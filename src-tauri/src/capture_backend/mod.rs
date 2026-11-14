use serde::Serialize;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter};

use crate::{
    config::{self, AppConfig},
    executor::{self, RuntimeErrorEvent},
    hotkeys, resolver,
    runtime::{
        self, EVENT_ACTION_EXECUTED, EVENT_CONTROL_RESOLVED, EVENT_ENCODED_KEY_RECEIVED,
        EVENT_PROFILE_RESOLVED, EVENT_RUNTIME_ERROR, EVENT_THROTTLE_BLOCKED, RuntimeStore,
    },
    window_capture,
};
use crate::RecoverPoison;

/// Payload for `throttle_blocked`: a binding's re-trigger landed inside its
/// throttle window and was skipped. The FE greys the hotspot + shows a countdown.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThrottleBlockedEvent {
    control_id: Option<String>,
    binding_id: Option<String>,
    remaining_ms: u64,
}

/// Exe of the last elevated foreground app the UI was told about, so the
/// "input is blocked" notice fires once per app instead of on every key.
static LAST_ELEVATED_NOTICE: Mutex<Option<String>> = Mutex::new(None);

/// True (and remembers `exe`) when `exe` differs, case-insensitively, from the
/// last notified one.
fn should_notify_elevated(last: &mut Option<String>, exe: &str) -> bool {
    if last.as_deref().is_some_and(|prev| prev.eq_ignore_ascii_case(exe)) {
        return false;
    }
    *last = Some(exe.to_owned());
    true
}

