# src-tauri/src/capture_backend — Keyboard capture

## Purpose

The low-level keyboard hook and the Razer-encoding detector: turns raw key events into encoded button signals (F13–F24 + Hypershift), suppresses/replays modifiers, dispatches actions, and keeps holds alive.

## Ownership

- `windows.rs` — `WH_KEYBOARD_LL` hook, encoding-chord detection, modifier buffering, hook-health probe, the capture worker + bounded event channel, foreground watcher.
- `mod.rs` — `process_encoded_key_event`: profile resolution, action lookup, dispatch, hold/release handling.
- `linux.rs` — Linux capture (not the primary target).

## Local Contracts

- This is a hard-latency path (the LL hook callback has a ~200–300ms system budget): no heavy work, allocations, or blocking in the hook callback. Per-keystroke work already got audited/optimized — do not regress it.
- The mask/probe key is VK 0xE8 (`VK_PROBE_KEY` / `VK_MASK_KEY`); the hook passes it through and it is not a modifier.
- The event channel is bounded and drops on full by design (a stalled consumer must not block the producer). Prefer draining releases promptly so holds don't stick.
- Razer encoding window (~10ms) vs modifier replay buffer (~20ms) are tuned constants — change only with real hardware measurements.

## Work Guidance

- Prefer linear scans over hash maps for the small hotkey/action sets (cache locality beats hashing at these sizes on this budget).

## Verification

- `cargo test` + `cargo clippy ... -D warnings`. Behaviour that depends on real hardware/UAC needs a manual check on the device.

## Child DOX Index

- None. Leaf directory.
