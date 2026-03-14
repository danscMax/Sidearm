# Features & Improvements — TDD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement all improvements from research (except Updater): config quick wins, hook test coverage, desktop UX (tray, global shortcut, OSD, useOptimistic), and major features (macro recording, chording, conditional actions).

**Architecture:** Strict TDD — tests written FIRST, then implementation. Each task ends with `npx vitest run && npx tsc --noEmit` gate. Phases are sequential: config → test infra → hook tests → desktop UX → major features.

**Tech Stack:** React 19, TypeScript 5.8, Tauri v2, Rust, Vitest 4, @testing-library/react, @tauri-apps/api/mocks

---

## Phase 1: Config Quick Wins (no tests needed — config only)

### Task 1: tsconfig + vite.config + Cargo.toml fixes

**Files:**
- Modify: `tsconfig.json`
- Modify: `vite.config.ts`
- Modify: `src-tauri/Cargo.toml`

**Step 1:** In `tsconfig.json`, add `"erasableSyntaxOnly": true` to compilerOptions (after `"moduleDetection": "force"`).

**Step 2:** In `vite.config.ts`, add `build: { target: "chrome110" }` to the config object (after `server` block).

**Step 3:** In `src-tauri/Cargo.toml`, change `jsonschema = { version = "0.44.1", ...}` to `jsonschema = { version = "0.44", ...}`.

**Step 4:** Verify: `npx tsc --noEmit && npx vitest run`

**Step 5:** Commit: `"chore: add erasableSyntaxOnly, explicit build target, relax jsonschema pin"`

---

## Phase 2: Test Infrastructure

### Task 2: Install @testing-library/react, configure Vitest for hooks

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `vitest.config.ts`
- Create: `src/test-setup.ts`

**Step 1:** Install dev dependency:
```bash
npm install -D @testing-library/react @testing-library/react-hooks jsdom
```
Note: `@testing-library/react` v16+ includes `renderHook` natively.

