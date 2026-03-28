//! Platform-specific display helpers (Windows).
//!
//! Provides DPI scaling, text measurement via GDI, and OSD monitor positioning.

use windows_sys::Win32::{
    Foundation::SIZE,
    Graphics::Gdi::{
        CreateFontW, DeleteObject, GetDC, GetDeviceCaps, GetMonitorInfoW, GetTextExtentPoint32W,
        MonitorFromPoint, ReleaseDC, SelectObject, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
        DEFAULT_PITCH, DEFAULT_QUALITY, LOGPIXELSX, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        OUT_DEFAULT_PRECIS,
    },
    UI::WindowsAndMessaging::GetCursorPos,
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

/// Measure text width in pixels using Win32 GDI with the specified font.
pub(crate) fn measure_text_width(
    text: &str,
    font_family: &str,
    font_size_px: i32,
    font_weight: i32,
) -> i32 {
    unsafe {
        let hdc = GetDC(std::ptr::null_mut());
        let family_wide: Vec<u16> = font_family.encode_utf16().chain(std::iter::once(0)).collect();
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
            OsdPosition::BottomRight => {
                (wa.right - outer_width - margin, wa.bottom - outer_height - margin)
            }
        }
    }
}
