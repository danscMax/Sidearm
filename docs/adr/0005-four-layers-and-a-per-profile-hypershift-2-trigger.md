# ADR-0005: Four Layers and a Per-Profile HyperShift 2 Trigger

- Status: Accepted
- Date: 2026-11-11
- Shipped in: v0.12.0 (config schema version 7), refined in v0.12.1 and v0.12.2

## Context

Until v0.11.8 a profile had two layers per control: standard and HyperShift.
HyperShift had one trigger per mouse, the same in every profile: the software
trigger from `Settings.hypershiftTrigger`, or the V3 Pro's firmware button
under the ring finger.

The owner asked for:

- more layers than two, opened by holding other buttons;
- a held trigger whose quick press stays the button's own click (the right
  button: a quick press is a right click, a hold is the layer);
- a per-button press, hold, double and triple press (stage 1, v0.12.0).

Measurements that shaped the decision:

- **Key buttons report one at a time.** The consumer report of the V2
  HyperSpeed (2026-10-27, again 2026-11-11 on the notebook) and of the V3 Pro
  (2026-11-11, main PC) carries one usage: pressing a second side button
  releases the first, and the first is not reported again while still held.
  A side button therefore cannot be a held modifier, and two side buttons
  cannot form a chord.
- **Native buttons are a separate channel.** The right button stays a native
  mouse button in the V3's live map and reaches a `WH_MOUSE_LL` hook, held
  together with any side button.
- **The hook cannot tell pointing devices apart.** A right press from the V3,
  a second mouse and a laptop touchpad look the same to the hook.
- **Raw input can.** Measured on the notebook (2026-11-11, probe in git
  `507bf8b`): Windows reports the device for a press even when the mouse hook
  swallowed it, a fraction of a millisecond before or after the hook sees it;
  a precision touchpad's click comes with no device.

## Decision

1. **Four layers**: `standard`, `hypershift`, `hypershift2`, `hypershiftBoth`
   (both triggers held). Config schema version 7.
2. **HyperShift 2's trigger is per profile** (`Profile.hypershift2Triggers`,
   one control per mouse). A profile without it keeps that button as it is, so
   holding the right button in a game still works. This reverses the first
   plan (one trigger for all profiles): the owner needs the plain right button
   in some profiles.
3. **The trigger is a native mouse button** (the V3's right button), never a
   key button (see the one-at-a-time measurement), never the left button, and
   never the software HyperShift trigger.
4. **Held, it is the layer; a quick press with nothing pressed meanwhile is
   the button's own click**, injected on release.
5. **Only the trigger mouse's press holds the layer.** The helper registers
   raw mouse input on its hook thread. A trigger press is matched to the raw
   press of that button: the trigger mouse's holds the layer, another device's
   passes as a normal click (dragging and holding keep working), an unknown
   one is held back until raw input settles it or 60 ms pass. A release is
   matched to its own press first, so another device's click never ends the
   layer. The decision is the pure `trigger2_decision`
   (`src-tauri/src/capture_backend/windows.rs`), unit-tested.
6. **Fallback**: an empty button on HyperShift plays its standard assignment,
   as before. The HyperShift 2 and HS + HS2 layers stand alone: an empty button
   there does nothing (owner's call after using it).
7. **Not stored in the mouse.** The firmware keeps two layers; the offline
   profile and onboard banks never get HyperShift 2 or HS + HS2.

## Considered Options

### Option 1: A side button as the HyperShift 2 trigger (through its consumer signal)

- Pros: no mouse hook, the signal already names its mouse
- Cons: impossible — the mouse reports one key button at a time, so pressing
  the layer's button releases the trigger

### Option 2: One HyperShift 2 trigger for all profiles

- Pros: same model as HyperShift
- Cons: the right button loses its hold (games, dragging) in every profile

### Option 3: Native right button through the mouse hook, per profile, attributed by raw input (chosen)

- Pros: works with any side button held, per-profile opt-in, touchpad and other
  mice unaffected
- Cons: needs the mouse hook and a raw-input window on the helper thread; one
  HyperShift 2 mouse at a time; only while Sidearm runs

## Consequences

- One HyperShift 2 mouse at a time: the hook has one trigger state
  (`shortcut:` comment in `spawn_capture_helper`).
- Raw input messages for every mouse move reach the helper's hook thread while
  a profile uses HyperShift 2 (cheap: a header read per message).
- The e2e harness drives the same decision through the fake mouse pipe
  (report `0x7F`), so the layers are tested end to end without hardware; the
  hook's raw-input path is covered by unit tests and a hardware check.
- Domain terms: `CONTEXT.md` (Layer, HyperShift role). Mechanism:
  `src-tauri/src/capture_backend/AGENTS.md`.
