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
//! **Hash pin.** The task does not start Sidearm.exe directly. It runs the
//! system `powershell.exe` (System32, admin-only writable) with a verifier
//! script embedded in the task XML (only an admin can change the task). At
//! enable time we record the SHA-256 of the exe AND of every `*.dll` next to
//! it (DLLs beside the exe load with the process's rights; an empty DLL set is
//! part of the pin too). At logon the script requires the same file set and
//! hashes, keeps every pinned file open with `FileShare.Read` (nobody can
//! overwrite, rename or delete it) while it hashes and starts Sidearm, waits
//! for the new process to go input-idle, and only then releases the files.
//! Any mismatch exits 2 without starting anything. After an update the pin no
//! longer matches: `query` reports `needs_reconfirm` and the UI calls
//! `enable()` again (one UAC prompt) to re-pin.
//!
//! ponytail: known ceiling — a DLL that was NOT present at start, dropped into
//! a user-writable folder WHILE Sidearm runs elevated and loaded lazily later
//! (`LoadLibrary`), is not caught: the pin is checked only at start. Full
//! protection needs the exe in an admin-only folder (Program Files).
//!
//! Result: a single UAC prompt at toggle time, **zero** external processes
//! spawned by Sidearm, zero console flashes.

use std::path::Path;
use std::sync::LazyLock;

const TASK_NAME: &str = "SidearmAutostartAdmin";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminAutostartStatus {
    pub enabled: bool,
    pub registered_path: Option<String>,
    pub current_exe: String,
    pub path_mismatch: bool,
    pub supported: bool,
    /// The task exists but its pin no longer matches the files on disk (or it
    /// was created by a pre-pin version): the user must confirm once more.
    pub needs_reconfirm: bool,
}

/// What the registered task launches, as read back from its XML.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RegisteredTask {
    /// Created by this version: verifier script + pinned (file, SHA-256) list.
    Pinned {
        path: String,
        manifest: Vec<(String, String)>,
    },
    /// Created by an older version: starts the exe directly, no pin.
    Legacy { path: String },
}

impl RegisteredTask {
    fn path(&self) -> &str {
        match self {
            Self::Pinned { path, .. } | Self::Legacy { path } => path,
        }
    }
}

#[cfg(target_os = "windows")]
pub fn query() -> AdminAutostartStatus {
    let current_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let registered = win::query_registered_task().ok().flatten();
    let registered_path = registered.as_ref().map(|task| task.path().to_owned());
    let path_mismatch = match &registered_path {
        Some(p) => !paths_equal(Path::new(p), Path::new(&current_exe)),
        None => false,
    };
    let needs_reconfirm = match &registered {
        None => false,
        Some(RegisteredTask::Legacy { .. }) => true,
        Some(RegisteredTask::Pinned { path, manifest }) => {
            paths_equal(Path::new(path), Path::new(&current_exe))
                && current_pin_manifest(Path::new(&current_exe)).as_ref() != Ok(manifest)
        }
    };
    AdminAutostartStatus {
        enabled: registered.is_some(),
        registered_path,
        current_exe,
        path_mismatch,
        supported: true,
        needs_reconfirm,
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
        needs_reconfirm: false,
    }
}

#[cfg(target_os = "windows")]
pub fn enable() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_path = exe.to_string_lossy();
    // Task Scheduler expands %VAR% inside Arguments/WorkingDirectory and has
    // no escape for it, so such a path could not be pinned faithfully.
    if exe_path.contains('%') {
        return Err(format!(
            "Путь к Sidearm содержит символ `%` — автозапуск от администратора для него не поддерживается: {exe_path}"
        ));
    }
    let manifest = current_pin_manifest(&exe)?;
    let xml = task_definition_xml(&exe_path, &manifest);
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

/// Pin manifest for the exe at `exe` (its folder + file name).
#[cfg(target_os = "windows")]
fn current_pin_manifest(exe: &Path) -> Result<Vec<(String, String)>, String> {
    let dir = exe
        .parent()
        .ok_or_else(|| format!("exe has no parent folder: {}", exe.display()))?;
    let name = exe
        .file_name()
        .ok_or_else(|| format!("exe has no file name: {}", exe.display()))?;
    build_pin_manifest(dir, &name.to_string_lossy())
}

/// Sorted (file name, SHA-256 upper-case hex) for the exe plus every `*.dll`
/// (extension case-insensitive) directly in `dir`; subfolders are not walked.
fn build_pin_manifest(dir: &Path, exe_name: &str) -> Result<Vec<(String, String)>, String> {
    let mut names = vec![exe_name.to_owned()];
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("dll"))
        {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let hash = sha256_file_hex(&dir.join(&name))?;
            Ok((name, hash))
        })
        .collect()
}

