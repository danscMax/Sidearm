# schemas — Config JSON Schema (contract)

## Purpose

The runtime-validated JSON Schema for `AppConfig` — the single source of truth for the config contract, bundled into the Rust backend and validated before every deserialize, import, and preset load.

## Ownership

- `config.v2.schema.json` — bundled into `src-tauri/src/config.rs` via `include_str!("../schemas/config.v2.schema.json")`.

## Local Contracts

- This schema, the Rust structs (`src-tauri/src/config.rs`), and the TS types (`src/lib/config.ts`) form a three-way contract — a change in any one requires the other two.
- Enum lists (`$defs.actionType.enum`, `$defs.mouseActionKind.enum`, `$defs.mediaKeyKind.enum`) must match the Rust enums; `config.rs` has schema-sync tests that assert this.
- A persisted field rename = `anyOf`(both names) here + `#[serde(alias)]` in Rust, so older configs still load.
- `version` is pinned to `SCHEMA_VERSION`; bump it deliberately (a newer-version config is never overwritten by an older app).

## Work Guidance

(empty)

## Verification

- `cargo test` — the schema-sync and validation tests in `config.rs`.

## Child DOX Index

- None. Leaf directory.
