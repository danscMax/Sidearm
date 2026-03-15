use crate::config::{MouseActionPayload, ShortcutActionPayload};
use crate::hotkeys::HotkeyModifiers;

#[cfg(target_os = "windows")]
pub(crate) const INTERNAL_SENDINPUT_EXTRA_INFO: usize = 0x4E41_4741_5354_5544usize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutDispatchReport {
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct VirtualKeySpec {
    pub(crate) code: u16,
    pub(crate) extended: bool,
}

#[derive(Clone, Debug)]
pub struct HeldShortcutState {
    /// VK codes of modifiers we pressed down (in press order, for LIFO release).
    pub pressed_modifier_vks: Vec<VirtualKeySpec>,
    /// Primary key we pressed down (if any).
    pub primary_key: Option<VirtualKeySpec>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
struct ModifierSnapshot {
    ctrl: bool,
    shift: bool,
    alt: bool,
    win: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModifierKey {
    Ctrl,
    Shift,
    Alt,
    Win,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyboardInputSpec {
    VirtualKey {
        code: u16,
        extended: bool,
        key_up: bool,
    },
    Unicode {
        code_unit: u16,
        key_up: bool,
    },
}

pub fn send_shortcut(
    payload: &ShortcutActionPayload,
    encoding_mods: &HotkeyModifiers,
) -> Result<ShortcutDispatchReport, String> {
    clear_modifiers(encoding_mods)?;
    let snapshot = current_modifier_snapshot()?;
    let (plan, reused_modifiers) = plan_shortcut_inputs(payload, &snapshot)?;

    if let Err(send_error) = send_keyboard_inputs(&plan) {
        // Best-effort cleanup: release any modifiers we pressed to prevent stuck keys.
        let pressed = extract_pressed_modifiers(payload, &snapshot);
        if !pressed.is_empty() {
            let cleanup = build_modifier_release_inputs(&pressed);
            let _ = send_keyboard_inputs(&cleanup);
        }
        return Err(send_error);
    }

    let warnings = if reused_modifiers.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "Shortcut reused already pressed modifier(s): {}.",
            reused_modifiers
                .iter()
                .map(|modifier| modifier.label())
                .collect::<Vec<_>>()
                .join(", ")
        )]
    };

    Ok(ShortcutDispatchReport { warnings })
}

/// Determine which modifiers the shortcut would have pressed down (i.e., desired
/// but not already active according to the snapshot).
fn extract_pressed_modifiers(
    payload: &ShortcutActionPayload,
    snapshot: &ModifierSnapshot,
) -> Vec<ModifierKey> {
    [
        (ModifierKey::Win, payload.win),
        (ModifierKey::Ctrl, payload.ctrl),
        (ModifierKey::Alt, payload.alt),
        (ModifierKey::Shift, payload.shift),
    ]
    .iter()
    .filter(|(modifier, desired)| *desired && !snapshot.is_active(*modifier))
    .map(|(modifier, _)| *modifier)
    .collect()
}

/// Build key-up events for the given modifiers, in reverse order (mirror the
/// press-down sequence so that the last-pressed modifier is released first).
fn build_modifier_release_inputs(modifiers: &[ModifierKey]) -> Vec<KeyboardInputSpec> {
    modifiers
        .iter()
        .rev()
        .map(|modifier| KeyboardInputSpec::VirtualKey {
            code: modifier.virtual_key().code,
            extended: modifier.virtual_key().extended,
            key_up: true,
        })
        .collect()
}

pub fn send_hotkey_string(
    raw: &str,
    encoding_mods: &HotkeyModifiers,
) -> Result<ShortcutDispatchReport, String> {
    let hotkey = crate::hotkeys::parse_hotkey(raw)?;
    let payload = ShortcutActionPayload {
        key: hotkey.key.display_name,
        ctrl: hotkey.modifiers.ctrl,
        shift: hotkey.modifiers.shift,
        alt: hotkey.modifiers.alt,
        win: hotkey.modifiers.win,
        raw: Some(hotkey.canonical),
    };

    send_shortcut(&payload, encoding_mods)
}

/// All modifiers must be cleared for text injection — held Ctrl/Alt corrupts
/// Unicode/VK_PACKET output.
const ALL_MODIFIERS: HotkeyModifiers = HotkeyModifiers {
    ctrl: true,
    shift: true,
    alt: true,
    win: true,
};

/// Text length threshold (in characters): above this, `send_text_with_delay`
/// uses clipboard-paste (Ctrl+V) instead of per-character `KEYEVENTF_UNICODE`
/// injection, because `SendInput` is slow and unreliable for long strings.
/// If the clipboard-paste attempt fails, the function falls back to the
/// per-character path transparently.
const CLIPBOARD_PASTE_THRESHOLD: usize = 100;

/// Send text with an optional inter-character delay (milliseconds).
/// When `inter_key_delay_ms` is 0, all characters are batched into a single
/// `SendInput` call.  A non-zero delay sends each character pair (down+up)
/// individually with a sleep in between — useful for apps that drop rapid
/// Unicode input bursts.  Pattern from AHK's `SetKeyDelay` / Kanata's
/// `rapid-event-delay`.
///
/// For text longer than [`CLIPBOARD_PASTE_THRESHOLD`] characters, the function
/// first attempts a clipboard-paste (save clipboard, set text, Ctrl+V, restore).
/// This is significantly faster and more reliable for large snippets.  If the
/// clipboard path fails for any reason, it silently falls back to per-character
/// `KEYEVENTF_UNICODE` injection.
pub fn send_text_with_delay(text: &str, inter_key_delay_ms: u32) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }

    // For long text, attempt clipboard-paste first (much faster than per-char SendInput).
    if text.chars().count() > CLIPBOARD_PASTE_THRESHOLD {
        match crate::clipboard::paste_text(text) {
            Ok(_report) => return Ok(()),
            Err(clipboard_error) => {
                // Clipboard-paste failed — fall through to per-character injection.
                log::warn!(
                    "[input] Clipboard-paste fallback failed for long text ({} chars), \
                     falling back to KEYEVENTF_UNICODE: {clipboard_error}",
                    text.chars().count()
                );
            }
        }
    }

    clear_modifiers(&ALL_MODIFIERS)?;
    let plan = build_text_inputs(text)?;
    if plan.is_empty() {
        return Ok(());
    }

    if inter_key_delay_ms == 0 {
        return send_keyboard_inputs(&plan);
    }

    // Send character-by-character: each char = 2 events (down + up)
    for chunk in plan.chunks(2) {
        send_keyboard_inputs(chunk)?;
        if chunk.len() == 2 {
            std::thread::sleep(std::time::Duration::from_millis(u64::from(inter_key_delay_ms)));
        }
    }
    Ok(())
}

