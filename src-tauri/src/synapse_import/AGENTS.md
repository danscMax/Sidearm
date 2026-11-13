# src-tauri/src/synapse_import — Razer Synapse import

## Purpose

Parse exported Razer Synapse profiles (`.synapse3` / `.synapse4`, incl. zipped) and map them into Sidearm's `AppConfig` bindings/actions.

## Ownership

- `mod.rs` — entry point + candidate discovery + warning collection.
- `format_v3.rs`, `format_v4.rs` — version-specific parsers.
- `macro_steps.rs`, `macro_xml.rs`, `makecode.rs`, `mapping.rs`, `merge.rs`, `types.rs`.

## Local Contracts

- Untrusted input: enforce a zip budget (`enforce_zip_budget`), never panic on malformed data — collect warnings and continue. Memory must stay bounded by the input, not by what it multiplies into: a repeated warning is given once per macro (`macro_steps::WarnedKinds`, the mouse-event flags), a V3 archive gives at most `MAX_V3_PROFILES` profiles, and the macro copies made per profile share `MAX_IMPORTED_MACRO_STEPS`, checked before each copy.
- Sibling XML folders share one `MacroFolderBudget`: actual bytes read (including invalid UTF-8) are charged against `MAX_TOTAL_UNCOMPRESSED` with a one-byte overflow probe, pooled decoded steps are capped by `MAX_IMPORTED_MACRO_STEPS`. Copies injected across profiles share that step limit and a separate 128 MiB owned-data budget (`macro_copy_bytes`: macro/step storage, name, GUID and Send strings), both counting existing embedded macros and checked before cloning. Keep per-file/count guards and missing-macro warnings for references left unresolved by either budget; a skipped large copy must not prevent later smaller copies that still fit. New string warnings use `ui_text!` + `ui_text::native` to fit the existing string DTO in the current UI language.
- `ReplaceByName` replaces only the first matching profile and keeps its ID, so settings and profile-switch references survive. Remove old actions only if neither remaining bindings nor nested menu items reference them. The import IPC checks both schema and the pure save validator before returning success.
- Macro `Send` steps occur at non-modifier key-down with that moment's modifiers; key-up tracks holds only. Preserve delay order and warn once for overlapping holds. V4 key integers accept numeric strings with checked conversion, require State 0..=3, and default only missing/null State to 0; malformed key payloads reject that macro with a warning.
- Canonicalize keys on the way in: F-key tokens to `F{n}`, bare-modifier VKs folded to modifier flags, dedupe case-insensitive path collisions.
- Report skipped/unreadable entries as warnings rather than failing the whole import.
- XML element text is collected through `macro_xml::TextBuf` (handles both `Event::Text` and `Event::GeneralRef`, trims once per element); never assign a raw `Event::Text` chunk — quick-xml ≥0.38 splits `A &amp; B` into three events.

## Work Guidance

(empty)

## Verification

- `cargo test` (includes parser edge/property tests) + `cargo clippy ... -D warnings`.

## Child DOX Index

- None. Leaf directory.
