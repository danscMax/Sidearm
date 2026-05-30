//! Canonical Windows virtual-key codes and modifier classification.
//!
//! Single source of truth shared by `hotkeys` (key-string parsing),
//! `input_synthesis` (SendInput, u16), and `capture_backend::windows`
//! (low-level hook, u32). Values are the native `windows_sys` VK_* codes; the
//! capture backend casts to `u32` at its WinAPI boundary via `as u32`.
//!
//! Previously these codes were duplicated across all three modules with
//! drifting types (u16 vs u32); a new key meant editing several places.

#![allow(dead_code)] // not every consumer uses every code; this is the shared table

// --- Named keys ---
pub const VK_BACK: u16 = 0x08;
pub const VK_TAB: u16 = 0x09;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_PAUSE: u16 = 0x13;
pub const VK_CAPITAL: u16 = 0x14;
pub const VK_ESCAPE: u16 = 0x1B;
pub const VK_SPACE: u16 = 0x20;
pub const VK_PRIOR: u16 = 0x21;
pub const VK_NEXT: u16 = 0x22;
pub const VK_END: u16 = 0x23;
pub const VK_HOME: u16 = 0x24;
pub const VK_LEFT: u16 = 0x25;
pub const VK_UP: u16 = 0x26;
pub const VK_RIGHT: u16 = 0x27;
pub const VK_DOWN: u16 = 0x28;
pub const VK_SNAPSHOT: u16 = 0x2C;
pub const VK_INSERT: u16 = 0x2D;
pub const VK_DELETE: u16 = 0x2E;
pub const VK_APPS: u16 = 0x5D;
pub const VK_NUMLOCK: u16 = 0x90;
pub const VK_SCROLL: u16 = 0x91;

// --- OEM punctuation ---
pub const VK_OEM_1: u16 = 0xBA;
pub const VK_OEM_PLUS: u16 = 0xBB;
pub const VK_OEM_COMMA: u16 = 0xBC;
pub const VK_OEM_MINUS: u16 = 0xBD;
pub const VK_OEM_PERIOD: u16 = 0xBE;
pub const VK_OEM_2: u16 = 0xBF;
pub const VK_OEM_3: u16 = 0xC0;
pub const VK_OEM_4: u16 = 0xDB;
pub const VK_OEM_5: u16 = 0xDC;
pub const VK_OEM_6: u16 = 0xDD;
pub const VK_OEM_7: u16 = 0xDE;

// --- Modifiers (generic + left/right variants) ---
pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12; // Alt
pub const VK_LSHIFT: u16 = 0xA0;
pub const VK_RSHIFT: u16 = 0xA1;
pub const VK_LCONTROL: u16 = 0xA2;
pub const VK_RCONTROL: u16 = 0xA3;
pub const VK_LMENU: u16 = 0xA4;
pub const VK_RMENU: u16 = 0xA5;
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RWIN: u16 = 0x5C;

/// "Menu Mask Key" — an unassigned VK injected between modifier-down and
/// modifier-up so Windows does not activate menus / the Start menu when Alt or
/// Win is released after a hotkey combo (AutoHotkey v2 pattern).
pub const VK_MASK_KEY: u16 = 0xE8;

/// Which modifier a virtual-key code represents, if any.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModifierKind {
    Ctrl,
    Shift,
    Alt,
    Win,
}

/// Classify a virtual-key code as a modifier (generic or left/right variant).
pub fn classify_modifier_vk(vk: u16) -> Option<ModifierKind> {
    match vk {
        VK_CONTROL | VK_LCONTROL | VK_RCONTROL => Some(ModifierKind::Ctrl),
        VK_SHIFT | VK_LSHIFT | VK_RSHIFT => Some(ModifierKind::Shift),
        VK_MENU | VK_LMENU | VK_RMENU => Some(ModifierKind::Alt),
        VK_LWIN | VK_RWIN => Some(ModifierKind::Win),
        _ => None,
    }
}

