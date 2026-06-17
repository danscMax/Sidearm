//! Mapping tables between Razer Synapse identifiers and Sidearm equivalents.
//!
//! Covers three domains:
//! 1. InputID → Sidearm `controlId` (thumb grid, mouse buttons, scroll wheel)
//! 2. Synapse `KEY_*` token → Sidearm keyboard `key` string + modifier booleans
//! 3. Synapse `outputType` → Sidearm `actionType`

use std::sync::LazyLock;
use std::collections::HashMap;

use super::types::{ImportWarning, ParsedAction};

// ============================================================================
// InputID → controlId
// ============================================================================

/// v4 side-panel thumb grid uses `KEY_1..KEY_9, KEY_0, KEY_HYPEN, KEY_EQUAL`
/// inside `sidePanelMappings.12ButtonSide[]`. The ordering is fixed in Synapse.
pub static THUMB_GRID_V4: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    HashMap::from([
        ("KEY_1", "thumb_01"),
        ("KEY_2", "thumb_02"),
        ("KEY_3", "thumb_03"),
        ("KEY_4", "thumb_04"),
        ("KEY_5", "thumb_05"),
        ("KEY_6", "thumb_06"),
        ("KEY_7", "thumb_07"),
        ("KEY_8", "thumb_08"),
        ("KEY_9", "thumb_09"),
        ("KEY_0", "thumb_10"),
        ("KEY_HYPEN", "thumb_11"),
        ("KEY_EQUAL", "thumb_12"),
    ])
});

/// v3 XML and v4 device-level `mappings[]` use `DKM_M_01..12` for thumb slots.
pub static THUMB_GRID_DKM: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    for (i, thumb) in [
        "thumb_01", "thumb_02", "thumb_03", "thumb_04", "thumb_05", "thumb_06",
        "thumb_07", "thumb_08", "thumb_09", "thumb_10", "thumb_11", "thumb_12",
    ]
    .iter()
    .enumerate()
    {
        let key: &'static str = Box::leak(format!("DKM_M_{:02}", i + 1).into_boxed_str());
        m.insert(key, *thumb);
    }
    m
});

/// Mouse / scroll / top buttons appear in the v4 `mappings[]` array and in
/// v3 `<MouseInput>` payloads.
pub static MOUSE_BUTTONS: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    HashMap::from([
        ("LeftClick", "mouse_left"),
        ("RightClick", "mouse_right"),
        ("MiddleClick", "wheel_click"),
        // v3 names for the same middle-click button.
        ("ScrollButton", "wheel_click"),
        ("Mouse4", "mouse_4"),
        ("Mouse5", "mouse_5"),
        // v3 uses Button4..Button7 for the side / top buttons.
        ("Button4", "mouse_4"),
        ("Button5", "mouse_5"),
        ("Button6", "top_aux_01"),
        ("Button7", "top_aux_02"),
        ("ScrollUp", "wheel_up"),
        ("ScrollDown", "wheel_down"),
        ("ScrollLeft", "wheel_left"),
        ("ScrollRight", "wheel_right"),
        // Observed in real exports but not meaningful for Sidearm — treated as
        // wheel_right/wheel_left since they fire on repeated horizontal scroll.
        ("RepeatScrollRight", "wheel_right"),
        ("RepeatScrollLeft", "wheel_left"),
        // HyperShift activator
        ("Mouse_HS", "hypershift_button"),
        ("HyperShift", "hypershift_button"),
    ])
});

/// Resolve a Synapse `(inputType, inputID)` pair to a Sidearm `controlId`.
/// Returns `None` for unknown pairs; caller emits a warning.
///
/// `is_side_panel` indicates whether the mapping came from
/// `sidePanelMappings.12ButtonSide[]` (true) vs top-level `mappings[]` (false);
/// this matters because v4 uses different naming in each place.
pub fn input_id_to_control_id(
    input_type: &str,
    input_id: &str,
    is_side_panel: bool,
) -> Option<&'static str> {
    if is_side_panel {
        return THUMB_GRID_V4.get(input_id).copied();
    }
    match input_type {
        "KeyInput" => THUMB_GRID_V4.get(input_id).copied(),
        "DKMInput" => THUMB_GRID_DKM.get(input_id).copied(),
        "MouseInput" => MOUSE_BUTTONS.get(input_id).copied(),
        _ => None,
    }
}

// ============================================================================
// KEY_* token → Sidearm key + modifiers
// ============================================================================

