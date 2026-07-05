# Config Schema V3

- Status: Current
- Date: 2026-07-05
- Canonical file name: `config.json`
- Canonical schema file: `schemas/config.v3.schema.json`
- Base document: `docs/CONFIG-SCHEMA-V2.md` (v3 is v2 plus the delta below; all
  v2 rules not listed here still apply)

## Why v3

Sidearm supports any programmable input device, not only the Razer Naga. The
closed, Naga-specific `controlId` enum became an open token, and devices became
first-class persisted entities.

## Delta from v2

### `controlId` is open

- v2: closed 27-value enum (`thumb_01` … `top_special_03`).
- v3: any token matching `^[a-z0-9][a-z0-9_-]*$` (max 64 chars).
- Referential integrity moved from the schema into application validation
  (`validate_config` in `src-tauri/src/config.rs`):
  - every `bindings[].controlId`, `bindings[].chordPartner`,
    `encoderMappings[].controlId`, and `devices[].hotspots[].controlId` must
    exist in `physicalControls`
  - every `physicalControls[].deviceId` must reference a declared device

### New top-level entity: `devices`

```json
{
  "id": "razer-naga",
  "name": "Razer Naga V2 Hyperspeed",
  "builtin": true,
  "image": "photo.png",
  "hotspots": [{ "controlId": "thumb_01", "x": 25.0, "y": 75.5 }]
}
```

- `id`, `name` required; `builtin` defaults to false.
- `image` is a **bare file name** resolved inside the app-data devices
  directory (path separators and `..` are rejected) — used by user devices.
  The built-in Naga device renders through frontend-bundled photos instead.
- `hotspots` place controls on the image in percent (0..=100) of its size.
- At least one device must be declared.
- A config declaring the built-in Naga device (`razer-naga`) must contain all
  27 Naga controls in `physicalControls` — the v2 completeness invariant,
  scoped to that device.

### `physicalControls[].deviceId`

Each control is tagged with the device it belongs to. Optional in the schema
(defaults to `razer-naga` in serde) so v2 files stay valid.

### Version and migration

- `version` accepts `2` or `3` at the schema layer; `validate_config` requires
  the migrated in-memory config to be exactly `3`.
- A v2 file loads unchanged: `migrate_devices` seeds the built-in Naga device,
  serde defaults tag legacy controls with `razer-naga`, and the version is
  bumped to 3 on the next save. Bindings, encoder mappings, and actions are
  untouched.
- An app older than v3 refuses a v3 file (its v2 schema pins `version` to 2)
  and, per the newer-schema guard, never overwrites or "recovers" it.
