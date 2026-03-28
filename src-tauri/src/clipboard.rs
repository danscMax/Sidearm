#[cfg(target_os = "windows")]
use std::ptr;
use std::{thread, time::Duration};

use crate::input_synthesis;

const CLIPBOARD_OPEN_RETRIES: usize = 10;
const CLIPBOARD_OPEN_RETRY_DELAY_MS: u64 = 20;
const CLIPBOARD_RESTORE_DELAY_MS: u64 = 150;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardPasteReport {
    pub warnings: Vec<String>,
}

pub fn paste_text(text: &str) -> Result<ClipboardPasteReport, String> {
    if text.contains('\0') {
        return Err("clipboardPaste does not support NUL characters in snippet text.".into());
    }

    let char_count = text.chars().count();
    log::info!("[clipboard] paste_text: staging {char_count} chars");

    #[cfg(target_os = "windows")]
    return paste_text_windows(text);

    #[cfg(target_os = "linux")]
    return paste_text_linux(text);

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = text;
        Err("clipboardPaste is not implemented for this platform.".into())
    }
}

/// Linux clipboard paste: save → stage → Ctrl+V → restore using arboard.
#[cfg(target_os = "linux")]
fn paste_text_linux(text: &str) -> Result<ClipboardPasteReport, String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("Failed to open clipboard: {e}"))?;

    // Save current clipboard text (best-effort)
    let saved = clipboard.get_text().ok();

    // Stage our text
    clipboard.set_text(text)
        .map_err(|e| format!("Failed to set clipboard text: {e}"))?;

    // Inject Ctrl+V
    let all_mods = crate::hotkeys::HotkeyModifiers {
        ctrl: true,
        shift: true,
        alt: true,
        win: true,
    };
    if let Err(error) = input_synthesis::send_hotkey_string("Ctrl+V", &all_mods) {
        // Restore on failure
        if let Some(original) = &saved {
            let _ = clipboard.set_text(original);
        }
        return Err(format!("Failed to inject Ctrl+V: {error}"));
    }

    // Wait for target app to consume
    thread::sleep(Duration::from_millis(CLIPBOARD_RESTORE_DELAY_MS));

    // Restore original clipboard
    let mut warnings = Vec::new();
    if let Some(original) = saved {
        if let Err(e) = clipboard.set_text(&original) {
            warnings.push(format!("Failed to restore clipboard: {e}"));
        }
    }

    Ok(ClipboardPasteReport { warnings })
}

/// Windows clipboard paste: runs on dedicated STA thread for OLE/COM.
#[cfg(target_os = "windows")]
fn paste_text_windows(text: &str) -> Result<ClipboardPasteReport, String> {
    log::info!("[clipboard] Spawning STA thread for clipboard operation");
    let text_owned = text.to_owned();
    let handle = thread::Builder::new()
        .name("clipboard-sta".into())
        .stack_size(16 * 1024 * 1024) // 16 MB — OleInitialize + COM/Shell extensions need deep stack
        .spawn(move || {
            log::info!("[clipboard] STA thread started");
            let result = paste_text_sta(&text_owned);
            match &result {
                Ok(_) => log::info!("[clipboard] STA thread completed successfully"),
                Err(e) => log::error!("[clipboard] STA thread failed: {e}"),
            }
            result
        })
        .map_err(|e| format!("Failed to spawn clipboard STA thread: {e}"))?;

    match handle.join() {
        Ok(result) => result,
        Err(panic_info) => {
            let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                format!("Clipboard STA thread panicked: {s}")
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                format!("Clipboard STA thread panicked: {s}")
            } else {
                "Clipboard STA thread panicked (unknown cause)".to_string()
            };
            log::error!("[clipboard] {msg}");
            Err(msg)
        }
    }
}

