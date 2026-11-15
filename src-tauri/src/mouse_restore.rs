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
/// Created by a Sidearm when its exit begins and held until its process ends:
/// a Sidearm starting meanwhile waits for it to be gone (`claim_app`).
const EXITING_MUTEX: &str = "Local\\Sidearm-exiting";
/// How long a starting Sidearm waits for an exiting (or relaunching) one.
const PREDECESSOR_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Marks this Sidearm as exiting, for the rest of its life (`claim_app`).
pub fn mark_exiting() {
    // The handle is never closed: Windows drops the mutex with the process.
    let _ = create_mutex(EXITING_MUTEX);
}

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
    open_mutex(name, false)
}

/// [`create_mutex`], or with `keep_existing` also a handle to one that exists
/// already: holding it keeps the mutex alive for as long as this process runs.
fn open_mutex(name: &str, keep_existing: bool) -> Option<windows_sys::Win32::Foundation::HANDLE> {
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
        if existed && !keep_existing {
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
/// that (a job's end would take it along), else stays in it. Returns whether
/// it left (`false`: Sidearm's job, when it ends, ends the process too).
fn spawn_detached(args: &[&std::ffi::OsStr]) -> std::io::Result<bool> {
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
    spawn(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB)
        // A job that allows no breakaway (`cargo run`'s, the dev build's) is
        // closed with every process in it: the shell's child is in its job instead.
        // Not for an elevated Sidearm: a watchdog with the shell's token might
        // not open it to wait for its end (a medium-integrity process).
        .or_else(|error| if crate::window_capture::is_current_process_elevated() { Err(error) } else { spawn_under_shell(args, CREATE_NO_WINDOW | DETACHED_PROCESS) })
        .map(|()| true)
        .or_else(|error| {
            log::warn!("[system] restore process stays in Sidearm's job (its end takes it along): {error}");
            spawn(CREATE_NO_WINDOW | DETACHED_PROCESS).map(|()| false)
        })
}

/// [`spawn_detached`] as a child of the shell (Explorer): a process gets the job
/// of the parent it is created under (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`),
/// so it leaves Sidearm's job. Its token is the shell's too (not elevated:
/// the restore needs no rights); the environment is still this process's.
fn spawn_under_shell(args: &[&std::ffi::OsStr], flags: u32) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, InitializeProcThreadAttributeList,
            LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcess, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, PROCESS_CREATE_PROCESS,
            PROCESS_INFORMATION, STARTUPINFOEXW, UpdateProcThreadAttribute,
        },
        UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId},
    };
    let exe = std::env::current_exe()?;
    let mut line = quote_arg(exe.as_os_str());
    for arg in args {
        line.push(' ');
        line.push_str(&quote_arg(arg));
    }
    let mut line: Vec<u16> = std::ffi::OsStr::new(&line).encode_wide().chain(Some(0)).collect();
    // SAFETY: plain Win32 calls; the attribute list lives in `buffer` until
    // deleted, the shell handle and the new process's handles are closed.
    unsafe {
        let mut shell_pid = 0;
        GetWindowThreadProcessId(GetShellWindow(), &mut shell_pid);
        if shell_pid == 0 {
            return Err(std::io::Error::other("no shell window"));
        }
        let shell = OpenProcess(PROCESS_CREATE_PROCESS, 0, shell_pid);
        if shell.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut size = 0;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        let mut buffer = vec![0u8; size];
        let list = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        let result = (|| {
            if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let ok = UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                (&shell as *const windows_sys::Win32::Foundation::HANDLE).cast(), std::mem::size_of_val(&shell), std::ptr::null_mut(), std::ptr::null());
            let created = ok != 0 && {
                let mut startup: STARTUPINFOEXW = std::mem::zeroed();
                startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
                startup.lpAttributeList = list;
                let mut info: PROCESS_INFORMATION = std::mem::zeroed();
                let created = CreateProcessW(std::ptr::null(), line.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 0,
                    flags | EXTENDED_STARTUPINFO_PRESENT, std::ptr::null(), std::ptr::null(), &startup.StartupInfo, &mut info) != 0;
                if created {
                    CloseHandle(info.hThread);
                    CloseHandle(info.hProcess);
                }
                created
            };
            let error = std::io::Error::last_os_error();
            DeleteProcThreadAttributeList(list);
            if created { Ok(()) } else { Err(error) }
        })();
        CloseHandle(shell);
        result
    }
}