/// Whether a virtual-key code is any modifier key.
pub fn is_modifier_vk(vk: u16) -> bool {
    classify_modifier_vk(vk).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_all_modifier_variants() {
        for vk in [VK_CONTROL, VK_LCONTROL, VK_RCONTROL] {
            assert_eq!(classify_modifier_vk(vk), Some(ModifierKind::Ctrl));
        }
        for vk in [VK_SHIFT, VK_LSHIFT, VK_RSHIFT] {
            assert_eq!(classify_modifier_vk(vk), Some(ModifierKind::Shift));
        }
        for vk in [VK_MENU, VK_LMENU, VK_RMENU] {
            assert_eq!(classify_modifier_vk(vk), Some(ModifierKind::Alt));
        }
        for vk in [VK_LWIN, VK_RWIN] {
            assert_eq!(classify_modifier_vk(vk), Some(ModifierKind::Win));
        }
    }

    #[test]
    fn non_modifiers_are_none() {
        for vk in [VK_RETURN, VK_TAB, VK_OEM_1, 0x41 /* A */, VK_MASK_KEY] {
            assert_eq!(classify_modifier_vk(vk), None);
            assert!(!is_modifier_vk(vk));
        }
    }
}

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Boundary / total-mapping invariants
    // -----------------------------------------------------------------------

    // Every u16 must produce a deterministic result from classify_modifier_vk
    // (no panic, no undefined behaviour) and is_modifier_vk must agree with it.
    proptest! {
        #[test]
        fn classify_never_panics_and_is_modifier_agrees(vk: u16) {
            let classification = classify_modifier_vk(vk);
            let is_mod = is_modifier_vk(vk);
            prop_assert_eq!(classification.is_some(), is_mod);
        }
    }

    /// The modifier VK set must be exhaustive and non-overlapping: each
    /// explicitly-named modifier maps to exactly one ModifierKind.
    #[test]
    fn modifier_vk_set_is_exhaustive_and_non_overlapping() {
        let ctrl_group = [VK_CONTROL, VK_LCONTROL, VK_RCONTROL];
        let shift_group = [VK_SHIFT, VK_LSHIFT, VK_RSHIFT];
        let alt_group = [VK_MENU, VK_LMENU, VK_RMENU];
        let win_group = [VK_LWIN, VK_RWIN];

        for &vk in ctrl_group.iter() {
            assert_eq!(classify_modifier_vk(vk), Some(ModifierKind::Ctrl), "vk={vk:#04x}");
        }
        for &vk in shift_group.iter() {
            assert_eq!(classify_modifier_vk(vk), Some(ModifierKind::Shift), "vk={vk:#04x}");
        }
        for &vk in alt_group.iter() {
            assert_eq!(classify_modifier_vk(vk), Some(ModifierKind::Alt), "vk={vk:#04x}");
        }
        for &vk in win_group.iter() {
            assert_eq!(classify_modifier_vk(vk), Some(ModifierKind::Win), "vk={vk:#04x}");
        }

        // Verify no overlap between groups
        let all_groups: [&[u16]; 4] = [&ctrl_group, &shift_group, &alt_group, &win_group];
        for i in 0..all_groups.len() {
            for j in (i + 1)..all_groups.len() {
                for &a in all_groups[i] {
                    for &b in all_groups[j] {
                        assert_ne!(a, b, "VK {a:#04x} appears in two modifier groups");
                    }
                }
            }
        }
    }

    /// Boundary: VK_MASK_KEY (0xE8) is deliberately NOT a modifier, verify it
    /// sits in the "none" bucket even though it's adjacent to some OEM codes.
    #[test]
    fn mask_key_is_not_a_modifier() {
        assert_eq!(classify_modifier_vk(VK_MASK_KEY), None);
        assert!(!is_modifier_vk(VK_MASK_KEY));
    }

    /// Boundary: minimum (0x00) and maximum (0xFF) u8-range VKs are not modifiers.
    #[test]
    fn boundary_vks_not_modifiers() {
        assert_eq!(classify_modifier_vk(0x00), None);
        assert_eq!(classify_modifier_vk(0xFF), None);
    }

    /// Boundary: VKs immediately OUTSIDE each contiguous modifier-code block are
    /// NOT modifiers (guards against off-by-one range bugs if the match is ever
    /// refactored to ranges). NOTE: modifier VKs come in adjacent L/R pairs —
    /// 0xA0/0xA1 = L/R Shift, 0xA2/0xA3 = L/R Ctrl, 0xA4/0xA5 = L/R Alt, and
    /// 0x5B/0x5C = L/R Win — so adjacency *within* a block is expected and correct;
    /// only the outer edge of each block must be a non-modifier.
    #[test]
    fn vks_outside_modifier_blocks_are_not_modifiers() {
        // Modifier blocks: 0x10..=0x12 (Shift/Ctrl/Menu), 0x5B..=0x5C (L/R Win),
        // 0xA0..=0xA5 (L/R Shift/Ctrl/Menu). Test the codes just outside each block.
        for edge in [0x0Fu16, 0x13, 0x5A, 0x5D, 0x9F, 0xA6] {
            assert_eq!(
                classify_modifier_vk(edge),
                None,
                "vk={:#04x} is just outside a modifier block and must not classify as a modifier",
                edge
            );
            assert!(!is_modifier_vk(edge));
        }
    }

    /// Overflow: u16::MAX and values above the standard 0x00..0xFF range are
    /// handled gracefully (no panic).
    #[test]
    fn high_vk_values_do_not_panic() {
        for &vk in &[0x0100u16, 0x1000u16, 0x8000u16, u16::MAX] {
            // Just verify it does not panic and returns None (no named modifier
            // is defined above 0xFF).
            let result = classify_modifier_vk(vk);
            assert_eq!(result, None, "vk={vk:#06x} should not be a modifier");
        }
    }

    /// Null/empty coverage: the function is total (defined for all u16), so we
    /// ensure the code reserved for "unassigned" ranges (0x00, 0x07, 0x3A..0x40,
    /// 0x5E, 0x88..0x8F, 0x97..0x9F, 0xB8..0xB9, 0xC1..0xDA, 0xE0..0xE1,
    /// 0xE3..0xE4, 0xE6, 0xE8..0xF5) return None.
    #[test]
    fn unassigned_vk_range_samples_return_none() {
        // A sample of well-known unassigned/reserved VK codes.
        let unassigned = [
            0x00u16, 0x07, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40,
            0x5E, 0x88, 0x97, 0xB8, 0xC1, 0xE0, 0xE8, 0xF5,
        ];
        for &vk in &unassigned {
            assert_eq!(
                classify_modifier_vk(vk), None,
                "unassigned vk={vk:#04x} should not classify as a modifier"
            );
        }
    }
}