pub static KEY_TOKEN_SPECIAL: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    HashMap::from([
        ("KEY_TAB", "Tab"),
        ("KEY_ENTER", "Enter"),
        ("KEY_ESCAPE", "Escape"),
        ("KEY_ESC", "Escape"),
        ("KEY_SPACE", "Space"),
        ("KEY_SPACEBAR", "Space"),
        ("KEY_BACK", "Backspace"),
        ("KEY_BACKSPACE", "Backspace"),
        ("KEY_DELETE", "Delete"),
        ("KEY_INSERT", "Insert"),
        ("KEY_HOME", "Home"),
        ("KEY_END", "End"),
        ("KEY_PGUP", "PageUp"),
        ("KEY_PAGEUP", "PageUp"),
        ("KEY_PGDN", "PageDown"),
        ("KEY_PAGEDOWN", "PageDown"),
        ("KEY_UP_ARROW", "Up"),
        ("KEY_DOWN_ARROW", "Down"),
        ("KEY_LEFT_ARROW", "Left"),
        ("KEY_RIGHT_ARROW", "Right"),
        ("KEY_UP", "Up"),
        ("KEY_DOWN", "Down"),
        ("KEY_LEFT", "Left"),
        ("KEY_RIGHT", "Right"),
        ("KEY_CAPS_LOCK", "CapsLock"),
        ("KEY_NUM_LOCK", "NumLock"),
        ("KEY_SCROLL_LOCK", "ScrollLock"),
        ("KEY_PRINT_SCREEN", "PrintScreen"),
        ("KEY_PAUSE", "Pause"),
        ("KEY_APPS", "Apps"),
        ("KEY_MENU", "Apps"),
        ("KEY_HYPEN", "-"),
        ("KEY_MINUS", "-"),
        ("KEY_EQUAL", "="),
        ("KEY_EQUALS", "="),
        ("KEY_COMMA", ","),
        ("KEY_PERIOD", "."),
        ("KEY_SLASH", "/"),
        ("KEY_BACKSLASH", "\\"),
        ("KEY_SEMICOLON", ";"),
        ("KEY_APOSTROPHE", "'"),
        ("KEY_OPEN_BRACKET", "["),
        ("KEY_LEFT_BRACKET", "["),
        ("KEY_CLOSE_BRACKET", "]"),
        ("KEY_RIGHT_BRACKET", "]"),
        ("KEY_TILDE", "`"),
        ("KEY_GRAVE", "`"),
        ("KEY_NUMPAD_0", "Num0"),
        ("KEY_NUMPAD_1", "Num1"),
        ("KEY_NUMPAD_2", "Num2"),
        ("KEY_NUMPAD_3", "Num3"),
        ("KEY_NUMPAD_4", "Num4"),
        ("KEY_NUMPAD_5", "Num5"),
        ("KEY_NUMPAD_6", "Num6"),
        ("KEY_NUMPAD_7", "Num7"),
        ("KEY_NUMPAD_8", "Num8"),
        ("KEY_NUMPAD_9", "Num9"),
        ("KEY_NUMPAD_ADD", "NumAdd"),
        ("KEY_NUMPAD_SUBTRACT", "NumSubtract"),
        ("KEY_NUMPAD_MULTIPLY", "NumMultiply"),
        ("KEY_NUMPAD_DIVIDE", "NumDivide"),
        ("KEY_NUMPAD_DECIMAL", "NumDecimal"),
        ("KEY_NUMPAD_ENTER", "NumEnter"),
    ])
});

