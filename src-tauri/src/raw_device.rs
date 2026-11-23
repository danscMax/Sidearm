//! Universal Raw Input device identity and one-shot hardware button/key learning.
//!
//! Lets any mouse, macropad, second keyboard, foot pedal, or HID input device
//! work in Sidearm with zero vendor software: pressing any physical button or
//! key records both the canonical signal (`Mouse4`, `Numpad1`, `1`, `F13`, ...)
//! and the hardware's stable `VID_xxxx&PID_xxxx` identifier so runtime hooks
//! intercept ONLY presses from that physical device.

use serde::Serialize;

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRawInput {
    pub encoded_key: String,
    pub raw_device_id: Option<String>,
    pub raw_device_label: String,
    pub input_kind: String,
}

/// Extracts a stable hardware device identifier (`VID_xxxx&PID_xxxx`, uppercase)
/// from a Windows `RIDI_DEVICENAME` path so bindings survive USB port swaps and
/// reboots. Supports both USB HID (`VID_046D&PID_C548`) and Bluetooth HID
/// (`VID&0002046D_PID&B023`), falling back to a stripped path prefix if neither
/// VID nor PID appears.
pub fn canonical_raw_device_id(device_path: &str) -> Option<String> {
    let upper = device_path.trim().to_ascii_uppercase();
    if upper.is_empty() {
        return None;
    }

    // Standard USB / HID path: `\\?\HID#VID_046D&PID_C548&MI_01#...`
    if let (Some(vid), Some(pid)) = (extract_hex_after(&upper, "VID_", 4), extract_hex_after(&upper, "PID_", 4)) {
        return Some(format!("VID_{vid}&PID_{pid}"));
    }

    // Bluetooth HID path: `...VID&0002046D_PID&B023...` (last 4 hex digits of VID)
    if let (Some(vid_raw), Some(pid)) = (extract_hex_run_after(&upper, "VID&"), extract_hex_after(&upper, "PID&", 4))
        && vid_raw.len() >= 4
    {
        let vid = &vid_raw[vid_raw.len() - 4..];
        return Some(format!("VID_{vid}&PID_{pid}"));
    }

    // Non-USB fallback (PS/2, virtual HID): strip `\\?\` prefix and trailing `#{GUID}` + volatile instance.
    let stripped = upper.strip_prefix(r"\\?\").unwrap_or(&upper);
    let mut parts = stripped.split('#');
    let bus = parts.next().unwrap_or("");
    let hw = parts.next().unwrap_or("");
    if !bus.is_empty() && !hw.is_empty() {
        return Some(format!("{bus}#{hw}"));
    }
    None
}

fn extract_hex_after<'a>(haystack: &'a str, prefix: &str, exact_len: usize) -> Option<&'a str> {
    let start = haystack.find(prefix)? + prefix.len();
    let rest = haystack.get(start..)?;
    if rest.len() < exact_len {
        return None;
    }
    let candidate = &rest[..exact_len];
    candidate.bytes().all(|b| b.is_ascii_hexdigit()).then_some(candidate)
}

fn extract_hex_run_after<'a>(haystack: &'a str, prefix: &str) -> Option<&'a str> {
    let start = haystack.find(prefix)? + prefix.len();
    let rest = haystack.get(start..)?;
    let len = rest.bytes().take_while(|b| b.is_ascii_hexdigit()).count();
    (len >= 4).then_some(&rest[..len])
}

/// Human-readable label for a canonical `raw_device_id` (e.g. `Logitech (VID_046D&PID_C548)`).
pub fn friendly_raw_device_label(raw_id: Option<&str>, input_kind: &str) -> String {
    let Some(id) = raw_id else {
        return if input_kind == "mouse" {
            "Mouse".to_owned()
        } else {
            "Keyboard".to_owned()
        };
    };
    let vendor = extract_hex_after(id, "VID_", 4).and_then(|vid| match vid {
        "046D" => Some("Logitech"),
        "1532" => Some("Razer"),
        "1B1C" => Some("Corsair"),
        "1038" => Some("SteelSeries"),
        "0951" => Some("HyperX"),
        "0FD9" => Some("Elgato"),
        "0B05" => Some("ASUS ROG"),
        "045E" => Some("Microsoft"),
        "05AC" => Some("Apple"),
        "09DA" | "25A7" => Some("A4Tech / Bloody"),
        "1E7D" => Some("Roccat"),
        "2DC8" => Some("8BitDo"),
        "3367" => Some("Wooting"),
        "3434" => Some("Keychron"),
        "16C0" | "FEED" => Some("QMK / Macro Pad"),
        "04D9" | "258A" | "320F" => Some("USB HID"),
        _ => None,
    });
    match vendor {
        Some(name) => format!("{name} ({id})"),
        None => format!("USB ({id})"),
    }
}

