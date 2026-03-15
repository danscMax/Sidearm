# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
