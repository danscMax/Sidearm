# Research: Hold-Through Input Synthesis on Windows (Rust)

## Summary

This document covers seven areas relevant to implementing "hold-through" input synthesis — injecting a key-down event and deferring the key-up until a physical release event is observed. The existing codebase uses `windows-sys 0.61` with `SendInput`, thread-local state inside the LL hook callback, and a dedicated hook thread feeding an `mpsc::channel` to a worker thread. These are all sound foundations. The main gaps for hold-through are: (1) no cross-thread held-key registry, (2) no repeat-event filtering in the LL hook, (3) no cleanup path on panic/crash, and (4) the Alt-menu side-effect when injecting Alt-down. Each of these has a well-known solution documented here.

---

## 1. SendInput for Sustained Key Holds

### How Hold-Through Works

`SendInput` is a one-shot injection. To hold a key, you send a `KEYBDINPUT` with `dwFlags = 0` (key-down) and do **not** immediately follow it with `KEYEVENTF_KEYUP`. The OS treats the key as held; applications, games, and the keyboard state APIs all see it as down. You send the `KEYEVENTF_KEYUP` event later, from any thread, at any time.

Key guarantee from MSDN (confirmed July 2025 docs): "The SendInput function inserts the events in the INPUT structures serially into the keyboard or mouse input stream. These events are not interspersed with other keyboard or mouse input events inserted either by the user (with the keyboard or mouse) or by calls to keybd_event, mouse_event, or other calls to SendInput."

This means a single `SendInput` call is **atomic** — all events in the array land contiguously. A separate later `SendInput` for the key-up will be ordered after whatever real hardware events have occurred in between.

### Gotchas

**State not reset**: `SendInput` does not reset existing key state. If a key is already held (physically or injected), sending another key-down is a no-op from the OS perspective; the state stays down. Sending key-up when the key is not down is also a no-op. This means double-injection is safe but wasteful.

**Partial failure**: The return value is the count of events actually inserted. If it is less than `cInputs`, check `GetLastError`. UIPI (User Interface Privilege Isolation) is the most common cause — the injecting process must be at equal or higher integrity than the target. Critically, **UIPI failures return zero with `GetLastError` returning zero too** (no error code is set). The existing codebase handles this correctly at line 666 of `input_synthesis.rs`.

**Scan code matters**: Always populate `wScan` via `MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)`. Some applications read scan code instead of VK for held-key detection (especially games). The existing code does this correctly.

**`dwExtraInfo` round-trip**: Setting `INTERNAL_SENDINPUT_EXTRA_INFO` on injected events is essential — it lets the LL hook callback skip own-injected events to prevent feedback loops. The existing code does this correctly.

**`time: 0` is fine**: Windows fills in the actual timestamp; passing 0 is the recommended approach.

### Relevant Existing Code
- `E:/Scripts/Razer Naga Studio/src-tauri/src/input_synthesis.rs`, function `send_keyboard_inputs` (line 601)
- `push_virtual_key_down` / `push_virtual_key_up` helpers (lines 248-262)

---

## 2. WH_KEYBOARD_LL: Propagating Key-Down and Key-Up to Worker Thread

### Delivery Model

The LL hook callback runs in the context of the **thread that installed the hook** (not a separate "hook thread" injected into other processes). It is delivered via a sent-message mechanism during `GetMessageW`/`PeekMessageW`. Critically: **the callback is called before the asynchronous key state is updated**, which means `GetAsyncKeyState` called from inside the callback reflects the *previous* state, not the current event's state. This is documented in the MSDN remarks for `LowLevelKeyboardProc`.

### Ordering Guarantee

WH_KEYBOARD_LL events are delivered to your hook in the same order they arrive from the input driver. The OS kernel serializes all keyboard input through a single queue before dispatching to LL hooks. There is no documented FIFO guarantee per se, but in practice (and consistent with all AHK/RawInput literature) key-down always precedes its own key-up for the same key. However, **interleaving between different keys is not guaranteed to be in physical time order** when multiple keys are held simultaneously.

**Practical implication**: For hold-through, you will observe: `KEYDOWN(thumb button)` → later `KEYUP(thumb button)`. These will not be reordered. What may interleave are other keys pressed in between.

