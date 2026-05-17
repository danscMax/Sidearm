# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
