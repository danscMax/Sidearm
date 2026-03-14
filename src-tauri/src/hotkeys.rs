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
    let compact = normalized.replace(' ', "").replace('_', "");

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

impl HotkeyModifiers {
    pub fn register_hotkey_mask(self) -> u32 {
        let mut mask = MOD_NOREPEAT;
        if self.alt {
            mask |= MOD_ALT;
        }
        if self.ctrl {
            mask |= MOD_CONTROL;
        }
        if self.shift {
            mask |= MOD_SHIFT;
        }
        if self.win {
            mask |= MOD_WIN;
        }
        mask
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

const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_WIN: u32 = 0x0008;
const MOD_NOREPEAT: u32 = 0x4000;

const VK_BACK: u16 = 0x08;
const VK_TAB: u16 = 0x09;
const VK_RETURN: u16 = 0x0D;
const VK_PAUSE: u16 = 0x13;
const VK_CAPITAL: u16 = 0x14;
const VK_ESCAPE: u16 = 0x1B;
const VK_SPACE: u16 = 0x20;
const VK_PRIOR: u16 = 0x21;
const VK_NEXT: u16 = 0x22;
const VK_END: u16 = 0x23;
const VK_HOME: u16 = 0x24;
const VK_LEFT: u16 = 0x25;
const VK_UP: u16 = 0x26;
const VK_RIGHT: u16 = 0x27;
const VK_DOWN: u16 = 0x28;
const VK_SNAPSHOT: u16 = 0x2C;
const VK_INSERT: u16 = 0x2D;
const VK_DELETE: u16 = 0x2E;
const VK_APPS: u16 = 0x5D;
const VK_NUMLOCK: u16 = 0x90;
const VK_SCROLL: u16 = 0x91;
const VK_OEM_1: u16 = 0xBA;
const VK_OEM_PLUS: u16 = 0xBB;
const VK_OEM_COMMA: u16 = 0xBC;
const VK_OEM_MINUS: u16 = 0xBD;
const VK_OEM_PERIOD: u16 = 0xBE;
const VK_OEM_2: u16 = 0xBF;
const VK_OEM_3: u16 = 0xC0;
const VK_OEM_4: u16 = 0xDB;
const VK_OEM_5: u16 = 0xDC;
const VK_OEM_6: u16 = 0xDD;
const VK_OEM_7: u16 = 0xDE;

/// Parse raw VK code from format "VK232" or "VK_232" (after normalization removes underscores).
fn parse_vk_code(compact: &str) -> Option<u16> {
    let digits = compact.strip_prefix("VK")?;
    let code: u16 = digits.parse().ok()?;
    if code == 0 {
        return None;
    }
    Some(code)
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
}