### Worker Thread Pattern (Current Architecture)

The existing code in `capture_backend.rs` (line 123-141) already follows the correct pattern:
1. Hook thread runs `GetMessageW` message pump — delivers LL callbacks serially
2. Callback sends to `mpsc::channel<EncodedKeyEvent>` (non-blocking, `send` not `recv`)
3. Worker thread blocks on `event_rx.recv()` and does actual work

**This pattern is correct for hold-through.** The key-down event goes through the channel; the key-up event goes through the channel later. The `mpsc::channel` preserves insertion order (FIFO), so downstream ordering matches hook delivery ordering.

**Race condition risk**: There is one subtle race. The hook callback and any `SendInput` calls from the worker thread run on different threads. While `SendInput` itself is atomic (its own events land contiguously), the hook callback can fire between two `SendInput` calls from the worker. For hold-through, this means: if the hook fires the key-up channel event before the worker thread has finished its key-down `SendInput`, the worker might try to send key-up before the injected key-down has been processed. Mitigation: send the injected key-down inside `SendInput` before posting the key-up event to any queue, and ensure the held-key state is updated atomically with a `Mutex` or `AtomicU64`.

### Timeout Constraint (Critical)

**The hook callback must return in under 1000 ms on Windows 10 1709+.** From MSDN: "on Windows 7 and later, the hook is silently removed without being called. There is no way for the application to know whether the hook is removed." The 1 second cap is hard-coded since Windows 10 1709 regardless of `LowLevelHooksTimeout`.

This means: **never do any blocking work in the callback**. The existing code sends to an unbounded `mpsc::channel` (non-blocking send) and then returns immediately — correct. For hold-through, the callback must similarly only update a shared state struct (e.g., write to an `AtomicU64` bitmask or send to a channel) and return.

---

## 3. State Tracking for Held Keys

### What Needs Tracking

You need to know which virtual key codes are currently "held" by your injection so that when the physical key-up arrives, you can send the corresponding injected key-up. This state must be:
- Readable from the hook thread (to decide whether a key-up should trigger an injected key-up)
- Writable from the worker thread (when a hold-through injection begins)

### Thread Safety Options

**Option A — `AtomicU64` bitmask**: For a small fixed set of keys (e.g., only modifier keys), store a bitmask. `AtomicU64` with `Ordering::SeqCst` provides lock-free read/write from any thread. Sufficient if only tracking 1-5 specific VK codes.

**Option B — `Arc<Mutex<HashSet<u16>>>>`**: For arbitrary VK codes, use a `HashSet<u16>` behind `Arc<Mutex<...>>`. The hook callback acquires the lock briefly to check membership; the worker acquires it to insert/remove. Lock contention is negligible since the hook callback is fast. This is the clearest approach for general hold-through.

**Option C — `Arc<DashMap<u16, ()>>`** (requires `dashmap` crate): Concurrent hashmap. Lock-free reads, fine-grained write locks. Useful if the set of held keys is large and contention is a concern — overkill for this use case.

**Recommended for this codebase**: Option B — `Arc<Mutex<HashSet<u16>>>`. Already uses `Arc<Mutex<RuntimeStore>>` pattern (line 4, `capture_backend.rs`), consistent with existing style.

### Pattern

```rust
// In the shared state struct visible to both hook thread and worker thread:
pub held_injected_keys: Arc<Mutex<HashSet<u16>>>,

// Worker thread — when starting a hold:
{
    let mut held = held_injected_keys.lock().unwrap();
    held.insert(vk_code);
}
send_keyboard_inputs(&[KeyboardInputSpec::VirtualKey { code: vk_code, extended, key_up: false }])?;

// Hook callback — on WM_KEYUP/WM_SYSKEYUP for a non-injected event:
let should_release = {
    let mut held = held_injected_keys.lock().unwrap();
    held.remove(&vk_code)  // returns true if it was present
};
if should_release {
    // Post to worker thread channel: release this key
    let _ = event_tx.send(ReleaseEvent { vk: vk_code });
}

// Worker thread — on receiving release event:
send_keyboard_inputs(&[KeyboardInputSpec::VirtualKey { code: vk_code, extended, key_up: true }])?;
```

