# src/components — UI components

## Purpose

All React components: mouse visualization, modals (action picker, app-mapping, confirm, error, presets, Synapse import), profiles/settings workspaces, command palette, onboarding, toasts, context menu, and shared primitives.

## Ownership

- `shared.tsx` — the canonical primitives: `ModalShell`, `ModalHeader`, `ModalFooter`, `Toggle`, `Notice`, `CloseButton`. Reuse these; do not fork new modal/toggle visuals.
- `mouse-visual/` — legend cells + columns (`LegendCell` is the keyboard-accessible control button that spreads `useControlInteractions`).
- `settings/` — settings panels + `SettingsShell`.
- `icons.tsx`, workspace shells, and the modal components.
- Delegated to child: `action-picker/` (the per-ActionType editors).

## Local Contracts

- Modals use `ModalShell` (Escape, focus-trap, focus restore). Popovers/menus use `useDismissable` + `useListKeyboard` for keyboard operability.
- Icon-only buttons carry an `aria-label`; search/text inputs carry an `aria-label` (placeholder is not an accessible name).
- Class names and colours come from `App.css` tokens. Do not reuse a class for a different purpose — e.g. `.field__hint` is a 16×16 "?" badge, not a text-hint class; visible help text uses `panel__muted`.
- Dynamic positioning/sizing goes through the CSSOM (CSP: no inline `style={}`).

## Work Guidance

- An unassigned control is labelled "Native action" (it passes through to the device/Synapse default), distinct from the "OFF" pill for an explicitly-disabled binding.

## Verification

- `npm run test` (vitest) + `npm run check`. Visual/a11y changes need a manual pass in the running app (cannot render headlessly here).

## Child DOX Index

- `src/components/action-picker/AGENTS.md` — per-ActionType editors and capture rows
