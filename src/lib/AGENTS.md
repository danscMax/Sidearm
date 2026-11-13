# src/lib — Pure logic

## Purpose

Framework-free TypeScript: config editing, conflict detection, action/label helpers, transfer (import/export), command-palette + verification logic, and the `AppConfig` types. No React here.

## Ownership

- `config.ts` — the `AppConfig` shape and action/payload types (must mirror the Rust structs + `config.v5.schema.json`).
- `config-editing.ts` — all config mutations (bindings, profiles, snippets, app-mappings), import validators, dedupe. A profile export carries the actions of its menus' items (import re-points them) and can leave out the owner's texts (`withoutTexts`: texts, macros with text, menus).
- `binding-moves.ts` — a button's assignments as one slot (profile · layer · control, every press pattern): move, swap onto an occupied one, copy (`placeSlot`), copy a layer or a profile (`copyAssignments`, menus skipped), sidebar profile order (`reorderProfiles`), the profile comparison table (`compareProfiles`).
- `menu-arrange.ts` — menu editor arranging: drop before/after/inside, level in/out, copies with fresh ids, search across menus, other menus using an action (`otherMenuUses`) and other buttons using it (`bindingUses`, one line per place, the other mouse's twin folded in), prompts from a text file.
- `press-stats.ts` — statistics from the daily press log (`get_press_log`): periods (`sumDays`, local dates), most pressed places with the period before, never pressed ones, keystrokes saved, HyperShift actions worth a hold (`holdHints`), heat per control and layer (`layerHeat`), menu items not picked (`unpickedItems`).
- `config-diff.ts` — what changed between two configs in words (`describeConfigChange`: places with another assignment, edited menus) for the "changed outside Sidearm" toast.
- `config-check.ts` — per-profile problems shown above the buttons: an assignment or menu item pointing at a missing action or library text, Enter next to closing the window on one button; and the same text / macro / menu / launch / shortcut on several buttons of one mouse and layer (`duplicate`, shown as a note, not a problem; shortcuts in an open conflict are the conflict banner's).
- `conflict-detection.ts` — shortcut conflicts within a device, profile, layer and press pattern (the same shortcut on a press and a hold is a choice: a `duplicate` note), minus the ones kept (`settings.acceptedConflicts`, `conflictKey`, `acceptConflict` in `config-editing.ts`), plus `bindingMatchesQuery` (label/shortcut/action-content search).
- `dpi-stages.ts` — pure, model-limited DPI choices and manual-value application for the single sensitivity control. Displaying defaults does not persist them; explicit application preserves the five-stage limit and custom saved values.
- `onboard-mapping.ts` also mirrors what the mouse plays without Sidearm (`playsWithoutSidearm`, Rust `mouse_offline::binding_action`/`onboard_action`) and the profile written at exit (`offlineProfileId`). It also defines the mouse snapshot IPC: three nullable readings, status and per-field UiText warnings/details. A missing read is not zero and does not erase saved profile settings. `getDeviceReport(detail)` keeps absent/full compatible with the existing verification scan.
- `backend.ts` — typed wrappers over Tauri `invoke` (the only place `invoke` is called).
- `devices.ts` — one `DeviceLayout` per built-in mouse (mirrors the Rust catalog's `device_id`/`control_prefix`): views, hotspots, legend columns, firmware HyperShift button, wizard extras; `layoutControlId`/`deviceControlId` translate between a device's control ids and the shared layout ids. Model differences in the UI live here only.
- `binding-moves.ts` `compareMice`: one profile's button places × mice (`sharedPlace`), rows that differ marked.
- `device-transfer.ts` — copying assignments between built-in mice (`planDeviceTransfer`/`applyDeviceTransfer`: same layout place, V2 side buttons ↔ V3 tilt, cloned actions — a menu with its own phrases, or the same menu with `shareMenus` —, keep/replace; HyperShift 2 / HS + HS2 bindings are `noLayer` for a layout without `hypershift2Triggers`), `planHoldsFromHypershift2` / `applyHoldOffers` (a mouse with HyperShift 2 → long presses of the same buttons of one without, where free), and `mirrorMouseEdit`: with `settings.syncMice` on, an edit of one built-in mouse's place (binding, its action, a menu's item actions) is repeated on the other mice's same place with the same action; a place changed on both at once is left alone, a missing layer skipped, orphaned copies dropped (texts kept unless another action holds them) and placing an imported profile's bindings on a chosen mouse (`retargetImportedBindings`).
- `helpers.ts`, `labels.ts`, `menu-helpers.ts`, `action-helpers.ts`, `command-palette-helpers.ts`, `verification-*`, `*-transfer.ts`, `synapse-import.ts`, `mouse-visual.ts`, `onboard-mapping.ts` (thumb + top-button bindings handed to `verify_onboard_mapping`, mirroring Rust `onboard_bindings`, `isBuiltinControl` for hiding the built-in device's signals, plus the takeover event type and the `NativeModelInfo` limits of `get_native_model`), `constants/`.

## Local Contracts

- Config edits are pure `(config) => config` functions — no side effects, no I/O. This keeps them idempotent under React strict mode and unit-testable.
- Validate untrusted import files at the boundary (`isValid*Export`) before mutating; never dereference an unvalidated entry.
- `ActionPayload` is a discriminated union keyed by `type` — handle every variant; use `assertNever` for exhaustiveness.

## Work Guidance

- Every non-trivial function has `*.test.ts`; boundary/edge behaviour goes in the matching `*.edgecases.test.ts`. Tests run with the RU locale as default.

## Verification

- `npm run test` (vitest). Prefer running the specific `*.test.ts` while iterating.
- `canon-guards.test.ts` parses JSX with the existing TypeScript compiler to ensure ordinary form controls use the shared input recipe, including inherited `.field`/`.capture-row` wrappers. Composite-editor exceptions name both the file and exact control class; never allow a whole file to contain arbitrary unstyled inputs.
- The same guard rejects event.target/currentTarget value/checked reads inside deferred config updaters; handlers snapshot those primitives first. Runtime regression tests cover capability status and profile name/description, including clearing a description.

## Child DOX Index

- None. Leaf directory.
