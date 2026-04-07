use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::{
    config::{self, AppConfig},
    executor::{self, RuntimeErrorEvent},
    hotkeys, resolver,
    runtime::{
        self, RuntimeStore, EVENT_ACTION_EXECUTED, EVENT_CONTROL_RESOLVED,
        EVENT_ENCODED_KEY_RECEIVED, EVENT_PROFILE_RESOLVED, EVENT_RUNTIME_ERROR,
    },
    window_capture,
};

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows::CaptureBackendHandle;

#[cfg(target_os = "windows")]
pub use windows::capture_helper_main;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::CaptureBackendHandle;

#[cfg(target_os = "linux")]
pub use linux::capture_helper_main;

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn capture_helper_main() {
    log::error!("[capture-helper] Only supported on Windows and Linux.");
}

pub const CAPTURE_BACKEND_NAME: &str = "windows-hotkey";

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
    #[cfg(target_os = "windows")]
    backend: Option<CaptureBackendHandle>,
    #[cfg(target_os = "linux")]
    backend: Option<CaptureBackendHandle>,
}

impl Drop for RuntimeController {
    fn drop(&mut self) {
        if let Err(e) = self.stop() {
            log::error!("[capture] Failed to stop runtime during drop: {e}");
        }
    }
}

impl RuntimeController {
    pub fn start(
        &mut self,
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            self.stop()?;
            let backend = CaptureBackendHandle::start(app, runtime_store, config, app_name)?;
            self.backend = Some(backend);
            Ok(())
        }

