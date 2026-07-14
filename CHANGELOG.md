# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.2] — 2026-07-14

### Fixed
- Dragging an action onto an already-bound control no longer fails to save with "Duplicate binding tuple detected" — the drop now replaces the binding already occupying that control/layer slot instead of adding a second one.
- Help tooltips ("?") in the action editor no longer clip at the top or bottom edge of the scrolling panel; they now escape the panel and flip above when there is no room below.

### Changed
- Reworked the "Assign action" editor for less clutter and better use of width:
  - Rarely-changed settings (trigger mode, throttle, execution conditions) now live in a collapsible **Advanced** section that opens automatically when any of them is set and shows a summary of the current values when collapsed.
  - Trigger mode and throttle sit side by side; the throttle field shows its "ms" unit.
  - A live **Result** line at the bottom previews what the action will do ("Types …", "Presses Ctrl+C", …).
  - The category list has a lighter active state, and each category now shows an icon and a one-line description.
  - More "?" help tooltips (key, launch mode, signal), Ctrl+Enter to save, Enter in search jumps to the first match, and the dry-run test result reuses the standard banner style.

## [0.8.1] — 2026-07-14

### Fixed
- The Save button in the action editor no longer washes out on hover — the accent call-to-action keeps its green fill and brightens, instead of fading to a translucent white. (Root cause: the `--primary` button variant was missing from the hover exclusion list, so a translucent-white overlay overrode its accent fill.)

### Changed
- Reworked the "Assign action" editor: a noticeably wider dialog; clickable token chips (`{date}`, `{clipboard}`, `{cursor}`) that insert at the caret, with live in-field highlighting of tokens; "?" help tooltips on throttle, trigger mode, execution conditions, name and signal; an auto-growing text field without the old resize grip; and removal of the left accent bars on notices.
- Consolidated the duplicate `--primary` button style into `--accent` (they were byte-identical), so the hover-fade class of bug cannot recur.

## [0.8.0] — 2026-07-06

### Added
- Universal device support — Sidearm is no longer Razer-Naga-only. Add any programmable mouse or device, name its buttons, and teach each one with learn-mode ("press the button and Sidearm captures the signal it sends"). Existing Naga configurations migrate automatically.
- A device switcher to keep several devices side by side, and a generic device view that lists a device's controls with their per-layer bindings.
- Upload a photo of your device and click to place hotspots over its buttons for a visual button map.
- Edit a learned control in place — rename it and re-capture its signal — and teach several buttons in a row without reopening the dialog ("Add & next"); a suggested name is pre-filled.
- Text snippets can drop the caret mid-text after expanding with the `{cursor}` token.
- A new application icon and matching in-app brand mark.

### Changed
- Multi-device UI polish from an expert UI review: the signal-capture button stays quiet and reads "Stop" while armed, per-layer labels are neutral ("Layer 1/2/3"), a long device name truncates cleanly, unassigned hotspots use a solid outline, and the empty state spells out the F13–F24 precondition.
- A duplicate-signal warning now names the device that already owns that signal and is announced to screen readers.

### Fixed
- Merge-importing a configuration keeps your existing devices instead of replacing them, and re-placing a hotspot keeps its binding.
- Several layout and interaction issues on the multi-device surfaces caught in a browser UI walk.
- Held modifiers are cleared before the `{cursor}` caret walk-back so it can't leave a modifier stuck down.

## [0.7.5] — 2026-07-05

### Added
- Text snippets can expand dynamic tokens at send time: `{date}` and `{clipboard}` (use `{{`/`}}` for literal braces); the snippet editor shows a token hint.
- Command palette gained commands to start/stop interception, open the snippet library, browse profile presets, and export the active profile.
- Command palette fuzzy matching — "np" finds "New profile" — and rules are searchable by what they do (launch-target paths, sequence step text, inline snippet text), not just their label.
- Keyboard shortcut cheat-sheet: press `?` (or run it from the palette) to see every shortcut.
- The macro step editor exposes the `repeat` field for Send/Text steps (the backend already executed it, but it could only be set by editing the config by hand).
- A multi-control selection is no longer a dead end — an inline bar offers "Clear bindings" (with confirm + single undo) and "Deselect".
- The context menu and a control's action editor are fully keyboard-operable (menu roles, arrow navigation, Enter to open the picker).
- A corrupt `config.json` is auto-recovered from the last-known-good file or a rolling backup instead of dropping the app into an error state; a config newer than the app is preserved rather than overwritten.

### Changed
- Rule on/off toggles use the shared Toggle component; the active navigation item shows an accent bar; quiet buttons respond to hover; the accent colour now applies to every checkbox and radio (no more OS-blue Synapse-import checkboxes).
- A control with no binding reads as "Native action" instead of "OFF" / "Not assigned".
- Profiles, Diagnostics and Snippet-library search fields are labelled for screen readers; mouse-photo alt text is localized.

### Fixed
- The window reliably comes to the foreground when opened from the tray icon or the global shortcut (Windows).
- "Record key" capture no longer picks up the app's own injected hook-probe key (a phantom `VK_232`).
- Long throttle help text no longer overflows its badge in the action picker; the snippet cheat-sheet panel has a proper modal background.
- Pasting a long snippet no longer silently discards non-text clipboard contents (image/files/HTML) without warning; a failed backup write now surfaces a toast instead of failing silently.
- "Pick a running process" surfaces an IPC failure instead of falsely reporting that nothing is running.
- Profile/snippet-library import validators no longer crash on a well-formed-but-corrupt file; rule priority guards against `NaN`.
- Dropped keyboard-capture events (a stalled consumer filling the bounded channel) are now logged (rate-limited) so "a button sometimes doesn't fire" is diagnosable.

## [0.7.4] — 2026-07-04

### Added
- Reorder application rules from the keyboard: focus a rule card and press Alt+↑/↓, or use "Raise/Lower priority" in its context menu — priority is no longer mouse-drag only.

