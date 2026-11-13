# src-tauri/src/synapse_import — Razer Synapse import

## Purpose

Parse exported Razer Synapse profiles (`.synapse3` / `.synapse4`, incl. zipped) and map them into Sidearm's `AppConfig` bindings/actions.

## Ownership

- `mod.rs` — entry point + candidate discovery + warning collection.
- `format_v3.rs`, `format_v4.rs` — version-specific parsers.
- `macro_steps.rs`, `macro_xml.rs`, `makecode.rs`, `mapping.rs`, `merge.rs`, `types.rs`.

## Local Contracts

- Untrusted input: enforce a zip budget (`enforce_zip_budget`), never panic on malformed data — collect warnings and continue. Memory must stay bounded by the input, not by what it multiplies into: a repeated warning is given once per macro (`macro_steps::WarnedKinds`, the mouse-event flags), a V3 archive gives at most `MAX_V3_PROFILES` profiles, and the macro copies made per profile share `MAX_IMPORTED_MACRO_STEPS`, checked before each copy.
- Canonicalize keys on the way in: F-key tokens to `F{n}`, bare-modifier VKs folded to modifier flags, dedupe case-insensitive path collisions.
- Report skipped/unreadable entries as warnings rather than failing the whole import.
- Merge rejects macros longer than `config::MAX_SEQUENCE_STEPS` before creating actions; their bindings are skipped and `macrosAdded` counts accepted macros only. The length warning uses `ui_text!` plus `ui_text::native` to preserve the existing string warning payload in the current UI language.
- XML element text is collected through `macro_xml::TextBuf` (handles both `Event::Text` and `Event::GeneralRef`, trims once per element); never assign a raw `Event::Text` chunk — quick-xml ≥0.38 splits `A &amp; B` into three events.

## Work Guidance

(empty)

## Verification

- `cargo test` (includes parser edge/property tests) + `cargo clippy ... -D warnings`.

## Child DOX Index

- None. Leaf directory.
