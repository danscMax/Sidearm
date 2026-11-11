//! The processes around a Sidearm that ended: the hook-free restore process —
//! started as a watchdog with every Sidearm, by a dead Sidearm's capture
//! helper, or by an exit with a sleeping mouse — and the named mutexes that
//! keep it and a running Sidearm off one receiver at a time.

use std::path::Path;

/// Argument of the one-shot process that restores the live maps a dead
/// Sidearm left (`Sidearm.exe --restore-live-maps <config dir>`).
pub const RESTORE_LIVE_MAPS_ARG: &str = "--restore-live-maps";
/// Added when Sidearm died: it stored no offline profile, so the restore
/// process stores it like an exit would.
pub const AFTER_CRASH_ARG: &str = "--after-crash";
/// `--watch <pid>`: the restore process first waits for that Sidearm to end,
/// and restores only when it ended without its exit (killed, crashed).
const WATCH_ARG: &str = "--watch";
/// `--spawn-watchdog <config dir> --watch <pid>`: starts the watchdog and ends.
const SPAWN_WATCHDOG_ARG: &str = "--spawn-watchdog";
/// `--spawn-restore <config dir>`: starts a restore process and ends (the
/// `RunOnce` entry at logon).
const SPAWN_RESTORE_ARG: &str = "--spawn-restore";
/// Left by a Sidearm whose exit ran to the end (its pid): its watchdog has
/// nothing to do.
const CLEAN_EXIT_FILE: &str = "sidearm-clean-exit";

/// Held by every running Sidearm app for its whole life; Windows drops it
/// with the process, so its absence means no Sidearm runs.
const APP_MUTEX: &str = "Local\\Sidearm-app";
/// Passed to the elevated Sidearm a relaunch starts (`relaunch_as_admin`).
pub const RELAUNCHED_ARG: &str = "--relaunched";
/// Held by the live-map restore process: a Sidearm starting meanwhile leaves
/// the mice alone until it ends (two processes must not talk to one receiver).
const RESTORE_MUTEX: &str = "Local\\Sidearm-live-map-restore";

/// Creates a named mutex every process of this user can open, an elevated
/// Sidearm's included (a default DACL would hide it from a non-elevated one);
/// `None` when it exists already or cannot be created.
/// A test run against virtual mice keeps its own mutexes, so it runs beside
/// the user's Sidearm without either seeing the other.
fn scoped(name: &str) -> String {
    match std::env::var("SIDEARM_FAKE_MICE") {
        Ok(dir) if crate::fake_mode() => {
            let hash = dir.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3));
            format!("{name}-test-{hash:016x}")
        }
        _ => name.to_owned(),
    }
}

fn create_mutex(name: &str) -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, LocalFree},
        Security::{Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES},
        System::Threading::CreateMutexW,
    };
    let name: Vec<u16> = scoped(name).encode_utf16().chain(Some(0)).collect();
    // Full access for authenticated users: openable at any elevation.
    let sddl: Vec<u16> = "D:(A;;GA;;;AU)".encode_utf16().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: NUL-terminated strings; CreateMutexW copies the descriptor, which
    // is freed right after; the handle is kept until the process ends.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) == 0 {
            log::warn!("[system] mutex {} not created: security descriptor error {}", String::from_utf16_lossy(&name[..name.len() - 1]), GetLastError());
            return None;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = CreateMutexW(&attributes, 0, name.as_ptr());
        let existed = GetLastError() == ERROR_ALREADY_EXISTS;
        LocalFree(descriptor);
        if handle.is_null() {
            return None;
        }
        if existed {
            CloseHandle(handle);
            return None;
        }
        Some(handle)
    }
}

/// Whether a named mutex exists: one that refuses access exists too (an older
/// or foreign DACL), so the check never fails open.
fn mutex_exists(name: &str) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError};
    let name: Vec<u16> = scoped(name).encode_utf16().chain(Some(0)).collect();
    // SAFETY: a NUL-terminated name; the handle is closed at once.
    unsafe {
        let handle = windows_sys::Win32::System::Threading::OpenMutexW(windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE, 0, name.as_ptr());
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        CloseHandle(handle);
        true
    }
}

