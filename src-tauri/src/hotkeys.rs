use crate::vk::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HotkeyModifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HotkeyKey {
    pub code: u16,
    pub extended: bool,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HotkeySpec {
    pub modifiers: HotkeyModifiers,
    pub key: HotkeyKey,
    pub canonical: String,
}

pub fn parse_primary_key(raw: &str) -> Result<HotkeyKey, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Hotkey primary key must not be empty.".into());
    }

    // Normalize Cyrillic letters to the Latin key at the same physical position
    // (ЙЦУКЕН → QWERTY) so e.g. `Ctrl+С` (Cyrillic) parses as `Ctrl+C`.
    if trimmed
        .chars()
        .any(|c| matches!(c, '\u{0400}'..='\u{04FF}'))
    {
        let normalized = normalize_cyrillic_key(trimmed);
        // Guard against infinite recursion: only re-parse if normalization made
        // progress. Cyrillic letters outside the ЙЦУКЕН map are returned
        // unchanged by normalize_cyrillic_key, so without this guard a key such
        // as 'Ђ', 'Є' or 'Ї' would recurse forever → stack overflow.
        if normalized.as_str() != trimmed {
            return parse_primary_key(&normalized);
        }
        // Fall through: an unmapped Cyrillic key is unsupported and is reported
        // as such by the logic below (returns Err).
    }

    if trimmed.chars().count() == 1 {
        let ch = trimmed.chars().next().expect("single-character branch");
        return match ch {
            'a'..='z' | 'A'..='Z' => Ok(simple_key(
                ch.to_ascii_uppercase() as u16,
                false,
                &ch.to_ascii_uppercase().to_string(),
            )),
            '0'..='9' => Ok(simple_key(ch as u16, false, &ch.to_string())),
            '-' => Ok(simple_key(VK_OEM_MINUS, false, "-")),
            '=' => Ok(simple_key(VK_OEM_PLUS, false, "=")),
            ',' => Ok(simple_key(VK_OEM_COMMA, false, ",")),
            '.' => Ok(simple_key(VK_OEM_PERIOD, false, ".")),
            '/' => Ok(simple_key(VK_OEM_2, false, "/")),
            ';' => Ok(simple_key(VK_OEM_1, false, ";")),
            '\'' => Ok(simple_key(VK_OEM_7, false, "'")),
            '[' => Ok(simple_key(VK_OEM_4, false, "[")),
            ']' => Ok(simple_key(VK_OEM_6, false, "]")),
            '\\' => Ok(simple_key(VK_OEM_5, false, "\\")),
            '`' => Ok(simple_key(VK_OEM_3, false, "`")),
            '+' => Err("Hotkey primary key `+` is ambiguous. Use `=` with Shift instead.".into()),
            '_' => Err("Hotkey primary key `_` is ambiguous. Use `-` with Shift instead.".into()),
            other => Err(format!("Unsupported hotkey primary key `{other}`.")),
        };
    }

    let normalized = trimmed.to_ascii_uppercase();
    let compact = normalized.replace([' ', '_'], "");

    if let Some(function_key) = parse_function_key(&compact) {
        return Ok(function_key);
    }

    match compact.as_str() {
        "ENTER" | "RETURN" => Ok(simple_key(VK_RETURN, false, "Enter")),
        "TAB" => Ok(simple_key(VK_TAB, false, "Tab")),
        "SPACE" | "SPACEBAR" => Ok(simple_key(VK_SPACE, false, "Space")),
        "BACKSPACE" | "BKSP" => Ok(simple_key(VK_BACK, false, "Backspace")),
        "DELETE" | "DEL" => Ok(simple_key(VK_DELETE, true, "Delete")),
        "INSERT" | "INS" => Ok(simple_key(VK_INSERT, true, "Insert")),
        "ESC" | "ESCAPE" => Ok(simple_key(VK_ESCAPE, false, "Escape")),
        "HOME" => Ok(simple_key(VK_HOME, true, "Home")),
        "END" => Ok(simple_key(VK_END, true, "End")),
        "PAGEUP" | "PGUP" => Ok(simple_key(VK_PRIOR, true, "PageUp")),
        "PAGEDOWN" | "PGDOWN" | "PGDN" => Ok(simple_key(VK_NEXT, true, "PageDown")),
        "LEFT" | "LEFTARROW" => Ok(simple_key(VK_LEFT, true, "Left")),
        "RIGHT" | "RIGHTARROW" => Ok(simple_key(VK_RIGHT, true, "Right")),
        "UP" | "UPARROW" => Ok(simple_key(VK_UP, true, "Up")),
        "DOWN" | "DOWNARROW" => Ok(simple_key(VK_DOWN, true, "Down")),
        "CAPSLOCK" => Ok(simple_key(VK_CAPITAL, false, "CapsLock")),
        "NUMLOCK" => Ok(simple_key(VK_NUMLOCK, true, "NumLock")),
        "PRINTSCREEN" | "PRTSC" | "PRTSCN" => Ok(simple_key(VK_SNAPSHOT, true, "PrintScreen")),
        "SCROLLLOCK" => Ok(simple_key(VK_SCROLL, false, "ScrollLock")),
        "PAUSE" => Ok(simple_key(VK_PAUSE, false, "Pause")),
        "APPS" | "APPLICATION" | "MENU" => Ok(simple_key(VK_APPS, false, "Apps")),
        "MINUS" | "HYPHEN" => Ok(simple_key(VK_OEM_MINUS, false, "-")),
        "EQUAL" | "EQUALS" | "PLUS" => Ok(simple_key(VK_OEM_PLUS, false, "=")),
        "COMMA" => Ok(simple_key(VK_OEM_COMMA, false, ",")),
        "PERIOD" | "DOT" => Ok(simple_key(VK_OEM_PERIOD, false, ".")),
        "SLASH" | "FORWARDSLASH" => Ok(simple_key(VK_OEM_2, false, "/")),
        "SEMICOLON" => Ok(simple_key(VK_OEM_1, false, ";")),
        "APOSTROPHE" | "QUOTE" => Ok(simple_key(VK_OEM_7, false, "'")),
        "LBRACKET" | "LEFTBRACKET" => Ok(simple_key(VK_OEM_4, false, "[")),
        "RBRACKET" | "RIGHTBRACKET" => Ok(simple_key(VK_OEM_6, false, "]")),
        "BACKSLASH" => Ok(simple_key(VK_OEM_5, false, "\\")),
        "GRAVE" | "BACKTICK" => Ok(simple_key(VK_OEM_3, false, "`")),
        _ => {
            // Support raw VK codes: "VK_232" or "VK232" → VK code 232
            if let Some(code) = parse_vk_code(&compact) {
                Ok(simple_key(code, false, &format!("VK_{code}")))
            } else {
                Err(format!("Unsupported hotkey primary key `{trimmed}`."))
            }
        }
    }
}