mod gestures;
#[cfg(any(target_os = "linux", test))]
mod linux_state;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
mod consumer;
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
    /// `true` when the press arrived while the software Hypershift trigger was
    /// held, so the resolver must look the binding up in the `hypershift` layer
    /// (with a fallback to the standard one). Stamped at capture time — reading
    /// the trigger state when the worker gets around to the event would race a
    /// fast press/release.
    pub is_hypershift: bool,
    /// `true` when the press arrived while its mouse's HyperShift 2 trigger
    /// was held (stamped `H2:` by the helper, as `is_hypershift` is).
    pub is_hypershift2: bool,
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

    pub fn reload_saved_config(
        &mut self,
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        if let Some(backend) = self.backend.take() {
            self.backend = Some(backend.restart_after_save(app, runtime_store, config, app_name)?);
            return Ok(());
        }
        self.restart(app, runtime_store, config, app_name)
    }

    pub fn stop(&mut self) -> Result<(), String> {
        // A macro must not keep typing after the capture stopped.
        executor::cancel_live_sequences();
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
fn select_held_key<'a>(held_keys: impl Iterator<Item = &'a str>, encoded_key: &str) -> HeldMatch {
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
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum EventOutcome {
    /// Event was dispatched, held, released, or otherwise fully handled.
    Handled,
    /// A hold-shortcut DOWN was dropped because the key is already held
    /// (auto-repeat or cross-source duplicate). The worker must NOT refresh
    /// `held_last_seen` for these — otherwise rapid re-taps after a helper
    /// death defer the stale-hold sweep forever (B-F4, Mode B).
    DroppedAsHeldDuplicate,
}

/// What a press of a button with several press patterns is dispatched with
/// once its pattern is known: the press's own window and layer.
#[derive(Clone)]
struct GestureContext {
    encoded_key: String,
    target: GestureTarget,
    exe: String,
    title: String,
    process_path: Option<String>,
    manual_profile_override: Option<String>,
    held: resolver::HeldLayers,
    own_window: bool,
    is_fg_elevated: bool,
}

type PendingGestures = gestures::Gestures<GestureContext>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct GestureTarget {
    hwnd: String,
    exe: String,
    title: String,
    process_path: String,
}

impl From<&window_capture::WindowCaptureResult> for GestureTarget {
    fn from(window: &window_capture::WindowCaptureResult) -> Self {
        Self { hwnd: window.hwnd.clone(), exe: window.exe.clone(), title: window.title.clone(), process_path: window.process_path.clone() }
    }
}

fn suppresses_event<T: Clone>(gestures: &mut gestures::Gestures<T>, suppressed: bool, key_up: bool) -> bool {
    if suppressed {
        gestures.clear();
    }
    suppressed && !key_up
}

fn replay_native_wheel(
    action: config::MouseActionKind,
    repeat: bool,
    fake: bool,
    send: impl FnOnce(config::MouseActionKind) -> Result<(), String>,
) -> Result<(), String> {
    if !repeat && !fake { send(action) } else { Ok(()) }
}

fn gesture_target_is_current(
    payload: Option<&config::ActionPayload>,
    start_window: &GestureTarget,
    current_window: Option<&GestureTarget>,
) -> bool {
    use config::{ActionPayload, MouseActionKind, SequenceStep};
    let sends_input = match payload {
        Some(ActionPayload::Shortcut(_) | ActionPayload::TextSnippet(_) | ActionPayload::MediaKey(_)) => true,
        Some(ActionPayload::MouseAction(mouse)) => !matches!(mouse.action, MouseActionKind::DpiUp | MouseActionKind::DpiDown),
        Some(ActionPayload::Sequence(sequence)) => sequence.steps.iter().any(|step| matches!(step, SequenceStep::Send { .. } | SequenceStep::Text { .. })),
        Some(ActionPayload::Launch(_) | ActionPayload::Menu(_) | ActionPayload::ProfileSwitch(_)
            | ActionPayload::Disabled(_) | ActionPayload::RepairClipboard(_) | ActionPayload::StopMacros(_)
            | ActionPayload::CheatSheet(_)) | None => false,
    };
    !sends_input || current_window.is_some_and(|current| {
        if !start_window.hwnd.is_empty() {
            current.hwnd == start_window.hwnd
        } else {
            // shortcut: GNOME exposes no ID; use app/title/path until the extension supplies a stable window ID.
            !start_window.exe.is_empty() && !start_window.title.is_empty() && current == start_window
        }
    })
}

fn gesture_dispatch_allowed(payload: Option<&config::ActionPayload>, target: &GestureTarget, current: Option<&window_capture::WindowCaptureResult>, suppressed: bool, recording: bool) -> bool {
    !suppressed
        && gesture_target_is_current(payload, target, current.map(GestureTarget::from).as_ref())
        && (current.is_none_or(|window| window.ignore_reason.as_deref() != Some(window_capture::OWN_WINDOW_REASON))
            || can_execute_in_own_window(payload, recording))
}

fn check_binding_throttle(
    config: &AppConfig,
    preview: &resolver::ResolvedInputPreview,
    store: &mut RuntimeStore,
    now: u64,
) -> Option<u64> {
    let id = preview.binding_id.as_deref()?;
    let ms = config.bindings.iter().find(|binding| binding.id == id)?.throttle_ms.unwrap_or(0);
    store.check_execution_throttle(id, ms, now)
}

/// A shortcut of modifiers alone: it is always held down (push-to-talk).
fn holds_modifiers_only(config: &AppConfig, preview: &resolver::ResolvedInputPreview) -> bool {
    config.actions.iter().any(|action| {
        Some(action.id.as_str()) == preview.action_id.as_deref()
            && matches!(&action.payload, config::ActionPayload::Shortcut(shortcut) if shortcut.key.trim().is_empty())
    })
}

/// The press patterns besides the plain press that the resolved control's
/// bindings answer on its layer. None when its plain press holds a shortcut
/// down (a hold must start on the press, it cannot wait).
fn gesture_patterns(config: &AppConfig, preview: &resolver::ResolvedInputPreview, held: resolver::HeldLayers) -> gestures::Patterns {
    let (Some(profile), Some(layer), Some(control)) =
        (preview.resolved_profile_id.as_deref(), preview.layer.as_deref(), preview.control_id.as_deref())
    else {
        return gestures::Patterns::default();
    };
    // Under HyperShift each pattern falls back to the standard layer on its
    // own (`resolver::resolve_gesture_preview`); the HyperShift 2 layers have
    // no fallback.
    let on_layer = |binding_layer: &str| {
        binding_layer == layer
            || (held.hypershift && !held.hypershift2 && (binding_layer == "hypershift" || binding_layer == "standard"))
    };
    if preview.trigger_mode == Some(config::TriggerMode::Hold) || holds_modifiers_only(config, preview) {
        return gestures::Patterns::default();
    }
    let mut patterns = gestures::Patterns::default();
    for binding in config.bindings.iter().filter(|binding| {
        binding.enabled && binding.profile_id == profile && on_layer(binding.layer.as_str()) && binding.control_id.as_str() == control
    }) {
        match config::Gesture::of(binding.trigger_mode) {
            config::Gesture::LongPress => patterns.long = true,
            config::Gesture::DoublePress => patterns.double = true,
            config::Gesture::TriplePress => patterns.triple = true,
            config::Gesture::Press => {}
        }
    }
    patterns
}

/// Dispatches what the clock settled (long presses, closed tap windows).
fn fire_due_gestures(app: &AppHandle, runtime_store: &Arc<Mutex<RuntimeStore>>, config: &AppConfig, gestures: &mut PendingGestures) {
    if suppresses_event(gestures, SUPPRESS_EXECUTION.load(Ordering::Relaxed) || crate::is_shutting_down(), false) {
        return;
    }
    let fired = gestures.tick(std::time::Instant::now());
    if !fired.is_empty() {
        fire_gestures(app, runtime_store, config, fired);
    }
}

/// Dispatches the press patterns the recognizer settled on.
fn fire_gestures(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    fired: Vec<(GestureContext, config::Gesture)>,
) {
    for (context, gesture) in fired {
        if SUPPRESS_EXECUTION.load(Ordering::Relaxed) {
            return;
        }
        let preview = resolver::resolve_gesture_preview(
            config,
            &context.encoded_key,
            &context.exe,
            &context.title,
            context.process_path.as_deref(),
            context.manual_profile_override.as_deref(),
            context.held,
            gesture,
        );
        if preview.status != resolver::ResolutionStatus::Resolved {
            log::info!("[capture] {gesture:?} of {} not dispatched: {}", context.encoded_key, preview.reason);
            continue;
        }
        let payload = config
            .actions
            .iter()
            .find(|action| Some(action.id.as_str()) == preview.action_id.as_deref())
            .map(|action| &action.payload);
        let current = window_capture::capture_active_window_with_resolution(config, "", None).ok();
        if !crate::fake_mode() && !gesture_dispatch_allowed(payload, &context.target, current.as_ref(), SUPPRESS_EXECUTION.load(Ordering::Relaxed), key_recording()) {
            log::info!("[capture] {gesture:?} of {} cancelled: foreground window changed", context.encoded_key);
            continue;
        }
        let own_window = current.as_ref().map_or(context.own_window, |window| window.ignore_reason.as_deref() == Some(window_capture::OWN_WINDOW_REASON));
        if own_window && !can_execute_in_own_window(payload, key_recording()) {
            log::info!("[capture] {gesture:?} of {} not dispatched: own window", context.encoded_key);
            continue;
        }
        log::info!("[capture] {gesture:?} of {}", context.encoded_key);
        run_fire_and_forget(app, runtime_store, config, &preview, Vec::new(), context.is_fg_elevated, false, Some(context.target));
    }
}

#[allow(clippy::too_many_arguments)]
fn process_encoded_key_event(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    app_name: &str,
    event: EncodedKeyEvent,
    held_actions: &mut std::collections::HashMap<String, crate::input_synthesis::HeldShortcutState>,
    gestures: &mut PendingGestures,
) -> EventOutcome {
    // Accumulate log entries locally and flush in a single lock at the end to
    // avoid acquiring the runtime_store mutex multiple times per keypress.
    let mut log_entries: Vec<(&str, crate::ui_text::UiText, bool)> = Vec::new(); // (source, message, is_warn)

    log_entries.push((
        "capture",
        crate::ui_text!(
            "capture.signalReceived",
            "Got signal `{key}` from the capture backend.",
            key = &event.encoded_key
        ),
        false,
    ));

    let _ = app.emit(EVENT_ENCODED_KEY_RECEIVED, &event);

    // Mirrors "Key-up received": without it a press that never reaches dispatch
    // leaves only its key-up in the file log.
    if !event.is_key_up {
        log::info!(
            "[capture] Key-down received for {} (hypershift: {}, hypershift2: {}, repeat: {})",
            event.encoded_key,
            event.is_hypershift,
            event.is_hypershift2,
            event.is_repeat
        );
    }

    // Live-capture/test mode: the UI just observed the raw key above; do NOT
    // resolve, execute, or inject it. Lets the onboarding hardware test light
    // up buttons without firing their real actions (search/delete/etc.).
    // Exiting: the mice are being given back, a press would start work the
    // exit then waits for.
    let exiting = crate::is_shutting_down();
    if suppresses_event(gestures, exiting || SUPPRESS_EXECUTION.load(Ordering::Relaxed), event.is_key_up) {
        log::info!("[capture] Not dispatched {}: {}", event.encoded_key, if exiting { "exiting" } else { "live-capture mode" });
        flush_log_entries(runtime_store, log_entries);
        return EventOutcome::Handled;
    }

    // A button whose press pattern is being told apart: its release and
    // repeats belong to the recognizer.
    if gestures.tracks(&event.encoded_key) {
        if event.is_key_up {
            let fired = gestures.release(&event.encoded_key, std::time::Instant::now());
            flush_log_entries(runtime_store, log_entries);
            fire_gestures(app, runtime_store, config, fired);
            return EventOutcome::Handled;
        }
        if event.is_repeat {
            flush_log_entries(runtime_store, log_entries);
            return EventOutcome::Handled;
        }
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
                    "execution",
                    crate::ui_text!(
                        "capture.releaseAmbiguous",
                        "Release of `{key}` is ambiguous (several holds share the same base key) — nothing was released.",
                        key = &event.encoded_key
                    ),
                    true,
                ));
                None
            }
        };

        if let Some(held) = held_key.and_then(|k| held_actions.remove(&k)) {
            match crate::input_synthesis::send_shortcut_hold_up(&held) {
                Ok(()) => {
                    log::info!("[capture] Hold-shortcut released for {}", event.encoded_key);
                    log_entries.push((
                        "execution",
                        crate::ui_text!(
                            "capture.holdReleased",
                            "Released the held shortcut for `{key}`.",
                            key = &event.encoded_key
                        ),
                        false,
                    ));
                }
                Err(e) => {
                    log::error!(
                        "[capture] Hold-shortcut release failed for {}: {e}",
                        event.encoded_key
                    );
                    log_entries.push((
                        "execution",
                        crate::ui_text!(
                            "capture.holdReleaseFailed",
                            "Failed to release the shortcut for `{key}`: {e}",
                            key = &event.encoded_key,
                            e = e
                        ),
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
                "capture",
                crate::ui_text!(
                    "capture.releaseWithoutHold",
                    "Release of `{key}` without an active hold.",
                    key = &event.encoded_key
                ),
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

    let capture_result = match window_capture::capture_active_window_with_resolution_with_override(
        config,
        app_name,
        None,
        manual_profile_override.as_deref(),
    ) {
        Ok(result) => result,
        // No window in front (a locked screen, a window just closed, a desktop
        // switch): the press still counts, on the profile no app chose.
        Err(message) => {
            log::info!("[capture] {}: no active window ({message}); the default profile applies", event.encoded_key);
            window_capture::without_foreground_window(config, manual_profile_override.as_deref())
        }
    };

    emit_profile_resolved_and_notify(app, runtime_store, &capture_result, config);

    let is_fg_elevated = capture_result.is_elevated;
    if is_fg_elevated {
        log_entries.push((
            "UIPI",
            crate::ui_text!(
                "capture.elevatedForeground",
                "The active window `{exe}` runs as administrator. \
                 SendInput is blocked by Windows (UIPI). \
                 Run Sidearm as administrator or with uiAccess.",
                exe = &capture_result.exe
            ),
            true,
        ));
        // Tell the UI once per elevated app (it offers "restart as administrator");
        // nothing to offer when Sidearm already runs elevated.
        if !window_capture::is_current_process_elevated()
            && should_notify_elevated(
                &mut LAST_ELEVATED_NOTICE.lock().recover_poison(),
                &capture_result.exe,
            )
        {
            let _ = app.emit(
                runtime::EVENT_ELEVATED_FOREGROUND,
                serde_json::json!({ "exe": capture_result.exe }),
            );
        }
    }

    if capture_result.ignored {
        log_entries.push((
            "capture",
            crate::ui_text!(
                "capture.ownWindowFallback",
                "Sidearm's own window — using the fallback profile."
            ),
            false,
        ));
    }

    // Resolve action — use empty exe/title when ignored (forces fallback profile).
    // Borrow straight from capture_result instead of cloning three Strings per
    // keystroke; the resolver only needs &str and capture_result outlives them.
    let (exe, title, process_path): (&str, &str, Option<&str>) = if capture_result.ignored {
        ("", "", None)
    } else {
        (
            &capture_result.exe,
            &capture_result.title,
            Some(capture_result.process_path.as_str()),
        )
    };

    let held = resolver::HeldLayers { hypershift: event.is_hypershift, hypershift2: event.is_hypershift2 };
    let preview = resolver::resolve_gesture_preview(
        config,
        &event.encoded_key,
        exe,
        title,
        process_path,
        manual_profile_override.as_deref(),
        held,
        config::Gesture::Press,
    );

    let own_window = capture_result.ignore_reason.as_deref() == Some(window_capture::OWN_WINDOW_REASON);
    // An open menu owns the mouse's buttons: the press drives it, the app gets nothing.
    if crate::menu_popup::is_open() {
        if !event.is_repeat {
            crate::menu_popup::handle_press(app, preview.control_id.as_deref());
        }
        flush_log_entries(runtime_store, log_entries);
        return EventOutcome::Handled;
    }
    if let Some(action) = native_wheel_scroll(&preview, own_window) {
        if let Err(error) = replay_native_wheel(action, event.is_repeat, crate::fake_mode(), |action| {
            crate::input_synthesis::send_mouse_action(
                &config::MouseActionPayload { action, ctrl: false, shift: false, alt: false, win: false },
                &hotkeys::HotkeyModifiers::default(),
            ).map(|_| ())
        })
        {
            log::warn!("[capture] Native V3 scroll failed: {error}");
        }
        flush_log_entries(runtime_store, log_entries);
        return EventOutcome::Handled;
    }

    let context = || GestureContext {
        encoded_key: event.encoded_key.clone(),
        target: GestureTarget::from(&capture_result),
        exe: exe.to_owned(),
        title: title.to_owned(),
        process_path: process_path.map(str::to_owned),
        manual_profile_override: manual_profile_override.clone(),
        held,
        own_window,
        is_fg_elevated,
    };

    // Several press patterns on this button: wait to tell them apart.
    let patterns = gesture_patterns(config, &preview, held);
    if patterns.any() && !event.is_repeat {
        let _ = app.emit(EVENT_CONTROL_RESOLVED, &preview);
        gestures.press(&event.encoded_key, patterns, context(), std::time::Instant::now());
        flush_log_entries(runtime_store, log_entries);
        return EventOutcome::Handled;
    }

    match preview.status {
        resolver::ResolutionStatus::Resolved => {
            log_entries.push((
                "resolution",
                crate::ui_text!(
                    "capture.signalResolved",
                    "Signal `{key}` resolved to `{control}` / `{layer}`.",
                    key = &preview.encoded_key,
                    control = preview.control_id.as_deref().unwrap_or("—"),
                    layer = preview.layer.as_deref().unwrap_or("—")
                ),
                false,
            ));
        }
        resolver::ResolutionStatus::Unresolved | resolver::ResolutionStatus::Ambiguous => {
            log_entries.push((
                "resolution",
                crate::ui_text!(
                    "capture.signalUnresolved",
                    "Signal `{key}` could not be resolved: {reason}",
                    key = &preview.encoded_key,
                    reason = &preview.reason
                ),
                true,
            ));
        }
        resolver::ResolutionStatus::ConditionUnmet => {
            log_entries.push((
                "resolution",
                crate::ui_text!(
                    "capture.signalConditionUnmet",
                    "Signal `{key}` resolved, but the action's conditions are not met: {reason}",
                    key = &preview.encoded_key,
                    reason = &preview.reason
                ),
                false,
            ));
        }
    }

    let _ = app.emit(EVENT_CONTROL_RESOLVED, &preview);
    if preview.status != resolver::ResolutionStatus::Resolved {
        log::info!(
            "[capture] Not dispatched {} ({:?}): {}",
            preview.encoded_key,
            preview.status,
            preview.reason
        );
        flush_log_entries(runtime_store, log_entries);
        return EventOutcome::Handled;
    }

    // DPI stepping writes mouse hardware; other actions stay blocked while Sidearm
    // is focused so injected shortcuts cannot operate its own editor.
    let resolved_action = config.actions.iter().find(|a| Some(a.id.as_str()) == preview.action_id.as_deref());
    if own_window && !can_execute_in_own_window(resolved_action.map(|action| &action.payload), key_recording()) {
        log::info!("[capture] Not dispatched {}: Sidearm's own window ({:?})", preview.encoded_key, capture_result.title);
        log_entries.push((
            "capture",
            crate::ui_text!(
                "capture.ownWindowActive",
                "Sidearm's window is active — `{key}` was only highlighted, no action ran.",
                key = &preview.encoded_key
            ),
            false,
        ));
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
    // Resolve the action once and reuse it below (is_modifier_only + hold branch)
    // instead of scanning config.actions twice per keystroke.
    let is_modifier_only_shortcut = preview.action_type.as_deref() == Some("shortcut")
        && resolved_action
            .and_then(|a| match &a.payload {
                config::ActionPayload::Shortcut(p) => Some(p.key.trim().is_empty()),
                _ => None,
            })
            .unwrap_or(false);

    let is_hold_shortcut = !crate::fake_mode()
        && preview.action_type.as_deref() == Some("shortcut")
        && (preview.trigger_mode == Some(config::TriggerMode::Hold) || is_modifier_only_shortcut);

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

        if let Some(config::Action {
            payload: config::ActionPayload::Shortcut(payload),
            ..
        }) = resolved_action
        {
            let encoding_mods = hotkeys::extract_encoding_modifiers(&event.encoded_key);
            log::info!(
                "[capture] Hold-shortcut sending: ctrl={} shift={} alt={} win={} key={:?} | encoding_mods={:?}",
                payload.ctrl,
                payload.shift,
                payload.alt,
                payload.win,
                payload.key,
                encoding_mods,
            );
            match crate::input_synthesis::send_shortcut_hold_down(payload, &encoding_mods) {
                Ok(held) => {
                    log::info!(
                        "[capture] Hold-shortcut hold-down OK for {} ({})",
                        event.encoded_key,
                        preview.action_pretty.as_deref().unwrap_or("?"),
                    );
                    log_entries.push((
                        "execution",
                        crate::ui_text!(
                            "capture.holdStarted",
                            "Holding shortcut `{action}` for `{key}`.",
                            action = preview.action_pretty.as_deref().unwrap_or("?"),
                            key = &preview.encoded_key
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
                            summary: crate::ui_text!(
                                "capture.holdStartedSummary",
                                "Holding shortcut `{action}`.",
                                action = preview.action_pretty.as_deref().unwrap_or("?")
                            ),
                            warnings: if is_fg_elevated {
                                vec![crate::ui_text!("capture.elevatedWarning", "The active window runs as administrator — input may be blocked (UIPI).")]
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
                        category: "execution".into(),
                        message: e.into(),
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
                "execution",
                crate::ui_text!(
                    "capture.holdNotShortcut",
                    "Hold requested, but the action is not a shortcut; switching to press."
                ),
                true,
            ));
            run_fire_and_forget(
                app,
                runtime_store,
                config,
                &preview,
                log_entries,
                is_fg_elevated,
                false,
                None,
            );
        }
    } else {
        run_fire_and_forget(
            app,
            runtime_store,
            config,
            &preview,
            log_entries,
            is_fg_elevated,
            false,
            None,
        );
    }

    EventOutcome::Handled
}

/// A live-overlay mouse's wheel with no active assignment: Sidearm scrolls
/// (the live map holds silent signals there).
fn native_wheel_scroll(
    preview: &resolver::ResolvedInputPreview,
    own_window: bool,
) -> Option<config::MouseActionKind> {
    if !own_window && preview.binding_id.is_some()
        && preview.status != resolver::ResolutionStatus::ConditionUnmet
    {
        return None;
    }
    #[cfg(target_os = "windows")]
    return crate::device_catalog::live_wheel_scroll(preview.control_id.as_deref()?);
    #[cfg(not(target_os = "windows"))]
    None
}

/// A shortcut or signal is being recorded in Sidearm's own window
/// (`set_key_recording`): the mouse must not type into it or close it.
static KEY_RECORDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn set_key_recording(on: bool) {
    KEY_RECORDING.store(on, std::sync::atomic::Ordering::Release);
}

pub(crate) fn key_recording() -> bool {
    KEY_RECORDING.load(std::sync::atomic::Ordering::Acquire)
}

/// In Sidearm's own window the buttons work as anywhere else (owner's call),
/// except while a key combination is recorded there: then only DPI steps
/// (they write the mouse, nothing reaches the window).
fn can_execute_in_own_window(payload: Option<&config::ActionPayload>, recording: bool) -> bool {
    !recording
        || matches!(
            payload,
            Some(config::ActionPayload::MouseAction(config::MouseActionPayload {
                action: config::MouseActionKind::DpiUp | config::MouseActionKind::DpiDown,
                ..
            }))
        )
}

#[allow(clippy::too_many_arguments)]
fn run_fire_and_forget(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    preview: &resolver::ResolvedInputPreview,
    mut log_entries: Vec<(&str, crate::ui_text::UiText, bool)>,
    is_fg_elevated: bool,
    // A popup menu's pick: its press was counted when the menu opened.
    menu_pick: bool,
    gesture_target: Option<GestureTarget>,
) {
    // All tap paths, including settled gestures. Holds never reach this path;
    // a menu pick belongs to the opening press and must not consume its throttle twice.
    if !menu_pick && let Some(remaining_ms) = runtime_store.lock().ok().and_then(|mut store| {
        check_binding_throttle(config, preview, &mut store, runtime::timestamp_millis())
    }) {
        log_entries.push(("execution", crate::ui_text!(
            "capture.throttled", "[throttle] `{key}` skipped — {ms} ms left.",
            key = &preview.encoded_key, ms = remaining_ms
        ), false));
        flush_log_entries(runtime_store, log_entries);
        let _ = app.emit(EVENT_THROTTLE_BLOCKED, &ThrottleBlockedEvent {
            control_id: preview.control_id.clone(), binding_id: preview.binding_id.clone(), remaining_ms,
        });
        return;
    }
    // Name the control and the layer: "the wrong action fired" is otherwise
    // indistinguishable from "the right control fired the right action" in the
    // log, and the two layers of one control hold different actions.
    log::info!(
        "[capture] Dispatching action for {} (control {}, layer {})",
        preview.encoded_key,
        preview.control_id.as_deref().unwrap_or("?"),
        preview.layer.as_deref().unwrap_or("?")
    );
    #[cfg(target_os = "windows")]
    if let Some(control) = preview.control_id.as_deref()
        && let Some(physical) = config.physical_controls.iter().find(|physical| physical.id.as_str() == control)
    {
        crate::onboard_guard::note_device_used(app, &physical.device_id);
    }
    // A cheat sheet is the popup as a grid of the pressed mouse's side buttons
    // on that layer: side button N (or a click) runs button N's action there.
    if let Some(action) = config.actions.iter().find(|a| Some(a.id.as_str()) == preview.action_id.as_deref())
        && let crate::config::ActionPayload::CheatSheet(payload) = &action.payload
    {
        flush_log_entries(runtime_store, log_entries);
        count_press(config, preview, &action.id, !menu_pick);
        crate::menu_popup::open_sheet(app, runtime_store, config, preview, payload.layer, is_fg_elevated);
        if crate::fake_mode() {
            log::info!("[capture] E2E execution {}", serde_json::json!({
                "encodedKey": preview.encoded_key, "controlId": preview.control_id, "layer": preview.layer,
                "actionId": action.id, "profileId": preview.resolved_profile_id, "outcome": "sheetOpened",
            }));
        }
        return;
    }
    // A phrase with input fields asks for them first; Enter runs it filled in.
    if let Some(action) = config.actions.iter().find(|a| Some(a.id.as_str()) == preview.action_id.as_deref())
        && crate::input_prompt::needs_inputs(config, action)
    {
        flush_log_entries(runtime_store, log_entries);
        count_press(config, preview, &action.id, !menu_pick);
        let (app_run, store, config_run, preview_run, action_run) = (app.clone(), runtime_store.clone(), config.clone(), preview.clone(), action.clone());
        crate::input_prompt::ask(app, &action.display_name, crate::input_prompt::fields_of(config, action), move |values| {
            let filled = crate::input_prompt::filled_config(&config_run, &action_run, &values);
            // Counted and throttled already: run as a menu pick does.
            run_fire_and_forget(&app_run, &store, &filled, &preview_run, Vec::new(), is_fg_elevated, true, None);
        }, || log::info!("[prompt] cancelled: nothing sent"));
        return;
    }
    // A menu opens its popup; the item picked there runs through `run_menu_item`.
    if let Some(action) = config.actions.iter().find(|a| Some(a.id.as_str()) == preview.action_id.as_deref())
        && let crate::config::ActionPayload::Menu(payload) = &action.payload
    {
        flush_log_entries(runtime_store, log_entries);
        count_press(config, preview, &action.id, !menu_pick);
        crate::menu_popup::open(app, runtime_store, config, preview, &action.display_name, payload, is_fg_elevated);
        if crate::fake_mode() {
            log::info!(
                "[capture] E2E execution {}",
                serde_json::json!({
                    "encodedKey": preview.encoded_key,
                    "controlId": preview.control_id,
                    "layer": preview.layer,
                    "actionId": action.id,
                    "profileId": preview.resolved_profile_id,
                    "outcome": "menuOpened",
                })
            );
        }
        return;
    }
    // A live sequence (pauses up to 30 s a step) runs on the sequence thread, so
    // the capture worker is free for the next press — and its release — at once.
    let is_sequence = config.actions.iter().any(|a| {
        Some(a.id.as_str()) == preview.action_id.as_deref()
            && matches!(a.payload, crate::config::ActionPayload::Sequence(_))
    });
    if is_sequence && !crate::fake_mode() {
        let (app, store, config, preview) = (app.clone(), runtime_store.clone(), Arc::new(config.clone()), preview.clone());
        let entries: Vec<(String, crate::ui_text::UiText, bool)> =
            log_entries.into_iter().map(|(category, text, error)| (category.to_owned(), text, error)).collect();
        let queued = executor::live_sequence_generation();
        let guard_config = config.clone();
        let guard_preview = preview.clone();
        let (notify_app, notify_store, notify_settings) = (app.clone(), store.clone(), config.settings.clone());
        let admitted = submit_sequence(guarded_sequence_job(queued, executor::live_sequence_generation, move || {
            gesture_target.as_ref().is_none_or(|target| {
                let payload = guard_config.actions.iter().find(|action| Some(action.id.as_str()) == guard_preview.action_id.as_deref()).map(|action| &action.payload);
                let current = window_capture::capture_active_window_with_resolution(&guard_config, "", None).ok();
                gesture_dispatch_allowed(payload, target, current.as_ref(), SUPPRESS_EXECUTION.load(Ordering::Relaxed), key_recording())
            })
        }, move || {
            let log_entries = entries.iter().map(|(c, t, e)| (c.as_str(), t.clone(), *e)).collect();
            let executed = executor::run_preview_action(&config, &preview);
            report_execution(&app, &store, &config, &preview, log_entries, is_fg_elevated, menu_pick, executed);
        }));
        report_sequence_admission(&notify_app, &notify_store, &notify_settings, admitted);
        return;
    }
    // A test run against virtual mice resolves and reports, but sends nothing.
    let executed = if crate::fake_mode() {
        executor::execute_preview_action(config, preview)
    } else {
        executor::run_preview_action(config, preview)
    };
    report_execution(app, runtime_store, config, preview, log_entries, is_fg_elevated, menu_pick, executed);
}

/// Live sequences run on one thread, one after another (a second waits for the
/// first). Bounded: a full queue drops the press instead of piling up.
/// Macros queued or running: the ones a new press waits behind.
static SEQUENCES_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Tells the user a macro press that does not start at once: one waiting
/// behind others (how many), or one dropped because the queue is full.
fn report_sequence_admission(app: &AppHandle, store: &Arc<Mutex<RuntimeStore>>, settings: &crate::config::Settings, admitted: Option<usize>) {
    let text = match admitted {
        Some(0) => return,
        Some(ahead) => crate::ui_text!("execution.sequenceQueued", "Macro waits: {ahead} ahead of it.", ahead = ahead),
        None => {
            let text = crate::ui_text!(
                "execution.sequenceDropped",
                "Macro not started: {count} are already waiting. \"Stop macros\" ends them.",
                count = SEQUENCE_QUEUE
            );
            if let Ok(mut store) = store.lock() {
                store.record_warn("execution", text.clone());
            }
            text
        }
    };
    crate::show_osd(app, "", &crate::ui_text::native(&text), settings);
}

/// `Some(n)` when accepted, `n` the macros ahead of it; `None` when dropped.
fn submit_sequence(job: Box<dyn FnOnce() + Send>) -> Option<usize> {
    type Job = Box<dyn FnOnce() + Send>;
    static RUNNER: std::sync::OnceLock<Option<std::sync::mpsc::SyncSender<Job>>> = std::sync::OnceLock::new();
    let runner = RUNNER.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Job>(SEQUENCE_QUEUE);
        std::thread::Builder::new()
            .name("sequence-runner".into())
            .spawn(move || receiver.into_iter().for_each(|job| job()))
            .inspect_err(|error| log::error!("[capture] sequence thread not started: {error}"))
            .ok()
            .map(|_| sender)
    });
    let ahead = SEQUENCES_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
    let counted: Box<dyn FnOnce() + Send> = Box::new(move || {
        job();
        SEQUENCES_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    });
    if queue_sequence(runner.as_ref(), counted) {
        Some(ahead)
    } else {
        SEQUENCES_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        None
    }
}

fn queue_sequence(runner: Option<&std::sync::mpsc::SyncSender<Box<dyn FnOnce() + Send>>>, job: Box<dyn FnOnce() + Send>) -> bool {
    match runner {
        Some(sender) => match sender.try_send(job) {
            Ok(()) => true,
            Err(error) => {
                log::warn!("[capture] Sequence press dropped: {error}");
                false
            }
        },
        None => {
            log::error!("[capture] Sequence press dropped: no sequence thread");
            false
        }
    }
}

/// Presses of sequences that may wait behind the one running.
const SEQUENCE_QUEUE: usize = 8;

fn guarded_sequence_job(
    queued: u64,
    generation: impl FnOnce() -> u64 + Send + 'static,
    allowed: impl FnOnce() -> bool + Send + 'static,
    run: impl FnOnce() + Send + 'static,
) -> Box<dyn FnOnce() + Send> {
    Box::new(move || {
        if generation() == queued && allowed() {
            run();
        } else {
            log::info!("[capture] Queued sequence dropped: cancelled or capture target changed before it started");
        }
    })
}

/// Logs, emits and shows what an action run did (or why it failed).
#[allow(clippy::too_many_arguments)]
fn report_execution(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    preview: &resolver::ResolvedInputPreview,
    mut log_entries: Vec<(&str, crate::ui_text::UiText, bool)>,
    is_fg_elevated: bool,
    menu_pick: bool,
    executed: Result<executor::ActionExecutionEvent, executor::ExecutorError>,
) {
    match executed {
        Ok(mut execution) => {
            if is_fg_elevated {
                execution.warnings.push(crate::ui_text!(
                    "capture.elevatedWarning",
                    "The active window runs as administrator — input may be blocked (UIPI)."
                ));
            }
            log::info!(
                "[capture] Action complete for {} (outcome: {:?})",
                execution.encoded_key,
                execution.outcome
            );
            if crate::fake_mode() {
                log::info!(
                    "[capture] E2E execution {}",
                    serde_json::json!({
                        "encodedKey": execution.encoded_key,
                        "controlId": preview.control_id,
                        "layer": preview.layer,
                        "actionId": execution.action_id,
                        "profileId": execution.resolved_profile_id,
                        "outcome": execution.outcome,
                    })
                );
            }
            log_entries.push((
                "execution",
                crate::ui_text!(
                    "capture.actionDone",
                    "Ran `{action}` for `{key}`.",
                    action = &execution.action_pretty,
                    key = &execution.encoded_key
                ),
                false,
            ));
            for warning in &execution.warnings {
                log_entries.push(("execution", warning.clone(), true));
            }
            flush_log_entries(runtime_store, log_entries);
            // Audit F003: apply the ProfileSwitch side effect HERE (live path only),
            // never on the Test/dry-run path. Set the sticky override so subsequent
            // input — and the OSD indicator — resolve under the switched-to profile.
            if let Some(action_id) = preview.action_id.as_deref()
                && let Some(action) = config.actions.iter().find(|a| a.id == action_id)
                && let crate::config::ActionPayload::ProfileSwitch(p) = &action.payload
                && let Ok(mut store) = runtime_store.lock()
            {
                store.set_manual_profile_override(Some(p.target_profile_id.clone()));
                drop(store);
                follow_manual_profile(&p.target_profile_id);
            }
            let _ = app.emit(EVENT_ACTION_EXECUTED, &execution);
            count_press(config, preview, &execution.action_id, !menu_pick);
            // What went out, in the OSD (`Settings.osdActions`): not for clicks
            // and scrolls, and briefer than a profile switch.
            if config.settings.osd_actions && execution.action_type != "mouseAction" && !crate::fake_mode() {
                let mut settings = config.settings.clone();
                settings.osd_duration_ms = settings.osd_duration_ms.min(ACTION_OSD_MS);
                crate::show_osd(app, "", &execution.action_pretty, &settings);
            }
        }
        // Stopped on purpose (capture stopped, profile switched by hand): a note, not a failure.
        Err(error) if error.code == "execution_cancelled" => {
            log::info!("[capture] Sequence for {} cancelled", preview.encoded_key);
            log_entries.push(("execution", error.event.message.clone(), true));
            flush_log_entries(runtime_store, log_entries);
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

/// Counts a run in the daily press log: its place (profile, layer, control and
/// the binding's press pattern) and its action. Wheel scrolling (zoom too: a
/// scroll with Ctrl) is left out: they fire per notch and would bury every button.
fn count_press(config: &AppConfig, preview: &resolver::ResolvedInputPreview, action_id: &str, place: bool) {
    let scrolls = config.actions.iter().find(|action| action.id == action_id).is_some_and(|action| {
        matches!(&action.payload, crate::config::ActionPayload::MouseAction(mouse) if matches!(mouse.action,
            crate::config::MouseActionKind::ScrollUp | crate::config::MouseActionKind::ScrollDown
                | crate::config::MouseActionKind::ScrollLeft | crate::config::MouseActionKind::ScrollRight))
    });
    let (Some(profile), Some(layer), Some(control)) =
        (preview.resolved_profile_id.as_deref(), preview.layer.as_deref(), preview.control_id.as_deref())
    else {
        return;
    };
    if scrolls {
        return;
    }
    let gesture = preview
        .binding_id
        .as_deref()
        .and_then(|id| config.bindings.iter().find(|binding| binding.id == id))
        .map_or("press", |binding| match config::Gesture::of(binding.trigger_mode) {
            config::Gesture::Press => "press",
            config::Gesture::LongPress => "longPress",
            config::Gesture::DoublePress => "doublePress",
            config::Gesture::TriplePress => "triplePress",
        });
    let slot = crate::press_log::slot_key(profile, layer, control, gesture);
    crate::press_log::count(place.then_some(slot.as_str()), action_id);
}

/// Longest the OSD names an action run (`Settings.osdActions`).
const ACTION_OSD_MS: u32 = 1200;

/// Run the item picked in a menu as if the menu's own press had resolved to it
/// (same profile, window, control and layer).
pub(crate) fn run_menu_item(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config: &AppConfig,
    menu_press: &resolver::ResolvedInputPreview,
    action_id: &str,
    is_fg_elevated: bool,
    completed: impl FnOnce(bool) + Send + 'static,
) {
    let Some(action) = config.actions.iter().find(|action| action.id == action_id) else {
        log::warn!("[menu] item action `{action_id}` no longer exists");
        completed(false);
        return;
    };
    let is_sequence = matches!(action.payload, config::ActionPayload::Sequence(_));
    let (notify_app, notify_store, notify_settings) = (app.clone(), runtime_store.clone(), config.settings.clone());
    let (app, store, config, menu_press, action) = (app.clone(), runtime_store.clone(), config.clone(), menu_press.clone(), action.clone());
    let queued = executor::live_sequence_generation();
    let run = menu_item_job(is_sequence.then_some(queued), executor::live_sequence_generation, move |completed| {
        // The popup has returned focus; recheck the selected action, retaining the opening profile/control/layer.
        let context = if action.conditions.is_empty() { None } else {
            window_capture::capture_active_window_with_resolution(&config, "Sidearm", None).ok()
        };
        let preview = menu_item_preview(&menu_press, &action, context.as_ref().map(|window| (window.exe.as_str(), window.title.as_str())));
        if preview.status != resolver::ResolutionStatus::Resolved {
            flush_log_entries(&store, vec![("resolution", crate::ui_text!(
                "capture.signalConditionUnmet", "Signal `{key}` resolved, but the action's conditions are not met: {reason}",
                key = &preview.encoded_key, reason = &action.display_name
            ), false)]);
            completed(false);
            return;
        }
        if matches!(action.payload, config::ActionPayload::Menu(_)) {
            run_fire_and_forget(&app, &store, &config, &preview, Vec::new(), is_fg_elevated, true, None);
            completed(false); // Opening another menu has not inserted text.
            return;
        }
        if crate::input_prompt::needs_inputs(&config, &action) {
            let done = Arc::new(Mutex::new(Some(completed)));
            let done_cancel = done.clone();
            let (app_run, store_run, action_run) = (app.clone(), store.clone(), action.clone());
            crate::input_prompt::ask(&app, &action.display_name, crate::input_prompt::fields_of(&config, &action), move |values| {
                let filled = crate::input_prompt::filled_config(&config, &action_run, &values);
                let completed = done.lock().ok().and_then(|mut slot| slot.take());
                let settings = filled.settings.clone();
                let (notify_app, notify_store) = (app_run.clone(), store_run.clone());
                let run = move || run_menu_execution(
                    || executor::run_preview_action(&filled, &preview),
                    |executed| report_execution(&app_run, &store_run, &filled, &preview, Vec::new(), is_fg_elevated, true, executed),
                    move |ok| if let Some(completed) = completed { completed(ok) },
                );
                // A filled macro waits its turn behind the others, like any macro.
                if is_sequence {
                    let admitted = submit_sequence(Box::new(run));
                    report_sequence_admission(&notify_app, &notify_store, &settings, admitted);
                } else {
                    run();
                }
            }, move || {
                if let Some(completed) = done_cancel.lock().ok().and_then(|mut slot| slot.take()) {
                    completed(false); // nothing inserted: no Enter either
                }
            });
            return;
        }
        log::info!(
            "[capture] Dispatching action for {} (control {}, layer {})",
            preview.encoded_key,
            preview.control_id.as_deref().unwrap_or("?"),
            preview.layer.as_deref().unwrap_or("?")
        );
        run_menu_execution(|| {
            if crate::fake_mode() {
                executor::execute_preview_action(&config, &preview)
            } else {
                executor::run_preview_action(&config, &preview)
            }
        }, |executed| report_execution(&app, &store, &config, &preview, Vec::new(), is_fg_elevated, true, executed), completed);
    }, completed);
    if is_sequence && !crate::fake_mode() {
        let admitted = submit_sequence(run);
        report_sequence_admission(&notify_app, &notify_store, &notify_settings, admitted);
    } else {
        run();
    }
}

fn run_menu_execution<T, E>(execute: impl FnOnce() -> Result<T, E>, report: impl FnOnce(Result<T, E>), completed: impl FnOnce(bool)) {
    let executed = execute();
    let succeeded = executed.is_ok();
    report(executed);
    completed(succeeded);
}

fn menu_item_job(
    queued: Option<u64>,
    generation: impl FnOnce() -> u64 + Send + 'static,
    run: impl FnOnce(Box<dyn FnOnce(bool) + Send>) + Send + 'static,
    completed: impl FnOnce(bool) + Send + 'static,
) -> Box<dyn FnOnce() + Send> {
    Box::new(move || {
        if queued.is_some_and(|queued| generation() != queued) {
            log::info!("[menu] Queued item cancelled before it started");
            completed(false);
        } else {
            run(Box::new(completed));
        }
    })
}

fn menu_item_preview(menu_press: &resolver::ResolvedInputPreview, action: &config::Action, context: Option<(&str, &str)>) -> resolver::ResolvedInputPreview {
    let mut preview = menu_press.clone();
    preview.action_id = Some(action.id.clone());
    preview.action_type = Some(action.action_type.as_str().into());
    preview.action_pretty = Some(action.display_name.clone());
    preview.trigger_mode = None;
    if !action.conditions.is_empty() && !context.is_some_and(|(exe, title)| executor::evaluate_conditions(&action.conditions, exe, title)) {
        preview.status = resolver::ResolutionStatus::ConditionUnmet;
        preview.reason = action.display_name.clone();
    }
    preview
}

/// Emit the resolved-profile event and, when the active profile changed, show
/// the OSD. Shared by the manual key-event path and the per-OS foreground
/// watchers (the tail was previously copied in mod.rs, windows.rs, linux.rs).
/// A profile chosen by hand (tray, ProfileSwitch action): the HyperShift 2
/// trigger follows it at once, without waiting for a window change.
pub(crate) fn follow_manual_profile(profile_id: &str) {
    #[cfg(target_os = "windows")]
    windows::follow_profile_hypershift2(Some(profile_id));
    #[cfg(not(target_os = "windows"))]
    let _ = profile_id;
}

pub(crate) fn emit_profile_resolved_and_notify(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    capture_result: &window_capture::WindowCaptureResult,
    config: &AppConfig,
) {
    let _ = app.emit(EVENT_PROFILE_RESOLVED, capture_result);

    if !capture_result.ignored {
        // Remember the real foreground window (so the tray "create rule" path can
        // fall back to it — at tray-click time the live foreground is Sidearm) and
        // decide whether the profile changed, in a single lock acquisition.
        #[cfg(target_os = "windows")]
        windows::follow_profile_hypershift2(capture_result.resolved_profile_id.as_deref());
        let should_notify = if let Ok(mut store) = runtime_store.lock() {
            store.set_last_foreground_window(capture_result.clone());
            store.notify_profile_change(capture_result.resolved_profile_id.as_deref())
        } else {
            false
        };
        if should_notify {
            let profile_name = capture_result
                .resolved_profile_name
                .as_deref()
                .unwrap_or("Default");
            let label = crate::ui_text::native(&crate::ui_text!("runtime.osdProfileLabel", "Profile:"));
            crate::show_osd(app, &label, profile_name, &config.settings);
            #[cfg(target_os = "windows")]
            if let Some(profile) = capture_result
                .resolved_profile_id
                .as_deref()
                .and_then(|id| config.profiles.iter().find(|p| p.id == id))
            {
                crate::mouse_speed::apply_profile_mouse_settings(profile);
            }
        }
    }
}

fn flush_log_entries(runtime_store: &Arc<Mutex<RuntimeStore>>, entries: Vec<(&str, crate::ui_text::UiText, bool)>) {
    if entries.is_empty() {
        return;
    }
    match runtime_store.lock() {
        Ok(mut store) => {
            for (source, message, is_warn) in entries {
                if is_warn {
                    store.record_warn(source, message);
                } else {
                    store.record_info(source, message);
                }
            }
        }
        _ => {
            log::error!("[capture] runtime_store mutex poisoned while flushing log entries");
        }
    }
}

fn emit_runtime_error(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    event: &RuntimeErrorEvent,
) {
    match runtime_store.lock() {
        Ok(mut store) => {
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
            // The context goes into the English text only: the translation
            // keeps its key and params.
            let mut message = event.message.clone();
            message.text.push_str(&suffix);
            store.record_warn(
                event.category.clone(),
                message,
            );
        }
        _ => {
            log::error!(
                "[{}] runtime_store mutex poisoned while recording runtime error: {}",
                event.category,
                event.message
            );
        }
    }

    let _ = app.emit(EVENT_RUNTIME_ERROR, event);
}

#[cfg(test)]
mod dispatch_regression_tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn a_full_sequence_queue_says_the_press_was_dropped() {
        let (sender, _receiver) = std::sync::mpsc::sync_channel::<Box<dyn FnOnce() + Send>>(1);
        assert!(queue_sequence(Some(&sender), Box::new(|| {})), "room left: queued");
        assert!(!queue_sequence(Some(&sender), Box::new(|| {})), "full: dropped, and the caller is told");
        assert!(!queue_sequence(None, Box::new(|| {})), "no runner: dropped");
    }

    #[test]
    fn menu_item_checks_its_own_exe_and_title_conditions() {
        let config = config::default_seed_config();
        let key = &config.encoder_mappings[0].encoded_key;
        let press = resolver::resolve_input_preview(&config, key, "notepad.exe", "Notes", None);
        let mut action = config.actions[0].clone();
        action.conditions = vec![config::ActionCondition::ExeEquals { value: "excel.exe".into() }, config::ActionCondition::WindowTitleContains { value: "Budget".into() }];
        for context in [None, Some(("notepad.exe", "Budget")), Some(("excel.exe", "Notes"))] {
            let preview = menu_item_preview(&press, &action, context);
            assert_eq!(preview.status, resolver::ResolutionStatus::ConditionUnmet);
            assert!(executor::execute_preview_action(&config, &preview).is_err());
        }
        let preview = menu_item_preview(&press, &action, Some(("EXCEL.EXE", "Annual Budget")));
        assert_eq!(preview.status, resolver::ResolutionStatus::Resolved);
        assert_eq!(preview.control_id, press.control_id);
        assert_eq!(preview.resolved_profile_id, press.resolved_profile_id);
        action.conditions.clear();
        assert_eq!(menu_item_preview(&press, &action, None).status, resolver::ResolutionStatus::Resolved);
    }

    #[test]
    fn capture_mode_cancels_pending_gestures_but_allows_hold_releases() {
        let now = Instant::now();
        let mut gestures = gestures::Gestures::default();
        gestures.press("F13", gestures::Patterns { long: true, ..Default::default() }, (), now);
        assert!(suppresses_event(&mut gestures, true, false));
        assert!(!suppresses_event(&mut gestures, true, true), "an existing hold must see its key-up");
        assert!(gestures.release("F13", now + Duration::from_millis(100)).is_empty());
        assert!(gestures.tick(now + Duration::from_secs(1)).is_empty());
        assert!(gestures.next_deadline().is_none());
    }

    #[test]
    fn fake_native_wheel_never_reaches_the_input_sink() {
        let mut sent = Vec::new();
        replay_native_wheel(config::MouseActionKind::ScrollDown, false, true, |action| { sent.push(action); Ok(()) }).unwrap();
        assert!(sent.is_empty());
        replay_native_wheel(config::MouseActionKind::ScrollDown, false, false, |action| { sent.push(action); Ok(()) }).unwrap();
        assert_eq!(sent, [config::MouseActionKind::ScrollDown]);
        replay_native_wheel(config::MouseActionKind::ScrollUp, true, false, |_| panic!("repeats are no scroll")).unwrap();
        assert_eq!(replay_native_wheel(config::MouseActionKind::ScrollUp, false, false, |_| Err("input failed".into())), Err("input failed".into()));
    }

    #[test]
    fn delayed_input_is_cancelled_when_its_foreground_window_changes() {
        let target = |hwnd: &str| GestureTarget { hwnd: hwnd.into(), exe: String::new(), title: String::new(), process_path: String::new() };
        let shortcut = config::ActionPayload::Shortcut(config::ShortcutActionPayload {
            key: "W".into(), ctrl: true, shift: false, alt: false, win: false, raw: None,
        });
        assert!(!gesture_target_is_current(Some(&shortcut), &target("0xA"), Some(&target("0xB"))));
        assert!(!gesture_target_is_current(Some(&shortcut), &target("0xA"), None));
        assert!(gesture_target_is_current(Some(&shortcut), &target("0xA"), Some(&target("0xA"))));
        let launch = config::ActionPayload::Launch(config::LaunchActionPayload {
            target: "notepad.exe".into(), args: Vec::new(), working_dir: None,
        });
        assert!(gesture_target_is_current(Some(&launch), &target("0xA"), Some(&target("0xB"))));
        assert!(!gesture_target_is_current(Some(&shortcut), &target(""), Some(&target(""))));
        let sequence = config::ActionPayload::Sequence(config::SequenceActionPayload {
            steps: vec![config::SequenceStep::Sleep { delay_ms: 100 }, config::SequenceStep::Text { value: "text".into(), delay_ms: None, repeat: None }],
        });
        assert!(!gesture_target_is_current(Some(&sequence), &target("0xA"), Some(&target("0xB"))));
        for kind in [config::MouseActionKind::LeftClick, config::MouseActionKind::DpiUp] {
            let payload = config::ActionPayload::MouseAction(config::MouseActionPayload {
                action: kind, ctrl: false, shift: false, alt: false, win: false,
            });
            assert_eq!(gesture_target_is_current(Some(&payload), &target("0xA"), Some(&target("0xB"))), kind == config::MouseActionKind::DpiUp);
        }
    }

    fn gnome_window(title: &str) -> window_capture::WindowCaptureResult {
        let mut window = window_capture::without_foreground_window(&config::default_seed_config(), None);
        window.exe = "org.gnome.texteditor".into();
        window.process_path = "/usr/bin/gnome-text-editor".into();
        window.title = title.into();
        window
    }

    fn input_sequence() -> config::ActionPayload {
        config::ActionPayload::Sequence(config::SequenceActionPayload {
            steps: vec![config::SequenceStep::Send { value: "Ctrl+W".into(), delay_ms: None, repeat: None }],
        })
    }

    #[test]
    fn delayed_gnome_input_uses_the_available_window_identity() {
        let a = gnome_window("Document A");
        assert!(a.hwnd.is_empty(), "the real GNOME capture has no HWND");
        let target = GestureTarget::from(&a);
        let payload = input_sequence();
        assert!(gesture_dispatch_allowed(Some(&payload), &target, Some(&a), false, false));
        assert!(!gesture_dispatch_allowed(Some(&payload), &target, Some(&gnome_window("Document B")), false, false));
        let mut other_app = a.clone();
        other_app.exe = "org.gnome.Terminal".into();
        assert!(!gesture_dispatch_allowed(Some(&payload), &target, Some(&other_app), false, false));
        assert!(!gesture_dispatch_allowed(Some(&payload), &target, None, false, false));
    }

    #[test]
    fn queued_gesture_rechecks_window_capture_and_recording_at_start() {
        use std::sync::mpsc::channel;
        for scenario in ["same", "changed", "suppressed", "recording", "cancelled"] {
            let a = gnome_window("Document A");
            let current = Arc::new(Mutex::new((a.clone(), false, false, 7)));
            let (started_tx, started_rx) = channel();
            let (release_tx, release_rx) = channel();
            submit_sequence(Box::new(move || { started_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(5)).unwrap(); }));
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let (sent_tx, sent_rx) = channel();
            let generation_state = current.clone();
            let target_state = current.clone();
            submit_sequence(guarded_sequence_job(7, move || generation_state.lock().unwrap().3, move || {
                let (window, suppressed, recording, _) = &*target_state.lock().unwrap();
                gesture_dispatch_allowed(Some(&input_sequence()), &GestureTarget::from(&a), Some(window), *suppressed, *recording)
            }, move || sent_tx.send("Ctrl+W").unwrap()));
            {
                let mut state = current.lock().unwrap();
                match scenario {
                    "changed" => state.0 = gnome_window("Document B"),
                    "suppressed" => state.1 = true,
                    "recording" => { state.0.ignore_reason = Some(window_capture::OWN_WINDOW_REASON.into()); state.2 = true; }
                    "cancelled" => state.3 += 1,
                    _ => {}
                }
            }
            let (done_tx, done_rx) = channel();
            submit_sequence(Box::new(move || done_tx.send(()).unwrap()));
            release_tx.send(()).unwrap();
            done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(sent_rx.try_iter().count(), usize::from(scenario == "same"), "{scenario}");
        }
    }

    #[test]
    fn menu_execution_reports_failure_and_only_enters_after_queued_success() {
        use std::sync::mpsc::channel;
        for scenario in ["success", "error", "cancelled", "rejected"] {
            let effects = Arc::new(Mutex::new(Vec::new()));
            let execution_effects = effects.clone();
            let completion_effects = effects.clone();
            let report_effects = effects.clone();
            let (entered_tx, entered_rx) = channel();
            let (release_tx, release_rx) = channel();
            let (done_tx, done_rx) = channel();
            let job = menu_item_job(Some(7), move || if scenario == "cancelled" { 8 } else { 7 }, move |completed| {
                run_menu_execution(|| {
                    // Controlled executor: fail its first step before Text, or finish Text after release.
                    execution_effects.lock().unwrap().push("first");
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    if scenario == "error" { return Err("first step failed"); }
                    execution_effects.lock().unwrap().push("Text");
                    Ok(())
                }, |result| report_effects.lock().unwrap().push(if result.is_ok() { "reported ok" } else { "reported error" }), completed);
            }, move |success| {
                crate::menu_popup::finish_pick(crate::menu_popup::PickMode::Enter, success, || completion_effects.lock().unwrap().push("Enter"));
                done_tx.send(()).unwrap();
            });
            if scenario == "rejected" {
                let (sender, _receiver) = std::sync::mpsc::sync_channel(0);
                queue_sequence(Some(&sender), job);
                assert!(effects.lock().unwrap().is_empty());
                continue;
            }
            submit_sequence(job);
            if scenario != "cancelled" {
                entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                assert_eq!(*effects.lock().unwrap(), ["first"], "completion must wait for execution");
                release_tx.send(()).unwrap();
            }
            done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let expected: &[&str] = match scenario {
                "success" => &["first", "Text", "reported ok", "Enter"],
                "error" => &["first", "reported error"],
                _ => &[],
            };
            assert_eq!(*effects.lock().unwrap(), expected, "{scenario}");
        }
    }

    #[test]
    fn short_presses_with_a_long_pattern_obey_binding_throttle() {
        let mut config = config::default_seed_config();
        let key = config.encoder_mappings.first().unwrap().encoded_key.clone();
        let first_preview = resolver::resolve_input_preview(&config, &key, "notepad.exe", "Test", None);
        let id = first_preview.binding_id.as_deref().unwrap();
        let binding = config.bindings.iter_mut().find(|binding| binding.id == id).unwrap();
        binding.throttle_ms = Some(1000);
        let mut long_binding = binding.clone();
        long_binding.id = "long-throttle-regression".into();
        long_binding.trigger_mode = Some(config::TriggerMode::LongPress);
        config.bindings.push(long_binding);
        let enabled_patterns = gesture_patterns(&config, &first_preview, resolver::HeldLayers::default());
        assert!(enabled_patterns.long);
        let mut store = RuntimeStore::default();
        let mut patterns = gestures::Gestures::default();
        let now = Instant::now();
        let mut ran = 0;
        for ms in [0, 200] {
            let at = now + Duration::from_millis(ms);
            patterns.press(&key, enabled_patterns, (), at);
            for (_, gesture) in patterns.release(&key, at + Duration::from_millis(50)) {
                let preview = resolver::resolve_gesture_preview(&config, &key, "notepad.exe", "Test", None, None, resolver::HeldLayers::default(), gesture);
                if check_binding_throttle(&config, &preview, &mut store, 1000 + ms).is_none() {
                    ran += 1;
                }
            }
        }
        assert_eq!(ran, 1);
    }
}

#[cfg(test)]
mod select_held_key_tests {
    use super::{HeldMatch, select_held_key};

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
        assert_eq!(
            select_held_key(held.into_iter(), "F13"),
            HeldMatch::Ambiguous
        );
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
        assert_eq!(
            select_held_key(held.into_iter(), "Alt+F19"),
            HeldMatch::None
        );
    }
}

#[cfg(test)]
mod elevated_notice_tests {
    use super::should_notify_elevated;

    #[test]
    fn should_notify_elevated_once_per_exe() {
        let mut last = None;
        assert!(should_notify_elevated(&mut last, "Admin.exe"));
        assert!(!should_notify_elevated(&mut last, "Admin.exe"));
        assert!(!should_notify_elevated(&mut last, "ADMIN.EXE"));
        assert!(should_notify_elevated(&mut last, "Other.exe"));
    }
}

#[cfg(test)]
mod own_window_tests {
    use super::{can_execute_in_own_window, config};

    #[cfg(target_os = "windows")]
    #[test]
    fn v3_wheel_falls_back_to_scroll_without_an_active_assignment() {
        use super::{native_wheel_scroll, resolver};
        let mut config = crate::mouse_memory::live_overlay::tests::config_with_v3();
        let key = config.encoder_mappings.iter().find(|mapping|
            mapping.control_id.as_str() == "v3_wheel_down" && mapping.layer == config::Layer::Standard
        ).unwrap().encoded_key.clone();
        let resolve = |config: &config::AppConfig| resolver::resolve_input_preview(
            config, &key, "notepad.exe", "Test", None,
        );
        assert_eq!(native_wheel_scroll(&resolve(&config), false), Some(config::MouseActionKind::ScrollDown));
        let mut binding = config.bindings.iter().find(|binding|
            binding.profile_id == config.settings.fallback_profile_id && binding.enabled
        ).unwrap().clone();
        binding.id = "v3-scroll-test".into();
        binding.layer = config::Layer::Standard;
        binding.control_id = config::ControlId::new("v3_wheel_down");
        config.bindings.push(binding);
        let assigned = resolve(&config);
        assert_eq!(native_wheel_scroll(&assigned, false), None);
        assert_eq!(native_wheel_scroll(&assigned, true), Some(config::MouseActionKind::ScrollDown));
    }

    #[test]
    fn everything_runs_in_own_window_but_while_recording_only_dpi_steps() {
        for kind in [
            config::MouseActionKind::DpiUp,
            config::MouseActionKind::DpiDown,
            config::MouseActionKind::LeftClick,
            config::MouseActionKind::ScrollUp,
        ] {
            let payload = config::ActionPayload::MouseAction(config::MouseActionPayload {
                action: kind,
                ctrl: false,
                shift: false,
                alt: false,
                win: false,
            });
            assert_eq!(
                can_execute_in_own_window(Some(&payload), true),
                matches!(kind, config::MouseActionKind::DpiUp | config::MouseActionKind::DpiDown)
            );
            assert!(can_execute_in_own_window(Some(&payload), false));
        }
        let shortcut = config::ActionPayload::Shortcut(config::ShortcutActionPayload {
            key: "Backspace".into(),
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
            raw: None,
        });
        assert!(!can_execute_in_own_window(Some(&shortcut), true));
        assert!(!can_execute_in_own_window(None, true));
        assert!(can_execute_in_own_window(Some(&shortcut), false));
    }
}