/// Streaming SHA-256 of a file as upper-case hex (the form PowerShell's
/// `[BitConverter]::ToString(..).Replace('-','')` produces).
fn sha256_file_hex(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect())
}

/// Split a Windows exe path into (folder with trailing `\`, file name).
fn split_exe_path(exe_path: &str) -> (&str, &str) {
    match exe_path.rfind('\\') {
        Some(idx) => exe_path.split_at(idx + 1),
        None => ("", exe_path),
    }
}

/// PowerShell single-quoted literal (`'` doubled; `$`, backtick stay literal).
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// PowerShell 5.1 verifier embedded in the task. Must never contain `%`
/// (Task Scheduler expands `%VAR%`) or `"` (it sits inside `-Command "..."`).
/// The fixed prefix `$d='..';$e='..';$m=@{..};` is what `parse_registered_task`
/// reads back. `start=false` prints `MATCH` instead of starting (tests).
fn verifier_script(exe_path: &str, manifest: &[(String, String)], start: bool) -> String {
    let (dir, exe) = split_exe_path(exe_path);
    let pins = manifest
        .iter()
        .map(|(name, hash)| format!("{}='{hash}'", ps_quote(name)))
        .collect::<Vec<_>>()
        .join(";");
    let action = if start {
        // Wait until the loader has mapped the exe and its static DLLs before
        // the finally block releases the pinned files.
        format!(
            "$p=Start-Process -FilePath {} -WorkingDirectory $d -PassThru;try{{[void]$p.WaitForInputIdle(15000)}}catch{{}}",
            ps_quote(exe_path)
        )
    } else {
        "Write-Output MATCH".to_owned()
    };
    format!(
        "$d={};$e={};$m=@{{{pins}}};$hs=@();try{{\
         $n=@(Get-ChildItem -LiteralPath $d -File -Force|Where-Object Extension -eq '.dll'|ForEach-Object Name)+$e;\
         if(@(Compare-Object @($n|Sort-Object) @(@($m.Keys)|Sort-Object)).Count -ne 0){{exit 2}};\
         foreach($k in @($m.Keys)){{$s=[IO.File]::Open((Join-Path $d $k),'Open','Read','Read');$hs+=$s;\
         $h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s)).Replace('-','');\
         if($h -ne $m[$k]){{exit 2}}}};\
         {action}}}finally{{foreach($s in $hs){{$s.Dispose()}}}}",
        ps_quote(dir),
        ps_quote(exe),
    )
}

/// `powershell.exe` command line (after the program name) the task runs.
fn task_arguments(exe_path: &str, manifest: &[(String, String)], start: bool) -> String {
    format!(
        "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"{}\"",
        verifier_script(exe_path, manifest, start)
    )
}

/// Task XML definition.  Logon trigger + Exec action (system PowerShell
/// running the hash-pin verifier, which starts Sidearm) + RunLevel=HighestAvailable.
/// `DisallowStartIfOnBatteries=false` and `StopIfGoingOnBatteries=false` keep
/// the task active on laptops; default Task Scheduler settings would prevent
/// startup when not plugged in.
fn task_definition_xml(exe_path: &str, manifest: &[(String, String)]) -> String {
    let (dir, _) = split_exe_path(exe_path);
    let arguments = xml_escape(&task_arguments(exe_path, manifest, true));
    let working_dir = xml_escape(dir);
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
      <Command>%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe</Command>
      <Arguments>{arguments}</Arguments>
      <WorkingDirectory>{working_dir}</WorkingDirectory>
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

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    if let (Ok(ca), Ok(cb)) = (a.canonicalize(), b.canonicalize()) {
        return ca == cb;
    }
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// Raw (still XML-escaped) text of the first `<tag>…</tag>` element.
fn element_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{tag}>"))?;
    Some(&xml[start..start + end])
}

fn extract_command_from_xml(xml: &str) -> Option<String> {
    // schtasks-registered tasks (pre-v0.1.11) wrapped the path in quotes
    // inside the <Command> element to handle spaces; the COM API does not.
    // Strip surrounding quotes so path comparison works regardless of which
    // version registered the task.
    Some(element_text(xml, "Command")?.trim().trim_matches('"').to_string())
}

