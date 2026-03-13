# Hold-Through Input Synthesis — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a mouse button mapped to `TriggerMode::Hold` is held down, keep the bound shortcut pressed for as long as the button is held; release on button release.

**Architecture:** The LL keyboard hook in the helper process already sees both WM_KEYDOWN and WM_KEYUP for suppressed primary keys. We extend the helper stdout protocol to emit key-up events with an `"UP:"` prefix, propagate `is_key_up` through `EncodedKeyEvent`, and add `send_shortcut_hold_down` / `send_shortcut_hold_up` to `input_synthesis`. The worker thread owns a `HashMap<String, HeldShortcutState>` of currently held actions (no shared-state synchronization needed). On graceful shutdown, all held keys are released. A panic hook provides emergency cleanup.

**Tech Stack:** Rust, windows-sys 0.61, Tauri v2, mpsc channels

**Scope:** Top buttons only (modifier combos via LL hook). Side buttons (F13–F24 via RegisterHotKey) do not support hold mode — RegisterHotKey has no key-up event. Hold-through applies ONLY to `ActionType::Shortcut` bindings with `TriggerMode::Hold`. All other action types fall back to press (fire-and-forget) even if trigger_mode is Hold.

---

### Task 1: Change suppressions from `HashSet<u32>` to `HashMap<u32, String>`

Store the matched `encoded_key` alongside the suppressed VK code so we can look it up on key-up.

**Files:**
- Modify: `src-tauri/src/capture_backend.rs:340-341` (HELPER_SUPPRESSIONS type)
- Modify: `src-tauri/src/capture_backend.rs:348-387` (process_helper_key_event)
- Modify: `src-tauri/src/capture_backend.rs:502` (clear call)

**Step 1: Update the thread-local type**

Change line 340–341 from:
```rust
static HELPER_SUPPRESSIONS: std::cell::RefCell<std::collections::HashSet<u32>> =
    std::cell::RefCell::new(std::collections::HashSet::new());
```
to:
```rust
static HELPER_SUPPRESSIONS: std::cell::RefCell<std::collections::HashMap<u32, String>> =
    std::cell::RefCell::new(std::collections::HashMap::new());
```

**Step 2: Update process_helper_key_event signature and body**

Change the `suppressions` parameter type from `&mut HashSet<u32>` to `&mut HashMap<u32, String>`.

In the `WM_KEYDOWN` branch (line 368), change:
```rust
let is_repeat = !suppressions.insert(vk);
```
to:
```rust
let is_repeat = suppressions.contains_key(&vk);
if !is_repeat {
    suppressions.insert(vk, reg.encoded_key.clone());
}
```

In the `WM_KEYUP` branch (line 382), change:
```rust
(suppressions.remove(&vk), false)
```
to:
```rust
(suppressions.remove(&vk).is_some(), false)
```

**Step 3: Update the clear call**

Line 502: `cell.borrow_mut().clear();` — no change needed, `HashMap::clear()` has the same API.

**Step 4: Run tests**

```bash
cd src-tauri && cargo test -- --skip capture_diag
```

Expected: all 36 tests pass (pure refactor, no behavior change).

**Step 5: Commit**

```bash
git add src-tauri/src/capture_backend.rs
git commit -m "refactor: change suppressions from HashSet to HashMap for key-up lookup"
```

---

### Task 2: Emit key-up events from LL hook

When a suppressed primary key is released (WM_KEYUP), push an `"UP:<encoded_key>"` line to HELPER_MATCHES and wake the message loop so drain flushes it to stdout.

**Files:**
- Modify: `src-tauri/src/capture_backend.rs:348-387` (process_helper_key_event)

**Step 1: Write the failing test**

Add to `helper_modifier_state_tests` module (after line 991):

