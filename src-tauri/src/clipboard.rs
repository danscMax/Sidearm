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

    let _ole = OleScope::initialize()?;
    let snapshot = ClipboardSnapshot::capture()?;
    let write_result = set_clipboard_text(text)?;

    if let Err(error) = input_synthesis::send_hotkey_string("Ctrl+V") {
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

    let warnings = snapshot.restore_if_unchanged(write_result.sequence_number)?;
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
                DataExchange::CountClipboardFormats,
                Ole::OleGetClipboard,
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

        if EmptyClipboard() == 0 {
            return Err("EmptyClipboard failed while staging snippet text.".into());
        }

        let handle = GlobalAlloc(GMEM_MOVEABLE, byte_len);
        if handle.is_null() {
            return Err("GlobalAlloc failed while staging snippet text.".into());
        }

        let locked = GlobalLock(handle);
        if locked.is_null() {
            let _ = GlobalFree(handle);
            return Err("GlobalLock failed while staging snippet text.".into());
        }

        ptr::copy_nonoverlapping(
            encoded.as_ptr() as *const u8,
            locked as *mut u8,
            byte_len,
        );
        let _ = GlobalUnlock(handle);

        let clipboard_handle = SetClipboardData(u32::from(CF_UNICODETEXT), handle);
        if clipboard_handle.is_null() {
            let _ = GlobalFree(handle);
            let owner = GetOpenClipboardWindow();
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
        use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard};

        open_clipboard_with_retry()?;
        let close_guard = ClipboardOpenGuard;
        if EmptyClipboard() == 0 {
            return Err("EmptyClipboard failed while restoring an empty clipboard.".into());
        }
        drop(close_guard);
        let _ = CloseClipboard;
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

        let hr = OleSetClipboard(data_object.as_raw());
        if !succeeded(hr) {
            return Err(format!(
                "Failed to restore the previous clipboard object: {}",
                format_hresult(hr)
            ));
        }

        let flush_hr = OleFlushClipboard();
        if !succeeded(flush_hr) {
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

        for attempt in 0..CLIPBOARD_OPEN_RETRIES {
            if OpenClipboard(ptr::null_mut()) != 0 {
                return Ok(());
            }

            if attempt + 1 < CLIPBOARD_OPEN_RETRIES {
                thread::sleep(Duration::from_millis(CLIPBOARD_OPEN_RETRY_DELAY_MS));
            }
        }

        let owner = GetOpenClipboardWindow();
        Err(format!(
            "OpenClipboard failed after {} attempts. OpenClipboard owner: 0x{:X}.",
            CLIPBOARD_OPEN_RETRIES,
            owner as usize
        ))
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
}
