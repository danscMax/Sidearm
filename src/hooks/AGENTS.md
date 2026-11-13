# src/hooks — React hooks

## Purpose

Shared React hooks that own cross-cutting UI behaviour: persistence/autosave, runtime state, keyboard/modal/list interaction, and per-panel view state.

## Ownership

- `useAppPersistence.ts` — load/save/undo/redo, 500ms autosave, rollback on save failure, concurrent-instance reload, one-time backup-failure warning. `updateDraft` passes every edit through `mirrorMouseEdit` (`settings.syncMice`), so the other mouse's copy is part of the same undo step. After a save it writes the key-button signals into the mouse only when they changed since the last save of the session (the first save just records them; the backend guard keeps the mouse in line and retries) — rewriting every save failed whenever the mouse slept.
- `useRuntime.ts` — runtime status + push-based log/event stream (incremental; avoid full refetch).
- `useListKeyboard.ts` — canonical Arrow/Home/End/Enter list navigation (palette, dropdown, context menu).
- `useModalDismiss.ts` / `useDismissable.ts` — Escape + focus-trap + outside-click for modals/popovers.
- `useControlInteractions.ts` — mouse-control click/dblclick/keydown/drag prop bundle.
- `useLogPanel.ts`, `useMouseVisualPanel.ts`, `useActionPicker.ts`, `useVerification.ts`.
- `useActionPicker` only opens a valid control's editor and selects its existing binding, if any. It must never create a placeholder or invoke persistence; the modal owns local drafts until Save.
- `useAppPersistence` accepts a reload only while its revision is current; newer reloads, edits, undo/redo, and completed saves supersede it. Reload clears undo/redo. A rejected save drops dependent queued edits; `runtime_reload_failed` means the file was committed, so reload it and surface the runtime error without a rollback notification.
- `useVerification` synchronizes selection only when the active step belongs to `effectiveDeviceId`; choosing another device pauses selection sync and preserves the session.

## Local Contracts

- Reuse these hooks instead of re-implementing keyboard/modal/list behaviour in components.
- Callbacks passed from parents are stored in refs so a new closure each render is safe.

## Work Guidance

- Hooks with logic have `*.test.ts` (`useListKeyboard`, `useAppPersistence`, `useRuntime`, `useLogPanel`, etc.).
- Hook tests explicitly call Testing Library `cleanup` after each test (before restoring fake timers). Verification event fixtures take their timestamp when emitted, never at module import.
- `App.test.tsx` exercises root orchestration with mocked IPC and workspace boundaries; keep real persistence, runtime, verification, modal, toolbar, and toast behavior.

## Verification

- `npm run test` (vitest).

## Child DOX Index

- None. Leaf directory.
