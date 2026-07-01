//! Elevated autostart-at-logon via Windows Task Scheduler COM API.
//!
//! Earlier versions shelled out to `schtasks.exe`, which flashes a console
//! window on every toggle even when launched with `SW_HIDE` (schtasks is a
//! console application — Windows attaches a fresh console to it on launch).
//!
//! This implementation talks to Task Scheduler directly through COM, using
//! the higher-level `windows` crate for safer interface dispatch:
//!   - **Query** (no UAC): in-proc `ITaskService` via `CoCreateInstance` →
//!     `GetFolder("\\")` → `GetTask` → read `IRegisteredTask::Xml`.
//!   - **Create / delete** (UAC once per toggle): elevated `ITaskService`
//!     via the `Elevation:Administrator!new:{CLSID}` COM moniker, then
//!     normal `ITaskFolder::RegisterTask` / `DeleteTask`.
//!
//! Result: a single UAC prompt at toggle time, **zero** external processes
//! spawned, zero console flashes.

use std::path::Path;

const TASK_NAME: &str = "SidearmAutostartAdmin";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminAutostartStatus {
    pub enabled: bool,
    pub registered_path: Option<String>,
    pub current_exe: String,
    pub path_mismatch: bool,
    pub supported: bool,
}

#[cfg(target_os = "windows")]
pub fn query() -> AdminAutostartStatus {
    let current_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let registered_path = win::query_registered_path().ok().flatten();
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
    AdminAutostartStatus {
        enabled: false,
        registered_path: None,
        current_exe: String::new(),
        path_mismatch: false,
        supported: false,
    }
}

#[cfg(target_os = "windows")]
pub fn enable() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let xml = task_definition_xml(&exe.to_string_lossy());
    win::register_task_elevated(TASK_NAME, &xml)
}

#[cfg(target_os = "windows")]
pub fn disable() -> Result<(), String> {
    win::delete_task_elevated(TASK_NAME)
}

#[cfg(not(target_os = "windows"))]
pub fn enable() -> Result<(), String> {
    Err("Admin autostart is supported only on Windows.".into())
}

#[cfg(not(target_os = "windows"))]
pub fn disable() -> Result<(), String> {
    Err("Admin autostart is supported only on Windows.".into())
}

/// Task XML definition.  Logon trigger + Exec action + RunLevel=HighestAvailable.
/// `DisallowStartIfOnBatteries=false` and `StopIfGoingOnBatteries=false` keep
/// the task active on laptops; default Task Scheduler settings would prevent
/// startup when not plugged in.
fn task_definition_xml(exe_path: &str) -> String {
    let escaped_exe = xml_escape(exe_path);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sidearm autostart at logon with administrator privileges.</Description>
    <Author>Sidearm</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escaped_exe}</Command>
    </Exec>
  </Actions>
</Task>"#
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    if let (Ok(ca), Ok(cb)) = (a.canonicalize(), b.canonicalize()) {
        return ca == cb;
    }
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

fn extract_command_from_xml(xml: &str) -> Option<String> {
    let start = xml.find("<Command>")?;
    let after = &xml[start + "<Command>".len()..];
    let end = after.find("</Command>")?;
    // schtasks-registered tasks (pre-v0.1.11) wrapped the path in quotes
    // inside the <Command> element to handle spaces; the COM API does not.
    // Strip surrounding quotes so path comparison works regardless of which
    // version registered the task.
    Some(after[..end].trim().trim_matches('"').to_string())
}

