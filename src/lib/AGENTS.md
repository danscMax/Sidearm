# src/lib — Pure logic

## Purpose

Framework-free TypeScript: config editing, conflict detection, action/label helpers, transfer (import/export), command-palette + verification logic, and the `AppConfig` types. No React here.

## Ownership

- `config.ts` — the `AppConfig` shape and action/payload types (must mirror the Rust structs + `config.v5.schema.json`). `isMenuMark`: a menu item with no name and no action (a line, the search box) — use it wherever an item's label or action is read. `menu-helpers.ts` `withSearchItem` / `searchNested`: a menu's search box first when it has none; an arrangement that puts it inside a block or list.
- `config-editing.ts` — all config mutations (bindings, profiles, snippets, app-mappings), import validators, dedupe. `deleteProfile` also drops the profile's `settings.syncSlots` keys (`<profileId>|…`). A profile export carries the actions of its menus' items (import re-points them) and can leave out the owner's texts (`withoutTexts`: texts, macros with text, menus).
- `import-validation.ts` — export guards reuse the config schema definitions for nested payloads and export-local references. Its schema keyword subset fails closed on additions; it does not replace backend validation of the complete config.
- `key-names.ts` — layout-independent primary-key aliases and VK codes, mirroring Rust `hotkeys::parse_primary_key`; shared by conflict signatures (including legacy accepted conflicts) and firmware eligibility; `otherLayout` maps text between the Russian and US layouts for searches.
- `snippet-tokens.ts` — a phrase read as `input_synthesis::expand_tokens_with` reads it (`scanSnippet`; `SNIPPET_TOKENS` mirrors the Rust list), its preview (`previewSnippet`, dates via `date-pattern.ts`) and likely mistakes (`snippetWarnings`, `replaceToken`; `fixDatePattern` in `date-pattern.ts`).
- `snippet-search.ts` — the library picker's search (`searchSnippets`: every word in name, text or tags, either layout; name matches first) and the places using each library text (`snippetPlaceCounts`: enabled bindings and menu items).
- `binding-moves.ts` — a button's assignments as one slot (profile · layer · control, every press pattern): move, swap onto an occupied one, copy (`placeSlot`), copy a layer or a profile (`copyAssignments`, menus skipped), sidebar profile order (`reorderProfiles`), the profile comparison table (`compareProfiles`).
- `menu-arrange.ts` — menu editor arranging: drop before/after/inside, level in/out, copies with fresh ids, search across menus, other menus using an action (`otherMenuUses`) and other buttons using it (`bindingUses`, one line per place, the other mouse's twin folded in), prompts from a text file.
- `press-stats.ts` — statistics from the daily press log (`get_press_log`): periods (`sumDays`, local dates), most pressed places with the period before, never pressed ones, keystrokes saved, HyperShift actions worth a hold (`holdHints`), heat per control and layer (`layerHeat`), menu items not picked (`unpickedItems`).
- `config-diff.ts` — what changed between two configs in words (`describeConfigChange`: places with another assignment, edited menus) for the "changed outside Sidearm" toast.
- `config-check.ts` — per-profile problems shown above the buttons: an assignment or menu item pointing at a missing action or library text, Enter next to closing the window on one button; and the same text / macro / menu / launch / shortcut on several buttons of one mouse and layer (`duplicate`, shown as a note, not a problem; shortcuts in an open conflict are the conflict banner's). Groups are per device: `duplicatesOnDevice` keeps the mouse shown's, `sameAsByControl` gives each button of a layer the other buttons it matches, with its own repeated press pattern ("Hold = Button 12"; legend mark), `duplicateKeys` keys each group "Hide" remembers (layer + places, not the name).
- `conflict-detection.ts` — shortcut conflicts within a device, profile, layer and press pattern (the same shortcut on a press and a hold is a choice: a `duplicate` note), minus the ones kept (`settings.acceptedConflicts`, `conflictKey`, `acceptConflict` in `config-editing.ts`), plus `bindingMatchesQuery` (label/shortcut/action-content search).
- `dpi-stages.ts` — pure, model-limited DPI choices and manual-value application for the single sensitivity control. Displaying defaults does not persist them; explicit application preserves the five-stage limit and custom saved values.
- `onboard-mapping.ts` defines Rust preview types (`OfflinePreview`, `OfflineControl`) and payload eligibility (`playsWithoutSidearm`, for picker validation only). Firmware assignments and write targets come exclusively from `backend.ts` `getOfflinePreview(config, profileId, deviceId)`. It also defines nullable mouse readings and per-field UiText warnings; missing readings never erase saved settings.
- `backend.ts` — typed wrappers over Tauri `invoke` (the only place `invoke` is called).
- `devices.ts` — one `DeviceLayout` per built-in mouse (mirrors the Rust catalog's `device_id`/`control_prefix`): views, hotspots, legend columns, firmware HyperShift button, wizard extras; `layoutControlId`/`deviceControlId` translate between a device's control ids and the shared layout ids. Model differences in the UI live here only.
- `binding-moves.ts` `compareMice`: one profile's button places × mice (`sharedPlace`), rows that differ marked.
- `device-transfer.ts` — copying assignments between built-in mice (`planDeviceTransfer`/`applyDeviceTransfer`: same layout place, V2 side buttons ↔ V3 tilt, cloned actions — a menu with its own phrases, or the same menu with `shareMenus` —, keep/replace; HyperShift 2 / HS + HS2 bindings are `noLayer` for a layout without `hypershift2Triggers`), `planHoldsFromHypershift2` / `applyHoldOffers` (a mouse with HyperShift 2 → long presses of the same buttons of one without, where free), and `mirrorMouseEdit`: with `settings.syncMice` on, an edit of one built-in mouse's place (binding, its action, a menu's item actions) is repeated on the other mice's same place with the same action; a place changed on both at once is left alone, a missing layer skipped, orphaned copies dropped (texts kept unless another action holds them); `slotCounterparts` (the other mice's bindings at a button's place), `slotReplacements` (those a sync copy would overwrite with something else) and `syncedWith` (the mice a synced button is alike with); and placing an imported profile's bindings on a chosen mouse (`retargetImportedBindings`).
- `helpers.ts`, `labels.ts`, `menu-helpers.ts`, `action-helpers.ts`, `command-palette-helpers.ts`, `verification-*`, `*-transfer.ts`, `synapse-import.ts`, `mouse-visual.ts`, `onboard-mapping.ts` (thumb + top-button bindings handed to `verify_onboard_mapping`, mirroring Rust `onboard_bindings`, `isBuiltinControl` for hiding the built-in device's signals, plus the takeover event type and the `NativeModelInfo` limits of `get_native_model`), `constants/`.

## Local Contracts

- Config edits are pure `(config) => config` functions — no side effects, no I/O. This keeps them idempotent under React strict mode and unit-testable.
- `OfflineLayer` / `isOfflineLayer` identify firmware-only bindings. `setOfflineAssignment` saves an enabled plain press (shortcut, mouseAction, or `"silent"` → disabled); null removes the own assignment with the usual menu-aware orphan cleanup.
- `mouse-visual.ts` `withOfflineAssignment` displays the supplied Rust preview without planning firmware behavior: own/inherited action names, preserved native/memory actions, silence with live context, reserved roles, unavailable and unknown. The same result supplies legend/hotspot labels and live S tooltips; config bindings are read only for editing/removal and live context.
- Offline bindings travel with profiles, exports/imports, device transfers and same-layer slot copies. Individual layer-copy tools never target them or fold them into live layers. Live layer lists (`layerCopy`, `deviceLayers`, compare/copy dialogs, layout print, cheat-sheet picker), runtime events, signal verification, press statistics, conflict/duplicate checks and live assignment search exclude them; firmware inheritance belongs to the Rust planner preview, never `FALLBACK_LAYERS`.
- Validate untrusted import files at the boundary (`isValid*Export`) before mutating; never dereference an unvalidated entry.
- Profile imports reject duplicate control/layer/gesture bindings and control/layer encoder mappings before publishing a draft. Profile-switch targets must exist in the destination; importing a profile remaps switches to itself to its new ID.
- Binding removal and replacement preserve targets of every retained menu, including unbound menus; profile exports carry the binding-reachable closure (`computeReferencedActionIds`), including cycles. Imported encoder mappings must name controls present on this computer; retargeting keeps the target mouse's signals.
- A phrase editor accepts only a single text or the canonical text / 80 ms pause / Enter sequence, without other timing or repeats. Picker saves preserve real action notes, excluding placeholder notes.
- Verification observations only update pending steps; previews must match the observed encoded key before changing recommendations or finalized resolution.
- `ActionPayload` is a discriminated union keyed by `type` — handle every variant; use `assertNever` for exhaustiveness.

## Work Guidance

- Every non-trivial function has `*.test.ts`; boundary/edge behaviour goes in the matching `*.edgecases.test.ts`. Tests run with the RU locale as default.

## Verification

- `npm run test` (vitest). Prefer running the specific `*.test.ts` while iterating.
- `canon-guards.test.ts` parses JSX with the existing TypeScript compiler to ensure ordinary form controls use the shared input recipe, including inherited `.field`/`.capture-row` wrappers. Composite-editor exceptions name both the file and exact control class; never allow a whole file to contain arbitrary unstyled inputs.
- The same guard rejects event.target/currentTarget value/checked reads inside deferred config updaters; handlers snapshot those primitives first. Runtime regression tests cover capability status and profile name/description, including clearing a description.

## Child DOX Index

- None. Leaf directory.
