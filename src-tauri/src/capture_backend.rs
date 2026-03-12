use serde::{Deserialize, Serialize};
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
};
use tauri::{AppHandle, Emitter};

use crate::{
    config::AppConfig,
    executor::{self, RuntimeErrorEvent},
    hotkeys, resolver,
    runtime::{
        self, RuntimeStore, EVENT_ACTION_EXECUTED, EVENT_CONTROL_RESOLVED,
        EVENT_ENCODED_KEY_RECEIVED, EVENT_PROFILE_RESOLVED, EVENT_RUNTIME_ERROR,
    },
    window_capture,
};

pub const CAPTURE_BACKEND_NAME: &str = "windows-hotkey";
const BACKEND_LL_HOOK: &str = "windows-ll-hook";

#[cfg(target_os = "windows")]
const MOD_ALT: u32 = 0x0001;
#[cfg(target_os = "windows")]
const MOD_CONTROL: u32 = 0x0002;
#[cfg(target_os = "windows")]
const MOD_SHIFT: u32 = 0x0004;
#[cfg(target_os = "windows")]
const MOD_WIN: u32 = 0x0008;

#[cfg(target_os = "windows")]
const VK_SHIFT: u32 = 0x10;
#[cfg(target_os = "windows")]
const VK_CONTROL: u32 = 0x11;
#[cfg(target_os = "windows")]
const VK_MENU: u32 = 0x12;
#[cfg(target_os = "windows")]
const VK_LSHIFT: u32 = 0xA0;
#[cfg(target_os = "windows")]
const VK_RSHIFT: u32 = 0xA1;
#[cfg(target_os = "windows")]
const VK_LCONTROL: u32 = 0xA2;
#[cfg(target_os = "windows")]
const VK_RCONTROL: u32 = 0xA3;
#[cfg(target_os = "windows")]
const VK_LMENU: u32 = 0xA4;
#[cfg(target_os = "windows")]
const VK_RMENU: u32 = 0xA5;
#[cfg(target_os = "windows")]
const VK_LWIN: u32 = 0x5B;
#[cfg(target_os = "windows")]
const VK_RWIN: u32 = 0x5C;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncodedKeyEvent {
    pub encoded_key: String,
    pub backend: String,
    pub received_at: u64,
    pub is_repeat: bool,
}

#[derive(Default)]
pub struct RuntimeController {
    backend: Option<CaptureBackendHandle>,
}

impl RuntimeController {
    pub fn start(
        &mut self,
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<(), String> {
        self.stop()?;
        let backend = CaptureBackendHandle::start(app, runtime_store, config, app_name)?;
        self.backend = Some(backend);
        Ok(())
    }

    pub fn restart(
        &mut self,
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<(), String> {
        self.start(app, runtime_store, config, app_name)
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(backend) = self.backend.take() {
            backend.stop()?;
        }
        Ok(())
    }
}

struct CaptureBackendHandle {
    hook_thread_id: u32,
    hook_thread: JoinHandle<()>,
    worker_thread: JoinHandle<()>,
    helper: Option<HelperHandle>,
}

struct HelperHandle {
    stdin_pipe: std::process::ChildStdin,
    child: std::process::Child,
    reader_thread: JoinHandle<()>,
}

impl CaptureBackendHandle {
    fn start(
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        {
            let registrations = build_hotkey_registrations(&config)?;
            let (event_tx, event_rx) = mpsc::channel::<EncodedKeyEvent>();
            let helper_event_tx = event_tx.clone();
            let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

            let worker_app = app.clone();
            let worker_runtime_store = runtime_store.clone();
            let worker_config = config.clone();
            let worker_app_name = app_name.clone();
            let worker_thread = thread::spawn(move || {
                while let Ok(event) = event_rx.recv() {
                    process_encoded_key_event(
                        &worker_app,
                        &worker_runtime_store,
                        &worker_config,
                        &worker_app_name,
                        event,
                    );
                }
            });

            let hook_registrations = registrations.clone();
            let hook_thread = thread::spawn(move || {
                run_hotkey_message_loop(hook_registrations, event_tx, ready_tx);
            });

            let hook_thread_id = match ready_rx.recv() {
                Ok(Ok(thread_id)) => thread_id,
                Ok(Err(error)) => {
                    drop(helper_event_tx);
                    let _ = hook_thread.join();
                    let _ = worker_thread.join();
                    return Err(error);
                }
                Err(error) => {
                    drop(helper_event_tx);
                    let _ = hook_thread.join();
                    let _ = worker_thread.join();
                    return Err(format!(
                        "Failed to receive capture backend readiness: {error}"
                    ));
                }
            };

            // Spawn helper process for modifier-combo hotkeys (non-fatal if fails)
            let helper = spawn_capture_helper(&registrations, helper_event_tx);

            Ok(Self {
                hook_thread_id,
                hook_thread,
                worker_thread,
                helper,
            })
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = app;
            let _ = runtime_store;
            let _ = config;
            let _ = app_name;
            Err("Global capture backend is only implemented for Windows.".into())
        }
    }

    fn stop(self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};

            let posted = unsafe { PostThreadMessageW(self.hook_thread_id, WM_QUIT, 0, 0) };
            if posted == 0 {
                return Err(format!(
                    "Failed to post WM_QUIT to capture thread {}.",
                    self.hook_thread_id
                ));
            }
        }

        // Signal helper to exit by closing its stdin pipe, then wait for cleanup
        if let Some(helper) = self.helper {
            let HelperHandle {
                stdin_pipe,
                mut child,
                reader_thread,
            } = helper;
            drop(stdin_pipe);
            let _ = child.wait();
            let _ = reader_thread.join();
        }

        self.hook_thread
            .join()
            .map_err(|_| "Capture hook thread panicked.".to_owned())?;
        self.worker_thread
            .join()
            .map_err(|_| "Capture worker thread panicked.".to_owned())?;
        Ok(())
    }
}

