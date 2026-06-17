use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
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

/// When true, the runtime surfaces raw key events to the UI (the
/// `encoded_key_received` event still fires) but does NOT resolve, execute, or
/// inject them. Set by the onboarding live hardware test so pressing Naga
/// buttons lights up the tester without firing their real actions. Lock-free,
/// read on the hot dispatch path; toggled by the `set_input_capture_mode`
/// command and always cleared when the test step is left.
pub(crate) static SUPPRESS_EXECUTION: AtomicBool = AtomicBool::new(false);

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

/// Outcome of matching a key-up event to a held hold-shortcut entry.
#[derive(Debug, PartialEq, Eq)]
enum HeldMatch {
    /// Exactly one held entry matches (by exact key, or by a unique base token).
    One(String),
    /// No held entry matches.
    None,
    /// The base-token fallback matched 2+ held entries — ambiguous, release none.
    Ambiguous,
}

/// Select which held-shortcut entry a key-up event should release.
///
/// `held_actions` is keyed by the full encoded key (e.g. `"Ctrl+F13"`). Matching
/// is exact-key-first (the normal Windows case where key-down and key-up carry
/// the same encoded key), then a fallback by *base key token* — the segment
/// after the last `'+'`. The fallback exists because on Linux/evdev the modifier
/// can drop between down and up (down `"Alt+F24"`, up `"F24"`).
///
/// The base match MUST be exact token equality, never `str::ends_with` (which
/// treats `"F3"` as a suffix of `"Ctrl+F13"`), and MUST be unique: releasing the
/// wrong held shortcut leaves the intended one physically stuck, so an ambiguous
/// base (2+ holds sharing the same base key) refuses to release any.
fn select_held_key<'a>(
    held_keys: impl Iterator<Item = &'a str>,
    encoded_key: &str,
) -> HeldMatch {
    let base = encoded_key.rsplit('+').next().unwrap_or(encoded_key);
    let mut exact: Option<String> = None;
    let mut base_matches: Vec<String> = Vec::new();
    for k in held_keys {
        if k == encoded_key {
            exact = Some(k.to_string());
        }
        if k.rsplit('+').next() == Some(base) {
            base_matches.push(k.to_string());
        }
    }
    if let Some(k) = exact {
        return HeldMatch::One(k);
    }
    match base_matches.len() {
        0 => HeldMatch::None,
        1 => HeldMatch::One(base_matches.into_iter().next().unwrap()),
        _ => HeldMatch::Ambiguous,
    }
}

/// Outcome of handling one captured key event, reported back to the worker
/// loop so it can decide whether to refresh the stale-hold deadline.
pub(super) enum EventOutcome {
    /// Event was dispatched, held, released, or otherwise fully handled.
    Handled,
    /// A hold-shortcut DOWN was dropped because the key is already held
    /// (auto-repeat or cross-source duplicate). The worker must NOT refresh
    /// `held_last_seen` for these — otherwise rapid re-taps after a helper
    /// death defer the stale-hold sweep forever (B-F4, Mode B).
    DroppedAsHeldDuplicate,
}