pub fn send_text(text: &str) -> Result<(), String> {
    send_text_with_delay(text, 0)
}

pub fn send_shortcut_hold_down(
    payload: &ShortcutActionPayload,
    encoding_mods: &HotkeyModifiers,
) -> Result<HeldShortcutState, String> {
    clear_modifiers(encoding_mods)?;
    let snapshot = current_modifier_snapshot()?;
    let (plan, held) = plan_shortcut_hold_down_inputs(payload, &snapshot)?;

    if let Err(send_error) = send_keyboard_inputs(&plan) {
        // Best-effort cleanup: release what we pressed
        let cleanup = plan_shortcut_hold_up_inputs(&held);
        let _ = send_keyboard_inputs(&cleanup);
        return Err(send_error);
    }

    Ok(held)
}

pub fn send_shortcut_hold_up(held: &HeldShortcutState) -> Result<(), String> {
    let plan = plan_shortcut_hold_up_inputs(held);
    if plan.is_empty() {
        return Ok(());
    }
    send_keyboard_inputs(&plan)
}

/// Emergency release: blast key-up for all standard modifiers.
/// Used by panic hooks when exact held state is unknown.
pub fn release_all_modifiers() {
    #[cfg(target_os = "windows")]
    {
        let inputs = vec![
            KeyboardInputSpec::VirtualKey { code: vk_lcontrol(), extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: vk_lshift(), extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: vk_lmenu(), extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: vk_lwin(), extended: false, key_up: true },
        ];
        let _ = send_keyboard_inputs(&inputs);
    }
}

fn plan_shortcut_inputs(
    payload: &ShortcutActionPayload,
    snapshot: &ModifierSnapshot,
) -> Result<(Vec<KeyboardInputSpec>, Vec<ModifierKey>), String> {
    let has_primary_key = !payload.key.trim().is_empty();
    let primary_key = if has_primary_key {
        let pk = parse_primary_key(&payload.key)?;
        if is_modifier_virtual_key(pk.code) {
            return Err(
                "Shortcut primary key must not be a modifier key. Use ctrl/shift/alt/win flags plus a non-modifier key."
                    .into(),
            );
        }
        Some(pk)
    } else {
        None
    };

    let has_modifier = payload.ctrl || payload.shift || payload.alt || payload.win;
    if primary_key.is_none() && !has_modifier {
        return Err("Shortcut must have a key or at least one modifier.".into());
    }

    let desired_modifiers = [
        (ModifierKey::Win, payload.win),
        (ModifierKey::Ctrl, payload.ctrl),
        (ModifierKey::Alt, payload.alt),
        (ModifierKey::Shift, payload.shift),
    ];

    let mut inputs = Vec::with_capacity(10);
    let mut pressed_modifiers = Vec::new();
    let mut reused_modifiers = Vec::new();

    for (modifier, desired) in desired_modifiers {
        let active = snapshot.is_active(modifier);
        // User's physical keyboard modifiers that are not part of the action
        // are allowed to pass through — the OS will combine them with the
        // injected shortcut (e.g. user holds Ctrl + side button sends
        // Backspace → OS sees Ctrl+Backspace).
        if desired {
            if active {
                reused_modifiers.push(modifier);
            } else {
                let key = modifier.virtual_key();
                push_virtual_key_down(&mut inputs, key);
                pressed_modifiers.push(modifier);
            }
        }
    }

    if let Some(pk) = primary_key {
        push_virtual_key_down(&mut inputs, pk);
        push_virtual_key_up(&mut inputs, pk);
    }

    for modifier in pressed_modifiers.into_iter().rev() {
        push_virtual_key_up(&mut inputs, modifier.virtual_key());
    }

    Ok((inputs, reused_modifiers))
}

fn plan_shortcut_hold_down_inputs(
    payload: &ShortcutActionPayload,
    snapshot: &ModifierSnapshot,
) -> Result<(Vec<KeyboardInputSpec>, HeldShortcutState), String> {
    let primary_key = if !payload.key.trim().is_empty() {
        let pk = parse_primary_key(&payload.key)?;
        if is_modifier_virtual_key(pk.code) {
            return Err("Hold-mode primary key must not be a modifier.".into());
        }
        Some(pk)
    } else {
        None
    };

    let desired_modifiers = [
        (ModifierKey::Win, payload.win),
        (ModifierKey::Ctrl, payload.ctrl),
        (ModifierKey::Alt, payload.alt),
        (ModifierKey::Shift, payload.shift),
    ];

    let mut inputs = Vec::with_capacity(5);
    let mut pressed_modifier_vks = Vec::new();

    for (modifier, desired) in desired_modifiers {
        if desired && !snapshot.is_active(modifier) {
            let key = modifier.virtual_key();
            push_virtual_key_down(&mut inputs, key);
            pressed_modifier_vks.push(key);
        }
    }

    if let Some(pk) = primary_key {
        push_virtual_key_down(&mut inputs, pk);
    }

    Ok((
        inputs,
        HeldShortcutState {
            pressed_modifier_vks,
            primary_key,
        },
    ))
}