/// Maps a Windows virtual-key code (plus `is_e0` extended flag) to a canonical
/// `hotkeys.rs` primary key name, or `None` for modifiers / ignored system VKs.
pub fn vk_to_hotkey_name(vk: u16, is_e0: bool) -> Option<String> {
    use crate::vk::*;
    if is_modifier_vk(vk) || vk == VK_MASK_KEY || vk == 0 || vk == 0xFF {
        return None;
    }
    let name: &str = match vk {
        0x30..=0x39 => return Some((vk as u8 as char).to_string()),
        0x41..=0x5A => return Some((vk as u8 as char).to_string()),
        0x70..=0x87 => return Some(format!("F{}", vk - 0x70 + 1)),
        VK_NUMPAD0..=VK_NUMPAD9 => return Some(format!("Numpad{}", vk - VK_NUMPAD0)),
        VK_MULTIPLY => "NumpadMultiply",
        VK_ADD => "NumpadAdd",
        VK_SUBTRACT => "NumpadSubtract",
        VK_DECIMAL => "NumpadDecimal",
        VK_DIVIDE => "NumpadDivide",
        VK_RETURN => "Enter",
        VK_TAB => "Tab",
        VK_SPACE => "Space",
        VK_BACK => "Backspace",
        VK_DELETE => if is_e0 { "Delete" } else { "NumpadDecimal" },
        VK_INSERT => if is_e0 { "Insert" } else { "Numpad0" },
        VK_HOME => if is_e0 { "Home" } else { "Numpad7" },
        VK_END => if is_e0 { "End" } else { "Numpad1" },
        VK_PRIOR => if is_e0 { "PageUp" } else { "Numpad9" },
        VK_NEXT => if is_e0 { "PageDown" } else { "Numpad3" },
        VK_LEFT => if is_e0 { "Left" } else { "Numpad4" },
        VK_RIGHT => if is_e0 { "Right" } else { "Numpad6" },
        VK_UP => if is_e0 { "Up" } else { "Numpad8" },
        VK_DOWN => if is_e0 { "Down" } else { "Numpad2" },
        VK_CAPITAL => "CapsLock",
        VK_NUMLOCK => "NumLock",
        VK_SNAPSHOT => "PrintScreen",
        VK_SCROLL => "ScrollLock",
        VK_PAUSE => "Pause",
        VK_APPS => "Apps",
        VK_OEM_MINUS => "-",
        VK_OEM_PLUS => "=",
        VK_OEM_COMMA => ",",
        VK_OEM_PERIOD => ".",
        VK_OEM_2 => "/",
        VK_OEM_1 => ";",
        VK_OEM_7 => "'",
        VK_OEM_4 => "[",
        VK_OEM_6 => "]",
        VK_OEM_5 => "\\",
        VK_OEM_3 => "`",
        VK_VOLUME_MUTE => "VolumeMute",
        VK_VOLUME_DOWN => "VolumeDown",
        VK_VOLUME_UP => "VolumeUp",
        VK_MEDIA_NEXT_TRACK => "MediaNext",
        VK_MEDIA_PREV_TRACK => "MediaPrev",
        VK_MEDIA_STOP => "MediaStop",
        VK_MEDIA_PLAY_PAUSE => "MediaPlayPause",
        _ => return Some(format!("VK_{vk}")),
    };
    Some(name.to_owned())
}

#[cfg(target_os = "windows")]
static CAPTURE_CANCELLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static CAPTURE_GEN: AtomicU64 = AtomicU64::new(0);

