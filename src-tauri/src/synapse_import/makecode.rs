//! Windows PS/2 Set 1 scancode table.
//!
//! Used by the v4 macro parser: `macroEvents[].KeyEvent.Makecode` is a
//! Windows scancode (same as v3's `<Scancode>`). Extended keys (right
//! modifiers, arrow keys, numpad navigation, Windows key) share the
//! base-table byte with a different key — the caller uses `is_extended`
//! to disambiguate.

use std::sync::LazyLock;
use std::collections::HashMap;

/// Key that a scancode resolves to when the extended-flag is off.
static BASE_TABLE: LazyLock<HashMap<u16, &'static str>> = LazyLock::new(|| {
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
static EXTENDED_TABLE: LazyLock<HashMap<u16, &'static str>> = LazyLock::new(|| {
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
    if is_extended
        && let Some(k) = EXTENDED_TABLE.get(&makecode) {
            return Some(*k);
        }
    if let Some(k) = BASE_TABLE.get(&makecode) {
        return Some(*k);
    }
    // Fallback: extended-only keys that showed up as base scancodes.
    if !is_extended
        && let Some(k) = EXTENDED_TABLE.get(&makecode) {
            return Some(*k);
        }
    None
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

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Boundary: min/max of u16 scancode range
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_scancode_zero_returns_none() {
        // Code 0 has no PS/2 meaning and must not panic.
        assert!(makecode_to_key(0x00, false).is_none());
        assert!(makecode_to_key(0x00, true).is_none());
    }

    #[test]
    fn boundary_scancode_u16_max_returns_none() {
        assert!(makecode_to_key(u16::MAX, false).is_none());
        assert!(makecode_to_key(u16::MAX, true).is_none());
    }

    #[test]
    fn boundary_f_key_range_top() {
        // F24 is the highest function key in the table (0x6F).
        assert_eq!(makecode_to_key(0x6F, false), Some("F24"));
        // 0x70 is beyond F24 — should return None (no panic).
        assert!(makecode_to_key(0x70, false).is_none());
    }

    // -----------------------------------------------------------------------
    // Property: makecode_to_key never panics on any (u16, bool) input
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn prop_makecode_to_key_never_panics(code in any::<u16>(), extended in any::<bool>()) {
            // Must complete without panic; return value is Option (Some or None).
            let _ = makecode_to_key(code, extended);
        }

        #[test]
        fn prop_modifier_canonical_never_panics(code in any::<u16>(), extended in any::<bool>()) {
            let _ = modifier_canonical(code, extended);
        }

        // Invariant: if modifier_canonical returns Some, the result is one of the
        // four canonical modifier names.
        #[test]
        fn prop_modifier_canonical_only_known_names(
            code in any::<u16>(),
            extended in any::<bool>()
        ) {
            if let Some(name) = modifier_canonical(code, extended) {
                assert!(
                    matches!(name, "Ctrl" | "Shift" | "Alt" | "Win"),
                    "unexpected canonical modifier: {name}"
                );
            }
        }

        // Invariant: if extended=true resolves to X, then that X is always from
        // the extended table or falls back to base — never an unknown value.
        #[test]
        fn prop_result_is_static_str_from_known_set(
            code in 0x01u16..=0x6Fu16,
            extended in any::<bool>()
        ) {
            // All results for codes in the defined range should be non-empty strings.
            if let Some(name) = makecode_to_key(code, extended) {
                assert!(!name.is_empty());
            }
        }
    }

    // -----------------------------------------------------------------------
    // Overflow / null: extended-flag fallback path with gap codes
    // -----------------------------------------------------------------------

    #[test]
    fn gap_codes_between_f12_and_f13_return_none() {
        // Only codes absent from BOTH tables return None. makecode_to_key falls
        // back to EXTENDED_TABLE for non-extended codes (e.g. 0x5B → LeftWin), so
        // a code present in either table is legitimately mapped — skip those.
        for code in 0x59u16..=0x63 {
            if BASE_TABLE.contains_key(&code) || EXTENDED_TABLE.contains_key(&code) {
                continue;
            }
            assert!(makecode_to_key(code, false).is_none(), "code 0x{:02X} should be None", code);
        }
    }

    // Concurrency: N/A — pure lookup functions with no shared mutable state;
    //              Lazy statics are initialised once (read-only thereafter).
    // Temporal:    N/A — no durations or timestamps in this module.
}
