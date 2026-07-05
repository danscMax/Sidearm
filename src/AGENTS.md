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
- Backend calls go through `lib/backend.ts` wrappers, never raw `invoke`. Surface failures via `setError`/`showToast`; never swallow a user-relevant error.

## Work Guidance

- Reuse shared primitives from `components/shared.tsx` (`ModalShell`, `ModalHeader`, `Toggle`, `Notice`) and hooks (`useListKeyboard`, `useModalDismiss`, `useDismissable`) instead of re-implementing modals/lists/toggles.

## Verification

- `npm run check` (tsc + knip + clippy) and `npm run test` (vitest). `npm run build` also typechecks `*.test.ts`.

## Child DOX Index

- `src/lib/AGENTS.md` — framework-free pure logic + its tests
- `src/components/AGENTS.md` — React components and the design canon
- `src/hooks/AGENTS.md` — shared React hooks
- `src/i18n/AGENTS.md` — localization (EN + RU)