#[derive(Clone)]
struct RegisteredHotkey {
    id: i32,
    encoded_key: String,
    modifiers_mask: u32,
    primary_vk: u32,
    /// True if this hotkey includes Ctrl / Alt / Shift / Win modifiers.
    has_modifiers: bool,
}

fn build_hotkey_registrations(config: &AppConfig) -> Result<Vec<RegisteredHotkey>, String> {
    let mut registrations = Vec::with_capacity(config.encoder_mappings.len());
    for (index, mapping) in config.encoder_mappings.iter().enumerate() {
        let hotkey = hotkeys::parse_hotkey(&mapping.encoded_key).map_err(|message| {
            format!(
                "Failed to register encodedKey `{}` for `{}::{}`: {}",
                mapping.encoded_key,
                mapping.control_id.as_str(),
                mapping.layer.as_str(),
                message
            )
        })?;

        let m = &hotkey.modifiers;
        registrations.push(RegisteredHotkey {
            id: (index + 1) as i32,
            encoded_key: hotkey.canonical,
            modifiers_mask: hotkey.modifiers.register_hotkey_mask(),
            primary_vk: u32::from(hotkey.key.code),
            has_modifiers: m.ctrl || m.alt || m.shift || m.win,
        });
    }

    Ok(registrations)
}

// ---------------------------------------------------------------------------
// Capture helper process — runs WH_KEYBOARD_LL in a child process to avoid
// WebView2 interference (tauri-apps/tauri#13919). The main process spawns
// this helper with `--capture-helper`; they communicate via stdin/stdout pipes.
// ---------------------------------------------------------------------------

/// IPC registration sent from the main process to the capture helper.
#[derive(Clone, Serialize, Deserialize)]
struct HelperRegistration {
    encoded_key: String,
    modifiers_mask: u32,
    primary_vk: u32,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct HelperModifierState {
    ctrl: bool,
    alt: bool,
    shift: bool,
    win: bool,
}

#[cfg(target_os = "windows")]
impl HelperModifierState {
    fn apply_vk_event(&mut self, vk: u32, is_down: bool) -> bool {
        if is_control_vk(vk) {
            self.ctrl = is_down;
            return true;
        }
        if is_alt_vk(vk) {
            self.alt = is_down;
            return true;
        }
        if is_shift_vk(vk) {
            self.shift = is_down;
            return true;
        }
        if is_win_vk(vk) {
            self.win = is_down;
            return true;
        }

        false
    }

    fn matches_mask(self, modifiers_mask: u32) -> bool {
        self.ctrl == ((modifiers_mask & MOD_CONTROL) != 0)
            && self.alt == ((modifiers_mask & MOD_ALT) != 0)
            && self.shift == ((modifiers_mask & MOD_SHIFT) != 0)
            && self.win == ((modifiers_mask & MOD_WIN) != 0)
    }
}

#[cfg(target_os = "windows")]
fn is_control_vk(vk: u32) -> bool {
    matches!(vk, VK_CONTROL | VK_LCONTROL | VK_RCONTROL)
}

#[cfg(target_os = "windows")]
fn is_alt_vk(vk: u32) -> bool {
    matches!(vk, VK_MENU | VK_LMENU | VK_RMENU)
}

#[cfg(target_os = "windows")]
fn is_shift_vk(vk: u32) -> bool {
    matches!(vk, VK_SHIFT | VK_LSHIFT | VK_RSHIFT)
}

#[cfg(target_os = "windows")]
fn is_win_vk(vk: u32) -> bool {
    matches!(vk, VK_LWIN | VK_RWIN)
}

// Thread-local state for the capture helper's LL keyboard hook callback.
#[cfg(target_os = "windows")]
thread_local! {
    static HELPER_REGISTRATIONS: std::cell::RefCell<Vec<HelperRegistration>> =
        std::cell::RefCell::new(Vec::new());
    static HELPER_MODIFIERS: std::cell::RefCell<HelperModifierState> =
        std::cell::RefCell::new(HelperModifierState::default());
    static HELPER_SUPPRESSIONS: std::cell::RefCell<std::collections::HashSet<u32>> =
        std::cell::RefCell::new(std::collections::HashSet::new());
    static HELPER_MATCHES: std::cell::RefCell<Vec<String>> =
        std::cell::RefCell::new(Vec::new());
    static HELPER_THREAD_ID: std::cell::Cell<u32> = std::cell::Cell::new(0);
}

#[cfg(target_os = "windows")]
fn process_helper_key_event(
    regs: &[HelperRegistration],
    modifiers: &mut HelperModifierState,
    suppressions: &mut std::collections::HashSet<u32>,
    matches: &mut Vec<String>,
    vk: u32,
    msg: u32,
) -> (bool, bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    match msg {
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            if modifiers.apply_vk_event(vk, true) {
                return (false, false);
            }

            for reg in regs.iter() {
                if reg.primary_vk == vk && modifiers.matches_mask(reg.modifiers_mask) {
                    let is_repeat = !suppressions.insert(vk);
                    if !is_repeat {
                        matches.push(reg.encoded_key.clone());
                    }
                    return (true, !is_repeat);
                }
            }

            (false, false)
        }
        WM_KEYUP | WM_SYSKEYUP => {
            if modifiers.apply_vk_event(vk, false) {
                (false, false)
            } else {
                (suppressions.remove(&vk), false)
            }
        }
        _ => (false, false),
    }
}

