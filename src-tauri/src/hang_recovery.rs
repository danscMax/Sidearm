//! A main thread frozen for good (`spawn_main_thread_watch`): the window, tray,
//! menus and every action that needs the main thread stay dead while the hooks
//! still take the buttons, so the mice do nothing at all. Seen 2026-11-19 on the
//! notebook: the main thread waited forever inside WebView2's window creation.
//! [`recover`] keeps a dump of the hang for its diagnosis, frees the modifiers,
//! starts a new Sidearm (it waits for this one to be gone, `claim_app`) and ends
//! this one; its mouse watchdog restores the mice as after a kill.

use std::path::{Path, PathBuf};

/// Hang dumps kept in the log folder (a few MB each); older ones are deleted.
const DUMPS_KEPT: usize = 3;
const DUMP_PREFIX: &str = "hang-";

/// Never returns unless a debugger holds the process (a breakpoint freezes the main thread too).
pub(crate) fn recover(log_dir: &Path) {
    if unsafe { windows_sys::Win32::System::Diagnostics::Debug::IsDebuggerPresent() } != 0 {
        log::warn!("[system] main thread frozen under a debugger: no restart");
        return;
    }
    match write_dump(log_dir) {
        Ok(path) => log::error!("[system] hang dump written: {}", path.display()),
        Err(error) => log::warn!("[system] hang dump not written: {error}"),
    }
    prune_dumps(log_dir);
    let _ = std::panic::catch_unwind(crate::input_synthesis::release_all_modifiers);
    match crate::mouse_restore::spawn_relaunch() {
        Ok(()) => log::error!("[system] restarting Sidearm: the main thread stays frozen"),
        // Ending anyway: the watchdog gives the mice their own buttons back, frozen they had none.
        Err(error) => log::error!("[system] the main thread stays frozen; no new Sidearm started ({error}), ending this one"),
    }
    log::logger().flush();
    std::process::exit(3);
}

/// A minidump of this process (every thread's stack and the memory it points to).
fn write_dump(log_dir: &Path) -> std::io::Result<PathBuf> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::{
        Diagnostics::Debug::{
            MiniDumpWithIndirectlyReferencedMemory, MiniDumpWithProcessThreadData, MiniDumpWithThreadInfo,
            MiniDumpWithUnloadedModules, MiniDumpWriteDump,
        },
        Threading::{GetCurrentProcess, GetCurrentProcessId},
    };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let pid = std::process::id();
    let path = log_dir.join(format!("{DUMP_PREFIX}{stamp}-{pid}.dmp"));
    let file = std::fs::File::create(&path)?;
    let kind = MiniDumpWithIndirectlyReferencedMemory | MiniDumpWithProcessThreadData | MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules;
    let ok = unsafe {
        MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            file.as_raw_handle(),
            kind,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        let error = std::io::Error::last_os_error();
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(path)
}

fn prune_dumps(log_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(log_dir) else { return };
    let mut dumps: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(DUMP_PREFIX) && name.ends_with(".dmp")
        })
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    dumps.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in dumps.into_iter().skip(DUMPS_KEPT) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_dump_and_keeps_only_the_newest() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..4 {
            std::fs::write(dir.path().join(format!("{DUMP_PREFIX}{index}.dmp")), b"x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        std::fs::write(dir.path().join("Sidearm.log"), b"log").unwrap();
        let dump = write_dump(dir.path()).unwrap();
        assert!(std::fs::metadata(&dump).unwrap().len() > 1024, "a real minidump");
        prune_dumps(dir.path());
        let mut left: Vec<String> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left.len(), DUMPS_KEPT + 1, "{left:?}");
        assert!(left.contains(&"Sidearm.log".to_owned()));
        assert!(left.iter().any(|name| dump.ends_with(name)));
        assert!(!left.contains(&format!("{DUMP_PREFIX}0.dmp")), "the oldest went: {left:?}");
    }
}