```rust
#[cfg(test)]
#[cfg(target_os = "windows")]
mod helper_key_event_tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_KEYUP};

    const VK_F24: u32 = 0x87;

    fn reg(encoded_key: &str, modifiers_mask: u32, primary_vk: u32) -> HelperRegistration {
        HelperRegistration {
            encoded_key: encoded_key.into(),
            modifiers_mask,
            primary_vk,
        }
    }

    #[test]
    fn key_up_emits_release_event() {
        let regs = vec![reg("Ctrl+Shift+F24", MOD_CONTROL | MOD_SHIFT, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // Simulate Ctrl down, Shift down, F24 down
        modifiers.apply_vk_event(VK_LCONTROL, true);
        modifiers.apply_vk_event(VK_LSHIFT, true);
        let (suppress, wake) =
            process_helper_key_event(&regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN);
        assert!(suppress);
        assert!(wake);
        assert_eq!(matches, vec!["Ctrl+Shift+F24"]);

        matches.clear();

        // Simulate F24 up
        let (suppress, wake) =
            process_helper_key_event(&regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYUP);
        assert!(suppress);
        assert!(wake, "key-up of suppressed key should wake for drain");
        assert_eq!(matches, vec!["UP:Ctrl+Shift+F24"]);
    }

    #[test]
    fn key_up_of_unsuppressed_key_does_not_emit() {
        let regs = vec![reg("Ctrl+Shift+F24", MOD_CONTROL | MOD_SHIFT, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // F24 up without prior down — should not emit
        let (suppress, wake) =
            process_helper_key_event(&regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYUP);
        assert!(!suppress);
        assert!(!wake);
        assert!(matches.is_empty());
    }
}
```

**Step 2: Run test to verify it fails**

```bash
cd src-tauri && cargo test helper_key_event_tests -- --nocapture
```

Expected: FAIL — key-up branch does not push to matches yet.

**Step 3: Implement key-up event emission**

In `process_helper_key_event`, change the `WM_KEYUP | WM_SYSKEYUP` branch from:

```rust
WM_KEYUP | WM_SYSKEYUP => {
    if modifiers.apply_vk_event(vk, false) {
        (false, false)
    } else {
        (suppressions.remove(&vk).is_some(), false)
    }
}
```

to:

```rust
WM_KEYUP | WM_SYSKEYUP => {
    if modifiers.apply_vk_event(vk, false) {
        (false, false)
    } else if let Some(encoded_key) = suppressions.remove(&vk) {
        matches.push(format!("UP:{encoded_key}"));
        (true, true)
    } else {
        (false, false)
    }
}
```

**Step 4: Run tests**

```bash
cd src-tauri && cargo test helper_key_event_tests -- --nocapture
```

Expected: both new tests pass + all 36 existing tests pass.

**Step 5: Commit**

```bash
git add src-tauri/src/capture_backend.rs
git commit -m "feat: emit UP: events from LL hook on key-up of suppressed keys"
```

---

### Task 3: Parse `UP:` prefix in reader thread + add `is_key_up` to `EncodedKeyEvent`

**Files:**
- Modify: `src-tauri/src/capture_backend.rs:54-61` (EncodedKeyEvent struct)
- Modify: `src-tauri/src/capture_backend.rs:654-671` (reader thread)
- Modify: `src-tauri/src/capture_backend.rs:751` (RegisterHotKey event)

**Step 1: Add `is_key_up` field to `EncodedKeyEvent`**

```rust
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncodedKeyEvent {
    pub encoded_key: String,
    pub backend: String,
    pub received_at: u64,
    pub is_repeat: bool,
    pub is_key_up: bool,
}
```

**Step 2: Fix all existing EncodedKeyEvent construction sites**

Reader thread (line 664): add `is_key_up: false` (will be updated in next step).

RegisterHotKey path (line 751): add `is_key_up: false`.

Any test construction sites: add `is_key_up: false`.

**Step 3: Parse `UP:` prefix in reader thread**

Change the reader thread closure (lines 659–670) from:

