# ADR-0003: Use a Control-Based Domain Model and Versioned JSON Config

- Status: Accepted
- Date: 2026-03-07

## Context

The target application must support:

- the 12-button thumb grid
- top-panel controls
- wheel click and tilt controls
- a Hypershift layer
- app-aware profile resolution
- multiple action types such as shortcuts, snippets, sequences, launch actions, and menus

The legacy AutoHotkey implementation is slot-oriented for the side grid and stores settings across multiple INI files. That shape is insufficient for the target system because it mixes runtime behavior with a partial device model and does not scale cleanly to the full control surface.

## Decision Drivers

- Separate hardware encoding from logical bindings and action execution.
- Model the physical device explicitly rather than inferring it from side-grid slots.
- Keep encoder mappings independent from per-profile bindings.
- Support validation states for controls that are not fully confirmed yet.
- Use a storage format that supports schema evolution, migrations, backups, and typed loading.

## Considered Options

### Option 1: Keep a slot-oriented model and INI-based storage

- Pros: close to the current AutoHotkey implementation, simple to inspect manually
- Cons: does not represent the full hardware surface, mixes concerns, weak migration story, awkward for nested and typed payloads

### Option 2: Use a control-based domain model with a versioned JSON config

- Pros: explicit and extensible, strong fit for typed payloads, better migrations, clean separation of encoder mappings and bindings
- Cons: more upfront modeling work, migration tooling is required later

### Option 3: Store encoder mappings directly inside bindings

- Pros: fewer top-level collections
- Cons: duplicates hardware encoding data across profiles, weak separation of concerns, harder conflict analysis

## Decision

The project will adopt a control-based domain model centered on the following entities:

- `Profile`
- `PhysicalControl`
- `EncoderMapping`
- `AppMapping`
- `Binding`
- `Action`
- `snippetLibrary`

Core rules:

- Physical controls are identified by stable `controlId` values.
- Bindings are defined against `profileId + controlId + layer`.
- Encoder mappings are stored separately from bindings.
- UI-facing shortcut display is human-readable, while stored shortcut payloads are normalized and typed.
- Top-panel and wheel controls belong in the model from day one, even if some start in `needsValidation`.

Configuration will be stored as a versioned JSON document in the application config directory, with:

- schema versioning
- typed serde loading
- migrations between versions
- atomic writes
- backup of the last known good config
- validation before activation

The initial schema target is the v2 shape described in the specification, with explicit collections for profiles, controls, encoder mappings, app mappings, bindings, actions, and snippet data.

## Consequences

- The model is ready for the full device surface rather than only the thumb grid.
- Runtime logic can resolve encoded events without conflating device topology and user bindings.
- Migration from legacy INI data becomes an explicit task instead of an implicit assumption.
- The config shape is more verbose than INI, but substantially safer and more extensible.
- Some controls will exist in the config before they are fully verified on the physical device.

## Follow-Up

- Define JSON schema v2 and serde models.
- Define migration rules from legacy INI storage.
- Decide how backups, recovery mode, and validation errors are surfaced in the UI.

## References

- Tauri configuration files: https://v2.tauri.app/develop/configuration-files/
- Tauri architecture: https://v2.tauri.app/concept/architecture/
