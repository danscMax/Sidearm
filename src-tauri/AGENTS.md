# src-tauri — Backend (Rust + Tauri v2)

## Purpose

The Rust backend: low-level keyboard capture, Razer-encoding detection, action execution (keystrokes, mouse, text/snippets, sequences, launches), config persistence with backups/recovery, Synapse import, window/foreground resolution, and the Tauri IPC surface.

## Ownership

- `src/lib.rs` — Tauri app setup + the `#[tauri::command]` handlers (the IPC surface called from `src/lib/backend.ts`).
- `src/config.rs` — `AppConfig`, load/save, schema + semantic validation, atomic writes, rolling/daily backups, corrupt-recovery + newer-schema guard.
- `src/executor.rs` — runs actions; `src/input_synthesis.rs` — `SendInput` keystroke/mouse/text, clipboard paste, snippet-token expansion.
- `src/backup.rs`, `src/resolver.rs`, `src/window_capture.rs`, `src/hotkeys.rs`, `src/vk.rs`, `src/chord.rs`, `src/recorder.rs`.
- Manifests: `Cargo.toml`, `tauri.conf.json`, `capabilities/` (under src-tauri). The config JSON schema is `schemas/config.v2.schema.json` at the repo ROOT, bundled into `config.rs` via `include_str!("../schemas/...")`.
- Delegated to children: `src/capture_backend/`, `src/synapse_import/`, `src/platform/`.

## Local Contracts

- Internal fns return `Result<T, String>`; convert to `CommandError` at the IPC boundary.
- Config is schema-first: the bundled `config.v2.schema.json` validates raw JSON before deserialize. A persisted field rename needs `anyOf`(both names) in the schema + `#[serde(alias)]`. Keep the Rust structs, `src/lib/config.ts`, and the schema in sync.
- Config writes are atomic (temp + rename); backups (rolling rotation, daily snapshot, last-known-good) are best-effort and never fail the save. A corrupt `config.json` recovers from last-known-good/rolling backups; a config declaring a newer schema version is never overwritten.
- Self-injected input carries `INTERNAL_SENDINPUT_EXTRA_INFO`; VK 0xE8 is the mask/probe key (`vk.rs` `VK_MASK_KEY`), deliberately not a modifier.

## Work Guidance

- `unwrap`/`expect` only where a preceding branch guarantees safety; never on user/hardware-controlled input.

## Verification

- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` (zero warnings) and `cargo test --manifest-path src-tauri/Cargo.toml`.
- `cargo` is at `C:\Users\User\.cargo\bin\cargo.exe` (not on the bash PATH).

## Child DOX Index

- `src-tauri/src/capture_backend/AGENTS.md` — LL keyboard hook + Razer encoding detection
- `src-tauri/src/synapse_import/AGENTS.md` — Razer Synapse profile import
- `src-tauri/src/platform/AGENTS.md` — OS-specific display/input/window/shell