**Step 2:** Update `vitest.config.ts` — add jsdom environment and setup file:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
  },
});
```

**Step 3:** Create `src/test-setup.ts` with Tauri mock scaffold:
```typescript
// Provide the __TAURI_INTERNALS__ stub so @tauri-apps/api works in jsdom
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {
    plugins: {},
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: () => Promise.resolve(),
  },
  writable: true,
});
```

**Step 4:** Verify existing tests still pass: `npx vitest run`

**Step 5:** Commit: `"test: add @testing-library/react, configure jsdom environment for hook tests"`

---

## Phase 3: Hook Tests (TDD — tests for existing code)

### Task 3: useAppPersistence tests

**Files:**
- Create: `src/hooks/useAppPersistence.test.ts`

Write tests FIRST for the existing hook behavior. These tests document the contract.

**Test cases to cover:**
1. `refreshConfig` — sets viewState to "ready" on success, sets workingConfig
2. `refreshConfig` — sets viewState to "error" on IPC failure
3. `updateDraft` — pushes to undoStack, clears redoStack
4. `updateDraft` — caps undoStack at MAX_UNDO (15)
5. `handleUndo` — pops from undoStack, pushes to redoStack, updates workingConfig
6. `handleUndo` — no-op when undoStack is empty
7. `handleRedo` — pops from redoStack, pushes to undoStack
8. `handleRedo` — no-op when redoStack is empty
9. Auto-save — calls save_config IPC after 500ms debounce
10. Auto-save — cancels pending save on refreshConfig

**Implementation approach:**
- Use `renderHook` from `@testing-library/react`
- Mock IPC with `vi.fn()` on `window.__TAURI_INTERNALS__.invoke`
- Use `vi.useFakeTimers()` for debounce testing

**Step 1:** Write all test cases (they should PASS since they test existing behavior).

**Step 2:** Run: `npx vitest run src/hooks/useAppPersistence.test.ts`

**Step 3:** Commit: `"test: add useAppPersistence hook tests — IPC mock, undo/redo, auto-save"`

---

### Task 4: useRuntime tests

**Files:**
- Create: `src/hooks/useRuntime.test.ts`

**Test cases:**
1. `handleStartRuntime` — calls start_runtime IPC, updates runtimeSummary
2. `handleStopRuntime` — calls stop_runtime IPC, updates runtimeSummary
3. `handleReloadRuntime` — calls reload_runtime IPC, updates runtimeSummary
4. `handleCaptureActiveWindow` — calls capture_active_window IPC with captureDelayMs
5. `handlePreviewResolution` — calls preview_resolution with resolutionKeyInput
6. `ensureRuntimeStarted` — calls start_runtime, does NOT catch errors (throws)
7. `clearRuntimeError` — sets lastRuntimeError to null
8. Error handling — IPC failure sets error via setError
9. Tauri event listeners — simulated runtime_started event updates state

**Step 1:** Write tests. **Step 2:** Run. **Step 3:** Commit: `"test: add useRuntime hook tests"`

---

### Task 5: useVerification tests

**Files:**
- Create: `src/hooks/useVerification.test.ts`

**Test cases:**
1. `handleStartVerificationSession` — calls ensureRuntimeStarted if runtime not running
2. `handleStartVerificationSession` — skips runtime start if already running
3. `handleStartVerificationSession` — creates session with correct scope
4. `handleVerificationResult` — finalizes step and advances to next
5. `handleNavigateVerificationStep` — navigates to specific step
6. `handleReopenVerificationStep` — resets step to pending
7. `handleResetVerificationSession` — shows confirm if has results
8. `handleExportVerificationSession` — calls export IPC with JSON
9. `onEncodedKeyEvent` — captures observation on active step
10. `onControlResolutionEvent` — captures resolution on active step

**Step 1:** Write tests. **Step 2:** Run. **Step 3:** Commit: `"test: add useVerification hook tests"`

---

## Phase 4: Desktop UX — Tray & Global Shortcut

### Task 6: Tray context menu (Show, Toggle Runtime, Quit)

**Files:**
- Modify: `src-tauri/src/lib.rs` — expand tray menu in `run()` setup

**Step 1 (TDD):** Write Rust test — verify tray menu items are constructed correctly. Since Tauri tray is hard to unit test, write an integration-style test that verifies the menu item IDs match expected values.

**Step 2:** Modify the `setup` closure in `run()`:
- Change tray menu from 2 items (Show, Quit) to 3 items (Show, Toggle Runtime, Quit)
- Add "Toggle Runtime" handler in `on_menu_event` that:
  - Locks `RuntimeStore` to check `is_running()`
  - If running: calls `controller.stop()`, updates store, emits `runtime_stopped`
  - If stopped: loads config, calls `controller.start()`, updates store, emits `runtime_started`
- This requires passing `Arc<Mutex<RuntimeStore>>` and `Arc<Mutex<RuntimeController>>` to the tray handler via `app.state()`

**Step 3:** Verify: `cargo test` (from src-tauri/) + manual smoke test with `cargo tauri dev`

**Step 4:** Commit: `"feat: add Toggle Runtime to system tray context menu"`

---

### Task 7: Global shortcut — show/hide window

**Files:**
- Modify: `src-tauri/Cargo.toml` — add `tauri-plugin-global-shortcut`
- Modify: `package.json` — add `@tauri-apps/plugin-global-shortcut`
- Modify: `src-tauri/src/lib.rs` — register global shortcut in setup
- Modify: `src-tauri/capabilities/default.json` — add shortcut permissions

**Step 1:** Add dependencies:
```bash
# Frontend
npm install @tauri-apps/plugin-global-shortcut
```
```toml
# Cargo.toml
tauri-plugin-global-shortcut = "2"
```

**Step 2:** Add capability:
```json
"global-shortcut:allow-register"
```

**Step 3:** In `run()` setup, register `Ctrl+Alt+N`:
```rust
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

app.plugin(tauri_plugin_global_shortcut::Builder::new().build())?;