fn process_encoded_key_event(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    app_name: &str,
    event: EncodedKeyEvent,
    held_actions: &mut std::collections::HashMap<String, crate::input_synthesis::HeldShortcutState>,
) -> EventOutcome {
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

    // Live-capture/test mode: the UI just observed the raw key above; do NOT
    // resolve, execute, or inject it. Lets the onboarding hardware test light
    // up buttons without firing their real actions (search/delete/etc.).
    if SUPPRESS_EXECUTION.load(Ordering::Relaxed) {
        flush_log_entries(runtime_store, log_entries);
        return EventOutcome::Handled;
    }

    // --- Key-up path: release any held shortcut ---
    if event.is_key_up {
        log::info!("[capture] Key-up received for {}", event.encoded_key);

        // On Linux/evdev, modifier state may change between key-down and
        // key-up (e.g. Razer releases Alt before F24), so the encoded_key at
        // key-up ("F24") won't match key-down ("Alt+F24"). select_held_key does
        // exact-match-first then a unique base-token fallback (NOT a string
        // suffix), refusing to release when the base is ambiguous.
        let mut ambiguous = false;
        let held_key = match select_held_key(
            held_actions.keys().map(String::as_str),
            &event.encoded_key,
        ) {
            HeldMatch::One(k) => Some(k),
            HeldMatch::None => None,
            HeldMatch::Ambiguous => {
                ambiguous = true;
                log::warn!(
                    "[capture] Key-up for {} matched multiple held shortcuts by base key — releasing none.",
                    event.encoded_key
                );
                log_entries.push((
                    "выполнение",
                    format!(
                        "Отпускание `{}` неоднозначно (несколько удержаний с тем же базовым ключом) — ничего не отпущено.",
                        event.encoded_key
                    ),
                    true,
                ));
                None
            }
        };

        if let Some(held) = held_key.and_then(|k| held_actions.remove(&k)) {
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
        } else if !ambiguous {
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
        return EventOutcome::Handled;
    }

    // Audit F003: read the sticky manual profile override once (set by a ProfileSwitch
    // action) and feed it to BOTH the foreground-window resolution (indicator, below)
    // and the key→binding resolution (dispatch, further below), so they resolve under
    // the same profile. The OSD watcher reads the same override, keeping indicator and
    // dispatch in lock-step.
    let manual_profile_override = runtime_store
        .lock()
        .ok()
        .and_then(|store| store.manual_profile_override().map(str::to_owned));

    let capture_result =
        match window_capture::capture_active_window_with_resolution_with_override(
            config,
            app_name,
            None,
            manual_profile_override.as_deref(),
        ) {
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
                return EventOutcome::Handled;
            }
        };

    emit_profile_resolved_and_notify(app, runtime_store, &capture_result, config);

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
    let (exe, title, process_path) = if capture_result.ignored {
        (String::new(), String::new(), None)
    } else {
        (
            capture_result.exe.clone(),
            capture_result.title.clone(),
            Some(capture_result.process_path.clone()),
        )
    };

    let preview = resolver::resolve_input_preview_with_override(
        config,
        &event.encoded_key,
        &exe,
        &title,
        process_path.as_deref(),
        manual_profile_override.as_deref(),
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
        resolver::ResolutionStatus::ConditionUnmet => {
            log_entries.push((
                "разрешение",
                format!(
                    "Сигнал `{}` разрешён, но условия действия не выполнены: {}",
                    preview.encoded_key, preview.reason
                ),
                false,
            ));
        }
    }

    let _ = app.emit(EVENT_CONTROL_RESOLVED, &preview);
    if preview.status != resolver::ResolutionStatus::Resolved {
        flush_log_entries(runtime_store, log_entries);
        return EventOutcome::Handled;
    }

    // Auto-repeat guard: only tap-mode shortcut actions should repeat.
    // Launch, text, macro, and other non-shortcut actions must NOT re-fire
    // on auto-repeat (e.g. holding a button mapped to Launch would spawn
    // the program 30+ times per second).
    if event.is_repeat && preview.action_type.as_deref() != Some("shortcut") {
        flush_log_entries(runtime_store, log_entries);
        return EventOutcome::Handled;
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
            return EventOutcome::DroppedAsHeldDuplicate;
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

    EventOutcome::Handled
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
            // Audit F003: apply the ProfileSwitch side effect HERE (live path only),
            // never on the Test/dry-run path. Set the sticky override so subsequent
            // input — and the OSD indicator — resolve under the switched-to profile.
            if let Some(action_id) = preview.action_id.as_deref()
                && let Some(action) = config.actions.iter().find(|a| a.id == action_id)
                    && let crate::config::ActionPayload::ProfileSwitch(p) = &action.payload
                        && let Ok(mut store) = runtime_store.lock() {
                            store.set_manual_profile_override(Some(p.target_profile_id.clone()));
                        }
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

/// Emit the resolved-profile event and, when the active profile changed, show
/// the OSD. Shared by the manual key-event path and the per-OS foreground
/// watchers (the tail was previously copied in mod.rs, windows.rs, linux.rs).
pub(crate) fn emit_profile_resolved_and_notify(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    capture_result: &window_capture::WindowCaptureResult,
    config: &AppConfig,
) {
    let _ = app.emit(EVENT_PROFILE_RESOLVED, capture_result);

    if !capture_result.ignored {
        let should_notify = runtime_store
            .lock()
            .ok()
            .map(|mut store| store.notify_profile_change(capture_result.resolved_profile_id.as_deref()))
            .unwrap_or(false);
        if should_notify {
            let profile_name = capture_result
                .resolved_profile_name
                .as_deref()
                .unwrap_or("Default");
            crate::show_osd(app, profile_name, &config.settings);
        }
    }
}

fn flush_log_entries(runtime_store: &Arc<Mutex<RuntimeStore>>, entries: Vec<(&str, String, bool)>) {
    if entries.is_empty() {
        return;
    }
    match runtime_store.lock() { Ok(mut store) => {
        for (source, message, is_warn) in entries {
            if is_warn {
                store.record_warn(source, message);
            } else {
                store.record_info(source, message);
            }
        }
    } _ => {
        log::error!("[capture] runtime_store mutex poisoned while flushing log entries");
    }}
}

fn emit_runtime_error(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    event: &RuntimeErrorEvent,
) {
    match runtime_store.lock() { Ok(mut store) => {
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
    } _ => {
        log::error!(
            "[{}] runtime_store mutex poisoned while recording runtime error: {}",
            event.category, event.message
        );
    }}

    let _ = app.emit(EVENT_RUNTIME_ERROR, event);
}

#[cfg(test)]
mod select_held_key_tests {
    use super::{select_held_key, HeldMatch};

    #[test]
    fn exact_match_wins() {
        let held = ["Ctrl+F13", "Alt+F24"];
        assert_eq!(
            select_held_key(held.into_iter(), "Ctrl+F13"),
            HeldMatch::One("Ctrl+F13".to_string())
        );
    }

    #[test]
    fn linux_modifier_drop_matches_base_token() {
        // down was "Alt+F24"; key-up arrives as "F24" (Alt released first).
        let held = ["Alt+F24"];
        assert_eq!(
            select_held_key(held.into_iter(), "F24"),
            HeldMatch::One("Alt+F24".to_string())
        );
    }

    #[test]
    fn suffix_false_positive_is_rejected() {
        // "Ctrl+F13".ends_with("F3") is true — the old bug. Base-token equality rejects it.
        let held = ["Ctrl+F13"];
        assert_eq!(select_held_key(held.into_iter(), "F3"), HeldMatch::None);
    }

    #[test]
    fn ambiguous_base_releases_none() {
        let held = ["Alt+F13", "Ctrl+F13"];
        assert_eq!(select_held_key(held.into_iter(), "F13"), HeldMatch::Ambiguous);
    }

    #[test]
    fn plain_base_key_exact_match() {
        let held = ["F13"];
        assert_eq!(
            select_held_key(held.into_iter(), "F13"),
            HeldMatch::One("F13".to_string())
        );
    }

    #[test]
    fn no_match_returns_none() {
        let held = ["Ctrl+F13"];
        assert_eq!(select_held_key(held.into_iter(), "Alt+F19"), HeldMatch::None);
    }
}
