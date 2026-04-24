//! Windows PS/2 Set 1 scancode table.
//!
//! Used by the v4 macro parser: `macroEvents[].KeyEvent.Makecode` is a
//! Windows scancode (same as v3's `<Scancode>`). Extended keys (right
//! modifiers, arrow keys, numpad navigation, Windows key) share the
//! base-table byte with a different key — the caller uses `is_extended`
//! to disambiguate.

use once_cell::sync::Lazy;
use std::collections::HashMap;

/// Key that a scancode resolves to when the extended-flag is off.
static BASE_TABLE: Lazy<HashMap<u16, &'static str>> = Lazy::new(|| {
    HashMap::from([
        (0x01, "Escape"),
        (0x02, "1"),
        (0x03, "2"),
        (0x04, "3"),
        (0x05, "4"),
        (0x06, "5"),
        (0x07, "6"),
        (0x08, "7"),
        (0x09, "8"),
        (0x0A, "9"),
        (0x0B, "0"),
        (0x0C, "-"),
        (0x0D, "="),
        (0x0E, "Backspace"),
        (0x0F, "Tab"),
        (0x10, "Q"),
        (0x11, "W"),
        (0x12, "E"),
        (0x13, "R"),
        (0x14, "T"),
        (0x15, "Y"),
        (0x16, "U"),
        (0x17, "I"),
        (0x18, "O"),
        (0x19, "P"),
        (0x1A, "["),
        (0x1B, "]"),
        (0x1C, "Enter"),
        (0x1D, "LeftCtrl"),
        (0x1E, "A"),
        (0x1F, "S"),
        (0x20, "D"),
        (0x21, "F"),
        (0x22, "G"),
        (0x23, "H"),
        (0x24, "J"),
        (0x25, "K"),
        (0x26, "L"),
        (0x27, ";"),
        (0x28, "'"),
        (0x29, "`"),
        (0x2A, "LeftShift"),
        (0x2B, "\\"),
        (0x2C, "Z"),
        (0x2D, "X"),
        (0x2E, "C"),
        (0x2F, "V"),
        (0x30, "B"),
        (0x31, "N"),
        (0x32, "M"),
        (0x33, ","),
        (0x34, "."),
        (0x35, "/"),
        (0x36, "RightShift"),
        (0x37, "NumMultiply"),
        (0x38, "LeftAlt"),
        (0x39, "Space"),
        (0x3A, "CapsLock"),
        (0x3B, "F1"),
        (0x3C, "F2"),
        (0x3D, "F3"),
        (0x3E, "F4"),
        (0x3F, "F5"),
        (0x40, "F6"),
        (0x41, "F7"),
        (0x42, "F8"),
        (0x43, "F9"),
        (0x44, "F10"),
        (0x45, "NumLock"),
        (0x46, "ScrollLock"),
        (0x47, "Num7"),
        (0x48, "Num8"),
        (0x49, "Num9"),
        (0x4A, "NumSubtract"),
        (0x4B, "Num4"),
        (0x4C, "Num5"),
        (0x4D, "Num6"),
        (0x4E, "NumAdd"),
        (0x4F, "Num1"),
        (0x50, "Num2"),
        (0x51, "Num3"),
        (0x52, "Num0"),
        (0x53, "NumDecimal"),
        (0x57, "F11"),
        (0x58, "F12"),
        (0x64, "F13"),
        (0x65, "F14"),
        (0x66, "F15"),
        (0x67, "F16"),
        (0x68, "F17"),
        (0x69, "F18"),
        (0x6A, "F19"),
        (0x6B, "F20"),
        (0x6C, "F21"),
        (0x6D, "F22"),
        (0x6E, "F23"),
        (0x6F, "F24"),
    ])
});

/// Key that a scancode resolves to when the extended-flag (E0 prefix) is on.
static EXTENDED_TABLE: Lazy<HashMap<u16, &'static str>> = Lazy::new(|| {
    HashMap::from([
        (0x1C, "NumEnter"),
        (0x1D, "RightCtrl"),
        (0x35, "NumDivide"),
        (0x37, "PrintScreen"),
        (0x38, "RightAlt"),
        (0x47, "Home"),
        (0x48, "Up"),
        (0x49, "PageUp"),
        (0x4B, "Left"),
        (0x4D, "Right"),
        (0x4F, "End"),
        (0x50, "Down"),
        (0x51, "PageDown"),
        (0x52, "Insert"),
        (0x53, "Delete"),
        (0x5B, "LeftWin"),
        (0x5C, "RightWin"),
        (0x5D, "Apps"),
    ])
});