let shortcut: Shortcut = "ctrl+alt+n".parse().unwrap();
app.global_shortcut().on_shortcut(shortcut, move |app, _id, event| {
    if event.state == ShortcutState::Pressed {
        if let Some(window) = app.get_webview_window("main") {
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
            } else {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
});
```

**Step 4:** Verify: `cargo check` + manual test

**Step 5:** Commit: `"feat: add global Ctrl+Alt+N shortcut to show/hide window"`

---

### Task 8: OSD notification on profile switch

**Files:**
- Modify: `src-tauri/Cargo.toml` — add `tauri-plugin-notification`
- Modify: `package.json` — add `@tauri-apps/plugin-notification`
- Modify: `src-tauri/src/lib.rs` — send notification when profile_resolved event fires
- Modify: `src-tauri/capabilities/default.json` — add notification permission

**Step 1:** Add dependencies:
```bash
npm install @tauri-apps/plugin-notification
```
```toml
tauri-plugin-notification = "2"
```

**Step 2:** In the runtime's profile resolution flow (where `EVENT_PROFILE_RESOLVED` is emitted), add notification:
```rust
use tauri_plugin_notification::NotificationExt;

// After emitting EVENT_PROFILE_RESOLVED, if profile changed:
if !result.ignored {
    let profile_name = result.resolved_profile_name.as_deref().unwrap_or("Default");
    let _ = app.notification()
        .builder()
        .title("Naga Studio")
        .body(format!("Профиль: {profile_name}"))
        .show();
}
```

Important: only notify when profile CHANGES (not every capture). Track last_resolved_profile_id in RuntimeStore.

**Step 3:** Verify: `cargo check` + manual test with `cargo tauri dev`

**Step 4:** Commit: `"feat: OSD notification on profile switch via system notifications"`

---

### Task 9: useOptimistic for autostart toggle

**Files:**
- Modify: `src/components/ServiceToolsPanel.tsx` (or wherever autostart toggle lives)
- Test: `src/components/ServiceToolsPanel.test.tsx` (new)

**Step 1 (TDD):** Write test that verifies: when toggle is clicked, UI immediately reflects new state before IPC completes.

**Step 2:** Implement using React 19 `useOptimistic`:
```typescript
const [optimisticAutostart, setOptimisticAutostart] = useOptimistic(
  actualAutostart,
  (_current, next: boolean) => next,
);
```

On toggle click: `setOptimisticAutostart(!optimisticAutostart)` immediately, then call IPC. If IPC fails, the actual state reverts and optimistic state follows.

**Step 3:** Verify: `npx vitest run && npx tsc --noEmit`

**Step 4:** Commit: `"feat: optimistic autostart toggle using React 19 useOptimistic"`

---

## Phase 5: Major Features

> **Note:** Each of these is a multi-day feature requiring its own spec/design. The tasks below define the test-first approach and core architecture. Implementation details will be refined during execution.

### Task 10: Live macro recording — Rust capture layer

**Files:**
- Modify: `src-tauri/src/capture_backend.rs` — add recording state machine
- Create: `src-tauri/src/recorder.rs` — keystroke recording module
- Modify: `src-tauri/src/lib.rs` — add start_recording/stop_recording commands
- Test: Rust unit tests in recorder.rs

**TDD approach:**

**Step 1 (Tests):** Write Rust tests for recorder module:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_single_keystroke_with_timing() {
        let mut recorder = MacroRecorder::new();
        recorder.start();
        recorder.record_keystroke("F13", 100);
        recorder.record_keystroke("F14", 250);
        let recording = recorder.stop();
        assert_eq!(recording.steps.len(), 2);
        assert_eq!(recording.steps[0].value, "F13");
        assert_eq!(recording.steps[1].delay_ms, Some(150)); // delta
    }

    #[test]
    fn caps_individual_delay_at_30_seconds() { ... }

    #[test]
    fn produces_empty_recording_when_no_keys_captured() { ... }

    #[test]
    fn converts_recording_to_sequence_steps() { ... }
}
```

**Step 2:** Implement `MacroRecorder` struct — state machine: Idle → Recording → Stopped.

**Step 3:** Add Tauri commands: `start_macro_recording`, `stop_macro_recording`, `get_macro_recording`.

**Step 4:** Commit: `"feat: add Rust-side macro recorder with keystroke capture"`

---

### Task 11: Live macro recording — Frontend UI

**Files:**
- Modify: `src/components/ActionPickerModal.tsx` — add Record button to sequence editor
- Modify: `src/lib/backend.ts` — add IPC functions
- Test: `src/components/ActionPickerModal.test.tsx`

**TDD approach:**

**Step 1 (Tests):** Write test that verifies:
- "Record" button starts recording state
- Received keystrokes appear in sequence steps
- "Stop" button ends recording and populates steps

**Step 2:** Add IPC wrappers: `startMacroRecording()`, `stopMacroRecording()`, `getMacroRecording()`.

**Step 3:** Add Record button UI in sequence editor section of ActionPickerModal.

**Step 4:** Verify: all tests pass.

**Step 5:** Commit: `"feat: live macro recording UI in action picker"`

---

### Task 12: Button chording — Rust chord detection

**Files:**
- Create: `src-tauri/src/chord.rs` — chord detection state machine
- Modify: `src-tauri/src/capture_backend.rs` — integrate chord detection
- Modify: `src/lib/config.ts` — add chord trigger mode to TriggerMode union
- Test: Rust unit tests + TS config tests

**TDD approach:**

**Step 1 (Tests):** Define chord behavior and write Rust tests:
```rust
#[test]
fn detects_two_button_chord_within_window() {
    let mut detector = ChordDetector::new(Duration::from_millis(100));
    detector.key_down("F13", now);
    detector.key_down("F14", now + 50ms);
    let result = detector.evaluate();
    assert_eq!(result, ChordResult::Chord("F13", "F14"));
}

#[test]
fn falls_back_to_single_press_after_timeout() { ... }

#[test]
fn ignores_chord_if_not_configured() { ... }
```

**Step 2:** Implement `ChordDetector` — tracks held keys, evaluates after configurable window (default 100ms).

**Step 3:** Add `"chord"` variant to TriggerMode in config.ts and Rust config.rs. Add `chordPartner: ControlId` to Binding.

**Step 4:** Verify all tests pass.

**Step 5:** Commit: `"feat: chord detection state machine with configurable timing window"`

---

### Task 13: Button chording — Frontend UI

**Files:**
- Modify: `src/components/ActionPickerModal.tsx` — add chord configuration
- Modify: `src/lib/config-editing.ts` — chord binding helpers
- Test: config-editing tests + component tests

**Step 1 (Tests):** Write tests for chord binding creation/lookup.

**Step 2:** Add UI in action picker: when trigger mode = "chord", show second button selector.

**Step 3:** Verify: all tests pass.

**Step 4:** Commit: `"feat: chord configuration UI in action picker"`

---

### Task 14: Conditional actions — config model

**Files:**
- Modify: `src/lib/config.ts` — add `conditions` to Action type
- Modify: `src-tauri/src/config.rs` — mirror in Rust
- Modify: `src-tauri/src/executor.rs` — evaluate conditions before execution
- Test: Rust unit tests + TS config tests

**TDD approach:**

**Step 1 (Tests):**
```rust
#[test]
fn condition_matches_window_title_contains() {
    let condition = ActionCondition::WindowTitleContains("Visual Studio".into());
    assert!(condition.evaluate("code.exe", "main.rs - Visual Studio Code"));
}

#[test]
fn condition_rejects_non_matching_title() { ... }

#[test]
fn multiple_conditions_require_all_match() { ... }
```

**Step 2:** Add `ActionCondition` enum:
```typescript
export type ActionCondition =
  | { type: "windowTitleContains"; value: string }
  | { type: "windowTitleNotContains"; value: string }
  | { type: "exeEquals"; value: string }
  | { type: "exeNotEquals"; value: string };
```

**Step 3:** Executor evaluates conditions before action dispatch.

**Step 4:** Commit: `"feat: conditional action evaluation based on window context"`

---

### Task 15: Conditional actions — Frontend UI

**Files:**
- Modify: `src/components/ActionPickerModal.tsx` — add conditions editor
- Modify: `src/components/ActionInspector.tsx` — display conditions
- Test: component tests

**Step 1 (Tests):** Write tests for condition editor CRUD operations.

**Step 2:** Add "Conditions" section in action picker — list of rules with add/remove.

**Step 3:** Verify all tests pass.

**Step 4:** Commit: `"feat: conditional action editor UI"`

---

## Execution Order Summary

| Phase | Tasks | Gate |
|-------|-------|------|
| 1. Config | Task 1 | `tsc + vitest + cargo check` |
| 2. Test infra | Task 2 | `vitest` (445 existing pass) |
| 3. Hook tests | Tasks 3-5 | `vitest` (445 + new hook tests) |
| 4. Desktop UX | Tasks 6-9 | `vitest + cargo test + manual` |
| 5. Macro recording | Tasks 10-11 | `vitest + cargo test` |
| 6. Chording | Tasks 12-13 | `vitest + cargo test` |
| 7. Conditionals | Tasks 14-15 | `vitest + cargo test` |

Each phase MUST pass all tests before proceeding to the next.