/// Cancels any active one-shot `capture_next_raw_input` session cleanly.
pub fn cancel_raw_input_capture() {
    #[cfg(target_os = "windows")]
    {
        CAPTURE_CANCELLED.store(true, Ordering::Release);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn capture_next_raw_input(_timeout_ms: u64) -> Result<Option<CapturedRawInput>, String> {
    Ok(None)
}

/// Waits for the next physical keyboard or mouse (middle/right/X1/X2) press
/// from ANY connected device via Windows Raw Input (`WM_INPUT`), returning both
/// the canonical signal and the device's stable `VID_xxxx&PID_xxxx` identity.
/// Returns `Ok(None)` if cancelled (Escape or `cancel_raw_input_capture`) or timed out.
#[cfg(target_os = "windows")]
pub fn capture_next_raw_input(timeout_ms: u64) -> Result<Option<CapturedRawInput>, String> {
    use std::cell::RefCell;
    use std::mem::{MaybeUninit, size_of};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::Input::{
        GetRawInputData, GetRawInputDeviceInfoW, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER,
        RID_INPUT, RIDEV_INPUTSINK, RIDI_DEVICENAME, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
        RegisterRawInputDevices,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, MSG,
        MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW, QS_ALLINPUT,
        RI_KEY_BREAK, RI_KEY_E0, RegisterClassW, TranslateMessage, WM_INPUT, WNDCLASSW,
        WS_OVERLAPPED,
    };

    // RAII guard: suppress live Sidearm action execution while learning so
    // pressing an already-mapped button records it without firing its action.
    struct SuppressGuard(bool);
    impl Drop for SuppressGuard {
        fn drop(&mut self) {
            crate::capture_backend::SUPPRESS_EXECUTION.store(self.0, Ordering::Release);
        }
    }
    let prev_suppress = crate::capture_backend::SUPPRESS_EXECUTION.swap(true, Ordering::AcqRel);
    let _guard = SuppressGuard(prev_suppress);

    let my_gen = CAPTURE_GEN.fetch_add(1, Ordering::AcqRel) + 1;
    CAPTURE_CANCELLED.store(false, Ordering::Release);

    thread_local! {
        static LEARNED: RefCell<Option<Option<CapturedRawInput>>> = const { RefCell::new(None) };
    }
    LEARNED.with(|cell| *cell.borrow_mut() = None);

    fn read_device_path(device: windows_sys::Win32::Foundation::HANDLE) -> Option<String> {
        let mut chars = 0u32;
        unsafe {
            GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, std::ptr::null_mut(), &mut chars);
            if chars == 0 {
                return None;
            }
            let mut buf = vec![0u16; chars as usize];
            let written = GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, buf.as_mut_ptr().cast(), &mut chars);
            (written != u32::MAX && written > 0).then(|| {
                String::from_utf16_lossy(&buf[..(written as usize).min(buf.len())])
                    .trim_end_matches('\0')
                    .to_owned()
            })
        }
    }

    fn key_held(vk: i32) -> bool {
        unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
    }

    unsafe extern "system" fn learn_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_INPUT {
            let mut raw: RAWINPUT = unsafe { std::mem::zeroed() };
            let mut size = size_of::<RAWINPUT>() as u32;
            let read = unsafe {
                GetRawInputData(
                    lparam as HRAWINPUT,
                    RID_INPUT,
                    (&raw mut raw).cast(),
                    &mut size,
                    size_of::<RAWINPUTHEADER>() as u32,
                )
            };
            if read != u32::MAX && !raw.header.hDevice.is_null() {
                let raw_id = read_device_path(raw.header.hDevice)
                    .and_then(|p| canonical_raw_device_id(&p));
                if raw.header.dwType == RIM_TYPEKEYBOARD {
                    let kb = unsafe { raw.data.keyboard };
                    let is_up = (kb.Flags & RI_KEY_BREAK as u16) != 0;
                    if !is_up {
                        let vk = kb.VKey;
                        let is_e0 = (kb.Flags & RI_KEY_E0 as u16) != 0;
                        let ctrl = key_held(crate::vk::VK_CONTROL as i32);
                        let alt = key_held(crate::vk::VK_MENU as i32);
                        let shift = key_held(crate::vk::VK_SHIFT as i32);
                        let win = key_held(crate::vk::VK_LWIN as i32) || key_held(crate::vk::VK_RWIN as i32);
                        if vk == crate::vk::VK_ESCAPE && !ctrl && !alt && !shift && !win {
                            LEARNED.with(|cell| *cell.borrow_mut() = Some(None));
                        } else if let Some(primary) = vk_to_hotkey_name(vk, is_e0) {
                            let mut parts = Vec::new();
                            if ctrl { parts.push("Ctrl".to_owned()); }
                            if alt { parts.push("Alt".to_owned()); }
                            if shift { parts.push("Shift".to_owned()); }
                            if win { parts.push("Win".to_owned()); }
                            parts.push(primary);
                            let encoded = crate::hotkeys::normalize_hotkey(&parts.join("+"))
                                .unwrap_or_else(|_| parts.join("+"));
                            let label = friendly_raw_device_label(raw_id.as_deref(), "keyboard");
                            LEARNED.with(|cell| {
                                *cell.borrow_mut() = Some(Some(CapturedRawInput {
                                    encoded_key: encoded,
                                    raw_device_id: raw_id,
                                    raw_device_label: label,
                                    input_kind: "keyboard".to_owned(),
                                }));
                            });
                        }
                    }
                } else if raw.header.dwType == RIM_TYPEMOUSE {
                    let flags = unsafe { raw.data.mouse.Anonymous.Anonymous.usButtonFlags };
                    // Never capture Left Click so clicking modal buttons ("Cancel", "Record") works normally.
                    let button = if flags & 0x0040 != 0 {
                        Some("Mouse4")
                    } else if flags & 0x0100 != 0 {
                        Some("Mouse5")
                    } else if flags & 0x0010 != 0 {
                        Some("MouseMiddle")
                    } else if flags & 0x0004 != 0 {
                        Some("MouseRight")
                    } else {
                        None
                    };
                    if let Some(btn_name) = button {
                        let label = friendly_raw_device_label(raw_id.as_deref(), "mouse");
                        LEARNED.with(|cell| {
                            *cell.borrow_mut() = Some(Some(CapturedRawInput {
                                encoded_key: btn_name.to_owned(),
                                raw_device_id: raw_id,
                                raw_device_label: label,
                                input_kind: "mouse".to_owned(),
                            }));
                        });
                    }
                }
            }
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    let class: Vec<u16> = "SidearmRawLearnWindow\0".encode_utf16().collect();
    let hwnd = unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSW {
            lpfnWndProc: Some(learn_wnd_proc),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&wc);
        CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            WS_OVERLAPPED,
            0, 0, 0, 0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if hwnd.is_null() {
        return Err(format!("Could not create raw input learn window: {}", std::io::Error::last_os_error()));
    }

    struct WindowGuard(HWND);
    impl Drop for WindowGuard {
        fn drop(&mut self) {
            unsafe { DestroyWindow(self.0); }
        }
    }
    let _win_guard = WindowGuard(hwnd);

    let devices = [0x02u16, 0x06u16].map(|usage| RAWINPUTDEVICE {
        usUsagePage: 0x01,
        usUsage: usage,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: hwnd,
    });
    let registered = unsafe {
        RegisterRawInputDevices(devices.as_ptr(), devices.len() as u32, size_of::<RAWINPUTDEVICE>() as u32) != 0
    };
    if !registered {
        return Err(format!("Could not register raw input for learning: {}", std::io::Error::last_os_error()));
    }

    let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(1_000, 60_000));
    let mut msg = MaybeUninit::<MSG>::zeroed();
    loop {
        if CAPTURE_CANCELLED.load(Ordering::Acquire) || CAPTURE_GEN.load(Ordering::Acquire) != my_gen {
            return Ok(None);
        }
        if let Some(result) = LEARNED.with(|cell| cell.borrow_mut().take()) {
            return Ok(result);
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        unsafe {
            MsgWaitForMultipleObjectsEx(0, std::ptr::null(), 25, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            while PeekMessageW(msg.as_mut_ptr(), hwnd, 0, 0, PM_REMOVE) != 0 {
                let m = msg.assume_init();
                TranslateMessage(&m);
                DispatchMessageW(&m);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_raw_device_id_extracts_usb_and_bluetooth_vid_pid() {
        assert_eq!(
            canonical_raw_device_id(r"\\?\HID#VID_046D&PID_C548&MI_01&Col02#7&1234abcd&0&0001#{884b96c3-56ef-11d1-bc8c-00a0c91405dd}"),
            Some("VID_046D&PID_C548".to_owned())
        );
        assert_eq!(
            canonical_raw_device_id(r"\\?\HID#{00001812-0000-1000-8000-00805f9b34fb}_DEV_VID&02046d_PID&b023_REV&0012#9&abc"),
            Some("VID_046D&PID_B023".to_owned())
        );
        assert_eq!(
            canonical_raw_device_id(r"\\?\ACPI#PNP0303#4&1a2b3c4d&0#{884b96c3-56ef-11d1-bc8c-00a0c91405dd}"),
            Some("ACPI#PNP0303".to_owned())
        );
        assert_eq!(canonical_raw_device_id(""), None);
    }

    #[test]
    fn friendly_label_recognizes_common_vendors() {
        assert_eq!(friendly_raw_device_label(Some("VID_046D&PID_C548"), "mouse"), "Logitech (VID_046D&PID_C548)");
        assert_eq!(friendly_raw_device_label(Some("VID_1234&PID_5678"), "keyboard"), "USB (VID_1234&PID_5678)");
    }

    #[test]
    fn vk_to_hotkey_name_maps_numpad_arrows_and_media() {
        assert_eq!(vk_to_hotkey_name(crate::vk::VK_NUMPAD5, false), Some("Numpad5".into()));
        assert_eq!(vk_to_hotkey_name(crate::vk::VK_LEFT, true), Some("Left".into()));
        assert_eq!(vk_to_hotkey_name(crate::vk::VK_LEFT, false), Some("Numpad4".into()));
        assert_eq!(vk_to_hotkey_name(crate::vk::VK_VOLUME_UP, false), Some("VolumeUp".into()));
        assert_eq!(vk_to_hotkey_name(crate::vk::VK_CONTROL, false), None);
    }
}
