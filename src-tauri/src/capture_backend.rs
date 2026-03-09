use serde::Serialize;
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

use crate::{
    config::AppConfig,
    executor::{self, RuntimeErrorEvent},
    hotkeys,
    resolver,
    runtime::{
        RuntimeStore, EVENT_ACTION_EXECUTED, EVENT_CONTROL_RESOLVED, EVENT_ENCODED_KEY_RECEIVED,
        EVENT_PROFILE_RESOLVED, EVENT_RUNTIME_ERROR,
    },
    window_capture,
};

pub const CAPTURE_BACKEND_NAME: &str = "windows-register-hotkey";

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

            let hook_thread = thread::spawn(move || {
                run_hotkey_message_loop(registrations, event_tx, ready_tx);
            });

            let hook_thread_id = match ready_rx.recv() {
                Ok(Ok(thread_id)) => thread_id,
                Ok(Err(error)) => {
                    let _ = hook_thread.join();
                    let _ = worker_thread.join();
                    return Err(error);
                }
                Err(error) => {
                    let _ = hook_thread.join();
                    let _ = worker_thread.join();
                    return Err(format!("Failed to receive capture backend readiness: {error}"));
                }
            };

            Ok(Self {
                hook_thread_id,
                hook_thread,
                worker_thread,
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

        registrations.push(RegisteredHotkey {
            id: (index + 1) as i32,
            encoded_key: hotkey.canonical,
            modifiers_mask: hotkey.modifiers.register_hotkey_mask(),
            primary_vk: u32::from(hotkey.key.code),
        });
    }

    Ok(registrations)
}

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
            DispatchMessageW, GetMessageW, MSG, TranslateMessage, WM_HOTKEY,
        },
    };

    let mut registered_ids = Vec::new();
    for registration in &registrations {
        let registered = unsafe {
            RegisterHotKey(
                std::ptr::null_mut(),
                registration.id,
                registration.modifiers_mask,
                registration.primary_vk,
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
                registration.encoded_key, last_error
            )));
            return;
        }
        registered_ids.push(registration.id);
    }

    let thread_id = unsafe { GetCurrentThreadId() };
    let _ = ready_tx.send(Ok(thread_id));

    let mut msg = MaybeUninit::<MSG>::zeroed();
    loop {
        let status = unsafe { GetMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0) };
        if status == -1 {
            break;
        }
        if status == 0 {
            break;
        }

        let msg = unsafe { msg.assume_init() };
        if msg.message == WM_HOTKEY {
            let hotkey_id = msg.wParam as i32;
            if let Some(registration) = registrations.iter().find(|item| item.id == hotkey_id) {
                let _ = event_tx.send(EncodedKeyEvent {
                    encoded_key: registration.encoded_key.clone(),
                    backend: CAPTURE_BACKEND_NAME.into(),
                    received_at: timestamp_millis(),
                    is_repeat: false,
                });
            }
        }

        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

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
    if let Ok(mut store) = runtime_store.lock() {
        store.record_info(
            "capture",
            format!("Received encoded key `{}` from runtime backend.", event.encoded_key),
        );
    }

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
                    created_at: timestamp_millis(),
                };
                emit_runtime_error(app, runtime_store, &error);
                return;
            }
        };

    let _ = app.emit(EVENT_PROFILE_RESOLVED, &capture_result);
    if capture_result.ignored {
        if let Ok(mut store) = runtime_store.lock() {
            store.record_warn(
                "capture",
                capture_result
                    .ignore_reason
                    .clone()
                    .unwrap_or_else(|| "Ignored studio-owned foreground window.".into()),
            );
        }
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
            if let Ok(mut store) = runtime_store.lock() {
                store.record_info(
                    "resolver",
                    format!(
                        "Resolved runtime input `{}` to `{}` / `{}`.",
                        preview.encoded_key,
                        preview.control_id.as_deref().unwrap_or("n/a"),
                        preview.layer.as_deref().unwrap_or("n/a")
                    ),
                );
            }
        }
        resolver::ResolutionStatus::Unresolved | resolver::ResolutionStatus::Ambiguous => {
            if let Ok(mut store) = runtime_store.lock() {
                store.record_warn(
                    "resolver",
                    format!(
                        "Runtime preview for `{}` did not resolve cleanly: {}",
                        preview.encoded_key, preview.reason
                    ),
                );
            }
        }
    }

    let _ = app.emit(EVENT_CONTROL_RESOLVED, &preview);
    if preview.status != resolver::ResolutionStatus::Resolved {
        return;
    }

    match executor::run_preview_action(config, &preview) {
        Ok(execution) => {
            if let Ok(mut store) = runtime_store.lock() {
                store.record_info(
                    "execution",
                    format!(
                        "Runtime executed `{}` for `{}`.",
                        execution.action_pretty, execution.encoded_key
                    ),
                );
                for warning in &execution.warnings {
                    store.record_warn("execution", warning.clone());
                }
            }
            let _ = app.emit(EVENT_ACTION_EXECUTED, &execution);
        }
        Err(error) => {
            emit_runtime_error(app, runtime_store, &error.event);
        }
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
        store.record_warn(event.category.clone(), format!("{}{}", event.message, suffix));
    }

    let _ = app.emit(EVENT_RUNTIME_ERROR, event);
}

fn timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
