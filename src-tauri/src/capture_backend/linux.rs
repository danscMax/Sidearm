//! Linux capture backend using evdev.
//!
//! Enumerates evdev devices to find a Razer Naga mouse, opens the device
//! (optionally grabbing it), and reads key events on a dedicated thread.
//! F13-F24 key codes are intercepted and sent through an mpsc channel to the
//! worker thread, which delegates to `process_encoded_key_event`.

#![allow(unused_imports)]

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use tauri::{AppHandle, Emitter};

use super::{process_encoded_key_event, EncodedKeyEvent, CAPTURE_BACKEND_NAME};
use crate::{
    config::AppConfig,
    runtime::{self, RuntimeStore, EVENT_PROFILE_RESOLVED},
    window_capture,
};

/// evdev key codes for F13-F24 (KEY_F13 through KEY_F24).
const KEY_F13: u16 = 183;
const KEY_F14: u16 = 184;
const KEY_F15: u16 = 185;
const KEY_F16: u16 = 186;
const KEY_F17: u16 = 187;
const KEY_F18: u16 = 188;
const KEY_F19: u16 = 189;
const KEY_F20: u16 = 190;
const KEY_F21: u16 = 191;
const KEY_F22: u16 = 192;
const KEY_F23: u16 = 193;
const KEY_F24: u16 = 194;

/// evdev key codes for modifier keys.
const KEY_LEFTCTRL: u16 = 29;
const KEY_RIGHTCTRL: u16 = 97;
const KEY_LEFTSHIFT: u16 = 42;
const KEY_RIGHTSHIFT: u16 = 54;
const KEY_LEFTALT: u16 = 56;
const KEY_RIGHTALT: u16 = 100;
const KEY_LEFTMETA: u16 = 125;
const KEY_RIGHTMETA: u16 = 126;

/// evdev event type for key events (EV_KEY).
const EV_KEY: u16 = 1;

/// evdev key event values.
const KEY_RELEASE: i32 = 0;
const KEY_PRESS: i32 = 1;
const KEY_REPEAT: i32 = 2;

pub(super) struct CaptureBackendHandle {
    stop_flag: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
    watcher_thread: Option<JoinHandle<()>>,
    worker_thread: Option<JoinHandle<()>>,
}

/// Modifier state tracker for evdev key events.
#[derive(Clone, Copy, Debug, Default)]
struct ModifierState {
    ctrl: bool,
    shift: bool,
    alt: bool,
    meta: bool,
}

impl ModifierState {
    /// Update modifier state from an evdev key event. Returns true if the
    /// event was a modifier key.
    fn apply_event(&mut self, code: u16, is_down: bool) -> bool {
        match code {
            KEY_LEFTCTRL | KEY_RIGHTCTRL => {
                self.ctrl = is_down;
                true
            }
            KEY_LEFTSHIFT | KEY_RIGHTSHIFT => {
                self.shift = is_down;
                true
            }
            KEY_LEFTALT | KEY_RIGHTALT => {
                self.alt = is_down;
                true
            }
            KEY_LEFTMETA | KEY_RIGHTMETA => {
                self.meta = is_down;
                true
            }
            _ => false,
        }
    }

    /// Build a modifier prefix string for the encoded key.
    /// Example: "Ctrl+Alt+" for ctrl+alt held, or "" for no modifiers.
    fn prefix(self) -> String {
        let mut parts = Vec::new();
        if self.ctrl {
            parts.push("Ctrl");
        }
        if self.shift {
            parts.push("Shift");
        }
        if self.alt {
            parts.push("Alt");
        }
        if self.meta {
            parts.push("Win");
        }
        if parts.is_empty() {
            String::new()
        } else {
            let mut s = parts.join("+");
            s.push('+');
            s
        }
    }
}

/// Map an evdev key code to its F-key display name.
fn evdev_code_to_key_name(code: u16) -> Option<&'static str> {
    match code {
        KEY_F13 => Some("F13"),
        KEY_F14 => Some("F14"),
        KEY_F15 => Some("F15"),
        KEY_F16 => Some("F16"),
        KEY_F17 => Some("F17"),
        KEY_F18 => Some("F18"),
        KEY_F19 => Some("F19"),
        KEY_F20 => Some("F20"),
        KEY_F21 => Some("F21"),
        KEY_F22 => Some("F22"),
        KEY_F23 => Some("F23"),
        KEY_F24 => Some("F24"),
        _ => None,
    }
}