/// Whether a restore process still owns the mice (live sessions wait for it).
pub fn live_map_restore_running() -> bool {
    mutex_exists(RESTORE_MUTEX)
}

/// Starts this exe with `args`, detached, windowless and without Sidearm's
/// standard handles. It also leaves a job Sidearm runs in when the job allows
/// that (a job's end would take it along), else stays in it.
fn spawn_detached(args: &[&std::ffi::OsStr]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let spawn = |flags: u32| {
        std::process::Command::new(std::env::current_exe()?)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(flags)
            .spawn()
            .map(|_| ())
    };
    spawn(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| spawn(CREATE_NO_WINDOW | DETACHED_PROCESS))
}

/// Started by the capture helper when Sidearm died, and by an exit that left
/// a sleeping mouse without its offline profile: a separate process with no
/// hooks that outlives Sidearm.
pub fn spawn_live_map_restore(config_dir: &Path, after_crash: bool) {
    let mut args = vec![RESTORE_LIVE_MAPS_ARG.as_ref(), config_dir.as_os_str()];
    if after_crash {
        args.push(AFTER_CRASH_ARG.as_ref());
    }
    if let Err(error) = spawn_detached(&args) {
        log::warn!("[capture-helper] live-map restore process not started: {error}");
    }
}

/// Starts this Sidearm's watchdog: a restore process that waits for it to end
/// and restores the mice when it ended without its exit. "End task" in Task
/// Manager takes Sidearm and its capture helper together, so the helper cannot
/// be the one to notice. It goes through a process that ends at once
/// (`--spawn-watchdog`): with its parent gone, the watchdog is no part of
/// Sidearm's process tree and survives that.
pub fn spawn_watchdog(config_dir: &Path) {
    // A mark an earlier Sidearm left (its watchdog gone) must not pass for this one's.
    let _ = std::fs::remove_file(config_dir.join(CLEAN_EXIT_FILE));
    let pid = std::process::id().to_string();
    if let Err(error) = spawn_detached(&[SPAWN_WATCHDOG_ARG.as_ref(), config_dir.as_os_str(), WATCH_ARG.as_ref(), pid.as_ref()]) {
        log::warn!("[system] mouse watchdog not started: {error}");
    }
}

/// The end of a clean exit: this Sidearm's watchdog has nothing to do.
pub fn mark_clean_exit(config_dir: &Path) {
    crate::mouse_offline::write_marker(&config_dir.join(CLEAN_EXIT_FILE), &std::process::id().to_string());
}

/// The restore processes' entry (`main.rs`, before Tauri starts). Returns
/// whether `args` were for one of them.
pub fn restore_entry(args: &[String]) -> bool {
    let value = |name: &str| args.iter().position(|arg| arg == name).and_then(|index| args.get(index + 1));
    // The logon entry: start the restore detached and end, so a restore
    // that waits for a sleeping mouse never holds up the logon.
    if let Some(dir) = value(SPAWN_RESTORE_ARG) {
        let _ = spawn_detached(&[RESTORE_LIVE_MAPS_ARG.as_ref(), dir.as_ref()]);
        return true;
    }
    if let Some(dir) = value(SPAWN_WATCHDOG_ARG) {
        if let Some(pid) = value(WATCH_ARG) {
            let _ = spawn_detached(&[RESTORE_LIVE_MAPS_ARG.as_ref(), dir.as_ref(), WATCH_ARG.as_ref(), pid.as_ref()]);
        }
        return true;
    }
    let Some(dir) = value(RESTORE_LIVE_MAPS_ARG) else { return false };
    let watch = value(WATCH_ARG).and_then(|pid| pid.parse().ok());
    restore_live_maps_main(Path::new(dir), args.iter().any(|arg| arg == AFTER_CRASH_ARG), watch);
    true
}

