//! Explicit, user-requested ownership transfer from Razer's application engine.
//! Never changes services/drivers or terminates an executable outside Razer's install tree.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::{
        Registry::{
            HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ, RegCloseKey,
            RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
        },
        Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        },
    },
};

pub static RECOVERY_LOCK: Mutex<()> = Mutex::new(());
const STARTUP_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_VALUE: &str = "RazerAppEngine";
const ENGINES: [&str; 2] = ["RazerAppEngine.exe", "RzEngineMon.exe"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub startup_restore_available: bool,
}

pub fn status(config_dir: &Path) -> Result<Status, String> {
    Ok(Status {
        running: engine_running()?,
        startup_restore_available: backup_path(config_dir)?.is_file(),
    })
}

fn processes() -> Result<Vec<crate::platform::shell::RunningProcess>, String> {
    let processes = crate::platform::shell::list_running_processes();
    if !processes.iter().any(|p| p.pid == std::process::id()) {
        return Err("Cannot read the process list; Synapse state is unknown".into());
    }
    Ok(processes)
}

pub fn engine_running() -> Result<bool, String> {
    Ok(processes()?.iter().any(|p| is_engine(&p.exe)))
}

fn is_engine(name: &str) -> bool {
    ENGINES.iter().any(|n| name.eq_ignore_ascii_case(n))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Exact structural allowlist, not a substring match (blocks lookalike folders/traversal).
fn trusted_engine_path(path: &Path) -> bool {
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .any(|var| {
            let Some(root) = std::env::var_os(var) else {
                return false;
            };
            let Ok(root) = Path::new(&root)
                .join(r"Razer\RazerAppEngine")
                .canonicalize()
            else {
                return false;
            };
            let Ok(relative) = path.strip_prefix(root) else {
                return false;
            };
            let parts: Vec<_> = relative
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            match parts.as_slice() {
                [exe] => exe.eq_ignore_ascii_case("RazerAppEngine.exe"),
                [version, exe] => {
                    version.starts_with("app-") && exe.eq_ignore_ascii_case("RazerAppEngine.exe")
                }
                [version, dlls, exe] => {
                    version.starts_with("app-")
                        && dlls.eq_ignore_ascii_case("CommonDLL")
                        && exe.eq_ignore_ascii_case("RzEngineMon.exe")
                }
                _ => false,
            }
        })
}

/// Query and terminate through the SAME process handle, avoiding recycled-PID races.
fn close_engine(pid: u32) -> Result<(), String> {
    unsafe {
        // SYNCHRONIZE (0x00100000) is needed to wait for completed termination.
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | 0x0010_0000,
            0,
            pid,
        );
        if handle.is_null() {
            // An exited process is harmless; an inaccessible live one is not success.
            if processes()?.iter().any(|p| p.pid == pid) {
                return Err(format!(
                    "Cannot open Razer process {pid}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            return Ok(());
        }
        let result = (|| {
            let mut exit_code = 0;
            if GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code != 259 {
                return Ok(());
            }
            let mut buf = vec![0u16; 32768];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) == 0 {
                return Err("Cannot verify Razer executable identity".into());
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            if !trusted_engine_path(Path::new(&path)) {
                return Err(
                    "Refusing to close an executable outside the Razer installation".into(),
                );
            }
            if TerminateProcess(handle, 0) == 0 {
                return Err(format!(
                    "Cannot close Razer process: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if WaitForSingleObject(handle, 3000) != 0 {
                return Err("Razer process did not exit within three seconds".into());
            }
            Ok(())
        })();
        CloseHandle(handle);
        result
    }
}

pub fn close_engines() -> Result<(), String> {
    let processes = processes()?;
    // A running installer/updater must finish before ownership can change.
    if processes.iter().any(|p| {
        ["RazerInstaller.exe", "RazerUpdater.exe"]
            .iter()
            .any(|n| p.exe.eq_ignore_ascii_case(n))
    }) {
        return Err("A Razer update is running. Wait until it finishes.".into());
    }
    // Validate the entire target set before touching any process.
    let engines: Vec<_> = processes.iter().filter(|p| is_engine(&p.exe)).collect();
    if engines
        .iter()
        .any(|p| !trusted_engine_path(Path::new(&p.path)))
    {
        return Err("Cannot verify the Razer application path. Close Synapse manually.".into());
    }
    for p in engines {
        close_engine(p.pid)?;
    }
    std::thread::sleep(Duration::from_millis(400));
    if engine_running()? {
        return Err("Razer restarted. Close Synapse before retrying.".into());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StartupEntry {
    kind: u32,
    data: Vec<u8>,
}

fn backup_path(config_dir: &Path) -> Result<PathBuf, String> {
    let machine = std::env::var("COMPUTERNAME").map_err(|_| "Cannot identify this computer")?;
    let user = std::env::var("USERNAME").map_err(|_| "Cannot identify this user")?;
    if machine.is_empty() || user.is_empty() {
        return Err("Cannot identify this computer/user".into());
    }
    // Portable data may be synced between PCs. Never offer another PC/user's
    // startup backup as this one's undo, and do not expose names in filenames.
    let binding = format!(
        "{:x}",
        Sha256::digest(format!("{machine}\0{user}").as_bytes())
    );
    Ok(config_dir.join(format!("synapse-startup-{binding}.json")))
}

fn read_backup(path: &Path) -> Result<StartupEntry, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 262144 {
        return Err("Startup backup is too large".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

struct RunKey(windows_sys::Win32::System::Registry::HKEY);
impl Drop for RunKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

fn open_run(write: bool) -> Result<RunKey, String> {
    let mut key = std::ptr::null_mut();
    let access = KEY_QUERY_VALUE | if write { KEY_SET_VALUE } else { 0 };
    let code = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            wide(STARTUP_KEY).as_ptr(),
            0,
            access,
            &mut key,
        )
    };
    if code != 0 {
        return Err(format!(
            "Cannot access startup entry (Windows error {code})"
        ));
    }
    Ok(RunKey(key))
}

fn read_entry(key: &RunKey) -> Result<Option<StartupEntry>, String> {
    let (mut kind, mut size) = (0, 0);
    let name = wide(STARTUP_VALUE);
    let code = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if code == 2 {
        return Ok(None);
    }
    if code != 0 || size > 65536 {
        return Err(format!("Cannot read startup entry (Windows error {code})"));
    }
    let mut data = vec![0; size as usize];
    let code = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            data.as_mut_ptr(),
            &mut size,
        )
    };
    if code != 0 {
        return Err(format!(
            "Startup entry changed while reading (Windows error {code})"
        ));
    }
    data.truncate(size as usize);
    Ok(Some(StartupEntry { kind, data }))
}

fn entry_command(entry: &StartupEntry) -> Result<String, String> {
    if ![REG_SZ, REG_EXPAND_SZ].contains(&entry.kind) || !entry.data.len().is_multiple_of(2) {
        return Err("Unsupported startup entry format".into());
    }
    let chars: Vec<_> = entry
        .data
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let command = String::from_utf16(&chars).map_err(|_| "Invalid startup entry text")?;
    let command = command.trim_end_matches('\0');
    if command.contains('\0') {
        return Err("Invalid startup entry text".into());
    }
    Ok(command.to_owned())
}

fn validate_entry(entry: &StartupEntry) -> Result<(), String> {
    let command = entry_command(entry)?;
    // Razer installs an absolute quoted executable. Do not guess how an unquoted
    // Program Files command or environment-expanded command will be interpreted.
    let exe = command
        .strip_prefix('"')
        .and_then(|s| s.split_once('"'))
        .map(|(exe, _)| exe)
        .ok_or("Unsupported startup command. Use Windows Startup apps instead.")?;
    if !Path::new(exe)
        .file_name()
        .is_some_and(|n| n.eq_ignore_ascii_case("RazerAppEngine.exe"))
        || !trusted_engine_path(Path::new(exe))
    {
        return Err("Startup entry does not point to the installed Razer engine".into());
    }
    Ok(())
}

/// Only the exact per-user RazerAppEngine Run entry is supported. Unknown,
/// machine-wide or task-based startup is left untouched and reported explicitly.
pub fn disable_startup(config_dir: &Path) -> Result<(), String> {
    let key = open_run(true)?;
    let backup = backup_path(config_dir)?;
    let Some(entry) = read_entry(&key)? else {
        if backup.is_file() {
            validate_entry(&read_backup(&backup)?)?;
            return Ok(());
        }
        return Err(
            "No supported per-user Razer startup entry found. Check Windows Startup apps.".into(),
        );
    };
    validate_entry(&entry)?;
    if backup.exists() {
        let saved = read_backup(&backup)?;
        if saved != entry {
            return Err("A different startup backup already exists. Restore it before changing startup again.".into());
        }
    } else {
        let mut temp = tempfile::NamedTempFile::new_in(config_dir).map_err(|e| e.to_string())?;
        temp.write_all(&serde_json::to_vec(&entry).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist_noclobber(&backup).map_err(|e| e.to_string())?;
    }
    // A concurrent vendor edit must not be deleted on the basis of an old read.
    if read_entry(&key)?.as_ref() != Some(&entry) {
        return Err("Startup entry changed. Nothing was disabled.".into());
    }
    let code = unsafe { RegDeleteValueW(key.0, wide(STARTUP_VALUE).as_ptr()) };
    if code != 0 {
        return Err(format!("Cannot disable startup (Windows error {code})"));
    }
    if read_entry(&key)?.is_some() {
        return Err("Razer recreated its startup entry".into());
    }
    Ok(())
}

pub fn restore_startup(config_dir: &Path) -> Result<(), String> {
    let backup = backup_path(config_dir)?;
    let entry = read_backup(&backup)?;
    validate_entry(&entry)?;
    let key = open_run(true)?;
    match read_entry(&key)? {
        Some(current) if current != entry => {
            return Err("Startup changed since the backup. Refusing to overwrite it.".into());
        }
        Some(_) => {}
        None => {
            let code = unsafe {
                RegSetValueExW(
                    key.0,
                    wide(STARTUP_VALUE).as_ptr(),
                    0,
                    entry.kind,
                    entry.data.as_ptr(),
                    entry.data.len() as u32,
                )
            };
            if code != 0 {
                return Err(format!("Cannot restore startup (Windows error {code})"));
            }
        }
    }
    if read_entry(&key)?.as_ref() != Some(&entry) {
        return Err("Startup restore could not be verified".into());
    }
    fs::remove_file(backup).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_parser_rejects_binary_odd_length_and_embedded_nul() {
        assert!(
            entry_command(&StartupEntry {
                kind: 3,
                data: vec![0, 0]
            })
            .is_err()
        );
        assert!(
            entry_command(&StartupEntry {
                kind: REG_SZ,
                data: vec![0]
            })
            .is_err()
        );
        assert!(
            entry_command(&StartupEntry {
                kind: REG_SZ,
                data: vec![65, 0, 0, 0, 66, 0]
            })
            .is_err()
        );
    }
    #[test]
    fn startup_parser_preserves_unicode_and_arguments() {
        let text = "\"C:\\Razer\\движок.exe\" --autoStart=1";
        let data = wide(text).iter().flat_map(|c| c.to_le_bytes()).collect();
        assert_eq!(
            entry_command(&StartupEntry { kind: REG_SZ, data }).unwrap(),
            text
        );
    }
    #[test]
    fn arbitrary_process_names_and_paths_are_not_targets() {
        assert!(!is_engine("RazerUpdater.exe"));
        assert!(!trusted_engine_path(Path::new(
            r"C:\Scripts\RazerAppEngine.exe"
        )));
    }
}
