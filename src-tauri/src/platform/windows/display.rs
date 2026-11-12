//! Platform-specific display helpers (Windows).
//!
//! Provides DPI scaling, text measurement via GDI, and OSD monitor positioning.

use windows_sys::Win32::{
    Foundation::SIZE,
    Graphics::Gdi::{
        CLIP_DEFAULT_PRECIS, CreateFontW, DEFAULT_CHARSET, DEFAULT_PITCH, DEFAULT_QUALITY,
        DeleteObject, GetDC, GetDeviceCaps, GetMonitorInfoW, GetTextExtentPoint32W, LOGPIXELSX,
        MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint, OUT_DEFAULT_PRECIS, ReleaseDC,
        SelectObject,
    },
    UI::{
        HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
        WindowsAndMessaging::GetCursorPos,
    },
};

use crate::config::OsdPosition;

/// Get the current DPI scale factor (1.0 = 96 DPI, 1.5 = 144 DPI, etc.).
pub(crate) fn get_dpi_scale() -> f64 {
    unsafe {
        let hdc = GetDC(std::ptr::null_mut());
        let dpi = GetDeviceCaps(hdc, LOGPIXELSX as i32);
        ReleaseDC(std::ptr::null_mut(), hdc);
        dpi as f64 / 96.0
    }
}

/// DPI scale of the monitor under the cursor — i.e. the monitor the OSD is
/// shown on (it is positioned via `MonitorFromPoint(cursor)`). On mixed-DPI
/// multi-monitor setups this differs from the primary monitor's DPI, so sizing
/// the OSD window with the primary scale clipped the text. Falls back to the
/// primary scale if the per-monitor query fails.
pub(crate) fn get_cursor_monitor_dpi_scale() -> f64 {
    dpi_scale_at(cursor_position())
}

/// Measure text width in pixels using Win32 GDI with the specified font.
pub(crate) fn measure_text_width(
    text: &str,
    font_family: &str,
    font_size_px: i32,
    font_weight: i32,
) -> i32 {
    unsafe {
        let hdc = GetDC(std::ptr::null_mut());
        let family_wide: Vec<u16> = font_family
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let hfont = CreateFontW(
            -font_size_px,
            0,
            0,
            0,
            font_weight,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            DEFAULT_QUALITY as u32,
            DEFAULT_PITCH as u32,
            family_wide.as_ptr(),
        );
        let old_font = SelectObject(hdc, hfont as _);

        let text_wide: Vec<u16> = text.encode_utf16().collect();
        let mut size = SIZE { cx: 0, cy: 0 };
        GetTextExtentPoint32W(hdc, text_wide.as_ptr(), text_wide.len() as i32, &mut size);

        SelectObject(hdc, old_font);
        DeleteObject(hfont as _);
        ReleaseDC(std::ptr::null_mut(), hdc);

        size.cx
    }
}

/// Position the OSD window on the monitor where the cursor is.
///
/// The cursor in physical screen coordinates.
pub(crate) fn cursor_position() -> (i32, i32) {
    unsafe {
        let mut pt = std::mem::zeroed();
        GetCursorPos(&mut pt);
        (pt.x, pt.y)
    }
}

/// Physical top-left for a popup of `width`×`height` at `point` (offset by
/// `gap`), flipped/clamped so it stays inside that monitor's work area.
pub(crate) fn position_near(point: (i32, i32), width: i32, height: i32, gap: i32) -> (i32, i32) {
    unsafe {
        let hmon = MonitorFromPoint(windows_sys::Win32::Foundation::POINT { x: point.0, y: point.1 }, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(hmon, &mut mi);
        let wa = mi.rcWork;
        popup_origin(point, (width, height), gap, (wa.left, wa.top, wa.right, wa.bottom))
    }
}

/// DPI scale of the monitor holding `point`.
pub(crate) fn dpi_scale_at(point: (i32, i32)) -> f64 {
    unsafe {
        let hmon = MonitorFromPoint(windows_sys::Win32::Foundation::POINT { x: point.0, y: point.1 }, MONITOR_DEFAULTTONEAREST);
        let (mut dpi_x, mut dpi_y) = (0u32, 0u32);
        if GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) == 0 && dpi_x > 0 {
            dpi_x as f64 / 96.0
        } else {
            get_dpi_scale()
        }
    }
}

/// Below-right of the cursor; above/left of it when that would leave the
/// work area; never outside it.
fn popup_origin(cursor: (i32, i32), size: (i32, i32), gap: i32, work: (i32, i32, i32, i32)) -> (i32, i32) {
    let (left, top, right, bottom) = work;
    let axis = |at: i32, len: i32, lo: i32, hi: i32| {
        let start = if at + gap + len <= hi { at + gap } else { at - gap - len };
        start.min(hi - len).max(lo)
    };
    (axis(cursor.0, size.0, left, right), axis(cursor.1, size.1, top, bottom))
}


/// Returns physical (x, y) coordinates for the chosen corner, accounting
/// for the monitor work area (excludes taskbar).
pub(crate) fn position_osd_on_monitor(
    osd_position: &OsdPosition,
    outer_width: i32,
    outer_height: i32,
    margin: i32,
) -> (i32, i32) {
    unsafe {
        let mut cursor_pt = std::mem::zeroed();
        GetCursorPos(&mut cursor_pt);
        let hmon = MonitorFromPoint(cursor_pt, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(hmon, &mut mi);
        let wa = mi.rcWork;
        match osd_position {
            OsdPosition::TopLeft => (wa.left + margin, wa.top + margin),
            OsdPosition::TopRight => (wa.right - outer_width - margin, wa.top + margin),
            OsdPosition::BottomLeft => (wa.left + margin, wa.bottom - outer_height - margin),
            OsdPosition::BottomRight => (
                wa.right - outer_width - margin,
                wa.bottom - outer_height - margin,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::popup_origin;

    #[test]
    fn a_popup_opens_below_right_of_the_cursor_and_flips_at_the_edges() {
        let work = (0, 0, 1000, 800);
        assert_eq!(popup_origin((100, 100), (200, 300), 8, work), (108, 108));
        assert_eq!(popup_origin((950, 700), (200, 300), 8, work), (742, 392));
        assert_eq!(popup_origin((10, 10), (2000, 900), 8, work), (0, 0), "bigger than the screen: pinned");
        assert_eq!(popup_origin((-500, 100), (200, 300), 8, (-1920, 0, 0, 1080)), (-492, 108), "monitor left of the primary");
    }
}
