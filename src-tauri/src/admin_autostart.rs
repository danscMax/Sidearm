//! Elevated autostart-at-logon via Windows Task Scheduler.
//!
//! The canonical Windows approach for "auto-launch with admin privileges
//! without a UAC prompt every time" is a scheduled task with `RunLevel=Highest`
//! and a logon trigger.  PowerToys, EarTrumpet and most production-grade
//! tools that need admin at startup use this pattern.
//!
//! We shell out to `schtasks.exe` for create/delete (cleaner than ITaskService
//! COM) and for query.  Create/delete need elevation, so they go through
//! `ShellExecuteW` with verb `runas` (one UAC prompt at enable/disable time).
//! Query needs no elevation and runs synchronously so we can read stdout.

use std::path::Path;

const TASK_NAME: &str = "SidearmAutostartAdmin";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminAutostartStatus {
    /// Whether the scheduled task currently exists on this machine.
    pub enabled: bool,
    /// Path the task is registered to launch.  Empty when not enabled.
    pub registered_path: Option<String>,
    /// Current Sidearm executable path.
    pub current_exe: String,
    /// True when enabled and the registered path differs from `current_exe`
    /// (e.g. portable folder was moved since registration).
    pub path_mismatch: bool,
    /// Platform-level support — false on non-Windows.
    pub supported: bool,
}

