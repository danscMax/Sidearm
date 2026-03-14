# Hook Encapsulation + Rust Dedup + Constants Split

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Full isolation of hook internal state (useVerification no longer touches useRuntime setters), dedup Rust commands in lib.rs, split constants.ts concerns.

**Architecture:** useVerification receives semantic callbacks (`ensureRuntimeStarted`, `clearRuntimeError`) instead of raw `setState` dispatchers. Rust lib.rs extracts shared resolve-and-execute helper. constants.ts splits into hotspots + types + ui-copy.

**Tech Stack:** React 19, TypeScript 5.8, Rust/Tauri v2, Vitest 4

**Verification:** `npx vitest run` + `npx tsc --noEmit` (frontend), `cargo check` (Rust, from src-tauri/)

---

### Task 1: Remove unused setters from useAppPersistence

**Evidence:**
- `src/hooks/useAppPersistence.ts` exports `setViewState`, `setSnapshot`, `setLastSave` in AppPersistence interface (lines 18, 20, 23) and return object (lines 182, 184, 187)
- Grep confirms 0 external consumers — these are only used internally

**Files:**
- Modify: `src/hooks/useAppPersistence.ts`

**Step 1:** Remove `setViewState`, `setSnapshot`, `setLastSave` from the `AppPersistence` interface (lines 18, 20, 23).

**Step 2:** Remove them from the return object (lines 182, 184, 187).

**Step 3:** Verify: `npx tsc --noEmit && npx vitest run`

**Step 4:** Commit: `"refactor: remove unused setters from useAppPersistence public interface"`

---

### Task 2: Add semantic methods to useRuntime, remove leaked setters

**Evidence:**
- `src/hooks/useRuntime.ts` exports 6 raw setters: `setRuntimeSummary`, `setLastCapture`, `setLastResolutionPreview`, `setLastExecution`, `setLastRuntimeError`, `setLastEncodedKey`
- Only `setRuntimeSummary` and `setLastRuntimeError` are used externally (by useVerification via App.tsx)
- useVerification uses them for: (a) update runtime state after startRuntime, (b) clear runtime error

**Files:**
- Modify: `src/hooks/useRuntime.ts`

**Step 1:** Add two new semantic methods inside useRuntime, after the `runtimeCommand` helper:

```typescript
async function ensureRuntimeStarted(): Promise<void> {
  const summary = await startRuntime();
  startTransition(() => setRuntimeSummary(summary));
  await refreshDebugLog();
}

function clearRuntimeError() {
  startTransition(() => setLastRuntimeError(null));
}
```

Note: `ensureRuntimeStarted` intentionally does NOT catch errors — the caller is responsible for error handling. This differs from `handleStartRuntime` which swallows errors via `runtimeCommand`.

**Step 2:** Update the `RuntimeControl` interface — remove the 6 raw setters, add the 2 new methods:

Remove from interface:
```
setRuntimeSummary: React.Dispatch<React.SetStateAction<RuntimeStateSummary>>;
setLastCapture: React.Dispatch<React.SetStateAction<WindowCaptureResult | null>>;
setLastResolutionPreview: React.Dispatch<React.SetStateAction<ResolvedInputPreview | null>>;
setLastExecution: React.Dispatch<React.SetStateAction<ActionExecutionEvent | null>>;
setLastRuntimeError: React.Dispatch<React.SetStateAction<RuntimeErrorEvent | null>>;
setLastEncodedKey: React.Dispatch<React.SetStateAction<EncodedKeyEvent | null>>;
```

Add to interface:
```typescript
ensureRuntimeStarted: () => Promise<void>;
clearRuntimeError: () => void;
```

**Step 3:** Update the return object — remove the 6 setters, add the 2 new methods.

**Step 4:** Verify: `npx tsc --noEmit` — will FAIL because App.tsx still passes the old setters to useVerification. That's expected, we fix it in Task 3.

**Step 5:** Do NOT commit yet — proceed to Task 3.

---

### Task 3: Rewire useVerification for full isolation

**Evidence:**
- `src/hooks/useVerification.ts` deps interface (lines 74-89) receives `setRuntimeSummary`, `refreshDebugLog`, `setLastRuntimeError` from useRuntime
- Line 178: calls `startRuntime()` directly (imported from backend.ts) + `setRuntimeSummary(summary)` + `refreshDebugLog()`
- Lines 205, 315: calls `setLastRuntimeError(null)`
- Line 176: only uses `runtimeSummary.status`

**Files:**
- Modify: `src/hooks/useVerification.ts`
- Modify: `src/App.tsx`

**Step 1:** Update useVerification deps interface. Replace:

```typescript
// OLD deps:
runtimeSummary: RuntimeStateSummary;
setRuntimeSummary: React.Dispatch<React.SetStateAction<RuntimeStateSummary>>;
refreshDebugLog: () => Promise<void>;
setLastRuntimeError: React.Dispatch<React.SetStateAction<import("../lib/runtime").RuntimeErrorEvent | null>>;
```

With:
```typescript
// NEW deps:
runtimeStatus: import("../lib/runtime").RuntimeStatus;
ensureRuntimeStarted: () => Promise<void>;
clearRuntimeError: () => void;
```

**Step 2:** Update the destructuring in useVerification body to match new deps names.

**Step 3:** Update `handleStartVerificationSession` (line 171):

Before:
```typescript
if (runtimeSummary.status !== "running") {
  try {
    const summary = await startRuntime();
    startTransition(() => {
      setRuntimeSummary(summary);
    });
    await refreshDebugLog();
  } catch (unknownError) {
    startTransition(() => {
      setError(normalizeCommandError(unknownError));
    });
    return;
  }
}
```

After:
```typescript
if (runtimeStatus !== "running") {
  try {
    await ensureRuntimeStarted();
  } catch (unknownError) {
    startTransition(() => {
      setError(normalizeCommandError(unknownError));
    });
    return;
  }
}
```

**Step 4:** Replace `setLastRuntimeError(null)` at lines ~205 and ~315 with `clearRuntimeError()`.

**Step 5:** Remove `startRuntime` from the import of `"../lib/backend"`. After this change, useVerification should no longer import `startRuntime` — only `exportVerificationSession` and `normalizeCommandError`.

**Step 6:** Remove the unused `RuntimeStateSummary` type import from `"../lib/runtime"` if no longer needed (check).

**Step 7:** Update `src/App.tsx` where useVerification is called (~line 241):

Before:
```tsx
const verification = useVerification({
  ...
  runtimeSummary: runtime.runtimeSummary,
  setRuntimeSummary: runtime.setRuntimeSummary,
  refreshDebugLog: runtime.refreshDebugLog,
  setLastRuntimeError: runtime.setLastRuntimeError,
  ...
});
```

After:
```tsx
const verification = useVerification({
  ...
  runtimeStatus: runtime.runtimeSummary.status,
  ensureRuntimeStarted: runtime.ensureRuntimeStarted,
  clearRuntimeError: runtime.clearRuntimeError,
  ...
});
```

**Step 8:** Verify: `npx tsc --noEmit && npx vitest run`

**Step 9:** Commit Tasks 2+3 together:
```
git add src/hooks/useRuntime.ts src/hooks/useVerification.ts src/hooks/useAppPersistence.ts src/App.tsx
git commit -m "refactor: encapsulate hook internals — useVerification no longer touches useRuntime state"
```

---

### Task 4: Rust lib.rs — extract shared resolve_and_execute_action helper

**Evidence:**
- `src-tauri/src/lib.rs` lines 482-574 (`execute_preview_action`) and 576-652 (`run_preview_action`) share ~80% code
- Shared: input validation, config load, resolution, emit control_resolved, error handling
- Different: which executor fn to call, success logging format

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Step 1:** Add an enum and the helper function ABOVE the two command functions:

```rust
/// Distinguishes dry-run preview from live execution for logging purposes.
enum ActionRunMode {
    DryRun,
    Live,
}

/// Shared logic for execute_preview_action and run_preview_action.
/// Validates input, loads config, resolves the key, runs the executor,
/// emits events, and logs results.
async fn resolve_and_execute_action(
    app: &AppHandle,
    runtime_store: &State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
    executor_fn: fn(&AppConfig, &ResolvedInputPreview) -> Result<ActionExecutionEvent, executor::ExecutorError>,
    mode: ActionRunMode,
) -> Result<ActionExecutionEvent, CommandError> {
    let normalized_key = encoded_key.trim().to_owned();
    if normalized_key.is_empty() {
        return Err(CommandError::new(
            "invalid_request",
            "encodedKey must not be empty.",
            None,
        ));
    }

    let config_dir = resolve_config_dir(app)?;
    let exe = exe.unwrap_or_default();
    let title = title.unwrap_or_default();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let load_response = load_or_initialize_config(&config_dir)?;
        let preview =
            resolver::resolve_input_preview(&load_response.config, &normalized_key, &exe, &title);
        let execution = executor_fn(&load_response.config, &preview);
        Ok::<_, ConfigStoreError>((preview, execution))
    })
    .await
    .map_err(|error| CommandError::internal(format!("action execution task failed: {error}")))?
    .map_err(CommandError::from)?;

    let (preview, execution) = result;

    app.emit(EVENT_CONTROL_RESOLVED, &preview)
        .map_err(|error| {
            CommandError::internal(format!("Failed to emit control_resolved event: {error}"))
        })?;

    match execution {
        Ok(event) => {
            {
                let mut store = runtime_store
                    .lock()
                    .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
                match mode {
                    ActionRunMode::DryRun => {
                        let message = format!(
                            "Пробное выполнение `{}` для `{}`.",
                            event.action_pretty, event.encoded_key
                        );
                        match event.outcome {
                            executor::ExecutionOutcome::Noop => {
                                store.record_warn("выполнение", message);
                            }
                            _ => {
                                store.record_info("выполнение", message);
                            }
                        }
                        for warning in &event.warnings {
                            store.record_warn("выполнение", warning.clone());
                        }
                    }
                    ActionRunMode::Live => {
                        store.record_info(
                            "выполнение",
                            format!(
                                "Выполнено вживую `{}` для `{}`.",
                                event.action_pretty, event.encoded_key
                            ),
                        );
                    }
                }
            }

            app.emit(EVENT_ACTION_EXECUTED, &event).map_err(|error| {
                CommandError::internal(format!("Failed to emit action_executed event: {error}"))
            })?;

            Ok(event)
        }
        Err(error) => {
            emit_runtime_error(app, runtime_store, &error.event)?;
            Err(CommandError::new(
                error.code,
                error.event.message.clone(),
                Some(
                    [
                        error.event.encoded_key.clone(),
                        error.event.action_id.clone(),
                    ]
                    .into_iter()
                    .flatten()
                    .collect(),
                ),
            ))
        }
    }
}
```