```rust
for line in reader.lines().map_while(Result::ok) {
    let encoded_key = line.trim().to_owned();
    if encoded_key.is_empty() {
        continue;
    }
    let _ = event_tx.send(EncodedKeyEvent {
        encoded_key,
        backend: BACKEND_LL_HOOK.into(),
        received_at: runtime::timestamp_millis(),
        is_repeat: false,
    });
}
```

to:

```rust
for line in reader.lines().map_while(Result::ok) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        continue;
    }
    let (is_key_up, encoded_key) = if let Some(rest) = trimmed.strip_prefix("UP:") {
        (true, rest.to_owned())
    } else {
        (false, trimmed.to_owned())
    };
    let _ = event_tx.send(EncodedKeyEvent {
        encoded_key,
        backend: BACKEND_LL_HOOK.into(),
        received_at: runtime::timestamp_millis(),
        is_repeat: false,
        is_key_up,
    });
}
```

**Step 4: Run tests**

```bash
cd src-tauri && cargo test -- --skip capture_diag
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src-tauri/src/capture_backend.rs
git commit -m "feat: propagate is_key_up through EncodedKeyEvent and helper protocol"
```

---

### Task 4: Add `trigger_mode` to `ResolvedInputPreview`

The resolver needs to pass the binding's `trigger_mode` so the executor/worker can decide whether to hold or fire-and-forget.

**Files:**
- Modify: `src-tauri/src/resolver.rs:29-60` (ResolvedInputPreview struct)
- Modify: `src-tauri/src/resolver.rs:209-228` (resolve_input_preview fn, resolved branch)
- Modify: `src-tauri/src/resolver.rs:117-136` (unresolved branch)
- Modify: `src-tauri/src/resolver.rs:140-164` (ambiguous branch)
- Test: existing resolver tests

**Step 1: Write the failing test**

Add to `resolver::tests`:

```rust
#[test]
fn resolve_input_preview_includes_trigger_mode_from_binding() {
    let mut config = test_config(vec![]);
    config.bindings[0].trigger_mode = Some(TriggerMode::Hold);

    let result = resolve_input_preview(&config, "F13", "chrome.exe", "Docs");

    assert_eq!(result.trigger_mode, Some(TriggerMode::Hold));
}
```

**Step 2: Run test to verify it fails**

```bash
cd src-tauri && cargo test resolve_input_preview_includes_trigger_mode -- --nocapture
```

Expected: FAIL — `trigger_mode` field does not exist on ResolvedInputPreview.

**Step 3: Add `trigger_mode` to ResolvedInputPreview**

Add to the struct (after `mapping_source`):

```rust
#[serde(skip_serializing_if = "Option::is_none")]
pub trigger_mode: Option<TriggerMode>,
```

Add to all construction sites:

- Unresolved branch (~line 134): `trigger_mode: None,`
- Ambiguous branch (~line 163): `trigger_mode: None,`
- Resolved branch (~line 227): `trigger_mode: binding.and_then(|b| b.trigger_mode),`

**Step 4: Run tests**

```bash
cd src-tauri && cargo test -- --skip capture_diag
```

Expected: all tests pass including the new one.

**Step 5: Commit**

```bash
git add src-tauri/src/resolver.rs
git commit -m "feat: include trigger_mode in ResolvedInputPreview"
```

---

### Task 5: Add `send_shortcut_hold_down` / `send_shortcut_hold_up`

**Files:**
- Modify: `src-tauri/src/input_synthesis.rs`

**Step 1: Define `HeldShortcutState`**

Add after `ShortcutDispatchReport` (after line 9):

```rust
#[derive(Clone, Debug)]
pub struct HeldShortcutState {
    /// VK codes of modifiers we pressed down (in press order, for LIFO release).
    pub pressed_modifier_vks: Vec<VirtualKeySpec>,
    /// Primary key we pressed down (if any).
    pub primary_key: Option<VirtualKeySpec>,
}
```

**Step 2: Write failing tests**

Add to `input_synthesis::tests`:

