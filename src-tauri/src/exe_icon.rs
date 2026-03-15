//! Extract application icons from Windows `.exe` files as base64-encoded PNGs.
//!
//! Uses `ExtractIconExW` to get the 32x32 large icon, reads BGRA pixels via
//! `GetDIBits`, converts to RGBA, encodes as PNG, and returns a base64 string
//! suitable for `data:image/png;base64,...` in HTML.

use std::ffi::c_void;
use std::io::Cursor;
use std::ptr;

use base64::Engine as _;
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows_sys::Win32::UI::Shell::ExtractIconExW;
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

const ICON_SIZE: u32 = 32;

type HICON = *mut c_void;
type HDC = *mut c_void;
type HGDIOBJ = *mut c_void;

/// RAII guard for an HICON handle.
struct HIconGuard(HICON);

impl Drop for HIconGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { DestroyIcon(self.0); }
        }
    }
}

/// RAII guard for an HGDIOBJ (bitmap) handle.
struct GdiObjectGuard(HGDIOBJ);

impl Drop for GdiObjectGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { DeleteObject(self.0); }
        }
    }
}

/// RAII guard for a device context.
struct DcGuard(HDC);

impl Drop for DcGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { DeleteDC(self.0); }
        }
    }
}

/// Extract the icon from `exe_path` and return it as a base64-encoded PNG.
///
/// Returns `None` if the file has no embedded icon or the path doesn't exist.
pub fn extract_icon_base64(exe_path: &str) -> Option<String> {
    let pixels = extract_icon_rgba(exe_path)?;
    encode_rgba_to_base64_png(&pixels, ICON_SIZE, ICON_SIZE)
}

/// Extract the icon as RGBA pixel data (32x32).
fn extract_icon_rgba(exe_path: &str) -> Option<Vec<u8>> {
    let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // 1. Extract HICON
        let mut hicon_large: HICON = ptr::null_mut();
        let mut hicon_small: HICON = ptr::null_mut();
        let count =
            ExtractIconExW(wide_path.as_ptr(), 0, &mut hicon_large, &mut hicon_small, 1);

        // Clean up both icons via RAII
        let _small_guard = HIconGuard(hicon_small);
        let _large_guard = HIconGuard(hicon_large);

        if count == 0 || hicon_large.is_null() {
            return None;
        }

        // 2. Get icon bitmap info
        let mut icon_info: ICONINFO = std::mem::zeroed();
        let ok = GetIconInfo(hicon_large, &mut icon_info);
        if ok == 0 {
            return None;
        }

        let _bm_color_guard = GdiObjectGuard(icon_info.hbmColor);
        let _bm_mask_guard = GdiObjectGuard(icon_info.hbmMask);

        if icon_info.hbmColor.is_null() {
            return None;
        }

        // 3. Read pixels via GetDIBits
        let hdc_screen = GetDC(ptr::null_mut());
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        ReleaseDC(ptr::null_mut(), hdc_screen);
        let _dc_guard = DcGuard(hdc_mem);

        if hdc_mem.is_null() {
            return None;
        }

        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = ICON_SIZE as i32;
        bmi.bmiHeader.biHeight = -(ICON_SIZE as i32); // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        let pixel_count = (ICON_SIZE * ICON_SIZE * 4) as usize;
        let mut pixels = vec![0u8; pixel_count];

        let rows = GetDIBits(
            hdc_mem,
            icon_info.hbmColor,
            0,
            ICON_SIZE,
            pixels.as_mut_ptr().cast(),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        if rows == 0 {
            return None;
        }

        // 4. BGRA -> RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        Some(pixels)
    }
}

/// Encode RGBA pixels to a base64-encoded PNG string.
fn encode_rgba_to_base64_png(pixels: &[u8], width: u32, height: u32) -> Option<String> {
    let mut buf = Cursor::new(Vec::with_capacity(4096));
    {
        let mut encoder = png::Encoder::new(&mut buf, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(pixels).ok()?;
    }
    Some(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
}
