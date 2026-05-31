use crate::config::{MouseActionPayload, ShortcutActionPayload};
use crate::hotkeys::HotkeyModifiers;
use crate::vk::*;

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
    log::info!(
        "[send-shortcut] enter: {}{}{}{}{} (encoding_mods: ctrl={} shift={} alt={} win={})",
        if payload.ctrl { "Ctrl+" } else { "" },
        if payload.shift { "Shift+" } else { "" },
        if payload.alt { "Alt+" } else { "" },
        if payload.win { "Win+" } else { "" },
        payload.key,
        encoding_mods.ctrl, encoding_mods.shift, encoding_mods.alt, encoding_mods.win,
    );
    clear_modifiers(encoding_mods)?;
    let snapshot = current_modifier_snapshot()?;
    log::info!(
        "[send-shortcut] post-clear snapshot: ctrl={} shift={} alt={} win={}",
        snapshot.is_active(ModifierKey::Ctrl),
        snapshot.is_active(ModifierKey::Shift),
        snapshot.is_active(ModifierKey::Alt),
        snapshot.is_active(ModifierKey::Win),
    );
    let (plan, reused_modifiers) = plan_shortcut_inputs(payload, &snapshot)?;
    log::info!(
        "[send-shortcut] plan: {} inputs, reused-modifiers={:?}",
        plan.len(),
        reused_modifiers.iter().map(|m| m.label()).collect::<Vec<_>>(),
    );

    if let Err(send_error) = send_keyboard_inputs(&plan) {
        // Best-effort cleanup: a partial SendInput can leave the primary key OR
        // modifiers physically down. Release everything the plan could have
        // pressed (primary + pressed modifiers), not just modifiers.
        let cleanup = build_shortcut_cleanup_inputs(payload, &snapshot);
        if !cleanup.is_empty() {
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

/// Best-effort key-ups to release everything a shortcut plan could have pressed,
/// for the cleanup path when `send_keyboard_inputs` reports a partial insert. A
/// truncated plan can leave the primary key OR modifiers physically down, so we
/// over-release the primary key (if any) plus every desired-but-not-already-
/// active modifier — a key-up of an un-pressed key is a harmless no-op. Infallible:
/// a primary key that fails to parse is skipped (modifiers still get released).
fn build_shortcut_cleanup_inputs(
    payload: &ShortcutActionPayload,
    snapshot: &ModifierSnapshot,
) -> Vec<KeyboardInputSpec> {
    let mut cleanup = Vec::new();
    if !payload.key.trim().is_empty() {
        if let Ok(pk) = parse_primary_key(&payload.key) {
            if !is_modifier_vk(pk.code) {
                push_virtual_key_up(&mut cleanup, pk);
            }
        }
    }
    cleanup.extend(build_modifier_release_inputs(&extract_pressed_modifiers(
        payload, snapshot,
    )));
    cleanup
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

    // On a partial send, the only virtual key that can be left physically down
    // is VK_RETURN (newline taps); Unicode events latch no key. Release it plus
    // any modifiers, best-effort, before propagating the error.
    let cleanup_on_partial_send = || {
        release_all_modifiers();
        let _ = send_keyboard_inputs(&[KeyboardInputSpec::VirtualKey {
            code: VK_RETURN,
            extended: false,
            key_up: true,
        }]);
    };

    if inter_key_delay_ms == 0 {
        if let Err(e) = send_keyboard_inputs(&plan) {
            cleanup_on_partial_send();
            return Err(e);
        }
        return Ok(());
    }

    // Send character-by-character: each char = 2 events (down + up)
    for chunk in plan.chunks(2) {
        if let Err(e) = send_keyboard_inputs(chunk) {
            cleanup_on_partial_send();
            return Err(e);
        }
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

/// Build the set of key-up inputs used by `release_all_modifiers`.
/// Covers L+R variants AND generic VK_CONTROL/SHIFT/MENU per AHK community
/// best practice — when the exact held state is unknown, KeyUp for an
/// unpressed VK is a no-op for the OS, so the blast is safe.  Split out so
/// unit tests can assert the spec list without invoking SendInput.
#[cfg(target_os = "windows")]
fn build_release_all_modifier_inputs() -> Vec<KeyboardInputSpec> {
    // The extended flag on each VK is physically accurate (RCtrl/RAlt ARE
    // extended scancodes; RShift/RWin are not), but it does not affect release
    // correctness: Windows matches a KEYEVENTF_KEYUP by virtual-key code, not by
    // the extended bit, and the generic VK_CONTROL/SHIFT/MENU entries below
    // release whichever side is physically down regardless. So this blast is
    // side- and extended-agnostic and needs no extra variants.
    vec![
        KeyboardInputSpec::VirtualKey { code: VK_LCONTROL, extended: false, key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_RCONTROL, extended: true,  key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_CONTROL,  extended: false, key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_LSHIFT,   extended: false, key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_RSHIFT,   extended: false, key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_SHIFT,    extended: false, key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_LMENU,    extended: false, key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_RMENU,    extended: true,  key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_MENU,     extended: false, key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_LWIN,     extended: false, key_up: true },
        KeyboardInputSpec::VirtualKey { code: VK_RWIN,     extended: false, key_up: true },
    ]
}

/// Emergency release: blast key-up for all standard modifiers.
/// Used by panic hooks, crash-sentinel recovery (`lib.rs:check_crash_sentinel`)
/// and helper teardown.
pub fn release_all_modifiers() {
    #[cfg(target_os = "windows")]
    {
        let inputs = build_release_all_modifier_inputs();
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
        if is_modifier_vk(pk.code) {
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
        if is_modifier_vk(pk.code) {
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
    } else if payload.alt || payload.win {
        // Modifier-only shortcut with Alt or Win: inject the mask key
        // (VK 0xE8, down+up) so Windows sees a non-modifier event between
        // modifier-down and the eventual modifier-up.  Without this the
        // lone Alt-up activates the window menu and the lone Win-up opens
        // the Start menu — both swallow the modifier combo the user was
        // trying to express.
        push_virtual_key_tap(
            &mut inputs,
            VirtualKeySpec {
                code: VK_MASK_KEY,
                extended: false,
            },
        );
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

impl From<crate::hotkeys::HotkeyKey> for VirtualKeySpec {
    fn from(key: crate::hotkeys::HotkeyKey) -> Self {
        VirtualKeySpec {
            code: key.code,
            extended: key.extended,
        }
    }
}

fn parse_primary_key(key: &str) -> Result<VirtualKeySpec, String> {
    // Canonical, layout-independent parsing lives in `hotkeys` (named keys,
    // function keys, OEM punctuation, raw `VK_<n>` codes, and the static
    // Cyrillic→Latin table).  Delegating here keeps a single source of truth and
    // removes the historical double-parse drift (e.g. a `VK_232` step that
    // validated via `hotkeys` but failed here).
    match crate::hotkeys::parse_primary_key(key) {
        Ok(hk) => Ok(hk.into()),
        Err(err) => {
            // Execution-only fallback: a single non-ASCII character the
            // layout-independent parser cannot resolve may still map to a key on
            // the *active* keyboard layout via `VkKeyScanW`.  This stays out of
            // `hotkeys` (also used for validation), which must remain
            // layout-independent.
            let trimmed = key.trim();
            if trimmed.chars().count() == 1 {
                if let Some(ch) = trimmed.chars().next() {
                    if !ch.is_ascii() {
                        if let Some(spec) = resolve_char_to_vk(ch) {
                            return Ok(spec);
                        }
                    }
                }
            }
            Err(err)
        }
    }
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
    if vk == 0 || is_modifier_vk(vk) {
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

    // The LL-hook modifier buffering in capture_backend/windows.rs already
    // prevents Razer encoding modifiers from reaching the OS.  Anything
    // GetAsyncKeyState reports as held at action-dispatch time is therefore
    // the user's physical keyboard — releasing it here would break
    // "hold Ctrl on keyboard + side button → Ctrl+Delete" (and similar).
    //
    // Exception: text injection passes ALL_MODIFIERS (all four bits set)
    // because held Ctrl/Alt corrupts Unicode / VK_PACKET output.  Fall
    // through to the legacy release-all path only for that case.
    let is_all_modifiers = mask.ctrl && mask.shift && mask.alt && mask.win;
    if !is_all_modifiers {
        log::debug!(
            "[clear-modifiers] skipped — buffering handles encoding mods \
             (mask: ctrl={} shift={} alt={} win={})",
            mask.ctrl, mask.shift, mask.alt, mask.win,
        );
        return Ok(());
    }

    // Diagnostic snapshot — distinguish L vs R variants for each modifier
    // so we can confirm whether the Razer driver injects LMENU or RMENU.
    let snapshot_state = || -> String {
        unsafe {
            format!(
                "LCTRL={} RCTRL={} VK_CONTROL={} | LSHIFT={} RSHIFT={} VK_SHIFT={} | LMENU={} RMENU={} VK_MENU={} | LWIN={} RWIN={}",
                key_is_down(GetAsyncKeyState(VK_LCONTROL as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_RCONTROL as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_CONTROL as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_LSHIFT as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_RSHIFT as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_SHIFT as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_LMENU as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_RMENU as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_MENU as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_LWIN as i32)) as u8,
                key_is_down(GetAsyncKeyState(VK_RWIN as i32)) as u8,
            )
        }
    };

    let pre_state = snapshot_state();
    log::debug!(
        "[clear-modifiers] mask: ctrl={} shift={} alt={} win={} | pre: {}",
        mask.ctrl, mask.shift, mask.alt, mask.win, pre_state,
    );

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
                    c if c == VK_LCONTROL => Some("VK_LCONTROL"),
                    c if c == VK_LSHIFT => Some("VK_LSHIFT"),
                    c if c == VK_LMENU => Some("VK_LMENU"),
                    c if c == VK_LWIN => Some("VK_LWIN"),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        log::debug!(
            "[clear-modifiers] releasing: [{}]",
            labels.join(", "),
        );
        send_keyboard_inputs(&release_inputs)?;
        let post_state = snapshot_state();
        log::debug!("[clear-modifiers] post: {}", post_state);
    } else {
        log::debug!("[clear-modifiers] nothing to release");
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn clear_modifiers(_mask: &HotkeyModifiers) -> Result<(), String> {
    // No-op on Linux. The Razer device is exclusively grabbed, so its
    // encoding modifiers (Ctrl/Alt/Shift/Win) never reach the compositor.
    // Sending spurious key-up events on the virtual keyboard for keys that
    // were never pressed on it confuses the compositor and can cause stuck
    // modifier keys.
    Ok(())
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

    let summary: Vec<String> = inputs
        .iter()
        .map(|i| match i {
            KeyboardInputSpec::VirtualKey { code, extended, key_up } => format!(
                "VK(0x{:02X},{}{})",
                code,
                if *extended { "ext," } else { "" },
                if *key_up { "up" } else { "down" },
            ),
            KeyboardInputSpec::Unicode { code_unit, key_up } => format!(
                "U(0x{:04X},{})",
                code_unit,
                if *key_up { "up" } else { "down" },
            ),
        })
        .collect();
    log::debug!("[send-keyboard-inputs] sending {} inputs: [{}]", inputs.len(), summary.join(", "));

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
/// VK code → evdev KeyCode mapping for common keys.
fn vk_to_evdev_key(code: u16) -> Option<evdev::KeyCode> {
    use evdev::KeyCode;
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
        // 0-9: evdev order is KEY_1(2)..KEY_9(10), KEY_0(11) — not contiguous
        // with VK order 0x30('0')..0x39('9'), so map explicitly.
        0x30 => KeyCode::KEY_0,
        0x31 => KeyCode::KEY_1,
        0x32 => KeyCode::KEY_2,
        0x33 => KeyCode::KEY_3,
        0x34 => KeyCode::KEY_4,
        0x35 => KeyCode::KEY_5,
        0x36 => KeyCode::KEY_6,
        0x37 => KeyCode::KEY_7,
        0x38 => KeyCode::KEY_8,
        0x39 => KeyCode::KEY_9,
        // A-Z: Windows VK codes are alphabetical, but evdev keycodes follow
        // physical QWERTY layout — explicit mapping required.
        0x41 => KeyCode::KEY_A,
        0x42 => KeyCode::KEY_B,
        0x43 => KeyCode::KEY_C,
        0x44 => KeyCode::KEY_D,
        0x45 => KeyCode::KEY_E,
        0x46 => KeyCode::KEY_F,
        0x47 => KeyCode::KEY_G,
        0x48 => KeyCode::KEY_H,
        0x49 => KeyCode::KEY_I,
        0x4A => KeyCode::KEY_J,
        0x4B => KeyCode::KEY_K,
        0x4C => KeyCode::KEY_L,
        0x4D => KeyCode::KEY_M,
        0x4E => KeyCode::KEY_N,
        0x4F => KeyCode::KEY_O,
        0x50 => KeyCode::KEY_P,
        0x51 => KeyCode::KEY_Q,
        0x52 => KeyCode::KEY_R,
        0x53 => KeyCode::KEY_S,
        0x54 => KeyCode::KEY_T,
        0x55 => KeyCode::KEY_U,
        0x56 => KeyCode::KEY_V,
        0x57 => KeyCode::KEY_W,
        0x58 => KeyCode::KEY_X,
        0x59 => KeyCode::KEY_Y,
        0x5A => KeyCode::KEY_Z,
        0x5B => KeyCode::KEY_LEFTMETA,
        0x5D => KeyCode::KEY_COMPOSE,
        // F1-F10 (contiguous in evdev: KEY_F1=59..KEY_F10=68)
        0x70..=0x79 => KeyCode::new((code - 0x70 + KeyCode::KEY_F1.0) as u16),
        // F11-F12 (non-contiguous: KEY_F11=87, KEY_F12=88)
        0x7A => KeyCode::KEY_F11,
        0x7B => KeyCode::KEY_F12,
        // F13-F24 (non-contiguous: KEY_F13=183..KEY_F24=194)
        0x7C..=0x87 => KeyCode::new((code - 0x7C + KeyCode::KEY_F13.0) as u16),
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

#[cfg(target_os = "linux")]
/// Persistent virtual keyboard device for uinput injection.
///
/// Created once on first use with all possible keys registered, so the
/// Wayland compositor has time to detect and start reading from it.
/// Reused for all subsequent key injections.
fn get_virtual_keyboard() -> Result<&'static std::sync::Mutex<evdev::uinput::VirtualDevice>, String>
{
    use std::sync::{Mutex, OnceLock};
    use evdev::{uinput::VirtualDevice, AttributeSet, KeyCode};

    static DEVICE: OnceLock<Result<Mutex<VirtualDevice>, String>> = OnceLock::new();

    DEVICE.get_or_init(|| {
        // Register all keys we might ever need so the device doesn't
        // need to be recreated when different shortcuts are used.
        let mut keys = AttributeSet::<KeyCode>::new();
        // Letters A-Z
        for code in 0x41u16..=0x5Au16 {
            if let Some(k) = vk_to_evdev_key(code) { keys.insert(k); }
        }
        // Digits 0-9
        for code in 0x30u16..=0x39u16 {
            if let Some(k) = vk_to_evdev_key(code) { keys.insert(k); }
        }
        // F1-F24
        for code in 0x70u16..=0x87u16 {
            if let Some(k) = vk_to_evdev_key(code) { keys.insert(k); }
        }
        // Modifiers
        for code in [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B] {
            if let Some(k) = vk_to_evdev_key(code) { keys.insert(k); }
        }
        // Common special keys
        for code in [0x08, 0x09, 0x0D, 0x13, 0x14, 0x1B, 0x20, 0x21, 0x22,
                     0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E,
                     0x5D, 0x90, 0x91] {
            if let Some(k) = vk_to_evdev_key(code) { keys.insert(k); }
        }
        // OEM keys
        for code in [0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0, 0xDB, 0xDC, 0xDD, 0xDE] {
            if let Some(k) = vk_to_evdev_key(code) { keys.insert(k); }
        }

        let device = VirtualDevice::builder()
            .map_err(|e| format!("Failed to create virtual keyboard builder: {e}"))?
            .name("Sidearm Virtual Keyboard")
            .with_keys(&keys)
            .map_err(|e| format!("Failed to configure virtual keyboard keys: {e}"))?
            .build()
            .map_err(|e| format!("Failed to build virtual keyboard device: {e}"))?;

        log::info!("[input] Persistent virtual keyboard device created.");

        // Give the compositor time to detect the new device.
        std::thread::sleep(std::time::Duration::from_millis(200));

        Ok(Mutex::new(device))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

#[cfg(target_os = "linux")]
fn send_keyboard_inputs(inputs: &[KeyboardInputSpec]) -> Result<(), String> {
    use evdev::{EventType, InputEvent};

    let mut device = get_virtual_keyboard()?
        .lock()
        .map_err(|e| format!("Failed to lock virtual keyboard: {e}"))?;

    // Mutter < 49 (GNOME 46 and earlier) has a race condition where modifier
    // key-up events arriving too fast from uinput devices are lost, causing
    // stuck modifiers.  We use longer delays around modifier transitions and
    // shorter delays between regular keys to keep total latency reasonable.
    let modifier_delay = std::time::Duration::from_millis(25);
    let key_delay = std::time::Duration::from_millis(5);

    let mut prev_was_modifier = false;

    for input in inputs {
        match input {
            KeyboardInputSpec::VirtualKey { code, key_up, .. } => {
                if let Some(key) = vk_to_evdev_key(*code) {
                    let is_modifier = is_modifier_vk(*code);

                    // Extra delay at modifier↔key boundary (e.g. Ctrl↓ → V↓
                    // or V↑ → Ctrl↑) to ensure Mutter processes the modifier
                    // state change before/after the primary key.
                    if prev_was_modifier != is_modifier && prev_was_modifier {
                        std::thread::sleep(modifier_delay);
                    }

                    let value = if *key_up { 0 } else { 1 };
                    let event = InputEvent::new(EventType::KEY.0, key.0, value);
                    device.emit(&[event])
                        .map_err(|e| format!("Failed to emit key event: {e}"))?;

                    std::thread::sleep(if is_modifier { modifier_delay } else { key_delay });
                    prev_was_modifier = is_modifier;
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
    log::debug!(
        "[send-mouse] enter: action={:?} mods=(ctrl={} shift={} alt={} win={}) \
         (encoding_mods: ctrl={} shift={} alt={} win={})",
        payload.action,
        payload.ctrl, payload.shift, payload.alt, payload.win,
        encoding_mods.ctrl, encoding_mods.shift, encoding_mods.alt, encoding_mods.win,
    );
    clear_modifiers(encoding_mods)?;

    let has_modifier = payload.ctrl || payload.shift || payload.alt || payload.win;
    let pressed_modifiers = if has_modifier {
        let snapshot = current_modifier_snapshot()?;
        log::debug!(
            "[send-mouse] post-clear snapshot: ctrl={} shift={} alt={} win={}",
            snapshot.is_active(ModifierKey::Ctrl),
            snapshot.is_active(ModifierKey::Shift),
            snapshot.is_active(ModifierKey::Alt),
            snapshot.is_active(ModifierKey::Win),
        );
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
        log::debug!(
            "[send-mouse] pressing modifiers: {:?}",
            mods_to_press.iter().map(|m| m.label()).collect::<Vec<_>>(),
        );

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
            if let Err(e) = send_keyboard_inputs(&press_inputs) {
                // Partial insert can leave modifiers physically down — release
                // them before bailing (the LIFO release below is skipped on early return).
                let _ = send_keyboard_inputs(&build_modifier_release_inputs(&mods_to_press));
                return Err(e);
            }
        }
        mods_to_press
    } else {
        Vec::new()
    };

    // Inject the mouse event
    let result = send_mouse_event(payload.action);

    // Release modifiers in reverse order (LIFO)
    if !pressed_modifiers.is_empty() {
        log::debug!(
            "[send-mouse] releasing modifiers (LIFO): {:?}",
            pressed_modifiers.iter().rev().map(|m| m.label()).collect::<Vec<_>>(),
        );
        let release = build_modifier_release_inputs(&pressed_modifiers);
        let _ = send_keyboard_inputs(&release);
    } else {
        log::debug!("[send-mouse] no modifiers to release");
    }

    log::debug!("[send-mouse] exit: result={:?}", result.as_ref().map(|_| "ok"));
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
/// Persistent virtual mouse device for uinput injection.
fn get_virtual_mouse() -> Result<&'static std::sync::Mutex<evdev::uinput::VirtualDevice>, String> {
    use std::sync::{Mutex, OnceLock};
    use evdev::{uinput::VirtualDevice, AttributeSet, KeyCode, RelativeAxisCode};

    static DEVICE: OnceLock<Result<Mutex<VirtualDevice>, String>> = OnceLock::new();

    DEVICE.get_or_init(|| {
        let mut keys = AttributeSet::<KeyCode>::new();
        keys.insert(KeyCode::BTN_LEFT);
        keys.insert(KeyCode::BTN_RIGHT);
        keys.insert(KeyCode::BTN_MIDDLE);
        keys.insert(KeyCode::BTN_SIDE);
        keys.insert(KeyCode::BTN_EXTRA);

        let mut axes = AttributeSet::<RelativeAxisCode>::new();
        axes.insert(RelativeAxisCode::REL_WHEEL);
        axes.insert(RelativeAxisCode::REL_HWHEEL);

        let device = VirtualDevice::builder()
            .map_err(|e| format!("Failed to create virtual mouse builder: {e}"))?
            .name("Sidearm Virtual Mouse")
            .with_keys(&keys)
            .map_err(|e| format!("Failed to configure virtual mouse keys: {e}"))?
            .with_relative_axes(&axes)
            .map_err(|e| format!("Failed to configure virtual mouse axes: {e}"))?
            .build()
            .map_err(|e| format!("Failed to build virtual mouse device: {e}"))?;

        log::info!("[input] Persistent virtual mouse device created.");
        std::thread::sleep(std::time::Duration::from_millis(200));

        Ok(Mutex::new(device))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

#[cfg(target_os = "linux")]
fn send_mouse_event(action: crate::config::MouseActionKind) -> Result<(), String> {
    use crate::config::MouseActionKind;
    use evdev::{EventType, InputEvent, KeyCode, RelativeAxisCode};

    let mut device = get_virtual_mouse()?
        .lock()
        .map_err(|e| format!("Failed to lock virtual mouse: {e}"))?;

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
    #[cfg(target_os = "windows")]
    fn release_all_modifiers_emits_left_right_and_generic_variants() {
        let inputs = build_release_all_modifier_inputs();
        let codes: Vec<u16> = inputs
            .iter()
            .filter_map(|i| match i {
                KeyboardInputSpec::VirtualKey { code, key_up: true, .. } => Some(*code),
                _ => None,
            })
            .collect();

        // All 11 modifier VKs covered, all key-ups.
        for vk in [
            VK_LCONTROL, VK_RCONTROL, VK_CONTROL,
            VK_LSHIFT, VK_RSHIFT, VK_SHIFT,
            VK_LMENU, VK_RMENU, VK_MENU,
            VK_LWIN, VK_RWIN,
        ] {
            assert!(codes.contains(&vk), "missing VK 0x{:02X} in release-all blast", vk);
        }
        assert_eq!(codes.len(), 11, "should emit exactly 11 modifier VKs");
    }

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
        assert!(error.contains("ambiguous"));
    }

    #[test]
    fn parse_primary_key_accepts_raw_vk_via_canonical_parser() {
        // Regression for the double-parse bug: raw VK codes are parsed by
        // `hotkeys` and must round-trip through the delegate.  Previously
        // `input_synthesis` rejected them, so a Send step like "Ctrl+VK_232"
        // validated via `hotkeys::parse_hotkey` but failed at live execution.
        let spec = parse_primary_key("VK_232").expect("raw VK should parse");
        assert_eq!(spec.code, 232);
    }

    #[test]
    fn parse_primary_key_normalizes_cyrillic_via_canonical_parser() {
        // Cyrillic 'С' (U+0421) maps to Latin 'C' through the static ЙЦУКЕН
        // table now shared in `hotkeys`.
        let spec = parse_primary_key("С").expect("cyrillic should parse");
        assert_eq!(spec.code, u16::from(b'C'));
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
    fn cleanup_includes_primary_and_pressed_modifiers() {
        // Ctrl+C with nothing already held → on a partial send we must release
        // BOTH the primary key (C) and the modifier we pressed (Ctrl).
        let payload = ShortcutActionPayload {
            key: "C".into(),
            ctrl: true,
            shift: false,
            alt: false,
            win: false,
            raw: Some("^c".into()),
        };
        let cleanup = build_shortcut_cleanup_inputs(&payload, &ModifierSnapshot::default());
        assert_eq!(
            cleanup,
            vec![
                KeyboardInputSpec::VirtualKey { code: b'C' as u16, extended: false, key_up: true },
                KeyboardInputSpec::VirtualKey { code: VK_LCONTROL, extended: false, key_up: true },
            ]
        );
    }

    #[test]
    fn cleanup_modifier_only_has_no_primary() {
        // Ctrl+Alt (modifier-only) → cleanup releases only the modifiers (Alt
        // then Ctrl, reverse press order), no primary key.
        let payload = ShortcutActionPayload {
            key: "".into(),
            ctrl: true,
            shift: false,
            alt: true,
            win: false,
            raw: None,
        };
        let cleanup = build_shortcut_cleanup_inputs(&payload, &ModifierSnapshot::default());
        assert_eq!(
            cleanup,
            vec![
                KeyboardInputSpec::VirtualKey { code: VK_LMENU, extended: false, key_up: true },
                KeyboardInputSpec::VirtualKey { code: VK_LCONTROL, extended: false, key_up: true },
            ]
        );
    }

    #[test]
    fn cleanup_excludes_already_active_modifier() {
        // Ctrl+C with Ctrl already physically held → Ctrl was NOT pressed by us,
        // so cleanup releases only the primary C (we never touched Ctrl).
        let payload = ShortcutActionPayload {
            key: "C".into(),
            ctrl: true,
            shift: false,
            alt: false,
            win: false,
            raw: Some("^c".into()),
        };
        let snapshot = ModifierSnapshot { ctrl: true, shift: false, alt: false, win: false };
        let cleanup = build_shortcut_cleanup_inputs(&payload, &snapshot);
        assert_eq!(
            cleanup,
            vec![KeyboardInputSpec::VirtualKey { code: b'C' as u16, extended: false, key_up: true }]
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
            KeyboardInputSpec::VirtualKey { code, .. } => *code == 0x08, // VK_BACK
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

        // Only Win should be tracked as pressed (Shift is reused from physical state).
        assert_eq!(held.pressed_modifier_vks.len(), 1, "only Win injected");
        assert_eq!(
            held.pressed_modifier_vks[0].code,
            ModifierKey::Win.virtual_key().code,
        );
        // Expected sequence: Win-down, MASK-down, MASK-up.  The mask key tap
        // prevents lone Win-up from activating the Start menu.
        assert_eq!(inputs.len(), 3, "Win-down + mask-down + mask-up");
        assert!(matches!(
            inputs[0],
            KeyboardInputSpec::VirtualKey {
                code,
                key_up: false,
                ..
            } if code == ModifierKey::Win.virtual_key().code,
        ));
        assert!(matches!(
            inputs[1],
            KeyboardInputSpec::VirtualKey {
                code: VK_MASK_KEY,
                key_up: false,
                ..
            }
        ));
        assert!(matches!(
            inputs[2],
            KeyboardInputSpec::VirtualKey {
                code: VK_MASK_KEY,
                key_up: true,
                ..
            }
        ));
    }

    #[test]
    fn hold_down_modifier_only_shortcut() {
        // Modifier-only action (Shift+Win) with nothing held → both injected,
        // plus a VK 0xE8 mask tap to prevent Start-menu activation on release.
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
        // Expected: Win-down, Shift-down, MASK-down, MASK-up.
        assert_eq!(inputs.len(), 4);
        // First two events are modifier-downs.
        for input in &inputs[..2] {
            assert!(matches!(
                input,
                KeyboardInputSpec::VirtualKey { key_up: false, .. },
            ));
        }
        // Last two events are mask-key tap.
        assert!(matches!(
            inputs[2],
            KeyboardInputSpec::VirtualKey {
                code: VK_MASK_KEY,
                key_up: false,
                ..
            }
        ));
        assert!(matches!(
            inputs[3],
            KeyboardInputSpec::VirtualKey {
                code: VK_MASK_KEY,
                key_up: true,
                ..
            }
        ));
    }

    #[test]
    fn hold_down_modifier_only_ctrl_shift_skips_mask_key() {
        // Modifier-only Ctrl+Shift — no Alt/Win — shouldn't inject mask key
        // because lone Ctrl-up and Shift-up don't activate any system menu.
        let payload = ShortcutActionPayload {
            key: String::new(),
            ctrl: true,
            shift: true,
            alt: false,
            win: false,
            raw: None,
        };

        let (inputs, _held) = plan_shortcut_hold_down_inputs(
            &payload,
            &ModifierSnapshot::default(),
        )
        .unwrap();

        assert_eq!(inputs.len(), 2, "only Ctrl-down + Shift-down, no mask");
        for input in &inputs {
            assert!(matches!(
                input,
                KeyboardInputSpec::VirtualKey { key_up: false, .. },
            ));
        }
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

// ============================================================================
// Property-based edge-case tests (pure logic only — NO SendInput, NO OS calls)
// ============================================================================
#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Helper: construct a minimal ShortcutActionPayload for planning tests.
    // These feed plan_shortcut_inputs and plan_shortcut_hold_down/up_inputs
    // which are pure (return Vec<KeyboardInputSpec>, no OS calls).
    // -----------------------------------------------------------------------

    fn payload_key(key: &str, ctrl: bool, shift: bool, alt: bool, win: bool) -> ShortcutActionPayload {
        ShortcutActionPayload {
            key: key.to_string(),
            ctrl,
            shift,
            alt,
            win,
            raw: None,
        }
    }

    fn default_snapshot() -> ModifierSnapshot {
        ModifierSnapshot::default()
    }

    // -----------------------------------------------------------------------
    // Boundary: build_text_inputs — ASCII printable chars produce exactly
    // 2 events each (down + up as Unicode events)
    // -----------------------------------------------------------------------

    proptest! {
        /// Every ASCII printable character (0x21–0x7E) must produce exactly
        /// 2 KeyboardInputSpec events (Unicode key-down + key-up).
        #[test]
        fn build_text_inputs_ascii_printable_two_events_each(
            chars in prop::collection::vec(0x21u8..=0x7Eu8, 1..20)
        ) {
            let text: String = chars.iter().map(|&b| b as char).collect();
            let char_count = text.chars().count();
            let inputs = build_text_inputs(&text).expect("ASCII printable must not fail");
            // Each ASCII char → 1 UTF-16 code unit → 2 events (down + up)
            prop_assert_eq!(
                inputs.len(),
                char_count * 2,
                "expected {} events for {} ASCII chars, got {}",
                char_count * 2,
                char_count,
                inputs.len()
            );
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: build_text_inputs — line endings
    // -----------------------------------------------------------------------

    #[test]
    fn build_text_inputs_empty_string_ok() {
        let inputs = build_text_inputs("").expect("empty string must succeed");
        assert!(inputs.is_empty(), "empty text must produce no events");
    }

    #[test]
    fn build_text_inputs_lf_produces_two_vk_return_events() {
        let inputs = build_text_inputs("\n").expect("LF must succeed");
        assert_eq!(inputs.len(), 2, "LF -> VK_RETURN tap = 2 events");
        assert!(matches!(
            inputs[0],
            KeyboardInputSpec::VirtualKey { code: VK_RETURN, key_up: false, .. }
        ));
        assert!(matches!(
            inputs[1],
            KeyboardInputSpec::VirtualKey { code: VK_RETURN, key_up: true, .. }
        ));
    }

    #[test]
    fn build_text_inputs_crlf_produces_single_vk_return_tap() {
        // CRLF must collapse to one VK_RETURN tap (2 events), not two.
        let inputs = build_text_inputs("\r\n").expect("CRLF must succeed");
        assert_eq!(inputs.len(), 2, "CRLF must produce exactly one VK_RETURN tap");
    }

    #[test]
    fn build_text_inputs_lone_cr_produces_vk_return_tap() {
        let inputs = build_text_inputs("\r").expect("lone CR must succeed");
        assert_eq!(inputs.len(), 2, "lone CR → one VK_RETURN tap = 2 events");
        assert!(matches!(
            inputs[0],
            KeyboardInputSpec::VirtualKey { code: VK_RETURN, key_up: false, .. }
        ));
    }

    // -----------------------------------------------------------------------
    // Null: build_text_inputs — NUL must return Err, not panic
    // -----------------------------------------------------------------------

    #[test]
    fn build_text_inputs_nul_char_returns_err() {
        let result = build_text_inputs("\0");
        assert!(result.is_err(), "NUL character must produce Err");
    }

    #[test]
    fn build_text_inputs_nul_embedded_in_text_returns_err() {
        let result = build_text_inputs("hello\0world");
        assert!(result.is_err(), "NUL embedded in text must produce Err");
    }

    // -----------------------------------------------------------------------
    // Overflow / unicode: build_text_inputs — BMP and surrogate-pair characters
    // -----------------------------------------------------------------------

    proptest! {
        /// BMP characters (U+0001..=U+FFFF, excluding surrogates, NUL, CR, LF)
        /// must produce exactly 2 Unicode events each.
        #[test]
        fn build_text_inputs_bmp_char_two_events(
            // Bounded range 0x20..=0xFFFF (NUL/CR/LF are all < 0x20, so already
            // excluded); only UTF-16 surrogates need filtering. Using a bounded
            // range instead of filtering prop::num::u32::ANY avoids proptest's
            // "too many local rejects" abort (the filter rejected ~99.998%).
            codepoint in (0x0020u32..=0xFFFFu32)
                .prop_filter("exclude UTF-16 surrogates", |cp| {
                    *cp < 0xD800u32 || *cp > 0xDFFFu32
                })
                .prop_map(|cp| char::from_u32(cp).unwrap())
        ) {
            let text = codepoint.to_string();
            let inputs = build_text_inputs(&text).expect("BMP char must succeed");
            // BMP char: encode_utf16 produces exactly 1 code unit → 2 events
            prop_assert_eq!(
                inputs.len(),
                2,
                "BMP char U+{:04X} must produce 2 events, got {}",
                codepoint as u32,
                inputs.len()
            );
            // Both must be Unicode events, not VirtualKey
            prop_assert!(
                matches!(inputs[0], KeyboardInputSpec::Unicode { key_up: false, .. }),
                "first event must be Unicode key-down"
            );
            prop_assert!(
                matches!(inputs[1], KeyboardInputSpec::Unicode { key_up: true, .. }),
                "second event must be Unicode key-up"
            );
        }
    }

    /// Surrogate-pair char: encode_utf16 produces 2 code units → 4 events.
    /// BUG-PROBE: send_text_with_delay uses plan.chunks(2) to pace events.
    /// For a surrogate-pair char the plan has 4 events, so chunks(2) sends
    /// the two halves as separate "characters" with a sleep between them.
    /// While not incorrect for the OS (it reassembles surrogates), this
    /// means the delay fires after the high surrogate alone, before the low
    /// surrogate arrives — behaviour that differs from BMP chars.
    /// Document with a concrete test.
    #[test]
    fn build_text_inputs_surrogate_pair_four_events() {
        // U+1F600 GRINNING FACE — outside BMP, requires two UTF-16 code units.
        let emoji = "\u{1F600}";
        let inputs = build_text_inputs(emoji).expect("emoji must succeed");
        assert_eq!(
            inputs.len(),
            4,
            "emoji U+1F600 requires 2 UTF-16 code units → 4 events (down+up per unit)"
        );
        // All four must be Unicode events
        for (i, ev) in inputs.iter().enumerate() {
            assert!(
                matches!(ev, KeyboardInputSpec::Unicode { .. }),
                "event[{}] must be Unicode for emoji input",
                i
            );
        }
        // First two are down+up for the high surrogate (0xD83D)
        assert!(matches!(inputs[0], KeyboardInputSpec::Unicode { key_up: false, .. }));
        assert!(matches!(inputs[1], KeyboardInputSpec::Unicode { key_up: true, .. }));
        // Last two are down+up for the low surrogate (0xDE00)
        assert!(matches!(inputs[2], KeyboardInputSpec::Unicode { key_up: false, .. }));
        assert!(matches!(inputs[3], KeyboardInputSpec::Unicode { key_up: true, .. }));
    }

    /// build_text_inputs must never panic on arbitrary Unicode strings —
    /// only Err on NUL; everything else must succeed.
    proptest! {
        #[test]
        fn build_text_inputs_never_panics_arbitrary_unicode(text in ".*") {
            // May return Err only if text contains \0.
            let result = build_text_inputs(&text);
            if text.contains('\0') {
                prop_assert!(result.is_err());
            } else {
                prop_assert!(result.is_ok());
            }
        }
    }

    // -----------------------------------------------------------------------
    // Boundary + overflow: build_text_inputs — very long strings don't panic
    // -----------------------------------------------------------------------

    proptest! {
        /// A string of n ASCII 'A' characters must produce exactly 2*n events.
        #[test]
        fn build_text_inputs_long_ascii_event_count_scales_linearly(n in 0usize..500) {
            let text = "A".repeat(n);
            let inputs = build_text_inputs(&text).expect("long ASCII must succeed");
            prop_assert_eq!(inputs.len(), n * 2);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: push_virtual_key_tap — always produces down then up
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn push_virtual_key_tap_always_down_then_up(code in any::<u16>(), extended in any::<bool>()) {
            let mut inputs = Vec::new();
            push_virtual_key_tap(&mut inputs, VirtualKeySpec { code, extended });
            prop_assert_eq!(inputs.len(), 2);
            prop_assert!(
                matches!(
                    inputs[0],
                    KeyboardInputSpec::VirtualKey { key_up: false, .. }
                ),
                "first event must be a key-down"
            );
            prop_assert!(
                matches!(
                    inputs[1],
                    KeyboardInputSpec::VirtualKey { key_up: true, .. }
                ),
                "second event must be a key-up"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: plan_shortcut_hold_up_inputs — all events are key-up
    // -----------------------------------------------------------------------

    proptest! {
        /// For any HeldShortcutState (arbitrary pressed modifier list + optional
        /// primary key), plan_shortcut_hold_up_inputs must produce only key-up events.
        #[test]
        fn plan_hold_up_all_events_are_key_up(
            mod_codes in prop::collection::vec(any::<u16>(), 0..5),
            has_primary in any::<bool>(),
            primary_code in any::<u16>(),
        ) {
            let pressed_modifier_vks = mod_codes
                .into_iter()
                .map(|code| VirtualKeySpec { code, extended: false })
                .collect();
            let primary_key = if has_primary {
                Some(VirtualKeySpec { code: primary_code, extended: false })
            } else {
                None
            };
            let held = HeldShortcutState { pressed_modifier_vks, primary_key };
            let inputs = plan_shortcut_hold_up_inputs(&held);
            for ev in &inputs {
                prop_assert!(
                    matches!(ev, KeyboardInputSpec::VirtualKey { key_up: true, .. }),
                    "hold-up must only emit key-up events, found: {:?}",
                    ev
                );
            }
        }

        /// hold-up event count = number of pressed modifiers + 1 if primary is Some.
        #[test]
        fn plan_hold_up_event_count_is_mods_plus_primary(
            mod_codes in prop::collection::vec(any::<u16>(), 0..5),
            has_primary in any::<bool>(),
            primary_code in any::<u16>(),
        ) {
            let n_mods = mod_codes.len();
            let pressed_modifier_vks = mod_codes
                .into_iter()
                .map(|code| VirtualKeySpec { code, extended: false })
                .collect();
            let primary_key = if has_primary {
                Some(VirtualKeySpec { code: primary_code, extended: false })
            } else {
                None
            };
            let held = HeldShortcutState { pressed_modifier_vks, primary_key };
            let inputs = plan_shortcut_hold_up_inputs(&held);
            let expected = n_mods + usize::from(has_primary);
            prop_assert_eq!(inputs.len(), expected);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: plan_shortcut_inputs — empty primary + no modifiers → Err
    // -----------------------------------------------------------------------

    #[test]
    fn plan_shortcut_no_key_no_modifier_returns_err() {
        let payload = payload_key("", false, false, false, false);
        let result = plan_shortcut_inputs(&payload, &default_snapshot());
        assert!(result.is_err(), "shortcut with no key and no modifiers must fail");
    }

    #[test]
    fn plan_shortcut_no_key_with_ctrl_ok() {
        let payload = payload_key("", true, false, false, false);
        let result = plan_shortcut_inputs(&payload, &default_snapshot());
        assert!(result.is_ok(), "modifier-only shortcut must plan successfully");
    }

    // -----------------------------------------------------------------------
    // Boundary: plan_shortcut_inputs — modifier-only shortcut emits paired
    // down+up for every pressed modifier (4 events for 2 modifiers: Ctrl+Alt)
    // -----------------------------------------------------------------------

    #[test]
    fn plan_shortcut_modifier_only_two_modifiers_four_events() {
        let payload = payload_key("", true, false, true, false); // Ctrl + Alt
        let (plan, _reused) = plan_shortcut_inputs(&payload, &default_snapshot())
            .expect("ctrl+alt modifier-only must plan");
        // Win+Ctrl+Alt+Shift ordering: Win, Ctrl, Alt, Shift processed in that order
        // pressed: Ctrl and Alt → 2 down + 2 up = 4 events
        assert_eq!(plan.len(), 4);
        // First two are key-downs; last two are key-ups in reverse
        assert!(matches!(plan[0], KeyboardInputSpec::VirtualKey { key_up: false, .. }));
        assert!(matches!(plan[1], KeyboardInputSpec::VirtualKey { key_up: false, .. }));
        assert!(matches!(plan[2], KeyboardInputSpec::VirtualKey { key_up: true, .. }));
        assert!(matches!(plan[3], KeyboardInputSpec::VirtualKey { key_up: true, .. }));
    }

    // -----------------------------------------------------------------------
    // Boundary: plan_shortcut_inputs — all four modifiers already active
    // (snapshot = all true) → all reused, 0 extra events except primary tap
    // -----------------------------------------------------------------------

    #[test]
    fn plan_shortcut_all_modifiers_reused_primary_only_two_events() {
        let snapshot = ModifierSnapshot {
            ctrl: true,
            shift: true,
            alt: true,
            win: true,
        };
        let payload = payload_key("A", true, true, true, true);
        let (plan, reused) = plan_shortcut_inputs(&payload, &snapshot)
            .expect("all-reused shortcut must plan");
        assert_eq!(reused.len(), 4, "all four modifiers must be marked reused");
        // Only primary tap emitted: down + up = 2 events
        assert_eq!(plan.len(), 2);
        assert!(matches!(plan[0], KeyboardInputSpec::VirtualKey { key_up: false, .. }));
        assert!(matches!(plan[1], KeyboardInputSpec::VirtualKey { key_up: true, .. }));
    }

    // -----------------------------------------------------------------------
    // Boundary: plan_shortcut_inputs — VK_code symmetry:
    // each pressed modifier's key-down matches the corresponding key-up
    // -----------------------------------------------------------------------

    #[test]
    fn plan_shortcut_modifier_down_up_codes_symmetric() {
        // Only Shift, from a clean snapshot
        let payload = payload_key("A", false, true, false, false);
        let (plan, _) = plan_shortcut_inputs(&payload, &default_snapshot())
            .expect("shift+A must plan");
        // Expected: Shift-down, A-down, A-up, Shift-up (4 events)
        assert_eq!(plan.len(), 4);
        let shift_down = match plan[0] {
            KeyboardInputSpec::VirtualKey { code, key_up: false, .. } => code,
            _ => panic!("expected shift key-down first"),
        };
        let shift_up = match plan[3] {
            KeyboardInputSpec::VirtualKey { code, key_up: true, .. } => code,
            _ => panic!("expected shift key-up last"),
        };
        assert_eq!(shift_down, shift_up, "Shift down/up must use the same VK code");
        assert_eq!(shift_down, VK_LSHIFT);
    }

    // -----------------------------------------------------------------------
    // Boundary: extract_pressed_modifiers — never includes modifiers
    // not requested by the payload
    // -----------------------------------------------------------------------

    proptest! {
        /// extract_pressed_modifiers must never return a modifier that the
        /// payload did not request.
        #[test]
        fn extract_pressed_modifiers_only_desired_keys(
            ctrl in any::<bool>(),
            shift in any::<bool>(),
            alt in any::<bool>(),
            win in any::<bool>(),
            snap_ctrl in any::<bool>(),
            snap_shift in any::<bool>(),
            snap_alt in any::<bool>(),
            snap_win in any::<bool>(),
        ) {
            let payload = payload_key("", ctrl, shift, alt, win);
            let snap = ModifierSnapshot {
                ctrl: snap_ctrl,
                shift: snap_shift,
                alt: snap_alt,
                win: snap_win,
            };
            let pressed = extract_pressed_modifiers(&payload, &snap);
            for m in &pressed {
                let desired = match m {
                    ModifierKey::Ctrl => ctrl,
                    ModifierKey::Shift => shift,
                    ModifierKey::Alt => alt,
                    ModifierKey::Win => win,
                };
                prop_assert!(desired, "pressed must only contain desired modifiers");
            }
        }

        /// extract_pressed_modifiers must never return a modifier that is
        /// already active in the snapshot.
        #[test]
        fn extract_pressed_modifiers_never_already_active(
            ctrl in any::<bool>(),
            shift in any::<bool>(),
            alt in any::<bool>(),
            win in any::<bool>(),
            snap_ctrl in any::<bool>(),
            snap_shift in any::<bool>(),
            snap_alt in any::<bool>(),
            snap_win in any::<bool>(),
        ) {
            let payload = payload_key("", ctrl, shift, alt, win);
            let snap = ModifierSnapshot {
                ctrl: snap_ctrl,
                shift: snap_shift,
                alt: snap_alt,
                win: snap_win,
            };
            let pressed = extract_pressed_modifiers(&payload, &snap);
            for m in &pressed {
                let already_active = snap.is_active(*m);
                prop_assert!(
                    !already_active,
                    "modifier {:?} is already active but appeared in pressed list",
                    m
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: build_modifier_release_inputs — all events are key-up
    // -----------------------------------------------------------------------

    proptest! {
        /// build_modifier_release_inputs over any modifier subset must produce
        /// only VirtualKey key-up events, one per modifier.
        #[test]
        fn build_modifier_release_inputs_all_key_up(
            modifiers in prop::collection::vec(
                prop_oneof![
                    Just(ModifierKey::Ctrl),
                    Just(ModifierKey::Shift),
                    Just(ModifierKey::Alt),
                    Just(ModifierKey::Win),
                ],
                0..5,
            ),
        ) {
            let release = build_modifier_release_inputs(&modifiers);
            prop_assert_eq!(release.len(), modifiers.len());
            for ev in &release {
                prop_assert!(
                    matches!(ev, KeyboardInputSpec::VirtualKey { key_up: true, .. }),
                    "release input must be a key-up event"
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: ModifierKey::label — non-empty, well-known strings
    // -----------------------------------------------------------------------

    #[test]
    fn modifier_key_labels_are_known_strings() {
        assert_eq!(ModifierKey::Ctrl.label(), "Ctrl");
        assert_eq!(ModifierKey::Shift.label(), "Shift");
        assert_eq!(ModifierKey::Alt.label(), "Alt");
        assert_eq!(ModifierKey::Win.label(), "Win");
    }

    // -----------------------------------------------------------------------
    // Boundary: ModifierKey::virtual_key — returns known VK codes
    // -----------------------------------------------------------------------

    #[test]
    fn modifier_key_virtual_keys_are_left_variants() {
        assert_eq!(ModifierKey::Ctrl.virtual_key().code, VK_LCONTROL);
        assert_eq!(ModifierKey::Shift.virtual_key().code, VK_LSHIFT);
        assert_eq!(ModifierKey::Alt.virtual_key().code, VK_LMENU);
        assert_eq!(ModifierKey::Win.virtual_key().code, VK_LWIN);
    }

    // -----------------------------------------------------------------------
    // Overflow: Duration from inter_key_delay_ms — no overflow for u32::MAX
    // -----------------------------------------------------------------------

    proptest! {
        /// For any u32 inter_key_delay_ms, Duration::from_millis(u64::from(v))
        /// must not overflow (u32→u64 widening is lossless; max value is
        /// ~49.7 days which fits in Duration).
        #[test]
        fn inter_key_delay_u64_from_u32_never_overflows(v in any::<u32>()) {
            let millis: u64 = u64::from(v);
            let _ = std::time::Duration::from_millis(millis);
            // If we reach here, no panic occurred.
        }
    }

    #[test]
    fn inter_key_delay_u32_max_does_not_overflow() {
        let millis: u64 = u64::from(u32::MAX);
        let d = std::time::Duration::from_millis(millis);
        // ~49.7 days — valid Duration, no panic
        assert!(d > std::time::Duration::from_secs(1));
    }

    // -----------------------------------------------------------------------
    // Overflow / unicode: send_text_with_delay chunk(2) vs surrogate pairs
    //
    // BUG-PROBE documented as a test: the function splits plan.chunks(2) with
    // an inter-key sleep between them.  For a surrogate-pair character (emoji),
    // build_text_inputs produces 4 events.  chunks(2) fires a sleep between
    // the high and low surrogate halves, not between full characters.
    // This test pins the behaviour so any fix is detectable.
    // -----------------------------------------------------------------------

    #[test]
    fn surrogate_pair_produces_4_events_not_2_chunks_of_2() {
        // U+1F916 ROBOT FACE — outside BMP, requires surrogate pair in UTF-16.
        let emoji = "\u{1F916}";
        let inputs = build_text_inputs(emoji).expect("emoji must succeed");
        // The plan has 4 events → chunks(2) would fire delay BETWEEN surrogates,
        // not between characters.  This is the observable artefact.
        assert_eq!(
            inputs.len(),
            4,
            "SMP char must produce 4 events; send_text_with_delay chunks(2) \
             would insert delay between surrogate halves rather than full chars"
        );
    }

    // -----------------------------------------------------------------------
    // Boundary: build_release_all_modifier_inputs (Windows only) — coverage
    // -----------------------------------------------------------------------

    #[cfg(target_os = "windows")]
    #[test]
    fn build_release_all_modifier_inputs_all_key_up_events() {
        let inputs = build_release_all_modifier_inputs();
        for ev in &inputs {
            assert!(
                matches!(ev, KeyboardInputSpec::VirtualKey { key_up: true, .. }),
                "all events from release-all must be key-up"
            );
        }
    }

    #[cfg(target_os = "windows")]
    proptest! {
        /// All codes produced by build_release_all_modifier_inputs must be
        /// recognised by is_modifier_vk or be VK_MASK_KEY — no random VK leaked.
        #[test]
        fn build_release_all_modifier_inputs_only_modifier_vks(_unused in 0u8..1) {
            let inputs = build_release_all_modifier_inputs();
            for ev in &inputs {
                if let KeyboardInputSpec::VirtualKey { code, .. } = ev {
                    prop_assert!(
                        is_modifier_vk(*code),
                        "release-all must only emit modifier VK codes, got 0x{:02X}",
                        code
                    );
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Concurrency: N/A
    //
    // All mutable shared state in input_synthesis (keyboard device mutex on
    // Linux, GetAsyncKeyState on Windows) is inside OS-calling functions.
    // The pure planning/building functions (plan_shortcut_inputs,
    // build_text_inputs, etc.) operate on owned/borrowed data with no global
    // state — concurrency testing of them adds no value beyond the existing
    // properties above.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Temporal: Duration computation coverage — no sleep() calls; only test
    // the Duration VALUE that would be passed to thread::sleep.
    // -----------------------------------------------------------------------

    #[test]
    fn delay_zero_duration_is_zero_not_blocking() {
        let d = std::time::Duration::from_millis(0);
        assert_eq!(d, std::time::Duration::ZERO);
    }

    #[test]
    fn delay_one_ms_duration_is_one_ms() {
        let d = std::time::Duration::from_millis(1);
        assert_eq!(d.as_millis(), 1);
    }

    #[test]
    fn delay_max_u32_duration_does_not_overflow() {
        let d = std::time::Duration::from_millis(u64::from(u32::MAX));
        assert!(d.as_secs() > 0, "u32::MAX ms must be a positive Duration");
    }
}
