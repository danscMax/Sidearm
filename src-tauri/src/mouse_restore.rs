//! The processes around a Sidearm that ended: the hook-free restore process a
//! dead Sidearm's capture helper (or an exit with a sleeping mouse) starts,
//! and the named mutexes that keep it and a running Sidearm off one receiver
//! at a time.

/// Argument of the one-shot process that restores the live maps a dead
/// Sidearm left (`Sidearm.exe --restore-live-maps <config dir>`).
pub const RESTORE_LIVE_MAPS_ARG: &str = "--restore-live-maps";
/// Added when Sidearm died: it stored no offline profile, so the restore
/// process stores it like an exit would.
pub const AFTER_CRASH_ARG: &str = "--after-crash";

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
fn create_mutex(name: &str) -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, LocalFree},
        Security::{Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES},
        System::Threading::CreateMutexW,
    };
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
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
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
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

/// Started by the capture helper when Sidearm died, and by an exit that left
/// a sleeping mouse without its offline profile: a separate process with no
/// hooks that outlives Sidearm.
pub fn spawn_live_map_restore(config_dir: &std::path::Path, after_crash: bool) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let started = std::env::current_exe().and_then(|exe| {
        std::process::Command::new(exe)
            .arg(RESTORE_LIVE_MAPS_ARG)
            .arg(config_dir)
            .args(after_crash.then_some(AFTER_CRASH_ARG))
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()
    });
    if let Err(error) = started {
        log::warn!("[capture-helper] live-map restore process not started: {error}");
    }
}

/// Restores the live maps a dead Sidearm left and stores an offline profile an
/// exit could not, retrying while a mouse sleeps (an asleep mouse answers
/// nothing and plays Sidearm's silent signals once it wakes).
/// Quits when Sidearm turns out alive, after 30 minutes, or once a Sidearm
/// starts — its own start restores them after this process ends.
pub fn restore_live_maps_main(config_dir: &std::path::Path, after_crash: bool) {
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
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    while !mutex_exists(APP_MUTEX) && Instant::now() < deadline {
        let maps_done = crate::mouse_memory::live_overlay::restore_orphaned(config_dir);
        // A mouse asleep at exit has no offline profile yet: store it once it
        // answers (the marker names the profile; a success removes it).
        if failed_marker.exists()
            && let Ok(config) = crate::config::read_and_migrate_config_file(&config_dir.join("config.json"))
        {
            crate::mouse_offline::retry_offline_profile(&config, config_dir);
        }
        if maps_done && !failed_marker.exists() {
            return;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
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
    fn a_named_mutex_is_single_and_goes_with_its_handle() {
        let name = format!(r"Local\Sidearm-test-{}", std::process::id());
        assert!(!mutex_exists(&name));
        let handle = create_mutex(&name).expect("first create");
        assert!(mutex_exists(&name));
        assert!(create_mutex(&name).is_none(), "a second holder is refused");
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        assert!(!mutex_exists(&name));
    }
}
