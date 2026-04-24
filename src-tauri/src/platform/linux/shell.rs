//! Platform-specific shell utilities (Linux).
//!
//! Provides executable path resolution via filesystem search and process
//! enumeration via `/proc`, plus opening paths with `xdg-open`.

#![allow(unused_imports)]
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Look up an executable in well-known Linux binary directories.
///
/// Linux has no App Paths registry. Instead, we search common binary locations:
/// `/usr/bin`, `/usr/local/bin`, `~/.local/bin`, then fall back to `$PATH`.
pub(crate) fn lookup_app_paths_registry(exe_name: &str) -> Option<String> {
    let well_known_dirs = ["/usr/bin", "/usr/local/bin"];

    for dir in &well_known_dirs {
        let candidate = PathBuf::from(dir).join(exe_name);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }

    // Check ~/.local/bin
    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join(".local/bin").join(exe_name);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }

    // Fall back to PATH search
    search_path_env(exe_name)
}

/// Search the `$PATH` environment variable for an executable.
///
/// Equivalent to Windows `SearchPathW` -- iterates over each directory
/// in `$PATH` and checks if the target exe exists there.
pub(crate) fn search_path_win32(exe_name: &str) -> Option<String> {
    search_path_env(exe_name)
}

/// Internal helper: search `$PATH` for an executable.
fn search_path_env(exe_name: &str) -> Option<String> {
    let path_var = std::env::var("PATH").ok()?;
    for dir in path_var.split(':') {
        let candidate = PathBuf::from(dir).join(exe_name);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Find the full path of a running process by exe name.
///
/// Enumerates `/proc/*/comm` files, matches against `exe_name` (case-insensitive),
/// then resolves the matching process's `/proc/<pid>/exe` symlink.
pub(crate) fn find_running_process_path(exe_name: &str) -> Option<String> {
    let target = exe_name.to_ascii_lowercase();
    let proc_dir = Path::new("/proc");

    let entries = match std::fs::read_dir(proc_dir) {
        Ok(entries) => entries,
        Err(_) => return None,
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();

        // Only look at numeric directories (PIDs)
        if !name_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        let comm_path = entry.path().join("comm");
        let comm = match std::fs::read_to_string(&comm_path) {
            Ok(c) => c.trim().to_ascii_lowercase(),
            Err(_) => continue,
        };

        if comm == target {
            let exe_link = entry.path().join("exe");
            if let Ok(resolved) = std::fs::read_link(&exe_link) {
                return Some(resolved.to_string_lossy().into_owned());
            }
        }
    }

    None
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunningProcess {
    pub exe: String,
    pub path: String,
    pub pid: u32,
}

/// Enumerate all running processes by scanning `/proc/{pid}/comm` and
/// resolving `/proc/{pid}/exe` where possible.
pub(crate) fn list_running_processes() -> Vec<RunningProcess> {
    let mut out: Vec<RunningProcess> = Vec::new();
    let proc_dir = Path::new("/proc");
    let entries = match std::fs::read_dir(proc_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if !name_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = name_str.parse::<u32>() else { continue };
        let comm_path = entry.path().join("comm");
        let comm = std::fs::read_to_string(&comm_path)
            .ok()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if comm.is_empty() {
            continue;
        }
        let exe_link = entry.path().join("exe");
        let full_path = std::fs::read_link(&exe_link)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push(RunningProcess {
            exe: comm,
            path: full_path,
            pid,
        });
    }
    out
}

/// Open a path in the system file manager using `xdg-open`.
pub(crate) fn open_in_explorer(path: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path.as_os_str())
        .spawn()
        .map_err(|error| format!("Failed to open path with xdg-open: {error}"))?;
    Ok(())
}
