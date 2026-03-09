# ADR-0004: Use a Hybrid Device Discovery and Verification Flow

- Status: Accepted
- Date: 2026-03-07

## Context

The specification requires support for the full control surface of the Razer Naga V2 HyperSpeed, including controls whose exact Windows and Synapse behavior is not yet fully validated. Some current observations come from screenshots and a working legacy setup, but not every top-panel, wheel, or Hypershift detail is confirmed on-device.

The system also depends on a strict separation:

1. Synapse encodes physical controls into unique keyboard events.
2. The runtime resolves encoded events into `controlId + layer`.
3. The runtime resolves bindings and executes actions.

That separation is only reliable if the actual device behavior is verified instead of assumed.

## Decision Drivers

- Avoid false confidence about device behavior.
- Keep iteration 1 compatible with incomplete hardware validation.
- Preserve the encoder-mapping boundary between Synapse and the runtime.
- Make setup recoverable when a control behaves unexpectedly.
- Support debugability from encoded event to executed action.

## Considered Options

### Option 1: Auto-detect device behavior as much as possible

- Pros: attractive onboarding if it works
- Cons: device and Windows behavior may not expose enough trustworthy signal, high risk of incorrect assumptions

### Option 2: Require fully manual mapping with no seed knowledge

- Pros: simple implementation, no false automation claims
- Cons: poor onboarding, misses useful seed knowledge already available from the specification and the working setup

### Option 3: Use a hybrid discovery and verification flow

- Pros: balances usability and correctness, keeps uncertainty visible, allows progressive validation
- Cons: requires a dedicated setup and verification UX

## Decision

The project will use a hybrid discovery model:

- Start with a seeded control catalog and seeded encoder mapping recommendations from the specification.
- Treat those seeds as defaults and hypotheses, not as universal truth.
- Require explicit verification for controls whose behavior is ambiguous or device-dependent.
- Track capability state per physical control using:
  - `verified`
  - `needsValidation`
  - `reserved`
  - `partiallyRemappable`

Iteration 1 discovery flow will include:

- a device setup view that explains the expected Synapse encoding namespaces
- manual verification of emitted encoded keys
- a debug log that shows `encoded key -> control -> layer -> profile -> action`
- the ability to keep unresolved controls in the model without pretending they are safe to use

Controls such as `top_aux_*`, `top_special_*`, `hypershift_button`, and any control with uncertain remap behavior will begin in a validation-aware state until verified on the target device.

## Consequences

- The model remains honest about what is known versus what is assumed.
- First-run setup will be more involved than a purely automatic approach.
- The UI must expose verification status and troubleshooting information early.
- Device validation becomes a first-class project activity rather than an afterthought.

## Validation Debt

The following items remain explicitly unresolved until verified on hardware:

- exact semantics for ambiguous top controls and temporary names
- exact modeling of the Hypershift button in the encoder matrix
- whether `mouse_left` should be modeled as remappable or reserved-only
- the precise meaning of ambiguous seed bindings such as `Paste Win`
- any control where Windows or Synapse emits duplicate or unstable behavior

## Follow-Up

- Design a device discovery/setup wizard.
- Define what evidence marks an `EncoderMapping` as verified.
- Add a backend ADR for hotkey event capture abstraction on Windows.

## References

- Razer support, remapping buttons on Razer Naga V2 mice: https://mysupport.razer.com/app/answers/detail/a_id/6400/~/how-to-remap-keys-or-buttons-on-your-razer-naga-v2-mouse
- Tauri global shortcut plugin: https://v2.tauri.app/plugin/global-shortcut/
