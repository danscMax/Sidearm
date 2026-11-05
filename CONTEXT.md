# Sidearm button assignments

Sidearm gives physical controls profile-specific actions and an optional shared HyperShift modifier role.

## Language

**Physical control**:
A particular button or wheel direction on an input device, regardless of its assigned function.
_Avoid_: Naming the right button "HS" merely because it currently activates HyperShift.

**Assignment**:
A control's action in one profile and layer. An absent assignment leaves the original device behaviour; an explicitly disabled action suppresses that assignment.
_Avoid_: Treating an absent assignment as a disabled button.

**HyperShift role**:
The single button held to activate the HyperShift layer across all profiles. The role takes precedence over that button's ordinary assignment without deleting it.
_Avoid_: Profile action, unassigned button.