### Changed
- Unified every text field, search box and select onto one input style — a recessed "well" with a consistent accent focus ring — so fields read the same across Settings, Diagnostics and every dialog.
- Reworked button emphasis: ordinary buttons (Browse, Export, filters) are now quiet, and the accent green is reserved for the single primary action on each screen; toggle buttons show a clear pressed state.
- Denser, more consistent Settings layout with unified section headers.
- Diagnostics resolution/execution facts show the action's name instead of its raw internal id.
- Command palette rows show keyboard shortcuts as key chips and mark the selected row with an accent bar.

### Fixed
- The event journal no longer shows raw `[date][time][LEVEL][module]` prefixes (or the date as a category) in release builds — the log parser handles the dated release-build format.
- The Diagnostics screen now adapts to the window width instead of overflowing horizontally; the testing bar wraps instead of clipping its buttons off-screen.
- Button-legend hover tooltips are no longer clipped on the top rows.
- The app-rule dialog caps its height and scrolls instead of clipping the header/footer on short windows; its "New rule" title is shown as a proper heading.
- The action search box no longer shows a duplicate native clear (×); the assignments search field no longer crowds its text against the top edge.
- Onboarding moves focus to each step's heading (announced by screen readers) without drawing a stray focus outline; the current progress dot is marked, and not-yet-reached dots are disabled.

## [0.7.3] — 2026-07-04

### Fixed
- Escape now dismisses the error dialog instead of silently clearing the background control selection.
- Merge-mode config import preserves the order of profiles, bindings and snippets instead of randomizing it.
- Importing a Synapse v3 profile with a bare-modifier key (a button mapped to hold Ctrl/Shift/Alt/Win) now folds it into the modifier flags correctly instead of dropping it.
- Snippet-library deduplication no longer merges two distinct snippets whose name/text happen to concatenate to the same string.
- Converting an action to a menu now seeds a fresh placeholder target instead of linking to an unrelated existing action.
- A transient lock on the rolling backup file (antivirus/indexer) no longer aborts saving the config.
- Sequence actions are capped at 200 steps so a malformed config cannot block the worker thread indefinitely.
- Zero-padded Synapse function-key tokens (e.g. `F01`) canonicalize to `F1`; profile priority no longer overflows on import; a sibling `Macros`/`macros` folder is parsed only once.
- `REG_EXPAND_SZ` App Paths registry values are expanded before the executable existence check.

### Changed
- Foreground-window process info (path/exe/elevation) is cached per (window, process) on the keystroke dispatch path, skipping redundant process-handle syscalls on repeated / held / auto-repeat keys. The window title is always re-read so it never goes stale.
- Reduced per-keystroke allocations and redundant lookups on the input hot path (single action lookup, borrowed strings, one lock acquisition, single title/path normalization).
- Debug-log summaries are no longer built when debug logging is disabled (the production default).
- Raised subtle and danger text contrast to meet WCAG AA (dark theme); added accessible labels to the action-picker and process-picker search inputs.
- The "Synapse installed" onboarding check runs off the shared async executor thread.

### Security
- Hardened the App Paths registry lookup against path traversal in the supplied executable name.

## [0.7.2] — 2026-07-02

### Added
- **Factory-defaults detector.** When the Razer software fails to apply the
  remap profile (a known Synapse 4 autostart bug), the mouse silently types
  factory digits 1–12 and bindings just stop working. Sidearm now recognizes
  the driver's re-injection signature at the keyboard-hook level and warns
  with a toast plus a Diagnostics entry instead of failing silently. The
  verification wizard's "no signal" hint now also points at Razer Synapse /
  onboard memory as the likely cause.

### Changed
- **Global shortcut is captured, not typed.** Settings → App now records the
  show/hide hotkey from an actual keypress — layout-independent, so it works
  on Cyrillic layouts — and applies it immediately, without an app restart.
  An unrelated settings save no longer re-registers (and briefly drops) the
  live hotkey.

## [0.7.1] — 2026-07-01

### Added
- **Configurable global shortcut.** The system-wide show/hide hotkey (previously
  hardcoded to `Ctrl+Alt+N`) can now be changed in Settings → App.
- **Launch folders and URLs.** A launch action can now open a folder or a URL,
  not just run a program — the target mode is auto-detected from what you enter.
- **Import: Merge vs Replace.** The import wizard now offers an explicit choice
  between merging into your current configuration and replacing it, and surfaces
  import errors inline instead of failing silently.

### Removed
- Unused notification permission/plugin (one fewer system permission requested).

### Fixed
- Clearer "no backup available" message with a shortcut to the config folder
  when there is nothing to restore.

## [0.7.0] — 2026-06-30

A large UX overhaul: power features for managing profiles and bindings, plus
visual polish across the app.

### Added
- **System tray menu.** Switch the active profile, pause/resume interception,
  and **create a rule for the active window** straight from the tray. The active
  profile is marked with a native checkmark.
- **Cross-profile command palette.** `Ctrl/Cmd+K` now searches bindings and
  snippets across *all* profiles, and shows recent activity when the query is
  empty. Selecting a result jumps straight to it.
- **All-rules view.** See every profile's application rules at once, grouped by
  profile. Drag a rule into another profile to move it (with a confirmation).
- **Single-binding export / import.** Share one binding as a portable
  `.sidearm-binding.json` file (referenced snippets travel with it), and import
  it onto any button.
- **Copy a binding to another profile** from its right-click menu.
- **Per-binding throttle** (0–5000 ms) to debounce accidental double-triggers;
  a throttled press dims the hotspot briefly and is logged in Diagnostics.
- **Per-binding disable** with a dimmed “OFF” overlay on the hotspot.
- **Conflict merge.** The duplicate-shortcut banner gains a “Keep this” action
  that disables the other conflicting bindings in one click.
- **Per-button recent-activity timeline** and richer hover tooltips.
- **Snippet export to Markdown / plain text**, in addition to JSON.
- **Re-run the setup wizard** from Settings → App and the title-bar “?” button.
- **Configurable device name**, a bottom status strip, and an undo button on
  toasts.

### Changed
- Visual polish throughout: two-line hotspot badges (number + signal),
  larger/higher-contrast hotspots, a search field with icon and clear button,
  and application-rule cards that show their binding count and priority.