pub static MODIFIER_TOKENS: &[&str] = &[
    "KEY_LEFT_CTRL",
    "KEY_RIGHT_CTRL",
    "KEY_LEFT_SHIFT",
    "KEY_RIGHT_SHIFT",
    "KEY_LEFT_ALT",
    "KEY_RIGHT_ALT",
    "KEY_LEFT_WIN",
    "KEY_RIGHT_WIN",
    "KEY_LEFT_GUI",
    "KEY_RIGHT_GUI",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModifierFlags {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
}

impl ModifierFlags {
    pub fn add_token(&mut self, token: &str) -> bool {
        if token.contains("CTRL") {
            self.ctrl = true;
            true
        } else if token.contains("SHIFT") {
            self.shift = true;
            true
        } else if token.contains("ALT") {
            self.alt = true;
            true
        } else if token.contains("WIN") || token.contains("GUI") {
            self.win = true;
            true
        } else {
            false
        }
    }
}

/// Translate a Synapse keyboard token (e.g. `KEY_TAB`, `KEY_A`, `KEY_F13`) into
/// a Sidearm key name. Returns `Err` for tokens that represent modifiers only
/// (caller folds them into the modifier flags) or tokens we don't know.
pub fn translate_key_token(token: &str) -> Result<String, KeyTranslationError> {
    if MODIFIER_TOKENS.contains(&token) {
        return Err(KeyTranslationError::ModifierOnly);
    }
    if let Some(special) = KEY_TOKEN_SPECIAL.get(token) {
        return Ok((*special).to_string());
    }
    if let Some(rest) = token.strip_prefix("KEY_") {
        // KEY_A..KEY_Z, KEY_0..KEY_9, KEY_F1..KEY_F24 fall through to here.
        if rest.len() == 1 {
            let ch = rest.chars().next().unwrap();
            if ch.is_ascii_alphanumeric() {
                return Ok(rest.to_string());
            }
        }
        if let Some(tail) = rest.strip_prefix('F') {
            // Function keys exist only as F1..=F24. Reject F0, F25+ and absurd
            // numbers instead of blindly accepting any digit tail.
            if let Ok(n) = tail.parse::<u8>() {
                if (1..=24).contains(&n) {
                    return Ok(rest.to_string());
                }
            }
        }
    }
    Err(KeyTranslationError::Unknown(token.to_string()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyTranslationError {
    ModifierOnly,
    Unknown(String),
}

/// Parse the `modifiers` array as returned by Synapse v4 `keyboardGroup.modifiers`.
pub fn parse_modifier_array(tokens: &[String]) -> ModifierFlags {
    let mut flags = ModifierFlags::default();
    for token in tokens {
        flags.add_token(token);
    }
    flags
}

// ============================================================================
// Mouse action mapping
// ============================================================================

// ============================================================================
// Win32 VirtualKey code → Sidearm key name  (v3 <KeyAssignment><VirtualKey>)
// ============================================================================

pub static VK_TO_KEY: LazyLock<HashMap<u16, &'static str>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    // Letter keys: VK_A (0x41) .. VK_Z (0x5A)
    for i in 0..26u16 {
        let ch = (b'A' + i as u8) as char;
        let s: &'static str = Box::leak(ch.to_string().into_boxed_str());
        m.insert(0x41 + i, s);
    }
    // Digit row: VK_0 (0x30) .. VK_9 (0x39)
    for i in 0..10u16 {
        let s: &'static str = Box::leak((i).to_string().into_boxed_str());
        m.insert(0x30 + i, s);
    }
    // Function keys VK_F1 (0x70) .. VK_F24 (0x87)
    for i in 0..24u16 {
        let name: &'static str = Box::leak(format!("F{}", i + 1).into_boxed_str());
        m.insert(0x70 + i, name);
    }
    // Common named keys
    for (vk, name) in [
        (0x08, "Backspace"),
        (0x09, "Tab"),
        (0x0D, "Enter"),
        (0x10, "Shift"),
        (0x11, "Ctrl"),
        (0x12, "Alt"),
        (0x13, "Pause"),
        (0x14, "CapsLock"),
        (0x1B, "Escape"),
        (0x20, "Space"),
        (0x21, "PageUp"),
        (0x22, "PageDown"),
        (0x23, "End"),
        (0x24, "Home"),
        (0x25, "Left"),
        (0x26, "Up"),
        (0x27, "Right"),
        (0x28, "Down"),
        (0x2C, "PrintScreen"),
        (0x2D, "Insert"),
        (0x2E, "Delete"),
        (0x5B, "LeftWin"),
        (0x5C, "RightWin"),
        (0x5D, "Apps"),
        (0x60, "Num0"),
        (0x61, "Num1"),
        (0x62, "Num2"),
        (0x63, "Num3"),
        (0x64, "Num4"),
        (0x65, "Num5"),
        (0x66, "Num6"),
        (0x67, "Num7"),
        (0x68, "Num8"),
        (0x69, "Num9"),
        (0x6A, "NumMultiply"),
        (0x6B, "NumAdd"),
        (0x6D, "NumSubtract"),
        (0x6E, "NumDecimal"),
        (0x6F, "NumDivide"),
        (0x90, "NumLock"),
        (0x91, "ScrollLock"),
        (0xA0, "LeftShift"),
        (0xA1, "RightShift"),
        (0xA2, "LeftCtrl"),
        (0xA3, "RightCtrl"),
        (0xA4, "LeftAlt"),
        (0xA5, "RightAlt"),
        (0xBA, ";"),
        (0xBB, "="),
        (0xBC, ","),
        (0xBD, "-"),
        (0xBE, "."),
        (0xBF, "/"),
        (0xC0, "`"),
        (0xDB, "["),
        (0xDC, "\\"),
        (0xDD, "]"),
        (0xDE, "'"),
    ] {
        m.insert(vk, name);
    }
    m
});

/// Translate a Win32 VK code to a Sidearm key name. Returns None for
/// unsupported codes.
pub fn vk_to_key(vk: u16) -> Option<&'static str> {
    VK_TO_KEY.get(&vk).copied()
}

/// Parse Synapse v3 `<Modifier>` string like "Left_Ctrl Left_Shift" (or
/// "Left_Alt Extended_Key") into modifier flags. Unknown tokens are
/// ignored.
pub fn parse_modifier_string(raw: &str) -> ModifierFlags {
    let mut flags = ModifierFlags::default();
    for tok in raw.split_whitespace() {
        let upper = tok.to_ascii_uppercase();
        if upper.contains("CTRL") {
            flags.ctrl = true;
        } else if upper.contains("SHIFT") {
            flags.shift = true;
        } else if upper.contains("ALT") {
            flags.alt = true;
        } else if upper.contains("WIN") || upper.contains("GUI") {
            flags.win = true;
        }
        // Extended_Key etc. are ignored — they're OS-level flags, not
        // logical modifiers.
    }
    flags
}

// ============================================================================
// Mouse action mapping
// ============================================================================

/// Translate Synapse `mouseGroup.mouseAssignment` to a Sidearm mouse action
/// string that the runtime understands. Returns None for unsupported actions.
pub fn translate_mouse_assignment(assignment: &str) -> Option<&'static str> {
    match assignment {
        "Click" | "LeftClick" => Some("leftClick"),
        "RightClick" => Some("rightClick"),
        "MiddleClick" => Some("middleClick"),
        "DoubleClick" => Some("doubleClick"),
        "ScrollUp" => Some("scrollUp"),
        "ScrollDown" => Some("scrollDown"),
        "ScrollLeft" => Some("scrollLeft"),
        "ScrollRight" => Some("scrollRight"),
        // v3 browser-back / browser-forward conventions.
        "Previous" => Some("mouseBack"),
        "Next" => Some("mouseForward"),
        _ => None,
    }
}

