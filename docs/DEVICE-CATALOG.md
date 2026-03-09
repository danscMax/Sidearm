# Device Catalog

- Status: Working draft aligned with ADR-0004 and config schema v2
- Date: 2026-03-07
- Device target: Razer Naga V2 HyperSpeed

## Purpose

This document defines the persisted control catalog for iteration 1.

It exists to:

- provide the canonical `controlId` inventory
- separate stable control identity from temporary display naming
- record validation debt explicitly
- drive both runtime resolution and device visualization

## Modeling Rules

- `controlId` is the stable identity and must not be renamed casually.
- `defaultName` is the preferred UI-facing baseline label.
- `synapseName` is optional because some observed control names are temporary or inferred.
- `family` is structural and stable.
- `capabilityStatus` expresses current confidence and remap safety.
- `remappable` means "expected to be meaningfully assignable through the supported workflow", not "guaranteed under all Windows/Synapse conditions".

## Capability Status Semantics

### `verified`

The control identity and expected encoded behavior have been confirmed on the target device.

### `needsValidation`

The control is part of the supported model, but its exact behavior still needs hardware confirmation.

### `reserved`

The control exists in the model, but iteration 1 should treat it as policy-reserved or not safely remappable.

### `partiallyRemappable`

The control appears remappable in some form, but behavior may be duplicated, unstable, or constrained.

## Canonical Control Inventory

| controlId | family | defaultName | synapseName | remappable | capabilityStatus | Notes |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `thumb_01` | `thumbGrid` | Thumb 1 | Button 1 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_02` | `thumbGrid` | Thumb 2 | Button 2 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_03` | `thumbGrid` | Thumb 3 | Button 3 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_04` | `thumbGrid` | Thumb 4 | Button 4 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_05` | `thumbGrid` | Thumb 5 | Button 5 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_06` | `thumbGrid` | Thumb 6 | Button 6 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_07` | `thumbGrid` | Thumb 7 | Button 7 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_08` | `thumbGrid` | Thumb 8 | Button 8 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_09` | `thumbGrid` | Thumb 9 | Button 9 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_10` | `thumbGrid` | Thumb 10 | Button 10 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_11` | `thumbGrid` | Thumb 11 | Button 11 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `thumb_12` | `thumbGrid` | Thumb 12 | Button 12 | `true` | `verified` | Seeded from working side-grid mapping model. |
| `mouse_left` | `topPanel` | Left Click | Щелчок левой кнопкой | `false` | `reserved` | Present in the model; remap policy unresolved and intentionally conservative in iteration 1. |
| `top_aux_01` | `topPanel` | DPI Up | Увеличение чувствительности | `true` | `needsValidation` | Confirmed in Synapse UI as DPI sensitivity control. |
| `top_aux_02` | `topPanel` | DPI Down | Уменьшение чувствительности | `true` | `needsValidation` | Confirmed in Synapse UI as DPI sensitivity control. |
| `mouse_4` | `topPanel` | Mouse 4 | Кнопка мыши 4 | `true` | `needsValidation` | Confirmed in Synapse UI. |
| `mouse_5` | `topPanel` | Mouse 5 | Кнопка мыши 5 | `true` | `needsValidation` | Confirmed in Synapse UI. |
| `wheel_up` | `wheel` | Wheel Up | Прокрутка вверх | `true` | `partiallyRemappable` | Wheel behavior can be constrained by OS/device semantics and may require special handling. |
| `wheel_down` | `wheel` | Wheel Down | Прокрутка вниз | `true` | `partiallyRemappable` | Wheel behavior can be constrained by OS/device semantics and may require special handling. |
| `wheel_click` | `wheel` | Wheel Click | Щелчок колесом прокрутки | `true` | `needsValidation` | Click behavior is modeled, but encoded mapping still needs confirmation in the target workflow. |
| `hypershift_button` | `system` | Hypershift Button | Razer Hypershift | `true` | `needsValidation` | Critical system control; exact encoder-model semantics remain unresolved. |

## Family Notes

### `thumbGrid`

- The thumb grid is the most mature part of the current model.
- Iteration 1 assumes full support for standard and Hypershift layers.
- Existing AHK seeds provide the strongest migration input for these controls.

### `topPanel`

- The top panel is modeled from iteration 1 even where exact names remain provisional.
- Discovery UI must expose temporary names and validation status clearly.
- Policy may keep some controls reserved even if they prove technically remappable.

### `wheel`

- Wheel controls should be treated carefully because scrolling behavior can collide with native OS expectations.
- Verification should confirm whether encoded mappings fully suppress or coexist with native wheel semantics.

### `system`

- `hypershift_button` is modeled as a first-class control, not a hidden implementation detail.
- The exact resolution strategy for Hypershift still depends on device validation.

## UI Implications

- The device view must show all controls in one model, not only the thumb grid.
- Controls with `needsValidation`, `reserved`, or `partiallyRemappable` need visible status treatment.
- Temporary hardware names must not leak into the UI as if they were final truth.

## Persistence Implications

- Every row in this catalog should correspond to a `physicalControls[]` entry in config v2.
- The `controlId` set here must remain in sync with `schemas/config.v2.schema.json`.
- If a control name improves later, update `defaultName` or `synapseName`, but preserve `controlId`.

## Known Catalog Debt

- Final remap policy for `mouse_left`
- Exact semantic role of `hypershift_button` inside the encoder-resolution pipeline
- Final remap confidence for wheel-related controls
- Removed controls not present in Synapse: `mouse_right`, `wheel_left`, `wheel_right`, `top_special_01/02/03`
