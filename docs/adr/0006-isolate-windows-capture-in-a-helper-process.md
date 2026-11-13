# ADR-0006: Isolate Windows Capture in a Helper Process

- Status: Accepted; supersedes ADR-0002 for capture-process placement
- Date: 2026-11-13

## Context

Windows low-level hooks have a strict callback latency budget and can be removed
silently after a timeout. Their message pump and held-input state need an explicit
lifecycle, diagnostics and recovery independent of the Tauri event loop.
ADR-0002's iteration 1 single-process description no longer describes capture.
This record documents the implemented boundary; it introduces no runtime change.

## Considered Options

1. Keep capture in the Tauri process: simpler lifecycle, shared failure domain.
2. Run the same executable as a capture helper: isolated hooks, explicit pipe
   lifecycle, no second binary to package. This is the implemented choice.
3. Package an independent Tauri `externalBin`: adds a binary/version boundary
   without a current requirement for an independent daemon.

## Decision

- The main process owns validated config, foreground/profile resolution,
  bindings, action execution, persistence and the live-map sessions. The helper
  owns the keyboard/mouse hook message pump, consumer readers and transient
  pressed/modifier/layer state; it does not persist config or resolve actions.
- `spawn_capture_helper` starts the same executable with `--capture-helper`.
  `main.rs` selects helper mode before Tauri setup. This is a subprocess,
  not a separately packaged Tauri sidecar or `externalBin`.
- Pipes carry newline-delimited messages. Parent stdin first sends JSON init
  (registrations, readers, triggers, timing and data directory); subsequent
  commands include `HS2:<code>` for profile trigger changes. Helper stdout sends
  encoded-key lines with release/repeat and `HS:`/`H2:`/`M<index>:` stamps,
  reader status and diagnostics. Stderr is copied into the parent log.
- Normal stop closes stdin, ends the helper pump, unhooks and releases state;
  the parent waits and kills a helper that does not stop. Unexpected helper EOF
  schedules bounded capture restart (1/5/30 seconds, generation-checked); repeated
  death or failed restart stops capture and exposes `helperLost`.
- When its parent dies, the helper starts the same executable in
  `--restore-live-maps` mode. Restoring live maps and a sleeping mouse's queued
  offline profile has its own mutex/lifecycle and may outlive the app.

## Consequences

The Rust domain/runtime stays in the main process. Hook failures and diagnostics
cross an explicit process boundary; no new plugin permissions or bundled binary
are required. Changes to pipe commands must update both producer and consumer.
The operational contract and hardware constraints remain in
[`src-tauri/src/capture_backend/AGENTS.md`](../../src-tauri/src/capture_backend/AGENTS.md).

## References

- [ADR-0002](0002-use-tauri-v2-react-rust-in-process-architecture.md)
- [Tauri external binaries](https://v2.tauri.app/develop/sidecar/)
- `src-tauri/src/main.rs`, `src-tauri/src/capture_backend/windows.rs`,
  `src-tauri/src/mouse_restore.rs`
