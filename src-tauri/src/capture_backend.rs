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

/// "Menu Mask Key" — an unassigned VK used to prevent Windows from activating
/// menus/ribbon (SC_KEYMENU) or the Start menu when Alt or Win is released
/// after a hotkey combo.  Injecting this between modifier-down and modifier-up
/// makes DefWindowProc think a non-modifier key was pressed, suppressing the
/// system activation.  Pattern borrowed from AutoHotkey v2.
#[cfg(target_os = "windows")]
const VK_MASK_KEY: u16 = 0xE8;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncodedKeyEvent {
    pub encoded_key: String,
    pub backend: String,
    pub received_at: u64,
    pub is_repeat: bool,
    pub is_key_up: bool,
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

    /// Send a REHOOK command to the capture helper, causing it to reinstall
    /// its WH_KEYBOARD_LL hook without restarting the entire runtime.
    pub fn rehook(&mut self) -> Result<(), String> {
        match &mut self.backend {
            Some(backend) => backend.rehook(),
            None => Err("Runtime is not running.".to_owned()),
        }
    }
}

struct CaptureBackendHandle {
    hook_thread_id: u32,
    hook_thread: JoinHandle<()>,
    worker_thread: JoinHandle<()>,
    helper: Option<HelperHandle>,
    foreground_watcher_thread_id: Option<u32>,
    foreground_watcher_thread: Option<JoinHandle<()>>,
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
                let mut held_actions: std::collections::HashMap<String, crate::input_synthesis::HeldShortcutState> =
                    std::collections::HashMap::new();

                while let Ok(event) = event_rx.recv() {
                    process_encoded_key_event(
                        &worker_app,
                        &worker_runtime_store,
                        &worker_config,
                        &worker_app_name,
                        event,
                        &mut held_actions,
                    );
                }

