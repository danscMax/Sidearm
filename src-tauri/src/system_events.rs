//! A hidden top-level window for two Windows broadcasts Tauri does not pass
//! on: a device was plugged in or out (`WM_DEVICECHANGE`), and the session is
//! ending (`WM_QUERYENDSESSION` / `WM_ENDSESSION` — shutdown, restart, logoff).
//!
//! A change in the connected native mice restarts capture, so each mouse gets
//! the path it needs (a live map only while two are connected). A session end
//! runs the same mouse shutdown as a normal exit, before Windows ends the
//! process.

use std::{sync::mpsc, thread, time::Duration};

use tauri::{AppHandle, Emitter};
use windows_sys::Win32::{
    Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM},
    UI::Input::{
        GetRawInputData, GetRawInputDeviceInfoW, HRAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RIDI_DEVICENAME,
        RID_HEADER, RegisterRawInputDevices,
    },
    System::{LibraryLoader::GetModuleHandleW, Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy}},
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, RegisterClassW, TranslateMessage,
        WM_DEVICECHANGE, WM_ENDSESSION, WM_INPUT, WM_QUERYENDSESSION, WNDCLASSW, WS_OVERLAPPED,
    },
};

/// Emitted with the connected mice (`NativeModelInfo[]`) whenever they change.
pub const EVENT_NATIVE_MICE_CHANGED: &str = "native_mice_changed";
/// Device notifications come in bursts (every collection of a receiver).
const SETTLE: Duration = Duration::from_millis(700);

static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
static CHANGED: std::sync::OnceLock<mpsc::Sender<()>> = std::sync::OnceLock::new();

pub fn spawn(app: AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let (changed, changes) = mpsc::channel();
    let _ = CHANGED.set(changed);
    let watcher = app.clone();
    let spawned = thread::Builder::new().name("mouse-devices".into()).spawn(move || watch_mice(&watcher, &changes));
    if let Err(error) = spawned {
        log::warn!("[system] device watcher not started: {error}");
    }
    if let Err(error) = thread::Builder::new().name("system-events".into()).spawn(run_window) {
        log::warn!("[system] system events window not started: {error}");
    }
}

/// Restarts capture when the set of connected native mice changes.
fn watch_mice(app: &AppHandle, changes: &mpsc::Receiver<()>) {
    let names = || crate::mouse_memory::present_models().iter().map(|model| model.name).collect::<Vec<_>>();
    let mut last = names();
    while changes.recv().is_ok() {
        // Wait for the burst to end.
        while changes.recv_timeout(SETTLE).is_ok() {}
        let now = names();
        if now == last {
            continue;
        }
        log::info!("[system] connected mice changed: {last:?} -> {now:?}");
        last = now;
        let consumer = crate::mouse_memory::consumer_signals_enabled();
        let mice: Vec<_> = crate::mouse_memory::present_models().into_iter().map(|model| model.info(true, consumer)).collect();
        let _ = app.emit(EVENT_NATIVE_MICE_CHANGED, &mice);
        if let Err(error) = crate::reload_capture(app) {
            log::warn!("[system] capture restart after a device change failed: {error}");
        }
    }
}

fn run_window() {
    let class: Vec<u16> = "SidearmSystemEvents\0".encode_utf16().collect();
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&wc);
        // Top-level (not message-only): only those receive the broadcasts.
        // Never shown.
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            log::warn!("[system] system events window not created: {}", std::io::Error::last_os_error());
            return;
        }
        // Every mouse's input, focused or not: it tells which mouse is in use.
        let mice = RAWINPUTDEVICE { usUsagePage: 0x01, usUsage: 0x02, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd };
        if RegisterRawInputDevices(&mice, 1, size_of::<RAWINPUTDEVICE>() as u32) == 0 {
            log::warn!("[system] mouse raw input not registered: {}", std::io::Error::last_os_error());
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Tells the battery badge which mouse moved or clicked. Runs for every mouse
/// report, so it only looks further when the reporting device changes.
fn note_mouse_input(lparam: LPARAM) {
    thread_local! {
        static LAST: std::cell::Cell<HANDLE> = const { std::cell::Cell::new(std::ptr::null_mut()) };
        static MODELS: std::cell::RefCell<std::collections::HashMap<usize, Option<&'static str>>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    let mut header: RAWINPUTHEADER = unsafe { std::mem::zeroed() };
    let mut size = size_of::<RAWINPUTHEADER>() as u32;
    // SAFETY: `lparam` is the HRAWINPUT of this WM_INPUT; the header buffer is
    // sized as passed.
    let read = unsafe { GetRawInputData(lparam as HRAWINPUT, RID_HEADER, (&raw mut header).cast(), &mut size, size_of::<RAWINPUTHEADER>() as u32) };
    // Injected input (ours included) has no device.
    if read == u32::MAX || header.hDevice.is_null() || LAST.get() == header.hDevice {
        return;
    }
    LAST.set(header.hDevice);
    let device_id = MODELS.with_borrow_mut(|models| {
        *models.entry(header.hDevice as usize).or_insert_with(|| {
            device_name(header.hDevice).and_then(|name| crate::device_catalog::model_for_path(&name)).map(|model| model.device_id)
        })
    });
    if let (Some(device_id), Some(app)) = (device_id, APP.get()) {
        crate::onboard_guard::note_device_used(app, device_id);
    }
}

/// The device path of a raw input device.
fn device_name(device: HANDLE) -> Option<String> {
    let mut chars = 0u32;
    // SAFETY: the first call only reports the length; the second fills a
    // buffer of that length.
    unsafe {
        GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, std::ptr::null_mut(), &mut chars);
        let mut name = vec![0u16; chars as usize];
        let written = GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, name.as_mut_ptr().cast(), &mut chars);
        (written != u32::MAX && written > 0).then(|| String::from_utf16_lossy(&name[..written as usize]))
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_INPUT => {
            note_mouse_input(lparam);
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        WM_DEVICECHANGE => {
            if let Some(changed) = CHANGED.get() {
                let _ = changed.send(());
            }
            1
        }
        // Never veto the session end. A block reason exists only while the
        // restore runs: one held from the query on would list Sidearm as
        // "preventing shutdown" on every shutdown.
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION if wparam != 0 => {
            if let Some(app) = APP.get() {
                let text = crate::ui_text!("system.restoringMouse", "Sidearm is restoring the mouse buttons");
                let reason: Vec<u16> = crate::ui_text::native(&text).encode_utf16().chain(std::iter::once(0)).collect();
                unsafe { ShutdownBlockReasonCreate(hwnd, reason.as_ptr()) };
                log::info!("[system] session ending");
                crate::shutdown_mouse(app);
                unsafe { ShutdownBlockReasonDestroy(hwnd) };
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}