/// LL keyboard hook callback for the capture helper process.
/// Matches modifier+F-key combos and buffers the encoded key in HELPER_MATCHES.
#[cfg(target_os = "windows")]
unsafe extern "system" fn helper_ll_keyboard_proc(
    code: i32,
    w_param: usize,
    l_param: isize,
) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, PostThreadMessageW, KBDLLHOOKSTRUCT,
    };

    if code >= 0 {
        let kb = &*(l_param as *const KBDLLHOOKSTRUCT);
        let msg = w_param as u32;
        let vk = kb.vkCode;
        let internal_injection =
            kb.dwExtraInfo == crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO;

        if internal_injection {
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
        }

        // Returns (suppress_key, new_match_added)
        let (suppress, wake) = HELPER_MODIFIERS.with(|mods_cell| {
            HELPER_SUPPRESSIONS.with(|sup_cell| {
                HELPER_REGISTRATIONS.with(|reg_cell| {
                    HELPER_MATCHES.with(|match_cell| {
                        let regs = reg_cell.borrow();
                        let mut modifiers = mods_cell.borrow_mut();
                        let mut suppressions = sup_cell.borrow_mut();
                        let mut matches = match_cell.borrow_mut();

                        process_helper_key_event(
                            &regs,
                            &mut modifiers,
                            &mut suppressions,
                            &mut matches,
                            vk,
                            msg,
                        )
                    })
                })
            })
        });

        // Post a wake-up message so GetMessageW returns and drain_helper_matches
        // can flush the buffered match to stdout. LL hook callbacks are dispatched
        // via sent-message delivery during GetMessageW, which does NOT cause
        // GetMessageW to return on its own.
        if wake {
            const WM_APP: u32 = 0x8000;
            HELPER_THREAD_ID.with(|cell| {
                let tid = cell.get();
                if tid != 0 {
                    PostThreadMessageW(tid, WM_APP, 0, 0);
                }
            });
        }

        if suppress {
            return 1;
        }
    }

    CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param)
}