                // Channel closed (graceful shutdown) — release all held keys
                for (encoded_key, held) in held_actions.drain() {
                    if let Err(e) = crate::input_synthesis::send_shortcut_hold_up(&held) {
                        log::warn!("[capture] Failed to release held shortcut `{encoded_key}` on shutdown: {e}");
                    }
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

            // Spawn foreground window watcher — detects window switches instantly
            let fg_app = app.clone();
            let fg_runtime_store = runtime_store.clone();
            let fg_config = config.clone();
            let fg_app_name = app_name.clone();
            let (fg_ready_tx, fg_ready_rx) = mpsc::channel::<u32>();
            let foreground_watcher_thread = thread::spawn(move || {
                run_foreground_watcher(fg_app, fg_runtime_store, fg_config, fg_app_name, fg_ready_tx);
            });
            let foreground_watcher_thread_id = fg_ready_rx.recv().ok();

            Ok(Self {
                hook_thread_id,
                hook_thread,
                worker_thread,
                helper,
                foreground_watcher_thread_id,
                foreground_watcher_thread: Some(foreground_watcher_thread),
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

            // Stop foreground watcher thread
            if let Some(fg_thread_id) = self.foreground_watcher_thread_id {
                unsafe { PostThreadMessageW(fg_thread_id, WM_QUIT, 0, 0) };
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
        if let Some(fg_thread) = self.foreground_watcher_thread {
            let _ = fg_thread.join();
        }
        Ok(())
    }

    fn rehook(&mut self) -> Result<(), String> {
        if let Some(ref mut helper) = self.helper {
            helper.send_command("REHOOK")
        } else {
            Err("No capture helper process is running.".to_owned())
        }
    }
}

impl HelperHandle {
    fn send_command(&mut self, cmd: &str) -> Result<(), String> {
        use std::io::Write;
        writeln!(self.stdin_pipe, "{cmd}")
            .and_then(|()| self.stdin_pipe.flush())
            .map_err(|e| format!("Failed to send command to helper: {e}"))
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

/// dwExtraInfo marker for hook health probe events.  Distinct from
/// `INTERNAL_SENDINPUT_EXTRA_INFO` so the hook callback can tell them apart.
#[cfg(target_os = "windows")]
const HOOK_PROBE_EXTRA_INFO: usize = 0x4E41_4741_5052_4F42usize;

/// VK used for probe injection (same unassigned key as the mask key).
#[cfg(target_os = "windows")]
const VK_PROBE_KEY: u16 = 0xE8;

/// How often the health monitor checks (milliseconds).
#[cfg(target_os = "windows")]
const HOOK_HEALTH_CHECK_INTERVAL_MS: u32 = 5000;

// Thread-local state for the capture helper's LL keyboard hook callback.
#[cfg(target_os = "windows")]
thread_local! {
    static HELPER_REGISTRATIONS: std::cell::RefCell<Vec<HelperRegistration>> =
        std::cell::RefCell::new(Vec::new());
    static HELPER_MODIFIERS: std::cell::RefCell<HelperModifierState> =
        std::cell::RefCell::new(HelperModifierState::default());
    static HELPER_SUPPRESSIONS: std::cell::RefCell<std::collections::HashMap<u32, String>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static HELPER_MATCHES: std::cell::RefCell<Vec<String>> =
        std::cell::RefCell::new(Vec::new());
    static HELPER_THREAD_ID: std::cell::Cell<u32> = std::cell::Cell::new(0);
    /// Set to `true` by the hook callback when it receives a probe event
    /// (dwExtraInfo == HOOK_PROBE_EXTRA_INFO).  Consumed by the health monitor.
    static HELPER_PROBE_RECEIVED: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

#[cfg(target_os = "windows")]
/// Returns `(suppress_key, new_match_added, inject_mask_key)`.
///
/// `inject_mask_key` is `true` when a combo matched while Alt or Win was active.
/// The caller must inject VK 0xE8 (down+up) via SendInput before returning from
/// the LL hook callback — this prevents Windows from generating SC_KEYMENU (Alt)
/// or activating the Start menu (Win).
fn process_helper_key_event(
    regs: &[HelperRegistration],
    modifiers: &mut HelperModifierState,
    suppressions: &mut std::collections::HashMap<u32, String>,
    matches: &mut Vec<String>,
    vk: u32,
    msg: u32,
) -> (bool, bool, bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    match msg {
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            if modifiers.apply_vk_event(vk, true) {
                return (false, false, false);
            }

            for reg in regs.iter() {
                if reg.primary_vk == vk && modifiers.matches_mask(reg.modifiers_mask) {
                    let is_repeat = suppressions.contains_key(&vk);
                    if !is_repeat {
                        suppressions.insert(vk, reg.encoded_key.clone());
                    }
                    if !is_repeat {
                        matches.push(reg.encoded_key.clone());
                    }
                    // Inject mask key if Alt or Win is active — prevents
                    // SC_KEYMENU (ribbon/menu activation) and Start menu.
                    let need_mask = !is_repeat && (modifiers.alt || modifiers.win);
                    return (true, !is_repeat, need_mask);
                }
            }

            (false, false, false)
        }
        WM_KEYUP | WM_SYSKEYUP => {
            if modifiers.apply_vk_event(vk, false) {
                (false, false, false)
            } else if let Some(encoded_key) = suppressions.remove(&vk) {
                matches.push(format!("UP:{encoded_key}"));
                (true, true, false)
            } else {
                (false, false, false)
            }
        }
        _ => (false, false, false),
    }
}

/// Inject VK 0xE8 (down + up) via SendInput.  This "Menu Mask Key" prevents
/// Windows from generating SC_KEYMENU or activating the Start menu when the
/// only keys between a modifier-down and modifier-up were suppressed by our
/// hook.  The events carry `INTERNAL_SENDINPUT_EXTRA_INFO` so our LL hook
/// passes them through without processing.
#[cfg(target_os = "windows")]
unsafe fn inject_mask_key() {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };

    let make_input = |key_up: bool| -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_MASK_KEY,
                    wScan: 0,
                    dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
                },
            },
        }
    };

    let inputs = [make_input(false), make_input(true)];
    SendInput(
        inputs.len() as u32,
        inputs.as_ptr(),
        size_of::<INPUT>() as i32,
    );
}