- A duplicate launch now surfaces the existing window and shows a toast instead
  of silently doing nothing.

### Fixed
- **Push-to-talk / held shortcuts** no longer cut off mid-hold — neither during
  the wireless mouse's key auto-repeat nor during brief RF dropouts while the
  button is still physically held.

### Notes
- The per-binding throttle and device-name settings add optional config fields.
  Configs that don't use them remain fully compatible with 0.6.x; if you set a
  throttle or device name and later downgrade, that config may not load on the
  older version (a backup is always kept).

## [0.6.3] — 2026-06-30

### Added
- **Single-instance enforcement.** Launching Sidearm while it is already running
  no longer starts a second copy — the existing window is surfaced (restored and
  focused) instead. This prevents two independent instances from fighting over
  the keyboard hook or clobbering each other's config (e.g. admin-autostart
  racing a manual launch). The capture helper subprocess is unaffected.

## [0.6.2] — 2026-06-28

### Fixed
- **Pasted text snippets no longer leak into clipboard history.** Long snippets
  (over 100 characters) are pasted via a brief clipboard write + Ctrl+V to
  preserve newlines; that staged write used to land in the Windows clipboard
  history (Win+V) and sync to the cloud clipboard. The staged write is now
  tagged with the documented exclusion formats (`CanIncludeInClipboardHistory`,
  `CanUploadToCloudClipboard`, `ExcludeClipboardContentFromMonitorProcessing`) —
  the same mechanism password managers use — so snippets stay out of history and
  the cloud. Paste behavior is otherwise unchanged.

## [0.6.1] — 2026-06-26

### Changed
- **Smaller download.** The three mouse images (combined/top/side views) were
  re-encoded from PNG to WebP — ~1.0 MB down to ~59 KB (-94%) with no visible
  quality loss. The frontend bundle drops from 1.8 MB to ~0.85 MB and the
  executable from 17.4 MB to 16.5 MB.

## [0.6.0] — 2026-06-26

### Added
- **Explicit "default profile" control.** The all-profiles list now shows a star
  on each profile; clicking it sets that profile as the catch-all used when no
  app rule matches (previously this `fallbackProfileId` had no UI). The current
  default is marked with a "default" badge.
- **Dedupe button in the snippet library** merges exact-duplicate snippets (same
  name + text + paste mode) into one and re-points every linked button to the
  kept copy.

### Changed
- **The snippet library editor is now a two-pane master/detail layout** (list on
  the left, sticky editor on the right). Selecting a snippet to edit no longer
  yanks the viewport back to the top.
- **Clearer profile copy.** Honest priority tooltip and renamed
  profile-switch / tab / workspace labels to reduce the "settings profiles vs.
  assignment" confusion.

### Fixed
- **Deleting the default profile now reassigns it predictably.** The new default
  becomes the highest-priority enabled profile (the old lowest-priority auto-pick
  surprised users — e.g. "game" winning over a higher-priority "main"), and the
  app reports by name which profile became the default so the change isn't silent.

## [0.5.1] — 2026-06-26

### Fixed
- **Deleting a profile no longer fails with "Config validation failed."** When
  the deleted profile was the fallback (or the target of a profile-switch
  action), the leftover reference pointed at a missing profile and the whole
  config was rejected, rolling the deletion back. Deleting now reassigns the
  fallback to a remaining profile, retargets profile-switch actions to it, and
  clears a stale last-selected pointer.

## [0.5.0] — 2026-06-26

### Added
- **The snippet library is now a real source of truth.** Inserting a snippet
  onto a button (or saving one to the library) links it by reference, so
  editing the library entry updates every button that uses it. Editing the
  text on a button detaches it into its own copy. The "used by N actions"
  counter and the delete warning now reflect reality instead of always showing
  zero.
- **Library tab gained tags, notes, name/text search, alphabetical sorting, a
  text preview on each card, Duplicate, and Export/Import** of the whole
  library to a `.json` file.
- **Profile export now bundles the snippets its buttons reference**, so
  library-linked buttons survive a cross-machine import.
- **Undo coalescing:** typing into a name or text field now collapses into a
  single undo step instead of one per keystroke.

### Fixed
- **Deleting a library snippet no longer breaks the buttons that used it** — the
  snippet's text is inlined back into each linked action instead of leaving a
  dangling reference.
- **Adding a new snippet no longer risks rolling back unsaved edits** (a blank
  snippet failed whole-config validation).
- Removed the paste-mode selector, which had no effect at runtime.

### Accessibility
- Modals restore focus to the element that opened them and describe their body
  to screen readers; destructive confirmations announce as alert dialogs.
- Removed invalid nested `<label>` markup around toggles.

## [0.4.0] — 2026-06-26

### Added
- **Snippet library editor.** A new *Library* tab in Settings lets you manage the
  reusable text-snippet library directly: add, rename, edit the text and paste
  mode, and delete snippets. Deleting a snippet that is still referenced by
  actions warns first and shows how many actions would be left without text.

### Fixed
- **Picking a snippet from the library now also fills the action name.** Selecting
  an entry in the action picker's "Insert from library" dropdown inserted the
  snippet's text but left the Name field stale; it now adopts the snippet's name.

## [0.3.0] — 2026-06-25

### Added
- **Redesigned Settings page.** The single endless-scroll settings panel is now
  organised into five tabs — App, Notifications, Profiles, Backups, Advanced —
  with a vertical tab rail. Surfaces gained depth (layered cards + subtle
  shadows) and accent colour is now disciplined: green marks only the primary
  action, an enabled toggle or the selected segment.
- **Corner picker for OSD position.** The notification position is now chosen on
  a 2×2 mini-screen with four corner targets instead of a flat segmented list.
- **Live OSD notification preview.** The Notifications tab renders a sample toast
  in the current size, position and animation instead of an empty box.

### Fixed
- **OSD notification no longer clips or runs off-screen on mixed-DPI
  multi-monitor setups.** Moving the notification window onto the cursor's
  monitor fired `WM_DPICHANGED`, which rescaled it after sizing — clipping the
  text on a lower-DPI monitor and overflowing the screen edge on a higher-DPI
  one. The window is now anchored on the target monitor before it is sized, so
  the computed size sticks.