**Important**: The hook callback must not call `SendInput` directly (to avoid blocking the hook pump). Post the release to a channel and let the worker thread call `SendInput`.

---

## 4. Auto-Repeat Handling

### The Problem

When a physical key is held, Windows generates repeated `WM_KEYDOWN` / `WM_SYSKEYDOWN` messages at the keyboard repeat rate. These arrive as LL hook callbacks with the same VK code. Without filtering, a hold-through implementation would reinject a key-down on every repeat, and potentially trigger repeated actions.

### Where the Repeat Flag Lives

**For WM_KEYDOWN / WM_SYSKEYDOWN at the window-message level**: The `lParam` bit 30 ("previous key state") is 1 for repeats and 0 for the first press.

**For WH_KEYBOARD_LL / KBDLLHOOKSTRUCT**: The `flags` field does **not** contain a direct repeat bit. The KBDLLHOOKSTRUCT flags are: `LLKHF_EXTENDED` (bit 0), `LLKHF_LOWER_IL_INJECTED` (bit 1), `LLKHF_INJECTED` (bit 4), `LLKHF_ALTDOWN` (bit 5), `LLKHF_UP` (bit 7). **There is no "previous key state" bit in `KBDLLHOOKSTRUCT.flags`**.

### Filtering Repeats in the LL Hook

Since `KBDLLHOOKSTRUCT` has no repeat bit, you must track state yourself. The existing `capture_backend.rs` already does this correctly via `HELPER_SUPPRESSIONS` (a `HashSet<u32>` of VK codes, line 341):

```rust
// On KEYDOWN:
let is_repeat = !suppressions.insert(vk);  // insert returns false if already present
if !is_repeat { /* first press */ }

// On KEYUP:
suppressions.remove(&vk);
```

This is the standard pattern used by AHK, the `win-hotkeys` crate, and other production implementations. The first `KEYDOWN` for a VK inserts it into the set (returns true = not a repeat). Subsequent `KEYDOWN`s fail the insert (returns false = repeat). `KEYUP` removes it, resetting the state.

**For hold-through specifically**: You should skip re-injecting the held key-down on repeats. Check the suppression set before deciding whether to start a new hold.

---

## 5. Modifier Key Interaction: Alt Menu Activation

### The Problem

When you inject `VK_LMENU` (Alt) key-down and hold it, Windows sees Alt as logically pressed. If the held Alt is later followed by any other key reaching `DefWindowProc`, it generates a `WM_SYSCOMMAND` / `SC_KEYMENU`, potentially activating the foreground application's menu bar. This is a well-documented gotcha in AHK and all input automation tools.

### What LLKHF_INJECTED Changes

Injected Alt does activate the menu bar in the focused application if it receives the `WM_SYSKEYDOWN` message and passes it to `DefWindowProc`. The `LLKHF_INJECTED` flag is visible to other LL hooks (they can detect it), but applications in their window procedure do **not** get this flag — they only get `WM_SYSKEYDOWN` with no indication of injection. So being injected does not automatically suppress the menu-bar behavior.

### Mitigations

**1. Inject `VK_RMENU` instead of `VK_LMENU` for non-UI contexts**: On systems with the US layout, `VK_RMENU` triggers `WM_KEYDOWN`, not `WM_SYSKEYDOWN`, because Right-Alt is often mapped to AltGr. However, this is keyboard-layout-dependent and not reliable cross-locale.

**2. Send the paired key immediately**: The menu bar activates only when Alt is *released* without an intervening non-modifier keypress (this triggers `WM_SYSCOMMAND SC_KEYMENU` from `DefWindowProc` on `WM_KEYUP`). In hold-through scenarios you are often holding Alt *with* a primary key, which suppresses the menu activation. Pure Alt-hold without any other key is the dangerous case.

**3. Use `WM_SYSKEYDOWN` detection in your own hook and send `VK_F10`-like neutralizers**: Advanced — generally not needed unless you're doing standalone Alt hold with no primary key.

