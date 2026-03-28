//! Platform-specific display helpers (Linux).
//!
//! Provides DPI scaling via environment variables, approximate text measurement,
//! and OSD monitor positioning using screen dimensions from `/sys/class/drm`.

#![allow(unused_imports)]

use std::path::Path;

use crate::config::OsdPosition;

/// Get the current DPI scale factor.
///
/// Reads `GDK_SCALE` (GTK) or `QT_SCALE_FACTOR` (Qt) environment variables.
/// Falls back to 1.0 if neither is set or parseable.
pub(crate) fn get_dpi_scale() -> f64 {
    // Try GTK scale first
    if let Ok(val) = std::env::var("GDK_SCALE") {
        if let Ok(scale) = val.trim().parse::<f64>() {
            if scale > 0.0 {
                return scale;
            }
        }
    }

    // Try Qt scale factor
    if let Ok(val) = std::env::var("QT_SCALE_FACTOR") {
        if let Ok(scale) = val.trim().parse::<f64>() {
            if scale > 0.0 {
                return scale;
            }
        }
    }

    1.0
}

/// Approximate text width in pixels.
///
/// Without Pango or Freetype dependencies, we use a simple heuristic:
/// average character width is roughly 0.6 * font_size for proportional fonts.
/// This is accurate enough for OSD sizing -- Tauri's window manager will
/// handle any overflow.
pub(crate) fn measure_text_width(
    text: &str,
    _font_family: &str,
    font_size_px: i32,
    _font_weight: i32,
) -> i32 {
    let char_count = text.chars().count() as f64;
    (char_count * font_size_px as f64 * 0.6).ceil() as i32
}

/// Position the OSD window on the screen.
///
/// Since we cannot easily get cursor position and monitor work area without
/// X11/Wayland libraries, we use a simpler approach:
/// - Try to read primary monitor resolution from `/sys/class/drm`
/// - Fall back to 1920x1080 if detection fails
/// - Assume single monitor, position relative to screen bounds
///
/// This is a reasonable MVP -- the Tauri window manager will clip to screen.
pub(crate) fn position_osd_on_monitor(
    osd_position: &OsdPosition,
    outer_width: i32,
    outer_height: i32,
    margin: i32,
) -> (i32, i32) {
    let (screen_w, screen_h) = detect_screen_resolution();

    match osd_position {
        OsdPosition::TopLeft => (margin, margin),
        OsdPosition::TopRight => (screen_w - outer_width - margin, margin),
        OsdPosition::BottomLeft => (margin, screen_h - outer_height - margin),
        OsdPosition::BottomRight => (
            screen_w - outer_width - margin,
            screen_h - outer_height - margin,
        ),
    }
}

/// Try to detect the primary monitor resolution from `/sys/class/drm`.
///
/// Reads mode files from DRM connector directories to find the active resolution.
/// Returns (width, height) or falls back to (1920, 1080).
fn detect_screen_resolution() -> (i32, i32) {
    let drm_path = Path::new("/sys/class/drm");

    if let Ok(entries) = std::fs::read_dir(drm_path) {
        for entry in entries.flatten() {
            let dir = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            // Look for connector directories like card0-HDMI-A-1, card0-DP-1, etc.
            if !name_str.starts_with("card") || !name_str.contains('-') {
                continue;
            }

            // Check if this connector is enabled/connected
            let status_path = dir.join("status");
            if let Ok(status) = std::fs::read_to_string(&status_path) {
                if status.trim() != "connected" {
                    continue;
                }
            } else {
                continue;
            }

            // Read the active mode from the modes file (first line is preferred)
            let modes_path = dir.join("modes");
            if let Ok(modes) = std::fs::read_to_string(&modes_path) {
                if let Some(first_mode) = modes.lines().next() {
                    if let Some((w, h)) = parse_mode_string(first_mode.trim()) {
                        return (w, h);
                    }
                }
            }
        }
    }

    // Fallback: 1920x1080
    (1920, 1080)
}

/// Parse a DRM mode string like "1920x1080" into (width, height).
fn parse_mode_string(mode: &str) -> Option<(i32, i32)> {
    let parts: Vec<&str> = mode.split('x').collect();
    if parts.len() == 2 {
        let w = parts[0].parse::<i32>().ok()?;
        let h = parts[1].parse::<i32>().ok()?;
        if w > 0 && h > 0 {
            return Some((w, h));
        }
    }
    None
}
