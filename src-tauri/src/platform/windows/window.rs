//! Platform-specific window detection (Windows).
//!
//! Provides foreground window capture, process elevation checks, and
//! fullscreen detection using Win32 APIs.

use std::path::Path;

use windows_sys::Win32::{
    Foundation::CloseHandle,
    Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    },
    Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
    System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId,
    },
};

use crate::runtime::timestamp_millis;
use crate::window_capture::RawWindowCapture;

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

        let title_len = GetWindowTextLengthW(hwnd);
        let mut title_buffer = vec![0u16; (title_len as usize).max(1) + 1];
        let actual_len = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title = String::from_utf16_lossy(&title_buffer[..actual_len.max(0) as usize]);

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

        Ok(RawWindowCapture {
            hwnd: format!("0x{:X}", hwnd as usize),
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