/// Whether Sidearm `pid` left the clean-exit mark (taken here: it is read once).
fn exited_cleanly(config_dir: &Path, pid: u32) -> bool {
    let mark = config_dir.join(CLEAN_EXIT_FILE);
    let clean = std::fs::read_to_string(&mark).is_ok_and(|text| text.trim() == pid.to_string());
    if clean {
        let _ = std::fs::remove_file(&mark);
    }
    clean
}

/// Blocks until process `pid` has ended (at once when it is gone already).
fn wait_for_exit(pid: u32) {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
    // SAFETY: the handle is checked and closed. A failed open is a process
    // already gone; any other reason is logged, and the restore's own check
    // (`APP_MUTEX`) then finds a live Sidearm and leaves the mice alone.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            log::info!("[restore] Sidearm {pid} not opened (error {}): taken as ended", GetLastError());
            return;
        }
        WaitForSingleObject(handle, INFINITE);
        CloseHandle(handle);
    }
}

/// Restores the live maps a dead Sidearm left and stores an offline profile an
/// exit could not, retrying while a mouse sleeps (an asleep mouse answers
/// nothing and plays Sidearm's silent signals once it wakes).
/// Quits when Sidearm turns out alive, after 30 minutes, or once a Sidearm
/// starts — its own start restores them after this process ends.
pub fn restore_live_maps_main(config_dir: &Path, after_crash: bool, watch: Option<u32>) {
    use std::time::{Duration, Instant};
    // No Tauri log plugin here: its own file next to Sidearm's logs.
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::paths::AppPaths::resolve().log_dir.join("restore.log"))
    {
        let _ = env_logger::Builder::new()
            .filter_level(log::LevelFilter::Info)
            .target(env_logger::Target::Pipe(Box::new(file)))
            .try_init();
    }
    let mut after_crash = after_crash;
    if let Some(pid) = watch {
        wait_for_exit(pid);
        if exited_cleanly(config_dir, pid) {
            return;
        }
        log::warn!("[restore] Sidearm {pid} ended without its exit (killed or crashed): restoring the mice");
        after_crash = true;
    }
    log::info!("[restore] started for {} (after a crash: {after_crash})", config_dir.display());
    // The dying Sidearm's mutex goes when its process has fully ended. Checked
    // before taking the restore mutex: a live Sidearm is never paused by it.
    let grace = Instant::now() + Duration::from_secs(15);
    while mutex_exists(APP_MUTEX) {
        if Instant::now() >= grace {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // One restorer at a time, holding the mutex until it exits.
    let Some(_restoring) = create_mutex(RESTORE_MUTEX) else { return };
    let failed_marker = config_dir.join(crate::mouse_offline::OFFLINE_FAILED_FILE);
    // The signal kind the dead Sidearm used: the inert records match it.
    crate::mouse_memory::set_consumer_signals(!config_dir.join(crate::mouse_memory::KEY_SIGNALS_FILE).exists());
    // A dead Sidearm stored no offline profile, so the mice keep its signals
    // (the V2's thumbs fall silent): store it like its exit would have.
    if after_crash
        && !failed_marker.exists()
        && let Ok(config) = crate::config::read_and_migrate_config_file(&config_dir.join("config.json"))
    {
        crate::mouse_offline::write_marker(&failed_marker, &crate::mouse_offline::offline_profile_id(&config, None));
    }
    // A mouse that sleeps longer than any wait must not stay silent: retry
    // until it answers (every 2 s at first, then every minute), and come back
    // at the next logon if Windows ends first.
    let started = Instant::now();
    let mut next_logon = None;
    'retry: while !mutex_exists(APP_MUTEX) {
        let maps_done = crate::mouse_memory::live_overlay::restore_orphaned(config_dir);
        // A mouse asleep at exit has no offline profile yet: store it once it
        // answers (the marker names the profile; a success removes it).
        if failed_marker.exists()
            && let Ok(config) = crate::config::read_and_migrate_config_file(&config_dir.join("config.json"))
        {
            crate::mouse_offline::retry_offline_profile(&config, config_dir);
        }
        if maps_done && !failed_marker.exists() {
            break;
        }
        if next_logon.is_none() {
            next_logon = Some(set_run_once(config_dir, true));
        }
        // A starting Sidearm is noticed within 2 s either way (it waits for
        // this process to let go of the mice).
        let pause = if started.elapsed() < Duration::from_secs(30 * 60) { 1 } else { 30 };
        for _ in 0..pause {
            std::thread::sleep(Duration::from_secs(2));
            if mutex_exists(APP_MUTEX) {
                break 'retry;
            }
        }
    }
    // Done, or a Sidearm started (it restores the mice itself).
    if next_logon == Some(true) {
        set_run_once(config_dir, false);
    }
}

