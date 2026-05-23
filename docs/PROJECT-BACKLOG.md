# Project Backlog

- Project: `Sidearm`
- Original: `2026-03-08`
- Rebuilt: `2026-05-23`
- Current version: `0.1.16`
- Status: canonical backlog and execution source of truth

## Reconciliation note (2026-05-23)

This document was rebuilt after a ~2.5-month drift. The previous revision was
dated `2026-03-08` and predated an entire development era: the rebrand to
Sidearm, full i18n, a Linux backend, the M1–M5 milestone system, the
modifier-leak/stuck-key reliability work, autostart, and the v0.1.6–v0.1.16
disk/memory-leak fixes. None of that was reflected here, and the milestone
roadmap (M1–M5) that actually drove April–May work was never persisted to any
canonical document — it is reconstructed below so it is not lost again.

Every status change in this rebuild was verified directly against the current
source (not inferred from commit messages). Code citations use `file:line`.
The raw evidence is recorded in the **Verification Log** at the end. One earlier
assumption was actively disproved during verification (clipboard-paste was
*not* removed — see WIN-002), which is why claims here are tied to lines.

## Product Goal

Build a desktop application for the Razer Naga V2 HyperSpeed (and similar
multi-button mice) that is easier to understand and faster to use than Razer
Synapse for profile-aware mouse workflows.

The user should be able to:

1. choose a profile
2. choose a physical mouse control
3. understand what that control currently does
4. change the action quickly
5. verify that the real hardware signal matches the intended mapping

It should be: more focused, more understandable, more mouse-centric, more
explicit about verification, and better at separating simple use from expert
tools. It should not blindly copy Synapse.

**Platform:** Windows is the primary, fully-featured target (autostart, UIPI
handling, OSD via GDI). A Linux backend (evdev + arboard + active-win-pos-rs)
exists behind a platform-abstraction layer — see `src-tauri/src/platform/`.
Cross-platform parity is not a stated goal; Linux is best-effort.

## Current Snapshot

### Architecture (verified)

- Tauri v2 + React + TypeScript + Rust, in-process (see ADR 0002).
- Config v2 storage with schema + semantic validation, atomic save, rotating
  backups (see ADR 0003, `src-tauri/src/backup.rs`).
- Platform abstraction layer: `src-tauri/src/platform/{windows,linux}/`
  (window capture, elevation probe, input synthesis differ per OS).
- Backend modules: `admin_autostart`, `backup`, `chord`, `clipboard`,
  `config`, `exe_icon`, `executor`, `hotkeys`, `input_synthesis`,
  `log_cleanup`, `paths`, `recorder`, `resolver`, `runtime`, `window_capture`.
- Test coverage: **199 Rust `#[test]`/`#[tokio::test]` functions**, 13
  TypeScript `*.test.ts(x)` files.

### UI state

- Mode-based shell: `Назначения`, `Профили`, `Проверка`, `Эксперт`.
- Russian-first, mode-based, mouse-centric direction (i18n via react-i18next,
  RU + EN).
- Central mouse visualization: `MouseVisualization.tsx` +
  `MouseVisualizationSvg.tsx` (SVG schematic now exists — see VIS-003).

### Main unresolved areas

- Windows edge-case validation against elevated / protected targets (manual).
- Production code-signing (enables the UIPI-bypass path; see WIN-001).
- Clipboard-paste restore validation across apps (see WIN-002).
- Final original mouse illustration set (design call; see VIS-003).

## Working Rules

### Priorities

- `P0`: blocks correct product behavior or continuation
- `P1`: next highest-value work, should be done soon
- `P2`: important follow-up work
- `P3`: good improvements, but not urgent

### Status values

- `todo`, `in_progress`, `blocked`, `done`, `deferred`, `obsolete`

### Recommended execution order (current)

1. WIN-002 — validate clipboard restore for long snippets (Office/terminals/browsers)
2. WIN-003 — finish Windows protected-window validation + docs
3. WIN-001 Phase 3 — production OV cert when distribution is in scope
4. ACT-001 — automated live-injection E2E harness (optional, P3)
5. VIS-003 — original illustration set (design-led, deferred)

(Done 2026-05-23: UI-CLEAN-001 — removed the no-op clipboardPaste selector + dead clipboard.rs.)

## Open Backlog

### WIN-001

- Title: Behavior in elevated windows (UIPI)
- Priority: `P1`
- Status: `done` (code) — residual is release-only (see below)
- Why it existed: `SendInput` silently fails against High-IL targets (Task
  Manager, regedit, admin CMD) because of Windows UIPI.
