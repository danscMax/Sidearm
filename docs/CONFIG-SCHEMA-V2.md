# Config Schema V2

- Status: Working draft aligned with accepted ADRs
- Date: 2026-03-07
- Canonical file name: `config.json`
- Canonical schema file: `schemas/config.v2.schema.json`

## Purpose

Config v2 defines the persisted state for Naga Workflow Studio iteration 1.

It is designed to support:

- the full physical control model from day one
- separation of hardware encoding, logical bindings, and action execution
- app-aware profile resolution
- reusable actions and snippets
- schema evolution through versioned JSON and explicit migrations

## Storage Rules

- Config is stored as JSON, not INI.
- Config lives in the application config directory resolved through Tauri path APIs.
- Writes must be atomic.
- The application must keep a last-known-good backup before replacing the active file.
- JSON Schema validates structure, but the application must also perform referential and semantic validation.

## JSON Schema Baseline

- Draft: JSON Schema 2020-12
- Object policy: strict-by-default, with `additionalProperties: false`
- Union policy: discriminated unions for `Action.payload` and menu items
- Leaf extensibility: only a small number of leaf tokens stay intentionally open in v2:
  - `settings.theme`
  - `bindings[].colorTag`
  - `encoderMappings[].encodedKey`
  - normalized key strings inside shortcut payloads

## Persisted Versus Non-Persisted State

Config v2 stores persisted operator data only.

It does not store:

- transient runtime debug logs
- raw discovery capture sessions
- window geometry and other plugin-managed window state
- temporary editor selections
- background service state

Those concerns may use separate files or plugin storage later, but are not part of `config.json`.

## Top-Level Shape

```json
{
  "version": 2,
  "settings": {},
  "profiles": [],
  "physicalControls": [],
  "encoderMappings": [],
  "appMappings": [],
  "bindings": [],
  "actions": [],
  "snippetLibrary": []
}
```

## ID Strategy

Config v2 uses hybrid IDs.

- `controlId` is a closed, device-specific enum such as `thumb_01` or `wheel_left`.
- `profileId` is a stable human-readable slug such as `default`, `main`, or `code`.
- `bindingId`, `actionId`, `appMappingId`, and `snippetId` are stable strings, but do not need to mirror display labels.
- Display names belong in `name`, `label`, or `pretty`, not in identity fields.

Recommended slug style for non-control IDs:

- lowercase
- ASCII
- kebab-case

## Entity Summary

### `settings`

Persisted application settings.

Required fields:

- `fallbackProfileId`
- `theme`
- `startWithWindows`
- `minimizeToTray`
- `debugLogging`

### `profiles`

Defines logical profile scopes.

Required fields:

- `id`
- `name`
- `enabled`
- `priority`

Optional fields:

- `description`

### `physicalControls`

Defines the full known device control catalog.

Required fields:

- `id`
- `family`
- `defaultName`
- `remappable`
- `capabilityStatus`

Optional fields:

- `synapseName`
- `notes`

`physicalControls` includes full-device entries from the beginning, even when some controls start as `needsValidation`.

### `encoderMappings`

Maps a physical control and layer to a Synapse-encoded key event.

Required fields:

- `controlId`
- `layer`
- `encodedKey`
- `source`
- `verified`

### `appMappings`

Maps a foreground application context to a profile.

Required fields:

- `id`
- `exe`
- `profileId`
- `enabled`
- `priority`

Optional fields:

- `titleIncludes`

If `titleIncludes` is present, it must contain at least one non-empty string.

Match semantics:

- `titleIncludes` is conjunctive in v2
- every listed substring must be present in the normalized window title for the mapping to match
- comparisons should be case-insensitive

Match resolution rule:

1. higher `priority` wins
2. for equal `priority`, a mapping with `titleIncludes` is more specific than one without
3. for equal `priority`, a mapping with more `titleIncludes` entries is more specific
4. if mappings are still tied, the application should warn and use stable lexical `id` ordering for deterministic behavior

### `bindings`

Binds a profile, control, and layer to a reusable action.

Required fields:

- `id`
- `profileId`
- `layer`
- `controlId`
- `label`
- `actionRef`
- `enabled`

Optional fields:

- `colorTag`

Bindings remain normalized. They do not inline action payloads.

### `actions`

Reusable action definitions.

Required fields:

- `id`
- `type`
- `payload`
- `pretty`

Optional fields:

- `notes`

Supported `type` values in v2:

- `shortcut`
- `textSnippet`
- `sequence`
- `launch`
- `menu`
- `disabled`

### `snippetLibrary`

Reusable text snippets for `textSnippet` actions.

Required fields:

- `id`
- `name`
- `text`
- `pasteMode`
- `tags`

Snippet library entries must store non-empty text.

Optional fields:

- `notes`

## Action Payload Rules

### `shortcut`

Payload fields:

- `key`
- `ctrl`
- `shift`
- `alt`
- `win`

Optional:

- `raw`

### `textSnippet`

Payload is a discriminated union:

- inline text payload
- library reference payload

Inline text payload fields:

- `source = "inline"`
- `text`
- `pasteMode`
- `tags`

Inline snippet text must be non-empty.

Library reference payload fields:

- `source = "libraryRef"`
- `snippetId`

### `sequence`

Payload contains ordered `steps`.

Supported step types:

- `send`
- `text`
- `sleep`
- `launch`

### `launch`

Payload fields:

- `target`
- `args`
- `workingDir`

Only explicit launch targets are allowed. Arbitrary shell execution is not part of v2.

### `menu`

Payload contains `items`.

Menu items are a discriminated union:

- `action` item: references an existing action
- `submenu` item: contains nested `items`

Cycles and self-references are application-level validation concerns.

### `disabled`

Payload is an empty object.

## Validation Outside JSON Schema

The application must validate rules that JSON Schema does not express well by itself:

- `settings.fallbackProfileId` must reference an existing profile
- all entity IDs must be unique within their collections
- `profileId`, `actionRef`, `snippetId`, and `controlId` references must resolve
- no duplicate `Binding(profileId, controlId, layer)` combinations
- no duplicate `EncoderMapping(controlId, layer)` combinations
- menu graphs must not contain cycles
- a disabled profile should not be the effective fallback profile
- `appMappings` with identical effective precedence should emit warnings

## Migration Guidance from Legacy AHK

- `Default`, `Main`, `Code`, and other legacy profile names should migrate to stable slug IDs while keeping display names.
- AHK side-grid slots must migrate to `controlId` values such as `thumb_01`.
- AHK action strings should migrate to typed action payloads.
- Legacy INI files map into this schema as described in `docs/MIGRATION-NOTES-AHK.md`.

## Deliberate Validation Debt in V2

Config v2 intentionally allows unresolved-but-modeled controls to exist in `physicalControls`.

This supports the chosen hybrid discovery flow for:

- temporary control names
- uncertain top-panel behavior
- wheel behavior that still needs device verification
- Hypershift modeling edge cases

The model remains complete even before every control becomes `verified`.