/// Inject a VK 0xE8 probe event via SendInput to test hook health.
/// The event carries `HOOK_PROBE_EXTRA_INFO` so the hook callback can
/// recognize it and set the `HELPER_PROBE_RECEIVED` flag without treating
/// it as a real key event.
#[cfg(target_os = "windows")]
unsafe fn inject_hook_probe() {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };

    let make_input = |key_up: bool| -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_PROBE_KEY,
                    wScan: 0,
                    dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: HOOK_PROBE_EXTRA_INFO,
                },
            },
        }
    };

    let inputs = [make_input(false), make_input(true)];
    SendInput(
        inputs.len() as u32,
        inputs.as_ptr(),
        size_of::<INPUT>() as i32,
    );
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
        // Probe event from the health monitor — acknowledge and pass through.
        if kb.dwExtraInfo == HOOK_PROBE_EXTRA_INFO {
            HELPER_PROBE_RECEIVED.with(|cell| cell.set(true));
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
        }

        let internal_injection =
            kb.dwExtraInfo == crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO;

        if internal_injection {
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
        }

        // Returns (suppress_key, new_match_added, inject_mask_key)
        let (suppress, wake, inject_mask) = HELPER_MODIFIERS.with(|mods_cell| {
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

        // AHK-style "Menu Mask Key": inject VK 0xE8 (down+up) to prevent
        // Windows from interpreting bare Alt-up or Win-up as menu / Start
        // activation.  The injected events carry INTERNAL_SENDINPUT_EXTRA_INFO
        // so our own hook passes them straight through — the 2 re-entrant
        // hook calls cost microseconds, well within LowLevelHooksTimeout.
        if inject_mask {
            inject_mask_key();
        }

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
    // Initialize a stderr logger for the helper subprocess (no Tauri runtime here).
    env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .target(env_logger::Target::Stderr)
        .init();

    use std::io::BufRead;
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        Foundation::{WAIT_FAILED, WAIT_TIMEOUT},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::WindowsAndMessaging::{
            DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW, PostThreadMessageW,
            SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, MSG, MWMO_INPUTAVAILABLE,
            PM_REMOVE, QS_ALLINPUT, WH_KEYBOARD_LL, WM_QUIT,
        },
    };

    // 1. Read registrations from stdin (one JSON line)
    let stdin = std::io::stdin();
    let mut line = String::new();
    if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 {
        log::warn!("[capture-helper] No input received on stdin, exiting.");
        return;
    }

    let registrations: Vec<HelperRegistration> = match serde_json::from_str(line.trim()) {
        Ok(regs) => regs,
        Err(e) => {
            log::error!("[capture-helper] Failed to parse registrations: {e}");
            return;
        }
    };

    if registrations.is_empty() {
        log::warn!("[capture-helper] No registrations, exiting.");
        return;
    }

    log::info!(
        "[capture-helper] Loaded {} modifier-combo registrations.",
        registrations.len()
    );

    // 2. Initialize thread-local state for the LL hook callback
    HELPER_REGISTRATIONS.with(|cell| *cell.borrow_mut() = registrations);
    HELPER_MODIFIERS.with(|cell| *cell.borrow_mut() = HelperModifierState::default());
    HELPER_SUPPRESSIONS.with(|cell| cell.borrow_mut().clear());
    HELPER_MATCHES.with(|cell| cell.borrow_mut().clear());

    // 2b. Elevate thread priority — LL hook callbacks must return within the
    //     LowLevelHooksTimeout (~200-300ms) or Windows silently removes the
    //     hook.  TIME_CRITICAL (priority 15) ensures our thread gets CPU time
    //     even under heavy load.  Pattern from AutoHotkey v2 (hook.cpp:4004).
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
    log::info!("[capture-helper] Thread priority set to TIME_CRITICAL.");

    // 3. Install WH_KEYBOARD_LL hook
    let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(helper_ll_keyboard_proc), hmod, 0) };
    if hook.is_null() {
        log::error!(
            "[capture-helper] SetWindowsHookExW failed: {}",
            std::io::Error::last_os_error()
        );
        return;
    }
    log::info!("[capture-helper] LL keyboard hook installed successfully.");

    // 4. Spawn stdin watcher — reads commands from parent.
    //    "REHOOK" → reinstall LL hook (WM_APP + 1)
    //    stdin close → exit (WM_QUIT)
    const WM_REHOOK: u32 = 0x8000 + 1; // WM_APP + 1
    let hook_tid = unsafe { GetCurrentThreadId() };
    HELPER_THREAD_ID.with(|cell| cell.set(hook_tid));
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = String::new();
        loop {
            buf.clear();
            match stdin.lock().read_line(&mut buf) {
                Ok(0) | Err(_) => {
                    log::info!("[capture-helper] stdin closed, posting WM_QUIT.");
                    unsafe { PostThreadMessageW(hook_tid, WM_QUIT, 0, 0); }
                    break;
                }
                Ok(_) => {
                    let cmd = buf.trim();
                    if cmd == "REHOOK" {
                        log::info!("[capture-helper] REHOOK command received.");
                        unsafe { PostThreadMessageW(hook_tid, WM_REHOOK, 0, 0); }
                    } else {
                        log::warn!("[capture-helper] Unknown command: {cmd:?}");
                    }
                }
            }
        }
    });

    // 5. Message pump — drives the LL hook callbacks.
    //    Uses MsgWaitForMultipleObjectsEx instead of GetMessageW so we get a
    //    periodic timeout for hook health monitoring.  Windows silently removes
    //    WH_KEYBOARD_LL hooks when the callback exceeds LowLevelHooksTimeout
    //    (~200-300 ms) and provides NO notification, so we must self-test.
    let stdout_handle = std::io::stdout();
    let mut stdout = stdout_handle.lock();
    let mut msg = MaybeUninit::<MSG>::zeroed();
    let mut hook = hook; // make mutable for reinstallation
    let mut probe_sent = false;
    let mut hook_reinstall_count: u32 = 0;

    loop {
        // Wait for messages OR timeout (health check interval).
        let wait_result = unsafe {
            MsgWaitForMultipleObjectsEx(
                0,
                std::ptr::null(),
                HOOK_HEALTH_CHECK_INTERVAL_MS,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            )
        };

        if wait_result == WAIT_FAILED {
            log::warn!(
                "[capture-helper] MsgWaitForMultipleObjectsEx failed: {}",
                std::io::Error::last_os_error()
            );
            // Continue the loop — next iteration will retry.
            continue;
        }

        if wait_result == WAIT_TIMEOUT {
            // No messages arrived within the interval — run health check.
            if probe_sent {
                // We sent a probe last cycle.  Check if the hook saw it.
                let received = HELPER_PROBE_RECEIVED.with(|cell| cell.replace(false));
                if received {
                    // Hook is alive.
                    probe_sent = false;
                } else {
                    // Hook is dead — reinstall it.
                    log::warn!(
                        "[capture-helper] Hook health probe not received — \
                         hook appears dead.  Reinstalling WH_KEYBOARD_LL..."
                    );
                    unsafe { UnhookWindowsHookEx(hook); }
                    let new_hook = unsafe {
                        SetWindowsHookExW(WH_KEYBOARD_LL, Some(helper_ll_keyboard_proc), hmod, 0)
                    };
                    if new_hook.is_null() {
                        log::error!(
                            "[capture-helper] Failed to reinstall hook: {}. Exiting.",
                            std::io::Error::last_os_error()
                        );
                        break;
                    }
                    hook = new_hook;
                    hook_reinstall_count += 1;
                    log::info!(
                        "[capture-helper] Hook reinstalled successfully \
                         (total reinstalls: {hook_reinstall_count})."
                    );
                    probe_sent = false;
                }
            } else {
                // Send a probe to test whether the hook is alive.
                unsafe { inject_hook_probe(); }
                probe_sent = true;
                HELPER_PROBE_RECEIVED.with(|cell| cell.set(false));
            }
            // Fall through to pump any messages that may have arrived.
        }

        // Pump all pending messages (PeekMessageW is non-blocking).
        loop {
            let found = unsafe {
                PeekMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0, PM_REMOVE)
            };
            if found == 0 {
                break;
            }

            let m = unsafe { msg.assume_init() };
            if m.message == WM_QUIT {
                // Drain any remaining matches before exiting.
                drain_helper_matches(&mut stdout);
                unsafe { UnhookWindowsHookEx(hook); }
                log::info!("[capture-helper] Hook uninstalled, exiting.");
                return;
            }
            if m.message == WM_REHOOK {
                log::info!("[capture-helper] REHOOK: reinstalling WH_KEYBOARD_LL...");
                unsafe { UnhookWindowsHookEx(hook); }
                let new_hook = unsafe {
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(helper_ll_keyboard_proc), hmod, 0)
                };
                if new_hook.is_null() {
                    log::error!(
                        "[capture-helper] Failed to reinstall hook on REHOOK: {}. Exiting.",
                        std::io::Error::last_os_error()
                    );
                    break;
                }
                hook = new_hook;
                hook_reinstall_count += 1;
                probe_sent = false;
                log::info!(
                    "[capture-helper] Hook reinstalled via REHOOK \
                     (total reinstalls: {hook_reinstall_count})."
                );
                continue;
            }

            // Drain matches buffered by the hook callback.
            drain_helper_matches(&mut stdout);

            unsafe {
                TranslateMessage(&m);
                DispatchMessageW(&m);
            }

            // Also drain after dispatch (hooks may fire during DispatchMessageW).
            drain_helper_matches(&mut stdout);
        }

        // If the probe was just received inline (during message pumping after
        // we injected it), acknowledge it immediately so we don't have to wait
        // another full interval.
        if probe_sent {
            let received = HELPER_PROBE_RECEIVED.with(|cell| cell.replace(false));
            if received {
                probe_sent = false;
            }
        }
    }

    // 6. Cleanup (reached only on reinstall failure)
    log::info!("[capture-helper] Exiting message pump.");
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
    log::error!("[capture-helper] Only supported on Windows.");
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
            log::warn!("[capture] Failed to get current exe path for helper: {e}");
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
            log::warn!("[capture] Failed to spawn capture helper: {e}");
            return None;
        }
    };

    let mut stdin_pipe = child.stdin.take().expect("stdin was piped");
    let stdout_pipe = child.stdout.take().expect("stdout was piped");

    // Write registrations as a JSON line to the helper's stdin
    let json = match serde_json::to_string(&helper_regs) {
        Ok(j) => j,
        Err(e) => {
            log::warn!("[capture] Failed to serialize helper registrations: {e}");
            let _ = child.kill();
            return None;
        }
    };

    let write_result = writeln!(stdin_pipe, "{json}").and_then(|()| stdin_pipe.flush());
    if let Err(e) = write_result {
        log::warn!("[capture] Failed to write to helper stdin: {e}");
        let _ = child.kill();
        return None;
    }

    log::info!(
        "[capture] Capture helper spawned (pid {}), {} modifier-combo registrations.",
        child.id(),
        helper_regs.len()
    );

    // Reader thread: reads encoded keys from helper stdout, converts to events
    let reader_thread = thread::spawn(move || {
        use std::io::BufRead;

        let reader = std::io::BufReader::new(stdout_pipe);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let (is_key_up, encoded_key) = if let Some(rest) = trimmed.strip_prefix("UP:") {
                (true, rest.to_owned())
            } else {
                (false, trimmed.to_owned())
            };
            let _ = event_tx.send(EncodedKeyEvent {
                encoded_key,
                backend: BACKEND_LL_HOOK.into(),
                received_at: runtime::timestamp_millis(),
                is_repeat: false,
                is_key_up,
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

    // Elevate thread priority (AHK pattern) — RegisterHotKey thread also
    // benefits from responsive message processing.
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }

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
            let hint = if last_error.raw_os_error() == Some(5) {
                // ERROR_ACCESS_DENIED (5) — another process (likely elevated)
                // already owns this hotkey and UIPI blocks our registration.
                " Hotkey may be owned by an elevated process. \
                 Try running as administrator."
            } else {
                ""
            };
            let _ = ready_tx.send(Err(format!(
                "RegisterHotKey failed for `{}`. {last_error}{hint}",
                reg.encoded_key
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
                    is_key_up: false,
                });
            } else {
                log::warn!("[capture] Received WM_HOTKEY with unrecognized id {hotkey_id}");
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

// ---------------------------------------------------------------------------
// Foreground window watcher — detects window switches instantly via WinEvent
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn run_foreground_watcher(
    app: AppHandle,
    runtime_store: Arc<Mutex<RuntimeStore>>,
    config: AppConfig,
    app_name: String,
    ready_tx: mpsc::Sender<u32>,
) {
    use std::cell::RefCell;
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        System::Threading::GetCurrentThreadId,
        UI::Accessibility::{SetWinEventHook, UnhookWinEvent},
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, TranslateMessage, MSG,
        },
    };

    // Thread-local storage for the callback to access our context.
    thread_local! {
        static FG_CTX: RefCell<Option<ForegroundWatcherCtx>> = const { RefCell::new(None) };
    }

    struct ForegroundWatcherCtx {
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    }

    unsafe extern "system" fn winevent_callback(
        _hook: *mut std::ffi::c_void,
        _event: u32,
        _hwnd: *mut std::ffi::c_void,
        _id_object: i32,
        _id_child: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        FG_CTX.with(|cell| {
            let borrow = cell.borrow();
            let Some(ctx) = borrow.as_ref() else { return };

            // Skip auto-profile-switching while a manual window capture is
            // in progress (the user is Alt+Tabbing to the target window).
            {
                let is_capturing = ctx
                    .runtime_store
                    .lock()
                    .ok()
                    .map(|store| store.is_capture_in_progress())
                    .unwrap_or(false);
                if is_capturing {
                    log::debug!("[capture] Foreground change ignored (capture in progress)");
                    return;
                }
            }

            let capture_result = match window_capture::capture_active_window_with_resolution(
                &ctx.config,
                &ctx.app_name,
                None,
            ) {
                Ok(result) => result,
                Err(_) => return,
            };

            let _ = ctx.app.emit(runtime::EVENT_PROFILE_RESOLVED, &capture_result);

            if !capture_result.ignored {
                let should_notify = ctx
                    .runtime_store
                    .lock()
                    .ok()
                    .map(|mut store| {
                        store.notify_profile_change(capture_result.resolved_profile_id.as_deref())
                    })
                    .unwrap_or(false);
                if should_notify {
                    let profile_name = capture_result
                        .resolved_profile_name
                        .as_deref()
                        .unwrap_or("Default");
                    crate::show_osd(&ctx.app, profile_name);
                }
            }
        });
    }

    // Store context in thread-local
    FG_CTX.with(|cell| {
        *cell.borrow_mut() = Some(ForegroundWatcherCtx {
            app,
            runtime_store,
            config,
            app_name,
        });
    });

    const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;

    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            std::ptr::null_mut(), // no DLL — callback in our process
            Some(winevent_callback),
            0, // all processes
            0, // all threads
            0, // WINEVENT_OUTOFCONTEXT (default)
        )
    };

    if hook.is_null() {
        log::warn!("[capture] SetWinEventHook(EVENT_SYSTEM_FOREGROUND) failed.");
        let _ = ready_tx.send(0);
        return;
    }

    let thread_id = unsafe { GetCurrentThreadId() };
    let _ = ready_tx.send(thread_id);

    // Message loop — required for WinEvent callbacks to fire
    let mut msg = MaybeUninit::<MSG>::zeroed();
    loop {
        let status = unsafe { GetMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0) };
        if status <= 0 {
            break;
        }
        unsafe {
            let m = msg.assume_init();
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    }

    unsafe { UnhookWinEvent(hook) };

    // Clean up thread-local
    FG_CTX.with(|cell| {
        *cell.borrow_mut() = None;
    });
}