#[cfg(target_os = "windows")]
mod win {
    use super::{TASK_NAME, extract_command_from_xml};
    use windows::Win32::System::Com::{
        BIND_OPTS, BIND_OPTS3, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance,
        CoGetObject, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::System::TaskScheduler::{
        ITaskFolder, ITaskService, TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN,
        TaskScheduler,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::core::{BSTR, GUID, PCWSTR};

    const HR_ERROR_CANCELLED: u32 = 0x8007_04C7; // user clicked No on UAC
    const HR_FILE_NOT_FOUND: u32 = 0x8007_0002; // task doesn't exist
    const HR_RPC_E_CHANGED_MODE: u32 = 0x8001_0106;

    /// RAII guard for CoInitializeEx / CoUninitialize.
    struct ComGuard;
    impl ComGuard {
        fn init() -> Result<Self, String> {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            // RPC_E_CHANGED_MODE — already initialised in another mode by
            // Tauri's main thread; that's expected and harmless on this
            // worker thread because we don't reinit, we just proceed.
            if hr.is_err() && hr.0 as u32 != HR_RPC_E_CHANGED_MODE {
                return Err(format!("CoInitializeEx: 0x{:08X}", hr.0));
            }
            Ok(ComGuard)
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    /// Get a non-elevated ITaskService (for queries that don't need admin).
    fn create_local_service() -> windows::core::Result<ITaskService> {
        unsafe { CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER) }
    }

    /// Get an elevated ITaskService via Windows' COM elevation moniker.
    /// Triggers a UAC prompt; the rest of the Sidearm process stays Medium-IL.
    fn create_elevated_service() -> Result<ITaskService, String> {
        let moniker_str = format!(
            "Elevation:Administrator!new:{{{}}}",
            guid_to_string(&TaskScheduler)
        );
        let moniker: Vec<u16> = moniker_str
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // BIND_OPTS3 -> BIND_OPTS2 -> BIND_OPTS is the layout windows-rs exposes.
        let mut bind_opts3 = BIND_OPTS3::default();
        bind_opts3.Base.Base.cbStruct = std::mem::size_of::<BIND_OPTS3>() as u32;
        bind_opts3.Base.dwClassContext = CLSCTX_INPROC_SERVER.0;

        let result: windows::core::Result<ITaskService> = unsafe {
            CoGetObject(
                PCWSTR(moniker.as_ptr()),
                Some(&bind_opts3 as *const _ as *const BIND_OPTS),
            )
        };
        result.map_err(|e| {
            if e.code().0 as u32 == HR_ERROR_CANCELLED {
                "Запуск от администратора отменён в UAC.".into()
            } else {
                format!("CoGetObject(elevation): 0x{:08X}", e.code().0)
            }
        })
    }

    fn guid_to_string(g: &GUID) -> String {
        format!(
            "{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
            g.data1,
            g.data2,
            g.data3,
            g.data4[0],
            g.data4[1],
            g.data4[2],
            g.data4[3],
            g.data4[4],
            g.data4[5],
            g.data4[6],
            g.data4[7],
        )
    }

    /// Connect an `ITaskService` and return the root `\` task folder. Shared
    /// preamble for register/delete/query (each supplies its own service).
    fn connect_root_folder(service: &ITaskService) -> Result<ITaskFolder, String> {
        unsafe {
            service
                .Connect(
                    &VARIANT::default(),
                    &VARIANT::default(),
                    &VARIANT::default(),
                    &VARIANT::default(),
                )
                .map_err(|e| format!("ITaskService::Connect: {e}"))?;
            service
                .GetFolder(&BSTR::from("\\"))
                .map_err(|e| format!("GetFolder: {e}"))
        }
    }

    pub fn register_task_elevated(name: &str, xml: &str) -> Result<(), String> {
        let _guard = ComGuard::init()?;
        let service = create_elevated_service()?;
        let root = connect_root_folder(&service)?;
        unsafe {
            root.RegisterTask(
                &BSTR::from(name),
                &BSTR::from(xml),
                TASK_CREATE_OR_UPDATE.0,
                &VARIANT::default(),
                &VARIANT::default(),
                TASK_LOGON_INTERACTIVE_TOKEN,
                &VARIANT::default(),
            )
            .map_err(|e| format!("RegisterTask: {e}"))?;
        }
        Ok(())
    }

    pub fn delete_task_elevated(name: &str) -> Result<(), String> {
        let _guard = ComGuard::init()?;
        let service = create_elevated_service()?;
        let root = connect_root_folder(&service)?;
        unsafe {
            match root.DeleteTask(&BSTR::from(name), 0) {
                Ok(()) => Ok(()),
                Err(e) if e.code().0 as u32 == HR_FILE_NOT_FOUND => Ok(()),
                Err(e) => Err(format!("DeleteTask: {e}")),
            }
        }
    }

    pub fn query_registered_path() -> Result<Option<String>, String> {
        let _guard = ComGuard::init()?;
        let service = create_local_service().map_err(|e| format!("create service: {e}"))?;
        let root = connect_root_folder(&service)?;
        unsafe {
            match root.GetTask(&BSTR::from(TASK_NAME)) {
                Ok(task) => {
                    let xml: BSTR = task
                        .Xml()
                        .map_err(|e| format!("IRegisteredTask::Xml: {e}"))?;
                    Ok(extract_command_from_xml(&xml.to_string()))
                }
                Err(e) if e.code().0 as u32 == HR_FILE_NOT_FOUND => Ok(None),
                Err(e) => Err(format!("GetTask: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_command_from_simple_xml() {
        let xml =
            r#"<Task><Actions><Exec><Command>C:\Sidearm.exe</Command></Exec></Actions></Task>"#;
        assert_eq!(
            extract_command_from_xml(xml).as_deref(),
            Some("C:\\Sidearm.exe")
        );
    }

    #[test]
    fn extracts_command_with_spaces_path() {
        let xml = r#"<Exec><Command>C:\Program Files\Sidearm\Sidearm.exe</Command></Exec>"#;
        assert_eq!(
            extract_command_from_xml(xml).as_deref(),
            Some(r#"C:\Program Files\Sidearm\Sidearm.exe"#)
        );
    }

    #[test]
    fn strips_surrounding_quotes_from_legacy_schtasks_path() {
        // Tasks registered by pre-v0.1.11 via schtasks /tr "\"...\"" store
        // the quoted path inside <Command>.  We must compare against the
        // unquoted current exe path, so trim the wrapping quotes.
        let xml = r#"<Exec><Command>"E:\Scripts\Sidearm-Portable\Sidearm.exe"</Command></Exec>"#;
        assert_eq!(
            extract_command_from_xml(xml).as_deref(),
            Some(r#"E:\Scripts\Sidearm-Portable\Sidearm.exe"#)
        );
    }

    #[test]
    fn returns_none_when_no_command_tag() {
        let xml = "<Task></Task>";
        assert!(extract_command_from_xml(xml).is_none());
    }

    #[test]
    fn xml_escape_handles_special_chars() {
        let s = r#"a & b < c > d " e ' f"#;
        let escaped = xml_escape(s);
        assert_eq!(escaped, "a &amp; b &lt; c &gt; d &quot; e &apos; f");
    }

    #[test]
    fn task_xml_contains_run_level_highest() {
        let xml = task_definition_xml(r"C:\Sidearm.exe");
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains(r"C:\Sidearm.exe"));
    }

    #[test]
    fn task_xml_escapes_ampersands_in_paths() {
        let xml = task_definition_xml(r"C:\path & with & amps\Sidearm.exe");
        assert!(xml.contains("path &amp; with &amp; amps"));
        let cmd_start = xml.find("<Command>").unwrap() + "<Command>".len();
        let cmd_end = xml.find("</Command>").unwrap();
        let cmd = &xml[cmd_start..cmd_end];
        assert!(!cmd.contains(" & "));
    }
}