- What shipped (verified):
  - Real elevation probe — `platform/windows/window.rs:94-110`
    (`OpenProcessToken(TOKEN_QUERY)` → `GetTokenInformation(TokenElevation)`;
    `ERROR_ACCESS_DENIED` treated as elevated at `:100`, which is correct
    because UIPI blocks token access exactly when it would block SendInput).
  - Target-window detection wired end-to-end: `window.rs:30` foreground HWND →
    `:67` `is_elevated` → struct field `window_capture.rs:29` → propagated
    `:58/:116` → consumed `capture_backend/mod.rs:260` → Russian UIPI warning
    `mod.rs:261-266, 426-427, 484-486`. **Not dead code.**
  - Own-process detection + remediation: `window.rs:117` →
    `is_running_as_admin` command `lib.rs:1070` → status + warning + relaunch
    button `RuntimePanel.tsx:141-156`; tray "Restart as administrator" shown
    only when non-elevated `lib.rs:2177-2199`; `relaunch_as_admin` `lib.rs:1106`.
  - uiAccess-bypass infrastructure: dual manifest (`manifest.xml` uiAccess
    false / `manifest-uiaccess.xml` uiAccess true) selected by `SIDEARM_UIACCESS`
    env at `build.rs:14-25`; research in `docs/research/UIPI-BYPASS-RESEARCH.md`.
- Residual (not code):
  - Phase 3: production OV/EV code-signing + perMachine install so the
    `uiAccess="true"` no-elevation path actually activates. Until then, the
    user remediation is "Restart as administrator" (which works today).
  - Manual confirmation against a live elevated target (e.g. Task Manager) if
    not already done on hardware.

### WIN-002

- Title: Validate clipboard-paste restore across target applications
- Priority: `P2`
- Status: `todo`
- Why it exists: for text snippets longer than 100 chars, the live execution
  path uses a clipboard paste (save CF_UNICODETEXT → Ctrl+V → restore), which
  can fail or corrupt the clipboard in some target apps.
- **Where it actually lives (verified):** NOT the user-facing paste-mode option
  (that was a no-op, removed in UI-CLEAN-001), but inside `send_text`:
  - `send_text` (`input_synthesis.rs:399`) → `send_text_with_delay(text, 0)`.
  - `input_synthesis.rs:344` `CLIPBOARD_PASTE_THRESHOLD = 100`; `:358-377`
    `send_text_with_delay` calls `paste_via_clipboard(text)` for text over the
    threshold, falling back to per-char `KEYEVENTF_UNICODE` on failure.
  - `paste_via_clipboard` (`input_synthesis.rs:170` Win32 / `:298` Linux) saves
    the original, stages text, injects Ctrl+V, restores — with a
    `GetClipboardSequenceNumber` race-guard (`:286`) that skips restore if the
    clipboard changed meanwhile. This is the *lightweight* path; the heavy
    COM/OLE `clipboard.rs` was dead and is deleted (UI-CLEAN-001).
- Note: corrected during UI-CLEAN-001. An earlier pass wrongly marked this
  `obsolete` ("clipboard never runs in prod") — that was true only of the
  removed option/module, not of `send_text`'s length-based path. Clipboard
  paste IS reachable in production for long snippets; the trigger is text
  length, not a user setting.
- Dependencies: WIN-001 (done)
- Acceptance: clipboard restore behavior documented across representative apps
  (Office, terminals, browsers); failure/abort modes recorded.

### UI-CLEAN-001

- Title: Remove the no-op clipboardPaste selector from the UI; delete dead clipboard.rs
- Priority: `P3`
- Status: `done` (2026-05-23)
- Why it existed: `clipboardPaste` was a no-op user choice — the executor
  ignores `paste_mode` (`executor.rs:720`) and the COM/OLE `clipboard.rs` was
  `#[cfg(test)]`-only, yet the UI offered (and defaulted to) the option in three
  places.
- What was done (verified: tsc clean, 590 vitest pass, cargo check + --tests
  clean, portable release build OK — sidearm.exe 19.6 MB):
  - Removed the paste-mode `<select>` from `ActionPickerModal.tsx`,
    `ActionInspector.tsx`, `SnippetLibraryEditor.tsx`.
  - Defaulted new inline snippets to `sendText` (`config-editing.ts:321`).
  - Removed the 9 selector-only i18n keys from `en.json` / `ru.json`.
  - Deleted `clipboard.rs` and its `#[cfg(test)] mod clipboard;` line in
    `lib.rs`.
  - Kept the data model for back-compat: `PasteMode` enum/type,
    `migrate_paste_mode`, `paste_mode_name`, and `labelForPasteMode` (still used
    by `action-helpers.ts:65` for action descriptions).