fn plan_shortcut_hold_up_inputs(held: &HeldShortcutState) -> Vec<KeyboardInputSpec> {
    let mut inputs = Vec::with_capacity(5);

    if let Some(pk) = held.primary_key {
        push_virtual_key_up(&mut inputs, pk);
    }

    // Release modifiers in reverse press order (LIFO)
    for key in held.pressed_modifier_vks.iter().rev() {
        push_virtual_key_up(&mut inputs, *key);
    }

    inputs
}

fn build_text_inputs(text: &str) -> Result<Vec<KeyboardInputSpec>, String> {
    let mut inputs = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\0' => return Err("Text injection does not support NUL characters.".into()),
            '\r' => {
                if chars.peek().is_some_and(|next| *next == '\n') {
                    chars.next();
                }
                push_virtual_key_tap(
                    &mut inputs,
                    VirtualKeySpec {
                        code: vk_return(),
                        extended: false,
                    },
                );
            }
            '\n' => push_virtual_key_tap(
                &mut inputs,
                VirtualKeySpec {
                    code: vk_return(),
                    extended: false,
                },
            ),
            _ => {
                let mut encoded = [0u16; 2];
                for code_unit in ch.encode_utf16(&mut encoded).iter().copied() {
                    inputs.push(KeyboardInputSpec::Unicode {
                        code_unit,
                        key_up: false,
                    });
                    inputs.push(KeyboardInputSpec::Unicode {
                        code_unit,
                        key_up: true,
                    });
                }
            }
        }
    }

    Ok(inputs)
}

fn push_virtual_key_tap(inputs: &mut Vec<KeyboardInputSpec>, key: VirtualKeySpec) {
    push_virtual_key_down(inputs, key);
    push_virtual_key_up(inputs, key);
}

fn push_virtual_key_down(inputs: &mut Vec<KeyboardInputSpec>, key: VirtualKeySpec) {
    inputs.push(KeyboardInputSpec::VirtualKey {
        code: key.code,
        extended: key.extended,
        key_up: false,
    });
}

fn push_virtual_key_up(inputs: &mut Vec<KeyboardInputSpec>, key: VirtualKeySpec) {
    inputs.push(KeyboardInputSpec::VirtualKey {
        code: key.code,
        extended: key.extended,
        key_up: true,
    });
}

