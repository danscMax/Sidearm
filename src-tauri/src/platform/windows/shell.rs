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
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        Registry::{
            HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, REG_EXPAND_SZ, REG_SZ,
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
        },
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
    },
};

/// Expand `%VAR%` placeholders in a REG_EXPAND_SZ string using the process
/// environment. Unknown / unterminated placeholders are left verbatim. Kept
/// dependency-free (no `ExpandEnvironmentStringsW`) so it needs no extra
/// windows-sys feature and is unit-testable off-Windows.
fn expand_env_placeholders(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let var = &after[..end];
                match std::env::var(var) {
                    Ok(val) => out.push_str(&val),
                    Err(_) => {
                        out.push('%');
                        out.push_str(var);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                // No closing '%': keep the rest verbatim.
                out.push('%');
                out.push_str(after);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Look up the exe path in the Windows App Paths registry.
///
/// Most installed applications register their full path under:
///   `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>`
pub(crate) fn lookup_app_paths_registry(exe_name: &str) -> Option<String> {
    // Defense in depth: exe_name reaches here from a frontend-supplied string
    // (get_exe_icon command). Reject path separators / traversal so a crafted
    // value can't redirect RegOpenKeyExW to an arbitrary subkey outside App Paths.
    if exe_name.is_empty() || exe_name.contains(['\\', '/']) || exe_name.contains("..") {
        return None;
    }
    let subkey = format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe_name}");
    let wide_subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();

    for &hive in &[HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let mut hkey = std::ptr::null_mut();
        let status =
            unsafe { RegOpenKeyExW(hive, wide_subkey.as_ptr(), 0, KEY_QUERY_VALUE, &mut hkey) };
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
        let mut trimmed = s.trim_end_matches('\0').trim_matches('"').to_owned();

        // REG_EXPAND_SZ values may embed %VAR% placeholders (e.g. %ProgramFiles%\…).
        // Expand them before the existence check — the raw placeholder never exists,
        // so the entry would otherwise be silently dropped despite the type check
        // above deliberately accepting REG_EXPAND_SZ.
        if value_type == REG_EXPAND_SZ {
            trimmed = expand_env_placeholders(&trimmed);
        }

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

/// Extract the NUL-terminated exe file name from a `PROCESSENTRY32W`'s `szExeFile`.
fn exe_name_from_entry(sz_exe_file: &[u16]) -> String {
    let len = sz_exe_file
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(sz_exe_file.len());
    String::from_utf16_lossy(&sz_exe_file[..len])
}

/// Read a process's full image path by PID. `None` if the process can't be
/// opened (permission denied / already exited) or the image-name query fails.
fn query_process_path(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut path_buf = vec![0u16; 512];
        let mut path_len = path_buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, path_buf.as_mut_ptr(), &mut path_len);
        CloseHandle(process);
        if ok != 0 {
            Some(String::from_utf16_lossy(&path_buf[..path_len as usize]))
        } else {
            None
        }
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
            let name = exe_name_from_entry(&entry.szExeFile).to_ascii_lowercase();
            if name == target
                && let Some(path) = query_process_path(entry.th32ProcessID)
            {
                CloseHandle(snapshot);
                return Some(path);
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
            out.push(RunningProcess {
                exe: exe_name_from_entry(&entry.szExeFile),
                path: query_process_path(entry.th32ProcessID).unwrap_or_default(),
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

/// Open a URL, folder, or document with the system default handler
/// (`ShellExecuteW` with the "open" verb). Used by the launch action for
/// non-executable targets (URLs and directories). When Sidearm is elevated the
/// target is handed to Explorer under the shell's (non-admin) token instead.
pub(crate) fn open_target(target: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    if crate::platform::window::is_current_process_elevated() {
        let explorer = format!(
            "{}\\explorer.exe",
            std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())
        );
        return spawn_with_shell_token(Path::new(&explorer), &[target.to_string()], None)
            .map(|_| ());
    }

    let verb_w: Vec<u16> = "open\0".encode_utf16().collect();
    let target_w: Vec<u16> = std::ffi::OsStr::new(target)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // ShellExecuteW returns an HINSTANCE; values <= 32 indicate failure.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_w.as_ptr(),
            target_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if (result as isize) <= 32 {
        return Err(format!(
            "ShellExecuteW failed to open `{target}` (code {})",
            result as isize
        ));
    }
    Ok(())
}

/// Quote one argument so `CommandLineToArgvW` / the MSVC CRT parse it back
/// verbatim (the rules `std::process::Command` uses): backslashes are literal
/// except before a quote, where N of them become 2N+1 plus `\"`, and a run
/// before the closing quote is doubled.
fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '"']) {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        if c == '\\' {
            backslashes += 1;
            continue;
        }
        let n = if c == '"' { backslashes * 2 + 1 } else { backslashes };
        out.extend(std::iter::repeat_n('\\', n));
        out.push(c);
        backslashes = 0;
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// Start `target` with the token of the interactive shell (explorer), i.e.
/// with the user's normal, non-elevated rights, and return its PID. Used when
/// Sidearm itself runs elevated so launch actions don't inherit admin rights.
/// Fails closed: if the shell token can't be obtained, nothing is started.
pub(crate) fn spawn_with_shell_token(
    target: &Path,
    args: &[String],
    working_dir: Option<&Path>,
) -> Result<u32, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::{
        DuplicateTokenEx, SecurityImpersonation, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY, TokenPrimary,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessWithTokenW, OpenProcessToken, PROCESS_INFORMATION, STARTUPINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }
    // std's OwnedHandle closes the handle on drop (RAII for every exit path).
    fn owned(handle: HANDLE) -> OwnedHandle {
        unsafe { OwnedHandle::from_raw_handle(handle) }
    }
    fn os_error(what: &str) -> String {
        format!("{what}: {}", std::io::Error::last_os_error())
    }

    let shell = unsafe { GetShellWindow() };
    if shell.is_null() {
        return Err("Windows shell (explorer) is not running".into());
    }
    let mut shell_pid = 0u32;
    unsafe { GetWindowThreadProcessId(shell, &mut shell_pid) };
    if shell_pid == 0 {
        return Err(os_error("GetWindowThreadProcessId(shell)"));
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, shell_pid) };
    if process.is_null() {
        return Err(os_error("OpenProcess(shell)"));
    }
    let process = owned(process);

    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_DUPLICATE, &mut token) } == 0 {
        return Err(os_error("OpenProcessToken(shell)"));
    }
    let token = owned(token);

    let mut primary: HANDLE = std::ptr::null_mut();
    let duplicated = unsafe {
        DuplicateTokenEx(
            token.as_raw_handle(),
            TOKEN_QUERY
                | TOKEN_DUPLICATE
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID,
            std::ptr::null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
    };
    if duplicated == 0 {
        return Err(os_error("DuplicateTokenEx(shell)"));
    }
    let primary = owned(primary);

    let target_str = target.to_string_lossy();
    let mut command_line = std::iter::once(quote_windows_arg(&target_str))
        .chain(args.iter().map(|arg| quote_windows_arg(arg)))
        .collect::<Vec<_>>()
        .join(" ")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<u16>>();
    let application = wide(target.as_os_str());
    let current_dir = working_dir.map(|dir| wide(dir.as_os_str()));

    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessWithTokenW(
            primary.as_raw_handle(),
            0,
            application.as_ptr(),
            command_line.as_mut_ptr(),
            0,
            std::ptr::null(),
            current_dir
                .as_ref()
                .map_or(std::ptr::null(), |dir| dir.as_ptr()),
            &startup,
            &mut info,
        )
    };
    if created == 0 {
        return Err(os_error("CreateProcessWithTokenW"));
    }
    drop(owned(info.hThread));
    drop(owned(info.hProcess));
    Ok(info.dwProcessId)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_windows_arg_cases() {
        assert_eq!(quote_windows_arg("abc"), "abc");
        assert_eq!(quote_windows_arg("a b"), r#""a b""#);
        assert_eq!(quote_windows_arg(""), r#""""#);
        assert_eq!(quote_windows_arg(r#"a"b"#), r#""a\"b""#);
        assert_eq!(
            quote_windows_arg(r"C:\dir with space\"),
            r#""C:\dir with space\\""#
        );
        assert_eq!(quote_windows_arg(r"a\\b"), r"a\\b");
    }

    #[test]
    fn expand_env_placeholders_edges() {
        // No placeholders → unchanged.
        assert_eq!(
            expand_env_placeholders(r"C:\Program Files\App\app.exe"),
            r"C:\Program Files\App\app.exe"
        );
        // Unknown variable → kept verbatim (better than dropping the whole path).
        assert_eq!(
            expand_env_placeholders(r"%NO_SUCH_VAR_SIDEARM%\bin"),
            r"%NO_SUCH_VAR_SIDEARM%\bin"
        );
        // Unterminated '%' → kept verbatim.
        assert_eq!(expand_env_placeholders("100% done"), "100% done");
        // A real variable expands. SystemRoot is always set on Windows.
        let sysroot = std::env::var("SystemRoot").expect("SystemRoot set on Windows");
        assert_eq!(
            expand_env_placeholders(r"%SystemRoot%\explorer.exe"),
            format!(r"{sysroot}\explorer.exe")
        );
    }
}