/// Entry point for the `--capture-helper` child process.
/// Reads modifier-combo registrations from stdin (one JSON line),
/// installs WH_KEYBOARD_LL, and writes matched encoded keys to stdout.
/// Exits when stdin is closed (parent process stopped).
#[cfg(target_os = "windows")]
pub fn capture_helper_main() {
    use std::io::BufRead;
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
            UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WM_QUIT,
        },
    };

    // 1. Read registrations from stdin (one JSON line)
    let stdin = std::io::stdin();
    let mut line = String::new();
    if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 {
        eprintln!("[capture-helper] No input received on stdin, exiting.");
        return;
    }

    let registrations: Vec<HelperRegistration> = match serde_json::from_str(line.trim()) {
        Ok(regs) => regs,
        Err(e) => {
            eprintln!("[capture-helper] Failed to parse registrations: {e}");
            return;
        }
    };

    if registrations.is_empty() {
        eprintln!("[capture-helper] No registrations, exiting.");
        return;
    }

    eprintln!(
        "[capture-helper] Loaded {} modifier-combo registrations.",
        registrations.len()
    );

    // 2. Initialize thread-local state for the LL hook callback
    HELPER_REGISTRATIONS.with(|cell| *cell.borrow_mut() = registrations);
    HELPER_MODIFIERS.with(|cell| *cell.borrow_mut() = HelperModifierState::default());
    HELPER_SUPPRESSIONS.with(|cell| cell.borrow_mut().clear());
    HELPER_MATCHES.with(|cell| cell.borrow_mut().clear());

    // 3. Install WH_KEYBOARD_LL hook
    let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(helper_ll_keyboard_proc), hmod, 0) };
    if hook.is_null() {
        eprintln!(
            "[capture-helper] SetWindowsHookExW failed: {}",
            std::io::Error::last_os_error()
        );
        return;
    }
    eprintln!("[capture-helper] LL keyboard hook installed successfully.");

    // 4. Spawn stdin watcher — when parent closes stdin, signal this thread to exit
    let hook_tid = unsafe { GetCurrentThreadId() };
    HELPER_THREAD_ID.with(|cell| cell.set(hook_tid));
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = String::new();
        // Blocks until stdin is closed (parent died or closed the pipe)
        let _ = stdin.lock().read_line(&mut buf);
        eprintln!("[capture-helper] stdin closed, posting WM_QUIT.");
        unsafe {
            PostThreadMessageW(hook_tid, WM_QUIT, 0, 0);
        }
    });

    // 5. Message pump — drives the LL hook callbacks
    let stdout_handle = std::io::stdout();
    let mut stdout = stdout_handle.lock();
    let mut msg = MaybeUninit::<MSG>::zeroed();
    loop {
        let status = unsafe { GetMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0) };
        if status <= 0 {
            break;
        }

        // Drain matches buffered by the hook callback during GetMessageW
        drain_helper_matches(&mut stdout);

        let m = unsafe { msg.assume_init() };
        unsafe {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }

        // Also drain after dispatch (hooks may fire during DispatchMessageW)
        drain_helper_matches(&mut stdout);
    }

    // 6. Cleanup
    unsafe {
        UnhookWindowsHookEx(hook);
    }
    eprintln!("[capture-helper] Hook uninstalled, exiting.");
}

#[cfg(target_os = "windows")]
fn drain_helper_matches(stdout: &mut std::io::StdoutLock<'_>) {
    use std::io::Write;

    let matches: Vec<String> = HELPER_MATCHES.with(|cell| cell.borrow_mut().drain(..).collect());
    for encoded_key in matches {
        let _ = writeln!(stdout, "{encoded_key}");
        let _ = stdout.flush();
    }
}

#[cfg(not(target_os = "windows"))]
pub fn capture_helper_main() {
    eprintln!("[capture-helper] Only supported on Windows.");
}

/// Spawns the capture helper child process for modifier-combo hotkeys.
/// Returns None if there are no modifier combos or if spawning fails (non-fatal).
#[cfg(target_os = "windows")]
fn spawn_capture_helper(
    registrations: &[RegisteredHotkey],
    event_tx: mpsc::Sender<EncodedKeyEvent>,
) -> Option<HelperHandle> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Only send modifier-combo registrations to the helper
    let helper_regs: Vec<HelperRegistration> = registrations
        .iter()
        .filter(|r| r.has_modifiers)
        .map(|r| HelperRegistration {
            encoded_key: r.encoded_key.clone(),
            modifiers_mask: r.modifiers_mask,
            primary_vk: r.primary_vk,
        })
        .collect();

    if helper_regs.is_empty() {
        return None;
    }

    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[capture] WARNING: Failed to get current exe path for helper: {e}");
            return None;
        }
    };

    let mut child = match Command::new(&exe_path)
        .arg("--capture-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[capture] WARNING: Failed to spawn capture helper: {e}");
            return None;
        }
    };

    let mut stdin_pipe = child.stdin.take().expect("stdin was piped");
    let stdout_pipe = child.stdout.take().expect("stdout was piped");

    // Write registrations as a JSON line to the helper's stdin
    let json = match serde_json::to_string(&helper_regs) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[capture] WARNING: Failed to serialize helper registrations: {e}");
            let _ = child.kill();
            return None;
        }
    };

    let write_result = writeln!(stdin_pipe, "{json}").and_then(|()| stdin_pipe.flush());
    if let Err(e) = write_result {
        eprintln!("[capture] WARNING: Failed to write to helper stdin: {e}");
        let _ = child.kill();
        return None;
    }

    eprintln!(
        "[capture] Capture helper spawned (pid {}), {} modifier-combo registrations.",
        child.id(),
        helper_regs.len()
    );

    // Reader thread: reads encoded keys from helper stdout, converts to events
    let reader_thread = thread::spawn(move || {
        use std::io::BufRead;

        let reader = std::io::BufReader::new(stdout_pipe);
        for line in reader.lines().map_while(Result::ok) {
            let encoded_key = line.trim().to_owned();
            if encoded_key.is_empty() {
                continue;
            }
            let _ = event_tx.send(EncodedKeyEvent {
                encoded_key,
                backend: BACKEND_LL_HOOK.into(),
                received_at: runtime::timestamp_millis(),
                is_repeat: false,
            });
        }
    });

    Some(HelperHandle {
        stdin_pipe,
        child,
        reader_thread,
    })
}