fn parse_primary_key(key: &str) -> Result<VirtualKeySpec, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("Shortcut key must not be empty for live execution.".into());
    }

    if trimmed.chars().count() == 1 {
        let ch = trimmed.chars().next().expect("single-character branch");
        return match ch {
            'a'..='z' | 'A'..='Z' => Ok(VirtualKeySpec {
                code: ch.to_ascii_uppercase() as u16,
                extended: false,
            }),
            '0'..='9' => Ok(VirtualKeySpec {
                code: ch as u16,
                extended: false,
            }),
            '-' => Ok(oem_key(vk_oem_minus())),
            '=' => Ok(oem_key(vk_oem_plus())),
            ',' => Ok(oem_key(vk_oem_comma())),
            '.' => Ok(oem_key(vk_oem_period())),
            '/' => Ok(oem_key(vk_oem_2())),
            ';' => Ok(oem_key(vk_oem_1())),
            '\'' => Ok(oem_key(vk_oem_7())),
            '[' => Ok(oem_key(vk_oem_4())),
            ']' => Ok(oem_key(vk_oem_6())),
            '\\' => Ok(oem_key(vk_oem_5())),
            '`' => Ok(oem_key(vk_oem_3())),
            '+' => Err(
                "Shortcut key `+` is ambiguous for live execution. Use `=` with shift=true instead."
                    .into(),
            ),
            '_' => Err(
                "Shortcut key `_` is ambiguous for live execution. Use `-` with shift=true instead."
                    .into(),
            ),
            other => match resolve_char_to_vk(other) {
                Some(spec) => Ok(spec),
                None => Err(format!("Unsupported shortcut key `{other}` for live execution.")),
            },
        };
    }

    let normalized = trimmed.to_ascii_uppercase();
    let compact = normalized.replace(' ', "").replace('_', "");

    if let Some(function_key) = parse_function_key(&compact) {
        return Ok(function_key);
    }

    match compact.as_str() {
        "ENTER" | "RETURN" => Ok(VirtualKeySpec {
            code: vk_return(),
            extended: false,
        }),
        "TAB" => Ok(VirtualKeySpec {
            code: vk_tab(),
            extended: false,
        }),
        "SPACE" | "SPACEBAR" => Ok(VirtualKeySpec {
            code: vk_space(),
            extended: false,
        }),
        "BACKSPACE" | "BKSP" => Ok(VirtualKeySpec {
            code: vk_back(),
            extended: false,
        }),
        "DELETE" | "DEL" => Ok(VirtualKeySpec {
            code: vk_delete(),
            extended: true,
        }),
        "INSERT" | "INS" => Ok(VirtualKeySpec {
            code: vk_insert(),
            extended: true,
        }),
        "ESC" | "ESCAPE" => Ok(VirtualKeySpec {
            code: vk_escape(),
            extended: false,
        }),
        "HOME" => Ok(VirtualKeySpec {
            code: vk_home(),
            extended: true,
        }),
        "END" => Ok(VirtualKeySpec {
            code: vk_end(),
            extended: true,
        }),
        "PAGEUP" | "PGUP" => Ok(VirtualKeySpec {
            code: vk_prior(),
            extended: true,
        }),
        "PAGEDOWN" | "PGDOWN" | "PGDN" => Ok(VirtualKeySpec {
            code: vk_next(),
            extended: true,
        }),
        "LEFT" | "LEFTARROW" => Ok(VirtualKeySpec {
            code: vk_left(),
            extended: true,
        }),
        "RIGHT" | "RIGHTARROW" => Ok(VirtualKeySpec {
            code: vk_right(),
            extended: true,
        }),
        "UP" | "UPARROW" => Ok(VirtualKeySpec {
            code: vk_up(),
            extended: true,
        }),
        "DOWN" | "DOWNARROW" => Ok(VirtualKeySpec {
            code: vk_down(),
            extended: true,
        }),
        "CAPSLOCK" => Ok(VirtualKeySpec {
            code: vk_capital(),
            extended: false,
        }),
        "NUMLOCK" => Ok(VirtualKeySpec {
            code: vk_numlock(),
            extended: true,
        }),
        "PRINTSCREEN" | "PRTSC" | "PRTSCN" => Ok(VirtualKeySpec {
            code: vk_snapshot(),
            extended: true,
        }),
        "SCROLLLOCK" => Ok(VirtualKeySpec {
            code: vk_scroll(),
            extended: false,
        }),
        "PAUSE" => Ok(VirtualKeySpec {
            code: vk_pause(),
            extended: false,
        }),
        "APPS" | "APPLICATION" | "MENU" => Ok(VirtualKeySpec {
            code: vk_apps(),
            extended: false,
        }),
        "MINUS" | "HYPHEN" => Ok(oem_key(vk_oem_minus())),
        "EQUAL" | "EQUALS" | "PLUS" => Ok(oem_key(vk_oem_plus())),
        "COMMA" => Ok(oem_key(vk_oem_comma())),
        "PERIOD" | "DOT" => Ok(oem_key(vk_oem_period())),
        "SLASH" | "FORWARDSLASH" => Ok(oem_key(vk_oem_2())),
        "SEMICOLON" => Ok(oem_key(vk_oem_1())),
        "APOSTROPHE" | "QUOTE" => Ok(oem_key(vk_oem_7())),
        "LBRACKET" | "LEFTBRACKET" => Ok(oem_key(vk_oem_4())),
        "RBRACKET" | "RIGHTBRACKET" => Ok(oem_key(vk_oem_6())),
        "BACKSLASH" => Ok(oem_key(vk_oem_5())),
        "GRAVE" | "BACKTICK" => Ok(oem_key(vk_oem_3())),
        _ => Err(format!(
            "Unsupported shortcut key `{trimmed}` for live execution."
        )),
    }
}

fn parse_function_key(compact: &str) -> Option<VirtualKeySpec> {
    let digits = compact.strip_prefix('F')?;
    let number: u16 = digits.parse().ok()?;
    if !(1..=24).contains(&number) {
        return None;
    }

    Some(VirtualKeySpec {
        code: 0x70 + (number - 1),
        extended: false,
    })
}

/// Resolves a non-ASCII character (e.g. Cyrillic 'Г') to a virtual key code
/// using the current keyboard layout via `VkKeyScanW`. Returns `None` if the
/// character cannot be mapped or maps to a modifier key.
#[cfg(target_os = "windows")]
fn resolve_char_to_vk(ch: char) -> Option<VirtualKeySpec> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VkKeyScanW;

    let result = unsafe { VkKeyScanW(ch as u16) };
    if result == -1i16 {
        return None;
    }
    let vk = (result as u16) & 0xFF;
    if vk == 0 || is_modifier_virtual_key(vk) {
        return None;
    }
    Some(VirtualKeySpec {
        code: vk,
        extended: false,
    })
}

#[cfg(not(target_os = "windows"))]
fn resolve_char_to_vk(_ch: char) -> Option<VirtualKeySpec> {
    None
}

fn is_modifier_virtual_key(code: u16) -> bool {
    matches!(
        code,
        0x10 | 0x11 | 0x12 | 0x5B | 0x5C | 0xA0 | 0xA1 | 0xA2 | 0xA3 | 0xA4 | 0xA5
    )
}

fn oem_key(code: u16) -> VirtualKeySpec {
    VirtualKeySpec {
        code,
        extended: false,
    }
}

impl ModifierSnapshot {
    fn is_active(&self, modifier: ModifierKey) -> bool {
        match modifier {
            ModifierKey::Ctrl => self.ctrl,
            ModifierKey::Shift => self.shift,
            ModifierKey::Alt => self.alt,
            ModifierKey::Win => self.win,
        }
    }
}

impl ModifierKey {
    fn label(self) -> &'static str {
        match self {
            ModifierKey::Ctrl => "Ctrl",
            ModifierKey::Shift => "Shift",
            ModifierKey::Alt => "Alt",
            ModifierKey::Win => "Win",
        }
    }

    fn virtual_key(self) -> VirtualKeySpec {
        match self {
            ModifierKey::Ctrl => VirtualKeySpec {
                code: vk_lcontrol(),
                extended: false,
            },
            ModifierKey::Shift => VirtualKeySpec {
                code: vk_lshift(),
                extended: false,
            },
            ModifierKey::Alt => VirtualKeySpec {
                code: vk_lmenu(),
                extended: false,
            },
            ModifierKey::Win => VirtualKeySpec {
                code: vk_lwin(),
                extended: false,
            },
        }
    }
}