**Step 2:** Replace `execute_preview_action` command body (lines 482-574):

```rust
#[tauri::command]
async fn execute_preview_action(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
) -> Result<ActionExecutionEvent, CommandError> {
    resolve_and_execute_action(
        &app,
        &runtime_store,
        encoded_key,
        exe,
        title,
        executor::execute_preview_action,
        ActionRunMode::DryRun,
    )
    .await
}
```

**Step 3:** Replace `run_preview_action` command body (lines 576-652):

```rust
#[tauri::command]
async fn run_preview_action(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
) -> Result<ActionExecutionEvent, CommandError> {
    resolve_and_execute_action(
        &app,
        &runtime_store,
        encoded_key,
        exe,
        title,
        executor::run_preview_action,
        ActionRunMode::Live,
    )
    .await
}
```

**Step 4:** Verify: `cd src-tauri && cargo check`

**Step 5:** Commit: `"refactor: extract resolve_and_execute_action helper to DRY up Rust commands"`

---

### Task 5: Split constants.ts into focused modules

**Evidence:**
- `src/lib/constants.ts` is 237 lines mixing: types (7), hotspot coordinates (5 objects, ~80 lines), UI copy/options (7 objects, ~100 lines), controlFamilyOrder

**Files:**
- Create: `src/lib/constants/types.ts`
- Create: `src/lib/constants/hotspots.ts`
- Create: `src/lib/constants/ui-copy.ts`
- Create: `src/lib/constants/index.ts` (barrel re-export for backwards compatibility)
- Delete: `src/lib/constants.ts` (replaced by directory)

**Grouping:**

`constants/types.ts`:
- ViewState, WorkspaceMode, FamilySection, ControlSurfaceEntry, HotspotPosition, CalloutAnchor, ActionCategory

`constants/hotspots.ts`:
- topViewHotspots, sideViewHotspots, combinedViewHotspots, topViewCallouts, sideViewCallouts

`constants/ui-copy.ts`:
- controlFamilyOrder, workspaceModeCopy, verificationScopeCopy, layerCopy, editableActionTypes, ACTION_CATEGORIES, MOUSE_ACTION_OPTIONS, MEDIA_KEY_OPTIONS

`constants/index.ts`:
- Re-export everything from all 3 files for backwards compatibility (no consumer changes needed)

**Step 1:** Create the 3 module files with appropriate content and imports.

**Step 2:** Create `constants/index.ts` barrel:
```typescript
export * from "./types";
export * from "./hotspots";
export * from "./ui-copy";
```

**Step 3:** Delete `src/lib/constants.ts`.

**Step 4:** Verify: `npx tsc --noEmit && npx vitest run`
All consumers import from `"../lib/constants"` which now resolves to `constants/index.ts` — no consumer changes needed.

**Step 5:** Commit: `"refactor: split constants.ts into types, hotspots, and ui-copy modules"`

---

## Summary

| Task | What | Risk |
|------|------|------|
| 1 | Remove 3 unused setters from useAppPersistence | Zero |
| 2-3 | Full isolation: semantic methods in useRuntime, rewire useVerification | Medium |
| 4 | Rust resolve_and_execute_action helper | Medium |
| 5 | Split constants.ts into 3 focused modules | Low |
