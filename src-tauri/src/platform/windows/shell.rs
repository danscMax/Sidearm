//! Platform-specific shell utilities (Windows).
//!
//! Provides exe path resolution via the Windows Registry and process
//! enumeration, plus opening paths in Explorer.

use std::path::Path;

use windows_sys::Win32::{
    Foundation::CloseHandle,
    Storage::FileSystem::SearchPathW,
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
            KEY_QUERY_VALUE, REG_EXPAND_SZ, REG_SZ,
        },
        Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

/// Look up the exe path in the Windows App Paths registry.
///
/// Most installed applications register their full path under:
///   `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>`
pub(crate) fn lookup_app_paths_registry(exe_name: &str) -> Option<String> {
    let subkey = format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe_name}"
    );
    let wide_subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();

    for &hive in &[HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let mut hkey = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(hive, wide_subkey.as_ptr(), 0, KEY_QUERY_VALUE, &mut hkey)
        };
        if status != 0 || hkey.is_null() {
            continue;
        }

        let mut buf = vec![0u16; 1024];
        let mut buf_size = (buf.len() * 2) as u32;
        let mut value_type: u32 = 0;
        let result = unsafe {
            RegQueryValueExW(
                hkey,
                [0u16].as_ptr(),
                std::ptr::null(),
                &mut value_type,
                buf.as_mut_ptr().cast(),
                &mut buf_size,
            )
        };
        unsafe { RegCloseKey(hkey) };

        if result != 0 || (value_type != REG_SZ && value_type != REG_EXPAND_SZ) {
            continue;
        }

        let len = (buf_size as usize) / 2;
        let s = String::from_utf16_lossy(&buf[..len]);
        let trimmed = s.trim_end_matches('\0').trim_matches('"').to_owned();

        if !trimmed.is_empty() && Path::new(&trimmed).exists() {
            return Some(trimmed);
        }
    }
    None
}

/// Use Win32 `SearchPathW` to find an executable.
///
/// Searches in the same order as `CreateProcess`:
/// application directory, current directory, System32, System, Windows, PATH.
pub(crate) fn search_path_win32(exe_name: &str) -> Option<String> {
    let wide_name: Vec<u16> = exe_name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 512];
    let mut file_part = std::ptr::null_mut();

    let len = unsafe {
        SearchPathW(
            std::ptr::null(),
            wide_name.as_ptr(),
            std::ptr::null(),
            buf.len() as u32,
            buf.as_mut_ptr(),
            &mut file_part,
        )
    };

    if len == 0 || len as usize >= buf.len() {
        return None;
    }

    let path = String::from_utf16_lossy(&buf[..len as usize]);
    if Path::new(&path).exists() {
        Some(path)
    } else {
        None
    }
}

/// Find the full path of a running process by exe name.
///
/// Uses `CreateToolhelp32Snapshot` + `QueryFullProcessImageNameW`.
pub(crate) fn find_running_process_path(exe_name: &str) -> Option<String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() {
            return None;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) == 0 {
            CloseHandle(snapshot);
            return None;
        }

        let target = exe_name.to_ascii_lowercase();
        loop {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name =
                String::from_utf16_lossy(&entry.szExeFile[..name_len]).to_ascii_lowercase();

            if name == target {
                let process =
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !process.is_null() {
                    let mut path_buf = vec![0u16; 512];
                    let mut path_len = path_buf.len() as u32;
                    let ok = QueryFullProcessImageNameW(
                        process,
                        0,
                        path_buf.as_mut_ptr(),
                        &mut path_len,
                    );
                    CloseHandle(process);
                    if ok != 0 {
                        let path = String::from_utf16_lossy(&path_buf[..path_len as usize]);
                        CloseHandle(snapshot);
                        return Some(path);
                    }
                }
            }

            if Process32NextW(snapshot, &mut entry) == 0 {
                break;
            }
        }

        CloseHandle(snapshot);
        None
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunningProcess {
    pub exe: String,
    pub path: String,
    pub pid: u32,
}

/// Enumerate all running processes. Best-effort: entries whose full path
/// cannot be queried (permission denied, system processes) still return
/// with an empty `path`.
pub(crate) fn list_running_processes() -> Vec<RunningProcess> {
    let mut out: Vec<RunningProcess> = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() {
            return out;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) == 0 {
            CloseHandle(snapshot);
            return out;
        }

        loop {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..name_len]);

            let mut full_path = String::new();
            let process =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
            if !process.is_null() {
                let mut path_buf = vec![0u16; 512];
                let mut path_len = path_buf.len() as u32;
                let ok = QueryFullProcessImageNameW(
                    process,
                    0,
                    path_buf.as_mut_ptr(),
                    &mut path_len,
                );
                if ok != 0 {
                    full_path = String::from_utf16_lossy(&path_buf[..path_len as usize]);
                }
                CloseHandle(process);
            }

            out.push(RunningProcess {
                exe,
                path: full_path,
                pid: entry.th32ProcessID,
            });

            if Process32NextW(snapshot, &mut entry) == 0 {
                break;
            }
        }

        CloseHandle(snapshot);
    }
    out
}

/// Open a path in Windows Explorer.
pub(crate) fn open_in_explorer(path: &Path) -> Result<(), String> {
    std::process::Command::new(format!(
        "{}\\explorer.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())
    ))
    .arg(path.as_os_str())
    .spawn()
    .map_err(|error| format!("Failed to open path in Explorer: {error}"))?;
    Ok(())
}
