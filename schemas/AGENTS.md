# schemas — Config JSON Schema (contract)

## Purpose

The runtime-validated JSON Schema for `AppConfig` — the single source of truth for the config contract, bundled into the Rust backend and validated before every deserialize, import, and preset load.

## Ownership

- `config.v4.schema.json` — bundled into `src-tauri/src/config.rs` via `include_str!("../schemas/config.v4.schema.json")`. Accepts versions 2/3/4 and migrates old files to v4 on load without adding DPI stages. V4 adds optional profile DPI stages and `dpiUp`/`dpiDown` mouse actions; the version stamp protects against destructive recovery by older apps.
- `config.v3.schema.json` — historical multi-device contract, retained unchanged for reference.
- `config.v2.schema.json` — historical (v0.x–v0.7.5 contract), no longer bundled. Kept for reference; see `docs/CONFIG-SCHEMA-V3.md` for the v2→v3 delta.

## Local Contracts

- This schema, the Rust structs (`src-tauri/src/config.rs`), and the TS types (`src/lib/config.ts`) form a three-way contract — a change in any one requires the other two.
- Enum lists (`$defs.actionType.enum`, `$defs.mouseActionKind.enum`, `$defs.mediaKeyKind.enum`) must match the Rust enums; `config.rs` has schema-sync tests that assert this.
- `$defs.controlId` is an OPEN pattern since v3 (any device's control token). Referential integrity (control ∈ `physicalControls`, control's `deviceId` ∈ `devices`) is enforced by `validate_config` in Rust, not by the schema.
- A persisted field rename = `anyOf`(both names) here + `#[serde(alias)]` in Rust, so older configs still load.
- A configured startup `mouseDpi` must belong to `mouseDpiStages` when stages are present (semantic validation in Rust). Stage lists contain 1–5 unique integers within 100–30000; the connected model further limits hardware writes.
- `version` is pinned to `SCHEMA_VERSION`; bump it deliberately (a newer-version config is never overwritten by an older app).

## Work Guidance

(empty)

## Verification

- `cargo test` — the schema-sync and validation tests in `config.rs`.

## Child DOX Index

- None. Leaf directory.