```rust
#[test]
fn hold_down_presses_without_releasing() {
    let payload = ShortcutActionPayload {
        key: "A".into(),
        ctrl: true,
        shift: false,
        alt: false,
        win: false,
        raw: None,
    };
    let snapshot = ModifierSnapshot::default();

    let (inputs, _) = plan_shortcut_hold_down_inputs(&payload, &snapshot).unwrap();

    // Should have: Ctrl-down, A-down — NO key-ups
    assert!(inputs.iter().all(|input| match input {
        KeyboardInputSpec::VirtualKey { key_up, .. } => !key_up,
        KeyboardInputSpec::Unicode { key_up, .. } => !key_up,
    }));
    assert_eq!(inputs.len(), 2); // Ctrl-down + A-down
}

#[test]
fn hold_up_releases_in_reverse_order() {
    let held = HeldShortcutState {
        pressed_modifier_vks: vec![
            ModifierKey::Ctrl.virtual_key(),
            ModifierKey::Alt.virtual_key(),
        ],
        primary_key: Some(parse_primary_key("A").unwrap()),
    };

    let inputs = plan_shortcut_hold_up_inputs(&held);

    // Should have: A-up, Alt-up, Ctrl-up (reverse order)
    assert!(inputs.iter().all(|input| match input {
        KeyboardInputSpec::VirtualKey { key_up, .. } => *key_up,
        _ => false,
    }));
    assert_eq!(inputs.len(), 3);
}
```

**Step 3: Run tests to verify they fail**

```bash
cd src-tauri && cargo test hold_down_presses -- --nocapture
cd src-tauri && cargo test hold_up_releases -- --nocapture
```

Expected: FAIL — functions don't exist.

**Step 4: Implement `plan_shortcut_hold_down_inputs`**

```rust
fn plan_shortcut_hold_down_inputs(
    payload: &ShortcutActionPayload,
    snapshot: &ModifierSnapshot,
) -> Result<(Vec<KeyboardInputSpec>, HeldShortcutState), String> {
    let primary_key = if !payload.key.trim().is_empty() {
        let pk = parse_primary_key(&payload.key)?;
        if is_modifier_virtual_key(pk.code) {
            return Err("Hold-mode primary key must not be a modifier.".into());
        }
        Some(pk)
    } else {
        None
    };

    let desired_modifiers = [
        (ModifierKey::Win, payload.win),
        (ModifierKey::Ctrl, payload.ctrl),
        (ModifierKey::Alt, payload.alt),
        (ModifierKey::Shift, payload.shift),
    ];

    let mut inputs = Vec::with_capacity(5);
    let mut pressed_modifier_vks = Vec::new();

    for (modifier, desired) in desired_modifiers {
        if desired && !snapshot.is_active(modifier) {
            let key = modifier.virtual_key();
            push_virtual_key_down(&mut inputs, key);
            pressed_modifier_vks.push(key);
        }
    }

    if let Some(pk) = primary_key {
        push_virtual_key_down(&mut inputs, pk);
    }

    Ok((
        inputs,
        HeldShortcutState {
            pressed_modifier_vks,
            primary_key,
        },
    ))
}
```

**Step 5: Implement `plan_shortcut_hold_up_inputs`**

```rust
fn plan_shortcut_hold_up_inputs(held: &HeldShortcutState) -> Vec<KeyboardInputSpec> {
    let mut inputs = Vec::with_capacity(5);

    if let Some(pk) = held.primary_key {
        push_virtual_key_up(&mut inputs, pk);
    }

    // Release modifiers in reverse press order (LIFO)
    for key in held.pressed_modifier_vks.iter().rev() {
        push_virtual_key_up(&mut inputs, *key);
    }

    inputs
}
```

**Step 6: Implement public functions**

