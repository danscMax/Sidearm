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