        #[cfg(target_os = "linux")]
        {
            self.stop()?;
            let backend = CaptureBackendHandle::start(app, runtime_store, config, app_name)?;
            self.backend = Some(backend);
            Ok(())
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            let _ = (app, runtime_store, config, app_name);
            Err("Global capture backend is only implemented for Windows and Linux.".into())
        }
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
        #[cfg(target_os = "windows")]
        if let Some(backend) = self.backend.take() {
            backend.stop()?;
        }
        #[cfg(target_os = "linux")]
        if let Some(backend) = self.backend.take() {
            backend.stop()?;
        }
        Ok(())
    }

    /// Send a REHOOK command to the capture helper, causing it to reinstall
    /// its WH_KEYBOARD_LL hook without restarting the entire runtime.
    /// On Linux, evdev capture does not need rehooking.
    pub fn rehook(&mut self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            match &mut self.backend {
                Some(backend) => backend.rehook(),
                None => Err("Runtime is not running.".to_owned()),
            }
        }
        #[cfg(target_os = "linux")]
        {
            match &mut self.backend {
                Some(backend) => backend.rehook(),
                None => Err("Runtime is not running.".to_owned()),
            }
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        Err("Runtime is not running.".to_owned())
    }
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
        log::info!("[capture] Key-up received for {}", event.encoded_key);
        if let Some(held) = held_actions.remove(&event.encoded_key) {
            match crate::input_synthesis::send_shortcut_hold_up(&held) {
                Ok(()) => {
                    log::info!(
                        "[capture] Hold-shortcut released for {}",
                        event.encoded_key
                    );
                    log_entries.push((
                        "выполнение",
                        format!("Отпущен удерживаемый шорткат для `{}`.", event.encoded_key),
                        false,
                    ));
                }
                Err(e) => {
                    log::error!(
                        "[capture] Hold-shortcut release failed for {}: {e}",
                        event.encoded_key
                    );
                    log_entries.push((
                        "выполнение",
                        format!("Не удалось отпустить шорткат для `{}`: {e}", event.encoded_key),
                        true,
                    ));
                }
            }
        } else {
            log::info!(
                "[capture] Key-up for {} without active hold",
                event.encoded_key
            );
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
            crate::show_osd(app, profile_name, &config.settings);
        }
    }

    let is_fg_elevated = capture_result.is_elevated;
    if is_fg_elevated {
        log_entries.push((
            "UIPI",
            format!(
                "Активное окно `{}` запущено с правами администратора. \
                 SendInput заблокирован Windows (UIPI). \
                 Запустите Sidearm от имени администратора или с uiAccess.",
                capture_result.exe
            ),
            true,
        ));
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

    // Auto-repeat guard: only tap-mode shortcut actions should repeat.
    // Launch, text, macro, and other non-shortcut actions must NOT re-fire
    // on auto-repeat (e.g. holding a button mapped to Launch would spawn
    // the program 30+ times per second).
    if event.is_repeat && preview.action_type.as_deref() != Some("shortcut") {
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
                config::ActionPayload::Shortcut(p) => Some(p.key.trim().is_empty()),
                _ => None,
            })
            .unwrap_or(false);

    let is_hold_shortcut = preview.action_type.as_deref() == Some("shortcut")
        && (preview.trigger_mode == Some(config::TriggerMode::Hold)
            || is_modifier_only_shortcut);

    if is_hold_shortcut {
        log::info!(
            "[capture] Hold-shortcut dispatch for {} (action_pretty={:?})",
            event.encoded_key,
            preview.action_pretty,
        );
        // Skip auto-repeat events — the shortcut is already held.
        // Re-calling hold_down would overwrite held_actions with an empty
        // state (modifiers already active → "reused" → nothing pressed)
        // and the eventual hold_up would fail to release.
        if held_actions.contains_key(&event.encoded_key) {
            log::info!(
                "[capture] Hold-shortcut already held for {}, skipping duplicate",
                event.encoded_key
            );
            flush_log_entries(runtime_store, log_entries);
            return;
        }

        let action = config
            .actions
            .iter()
            .find(|a| Some(a.id.as_str()) == preview.action_id.as_deref());

        if let Some(config::Action {
            payload: config::ActionPayload::Shortcut(payload),
            ..
        }) = action
        {
            let encoding_mods = hotkeys::extract_encoding_modifiers(&event.encoded_key);
            log::info!(
                "[capture] Hold-shortcut sending: ctrl={} shift={} alt={} win={} key={:?} | encoding_mods={:?}",
                payload.ctrl, payload.shift, payload.alt, payload.win, payload.key, encoding_mods,
            );
            match crate::input_synthesis::send_shortcut_hold_down(payload, &encoding_mods) {
                Ok(held) => {
                    log::info!(
                        "[capture] Hold-shortcut hold-down OK for {} ({})",
                        event.encoded_key,
                        preview.action_pretty.as_deref().unwrap_or("?"),
                    );
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
                            warnings: if is_fg_elevated {
                                vec!["Активное окно запущено с правами администратора — ввод может быть заблокирован (UIPI).".into()]
                            } else {
                                Vec::new()
                            },
                            executed_at: runtime::timestamp_millis(),
                        },
                    );
                }
                Err(e) => {
                    log::error!(
                        "[capture] Hold-shortcut hold-down FAILED for {}: {e}",
                        event.encoded_key
                    );
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
            log::warn!(
                "[capture] Hold requested but action is not a shortcut for {}; falling back",
                event.encoded_key
            );
            log_entries.push((
                "выполнение",
                "Запрошено удержание, но действие не шорткат; переключение на нажатие.".into(),
                true,
            ));
            run_fire_and_forget(app, runtime_store, config, &preview, &event, log_entries, is_fg_elevated);
        }
    } else {
        run_fire_and_forget(app, runtime_store, config, &preview, &event, log_entries, is_fg_elevated);
    }
}

fn run_fire_and_forget(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    preview: &resolver::ResolvedInputPreview,
    _event: &EncodedKeyEvent,
    mut log_entries: Vec<(&str, String, bool)>,
    is_fg_elevated: bool,
) {
    log::info!(
        "[capture] Dispatching action for {}",
        preview.encoded_key
    );
    match executor::run_preview_action(config, preview) {
        Ok(mut execution) => {
            if is_fg_elevated {
                execution.warnings.push(
                    "Активное окно запущено с правами администратора — ввод может быть заблокирован (UIPI).".into()
                );
            }
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
