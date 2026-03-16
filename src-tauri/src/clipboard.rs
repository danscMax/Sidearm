use std::{ptr, thread, time::Duration};

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

    // OleInitialize requires STA (Single-Threaded Apartment), but Tauri's
    // async runtime initializes threads as MTA. Calling OleInitialize on an
    // MTA thread causes RPC_E_CHANGED_MODE or a COM crash. The fix: run the
    // entire clipboard operation on a dedicated STA thread.
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
fn paste_text_sta(text: &str) -> Result<ClipboardPasteReport, String> {
    let _ole = OleScope::initialize()?;
    log::debug!("[clipboard] STA thread: OLE initialized, saving clipboard snapshot");
    let snapshot = ClipboardSnapshot::capture()?;
    let write_result = set_clipboard_text(text)?;

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

#[derive(Debug)]
enum ClipboardSnapshot {
    Empty,
    DataObject(ComPtr),
}

impl ClipboardSnapshot {
    fn capture() -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::{
                DataExchange::CountClipboardFormats, Ole::OleGetClipboard,
            };

            let format_count = CountClipboardFormats();
            if format_count == 0 {
                return Ok(Self::Empty);
            }

            let mut data_object = ptr::null_mut();
            let hr = OleGetClipboard(&mut data_object);
            if succeeded(hr) && !data_object.is_null() {
                return Ok(Self::DataObject(ComPtr::new(data_object)));
            }

            Err(format!(
                "Failed to snapshot the current clipboard object: {}",
                format_hresult(hr)
            ))
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = text;
            Err("clipboardPaste is only implemented for Windows.".into())
        }
    }

    fn restore_if_unchanged(&self, expected_sequence_number: u32) -> Result<Vec<String>, String> {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;

            let current_sequence_number = GetClipboardSequenceNumber();
            if current_sequence_number != expected_sequence_number {
                return Ok(vec![
                    "Clipboard changed before restore, so the Studio left the newer clipboard contents intact.".into(),
                ]);
            }
        }

        self.restore_force().map(|mut warnings| {
            if warnings.is_empty() {
                warnings
            } else {
                let mut prefixed = Vec::with_capacity(warnings.len());
                prefixed.append(&mut warnings);
                prefixed
            }
        })
    }

    fn restore_force(&self) -> Result<Vec<String>, String> {
        match self {
            Self::Empty => clear_clipboard().map(|()| Vec::new()),
            Self::DataObject(data_object) => restore_clipboard_object(data_object),
        }
    }
}

#[derive(Debug)]
struct ClipboardWriteResult {
    sequence_number: u32,
}

fn set_clipboard_text(text: &str) -> Result<ClipboardWriteResult, String> {
    #[cfg(target_os = "windows")]
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

        // NOTE: The Windows clipboard API requires EmptyClipboard() to be called
        // before SetClipboardData(). This means if GlobalAlloc fails below, the
        // clipboard will have already been emptied and the prior contents are lost.
        // This is an inherent limitation of the Win32 clipboard API -- there is no
        // way to atomically replace clipboard contents. The caller (paste_text)
        // mitigates this by capturing a snapshot via OleGetClipboard before we get
        // here, but the snapshot restore is best-effort and may not recover all
        // original clipboard formats.
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

    #[cfg(not(target_os = "windows"))]
    {
        let _ = text;
        Err("clipboardPaste is only implemented for Windows.".into())
    }
}

fn clear_clipboard() -> Result<(), String> {
    #[cfg(target_os = "windows")]
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

    #[cfg(not(target_os = "windows"))]
    {
        Err("clipboardPaste is only implemented for Windows.".into())
    }
}

fn restore_clipboard_object(data_object: &ComPtr) -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::System::Ole::{OleFlushClipboard, OleSetClipboard};

        log::debug!("[clipboard] Restoring previous clipboard object");
        let hr = OleSetClipboard(data_object.as_raw());
        if !succeeded(hr) {
            log::warn!(
                "[clipboard] OleSetClipboard failed: {}",
                format_hresult(hr)
            );
            return Err(format!(
                "Failed to restore the previous clipboard object: {}",
                format_hresult(hr)
            ));
        }

        let flush_hr = OleFlushClipboard();
        if !succeeded(flush_hr) {
            log::warn!(
                "[clipboard] OleFlushClipboard failed: {}",
                format_hresult(flush_hr)
            );
            return Ok(vec![format!(
                "Clipboard was restored, but OleFlushClipboard failed: {}.",
                format_hresult(flush_hr)
            )]);
        }

        Ok(Vec::new())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = data_object;
        Err("clipboardPaste is only implemented for Windows.".into())
    }
}

fn open_clipboard_with_retry() -> Result<(), String> {
    #[cfg(target_os = "windows")]
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

    #[cfg(not(target_os = "windows"))]
    {
        Err("clipboardPaste is only implemented for Windows.".into())
    }
}

fn utf16_null_terminated(text: &str) -> Vec<u16> {
    let mut encoded: Vec<u16> = text.encode_utf16().collect();
    encoded.push(0);
    encoded
}

struct ClipboardOpenGuard;

impl Drop for ClipboardOpenGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::DataExchange::CloseClipboard;
            let _ = CloseClipboard();
        }
    }
}

struct OleScope {
    should_uninitialize: bool,
}

impl OleScope {
    fn initialize() -> Result<Self, String> {
        #[cfg(target_os = "windows")]
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

        #[cfg(not(target_os = "windows"))]
        {
            Err("clipboardPaste is only implemented for Windows.".into())
        }
    }
}

impl Drop for OleScope {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        unsafe {
            if self.should_uninitialize {
                use windows_sys::Win32::System::Ole::OleUninitialize;
                OleUninitialize();
            }
        }
    }
}

#[derive(Debug)]
struct ComPtr(*mut core::ffi::c_void);

impl ComPtr {
    fn new(raw: *mut core::ffi::c_void) -> Self {
        Self(raw)
    }

    fn as_raw(&self) -> *mut core::ffi::c_void {
        self.0
    }
}

impl Drop for ComPtr {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        unsafe {
            if !self.0.is_null() {
                let vtbl = *(self.0 as *mut *mut windows_sys::core::IUnknown_Vtbl);
                ((*vtbl).Release)(self.0);
            }
        }
    }
}

fn succeeded(hr: windows_sys::core::HRESULT) -> bool {
    hr >= 0
}

fn format_hresult(hr: windows_sys::core::HRESULT) -> String {
    format!("HRESULT 0x{:08X}", hr as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
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