pub fn parse_hotkey(raw: &str) -> Result<HotkeySpec, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("encodedKey must not be empty.".into());
    }

    let mut modifiers = HotkeyModifiers::default();
    let mut primary_key: Option<HotkeyKey> = None;

    for token in trimmed
        .split('+')
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        match normalize_modifier_token(token) {
            Some(ModifierToken::Ctrl) => {
                if modifiers.ctrl {
                    return Err("encodedKey contains duplicate Ctrl modifier.".into());
                }
                modifiers.ctrl = true;
            }
            Some(ModifierToken::Alt) => {
                if modifiers.alt {
                    return Err("encodedKey contains duplicate Alt modifier.".into());
                }
                modifiers.alt = true;
            }
            Some(ModifierToken::Shift) => {
                if modifiers.shift {
                    return Err("encodedKey contains duplicate Shift modifier.".into());
                }
                modifiers.shift = true;
            }
            Some(ModifierToken::Win) => {
                if modifiers.win {
                    return Err("encodedKey contains duplicate Win modifier.".into());
                }
                modifiers.win = true;
            }
            None => {
                if primary_key.is_some() {
                    return Err("encodedKey must contain exactly one non-modifier key.".into());
                }
                primary_key = Some(parse_primary_key(token)?);
            }
        }
    }

    let primary_key = primary_key
        .ok_or_else(|| "encodedKey must contain one non-modifier primary key.".to_owned())?;

    let mut parts = Vec::new();
    if modifiers.ctrl {
        parts.push("Ctrl".to_owned());
    }
    if modifiers.alt {
        parts.push("Alt".to_owned());
    }
    if modifiers.shift {
        parts.push("Shift".to_owned());
    }
    if modifiers.win {
        parts.push("Win".to_owned());
    }
    parts.push(primary_key.display_name.clone());

    Ok(HotkeySpec {
        modifiers,
        key: primary_key,
        canonical: parts.join("+"),
    })
}

