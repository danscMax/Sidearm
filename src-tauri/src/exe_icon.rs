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
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC,
};
use windows_sys::Win32::UI::Shell::ExtractIconExW;
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

/// Upper bound on icon dimensions we will read, bounding the pixel buffer and
/// PNG size and rejecting absurd / corrupt bitmaps. 256 covers the largest
/// shell icons at any DPI scaling.
const MAX_ICON_DIM: u32 = 256;

// These mirror the Win32 type names verbatim, so keep the WinAPI casing.
#[allow(clippy::upper_case_acronyms)]
type HICON = *mut c_void;
#[allow(clippy::upper_case_acronyms)]
type HDC = *mut c_void;
#[allow(clippy::upper_case_acronyms)]
type HGDIOBJ = *mut c_void;

/// RAII guard for an HICON handle.
struct HIconGuard(HICON);

impl Drop for HIconGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                DestroyIcon(self.0);
            }
        }
    }
}

/// RAII guard for an HGDIOBJ (bitmap) handle.
struct GdiObjectGuard(HGDIOBJ);

impl Drop for GdiObjectGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                DeleteObject(self.0);
            }
        }
    }
}

/// RAII guard for a device context.
struct DcGuard(HDC);

impl Drop for DcGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                DeleteDC(self.0);
            }
        }
    }
}

/// Validate raw bitmap dimensions from `GetObjectW` and convert to `u32`.
///
/// Returns `None` when the dimensions are non-positive or exceed
/// [`MAX_ICON_DIM`] — we prefer showing no icon over reading a mismatched or
/// unbounded DIB.
fn validate_icon_dims(width: i32, height: i32) -> Option<(u32, u32)> {
    let width = u32::try_from(width).ok()?;
    let height = u32::try_from(height).ok()?;
    if width == 0 || height == 0 || width > MAX_ICON_DIM || height > MAX_ICON_DIM {
        return None;
    }
    Some((width, height))
}

/// Extract the icon from `exe_path` and return it as a base64-encoded PNG.
///
/// Returns `None` if the file has no embedded icon or the path doesn't exist.
pub fn extract_icon_base64(exe_path: &str) -> Option<String> {
    let (pixels, width, height) = extract_icon_rgba(exe_path)?;
    encode_rgba_to_base64_png(&pixels, width, height)
}

/// Extract the icon as RGBA pixel data at its native size (32x32 on standard
/// DPI, 48x48 / 64x64 on high-DPI). Returns the pixels plus their width/height.
fn extract_icon_rgba(exe_path: &str) -> Option<(Vec<u8>, u32, u32)> {
    let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // 1. Extract HICON
        let mut hicon_large: HICON = ptr::null_mut();
        let mut hicon_small: HICON = ptr::null_mut();
        let count = ExtractIconExW(wide_path.as_ptr(), 0, &mut hicon_large, &mut hicon_small, 1);

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

        // 3. Determine the real icon dimensions. ExtractIconExW returns the
        // system large icon (SM_CXICON): 32 on standard DPI, but 48/64 on
        // high-DPI displays — a hardcoded 32x32 read would clip/garble it.
        let mut bm: BITMAP = std::mem::zeroed();
        let got = GetObjectW(
            icon_info.hbmColor,
            std::mem::size_of::<BITMAP>() as i32,
            (&mut bm as *mut BITMAP).cast(),
        );
        let (width, height) = if got != 0 {
            // Query OK: reject out-of-range dims (no icon beats a wrong one).
            validate_icon_dims(bm.bmWidth, bm.bmHeight)?
        } else {
            // Query failed: prefer the monogram fallback over a possibly clipped
            // 32x32 read (on hi-DPI the real bitmap may be 48/64). Consistent
            // with the `validate_icon_dims(...)?` path above — no icon beats a
            // wrong one. See finding F034.
            return None;
        };

        // 4. Read pixels via GetDIBits
        let hdc_screen = GetDC(ptr::null_mut());
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        ReleaseDC(ptr::null_mut(), hdc_screen);
        let _dc_guard = DcGuard(hdc_mem);

        if hdc_mem.is_null() {
            return None;
        }

        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width as i32;
        bmi.bmiHeader.biHeight = -(height as i32); // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        let pixel_count = (width * height * 4) as usize;
        let mut pixels = vec![0u8; pixel_count];

        let rows = GetDIBits(
            hdc_mem,
            icon_info.hbmColor,
            0,
            height,
            pixels.as_mut_ptr().cast(),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        if rows == 0 {
            return None;
        }

        // 5. BGRA -> RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        Some((pixels, width, height))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_icon_dims_accepts_in_range() {
        assert_eq!(validate_icon_dims(32, 32), Some((32, 32)));
        assert_eq!(validate_icon_dims(48, 48), Some((48, 48)));
        assert_eq!(validate_icon_dims(64, 64), Some((64, 64)));
        assert_eq!(
            validate_icon_dims(MAX_ICON_DIM as i32, MAX_ICON_DIM as i32),
            Some((MAX_ICON_DIM, MAX_ICON_DIM))
        );
        // Non-square icons are allowed too.
        assert_eq!(validate_icon_dims(48, 32), Some((48, 32)));
    }

    #[test]
    fn validate_icon_dims_rejects_out_of_range() {
        assert_eq!(validate_icon_dims(0, 32), None);
        assert_eq!(validate_icon_dims(32, 0), None);
        assert_eq!(validate_icon_dims(-5, 32), None);
        assert_eq!(validate_icon_dims(32, -1), None);
        assert_eq!(validate_icon_dims(MAX_ICON_DIM as i32 + 1, 32), None);
        assert_eq!(validate_icon_dims(32, MAX_ICON_DIM as i32 + 1), None);
    }

    #[test]
    fn encode_rgba_to_base64_png_roundtrips_dimensions() {
        // 2x2 solid-red RGBA buffer.
        let (width, height) = (2u32, 2u32);
        let pixels: Vec<u8> = (0..width * height)
            .flat_map(|_| [255u8, 0, 0, 255])
            .collect();

        let b64 = encode_rgba_to_base64_png(&pixels, width, height)
            .expect("encoding a valid RGBA buffer should succeed");
        assert!(!b64.is_empty());

        // Decode base64 -> PNG bytes and confirm the dimensions round-trip.
        let png_bytes = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .expect("output should be valid base64");
        let reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
            .read_info()
            .expect("output should be a valid PNG");
        assert_eq!(reader.info().width, width);
        assert_eq!(reader.info().height, height);
    }
}