- Note: clipboard paste for long text still happens automatically via
  `input_synthesis::paste_via_clipboard` — that is WIN-002, unaffected by this.

### WIN-003

- Title: Validate protected-window and security-boundary behavior
- Priority: `P2`
- Status: `todo`
- Why it exists: UAC prompts, lock screen, and the secure desktop may block or
  alter input; behavior is undocumented.
- Note: partially covered by WIN-001's elevation detection (the warning fires
  for High-IL foreground windows). The secure-desktop / lock-screen cases are
  separate and inherently manual.
- Dependencies: WIN-001 (done)
- Acceptance: protected-window behavior described; user-visible limitations known.

### VIS-003

- Title: Original mouse illustration set
- Priority: `P2`
- Status: `deferred`
- Why it exists: the transitional thumb scene was a placeholder.
- Note: an SVG visualization now exists (`MouseVisualizationSvg.tsx`). Whether
  it already satisfies "original illustration" or is still transitional is a
  design call. Re-confirm intent before investing.
- Acceptance: original schematic represents side keypad, top controls, wheel,
  and Hypershift clearly, using Razer geometry as reference, not a copy.

### ACT-001 (new)

- Title: Automated live-injection E2E harness for action execution
- Priority: `P3`
- Status: `todo`
- Why it exists: all four action types are dispatched (`executor.rs:204-219`:
  Shortcut/TextSnippet/Launch/Sequence) and the **preview/dry-run** layer is
  unit-tested (`executor.rs:1037+`, e.g. `:1038` shortcut sim, `:1050` blocked
  unresolved, `:1109` menu-not-live, `:1137/:1150` launch validation). But live
  `SendInput` injection reaching a real target is not (and cannot be) covered by
  unit tests — it is validated only by manual/real use today.
- Acceptance: a documented, repeatable way to validate live injection of each
  action type end-to-end (even if semi-manual).

## Completed since 2026-03-08 (reconstructed from git + spot-verified)

Grouped by epic. Citations are existence/where-verified, not exhaustive proof.

- **Rebrand → Sidearm**: crate, identifier, config migration (tags around
  `e1bbe3f`); identifier `com.sidearm.desktop` (`paths.rs:20`).
- **i18n RU/EN**: react-i18next; labels via `src/lib/labels.ts`, `i18n.t(...)`.
- **WIN-001 elevated-window handling** — see Open Backlog (done in code).
- **Cross-platform / platform abstraction**: `src-tauri/src/platform/` with a
  real Linux window+elevation path (`platform/linux/window.rs:68/:114`).
- **M1 — portable mode + rotating backups + friendly errors**:
  `paths.rs:14` (`sidearm.portable` marker, Portable/Roaming/Fallback),
  `backup.rs`.
- **M2 — undo/redo toasts, search, layer indicator, conflict badges,
  terminology pass** (frontend; conflict-detection tests present).
- **M3 — Razer Synapse import** (.synapse4 / .synapse3 ZIP, sibling `Макросы/`
  `.xml` macros, merge strategy + drag-drop): `src/components/SynapseImportModal.tsx`,
  `src/lib/synapse-import.ts`.
- **M4 — multi-press (double/triple) + chords + app-mapping picker + launch
  args/workingDir + inline menu builder**: `src-tauri/src/chord.rs`; launch
  validation `executor.rs:1137`.
- **M5 — bundled preset profiles, runtime profile switch from sidebar,
  drag-reorder appMapping priority + overview tab, 1000-step macro-recorder cap**:
  `src-tauri/src/recorder.rs`.
- **Reliability — modifier-leak / stuck-Ctrl/Alt saga**: extended capture-backend
  work (phantom-Alt buffering, REPLAYED orphan tracking, extended-key injection).
- **Autostart (incl. elevated via Task Scheduler COM)**:
  `src-tauri/src/admin_autostart.rs` (`register_task_elevated` `:246`,
  COM elevation moniker `:202-224`); commands `lib.rs:1075-1093`.
- **Perf / leak fixes (v0.1.6, v0.1.14–0.1.16)**: push-based debug log +
  retention, portable WebView2 state isolation, the runaway disk/memory-leak
  fix (bounded channels + emit-skip + log filter), and the audit follow-up
  capping remaining unbounded growth (`runtime.rs`, `log_cleanup.rs`,
  `recorder.rs`, capture backends). See `CHANGELOG.md`.

### Earlier items already marked done (2026-03-08 revision)

Preserved for ID continuity; all `done` unless noted:

- UX-001…UX-008 — Russian-first UX, jargon removal, de-duplication, per-mode
  hierarchy (`Назначения`/`Профили`/`Проверка`/`Эксперт`), settings hardening.
