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
//!   - **Create / delete** need admin rights. An elevated Sidearm registers
//!     the task in-process. A non-elevated one starts its own exe elevated
//!     (`runas`, one UAC prompt) with `--admin-autostart enable|disable`
//!     ([`HELPER_ARG`], [`helper_main`]) and waits for its exit code. The
//!     `Elevation:Administrator!new:{CLSID}` COM moniker cannot be used: the
//!     Task Scheduler class is not registered for elevated activation
//!     (measured: `CO_E_ELEVATION_DISABLED`, 0x80080017, on every call).
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
//! Result: a single UAC prompt at toggle time and no console flashes (the
//! elevated helper is Sidearm's own GUI-subsystem exe).

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
    /// `outdated`: an older verifier script (e.g. one calling cmdlets) — re-register.
    Pinned {
        path: String,
        manifest: Vec<(String, String)>,
        outdated: bool,
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
        Some(RegisteredTask::Pinned { path, manifest, outdated }) => {
            paths_equal(Path::new(path), Path::new(&current_exe))
                && (*outdated || current_pin_manifest(Path::new(&current_exe)).as_ref() != Ok(manifest))
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

/// Command-line flag that turns Sidearm.exe into the elevated helper.
pub const HELPER_ARG: &str = "--admin-autostart";
/// Helper exit code for a failure that has no HRESULT (e.g. the `%` path).
const HELPER_EXIT_FAILED: i32 = 1;

#[cfg(target_os = "windows")]
pub fn enable() -> Result<(), String> {
    if !crate::window_capture::is_current_process_elevated() {
        return run_elevated_helper("enable");
    }
    enable_elevated()
}

#[cfg(target_os = "windows")]
pub fn disable() -> Result<(), String> {
    if !crate::window_capture::is_current_process_elevated() {
        return run_elevated_helper("disable");
    }
    win::delete_task(TASK_NAME)
}

#[cfg(target_os = "windows")]
fn enable_elevated() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_path = exe.to_string_lossy();
    // Task Scheduler expands %VAR% inside Arguments/WorkingDirectory and has
    // no escape for it, so such a path could not be pinned faithfully.
    if exe_path.contains('%') {
        return Err(format!(
            "The Sidearm path contains the `%` character — admin autostart does not support it: {exe_path}"
        ));
    }
    let manifest = current_pin_manifest(&exe)?;
    let xml = task_definition_xml(&exe_path, &manifest);
    win::register_task(TASK_NAME, &xml)
}

/// Entry point of the elevated helper (`Sidearm.exe --admin-autostart <action>`).
/// Returns the process exit code: `0` on success, the failing HRESULT when
/// there is one, [`HELPER_EXIT_FAILED`] otherwise. No file is written: an
/// elevated process writing to a path a non-elevated one chose could be
/// redirected by a planted link.
#[cfg(target_os = "windows")]
pub fn helper_main(action: Option<&str>) -> i32 {
    let result = match action {
        Some("enable") => enable_elevated(),
        Some("disable") => win::delete_task(TASK_NAME),
        _ => Err("unknown admin-autostart action".into()),
    };
    match result {
        Ok(()) => 0,
        Err(message) => win::hresult_in(&message).unwrap_or(HELPER_EXIT_FAILED),
    }
}

/// Runs this exe elevated as the helper and waits for it. One UAC prompt.
#[cfg(target_os = "windows")]
fn run_elevated_helper(action: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, INFINITE, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};

    const ERROR_CANCELLED: u32 = 1223;
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() };
    let file = wide(&exe.to_string_lossy());
    let verb = wide("runas");
    let params = wide(&format!("{HELPER_ARG} {action}"));

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = 0; // SW_HIDE — the helper has no window anyway
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let error = unsafe { GetLastError() };
        return Err(if error == ERROR_CANCELLED {
            "Elevation was cancelled in the UAC prompt.".into()
        } else {
            format!("ShellExecuteExW(runas): error {error}")
        });
    }
    if info.hProcess.is_null() {
        return Err("ShellExecuteExW(runas) returned no process handle".into());
    }
    let mut code: u32 = 0;
    unsafe {
        WaitForSingleObject(info.hProcess, INFINITE);
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
    }
    match code {
        0 => Ok(()),
        c if c as i32 == HELPER_EXIT_FAILED => Err(
            "Admin autostart is not set up (the elevated process failed).".into(),
        ),
        c => Err(format!("Admin autostart is not set up: 0x{c:08X}")),
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
    // .NET calls only, no cmdlet: a cmdlet loads its module from PSModulePath,
    // whose per-user folder comes first and is writable without admin rights —
    // a module planted there would run elevated before any pin is checked.
    let action = if start {
        // Wait until the loader has mapped the exe and its static DLLs before
        // the finally block releases the pinned files.
        format!(
            "$i=[Diagnostics.ProcessStartInfo]::new({});$i.WorkingDirectory=$d;$p=[Diagnostics.Process]::Start($i);try{{[void]$p.WaitForInputIdle(15000)}}catch{{}}",
            ps_quote(exe_path)
        )
    } else {
        "'MATCH'".to_owned()
    };
    format!(
        "$d={};$e={};$m=@{{{pins}}};$hs=@();try{{\
         $n=[Collections.Generic.List[string]]::new();$n.Add($e);\
         foreach($f in [IO.Directory]::GetFiles($d)){{if([IO.Path]::GetExtension($f) -eq '.dll'){{$n.Add([IO.Path]::GetFileName($f))}}}};\
         $a=$n.ToArray();$b=[string[]]@($m.Keys);[Array]::Sort($a,[StringComparer]::OrdinalIgnoreCase);[Array]::Sort($b,[StringComparer]::OrdinalIgnoreCase);\
         if([string]::Join('|',$a) -ne [string]::Join('|',$b)){{exit 2}};\
         foreach($k in $b){{$s=[IO.File]::Open([IO.Path]::Combine($d,$k),'Open','Read','Read');$hs+=$s;\
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
/// startup when not plugged in. Every element must exist in the declared
/// schema `version="1.2"`: Task Scheduler rejects the whole task otherwise
/// (measured: `UseUnifiedSchedulingEngine`, a 1.6 element, failed every
/// registration with 0x80041316 "unexpected node").
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
            let manifest: Vec<(String, String)> = PAIR
                .captures_iter(&caps[3])
                .map(|pair| (unquote(&pair[1]), pair[2].to_owned()))
                .collect();
            let path = format!("{}{}", unquote(&caps[1]), unquote(&caps[2]));
            let outdated = script != task_arguments(&path, &manifest, true);
            return Some(RegisteredTask::Pinned { path, manifest, outdated });
        }
    }
    extract_command_from_xml(xml).map(|path| RegisteredTask::Legacy { path })
}