**4. The real production mitigation (used by AHK)**: When injecting Alt-down and then Alt-up *without* an intervening key, inject a dummy `VK_PACKET` or `VK_F10` with `KEYEVENTF_KEYUP` to cancel the pending menu command. Rarely needed for a thumb-button remapper that always pairs Alt with a primary key.

### LLKHF_INJECTED Considerations

- `LLKHF_INJECTED` is set on every event sent via `SendInput` or `keybd_event` — there is no way to suppress this flag.
- Your own LL hook should check `dwExtraInfo == INTERNAL_SENDINPUT_EXTRA_INFO` (as the existing code does) rather than `LLKHF_INJECTED` alone, because other processes may inject events too that you should not ignore.
- Third-party security software and anti-cheat systems filter based on `LLKHF_INJECTED` — injected events are widely detectable.
- `LLKHF_LOWER_IL_INJECTED` (bit 1) is set when the injecting process has lower integrity than the receiver. A standard desktop app runs at medium integrity, so this bit is typically not set for peer-process injection.

---

## 6. Cleanup and Safety: Stuck Keys on Process Crash

### The Core Problem

If your process crashes or panics while a key is held via `SendInput`, the OS has no automatic mechanism to release that key. The key state lives in the Win32 input system, not in any per-process resource that gets cleaned up on exit. The key remains "pressed" until something sends a `KEYEVENTF_KEYUP` for it, or until the user physically presses and releases the key (which generates real hardware events that reset the logical state).

This is a real-world problem: AHK users frequently report Ctrl/Alt/Win being stuck after AHK crashes.

### Mitigation Strategies

**Strategy 1 — Rust panic hook** (covers panics, not abort):

```rust
let original_hook = std::panic::take_hook();
std::panic::set_hook(Box::new(move |info| {
    release_all_injected_held_keys();  // call SendInput with KEYEVENTF_KEYUP for all held VKs
    original_hook(info);
}));
```

This runs on `panic!` with `unwind` strategy. With `panic = "abort"` in Cargo.toml (common for Tauri release builds), this hook does NOT run. Check your profile settings.

**Strategy 2 — Tauri `on_window_event` / graceful shutdown**:

Register a handler on app exit that releases all held keys before termination. This covers normal exits. The existing `RuntimeController::stop()` is the right place to add a `release_all_held_keys()` call.

**Strategy 3 — ctrlc signal handler**:

Use the `ctrlc` crate to intercept Ctrl+C / console close events:

```rust
ctrlc::set_handler(move || {
    release_all_injected_held_keys();
    std::process::exit(0);
}).expect("Error setting Ctrl-C handler");
```

**Strategy 4 — Keep the hold duration bounded**:

The safest design is to not hold keys indefinitely. Apply a maximum hold duration (e.g., 30 seconds) as a watchdog. If the physical key-up never arrives (because the hook died), the watchdog timer sends the key-up. A `tokio::time::sleep` or `std::thread::sleep` in the worker thread, checking the held-key state periodically, covers this.

**Strategy 5 — Atomic generation counter** (detect stale holds):

Each hold-through session gets a unique u64 ID. When the session ends normally, the key-up is sent. A background watchdog periodically checks if any held key has an ID older than N seconds and releases it. Robust against crashes within the worker thread.

### What Does NOT Work

- `atexit` via C FFI: runs only on orderly `exit()`, not on panic or signal-kill.
- Rust `Drop` on `Arc<...>`: struct drops don't run on `panic = "abort"` or process kill.
- OS cleanup: Windows does not release injected key state on process exit. Confirmed behavior across Windows 7 through Windows 11.

### Recommendation

Minimum viable safety net for this codebase:
1. Add `std::panic::set_hook` at startup that releases all held keys.
2. Add maximum hold duration (30 seconds, matching the existing executor sleep cap).
3. Release all held keys inside `RuntimeController::stop()`.

---

## 7. windows-sys vs windows Crate: 2025-2026 Recommendation

### Current State (March 2026)

Both crates are actively maintained by Microsoft's Rust team. As of March 2026:
- `windows-sys` is at **0.61.2** (this codebase uses 0.61)
- `windows` is at **0.62.2**

### Key Differences