```rust
pub fn send_shortcut_hold_down(
    payload: &ShortcutActionPayload,
) -> Result<HeldShortcutState, String> {
    clear_external_modifiers()?;
    let snapshot = current_modifier_snapshot()?;
    let (plan, held) = plan_shortcut_hold_down_inputs(payload, &snapshot)?;

    if let Err(send_error) = send_keyboard_inputs(&plan) {
        // Best-effort cleanup: release what we pressed
        let cleanup = plan_shortcut_hold_up_inputs(&held);
        let _ = send_keyboard_inputs(&cleanup);
        return Err(send_error);
    }

    Ok(held)
}

pub fn send_shortcut_hold_up(held: &HeldShortcutState) -> Result<(), String> {
    let plan = plan_shortcut_hold_up_inputs(held);
    if plan.is_empty() {
        return Ok(());
    }
    send_keyboard_inputs(&plan)
}

/// Emergency release: blast key-up for all standard modifiers.
/// Used by panic hooks when exact held state is unknown.
pub fn release_all_modifiers() {
    #[cfg(target_os = "windows")]
    {
        let inputs = vec![
            KeyboardInputSpec::VirtualKey { code: vk_lcontrol(), extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: vk_lshift(), extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: vk_lmenu(), extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: vk_lwin(), extended: false, key_up: true },
        ];
        let _ = send_keyboard_inputs(&inputs);
    }
}
```

**Step 7: Run tests**

```bash
cd src-tauri && cargo test -- --skip capture_diag
```

Expected: all tests pass.

**Step 8: Commit**

```bash
git add src-tauri/src/input_synthesis.rs
git commit -m "feat: add send_shortcut_hold_down/hold_up for sustained key injection"
```

---

### Task 6: Hold-mode routing in `process_encoded_key_event`

The worker thread routes key-down events with `TriggerMode::Hold` to `send_shortcut_hold_down` and key-up events to `send_shortcut_hold_up`. Non-hold events continue through the existing `run_preview_action` path.

**Files:**
- Modify: `src-tauri/src/capture_backend.rs:131-141` (worker thread closure)
- Modify: `src-tauri/src/capture_backend.rs:787-898` (process_encoded_key_event)
- Modify: `src-tauri/src/executor.rs` (new `run_hold_shortcut_down` function)

**Step 1: Add held_actions state to worker thread**

Change lines 131–141 from:

```rust
let worker_thread = thread::spawn(move || {
    while let Ok(event) = event_rx.recv() {
        process_encoded_key_event(
            &worker_app,
            &worker_runtime_store,
            &worker_config,
            &worker_app_name,
            event,
        );
    }
});
```

to:

```rust
let worker_thread = thread::spawn(move || {
    let mut held_actions: std::collections::HashMap<String, crate::input_synthesis::HeldShortcutState> =
        std::collections::HashMap::new();

    while let Ok(event) = event_rx.recv() {
        process_encoded_key_event(
            &worker_app,
            &worker_runtime_store,
            &worker_config,
            &worker_app_name,
            event,
            &mut held_actions,
        );
    }

    // Channel closed (graceful shutdown) — release all held keys
    for (encoded_key, held) in held_actions.drain() {
        if let Err(e) = crate::input_synthesis::send_shortcut_hold_up(&held) {
            eprintln!("[capture] WARNING: Failed to release held shortcut `{encoded_key}`: {e}");
        }
    }
});
```

**Step 2: Update `process_encoded_key_event` signature**

Add `held_actions: &mut HashMap<String, HeldShortcutState>` parameter.

**Step 3: Add key-up handling at the top of `process_encoded_key_event`**

After the log entry push (line 806), add key-up handling before the window capture:

```rust
// --- Key-up path: release any held shortcut ---
if event.is_key_up {
    if let Some(held) = held_actions.remove(&event.encoded_key) {
        match crate::input_synthesis::send_shortcut_hold_up(&held) {
            Ok(()) => {
                log_entries.push((
                    "execution",
                    format!("Released held shortcut for `{}`.", event.encoded_key),
                    false,
                ));
            }
            Err(e) => {
                log_entries.push((
                    "execution",
                    format!("Failed to release held shortcut for `{}`: {e}", event.encoded_key),
                    true,
                ));
            }
        }
    } else {
        log_entries.push((
            "capture",
            format!("Received key-up for `{}` but no held action was active.", event.encoded_key),
            false,
        ));
    }
    flush_log_entries(runtime_store, log_entries);
    return;
}
```

