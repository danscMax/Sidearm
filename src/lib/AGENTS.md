# src/lib — Pure logic

## Purpose

Framework-free TypeScript: config editing, conflict detection, action/label helpers, transfer (import/export), command-palette + verification logic, and the `AppConfig` types. No React here.

## Ownership

- `config.ts` — the `AppConfig` shape and action/payload types (must mirror the Rust structs + `config.v2.schema.json`).
- `config-editing.ts` — all config mutations (bindings, profiles, snippets, app-mappings), import validators, dedupe.
- `conflict-detection.ts` — shortcut conflicts + `bindingMatchesQuery` (label/shortcut/action-content search).
- `backend.ts` — typed wrappers over Tauri `invoke` (the only place `invoke` is called).
- `helpers.ts`, `labels.ts`, `menu-helpers.ts`, `action-helpers.ts`, `command-palette-helpers.ts`, `verification-*`, `*-transfer.ts`, `synapse-import.ts`, `mouse-visual.ts`, `constants/`.

## Local Contracts

- Config edits are pure `(config) => config` functions — no side effects, no I/O. This keeps them idempotent under React strict mode and unit-testable.
- Validate untrusted import files at the boundary (`isValid*Export`) before mutating; never dereference an unvalidated entry.
- `ActionPayload` is a discriminated union keyed by `type` — handle every variant; use `assertNever` for exhaustiveness.

## Work Guidance

- Every non-trivial function has `*.test.ts`; boundary/edge behaviour goes in the matching `*.edgecases.test.ts`. Tests run with the RU locale as default.

## Verification

- `npm run test` (vitest). Prefer running the specific `*.test.ts` while iterating.

## Child DOX Index

- None. Leaf directory.
