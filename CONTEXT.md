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
One set of assignments a profile gives its controls: the standard layer, and one or more HyperShift layers that replace it while their trigger is held.
_Avoid_: Mode, bank (a bank is a profile stored in the mouse).

**HyperShift role**:
The button held to activate one HyperShift layer across all profiles for its device. Each HyperShift layer has its own trigger; which layer a trigger opens is the same in every profile, only the assignments on that layer differ per profile. The role takes precedence over that button's ordinary assignment without deleting it. In simultaneous Naga capture, each mouse reports its own layer.
_Avoid_: Profile action, unassigned button, a per-profile trigger.
