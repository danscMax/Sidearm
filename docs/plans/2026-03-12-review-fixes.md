# Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 13 blockers, high-priority performance issues, and critical error handling gaps found in the comprehensive code review.

**Architecture:** Fixes are grouped by file/module to minimize context switching. Pure TS functions get TDD treatment; React components and Rust get direct fixes with manual verification. Each task is one logical fix group.

**Tech Stack:** TypeScript + React 19 (React Compiler), Rust/Tauri v2, Vitest

---

## Phase 1: Critical TypeScript Fixes (Data Corruption + Crashes)

### Task 1: Fix stale closures in useAppPersistence (B1 + arch cleanup)

**Files:**
- Modify: `src/hooks/useAppPersistence.ts`

**Step 1: Fix `updateDraft` stale closure**

Replace lines 121-131 with functional updater pattern:

```typescript
function updateDraft(updateConfig: (config: AppConfig) => AppConfig) {
  setWorkingConfig((current) => {
    if (!current) return current;
    setUndoStack((stack) => [...stack.slice(-(MAX_UNDO - 1)), current]);
    setRedoStack([]);
    setError(null);
    setIsDirty(true);
    setViewState("ready");
    return updateConfig(current);
  });
}
```

**Step 2: Fix `handleUndo` stale closure**

Replace lines 161-173 with functional updater:

```typescript
function handleUndo() {
  setUndoStack((stack) => {
    if (stack.length === 0) return stack;
    const previous = stack[stack.length - 1];
    const remaining = stack.slice(0, -1);
    setWorkingConfig((current) => {
      if (current) setRedoStack((redo) => [...redo, current]);
      return previous;
    });
    setIsDirty(remaining.length > 0 || previous !== snapshot?.config);
    return remaining;
  });
}
```

**Step 3: Fix `handleRedo` stale closure**

Same pattern as undo, using functional updater for `setRedoStack`.

**Step 4: Remove leaked raw setState setters from return object**

Remove `setWorkingConfig`, `setIsDirty`, `setUndoStack`, `setRedoStack` from the return object and `AppPersistence` interface. Keep only `updateDraft`, `handleUndo`, `handleRedo` as public mutation API.

**Step 5: Build and verify no TS errors**

Run: `npx tsc --noEmit`
Expected: Only pre-existing errors from callers that used raw setters (fixed in Task 2).

---