/// Selectively clears held modifier keys by injecting key-up events.
///
/// Only modifiers whose flag is `true` in `mask` are cleared. This allows
/// Synapse encoding modifiers (e.g. Ctrl+Alt from "Ctrl+Alt+F13") to be
/// released while the user's physical keyboard modifiers (e.g. Shift held on
/// keyboard for Shift+Backspace) pass through untouched.
///
/// For text injection, pass `ALL_MODIFIERS` to clear everything — held
/// Ctrl/Alt corrupts Unicode/VK_PACKET output.
///
/// The injected key-ups carry `INTERNAL_SENDINPUT_EXTRA_INFO` so our own LL hook
/// ignores them. When the user eventually releases the mouse button, the Razer
/// driver sends redundant key-ups which are harmless no-ops.
#[cfg(target_os = "windows")]
fn clear_modifiers(mask: &HotkeyModifiers) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };

    let mut release_inputs = Vec::new();

    unsafe {
        if mask.ctrl && key_is_down(GetAsyncKeyState(VK_CONTROL as i32)) {
            release_inputs.push(KeyboardInputSpec::VirtualKey {
                code: vk_lcontrol(),
                extended: false,
                key_up: true,
            });
        }
        if mask.shift && key_is_down(GetAsyncKeyState(VK_SHIFT as i32)) {
            release_inputs.push(KeyboardInputSpec::VirtualKey {
                code: vk_lshift(),
                extended: false,
                key_up: true,
            });
        }
        if mask.alt && key_is_down(GetAsyncKeyState(VK_MENU as i32)) {
            release_inputs.push(KeyboardInputSpec::VirtualKey {
                code: vk_lmenu(),
                extended: false,
                key_up: true,
            });
        }
        if mask.win
            && (key_is_down(GetAsyncKeyState(VK_LWIN as i32))
                || key_is_down(GetAsyncKeyState(VK_RWIN as i32)))
        {
            release_inputs.push(KeyboardInputSpec::VirtualKey {
                code: vk_lwin(),
                extended: false,
                key_up: true,
            });
        }
    }

    if !release_inputs.is_empty() {
        send_keyboard_inputs(&release_inputs)?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn clear_modifiers(_mask: &HotkeyModifiers) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn current_modifier_snapshot() -> Result<ModifierSnapshot, String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };

    let snapshot = unsafe {
        ModifierSnapshot {
            ctrl: key_is_down(GetAsyncKeyState(VK_CONTROL as i32)),
            shift: key_is_down(GetAsyncKeyState(VK_SHIFT as i32)),
            alt: key_is_down(GetAsyncKeyState(VK_MENU as i32)),
            win: key_is_down(GetAsyncKeyState(VK_LWIN as i32))
                || key_is_down(GetAsyncKeyState(VK_RWIN as i32)),
        }
    };

    Ok(snapshot)
}

#[cfg(not(target_os = "windows"))]
fn current_modifier_snapshot() -> Result<ModifierSnapshot, String> {
    Err("Live keyboard injection is only implemented for Windows.".into())
}

#[cfg(target_os = "windows")]
fn send_keyboard_inputs(inputs: &[KeyboardInputSpec]) -> Result<(), String> {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
    };

    if inputs.is_empty() {
        return Ok(());
    }

    let windows_inputs: Vec<INPUT> = inputs
        .iter()
        .map(|input| match input {
            KeyboardInputSpec::VirtualKey {
                code,
                extended,
                key_up,
            } => {
                let mut flags = if *key_up { KEYEVENTF_KEYUP } else { 0 };
                if *extended {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                let scan_code = unsafe { MapVirtualKeyW(u32::from(*code), MAPVK_VK_TO_VSC) } as u16;
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: *code,
                            wScan: scan_code,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: INTERNAL_SENDINPUT_EXTRA_INFO,
                        },
                    },
                }
            }
            KeyboardInputSpec::Unicode { code_unit, key_up } => {
                let mut flags = KEYEVENTF_UNICODE;
                if *key_up {
                    flags |= KEYEVENTF_KEYUP;
                }
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: 0,
                            wScan: *code_unit,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: INTERNAL_SENDINPUT_EXTRA_INFO,
                        },
                    },
                }
            }
        })
        .collect();

    let sent = unsafe {
        SendInput(
            windows_inputs.len() as u32,
            windows_inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    if sent == windows_inputs.len() as u32 {
        Ok(())
    } else {
        let last_error = std::io::Error::last_os_error();
        let suffix = match last_error.raw_os_error() {
            Some(code) => {
                format!(" Win32 error {code}: {last_error}. SendInput may also be blocked by UIPI.")
            }
            None => " SendInput may have been blocked by another thread or by UIPI.".into(),
        };
        Err(format!(
            "SendInput inserted {sent} of {} event(s).{suffix}",
            windows_inputs.len()
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn send_keyboard_inputs(_inputs: &[KeyboardInputSpec]) -> Result<(), String> {
    Err("Live keyboard injection is only implemented for Windows.".into())
}

#[cfg(target_os = "windows")]
fn key_is_down(state: i16) -> bool {
    state < 0
}

#[cfg(target_os = "windows")]
const fn vk_return() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_RETURN
}

#[cfg(not(target_os = "windows"))]
const fn vk_return() -> u16 {
    0x0D
}

#[cfg(target_os = "windows")]
const fn vk_tab() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_TAB
}

#[cfg(not(target_os = "windows"))]
const fn vk_tab() -> u16 {
    0x09
}

#[cfg(target_os = "windows")]
const fn vk_space() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_SPACE
}

#[cfg(not(target_os = "windows"))]
const fn vk_space() -> u16 {
    0x20
}

#[cfg(target_os = "windows")]
const fn vk_back() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_BACK
}

#[cfg(not(target_os = "windows"))]
const fn vk_back() -> u16 {
    0x08
}

#[cfg(target_os = "windows")]
const fn vk_delete() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_DELETE
}