/// `RunOnce` value that starts the restore process at the next logon while a
/// mouse still waits for its restore.
const RUN_ONCE_VALUE: &str = "SidearmRestoreMice";

/// Adds (`on`) or removes this restore at the next logon. Returns whether it
/// is registered now.
fn set_run_once(config_dir: &Path, on: bool) -> bool {
    if crate::fake_mode() {
        return false;
    }
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegDeleteKeyValueW, RegSetKeyValueW};
    let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\RunOnce");
    let value = wide(RUN_ONCE_VALUE);
    if !on {
        // SAFETY: both strings are NUL-terminated and outlive the call.
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr()) };
        return false;
    }
    let Ok(exe) = std::env::current_exe() else { return false };
    let command = wide(&format!("\"{}\" {SPAWN_RESTORE_ARG} \"{}\"", exe.display(), config_dir.display()));
    // SAFETY: as above; the data is a NUL-terminated UTF-16 string of the
    // byte length passed.
    let status = unsafe {
        RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), REG_SZ, command.as_ptr().cast(), (command.len() * 2) as u32)
    };
    if status != 0 {
        log::warn!("[restore] restore at the next logon not registered: error {status}");
    }
    status == 0
}

/// Marks this process as a running Sidearm for a restore process, held until
/// it ends. An elevated relaunch (`RELAUNCHED_ARG`) starts while the old
/// Sidearm still restores its mice on exit, and the single-instance lock would
/// turn it away: it waits up to 60 s for that one to end first.
pub fn claim_app() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    if std::env::args().any(|arg| arg == RELAUNCHED_ARG) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while mutex_exists(APP_MUTEX) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    create_mutex(APP_MUTEX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_sidearms_clean_exit_mark_counts() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!exited_cleanly(dir.path(), 4242), "no mark: killed");
        std::fs::write(dir.path().join(CLEAN_EXIT_FILE), "1111").unwrap();
        assert!(!exited_cleanly(dir.path(), 4242), "another Sidearm's mark");
        mark_clean_exit(dir.path());
        assert!(exited_cleanly(dir.path(), std::process::id()));
        assert!(!dir.path().join(CLEAN_EXIT_FILE).exists(), "the mark is taken");
    }

    #[test]
    fn a_named_mutex_is_single_and_goes_with_its_handle() {
        let name = format!(r"Local\Sidearm-test-{}", std::process::id());
        assert!(!mutex_exists(&name));
        let handle = create_mutex(&name).expect("first create");
        assert!(mutex_exists(&name));
        assert!(create_mutex(&name).is_none(), "a second holder is refused");
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        assert!(!mutex_exists(&name));
    }

    /// Writes and removes the real HKCU RunOnce value (run by hand:
    /// `cargo test -- --ignored run_once`).
    #[test]
    #[ignore]
    fn run_once_registers_a_detached_restore_and_is_removed() {
        let read = || {
            std::process::Command::new("reg")
                .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce", "/v", RUN_ONCE_VALUE])
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
                .unwrap_or_default()
        };
        let dir = Path::new(r"C:\Temp\sidearm test");
        assert!(set_run_once(dir, true));
        let value = read();
        assert!(value.contains(SPAWN_RESTORE_ARG) && value.contains(r#""C:\Temp\sidearm test""#), "{value}");
        set_run_once(dir, false);
        assert!(!read().contains(RUN_ONCE_VALUE));
    }
}
