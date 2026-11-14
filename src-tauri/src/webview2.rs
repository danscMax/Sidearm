//! The WebView2 side of Sidearm's footprint: the profile's caches are emptied
//! at start, and the main window's webview asks for less memory while the
//! window is hidden or minimized (`ICoreWebView2_19::put_MemoryUsageTargetLevel`,
//! Microsoft's guidance for an inactive app; never mixed with `TrySuspend`).

use std::cell::{Cell, RefCell};
use std::path::Path;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
};
use windows::core::Interface;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible, SIZE_MINIMIZED, WM_SHOWWINDOW, WM_SIZE};

/// Folders of the Chromium profile that hold no user state: the HTTP cache, V8's
/// code cache, the GPU shader cache and crash dumps. Chromium rebuilds each on
/// demand. Not `component_crx_cache`: its downloads would come again on every
/// start. `Default\Local Storage` and `Default\IndexedDB` (the UI's own state)
/// are never touched.
const CACHE_DIRS: [&str; 4] = [
    r"Default\Cache",
    r"Default\Code Cache",
    "GrShaderCache",
    r"Crashpad\reports",
];

/// Empties [`CACHE_DIRS`] in the WebView2 user data folder `user_data` (WebView2
/// keeps its profile in an `EBWebView` folder inside it). Call before any webview
/// starts. Returns what to log once the logger runs: none of this is logged yet.
pub fn clear_caches(user_data: &Path) -> Option<String> {
    let profile = user_data.join("EBWebView");
    let lock = profile.join("lockfile");
    // A browser process running on this profile (another Sidearm on the same
    // data folder) holds `lockfile` open for itself, and Chromium deletes it on
    // exit: leave its caches alone.
    if lock.exists() && std::fs::OpenOptions::new().write(true).open(&lock).is_err() {
        return Some("[webview] profile in use by another process: caches kept".into());
    }
    let (mut removed, mut kept) = (Vec::new(), Vec::new());
    for dir in CACHE_DIRS {
        match std::fs::remove_dir_all(profile.join(dir)) {
            Ok(()) => removed.push(dir.to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            // A file held by something else (a scanner): this one stays, the next are still tried.
            Err(error) => kept.push(format!("`{dir}` ({error})")),
        }
    }
    let mut lines = Vec::new();
    if !removed.is_empty() {
        lines.push(format!("[webview] caches emptied: {}", removed.join(", ")));
    }
    if !kept.is_empty() {
        lines.push(format!("[webview] caches not emptied: {}", kept.join(", ")));
    }
    (!lines.is_empty()).then(|| lines.join("; "))
}

thread_local! {
    /// The main window's webview, on the main thread that owns it and its window.
    static MAIN: RefCell<Option<ICoreWebView2_19>> = const { RefCell::new(None) };
    /// The level last set (`true` = low), so a resize does not set it again.
    static LOW: Cell<Option<bool>> = const { Cell::new(None) };
}

const SUBCLASS_ID: usize = 0x5344_4d4c; // "SDML"

/// Lowers the memory use of `window`'s webview whenever the window is hidden
/// (closed to the tray, toggled away) or minimized, and puts it back when it
/// shows again: a subclass of the window sees every show, hide and minimize,
/// whoever asked for it (Rust, the page, the taskbar).
pub fn low_memory_while_hidden(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    let queued = window.with_webview(move |webview| {
        // SAFETY: a COM call on the webview's own (main) thread, where this runs.
        let core = unsafe { webview.controller().CoreWebView2() }.and_then(|core| core.cast::<ICoreWebView2_19>());
        let core = match core {
            Ok(core) => core,
            // A WebView2 runtime older than the memory target API (Edge 114).
            Err(error) => return log::info!("[webview] no memory target level: {error}"),
        };
        MAIN.with(|main| *main.borrow_mut() = Some(core));
        let hwnd = hwnd as HWND;
        // SAFETY: `hwnd` is the window's own handle, used on the thread that owns it.
        unsafe {
            set_low(IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0);
            if SetWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID, 0) == 0 {
                log::warn!("[webview] window not watched: its memory stays at the normal level");
            }
        }
    });
    if let Err(error) = queued {
        log::warn!("[webview] memory target not set up: {error}");
    }
}

