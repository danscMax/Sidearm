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
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe failed: {e}"))?;
    let exe_str = exe.to_string_lossy();
    // /tr expects a single quoted string. To keep the exe path intact when it
    // contains spaces, we wrap it in escaped quotes inside the outer pair.
    // The resulting argument that schtasks parses is:  "\"C:\Path\Sidearm.exe\""
    let args = format!(
        "/create /tn {task} /tr \"\\\"{exe}\\\"\" /sc onlogon /rl highest /f",
        task = TASK_NAME,
        exe = exe_str,
    );
    elevated_schtasks(&args)
}

#[cfg(target_os = "windows")]
pub fn disable() -> Result<(), String> {
    let args = format!("/delete /tn {} /f", TASK_NAME);
    elevated_schtasks(&args)
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

#[cfg(target_os = "windows")]
fn elevated_schtasks(args: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let file = std::ffi::OsStr::new("schtasks.exe");
    let file_w: Vec<u16> = file.encode_wide().chain(std::iter::once(0)).collect();
    let verb_w: Vec<u16> = "runas\0".encode_utf16().collect();
    let args_w: Vec<u16> = args.encode_utf16().chain(std::iter::once(0)).collect();

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_w.as_ptr(),
            file_w.as_ptr(),
            args_w.as_ptr(),
            std::ptr::null(),
            SW_HIDE,
        )
    };
    let code = result as isize;
    if code <= 32 {
        // SE_ERR_ACCESSDENIED (5) is what we get when the user cancels UAC.
        return Err(if code == 5 {
            "Запуск schtasks от администратора отменён в UAC.".into()
        } else {
            format!("ShellExecuteW(schtasks.exe) failed with code {code}")
        });
    }
    // ShellExecuteW returns immediately — give schtasks a moment to actually
    // create/delete the task before the caller re-queries status.
    std::thread::sleep(std::time::Duration::from_millis(800));
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