/// One command-line argument as `CommandLineToArgvW` reads it back.
fn quote_arg(arg: &std::ffi::OsStr) -> String {
    let arg = arg.to_string_lossy();
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.into_owned();
    }
    let mut out = String::from('"');
    let mut slashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        // Backslashes before a quote are doubled, and the quote escaped.
        out.push_str(&"\\".repeat(if ch == '"' { slashes * 2 + 1 } else { slashes }));
        slashes = 0;
        out.push(ch);
    }
    // Backslashes before the closing quote are doubled.
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
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
/// A watchdog that is missing, or stuck in Sidearm's job (an elevated Sidearm
/// in a job that forbids breakaway), is the `watchdogOff` state for this run.
pub fn spawn_watchdog(app: &tauri::AppHandle, config_dir: &Path) {
    use crate::mouse_status::{StatusKind, set_state};
    // A mark an earlier Sidearm left (its watchdog gone) must not pass for this one's.
    let _ = std::fs::remove_file(config_dir.join(CLEAN_EXIT_FILE));
    // Until the clean exit removes it: a power loss or a crash of Windows takes
    // the watchdog along, and the next logon restores the mice instead.
    set_run_once(config_dir, true);
    let pid = std::process::id();
    let (app, config_dir) = (app.clone(), config_dir.to_owned());
    // The broker it goes through ends at once and logs only a failed spawn: a
    // watchdog that never came up says so by its missing mutex. Checked off the setup.
    let _ = std::thread::Builder::new().name("watchdog-start".into()).spawn(move || {
        for attempt in 1..=2 {
            let pid_text = pid.to_string();
            let outside = match spawn_detached(&[SPAWN_WATCHDOG_ARG.as_ref(), config_dir.as_os_str(), WATCH_ARG.as_ref(), pid_text.as_ref()]) {
                Ok(outside) => outside,
                Err(error) => {
                    log::warn!("[system] mouse watchdog not started (attempt {attempt}): {error}");
                    continue;
                }
            };
            if wait_for_mutex(&watchdog_mutex(pid), std::time::Duration::from_secs(5)) {
                if outside {
                    log::info!("[system] mouse watchdog running");
                } else if job_kills_on_close() {
                    log::warn!("[system] mouse watchdog runs inside Sidearm's job: the job's end takes it along");
                    set_state(Some(&app), StatusKind::WatchdogOff, true);
                } else {
                    // A job that does not end its processes leaves the watchdog running.
                    log::info!("[system] mouse watchdog running (inside Sidearm's job, which does not end with it)");
                }
                return;
            }
            log::warn!("[system] mouse watchdog did not come up (attempt {attempt})");
        }
        log::error!("[system] no mouse watchdog: a killed Sidearm will not restore the mice by itself");
        set_state(Some(&app), StatusKind::WatchdogOff, true);
    });
}