| Aspect | `windows-sys` | `windows` |
|---|---|---|
| API surface | C-style Win32 only (externs, structs, consts) | C-style + COM + WinRT |
| Compile time | Significantly faster (no function bodies) | Slower due to COM codegen |
| `no_std` support | Yes | No |
| Ergonomics | Raw, unsafe, direct | Safer wrappers, RAII |
| Helper types | None | `HSTRING`, RAII handles, etc. |
| Dependency weight | Minimal | Heavier |

### Crate Author Guidance (Kenny Kerr, Microsoft)

From the official guidance: "windows-sys is a zero-overhead fallback for the most demanding situations and primarily where the absolute best compile time is essential." The `windows` crate is recommended when you need COM/WinRT, prefer idiomatic Rust, or benefit from safety wrappers.

### 2025 Architecture Change

In 2025, `windows-sys 0.61` switched to depend on `windows-link` (using `raw-dylib` unconditionally). This eliminated the need for `.lib` files and improved cross-compilation and developer ergonomics significantly — closing one of the gaps that previously made `windows-sys` less attractive.

### Recommendation for This Codebase

**Stick with `windows-sys 0.61`**. Rationale:
1. The codebase only calls C-style Win32 APIs — no COM, no WinRT.
2. Tauri itself already pulls in compile-time weight; minimizing additional compile time is valuable.
3. The existing code is clean, correct, and consistently uses `windows-sys`. Migrating to `windows` would be a large diff for no functional gain.
4. `windows-sys 0.61` now uses `raw-dylib`, so the main historical ergonomic disadvantage (requiring `.lib` files) is resolved.

If a future need for COM or WinRT arises, migrate selectively (the two crates can coexist).

---

## Existing Code Analysis

### Relevant Files

- `src-tauri/src/input_synthesis.rs` — All `SendInput` logic. Exports `send_shortcut`, `send_text`, `send_hotkey_string`. Key internal: `send_keyboard_inputs` (line 601), `clear_external_modifiers` (line 524). Uses `INTERNAL_SENDINPUT_EXTRA_INFO` sentinel correctly.
- `src-tauri/src/capture_backend.rs` — LL hook infrastructure. Key sections: `CaptureBackendHandle` (line 100), `helper_ll_keyboard_proc` (line 392), `HELPER_SUPPRESSIONS` repeat-filter (line 341), worker thread channel pattern (line 131).
- `src-tauri/src/hotkeys.rs` — VK code parsing, modifier mask building.
- `src-tauri/Cargo.toml` — `windows-sys = { version = "0.61", features = [...] }` (line 30).

### Patterns Found

- Repeat suppression via `HashSet<u32>` insert/remove (capture_backend.rs lines 341, 368-369, 381) — correct and production-quality.
- Internal injection detection via `dwExtraInfo` sentinel (capture_backend.rs line 406) — correct, better than `LLKHF_INJECTED` alone.
- Worker thread `mpsc::channel` pattern — hook sends, worker receives and acts (lines 123-141).
- Thread-local state for LL hook callback (`thread_local!` at line 335) — avoids `Mutex` inside the hook, correct for single-threaded hook pump.
- `PostThreadMessageW(WM_APP, ...)` to wake message pump from inside hook callback (line 440-447) — correct solution to the "LL callbacks don't cause GetMessageW to return" problem.

### Dependencies and Interfaces

- `send_keyboard_inputs` is private to `input_synthesis.rs`. For hold-through, you would add `send_keyboard_hold(vk: u16, extended: bool)` and `send_keyboard_release(vk: u16, extended: bool)` as thin wrappers, or extend `KeyboardInputSpec`.
- `RuntimeController::start/stop` in `capture_backend.rs` is the lifecycle boundary. Add `release_all_held_keys()` in `stop()`.
- The held-key state registry (`Arc<Mutex<HashSet<u16>>>`) must be shared between `CaptureBackendHandle` (so the hook callback can read it and post releases) and the executor (so action execution can write to it). Likely lives in `RuntimeStore` or alongside it.

---

## Risks and Considerations