/// Read back what a registered task starts: a pinned verifier task (this
/// version) or a direct exe launch (older versions). An `<Arguments>` that is
/// not our verifier falls back to the `<Command>` path, so the UI shows a path
/// mismatch and offers to re-register.
fn parse_registered_task(xml: &str) -> Option<RegisteredTask> {
    static HEADER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"\$d='((?:[^']|'')*)';\$e='((?:[^']|'')*)';\$m=@\{((?:'(?:[^']|'')*'='[0-9A-F]{64}';?)*)\};",
        )
        .expect("static verifier header regex")
    });
    static PAIR: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"'((?:[^']|'')*)'='([0-9A-F]{64})'").expect("static pin pair regex")
    });
    let unquote = |s: &str| s.replace("''", "'");

    if let Some(arguments) = element_text(xml, "Arguments") {
        let script = xml_unescape(arguments);
        if let Some(caps) = HEADER.captures(&script) {
            let manifest = PAIR
                .captures_iter(&caps[3])
                .map(|pair| (unquote(&pair[1]), pair[2].to_owned()))
                .collect();
            return Some(RegisteredTask::Pinned {
                path: format!("{}{}", unquote(&caps[1]), unquote(&caps[2])),
                manifest,
            });
        }
    }
    extract_command_from_xml(xml).map(|path| RegisteredTask::Legacy { path })
}

#[cfg(target_os = "windows")]
mod win {
    use super::{RegisteredTask, TASK_NAME, parse_registered_task};
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

    pub fn query_registered_task() -> Result<Option<RegisteredTask>, String> {
        let _guard = ComGuard::init()?;
        let service = create_local_service().map_err(|e| format!("create service: {e}"))?;
        let root = connect_root_folder(&service)?;
        unsafe {
            match root.GetTask(&BSTR::from(TASK_NAME)) {
                Ok(task) => {
                    let xml: BSTR = task
                        .Xml()
                        .map_err(|e| format!("IRegisteredTask::Xml: {e}"))?;
                    Ok(parse_registered_task(&xml.to_string()))
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
        let xml = task_definition_xml(r"C:\Sidearm.exe", &test_manifest());
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains(r"C:\Sidearm.exe"));
    }

    #[test]
    fn task_xml_escapes_ampersands_in_paths() {
        let xml = task_definition_xml(r"C:\path & with & amps\Sidearm.exe", &test_manifest());
        assert!(xml.contains("path &amp; with &amp; amps"));
        let cmd_start = xml.find("<Command>").unwrap() + "<Command>".len();
        let cmd_end = xml.find("</Command>").unwrap();
        let cmd = &xml[cmd_start..cmd_end];
        assert!(!cmd.contains(" & "));
    }

    #[test]
    fn task_xml_has_no_raw_markup_for_hostile_path() {
        // Single call site so a signature change only touches this helper.
        fn build(path: &str) -> String {
            task_definition_xml(path, &test_manifest())
        }
        let xml = build(r"C:\a&b'c<d>e\Sidearm.exe");
        const ENTITIES: [&str; 5] = ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"];
        for (i, _) in xml.match_indices('&') {
            assert!(
                ENTITIES.iter().any(|e| xml[i..].starts_with(e)),
                "raw '&' at byte {i}: {}",
                &xml[i..(i + 10).min(xml.len())]
            );
        }
        assert_eq!(xml.matches("<Task ").count(), 1);
        assert_eq!(xml.matches("</Task>").count(), 1);
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains("<LogonTrigger>"));
    }

    fn test_manifest() -> Vec<(String, String)> {
        vec![("Sidearm.exe".into(), "A".repeat(64))]
    }

    #[test]
    fn sha256_file_hex_matches_known_vector() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("abc.txt");
        std::fs::write(&file, "abc").expect("write");
        assert_eq!(
            sha256_file_hex(&file).unwrap(),
            "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
        );
    }