**Step 4: Add hold-down routing after action resolution**

Replace the existing `executor::run_preview_action` call (line 877) with hold-aware routing:

```rust
let is_hold_shortcut = preview.trigger_mode == Some(crate::config::TriggerMode::Hold)
    && preview.action_type.as_deref() == Some("shortcut");

if is_hold_shortcut {
    // Hold-mode: press and keep held until key-up
    let action = config.actions.iter().find(|a| Some(a.id.as_str()) == preview.action_id.as_deref());
    if let Some(Action { payload: ActionPayload::Shortcut(payload), .. }) = action {
        match crate::input_synthesis::send_shortcut_hold_down(payload) {
            Ok(held) => {
                log_entries.push((
                    "execution",
                    format!("Held shortcut `{}` for `{}`.", preview.action_pretty.as_deref().unwrap_or("?"), preview.encoded_key),
                    false,
                ));
                held_actions.insert(event.encoded_key.clone(), held);
                flush_log_entries(runtime_store, log_entries);
                let _ = app.emit(EVENT_ACTION_EXECUTED, &executor::ActionExecutionEvent {
                    encoded_key: preview.encoded_key.clone(),
                    action_id: preview.action_id.clone().unwrap_or_default(),
                    action_type: "shortcut".into(),
                    action_pretty: preview.action_pretty.clone().unwrap_or_default(),
                    resolved_profile_id: preview.resolved_profile_id.clone(),
                    resolved_profile_name: preview.resolved_profile_name.clone(),
                    matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
                    control_id: preview.control_id.clone(),
                    layer: preview.layer.clone(),
                    binding_id: preview.binding_id.clone(),
                    mode: executor::ExecutionMode::Live,
                    outcome: executor::ExecutionOutcome::Injected,
                    process_id: None,
                    summary: format!("Holding shortcut `{}`.", preview.action_pretty.as_deref().unwrap_or("?")),
                    warnings: Vec::new(),
                    executed_at: runtime::timestamp_millis(),
                });
            }
            Err(e) => {
                log_entries.push(("execution", format!("Failed to hold shortcut: {e}"), true));
                flush_log_entries(runtime_store, log_entries);
                emit_runtime_error(app, runtime_store, &executor::RuntimeErrorEvent {
                    category: "execution".into(),
                    message: e,
                    encoded_key: Some(event.encoded_key.clone()),
                    action_id: preview.action_id.clone(),
                    created_at: runtime::timestamp_millis(),
                });
            }
        }
    } else {
        // Fallback: action not found or not shortcut, fire-and-forget
        log_entries.push(("execution", "Hold requested but action is not a shortcut; falling back to press.".into(), true));
        flush_log_entries(runtime_store, log_entries);
        // ... call run_preview_action as fallback
        match executor::run_preview_action(config, &preview) {
            Ok(execution) => {
                let _ = app.emit(EVENT_ACTION_EXECUTED, &execution);
            }
            Err(error) => {
                emit_runtime_error(app, runtime_store, &error.event);
            }
        }
    }
} else {
    // Existing fire-and-forget path (unchanged)
    match executor::run_preview_action(config, &preview) {
        Ok(execution) => {
            log_entries.push((
                "execution",
                format!("Runtime executed `{}` for `{}`.", execution.action_pretty, execution.encoded_key),
                false,
            ));
            for warning in &execution.warnings {
                log_entries.push(("execution", warning.clone(), true));
            }
            flush_log_entries(runtime_store, log_entries);
            let _ = app.emit(EVENT_ACTION_EXECUTED, &execution);
        }
        Err(error) => {
            flush_log_entries(runtime_store, log_entries);
            emit_runtime_error(app, runtime_store, &error.event);
        }
    }
}
```