1. **`panic = "abort"` in release profile**: Tauri projects often set this for smaller binaries. Verify `src-tauri/Cargo.toml` profiles. If abort is set, `std::panic::set_hook` will not run on panic — the watchdog timer becomes the only safety net.

2. **Alt-menu activation in hold-through**: Injecting `VK_LMENU` hold without a paired primary key will likely activate the menu bar of whatever application has focus when Alt is released. This is a UX hazard. For the Naga use case (thumb button remapping), Alt is always paired with another key, so this is low risk — but worth documenting in the feature spec.

3. **Hook callback lock contention**: If the held-key `Mutex` is held by the worker thread during a lengthy `SendInput` call, the hook callback will block waiting for the lock. `SendInput` is fast (microseconds), so this should never approach the 1-second hook timeout. Still, keep the lock scope minimal.

4. **Key-up for a key that was released before the worker processes it**: If the physical key-up arrives and the worker thread is busy, the hook posts the release event. But if the worker is mid-`SendInput` for a different key, it will see the release event after returning. The key-up `SendInput` then goes out slightly late. This is fine — the OS sees the key-up, it just had a small delay. The key will not get "stuck" as long as the channel is drained.

5. **Multiple simultaneous held keys**: If two thumb buttons are held simultaneously, each gets its own entry in the held-key `HashSet`. Key-up events for each are tracked independently. No cross-contamination risk with the `HashSet` approach.

6. **`dwExtraInfo` for released keys**: When sending the injected key-up (in response to physical key-up), use `INTERNAL_SENDINPUT_EXTRA_INFO` on the key-up event too. Otherwise, your own LL hook will see the injected key-up, remove it from the suppression set (which it was not in, since it was an injected event), and possibly corrupt state.

7. **KBDLLHOOKSTRUCT repeat bit absent**: There is no repeat flag in the LL hook struct itself. You must maintain your own suppression `HashSet`. The existing code does this. For hold-through, extend the same pattern.

---

## Recommendations

1. **Held-key registry**: Add `Arc<Mutex<HashSet<u16>>>` to the runtime state (alongside `RuntimeStore`). Inject reference into both the worker thread and the hook callback (via the thread-local `HELPER_*` pattern or via a new global/thread-local).

2. **Key-up propagation from hook**: When the hook sees `WM_KEYUP` for a VK that is in the held-key set, send a `ReleaseHeldKey(vk)` event through the existing `mpsc::channel` to the worker thread. The worker then calls `SendInput(KEYEVENTF_KEYUP)`. Never call `SendInput` from inside the hook callback.

3. **Repeat filtering**: Already implemented in the helper process. Ensure the main process hook (if it ever handles non-modifier keys for hold-through) applies the same `HashSet::insert` → `false == repeat` pattern.

4. **Panic hook**: At startup, call `std::panic::set_hook` to release all held keys. Check `Cargo.toml` for `panic = "abort"` in `[profile.release]` — if present, add a watchdog timer instead.

5. **Maximum hold duration watchdog**: Add a configurable max hold (default 30 s, matching the sequence sleep cap in `executor.rs`). The worker thread tracks hold start time and sends key-up automatically if exceeded.

6. **Alt-menu mitigation**: Document in the feature spec that hold-through of Alt alone is not supported (or add a neutralizer injection). For the Naga use case where Alt is always paired, this is informational only.

7. **Crate choice**: Remain on `windows-sys 0.61`. No migration needed.

---

## Sources

- [SendInput function (winuser.h) - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- [KBDLLHOOKSTRUCT (winuser.h) - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-kbdllhookstruct)
- [LowLevelKeyboardProc callback - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc)
- [WM_KEYDOWN message - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-keydown)
- [WM_SYSKEYDOWN message - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-syskeydown)
- [Choosing between windows and windows-sys crates - Kenny Kerr](https://kennykerr.ca/rust-getting-started/windows-or-windows-sys.html)
- [Rust for Windows – August 2025 (microsoft/windows-rs)](https://github.com/microsoft/windows-rs/issues/3746)
- [win-hotkeys crate (iholston/win-hotkeys)](https://github.com/iholston/win-hotkeys)
- [std::panic::set_hook - Rust standard library](https://doc.rust-lang.org/std/panic/fn.set_hook.html)