#[cfg(not(target_os = "windows"))]
fn run_foreground_watcher(
    _app: AppHandle,
    _runtime_store: Arc<Mutex<RuntimeStore>>,
    _config: AppConfig,
    _app_name: String,
    _ready_tx: mpsc::Sender<u32>,
) {
    // No foreground watcher on non-Windows platforms.
}

fn process_encoded_key_event(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    app_name: &str,
    event: EncodedKeyEvent,
    held_actions: &mut std::collections::HashMap<String, crate::input_synthesis::HeldShortcutState>,
) {
    // Accumulate log entries locally and flush in a single lock at the end to
    // avoid acquiring the runtime_store mutex multiple times per keypress.
    let mut log_entries: Vec<(&str, String, bool)> = Vec::new(); // (source, message, is_warn)

    log_entries.push((
        "перехват",
        format!(
            "Получен сигнал `{}` от бэкенда перехвата.",
            event.encoded_key
        ),
        false,
    ));

    let _ = app.emit(EVENT_ENCODED_KEY_RECEIVED, &event);

    // --- Key-up path: release any held shortcut ---
    if event.is_key_up {
        if let Some(held) = held_actions.remove(&event.encoded_key) {
            match crate::input_synthesis::send_shortcut_hold_up(&held) {
                Ok(()) => {
                    log_entries.push((
                        "выполнение",
                        format!("Отпущен удерживаемый шорткат для `{}`.", event.encoded_key),
                        false,
                    ));
                }
                Err(e) => {
                    log_entries.push((
                        "выполнение",
                        format!("Не удалось отпустить шорткат для `{}`: {e}", event.encoded_key),
                        true,
                    ));
                }
            }
        } else {
            log_entries.push((
                "перехват",
                format!("Отпускание `{}` без активного удержания.", event.encoded_key),
                false,
            ));
        }
        flush_log_entries(runtime_store, log_entries);
        return;
    }

    let capture_result =
        match window_capture::capture_active_window_with_resolution(config, app_name, None) {
            Ok(result) => result,
            Err(message) => {
                let error = RuntimeErrorEvent {
                    category: "захват окна".into(),
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

    // Send OSD notification if active profile changed
    if !capture_result.ignored {
        let should_notify = runtime_store
            .lock()
            .ok()
            .map(|mut store| {
                store.notify_profile_change(capture_result.resolved_profile_id.as_deref())
            })
            .unwrap_or(false);
        if should_notify {
            let profile_name = capture_result
                .resolved_profile_name
                .as_deref()
                .unwrap_or("Default");
            crate::show_osd(app, profile_name);
        }
    }

    if capture_result.ignored {
        log_entries.push((
            "перехват",
            "Окно студии — используется fallback-профиль.".into(),
            false,
        ));
    }

    // Resolve action — use empty exe/title when ignored (forces fallback profile)
    let (exe, title) = if capture_result.ignored {
        (String::new(), String::new())
    } else {
        (capture_result.exe.clone(), capture_result.title.clone())
    };

    let preview = resolver::resolve_input_preview(
        config,
        &event.encoded_key,
        &exe,
        &title,
    );

    match preview.status {
        resolver::ResolutionStatus::Resolved => {
            log_entries.push((
                "разрешение",
                format!(
                    "Сигнал `{}` разрешён в `{}` / `{}`.",
                    preview.encoded_key,
                    preview.control_id.as_deref().unwrap_or("н/д"),
                    preview.layer.as_deref().unwrap_or("н/д")
                ),
                false,
            ));
        }
        resolver::ResolutionStatus::Unresolved | resolver::ResolutionStatus::Ambiguous => {
            log_entries.push((
                "разрешение",
                format!(
                    "Сигнал `{}` не удалось разрешить: {}",
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

    // Modifier-only shortcuts (Ctrl+Alt, Ctrl+Shift, etc.) are forced to hold
    // mode regardless of configured trigger mode — in tap mode they press and
    // immediately release modifiers, which is useless.
    let is_modifier_only_shortcut = preview.action_type.as_deref() == Some("shortcut")
        && config
            .actions
            .iter()
            .find(|a| Some(a.id.as_str()) == preview.action_id.as_deref())
            .and_then(|a| match &a.payload {
                crate::config::ActionPayload::Shortcut(p) => Some(p.key.trim().is_empty()),
                _ => None,
            })
            .unwrap_or(false);

    let is_hold_shortcut = preview.action_type.as_deref() == Some("shortcut")
        && (preview.trigger_mode == Some(crate::config::TriggerMode::Hold)
            || is_modifier_only_shortcut);

    if is_hold_shortcut {
        let action = config
            .actions
            .iter()
            .find(|a| Some(a.id.as_str()) == preview.action_id.as_deref());

        if let Some(crate::config::Action {
            payload: crate::config::ActionPayload::Shortcut(payload),
            ..
        }) = action
        {
            let encoding_mods = hotkeys::extract_encoding_modifiers(&event.encoded_key);
            match crate::input_synthesis::send_shortcut_hold_down(payload, &encoding_mods) {
                Ok(held) => {
                    log_entries.push((
                        "выполнение",
                        format!(
                            "Удержание шортката `{}` для `{}`.",
                            preview.action_pretty.as_deref().unwrap_or("?"),
                            preview.encoded_key
                        ),
                        false,
                    ));
                    flush_log_entries(runtime_store, log_entries);
                    held_actions.insert(event.encoded_key.clone(), held);
                    let _ = app.emit(
                        EVENT_ACTION_EXECUTED,
                        &executor::ActionExecutionEvent {
                            encoded_key: preview.encoded_key.clone(),
                            action_id: preview.action_id.clone().unwrap_or_default(),
                            action_type: "shortcut".into(),
                            action_pretty: preview.action_pretty.clone().unwrap_or_default(),
                            resolved_profile_id: preview.resolved_profile_id.clone(),
                            resolved_profile_name: preview.resolved_profile_name.clone(),
                            matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
                            control_id: preview.control_id.clone(),
                            layer: preview.layer.clone(),
                            binding_id: preview.binding_id.clone(),
                            mode: executor::ExecutionMode::Live,
                            outcome: executor::ExecutionOutcome::Injected,
                            process_id: None,
                            summary: format!(
                                "Удержание шортката `{}`.",
                                preview.action_pretty.as_deref().unwrap_or("?")
                            ),
                            warnings: Vec::new(),
                            executed_at: runtime::timestamp_millis(),
                        },
                    );
                }
                Err(e) => {
                    let error_event = executor::RuntimeErrorEvent {
                        category: "выполнение".into(),
                        message: e,
                        encoded_key: Some(event.encoded_key.clone()),
                        action_id: preview.action_id.clone(),
                        created_at: runtime::timestamp_millis(),
                    };
                    flush_log_entries(runtime_store, log_entries);
                    emit_runtime_error(app, runtime_store, &error_event);
                }
            }
        } else {
            // Hold requested but action is not a shortcut — fall back to press
            log_entries.push((
                "выполнение",
                "Запрошено удержание, но действие не шорткат; переключение на нажатие.".into(),
                true,
            ));
            run_fire_and_forget(app, runtime_store, config, &preview, &event, log_entries);
        }
    } else {
        run_fire_and_forget(app, runtime_store, config, &preview, &event, log_entries);
    }
}

fn run_fire_and_forget(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    preview: &resolver::ResolvedInputPreview,
    _event: &EncodedKeyEvent,
    mut log_entries: Vec<(&str, String, bool)>,
) {
    log::info!(
        "[capture] Dispatching action for {}",
        preview.encoded_key
    );
    match executor::run_preview_action(config, preview) {
        Ok(execution) => {
            log::info!(
                "[capture] Action complete for {} (outcome: {:?})",
                execution.encoded_key,
                execution.outcome
            );
            log_entries.push((
                "выполнение",
                format!(
                    "Выполнено `{}` для `{}`.",
                    execution.action_pretty, execution.encoded_key
                ),
                false,
            ));
            for warning in &execution.warnings {
                log_entries.push(("выполнение", warning.clone(), true));
            }
            flush_log_entries(runtime_store, log_entries);
            let _ = app.emit(EVENT_ACTION_EXECUTED, &execution);
        }
        Err(error) => {
            log::error!(
                "[capture] Action failed for {}: {}",
                preview.encoded_key,
                error.event.message
            );
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
        log::error!("[capture] runtime_store mutex poisoned while flushing log entries");
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
        log::error!(
            "[{}] runtime_store mutex poisoned while recording runtime error: {}",
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

#[cfg(test)]
#[cfg(target_os = "windows")]
mod helper_key_event_tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_KEYUP};

    const VK_F24: u32 = 0x87;

    fn reg(encoded_key: &str, modifiers_mask: u32, primary_vk: u32) -> HelperRegistration {
        HelperRegistration {
            encoded_key: encoded_key.into(),
            modifiers_mask,
            primary_vk,
        }
    }

    #[test]
    fn key_up_emits_release_event() {
        let regs = vec![reg("Ctrl+Shift+F24", MOD_CONTROL | MOD_SHIFT, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // Simulate Ctrl down, Shift down, F24 down
        modifiers.apply_vk_event(VK_LCONTROL, true);
        modifiers.apply_vk_event(VK_LSHIFT, true);
        let (suppress, wake, _inject_mask) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        assert_eq!(matches, vec!["Ctrl+Shift+F24"]);
        matches.clear();

        // Simulate F24 up — should emit UP: event
        let (suppress, wake, _inject_mask) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYUP,
        );
        assert!(suppress);
        assert!(wake, "key-up of suppressed key should wake for drain");
        assert_eq!(matches, vec!["UP:Ctrl+Shift+F24"]);
    }

    #[test]
    fn key_up_of_unsuppressed_key_does_not_emit() {
        let regs = vec![reg("Ctrl+Shift+F24", MOD_CONTROL | MOD_SHIFT, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // F24 up without prior down — should not emit
        let (suppress, wake, _inject_mask) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYUP,
        );
        assert!(!suppress);
        assert!(!wake);
        assert!(matches.is_empty());
    }
}

// ---------------------------------------------------------------------------
// Diagnostic tests — verify Win32 capture mechanisms via SendInput
// Run with: cargo test -p sidearm capture_diag -- --nocapture
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
        log::debug!("\n=== TEST: RegisterHotKey + SendInput(F13) ===");
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
        log::debug!("  SendInput returned {sent}");

        let received = poll_wm_hotkey(Duration::from_millis(500));
        log::debug!("  WM_HOTKEY received: {:?} (expected Some({id}))", received);

        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };

        assert_eq!(
            received,
            Some(id),
            "RegisterHotKey should catch SendInput(F13)"
        );
    }

    #[test]
    fn diag_register_hotkey_ctrl_shift_f23() {
        log::debug!("\n=== TEST: RegisterHotKey + SendInput(Ctrl+Shift+F23) ===");
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
        log::debug!("  SendInput returned {sent}");

        let received = poll_wm_hotkey(Duration::from_millis(500));
        log::debug!(
            "  WM_HOTKEY received: {:?} (expected Some({id}) if working)",
            received
        );

        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };

        // This test documents behavior — it may or may not pass depending on system
        if received.is_some() {
            log::debug!("  RESULT: RegisterHotKey CAN catch Ctrl+Shift+F23 via SendInput");
        } else {
            log::debug!("  RESULT: RegisterHotKey CANNOT catch Ctrl+Shift+F23 via SendInput");
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

        log::debug!("\n=== TEST: WH_KEYBOARD_LL + SendInput(Ctrl+Shift+F23) ===");

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
        log::debug!("  GetModuleHandleW(NULL) = {:?}", hmod);

        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(test_hook_proc), hmod, 0) };
        log::debug!("  SetWindowsHookExW result: {:?} (null=failed)", hook);
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
        log::debug!("  SendInput returned {sent}");

        // Pump messages to let hook callbacks fire
        pump_messages(Duration::from_millis(300));

        let hits = TEST_HOOK.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|s| s.hits.clone())
                .unwrap_or_default()
        });

        log::debug!("  Hook received {} key-down events:", hits.len());
        for (vk, ctrl, shift) in &hits {
            let name = match *vk as u16 {
                0x11 => "VK_CONTROL",
                0x10 => "VK_SHIFT",
                0x86 => "VK_F23",
                other => {
                    log::debug!("    vk=0x{other:02X} ctrl={ctrl} shift={shift}");
                    continue;
                }
            };
            log::debug!("    {name} (0x{vk:02X}) ctrl={ctrl} shift={shift}");
        }

        let f23_hit = hits.iter().find(|(vk, _, _)| *vk == VK_F23 as u32);
        if let Some((_, ctrl, shift)) = f23_hit {
            log::debug!("  RESULT: LL hook DID catch F23. ctrl={ctrl}, shift={shift}");
            if *ctrl && *shift {
                log::debug!(
                    "  RESULT: Modifier state CORRECT — LL hook can intercept Ctrl+Shift+F23"
                );
            } else {
                log::debug!("  RESULT: Modifier state WRONG — GetAsyncKeyState unreliable in hook");
            }
        } else {
            log::debug!("  RESULT: LL hook did NOT receive F23 key event at all!");
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

        log::debug!("\n=== TEST: WH_KEYBOARD_LL + SendInput(F13) ===");

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
        log::debug!("  SendInput returned {sent}");

        pump_messages(Duration::from_millis(300));

        let hits = TEST_HITS.with(|cell| cell.borrow().clone());
        log::debug!("  Hook received {} key-down events: {:?}", hits.len(), hits);

        let f13_hit = hits.iter().any(|vk| *vk == VK_F13 as u32);
        if f13_hit {
            log::debug!("  RESULT: LL hook CAN catch simple F13 via SendInput");
        } else {
            log::debug!("  RESULT: LL hook CANNOT catch F13 — hook callbacks not firing!");
        }

        unsafe { UnhookWindowsHookEx(hook) };

        assert!(f13_hit, "LL hook should receive F13 keydown from SendInput");
    }
}
