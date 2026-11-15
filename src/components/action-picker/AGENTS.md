# src/components/action-picker — Action editors

## Purpose

The editors inside the "Assign action" modal — one per `ActionType` (shortcut, mouse, text snippet, sequence/macro, launch, media key, profile switch, menu), plus the trigger-mode, conditions, and capture controls.

## Ownership

- `ShortcutEditor`, `MouseActionEditor`, `TextSnippetEditor`, `SequenceStepEditor`, `LaunchEditor`, `MediaKeyEditor`, `ProfileSwitchEditor`, `MenuItemsEditor` (master–detail: the menu as the popup shows it — blocks, button numbers — with a quiet add bar (phrase, keys, block, list, templates from `lib/menu-templates.ts`) and the selected item on the right: a phrase (text, Enter), keys (`ShortcutEditor`) or another action (filterable list by type), its block and order; new and edited actions are written on Save through `lib/menu-phrase.ts` `applyMenuEdits`, library texts stay linked; rows and block headers are dragged to reorder — upper/lower half before/after, the middle of a list or block inside — and Alt+↑↓/←→ do the same (`lib/menu-arrange.ts`); per item: duplicate, copy to another menu (that menu's edited action is saved with this one), delete with a one-step "Restore", the popup's pick count (`get_menu_usage`) and the other menus using it; "From folder" turns a folder's .txt/.md (a fenced prompt of a how-to page, else the whole text, `promptsFromFile`) into a list with the text copied in; a search box searches every menu), `ConditionsEditor`, `TriggerModeEditor`.
- `CompoundCard` takes `reorder` (index + `onMove`): its header drags onto another card of the list (the sequence steps).
- `shared/` — `CaptureRow` (read-only input + Record/Stop button; keyboard fields pass `captureOnFocus`: a click into the field starts the capture, leaving it stops it, no button — the shortcut editor and the global shortcut; signal capture keeps the button), `ModifierRow`, `PickerGrid`, `CompoundCard`, `SignalCaptureField`, `TokenTextarea` (a phrase's text box, shared by `TextSnippetEditor` and the menu inspector: tokens highlighted, the token chips with the Date and time formats, a one-line preview of what it types — dates filled, the clipboard / selection / caret / fields as placeholders — and warnings with a one-click fix: an unknown `{word}` with the closest token, a `{date:…}` using Y / D / h).
- `TextSnippetEditor`: "Insert from library" is `SnippetLibraryPicker` (a button with the library's size, a popover with a search box — name, text and tags, either keyboard layout, `lib/snippet-search.ts` — and rows of name, first line, typing-mode and tag badges and the places using it; ↑ ↓ Enter Esc, the linked text marked). A linked text shows "Library: <name> · used in N places": its text and typing mode are edited for all its uses (Save writes them into `snippetLibrary`, `upsertSnippetLibraryItem`), and "Detach into its own copy" makes it the button's own inline text (with "also save to library" turned off).
- `shared/key-recording.ts` — capture leases shared by `CaptureRow` and the sequence recorder; native mode writes are serialized, and only the final release disables the mode.

## Local Contracts

- On `offline` / `offlineHypershift`, `ActionPickerModal` edits only plain presses: keys, firmware mouse actions and Silent. `offlineAssignment` seeds own/inherited/silent drafts; `playsWithoutSidearm` is the eligibility rule (also derives the mouse list). Save uses `setOfflineAssignment`; Same as in Sidearm stages null until Save. Draft undo/discard and per-slot mouse sync use the existing paths. No Test, roles, gesture controls, conditions, throttle, name or signal editing on these layers.
- The KEY capture is a DOM `onKeyDown` (`resolveKeyName`), so it also receives Sidearm's own injected VK 0xE8 (mask/hook-probe key) when the window is focused — capture ignores `"VK_232"` for this reason; keep that guard.
- A `waitWindow` step (`exe`, optional `title`, `timeoutMs` up to 30 s) waits for that window to come to the front; past the timeout the sequence stops with `execution.waitWindowTimeout` instead of typing elsewhere. It has no step delay of its own, and turning a launch step into one waits for the program it started.
- `SequenceStepEditor`: one row per step (icon, what it does, its pause and repeat), a click opens its fields in place; new and recorded steps go in after the selected step (else at the end) and the first is opened and scrolled to — a recording never replaces the steps; rows drag to reorder; a row's ⧉ puts a copy right after it, opened (`insertSteps`); under the list a line gives the step count and the estimated length (pauses, step delays × repeats; a "wait for window" step counts as "up to" its timeout; typing time is not counted). The recorder sends each chord plus the character a printable key typed (`typedText`), so the backend turns a typed word into one Text step. A Send step's value has a Record button beside the field: the next chord goes in (`chordOf`, the recorder's own formatting, `VK_232` ignored), Esc cancels; it holds a `KEY_RECORDING` lease while capturing. A new macro starts with no steps and a new Send step empty (Save waits until it is filled). Sequences contain 1–200 steps; manual additions and recording respect the same maximum, and invalid existing drafts stay open with feedback until corrected. The recorder owns backend recording and a `KEY_RECORDING` lease for its lifetime, including cleanup after a pending Start completes following unmount; teardown finishes before another sequence editor starts, and it also ignores `VK_232`.
- `dpiUp`/`dpiDown` are mouse actions with no keyboard modifiers. They use the resolved profile's stages; the picker test passes the edited profile ID explicitly.
- Capture rows own their capture state via the parent; `CaptureRow` is presentational and requires a localized `ariaLabel`, forwarded to its readonly input. A changing capture placeholder must not change the field's accessible name.
- `pasteMode`: `sendText` (and the legacy `clipboardPaste`) is automatic — typed, a text over 100 characters pasted through the clipboard; `keyboardOnly` is always typed (`input_synthesis::send_text_typed`). The switch is in `TextSnippetEditor` and the menu inspector; on a library-linked phrase it sets the library item's mode (all its uses). "Press Enter after the text" is the text action's own `pressEnter` (inline or a library use), so it keeps both.
- A snippet's text (and a macro's text step, and a popup "copy only") is sent verbatim except the tokens expanded backend-side at send time (`input_synthesis::expand_snippet_tokens`): `{date}`, `{date:<pattern>}` (`yyyy yy MMMM MM M dd d HH H mm ss`, month names from `backend.snippet.monthNames`; the Date and time chip offers formats, `lib/date-pattern.ts` draws today in them), `{time}` (HH:mm), `{clipboard}`, `{selection}` (copied from the window in front with Ctrl+Insert — never Ctrl+C, which stops a terminal program — the clipboard put back), `{cursor}` or `{|}` (the caret goes back there); `{{`/`}}` escape. `lib/snippet-tokens.ts` reads a phrase as that expander does (`SNIPPET_TOKENS` mirrors the Rust list — `snippet-tokens.test.ts` compares them — and `{{date}}` is no token) for the highlight, the preview and the warnings.

## Work Guidance

Adding a new `ActionType` is a mirrored change — do all of:
- Rust `ActionPayload` variant (untagged: give it a required discriminating field) + `config.v5.schema.json` (`anyOf`) + `ALL_ACTION_TYPES` exhaustiveness guard.
- TS `config.ts` union, `config-editing.ts` coercion switch, a new editor here, and all Settings literals.
- Backend executor handling in `src-tauri/src/executor.rs`.

## Verification

- `npm run test` (vitest) — includes `SequenceStepEditor.test.tsx` and action-helper edgecases.

## Child DOX Index

- None. Leaf directory.