#[cfg(target_os = "windows")]
mod win {
    use super::{RegisteredTask, TASK_NAME, parse_registered_task};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::System::TaskScheduler::{
        ITaskFolder, ITaskService, TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN,
        TaskScheduler,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::core::BSTR;

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

    /// The `0x…` HRESULT a `win` error message carries, if any — the elevated
    /// helper reports it as its exit code.
    pub fn hresult_in(message: &str) -> Option<i32> {
        let hex = message.split("0x").nth(1)?.get(..8)?;
        u32::from_str_radix(hex, 16).ok().map(|code| code as i32)
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

    /// Registers the task. The caller must be elevated (see `enable`).
    pub fn register_task(name: &str, xml: &str) -> Result<(), String> {
        let _guard = ComGuard::init()?;
        let service = create_local_service().map_err(|e| format!("create service: 0x{:08X}", e.code().0))?;
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
            .map_err(|e| format!("RegisterTask: 0x{:08X} {e}", e.code().0))?;
        }
        Ok(())
    }

    /// Deletes the task. The caller must be elevated (see `disable`).
    pub fn delete_task(name: &str) -> Result<(), String> {
        let _guard = ComGuard::init()?;
        let service = create_local_service().map_err(|e| format!("create service: 0x{:08X}", e.code().0))?;
        let root = connect_root_folder(&service)?;
        unsafe {
            match root.DeleteTask(&BSTR::from(name), 0) {
                Ok(()) => Ok(()),
                Err(e) if e.code().0 as u32 == HR_FILE_NOT_FOUND => Ok(()),
                Err(e) => Err(format!("DeleteTask: 0x{:08X} {e}", e.code().0)),
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

    /// Elements newer than the declared schema 1.2 make Task Scheduler reject
    /// the task (0x80041316) — these are the ones a copy-pasted task tends to carry.
    #[test]
    fn task_xml_stays_within_schema_1_2() {
        let xml = task_definition_xml(r"C:\Sidearm\Sidearm.exe", &[("Sidearm.exe".into(), "AB".into())]);
        assert!(xml.contains(r#"<Task version="1.2""#));
        for newer in ["UseUnifiedSchedulingEngine", "DisallowStartOnRemoteAppSession", "Volatile"] {
            assert!(!xml.contains(newer), "{newer} is not part of task schema 1.2");
        }
    }

    /// The elevated helper reports a failure as its exit code: the HRESULT in
    /// the error message, or none (→ the generic failure code).
    #[cfg(target_os = "windows")]
    #[test]
    fn helper_exit_code_carries_the_hresult() {
        assert_eq!(win::hresult_in("RegisterTask: 0x80070005 Access is denied"), Some(0x8007_0005_u32 as i32));
        assert_eq!(win::hresult_in("create service: 0x80080017"), Some(0x8008_0017_u32 as i32));
        assert_eq!(win::hresult_in("The Sidearm path contains the `%` character"), None);
    }

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
                manifest: manifest.clone(),
                outdated: false,
            })
        );
        // A task an older version registered (its verifier called cmdlets) asks for a re-confirm.
        let old = xml.replace("[IO.Directory]::GetFiles($d)", "Get-ChildItem -LiteralPath $d");
        assert!(matches!(parse_registered_task(&old), Some(RegisteredTask::Pinned { outdated: true, .. })));
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
        let start = script.find("[Diagnostics.Process]::Start(").expect("starts the exe");
        let first_exit = script.find("exit 2").expect("has a refusal exit");
        assert!(first_exit < start, "refusal must come before the start");
        // A cmdlet would load its module from the user-writable PSModulePath.
        for cmdlet in ["Get-", "Start-", "Join-", "Write-", "New-", "-Object", "Sort-", "Compare-"] {
            assert!(!script.contains(cmdlet), "the elevated verifier must not call a cmdlet ({cmdlet})");
        }
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