### Changed
- **Advanced settings tucked away.** Interception-tuning fields keep their depth
  but moved under an Advanced tab with long explanations collapsed into “?”
  hints; the raw `CONSUMED`/`REPLAYED` terms left the visible labels.
- **Cleaner profile list and backups.** The all-profiles list dropped its
  per-card icon actions (duplicate/export/delete now live only in the editor),
  and backups are grouped into auto-copies vs dated snapshots with restore
  de-emphasised.

## [0.2.3] — 2026-06-20

### Added
- **Reorder macro steps.** Sequence-action steps can now be moved up or down
  with ↑/↓ controls on each step card; previously they could only be added,
  edited or deleted.
- **Keyboard shortcuts for common commands.** New profile (Ctrl+N), add rule
  (Ctrl+Shift+A) and capture active window (Ctrl+Shift+C) now have shortcuts,
  surfaced in the command palette.

### Fixed
- **Input placeholders meet WCAG AA contrast.** `.field` input/textarea placeholders
  used `rgba(226,236,218,0.45)` (~3.8:1 on the dark surface, below the 4.5:1 floor);
  they now use `--c-text-muted`, matching the search/palette placeholders.

### Changed
- **Distinct labels for the two capture buttons.** In the shortcut-action editor
  the key-capture and signal-capture rows both showed a generic “Record” button;
  they are now “Record key” / “Record signal” so it is clear which records what.
- **All settings segment-controls use the shared `PillTrack`.** The six OSD and
  capture-tuning toggles (duration / position / font size / animation / stale-GC
  window / force-release window) were hand-rolled `action-button` groups — a third
  segment-control style alongside the pill tabs. They now reuse `PillTrack` for a
  consistent look and animated indicator.
- **UI consolidation pass (no behavioural change).** A second duplication audit
  drove a round of shared-component adoption with no user-facing change beyond
  consistency: a single `ModalHeader`/`ModalFooter` now back every modal's title
  and action rows (all headings are `<h2>`; the confirm dialog gained an
  `aria-labelledby`), a `Notice` component owns the dozen inline status banners,
  `SelectField`/`Toggle` replaced the remaining hand-rolled `<select>`s and
  checkboxes, the capture-delay strip reuses the shared `PillTrack`, and the
  copy/export/delete icons became shared components (fixing a copy-icon that had
  silently drifted between its two sizes).
- **Unified list keyboard navigation.** Arrow / Home / End / Enter handling for
  the profile dropdown and command palette now share one `useListKeyboard` hook
  (clamp by default, wrap for the dropdown), and the running-process picker gained
  arrow-key navigation with a highlighted row.

## [0.2.2] — 2026-06-19

### Changed
- **Responsive narrow-window layout instead of a hard 900px floor.** The minimum
  window width dropped from 900 to 480. Below 860px the sidebar collapses to a
  56px icon rail (nav icons with hover tooltips + the runtime status dot; brand,
  profile switcher and labels hide — profiles stay switchable from Settings), and
  the assignments view stacks the mouse image on top with the two label columns
  side by side below it. Below 560px the side-view legend drops from four columns
  to two and the verification-steps grid to one. Previously the window simply
  couldn't be made narrow.

## [0.2.1] — 2026-06-19

A quality release: a UI-consolidation refactor (shared components/hooks, no
behavioural change), several onboarding fixes, a window-resize fix, and two
bugs found by new property-based tests. All gates green (tsc, vitest, knip,
clippy `-D warnings`) and a portable build was smoke-tested.

### Fixed
- **Key-name normalization is robust against reserved names.** `normalizeKeyName`
  used a plain-object lookup, so inputs like `"toString"`/`"valueOf"` returned an
  inherited `Object.prototype` function instead of the string. Found by
  property-based testing; now guarded with an own-property check.
