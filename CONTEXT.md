# Sidearm button assignments

Sidearm gives physical controls profile-specific actions and an optional shared HyperShift modifier role.

## Language

**Physical control**:
A particular button or wheel direction on an input device, regardless of its assigned function.
The Naga V2 HyperSpeed and Naga V3 Pro have separate control identities, even where their buttons have the same labels.
_Avoid_: Naming the right button "HS" merely because it currently activates HyperShift.

**Assignment**:
A control's action in one profile and layer. An absent assignment leaves the original device behaviour; an explicitly disabled action suppresses that assignment.
_Avoid_: Treating an absent assignment as a disabled button.

**Layer**:
One set of assignments a profile gives its controls: the standard layer, HyperShift, HyperShift 2, and "HS + HS2" (both triggers held). An empty button on HyperShift plays its standard assignment; on HyperShift 2 and "HS + HS2" it does nothing (those layers stand alone).
_Avoid_: Mode, bank (a bank is a profile stored in the mouse).

**HyperShift role**:
The button held to activate a HyperShift layer for its device. The HyperShift trigger is the same in every profile. The HyperShift 2 trigger is set per profile (a profile without one keeps that button ordinary, e.g. for holding it in a game); it is a native mouse button, and a quick press with nothing else pressed is its own click. The role takes precedence over that button's ordinary assignment without deleting it. In simultaneous Naga capture, each mouse reports its own layer.
_Avoid_: Profile action, unassigned button.