pub fn normalize_hotkey(raw: &str) -> Result<String, String> {
    parse_hotkey(raw).map(|hotkey| hotkey.canonical)
}

/// Extract which modifiers are part of the Synapse encoding for a given
/// `encodedKey` string (e.g. `"Ctrl+Alt+F13"` → ctrl=true, alt=true).
///
/// These modifiers are injected by the Razer driver when the mouse button is
/// pressed and must be cleared before action execution. Any modifier NOT in
/// this mask is presumed to be a user's physical keyboard modifier and should
/// pass through to the action.
pub fn extract_encoding_modifiers(encoded_key: &str) -> HotkeyModifiers {
    match parse_hotkey(encoded_key) {
        Ok(spec) => spec.modifiers,
        Err(_) => HotkeyModifiers::default(),
    }
}

fn simple_key(code: u16, extended: bool, display_name: &str) -> HotkeyKey {
    HotkeyKey {
        code,
        extended,
        display_name: display_name.into(),
    }
}

fn parse_function_key(compact: &str) -> Option<HotkeyKey> {
    let digits = compact.strip_prefix('F')?;
    let number: u16 = digits.parse().ok()?;
    if !(1..=24).contains(&number) {
        return None;
    }

    Some(simple_key(
        0x70 + (number - 1),
        false,
        &format!("F{number}"),
    ))
}

enum ModifierToken {
    Ctrl,
    Alt,
    Shift,
    Win,
}

fn normalize_modifier_token(token: &str) -> Option<ModifierToken> {
    match token.trim().to_ascii_uppercase().as_str() {
        "CTRL" | "CONTROL" => Some(ModifierToken::Ctrl),
        "ALT" => Some(ModifierToken::Alt),
        "SHIFT" => Some(ModifierToken::Shift),
        "WIN" | "WINDOWS" | "META" => Some(ModifierToken::Win),
        _ => None,
    }
}

/// Parse raw VK code from format "VK232" or "VK_232" (after normalization removes underscores).
fn parse_vk_code(compact: &str) -> Option<u16> {
    let digits = compact.strip_prefix("VK")?;
    let code: u16 = digits.parse().ok()?;
    if code == 0 {
        return None;
    }
    Some(code)
}