- VIS-001 (green-noise reduction), VIS-002 (mouse as visual center),
  VIS-004 (panel density). VIS-003 — see Open Backlog (`deferred`).
- VERIFY-001…VERIFY-005 — real-device validation of top-panel/wheel/Hypershift
  controls, reserved-control policy, verification wording.
- PACK-001…PACK-003 — bundle identifier, release steps, git repo.
- DOC-001…DOC-003 — backlog as source of truth, open-issues list, UI todo.
  **Note:** DOC-001/DOC-003 referenced `docs/PROJECT-HANDOFF-2026-03-08.md` and
  `docs/UI-REDESIGN-TODO.md`, which **no longer exist** (verified absent
  2026-05-23). Those references must be removed where they still appear (e.g.
  `docs/OPEN-ISSUES.md`, README).

## Active Focus

Open, in priority order:

1. **WIN-002** (P2) — validate clipboard restore for long snippets (`input_synthesis::paste_via_clipboard`)
2. **WIN-003** (P2) — protected-window / secure-desktop validation
3. **WIN-001 Phase 3** (P1-residual, release-gated) — production code-signing
4. **ACT-001** (P3) — live-injection E2E harness
5. **VIS-003** (P2, deferred) — original illustration, design-led

Done 2026-05-23: **UI-CLEAN-001** — removed the no-op clipboardPaste selector + dead `clipboard.rs`.

## Immediate Blockers

- None for code editing.
- WIN-001 Phase 3 is blocked on a code-signing certificate (cost/decision).
- Real-device / elevated-target validation requires the physical machine.
- `tauri build` can be blocked by the running exe until the process is stopped.

## Related Documents

- summary: `README.md`
- unresolved issues: `docs/OPEN-ISSUES.md` (stale — still lists WIN-001 as P1;
  sync to this rebuild)
- UIPI research: `docs/research/UIPI-BYPASS-RESEARCH.md`
- runtime pipeline: `docs/RUNTIME-PIPELINE.md`
- config schema: `docs/CONFIG-SCHEMA-V2.md`
- device catalog / verification: `docs/DEVICE-CATALOG.md`,
  `docs/DEVICE-VERIFICATION-MATRIX.md`
- ADRs: `docs/adr/0001…0004`
- changelog: `CHANGELOG.md`
- *(removed dead refs: `PROJECT-HANDOFF-2026-03-08.md`, `UI-REDESIGN-TODO.md` —
  do not exist)*

## Verification Log (2026-05-23)

Raw evidence gathered for this rebuild (read personally, not summarized):

- WIN-001 elevation probe is real Win32: `platform/windows/window.rs:94-110`
  (`OpenProcessToken`/`GetTokenInformation(TokenElevation)`), access-denied →
  elevated at `:100`; own-process `:117-118`.
- Target-window flag flows probe → struct → warning:
  `window.rs:67/:83` → `window_capture.rs:29/:58/:116` →
  `capture_backend/mod.rs:260-266/:426-427/:484-486`.
- UI surfacing: `RuntimePanel.tsx:6/:28/:33/:141/:145-156`; tray `lib.rs:2177-2199`;
  relaunch `lib.rs:1106-1152`; startup log `lib.rs:2126-2132`.
- Manifest/build switch: `build.rs:14-25`; `manifest.xml:6` (uiAccess false),
  `manifest-uiaccess.xml:6` (uiAccess true).
- `input_synthesis.rs` only emits UIPI-hint strings (`:1217/:1219`); the
  detection is NOT here (corrected an earlier wrong assumption).
- clipboardPaste *option/module* dead, but clipboard paste IS reachable for long
  text: executor always `send_text` (`executor.rs:720`); `send_text`
  (`input_synthesis.rs:399`) → `send_text_with_delay` → `paste_via_clipboard`
  for text >100 chars (`:344`, `:358-377`; restore race-guard `:286`). COM/OLE
  `clipboard.rs` was `#[cfg(test)]`-only and is deleted (UI-CLEAN-001). The
  earlier "obsolete" verdict on WIN-002 was wrong — corrected.
- Executor dispatch `executor.rs:204-219`; preview tests `:1037-1156`.
- Portable mode `paths.rs:14-28`; autostart `admin_autostart.rs:202-277`.
- Cross-platform Linux real: `platform/linux/window.rs:68/:114`.
- Dead docs absent: `docs/PROJECT-HANDOFF-2026-03-08.md`,
  `docs/UI-REDESIGN-TODO.md` (ls → No such file).
- Test counts: 199 Rust test fns, 13 TS test files.
