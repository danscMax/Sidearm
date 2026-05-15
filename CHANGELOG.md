# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [Released earlier]

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
