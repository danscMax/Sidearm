# ADR-0002: Use Tauri v2, React, and an In-Process Rust Runtime

- Status: Accepted
- Date: 2026-03-07

## Context

The target system is a Windows desktop application for configuring and executing context-aware actions for a Razer Naga V2 HyperSpeed. The application needs:

- a native desktop shell with tray support and window lifecycle management
- a long-lived runtime engine that resolves encoded input events to actions
- a maintainable GUI for profiles, device visualization, editors, mappings, and debug tooling
- explicit security boundaries for plugins and host capabilities

The specification already prefers Tauri v2, Rust stable, and either React or Svelte with Vite. The chosen frontend stack still needs to be fixed for the repository.

## Decision Drivers

- Tight integration with a Rust runtime.
- Lower overhead than a Chromium-heavy shell-first architecture.
- Clear capability and permission boundaries.
- Strong fit for a desktop configurator with tray, window state, commands, and events.
- A frontend stack with a broad ecosystem for complex editors and stateful tooling.
- Avoid making sidecars mandatory before there is evidence they are needed.

## Considered Options

### Option 1: Continue with AutoHotkey as the primary runtime and GUI

- Pros: already working, no bootstrap cost
- Cons: does not match the target architecture, limited long-term maintainability, weak fit for the desired domain model and UI

### Option 2: Use an Electron-style architecture

- Pros: broad frontend ecosystem, many examples
- Cons: weaker alignment with a Rust runtime-first design, heavier desktop footprint, unnecessary duplication of logic across process boundaries

### Option 3: Use Tauri v2 with an in-process Rust runtime and a TypeScript frontend

- Pros: strong Rust integration, plugin model, capability-based permissions, good fit for the desired desktop shell
- Cons: Windows build prerequisites matter, command/event boundaries still need careful design

### Option 4: Use Tauri v2 but require a sidecar from iteration 1

- Pros: clearer crash isolation and daemon separation
- Cons: adds lifecycle and packaging complexity before there is evidence it is needed

## Decision

The project will use:

- Tauri v2 as the desktop shell
- Rust stable for the application core and runtime engine
- React + TypeScript + Vite for the frontend
- a single in-process runtime as the default architecture

Sidecars are explicitly deferred. They remain an allowed future option, but are not part of iteration 1. Introducing a sidecar later requires a separate ADR that demonstrates a concrete need such as:

- crash isolation
- a background daemon with an independent lifecycle
- a meaningful privilege or trust boundary

The application will prefer a minimal plugin surface and explicit capability permissions instead of enabling broad defaults.

## Consequences

- The architecture stays aligned with the specification and current Tauri guidance.
- Rust owns the domain model, runtime resolution, configuration, app detection, and execution engine.
- The frontend remains focused on visualization, editing, and operator feedback.
- Windows build prerequisites become part of the project reality; local builds depend on the Rust and MSVC toolchain being correctly installed.
- Sidecar complexity is avoided until justified by evidence.

## Follow-Up

- Add an ADR for hotkey backend abstraction once backend comparison work begins.
- Add an ADR for sidecars only if a real requirement emerges.
- Keep plugin permissions narrow as commands and plugins are introduced.

## References

- Tauri architecture: https://v2.tauri.app/concept/architecture/
- Tauri create project: https://v2.tauri.app/start/create-project/
- Tauri prerequisites: https://v2.tauri.app/start/prerequisites/
- Tauri plugins: https://v2.tauri.app/develop/plugins/
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
- React 19 announcement: https://react.dev/blog/2024/12/05/react-19