- **Launch actions always get a non-empty default name.** A launch target that
  was empty or ended in a path separator (e.g. `C:\`) produced an empty
  auto-generated name (`??` didn't catch the empty-string basename). Found by PBT.
- **Window can no longer be resized below its usable size.** The borderless
  window didn't get the OS minimum-size clamp, so dragging it narrow broke the
  layout (the sidebar piled up full-width over the workspace). The 900×600
  minimum is now enforced explicitly, so interactive resizes are clamped.
- **Administrator check is fixable from the welcome step.** The first onboarding
  screen's "running as administrator" check now offers an inline "Restart as
  admin" button when it's red, instead of just showing "not found".
- **Onboarding admin check no longer contradicts itself.** The "administrator
  rights" step claimed "already running as administrator" whenever the
  run-as-admin autostart task existed, even when the current session was not
  elevated (so the welcome step showed it red and the admin step showed it
  green at once). It now distinguishes three states: elevated now, autostart
  configured (applies at next sign-in), or neither.
- **Onboarding can elevate the current session.** Added a "Restart as
  administrator now" button (reusing the existing tray relaunch command) so the
  red welcome check has a real remedy — the wizard reopens elevated.
- **Onboarding spacing under strict CSP.** Several inline `style` attributes
  were silently dropped by the app's `style-src 'self'` policy; moved to CSS
  classes so first-run spacing renders as intended.
- **Command palette is now a proper modal** (focus-trap + `aria-modal`),
  fixing focus escaping the palette.
- **Portable build no longer crashes on the WebView2 signature check** when the
  PowerShell security module fails to load — the check now fails closed (warns
  and skips bundling) instead of aborting.

### Changed
- **UI consolidation (no behavioural change).** Extracted shared components and
  hooks to remove drifted re-implementations: `PillTrack` (was 3 hand-rolled
  pill selectors), `PathField`, `SelectField`, `CompoundCard`, the action-picker
  `ModifierRow`/`CaptureRow`/`PickerGrid` primitives, and a `useDismissable`
  popover hook (unifies dropdown/context-menu dismiss). Onboarding and command
  palette now use the shared `ModalShell`. Status colours and elevation shadows
  moved onto CSS custom properties (`--shadow-modal`, `--shadow-popover`,
  `--c-info`, `color-mix`-derived semantic tints).

## [0.2.0] — 2026-06-17

A large audit-driven release: one new feature, the English UI fixed, several
save-breaking bugs repaired, ~25 smaller fixes, and internal modernization. All
changes were gated (cargo test, clippy `-D warnings`, tsc, vitest, knip) and a
portable build was smoke-tested.

### Added
- **Profile switching from a mouse button.** A control bound to a *Profile switch*
  action now actually changes the active profile at runtime (sticky until the next
  switch) instead of failing with "not supported". The override is read by both the
  active-profile indicator and dispatch, so they stay in lock-step.

### Fixed
- **"Repair clipboard" bindings can be saved again.** A config containing a
  `repairClipboard` action was wrongly rejected on save/load by the semantic
  validator (it had no matching arm).
- **Profiles whose name starts with a digit now save** ("2nd profile", "3D"): the
  generated id no longer violates the config-schema id pattern.
- **Empty menu no longer eats your edits** — Save is disabled until the menu has at
  least one item, instead of letting the backend reject it and roll the draft back.
- **The English UI is actually English.** Action-type categories, mouse/media
  options, and workspace/verification labels were hardcoded in Russian and ignored
  the locale; they now resolve through i18n.
- **Linux:** the evdev capture backend no longer hangs on stop/exit when idle
  (non-blocking reads) and no longer recurses unboundedly on device hotplug.
  *(Verified on Linux: compiles, unit tests pass, and a synthetic-device runtime
  smoke confirms stop() is responsive.)*
- ~17 smaller reliability/correctness fixes: global hotkeys firing through open
  modals, a CSS variable not being cleared, a `sleep`→`send` step carrying the wrong
  delay, a log-panel StrictMode leak, editing a library snippet, orphan-action
  pruning on binding duplication, verification-session key correlation, Synapse-import
  warning suppression and missing size limits, and resolver regex-length limits.
- **Accessibility:** the profile cards and icon-only header buttons are now
  keyboard-accessible / labelled; onboarding and autostart-hint text colours meet
  contrast (no more undefined CSS tokens).

### Changed
- Single-profile export/import now goes through one consolidated path with
  consistent filename sanitization (previously two duplicate command pairs).
- The portable build verifies the WebView2 bootstrapper's Authenticode signature
  (must be Microsoft-signed) before bundling it.
- The dependency-audit workflow now ignores 19 transitive, non-exploitable advisories
  (GTK3 bindings + build tooling) so genuine issues stand out.
- Internal modernization: migrated the Rust crate to **edition 2024**, upgraded
  `zip` 0.6 → 2.x on the untrusted-archive parser, and replaced `once_cell::Lazy`
  with `std::sync::LazyLock`.

## [0.1.25] — 2026-06-14

### Fixed
- Clipboard auto-repair now skips any copy that also carries non-text formats
  (images, files, HTML, RTF) instead of rewriting the clipboard with text only —
  so a repair can no longer discard rich content. Plain-text copies (the only
  ones that actually mojibake) are still repaired; the skip and the preserved
  formats are logged.

## [0.1.24] — 2026-06-14

### Fixed
- Clipboard auto-repair (the `repairClipboard` action and the "repair on copy"
  setting) now also undoes mis-decodes that came through the terminal's
  **Windows-1252** path, not only Latin-1 — so Cyrillic letters that turned into
  symbols like `€ ' " – —` are recovered too.
- Auto-repair now works on **mixed** clipboard text. Previously a single
  already-correct character (e.g. real Cyrillic) made it bail on the whole
  string; it now re-decodes each mangled run independently and leaves correct
  characters untouched.

### Changed
- The post-copy repair waits up to 800 ms (was 400 ms) for slow/large copies to
  land before giving up, and logs why a repair was skipped — including the
  foreground window when a copy never reached the clipboard — to make
  intermittent "copy not fixed" reports diagnosable from the log alone.

## [0.1.22] — 2026-06-06

### Security
- Updated `vite` (8.0.16) and `picomatch` (4.0.4) to clear known advisories — a
  path traversal and an arbitrary file read in the vite dev server, and a
  picomatch ReDoS. Dev toolchain only; the shipped app is unaffected.

### Changed
- Renamed two persisted config fields for consistency: `actionRef` → `actionId`
  and `pretty` → `displayName`. Backward-compatible — existing configs still load
  and are migrated to the new names on the next save.

### Internal
- Added a CI pipeline (typecheck · tests · clippy · cargo test) and `knip`
  dead-code detection wired into `npm run check`; hardened the dependency-audit
  workflow (prebuilt cargo-audit, prod-only `npm audit`, Node 24 action majors).

## [0.1.21] — 2026-06-05

### Added
- **Binding context menu** — right-click a mouse button to edit, duplicate, copy
  to the other layer, enable/disable, or clear its binding.
- **"Test" button in the action picker** — runs the draft action for real
  (3-2-1 countdown so you can switch to the target window; Launch/URL fires
  immediately), instead of only describing it.
- **Shortcut-conflict banner** naming the clashing buttons on the current layer.
- **Per-binding enable/disable toggle** in the inspector.
- **Launch action opens URLs and folders**, not just executables.
- **Cross-profile binding search** — find where a shortcut is bound across all
  profiles.
- **Snippet library** — insert from / save to the reusable snippet library in
  the text editor.
- **Command palette** gains new/duplicate profile, add rule, open config folder,
  and capture window.
- **Keyboard**: Enter opens the picker, Delete clears the selected control's
  binding.

### Changed
- Visual polish: toast colors aligned to design tokens, button hover states,
  `:focus-visible` on toolbar/titlebar controls, radius tokens, richer empty
  states.
- Accessibility: `aria-pressed`/`aria-current` on toggle groups, localized
  `ErrorBoundary` and onboarding, onboarding focus-trap + Escape.
- Reliability: per-keystroke debug logging gated behind `SIDEARM_DEBUG_CAPTURE`,
  a single OSD hide-timer thread, clipboard auto-repair moved off the worker
  thread, atomic config copies during migration, date-safe snapshot pruning, and
  a clearer restore error for unreachable backup paths.
- Mouse illustrations downscaled (~0.8 MB smaller install).
- Tooling: `clippy` wired into `check:rust` (+ strict `lint:rust`); the portable
  build script now stops a running app before compiling.

### Fixed
- Editing a binding no longer silently re-enables one you deliberately disabled;
  first-time assignments now correctly save as enabled.
- Destructive confirmation dialogs use a red (danger) button.

## [0.1.20] — 2026-06-04

### Fixed
- **Cyrillic text snippets no longer garble into mojibake.** Short snippets type
  their text via `SendInput` `KEYEVENTF_UNICODE`, which Windows corrupts for
  non-ASCII characters when a Ctrl/Alt modifier is momentarily held — the Razer
  encoding-modifier suppression could leave one asserted past the injection. The
  injector now waits (bounded) until Ctrl and Alt actually read released before
  typing, re-asserting their release against a late key-up. English text and long
  (clipboard-pasted) snippets were never affected.

### Changed
- Internal: the action picker is decomposed into focused per-category editor
  components plus a tested pure-logic module (no behaviour change), and the
  executable/directory path pickers are shared instead of duplicated.

### Security
- Patched build-time dependencies (`vite`, `postcss`, `picomatch`) via
  `npm audit fix` — 0 advisories remaining. The shipped binary was not affected.

### Removed
- Unused dead exports and the unused `@tauri-apps/plugin-global-shortcut` and
  `@tauri-apps/plugin-notification` JS bindings (both are driven from Rust).

## [0.1.19] — 2026-06-04

### Added
- **First-run onboarding wizard.** A full-screen setup wizard guides new users
  through Razer Synapse configuration, verifies the F13–F24 pipeline live
  (press Naga buttons and watch them light up), offers run-as-administrator
  autostart, and ends with a hands-on "press a button, watch it fire" step.
  Ships the Razer Synapse profile in the app and adds a "Re-run onboarding"
  entry in Settings.

### Fixed
- **Per-app profile resolution.** The foreground watcher and the dispatch path
  used drifted copies of the resolver; only dispatch consulted the editor's
  last-selected profile, so selecting an empty profile could make every
  unmapped app stop responding while the on-screen indicator still showed a
  working profile. Both now share one resolver (app mapping → fallback);
  the editor selection no longer overrides the runtime.
- **Razer Synapse import** no longer produces a config rejected on save when a
  button is mapped via two Synapse inputs (e.g. `DKM_M_0X` and `KEY_X`):
  duplicate `(control, layer)` bindings are de-duplicated with a warning.

## [0.1.18] — 2026-06-01

### Fixed
- Mouse visualizer re-applies the per-layer accent: the **Hypershift** layer is
  orange again (it had silently reverted to the standard green after an earlier
  workspace refactor dropped the wrapper that set the layer CSS variables), and
  the toolbar layer badge now matches that colour.
- Switching layers no longer nudges the assignments **search field** sideways —
  the layer badge reserves a stable width across the "Standard"/"Hypershift"
  labels regardless of locale.
- **Action summaries** in the control properties panel are localized again via
  i18n instead of always rendering Russian, so they follow the selected UI
  language (English included).

### Changed
- Internal: deduplicated the photo and schematic mouse visualizers into a shared
  `lib/mouse-visual` + `useControlInteractions` hook + `mouse-visual/*` components,
  and consolidated modal markup into a shared `ModalShell` + `CloseButton`. No
  user-facing behaviour change. Added unit tests for the error translator and the
  control-interaction hook.

### Removed
- Internal: removed dead code — 5 orphaned components, the CSS only they used, and
  unused exports (~1.9k lines), with no functional impact.

## [0.1.17] — 2026-05-29

### Security
- **Removed the self-signed code-signing cert auto-install into the Trusted
  Root store** and the hardcoded PFX password from the build scripts
  (`sign.ps1` / `nsis-hooks.nsh` deleted, bundled `.cer` resource dropped).
  Installing a custom root on every end-user machine is a high-value attack
  surface for an input-synthesis app (FIXES P0-1).
- **Hardened CSP**: `style-src` no longer allows `'unsafe-inline'`. All inline
  styles moved to CSS classes / `data-*` attributes / CSSOM, closing the
  CSS-injection surface in the renderer (FIXES P2-3).
- **Narrowed file IPC**: the generic `write_text_file`/`read_text_file` commands
  (any path under home) are replaced with purpose-named profile export/import
  commands that validate the path (home-scoped + `.json` + 5 MiB import cap), so
  a compromised renderer can no longer read/write arbitrary files (FIXES P2-2).
- **Zip-bomb caps** on Razer Synapse `.synapse3` import: entry-count, per-entry
  and total uncompressed-size limits reject decompression bombs before any entry
  is read (FIXES P2-1).

### Added
- **Contextual action conditions are now enforced**: actions carrying
  `ExeEquals` / `WindowTitleContains` (etc.) fire only when the active window
  matches; a new `ConditionUnmet` diagnostics status explains skips (CTX-001).
- **Diagnostics**: live-test for media/mouse actions, plus the resolution reason
  shown in the panel.
- **App mappings match by pinned `process_path`**, distinguishing two apps that
  share the same executable name.
- **Repeat-count** on Send/Text macro steps.
- Broad UI / i18n / a11y pass (40-item audit): fully localized service/settings
  panels, aria-labels and focus management on modals, transitions, loading
  spinner, command-palette and drag affordance hints.

### Changed
- Added a release build profile (`lto`, `codegen-units=1`, `strip`): smaller
  binary and less unwinding machinery for an input-synthesis app (FIXES P2-4).

### Fixed
- Reliability hardening (40-item audit): graceful handling of capture-helper
  pipes and a reaper thread that joins wedged hook/worker threads on stop;
  no-panic fallbacks for tray icon / global shortcut / setup; `ErrorBoundary`
  "Reload" now performs a real `window.location.reload()`; the log panel no
  longer leaks a dangling native listener on a failed attach; IPC failures
  surface instead of vanishing silently.
- `build_portable` no longer wipes `./data` (config / profiles / snapshots) on
  rebuild (PKG-001).

### Removed
- The no-op `clipboardPaste` paste-mode selector from the UI and the dead
  `#[cfg(test)]`-only `clipboard.rs` (long text still uses the clipboard-paste
  path inside `input_synthesis`) (UI-CLEAN-001).

## [0.1.16] — 2026-05-17

### Changed
Preventive sweep of the remaining unbounded-growth points found during the
post-v0.1.15 audit — same failure pattern as v0.1.15 (hot-path producer +
stallable consumer + no cap = OOM under the wrong conditions).

- **Keyboard event channel** (`capture_backend::start`) switched from
  `mpsc::channel` (unbounded) to `mpsc::sync_channel(10_000)` with
  `try_send` at every producer call site (LL hook callback, WM_HOTKEY
  handler, evdev reader). When the worker_thread stalls — e.g. the
  executor is waiting on a hung SendInput against an unresponsive target —
  events drop at the boundary instead of accumulating until OOM. 10 000
  events ≈ 1–2 MB max, covering ~100 ms of typing on the fastest keyboards.
- **MacroRecorder** gained a Rust-side `MAX_RECORDED_STEPS = 1000` cap
  mirroring the existing frontend cap. Defence-in-depth: if the UI cap
  ever fails or is bypassed, `record_keystroke` silently drops further
  events instead of growing `Vec<RecordedEvent>` to OOM.

No behavioural change for normal use; only failure modes covered.

## [0.1.15] — 2026-05-17

### Fixed
- **Critical: runaway disk + memory leak** that filled 230 GB across 117 000
  log files and 16 GB of RAM in a few hours. Root cause was a feedback loop
  introduced by the v0.1.6 push-based debug log: when the webview window
  closed unexpectedly, `app.emit()` for the `debug_log_appended` event
  triggered an `HRESULT(0x8007139F)` error inside `tauri_runtime_wry`,
  which `log::error!()`'d it. tauri-plugin-log captured that error and
  wrote it to the log file; the runtime store also pushed it into the
  bridge channel, which tried to emit it, which errored again — snowballing
  at ~5 000 entries/s.

  Three defenses, applied as belt-and-suspenders:
  1. **tauri-plugin-log filter** drops `tauri_runtime_wry` Error-level
     messages. Those messages were the engine of the loop and carry no
     actionable info.
  2. **Bridge thread skips `emit()` when no webview is registered**
     (`app.webview_windows().is_empty()`). Without a listener there's
     nothing to emit to anyway.
  3. **Bounded channel via pending counter**: `push_log` skips the send
     when in-flight entries exceed 1024 (~256 KB max channel memory).
     The bridge thread decrements as it drains. If the bridge stalls,
     drops kick in immediately — no unbounded growth possible.

## [0.1.14] — 2026-05-16

### Fixed
- Portable mode is now actually portable for WebView2 state.  Previously the
  WebView2 user-data folder (cookies, IndexedDB, service workers — ~111 MB
  per machine) lived at the default `%LOCALAPPDATA%\com.sidearm.desktop\
  EBWebView`, surviving deletion of the portable folder.  Now lives in
  `./data/EBWebView/` next to the exe when the portable marker is present.
  Implementation: `WEBVIEW2_USER_DATA_FOLDER` env var is set before
  `tauri::Builder` initialises.
- Roaming-mode logs orphaned by previous non-portable runs (107 MB on the
  audit machine) are now swept by the same retention policy.  When portable
  mode is active, `log_cleanup::sweep` runs a second pass against
  `%LOCALAPPDATA%\com.sidearm.desktop\logs\` to drain anything stranded
  there before the user switched to portable.

### Removed
- Pre-rebrand orphan directories (`com.nagaworkflowstudio.app/.desktop` in
  both `%APPDATA%` and `%LOCALAPPDATA%`) are now deleted on startup.  On the
  audit machine these held ~274 MB of dead data from the era when the
  project was called "Naga Workflow Studio".

### Added
- `build_portable.ps1 -CleanCargo` switch: runs `cargo clean -p sidearm`
  before the build.  Useful periodically — `target/release/` accumulates
  dep build artefacts across releases (4.2 GB after a dozen rapid releases
  in this session).

## [0.1.13] — 2026-05-15

### Fixed
- Diagnostic `diag_*` tests in `capture_backend::windows` are now marked
  `#[ignore]`. They register global hotkeys (F13, Ctrl+Shift+F23) and install
  LL keyboard hooks on the current process, both of which fail when another
  Sidearm instance is running. They're exploratory diagnostics rather than
  contract tests — keep them in tree but don't run by default. Use
  `cargo test -- --ignored diag_` to invoke manually.

### Changed
- CHANGELOG cleanup: the stale "Unreleased" bucket that had accumulated
  features now lives under `[0.1.0]` (initial public release, 2026-03-16) so
  the file lines up with the GitHub release history.

## [0.1.12] — 2026-05-15

### Fixed
- False-positive path mismatch warning for admin-autostart tasks created
  by pre-v0.1.11 builds. Those used `schtasks /tr "\"<exe>\""`, which
  stores the path with surrounding quotes inside the task's `<Command>`
  XML element. The new COM-based registrar does not quote the path,
  so a legacy task showed up as `"E:\…\Sidearm.exe"` while the running
  process reported `E:\…\Sidearm.exe` — visibly identical but
  string-unequal. `extract_command_from_xml` now strips wrapping quotes.

## [0.1.11] — 2026-05-15

### Changed
- Autostart settings reworked from two confusing toggles into a clearer
  master / sub-toggle pair. **"Запускать при входе в систему"** is the master
  switch (does Sidearm launch automatically at logon?); **"Запускать от
  администратора"** is a sub-toggle, indented and disabled when the master
  is off, that upgrades the launcher from regular to elevated. The previous
  two-toggle design left a confusing case where "Запускать вместе с Windows"
  was visibly off but the app still launched at logon via Task Scheduler.

### Fixed
- No console-window flash when toggling admin autostart. The previous
  approach used `schtasks.exe` (which spawns a console host) or a
  self-elevated GUI child running schtasks, both of which produced a brief
  black window. v0.1.11 talks to Task Scheduler **directly** through its
  COM API via the standard Windows COM elevation moniker
  (`Elevation:Administrator!new:{CLSID}`). Single UAC prompt at toggle time,
  zero external processes spawned, zero console flashes.

### Removed
- `--admin-autostart` CLI flag and self-elevation child branch from
  `main.rs`. Superseded by COM-based registration.

## [0.1.10] — 2026-05-15

### Fixed
- No more flashing console windows when toggling admin autostart. The earlier
  approach (`ShellExecuteW("runas", "schtasks.exe", ...)`) showed a brief
  console flash even with SW_HIDE because schtasks is a console app and
  Windows attaches a fresh console to it on launch. Replaced with
  self-elevation: Sidearm re-launches itself elevated with
  `--admin-autostart enable|disable`; the elevated child (GUI subsystem) runs
  schtasks through `Command + CREATE_NO_WINDOW`, so no console ever appears.
- Autostart row layout: long hint texts (e.g. "Отключено, потому что включён
  запуск от администратора...") no longer overlap the Toggle switch. Two-pane
  row: title + hint on the left, toggle pinned right with proper flex sizing.
- Toggle component honours its new `disabled` prop visually (opacity + no
  pointer events), so the greyed-out "Запускать вместе с Windows" toggle is
  now clearly distinguishable from an active one.

## [0.1.9] — 2026-05-15

### Fixed
- Autostart toggles ("Запускать вместе с Windows" and the new "Запускать от
  администратора при входе") now live in Settings → Автозапуск, where users
  actually look. v0.1.8 mistakenly attached them to ServiceToolsPanel inside
  Diagnostics.
- Left sidebar items ("Назначения", "Диагностика", "Настройки") now switch
  language when the UI locale changes. They were sourced from a hard-coded
  Russian constants table in `lib/constants/ui-copy.ts` and ignored i18n;
  Sidebar and the Toolbar heading now read the same strings through `t()`.

## [0.1.8] — 2026-05-15

### Added
- Elevated autostart-at-logon via Windows Task Scheduler. New toggle in
  Settings → "Запускать от администратора при входе". When enabled, Sidearm
  registers a `RunLevel=Highest` / `OnLogon` task (single UAC prompt at toggle
  time). Subsequent system starts launch Sidearm elevated without any further
  UAC. Canonical Windows pattern (also used by PowerToys, EarTrumpet).
- Path-mismatch detection: if the portable folder was moved after the task
  was registered, the UI shows the registered vs current path and offers a
  "Re-register on current path" button.
- New module `admin_autostart` with 4 unit tests; new Tauri commands
  `get_admin_autostart_status` and `set_admin_autostart`.

### Changed
- When admin autostart is enabled, the regular `tauri-plugin-autostart` entry
  is disabled automatically to avoid two launchers competing at logon.

## [0.1.7] — 2026-05-15

### Added
- "Перезапустить от администратора" / "Restart as administrator" in the tray
  menu and in `RuntimePanel`. Triggers a UAC prompt and re-launches Sidearm
  elevated so `SendInput` reaches High-IL foreground windows (Task Manager,
  regedit, UAC dialogs) — Windows UIPI blocks input from a Medium-IL process
  to a High-IL one.
- `is_running_as_admin` / `relaunch_as_admin` Tauri commands.

## [0.1.6] — 2026-05-15

### Fixed
- Debug log poll-storm on every capture event — replaced poll-based `getDebugLog()`
  with push-based `debug_log_appended` Tauri event. Was costing ~1.7% total CPU
  (~27% of one core) during active mouse use with window minimised to tray.
- Stale `useEffect` without dependency array in `ProfilesWorkspace` (ran on every
  render, amplifying the poll-storm above).

### Changed
- Log retention: replaced `RotationStrategy::KeepAll` (which let logs grow to
  128 GB across 591 000 files) with hybrid sweep — keep last 7 days OR 50 files,
  whichever is stricter. Sweep runs at startup before the plugin opens any file.
- `max_file_size` for rotated logs: 10 MB → 2 MB (smaller race window when
  multiple threads write concurrently; one log had grown to 8 GB).
- Hot-path keyboard/mouse synthesis logs (`send-mouse`, `send-keyboard-inputs`,
  `clear-modifiers`) demoted from `info` to `debug` — was emitting 5–8 lines per
  click at info level.

### Added
- `log_cleanup` module with unit tests for retention sweep.
- Slim dev cargo profile: `split-debuginfo = "packed"` + `debug = "line-tables-only"`
  for dependencies, cutting `target/debug/` size roughly in half.

## [0.1.1] — [0.1.5]

See the [GitHub releases page](https://github.com/danscMax/Sidearm/releases) for
the changelog of these versions — primarily stuck-modifier hardening (RCtrl/RAlt,
buffered Ctrl recovery, hook health probes, REHOOK state reset).

## [0.1.0] — 2026-03-16

Initial public release.

### Added
- Structured logging system (tauri-plugin-log v2) with file rotation, real-time viewer, level/category/search filters
- Global JS error capture (window.onerror + unhandledrejection)
- Crash sentinel for detecting abnormal terminations
- Custom themed titlebar (replaces native Windows chrome)
- Portable build scripts (build_portable.bat/.ps1) with per-crate progress
- Heatmap: execution count indicator on each button
- Tooltips and inline help in Diagnostics workspace
- Log file cleanup (older than 30 days)

### Changed
- Rebranded from "Naga Workflow Studio" to "Sidearm"
- Heatmap style: subtle background tint + count text instead of full color fill

### Fixed
- OSD notification positioning at startup (uses Win32 GetSystemMetrics)
- CSP: allow data: URIs for exe icons in release builds
- Stack overflow in push_log on LL keyboard hook thread
- Duplicate log lines (clear_targets before adding custom targets)
- Overlay scrollbar without permanent gutter
- Window drag via data-tauri-drag-region + correct permissions
