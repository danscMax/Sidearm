# Runtime Pipeline

- Status: Implemented baseline with remaining hardware-validation debt
- Date: 2026-03-08

## Purpose

This document describes the runtime behavior implemented for iteration 1 and the limits that still remain.

It clarifies:

- how encoded input enters the system
- how the runtime resolves controls and profiles
- how actions are executed
- where validation and failure reporting belong

## Core Separation

The runtime is built around three separate concerns:

1. hardware encoding
2. logical binding resolution
3. action execution

Those concerns must remain separate in code and persisted state.

## High-Level Flow

1. Receive an encoded input event from the backend capture layer.
2. Normalize the incoming event into an internal encoded-key representation.
3. Resolve the event against `encoderMappings`.
4. Resolve `controlId + layer`.
5. Determine the active foreground application context.
6. Resolve the active profile through `appMappings`, override rules, and fallback behavior.
7. Resolve the binding for `(profileId, controlId, layer)`.
8. Resolve the referenced action.
9. Execute the action.
10. Emit structured debug and runtime events for visibility.

## Runtime Components

### Capture Backend

Responsibilities:

- receive encoded global input events
- translate backend-specific events into a normalized form
- isolate crate- or platform-specific behavior behind an abstraction

Non-responsibilities:

- profile resolution
- control resolution
- action execution

Current implementation note:

- iteration 1 now uses a Windows `RegisterHotKey` backend for validated `encoderMappings`
- the backend listens only for configured encoded keys rather than all keyboard traffic
- config reload rebuilds the registered hotkey set from the validated config

### Resolver

Responsibilities:

- map encoded input to `EncoderMapping`
- resolve `controlId + layer`
- apply app-aware profile selection
- resolve the effective binding and referenced action

### Action Executor

Responsibilities:

- execute supported action types safely
- emit result metadata
- distinguish expected user-facing failures from internal runtime errors

Current implementation note:

- iteration 1 keeps a `dryRun` executor for manual preview dispatch
- `execute_preview_action` validates and summarizes actions without side effects
- the live executor now supports `shortcut`, `launch`, `disabled`, `textSnippet`, and `sequence` actions composed of `send`, `sleep`, `text`, and `launch` steps
- live launch requires absolute existing target paths and does not invoke a shell
- live shortcut and `sendText` execution use Win32 `SendInput`
- `clipboardPaste` now stages text through the Windows clipboard, injects `Ctrl+V`, and restores the previous clipboard object when it remains safe to do so

## Normalized Event Model

The runtime should convert backend-specific input into a normalized event shape before resolution.

Recommended normalized fields:

- `encodedKey`
- `receivedAt`
- `backend`
- `isRepeat`
- optional backend diagnostics

This normalized event is runtime-internal state, not part of `config.json`.

## Encoder Mapping Resolution

Resolution rules:

1. Find a unique `encoderMappings` entry matching the normalized `encodedKey`.
2. If no mapping exists, emit an unresolved-input event and debug log entry.
3. If multiple mappings resolve to the same encoded key in active config, emit a runtime error and refuse ambiguous execution.
4. If the mapping exists but is unverified, the runtime may still resolve it, but the UI and debug log must make the validation state obvious.

Iteration 1 policy:

- unverified mappings are allowed in config
- ambiguous mappings are not allowed for execution

## Control and Layer Resolution

The runtime resolves:

- `controlId`
- `layer`

from the matched `EncoderMapping`, not from frontend assumptions and not from slot numbering.

This is a core consequence of the control-based model.

## Foreground Application Detection

The runtime determines the active application context from:

- the foreground window handle
- process executable name
- optional title text

Title filter semantics:

- app mapping `titleIncludes` entries are evaluated case-insensitively
- all listed entries must match for the mapping to remain eligible

The runtime should ignore:

- the Studio's own main window
- internal utility windows created by the application
- obvious development utility windows when configured to do so

Recommended normalized app-context fields:

- `hwnd`
- `exe`
- `title`
- `capturedAt`

## Profile Resolution

Profile selection order:

1. manual override profile, if enabled by future runtime/UI state
2. highest-precedence enabled `appMapping`
3. `settings.fallbackProfileId`

App-mapping selection uses the precedence rules defined in `docs/CONFIG-SCHEMA-V2.md`.

If the resolved profile is disabled or missing, the runtime should:

1. emit a warning
2. attempt safe fallback behavior
3. avoid silent failure

## Binding Resolution

The runtime resolves a binding using:

- `profileId`
- `controlId`
- `layer`

Rules:

- only enabled bindings are eligible
- the tuple `(profileId, controlId, layer)` must be unique after config validation
- if no binding exists, emit a no-binding debug event and stop cleanly

Iteration 1 fallback behavior:

- no implicit per-binding fallback to another profile unless a dedicated ADR introduces that behavior
- profile fallback happens at profile selection time, not during late binding lookup

This intentionally differs from the legacy AHK script, which opportunistically falls back to `Default` during action lookup.

## Action Resolution

The runtime resolves the `actionRef` from the binding into the normalized `actions` collection.

Rules:

- missing action references are configuration errors
- disabled actions are valid targets but result in a no-op execution outcome
- `pretty` is presentation metadata and must not drive behavior

## Action Execution Semantics

### `shortcut`

- send normalized key combinations
- prefer explicit input synthesis over stringly behavior where possible

### `textSnippet`

- support both inline and library-backed snippet sources
- use configured `pasteMode`
- preserve clipboard only when the chosen paste strategy requires it
- iteration 1 live execution supports both `sendText` and `clipboardPaste`

### `sequence`

- execute steps in order
- stop and report on malformed or unsafe steps
- treat timing as part of the payload, not hidden executor state
- iteration 1 live execution supports `send` when the step value parses as a supported hotkey string

### `launch`

- execute only explicit targets and arguments
- validate target existence and policy before launch where practical
- do not expand into arbitrary shell execution

### `menu`

- resolve nested items lazily at display time or dispatch time
- reject cyclic graphs at validation time

### `disabled`

- perform no action
- still emit a clean execution result when useful for debugging

## Error Model

The runtime should classify failures into at least these categories:

- unresolved input
- ambiguous mapping
- app detection failure
- missing profile
- missing binding
- missing action
- validation warning
- execution failure
- internal runtime error

Expected resolution misses should not be treated as crashes.

## Observability

The runtime should emit structured events and logs for:

- encoded key received
- control resolved
- profile resolved
- action execution started
- action execution completed
- runtime warning or error

The debug view should show the resolution chain, not just the final action.

## Concurrency and Lifecycle Notes

- The runtime should be startable, stoppable, and reloadable without restarting the whole desktop shell.
- Config reload should replace runtime state atomically from the runtime's point of view.
- Long-running work should not block the UI thread.
- Background execution should use explicit task boundaries rather than implicit shared mutable state.

## Known Open Points

- on-device verification for top-panel, wheel, and ambiguous Hypershift controls
- behavior in elevated or protected windows where `SendInput` and clipboard flows may be limited by UIPI
- how much execution telemetry should remain transient versus later persisted for troubleshooting