/// Translate a Synapse mouse-assignment string into a `ParsedAction`, emitting
/// an `unsupported_mouse_assignment` warning (scoped to `profile_name`) when the
/// assignment has no Sidearm equivalent. Shared by the v3 and v4 builders.
pub fn mouse_action_from_assignment(
    assignment: &str,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> ParsedAction {
    match translate_mouse_assignment(assignment) {
        Some(action) => ParsedAction::MouseAction {
            action: action.to_string(),
        },
        None => {
            warnings.push(
                ImportWarning::new(
                    "unsupported_mouse_assignment",
                    format!("Mouse assignment `{assignment}` is not supported."),
                )
                .with_context(profile_name.to_string()),
            );
            ParsedAction::Unmappable {
                reason: format!("Mouse assignment `{assignment}` not supported"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumb_grid_v4_covers_all_twelve_slots() {
        for slot in ["KEY_1", "KEY_2", "KEY_3", "KEY_4", "KEY_5", "KEY_6",
                     "KEY_7", "KEY_8", "KEY_9", "KEY_0", "KEY_HYPEN", "KEY_EQUAL"] {
            assert!(THUMB_GRID_V4.contains_key(slot), "missing slot: {slot}");
        }
        assert_eq!(THUMB_GRID_V4.len(), 12);
    }

    #[test]
    fn thumb_grid_dkm_covers_all_twelve_slots() {
        for i in 1..=12 {
            let key = format!("DKM_M_{i:02}");
            assert!(THUMB_GRID_DKM.contains_key(key.as_str()), "missing {key}");
        }
        assert_eq!(THUMB_GRID_DKM.len(), 12);
    }

    #[test]
    fn input_id_side_panel_uses_v4_table() {
        assert_eq!(input_id_to_control_id("KeyInput", "KEY_3", true), Some("thumb_03"));
        assert_eq!(input_id_to_control_id("KeyInput", "KEY_EQUAL", true), Some("thumb_12"));
    }

    #[test]
    fn input_id_mappings_uses_dkm_for_dkm_input() {
        assert_eq!(input_id_to_control_id("DKMInput", "DKM_M_01", false), Some("thumb_01"));
    }

    #[test]
    fn input_id_mouse_buttons() {
        assert_eq!(input_id_to_control_id("MouseInput", "LeftClick", false), Some("mouse_left"));
        assert_eq!(input_id_to_control_id("MouseInput", "ScrollDown", false), Some("wheel_down"));
        assert_eq!(input_id_to_control_id("MouseInput", "Mouse4", false), Some("mouse_4"));
        assert_eq!(input_id_to_control_id("MouseInput", "Mouse_HS", false), Some("hypershift_button"));
    }

    #[test]
    fn input_id_unknown_returns_none() {
        assert_eq!(input_id_to_control_id("MouseInput", "NoSuchButton", false), None);
    }

    #[test]
    fn key_token_translate_letters_and_digits() {
        assert_eq!(translate_key_token("KEY_A").unwrap(), "A");
        assert_eq!(translate_key_token("KEY_Z").unwrap(), "Z");
        assert_eq!(translate_key_token("KEY_0").unwrap(), "0");
        assert_eq!(translate_key_token("KEY_9").unwrap(), "9");
    }

    #[test]
    fn key_token_translate_f_keys() {
        assert_eq!(translate_key_token("KEY_F1").unwrap(), "F1");
        assert_eq!(translate_key_token("KEY_F13").unwrap(), "F13");
        assert_eq!(translate_key_token("KEY_F24").unwrap(), "F24");
    }

    #[test]
    fn key_token_translate_special() {
        assert_eq!(translate_key_token("KEY_TAB").unwrap(), "Tab");
        assert_eq!(translate_key_token("KEY_DELETE").unwrap(), "Delete");
        assert_eq!(translate_key_token("KEY_UP_ARROW").unwrap(), "Up");
    }

    #[test]
    fn key_token_modifiers_return_error() {
        assert!(matches!(
            translate_key_token("KEY_LEFT_CTRL"),
            Err(KeyTranslationError::ModifierOnly)
        ));
        assert!(matches!(
            translate_key_token("KEY_RIGHT_ALT"),
            Err(KeyTranslationError::ModifierOnly)
        ));
    }

    #[test]
    fn parse_modifier_array_folds_to_flags() {
        let flags = parse_modifier_array(&[
            "KEY_LEFT_CTRL".into(),
            "KEY_RIGHT_SHIFT".into(),
        ]);
        assert_eq!(
            flags,
            ModifierFlags {
                ctrl: true,
                shift: true,
                alt: false,
                win: false
            }
        );
    }

    #[test]
    fn translate_mouse_assignment_known_actions() {
        assert_eq!(translate_mouse_assignment("Click"), Some("leftClick"));
        assert_eq!(translate_mouse_assignment("DoubleClick"), Some("doubleClick"));
        assert_eq!(translate_mouse_assignment("Menu"), None);
    }
}

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Boundary: empty / single-char / very long token strings
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_empty_token_is_unknown() {
        assert_eq!(
            translate_key_token(""),
            Err(KeyTranslationError::Unknown(String::new()))
        );
    }

    #[test]
    fn boundary_key_prefix_only_is_unknown() {
        // "KEY_" with no suffix should not panic and returns Unknown.
        assert!(matches!(
            translate_key_token("KEY_"),
            Err(KeyTranslationError::Unknown(_))
        ));
    }

    #[test]
    fn boundary_key_f0_is_unknown() {
        // "KEY_F0" — the tail after 'F' is "0" which is a digit but F0 is not
        // a real key.  It should NOT match the F-key arm because F0 is not
        // in the special table, and the single-char arm only applies to
        // alphanumeric chars.  Confirm it returns Unknown (not a panic).
        assert!(matches!(
            translate_key_token("KEY_F0"),
            Err(KeyTranslationError::Unknown(_))
        ));
    }

    #[test]
    fn boundary_key_f25_is_unknown() {
        // F25 does not exist in Synapse or PS/2; must be Unknown.
        assert!(matches!(
            translate_key_token("KEY_F25"),
            Err(KeyTranslationError::Unknown(_))
        ));
    }

    // -----------------------------------------------------------------------
    // Null & empty: empty modifier array / modifier string
    // -----------------------------------------------------------------------

    #[test]
    fn null_empty_modifier_array_returns_all_false() {
        let flags = parse_modifier_array(&[]);
        assert_eq!(flags, ModifierFlags::default());
    }

    #[test]
    fn null_empty_modifier_string_returns_all_false() {
        let flags = parse_modifier_string("");
        assert_eq!(flags, ModifierFlags::default());
    }

    #[test]
    fn null_whitespace_only_modifier_string_returns_all_false() {
        let flags = parse_modifier_string("   \t  ");
        assert_eq!(flags, ModifierFlags::default());
    }

    // -----------------------------------------------------------------------
    // Property: translate_key_token never panics on arbitrary strings
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn prop_translate_key_token_never_panics(s in ".*") {
            let _ = translate_key_token(&s);
        }

        // Invariant: result for valid single-char alphanumeric KEY_X is exactly
        // that character as an uppercase ASCII string.
        #[test]
        fn prop_key_single_char_alphanum_roundtrip(
            ch in "[A-Z0-9]"
        ) {
            let token = format!("KEY_{ch}");
            match translate_key_token(&token) {
                Ok(name) => assert_eq!(name, ch),
                Err(_) => panic!("Expected Ok for token {token}"),
            }
        }

        // Invariant: parse_modifier_array never panics on arbitrary token lists.
        #[test]
        fn prop_parse_modifier_array_never_panics(
            tokens in prop::collection::vec(".*", 0..50)
        ) {
            let _ = parse_modifier_array(&tokens);
        }

        // Invariant: parse_modifier_string never panics on arbitrary strings.
        #[test]
        fn prop_parse_modifier_string_never_panics(s in ".*") {
            let _ = parse_modifier_string(&s);
        }

        // Invariant: translate_mouse_assignment never panics.
        #[test]
        fn prop_translate_mouse_assignment_never_panics(s in ".*") {
            let _ = translate_mouse_assignment(&s);
        }

        // Invariant: input_id_to_control_id never panics.
        #[test]
        fn prop_input_id_to_control_id_never_panics(
            input_type in ".*",
            input_id in ".*",
            is_side_panel in any::<bool>()
        ) {
            let _ = input_id_to_control_id(&input_type, &input_id, is_side_panel);
        }

        // Invariant: vk_to_key never panics for any u16.
        #[test]
        fn prop_vk_to_key_never_panics(vk in any::<u16>()) {
            let _ = vk_to_key(vk);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: VK code range edges
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_vk_zero_and_max_return_none() {
        assert!(vk_to_key(0).is_none());
        assert!(vk_to_key(u16::MAX).is_none());
    }

    #[test]
    fn boundary_vk_letter_range_coverage() {
        // VK_A=0x41..VK_Z=0x5A — all should resolve to single uppercase letters.
        for (i, expected) in (b'A'..=b'Z').enumerate() {
            let vk = 0x41u16 + i as u16;
            assert_eq!(
                vk_to_key(vk),
                Some(std::str::from_utf8(&[expected]).unwrap()),
                "vk 0x{vk:02X} should map to {}",
                expected as char
            );
        }
    }

    #[test]
    fn boundary_vk_f1_to_f24_all_resolve() {
        // VK_F1=0x70 .. VK_F24=0x87
        for i in 0u16..24 {
            let vk = 0x70 + i;
            let name = vk_to_key(vk).unwrap_or_else(|| panic!("VK F{} (0x{vk:02X}) should resolve", i + 1));
            assert_eq!(name, format!("F{}", i + 1));
        }
    }

    // -----------------------------------------------------------------------
    // Overflow: very long KEY_ token (no panic, just Unknown)
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_very_long_key_token_is_unknown() {
        let long = format!("KEY_{}", "A".repeat(10_000));
        assert!(matches!(
            translate_key_token(&long),
            Err(KeyTranslationError::Unknown(_))
        ));
    }

    // -----------------------------------------------------------------------
    // ModifierFlags::add_token idempotency
    // -----------------------------------------------------------------------

    #[test]
    fn modifier_add_token_idempotent() {
        let mut flags = ModifierFlags::default();
        flags.add_token("KEY_LEFT_CTRL");
        flags.add_token("KEY_LEFT_CTRL");
        assert!(flags.ctrl);
        assert!(!flags.shift);
    }

    // Concurrency: N/A — all functions are pure; Lazy statics read-only after init.
    // Temporal:    N/A — no durations in this module.
}
