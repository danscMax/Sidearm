# src/components/action-picker — Action editors

## Purpose

The editors inside the "Assign action" modal — one per `ActionType` (shortcut, mouse, text snippet, sequence/macro, launch, media key, profile switch, menu), plus the trigger-mode, conditions, and capture controls.

## Ownership

- `ShortcutEditor`, `MouseActionEditor`, `TextSnippetEditor`, `SequenceStepEditor`, `LaunchEditor`, `MediaKeyEditor`, `ProfileSwitchEditor`, `MenuItemsEditor` (master–detail: the menu as the popup shows it — blocks, button numbers — with a quiet add bar (phrase, keys, block, list, templates from `lib/menu-templates.ts`) and the selected item on the right: a phrase (text, Enter), keys (`ShortcutEditor`) or another action (filterable list by type), its block and order; new and edited actions are written on Save through `lib/menu-phrase.ts` `applyMenuEdits`, library texts stay linked), `ConditionsEditor`, `TriggerModeEditor`.
- `shared/` — `CaptureRow` (read-only input + Record/Stop button; keyboard fields pass `captureOnFocus`: a click into the field starts the capture, leaving it stops it, no button — the shortcut editor and the global shortcut; signal capture keeps the button), `ModifierRow`, `PickerGrid`, `CompoundCard`, `SignalCaptureField`.

## Local Contracts

- The KEY capture is a DOM `onKeyDown` (`resolveKeyName`), so it also receives Sidearm's own injected VK 0xE8 (mask/hook-probe key) when the window is focused — capture ignores `"VK_232"` for this reason; keep that guard.
- `dpiUp`/`dpiDown` are mouse actions with no keyboard modifiers. They use the resolved profile's stages; the picker test passes the edited profile ID explicitly.
- Capture rows own their capture state via the parent; `CaptureRow` is presentational and requires a localized `ariaLabel`, forwarded to its readonly input. A changing capture placeholder must not change the field's accessible name.
- A snippet's text is sent verbatim except `{date}`/`{clipboard}` tokens (`{{`/`}}` escape) expanded backend-side at send time.

## Work Guidance

Adding a new `ActionType` is a mirrored change — do all of:
- Rust `ActionPayload` variant (untagged: give it a required discriminating field) + `config.v5.schema.json` (`anyOf`) + `ALL_ACTION_TYPES` exhaustiveness guard.
- TS `config.ts` union, `config-editing.ts` coercion switch, a new editor here, and all Settings literals.
- Backend executor handling in `src-tauri/src/executor.rs`.

## Verification

- `npm run test` (vitest) — includes `SequenceStepEditor.test.tsx` and action-helper edgecases.

## Child DOX Index

- None. Leaf directory.
