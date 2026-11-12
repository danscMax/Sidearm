# src/components/action-picker — Action editors

## Purpose

The editors inside the "Assign action" modal — one per `ActionType` (shortcut, mouse, text snippet, sequence/macro, launch, media key, profile switch, menu), plus the trigger-mode, conditions, and capture controls.

## Ownership

- `ShortcutEditor`, `MouseActionEditor`, `TextSnippetEditor`, `SequenceStepEditor`, `LaunchEditor`, `MediaKeyEditor`, `ProfileSwitchEditor`, `MenuItemsEditor` (master–detail: the menu as the popup shows it — blocks, button numbers — with a quiet add bar (phrase, keys, block, list, templates from `lib/menu-templates.ts`) and the selected item on the right: a phrase (text, Enter), keys (`ShortcutEditor`) or another action (filterable list by type), its block and order; new and edited actions are written on Save through `lib/menu-phrase.ts` `applyMenuEdits`, library texts stay linked; rows and block headers are dragged to reorder — upper/lower half before/after, the middle of a list or block inside — and Alt+↑↓/←→ do the same (`lib/menu-arrange.ts`); per item: duplicate, copy to another menu (that menu's edited action is saved with this one), delete with a one-step "Restore", the popup's pick count (`get_menu_usage`) and the other menus using it; "From folder" turns a folder's .txt/.md (a fenced prompt of a how-to page, else the whole text, `promptsFromFile`) into a list with the text copied in; a search box searches every menu), `ConditionsEditor`, `TriggerModeEditor`.
- `CompoundCard` takes `reorder` (index + `onMove`): its header drags onto another card of the list (the sequence steps).
- `shared/` — `CaptureRow` (read-only input + Record/Stop button; keyboard fields pass `captureOnFocus`: a click into the field starts the capture, leaving it stops it, no button — the shortcut editor and the global shortcut; signal capture keeps the button), `ModifierRow`, `PickerGrid`, `CompoundCard`, `SignalCaptureField`.

## Local Contracts

- The KEY capture is a DOM `onKeyDown` (`resolveKeyName`), so it also receives Sidearm's own injected VK 0xE8 (mask/hook-probe key) when the window is focused — capture ignores `"VK_232"` for this reason; keep that guard.
- `dpiUp`/`dpiDown` are mouse actions with no keyboard modifiers. They use the resolved profile's stages; the picker test passes the edited profile ID explicitly.
- Capture rows own their capture state via the parent; `CaptureRow` is presentational and requires a localized `ariaLabel`, forwarded to its readonly input. A changing capture placeholder must not change the field's accessible name.
- A snippet's text (and a macro's text step, and a popup "copy only") is sent verbatim except the tokens expanded backend-side at send time (`input_synthesis::expand_snippet_tokens`): `{date}`, `{clipboard}`, `{selection}` (copied from the window in front with Ctrl+Insert — never Ctrl+C, which stops a terminal program — the clipboard put back), `{cursor}` or `{|}` (the caret goes back there); `{{`/`}}` escape. `TOKEN_RE`/`TOKENS` in `TextSnippetEditor.tsx` mirror that list.

## Work Guidance

Adding a new `ActionType` is a mirrored change — do all of:
- Rust `ActionPayload` variant (untagged: give it a required discriminating field) + `config.v5.schema.json` (`anyOf`) + `ALL_ACTION_TYPES` exhaustiveness guard.
- TS `config.ts` union, `config-editing.ts` coercion switch, a new editor here, and all Settings literals.
- Backend executor handling in `src-tauri/src/executor.rs`.

## Verification

- `npm run test` (vitest) — includes `SequenceStepEditor.test.tsx` and action-helper edgecases.

## Child DOX Index

- None. Leaf directory.
