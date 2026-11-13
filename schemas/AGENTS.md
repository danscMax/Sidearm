# schemas — Config JSON Schema (contract)

## Purpose

The runtime-validated JSON Schema for `AppConfig` — the single source of truth for the config contract, bundled into the Rust backend and validated before every deserialize, import, and preset load.

## Ownership

- `config.v5.schema.json` — bundled into `src-tauri/src/config.rs` via `include_str!("../schemas/config.v5.schema.json")`. Accepts versions 2–10 and migrates old files to the current version (10) on load without changing assignments; the file keeps its v5 name. V10 adds `Settings.hs2CheatSheet` (the HyperShift 2 grid at the cursor while its trigger is held). V9 adds `MenuItem.pinned` (an action item shown first, in the popup's ★ block) and `Settings.osdActions` (the OSD names each action run). V8 adds `Settings.syncMice` (the UI repeats an assignment edit of one built-in mouse on the others). V7 adds the HyperShift 2 and HS + HS2 layers and `Profile.hypershift2Triggers` (ADR-0005). V6 adds the `longPress` trigger mode (one binding per control, layer and press pattern) and `Settings.hypershiftTap`. V5 adds `Profile.deviceSlots` (device id → onboard bank 1–5) and raises the DPI limit to 50000 (Naga V3 Pro); the version stamp protects against destructive recovery by older apps.
- `config.v4.schema.json` — historical (v0.11.8: profile DPI stages, `dpiUp`/`dpiDown`), retained unchanged for reference.
- `config.v3.schema.json` — historical multi-device contract, retained unchanged for reference.
- `config.v2.schema.json` — historical (v0.x–v0.7.5 contract), no longer bundled. Kept for reference; see `docs/CONFIG-SCHEMA-V3.md` for the v2→v3 delta.

## Local Contracts

- This schema, the Rust structs (`src-tauri/src/config.rs`), and the TS types (`src/lib/config.ts`) form a three-way contract — a change in any one requires the other two.
- Enum lists (`$defs.actionType.enum`, `$defs.mouseActionKind.enum`, `$defs.mediaKeyKind.enum`) must match the Rust enums; `config.rs` has schema-sync tests that assert this.
- `$defs.controlId` is an OPEN pattern since v3 (any device's control token). Referential integrity (control ∈ `physicalControls`, control's `deviceId` ∈ `devices`) is enforced by `validate_config` in Rust, not by the schema.
- A persisted field rename = `anyOf`(both names) here + `#[serde(alias)]` in Rust, so older configs still load.
- Mouse settings live per mouse in `Profile.deviceMouse` (device id → `mouseDpi`/`mousePollRateHz`/`mouseDpiStages`); the flat profile fields are the pre-v5 form, still accepted and moved there on load. A configured startup `mouseDpi` must belong to that mouse's `mouseDpiStages` when stages are present (semantic validation in Rust). Stage lists and `mouseDpi` are integers within 100–50000 (the widest catalog model); the connected model further limits hardware writes.
- `version` is pinned to `SCHEMA_VERSION`. **Every schema change (a new field, a new enum value) bumps it**: an older app fails schema validation on anything new and would quarantine the file as corrupt and seed a default config (happened 2026-11-11: v0.11.8 at logon replaced a config holding `longPress`/`hypershiftTap`); a newer version number makes it refuse instead and leave the file intact. Dev runs share the portable data, so this matters on the dev machine too.

## Work Guidance

(empty)

## Verification

- `cargo test` — the schema-sync and validation tests in `config.rs`.

## Child DOX Index

- None. Leaf directory.