#[cfg(target_os = "windows")]
pub fn query() -> AdminAutostartStatus {
    let current_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let registered_path = query_registered_path();
    let path_mismatch = match &registered_path {
        Some(p) => !paths_equal(Path::new(p), Path::new(&current_exe)),
        None => false,
    };
    AdminAutostartStatus {
        enabled: registered_path.is_some(),
        registered_path,
        current_exe,
        path_mismatch,
        supported: true,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn query() -> AdminAutostartStatus {
    let current_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    AdminAutostartStatus {
        enabled: false,
        registered_path: None,
        current_exe,
        path_mismatch: false,
        supported: false,
    }
}

#[cfg(target_os = "windows")]
pub fn enable() -> Result<(), String> {
    // Self-elevation: re-launch the current Sidearm exe with verb "runas" and
    // a CLI flag, then have the elevated child run schtasks via
    // CREATE_NO_WINDOW.  This is the canonical way to avoid the console-window
    // flash that ShellExecuteW(runas, schtasks.exe) produces.
    self_elevate_admin_autostart("enable")
}

#[cfg(target_os = "windows")]
pub fn disable() -> Result<(), String> {
    self_elevate_admin_autostart("disable")
}

/// Run synchronously inside the elevated child process to actually create
/// the scheduled task.  Returns process exit code (0 on success).
#[cfg(target_os = "windows")]
pub fn run_silent_enable_from_elevated_child() -> i32 {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return 2,
    };
    let tr = format!("\"{}\"", exe.to_string_lossy());
    let status = std::process::Command::new("schtasks")
        .args([
            "/create", "/tn", TASK_NAME, "/tr", &tr, "/sc", "onlogon", "/rl",
            "highest", "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    match status {
        Ok(s) if s.success() => 0,
        Ok(s) => s.code().unwrap_or(1),
        Err(_) => 3,
    }
}

#[cfg(target_os = "windows")]
pub fn run_silent_disable_from_elevated_child() -> i32 {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let status = std::process::Command::new("schtasks")
        .args(["/delete", "/tn", TASK_NAME, "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    match status {
        Ok(s) if s.success() => 0,
        Ok(s) => s.code().unwrap_or(1),
        Err(_) => 3,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn enable() -> Result<(), String> {
    Err("Admin autostart is supported only on Windows.".into())
}

#[cfg(not(target_os = "windows"))]
pub fn disable() -> Result<(), String> {
    Err("Admin autostart is supported only on Windows.".into())
}

#[cfg(target_os = "windows")]
fn query_registered_path() -> Option<String> {
    use std::process::Command;
    // /xml output is locale-independent and easy to parse.  schtasks emits
    // UTF-16 LE with BOM on stdout when /xml is used.
    let output = Command::new("schtasks")
        .args(["/query", "/tn", TASK_NAME, "/xml"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let xml = decode_utf16_or_utf8(&output.stdout);
    extract_command_from_xml(&xml).map(|p| p.trim_matches('"').to_string())
}

/// Launch the current Sidearm exe elevated with `--admin-autostart <action>`,
/// wait for the elevated child to finish, and return its exit code as Ok/Err.
///
/// Why self-elevate instead of running schtasks.exe directly:
/// `ShellExecuteW("runas", "schtasks.exe", ...)` flashes a console window even
/// with SW_HIDE because schtasks is a console application and Windows attaches
/// a fresh console to it on launch.  Sidearm.exe is a GUI subsystem binary, so
/// when the elevated child runs `schtasks` via `Command + CREATE_NO_WINDOW`
/// no console ever materialises — zero UI flash.
#[cfg(target_os = "windows")]
fn self_elevate_admin_autostart(action: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe failed: {e}"))?;
    let exe_w: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb_w: Vec<u16> = "runas\0".encode_utf16().collect();
    let params = format!("--admin-autostart {action}");
    let params_w: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();

    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: std::ptr::null_mut(),
        lpVerb: verb_w.as_ptr(),
        lpFile: exe_w.as_ptr(),
        lpParameters: params_w.as_ptr(),
        lpDirectory: std::ptr::null(),
        nShow: SW_HIDE as i32,
        hInstApp: std::ptr::null_mut(),
        lpIDList: std::ptr::null_mut(),
        lpClass: std::ptr::null(),
        hkeyClass: std::ptr::null_mut(),
        dwHotKey: 0,
        Anonymous: unsafe { std::mem::zeroed() },
        hProcess: std::ptr::null_mut(),
    };

    let ok = unsafe { ShellExecuteExW(&mut sei) };
    if ok == 0 {
        // GetLastError == 1223 (ERROR_CANCELLED) when the user clicks "No" on UAC.
        let err = std::io::Error::last_os_error();
        return Err(if err.raw_os_error() == Some(1223) {
            "Запуск от администратора отменён в UAC.".into()
        } else {
            format!("ShellExecuteExW failed: {err}")
        });
    }

    if sei.hProcess.is_null() {
        return Err("ShellExecuteExW did not return a process handle.".into());
    }

    let wait = unsafe { WaitForSingleObject(sei.hProcess, INFINITE) };
    if wait != WAIT_OBJECT_0 {
        unsafe { CloseHandle(sei.hProcess) };
        return Err("Wait on elevated child failed.".into());
    }
    let mut exit_code: u32 = 1;
    let got = unsafe { GetExitCodeProcess(sei.hProcess, &mut exit_code) };
    unsafe { CloseHandle(sei.hProcess) };
    if got == 0 {
        return Err("GetExitCodeProcess failed.".into());
    }
    if exit_code != 0 {
        return Err(format!("schtasks exited with code {exit_code}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn decode_utf16_or_utf8(bytes: &[u8]) -> String {
    // schtasks /xml emits UTF-16 LE with BOM (FF FE).  Fall back to UTF-8
    // for safety on unusual locales.
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let mut units = Vec::with_capacity((bytes.len() - 2) / 2);
        for chunk in bytes[2..].chunks_exact(2) {
            units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn extract_command_from_xml(xml: &str) -> Option<String> {
    // <Exec><Command>C:\path\to\Sidearm.exe</Command>...</Exec>
    let start = xml.find("<Command>")?;
    let after = &xml[start + "<Command>".len()..];
    let end = after.find("</Command>")?;
    Some(after[..end].trim().to_string())
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    if let (Ok(ca), Ok(cb)) = (a.canonicalize(), b.canonicalize()) {
        return ca == cb;
    }
    // Fallback when one of the paths no longer exists (e.g. portable folder
    // was moved): compare case-insensitive lossy strings.
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_command_from_simple_xml() {
        let xml = r#"<Task><Actions><Exec><Command>C:\Sidearm.exe</Command></Exec></Actions></Task>"#;
        assert_eq!(
            extract_command_from_xml(xml).as_deref(),
            Some("C:\\Sidearm.exe")
        );
    }

    #[test]
    fn extracts_command_with_quoted_path() {
        let xml = r#"<Exec><Command>"C:\Program Files\Sidearm\Sidearm.exe"</Command></Exec>"#;
        // We return the raw inner text including quotes; the caller trims them
        // because schtasks /xml stores them when /tr was quoted.
        assert_eq!(
            extract_command_from_xml(xml).as_deref(),
            Some(r#""C:\Program Files\Sidearm\Sidearm.exe""#)
        );
    }

    #[test]
    fn returns_none_when_no_command_tag() {
        let xml = "<Task></Task>";
        assert!(extract_command_from_xml(xml).is_none());
    }

    #[test]
    fn paths_equal_handles_case_difference_on_windows() {
        // Even when both paths don't exist, the lowercase fallback should match.
        let a = Path::new("C:\\NoSuchFolder\\Sidearm.exe");
        let b = Path::new("c:\\NoSuchFolder\\sidearm.exe");
        assert!(paths_equal(a, b));
    }
}