/// Map Cyrillic characters to the QWERTY key at the same physical position on a
/// standard ЙЦУКЕН keyboard layout.  Users often capture shortcuts with the
/// Russian layout active, producing 'С' (Cyrillic) instead of 'C' (Latin) for
/// Ctrl+C — this reverses that by physical key position.  The table is static
/// and layout-independent, so it is safe to apply during validation.
fn normalize_cyrillic_key(key: &str) -> String {
    key.chars()
        .map(|ch| match ch {
            // Row 0: Ё → `
            'ё' | 'Ё' => '`',
            // Row 1: Й Ц У К Е Н Г Ш Щ З Х Ъ → Q W E R T Y U I O P [ ]
            'й' | 'Й' => 'Q',
            'ц' | 'Ц' => 'W',
            'у' | 'У' => 'E',
            'к' | 'К' => 'R',
            'е' | 'Е' => 'T',
            'н' | 'Н' => 'Y',
            'г' | 'Г' => 'U',
            'ш' | 'Ш' => 'I',
            'щ' | 'Щ' => 'O',
            'з' | 'З' => 'P',
            'х' | 'Х' => '[',
            'ъ' | 'Ъ' => ']',
            // Row 2: Ф Ы В А П Р О Л Д Ж Э → A S D F G H J K L ; '
            'ф' | 'Ф' => 'A',
            'ы' | 'Ы' => 'S',
            'в' | 'В' => 'D',
            'а' | 'А' => 'F',
            'п' | 'П' => 'G',
            'р' | 'Р' => 'H',
            'о' | 'О' => 'J',
            'л' | 'Л' => 'K',
            'д' | 'Д' => 'L',
            'ж' | 'Ж' => ';',
            'э' | 'Э' => '\'',
            // Row 3: Я Ч С М И Т Ь Б Ю → Z X C V B N M , .
            'я' | 'Я' => 'Z',
            'ч' | 'Ч' => 'X',
            'с' | 'С' => 'C',
            'м' | 'М' => 'V',
            'и' | 'И' => 'B',
            'т' | 'Т' => 'N',
            'ь' | 'Ь' => 'M',
            'б' | 'Б' => ',',
            'ю' | 'Ю' => '.',
            _ => ch,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_seed_hypershift_hotkey() {
        let parsed = parse_hotkey(" Ctrl + Alt + Shift + f13 ").expect("expected hotkey");
        assert_eq!(parsed.canonical, "Ctrl+Alt+Shift+F13");
        assert!(parsed.modifiers.ctrl);
        assert!(parsed.modifiers.alt);
        assert!(parsed.modifiers.shift);
        assert_eq!(parsed.key.display_name, "F13");
    }

    #[test]
    fn rejects_multiple_primary_keys() {
        let error = parse_hotkey("Ctrl+F13+F14").expect_err("expected invalid hotkey");
        assert!(error.contains("exactly one non-modifier"));
    }

    #[test]
    fn parses_named_primary_keys() {
        let parsed = parse_hotkey("Shift+Enter").expect("expected enter hotkey");
        assert_eq!(parsed.canonical, "Shift+Enter");
        assert_eq!(parsed.key.code, VK_RETURN);
    }

    #[test]
    fn extracts_encoding_modifiers_from_combo_key() {
        let mods = extract_encoding_modifiers("Ctrl+Alt+F13");
        assert!(mods.ctrl);
        assert!(mods.alt);
        assert!(!mods.shift);
        assert!(!mods.win);
    }

    #[test]
    fn extracts_no_encoding_modifiers_from_bare_key() {
        let mods = extract_encoding_modifiers("F13");
        assert!(!mods.ctrl);
        assert!(!mods.alt);
        assert!(!mods.shift);
        assert!(!mods.win);
    }

    #[test]
    fn extracts_encoding_modifiers_returns_default_for_invalid() {
        let mods = extract_encoding_modifiers("+++garbage");
        assert_eq!(mods, HotkeyModifiers::default());
    }

    #[test]
    fn parses_raw_vk_code() {
        let parsed = parse_hotkey("Ctrl+Alt+VK_232").expect("expected hotkey with VK code");
        assert_eq!(parsed.canonical, "Ctrl+Alt+VK_232");
        assert!(parsed.modifiers.ctrl);
        assert!(parsed.modifiers.alt);
        assert_eq!(parsed.key.code, 232);
    }

    #[test]
    fn parses_raw_vk_code_bare() {
        let parsed = parse_hotkey("VK_128").expect("expected bare VK code");
        assert_eq!(parsed.canonical, "VK_128");
        assert_eq!(parsed.key.code, 128);
    }

    #[test]
    fn parses_cyrillic_primary_key() {
        // Cyrillic 'С' (U+0421) → Latin 'C' via the static ЙЦУКЕН table.
        let parsed = parse_hotkey("Ctrl+С").expect("expected cyrillic hotkey");
        assert!(parsed.modifiers.ctrl);
        assert_eq!(parsed.key.display_name, "C");
        assert_eq!(parsed.canonical, "Ctrl+C");
    }
}
