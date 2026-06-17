//! Platform-specific window detection (Linux).
//!
//! Provides foreground window capture via a GNOME Shell D-Bus extension on
//! Wayland, falling back to `active-win-pos-rs` (XCB) on X11. Process
//! elevation checks use `/proc`.

#![allow(unused_imports)]

use std::path::Path;

use crate::runtime::timestamp_millis;
use crate::window_capture::RawWindowCapture;

/// Call the Sidearm GNOME Shell extension D-Bus `Get` method and parse the JSON
/// payload it returns (gdbus wraps it as `('{...}',)`). Shared by
/// `try_gnome_dbus` and `try_gnome_dbus_geometry`.
fn fetch_focused_window_json() -> Option<serde_json::Value> {
    let output = std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "com.sidearm.FocusedWindow",
            "--object-path",
            "/com/sidearm/FocusedWindow",
            "--method",
            "com.sidearm.FocusedWindow.Get",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    // gdbus output format: ('{"pid":1234,"title":"...","wm_class":"...","x":0,"y":0,"width":800,"height":600}',)
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_str = stdout.trim().strip_prefix("('")?.strip_suffix("',)")?;
    serde_json::from_str(json_str).ok()
}

/// Try to get the focused window via the Sidearm GNOME Shell extension D-Bus
/// interface (`com.sidearm.FocusedWindow`). Returns `None` if the extension is
/// unavailable or the call fails.
fn try_gnome_dbus() -> Option<RawWindowCapture> {
    let v = fetch_focused_window_json()?;
    let pid = v.get("pid")?.as_u64()? as u32;
    if pid == 0 {
        return None;
    }

    let title = v.get("title")?.as_str().unwrap_or_default().to_owned();
    let wm_class = v.get("wm_class")?.as_str().unwrap_or_default().to_owned();

    // Resolve process path via /proc/<pid>/exe
    let proc_exe_path = format!("/proc/{pid}/exe");
    let process_path = std::fs::read_link(&proc_exe_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let exe = if !wm_class.is_empty() {
        wm_class.to_ascii_lowercase()
    } else {
        Path::new(&process_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
    };

    let is_elevated = is_process_elevated(pid);

    Some(RawWindowCapture {
        hwnd: String::new(),
        pid,
        exe,
        process_path,
        title,
        captured_at: timestamp_millis(),
        is_elevated,
    })
}

/// Capture information about the current foreground window.
///
/// On Wayland sessions, first tries the Sidearm GNOME Shell D-Bus extension.
/// Falls back to `active_win_pos_rs::get_active_window` (XCB/X11).
pub(crate) fn capture_foreground_window() -> Result<RawWindowCapture, String> {
    // Try GNOME Wayland D-Bus extension first
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        if let Some(capture) = try_gnome_dbus() {
            return Ok(capture);
        }
    }

    // Fallback to X11/XCB
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
    match std::fs::read_to_string(&status_path) {
        Ok(content) => parse_effective_uid_is_root(&content),
        Err(e) => elevated_on_read_error(&e),
    }
}

/// Fail-safe interpretation of a `/proc/<pid>/status` read error.
///
/// Mirrors the Windows-side fail-safe (window.rs `is_process_elevated`):
/// a permission error (e.g. `/proc` mounted with `hidepid=2`) means we
/// genuinely cannot tell, so assume elevated — under-warning is worse than
/// over-warning, since input injection into an elevated window would fail
/// regardless. Only a vanished process (`NotFound`) is treated as not-elevated.
/// See finding F044.
fn elevated_on_read_error(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::PermissionDenied
}

/// Parse the effective UID from `/proc/<pid>/status` contents and report whether
/// it is root (0). Returns false when no `Uid:` line is present.
fn parse_effective_uid_is_root(content: &str) -> bool {
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
/// On Wayland, queries the Sidearm GNOME Shell D-Bus extension for window
/// geometry. Falls back to `active-win-pos-rs` (XCB) on X11. Returns false
/// on any error -- the Tauri window manager will clip to screen regardless.
pub(crate) fn is_foreground_fullscreen() -> bool {
    // Try GNOME Wayland D-Bus extension first
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        if let Some(capture) = try_gnome_dbus_geometry() {
            let (x, y, w, h) = capture;
            if x != 0 || y != 0 {
                return false;
            }
            return w >= 1024 && h >= 768;
        }
    }

    // Fallback to X11/XCB
    let window = match active_win_pos_rs::get_active_window() {
        Ok(w) => w,
        Err(_) => return false,
    };

    let pos = window.position;
    let win_x = pos.x;
    let win_y = pos.y;
    let win_w = pos.width;
    let win_h = pos.height;

    if win_x != 0.0 || win_y != 0.0 {
        return false;
    }

    win_w >= 1024.0 && win_h >= 768.0
}

/// Query window geometry from the GNOME Shell D-Bus extension.
/// Returns (x, y, width, height) or None.
fn try_gnome_dbus_geometry() -> Option<(i64, i64, i64, i64)> {
    let v = fetch_focused_window_json()?;

    let x = v.get("x")?.as_i64()?;
    let y = v.get("y")?.as_i64()?;
    let w = v.get("width")?.as_i64()?;
    let h = v.get("height")?.as_i64()?;
    Some((x, y, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    // F044: a permission error must be treated as "elevated" (fail-safe),
    // matching the Windows-side behaviour, so a window we cannot inspect (e.g.
    // hidepid=2) still triggers the elevation warning.
    #[test]
    fn permission_denied_is_treated_as_elevated() {
        let err = Error::from(ErrorKind::PermissionDenied);
        assert!(
            elevated_on_read_error(&err),
            "permission denied must conservatively report elevated"
        );
    }

    // A vanished process (status file gone) is NOT elevated.
    #[test]
    fn not_found_is_not_elevated() {
        let err = Error::from(ErrorKind::NotFound);
        assert!(
            !elevated_on_read_error(&err),
            "a missing process must report not-elevated"
        );
    }

    #[test]
    fn effective_uid_root_is_elevated() {
        let status = "Name:\tbash\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n";
        assert!(parse_effective_uid_is_root(status));
    }

    #[test]
    fn effective_uid_nonroot_is_not_elevated() {
        let status = "Name:\tbash\nUid:\t1000\t1000\t1000\t1000\n";
        assert!(!parse_effective_uid_is_root(status));
    }

    #[test]
    fn missing_uid_line_is_not_elevated() {
        let status = "Name:\tbash\nState:\tR (running)\n";
        assert!(!parse_effective_uid_is_root(status));
    }
}