/// Resolve a `(makecode, is_extended)` pair to a Sidearm key name.
/// Returns `None` for unknown codes; caller emits a warning and falls back
/// to a verbatim `Scancode(0xNN)` placeholder.
///
/// Fallback rule: if the base table has no entry for this code (and the
/// extended-flag was off), try the extended table. This handles Synapse
/// v3 macros that encode Windows-key etc. as base scancodes without the
/// extended marker, since the base set has no meaning for those codes.
pub fn makecode_to_key(makecode: u16, is_extended: bool) -> Option<&'static str> {
    if is_extended {
        if let Some(k) = EXTENDED_TABLE.get(&makecode) {
            return Some(*k);
        }
    }
    if let Some(k) = BASE_TABLE.get(&makecode) {
        return Some(*k);
    }
    // Fallback: extended-only keys that showed up as base scancodes.
    if !is_extended {
        if let Some(k) = EXTENDED_TABLE.get(&makecode) {
            return Some(*k);
        }
    }
    None
}

/// True if the key at this `(makecode, is_extended)` pair is a pure modifier.
/// Used by the sequence builder to fold held modifiers into keyboard-group
/// shortcut flags instead of emitting them as separate Send steps.
pub fn is_modifier(makecode: u16, is_extended: bool) -> bool {
    matches!(
        makecode_to_key(makecode, is_extended),
        Some("LeftCtrl") | Some("RightCtrl")
            | Some("LeftShift") | Some("RightShift")
            | Some("LeftAlt") | Some("RightAlt")
            | Some("LeftWin") | Some("RightWin")
    )
}

/// Canonical name for the modifier side-pair — folds Left* / Right* to
/// "Ctrl", "Shift", "Alt", "Win" so shortcut-payload flags compose correctly.
pub fn modifier_canonical(makecode: u16, is_extended: bool) -> Option<&'static str> {
    match makecode_to_key(makecode, is_extended)? {
        "LeftCtrl" | "RightCtrl" => Some("Ctrl"),
        "LeftShift" | "RightShift" => Some("Shift"),
        "LeftAlt" | "RightAlt" => Some("Alt"),
        "LeftWin" | "RightWin" => Some("Win"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_letters_resolve() {
        assert_eq!(makecode_to_key(0x1E, false), Some("A"));
        assert_eq!(makecode_to_key(0x2C, false), Some("Z"));
        assert_eq!(makecode_to_key(0x10, false), Some("Q"));
    }

    #[test]
    fn digits_and_row_resolve() {
        assert_eq!(makecode_to_key(0x02, false), Some("1"));
        assert_eq!(makecode_to_key(0x0B, false), Some("0"));
        assert_eq!(makecode_to_key(0x0C, false), Some("-"));
        assert_eq!(makecode_to_key(0x0D, false), Some("="));
    }

    #[test]
    fn function_keys_resolve() {
        assert_eq!(makecode_to_key(0x3B, false), Some("F1"));
        assert_eq!(makecode_to_key(0x58, false), Some("F12"));
        assert_eq!(makecode_to_key(0x64, false), Some("F13"));
        assert_eq!(makecode_to_key(0x6F, false), Some("F24"));
    }

    #[test]
    fn extended_keys_disambiguate() {
        // Base 0x48 is Num8; extended 0x48 is the Up arrow.
        assert_eq!(makecode_to_key(0x48, false), Some("Num8"));
        assert_eq!(makecode_to_key(0x48, true), Some("Up"));
        // Base 0x1D is LeftCtrl; extended is RightCtrl.
        assert_eq!(makecode_to_key(0x1D, false), Some("LeftCtrl"));
        assert_eq!(makecode_to_key(0x1D, true), Some("RightCtrl"));
    }

    #[test]
    fn unknown_code_returns_none() {
        assert_eq!(makecode_to_key(0xFF, false), None);
        assert_eq!(makecode_to_key(0xAA, true), None);
    }

    #[test]
    fn is_modifier_recognises_all_sides() {
        assert!(is_modifier(0x1D, false)); // LeftCtrl
        assert!(is_modifier(0x1D, true));  // RightCtrl
        assert!(is_modifier(0x2A, false)); // LeftShift
        assert!(is_modifier(0x36, false)); // RightShift
        assert!(is_modifier(0x38, false)); // LeftAlt
        assert!(is_modifier(0x38, true));  // RightAlt
        assert!(is_modifier(0x5B, true));  // LeftWin
        assert!(!is_modifier(0x1E, false)); // A
    }

    #[test]
    fn modifier_canonical_collapses_sides() {
        assert_eq!(modifier_canonical(0x1D, false), Some("Ctrl"));
        assert_eq!(modifier_canonical(0x1D, true), Some("Ctrl"));
        assert_eq!(modifier_canonical(0x2A, false), Some("Shift"));
        assert_eq!(modifier_canonical(0x36, false), Some("Shift"));
        assert_eq!(modifier_canonical(0x38, true), Some("Alt"));
        assert_eq!(modifier_canonical(0x5B, true), Some("Win"));
        assert_eq!(modifier_canonical(0x1E, false), None); // A — not a modifier
    }
}