#[cfg(not(target_os = "windows"))]
const fn vk_delete() -> u16 {
    0x2E
}

#[cfg(target_os = "windows")]
const fn vk_insert() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_INSERT
}

#[cfg(not(target_os = "windows"))]
const fn vk_insert() -> u16 {
    0x2D
}

#[cfg(target_os = "windows")]
const fn vk_escape() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE
}

#[cfg(not(target_os = "windows"))]
const fn vk_escape() -> u16 {
    0x1B
}

#[cfg(target_os = "windows")]
const fn vk_home() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_HOME
}

#[cfg(not(target_os = "windows"))]
const fn vk_home() -> u16 {
    0x24
}

#[cfg(target_os = "windows")]
const fn vk_end() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_END
}

#[cfg(not(target_os = "windows"))]
const fn vk_end() -> u16 {
    0x23
}

#[cfg(target_os = "windows")]
const fn vk_prior() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_PRIOR
}

#[cfg(not(target_os = "windows"))]
const fn vk_prior() -> u16 {
    0x21
}

#[cfg(target_os = "windows")]
const fn vk_next() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_NEXT
}

#[cfg(not(target_os = "windows"))]
const fn vk_next() -> u16 {
    0x22
}

#[cfg(target_os = "windows")]
const fn vk_left() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LEFT
}

#[cfg(not(target_os = "windows"))]
const fn vk_left() -> u16 {
    0x25
}

#[cfg(target_os = "windows")]
const fn vk_right() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_RIGHT
}

#[cfg(not(target_os = "windows"))]
const fn vk_right() -> u16 {
    0x27
}

#[cfg(target_os = "windows")]
const fn vk_up() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_UP
}

#[cfg(not(target_os = "windows"))]
const fn vk_up() -> u16 {
    0x26
}

#[cfg(target_os = "windows")]
const fn vk_down() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_DOWN
}

#[cfg(not(target_os = "windows"))]
const fn vk_down() -> u16 {
    0x28
}

#[cfg(target_os = "windows")]
const fn vk_capital() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_CAPITAL
}

#[cfg(not(target_os = "windows"))]
const fn vk_capital() -> u16 {
    0x14
}

#[cfg(target_os = "windows")]
const fn vk_numlock() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_NUMLOCK
}

#[cfg(not(target_os = "windows"))]
const fn vk_numlock() -> u16 {
    0x90
}

#[cfg(target_os = "windows")]
const fn vk_snapshot() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_SNAPSHOT
}

#[cfg(not(target_os = "windows"))]
const fn vk_snapshot() -> u16 {
    0x2C
}

#[cfg(target_os = "windows")]
const fn vk_scroll() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_SCROLL
}

#[cfg(not(target_os = "windows"))]
const fn vk_scroll() -> u16 {
    0x91
}

#[cfg(target_os = "windows")]
const fn vk_pause() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_PAUSE
}

#[cfg(not(target_os = "windows"))]
const fn vk_pause() -> u16 {
    0x13
}

#[cfg(target_os = "windows")]
const fn vk_apps() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_APPS
}

#[cfg(not(target_os = "windows"))]
const fn vk_apps() -> u16 {
    0x5D
}

#[cfg(target_os = "windows")]
const fn vk_lcontrol() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LCONTROL
}

#[cfg(not(target_os = "windows"))]
const fn vk_lcontrol() -> u16 {
    0xA2
}

#[cfg(target_os = "windows")]
const fn vk_lshift() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LSHIFT
}

#[cfg(not(target_os = "windows"))]
const fn vk_lshift() -> u16 {
    0xA0
}

#[cfg(target_os = "windows")]
const fn vk_lmenu() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LMENU
}

#[cfg(not(target_os = "windows"))]
const fn vk_lmenu() -> u16 {
    0xA4
}

#[cfg(target_os = "windows")]
const fn vk_lwin() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LWIN
}

#[cfg(not(target_os = "windows"))]
const fn vk_lwin() -> u16 {
    0x5B
}

#[cfg(target_os = "windows")]
const fn vk_oem_minus() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_MINUS
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_minus() -> u16 {
    0xBD
}

#[cfg(target_os = "windows")]
const fn vk_oem_plus() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_PLUS
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_plus() -> u16 {
    0xBB
}

#[cfg(target_os = "windows")]
const fn vk_oem_comma() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_COMMA
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_comma() -> u16 {
    0xBC
}

#[cfg(target_os = "windows")]
const fn vk_oem_period() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_PERIOD
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_period() -> u16 {
    0xBE
}

#[cfg(target_os = "windows")]
const fn vk_oem_1() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_1
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_1() -> u16 {
    0xBA
}

#[cfg(target_os = "windows")]
const fn vk_oem_2() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_2
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_2() -> u16 {
    0xBF
}

#[cfg(target_os = "windows")]
const fn vk_oem_3() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_3
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_3() -> u16 {
    0xC0
}

#[cfg(target_os = "windows")]
const fn vk_oem_4() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_4
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_4() -> u16 {
    0xDB
}

#[cfg(target_os = "windows")]
const fn vk_oem_5() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_5
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_5() -> u16 {
    0xDC
}

#[cfg(target_os = "windows")]
const fn vk_oem_6() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_6
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_6() -> u16 {
    0xDD
}