#[cfg(not(target_os = "windows"))]
fn spawn_capture_helper(
    _registrations: &[RegisteredHotkey],
    _event_tx: mpsc::Sender<EncodedKeyEvent>,
) -> Option<HelperHandle> {
    None
}

// ---------------------------------------------------------------------------
// RegisterHotKey capture loop
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn run_hotkey_message_loop(
    registrations: Vec<RegisteredHotkey>,
    event_tx: mpsc::Sender<EncodedKeyEvent>,
    ready_tx: mpsc::Sender<Result<u32, String>>,
) {
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        System::Threading::GetCurrentThreadId,
        UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey},
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, TranslateMessage, MSG, WM_HOTKEY,
        },
    };

    // --- 1. Register all hotkeys via RegisterHotKey ---
    let mut registered_ids = Vec::new();
    for reg in &registrations {
        let registered = unsafe {
            RegisterHotKey(
                std::ptr::null_mut(),
                reg.id,
                reg.modifiers_mask,
                reg.primary_vk,
            )
        };
        if registered == 0 {
            for registered_id in registered_ids.iter().copied() {
                unsafe {
                    UnregisterHotKey(std::ptr::null_mut(), registered_id);
                }
            }
            let last_error = std::io::Error::last_os_error();
            let _ = ready_tx.send(Err(format!(
                "RegisterHotKey failed for `{}`. {}",
                reg.encoded_key, last_error
            )));
            return;
        }
        registered_ids.push(reg.id);
    }

    let thread_id = unsafe { GetCurrentThreadId() };
    let _ = ready_tx.send(Ok(thread_id));

    // --- 2. Message loop ---
    let mut msg = MaybeUninit::<MSG>::zeroed();
    loop {
        let status = unsafe { GetMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0) };
        if status <= 0 {
            break; // 0 = WM_QUIT, -1 = error
        }

        let m = unsafe { msg.assume_init() };
        if m.message == WM_HOTKEY {
            let hotkey_id = m.wParam as i32;
            let index = (hotkey_id as usize).checked_sub(1);
            let registration = index.and_then(|i| registrations.get(i));
            if let Some(registration) = registration {
                let _ = event_tx.send(EncodedKeyEvent {
                    encoded_key: registration.encoded_key.clone(),
                    backend: CAPTURE_BACKEND_NAME.into(),
                    received_at: runtime::timestamp_millis(),
                    is_repeat: false,
                });
            } else {
                eprintln!("[capture] WARNING: received WM_HOTKEY with unrecognized id {hotkey_id}");
            }
        }

        unsafe {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    }

    // --- 3. Cleanup ---
    for registered_id in registered_ids {
        unsafe {
            UnregisterHotKey(std::ptr::null_mut(), registered_id);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn run_hotkey_message_loop(
    _registrations: Vec<RegisteredHotkey>,
    _event_tx: mpsc::Sender<EncodedKeyEvent>,
    ready_tx: mpsc::Sender<Result<u32, String>>,
) {
    let _ = ready_tx.send(Err(
        "Global capture backend is only implemented for Windows.".into(),
    ));
}

fn process_encoded_key_event(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    app_name: &str,
    event: EncodedKeyEvent,
) {
    // Accumulate log entries locally and flush in a single lock at the end to
    // avoid acquiring the runtime_store mutex multiple times per keypress.
    let mut log_entries: Vec<(&str, String, bool)> = Vec::new(); // (source, message, is_warn)

    log_entries.push((
        "capture",
        format!(
            "Received encoded key `{}` from runtime backend.",
            event.encoded_key
        ),
        false,
    ));

    let _ = app.emit(EVENT_ENCODED_KEY_RECEIVED, &event);

    let capture_result =
        match window_capture::capture_active_window_with_resolution(config, app_name, None) {
            Ok(result) => result,
            Err(message) => {
                let error = RuntimeErrorEvent {
                    category: "window-capture".into(),
                    message,
                    encoded_key: Some(event.encoded_key.clone()),
                    action_id: None,
                    created_at: runtime::timestamp_millis(),
                };
                emit_runtime_error(app, runtime_store, &error);
                return;
            }
        };

    let _ = app.emit(EVENT_PROFILE_RESOLVED, &capture_result);
    if capture_result.ignored {
        log_entries.push((
            "capture",
            capture_result
                .ignore_reason
                .clone()
                .unwrap_or_else(|| "Ignored studio-owned foreground window.".into()),
            true,
        ));
        flush_log_entries(runtime_store, log_entries);
        return;
    }

    let preview = resolver::resolve_input_preview(
        config,
        &event.encoded_key,
        &capture_result.exe,
        &capture_result.title,
    );

    match preview.status {
        resolver::ResolutionStatus::Resolved => {
            log_entries.push((
                "resolver",
                format!(
                    "Resolved runtime input `{}` to `{}` / `{}`.",
                    preview.encoded_key,
                    preview.control_id.as_deref().unwrap_or("n/a"),
                    preview.layer.as_deref().unwrap_or("n/a")
                ),
                false,
            ));
        }
        resolver::ResolutionStatus::Unresolved | resolver::ResolutionStatus::Ambiguous => {
            log_entries.push((
                "resolver",
                format!(
                    "Runtime preview for `{}` did not resolve cleanly: {}",
                    preview.encoded_key, preview.reason
                ),
                true,
            ));
        }
    }

    let _ = app.emit(EVENT_CONTROL_RESOLVED, &preview);
    if preview.status != resolver::ResolutionStatus::Resolved {
        flush_log_entries(runtime_store, log_entries);
        return;
    }

    match executor::run_preview_action(config, &preview) {
        Ok(execution) => {
            log_entries.push((
                "execution",
                format!(
                    "Runtime executed `{}` for `{}`.",
                    execution.action_pretty, execution.encoded_key
                ),
                false,
            ));
            for warning in &execution.warnings {
                log_entries.push(("execution", warning.clone(), true));
            }
            flush_log_entries(runtime_store, log_entries);
            let _ = app.emit(EVENT_ACTION_EXECUTED, &execution);
        }
        Err(error) => {
            flush_log_entries(runtime_store, log_entries);
            emit_runtime_error(app, runtime_store, &error.event);
        }
    }
}

fn flush_log_entries(runtime_store: &Arc<Mutex<RuntimeStore>>, entries: Vec<(&str, String, bool)>) {
    if entries.is_empty() {
        return;
    }
    if let Ok(mut store) = runtime_store.lock() {
        for (source, message, is_warn) in entries {
            if is_warn {
                store.record_warn(source, message);
            } else {
                store.record_info(source, message);
            }
        }
    } else {
        eprintln!("[capture] WARNING: runtime_store mutex poisoned while flushing log entries");
    }
}

fn emit_runtime_error(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    event: &RuntimeErrorEvent,
) {
    if let Ok(mut store) = runtime_store.lock() {
        let mut context = Vec::new();
        if let Some(encoded_key) = &event.encoded_key {
            context.push(format!("encodedKey={encoded_key}"));
        }
        if let Some(action_id) = &event.action_id {
            context.push(format!("actionId={action_id}"));
        }

        let suffix = if context.is_empty() {
            String::new()
        } else {
            format!(" ({})", context.join(", "))
        };
        store.record_warn(
            event.category.clone(),
            format!("{}{}", event.message, suffix),
        );
    } else {
        eprintln!(
            "[{}] WARNING: runtime_store mutex poisoned while recording runtime error: {}",
            event.category, event.message
        );
    }

    let _ = app.emit(EVENT_RUNTIME_ERROR, event);
}

#[cfg(test)]
#[cfg(target_os = "windows")]
mod helper_modifier_state_tests {
    use super::*;

    #[test]
    fn tracks_left_and_right_modifier_variants() {
        let mut state = HelperModifierState::default();

        assert!(state.apply_vk_event(VK_LCONTROL, true));
        assert!(state.ctrl);
        assert!(state.apply_vk_event(VK_RSHIFT, true));
        assert!(state.shift);
        assert!(state.apply_vk_event(VK_RMENU, true));
        assert!(state.alt);
        assert!(state.apply_vk_event(VK_LWIN, true));
        assert!(state.win);

        assert!(state.apply_vk_event(VK_CONTROL, false));
        assert!(!state.ctrl);
        assert!(state.apply_vk_event(VK_SHIFT, false));
        assert!(!state.shift);
        assert!(state.apply_vk_event(VK_MENU, false));
        assert!(!state.alt);
        assert!(state.apply_vk_event(VK_RWIN, false));
        assert!(!state.win);
    }

    #[test]
    fn matches_modifier_mask_exactly() {
        let state = HelperModifierState {
            ctrl: true,
            alt: false,
            shift: true,
            win: false,
        };

        assert!(state.matches_mask(MOD_CONTROL | MOD_SHIFT));
        assert!(!state.matches_mask(MOD_CONTROL));
        assert!(!state.matches_mask(MOD_CONTROL | MOD_SHIFT | MOD_ALT));
    }
}

// ---------------------------------------------------------------------------
// Diagnostic tests — verify Win32 capture mechanisms via SendInput
// Run with: cargo test -p naga-workflow-studio capture_diag -- --nocapture
// ---------------------------------------------------------------------------

#[cfg(test)]
#[cfg(target_os = "windows")]
mod capture_diag {
    use std::mem::MaybeUninit;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, SendInput, UnregisterHotKey, INPUT, INPUT_KEYBOARD, KEYBDINPUT,
        KEYEVENTF_KEYUP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY,
    };

    const VK_F13: u16 = 0x7C;
    const VK_F23: u16 = 0x86;
    const VK_CONTROL: u16 = 0x11;
    const VK_SHIFT: u16 = 0x10;
    const MOD_NOREPEAT: u32 = 0x4000;
    const MOD_CONTROL: u32 = 0x0002;
    const MOD_SHIFT: u32 = 0x0004;

    fn kbd_down(vk: u16) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn kbd_up(vk: u16) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Pump messages and look for WM_HOTKEY within `timeout`.
    fn poll_wm_hotkey(timeout: Duration) -> Option<i32> {
        let start = Instant::now();
        let mut msg = MaybeUninit::<MSG>::zeroed();
        while start.elapsed() < timeout {
            let found = unsafe {
                PeekMessageW(
                    msg.as_mut_ptr(),
                    std::ptr::null_mut(),
                    WM_HOTKEY,
                    WM_HOTKEY,
                    PM_REMOVE,
                )
            };
            if found != 0 {
                let m = unsafe { msg.assume_init() };
                return Some(m.wParam as i32);
            }
            // Also pump other messages (needed for LL hook callbacks)
            let found_any =
                unsafe { PeekMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0, PM_REMOVE) };
            if found_any != 0 {
                let m = unsafe { msg.assume_init() };
                unsafe {
                    DispatchMessageW(&m);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        None
    }

    /// Pump messages to let LL hook callbacks fire.
    fn pump_messages(duration: Duration) {
        let start = Instant::now();
        let mut msg = MaybeUninit::<MSG>::zeroed();
        while start.elapsed() < duration {
            let found =
                unsafe { PeekMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0, PM_REMOVE) };
            if found != 0 {
                let m = unsafe { msg.assume_init() };
                unsafe {
                    DispatchMessageW(&m);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn diag_register_hotkey_simple_f13() {
        eprintln!("\n=== TEST: RegisterHotKey + SendInput(F13) ===");
        let id = 8001;
        let ok = unsafe { RegisterHotKey(std::ptr::null_mut(), id, MOD_NOREPEAT, VK_F13 as u32) };
        assert!(
            ok != 0,
            "RegisterHotKey(F13) failed: {}",
            std::io::Error::last_os_error()
        );

        let mut inputs = [kbd_down(VK_F13), kbd_up(VK_F13)];
        let sent =
            unsafe { SendInput(2, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
        eprintln!("  SendInput returned {sent}");

        let received = poll_wm_hotkey(Duration::from_millis(500));
        eprintln!("  WM_HOTKEY received: {:?} (expected Some({id}))", received);

        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };

        assert_eq!(
            received,
            Some(id),
            "RegisterHotKey should catch SendInput(F13)"
        );
    }

    #[test]
    fn diag_register_hotkey_ctrl_shift_f23() {
        eprintln!("\n=== TEST: RegisterHotKey + SendInput(Ctrl+Shift+F23) ===");
        let id = 8002;
        let mask = MOD_NOREPEAT | MOD_CONTROL | MOD_SHIFT;
        let ok = unsafe { RegisterHotKey(std::ptr::null_mut(), id, mask, VK_F23 as u32) };
        assert!(
            ok != 0,
            "RegisterHotKey(Ctrl+Shift+F23) failed: {}",
            std::io::Error::last_os_error()
        );

        // Send modifiers then primary (how Razer Synapse does it)
        let mut inputs = [
            kbd_down(VK_CONTROL),
            kbd_down(VK_SHIFT),
            kbd_down(VK_F23),
            kbd_up(VK_F23),
            kbd_up(VK_SHIFT),
            kbd_up(VK_CONTROL),
        ];
        let sent =
            unsafe { SendInput(6, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
        eprintln!("  SendInput returned {sent}");

        let received = poll_wm_hotkey(Duration::from_millis(500));
        eprintln!(
            "  WM_HOTKEY received: {:?} (expected Some({id}) if working)",
            received
        );

        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };

        // This test documents behavior — it may or may not pass depending on system
        if received.is_some() {
            eprintln!("  RESULT: RegisterHotKey CAN catch Ctrl+Shift+F23 via SendInput");
        } else {
            eprintln!("  RESULT: RegisterHotKey CANNOT catch Ctrl+Shift+F23 via SendInput");
        }
    }

    #[test]
    fn diag_ll_hook_ctrl_shift_f23() {
        use std::cell::RefCell;
        use windows_sys::Win32::{
            System::LibraryLoader::GetModuleHandleW,
            UI::Input::KeyboardAndMouse::GetAsyncKeyState,
            UI::WindowsAndMessaging::{
                CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
            },
        };

        eprintln!("\n=== TEST: WH_KEYBOARD_LL + SendInput(Ctrl+Shift+F23) ===");

        struct TestHookState {
            hits: Vec<(u32, bool, bool)>, // (vk, ctrl_down, shift_down)
        }

        thread_local! {
            static TEST_HOOK: RefCell<Option<TestHookState>> = RefCell::new(None);
        }

        unsafe extern "system" fn test_hook_proc(
            code: i32,
            w_param: usize,
            l_param: isize,
        ) -> isize {
            if code >= 0 {
                let kb = unsafe { &*(l_param as *const KBDLLHOOKSTRUCT) };
                let msg = w_param as u32;
                if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                    let ctrl = (unsafe { GetAsyncKeyState(0x11) } as u16 & 0x8000) != 0;
                    let shift = (unsafe { GetAsyncKeyState(0x10) } as u16 & 0x8000) != 0;
                    TEST_HOOK.with(|cell| {
                        if let Some(state) = cell.borrow_mut().as_mut() {
                            state.hits.push((kb.vkCode, ctrl, shift));
                        }
                    });
                }
            }
            unsafe { CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param) }
        }

        TEST_HOOK.with(|cell| {
            *cell.borrow_mut() = Some(TestHookState { hits: Vec::new() });
        });

        let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
        eprintln!("  GetModuleHandleW(NULL) = {:?}", hmod);

        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(test_hook_proc), hmod, 0) };
        eprintln!("  SetWindowsHookExW result: {:?} (null=failed)", hook);
        assert!(
            !hook.is_null(),
            "SetWindowsHookExW failed: {}",
            std::io::Error::last_os_error()
        );

        // Send Ctrl+Shift+F23
        let mut inputs = [
            kbd_down(VK_CONTROL),
            kbd_down(VK_SHIFT),
            kbd_down(VK_F23),
            kbd_up(VK_F23),
            kbd_up(VK_SHIFT),
            kbd_up(VK_CONTROL),
        ];
        let sent =
            unsafe { SendInput(6, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
        eprintln!("  SendInput returned {sent}");

        // Pump messages to let hook callbacks fire
        pump_messages(Duration::from_millis(300));

        let hits = TEST_HOOK.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|s| s.hits.clone())
                .unwrap_or_default()
        });

        eprintln!("  Hook received {} key-down events:", hits.len());
        for (vk, ctrl, shift) in &hits {
            let name = match *vk as u16 {
                0x11 => "VK_CONTROL",
                0x10 => "VK_SHIFT",
                0x86 => "VK_F23",
                other => {
                    eprintln!("    vk=0x{other:02X} ctrl={ctrl} shift={shift}");
                    continue;
                }
            };
            eprintln!("    {name} (0x{vk:02X}) ctrl={ctrl} shift={shift}");
        }

        let f23_hit = hits.iter().find(|(vk, _, _)| *vk == VK_F23 as u32);
        if let Some((_, ctrl, shift)) = f23_hit {
            eprintln!("  RESULT: LL hook DID catch F23. ctrl={ctrl}, shift={shift}");
            if *ctrl && *shift {
                eprintln!(
                    "  RESULT: Modifier state CORRECT — LL hook can intercept Ctrl+Shift+F23"
                );
            } else {
                eprintln!("  RESULT: Modifier state WRONG — GetAsyncKeyState unreliable in hook");
            }
        } else {
            eprintln!("  RESULT: LL hook did NOT receive F23 key event at all!");
        }

        unsafe { UnhookWindowsHookEx(hook) };
        TEST_HOOK.with(|cell| {
            *cell.borrow_mut() = None;
        });
    }

    #[test]
    fn diag_ll_hook_simple_f13() {
        use std::cell::RefCell;
        use windows_sys::Win32::{
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{
                CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
            },
        };

        eprintln!("\n=== TEST: WH_KEYBOARD_LL + SendInput(F13) ===");

        thread_local! {
            static TEST_HITS: RefCell<Vec<u32>> = RefCell::new(Vec::new());
        }

        unsafe extern "system" fn test_hook_proc(
            code: i32,
            w_param: usize,
            l_param: isize,
        ) -> isize {
            if code >= 0 {
                let kb = unsafe { &*(l_param as *const KBDLLHOOKSTRUCT) };
                let msg = w_param as u32;
                if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                    TEST_HITS.with(|cell| {
                        cell.borrow_mut().push(kb.vkCode);
                    });
                }
            }
            unsafe { CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param) }
        }

        TEST_HITS.with(|cell| cell.borrow_mut().clear());

        let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(test_hook_proc), hmod, 0) };
        assert!(
            !hook.is_null(),
            "SetWindowsHookExW failed: {}",
            std::io::Error::last_os_error()
        );

        let mut inputs = [kbd_down(VK_F13), kbd_up(VK_F13)];
        let sent =
            unsafe { SendInput(2, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
        eprintln!("  SendInput returned {sent}");

        pump_messages(Duration::from_millis(300));

        let hits = TEST_HITS.with(|cell| cell.borrow().clone());
        eprintln!("  Hook received {} key-down events: {:?}", hits.len(), hits);

        let f13_hit = hits.iter().any(|vk| *vk == VK_F13 as u32);
        if f13_hit {
            eprintln!("  RESULT: LL hook CAN catch simple F13 via SendInput");
        } else {
            eprintln!("  RESULT: LL hook CANNOT catch F13 — hook callbacks not firing!");
        }

        unsafe { UnhookWindowsHookEx(hook) };

        assert!(f13_hit, "LL hook should receive F13 keydown from SendInput");
    }
}