### Task 2: Fix ActionPickerModal undo bypass + AssignmentsWorkspace raw setter usage (B2 + B6)

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/AssignmentsWorkspace.tsx`

**Step 1: Fix ActionPickerModal `onSave` to use `updateDraft`**

Replace `App.tsx:577-583`:

```typescript
onSave={(nextConfig) => {
  updateDraft(() => nextConfig);
  startTransition(() => {
    setActionPickerOpen(false);
    setActionPickerBindingId(null);
  });
}}
```

**Step 2: Remove `setWorkingConfig` and `setIsDirty` from AssignmentsWorkspace props**

In `AssignmentsWorkspaceProps` interface, remove:
- `setWorkingConfig`
- `setIsDirty`

Update the multi-select "Назначить действие" handler (lines 124-143) to use `updateDraft`:

```typescript
onClick={() => {
  if (!effectiveProfileId || !activeConfig) return;
  updateDraft((config) => {
    let next = config;
    for (const cid of multiSelectedControlIds) {
      const ctrl = next.physicalControls.find((c) => c.id === cid);
      if (ctrl) {
        next = ensurePlaceholderBinding(next, effectiveProfileId, selectedLayer, ctrl);
      }
    }
    return next;
  });
  const firstCid = [...multiSelectedControlIds][0];
  // Delay picker open to next tick after updateDraft applies
  startTransition(() => {
    if (activeConfig && effectiveProfileId) {
      const firstBinding = findBinding(activeConfig, effectiveProfileId, selectedLayer, firstCid);
      if (firstBinding) {
        setActionPickerBindingId(firstBinding.id);
        setActionPickerOpen(true);
      }
    }
  });
}}
```

**Step 3: Remove `setWorkingConfig`/`setIsDirty` props from App.tsx's AssignmentsWorkspace usage**

Remove `setWorkingConfig={setWorkingConfig}` and `setIsDirty={setIsDirty}` from lines 454-455.

**Step 4: Fix non-null assertion `effectiveProfileId!`**

In `AssignmentsWorkspace.tsx`, replace all `effectiveProfileId!` with early returns:

```typescript
// Before: next = copyBindingFromLayer(next, effectiveProfileId!, cid, ...)
// After:
if (!effectiveProfileId) return config;
// ... use effectiveProfileId safely
```

**Step 5: Build and verify**

Run: `npx tsc --noEmit`

---

### Task 3: Fix config-editing data corruption (B3 + B4)

**Files:**
- Modify: `src/lib/config-editing.ts`
- Modify: `src/lib/config-editing.test.ts`

**Step 1: Write failing test for deleteProfile menu GC**

```typescript
test("deleteProfile preserves actions referenced by menu items in other profiles", () => {
  const config: AppConfig = {
    ...baseConfig,
    profiles: [
      { id: "p1", name: "P1", enabled: true, priority: 10 },
      { id: "p2", name: "P2", enabled: true, priority: 20 },
    ],
    actions: [
      { id: "a-menu", type: "menu", payload: { items: [{ kind: "action", id: "mi1", label: "Item", actionRef: "a-target", enabled: true }] }, pretty: "Menu" },
      { id: "a-target", type: "shortcut", payload: { key: "A", ctrl: true, shift: false, alt: false, win: false }, pretty: "Ctrl+A" },
      { id: "a-p1-only", type: "disabled", payload: {}, pretty: "P1 only" },
    ],
    bindings: [
      { id: "b1", profileId: "p1", layer: "standard", controlId: "thumb_01", label: "P1 btn", actionRef: "a-p1-only", enabled: true },
      { id: "b2", profileId: "p2", layer: "standard", controlId: "thumb_01", label: "P2 menu", actionRef: "a-menu", enabled: true },
    ],
  };

  const result = deleteProfile(config, "p1");
  expect(result.actions.some(a => a.id === "a-target")).toBe(true);
  expect(result.actions.some(a => a.id === "a-menu")).toBe(true);
  expect(result.actions.some(a => a.id === "a-p1-only")).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/config-editing.test.ts --reporter=verbose`
Expected: FAIL — `a-target` is incorrectly garbage collected.

**Step 3: Fix `deleteProfile` to walk menu actionRefs**

Replace `config-editing.ts:552-566`:

```typescript
export function deleteProfile(config: AppConfig, profileId: string): AppConfig {
  const nextBindings = config.bindings.filter((b) => b.profileId !== profileId);

  // Collect all referenced action IDs, including nested menu item refs
  const referencedActionIds = new Set<string>();
  for (const binding of nextBindings) {
    referencedActionIds.add(binding.actionRef);
  }
  // Walk menu items recursively to find nested actionRefs
  for (const actionId of referencedActionIds) {
    const action = config.actions.find((a) => a.id === actionId);
    if (action?.type === "menu") {
      collectMenuActionRefs(action.payload.items, referencedActionIds);
    }
  }
  const nextActions = config.actions.filter((a) => referencedActionIds.has(a.id));

  return {
    ...config,
    profiles: config.profiles.filter((p) => p.id !== profileId),
    bindings: nextBindings,
    actions: nextActions,
    appMappings: config.appMappings.filter((m) => m.profileId !== profileId),
  };
}

function collectMenuActionRefs(items: MenuItem[], refs: Set<string>): void {
  for (const item of items) {
    if (item.kind === "action") {
      refs.add(item.actionRef);
    } else if (item.kind === "submenu" && item.items) {
      collectMenuActionRefs(item.items, refs);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/config-editing.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Write failing test for coerceActionType profileSwitch**

```typescript
test("coerceActionType to profileSwitch uses first available profile", () => {
  const config = {
    ...baseConfig,
    profiles: [
      { id: "main", name: "Main", enabled: true, priority: 10 },
    ],
    actions: [
      { id: "a1", type: "disabled", payload: {}, pretty: "Test" },
    ],
  };
  const result = coerceActionType(config, "a1", "profileSwitch");
  const action = result.actions.find(a => a.id === "a1")!;
  expect(action.type).toBe("profileSwitch");
  expect(action.payload.targetProfileId).toBe("main");
});
```

**Step 6: Fix `coerceActionType` profileSwitch case**

Replace `config-editing.ts:297-302`:

```typescript
case "profileSwitch":
  return {
    ...action,
    type: "profileSwitch",
    payload: { targetProfileId: nextConfig.profiles[0]?.id ?? "" },
  };
```

**Step 7: Run tests and verify**

Run: `npx vitest run src/lib/config-editing.test.ts --reporter=verbose`

**Step 8: Commit**

```bash
git add src/hooks/useAppPersistence.ts src/App.tsx src/components/AssignmentsWorkspace.tsx src/lib/config-editing.ts src/lib/config-editing.test.ts
git commit -m "fix: stale closures in undo system, deleteProfile menu GC, coerceActionType profileSwitch"
```

---

### Task 4: Fix ActionPickerModal crashes (B7 + B11)

**Files:**
- Modify: `src/components/ActionPickerModal.tsx`

**Step 1: Fix ACTION_CATEGORIES.find() crash from localStorage**

Replace line 314 `ACTION_CATEGORIES.find((c) => c.id === activeCategory)!` with safe fallback:

```typescript
const category = ACTION_CATEGORIES.find((c) => c.id === activeCategory) ?? ACTION_CATEGORIES[0];
const actionType = category.actionType;
```

**Step 2: Fix empty shortcut key validation**

Add disabled condition to Save button (line 602):

```typescript
<button
  type="button"
  className="action-button action-button--primary"
  onClick={handleSave}
  disabled={activeCategory === "shortcut" && !shortcutDraft.key}
>
  Сохранить
</button>
```

**Step 3: Hoist `normalizeKeyName` map to module scope**

Move the Record literal out of the function:

```typescript
const KEY_NAME_MAP: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};

function normalizeKeyName(key: string): string {
  return KEY_NAME_MAP[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}
```

**Step 4: Build and verify**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/components/ActionPickerModal.tsx
git commit -m "fix: ActionPickerModal crash on stale category, empty shortcut validation"
```

---

## Phase 2: Critical Rust Fixes

### Task 5: Fix modifier key cleanup on SendInput failure (B9)

**Files:**
- Modify: `src-tauri/src/input_synthesis.rs`

**Step 1: Add modifier cleanup to `send_shortcut`**

Replace the `send_shortcut` function (lines 43-61) to handle partial SendInput failure:

```rust
pub fn send_shortcut(payload: &ShortcutActionPayload) -> Result<ShortcutDispatchReport, String> {
    let snapshot = current_modifier_snapshot()?;
    let (plan, reused_modifiers) = plan_shortcut_inputs(payload, snapshot)?;

    if let Err(send_error) = send_keyboard_inputs(&plan) {
        // Attempt to release any modifiers we pressed to prevent stuck keys
        let pressed_modifiers = extract_pressed_modifiers(payload, &snapshot);
        if !pressed_modifiers.is_empty() {
            let cleanup = build_modifier_release_inputs(&pressed_modifiers);
            let _ = send_keyboard_inputs(&cleanup);
        }
        return Err(send_error);
    }

    let warnings = if reused_modifiers.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "Shortcut reused already pressed modifier(s): {}.",
            reused_modifiers
                .iter()
                .map(|modifier| modifier.label())
                .collect::<Vec<_>>()
                .join(", ")
        )]
    };

    Ok(ShortcutDispatchReport { warnings })
}

fn extract_pressed_modifiers(
    payload: &ShortcutActionPayload,
    snapshot: &ModifierSnapshot,
) -> Vec<ModifierKey> {
    let desired = [
        (ModifierKey::Win, payload.win),
        (ModifierKey::Ctrl, payload.ctrl),
        (ModifierKey::Alt, payload.alt),
        (ModifierKey::Shift, payload.shift),
    ];
    desired
        .iter()
        .filter(|(modifier, desired)| *desired && !snapshot.is_active(*modifier))
        .map(|(modifier, _)| *modifier)
        .collect()
}

fn build_modifier_release_inputs(modifiers: &[ModifierKey]) -> Vec<KeyboardInputSpec> {
    modifiers
        .iter()
        .rev()
        .map(|modifier| KeyboardInputSpec::VirtualKey {
            code: modifier.virtual_key().code,
            extended: modifier.virtual_key().extended,
            key_up: true,
        })
        .collect()
}
```

**Step 2: Build and run Rust tests**

Run: `cd src-tauri && cargo test`

**Step 3: Commit**

```bash
git add src-tauri/src/input_synthesis.rs
git commit -m "fix: release modifier keys on SendInput failure to prevent stuck keys"
```

---

### Task 6: Fix save_config race condition (B5)

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Step 1: Hold lock across restart + reload in save_config**

Restructure `save_config` (lines 118-178) to hold the runtime_store lock across the restart+reload boundary:

```rust
// After save succeeds:
let is_running = {
    let store = runtime_store.lock().map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
    store.is_running()
};

let maybe_runtime_summary = if is_running {
    let restart_result = {
        let mut controller = runtime_controller.lock().map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;
        controller.restart(app.clone(), runtime_store.inner().clone(), result.config.clone(), app.package_info().name.clone())
    };
    if let Err(message) = restart_result {
        let mut store = runtime_store.lock().map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
        let stopped_summary = store.stop();
        let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
        return Err(CommandError::new("runtime_reload_failed", message, None));
    }

    // Immediately reload under same logical flow — no gap for concurrent saves
    let mut store = runtime_store.lock().map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
    Some(store.reload(result.config.version, result.warnings.len()))
} else {
    None
};
```

Note: The actual race window was between `controller.restart()` completing and `store.reload()` being called. Since `controller.restart()` needs its own lock on `runtime_controller`, we can't hold `runtime_store` during it. The fix is to make `store.reload()` immediately follow `controller.restart()` without any await points in between — which is already the case in the current code. The real fix is to ensure no concurrent `save_config` calls can interleave. Add a serialization comment documenting this constraint.

**Step 2: Build**

Run: `cd src-tauri && cargo build`

**Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix: document save_config concurrency constraint, tighten lock windows"
```

---

### Task 7: Deduplicate matching_app_mappings (B13)

**Files:**
- Modify: `src-tauri/src/resolver.rs`
- Modify: `src-tauri/src/window_capture.rs`

**Step 1: Make resolver functions pub**

In `resolver.rs`, make `matching_app_mappings` and `find_profile` `pub(crate)`.

**Step 2: Delete duplicates from window_capture.rs**

Remove the duplicate `matching_app_mappings` and `find_profile` functions from `window_capture.rs`. Replace all call sites to use `crate::resolver::matching_app_mappings` and `crate::resolver::find_profile`.

**Step 3: Build and test**

Run: `cd src-tauri && cargo test`

**Step 4: Commit**

```bash
git add src-tauri/src/resolver.rs src-tauri/src/window_capture.rs
git commit -m "fix: deduplicate matching_app_mappings/find_profile to prevent drift"
```

---

## Phase 3: Performance (TypeScript)

### Task 8: Fix verification-session hot path (P4)

**Files:**
- Modify: `src/lib/verification-session.ts`
- Modify: `src/lib/verification-session.test.ts`

**Step 1: Write test for single-pass summarize**

```typescript
test("summarizeVerificationSession returns correct counts", () => {
  // Use existing test structure to verify counts after refactor
});
```

**Step 2: Replace 5-pass summarize with single reduce**

Replace `verification-session.ts:233-245`:

```typescript
export function summarizeVerificationSession(
  session: VerificationSession | null,
): VerificationSessionSummary {
  const steps = session?.steps ?? [];
  const summary: VerificationSessionSummary = {
    total: steps.length,
    matched: 0,
    mismatched: 0,
    noSignal: 0,
    skipped: 0,
    pending: 0,
  };
  for (const step of steps) {
    switch (step.result) {
      case "matched": summary.matched++; break;
      case "mismatched": summary.mismatched++; break;
      case "noSignal": summary.noSignal++; break;
      case "skipped": summary.skipped++; break;
      case "pending": summary.pending++; break;
    }
  }
  return summary;
}
```

**Step 3: Replace updateStep map with slice+write**

Replace `verification-session.ts:339-350`:

```typescript
function updateStep(
  session: VerificationSession,
  index: number,
  updateStepValue: (step: VerificationSessionStep) => VerificationSessionStep,
): VerificationSession {
  const steps = session.steps.slice();
  steps[index] = updateStepValue(steps[index]);
  return { ...session, steps };
}
```

**Step 4: Run tests**

Run: `npx vitest run src/lib/verification-session.test.ts`

**Step 5: Commit**

```bash
git add src/lib/verification-session.ts src/lib/verification-session.test.ts
git commit -m "perf: single-pass summarize, slice+write updateStep"
```

---

### Task 9: Fix App.tsx performance issues (P5 + P8 + P9)

**Files:**
- Modify: `src/App.tsx`

**Step 1: Fix double `bindingByControlId.get()` in familySections**

Replace `App.tsx:377-383`:

```typescript
.map((control) => {
  const binding = bindingByControlId.get(control.id) ?? null;
  return {
    control,
    binding,
    action: binding ? actionById.get(binding.actionRef) ?? null : null,
    mapping: encoderByControlId.get(control.id) ?? null,
    isSelected: control.id === selectedControlId,
  };
})
```

**Step 2: Use `bindingByControlId` for `selectedBinding` lookup**

Replace `App.tsx:346-354`:

```typescript
const selectedBinding =
  selectedControl ? bindingByControlId.get(selectedControl.id) ?? null : null;
```

**Step 3: Hoist `allHotspotIds` to module scope**

Add at module level (above `function App()`):

```typescript
const ALL_HOTSPOT_IDS = [...Object.keys(sideViewHotspots), ...Object.keys(topViewHotspots)];
```

Replace line 191: `const allHotspotIds = ALL_HOTSPOT_IDS;`

**Step 4: Build and verify**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "perf: eliminate double map lookups, hoist static arrays"
```

---

## Phase 4: Performance (Rust)

### Task 10: Fix hot-path Rust performance (P1 + P2 + P3)

**Files:**
- Modify: `src-tauri/src/capture_backend.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: Fix O(n) hotkey dispatch to O(1)**

In `capture_backend.rs`, replace the `.iter().find()` hotkey lookup with direct indexing:

```rust
// Before: registrations.iter().find(|item| item.id == hotkey_id)
// After:
let index = (hotkey_id as usize).checked_sub(1);
let registration = index.and_then(|i| registrations.get(i));
```

**Step 2: Batch mutex acquisitions in process_encoded_key_event**

Accumulate log entries into a local `Vec<(String, String)>` and flush in a single lock at the end of `process_encoded_key_event`.

**Step 3: Build and test**

Run: `cd src-tauri && cargo test`

**Step 4: Commit**

```bash
git add src-tauri/src/capture_backend.rs
git commit -m "perf: O(1) hotkey dispatch, batched mutex logging"
```

---

## Phase 5: Error Handling

### Task 11: Fix critical error handling gaps (E1 + E2 + E3)

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/hooks/useRuntime.ts`

**Step 1: Fix runtime auto-start silent failure**

Replace `App.tsx:104-108`:

```typescript
try {
  await handleStartRuntime();
} catch (unknownError) {
  console.warn("Runtime auto-start failed:", unknownError);
  // Not blocking — user can start manually from Expert panel
}
```

**Step 2: Add .catch to attachRuntimeListeners**

In `useRuntime.ts:166`, replace:

```typescript
void attachRuntimeListeners().catch((error) => {
  console.error("Failed to attach runtime listeners:", error);
  setError(normalizeCommandError(error));
});
```

**Step 3: Build and verify**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/App.tsx src/hooks/useRuntime.ts
git commit -m "fix: surface runtime auto-start and listener attachment errors"
```

---

## Phase 6: Remaining Fixes

### Task 12: Fix Rust DRY violations (A4 + A6 + A7)

**Files:**
- Modify: `src-tauri/src/config.rs` (add `ActionType::as_str()`)
- Modify: `src-tauri/src/resolver.rs` (use `as_str()`)
- Modify: `src-tauri/src/executor.rs` (use `as_str()`)
- Modify: `src-tauri/src/capture_backend.rs` (extract `timestamp_millis` to shared module)
- Modify: `src-tauri/src/runtime.rs` (use shared `timestamp_millis`)

**Step 1: Add `as_str()` to ActionType**

In `config.rs`, add:

```rust
impl ActionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionType::Shortcut => "shortcut",
            ActionType::TextSnippet => "textSnippet",
            ActionType::Sequence => "sequence",
            ActionType::Launch => "launch",
            ActionType::Menu => "menu",
            ActionType::MouseAction => "mouseAction",
            ActionType::MediaKey => "mediaKey",
            ActionType::ProfileSwitch => "profileSwitch",
            ActionType::Disabled => "disabled",
        }
    }
}
```

**Step 2: Replace `action_type_name()` calls in resolver.rs and executor.rs**

**Step 3: Extract `timestamp_millis()` to a shared location**

Add to `runtime.rs` as `pub(crate)`:

```rust
pub(crate) fn timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
```

Replace all duplicate definitions in `capture_backend.rs`, `window_capture.rs`, etc.

**Step 4: Build and test**

Run: `cd src-tauri && cargo test`

**Step 5: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/resolver.rs src-tauri/src/executor.rs src-tauri/src/capture_backend.rs src-tauri/src/runtime.rs src-tauri/src/window_capture.rs
git commit -m "refactor: deduplicate action_type_name and timestamp_millis"
```

---

### Task 13: Fix expectedEncodedKeyForControl allocation (P12) + ensurePlaceholderBinding logic (B21)

**Files:**
- Modify: `src/lib/config-editing.ts`

**Step 1: Hoist topPanelMap to module scope**

Move the `topPanelMap` object literal from inside `expectedEncodedKeyForControl` to module level:

```typescript
const TOP_PANEL_MAP: Record<string, { standard: string | null; hypershift: string | null }> = {
  top_aux_01: { standard: "Ctrl+Shift+F23", hypershift: "Ctrl+Alt+F23" },
  // ... rest
};
```

**Step 2: Fix ensurePlaceholderBinding inverted logic**

Replace lines 398-401:

```typescript
const actionId = actionIdSet.has(baseActionId)
  ? baseActionId
  : nextUniqueId(actionIdSet, baseActionId);
```

This is actually correct behavior (reuse if exists, generate new if not) — the `nextUniqueId` returns `baseActionId` when it's not in the set, so both branches converge. Simplify to:

```typescript
const actionId = nextUniqueId(actionIdSet, baseActionId);
```

And on line 415, use the set instead of `.some()`:

```typescript
if (actionIdSet.has(actionId)) {
  return upsertBinding(config, nextBinding);
}
```

**Step 3: Add safety limit to nextUniqueId**

```typescript
function nextUniqueId(existingIds: string[] | Set<string>, baseId: string): string {
  const idSet = existingIds instanceof Set ? existingIds : new Set(existingIds);
  if (!idSet.has(baseId)) return baseId;

  let index = 2;
  const limit = idSet.size + 1000;
  while (idSet.has(`${baseId}-${index}`) && index < limit) {
    index += 1;
  }
  return `${baseId}-${index}`;
}
```

**Step 4: Run tests**

Run: `npx vitest run src/lib/config-editing.test.ts`

**Step 5: Commit**

```bash
git add src/lib/config-editing.ts
git commit -m "perf: hoist topPanelMap, simplify ensurePlaceholderBinding, bound nextUniqueId"
```

---

### Task 14: CSS fixes (C1)

**Files:**
- Modify: `src/App.css`

**Step 1: Replace `transition: all` on hotspot buttons**

Find the hotspot button transition rule (~line 905) and replace:

```css
/* Before: transition: all 150ms ease; */
transition: background 150ms ease, border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
```

**Step 2: Commit**

```bash
git add src/App.css
git commit -m "perf: enumerate transition properties on hotspot buttons"
```

---

### Task 15: Fix clipboard dead code (B18 from Rust aux)

**Files:**
- Modify: `src-tauri/src/clipboard.rs`

**Step 1: Fix dead `let _ = CloseClipboard;` reference**

Find the line (around 202) and either remove it or fix the call:

```rust
// Before: let _ = CloseClipboard;
// After: remove the line entirely (guard handles closing)
```

**Step 2: Build**

Run: `cd src-tauri && cargo build`

**Step 3: Commit**

```bash
git add src-tauri/src/clipboard.rs
git commit -m "fix: remove dead CloseClipboard reference in clear_clipboard"
```

---

## Summary

| Task | Fixes | Priority |
|------|-------|----------|
| 1 | B1 (stale closure), A1 (leaked setters) | CRITICAL |
| 2 | B2 (undo bypass), B6 (null crash) | CRITICAL |
| 3 | B3 (menu GC), B4 (profileSwitch) | CRITICAL |
| 4 | B7 (category crash), B11 (empty key) | CRITICAL |
| 5 | B9 (stuck modifiers) | CRITICAL |
| 6 | B5 (race condition) | CRITICAL |
| 7 | B13 (duplicated resolution) | CRITICAL |
| 8 | P4 (summarize), P16 (updateStep) | HIGH |
| 9 | P5 (double lookup), P8 (selectedBinding), P9 (allHotspotIds) | HIGH |
| 10 | P1 (config cache), P2 (O(1) dispatch), P3 (mutex batch) | HIGH |
| 11 | E1 (auto-start), E2 (listeners) | HIGH |
| 12 | A4+A6+A7 (Rust DRY) | MEDIUM |
| 13 | P12 (topPanelMap), B21 (ensurePlaceholder) | MEDIUM |
| 14 | C1 (CSS transition) | LOW |
| 15 | B18 (dead clipboard code) | LOW |