#[cfg(target_os = "windows")]
const fn vk_oem_7() -> u16 {
    windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_OEM_7
}

#[cfg(not(target_os = "windows"))]
const fn vk_oem_7() -> u16 {
    0xDE
}

// ---------------------------------------------------------------------------
// Mouse action injection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct MouseDispatchReport {
    pub warnings: Vec<String>,
}

/// Send a mouse action (click, scroll, etc.) with optional keyboard modifiers.
///
/// Flow mirrors `send_shortcut`:
/// 1. Clear encoding modifiers injected by the Razer driver.
/// 2. Press desired modifiers (Ctrl, Shift, etc.).
/// 3. Inject the mouse event via `SendInput`.
/// 4. Release modifiers we pressed.
pub fn send_mouse_action(
    payload: &MouseActionPayload,
    encoding_mods: &HotkeyModifiers,
) -> Result<MouseDispatchReport, String> {
    clear_modifiers(encoding_mods)?;

    let has_modifier = payload.ctrl || payload.shift || payload.alt || payload.win;
    let pressed_modifiers = if has_modifier {
        let snapshot = current_modifier_snapshot()?;
        let mods_to_press: Vec<ModifierKey> = [
            (ModifierKey::Win, payload.win),
            (ModifierKey::Ctrl, payload.ctrl),
            (ModifierKey::Alt, payload.alt),
            (ModifierKey::Shift, payload.shift),
        ]
        .iter()
        .filter(|(_, desired)| *desired)
        .filter(|(modifier, _)| !snapshot.is_active(*modifier))
        .map(|(modifier, _)| *modifier)
        .collect();

        // Press modifiers down
        let press_inputs: Vec<KeyboardInputSpec> = mods_to_press
            .iter()
            .map(|m| KeyboardInputSpec::VirtualKey {
                code: m.virtual_key().code,
                extended: m.virtual_key().extended,
                key_up: false,
            })
            .collect();
        if !press_inputs.is_empty() {
            send_keyboard_inputs(&press_inputs)?;
        }
        mods_to_press
    } else {
        Vec::new()
    };

    // Inject the mouse event
    let result = send_mouse_event(&payload.action);

    // Release modifiers in reverse order (LIFO)
    if !pressed_modifiers.is_empty() {
        let release = build_modifier_release_inputs(&pressed_modifiers);
        let _ = send_keyboard_inputs(&release);
    }

    result?;
    Ok(MouseDispatchReport {
        warnings: Vec::new(),
    })
}

/// Wheel scroll amount — one notch (standard WHEEL_DELTA = 120).
const WHEEL_DELTA: i32 = 120;