    #[test]
    fn pin_manifest_covers_exe_and_sibling_dlls_only() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        std::fs::write(dir.join("Sidearm.exe"), "exe").unwrap();
        std::fs::write(dir.join("a.dll"), "a").unwrap();
        std::fs::write(dir.join("B.DLL"), "b").unwrap();
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("deep.dll"), "ignored").unwrap();

        let base = build_pin_manifest(dir, "Sidearm.exe").unwrap();
        let names: Vec<&str> = base.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["B.DLL", "Sidearm.exe", "a.dll"]);
        assert!(base.iter().all(|(_, h)| h.len() == 64));

        // A new DLL changes the manifest.
        std::fs::write(dir.join("c.dll"), "c").unwrap();
        let with_extra = build_pin_manifest(dir, "Sidearm.exe").unwrap();
        assert_ne!(base, with_extra);
        std::fs::remove_file(dir.join("c.dll")).unwrap();

        // A changed byte changes the hash.
        std::fs::write(dir.join("a.dll"), "A").unwrap();
        let changed = build_pin_manifest(dir, "Sidearm.exe").unwrap();
        assert_eq!(changed.len(), base.len());
        assert_ne!(base, changed);
    }

    #[test]
    fn pinned_task_round_trips_hostile_path() {
        let path = r"C:\a&b'c\Sidearm.exe";
        let manifest = vec![
            ("Sidearm.exe".to_string(), "0".repeat(64)),
            ("x'y.dll".to_string(), "F".repeat(64)),
        ];
        let xml = task_definition_xml(path, &manifest);
        assert_eq!(
            parse_registered_task(&xml),
            Some(RegisteredTask::Pinned {
                path: path.to_string(),
                manifest,
            })
        );
    }

    #[test]
    fn task_without_arguments_parses_as_legacy() {
        let xml =
            r#"<Task><Actions><Exec><Command>C:\Sidearm.exe</Command></Exec></Actions></Task>"#;
        assert_eq!(
            parse_registered_task(xml),
            Some(RegisteredTask::Legacy {
                path: r"C:\Sidearm.exe".into()
            })
        );
    }

    #[test]
    fn verifier_refuses_before_starting_and_releases_in_finally() {
        let script = verifier_script(r"C:\Sidearm\Sidearm.exe", &test_manifest(), true);
        let start = script.find("Start-Process").expect("starts the exe");
        let first_exit = script.find("exit 2").expect("has a refusal exit");
        assert!(first_exit < start, "refusal must come before Start-Process");
        let finally = script.find("finally{").expect("has finally");
        assert!(finally > start);
        assert!(script[finally..].contains("Dispose()"));
        assert!(!script.contains('"'));
    }

    #[test]
    fn task_arguments_have_no_percent_sign() {
        let xml = task_definition_xml(r"C:\Sidearm\Sidearm.exe", &test_manifest());
        let arguments = element_text(&xml, "Arguments").expect("has Arguments");
        assert!(!arguments.contains('%'));
        let working_dir = element_text(&xml, "WorkingDirectory").expect("has WorkingDirectory");
        assert_eq!(working_dir, r"C:\Sidearm\");
    }

    /// Runs the real verifier through Windows PowerShell 5.1 (the same
    /// `powershell.exe` the task uses) against a temp folder.
    #[cfg(target_os = "windows")]
    #[test]
    fn verifier_script_matches_and_rejects_in_powershell() {
        // The exact Arguments string the task passes (verbatim, no re-quoting).
        fn run(exe: &Path, manifest: &[(String, String)]) -> (Option<i32>, String) {
            use std::os::windows::process::CommandExt;
            let arguments = task_arguments(&exe.to_string_lossy(), manifest, false);
            let out = std::process::Command::new("powershell.exe")
                .raw_arg(arguments)
                .output()
                .expect("run powershell.exe");
            (
                out.status.code(),
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
            )
        }

        let tmp = tempfile::tempdir().expect("tempdir");
        // Quote, ampersand, `$` and spaces in the folder exercise the quoting.
        let dir = &tmp.path().join("a&b'c $x");
        std::fs::create_dir(dir).unwrap();
        let system_root = std::env::var("SystemRoot").expect("SystemRoot");
        let exe = dir.join("Sidearm.exe");
        std::fs::copy(format!(r"{system_root}\System32\whoami.exe"), &exe).unwrap();
        std::fs::write(dir.join("x.dll"), "fake dll").unwrap();
        let manifest = build_pin_manifest(dir, "Sidearm.exe").unwrap();

        assert_eq!(run(&exe, &manifest), (Some(0), "MATCH".to_string()));

        // A modified pinned DLL is refused.
        std::fs::write(dir.join("x.dll"), "fake dll!").unwrap();
        assert_eq!(run(&exe, &manifest).0, Some(2));
        std::fs::write(dir.join("x.dll"), "fake dll").unwrap();
        assert_eq!(run(&exe, &manifest).0, Some(0));

        // An extra DLL next to the exe is refused.
        std::fs::write(dir.join("y.dll"), "planted").unwrap();
        assert_eq!(run(&exe, &manifest).0, Some(2));
        std::fs::remove_file(dir.join("y.dll")).unwrap();

        // ...including a hidden one.
        let hidden = dir.join("z.dll");
        std::fs::write(&hidden, "planted").unwrap();
        let status = std::process::Command::new("attrib")
            .arg("+h")
            .arg(&hidden)
            .status()
            .expect("run attrib");
        assert!(status.success());
        assert_eq!(run(&exe, &manifest).0, Some(2));
    }
}
