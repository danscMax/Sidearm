//! Probe (interactive, `--ignored`): does Raw Input still report a mouse button
//! that a `WH_MOUSE_LL` hook swallowed, and does it arrive before or after the
//! hook saw it? Decides whether HyperShift 2 can tell which mouse pressed the
//! right button (plans/hypershift-layers). Changes nothing in the app.
//!
//! `cargo test --lib raw_probe -- --ignored --nocapture`: injects three right
//! clicks (swallowed by the hook, so nothing happens on the desktop).
//! With `SIDEARM_PROBE_PHYSICAL=1` it injects nothing and listens 20 s for
//! real right clicks (any mouse, the touchpad) — also swallowed meanwhile.

use std::sync::Mutex;
use std::time::Instant;

static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static START: Mutex<Option<Instant>> = Mutex::new(None);

fn note(line: String) {
    let ms = START.lock().ok().and_then(|start| start.map(|s| s.elapsed().as_secs_f64() * 1000.0)).unwrap_or(0.0);
    if let Ok(mut events) = EVENTS.lock() {
        events.push(format!("{ms:9.2} ms  {line}"));
    }
}

unsafe extern "system" fn hook(code: i32, w_param: usize, l_param: isize) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{CallNextHookEx, MSLLHOOKSTRUCT, WM_RBUTTONDOWN, WM_RBUTTONUP};
    let msg = w_param as u32;
    if code >= 0 && (msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP) {
        let ms = unsafe { &*(l_param as *const MSLLHOOKSTRUCT) };
        note(format!("hook   {} injected={} (swallowed)", if msg == WM_RBUTTONDOWN { "right down" } else { "right up  " }, ms.flags & 1 != 0));
        return 1;
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param) }
}

unsafe extern "system" fn window_proc(hwnd: windows_sys::Win32::Foundation::HWND, message: u32, w_param: usize, l_param: isize) -> isize {
    use windows_sys::Win32::UI::Input::{GetRawInputData, GetRawInputDeviceInfoW, HRAWINPUT, RAWINPUT, RAWINPUTHEADER, RID_INPUT, RIDI_DEVICENAME, RIM_TYPEMOUSE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_INPUT};
    if message == WM_INPUT {
        let mut input: RAWINPUT = unsafe { std::mem::zeroed() };
        let mut size = size_of::<RAWINPUT>() as u32;
        let read = unsafe { GetRawInputData(l_param as HRAWINPUT, RID_INPUT, (&raw mut input).cast(), &mut size, size_of::<RAWINPUTHEADER>() as u32) };
        if read != u32::MAX && input.header.dwType == RIM_TYPEMOUSE {
            let flags = unsafe { input.data.mouse.Anonymous.Anonymous.usButtonFlags };
            // RI_MOUSE_RIGHT_BUTTON_DOWN 0x4, _UP 0x8.
            if flags & 0x0c != 0 {
                let device = input.header.hDevice;
                let name = if device.is_null() {
                    "(no device: injected)".to_owned()
                } else {
                    let mut chars = 0u32;
                    unsafe { GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, std::ptr::null_mut(), &mut chars) };
                    let mut buffer = vec![0u16; chars as usize];
                    let written = unsafe { GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, buffer.as_mut_ptr().cast(), &mut chars) };
                    String::from_utf16_lossy(&buffer[..written.min(chars) as usize])
                };
                note(format!("raw    {} from {name}", if flags & 0x4 != 0 { "right down" } else { "right up  " }));
            }
        }
    }
    unsafe { DefWindowProcW(hwnd, message, w_param, l_param) }
}

#[test]
#[ignore = "interactive probe: hooks the real mouse"]
fn raw_input_under_a_swallowing_mouse_hook() {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, SendInput, INPUT};
    use windows_sys::Win32::UI::Input::{RAWINPUTDEVICE, RIDEV_INPUTSINK, RegisterRawInputDevices};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, KillTimer, MSG, PeekMessageW, PM_REMOVE, RegisterClassW, SetTimer,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WNDCLASSW, WS_OVERLAPPED,
    };

    let physical = std::env::var("SIDEARM_PROBE_PHYSICAL").is_ok_and(|value| value == "1");
    *START.lock().unwrap() = Some(Instant::now());
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let class: Vec<u16> = "SidearmRawProbe\0".encode_utf16().collect();
        let wc = WNDCLASSW { lpfnWndProc: Some(window_proc), hInstance: instance, lpszClassName: class.as_ptr(), ..std::mem::zeroed() };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), WS_OVERLAPPED, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), instance, std::ptr::null());
        assert!(!hwnd.is_null(), "probe window");
        let device = RAWINPUTDEVICE { usUsagePage: 0x01, usUsage: 0x02, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd };
        assert!(RegisterRawInputDevices(&device, 1, size_of::<RAWINPUTDEVICE>() as u32) != 0, "raw input");
        let hook_handle = SetWindowsHookExW(WH_MOUSE_LL, Some(hook), instance, 0);
        assert!(!hook_handle.is_null(), "mouse hook");

        if !physical {
            // Inject from another thread: SendInput from the hook's own thread
            // would wait on this very loop.
            std::thread::spawn(|| {
                for _ in 0..3 {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    for flags in [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP] {
                        let input: INPUT = crate::input_synthesis::make_mouse_input(flags, 0);
                        let sent = SendInput(1, &input, size_of::<INPUT>() as i32);
                        note(format!("sent   {flags:#x} -> {sent} ({})", std::io::Error::last_os_error()));
                        std::thread::sleep(std::time::Duration::from_millis(60));
                    }
                }
            });
        } else {
            println!("Right-click with every mouse and the touchpad for 20 s (clicks are swallowed)...");
        }
        let deadline = Instant::now() + std::time::Duration::from_secs(if physical { 20 } else { 2 });
        let timer = SetTimer(std::ptr::null_mut(), 0, 50, None);
        let mut msg: MSG = std::mem::zeroed();
        while Instant::now() < deadline {
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            windows_sys::Win32::UI::WindowsAndMessaging::MsgWaitForMultipleObjects(0, std::ptr::null(), 0, 50, 0x04FF);
        }
        KillTimer(std::ptr::null_mut(), timer);
        UnhookWindowsHookEx(hook_handle);
    }
    let events = EVENTS.lock().unwrap();
    println!("--- {} events ---", events.len());
    for line in events.iter() {
        println!("{line}");
    }
}
