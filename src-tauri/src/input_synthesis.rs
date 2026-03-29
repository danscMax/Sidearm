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
    log::debug!(
        "[input] Shortcut: {}{}{}{}{}",
        if payload.ctrl { "Ctrl+" } else { "" },
        if payload.shift { "Shift+" } else { "" },
        if payload.alt { "Alt+" } else { "" },
        if payload.win { "Win+" } else { "" },
        payload.key
    );
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

/// Lightweight clipboard-paste: save CF_UNICODETEXT → set text → Ctrl+V → restore.
///
/// Intentionally does NOT call OleInitialize and only touches CF_UNICODETEXT.
/// The full COM/OLE path (`clipboard::paste_text`) enumerated every clipboard
/// format, calling `GlobalLock` on non-HGLOBAL handles (CF_BITMAP,
/// CF_ENHMETAFILE) and loading shell extensions via OleInitialize — both of
/// which caused unrecoverable access-violation crashes.
///
/// Trade-off: non-text clipboard content (images, files) is lost during the
/// brief paste window.  The original text is restored after 150 ms.
#[cfg(target_os = "windows")]
fn paste_via_clipboard(text: &str) -> Result<(), String> {
    use std::{ptr, thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::GlobalFree,
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
                OpenClipboard, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::CF_UNICODETEXT,
        },
    };

    const RESTORE_DELAY: Duration = Duration::from_millis(150);

    // --- helper: open clipboard with retry ---
    let open = || -> Result<(), String> {
        for attempt in 0..10u32 {
            if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
                return Ok(());
            }
            if attempt + 1 < 10 {
                thread::sleep(Duration::from_millis(20));
            }
        }
        Err("OpenClipboard failed after 10 retries".into())
    };

    // --- helper: read CF_UNICODETEXT from an already-open clipboard ---
    let read_text = || -> Option<String> {
        unsafe {
            let handle = GetClipboardData(u32::from(CF_UNICODETEXT));
            if handle.is_null() {
                return None;
            }
            let locked = GlobalLock(handle);
            if locked.is_null() {
                return None;
            }
            let mut len = 0usize;
            let wide = locked as *const u16;
            while *wide.add(len) != 0 {
                len += 1;
            }
            let t = String::from_utf16_lossy(std::slice::from_raw_parts(wide, len));
            let _ = GlobalUnlock(handle);
            Some(t)
        }
    };

    // --- helper: write CF_UNICODETEXT to an already-open, emptied clipboard ---
    let write_text = |t: &str| -> Result<(), String> {
        unsafe {
            let encoded: Vec<u16> = t.encode_utf16().chain(std::iter::once(0)).collect();
            let byte_len = encoded.len() * std::mem::size_of::<u16>();

            let handle = GlobalAlloc(GMEM_MOVEABLE, byte_len);
            if handle.is_null() {
                return Err("GlobalAlloc failed".into());
            }
            let locked = GlobalLock(handle);
            if locked.is_null() {
                let _ = GlobalFree(handle);
                return Err("GlobalLock failed".into());
            }
            ptr::copy_nonoverlapping(encoded.as_ptr() as *const u8, locked as *mut u8, byte_len);
            let _ = GlobalUnlock(handle);

            if SetClipboardData(u32::from(CF_UNICODETEXT), handle).is_null() {
                let _ = GlobalFree(handle);
                return Err("SetClipboardData failed".into());
            }
            Ok(())
        }
    };

    // --- helper: best-effort restore ---
    let restore = |original: &str| {
        if open().is_ok() {
            unsafe { EmptyClipboard() };
            let _ = write_text(original);
            unsafe { CloseClipboard() };
        }
    };

    // 1. Open clipboard and save current text
    open()?;
    let saved_text = read_text();
    unsafe { CloseClipboard() };

    // 2. Stage our text
    open()?;
    unsafe { EmptyClipboard() };
    if let Err(e) = write_text(text) {
        unsafe { CloseClipboard() };
        if let Some(ref original) = saved_text {
            restore(original);
        }
        return Err(e);
    }
    let seq = unsafe { GetClipboardSequenceNumber() };
    unsafe { CloseClipboard() };

    // 3. Inject Ctrl+V (clears encoding modifiers first)
    if let Err(e) = send_hotkey_string("Ctrl+V", &ALL_MODIFIERS) {
        if let Some(ref original) = saved_text {
            restore(original);
        }
        return Err(format!("Failed to inject Ctrl+V: {e:?}"));
    }

    // 4. Wait for target app to consume the paste
    thread::sleep(RESTORE_DELAY);

    // 5. Restore original clipboard text (only if no one else changed it)
    if unsafe { GetClipboardSequenceNumber() } != seq {
        log::debug!("[input] Clipboard changed externally, skipping restore");
        return Ok(());
    }
    if let Some(ref original) = saved_text {
        restore(original);
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn paste_via_clipboard(text: &str) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Failed to open clipboard: {e}"))?;

    let saved = clipboard.get_text().ok();

    clipboard
        .set_text(text)
        .map_err(|e| format!("Failed to set clipboard text: {e}"))?;

    if let Err(e) = send_hotkey_string("Ctrl+V", &ALL_MODIFIERS) {
        if let Some(ref original) = saved {
            let _ = clipboard.set_text(original);
        }
        return Err(format!("Failed to inject Ctrl+V: {e:?}"));
    }

    std::thread::sleep(std::time::Duration::from_millis(150));

    if let Some(original) = saved {
        let _ = clipboard.set_text(&original);
    }

    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn paste_via_clipboard(_text: &str) -> Result<(), String> {
    Err("Clipboard paste is not implemented for this platform".into())
}

/// All modifiers must be cleared for text injection — held Ctrl/Alt corrupts
/// Unicode/VK_PACKET output.
const ALL_MODIFIERS: HotkeyModifiers = HotkeyModifiers {
    ctrl: true,
    shift: true,
    alt: true,
    win: true,
};

/// Text length threshold: above this, `send_text_with_delay` attempts a
/// lightweight clipboard-paste (Ctrl+V) before falling back to per-character
/// `KEYEVENTF_UNICODE`.  Clipboard-paste preserves newlines as the target
/// app expects (no extra paragraph breaks), while per-character SendInput
/// sends literal VK_RETURN which many apps interpret as "new paragraph" or
/// "send message".
const CLIPBOARD_PASTE_THRESHOLD: usize = 100;

/// Send text with an optional inter-character delay (milliseconds).
/// When `inter_key_delay_ms` is 0, all characters are batched into a single
/// `SendInput` call.  A non-zero delay sends each character pair (down+up)
/// individually with a sleep in between — useful for apps that drop rapid
/// Unicode input bursts.  Pattern from AHK's `SetKeyDelay` / Kanata's
/// `rapid-event-delay`.
///
/// For text longer than [`CLIPBOARD_PASTE_THRESHOLD`] characters, attempts a
/// lightweight clipboard-paste (save CF_UNICODETEXT → set → Ctrl+V → restore).
/// Unlike the full COM/OLE clipboard module, this path does NOT call
/// OleInitialize and only touches CF_UNICODETEXT, avoiding the shell-extension
/// access-violation crashes that plagued the original implementation.
pub fn send_text_with_delay(text: &str, inter_key_delay_ms: u32) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }

    log::debug!("[input] Text input: {} chars", text.chars().count());

    // For long text, attempt lightweight clipboard-paste (preserves newlines correctly).
    if text.chars().count() > CLIPBOARD_PASTE_THRESHOLD {
        match paste_via_clipboard(text) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log::warn!(
                    "[input] Lightweight clipboard-paste failed ({} chars), \
                     falling back to KEYEVENTF_UNICODE: {e}",
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
            KeyboardInputSpec::VirtualKey { code: VK_LCONTROL, extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: VK_LSHIFT, extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: VK_LMENU, extended: false, key_up: true },
            KeyboardInputSpec::VirtualKey { code: VK_LWIN, extended: false, key_up: true },
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
                        code: VK_RETURN,
                        extended: false,
                    },
                );
            }
            '\n' => push_virtual_key_tap(
                &mut inputs,
                VirtualKeySpec {
                    code: VK_RETURN,
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

/// Map Cyrillic characters to the QWERTY key at the same physical position
/// on a standard ЙЦУКЕН keyboard layout.  Users often capture shortcuts with
/// Russian layout active, producing 'С' (Cyrillic) instead of 'C' (Latin)
/// for Ctrl+C — this function reverses that by physical key position.
fn normalize_cyrillic_key(key: &str) -> String {
    key.chars()
        .map(|ch| match ch {
            // Row 0: Ё → `
            'ё' | 'Ё' => '`',
            // Row 1: Й Ц У К Е Н Г Ш Щ З Х Ъ → Q W E R T Y U I O P [ ]
            'й' | 'Й' => 'Q', 'ц' | 'Ц' => 'W', 'у' | 'У' => 'E',
            'к' | 'К' => 'R', 'е' | 'Е' => 'T', 'н' | 'Н' => 'Y',
            'г' | 'Г' => 'U', 'ш' | 'Ш' => 'I', 'щ' | 'Щ' => 'O',
            'з' | 'З' => 'P', 'х' | 'Х' => '[', 'ъ' | 'Ъ' => ']',
            // Row 2: Ф Ы В А П Р О Л Д Ж Э → A S D F G H J K L ; '
            'ф' | 'Ф' => 'A', 'ы' | 'Ы' => 'S', 'в' | 'В' => 'D',
            'а' | 'А' => 'F', 'п' | 'П' => 'G', 'р' | 'Р' => 'H',
            'о' | 'О' => 'J', 'л' | 'Л' => 'K', 'д' | 'Д' => 'L',
            'ж' | 'Ж' => ';', 'э' | 'Э' => '\'',
            // Row 3: Я Ч С М И Т Ь Б Ю → Z X C V B N M , .
            'я' | 'Я' => 'Z', 'ч' | 'Ч' => 'X', 'с' | 'С' => 'C',
            'м' | 'М' => 'V', 'и' | 'И' => 'B', 'т' | 'Т' => 'N',
            'ь' | 'Ь' => 'M', 'б' | 'Б' => ',', 'ю' | 'Ю' => '.',
            _ => ch,
        })
        .collect()
}

fn parse_primary_key(key: &str) -> Result<VirtualKeySpec, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("Shortcut key must not be empty for live execution.".into());
    }

    // Normalize Cyrillic → Latin (e.g. Ctrl+С → Ctrl+C)
    let has_cyrillic = trimmed.chars().any(|c| matches!(c, '\u{0400}'..='\u{04FF}'));
    if has_cyrillic {
        let normalized = normalize_cyrillic_key(trimmed);
        log::info!("[input] Normalized Cyrillic key: `{trimmed}` → `{normalized}`");
        return parse_primary_key(&normalized);
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
            '-' => Ok(oem_key(VK_OEM_MINUS)),
            '=' => Ok(oem_key(VK_OEM_PLUS)),
            ',' => Ok(oem_key(VK_OEM_COMMA)),
            '.' => Ok(oem_key(VK_OEM_PERIOD)),
            '/' => Ok(oem_key(VK_OEM_2)),
            ';' => Ok(oem_key(VK_OEM_1)),
            '\'' => Ok(oem_key(VK_OEM_7)),
            '[' => Ok(oem_key(VK_OEM_4)),
            ']' => Ok(oem_key(VK_OEM_6)),
            '\\' => Ok(oem_key(VK_OEM_5)),
            '`' => Ok(oem_key(VK_OEM_3)),
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
            code: VK_RETURN,
            extended: false,
        }),
        "TAB" => Ok(VirtualKeySpec {
            code: VK_TAB,
            extended: false,
        }),
        "SPACE" | "SPACEBAR" => Ok(VirtualKeySpec {
            code: VK_SPACE,
            extended: false,
        }),
        "BACKSPACE" | "BKSP" => Ok(VirtualKeySpec {
            code: VK_BACK,
            extended: false,
        }),
        "DELETE" | "DEL" => Ok(VirtualKeySpec {
            code: VK_DELETE,
            extended: true,
        }),
        "INSERT" | "INS" => Ok(VirtualKeySpec {
            code: VK_INSERT,
            extended: true,
        }),
        "ESC" | "ESCAPE" => Ok(VirtualKeySpec {
            code: VK_ESCAPE,
            extended: false,
        }),
        "HOME" => Ok(VirtualKeySpec {
            code: VK_HOME,
            extended: true,
        }),
        "END" => Ok(VirtualKeySpec {
            code: VK_END,
            extended: true,
        }),
        "PAGEUP" | "PGUP" => Ok(VirtualKeySpec {
            code: VK_PRIOR,
            extended: true,
        }),
        "PAGEDOWN" | "PGDOWN" | "PGDN" => Ok(VirtualKeySpec {
            code: VK_NEXT,
            extended: true,
        }),
        "LEFT" | "LEFTARROW" => Ok(VirtualKeySpec {
            code: VK_LEFT,
            extended: true,
        }),
        "RIGHT" | "RIGHTARROW" => Ok(VirtualKeySpec {
            code: VK_RIGHT,
            extended: true,
        }),
        "UP" | "UPARROW" => Ok(VirtualKeySpec {
            code: VK_UP,
            extended: true,
        }),
        "DOWN" | "DOWNARROW" => Ok(VirtualKeySpec {
            code: VK_DOWN,
            extended: true,
        }),
        "CAPSLOCK" => Ok(VirtualKeySpec {
            code: VK_CAPITAL,
            extended: false,
        }),
        "NUMLOCK" => Ok(VirtualKeySpec {
            code: VK_NUMLOCK,
            extended: true,
        }),
        "PRINTSCREEN" | "PRTSC" | "PRTSCN" => Ok(VirtualKeySpec {
            code: VK_SNAPSHOT,
            extended: true,
        }),
        "SCROLLLOCK" => Ok(VirtualKeySpec {
            code: VK_SCROLL,
            extended: false,
        }),
        "PAUSE" => Ok(VirtualKeySpec {
            code: VK_PAUSE,
            extended: false,
        }),
        "APPS" | "APPLICATION" | "MENU" => Ok(VirtualKeySpec {
            code: VK_APPS,
            extended: false,
        }),
        "MINUS" | "HYPHEN" => Ok(oem_key(VK_OEM_MINUS)),
        "EQUAL" | "EQUALS" | "PLUS" => Ok(oem_key(VK_OEM_PLUS)),
        "COMMA" => Ok(oem_key(VK_OEM_COMMA)),
        "PERIOD" | "DOT" => Ok(oem_key(VK_OEM_PERIOD)),
        "SLASH" | "FORWARDSLASH" => Ok(oem_key(VK_OEM_2)),
        "SEMICOLON" => Ok(oem_key(VK_OEM_1)),
        "APOSTROPHE" | "QUOTE" => Ok(oem_key(VK_OEM_7)),
        "LBRACKET" | "LEFTBRACKET" => Ok(oem_key(VK_OEM_4)),
        "RBRACKET" | "RIGHTBRACKET" => Ok(oem_key(VK_OEM_6)),
        "BACKSLASH" => Ok(oem_key(VK_OEM_5)),
        "GRAVE" | "BACKTICK" => Ok(oem_key(VK_OEM_3)),
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
    // On Linux, character-to-keycode mapping would require xkbcommon.
    // For now, return None — text input uses KEYEVENTF_UNICODE equivalent.
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
                code: VK_LCONTROL,
                extended: false,
            },
            ModifierKey::Shift => VirtualKeySpec {
                code: VK_LSHIFT,
                extended: false,
            },
            ModifierKey::Alt => VirtualKeySpec {
                code: VK_LMENU,
                extended: false,
            },
            ModifierKey::Win => VirtualKeySpec {
                code: VK_LWIN,
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
                code: VK_LCONTROL,
                extended: false,
                key_up: true,
            });
        }
        if mask.shift && key_is_down(GetAsyncKeyState(VK_SHIFT as i32)) {
            release_inputs.push(KeyboardInputSpec::VirtualKey {
                code: VK_LSHIFT,
                extended: false,
                key_up: true,
            });
        }
        if mask.alt && key_is_down(GetAsyncKeyState(VK_MENU as i32)) {
            release_inputs.push(KeyboardInputSpec::VirtualKey {
                code: VK_LMENU,
                extended: false,
                key_up: true,
            });
        }
        if mask.win
            && (key_is_down(GetAsyncKeyState(VK_LWIN as i32))
                || key_is_down(GetAsyncKeyState(VK_RWIN as i32)))
        {
            release_inputs.push(KeyboardInputSpec::VirtualKey {
                code: VK_LWIN,
                extended: false,
                key_up: true,
            });
        }
    }

    if !release_inputs.is_empty() {
        let labels: Vec<&str> = release_inputs
            .iter()
            .filter_map(|input| match input {
                KeyboardInputSpec::VirtualKey { code, .. } => match *code {
                    c if c == VK_LCONTROL => Some("Ctrl"),
                    c if c == VK_LSHIFT => Some("Shift"),
                    c if c == VK_LMENU => Some("Alt"),
                    c if c == VK_LWIN => Some("Win"),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        log::debug!(
            "[modifier-passthrough] clear_modifiers: releasing [{}]",
            labels.join(", "),
        );
        send_keyboard_inputs(&release_inputs)?;
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn clear_modifiers(mask: &HotkeyModifiers) -> Result<(), String> {
    // Release modifier keys that were injected by the Razer driver encoding.
    // On Linux, we send key-up events via uinput for each active modifier.
    let mut keys_to_release = Vec::new();
    if mask.ctrl { keys_to_release.push(VK_LCONTROL); }
    if mask.shift { keys_to_release.push(VK_LSHIFT); }
    if mask.alt { keys_to_release.push(VK_LMENU); }
    if mask.win { keys_to_release.push(VK_LWIN); }
    if keys_to_release.is_empty() {
        return Ok(());
    }
    let inputs: Vec<KeyboardInputSpec> = keys_to_release
        .into_iter()
        .map(|code| KeyboardInputSpec::VirtualKey { code, extended: false, key_up: true })
        .collect();
    send_keyboard_inputs(&inputs)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
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

#[cfg(target_os = "linux")]
fn current_modifier_snapshot() -> Result<ModifierSnapshot, String> {
    // On Linux, reading the live modifier state from evdev requires finding
    // the keyboard device and querying key state via EVIOCGKEY ioctl.
    // For MVP, assume no modifiers are held — the Razer driver encoding
    // modifiers are cleared by clear_modifiers() before action execution.
    Ok(ModifierSnapshot::default())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn current_modifier_snapshot() -> Result<ModifierSnapshot, String> {
    Err("Live keyboard injection is not implemented for this platform.".into())
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

    log::debug!("[input] Sending {} inputs", inputs.len());

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
        let msg = format!(
            "SendInput inserted {sent} of {} event(s).{suffix}",
            windows_inputs.len()
        );
        log::error!("[input] {msg}");
        Err(msg)
    }
}

#[cfg(target_os = "linux")]
fn send_keyboard_inputs(inputs: &[KeyboardInputSpec]) -> Result<(), String> {
    use evdev::{uinput::VirtualDevice, AttributeSet, EventType, InputEvent, KeyCode};

    // VK code → evdev KeyCode mapping for common keys
    fn vk_to_evdev_key(code: u16) -> Option<KeyCode> {
        Some(match code {
            0x08 => KeyCode::KEY_BACKSPACE,
            0x09 => KeyCode::KEY_TAB,
            0x0D => KeyCode::KEY_ENTER,
            0x13 => KeyCode::KEY_PAUSE,
            0x14 => KeyCode::KEY_CAPSLOCK,
            0x1B => KeyCode::KEY_ESC,
            0x20 => KeyCode::KEY_SPACE,
            0x21 => KeyCode::KEY_PAGEUP,
            0x22 => KeyCode::KEY_PAGEDOWN,
            0x23 => KeyCode::KEY_END,
            0x24 => KeyCode::KEY_HOME,
            0x25 => KeyCode::KEY_LEFT,
            0x26 => KeyCode::KEY_UP,
            0x27 => KeyCode::KEY_RIGHT,
            0x28 => KeyCode::KEY_DOWN,
            0x2C => KeyCode::KEY_SYSRQ,
            0x2D => KeyCode::KEY_INSERT,
            0x2E => KeyCode::KEY_DELETE,
            // 0-9
            0x30..=0x39 => KeyCode::new((code - 0x30 + KeyCode::KEY_0.0) as u16),
            // A-Z
            0x41..=0x5A => KeyCode::new((code - 0x41 + KeyCode::KEY_A.0) as u16),
            0x5B => KeyCode::KEY_LEFTMETA,
            0x5D => KeyCode::KEY_COMPOSE,
            // F1-F24
            0x70..=0x87 => KeyCode::new((code - 0x70 + KeyCode::KEY_F1.0) as u16),
            0x90 => KeyCode::KEY_NUMLOCK,
            0x91 => KeyCode::KEY_SCROLLLOCK,
            // Modifiers
            0xA0 => KeyCode::KEY_LEFTSHIFT,
            0xA1 => KeyCode::KEY_RIGHTSHIFT,
            0xA2 => KeyCode::KEY_LEFTCTRL,
            0xA3 => KeyCode::KEY_RIGHTCTRL,
            0xA4 => KeyCode::KEY_LEFTALT,
            0xA5 => KeyCode::KEY_RIGHTALT,
            // OEM keys
            0xBA => KeyCode::KEY_SEMICOLON,
            0xBB => KeyCode::KEY_EQUAL,
            0xBC => KeyCode::KEY_COMMA,
            0xBD => KeyCode::KEY_MINUS,
            0xBE => KeyCode::KEY_DOT,
            0xBF => KeyCode::KEY_SLASH,
            0xC0 => KeyCode::KEY_GRAVE,
            0xDB => KeyCode::KEY_LEFTBRACE,
            0xDC => KeyCode::KEY_BACKSLASH,
            0xDD => KeyCode::KEY_RIGHTBRACE,
            0xDE => KeyCode::KEY_APOSTROPHE,
            _ => return None,
        })
    }

    // Build the set of keys we need
    let mut keys = AttributeSet::<KeyCode>::new();
    for input in inputs {
        match input {
            KeyboardInputSpec::VirtualKey { code, .. } => {
                if let Some(key) = vk_to_evdev_key(*code) {
                    keys.insert(key);
                }
            }
            KeyboardInputSpec::Unicode { .. } => {}
        }
    }

    let mut device = VirtualDevice::builder()
        .map_err(|e| format!("Failed to create virtual device: {e}"))?
        .name("Sidearm Virtual Keyboard")
        .with_keys(&keys)
        .map_err(|e| format!("Failed to configure virtual device keys: {e}"))?
        .build()
        .map_err(|e| format!("Failed to build virtual device: {e}"))?;

    std::thread::sleep(std::time::Duration::from_millis(10));

    for input in inputs {
        match input {
            KeyboardInputSpec::VirtualKey { code, key_up, .. } => {
                if let Some(key) = vk_to_evdev_key(*code) {
                    let value = if *key_up { 0 } else { 1 };
                    let event = InputEvent::new(EventType::KEY.0, key.0, value);
                    device.emit(&[event])
                        .map_err(|e| format!("Failed to emit key event: {e}"))?;
                }
            }
            KeyboardInputSpec::Unicode { .. } => {}
        }
    }

    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn send_keyboard_inputs(_inputs: &[KeyboardInputSpec]) -> Result<(), String> {
    Err("Live keyboard injection is not implemented for this platform.".into())
}

#[cfg(target_os = "windows")]
fn key_is_down(state: i16) -> bool {
    state < 0
}

// Virtual key codes — platform-independent hex literals identical to the
// windows_sys VK_* constants.  Replaces 36 paired cfg accessor functions.
const VK_RETURN: u16 = 0x0D;
const VK_TAB: u16 = 0x09;
const VK_SPACE: u16 = 0x20;
const VK_BACK: u16 = 0x08;
const VK_DELETE: u16 = 0x2E;
const VK_INSERT: u16 = 0x2D;
const VK_ESCAPE: u16 = 0x1B;
const VK_HOME: u16 = 0x24;
const VK_END: u16 = 0x23;
const VK_PRIOR: u16 = 0x21;
const VK_NEXT: u16 = 0x22;
const VK_LEFT: u16 = 0x25;
const VK_RIGHT: u16 = 0x27;
const VK_UP: u16 = 0x26;
const VK_DOWN: u16 = 0x28;
const VK_CAPITAL: u16 = 0x14;
const VK_NUMLOCK: u16 = 0x90;
const VK_SNAPSHOT: u16 = 0x2C;
const VK_SCROLL: u16 = 0x91;
const VK_PAUSE: u16 = 0x13;
const VK_APPS: u16 = 0x5D;
const VK_LCONTROL: u16 = 0xA2;
const VK_LSHIFT: u16 = 0xA0;
const VK_LMENU: u16 = 0xA4;
const VK_LWIN: u16 = 0x5B;
const VK_OEM_MINUS: u16 = 0xBD;
const VK_OEM_PLUS: u16 = 0xBB;
const VK_OEM_COMMA: u16 = 0xBC;
const VK_OEM_PERIOD: u16 = 0xBE;
const VK_OEM_1: u16 = 0xBA;
const VK_OEM_2: u16 = 0xBF;
const VK_OEM_3: u16 = 0xC0;
const VK_OEM_4: u16 = 0xDB;
const VK_OEM_5: u16 = 0xDC;
const VK_OEM_6: u16 = 0xDD;
const VK_OEM_7: u16 = 0xDE;

/// Send a single virtual key tap (down + up) via SendInput.
///
/// Used for media keys and other simple VK injections that don't require
/// modifier management. The events carry `INTERNAL_SENDINPUT_EXTRA_INFO`
/// so our LL hook ignores them.
pub fn send_vk_tap(vk: u16) -> Result<(), String> {
    let inputs = vec![
        KeyboardInputSpec::VirtualKey {
            code: vk,
            extended: false,
            key_up: false,
        },
        KeyboardInputSpec::VirtualKey {
            code: vk,
            extended: false,
            key_up: true,
        },
    ];
    send_keyboard_inputs(&inputs)
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
    log::debug!("[input] Mouse action: {:?}", payload.action);
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
    let result = send_mouse_event(payload.action);

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
#[cfg(target_os = "windows")]
const WHEEL_DELTA: i32 = 120;

#[cfg(target_os = "windows")]
fn send_mouse_event(action: crate::config::MouseActionKind) -> Result<(), String> {
    use crate::config::MouseActionKind;
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
        MouseActionKind::LeftClick => vec![
            make_mouse(MOUSEEVENTF_LEFTDOWN, 0),
            make_mouse(MOUSEEVENTF_LEFTUP, 0),
        ],
        MouseActionKind::RightClick => vec![
            make_mouse(MOUSEEVENTF_RIGHTDOWN, 0),
            make_mouse(MOUSEEVENTF_RIGHTUP, 0),
        ],
        MouseActionKind::MiddleClick => vec![
            make_mouse(MOUSEEVENTF_MIDDLEDOWN, 0),
            make_mouse(MOUSEEVENTF_MIDDLEUP, 0),
        ],
        MouseActionKind::DoubleClick => vec![
            make_mouse(MOUSEEVENTF_LEFTDOWN, 0),
            make_mouse(MOUSEEVENTF_LEFTUP, 0),
            make_mouse(MOUSEEVENTF_LEFTDOWN, 0),
            make_mouse(MOUSEEVENTF_LEFTUP, 0),
        ],
        MouseActionKind::ScrollUp => vec![make_mouse(MOUSEEVENTF_WHEEL, WHEEL_DELTA)],
        MouseActionKind::ScrollDown => vec![make_mouse(MOUSEEVENTF_WHEEL, -WHEEL_DELTA)],
        MouseActionKind::ScrollLeft => vec![make_mouse(MOUSEEVENTF_HWHEEL, -WHEEL_DELTA)],
        MouseActionKind::ScrollRight => vec![make_mouse(MOUSEEVENTF_HWHEEL, WHEEL_DELTA)],
        MouseActionKind::MouseBack => vec![
            make_mouse(MOUSEEVENTF_XDOWN, 0x0001),
            make_mouse(MOUSEEVENTF_XUP, 0x0001),
        ],
        MouseActionKind::MouseForward => vec![
            make_mouse(MOUSEEVENTF_XDOWN, 0x0002),
            make_mouse(MOUSEEVENTF_XUP, 0x0002),
        ],
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

#[cfg(target_os = "linux")]
fn send_mouse_event(action: crate::config::MouseActionKind) -> Result<(), String> {
    use crate::config::MouseActionKind;
    use evdev::{uinput::VirtualDevice, AttributeSet, EventType, InputEvent, KeyCode, RelativeAxisCode};

    let mut keys = AttributeSet::<KeyCode>::new();
    let mut axes = AttributeSet::<RelativeAxisCode>::new();

    match action {
        MouseActionKind::LeftClick | MouseActionKind::DoubleClick => { keys.insert(KeyCode::BTN_LEFT); }
        MouseActionKind::RightClick => { keys.insert(KeyCode::BTN_RIGHT); }
        MouseActionKind::MiddleClick => { keys.insert(KeyCode::BTN_MIDDLE); }
        MouseActionKind::ScrollUp | MouseActionKind::ScrollDown => { axes.insert(RelativeAxisCode::REL_WHEEL); }
        MouseActionKind::ScrollLeft | MouseActionKind::ScrollRight => { axes.insert(RelativeAxisCode::REL_HWHEEL); }
        MouseActionKind::MouseBack => { keys.insert(KeyCode::BTN_SIDE); }
        MouseActionKind::MouseForward => { keys.insert(KeyCode::BTN_EXTRA); }
    }

    let mut builder = VirtualDevice::builder()
        .map_err(|e| format!("Failed to create virtual mouse device: {e}"))?
        .name("Sidearm Virtual Mouse");

    if keys.iter().next().is_some() {
        builder = builder.with_keys(&keys)
            .map_err(|e| format!("Failed to configure mouse keys: {e}"))?;
    }
    if axes.iter().next().is_some() {
        builder = builder.with_relative_axes(&axes)
            .map_err(|e| format!("Failed to configure mouse axes: {e}"))?;
    }

    let mut device = builder.build()
        .map_err(|e| format!("Failed to build virtual mouse device: {e}"))?;

    std::thread::sleep(std::time::Duration::from_millis(10));

    let mut emit = |events: &[InputEvent]| -> Result<(), String> {
        device.emit(events).map_err(|e| format!("Failed to emit mouse event: {e}"))
    };

    match action {
        MouseActionKind::LeftClick => {
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_LEFT.0, 1)])?;
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_LEFT.0, 0)])?;
        }
        MouseActionKind::RightClick => {
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_RIGHT.0, 1)])?;
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_RIGHT.0, 0)])?;
        }
        MouseActionKind::MiddleClick => {
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_MIDDLE.0, 1)])?;
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_MIDDLE.0, 0)])?;
        }
        MouseActionKind::DoubleClick => {
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_LEFT.0, 1)])?;
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_LEFT.0, 0)])?;
            std::thread::sleep(std::time::Duration::from_millis(50));
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_LEFT.0, 1)])?;
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_LEFT.0, 0)])?;
        }
        MouseActionKind::ScrollUp => {
            emit(&[InputEvent::new(EventType::RELATIVE.0, RelativeAxisCode::REL_WHEEL.0, 1)])?;
        }
        MouseActionKind::ScrollDown => {
            emit(&[InputEvent::new(EventType::RELATIVE.0, RelativeAxisCode::REL_WHEEL.0, -1)])?;
        }
        MouseActionKind::ScrollLeft => {
            emit(&[InputEvent::new(EventType::RELATIVE.0, RelativeAxisCode::REL_HWHEEL.0, -1)])?;
        }
        MouseActionKind::ScrollRight => {
            emit(&[InputEvent::new(EventType::RELATIVE.0, RelativeAxisCode::REL_HWHEEL.0, 1)])?;
        }
        MouseActionKind::MouseBack => {
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_SIDE.0, 1)])?;
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_SIDE.0, 0)])?;
        }
        MouseActionKind::MouseForward => {
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_EXTRA.0, 1)])?;
            emit(&[InputEvent::new(EventType::KEY.0, KeyCode::BTN_EXTRA.0, 0)])?;
        }
    }

    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn send_mouse_event(_action: crate::config::MouseActionKind) -> Result<(), String> {
    Err("Live mouse action injection is not implemented for this platform.".into())
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
                    code: VK_LCONTROL,
                    extended: false,
                    key_up: false,
                },
                KeyboardInputSpec::VirtualKey {
                    code: VK_LMENU,
                    extended: false,
                    key_up: false,
                },
                KeyboardInputSpec::VirtualKey {
                    code: VK_LMENU,
                    extended: false,
                    key_up: true,
                },
                KeyboardInputSpec::VirtualKey {
                    code: VK_LCONTROL,
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
                    code: VK_RETURN,
                    extended: false,
                    key_up: false,
                },
                KeyboardInputSpec::VirtualKey {
                    code: VK_RETURN,
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
    fn physical_shift_not_in_plan_when_action_has_no_shift() {
        // User holds Shift on keyboard, action = Backspace (no modifiers).
        // Shift is NOT in the action payload → it should not appear in the
        // injection plan.  The OS will combine the physical Shift with the
        // injected Backspace, producing Shift+Backspace.
        let payload = ShortcutActionPayload {
            key: "Backspace".into(),
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
            raw: None,
        };

        let (plan, reused) = plan_shortcut_inputs(
            &payload,
            &ModifierSnapshot {
                ctrl: false,
                shift: true, // physical Shift held
                alt: false,
                win: false,
            },
        )
        .expect("plan should succeed");

        // Physical Shift is not desired by the action, so it's neither
        // injected nor listed as reused — it simply passes through.
        assert!(reused.is_empty(), "Shift should not be reused");
        assert_eq!(plan.len(), 2, "only Backspace down + up");
        assert!(plan.iter().all(|i| match i {
            KeyboardInputSpec::VirtualKey { code, .. } => *code == VK_BACK,
            _ => false,
        }));
    }

    #[test]
    fn action_modifier_injected_despite_unrelated_physical_modifier() {
        // User holds Shift, action = Ctrl+C.  Ctrl is NOT active → must be
        // injected.  Shift is active but not in the action → passes through.
        let payload = ShortcutActionPayload {
            key: "C".into(),
            ctrl: true,
            shift: false,
            alt: false,
            win: false,
            raw: None,
        };

        let (plan, reused) = plan_shortcut_inputs(
            &payload,
            &ModifierSnapshot {
                ctrl: false,
                shift: true, // physical
                alt: false,
                win: false,
            },
        )
        .expect("plan should succeed");

        assert!(reused.is_empty());
        // Plan: Ctrl-down, C-down, C-up, Ctrl-up
        assert_eq!(plan.len(), 4);
        // First event must be Ctrl press
        assert!(matches!(
            plan[0],
            KeyboardInputSpec::VirtualKey {
                code,
                key_up: false,
                ..
            } if code == VK_LCONTROL
        ));
    }

    #[test]
    fn hold_down_reuses_already_active_modifier() {
        // Shift is physically held, action = Shift+Win hold.
        // Shift should be reused (not re-injected), Win should be injected.
        let payload = ShortcutActionPayload {
            key: String::new(),
            ctrl: false,
            shift: true,
            alt: false,
            win: true,
            raw: None,
        };

        let (inputs, held) = plan_shortcut_hold_down_inputs(
            &payload,
            &ModifierSnapshot {
                ctrl: false,
                shift: true, // already held
                alt: false,
                win: false,
            },
        )
        .unwrap();

        // Only Win should be injected (Shift is reused from physical state)
        assert_eq!(held.pressed_modifier_vks.len(), 1, "only Win injected");
        assert_eq!(
            held.pressed_modifier_vks[0].code,
            ModifierKey::Win.virtual_key().code,
        );
        assert_eq!(inputs.len(), 1, "only Win-down");
    }

    #[test]
    fn hold_down_modifier_only_shortcut() {
        // Modifier-only action (Shift+Win) with nothing held → both injected.
        let payload = ShortcutActionPayload {
            key: String::new(),
            ctrl: false,
            shift: true,
            alt: false,
            win: true,
            raw: None,
        };

        let (inputs, held) = plan_shortcut_hold_down_inputs(
            &payload,
            &ModifierSnapshot::default(),
        )
        .unwrap();

        assert!(held.primary_key.is_none());
        assert_eq!(held.pressed_modifier_vks.len(), 2, "Win + Shift injected");
        // All inputs should be key-down only
        assert!(inputs.iter().all(|i| match i {
            KeyboardInputSpec::VirtualKey { key_up, .. } => !key_up,
            _ => false,
        }));
        assert_eq!(inputs.len(), 2);
    }

    #[test]
    fn hold_up_empty_when_all_reused() {
        // If all modifiers were reused (none injected), hold-up has nothing to release.
        let held = HeldShortcutState {
            pressed_modifier_vks: vec![],
            primary_key: None,
        };

        let inputs = plan_shortcut_hold_up_inputs(&held);
        assert!(inputs.is_empty());
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
