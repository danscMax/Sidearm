# src-tauri/src/synapse_import — Razer Synapse import

## Purpose

Parse exported Razer Synapse profiles (`.synapse3` / `.synapse4`, incl. zipped) and map them into Sidearm's `AppConfig` bindings/actions.

## Ownership

- `mod.rs` — entry point + candidate discovery + warning collection.
- `format_v3.rs`, `format_v4.rs` — version-specific parsers.
- `macro_steps.rs`, `macro_xml.rs`, `makecode.rs`, `mapping.rs`, `merge.rs`, `types.rs`.

## Local Contracts

- Untrusted input: enforce a zip budget (`enforce_zip_budget`), never panic on malformed data — collect warnings and continue.
- Canonicalize keys on the way in: F-key tokens to `F{n}`, bare-modifier VKs folded to modifier flags, dedupe case-insensitive path collisions.
- Report skipped/unreadable entries as warnings rather than failing the whole import.

## Work Guidance

(empty)

## Verification

- `cargo test` (includes parser edge/property tests) + `cargo clippy ... -D warnings`.

## Child DOX Index

- None. Leaf directory.
