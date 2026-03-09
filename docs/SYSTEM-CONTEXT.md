# System Context

- Date: 2026-03-07
- Scope: inception context for iteration 1

## Purpose

Naga Workflow Studio is a Windows desktop application that turns Synapse-encoded mouse input into profile-aware actions resolved by a Rust runtime and edited through a desktop GUI.

The system exists to replace the current AutoHotkey-based setup with a maintainable architecture that supports the full physical control model of the Razer Naga V2 HyperSpeed.

## Primary Components

### 1. Razer Synapse

- Owns low-level hardware encoding.
- Assigns unique keyboard events to physical controls.
- Is not the source of profile logic, action logic, or conflict resolution.

### 2. Tauri Desktop Shell

- Owns windows, tray behavior, lifecycle, command/event transport, and plugin host duties.
- Hosts the frontend and Rust core inside one desktop application.

### 3. Rust Application Core

- Owns the domain model.
- Loads, validates, migrates, and saves config.
- Detects the active application and window context.
- Resolves encoded keys into `controlId + layer`.
- Resolves profile bindings.
- Executes actions.
- Emits structured debug and runtime events.

### 4. React Frontend

- Owns profile editing, device visualization, action editors, mappings UI, snippet library UI, and debug views.
- Uses commands to request state and events to observe runtime changes.

### 5. Windows Platform Services

- Foreground window and process inspection.
- Global hotkey or equivalent encoded input capture.
- Launch and clipboard integration used by explicit action types.

## Runtime Flow

1. A physical mouse control is encoded in Synapse as a unique keyboard event.
2. The runtime receives the encoded event through a backend abstraction.
3. The runtime resolves the event to an `EncoderMapping`.
4. The runtime resolves `controlId + layer`.
5. The runtime inspects the active foreground application and optional title filters.
6. The runtime chooses the active profile.
7. The runtime resolves the matching binding.
8. The runtime executes the referenced action and logs the result.

## System Boundaries

### Inside the System

- profile resolution
- control and encoder mapping resolution
- config persistence and migrations
- action execution rules
- discovery and verification flow
- operator-facing GUI and debug output

### Outside the System

- physical device firmware behavior
- Synapse remap mechanics
- Windows key dispatch semantics
- behavior of launched third-party applications

## Trust and Safety Boundaries

- Synapse is trusted only as a hardware encoder, not as the owner of business logic.
- Only explicit action types may execute side effects.
- Arbitrary shell execution is out of scope unless introduced as a dedicated action type and ADR-backed security decision.
- Config writes must be atomic and recoverable.
- Plugin capabilities and permissions should remain minimal and explicit.

## Iteration 1 Non-Goals

- replacing Synapse as the hardware encoder
- requiring a sidecar or background daemon
- full automatic discovery of all device behavior
- dark-theme parity and advanced visual polish beyond a solid desktop baseline
- preserving AutoHotkey as a long-term runtime

## Open Questions

- Which Windows hotkey backend is the most reliable on the target device?
- How should verification evidence be captured for encoder mappings?
- Which controls should remain reserved by policy even if technically remappable?
- What is the exact import strategy from legacy INI data into JSON v2?