/// Runs on a dedicated STA thread where OleInitialize succeeds.
#[cfg(target_os = "windows")]
fn paste_text_sta(text: &str) -> Result<ClipboardPasteReport, String> {
    let _ole = OleScope::initialize()?;
    log::debug!("[clipboard] STA thread: OLE initialized, saving clipboard snapshot");
    let snapshot = ClipboardSnapshot::capture()?;
    let write_result = match set_clipboard_text(text) {
        Ok(result) => result,
        Err(e) => {
            log::warn!("[clipboard] set_clipboard_text failed, restoring snapshot: {e}");
            let _ = snapshot.restore_force();
            return Err(e);
        }
    };

    // Full clearing: clipboard paste is always an internal operation, not a
    // user-triggered shortcut that should inherit physical keyboard modifiers.
    let all_mods = crate::hotkeys::HotkeyModifiers {
        ctrl: true,
        shift: true,
        alt: true,
        win: true,
    };
    log::debug!("[clipboard] Injecting Ctrl+V");
    if let Err(error) = input_synthesis::send_hotkey_string("Ctrl+V", &all_mods) {
        log::warn!("[clipboard] Ctrl+V injection failed: {error}");
        let restore_message = snapshot
            .restore_force()
            .err()
            .map(|restore_error| format!(" Clipboard restore also failed: {restore_error}"))
            .unwrap_or_default();
        return Err(format!(
            "Failed to inject Ctrl+V after staging clipboard text: {error}.{restore_message}"
        ));
    }

    thread::sleep(Duration::from_millis(CLIPBOARD_RESTORE_DELAY_MS));

    log::debug!("[clipboard] Restoring clipboard");
    let warnings = match snapshot.restore_if_unchanged(write_result.sequence_number) {
        Ok(w) => w,
        Err(restore_error) => {
            log::warn!("[clipboard] Clipboard restore failed: {restore_error}");
            vec![restore_error]
        }
    };
    log::debug!("[clipboard] Clipboard operation complete");
    Ok(ClipboardPasteReport { warnings })
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
enum ClipboardSnapshot {
    Empty,
    #[cfg(target_os = "windows")]
    RawFormats {
        formats: Vec<(u32, *mut core::ffi::c_void, usize)>,
    },
}

#[cfg(target_os = "windows")]
// HGLOBAL pointers are Send-safe — they point to process-local heap memory.
unsafe impl Send for ClipboardSnapshot {}

#[cfg(target_os = "windows")]
impl ClipboardSnapshot {
    fn capture() -> Result<Self, String> {
        unsafe {
            use windows_sys::Win32::{
                Foundation::GlobalFree,
                System::{
                    DataExchange::{
                        CountClipboardFormats, EnumClipboardFormats, GetClipboardData,
                    },
                    Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
                },
            };

            let format_count = CountClipboardFormats();
            if format_count == 0 {
                return Ok(Self::Empty);
            }

            open_clipboard_with_retry()?;
            let _close = ClipboardOpenGuard;

            let mut formats: Vec<(u32, *mut core::ffi::c_void, usize)> = Vec::new();
            let mut format = 0u32;
            loop {
                format = EnumClipboardFormats(format);
                if format == 0 {
                    break;
                }
                let src_handle = GetClipboardData(format);
                if src_handle.is_null() {
                    continue;
                }
                let src_locked = GlobalLock(src_handle);
                if src_locked.is_null() {
                    continue;
                }
                let size = GlobalSize(src_handle);
                if size == 0 {
                    let _ = GlobalUnlock(src_handle);
                    continue;
                }

                let dst_handle = GlobalAlloc(GMEM_MOVEABLE, size);
                if dst_handle.is_null() {
                    let _ = GlobalUnlock(src_handle);
                    continue;
                }
                let dst_locked = GlobalLock(dst_handle);
                if dst_locked.is_null() {
                    let _ = GlobalUnlock(src_handle);
                    let _ = GlobalFree(dst_handle);
                    continue;
                }

                ptr::copy_nonoverlapping(src_locked as *const u8, dst_locked as *mut u8, size);
                let _ = GlobalUnlock(dst_handle);
                let _ = GlobalUnlock(src_handle);

                formats.push((format, dst_handle, size));
            }

            if formats.is_empty() {
                return Ok(Self::Empty);
            }

            log::debug!("[clipboard] Captured {} clipboard formats", formats.len());
            Ok(Self::RawFormats { formats })
        }
    }

    fn restore_if_unchanged(&self, expected_sequence_number: u32) -> Result<Vec<String>, String> {
        unsafe {
            use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;

            let current_sequence_number = GetClipboardSequenceNumber();
            if current_sequence_number != expected_sequence_number {
                return Ok(vec![
                    "Clipboard changed before restore, so the Studio left the newer clipboard contents intact.".into(),
                ]);
            }
        }

        self.restore_force()
    }

    fn restore_force(&self) -> Result<Vec<String>, String> {
        match self {
            Self::Empty => clear_clipboard().map(|()| Vec::new()),
            Self::RawFormats { formats } => restore_raw_formats(formats),
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ClipboardSnapshot {
    fn drop(&mut self) {
        if let Self::RawFormats { formats } = self {
            for &mut (_, handle, _) in formats.iter_mut() {
                if !handle.is_null() {
                    unsafe {
                        use windows_sys::Win32::Foundation::GlobalFree;
                        let _ = GlobalFree(handle);
                    }
                }
            }
        }
    }
}

/// Restore clipboard from saved raw HGLOBAL data.
/// Each saved format's HGLOBAL is duplicated before SetClipboardData (which
/// takes ownership of the handle), so the snapshot can still be dropped safely.
#[cfg(target_os = "windows")]
fn restore_raw_formats(
    formats: &[(u32, *mut core::ffi::c_void, usize)],
) -> Result<Vec<String>, String> {
    unsafe {
        use windows_sys::Win32::{
            Foundation::GlobalFree,
            System::{
                DataExchange::{EmptyClipboard, SetClipboardData},
                Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            },
        };

        open_clipboard_with_retry()?;
        let _close = ClipboardOpenGuard;

        if EmptyClipboard() == 0 {
            return Err("EmptyClipboard failed while restoring clipboard.".into());
        }

        let mut warnings = Vec::new();
        for &(format, src_handle, size) in formats {
            if src_handle.is_null() || size == 0 {
                continue;
            }

            // Duplicate the HGLOBAL — SetClipboardData takes ownership
            let dst_handle = GlobalAlloc(GMEM_MOVEABLE, size);
            if dst_handle.is_null() {
                warnings.push(format!(
                    "GlobalAlloc failed for clipboard format {format} during restore."
                ));
                continue;
            }
            let src_locked = GlobalLock(src_handle);
            let dst_locked = GlobalLock(dst_handle);
            if src_locked.is_null() || dst_locked.is_null() {
                if !dst_locked.is_null() {
                    let _ = GlobalUnlock(dst_handle);
                }
                if !src_locked.is_null() {
                    let _ = GlobalUnlock(src_handle);
                }
                let _ = GlobalFree(dst_handle);
                warnings.push(format!(
                    "GlobalLock failed for clipboard format {format} during restore."
                ));
                continue;
            }

            ptr::copy_nonoverlapping(src_locked as *const u8, dst_locked as *mut u8, size);
            let _ = GlobalUnlock(dst_handle);
            let _ = GlobalUnlock(src_handle);

            let result = SetClipboardData(format, dst_handle);
            if result.is_null() {
                // SetClipboardData failed — we still own the handle
                let _ = GlobalFree(dst_handle);
                warnings.push(format!(
                    "SetClipboardData failed for clipboard format {format}."
                ));
            }
            // On success, SetClipboardData takes ownership — do NOT free dst_handle
        }

        log::debug!(
            "[clipboard] Restored {} clipboard formats",
            formats.len() - warnings.len()
        );
        Ok(warnings)
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct ClipboardWriteResult {
    sequence_number: u32,
}

#[cfg(target_os = "windows")]
fn set_clipboard_text(text: &str) -> Result<ClipboardWriteResult, String> {
    unsafe {
        use windows_sys::Win32::{
            Foundation::GlobalFree,
            System::{
                DataExchange::{
                    EmptyClipboard, GetClipboardSequenceNumber, GetOpenClipboardWindow,
                    SetClipboardData,
                },
                Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
                Ole::CF_UNICODETEXT,
            },
        };

        let encoded = utf16_null_terminated(text);
        let byte_len = encoded.len() * std::mem::size_of::<u16>();

        open_clipboard_with_retry()?;
        let close_guard = ClipboardOpenGuard;

        if EmptyClipboard() == 0 {
            log::warn!("[clipboard] EmptyClipboard failed while staging snippet text");
            return Err("EmptyClipboard failed while staging snippet text.".into());
        }

        let handle = GlobalAlloc(GMEM_MOVEABLE, byte_len);
        if handle.is_null() {
            log::warn!("[clipboard] GlobalAlloc failed after EmptyClipboard; prior clipboard contents are lost");
            return Err(
                "GlobalAlloc failed after EmptyClipboard; prior clipboard contents are lost."
                    .into(),
            );
        }

        let locked = GlobalLock(handle);
        if locked.is_null() {
            let _ = GlobalFree(handle);
            log::warn!("[clipboard] GlobalLock failed while staging snippet text");
            return Err("GlobalLock failed while staging snippet text.".into());
        }

        ptr::copy_nonoverlapping(encoded.as_ptr() as *const u8, locked as *mut u8, byte_len);
        let _ = GlobalUnlock(handle);

        let clipboard_handle = SetClipboardData(u32::from(CF_UNICODETEXT), handle);
        if clipboard_handle.is_null() {
            let _ = GlobalFree(handle);
            let owner = GetOpenClipboardWindow();
            log::warn!(
                "[clipboard] SetClipboardData failed. OpenClipboard owner: 0x{:X}",
                owner as usize
            );
            return Err(format!(
                "SetClipboardData failed while staging snippet text. OpenClipboard owner: 0x{:X}.",
                owner as usize
            ));
        }

        drop(close_guard);

        Ok(ClipboardWriteResult {
            sequence_number: GetClipboardSequenceNumber(),
        })
    }
}

#[cfg(target_os = "windows")]
fn clear_clipboard() -> Result<(), String> {
    unsafe {
        use windows_sys::Win32::System::DataExchange::EmptyClipboard;

        open_clipboard_with_retry()?;
        let close_guard = ClipboardOpenGuard;
        if EmptyClipboard() == 0 {
            return Err("EmptyClipboard failed while restoring an empty clipboard.".into());
        }
        drop(close_guard);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn open_clipboard_with_retry() -> Result<(), String> {
    unsafe {
        use windows_sys::Win32::System::DataExchange::{GetOpenClipboardWindow, OpenClipboard};

        log::debug!("[clipboard] Opening clipboard");
        for attempt in 0..CLIPBOARD_OPEN_RETRIES {
            if OpenClipboard(ptr::null_mut()) != 0 {
                return Ok(());
            }

            if attempt + 1 < CLIPBOARD_OPEN_RETRIES {
                thread::sleep(Duration::from_millis(CLIPBOARD_OPEN_RETRY_DELAY_MS));
            }
        }

        let owner = GetOpenClipboardWindow();
        let msg = format!(
            "OpenClipboard failed after {} attempts. OpenClipboard owner: 0x{:X}.",
            CLIPBOARD_OPEN_RETRIES, owner as usize
        );
        log::warn!("[clipboard] {msg}");
        Err(msg)
    }
}

#[cfg(target_os = "windows")]
fn utf16_null_terminated(text: &str) -> Vec<u16> {
    let mut encoded: Vec<u16> = text.encode_utf16().collect();
    encoded.push(0);
    encoded
}

#[cfg(target_os = "windows")]
struct ClipboardOpenGuard;

#[cfg(target_os = "windows")]
impl Drop for ClipboardOpenGuard {
    fn drop(&mut self) {
        unsafe {
            use windows_sys::Win32::System::DataExchange::CloseClipboard;
            let _ = CloseClipboard();
        }
    }
}

#[cfg(target_os = "windows")]
struct OleScope {
    should_uninitialize: bool,
}

#[cfg(target_os = "windows")]
impl OleScope {
    fn initialize() -> Result<Self, String> {
        unsafe {
            use windows_sys::Win32::{
                Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK},
                System::Ole::OleInitialize,
            };

            let hr = OleInitialize(ptr::null());
            if hr == S_OK || hr == S_FALSE {
                return Ok(Self {
                    should_uninitialize: true,
                });
            }
            if hr == RPC_E_CHANGED_MODE {
                return Err(
                    "clipboardPaste requires an STA OLE apartment, but the current thread is initialized in a conflicting COM mode."
                        .into(),
                );
            }

            Err(format!(
                "OleInitialize failed for clipboardPaste: {}",
                format_hresult(hr)
            ))
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for OleScope {
    fn drop(&mut self) {
        unsafe {
            if self.should_uninitialize {
                use windows_sys::Win32::System::Ole::OleUninitialize;
                OleUninitialize();
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn format_hresult(hr: windows_sys::core::HRESULT) -> String {
    format!("HRESULT 0x{:08X}", hr as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "windows")]
    fn utf16_helper_appends_nul() {
        let encoded = utf16_null_terminated("Hi");
        assert_eq!(encoded, vec![72, 105, 0]);
    }

    /// Read the current clipboard text via Win32 API. Test-only helper.
    #[cfg(target_os = "windows")]
    fn read_clipboard_text() -> Result<String, String> {
        unsafe {
            use windows_sys::Win32::System::{
                DataExchange::{GetClipboardData, IsClipboardFormatAvailable},
                Memory::GlobalLock,
                Ole::CF_UNICODETEXT,
            };

            let format = u32::from(CF_UNICODETEXT);
            if IsClipboardFormatAvailable(format) == 0 {
                return Err("CF_UNICODETEXT not available on clipboard".into());
            }

            open_clipboard_with_retry()?;
            let _guard = ClipboardOpenGuard;

            let handle = GetClipboardData(format);
            if handle.is_null() {
                return Err("GetClipboardData returned null".into());
            }

            let locked = GlobalLock(handle);
            if locked.is_null() {
                return Err("GlobalLock on clipboard data returned null".into());
            }

            let mut len = 0usize;
            let wide_ptr = locked as *const u16;
            while *wide_ptr.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(wide_ptr, len);
            let text = String::from_utf16(slice)
                .map_err(|e| format!("Invalid UTF-16 in clipboard: {e}"))?;

            use windows_sys::Win32::System::Memory::GlobalUnlock;
            let _ = GlobalUnlock(handle);

            Ok(text)
        }
    }

    /// Serialize clipboard tests: the Windows clipboard is a global singleton,
    /// so concurrent tests would race. This lock ensures one test at a time.
    #[cfg(target_os = "windows")]
    static CLIPBOARD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    #[cfg(target_os = "windows")]
    fn clipboard_set_and_read_roundtrip() {
        let _lock = CLIPBOARD_LOCK.lock().unwrap();
        let _ole = OleScope::initialize().expect("OleInitialize");

        let text = "Naga Studio roundtrip test";
        set_clipboard_text(text).expect("set_clipboard_text");

        let read_back = read_clipboard_text().expect("read_clipboard_text");
        assert_eq!(read_back, text);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn clipboard_handles_empty_text() {
        let _lock = CLIPBOARD_LOCK.lock().unwrap();
        let _ole = OleScope::initialize().expect("OleInitialize");

        // Setting empty string should succeed without panic.
        set_clipboard_text("").expect("set_clipboard_text with empty string");

        let read_back = read_clipboard_text().expect("read_clipboard_text");
        assert_eq!(read_back, "");
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn clipboard_handles_unicode() {
        let _lock = CLIPBOARD_LOCK.lock().unwrap();
        let _ole = OleScope::initialize().expect("OleInitialize");

        let text = "Привет мир";
        set_clipboard_text(text).expect("set_clipboard_text with Cyrillic");

        let read_back = read_clipboard_text().expect("read_clipboard_text");
        assert_eq!(read_back, text);
    }

    /// This test calls `paste_text`, which simulates a real Ctrl+V keystroke.
    /// It is marked `#[ignore]` because the injected input would type into
    /// whatever window is focused, causing unintended side effects.
    /// Run manually with: `cargo test clipboard_restore -- --ignored`
    #[test]
    #[ignore]
    #[cfg(target_os = "windows")]
    fn clipboard_restore_preserves_original() {
        let _lock = CLIPBOARD_LOCK.lock().unwrap();

        let original = "original clipboard content";
        {
            let _ole = OleScope::initialize().expect("OleInitialize");
            set_clipboard_text(original).expect("set original text");
        }

        // paste_text sets "injected text", sends Ctrl+V, then restores.
        let report = paste_text("injected text").expect("paste_text");

        // After paste_text returns, the clipboard should be restored to the
        // original text (unless another application grabbed it in the meantime,
        // which paste_text reports as a warning).
        if report.warnings.is_empty() {
            let _ole = OleScope::initialize().expect("OleInitialize for read-back");
            let restored = read_clipboard_text().expect("read_clipboard_text after restore");
            assert_eq!(restored, original);
        }
    }
}
