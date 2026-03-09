# Migration Notes from the Legacy AutoHotkey Prototype

- Source file: `Razer.ahk`
- Date captured: 2026-03-07
- Purpose: preserve working behavior and constraints without turning the legacy script into the target architecture

## Current Legacy Shape

The current prototype is a single AutoHotkey v2 script with local INI-backed storage and an integrated GUI.

### Config Storage

The script stores state in three INI files under `config/`:

- `actions.ini`
- `apps.ini`
- `settings.ini`

This is useful as migration input, but not as the target persistence model.

### Encoded Input Model

The script currently registers:

- `F13` through `F24` for the standard side-grid layer
- `Ctrl + Alt + Shift + F13` through `Ctrl + Alt + Shift + F24` for the Hypershift side-grid layer

This matches the intended thumb-grid namespace and is the strongest legacy seed input for iteration 1.

### Profile Resolution

The script resolves the active profile by:

1. checking a manual override
2. reading the foreground window process executable
3. mapping that executable through `apps.ini`
4. falling back to the configured default profile

This behavior should be preserved conceptually, then extended with title filters and enable flags in the new model.

### Supported Action Types

The legacy script already distinguishes:

- `Shortcut`
- `Text snippet`
- `Launch`
- `Sequence`
- `Menu`
- `Disabled`

These categories map cleanly to the target `Action.type` set, although payload normalization still needs design work.

### Current GUI Coverage

The legacy GUI already includes:

- profile selection
- a two-layer side-grid editor
- app mappings
- an all-actions table
- a debug tab

This is valuable as behavior reference, but it is still slot-oriented and does not model the full device surface.

## Migration Implications

### Preserve

- seed profiles already used in practice
- seed bindings for `Main` and `Code`
- the fallback profile behavior
- the clipboard-restore option used for text snippets
- the debug concept of logging the active window and resolved profile

### Change

- move from side-grid slots to stable `controlId` values such as `thumb_01`
- separate `EncoderMapping` from `Binding`
- move from INI to versioned JSON
- move from raw AutoHotkey shortcut strings to structured shortcut payloads
- expand from the thumb grid to the full physical control model
- add verification status for controls and mappings

### Add

- top-panel and wheel controls in the model and UI
- title filters in app mappings
- schema validation, migrations, atomic save, and recovery behavior
- a discovery/setup flow for ambiguous controls

## Data Conversion Candidates

### `actions.ini`

Can become a combination of:

- `profiles`
- `bindings`
- `actions`

### `apps.ini`

Can become:

- `appMappings`

### `settings.ini`

Can become:

- `settings`

## Known Legacy Gaps

- No explicit model for top-panel controls, wheel controls, or verification status.
- No typed JSON schema or migration layer.
- No separate encoder-mapping table.
- No title-based application matching.
- No full-device visual model.

## Known Ambiguities to Carry Forward

- `Paste Win` is currently represented as `Win + V`, but the intended user meaning still needs confirmation.
- Some Hypershift seed actions are placeholders rather than verified final payloads.
- Right-side modifier semantics are not modeled explicitly in the current shortcut representation.
- Top-panel and wheel observations exist in the specification but not in the current script.

## Migration Strategy Implication

The legacy AutoHotkey script should be treated as a behavior reference and seed-data source, not as a runtime foundation for the new application.

The preferred migration path is:

1. keep the script unchanged while the new architecture is designed
2. import or re-enter seed data into the new JSON v2 model
3. validate the full device model on hardware
4. retire the script only after the new runtime reaches feature parity for required workflows