**Step 5: Make required fields/types public in executor.rs**

Ensure `ActionExecutionEvent`, `ExecutionMode`, `ExecutionOutcome`, `RuntimeErrorEvent` are `pub` (they should already be). Check if `action_type` field on `ResolvedInputPreview` is available — it is (`action_type: Option<String>`).

**Step 6: Run tests**

```bash
cd src-tauri && cargo test -- --skip capture_diag
```

Expected: all tests pass.

**Step 7: Commit**

```bash
git add src-tauri/src/capture_backend.rs src-tauri/src/executor.rs
git commit -m "feat: route hold-mode shortcuts through hold_down/hold_up pipeline"
```

---

### Task 7: Safety net — panic hook + hold duration watchdog

**Files:**
- Modify: `src-tauri/src/lib.rs` or `src-tauri/src/main.rs` (panic hook setup)

**Step 1: Add panic hook at app startup**

In `main.rs` (or `lib.rs` `run()` function), before the Tauri app builder:

```rust
std::panic::set_hook(Box::new(|info| {
    // Emergency: release all modifiers to prevent stuck keys
    crate::input_synthesis::release_all_modifiers();
    eprintln!("[panic] Emergency modifier release. Panic info: {info}");
}));
```

**Step 2: Verify Cargo.toml panic strategy**

Check `[profile.release]` in Cargo.toml. If `panic = "abort"` is set, the panic hook won't run. Document this limitation in a code comment. If not set, the default is `unwind` and the hook works.

**Step 3: Run tests**

```bash
cd src-tauri && cargo test -- --skip capture_diag
```

Expected: all tests pass.

**Step 4: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/lib.rs
git commit -m "feat: add panic hook for emergency modifier release"
```

---

### Task 8: Manual integration test

No automated integration test (requires running Tauri + Razer hardware). Manual test procedure:

1. Set a binding on a top button (e.g., Thumb01 Hypershift) to `TriggerMode::Hold` with a shortcut action (e.g., `Alt+Tab`)
2. Start the runtime
3. Hold the mouse button — the shortcut should remain active (Alt+Tab stays open)
4. Release the mouse button — the shortcut should release
5. Verify debug log shows "Held shortcut" and "Released held shortcut" entries
6. Verify no stuck keys after release
7. Test crash recovery: force-kill the app while holding — verify modifier keys aren't stuck

---

## Architecture diagram

```
Mouse button held → Razer Synapse → Ctrl+Shift+F24 key-down
  ↓
LL Hook (helper process)
  → process_helper_key_event: WM_KEYDOWN → suppressions.insert(F24, "Ctrl+Shift+F24")
  → HELPER_MATCHES: push "Ctrl+Shift+F24"
  → stdout: "Ctrl+Shift+F24\n"
  ↓
Reader thread (main process)
  → EncodedKeyEvent { encoded_key: "Ctrl+Shift+F24", is_key_up: false }
  ↓
Worker thread
  → resolve_input_preview → trigger_mode: Hold, action: Shortcut
  → send_shortcut_hold_down(payload) → SendInput: Ctrl↓ Shift↓ F24↓ (no release)
  → held_actions.insert("Ctrl+Shift+F24", HeldShortcutState)
  ↓

Mouse button released → Razer Synapse → F24 key-up
  ↓
LL Hook
  → process_helper_key_event: WM_KEYUP → suppressions.remove(F24) → "Ctrl+Shift+F24"
  → HELPER_MATCHES: push "UP:Ctrl+Shift+F24"
  → stdout: "UP:Ctrl+Shift+F24\n"
  ↓
Reader thread
  → EncodedKeyEvent { encoded_key: "Ctrl+Shift+F24", is_key_up: true }
  ↓
Worker thread
  → held_actions.remove("Ctrl+Shift+F24") → HeldShortcutState
  → send_shortcut_hold_up(held) → SendInput: F24↑ Shift↑ Ctrl↑
```
