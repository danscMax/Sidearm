# src/components/action-picker — Action editors

## Purpose

The editors inside the "Assign action" modal — one per `ActionType` (shortcut, mouse, text snippet, sequence/macro, launch, media key, profile switch, menu), plus the trigger-mode, conditions, and capture controls.

## Ownership

- `ShortcutEditor`, `MouseActionEditor`, `TextSnippetEditor`, `SequenceStepEditor`, `LaunchEditor`, `MediaKeyEditor`, `ProfileSwitchEditor`, `MenuItemsEditor`, `ConditionsEditor`, `TriggerModeEditor`.
- `shared/` — `CaptureRow` (read-only input + Record/Cancel button), `ModifierRow`, `PickerGrid`, `CompoundCard`, `SignalCaptureField`.

## Local Contracts

- The KEY capture is a DOM `onKeyDown` (`resolveKeyName`), so it also receives Sidearm's own injected VK 0xE8 (mask/hook-probe key) when the window is focused — capture ignores `"VK_232"` for this reason; keep that guard.
- Capture rows own their capture state via the parent; `CaptureRow` is presentational.
- A snippet's text is sent verbatim except `{date}`/`{clipboard}` tokens (`{{`/`}}` escape) expanded backend-side at send time.

## Work Guidance

Adding a new `ActionType` is a mirrored change — do all of:
- Rust `ActionPayload` variant (untagged: give it a required discriminating field) + `config.v2.schema.json` (`anyOf`) + `ALL_ACTION_TYPES` exhaustiveness guard.
- TS `config.ts` union, `config-editing.ts` coercion switch, a new editor here, and all Settings literals.
- Backend executor handling in `src-tauri/src/executor.rs`.

## Verification

- `npm run test` (vitest) — includes `SequenceStepEditor.test.tsx` and action-helper edgecases.

## Child DOX Index

- None. Leaf directory.
