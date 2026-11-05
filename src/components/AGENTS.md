# src/components — UI components

## Purpose

All React components: mouse visualization, modals (action picker, app-mapping, confirm, error, presets, Synapse import), profiles/settings workspaces, command palette, onboarding, toasts, context menu, and shared primitives.

## Ownership

- `shared.tsx` — the canonical primitives: `ModalShell`, `ModalHeader`, `ModalFooter`, `Toggle`, `Notice`, `CloseButton`, `SettingRow` (settings line: title + hint left, control right; `.setting-row` in `App.css`). Reuse these; do not fork new modal/toggle/row visuals. Settings screens live in `.settings-shell__content`, capped at 920px.
- `mouse-visual/` — legend cells + columns (`LegendCell` is the keyboard-accessible control button that spreads `useControlInteractions`).
- `settings/` — settings panels + `SettingsShell`.
- `MouseWorkspace.tsx` (the "Mouse" workspace, shown only with the built-in Naga): a profile switcher on top (same selection as the sidebar, "● now" marks the runtime profile), the battery + `showBatteryInTray` switch, `offlineProfileId` (profile written into the mouse on exit; empty = the fallback profile, listed first as "<name> (fallback)"; `OFFLINE_PROFILE_ACTIVE` = the one in effect at exit), and the edited profile's own `mouseDpi`/`mousePollRateHz` (saved to the profile; also written to the mouse at once when that profile is the runtime one); the DPI range and poll-rate pills come from `getNativeModel()` (catalog data, available while the mouse sleeps), never from frontend constants; an unverified model gets a warning notice (`mouse.unverifiedModel`: buttons work through signals as a user device) with a "Help verify" button when that model is connected (`getDeviceReport` → clipboard + read-only textarea, then `openDeviceReportIssue`; the hint says whether the copy succeeded, and a disconnected model gets a "connect the mouse" hint instead of the button); a model with the consumer path gets a "Side button signals" switch (`setKeySignals`; the backend rewrites the mouse and restarts a running capture itself; the choice shows at once with a "switching…" then "done" status line, `.mouse-signals`); the active mouse-path states (`mouseStates` prop from `App.tsx`, fed by `get_mouse_status` + `mouse_status`) show as warnings on top. The profile's "own settings" toggle is seeded from the mouse's live DPI/poll rate and stays off until they are read. `App.tsx` turns the one-time notices (`offlineNotStored`, `signalsSwitched` — with a "back to F13–F24" action in consumer mode; taken only while the window is visible, so a start hidden in the tray keeps them) and `helperLost` into toasts.
- `icons.tsx`, workspace shells, and the modal components.
- `SynapseNotice.tsx` consolidates Razer process/driver/mapping warnings into one persistent bottom-right `Toast` card. Closing the Razer engine is explicit and warns about shared modules; the startup checkbox defaults off and an undo is available for this computer/user. Technical recovery leads to a physical HyperShift test, not a success claim. Process snapshots recover state for late-opened windows; subsequent Razer launches renew the warning. Ordinary toasts share the bottom-right stack without replacing the conflict card.
- Delegated to child: `action-picker/` (the per-ActionType editors).

## Local Contracts

- Modals use `ModalShell` (Escape, focus-trap, focus restore). Popovers/menus use `useDismissable` + `useListKeyboard` for keyboard operability.
- Icon-only buttons carry an `aria-label`; search/text inputs carry an `aria-label` (placeholder is not an accessible name).
- Class names and colours come from `App.css` tokens. Do not reuse a class for a different purpose — e.g. `.field__hint` is a 16×16 "?" badge, not a text-hint class; visible help text uses `panel__muted`.
- Dynamic positioning/sizing goes through the CSSOM (CSP: no inline `style={}`).

## Work Guidance

- Signals (`encoderMappings`, e.g. `F13`) of the built-in Naga are Sidearm's own transport codes, written into the mouse by the backend: never show or edit them there (`isBuiltinControl` in `lib/onboard-mapping.ts`). The action picker hides `SignalCaptureField` and never saves a mapping for them, Diagnostics hides the signal chip + verification workflow (`signalsHidden`) and shows the verification session only when a user device exists, the tester picks "button · layer" instead of a typed code, and hotspot tooltips drop the code. User devices keep every signal UI — the recorded signal is how a button is identified. Onboarding writes the mouse (`restoreOnboardControl`) instead of teaching Synapse/F-keys.
- An unassigned control is labelled "Native action" (it passes through to the device/Synapse default), distinct from the "OFF" pill for an explicitly-disabled binding.
- `ActionPickerModal` shows the global HyperShift role before profile actions, with an explicit all-profiles scope and replacement/removal warning. The role edits `settings.hypershiftTrigger`, never adds an `ActionType`; existing actions survive a role transfer. Native action removes the selected slot's binding. A new action/binding is created only on Save, with collision-safe IDs; opening/cancelling must not change the config. The five native trigger choices share `NATIVE_HYPERSHIFT_TRIGGERS` with general settings; encoded key buttons and scroll ticks remain unsupported as triggers.
- Photo/schematic layouts address the physical `mouse_right` control, never the legacy `hypershift_button` placeholder (which stays in persisted configs for compatibility). Physical badges remain localized button names; an HS marker and the assignment text/tooltip come from the current `settings.hypershiftTrigger` via the derived `ControlSurfaceEntry.isHypershiftTrigger`. Changing or disabling the trigger updates the marker without mutating bindings. Recovery instructions use this setting, including a separate left-trigger and disabled-trigger path.
- Multi-device (v3): `DeviceBar` switches `AppConfig.devices`; the built-in Naga renders `MouseVisualization`, user devices render `GenericDeviceView` (legend grid + optional photo with click-to-place hotspots). `AddControlModal` learns a button via DOM key capture — do NOT switch it to the runtime `encoded_key_received` event: the low-level hook only hears already-mapped signals. Device photos are served as `data:` URLs via `read_device_image` (asset protocol deliberately off — its scope vars can't cover the portable `./data`).

## Verification

- `npm run test` (vitest) + `npm run check`. Visual/a11y changes need a manual pass in the running app (cannot render headlessly here).

## Child DOX Index

- `src/components/action-picker/AGENTS.md` — per-ActionType editors and capture rows
