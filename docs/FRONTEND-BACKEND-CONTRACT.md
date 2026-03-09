# Frontend / Backend Contract

- Status: Implemented command/event baseline for iteration 1
- Date: 2026-03-08

## Purpose

This document defines the current command and event contract between the Tauri frontend and the Rust backend.

It exists to:

- stabilize the command/event boundary around the current implementation
- keep transport concerns separate from domain logic
- define a narrow capability and permission baseline

## Transport Principles

- Frontend requests state changes and queries through Tauri commands.
- Backend publishes runtime state changes through Tauri events.
- Commands are request/response interactions.
- Events are one-way notifications.
- Frontend should use typed wrappers around `invoke` and event listeners rather than string literals spread throughout the UI.

## Contract Style

- Command names use `snake_case` for continuity with the accepted spec.
- Event names use `snake_case`.
- Payloads are JSON-serializable and should mirror the domain model where practical.
- Transport payloads should be stable and explicit, not ad hoc debug strings.

## Command Set

### `load_config`

Purpose:

- load the active config from the application config directory
- validate it against the published schema and semantic rules
- deserialize it for runtime/frontend use

Returns:

- full config payload
- validation warnings if any

Failure classes:

- file missing
- parse failure
- schema violation
- semantic validation failure

### `save_config`

Purpose:

- validate and atomically persist the supplied config
- update runtime state only after successful validation and write

Input:

- full config payload

Returns:

- schema-valid saved config
- validation warnings if any

Current iteration note:

- frontend editors currently work against an in-memory `AppConfig` draft and persist through whole-document `save_config`
- there are no single-record mutation commands in the backend at this stage

### `capture_active_window`

Purpose:

- capture delayed foreground window context for app mapping setup

Input:

- optional delay configuration

Returns:

- captured window context

### `preview_resolution`

Purpose:

- resolve `encodedKey` plus optional app context against the active config
- expose the exact control/profile/binding/action chain before execution

Input:

- `encodedKey`
- optional `exe`
- optional `title`

Returns:

- resolved or unresolved preview payload

### `execute_preview_action`

Purpose:

- run the current action executor against a resolved preview context
- emit `control_resolved`, `action_executed`, and `runtime_error` as needed

Input:

- `encodedKey`
- optional `exe`
- optional `title`

Returns:

- execution result payload

Current iteration note:

- execution remains `dryRun` for preview-only dispatch
- `execute_preview_action` validates and summarizes all supported action types without side effects

### `run_preview_action`

Purpose:

- run the first live execution backend for a resolved preview context
- keep live side effects narrower than dry-run coverage

Input:

- `encodedKey`
- optional `exe`
- optional `title`

Returns:

- execution result payload

Current iteration note:

- live execution currently supports `shortcut`, `launch`, `disabled`, `textSnippet`, and `sequence` actions composed only of supported live steps
- `sequence` live support currently covers `send`, `sleep`, `text`, and `launch`
- launch targets and working directories must be absolute existing paths
- launch uses direct process spawn, not shell string expansion
- shortcut injection uses Win32 `SendInput`
- `clipboardPaste` snippets use a clipboard-preserving backend with staged restore

### `start_runtime`

Purpose:

- start input capture and action resolution
- register active `encoderMappings` as global hotkeys on Windows
- execute resolved actions automatically when a registered encoded key fires

Returns:

- runtime state summary

### `stop_runtime`

Purpose:

- stop input capture and transition runtime to idle

Returns:

- runtime state summary

### `reload_runtime`

Purpose:

- reinitialize runtime state from the active validated config
- rebuild global hotkey registrations from the current validated `encoderMappings`

Returns:

- runtime state summary

### `get_debug_log`

Returns:

- recent debug events or log entries intended for the debug panel

## Event Set

### `runtime_started`

Payload:

- runtime state summary

### `runtime_stopped`

Payload:

- runtime state summary

### `encoded_key_received`

Payload:

- normalized encoded input event
- includes the registered `encodedKey`, backend label, timestamp, and repeat flag

### `control_resolved`

Payload:

- resolved control event
- includes `controlId`, `layer`, verification state, and source mapping data

### `profile_resolved`

Payload:

- resolved profile event
- includes selected profile and app-context summary

### `action_executed`

Payload:

- execution result
- includes action type, outcome, timing, and warning/error metadata if relevant

### `runtime_error`

Payload:

- structured runtime error
- includes category, message, and optional resolution context

### `config_reloaded`

Payload:

- config summary
- validation warnings if any

## Recommended Transport Shapes

### Runtime State Summary

Recommended fields:

- `status`
- `startedAt`
- `captureBackend`
- `activeConfigVersion`

### Window Capture Result

Recommended fields:

- `hwnd`
- `exe`
- `title`
- `capturedAt`

### Structured Error

Recommended fields:

- `code`
- `category`
- `message`
- `details`
- `context`

### Validation Warning

Recommended fields:

- `code`
- `message`
- `path`
- `severity`

## Capability and Permission Baseline

Iteration 1 should keep permissions narrow and explicit.

Baseline guidance:

- enable only the core capabilities needed for the main window and tray workflow
- scope command access to the application windows that actually need it
- do not broadly enable plugins before they are required
- treat window-state and path/config access as explicit capability decisions

Planned capability-relevant concerns:

- main app window
- debug-facing event subscriptions
- config file path resolution
- optional window-state persistence

## Boundary Rules

- Frontend does not decide how encoded keys resolve to controls.
- Backend does not own UI presentation state such as selected panels or editor focus.
- Frontend may show unresolved or unverified state, but backend remains the source of truth for validation and runtime decisions.
- Commands should prefer domain-shaped payloads over raw form-state payloads.

## Versioning Rules

- Breaking command or event changes require explicit documentation updates.
- Config schema versioning and transport contract versioning are related but not identical.
- The transport layer may evolve without bumping config version if persisted data shape is unchanged.

## Known Open Points

- Whether debug log retrieval should remain command-based plus events, or later move to a stronger streaming model
- Whether the transport should eventually expose smaller mutation commands in addition to document-oriented saves
- Final capability file layout if more windows or plugins are introduced
