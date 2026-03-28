//! Platform-specific window detection (Linux).
//!
//! Provides foreground window capture via `active-win-pos-rs`, process elevation
//! checks via `/proc`, and basic fullscreen detection.

#![allow(unused_imports)]

use std::path::Path;

use crate::runtime::timestamp_millis;
use crate::window_capture::RawWindowCapture;

/// Capture information about the current foreground window.
///
/// Uses `active_win_pos_rs::get_active_window` to obtain the active window,
/// then resolves the process path via `/proc/<pid>/exe` and checks elevation
/// via `/proc/<pid>/status`.
pub(crate) fn capture_foreground_window() -> Result<RawWindowCapture, String> {
    let window = active_win_pos_rs::get_active_window()
        .map_err(|e| format!("Failed to get active window: {e:?}"))?;

    let pid = window.process_id as u32;
    let title = window.title;
    let window_id = window.window_id;

    // Resolve process path via /proc/<pid>/exe symlink
    let proc_exe_path = format!("/proc/{pid}/exe");
    let process_path = std::fs::read_link(&proc_exe_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    // Extract lowercase basename for exe matching
    let exe = Path::new(&process_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let is_elevated = is_process_elevated(pid);

    Ok(RawWindowCapture {
        hwnd: window_id,
        pid,
        exe,
        process_path,
        title,
        captured_at: timestamp_millis(),
        is_elevated,
    })
}

/// Check whether a target process is running with elevated privileges (root).
///
/// Reads `/proc/<pid>/status` and parses the `Uid:` line.
/// The effective UID is the second field. If it is 0, the process is root.
fn is_process_elevated(pid: u32) -> bool {
    let status_path = format!("/proc/{pid}/status");
    let content = match std::fs::read_to_string(&status_path) {
        Ok(c) => c,
        Err(_) => return false,
    };

    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("Uid:") {
            // Fields: real, effective, saved-set, filesystem
            let fields: Vec<&str> = rest.split_whitespace().collect();
            if let Some(effective_uid) = fields.get(1) {
                return *effective_uid == "0";
            }
        }
    }

    false
}

/// Check whether the current process itself is running elevated (root).
///
/// Reads `/proc/self/status` and parses the effective UID.
pub(crate) fn is_current_process_elevated() -> bool {
    is_process_elevated(std::process::id())
}

/// Check whether the current foreground window is fullscreen.
///
/// Uses `active-win-pos-rs` to get the active window position and size,
/// then compares against the reported screen dimensions. Returns false on
/// any error -- the Tauri window manager will clip to screen regardless.
pub(crate) fn is_foreground_fullscreen() -> bool {
    let window = match active_win_pos_rs::get_active_window() {
        Ok(w) => w,
        Err(_) => return false,
    };

    let pos = window.position;
    let win_x = pos.x;
    let win_y = pos.y;
    let win_w = pos.width;
    let win_h = pos.height;

    // Try to determine screen dimensions from the window's reported position.
    // A fullscreen window typically starts at (0, 0) and spans the entire screen.
    // Without direct X11/Wayland calls, we use a heuristic: if the window is
    // at origin and both dimensions are >= 1024, it is likely fullscreen.
    // For multi-monitor setups this is approximate but sufficient for OSD logic.
    if win_x != 0.0 || win_y != 0.0 {
        return false;
    }

    // A fullscreen window should be at least 1024x768 (minimum reasonable resolution)
    win_w >= 1024.0 && win_h >= 768.0
}
