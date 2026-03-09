# Device Verification Matrix

- Status: Working draft aligned with ADR-0004
- Date: 2026-03-07
- Device target: Razer Naga V2 HyperSpeed

## Purpose

This document defines what must be verified on hardware before a control or mapping can be treated as trusted.

It is not a runtime log. It is a validation plan and evidence checklist for:

- control identity
- layer behavior
- encoded key behavior
- remap safety
- divergence between observed, expected, and actual device behavior

## Verification Principles

- Seeded mappings are hypotheses until confirmed on the actual device.
- Validation must focus on emitted encoded events, not only on what Synapse visually shows.
- The system should prefer conservative status changes over optimistic assumptions.
- A mapping can be present in config while still remaining unverified.

## Namespace Strategy

The preferred namespace plan for iteration 1 is:

| Namespace | Intended use | Status |
| :-- | :-- | :-- |
| `F13` to `F24` | Thumb grid, standard layer | Seeded and strongly supported by the current setup |
| `Ctrl + Alt + Shift + F13` to `F24` | Thumb grid, Hypershift layer | Seeded and strongly supported by the current setup |
| `Ctrl + F13` to `F24` | Top-panel and wheel controls, standard layer | Planned, requires device verification |
| `Ctrl + Shift + F13` to `F24` | Top-panel and wheel controls, Hypershift layer | Planned, requires device verification |
| `Alt + F13` to `F24` | Reserved future namespace | Reserved |
| `Win + F13` to `F24` | Reserved future namespace | Reserved |

## Verification States

### Mapping Verified

A mapping may be treated as verified when all of the following are true:

- the physical control pressed is unambiguous
- the layer context is known
- the expected encoded key is observed
- no unexpected duplicate or conflicting native behavior remains
- the result is reproducible

### Mapping Needs Validation

Any of the following keeps a mapping unverified:

- control naming is provisional
- emitted key differs from expectation
- native behavior leaks through unexpectedly
- the event is intermittent or duplicated
- the layer cannot be resolved confidently

## Per-Control Validation Matrix

| controlId | standard expected | hypershift expected | current confidence | Validation focus |
| :-- | :-- | :-- | :-- | :-- |
| `thumb_01` | `F13` | `Ctrl+Alt+Shift+F13` | strong | Confirm reproducibility against current working setup. |
| `thumb_02` | `F14` | `Ctrl+Alt+Shift+F14` | strong | Confirm reproducibility against current working setup. |
| `thumb_03` | `F15` | `Ctrl+Alt+Shift+F15` | strong | Confirm reproducibility against current working setup. |
| `thumb_04` | `F16` | `Ctrl+Alt+Shift+F16` | strong | Confirm reproducibility against current working setup. |
| `thumb_05` | `F17` | `Ctrl+Alt+Shift+F17` | strong | Confirm reproducibility against current working setup. |
| `thumb_06` | `F18` | `Ctrl+Alt+Shift+F18` | strong | Confirm reproducibility against current working setup. |
| `thumb_07` | `F19` | `Ctrl+Alt+Shift+F19` | strong | Confirm reproducibility against current working setup. |
| `thumb_08` | `F20` | `Ctrl+Alt+Shift+F20` | strong | Confirm reproducibility against current working setup. |
| `thumb_09` | `F21` | `Ctrl+Alt+Shift+F21` | strong | Confirm reproducibility against current working setup. |
| `thumb_10` | `F22` | `Ctrl+Alt+Shift+F22` | strong | Confirm reproducibility against current working setup. |
| `thumb_11` | `F23` | `Ctrl+Alt+Shift+F23` | strong | Confirm reproducibility against current working setup. |
| `thumb_12` | `F24` | `Ctrl+Alt+Shift+F24` | strong | Confirm reproducibility against current working setup. |
| `mouse_left` | native left click or reserved | TBD | low | Decide whether this control stays reserved regardless of technical remapability. |
| `mouse_right` | observed right click or encoded remap | observed right click or encoded remap | low | Confirm whether it can participate safely in the chosen encoding workflow. |
| `top_aux_01` | planned `Ctrl+F13` family slot | planned `Ctrl+Shift+F13` family slot | low | Identify exact hardware name and emitted key. |
| `top_aux_02` | planned `Ctrl+F14` family slot | planned `Ctrl+Shift+F14` family slot | low | Identify exact hardware name and emitted key. |
| `mouse_4` | planned `Ctrl+F15` family slot | planned `Ctrl+Shift+F15` family slot | low | Confirm behavior under Synapse remap and collision risk with native button semantics. |
| `mouse_5` | planned `Ctrl+F16` family slot | planned `Ctrl+Shift+F16` family slot | low | Confirm behavior under Synapse remap and collision risk with native button semantics. |
| `wheel_up` | planned `Ctrl+F17` family slot | planned `Ctrl+Shift+F17` family slot | low | Check whether native scrolling is suppressed, duplicated, or partially retained. |
| `wheel_down` | planned `Ctrl+F18` family slot | planned `Ctrl+Shift+F18` family slot | low | Check whether native scrolling is suppressed, duplicated, or partially retained. |
| `wheel_click` | planned `Ctrl+F19` family slot | planned `Ctrl+Shift+F19` family slot | low | Confirm click remap behavior and event stability. |
| `wheel_left` | planned `Ctrl+F20` family slot | planned `Ctrl+Shift+F20` family slot | low | Confirm exact hardware semantics and emitted key. |
| `wheel_right` | planned `Ctrl+F21` family slot | planned `Ctrl+Shift+F21` family slot | low | Confirm exact hardware semantics and emitted key. |
| `hypershift_button` | special system behavior | special system behavior | low | Determine whether this is modeled as a pressable control, a layer modifier, or both. |
| `top_special_01` | planned `Ctrl+F22` family slot | planned `Ctrl+Shift+F22` family slot | low | Replace temporary name with verified hardware identity. |
| `top_special_02` | planned `Ctrl+F23` family slot | planned `Ctrl+Shift+F23` family slot | low | Replace temporary name with verified hardware identity. |
| `top_special_03` | planned `Ctrl+F24` family slot | planned `Ctrl+Shift+F24` family slot | low | Replace temporary name with verified hardware identity. |

## Required Evidence Per Validation Session

Each validation session should record:

- date
- device firmware/software context if relevant
- Synapse assignment used for the control
- physical control tested
- layer tested
- expected encoded key
- actual encoded key
- whether native behavior also occurred
- whether the result was reproducible
- resulting status change, if any

## Promotion Rules

### Promote to `verified`

Use when:

- naming is confirmed
- encoded output is stable
- no problematic duplicate behavior remains
- the control is considered safe for supported workflows

### Keep as `needsValidation`

Use when:

- the key assignment is plausible but not yet trusted
- naming remains temporary
- behavior is not consistently reproducible

### Downgrade to `partiallyRemappable`

Use when:

- the control can be remapped, but native behavior leaks through
- suppression behavior is inconsistent
- only some layers or apps behave correctly

### Mark as `reserved`

Use when:

- policy decides not to support remapping
- remapping is technically possible but too risky for reliable iteration 1 behavior

## Runtime and UI Implications

- Runtime must not assume that every modeled control already has a trusted encoder mapping.
- Discovery UI should show seeded expectations and actual observed results side by side.
- Debug output should make it obvious when a control exists in the catalog but lacks a verified encoder mapping.

## Known Open Questions

- Is `hypershift_button` better modeled as an independently bindable control, a pure modifier concept, or a hybrid of both?
- Which top-panel controls are truly distinct hardware identities versus temporary observation labels?
- Which wheel operations remain practical in the presence of native scroll semantics?
