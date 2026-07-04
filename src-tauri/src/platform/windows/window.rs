//! Platform-specific window detection (Windows).
//!
//! Provides foreground window capture, process elevation checks, and
//! fullscreen detection using Win32 APIs.

use std::path::Path;

use windows_sys::Win32::{
    Foundation::CloseHandle,
    Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow},
    Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
    System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    },
    UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId,
    },
};

use crate::runtime::timestamp_millis;
use crate::window_capture::RawWindowCapture;

/// Cache of the *expensive* per-process fields (path/exe/elevation) keyed by
/// (hwnd, pid). The cheap per-call fields — hwnd, pid and especially the title —
/// are always re-read: a window's title changes while its HWND stays constant
/// (browser tabs, document switches), so it must never be served stale. The
/// owning process path/exe/elevation are stable for a live (hwnd, pid), so on a
/// repeat of the same foreground window (the common case for held / auto-repeat /
/// macro-spam keystrokes) we skip OpenProcess + QueryFullProcessImageNameW +
/// OpenProcessToken + GetTokenInformation + two CloseHandle calls — the bulk of
/// the per-event capture cost on the dispatch hot path (P1).
struct ProcessInfoCache {
    hwnd: usize,
    pid: u32,
    process_path: String,
    exe: String,
    is_elevated: bool,
}

impl ProcessInfoCache {
    /// The cached process fields, iff this entry is for the same (hwnd, pid).
    fn matching(&self, hwnd: usize, pid: u32) -> Option<(String, String, bool)> {
        (self.hwnd == hwnd && self.pid == pid)
            .then(|| (self.process_path.clone(), self.exe.clone(), self.is_elevated))
    }
}

static PROCESS_INFO_CACHE: std::sync::Mutex<Option<ProcessInfoCache>> =
    std::sync::Mutex::new(None);

/// Capture information about the current foreground window.
pub(crate) fn capture_foreground_window() -> Result<RawWindowCapture, String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return Err("No foreground window is available.".into());
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return Err("Failed to resolve the foreground window process id.".into());
        }

        // Always re-read the title — it changes without an HWND change.
        let title_len = GetWindowTextLengthW(hwnd);
        let mut title_buffer = vec![0u16; (title_len as usize).max(1) + 1];
        let actual_len = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title = String::from_utf16_lossy(&title_buffer[..actual_len.max(0) as usize]);

        let hwnd_val = hwnd as usize;

        // Fast path: reuse the cached process path/exe/elevation for this exact
        // (hwnd, pid), skipping the expensive process-handle work below.
        let cached = PROCESS_INFO_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .and_then(|c| c.matching(hwnd_val, pid));

        let (process_path, exe, is_elevated) = match cached {
            Some(hit) => hit,
            None => {
                let process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if process_handle.is_null() {
                    return Err(format!("Failed to open foreground process {pid}."));
                }

                let process_path = {
                    let mut path_buffer = vec![0u16; 260];
                    let mut path_length = path_buffer.len() as u32;
                    let success = QueryFullProcessImageNameW(
                        process_handle,
                        0,
                        path_buffer.as_mut_ptr(),
                        &mut path_length,
                    );
                    if success == 0 {
                        CloseHandle(process_handle);
                        return Err("Failed to resolve the foreground process path.".into());
                    }
                    String::from_utf16_lossy(&path_buffer[..path_length as usize])
                };

                let is_elevated = is_process_elevated(process_handle);
                CloseHandle(process_handle);

                let exe = Path::new(&process_path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&process_path)
                    .to_ascii_lowercase();

                *PROCESS_INFO_CACHE
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ProcessInfoCache {
                    hwnd: hwnd_val,
                    pid,
                    process_path: process_path.clone(),
                    exe: exe.clone(),
                    is_elevated,
                });

                (process_path, exe, is_elevated)
            }
        };

        Ok(RawWindowCapture {
            hwnd: format!("0x{hwnd_val:X}"),
            pid,
            exe,
            process_path,
            title,
            captured_at: timestamp_millis(),
            is_elevated,
        })
    }
}

/// Check whether a process is running with elevated privileges (admin token).
///
/// When our app runs non-elevated, `OpenProcessToken` fails with
/// `ERROR_ACCESS_DENIED` for elevated targets (UIPI blocks token access).
/// We treat access-denied as "elevated" — in all such cases `SendInput`
/// would also be blocked, so the warning is correct regardless.
unsafe fn is_process_elevated(process_handle: windows_sys::Win32::Foundation::HANDLE) -> bool {
    unsafe {
        use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;

        let mut token_handle = std::ptr::null_mut();
        if OpenProcessToken(process_handle, TOKEN_QUERY, &mut token_handle) == 0 {
            let err = std::io::Error::last_os_error();
            return err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32);
        }

        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut return_length = 0u32;
        let ok = GetTokenInformation(
            token_handle,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut return_length,
        );
        CloseHandle(token_handle);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

/// Check whether the current process itself is running elevated (admin).
pub(crate) fn is_current_process_elevated() -> bool {
    unsafe { is_process_elevated(GetCurrentProcess()) }
}

/// Check whether the current foreground window is fullscreen on its monitor.
/// Uses MonitorFromWindow + GetMonitorInfoW to be multi-monitor safe.
pub(crate) fn is_foreground_fullscreen() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() {
            return false;
        }
        let mut win_rect = std::mem::zeroed();
        if GetWindowRect(fg, &mut win_rect) == 0 {
            return false;
        }
        let hmon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        if hmon.is_null() {
            return false;
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(hmon, &mut mi) == 0 {
            return false;
        }
        let rc = mi.rcMonitor;
        win_rect.left <= rc.left
            && win_rect.top <= rc.top
            && win_rect.right >= rc.right
            && win_rect.bottom >= rc.bottom
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_info_cache_matches_only_same_hwnd_and_pid() {
        let entry = ProcessInfoCache {
            hwnd: 0x1234,
            pid: 42,
            process_path: r"C:\App\app.exe".into(),
            exe: "app.exe".into(),
            is_elevated: false,
        };
        // Same (hwnd, pid) → hit with the stored process fields.
        assert_eq!(
            entry.matching(0x1234, 42),
            Some((r"C:\App\app.exe".to_string(), "app.exe".to_string(), false))
        );
        // Different HWND (window switched) → miss → fresh capture.
        assert_eq!(entry.matching(0x9999, 42), None);
        // Same HWND but different PID (handle recycled to a new process) → miss,
        // so a recycled window never serves another process's path/elevation.
        assert_eq!(entry.matching(0x1234, 99), None);
    }
}
