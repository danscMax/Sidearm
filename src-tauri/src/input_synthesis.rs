use crate::config::ShortcutActionPayload;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutDispatchReport {
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct VirtualKeySpec {
    code: u16,
    extended: bool,
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

pub fn send_shortcut(payload: &ShortcutActionPayload) -> Result<ShortcutDispatchReport, String> {
    let snapshot = current_modifier_snapshot()?;
    let (plan, reused_modifiers) = plan_shortcut_inputs(payload, snapshot)?;
    send_keyboard_inputs(&plan)?;

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

pub fn send_hotkey_string(raw: &str) -> Result<ShortcutDispatchReport, String> {
    let hotkey = crate::hotkeys::parse_hotkey(raw)?;
    let payload = ShortcutActionPayload {
        key: hotkey.key.display_name,
        ctrl: hotkey.modifiers.ctrl,
        shift: hotkey.modifiers.shift,
        alt: hotkey.modifiers.alt,
        win: hotkey.modifiers.win,
        raw: Some(hotkey.canonical),
    };

    send_shortcut(&payload)
}

pub fn send_text(text: &str) -> Result<(), String> {
    let plan = build_text_inputs(text)?;
    if plan.is_empty() {
        return Ok(());
    }

    send_keyboard_inputs(&plan)
}

fn plan_shortcut_inputs(
    payload: &ShortcutActionPayload,
    snapshot: ModifierSnapshot,
) -> Result<(Vec<KeyboardInputSpec>, Vec<ModifierKey>), String> {
    let primary_key = parse_primary_key(&payload.key)?;
    if is_modifier_virtual_key(primary_key.code) {
        return Err(
            "Shortcut primary key must not be a modifier key. Use ctrl/shift/alt/win flags plus a non-modifier key."
                .into(),
        );
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
        if active && !desired {
            return Err(format!(
                "Cannot inject shortcut while external modifier `{}` is already pressed. Release it and try again.",
                modifier.label()
            ));
        }

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

    push_virtual_key_down(&mut inputs, primary_key);
    push_virtual_key_up(&mut inputs, primary_key);

    for modifier in pressed_modifiers.into_iter().rev() {
        push_virtual_key_up(&mut inputs, modifier.virtual_key());
    }

    Ok((inputs, reused_modifiers))
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
            other => Err(format!("Unsupported shortcut key `{other}` for live execution.")),
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
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MapVirtualKeyW, SendInput,
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
                            dwExtraInfo: 0,
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
                            dwExtraInfo: 0,
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
            Some(code) => format!(
                " Win32 error {code}: {last_error}. SendInput may also be blocked by UIPI."
            ),
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
            assert!(
                parse_primary_key(key).is_ok(),
                "expected `{key}` to parse"
            );
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
            ModifierSnapshot {
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
    fn blocks_unexpected_external_modifiers() {
        let payload = ShortcutActionPayload {
            key: "C".into(),
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
            raw: None,
        };

        let error = plan_shortcut_inputs(
            &payload,
            ModifierSnapshot {
                ctrl: true,
                shift: false,
                alt: false,
                win: false,
            },
        )
        .expect_err("expected modifier conflict");

        assert!(error.contains("external modifier `Ctrl`"));
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
}
