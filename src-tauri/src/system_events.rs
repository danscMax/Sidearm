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
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::{LibraryLoader::GetModuleHandleW, Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy}},
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, RegisterClassW, TranslateMessage,
        WM_DEVICECHANGE, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW, WS_OVERLAPPED,
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
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
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