/// Find evdev devices that match "Razer" and "Naga" in their name.
///
/// First pass: look for devices containing both "razer" and "naga".
/// Fallback: accept any device containing "razer" (broader match).
fn find_razer_naga_devices() -> Vec<std::path::PathBuf> {
    let mut result = Vec::new();

    // evdev::enumerate() returns (PathBuf, Device) tuples
    for (path, device) in evdev::enumerate() {
        let name = device.name().unwrap_or_default().to_ascii_lowercase();
        if name.contains("razer") && name.contains("naga") {
            result.push(path);
        }
    }

    // Fallback: accept any Razer device that might emit F-keys
    if result.is_empty() {
        for (path, device) in evdev::enumerate() {
            let name = device.name().unwrap_or_default().to_ascii_lowercase();
            if name.contains("razer") {
                result.push(path);
            }
        }
    }

    result
}

impl CaptureBackendHandle {
    pub(super) fn start(
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<Self, String> {
        let stop_flag = Arc::new(AtomicBool::new(false));

        let (event_tx, event_rx) = mpsc::channel::<EncodedKeyEvent>();

        // --- Worker thread: processes EncodedKeyEvents (same pattern as Windows) ---
        let worker_app = app.clone();
        let worker_runtime_store = runtime_store.clone();
        let worker_config = config.clone();
        let worker_app_name = app_name.clone();
        let worker_thread = thread::spawn(move || {
            let mut held_actions: HashMap<String, crate::input_synthesis::HeldShortcutState> =
                HashMap::new();

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

            // Channel closed -- release all held keys
            for (encoded_key, held) in held_actions.drain() {
                if let Err(e) = crate::input_synthesis::send_shortcut_hold_up(&held) {
                    log::warn!(
                        "[capture] Failed to release held shortcut `{encoded_key}` on shutdown: {e}"
                    );
                }
            }
        });

        // --- Capture thread: reads evdev events ---
        let capture_stop = stop_flag.clone();
        let capture_tx = event_tx.clone();
        let capture_thread = thread::spawn(move || {
            run_evdev_capture_loop(capture_stop, capture_tx);
        });

        // --- Foreground watcher thread: polls active window every ~300ms ---
        let watcher_stop = stop_flag.clone();
        let watcher_app = app.clone();
        let watcher_runtime_store = runtime_store.clone();
        let watcher_config = config.clone();
        let watcher_app_name = app_name.clone();
        let watcher_thread = thread::spawn(move || {
            run_foreground_watcher(
                watcher_stop,
                watcher_app,
                watcher_runtime_store,
                watcher_config,
                watcher_app_name,
            );
        });

        Ok(Self {
            stop_flag,
            capture_thread: Some(capture_thread),
            watcher_thread: Some(watcher_thread),
            worker_thread: Some(worker_thread),
        })
    }

    pub(super) fn stop(mut self) -> Result<(), String> {
        self.stop_flag.store(true, Ordering::SeqCst);

        if let Some(thread) = self.capture_thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.watcher_thread.take() {
            let _ = thread.join();
        }
        // Worker thread exits when the channel sender is dropped (capture_thread ends).
        if let Some(thread) = self.worker_thread.take() {
            let _ = thread.join();
        }

        Ok(())
    }

    /// Rehook is not needed on Linux -- evdev capture runs in-process and
    /// does not use installable hooks that can be unloaded by the OS.
    pub(super) fn rehook(&mut self) -> Result<(), String> {
        log::info!("[capture] Rehook not needed on Linux (evdev capture is in-process).");
        Ok(())
    }
}

/// Main evdev capture loop. Runs on a dedicated thread.
///
/// Finds Razer Naga devices, opens them, and reads key events in a loop.
/// When F13-F24 are detected (with optional modifier tracking), sends
/// EncodedKeyEvent through the channel.
fn run_evdev_capture_loop(stop_flag: Arc<AtomicBool>, event_tx: mpsc::Sender<EncodedKeyEvent>) {
    let device_paths = find_razer_naga_devices();

    if device_paths.is_empty() {
        log::info!(
            "[capture] No Razer Naga evdev devices found — waiting for hotplug."
        );

        // Poll for device connection every 2 seconds until found or stopped.
        loop {
            if stop_flag.load(Ordering::SeqCst) {
                log::info!("[capture] Capture loop stopped while waiting for device.");
                return;
            }
            thread::sleep(std::time::Duration::from_secs(2));
            let paths = find_razer_naga_devices();
            if !paths.is_empty() {
                log::info!(
                    "[capture] Razer Naga device(s) detected via hotplug: {:?}",
                    paths
                );
                // Restart capture with found devices — tail-call into the main loop.
                return run_evdev_capture_loop(stop_flag, event_tx);
            }
        }
    }

    log::info!(
        "[capture] Found {} Razer Naga device(s): {:?}",
        device_paths.len(),
        device_paths
    );

    // Open the first matching device
    let device_path = &device_paths[0];
    let mut device = match evdev::Device::open(device_path) {
        Ok(d) => d,
        Err(e) => {
            log::error!(
                "[capture] Failed to open evdev device {}: {e}",
                device_path.display()
            );
            return;
        }
    };

    log::info!(
        "[capture] Opened evdev device: {} ({})",
        device.name().unwrap_or("unknown"),
        device_path.display()
    );

    // Attempt to grab the device exclusively so other applications don't
    // see the F13-F24 keys. Non-fatal if grab fails (requires root or
    // appropriate udev rules).
    match device.grab() {
        Ok(()) => {
            log::info!("[capture] Grabbed evdev device exclusively.");
        }
        Err(e) => {
            log::warn!(
                "[capture] Could not grab evdev device exclusively: {e}. \
                 F-key events may be seen by other applications."
            );
        }
    }

    let mut modifier_state = ModifierState::default();

    while !stop_flag.load(Ordering::SeqCst) {
        // fetch_events() blocks until events are available. We use a
        // non-blocking poll by reading with a short timeout via the
        // device's underlying file descriptor. However, evdev's
        // fetch_events() is blocking, so we use a small sleep + peek
        // pattern to allow checking the stop flag periodically.
        let events: Vec<evdev::InputEvent> = match device.fetch_events() {
            Ok(events) => events.collect(),
            Err(e) => {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                // EAGAIN or similar -- retry after brief sleep
                let kind = e.kind();
                if kind == std::io::ErrorKind::WouldBlock {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                log::error!("[capture] evdev fetch_events error: {e}");
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };

        for event in events {
            let ev_type = event.event_type().0;
            if ev_type != EV_KEY {
                continue;
            }

            let code = event.code();
            let value = event.value();

            let is_down = value == KEY_PRESS;
            let is_repeat = value == KEY_REPEAT;
            let is_up = value == KEY_RELEASE;

            // Track modifier state
            if modifier_state.apply_event(code, is_down || is_repeat) {
                continue;
            }

            // Only process F13-F24 key events
            let key_name = match evdev_code_to_key_name(code) {
                Some(name) => name,
                None => continue,
            };

            if !is_down && !is_repeat && !is_up {
                continue;
            }

            // Build encoded key with modifier prefix
            let encoded_key = format!("{}{}", modifier_state.prefix(), key_name);

            let event = EncodedKeyEvent {
                encoded_key,
                backend: CAPTURE_BACKEND_NAME.to_owned(),
                received_at: runtime::timestamp_millis(),
                is_repeat,
                is_key_up: is_up,
            };

            if event_tx.send(event).is_err() {
                // Receiver dropped -- shutting down
                break;
            }
        }
    }

    // Release grab on shutdown
    let _ = device.ungrab();
    log::info!("[capture] evdev capture loop exited.");
}

/// Foreground window watcher. Polls the active window every ~300ms and emits
/// profile-resolved events when the foreground application changes.
///
/// On Linux we poll because there is no universal window-change event API
/// that works across both X11 and Wayland without additional dependencies.
fn run_foreground_watcher(
    stop_flag: Arc<AtomicBool>,
    app: AppHandle,
    runtime_store: Arc<Mutex<RuntimeStore>>,
    config: AppConfig,
    app_name: String,
) {
    let mut last_window_id = String::new();

    while !stop_flag.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(300));

        if stop_flag.load(Ordering::SeqCst) {
            break;
        }

        // Skip if a manual capture is in progress
        let is_capturing = runtime_store
            .lock()
            .ok()
            .map(|store| store.is_capture_in_progress())
            .unwrap_or(false);
        if is_capturing {
            continue;
        }

        let capture_result = match window_capture::capture_active_window_with_resolution(
            &config, &app_name, None,
        ) {
            Ok(result) => result,
            Err(_) => continue,
        };

        // Only emit when the foreground window actually changed
        if capture_result.hwnd == last_window_id {
            continue;
        }
        last_window_id.clone_from(&capture_result.hwnd);

        let _ = app.emit(EVENT_PROFILE_RESOLVED, &capture_result);

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
                crate::show_osd(&app, profile_name, &config.settings);
            }
        }
    }

    log::info!("[capture] Foreground watcher exited.");
}

/// Entry point for the capture helper subprocess.
///
/// Not needed on Linux -- evdev capture runs in-process. The helper
/// architecture is a Windows-specific pattern for the LL keyboard hook.
pub fn capture_helper_main() {
    log::info!("[capture-helper] Linux capture runs in-process, helper not needed.");
}
