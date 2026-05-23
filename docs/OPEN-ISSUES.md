# Open Issues

- Status: active unresolved issues and risks
- Canonical planning source: `docs/PROJECT-BACKLOG.md`
- Updated: 2026-05-23

## P2

### WIN-002

- Area: Windows runtime
- Title: Clipboard-paste restore not validated for long snippets
- Impact: text snippets longer than 100 chars are typed via a clipboard paste
  (`input_synthesis::paste_via_clipboard`, used by `send_text` over
  `CLIPBOARD_PASTE_THRESHOLD = 100`), which can fail or corrupt the clipboard in
  some target apps. The trigger is text length, not a user setting.
- Note: this is the *lightweight* CF_UNICODETEXT path with a sequence-number
  restore race-guard (`input_synthesis.rs:286`); the heavy COM/OLE `clipboard.rs`
  was dead and was deleted in UI-CLEAN-001. An earlier pass wrongly called this
  obsolete — corrected.
- Dependencies: WIN-001 (done)
- Next action:
  - test long-snippet paste + clipboard restore in Office, terminals, browsers
  - document failure/abort modes

### WIN-003

- Area: Windows runtime
- Title: Protected-window and security-boundary behavior not validated
- Impact: UAC prompts, lock screen, and the secure desktop may block or alter
  input synthesis
- Note: partially covered by WIN-001's elevation detection (the UIPI warning
  fires for High-IL foreground windows); the secure-desktop / lock-screen cases
  remain separate and manual
- Dependencies: WIN-001 (done)
- Next action:
  - test against UAC prompts, lock screen, secure desktop
  - document user-visible limitations

### VIS-003

- Area: Visual design
- Title: Original mouse illustration set not yet finalized
- Status: deferred
- Note: an SVG visualization now exists (`MouseVisualizationSvg.tsx`); confirm
  whether it already satisfies "original illustration" before investing
- Next action:
  - design call on the final mouse schematic

## Resolved in the 2026-05-23 reconciliation

- **WIN-001** (elevated-window UIPI) — done in code. Real elevation probe
  (`platform/windows/window.rs:94-110`), UIPI warning + "Restart as
  administrator" (`RuntimePanel.tsx:145-156`, tray `lib.rs:2182`), and
  uiAccess-manifest infrastructure (`build.rs:14-25`). The only residual is
  release-gated: production OV/EV code-signing (tracked as WIN-001 Phase 3 in
  the backlog).
- **UI-CLEAN-001** (no-op clipboardPaste UI) — done. Removed the paste-mode
  selector from ActionPickerModal / ActionInspector / SnippetLibraryEditor,
  defaulted new snippets to `sendText`, dropped the 9 selector i18n keys, and
  deleted the dead `#[cfg(test)]`-only `clipboard.rs`. Kept `PasteMode` +
  migration + `labelForPasteMode` for back-compat. Verified: tsc, 590 vitest,
  cargo check (+ --tests), portable build. (WIN-002 — the clipboard-restore
  validation for long snippets — remains separately open under P2.)

## Closed earlier

- ISSUE-001..003 (UI Russian, internal jargon, duplication) — done (UX-001..003)
- ISSUE-004 (bundle identifier) — done (PACK-001)
- ISSUE-005..007 (hardware validation) — done (VERIFY-001..003)
- ISSUE-009 (build lock) — documented
- ISSUE-010 (git repo) — done (PACK-003)

## Notes

- These are issue summaries, not the canonical backlog.
- Use `docs/PROJECT-BACKLOG.md` for priorities, dependencies, and execution order.
