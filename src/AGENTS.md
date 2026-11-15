# src — Frontend (React + TypeScript)

## Purpose

The React 19 + TypeScript UI. Renders the mouse visualization, action editors, profiles, settings, diagnostics, command palette, and onboarding; talks to the Rust backend over Tauri IPC.

## Ownership

- Owned here: `App.tsx` (root state, global keyboard shortcuts, modal orchestration), `main.tsx`, `App.css` (the design system), `test-setup.ts`.
- Delegated to children: pure logic (`lib/`), UI components (`components/`), React hooks (`hooks/`), localization (`i18n/`).

## Local Contracts

- Dark theme only. All colours/spacing come from CSS custom properties (tokens) in `App.css` — no hardcoded colours.
- Strict CSP forbids inline styles: set dynamic styles via the CSSOM (`ref`/`el.style.setProperty`), never `style={}`. `canon-guards.test.ts` ratchets design-system rules.
- react-compiler is on: avoid adding manual `useMemo`/`useCallback` for micro-opts; clean them as you touch code (keep `useEffectEvent` where already used).
- Every user-facing string is an i18next key present in both locales (see `i18n/AGENTS.md`).
- Backend calls go through `lib/backend.ts` wrappers, never raw `invoke`. Surface failures via `setError`/`showToast`; never swallow a user-relevant error. `setError` opens `ErrorModal` whenever an error is set (not only on a failed config load).
- Razer takeover events are owned by the consolidated `SynapseNotice` card, not separate root toasts; preserve its unchecked-by-default startup opt-in and explicit physical verification step.
- Root event effects release registrations that resolve after cleanup; deferred mouse-status visibility callbacks and snapshots must also stop after cleanup.
- Root workspace shortcuts honor already-handled events, preserve native Enter activation on buttons, and stay blocked while the presets dialog is open. Stored Undo-toast actions invoke the current redo handler.
- `main.tsx` owns the one `contextmenu` rule: the browser's own menu (Back, Reload, Print…) never shows outside text fields; a dev build shows it with Shift held (Inspect). App menus are `components/ContextMenu`.
- Config reloads synchronously invalidate the import revision; Synapse merges cannot start while a reload is pending or its revision marker awaits React commit, or apply across its revision.

## Work Guidance

- Reuse shared primitives from `components/shared.tsx` (`ModalShell`, `ModalHeader`, `Toggle`, `Notice`) and hooks (`useListKeyboard`, `useModalDismiss`, `useDismissable`) instead of re-implementing modals/lists/toggles.

## Verification

- `npm run check` (tsc + knip + clippy) and `npm run test` (vitest). `npm run build` also typechecks `*.test.ts`.

## Child DOX Index

- `src/lib/AGENTS.md` — framework-free pure logic + its tests
- `src/components/AGENTS.md` — React components and the design canon
- `src/hooks/AGENTS.md` — shared React hooks
- `src/i18n/AGENTS.md` — localization (EN + RU)