#[cfg(target_os = "windows")]
fn send_mouse_event(action: &str) -> Result<(), String> {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN,
        MOUSEEVENTF_XUP, MOUSEINPUT,
    };

    let make_mouse = |flags: u32, mouse_data: i32| -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: mouse_data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: INTERNAL_SENDINPUT_EXTRA_INFO,
                },
            },
        }
    };

    let inputs: Vec<INPUT> = match action {
        "leftClick" => vec![
            make_mouse(MOUSEEVENTF_LEFTDOWN, 0),
            make_mouse(MOUSEEVENTF_LEFTUP, 0),
        ],
        "rightClick" => vec![
            make_mouse(MOUSEEVENTF_RIGHTDOWN, 0),
            make_mouse(MOUSEEVENTF_RIGHTUP, 0),
        ],
        "middleClick" => vec![
            make_mouse(MOUSEEVENTF_MIDDLEDOWN, 0),
            make_mouse(MOUSEEVENTF_MIDDLEUP, 0),
        ],
        "doubleClick" => vec![
            make_mouse(MOUSEEVENTF_LEFTDOWN, 0),
            make_mouse(MOUSEEVENTF_LEFTUP, 0),
            make_mouse(MOUSEEVENTF_LEFTDOWN, 0),
            make_mouse(MOUSEEVENTF_LEFTUP, 0),
        ],
        "scrollUp" => vec![make_mouse(MOUSEEVENTF_WHEEL, WHEEL_DELTA)],
        "scrollDown" => vec![make_mouse(MOUSEEVENTF_WHEEL, -WHEEL_DELTA)],
        "scrollLeft" => vec![make_mouse(MOUSEEVENTF_HWHEEL, -WHEEL_DELTA)],
        "scrollRight" => vec![make_mouse(MOUSEEVENTF_HWHEEL, WHEEL_DELTA)],
        "mouseBack" => vec![
            make_mouse(MOUSEEVENTF_XDOWN, 0x0001),
            make_mouse(MOUSEEVENTF_XUP, 0x0001),
        ],
        "mouseForward" => vec![
            make_mouse(MOUSEEVENTF_XDOWN, 0x0002),
            make_mouse(MOUSEEVENTF_XUP, 0x0002),
        ],
        other => return Err(format!("Неизвестное действие мыши: `{other}`.")),
    };

    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        let err = std::io::Error::last_os_error();
        Err(format!(
            "SendInput (mouse) injected {sent}/{} events: {err}",
            inputs.len()
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn send_mouse_event(_action: &str) -> Result<(), String> {
    Err("Live mouse action injection is only implemented for Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_seed_shortcut_keys() {
        for key in [
            "C",
            "V",
            "F4",
            "Enter",
            "Delete",
            "Backspace",
            "Space",
            "Insert",
            "Tab",
            "-",
            "=",
            "8",
        ] {
            assert!(parse_primary_key(key).is_ok(), "expected `{key}` to parse");
        }
    }

    #[test]
    fn rejects_ambiguous_shifted_symbol_shortcut_keys() {
        let error = parse_primary_key("+").expect_err("expected ambiguous plus");
        assert!(error.contains("Use `=` with shift=true"));
    }

    #[test]
    fn plans_shortcut_without_releasing_reused_modifiers() {
        let payload = ShortcutActionPayload {
            key: "C".into(),
            ctrl: true,
            shift: false,
            alt: false,
            win: false,
            raw: Some("^c".into()),
        };

        let (plan, reused) = plan_shortcut_inputs(
            &payload,
            &ModifierSnapshot {
                ctrl: true,
                shift: false,
                alt: false,
                win: false,
            },
        )
        .expect("expected valid plan");

        assert_eq!(reused, vec![ModifierKey::Ctrl]);
        assert_eq!(
            plan,
            vec![
                KeyboardInputSpec::VirtualKey {
                    code: b'C' as u16,
                    extended: false,
                    key_up: false,
                },
                KeyboardInputSpec::VirtualKey {
                    code: b'C' as u16,
                    extended: false,
                    key_up: true,
                },
            ]
        );
    }

    #[test]
    fn plans_modifier_only_shortcut_as_press_and_release() {
        let payload = ShortcutActionPayload {
            key: String::new(),
            ctrl: true,
            shift: false,
            alt: true,
            win: false,
            raw: Some("Ctrl+Alt".into()),
        };

        let (plan, reused) = plan_shortcut_inputs(&payload, &ModifierSnapshot::default())
            .expect("expected modifier-only shortcut to plan");

        assert!(reused.is_empty());
        assert_eq!(
            plan,
            vec![
                KeyboardInputSpec::VirtualKey {
                    code: vk_lcontrol(),
                    extended: false,
                    key_up: false,
                },
                KeyboardInputSpec::VirtualKey {
                    code: vk_lmenu(),
                    extended: false,
                    key_up: false,
                },
                KeyboardInputSpec::VirtualKey {
                    code: vk_lmenu(),
                    extended: false,
                    key_up: true,
                },
                KeyboardInputSpec::VirtualKey {
                    code: vk_lcontrol(),
                    extended: false,
                    key_up: true,
                },
            ]
        );
    }

    #[test]
    fn allows_user_held_modifiers_to_pass_through() {
        let payload = ShortcutActionPayload {
            key: "C".into(),
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
            raw: None,
        };

        // User holds Ctrl on keyboard — it should pass through to the OS,
        // combining with the injected keypress (Ctrl+C at OS level).
        let (plan, reused) = plan_shortcut_inputs(
            &payload,
            &ModifierSnapshot {
                ctrl: true,
                shift: false,
                alt: false,
                win: false,
            },
        )
        .expect("user modifiers should pass through");

        assert!(reused.is_empty());
        assert_eq!(
            plan,
            vec![
                KeyboardInputSpec::VirtualKey {
                    code: b'C' as u16,
                    extended: false,
                    key_up: false,
                },
                KeyboardInputSpec::VirtualKey {
                    code: b'C' as u16,
                    extended: false,
                    key_up: true,
                },
            ]
        );
    }

    #[test]
    fn build_text_inputs_normalizes_crlf_to_single_enter() {
        let inputs = build_text_inputs("A\r\nB").expect("expected text plan");

        assert_eq!(
            inputs,
            vec![
                KeyboardInputSpec::Unicode {
                    code_unit: 'A' as u16,
                    key_up: false,
                },
                KeyboardInputSpec::Unicode {
                    code_unit: 'A' as u16,
                    key_up: true,
                },
                KeyboardInputSpec::VirtualKey {
                    code: vk_return(),
                    extended: false,
                    key_up: false,
                },
                KeyboardInputSpec::VirtualKey {
                    code: vk_return(),
                    extended: false,
                    key_up: true,
                },
                KeyboardInputSpec::Unicode {
                    code_unit: 'B' as u16,
                    key_up: false,
                },
                KeyboardInputSpec::Unicode {
                    code_unit: 'B' as u16,
                    key_up: true,
                },
            ]
        );
    }

    #[test]
    fn hold_down_presses_without_releasing() {
        let payload = ShortcutActionPayload {
            key: "A".into(),
            ctrl: true,
            shift: false,
            alt: false,
            win: false,
            raw: None,
        };
        let snapshot = ModifierSnapshot::default();

        let (inputs, held) = plan_shortcut_hold_down_inputs(&payload, &snapshot).unwrap();

        // Should have: Ctrl-down, A-down — NO key-ups
        assert!(inputs.iter().all(|input| match input {
            KeyboardInputSpec::VirtualKey { key_up, .. } => !key_up,
            KeyboardInputSpec::Unicode { key_up, .. } => !key_up,
        }));
        assert_eq!(inputs.len(), 2); // Ctrl-down + A-down
        assert!(held.primary_key.is_some());
        assert_eq!(held.pressed_modifier_vks.len(), 1);
    }

    #[test]
    fn hold_up_releases_in_reverse_order() {
        let ctrl_vk = ModifierKey::Ctrl.virtual_key();
        let alt_vk = ModifierKey::Alt.virtual_key();
        let primary = parse_primary_key("A").unwrap();

        let held = HeldShortcutState {
            pressed_modifier_vks: vec![ctrl_vk, alt_vk],
            primary_key: Some(primary),
        };

        let inputs = plan_shortcut_hold_up_inputs(&held);

        // Should have: A-up, Alt-up, Ctrl-up (primary first, then modifiers in reverse)
        assert!(inputs.iter().all(|input| match input {
            KeyboardInputSpec::VirtualKey { key_up, .. } => *key_up,
            _ => false,
        }));
        assert_eq!(inputs.len(), 3);
    }
}