/// Whether the job this process runs in ends every process in it when it
/// closes (`cargo run`'s does): only then does a watchdog left inside it die
/// with Sidearm. Unknown counts as yes.
fn job_kills_on_close() -> bool {
    use windows_sys::Win32::System::JobObjects::{
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        QueryInformationJobObject,
    };
    // SAFETY: a null job handle queries the caller's own job; the buffer is the
    // structure the information class names, zeroed.
    unsafe {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        let ok = QueryInformationJobObject(
            std::ptr::null_mut(),
            JobObjectExtendedLimitInformation,
            (&mut info as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            std::ptr::null_mut(),
        );
        ok == 0 || info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0
    }
}

/// Held by the watchdog of Sidearm `pid` while it waits for it.
fn watchdog_mutex(pid: u32) -> String {
    format!("Local\\Sidearm-watchdog-{pid}")
}

/// Whether mutex `name` appears within `limit`.
fn wait_for_mutex(name: &str, limit: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + limit;
    loop {
        if mutex_exists(name) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// The end of a clean exit: this Sidearm's watchdog has nothing to do.
pub fn mark_clean_exit(config_dir: &Path) {
    crate::mouse_offline::write_marker(&config_dir.join(CLEAN_EXIT_FILE), &std::process::id().to_string());
    // A restorer this exit started for a sleeping mouse registers its own.
    set_run_once(config_dir, false);
}

/// The restore processes' entry (`main.rs`, before Tauri starts). Returns
/// whether `args` were for one of them.
pub fn restore_entry(args: &[String]) -> bool {
    let value = |name: &str| args.iter().position(|arg| arg == name).and_then(|index| args.get(index + 1));
    // The logon entry: start the restore detached and end, so a restore
    // that waits for a sleeping mouse never holds up the logon.
    // The brokers stay fast: their log is opened only for a failure.
    let broker_failed = |what: &str, error: std::io::Error| {
        init_restore_log(false);
        log::error!("[restore] {what} not started: {error}");
    };
    if let Some(dir) = value(SPAWN_RESTORE_ARG) {
        // Windows removed the value to run this. A Sidearm that started first
        // (the logon task) had written it for itself: give it back.
        if mutex_exists(APP_MUTEX) {
            set_run_once(Path::new(dir), true);
        }
        // Registered by every running Sidearm and removed by its clean exit:
        // what is left at logon is a Sidearm that ended without it.
        if let Err(error) = spawn_detached(&[RESTORE_LIVE_MAPS_ARG.as_ref(), dir.as_ref(), AFTER_CRASH_ARG.as_ref()]) {
            broker_failed("restore process (logon entry)", error);
        }
        return true;
    }
    if let Some(dir) = value(SPAWN_WATCHDOG_ARG) {
        if let Some(pid) = value(WATCH_ARG)
            && let Err(error) = spawn_detached(&[RESTORE_LIVE_MAPS_ARG.as_ref(), dir.as_ref(), WATCH_ARG.as_ref(), pid.as_ref()])
        {
            broker_failed(&format!("watchdog of Sidearm {pid}"), error);
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

/// The restore processes' log, next to Sidearm's logs (no Tauri log plugin runs in them).
const RESTORE_LOG: &str = "restore.log";
/// A restore process starting finds a log over this moved to `restore.log.1`.
const RESTORE_LOG_LIMIT: u64 = 1_000_000;

/// Logs this process into [`RESTORE_LOG`]. `rotate` first moves a log over
/// [`RESTORE_LOG_LIMIT`] aside (replacing an older one) — only at a process's
/// start, never mid-run: the e2e run reads the file from an offset.
fn init_restore_log(rotate: bool) {
    let path = crate::paths::AppPaths::resolve().log_dir.join(RESTORE_LOG);
    if rotate {
        rotate_log(&path, RESTORE_LOG_LIMIT);
    }
    let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
    let inner = env_logger::Builder::new()
        .filter_level(log::LevelFilter::Info)
        .target(env_logger::Target::Pipe(Box::new(file)))
        .build();
    let level = inner.filter();
    if log::set_boxed_logger(Box::new(RestoreLogger(inner))).is_ok() {
        log::set_max_level(level);
    }
}

/// Moves `path` to `<path>.1` when it is over `limit` bytes.
fn rotate_log(path: &Path, limit: u64) {
    // Best effort: no log is open yet to tell of a failure (the file then grows on).
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > limit) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

/// The lines of the retry round under way and of the one before: a mouse that
/// sleeps fails the same way every 2 s, so a line the last round logged
/// already is left out (7.5 MB of one line seen).
#[derive(Default)]
struct Rounds {
    /// Set by the first round's end: lines before it are all written.
    quiet: bool,
    last: Vec<String>,
    this: Vec<String>,
    left_out: usize,
}

impl Rounds {
    /// Whether `line` is written.
    fn admit(&mut self, line: String) -> bool {
        let repeated = self.quiet && self.last.contains(&line);
        self.this.push(line);
        self.left_out += usize::from(repeated);
        !repeated
    }

    /// Ends a round. Returns how many of its lines were left out.
    fn end(&mut self) -> usize {
        self.quiet = true;
        self.last = std::mem::take(&mut self.this);
        std::mem::take(&mut self.left_out)
    }
}

static ROUNDS: std::sync::Mutex<Rounds> = std::sync::Mutex::new(Rounds { quiet: false, last: Vec::new(), this: Vec::new(), left_out: 0 });

fn rounds() -> std::sync::MutexGuard<'static, Rounds> {
    ROUNDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// env_logger with [`Rounds`] in front of it.
struct RestoreLogger(env_logger::Logger);

impl log::Log for RestoreLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        self.0.enabled(metadata)
    }

    fn log(&self, record: &log::Record) {
        if self.0.matches(record) && rounds().admit(format!("{} {} {}", record.level(), record.target(), record.args())) {
            self.0.log(record);
        }
    }

    fn flush(&self) {
        self.0.flush();
    }
}

/// How often a restore that keeps waiting says so while it logs nothing new.
const STILL_WAITING_EVERY: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Restores the live maps a dead Sidearm left and stores an offline profile an
/// exit could not, retrying while a mouse sleeps (an asleep mouse answers
/// nothing and plays Sidearm's silent signals once it wakes).
/// Quits when Sidearm turns out alive or once a Sidearm starts — its own start
/// restores them after this process ends. Every end logs
/// `[restore] process <pid> done: <why>`.
pub fn restore_live_maps_main(config_dir: &Path, after_crash: bool, watch: Option<u32>) {
    use std::time::{Duration, Instant};
    init_restore_log(true);
    let me = std::process::id();
    let done = |why: &str| log::info!("[restore] process {me} done: {why}");
    let mut after_crash = after_crash;
    if let Some(pid) = watch {
        // Tells Sidearm its watchdog is up; released when this process ends.
        let _ready = create_mutex(&watchdog_mutex(pid));
        wait_for_exit(pid);
        if exited_cleanly(config_dir, pid) {
            return done(&format!("Sidearm {pid} exited cleanly"));
        }
        log::warn!("[restore] Sidearm {pid} ended without its exit (killed or crashed): restoring the mice");
        after_crash = true;
    }
    log::info!("[restore] process {me} started for {} (after a crash: {after_crash})", config_dir.display());
    // The dying Sidearm's mutex goes when its process has fully ended. Checked
    // before taking the restore mutex: a live Sidearm is never paused by it.
    let grace = Instant::now() + Duration::from_secs(15);
    while mutex_exists(APP_MUTEX) {
        if Instant::now() >= grace {
            return done("a Sidearm still runs after 15 s (it keeps the mice)");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // One restorer at a time, holding the mutex until it exits.
    let Some(_restoring) = create_mutex(RESTORE_MUTEX) else { return done("another restore process has the mice") };
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
    let mut said_waiting = started;
    let mut tries = 0u32;
    let mut registered = false;
    let sidearm_started = "a Sidearm started (it restores the mice itself)";
    let outcome = 'retry: loop {
        if mutex_exists(APP_MUTEX) {
            break sidearm_started;
        }
        tries += 1;
        let maps_done = crate::mouse_memory::live_overlay::restore_orphaned(config_dir);
        // A mouse asleep at exit has no offline profile yet: store it once it
        // answers (the marker names the profile; a success removes it).
        if failed_marker.exists()
            && let Ok(config) = crate::config::read_and_migrate_config_file(&config_dir.join("config.json"))
        {
            crate::mouse_offline::retry_offline_profile(&config, config_dir);
        }
        let left_out = rounds().end();
        if maps_done && !failed_marker.exists() {
            break "the mice are restored";
        }
        if left_out > 0 && said_waiting.elapsed() >= STILL_WAITING_EVERY {
            log::info!("[restore] still waiting for a mouse to answer ({tries} tries, {} min)", started.elapsed().as_secs() / 60);
            said_waiting = Instant::now();
        }
        if !registered {
            set_run_once(config_dir, true);
            registered = true;
        }
        // A starting Sidearm is noticed within 2 s either way (it waits for
        // this process to let go of the mice).
        let pause = if started.elapsed() < Duration::from_secs(30 * 60) { 1 } else { 30 };
        for _ in 0..pause {
            std::thread::sleep(Duration::from_secs(2));
            if mutex_exists(APP_MUTEX) {
                break 'retry sidearm_started;
            }
        }
    };
    // A Sidearm that started registered the logon restore for itself.
    if outcome != sidearm_started && !mutex_exists(APP_MUTEX) {
        set_run_once(config_dir, false);
    }
    done(&format!("{outcome} after {tries} tries"));
}

/// `RunOnce` value that starts the restore process at the next logon while a
/// Sidearm runs (until its clean exit) or a mouse still waits for its restore.
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
    // A Sidearm still exiting (its exit can wait on a sleeping mouse for many
    // seconds) or the one an admin relaunch replaces: start once it is gone.
    // Overlapping, both used one WebView2 data folder (`data\EBWebView`), whose
    // environments share their processes: the new window sometimes never came
    // up, and with it no capture.
    if std::env::args().any(|arg| arg == RELAUNCHED_ARG) || mutex_exists(EXITING_MUTEX) {
        let deadline = std::time::Instant::now() + PREDECESSOR_WAIT;
        while mutex_exists(APP_MUTEX) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    // A Sidearm still exiting holds it too (its exit waits on a sleeping mouse
    // for many seconds): hold it anyway. Turned away, this Sidearm ran without
    // it, and a restore process took it for gone and kept the mice for good.
    open_mutex(APP_MUTEX, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_own_job_is_read() {
        // Under cargo test the process is in cargo's job, which ends with it.
        let _ = job_kills_on_close();
    }

    #[test]
    fn an_argument_reads_back_as_it_was_quoted() {
        let quote = |text: &str| quote_arg(std::ffi::OsStr::new(text));
        assert_eq!(quote(r"C:\Scripts\data"), r"C:\Scripts\data", "nothing to quote");
        assert_eq!(quote(r"C:\My data\"), r#""C:\My data\\""#, "a trailing backslash is doubled");
        assert_eq!(quote(r#"a "b" c"#), r#""a \"b\" c""#);
        assert_eq!(quote(r#"x\"y z"#), r#""x\\\"y z""#, "backslashes before a quote are doubled");
        assert_eq!(quote(""), r#""""#);
    }

    #[test]
    fn the_watchdog_mutex_is_seen_once_it_exists() {
        let pid = u32::MAX - std::process::id();
        let name = watchdog_mutex(pid);
        assert!(!wait_for_mutex(&name, std::time::Duration::from_millis(150)), "no watchdog yet");
        let held = create_mutex(&name).expect("created");
        assert!(wait_for_mutex(&name, std::time::Duration::from_secs(1)));
        unsafe { windows_sys::Win32::Foundation::CloseHandle(held) };
    }

    /// The app mutex is held even when an exiting Sidearm still holds it: it
    /// stays while this one runs, after the other one let go.
    #[test]
    fn a_starting_sidearm_holds_the_app_mutex_its_predecessor_still_holds() {
        let name = format!("Local\\Sidearm-test-mutex-{}", std::process::id());
        let exiting = create_mutex(&name).expect("first holder");
        assert!(create_mutex(&name).is_none(), "one restorer at a time");
        let starting = open_mutex(&name, true).expect("held although it exists");
        unsafe { windows_sys::Win32::Foundation::CloseHandle(exiting) };
        assert!(mutex_exists(&name), "still held by the starting one");
        unsafe { windows_sys::Win32::Foundation::CloseHandle(starting) };
        assert!(!mutex_exists(&name));
    }

    /// A log over the limit moves to `.1`, replacing an older one; a smaller one stays.
    #[test]
    fn a_large_restore_log_is_rotated_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join(RESTORE_LOG);
        std::fs::write(&log, "small").unwrap();
        rotate_log(&log, 10);
        assert!(log.exists(), "under the limit");
        std::fs::write(dir.path().join("restore.log.1"), "older").unwrap();
        std::fs::write(&log, "more than ten bytes").unwrap();
        rotate_log(&log, 10);
        assert!(!log.exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("restore.log.1")).unwrap(), "more than ten bytes");
    }

    /// A retry round's line the round before logged is left out; a changed
    /// line, and every line before the first round's end, is written.
    #[test]
    fn a_repeated_retry_line_is_logged_once() {
        let mut rounds = Rounds::default();
        assert!(rounds.admit("started".into()));
        assert!(rounds.admit("V2 asleep".into()));
        assert_eq!(rounds.end(), 0);
        assert!(!rounds.admit("V2 asleep".into()), "the same failure");
        assert!(rounds.admit("V3 restored".into()));
        assert_eq!(rounds.end(), 1);
        assert!(!rounds.admit("V2 asleep".into()));
        assert!(rounds.admit("V2 out of range".into()), "a new text");
        assert_eq!(rounds.end(), 1);
        assert!(rounds.admit("V3 restored".into()), "not in the last round");
    }

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