fn set_low(low: bool) {
    if LOW.get() == Some(low) {
        return;
    }
    MAIN.with(|main| {
        let Some(core) = main.borrow().clone() else { return };
        let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        // SAFETY: a property set on the main thread's own webview.
        match unsafe { core.SetMemoryUsageTargetLevel(level) } {
            Ok(()) => {
                LOW.set(Some(low));
                log::debug!("[webview] memory target level {}", if low { "low" } else { "normal" });
            }
            Err(error) => log::warn!("[webview] memory target level not set: {error}"),
        }
    });
}

/// Level for a window message: `Some(true)` hidden or minimized, `Some(false)`
/// shown or restored, `None` no change.
fn level_for(msg: u32, wparam: WPARAM, lparam: LPARAM, visible: bool) -> Option<bool> {
    match msg {
        // lparam 0: ShowWindow on this window itself, not an owner minimizing.
        WM_SHOWWINDOW if lparam == 0 => Some(wparam == 0),
        WM_SIZE if wparam == SIZE_MINIMIZED as WPARAM => Some(true),
        // Restored or maximized; a hidden window resized stays low.
        WM_SIZE if visible => Some(false),
        _ => None,
    }
}

unsafe extern "system" fn on_message(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    // SAFETY: called by Windows on the window's thread with its own handle.
    let visible = msg == WM_SIZE && unsafe { IsWindowVisible(hwnd) } != 0;
    if let Some(low) = level_for(msg, wparam, lparam, visible) {
        set_low(low);
    }
    // SAFETY: passes the message on unchanged, as a subclass must.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SIZE_MAXIMIZED, SIZE_RESTORED, WM_MOVE};

    #[test]
    fn hidden_and_minimized_are_low_shown_and_restored_normal() {
        assert_eq!(level_for(WM_SHOWWINDOW, 0, 0, true), Some(true), "hidden");
        assert_eq!(level_for(WM_SHOWWINDOW, 1, 0, false), Some(false), "shown");
        assert_eq!(level_for(WM_SHOWWINDOW, 0, 1, true), None, "the owner minimizing");
        assert_eq!(level_for(WM_SIZE, SIZE_MINIMIZED as WPARAM, 0, true), Some(true));
        assert_eq!(level_for(WM_SIZE, SIZE_RESTORED as WPARAM, 0, true), Some(false));
        assert_eq!(level_for(WM_SIZE, SIZE_MAXIMIZED as WPARAM, 0, true), Some(false));
        assert_eq!(level_for(WM_SIZE, SIZE_RESTORED as WPARAM, 0, false), None, "a hidden window resized");
        assert_eq!(level_for(WM_MOVE, 0, 0, true), None);
    }

    #[test]
    fn only_cache_folders_are_emptied() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("EBWebView");
        for sub in CACHE_DIRS.iter().chain(&[r"Default\Local Storage", r"Default\IndexedDB"]) {
            std::fs::create_dir_all(profile.join(sub)).unwrap();
            std::fs::write(profile.join(sub).join("data"), "x").unwrap();
        }
        let said = clear_caches(dir.path()).unwrap();
        assert!(said.starts_with("[webview] caches emptied"), "{said}");
        for sub in CACHE_DIRS {
            assert!(!profile.join(sub).exists(), "{sub}");
        }
        assert!(profile.join(r"Default\Local Storage\data").exists());
        assert!(profile.join(r"Default\IndexedDB\data").exists());
        assert_eq!(clear_caches(dir.path()), None, "nothing left to empty");
    }

    #[test]
    fn a_profile_in_use_keeps_its_caches() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("EBWebView");
        std::fs::create_dir_all(profile.join(r"Default\Cache")).unwrap();
        // How Chromium holds it: write access, others may only read.
        let _held = std::fs::OpenOptions::new().write(true).create(true).truncate(true).share_mode(1).open(profile.join("lockfile")).unwrap();
        assert!(clear_caches(dir.path()).unwrap().contains("in use"));
        assert!(profile.join(r"Default\Cache").exists());
    }
}
