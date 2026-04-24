//! Mapping tables between Razer Synapse identifiers and Sidearm equivalents.
//!
//! Covers three domains:
//! 1. InputID → Sidearm `controlId` (thumb grid, mouse buttons, scroll wheel)
//! 2. Synapse `KEY_*` token → Sidearm keyboard `key` string + modifier booleans
//! 3. Synapse `outputType` → Sidearm `actionType`

use once_cell::sync::Lazy;
use std::collections::HashMap;

// ============================================================================
// InputID → controlId
// ============================================================================

/// v4 side-panel thumb grid uses `KEY_1..KEY_9, KEY_0, KEY_HYPEN, KEY_EQUAL`
/// inside `sidePanelMappings.12ButtonSide[]`. The ordering is fixed in Synapse.
pub static THUMB_GRID_V4: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
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
pub static THUMB_GRID_DKM: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
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

/// Mouse / scroll / top buttons appear in the v4 `mappings[]` array.
pub static MOUSE_BUTTONS: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    HashMap::from([
        ("LeftClick", "mouse_left"),
        ("RightClick", "mouse_right"),
        ("MiddleClick", "wheel_click"),
        ("Mouse4", "mouse_4"),
        ("Mouse5", "mouse_5"),
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

pub static KEY_TOKEN_SPECIAL: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
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
        if rest.starts_with('F') {
            let tail = &rest[1..];
            if tail.chars().all(|c| c.is_ascii_digit()) && !tail.is_empty() {
                return Ok(rest.to_string());
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

/// Translate Synapse `mouseGroup.mouseAssignment` to a Sidearm mouse action
/// string that the runtime understands. Returns None for unsupported actions.
pub fn translate_mouse_assignment(assignment: &str) -> Option<&'static str> {
    match assignment {
        "Click" => Some("leftClick"),
        "LeftClick" => Some("leftClick"),
        "RightClick" => Some("rightClick"),
        "MiddleClick" => Some("middleClick"),
        "DoubleClick" => Some("doubleClick"),
        "ScrollUp" => Some("scrollUp"),
        "ScrollDown" => Some("scrollDown"),
        _ => None,
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
