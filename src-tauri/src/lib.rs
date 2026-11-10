mod ui_text;
mod admin_autostart;
mod backup;
mod capture_backend;
mod chord;
mod command_error;
mod config;
#[cfg(target_os = "windows")]
mod device_catalog;
#[cfg(target_os = "windows")]
mod exe_icon;
mod executor;
mod hotkeys;
mod input_synthesis;
mod log_cleanup;
#[cfg(target_os = "windows")]
mod mouse_memory;
#[cfg(target_os = "windows")]
mod mouse_settings;
#[cfg(target_os = "windows")]
mod mouse_offline;
#[cfg(target_os = "windows")]
mod mouse_restore;
#[cfg(target_os = "windows")]
mod mouse_speed;
#[cfg(target_os = "windows")]
pub use mouse_restore::restore_entry;
#[cfg(target_os = "windows")]
pub(crate) use mouse_restore::{live_map_restore_running, spawn_live_map_restore};
#[cfg(target_os = "windows")]
mod mouse_status;
#[cfg(target_os = "windows")]
mod onboard_guard;
#[cfg(target_os = "windows")]
mod synapse_control;
#[cfg(target_os = "windows")]
mod system_events;
#[cfg(target_os = "windows")]
mod tray_badge;
mod paths;
mod platform;
mod recorder;
mod resolver;
mod runtime;
mod synapse_import;
mod vk;
mod window_capture;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

/// Managed state: cached `minimize_to_tray` setting for the close handler.
/// Updated by `load_config` and `save_config`; read by `CloseRequested`.
/// Initial value `false` (window closes) until config is loaded.
type MinimizeToTray = Arc<AtomicBool>;

/// Fingerprint of the `config.json` this process last loaded or saved. Read by
/// `save_config` to detect a concurrent overwrite by ANOTHER Sidearm instance
/// (e.g. the elevated autostart instance vs a manual launch) and refuse to
/// clobber its edits. `None` until the first load. See `config::config_file_stamp`.
type ConfigStamp = Arc<Mutex<Option<u64>>>;

/// Last global shortcut string actually registered with the OS. Lets a save
/// re-register only when the value changed (see `plan_global_shortcut`),
/// instead of tearing down the live hotkey on every unrelated save.
type CurrentGlobalShortcut = Arc<Mutex<Option<String>>>;

use capture_backend::RuntimeController;
pub use capture_backend::capture_helper_main;

#[cfg(target_os = "windows")]
pub use admin_autostart::{HELPER_ARG as ADMIN_AUTOSTART_HELPER_ARG, helper_main as admin_autostart_helper_main};
use command_error::CommandError;
use config::{
    AppConfig, ConfigStoreError, DEFAULT_GLOBAL_SHORTCUT, LoadConfigResponse, SaveConfigResponse,
    load_or_initialize_config, read_and_migrate_config_file, save_config as save_config_to_store,
};
use executor::{ActionExecutionEvent, RuntimeErrorEvent};
use recorder::MacroRecorder;
use resolver::ResolvedInputPreview;
use runtime::{
    DebugLogEntry, EVENT_ACTION_EXECUTED, EVENT_CONFIG_RELOADED, EVENT_CONTROL_RESOLVED,
    EVENT_DEBUG_LOG_APPENDED, EVENT_PROFILE_RESOLVED, EVENT_QUICK_RULE_FAILED,
    EVENT_QUICK_RULE_START, EVENT_RUNTIME_ERROR, EVENT_RUNTIME_STARTED, EVENT_RUNTIME_STOPPED,
    EVENT_SINGLE_INSTANCE_BLOCKED, EVENT_TRAY_PROFILE_CHANGED, RuntimeStateSummary, RuntimeStore,
};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use window_capture::WindowCaptureResult;

/// Lock a `Mutex`, recovering from poisoning (a panic in another thread while
/// holding the lock) by taking the inner value. Sidearm's runtime state stays
/// readable after such a panic — `release_all_modifiers` runs via
/// `catch_unwind` — so recovering beats failing the command. Replaces the
/// repeated `.lock().recover_poison()` idiom.
trait RecoverPoison<'a, T> {
    fn recover_poison(self) -> std::sync::MutexGuard<'a, T>;
}

impl<'a, T> RecoverPoison<'a, T> for std::sync::LockResult<std::sync::MutexGuard<'a, T>> {
    fn recover_poison(self) -> std::sync::MutexGuard<'a, T> {
        self.unwrap_or_else(|e| e.into_inner())
    }
}

/// Generation counter for OSD hide timer cancellation.
/// Each show_osd call increments this; the hide thread only hides if the
/// generation hasn't changed, preventing premature hide on rapid switches.
static OSD_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Request sent to the single long-lived OSD hide-timer thread.
struct OsdHideRequest {
    win: tauri::WebviewWindow,
    generation: u64,
    duration_ms: u64,
}

/// Sender to the one OSD hide-timer thread. Replaces the previous
/// thread-spawn-per-show, which could pile up dozens of sleeping threads under
/// rapid profile/window switching (each living up to osd_duration_ms).
static OSD_HIDE_TX: std::sync::OnceLock<std::sync::mpsc::Sender<OsdHideRequest>> =
    std::sync::OnceLock::new();

fn osd_hide_sender() -> &'static std::sync::mpsc::Sender<OsdHideRequest> {
    OSD_HIDE_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<OsdHideRequest>();
        std::thread::spawn(move || {
            let mut pending: Option<OsdHideRequest> = None;
            loop {
                match pending.take() {
                    // Idle: block until the next show request arrives.
                    None => match rx.recv() {
                        Ok(req) => pending = Some(req),
                        Err(_) => return, // all senders dropped (app shutdown)
                    },
                    // Waiting out a request's duration. A newer request supersedes
                    // it (restart the wait); a timeout fires the hide. The Ok arm
                    // must NOT hide — it means a fresher show arrived.
                    Some(req) => {
                        match rx.recv_timeout(std::time::Duration::from_millis(req.duration_ms)) {
                            Ok(newer) => pending = Some(newer),
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                if OSD_GENERATION.load(Ordering::Acquire) == req.generation {
                                    let _ = req.win.hide();
                                }
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                        }
                    }
                }
            }
        });
        tx
    })
}

/// Check whether the current foreground window is fullscreen on its monitor.
fn is_foreground_fullscreen() -> bool {
    #[cfg(target_os = "windows")]
    return crate::platform::window::is_foreground_fullscreen();
    #[cfg(target_os = "linux")]
    return crate::platform::window::is_foreground_fullscreen();
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    return false;
}

/// Show the OSD notification bubble with the profile name.
///
/// OSD window lifecycle (lazy creation):
/// 1. First call: create the window and return without showing (let WebView load JS).
/// 2. Subsequent calls: window exists, emit event + position + show + auto-hide.
///
/// This avoids startup flash, event loss, and foreground watcher interference.
/// Shows the OSD bubble: `label` (bold-less, may be empty) then `profile_name`.
pub(crate) fn show_osd(app: &AppHandle, label: &str, profile_name: &str, settings: &config::Settings) {
    if !settings.osd_enabled {
        return;
    }
    if is_foreground_fullscreen() {
        return;
    }

    let w = match app.get_webview_window("osd") {
        Some(w) => w,
        None => {
            create_osd_window(app);
            return; // WebView loading; next call will show
        }
    };

    // --- Measure text width for pixel-perfect sizing ---
    // GDI returns logical pixels; Tauri set_size/set_position use physical.
    // Multiply by DPI scale factor to convert.
    let dpi_scale = {
        #[cfg(target_os = "windows")]
        {
            crate::platform::display::get_cursor_monitor_dpi_scale()
        }
        #[cfg(target_os = "linux")]
        {
            crate::platform::display::get_dpi_scale()
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            1.0_f64
        }
    };

    let font_px = match settings.osd_font_size {
        config::OsdFontSize::Small => 11_i32,
        config::OsdFontSize::Medium => 12,
        config::OsdFontSize::Large => 14,
    };
    // Measure label (weight 500) and name (weight 700) separately
    let label_width = if label.is_empty() { 0 } else { measure_text_width(label, "Segoe UI", font_px, 500) };
    let name_width = measure_text_width(profile_name, "Segoe UI", font_px, 700);
    let logical_padding = 16 + 8 + 16 + 8; // left-pad + gap + right-pad + safety (GDI vs WebView2)
    let logical_width = label_width + name_width + logical_padding;

    // Convert to physical pixels for Tauri
    let win_width = (logical_width as f64 * dpi_scale).ceil() as i32;
    let height = (32.0 * dpi_scale).ceil() as i32;
    let margin = (6.0 * dpi_scale).ceil() as i32;

    log::debug!(
        "[osd] label_w={label_width} name_w={name_width} pad={logical_padding} \
         logical={logical_width} dpi={dpi_scale} physical_w={win_width} h={height}"
    );

    // --- Anchor on target monitor → Size → read outer size → Position → Show ---
    // Order matters on mixed-DPI multi-monitor setups: moving a window across
    // monitors fires WM_DPICHANGED and Windows rescales it by target_dpi/source_dpi.
    // If we sized the window while it was still parked on the primary monitor and
    // only moved it afterwards, that move would silently rescale our physical size —
    // clipping the text on a lower-DPI monitor, overflowing the screen edge on a
    // higher-DPI one. So we move onto the cursor's monitor FIRST (letting the DPI
    // change settle) using a rough anchor, then set the physical size — which now
    // sticks because no further cross-monitor move follows.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let (ax, ay) = crate::platform::display::position_osd_on_monitor(
            &settings.osd_position,
            win_width,
            height,
            margin,
        );
        let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: ax,
            y: ay,
        }));
    }

    let _ = w.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: win_width as u32,
        height: height as u32,
    }));

    // Read back actual outer size (includes any window frame/border added by the
    // OS or WebView2) now that the window lives in its final DPI context, then
    // place it precisely at the chosen corner.
    let outer = w.outer_size().unwrap_or(tauri::PhysicalSize {
        width: win_width as u32,
        height: height as u32,
    });
    let ow = outer.width as i32;
    let oh = outer.height as i32;

    log::debug!("[osd] readback outer_w={ow} outer_h={oh} (computed win_w={win_width})");

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let (x, y) = crate::platform::display::position_osd_on_monitor(
            &settings.osd_position,
            ow,
            oh,
            margin,
        );
        let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }

    let _ = w.show();

    // Emit for JS to update text and animate (no sizing/positioning in JS)
    let font_size_str = match settings.osd_font_size {
        config::OsdFontSize::Small => "small",
        config::OsdFontSize::Medium => "medium",
        config::OsdFontSize::Large => "large",
    };
    let animation_str = match settings.osd_animation {
        config::OsdAnimation::SlideIn => "slideIn",
        config::OsdAnimation::FadeIn => "fadeIn",
        config::OsdAnimation::None => "none",
    };
    let _ = app.emit(
        "osd-show",
        serde_json::json!({
            "name": profile_name,
            "label": label,
            "fontSize": font_size_str,
            "animation": animation_str,
        }),
    );

    // Auto-hide: hand the request to the single hide-timer thread instead of
    // spawning a fresh sleeping thread on every show.
    let generation = OSD_GENERATION.fetch_add(1, Ordering::Release) + 1;
    let duration_ms = settings.osd_duration_ms.clamp(500, 10000) as u64;
    let _ = osd_hide_sender().send(OsdHideRequest {
        win: w.clone(),
        generation,
        duration_ms,
    });
}

fn measure_text_width(text: &str, font_family: &str, font_size_px: i32, font_weight: i32) -> i32 {
    #[cfg(target_os = "windows")]
    return crate::platform::display::measure_text_width(
        text,
        font_family,
        font_size_px,
        font_weight,
    );
    #[cfg(target_os = "linux")]
    return crate::platform::display::measure_text_width(
        text,
        font_family,
        font_size_px,
        font_weight,
    );
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (text, font_family, font_weight);
        return font_size_px * 8;
    }
}

/// Create the hidden OSD window (called lazily on first show_osd).
/// Positioned off-screen and explicitly hidden to prevent any flash.
fn create_osd_window(app: &AppHandle) {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    if let Ok(w) = WebviewWindowBuilder::new(app, "osd", WebviewUrl::App("/osd.html".into()))
        .title("")
        .inner_size(1.0, 1.0) // Rust resizes before showing
        .position(-9999.0, -9999.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .visible(false)
        .background_color(tauri::window::Color(0x1a, 0x1f, 0x16, 0xff))
        .build()
    {
        // Belt-and-suspenders: force hide even if visible(false) is ignored
        let _ = w.hide();
    }
}

fn resolve_app_paths(app: &AppHandle) -> Arc<paths::AppPaths> {
    app.state::<Arc<paths::AppPaths>>().inner().clone()
}

fn resolve_config_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(resolve_app_paths(app).config_dir.clone())
}

/// Build the system-tray context menu from the current config + runtime state.
/// The active-profile row reflects the manual tray/ProfileSwitch selection
/// (falling back to the configured fallback profile), not the per-window
/// auto-resolution which changes with every foreground window.
fn build_tray_menu(
    app: &AppHandle,
    profiles: &[config::Profile],
    active_profile_id: Option<&str>,
    is_running: bool,
    is_elevated: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    let active_name = active_profile_id
        .and_then(|id| profiles.iter().find(|p| p.id == id))
        .map(|p| p.name.as_str())
        .unwrap_or("—");

    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "active_profile",
        crate::ui_text::native(&crate::ui_text!("runtime.trayActiveProfile", "Active profile: {profile_name}", profile_name = active_name)),
        false,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    for profile in profiles {
        // Native checkmark on the active profile — auto-aligned by the OS, unlike
        // a text "● "/"  " prefix which mis-indents in the proportional menu font.
        let is_active = Some(profile.id.as_str()) == active_profile_id;
        menu.append(&CheckMenuItem::with_id(
            app,
            format!("profile:{}", profile.id),
            &profile.name,
            true,
            is_active,
            None::<&str>,
        )?)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "create_rule",
        crate::ui_text::native(&crate::ui_text!("runtime.trayCreateRule", "Create a rule for the active window")),
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "toggle_runtime",
        if is_running {
            crate::ui_text::native(&crate::ui_text!("runtime.trayPause", "Pause"))
        } else {
            crate::ui_text::native(&crate::ui_text!("runtime.trayListen", "Listen to the mouse"))
        },
        true,
        None::<&str>,
    )?)?;
    // "Restart as administrator" only when non-elevated (UIPI blocks SendInput
    // into elevated foreground windows otherwise).
    if !is_elevated {
        menu.append(&MenuItem::with_id(
            app,
            "relaunch_as_admin",
            crate::ui_text::native(&crate::ui_text!("runtime.trayRelaunchAsAdmin", "Restart as administrator")),
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        crate::ui_text::native(&crate::ui_text!("runtime.trayQuit", "Quit")),
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// Rebuild the tray menu from an in-hand config (no disk IO). Use this from the
/// save/reload paths where the config is already loaded, to avoid a disk read on
/// every autosave.
/// Sets the tray icon to the app icon, with the battery badge when `badge` is
/// set. Skips the call when the icon already shows this state.
#[cfg(target_os = "windows")]
fn update_tray_icon(app: &AppHandle, tray: &tauri::tray::TrayIcon, badge: Option<u8>) {
    static SHOWN: Mutex<Option<Option<u8>>> = Mutex::new(None);
    let mut shown = SHOWN.lock().recover_poison();
    if *shown == Some(badge) {
        return;
    }
    let Some(base) = app.default_window_icon() else {
        return;
    };
    let icon = match badge {
        Some(percent) => tauri::image::Image::new_owned(
            tray_badge::compose(base.rgba(), base.width(), base.height(), percent),
            tray_badge::SIZE,
            tray_badge::SIZE,
        ),
        None => base.clone().to_owned(),
    };
    match tray.set_icon(Some(icon)) {
        Ok(()) => *shown = Some(badge),
        Err(error) => log::warn!("[tray] set_icon failed: {error}"),
    }
}

fn rebuild_tray_menu_from_config(app: &AppHandle, config: &config::AppConfig) {
    let Some(tray) = app.tray_by_id("sidearm-tray") else {
        return;
    };

    let store = app.state::<Arc<Mutex<RuntimeStore>>>();
    let (is_running, manual_override) = match store.lock() {
        Ok(store) => (
            store.is_running(),
            store.manual_profile_override().map(str::to_owned),
        ),
        Err(_) => (false, None),
    };
    let active = manual_override
        .or_else(|| Some(config.settings.fallback_profile_id.clone()))
        .filter(|id| !id.is_empty());
    let is_elevated = window_capture::is_current_process_elevated();

    // Windows shows an empty tooltip box on hover unless the tray icon carries
    // one, so keep it in sync with the same state the menu shows.
    let active_name = active
        .as_deref()
        .and_then(|id| config.profiles.iter().find(|p| p.id == id))
        .map(|p| p.name.as_str())
        .unwrap_or("—");
    // Nested parts are translated first: a param is plain text.
    let state_label = crate::ui_text::native(&if is_running {
        crate::ui_text!("runtime.trayListening", "listening to the mouse")
    } else {
        crate::ui_text!("runtime.trayPaused", "paused")
    });
    #[cfg(target_os = "windows")]
    let battery_line: String = onboard_guard::last_batteries()
        .into_iter()
        .map(|(model, percent)| {
            crate::ui_text::native(&crate::ui_text!("runtime.trayBattery", "\n{model}: {percent}%", model = model, percent = percent))
        })
        .collect();
    #[cfg(not(target_os = "windows"))]
    let battery_line = String::new();
    let tooltip = crate::ui_text!(
        "runtime.trayTooltip",
        "Sidearm — {state_label}\nProfile: {profile_name}{battery_line}",
        state_label = state_label,
        profile_name = active_name,
        battery_line = battery_line
    );
    if let Err(error) = tray.set_tooltip(Some(crate::ui_text::native(&tooltip))) {
        log::warn!("[tray] set_tooltip failed: {error}");
    }
    #[cfg(target_os = "windows")]
    update_tray_icon(
        app,
        &tray,
        config
            .settings
            .show_battery_in_tray
            .then(onboard_guard::last_battery_percent)
            .flatten(),
    );

    match build_tray_menu(
        app,
        &config.profiles,
        active.as_deref(),
        is_running,
        is_elevated,
    ) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                log::warn!("[tray] set_menu failed: {error}");
            }
        }
        Err(error) => log::warn!("[tray] build_tray_menu failed: {error}"),
    }
}

/// Reload config from disk and rebuild the tray menu. Use this from triggers
/// that have no config in hand (setup, tray profile click, pause toggle).
fn rebuild_tray_menu(app: &AppHandle) {
    let config_dir = resolve_app_paths(app).config_dir.clone();
    match load_or_initialize_config(&config_dir) {
        Ok(response) => rebuild_tray_menu_from_config(app, &response.config),
        Err(_) => log::warn!("[tray] menu rebuild skipped — config load failed"),
    }
}

fn configured_global_shortcut(app: &AppHandle) -> String {
    let config_dir = resolve_app_paths(app).config_dir.clone();
    match load_or_initialize_config(&config_dir) {
        Ok(load) => load
            .config
            .settings
            .global_shortcut
            .filter(|shortcut| !shortcut.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_GLOBAL_SHORTCUT.to_string()),
        Err(error) => {
            log::warn!(
                "[system] Could not load global shortcut setting; using {DEFAULT_GLOBAL_SHORTCUT}: {error}"
            );
            DEFAULT_GLOBAL_SHORTCUT.to_string()
        }
    }
}

/// The registration change implied by a new desired global shortcut, given what
/// is currently registered. Pure decision logic (no OS calls) so it is unit-
/// testable; the caller performs the actual register/unregister side effects.
#[derive(Debug, PartialEq)]
pub(crate) enum ShortcutAction {
    /// Desired == current: re-registering would needlessly drop the live hotkey
    /// on every unrelated save, so do nothing.
    NoChange,
    /// Register `desired`; only once that succeeds, unregister `unregister_previous`
    /// (None at startup). Registering first means a failed new combo leaves the
    /// old one live instead of dropping the user's hotkey.
    Register {
        desired: String,
        unregister_previous: Option<String>,
    },
}

/// Decide what to do when the configured global shortcut becomes `desired`,
/// given the currently-registered `current` (`None` before the first register).
pub(crate) fn plan_global_shortcut(current: Option<&str>, desired: &str) -> ShortcutAction {
    if current == Some(desired) {
        ShortcutAction::NoChange
    } else {
        ShortcutAction::Register {
            desired: desired.to_string(),
            unregister_previous: current.map(str::to_string),
        }
    }
}

/// Reliably surface the main window from a hidden / tray / minimized state. On
/// Windows `set_focus` (SetForegroundWindow) is refused for a process that isn't
/// already the foreground app (the foreground lock), so the window would appear
/// behind everything and only flash its taskbar button. Briefly toggling
/// always-on-top forces it to the top of the z-order, then we drop it back.
fn bring_to_front(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    #[cfg(windows)]
    {
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
    }
    #[cfg(not(windows))]
    {
        let _ = window.set_focus();
    }
}

/// Show/hide the main window. Shared by the tray left-click and the global
/// shortcut so the toggle behaves identically from both entry points.
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // A minimized window still reports visible on Windows, so treat
        // "minimized" as "surface it", not "hide it".
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if visible && !minimized {
            let _ = window.hide();
        } else {
            bring_to_front(&window);
        }
    }
}

/// (Re)register the OS-global show/hide shortcut to match `desired`. Uses the
/// last-registered value tracked in `CurrentGlobalShortcut` to skip a no-op
/// re-register (which would briefly drop the live hotkey). Registers the NEW
/// combo before unregistering the old one, so a failed new combo (e.g. owned by
/// another app) leaves the previous hotkey live. Never fatal — failures are
/// surfaced via `record_startup_runtime_error` (Diagnostics + runtime_error event).
fn apply_global_shortcut(app: &AppHandle, desired: &str) {
    let runtime_store = app.state::<Arc<Mutex<RuntimeStore>>>();
    let current_state = app.state::<CurrentGlobalShortcut>();

    let action = {
        let current = current_state.lock().recover_poison();
        plan_global_shortcut(current.as_deref(), desired)
    };
    let ShortcutAction::Register {
        desired,
        unregister_previous,
    } = action
    else {
        return; // NoChange — leave the live hotkey untouched.
    };

    let shortcut: Shortcut = match desired.parse() {
        Ok(s) => s,
        Err(e) => {
            let message = crate::ui_text!("runtime.globalShortcutParseFailed", "Could not parse the global shortcut `{shortcut}`: {error}", shortcut = &desired, error = &e);
            log::warn!("[system] {message}");
            record_startup_runtime_error(app, runtime_store.inner(), "globalShortcut", message);
            return;
        }
    };

    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_main_window(app);
            }
        })
    {
        let message = crate::ui_text!("runtime.globalShortcutRegisterFailed", "Could not register the global shortcut `{shortcut}`: {error}", shortcut = &desired, error = &e);
        log::warn!("[system] {message}");
        record_startup_runtime_error(app, runtime_store.inner(), "globalShortcut", message);
        return; // Registration failed — the previous hotkey stays live.
    }

    // New combo is live; drop the previous one (if any) and remember the new one.
    if let Some(previous) = unregister_previous
        && let Ok(prev) = previous.parse::<Shortcut>()
    {
        let _ = app.global_shortcut().unregister(prev);
    }
    *current_state.lock().recover_poison() = Some(desired);
}

/// Atomically copy `src` → `dst` by streaming into a temp file via the shared
/// `config::persist_atomically` (temp in dst's dir, fsync, atomic same-volume
/// rename). A crash/IO error mid-copy leaves `dst` untouched — never truncated.
fn atomic_copy_file(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    config::persist_atomically(dst, |file| {
        let mut reader = fs::File::open(src)?;
        std::io::copy(&mut reader, file)?;
        Ok(())
    })
}

fn resolve_log_dir(app: &AppHandle) -> PathBuf {
    resolve_app_paths(app).log_dir.clone()
}

/// Validate a user-supplied file path. The path is chosen by the user through a
/// native OS save/open dialog, which is the trust boundary — so any absolute
/// location is allowed (e.g. a backup folder on another drive / OneDrive). We
/// still reject relative paths and `..` segments as a cheap guard against
/// surprising or obfuscated targets.
fn validate_user_file_path(path: &str) -> Result<PathBuf, CommandError> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(CommandError::new(
            "invalid_path",
            "File path must be absolute.",
            None,
        ));
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(CommandError::new(
            "invalid_path",
            "File path must not contain `..` segments.",
            None,
        ));
    }
    Ok(path)
}

/// Maximum size of a profile JSON file accepted on import. Generous vs. a
/// realistic profile (a few KB–tens of KB) while preventing a renderer from
/// asking the backend to slurp an arbitrarily large file into memory.
const MAX_IMPORT_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB

/// Maximum size of a full-config JSON file accepted on import. Larger than the
/// per-profile cap (a full config can hold many profiles/snippets) but still
/// bounds how much a corrupt or hostile file can ask the backend to slurp.
const MAX_FULL_CONFIG_IMPORT_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB

/// As [`validate_user_file_path`], plus a `.json` extension (case-insensitive).
/// The extension whitelist keeps the export/import commands from writing shell
/// profiles, autostart scripts, or `.lnk`/`.ps1` files now that the path is no
/// longer confined to the home directory (preserves the P2-2 fix).
fn validate_user_json_path(path: &str) -> Result<PathBuf, CommandError> {
    validate_user_path_with_ext(path, &["json"], "File must have a .json extension.")
}

/// As [`validate_user_file_path`], plus a case-insensitive extension whitelist.
/// Snippet export reuses this with inert text formats (`md`/`txt`) — still no
/// executable/shell extensions, preserving the P2-2 fix.
fn validate_user_path_with_ext(
    path: &str,
    allowed: &[&str],
    reject_message: &'static str,
) -> Result<PathBuf, CommandError> {
    let validated = validate_user_file_path(path)?;
    let ext_ok = validated
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| allowed.iter().any(|a| extension.eq_ignore_ascii_case(a)));
    if !ext_ok {
        return Err(CommandError::new("invalid_path", reject_message, None));
    }
    Ok(validated)
}

/// Shared body for the narrow profile-export commands: validate the JSON path,
/// then write the caller-serialized contents.
async fn write_user_json(
    path: String,
    contents: String,
    op: &'static str,
) -> Result<(), CommandError> {
    let validated_path = validate_user_json_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = validated_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| CommandError::internal(format!("Failed to create directory: {e}")))?;
        }
        config::persist_atomically(&validated_path, |file| {
            use std::io::Write as _;
            file.write_all(contents.as_bytes())
        })
        .map_err(|e| CommandError::internal(format!("Failed to write file: {e}")))
    })
    .await
    .map_err(|e| CommandError::internal(format!("{op} task failed: {e}")))?
}

/// Stat `path` and reject it when its length exceeds `max_bytes`, returning a
/// [`CommandError`] tagged with `code` (the FE maps on the code). Shared by the
/// per-profile and full-config import guards; run inside their blocking tasks.
fn check_import_size(path: &Path, max_bytes: u64, code: &'static str) -> Result<(), CommandError> {
    let len = fs::metadata(path)
        .map_err(|e| CommandError::internal(format!("Failed to stat import file: {e}")))?
        .len();
    if len > max_bytes {
        return Err(CommandError::new(
            code,
            format!("File exceeds the {max_bytes}-byte import limit."),
            None,
        ));
    }
    Ok(())
}

/// Shared body for the narrow profile-import commands: validate the JSON path,
/// enforce the size cap, then read the contents back as a string.
async fn read_user_json(path: String, op: &'static str) -> Result<String, CommandError> {
    let validated_path = validate_user_json_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        check_import_size(&validated_path, MAX_IMPORT_BYTES, "file_too_large")?;
        fs::read_to_string(&validated_path)
            .map_err(|e| CommandError::internal(format!("Failed to read file: {e}")))
    })
    .await
    .map_err(|e| CommandError::internal(format!("{op} task failed: {e}")))?
}

/// Enforce [`MAX_FULL_CONFIG_IMPORT_BYTES`] on a full-config import file before
/// it is read into memory. Mirrors the per-profile cap in `read_user_json`, but
/// guards the full-config preview/apply paths, which read the file directly and
/// bypass `read_user_json`. Run inside the import command's blocking task.
fn ensure_full_config_import_size(path: &Path) -> Result<(), CommandError> {
    check_import_size(path, MAX_FULL_CONFIG_IMPORT_BYTES, "import_too_large")
}

// Narrow, purpose-named replacements for the removed generic write_text_file/
// read_text_file (FIXES P2-2). Single-profile `ProfileExportData` transfer
// commands shared by the Profiles and Settings views. Purpose-named commands
// keep the IPC surface self-documenting. The path is always chosen by the user
// via the native save/open dialog; validation here defends against a renderer
// calling the command directly with an arbitrary path.

/// Export a single profile (`ProfileExportData`) to a user-chosen `.json` file.
#[tauri::command]
async fn export_profile(path: String, contents: String) -> Result<(), CommandError> {
    write_user_json(path, contents, "export_profile").await
}

/// Import a single profile (`ProfileExportData`) from a user-chosen `.json` file.
#[tauri::command]
async fn import_profile(path: String) -> Result<String, CommandError> {
    read_user_json(path, "import_profile").await
}

/// Export the snippet library to a user-chosen `.json` / `.md` / `.txt` file.
/// Looser extension whitelist than profiles (still inert text only); the FE
/// serializes the contents per chosen format.
#[tauri::command]
async fn export_snippets(path: String, contents: String) -> Result<(), CommandError> {
    let validated_path = validate_user_path_with_ext(
        &path,
        &["json", "md", "txt"],
        "Snippet export must be a .json, .md, or .txt file.",
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = validated_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| CommandError::internal(format!("Failed to create directory: {e}")))?;
        }
        config::persist_atomically(&validated_path, |file| {
            use std::io::Write as _;
            file.write_all(contents.as_bytes())
        })
        .map_err(|e| CommandError::internal(format!("Failed to write file: {e}")))
    })
    .await
    .map_err(|e| CommandError::internal(format!("export_snippets task failed: {e}")))?
}

#[tauri::command]
async fn export_verification_session(
    app: AppHandle,
    filename: String,
    contents: String,
) -> Result<String, CommandError> {
    let filename = filename.trim().to_owned();

    // Validate filename: must not be empty, must end with .json, must not contain path separators or traversal
    if filename.is_empty() {
        return Err(CommandError::new(
            "invalid_request",
            "Export filename must not be empty.",
            None,
        ));
    }
    if !filename.ends_with(".json") {
        return Err(CommandError::new(
            "invalid_request",
            "Export filename must end with .json.",
            None,
        ));
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(CommandError::new(
            "invalid_request",
            "Export filename must not contain path separators or '..' segments.",
            None,
        ));
    }

    // Construct the export path under config_dir/exports/ — this is under the
    // portable `./data/` folder in portable mode, or the roaming config dir.
    let config_dir = resolve_config_dir(&app)?;
    let export_dir = config_dir.join("exports");
    let export_path = export_dir.join(&filename);

    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&export_dir).map_err(|error| {
            CommandError::internal(format!(
                "Failed to create export directory `{}`: {error}",
                export_dir.display()
            ))
        })?;

        config::persist_atomically(&export_path, |file| {
            use std::io::Write as _;
            file.write_all(contents.as_bytes())
        })
        .map_err(|error| {
            CommandError::internal(format!(
                "Failed to write verification export `{}`: {error}",
                export_path.display()
            ))
        })?;

        Ok(export_path.display().to_string())
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!("export_verification_session task failed: {error}"))
    })?
}

/// Record this process's view of the on-disk config fingerprint so a later
/// `save_config` can detect a concurrent overwrite by another instance.
/// Best-effort: re-resolves the config dir and stores `None` if unreadable.
fn record_config_stamp(app: &AppHandle) {
    if let Ok(dir) = resolve_config_dir(app) {
        let stamp = config::config_file_stamp(&dir);
        *app.state::<ConfigStamp>().inner().lock().recover_poison() = stamp;
    }
}

// ── Device images (universal-device support) ────────────────────────────────
// User-device photos live as bare files in `<config_dir>/devices/`; the config
// stores only the file name (validated bare in `validate_config`). Serving
// goes through a data: URL instead of the asset protocol — the portable build
// keeps its data dir next to the exe, which no asset-scope variable covers.

const DEVICE_IMAGE_DIR: &str = "devices";
const DEVICE_IMAGE_MAX_BYTES: u64 = 10 * 1024 * 1024;

fn device_image_mime(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// Reject anything that is not a bare file name (defense in depth on top of
/// the same check in `validate_config`).
fn validated_device_image_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, CommandError> {
    if file_name.trim().is_empty()
        || file_name.contains(['/', '\\'])
        || file_name.contains("..")
    {
        return Err(CommandError::new(
            "device_image_invalid_name",
            format!("`{file_name}` is not a bare file name."),
            None,
        ));
    }
    Ok(resolve_config_dir(app)?
        .join(DEVICE_IMAGE_DIR)
        .join(file_name))
}

/// Copy a user-picked photo into the app-data devices dir; returns the bare
/// file name the config should reference.
#[tauri::command]
async fn import_device_image(app: AppHandle, source_path: String) -> Result<String, CommandError> {
    let source = PathBuf::from(&source_path);
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if device_image_mime(&extension).is_none() {
        return Err(CommandError::new(
            "device_image_unsupported",
            format!("`{extension}` is not a supported image type (png/jpg/webp/gif/bmp)."),
            None,
        ));
    }

    let devices_dir = resolve_config_dir(&app)?.join(DEVICE_IMAGE_DIR);
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = fs::metadata(&source).map_err(|error| {
            CommandError::internal(format!("Failed to read `{}`: {error}", source.display()))
        })?;
        if metadata.len() > DEVICE_IMAGE_MAX_BYTES {
            return Err(CommandError::new(
                "device_image_too_large",
                format!(
                    "Image is {} MB; the limit is {} MB.",
                    metadata.len() / (1024 * 1024),
                    DEVICE_IMAGE_MAX_BYTES / (1024 * 1024)
                ),
                None,
            ));
        }
        fs::create_dir_all(&devices_dir).map_err(|error| {
            CommandError::internal(format!(
                "Failed to create `{}`: {error}",
                devices_dir.display()
            ))
        })?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let file_name = format!("device-{nanos}.{extension}");
        fs::copy(&source, devices_dir.join(&file_name)).map_err(|error| {
            CommandError::internal(format!("Failed to copy device image: {error}"))
        })?;
        Ok(file_name)
    })
    .await
    .map_err(|error| CommandError::internal(format!("import_device_image task failed: {error}")))?
}

/// Read a stored device photo as a `data:` URL (CSP `img-src data:` allows it
/// everywhere, including the portable build).
#[tauri::command]
async fn read_device_image(app: AppHandle, file_name: String) -> Result<String, CommandError> {
    let path = validated_device_image_path(&app, &file_name)?;
    let mime = path
        .extension()
        .and_then(|ext| ext.to_str())
        .and_then(device_image_mime)
        .ok_or_else(|| {
            CommandError::new(
                "device_image_unsupported",
                format!("`{file_name}` is not a supported image type."),
                None,
            )
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = fs::metadata(&path).map_err(|error| {
            CommandError::internal(format!("Failed to read `{}`: {error}", path.display()))
        })?;
        if metadata.len() > DEVICE_IMAGE_MAX_BYTES {
            return Err(CommandError::new(
                "device_image_too_large",
                "Stored image exceeds the size limit.".to_string(),
                None,
            ));
        }
        let bytes = fs::read(&path).map_err(|error| {
            CommandError::internal(format!("Failed to read `{}`: {error}", path.display()))
        })?;
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{mime};base64,{encoded}"))
    })
    .await
    .map_err(|error| CommandError::internal(format!("read_device_image task failed: {error}")))?
}

/// Best-effort cleanup when a photo is replaced or its device deleted.
#[tauri::command]
async fn delete_device_image(app: AppHandle, file_name: String) -> Result<(), CommandError> {
    let path = validated_device_image_path(&app, &file_name)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = fs::remove_file(&path) {
            // Missing file is fine (already cleaned up / never written).
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("[device-image] Failed to delete {}: {error}", path.display());
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| CommandError::internal(format!("delete_device_image task failed: {error}")))?
}

#[tauri::command]
async fn load_config(app: AppHandle) -> Result<LoadConfigResponse, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let response =
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            let stamp = config::config_file_stamp(&config_dir);
            let mut response = load_or_initialize_config(&config_dir)?;
            #[cfg(target_os = "windows")]
            if mouse_memory::live_overlay::configure(&mut response.config, &mouse_memory::present_models()) {
                let migrated = config::save_config(&config_dir, response.config, stamp)?;
                response.config = migrated.config;
                response.warnings.extend(migrated.warnings);
            }
            Ok::<_, config::ConfigStoreError>(response)
        })
            .await
            .map_err(|error| CommandError::internal(format!("load_config task failed: {error}")))?
            .map_err(CommandError::from)?;

    // Sync the cached minimize_to_tray flag for the close handler
    app.state::<MinimizeToTray>()
        .store(response.config.settings.minimize_to_tray, Ordering::Relaxed);
    // Remember what we just loaded so save_config can guard against clobbering
    // a newer config written by a concurrent instance.
    record_config_stamp(&app);

    Ok(response)
}

/// Save the config to disk and, if the runtime is active, restart the capture
/// backend so it picks up the new config.
///
/// CONCURRENCY NOTE: The `runtime_controller` lock serializes concurrent
/// `save_config` calls through the restart path. The `runtime_store` lock is
/// re-acquired immediately after restart to update the version. No async yield
/// points exist between `controller.reload_saved_config()` and `store.reload()`.
#[tauri::command]
async fn save_config(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    runtime_controller: State<'_, Arc<Mutex<RuntimeController>>>,
    config: AppConfig,
) -> Result<SaveConfigResponse, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    // What this process believes is currently on disk. If another instance has
    // written config.json since, the guarded save below returns
    // `config_changed_on_disk` instead of clobbering those edits.
    let expected_stamp = *app.state::<ConfigStamp>().inner().lock().recover_poison();
    let result = tauri::async_runtime::spawn_blocking(move || {
        save_config_to_store(&config_dir, config, expected_stamp)
    })
    .await
    .map_err(|error| CommandError::internal(format!("save_config task failed: {error}")))?
    .map_err(CommandError::from)?;

    // Sync the cached minimize_to_tray flag for the close handler
    app.state::<MinimizeToTray>()
        .store(result.config.settings.minimize_to_tray, Ordering::Relaxed);
    // We just wrote the file — adopt its new fingerprint as our baseline.
    record_config_stamp(&app);

    let is_running = {
        let store = runtime_store.lock().recover_poison();
        store.is_running()
    };

    let maybe_runtime_summary = if is_running {
        let restart_result = {
            let mut controller = runtime_controller
                .lock()
                .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;

            // TOCTOU guard: re-check runtime status after acquiring the controller lock.
            // The runtime may have been stopped between the initial check and lock acquisition.
            let still_running = runtime_store.lock().recover_poison().is_running();
            if !still_running {
                None
            } else {
                Some(controller.reload_saved_config(
                    app.clone(),
                    runtime_store.inner().clone(),
                    result.config.clone(),
                    app.package_info().name.clone(),
                ))
            }
        };
        match restart_result {
            Some(Err(message)) => {
                let stopped_summary = {
                    let mut store = runtime_store.lock().recover_poison();
                    store.stop()
                };
                let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
                return Err(CommandError::new("runtime_reload_failed", message, None));
            }
            Some(Ok(())) => {
                let mut store = runtime_store.lock().recover_poison();
                Some(store.reload(result.config.version, result.warnings.len()))
            }
            None => None,
        }
    } else {
        None
    };

    if let Some(summary) = maybe_runtime_summary {
        app.emit(EVENT_CONFIG_RELOADED, &summary).map_err(|error| {
            CommandError::internal(format!("Failed to emit config_reloaded event: {error}"))
        })?;
    }

    // Keep the tray's profile list / active marker in sync after a save.
    rebuild_tray_menu_from_config(&app, &result.config);

    // Apply a changed global shortcut immediately — re-registers only if the
    // value actually changed, and leaves the old one live if the new combo fails.
    let desired = result
        .config
        .settings
        .global_shortcut
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_GLOBAL_SHORTCUT);
    apply_global_shortcut(&app, desired);

    Ok(result)
}

// ============================================================================
// M1 — Backup, export/import, portable migration commands
// ============================================================================

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPathsInfo {
    mode: paths::PathMode,
    config_dir: String,
    log_dir: String,
    snapshots_dir: String,
    portable_marker_present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_reason: Option<String>,
    needs_portable_migration_prompt: bool,
}

#[tauri::command]
async fn get_app_paths(app: AppHandle) -> Result<AppPathsInfo, CommandError> {
    let paths = resolve_app_paths(&app);
    let needs_portable_migration_prompt = needs_portable_migration_prompt(&paths);
    Ok(AppPathsInfo {
        mode: paths.mode,
        config_dir: paths.config_dir.to_string_lossy().into_owned(),
        log_dir: paths.log_dir.to_string_lossy().into_owned(),
        snapshots_dir: paths.snapshots_dir.to_string_lossy().into_owned(),
        portable_marker_present: paths.portable_marker_present,
        fallback_reason: paths.fallback_reason.clone(),
        needs_portable_migration_prompt,
    })
}

fn needs_portable_migration_prompt(paths: &paths::AppPaths) -> bool {
    if paths.needs_portable_migration_prompt() {
        return true;
    }
    if paths.mode != paths::PathMode::Portable {
        return false;
    }
    if paths
        .config_dir
        .join(paths::MIGRATION_DECLINED_MARKER)
        .exists()
    {
        return false;
    }
    if !paths::AppPaths::roaming_config_file().exists() {
        return false;
    }
    let portable_config = paths.config_dir.join("config.json");
    if !portable_config.exists() {
        return false;
    }
    match read_and_migrate_config_file(&portable_config) {
        Ok(config) => config == config::default_seed_config(),
        Err(error) => {
            log::warn!("[portable] migration prompt seed check skipped: {error}");
            false
        }
    }
}

#[tauri::command]
async fn list_backups(app: AppHandle) -> Result<Vec<backup::BackupEntry>, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        backup::list_backups(&config_dir)
            .map_err(|e| CommandError::internal(format!("Failed to list backups: {e}")))
    })
    .await
    .map_err(|e| CommandError::internal(format!("list_backups task failed: {e}")))?
}

#[tauri::command]
async fn restore_config_from_backup(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    runtime_controller: State<'_, Arc<Mutex<RuntimeController>>>,
    backup_path: String,
) -> Result<LoadConfigResponse, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let backup_pb = PathBuf::from(&backup_path);
    match backup::check_backup_location(&config_dir, &backup_pb) {
        backup::BackupLocationCheck::Inside => {}
        backup::BackupLocationCheck::Outside => {
            return Err(CommandError::new(
                "invalid_backup_path",
                "Backup path must point to a file inside the config directory.",
                Some(vec![backup_path]),
            ));
        }
        backup::BackupLocationCheck::Unresolvable(detail) => {
            log::warn!("[restore] backup path unresolvable: {detail}");
            return Err(CommandError::new(
                "backup_path_unresolvable",
                "Could not access the backup path. It may be on a disconnected network drive or still syncing (e.g. OneDrive). Please try again.",
                Some(vec![backup_path]),
            ));
        }
    }

    let config_dir_for_task = config_dir.clone();
    let response = tauri::async_runtime::spawn_blocking(
        move || -> Result<LoadConfigResponse, CommandError> {
            let config = read_and_migrate_config_file(&backup_pb).map_err(CommandError::from)?;
            save_config_to_store(&config_dir_for_task, config, None).map_err(CommandError::from)?;
            load_or_initialize_config(&config_dir_for_task).map_err(CommandError::from)
        },
    )
    .await
    .map_err(|e| CommandError::internal(format!("restore task failed: {e}")))??;

    app.state::<MinimizeToTray>()
        .store(response.config.settings.minimize_to_tray, Ordering::Relaxed);
    // Explicit overwrite — adopt the new on-disk fingerprint as our baseline so
    // the next save_config does not falsely report a concurrent change.
    record_config_stamp(&app);

    let is_running = {
        let store = runtime_store.lock().recover_poison();
        store.is_running()
    };

    if is_running {
        let restart_result = {
            let mut controller = runtime_controller
                .lock()
                .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;
            let still_running = runtime_store.lock().recover_poison().is_running();
            if still_running {
                Some(controller.restart(
                    app.clone(),
                    runtime_store.inner().clone(),
                    response.config.clone(),
                    app.package_info().name.clone(),
                ))
            } else {
                None
            }
        };

        if let Some(restart_result) = restart_result {
            match restart_result {
                Ok(()) => {
                    let summary = {
                        let mut store = runtime_store.lock().recover_poison();
                        store.reload(response.config.version, response.warnings.len())
                    };
                    app.emit(EVENT_CONFIG_RELOADED, &summary).map_err(|error| {
                        CommandError::internal(format!(
                            "Failed to emit config_reloaded event: {error}"
                        ))
                    })?;
                }
                Err(message) => {
                    let stopped_summary = {
                        let mut store = runtime_store.lock().recover_poison();
                        store.stop()
                    };
                    let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
                    return Err(CommandError::new("runtime_reload_failed", message, None));
                }
            }
        }
    }

    rebuild_tray_menu_from_config(&app, &response.config);

    Ok(response)
}

#[tauri::command]
async fn export_full_config(app: AppHandle, target_path: String) -> Result<String, CommandError> {
    let validated = validate_user_json_path(&target_path)?;
    let config_dir = resolve_config_dir(&app)?;
    let source = config_dir.join("config.json");
    tauri::async_runtime::spawn_blocking(move || -> Result<String, CommandError> {
        if !source.is_file() {
            return Err(CommandError::new(
                "io_error",
                "No config.json to export — save the app at least once first.",
                None,
            ));
        }
        if let Some(parent) = validated.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                CommandError::internal(format!("Failed to create export directory: {e}"))
            })?;
        }
        atomic_copy_file(&source, &validated)
            .map_err(|e| CommandError::internal(format!("Failed to copy config: {e}")))?;
        Ok(validated.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| CommandError::internal(format!("export task failed: {e}")))?
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportPreview {
    version: i32,
    profile_count: usize,
    binding_count: usize,
    action_count: usize,
    app_mapping_count: usize,
    snippet_count: usize,
    warnings: Vec<String>,
}

#[tauri::command]
async fn import_full_config_preview(source_path: String) -> Result<ImportPreview, CommandError> {
    let validated = validate_user_file_path(&source_path)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<ImportPreview, CommandError> {
        ensure_full_config_import_size(&validated)?;
        let raw = fs::read_to_string(&validated).map_err(|e| {
            CommandError::new(
                "io_error",
                format!("Failed to read import file: {e}"),
                Some(vec![validated.to_string_lossy().into_owned()]),
            )
        })?;
        let raw_value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
            CommandError::new(
                "parse_error",
                format!("Failed to parse import JSON: {e}"),
                None,
            )
        })?;

        let version = raw_value
            .get("version")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32;
        let count = |key: &str| {
            raw_value
                .get(key)
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0)
        };

        let warnings = config::collect_schema_errors(&raw_value);

        Ok(ImportPreview {
            version,
            profile_count: count("profiles"),
            binding_count: count("bindings"),
            action_count: count("actions"),
            app_mapping_count: count("appMappings"),
            snippet_count: count("snippetLibrary"),
            warnings,
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("import preview task failed: {e}")))?
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum ImportMode {
    Replace,
    Merge,
}

#[tauri::command]
async fn import_full_config_apply(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    runtime_controller: State<'_, Arc<Mutex<RuntimeController>>>,
    source_path: String,
    mode: ImportMode,
) -> Result<SaveConfigResponse, CommandError> {
    let validated = validate_user_file_path(&source_path)?;
    let config_dir = resolve_config_dir(&app)?;
    let config_dir_for_task = config_dir.clone();

    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<SaveConfigResponse, CommandError> {
            ensure_full_config_import_size(&validated)?;
            let imported = read_and_migrate_config_file(&validated).map_err(CommandError::from)?;
            let final_config = match mode {
                ImportMode::Replace => imported,
                ImportMode::Merge => {
                    let base = load_or_initialize_config(&config_dir_for_task)
                        .map_err(CommandError::from)?
                        .config;
                    merge_configs_by_id(base, imported)
                }
            };
            save_config_to_store(&config_dir_for_task, final_config, None)
                .map_err(CommandError::from)
        },
    )
    .await
    .map_err(|e| CommandError::internal(format!("import apply task failed: {e}")))??;

    app.state::<MinimizeToTray>()
        .store(result.config.settings.minimize_to_tray, Ordering::Relaxed);
    // Explicit overwrite — adopt the new on-disk fingerprint as our baseline so
    // the next save_config does not falsely report a concurrent change.
    record_config_stamp(&app);

    let is_running = {
        let store = runtime_store.lock().recover_poison();
        store.is_running()
    };

    if is_running {
        let restart_result = {
            let mut controller = runtime_controller
                .lock()
                .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;
            let still_running = runtime_store.lock().recover_poison().is_running();
            if still_running {
                Some(controller.restart(
                    app.clone(),
                    runtime_store.inner().clone(),
                    result.config.clone(),
                    app.package_info().name.clone(),
                ))
            } else {
                None
            }
        };

        if let Some(restart_result) = restart_result {
            match restart_result {
                Ok(()) => {
                    let summary = {
                        let mut store = runtime_store.lock().recover_poison();
                        store.reload(result.config.version, result.warnings.len())
                    };
                    app.emit(EVENT_CONFIG_RELOADED, &summary).map_err(|error| {
                        CommandError::internal(format!(
                            "Failed to emit config_reloaded event: {error}"
                        ))
                    })?;
                }
                Err(message) => {
                    let stopped_summary = {
                        let mut store = runtime_store.lock().recover_poison();
                        store.stop()
                    };
                    let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
                    return Err(CommandError::new("runtime_reload_failed", message, None));
                }
            }
        }
    }

    rebuild_tray_menu_from_config(&app, &result.config);

    Ok(result)
}

/// Merge two configs by ID (incoming wins on ID conflicts). Non-array fields
/// (version, settings) are taken from `incoming`. Suitable for merging
/// same-user configs where IDs are unique random tokens (see `makeRandomId`
/// in the frontend). Since v3, devices/physicalControls/encoderMappings merge
/// by id too — taking them wholesale from `incoming` (the pre-v3 behavior,
/// safe when the control set was a fixed enum) would orphan the base config's
/// user-device bindings and fail validation.
fn merge_configs_by_id(base: AppConfig, incoming: AppConfig) -> AppConfig {
    use std::collections::HashMap;

    fn merge_by<K: Eq + std::hash::Hash + Clone, T, F: Fn(&T) -> K>(
        base: Vec<T>,
        incoming: Vec<T>,
        key: F,
    ) -> Vec<T> {
        // Order-preserving merge: keep base items in their original order (each
        // replaced in place when an incoming item shares its id — incoming wins),
        // then append incoming-only items in their original order. Collecting
        // HashMap::into_values() would randomize the user's list order (profiles,
        // bindings, snippets) because HashMap iteration order is unspecified.
        let mut incoming_map: HashMap<K, T> = HashMap::with_capacity(incoming.len());
        let mut incoming_order: Vec<K> = Vec::with_capacity(incoming.len());
        for item in incoming {
            let k = key(&item);
            if incoming_map.insert(k.clone(), item).is_none() {
                incoming_order.push(k);
            }
        }
        let mut result: Vec<T> = Vec::with_capacity(base.len() + incoming_order.len());
        for item in base {
            match incoming_map.remove(&key(&item)) {
                Some(replacement) => result.push(replacement),
                None => result.push(item),
            }
        }
        for k in incoming_order {
            if let Some(item) = incoming_map.remove(&k) {
                result.push(item);
            }
        }
        result
    }

    AppConfig {
        version: incoming.version,
        settings: incoming.settings,
        profiles: merge_by(base.profiles, incoming.profiles, |p| p.id.clone()),
        devices: merge_by(base.devices, incoming.devices, |d| d.id.clone()),
        physical_controls: merge_by(base.physical_controls, incoming.physical_controls, |c| {
            c.id.clone()
        }),
        encoder_mappings: merge_by(base.encoder_mappings, incoming.encoder_mappings, |m| {
            (m.control_id.clone(), m.layer)
        }),
        app_mappings: merge_by(base.app_mappings, incoming.app_mappings, |m| m.id.clone()),
        bindings: merge_by(base.bindings, incoming.bindings, |b| b.id.clone()),
        actions: merge_by(base.actions, incoming.actions, |a| a.id.clone()),
        snippet_library: merge_by(base.snippet_library, incoming.snippet_library, |s| {
            s.id.clone()
        }),
    }
}

#[tauri::command]
async fn open_config_folder(app: AppHandle) -> Result<(), CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let _ = fs::create_dir_all(&config_dir);
    #[cfg(target_os = "windows")]
    crate::platform::shell::open_in_explorer(&config_dir).map_err(CommandError::internal)?;
    #[cfg(target_os = "linux")]
    crate::platform::shell::open_in_explorer(&config_dir).map_err(CommandError::internal)?;
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        std::process::Command::new("xdg-open")
            .arg(config_dir.as_os_str())
            .spawn()
            .map_err(|e| CommandError::internal(format!("Failed to open config folder: {e}")))?;
    }
    Ok(())
}

#[tauri::command]
async fn accept_portable_migration(
    app: AppHandle,
    copy_from_roaming: bool,
) -> Result<(), CommandError> {
    let paths_state = resolve_app_paths(&app);
    let config_dir = paths_state.config_dir.clone();
    let roaming_config = paths::AppPaths::roaming_config_file();

    tauri::async_runtime::spawn_blocking(
        move || -> Result<(), CommandError> {
            if copy_from_roaming && roaming_config.is_file() {
                fs::create_dir_all(&config_dir).map_err(|e| {
                    CommandError::internal(format!("Failed to create portable config dir: {e}"))
                })?;
                let target = config_dir.join("config.json");
                // Always overwrite on explicit user-initiated migration, even
                // if the target exists — it was likely auto-created by an
                // earlier `load_config` as a default seed.
                atomic_copy_file(&roaming_config, &target).map_err(|e| {
                    CommandError::internal(format!(
                        "Failed to copy roaming config into portable dir: {e}"
                    ))
                })?;
            }
            if let Err(err) = paths_state.mark_migration_declined() {
                log::warn!("[portable] Failed to write migration marker: {err}");
            }
            Ok(())
        },
    )
    .await
    .map_err(|e| CommandError::internal(format!("migration task failed: {e}")))?
}

// ============================================================================
// M3 — Razer Synapse import
// ============================================================================

#[tauri::command]
async fn parse_synapse_source(
    path: String,
) -> Result<synapse_import::ParsedSynapseProfiles, CommandError> {
    let validated = validate_user_file_path(&path)?;
    tauri::async_runtime::spawn_blocking(
        move || -> Result<synapse_import::ParsedSynapseProfiles, CommandError> {
            // Bound how much a hostile/corrupt Synapse export can ask the backend
            // to read, consistent with the other import commands (the JSON import
            // paths enforce MAX_FULL_CONFIG_IMPORT_BYTES via this same guard).
            ensure_full_config_import_size(&validated)?;
            synapse_import::parse_synapse_source(&validated).map_err(|e| {
                CommandError::new(
                    "synapse_parse_failed",
                    format!("{e}"),
                    Some(vec![validated.to_string_lossy().into_owned()]),
                )
            })
        },
    )
    .await
    .map_err(|e| CommandError::internal(format!("parse_synapse_source task failed: {e}")))?
}

#[tauri::command]
async fn import_synapse_into_config(
    parsed: synapse_import::ParsedSynapseProfiles,
    options: synapse_import::ImportOptions,
    base: AppConfig,
) -> Result<synapse_import::ImportedConfig, CommandError> {
    tauri::async_runtime::spawn_blocking(
        move || -> Result<synapse_import::ImportedConfig, CommandError> {
            let result = synapse_import::apply_parsed_into_config(base, parsed, &options);
            // Schema-validate to guarantee the merged config is loadable.
            let value = serde_json::to_value(&result.config)
                .map_err(|e| CommandError::internal(format!("serialize failed: {e}")))?;
            let schema_errors = config::collect_schema_errors(&value);
            if !schema_errors.is_empty() {
                return Err(CommandError::new(
                    "schema_violation",
                    "Imported config does not match the expected schema.",
                    Some(schema_errors),
                ));
            }
            Ok(result)
        },
    )
    .await
    .map_err(|e| CommandError::internal(format!("import_synapse_into_config task failed: {e}")))?
}

// ============================================================================
// Onboarding — environment checks
// ============================================================================

/// Toggle "live capture" mode. While enabled, captured Naga keys are surfaced
/// to the UI via `encoded_key_received` but are NOT resolved/executed/injected.
/// The onboarding hardware test enables it so pressing buttons lights up the
/// tester without firing their real actions; it is always cleared on exit.
#[tauri::command]
async fn set_input_capture_mode(app: AppHandle, enabled: bool, check_extra_controls: Option<bool>) -> Result<(), CommandError> {
    #[cfg(target_os = "windows")]
    if check_extra_controls == Some(true) {
        return tauri::async_runtime::spawn_blocking(move || {
            let store = app.state::<Arc<Mutex<RuntimeStore>>>();
            let controller = app.state::<Arc<Mutex<RuntimeController>>>();
            let mut controller = controller.lock().recover_poison();
            let previous = mouse_memory::live_overlay::CHECK_EXTRA_CONTROLS.swap(enabled, Ordering::AcqRel);
            if enabled {
                capture_backend::SUPPRESS_EXECUTION.store(true, Ordering::Relaxed);
            }
            if previous != enabled && store.lock().recover_poison().is_running() {
                let reload = (|| {
                    let config = load_or_initialize_config(&resolve_config_dir(&app)?)
                        .map_err(CommandError::from)?.config;
                    controller.reload_saved_config(app.clone(), store.inner().clone(), config, app.package_info().name.clone())
                        .map_err(|message| CommandError::new("runtime_reload_failed", message, None))
                })();
                if let Err(error) = reload {
                    mouse_memory::live_overlay::CHECK_EXTRA_CONTROLS.store(false, Ordering::Release);
                    capture_backend::SUPPRESS_EXECUTION.store(false, Ordering::Relaxed);
                    let _ = controller.stop();
                    let summary = store.lock().recover_poison().stop();
                    let _ = app.emit(EVENT_RUNTIME_STOPPED, &summary);
                    return Err(error);
                }
            }
            capture_backend::SUPPRESS_EXECUTION.store(enabled, Ordering::Relaxed);
            Ok(())
        }).await.map_err(|error| CommandError::internal(format!("button check task failed: {error}")))?;
    }
    let _ = (app, check_extra_controls);
    capture_backend::SUPPRESS_EXECUTION.store(enabled, Ordering::Relaxed);
    Ok(())
}

/// Whether a mouse's buttons reach Sidearm now: a live-map mouse once its map
/// is written and verified (and it sends consumer signals); an onboard mouse
/// whenever it is connected — the guard keeps its records.
#[tauri::command]
async fn live_map_ready(device_id: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let present = mouse_memory::present_models();
            let Some(model) = present.iter().find(|model| model.device_id == device_id) else { return false };
            match mouse_memory::live_overlay::live_models(&present).iter().any(|live| live.is(model)) {
                true => mouse_memory::live_overlay::is_ready(model),
                false => model.transport == device_catalog::Transport::Onboard,
            }
        })
        .await
        .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = device_id;
        false
    }
}

#[tauri::command]
async fn start_runtime(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    runtime_controller: State<'_, Arc<Mutex<RuntimeController>>>,
) -> Result<RuntimeStateSummary, CommandError> {
    // Guard: if already running, return current state (prevents double spawn
    // from React.StrictMode double-invoking useEffect in dev mode).
    {
        let store = runtime_store.lock().recover_poison();
        if store.is_running() {
            log::info!("[system] start_runtime called but already running, skipping");
            return Ok(store.summary());
        }
    }

    let config_dir = resolve_config_dir(&app)?;
    let load_response =
        tauri::async_runtime::spawn_blocking(move || load_or_initialize_config(&config_dir))
            .await
            .map_err(|error| CommandError::internal(format!("start_runtime task failed: {error}")))?
            .map_err(CommandError::from)?;

    {
        let mut controller = runtime_controller
            .lock()
            .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;
        controller
            .start(
                app.clone(),
                runtime_store.inner().clone(),
                load_response.config.clone(),
                app.package_info().name.clone(),
            )
            .map_err(|message| CommandError::new("runtime_start_failed", message, None))?;
    }

    let summary = {
        let mut store = runtime_store.lock().recover_poison();
        store.start(load_response.config.version, load_response.warnings.len())
    };

    app.emit(EVENT_RUNTIME_STARTED, &summary).map_err(|error| {
        CommandError::internal(format!("Failed to emit runtime_started event: {error}"))
    })?;

    // Tray label and tooltip carry the running state, so they go stale unless
    // every start/stop path refreshes them - not just the tray's own menu item.
    rebuild_tray_menu_from_config(&app, &load_response.config);

    Ok(summary)
}

#[tauri::command]
async fn stop_runtime(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    runtime_controller: State<'_, Arc<Mutex<RuntimeController>>>,
) -> Result<RuntimeStateSummary, CommandError> {
    {
        let mut controller = runtime_controller
            .lock()
            .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;
        controller
            .stop()
            .map_err(|message| CommandError::new("runtime_stop_failed", message, None))?;
    }

    let summary = {
        let mut store = runtime_store.lock().recover_poison();
        store.stop()
    };

    app.emit(EVENT_RUNTIME_STOPPED, &summary).map_err(|error| {
        CommandError::internal(format!("Failed to emit runtime_stopped event: {error}"))
    })?;

    rebuild_tray_menu(&app);

    Ok(summary)
}

/// Restarts capture with the config on disk (the capture helper died, or the
/// key-button signals switched). The runtime state stays "running": only the
/// backend is replaced. Decided under the controller lock, like every other
/// start: `Ok(false)` when the runtime is not running or `still_wanted` says a
/// reload / stop-start already replaced what this restart was for.
#[cfg(target_os = "windows")]
pub(crate) fn restart_capture(app: &AppHandle, still_wanted: impl Fn() -> bool) -> Result<bool, String> {
    restart_capture_with(app, still_wanted, false)
}

/// Like [`restart_capture`], but a mouse whose live map did not change keeps
/// it: plugging one receiver in must not rewrite the other mouse.
#[cfg(target_os = "windows")]
pub(crate) fn reload_capture(app: &AppHandle) -> Result<bool, String> {
    restart_capture_with(app, || true, true)
}

fn restart_capture_with(app: &AppHandle, still_wanted: impl Fn() -> bool, keep_maps: bool) -> Result<bool, String> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let config_dir = resolve_config_dir(app).map_err(|error| error.message)?;
    let loaded = load_or_initialize_config(&config_dir).map_err(|error| error.to_string())?;
    let store = app.state::<Arc<Mutex<RuntimeStore>>>().inner().clone();
    let controller = app.state::<Arc<Mutex<RuntimeController>>>();
    let mut controller = controller.lock().map_err(|_| "runtime controller lock poisoned".to_string())?;
    if !store.lock().recover_poison().is_running() || !still_wanted() {
        return Ok(false);
    }
    let name = app.package_info().name.clone();
    let result = if keep_maps {
        controller.reload_saved_config(app.clone(), store.clone(), loaded.config, name)
    } else {
        controller.restart(app.clone(), store.clone(), loaded.config, name)
    };
    if result.is_err() {
        // `restart` already dropped the old backend: say so, as `reload_runtime`
        // does, and in the tray — nobody may be watching the window.
        let stopped_summary = store.lock().recover_poison().stop();
        let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
        rebuild_tray_menu(app);
    }
    result.map(|()| true)
}

/// The frontend's translations of the `backend.*` keys (flat `area.name` →
/// text) for the tray and the OSD; sent at start and on every language change.
#[tauri::command]
fn set_native_texts(app: AppHandle, texts: std::collections::HashMap<String, String>) {
    crate::ui_text::set_native_texts(texts);
    rebuild_tray_menu(&app);
}

#[tauri::command]
async fn reload_runtime(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    runtime_controller: State<'_, Arc<Mutex<RuntimeController>>>,
) -> Result<RuntimeStateSummary, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let load_response =
        tauri::async_runtime::spawn_blocking(move || load_or_initialize_config(&config_dir))
            .await
            .map_err(|error| {
                CommandError::internal(format!("reload_runtime task failed: {error}"))
            })?
            .map_err(CommandError::from)?;

    let restart_result = {
        let mut controller = runtime_controller
            .lock()
            .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;
        controller.restart(
            app.clone(),
            runtime_store.inner().clone(),
            load_response.config.clone(),
            app.package_info().name.clone(),
        )
    };
    if let Err(message) = restart_result {
        let stopped_summary = {
            let mut store = runtime_store.lock().recover_poison();
            store.stop()
        };
        let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
        return Err(CommandError::new("runtime_reload_failed", message, None));
    }

    let summary = {
        let mut store = runtime_store.lock().recover_poison();
        store.reload(load_response.config.version, load_response.warnings.len())
    };

    app.emit(EVENT_CONFIG_RELOADED, &summary).map_err(|error| {
        CommandError::internal(format!("Failed to emit config_reloaded event: {error}"))
    })?;

    // Reflect any profile changes in the tray menu.
    rebuild_tray_menu_from_config(&app, &load_response.config);

    Ok(summary)
}

#[tauri::command]
async fn rehook_capture(
    runtime_controller: State<'_, Arc<Mutex<RuntimeController>>>,
) -> Result<(), CommandError> {
    let mut controller = runtime_controller
        .lock()
        .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;
    controller
        .rehook()
        .map_err(|message| CommandError::new("rehook_failed", message, None))
}

#[tauri::command]
async fn get_debug_log(
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
) -> Result<Vec<DebugLogEntry>, CommandError> {
    let store = runtime_store.lock().recover_poison();

    Ok(store.logs())
}

#[tauri::command]
async fn get_log_directory(app: AppHandle) -> Result<String, CommandError> {
    let log_dir = resolve_log_dir(&app);
    Ok(log_dir.to_string_lossy().into_owned())
}

/// Whether the Sidearm process is itself running with elevated (administrator
/// on Windows, root on Linux) privileges. The frontend uses this to decide
/// whether to show the "Restart as administrator" affordance.
#[tauri::command]
async fn is_running_as_admin() -> Result<bool, CommandError> {
    Ok(window_capture::is_current_process_elevated())
}

#[tauri::command]
async fn get_admin_autostart_status() -> Result<admin_autostart::AdminAutostartStatus, CommandError>
{
    Ok(admin_autostart::query())
}

/// Enable or disable the elevated autostart-at-logon scheduled task.
/// Enabling triggers a UAC prompt (Task Scheduler needs admin to create a
/// RunLevel=Highest task) and re-pins the exe/DLL hashes, so it also serves
/// as the one-time re-confirmation after an update.  After enabling, the
/// frontend should disable the regular tauri-plugin-autostart entry to avoid
/// two launchers competing.
#[tauri::command]
async fn set_admin_autostart(
    enabled: bool,
) -> Result<admin_autostart::AdminAutostartStatus, CommandError> {
    // Blocking: a non-elevated Sidearm waits for its elevated helper (UAC).
    tauri::async_runtime::spawn_blocking(move || {
        let result = if enabled {
            admin_autostart::enable()
        } else {
            admin_autostart::disable()
        };
        if let Err(message) = result {
            return Err(CommandError::new("admin_autostart_failed", message, None));
        }
        Ok(admin_autostart::query())
    })
    .await
    .map_err(|e| CommandError::internal(format!("set_admin_autostart task failed: {e}")))?
}

/// Re-launch Sidearm with administrator privileges and exit the current
/// process. On Windows this goes through `ShellExecuteW` with verb `runas`,
/// which triggers the UAC prompt. If the user cancels the prompt the new
/// process never starts and we report the failure without exiting.
///
/// Why this matters: `SendInput` from a Medium-IL process is silently dropped
/// by Windows UIPI when the foreground window is High-IL (Task Manager,
/// regedit, UAC dialogs). Running elevated is the only way to inject input
/// into those windows.
#[tauri::command]
async fn relaunch_as_admin(app: AppHandle) -> Result<(), CommandError> {
    if window_capture::is_current_process_elevated() {
        return Err(CommandError::from_ui(
            "already_elevated",
            crate::ui_text!("admin.alreadyElevated", "Sidearm is already running with administrator rights."),
        ));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let exe = std::env::current_exe()
            .map_err(|e| CommandError::internal(format!("current_exe failed: {e}")))?;
        let exe_w: Vec<u16> = exe
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let verb_w: Vec<u16> = "runas\0".encode_utf16().collect();
        let params_w: Vec<u16> = mouse_restore::RELAUNCHED_ARG.encode_utf16().chain(std::iter::once(0)).collect();

        // ShellExecuteW returns an HINSTANCE; values <= 32 indicate failure.
        // SE_ERR_ACCESSDENIED (5) is the code we get when the user cancels UAC.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb_w.as_ptr(),
                exe_w.as_ptr(),
                params_w.as_ptr(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        let code = result as isize;
        if code <= 32 {
            let message = if code == 5 {
                crate::ui_text!("admin.elevationCancelled", "Elevation was cancelled in the UAC prompt.")
            } else {
                crate::ui_text!("admin.relaunchFailed", "Could not restart with administrator rights.")
            };
            return Err(CommandError::from_ui("relaunch_cancelled", message));
        }

        // New elevated process launched successfully — release modifiers and
        // exit the current one. The new process has its own keyboard hook.
        let _ = std::panic::catch_unwind(input_synthesis::release_all_modifiers);
        app.exit(0);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err(CommandError::new(
            "unsupported_platform",
            "Restarting as administrator is only supported on Windows.",
            None,
        ))
    }
}

#[tauri::command]
async fn open_log_directory(app: AppHandle) -> Result<(), CommandError> {
    let log_dir = resolve_log_dir(&app);
    if log_dir.exists() {
        #[cfg(target_os = "windows")]
        crate::platform::shell::open_in_explorer(&log_dir).map_err(CommandError::internal)?;
        #[cfg(target_os = "linux")]
        crate::platform::shell::open_in_explorer(&log_dir).map_err(CommandError::internal)?;
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            std::process::Command::new("xdg-open")
                .arg(log_dir.as_os_str())
                .spawn()
                .map_err(|error| {
                    CommandError::internal(format!("Failed to open log directory: {error}"))
                })?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn capture_active_window(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    delay_ms: Option<u64>,
) -> Result<WindowCaptureResult, CommandError> {
    // Suppress auto-profile-switching during capture so that when the user
    // Alt+Tabs to the target window, the foreground watcher doesn't change
    // the active profile before the capture completes.
    {
        let mut store = runtime_store.lock().recover_poison();
        store.set_capture_in_progress(true);
        log::info!("[system] capture_in_progress = true (v2 auto-switching suppressed)");
    }

    // Run the capture logic in a block so that capture_in_progress is ALWAYS
    // reset on exit — success or failure. Without this, a failed capture would
    // permanently disable auto-profile-switching until runtime restart.
    let capture_result: Result<WindowCaptureResult, CommandError> = async {
        let config_dir = resolve_config_dir(&app)?;
        let app_name = app.package_info().name.clone();
        let (result, settings) = tauri::async_runtime::spawn_blocking(move || {
            let load_response = load_or_initialize_config(&config_dir)?;
            let settings = load_response.config.settings.clone();
            let capture = window_capture::capture_active_window_with_resolution(
                &load_response.config,
                &app_name,
                delay_ms,
            )
            .map_err(|message| CommandError::new("window_capture_error", message, None))?;
            Ok::<_, CommandError>((capture, settings))
        })
        .await
        .map_err(|error| {
            CommandError::internal(format!("capture_active_window task failed: {error}"))
        })??;

        {
            let mut store = runtime_store.lock().recover_poison();
            if result.ignored {
                store.record_warn(
                    "windowCapture",
                    result
                        .ignore_reason
                        .clone()
                        .map(crate::ui_text::UiText::from)
                        .unwrap_or_else(|| crate::ui_text!("window.ignored", "The window is ignored.")),
                );
            } else {
                store.record_info(
                    "windowCapture",
                    crate::ui_text!(
                        "window.captured",
                        "Captured `{exe}`, profile `{profile_id}`.",
                        exe = &result.exe,
                        profile_id = result.resolved_profile_id.as_deref().unwrap_or("—")
                    ),
                );
            }
        }

        app.emit(EVENT_PROFILE_RESOLVED, &result).map_err(|error| {
            CommandError::internal(format!("Failed to emit profile_resolved event: {error}"))
        })?;

        // Send OSD notification if active profile changed
        if !result.ignored {
            let should_notify = {
                let mut store = runtime_store.lock().recover_poison();
                store.notify_profile_change(result.resolved_profile_id.as_deref())
            };
            if should_notify {
                let profile_name = result.resolved_profile_name.as_deref().unwrap_or("Default");
                let label = crate::ui_text::native(&crate::ui_text!("runtime.osdProfileLabel", "Profile:"));
                show_osd(&app, &label, profile_name, &settings);
            }
        }

        Ok(result)
    }
    .await;

    // Always reset capture_in_progress regardless of success/failure — even if
    // the mutex was poisoned by a panic in another thread, otherwise a failed
    // capture would permanently disable auto-profile-switching until runtime
    // restart. Use the same `recover_poison()` idiom as every other lock site
    // here instead of silently skipping the reset on a poisoned lock. See
    // finding F036.
    {
        let mut store = runtime_store.lock().recover_poison();
        store.set_capture_in_progress(false);
        log::info!("[system] capture_in_progress = false (auto-switching resumed)");
    }

    let result = capture_result?;

    // Return focus to the studio window after capture
    if let Some(window) = app.get_webview_window("main") {
        bring_to_front(&window);
    }

    Ok(result)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunningProcessInfo {
    exe: String,
    path: String,
    pid: u32,
}

#[tauri::command]
async fn list_running_processes() -> Result<Vec<RunningProcessInfo>, CommandError> {
    tauri::async_runtime::spawn_blocking(|| -> Vec<RunningProcessInfo> {
        #[cfg(target_os = "windows")]
        {
            crate::platform::shell::list_running_processes()
                .into_iter()
                .map(|p| RunningProcessInfo {
                    exe: p.exe,
                    path: p.path,
                    pid: p.pid,
                })
                .collect()
        }
        #[cfg(target_os = "linux")]
        {
            return crate::platform::shell::list_running_processes()
                .into_iter()
                .map(|p| RunningProcessInfo {
                    exe: p.exe,
                    path: p.path,
                    pid: p.pid,
                })
                .collect();
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            Vec::new()
        }
    })
    .await
    .map_err(|e| CommandError::internal(format!("list_running_processes task failed: {e}")))
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PresetInfo {
    id: String,
    name: String,
    description: String,
}

#[derive(serde::Deserialize)]
struct PresetFileMeta {
    profile: PresetFileProfile,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetFileProfile {
    name: String,
    #[serde(default)]
    description: Option<String>,
}

fn presets_dir(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .resolve("resources/presets", tauri::path::BaseDirectory::Resource)
        .map_err(|e| CommandError::internal(format!("failed to resolve presets dir: {e}")))
}

#[tauri::command]
async fn list_bundled_presets(app: AppHandle) -> Result<Vec<PresetInfo>, CommandError> {
    let dir = presets_dir(&app)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| {
        CommandError::new(
            "io_error",
            format!("cannot read presets dir `{}`: {e}", dir.display()),
            None,
        )
    })?;

    let mut out: Vec<PresetInfo> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                log::warn!("[presets] Skipping unreadable directory entry: {error}");
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(stem) => stem.to_string(),
            None => continue,
        };
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(error) => {
                log::warn!(
                    "[presets] Skipping unreadable preset {}: {error}",
                    path.display()
                );
                continue;
            }
        };
        let meta: PresetFileMeta = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(error) => {
                log::warn!(
                    "[presets] Skipping invalid preset {}: {error}",
                    path.display()
                );
                continue;
            }
        };
        out.push(PresetInfo {
            id,
            name: meta.profile.name,
            description: meta.profile.description.unwrap_or_default(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
async fn read_bundled_preset(
    app: AppHandle,
    id: String,
) -> Result<serde_json::Value, CommandError> {
    if id.contains('/') || id.contains('\\') || id.contains("..") || id.is_empty() {
        return Err(CommandError::new(
            "invalid_input",
            format!("invalid preset id `{id}`"),
            None,
        ));
    }
    let path = presets_dir(&app)?.join(format!("{id}.json"));
    let bytes = std::fs::read(&path).map_err(|e| {
        CommandError::new(
            "io_error",
            format!("cannot read preset `{}`: {e}", path.display()),
            None,
        )
    })?;
    serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|e| {
        CommandError::new(
            "parse_error",
            format!("preset `{id}` is not valid JSON: {e}"),
            None,
        )
    })
}

#[tauri::command]
async fn preview_resolution(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
) -> Result<ResolvedInputPreview, CommandError> {
    let normalized_key = encoded_key.trim().to_owned();
    if normalized_key.is_empty() {
        return Err(CommandError::new(
            "invalid_request",
            "encodedKey must not be empty.",
            None,
        ));
    }

    let config_dir = resolve_config_dir(&app)?;
    let exe = exe.unwrap_or_default();
    let title = title.unwrap_or_default();
    let preview = tauri::async_runtime::spawn_blocking(move || {
        let load_response = load_or_initialize_config(&config_dir)?;
        Ok::<ResolvedInputPreview, ConfigStoreError>(resolver::resolve_input_preview(
            &load_response.config,
            &normalized_key,
            &exe,
            &title,
            None,
        ))
    })
    .await
    .map_err(|error| CommandError::internal(format!("preview_resolution task failed: {error}")))?
    .map_err(CommandError::from)?;

    {
        let mut store = runtime_store.lock().recover_poison();
        match preview.status {
            resolver::ResolutionStatus::Resolved => store.record_info(
                "resolution",
                crate::ui_text!(
                    "resolution.resolved",
                    "Resolved `{encoded_key}` to control `{control_id}` for profile `{profile_id}`.",
                    encoded_key = &preview.encoded_key,
                    control_id = preview.control_id.as_deref().unwrap_or("—"),
                    profile_id = preview.resolved_profile_id.as_deref().unwrap_or("—")
                ),
            ),
            resolver::ResolutionStatus::Unresolved => store.record_warn(
                "resolution",
                crate::ui_text!(
                    "resolution.unresolved",
                    "Not resolved `{encoded_key}`: {reason}",
                    encoded_key = &preview.encoded_key,
                    reason = &preview.reason
                ),
            ),
            resolver::ResolutionStatus::Ambiguous => store.record_warn(
                "resolution",
                crate::ui_text!(
                    "resolution.ambiguous",
                    "Ambiguous result `{encoded_key}`: {reason}",
                    encoded_key = &preview.encoded_key,
                    reason = &preview.reason
                ),
            ),
            resolver::ResolutionStatus::ConditionUnmet => store.record_info(
                "resolution",
                crate::ui_text!(
                    "resolution.conditionUnmet",
                    "Conditions not met for `{encoded_key}`: {reason}",
                    encoded_key = &preview.encoded_key,
                    reason = &preview.reason
                ),
            ),
        }
    }

    app.emit(EVENT_CONTROL_RESOLVED, &preview)
        .map_err(|error| {
            CommandError::internal(format!("Failed to emit control_resolved event: {error}"))
        })?;

    Ok(preview)
}

/// Distinguishes dry-run preview from live execution for logging purposes.
enum ActionRunMode {
    DryRun,
    Live,
}

/// Shared logic for execute_preview_action and run_preview_action.
async fn resolve_and_execute_action(
    app: &AppHandle,
    runtime_store: &State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
    executor_fn: fn(
        &AppConfig,
        &ResolvedInputPreview,
    ) -> Result<ActionExecutionEvent, executor::ExecutorError>,
    mode: ActionRunMode,
) -> Result<ActionExecutionEvent, CommandError> {
    let normalized_key = encoded_key.trim().to_owned();
    if normalized_key.is_empty() {
        return Err(CommandError::new(
            "invalid_request",
            "encodedKey must not be empty.",
            None,
        ));
    }

    let config_dir = resolve_config_dir(app)?;
    let exe = exe.unwrap_or_default();
    let title = title.unwrap_or_default();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let load_response = load_or_initialize_config(&config_dir)?;
        let preview = resolver::resolve_input_preview(
            &load_response.config,
            &normalized_key,
            &exe,
            &title,
            None,
        );
        let execution = executor_fn(&load_response.config, &preview);
        Ok::<_, ConfigStoreError>((preview, execution))
    })
    .await
    .map_err(|error| CommandError::internal(format!("action execution task failed: {error}")))?
    .map_err(CommandError::from)?;

    let (preview, execution) = result;

    app.emit(EVENT_CONTROL_RESOLVED, &preview)
        .map_err(|error| {
            CommandError::internal(format!("Failed to emit control_resolved event: {error}"))
        })?;

    match execution {
        Ok(event) => {
            {
                let mut store = runtime_store.lock().recover_poison();
                match mode {
                    ActionRunMode::DryRun => {
                        let message = crate::ui_text!(
                            "execution.dryRun",
                            "Dry run of `{action}` for `{encoded_key}`.",
                            action = &event.action_pretty,
                            encoded_key = &event.encoded_key
                        );
                        match event.outcome {
                            executor::ExecutionOutcome::Noop => {
                                store.record_warn("execution", message);
                            }
                            _ => {
                                store.record_info("execution", message);
                            }
                        }
                        for warning in &event.warnings {
                            store.record_warn("execution", warning.clone());
                        }
                    }
                    ActionRunMode::Live => {
                        store.record_info(
                            "execution",
                            crate::ui_text!(
                                "execution.live",
                                "Executed live `{action}` for `{encoded_key}`.",
                                action = &event.action_pretty,
                                encoded_key = &event.encoded_key
                            ),
                        );
                    }
                }
            }

            app.emit(EVENT_ACTION_EXECUTED, &event).map_err(|error| {
                CommandError::internal(format!("Failed to emit action_executed event: {error}"))
            })?;

            Ok(event)
        }
        Err(error) => {
            emit_runtime_error(app, runtime_store, &error.event)?;
            Err(CommandError {
                details: Some(
                    [
                        error.event.encoded_key.clone(),
                        error.event.action_id.clone(),
                    ]
                    .into_iter()
                    .flatten()
                    .collect(),
                ),
                ..CommandError::from_ui(error.code, error.event.message.clone())
            })
        }
    }
}

#[tauri::command]
async fn execute_preview_action(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
) -> Result<ActionExecutionEvent, CommandError> {
    resolve_and_execute_action(
        &app,
        &runtime_store,
        encoded_key,
        exe,
        title,
        executor::execute_preview_action,
        ActionRunMode::DryRun,
    )
    .await
}

#[tauri::command]
async fn run_preview_action(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
) -> Result<ActionExecutionEvent, CommandError> {
    resolve_and_execute_action(
        &app,
        &runtime_store,
        encoded_key,
        exe,
        title,
        executor::run_preview_action,
        ActionRunMode::Live,
    )
    .await
}

/// Live-test a draft action straight from the picker (no save, no encoder signal).
/// Actually executes the action; the frontend runs the "switch to your window"
/// countdown before calling this. Loads the on-disk config only to resolve
/// library snippets / profile names referenced by the draft.
#[tauri::command]
async fn live_test_action(
    app: AppHandle,
    action: config::Action,
    profile_id: Option<String>,
) -> Result<ActionExecutionEvent, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    // HID queries can wait for the shared device lock; keep them off async workers.
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_or_initialize_config(&config_dir).map_err(CommandError::from)?.config;
        executor::live_test_action(&config, &action, profile_id.as_deref()).map_err(|error| CommandError {
            details: error.event.action_id.clone().map(|id| vec![id]),
            ..CommandError::from_ui(error.code, error.event.message.clone())
        })
    }).await.map_err(|error| CommandError::internal(format!("live_test_action task failed: {error}")))?
}

fn emit_runtime_error(
    app: &AppHandle,
    runtime_store: &State<'_, Arc<Mutex<RuntimeStore>>>,
    event: &RuntimeErrorEvent,
) -> Result<(), CommandError> {
    {
        let mut store = runtime_store.lock().recover_poison();
        store.record_warn(
            event.category.clone(),
            format!("{}{}", event.message, runtime_error_context(event)),
        );
    }

    app.emit(EVENT_RUNTIME_ERROR, event).map_err(|error| {
        CommandError::internal(format!("Failed to emit runtime_error event: {error}"))
    })?;

    Ok(())
}

fn record_startup_runtime_error(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    category: impl Into<String>,
    message: impl Into<crate::ui_text::UiText>,
) {
    let event = RuntimeErrorEvent {
        category: category.into(),
        message: message.into(),
        encoded_key: None,
        action_id: None,
        created_at: runtime::timestamp_millis(),
    };
    {
        let mut store = runtime_store.lock().recover_poison();
        store.record_warn(event.category.clone(), event.message.clone());
    }
    let _ = app.emit(EVENT_RUNTIME_ERROR, &event);
}

fn runtime_error_context(event: &RuntimeErrorEvent) -> String {
    let mut parts = Vec::new();
    if let Some(encoded_key) = &event.encoded_key {
        parts.push(format!("encodedKey={encoded_key}"));
    }
    if let Some(action_id) = &event.action_id {
        parts.push(format!("actionId={action_id}"));
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", parts.join(", "))
    }
}

#[tauri::command]
async fn start_macro_recording(
    recorder: State<'_, Arc<Mutex<MacroRecorder>>>,
) -> Result<(), CommandError> {
    let mut rec = recorder
        .lock()
        .map_err(|_| CommandError::internal("recorder lock poisoned"))?;
    rec.start(runtime::timestamp_millis())
        .map_err(|msg| CommandError::new("recording_error", msg, None))
}

#[tauri::command]
async fn record_keystroke(
    recorder: State<'_, Arc<Mutex<MacroRecorder>>>,
    key: String,
) -> Result<(), CommandError> {
    let mut rec = recorder
        .lock()
        .map_err(|_| CommandError::internal("recorder lock poisoned"))?;
    rec.record_keystroke(key, runtime::timestamp_millis());
    Ok(())
}

#[tauri::command]
async fn stop_macro_recording(
    recorder: State<'_, Arc<Mutex<MacroRecorder>>>,
) -> Result<recorder::MacroRecording, CommandError> {
    let mut rec = recorder
        .lock()
        .map_err(|_| CommandError::internal("recorder lock poisoned"))?;
    rec.stop(runtime::timestamp_millis())
        .map_err(|msg| CommandError::new("recording_error", msg, None))
}

/// No onboard-path mouse plugged in is `onboard_not_connected` (the guard
/// writes it when one appears); any other open failure is a real error.
#[cfg(target_os = "windows")]
fn onboard_open_error(message: String) -> CommandError {
    let code = if message == mouse_memory::NOT_CONNECTED { "onboard_not_connected" } else { "onboard_device_unavailable" };
    CommandError::new(code, message, None)
}

/// Writes the thumb-button mapping into the mouse's onboard memory, so the
/// mouse emits those key codes itself and no vendor remapper has to run.
/// `bindings` come from the config's `encoder_mappings`; each write is verified
/// against the mouse's own reply.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn apply_onboard_mapping(
    bindings: Vec<mouse_memory::OnboardBinding>,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let device = mouse_memory::VendorDevice::open_onboard().map_err(onboard_open_error)?;
        device
            .apply_bindings(&bindings)
            .map_err(|msg| CommandError::new("onboard_write_unconfirmed", msg, None))
    })
    .await
    .map_err(|e| CommandError::internal(format!("apply_onboard_mapping task failed: {e}")))?
}

/// Asks the mouse which of the given bindings it actually holds. The vendor
/// collection answers only with what the previous write stored, so the mouse
/// cannot be read — each binding is written and confirmed by its echo.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn verify_onboard_mapping(
    bindings: Vec<mouse_memory::OnboardBinding>,
) -> Result<mouse_memory::OnboardReport, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let device = mouse_memory::VendorDevice::open_onboard().map_err(onboard_open_error)?;
        device
            .verify(&bindings)
            .map_err(|msg| CommandError::new("onboard_write_unconfirmed", msg, None))
    })
    .await
    .map_err(|e| CommandError::internal(format!("verify_onboard_mapping task failed: {e}")))?
}

/// Puts the mouse back under Sidearm's control: `Normal` mode plus the onboard
/// mapping the config asks for. The takeover notification offers this so the user
/// can take the buttons back without restarting anything.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn restore_onboard_control(app: AppHandle) -> Result<(), CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let config = config::read_and_migrate_config_file(&config_dir.join("config.json"))
            .map_err(CommandError::from)?;
        restore_and_verify_onboard(&config)
    })
    .await
    .map_err(|e| CommandError::internal(format!("restore_onboard_control task failed: {e}")))?
}

#[cfg(target_os = "windows")]
fn restore_and_verify_onboard(config: &AppConfig) -> Result<(), CommandError> {
    let device = mouse_memory::VendorDevice::open_onboard().map_err(onboard_open_error)?;
    device.ensure_normal_mode()
        .map_err(|msg| CommandError::new("onboard_mode_stuck", msg, None))?;
    mouse_offline::write_signals(&device, config)
        .map_err(|msg| CommandError::new("onboard_write_unconfirmed", msg, None))?;
    let bindings = mouse_memory::onboard_bindings(config);
    if device.mode().map_err(CommandError::internal)? != mouse_memory::MODE_NORMAL
        || !device.drifted_bindings(&bindings).map_err(CommandError::internal)?.is_empty()
        || !device.drifted_native_buttons().map_err(CommandError::internal)?.is_empty() {
        return Err(CommandError::internal("Mouse settings could not be confirmed. Wake the mouse and retry."));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_synapse_status(app: AppHandle) -> Result<synapse_control::Status, CommandError> {
    let dir = resolve_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || synapse_control::status(&dir))
        .await.map_err(|e| CommandError::internal(e.to_string()))?.map_err(CommandError::internal)
}

#[cfg(target_os = "windows")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SynapseRecoveryResult {
    startup_disabled: bool,
    startup_error: Option<CommandError>,
}

#[cfg(target_os = "windows")]
fn synapse_command_error(reason: impl Into<String>) -> CommandError {
    let reason = reason.into();
    log::warn!("[synapse-recovery] {reason}");
    let mut error = CommandError::from_ui("synapse_recovery_failed", crate::ui_text!(
        "synapse.recoveryFailed",
        "Could not finish setup. Wake the mouse, finish any Razer update, close Synapse and retry. Details are in the diagnostics log."
    ));
    error.details = Some(vec![reason]);
    error
}

/// Explicit ownership transfer. Successful writes are read back; a physical
/// HyperShift test remains a separate user step, never inferred from HID memory.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn recover_from_synapse(app: AppHandle, disable_startup: bool, close_synapse: bool) -> Result<SynapseRecoveryResult, CommandError> {
    let dir = resolve_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = synapse_control::RECOVERY_LOCK.try_lock()
            .map_err(|_| synapse_command_error("A Synapse recovery operation is already running"))?;
        if !app.state::<Arc<Mutex<RuntimeStore>>>().lock().recover_poison().is_running() {
            return Err(CommandError::from_ui("runtime_stopped", crate::ui_text!("synapse.runtimeStopped", "Start Sidearm capture and retry.")));
        }
        let config = config::read_and_migrate_config_file(&dir.join("config.json")).map_err(CommandError::from)?;
        let present = mouse_memory::present_models();
        if present.is_empty() {
            return Err(synapse_command_error(mouse_memory::NOT_CONNECTED));
        }
        if present.iter().all(|model| !model.verified) {
            return Err(CommandError::from_ui("unverified_mouse", crate::ui_text!("synapse.unverifiedMouse", "This mouse model is not verified for Sidearm's native setup. Synapse was left running.")));
        }
        // A live-map mouse is set up again by the capture restart below.
        let onboard = present.iter().any(|model| model.verified && model.transport == device_catalog::Transport::Onboard);
        if close_synapse {
            synapse_control::close_engines().map_err(synapse_command_error)?;
        } else if synapse_control::engine_running().map_err(synapse_command_error)? {
            return Err(CommandError::from_ui("synapse_restarted", crate::ui_text!("synapse.restarted", "Synapse started again. Use the close-Synapse action to continue.")));
        }
        if onboard {
            restore_and_verify_onboard(&config).map_err(|e| synapse_command_error(e.message))?;
        }
        if !restart_capture(&app, || true).map_err(synapse_command_error)? {
            return Err(CommandError::from_ui("runtime_stopped", crate::ui_text!("synapse.runtimeStopped", "Start Sidearm capture and retry.")));
        }
        if synapse_control::engine_running().map_err(synapse_command_error)? {
            return Err(CommandError::from_ui("synapse_restarted", crate::ui_text!("synapse.restarted", "Synapse started again. Use the close-Synapse action to continue.")));
        }
        // Change future startup only after the current-session repair succeeds.
        let startup_result = if disable_startup && close_synapse { synapse_control::disable_startup(&dir) } else { Ok(()) };
        onboard_guard::request_check();
        log::info!("[synapse-recovery] vendor engine closed; onboard settings verified; capture restarted; awaiting physical test");
        Ok(SynapseRecoveryResult { startup_disabled: disable_startup && close_synapse && startup_result.is_ok(), startup_error: startup_result.err().map(|reason| {
            log::warn!("[synapse-recovery] startup: {reason}");
            CommandError::from_ui("synapse_startup_failed", crate::ui_text!("synapse.startupFailed", "The startup entry could not be changed. Use Windows Startup apps, or restore the saved entry before retrying."))
        }) })
    }).await.map_err(|e| CommandError::internal(e.to_string()))?
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn restore_synapse_startup(app: AppHandle) -> Result<(), CommandError> {
    let dir = resolve_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = synapse_control::RECOVERY_LOCK.try_lock()
            .map_err(|_| synapse_command_error("A Synapse recovery operation is already running"))?;
        synapse_control::restore_startup(&dir).map_err(|reason| {
            log::warn!("[synapse-recovery] startup restore: {reason}");
            CommandError::from_ui("synapse_startup_restore_failed", crate::ui_text!("synapse.startupRestoreFailed", "The saved startup entry could not be restored. It was kept for a retry; no newer entry was overwritten."))
        })
    }).await.map_err(|e| CommandError::internal(e.to_string()))?
}

/// Set once exit work began: no capture restart may write the mice after it.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

/// Exit work for the mice, once per process — a clean exit and the end of the
/// Windows session both run it. Stops the capture helper first (an orphaned
/// helper keeps its mouse hook alive and swallows back/forward after exit),
/// which also restores every live map, then stores the offline profile.
pub(crate) fn shutdown_mouse(app: &AppHandle) {
    // The session end and the app exit can race: the second caller waits for
    // the first, so the process never ends in the middle of the writes.
    // A Mutex, not a Once: a first run that panicked must not abort the second
    // caller (from a window procedure) with a poisoned Once.
    static SHUTDOWN: Mutex<bool> = Mutex::new(false);
    let mut done = SHUTDOWN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !std::mem::replace(&mut *done, true) {
        shutdown_mouse_once(app);
    }
}

fn shutdown_mouse_once(app: &AppHandle) {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    #[cfg(target_os = "windows")]
    onboard_guard::wait_tick();
    if let Ok(mut controller) = app.state::<Arc<Mutex<RuntimeController>>>().lock()
        && let Err(message) = controller.stop()
    {
        log::warn!("[system] runtime stop on exit failed: {message}");
    }
    // Every session still restoring its mouse — the stop's own, and any a
    // config reload handed off — finishes before the offline write.
    #[cfg(target_os = "windows")]
    if !mouse_memory::live_overlay::wait_idle(std::time::Duration::from_secs(30)) {
        log::warn!("[system] a live map was still being restored at exit");
    }
    #[cfg(target_os = "windows")]
    {
        write_offline_mouse_profile(app);
        // A mouse that slept through it gets its profile once it wakes.
        if let Ok(config_dir) = resolve_config_dir(app) {
            if config_dir.join(mouse_offline::OFFLINE_FAILED_FILE).exists() {
                spawn_live_map_restore(&config_dir, false);
            }
            // Last: an exit cut short leaves the watchdog to finish it.
            mouse_restore::mark_clean_exit(&config_dir);
        }
    }
}

/// On exit: store the profile in effect in the mouse itself, so its simple
/// bindings keep working while Sidearm is closed (see `mouse_offline`).
#[cfg(target_os = "windows")]
fn write_offline_mouse_profile(app: &AppHandle) {
    let Ok(config_dir) = resolve_config_dir(app) else {
        return;
    };
    let Ok(config) = config::read_and_migrate_config_file(&config_dir.join("config.json")) else {
        return;
    };
    let store = app.state::<Arc<Mutex<RuntimeStore>>>();
    // Default: the fallback profile. The one in effect at exit depends on which
    // window happened to be focused — a per-app profile full of snippets the
    // mouse cannot play left buttons dead without Sidearm.
    let in_effect = store.lock().ok().and_then(|store| store.last_active_profile_id().map(str::to_owned));
    let profile_id = mouse_offline::offline_profile_id(&config, in_effect);
    mouse_offline::write_offline_profile(&config, &profile_id, &config_dir);
}

/// Opens the mouse, runs `work` on it, and returns its fresh settings.
#[cfg(target_os = "windows")]
async fn with_mouse_settings(
    device_id: Option<String>,
    work: impl FnOnce(&mouse_memory::VendorDevice) -> Result<(), String> + Send + 'static,
) -> Result<mouse_settings::MouseSettings, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let device = open_mouse(device_id.as_deref())
            .map_err(|msg| {
                let mut error = CommandError::from_ui("onboard_device_unavailable",
                    crate::ui_text!("mouseRead.accessFailed", "Could not access the mouse."));
                error.details = Some(vec![mouse_settings::public_read_error(&msg)]);
                error
            })?;
        work(&device).map_err(|msg| {
            let mut error = CommandError::from_ui("mouse_setting_failed",
                crate::ui_text!("mouseRead.writeNotConfirmed", "Could not confirm the mouse setting."));
            error.details = Some(vec![mouse_settings::public_read_error(&msg)]);
            error
        })?;
        // Each setter has already verified its own write. Other failed readings
        // are warnings in the snapshot, not a second failure of that write.
        Ok(device.settings())
    })
    .await
    .map_err(|e| CommandError::internal(format!("mouse settings task failed: {e}")))?
}

/// The mouse of a config device, or the first connected one.
#[cfg(target_os = "windows")]
fn open_mouse(device_id: Option<&str>) -> Result<mouse_memory::VendorDevice, String> {
    match device_id {
        Some(device_id) => mouse_memory::VendorDevice::open_for_device(device_id),
        None => mouse_memory::VendorDevice::open_connected(),
    }
}

/// Name, DPI range, poll rates and verification of a natively driven model:
/// the one plugged in for `device_id` (else any), else the catalog's default
/// for that device. Catalog data plus a registry lookup and an open handle —
/// no vendor command, so a sleeping mouse still answers.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_native_model(device_id: Option<String>) -> Result<device_catalog::NativeModelInfo, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let consumer = mouse_memory::consumer_signals_enabled();
        match open_mouse(device_id.as_deref()) {
            Ok(device) => device.model().info(true, consumer),
            Err(_) => device_id
                .as_deref()
                .and_then(|id| device_catalog::CATALOG.iter().find(|model| model.device_id == id).copied())
                .unwrap_or_else(mouse_memory::config_model)
                .info(false, consumer),
        }
    })
    .await
    .map_err(|e| CommandError::internal(format!("native model task failed: {e}")))
}

/// Every catalog mouse whose receiver is plugged in now, without talking to it.
#[cfg(target_os = "windows")]
#[tauri::command]
fn list_native_mice() -> Vec<device_catalog::NativeModelInfo> {
    let consumer = mouse_memory::consumer_signals_enabled();
    mouse_memory::present_models().into_iter().map(|model| model.info(true, consumer)).collect()
}

/// The onboard banks of a device's mouse (`live_overlay::Banks`).
#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_onboard_banks(device_id: String) -> Result<mouse_memory::live_overlay::Banks, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let model = device_catalog::CATALOG
            .iter()
            .find(|model| model.device_id == device_id && model.live.as_ref().is_some_and(|live| live.banks))
            .ok_or_else(|| CommandError::internal(format!("{device_id} has no onboard banks")))?;
        mouse_memory::live_overlay::banks(model).map_err(|msg| {
            let mut error = CommandError::from_ui("onboard_device_unavailable",
                crate::ui_text!("mouseRead.accessFailed", "Could not access the mouse."));
            error.details = Some(vec![mouse_settings::public_read_error(&msg)]);
            error
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("onboard banks task failed: {e}")))?
}

/// Read-only dump of the connected mouse for a "help verify" issue
/// (`VendorDevice::probe_report`). Scans every button id, so it takes ~20 s.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_device_report(detail: Option<mouse_settings::ReportDetail>, device_id: Option<String>) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let detail = detail.unwrap_or_default();
        match open_mouse(device_id.as_deref()) {
            Ok(device) => Ok(match detail {
                mouse_settings::ReportDetail::Summary => device.probe_summary(),
                mouse_settings::ReportDetail::Full => device.probe_report(),
            }),
            Err(message) if matches!(detail, mouse_settings::ReportDetail::Summary) =>
                Ok(mouse_memory::unavailable_device_report(&message)),
            Err(message) => {
                let mut error = CommandError::from_ui("onboard_device_unavailable",
                    crate::ui_text!("mouseRead.accessFailed", "Could not access the mouse."));
                error.details = Some(vec![mouse_settings::public_read_error(&message)]);
                Err(error)
            }
        }
    })
    .await
    .map_err(|e| CommandError::internal(format!("device report task failed: {e}")))?
}

/// Opens a new GitHub issue for a device report in the browser. The report
/// itself goes through the clipboard: it is too long for a URL.
#[cfg(target_os = "windows")]
#[tauri::command]
fn open_device_report_issue() -> Result<(), CommandError> {
    // The form (.github/ISSUE_TEMPLATE/device_report.yml) asks for the report,
    // the connection and notes, and labels the issue `device-report`.
    const URL: &str = "https://github.com/danscMax/Sidearm/issues/new?template=device_report.yml&title=Device%20report%3A%20";
    crate::platform::shell::open_target(URL).map_err(CommandError::internal)
}

/// Mouse-path states and pending notices (`mouse_status::snapshot`); the
/// pending notices are taken.
#[cfg(target_os = "windows")]
#[tauri::command]
fn get_mouse_status() -> Vec<mouse_status::StatusEvent> {
    mouse_status::snapshot()
}

/// Switches what the key buttons send: consumer signals (`true`) or
/// `F13`..`F24` — the file `onboard-key-signals` next to the config, kept for
/// the next start. Returns once the mouse holds the new signals and a running
/// capture has restarted to read (or stop reading) them; a stopped one stays
/// stopped. A mouse that cannot take the records now (asleep) gets them from
/// the guard later.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_key_signals(app: AppHandle, consumer: bool) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || switch_key_signals(&app, consumer))
        .await
        .map_err(|e| CommandError::internal(format!("signal switch task failed: {e}")))?
}

#[cfg(target_os = "windows")]
fn switch_key_signals(app: &AppHandle, consumer: bool) -> Result<(), CommandError> {
    let file = resolve_config_dir(app)?.join(mouse_memory::KEY_SIGNALS_FILE);
    let result = if consumer {
        std::fs::remove_file(&file).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
    } else {
        std::fs::write(&file, b"")
    };
    result.map_err(|e| CommandError::internal(format!("{}: {e}", file.display())))?;
    // Before the flag flips: a guard tick in between must already know the
    // rewrite it is about to make is the user's own.
    onboard_guard::USER_SWITCHED_SIGNALS.store(true, std::sync::atomic::Ordering::SeqCst);
    mouse_memory::set_consumer_signals(consumer);
    log::info!("[onboard] key buttons now send {}", if consumer { "consumer signals" } else { "F13..F24" });
    let config_dir = resolve_config_dir(app)?;
    let rewritten = load_or_initialize_config(&config_dir)
        .map_err(|error| error.to_string())
        .and_then(|loaded| {
            let device = match mouse_memory::VendorDevice::open_onboard() {
                Ok(device) => device,
                // Live maps follow from the capture restart below.
                Err(message) if message == mouse_memory::NOT_CONNECTED => return Ok(()),
                Err(message) => return Err(message),
            };
            if mouse_memory::live_overlay::is_active(device.model()) {
                return Ok(()); // The capture restart below rewrites its live map.
            }
            device.apply_bindings(&mouse_memory::onboard_bindings(&loaded.config))
        });
    if let Err(message) = rewritten {
        log::info!("[onboard] signal switch left to the guard: {message}");
        onboard_guard::request_check();
    }
    restart_capture(app, || true).map_err(|message| CommandError::new("runtime_reload_failed", message, None))?;
    Ok(())
}

/// Opens Windows Settings → Apps → Startup, where Razer Synapse's autostart
/// is turned off (the `razerStarted` toast's action). A fixed target.
#[cfg(target_os = "windows")]
#[tauri::command]
fn open_startup_apps_settings() -> Result<(), CommandError> {
    crate::platform::shell::open_target("ms-settings:startupapps").map_err(CommandError::internal)
}

/// Battery, DPI and poll rate as the mouse reports them now.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_mouse_settings(device_id: Option<String>) -> Result<mouse_settings::MouseSettings, CommandError> {
    tauri::async_runtime::spawn_blocking(move || match open_mouse(device_id.as_deref()) {
        Ok(device) => device.settings(),
        Err(error) => mouse_settings::MouseSettings::inaccessible(&error, error == mouse_memory::NOT_CONNECTED),
    }).await.map_err(|error| CommandError::internal(format!("mouse settings task failed: {error}")))
}

/// Stores a DPI in the mouse (both axes) and returns the settings read back.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_mouse_dpi(dpi: u16, device_id: Option<String>) -> Result<mouse_settings::MouseSettings, CommandError> {
    with_mouse_settings(device_id, move |device| {
        device.set_dpi(dpi, true)?;
        mouse_speed::forget_originals(device.model().device_id, true, false);
        Ok(())
    })
    .await
}

/// Sets the mouse poll rate (125/500/1000 Hz) and returns the settings read back.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_mouse_poll_rate(hz: u16, device_id: Option<String>) -> Result<mouse_settings::MouseSettings, CommandError> {
    with_mouse_settings(device_id, move |device| {
        device.set_poll_rate_hz(hz)?;
        mouse_speed::forget_originals(device.model().device_id, false, true);
        Ok(())
    })
    .await
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_exe_icon(
    exe_name: String,
    process_path: Option<String>,
) -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Try the known process path first (most reliable — captured from OS)
        if let Some(ref path) = process_path
            && std::path::Path::new(path).exists()
            && let Some(b64) = exe_icon::extract_icon_base64(path)
        {
            return Ok(Some(b64));
        }
        // 2. Fall back to API-based search (App Paths registry + SearchPathW)
        let candidates = exe_icon_search_paths(&exe_name);
        for path in &candidates {
            if let Some(b64) = exe_icon::extract_icon_base64(path) {
                return Ok(Some(b64));
            }
        }
        // 3. Try to find path from a running process with this exe name
        if let Some(path) = find_running_process_path(&exe_name)
            && let Some(b64) = exe_icon::extract_icon_base64(&path)
        {
            return Ok(Some(b64));
        }
        Ok(None)
    })
    .await
    .map_err(|error| CommandError::internal(format!("get_exe_icon task failed: {error}")))?
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn get_exe_icon(
    _exe_name: String,
    _process_path: Option<String>,
) -> Result<Option<String>, CommandError> {
    Ok(None)
}

/// Resolve the full path of an exe using platform-specific APIs.
#[cfg(target_os = "windows")]
fn exe_icon_search_paths(exe_name: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(path) = crate::platform::shell::lookup_app_paths_registry(exe_name) {
        paths.push(path);
    }
    if let Some(path) = crate::platform::shell::search_path_win32(exe_name)
        && !paths.contains(&path)
    {
        paths.push(path);
    }
    paths
}

fn find_running_process_path(exe_name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    return crate::platform::shell::find_running_process_path(exe_name);
    #[cfg(target_os = "linux")]
    return crate::platform::shell::find_running_process_path(exe_name);
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = exe_name;
        return None;
    }
}

/// Migrate config from the old "com.nagaworkflowstudio.desktop" directory
/// to the new "com.sidearm.desktop" directory (one-time).
/// Overwrites the new config if the old one is larger (has real user data
/// vs a freshly-generated default).
fn migrate_old_config(app: &AppHandle) {
    // Skip in portable mode — users opting into portable explicitly don't want
    // old %APPDATA% data silently copied into their ./data/ folder.
    let app_paths = resolve_app_paths(app);
    if app_paths.mode != paths::PathMode::Roaming {
        return;
    }
    let new_config_dir = app_paths.config_dir.clone();
    let Some(roaming) = dirs_fallback_roaming() else {
        return;
    };

    let old_dir = roaming.join("com.nagaworkflowstudio.desktop");
    let old_config = old_dir.join("config.json");
    if !old_config.exists() {
        return;
    }

    let new_config = new_config_dir.join("config.json");
    let old_size = fs::metadata(&old_config).map(|m| m.len()).unwrap_or(0);
    let new_size = fs::metadata(&new_config).map(|m| m.len()).unwrap_or(0);

    // Only migrate if old config has more data (user profiles vs empty default)
    if old_size <= new_size {
        return;
    }

    if let Err(error) = fs::create_dir_all(&new_config_dir) {
        log::warn!(
            "[system] Could not create config migration destination {}: {error}",
            new_config_dir.display()
        );
        return;
    }
    // Copy all json files (config + backups + window-state)
    match fs::read_dir(&old_dir) {
        Ok(entries) => {
            for entry_result in entries {
                let entry = match entry_result {
                    Ok(entry) => entry,
                    Err(error) => {
                        log::warn!("[system] Skipping unreadable config migration entry: {error}");
                        continue;
                    }
                };
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "json") {
                    let dest = new_config_dir.join(entry.file_name());
                    if let Err(error) = atomic_copy_file(&path, &dest) {
                        log::warn!(
                            "[system] Could not migrate config file {} to {}: {error}",
                            path.display(),
                            dest.display()
                        );
                    }
                }
            }
        }
        Err(error) => {
            log::warn!(
                "[system] Could not read old config directory {}: {error}",
                old_dir.display()
            );
        }
    }
    log::info!(
        "[system] Migrated config from old directory: {}",
        old_dir.display()
    );
}

/// Get %APPDATA% without depending on the Tauri path resolver (which uses the new identifier).
fn dirs_fallback_roaming() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(PathBuf::from)
}

/// Get %LOCALAPPDATA% (where Tauri puts the default log dir for our app).
fn dirs_fallback_local() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA").ok().map(PathBuf::from)
}

/// The log directory Sidearm uses when running in roaming (non-portable) mode.
/// Equivalent to what `paths::AppPaths::resolve()` would return for that mode;
/// we recompute it here so portable runs can sweep any orphan logs left in
/// the standard location by previous non-portable invocations.
fn legacy_local_app_data_log_dir() -> Option<PathBuf> {
    dirs_fallback_local().map(|p| p.join("com.sidearm.desktop").join("logs"))
}

/// Delete the pre-rebrand `com.nagaworkflowstudio.*` directories.  Returns
/// total bytes freed (best-effort metric; not reported on failure).
fn cleanup_pre_rebrand_orphans() -> u64 {
    const LEGACY_IDENTIFIERS: &[&str] = &[
        "com.nagaworkflowstudio.app",
        "com.nagaworkflowstudio.desktop",
    ];
    let mut total_bytes = 0u64;
    for base in [dirs_fallback_local(), dirs_fallback_roaming()]
        .into_iter()
        .flatten()
    {
        for id in LEGACY_IDENTIFIERS {
            let path = base.join(id);
            if path.is_dir() {
                total_bytes += dir_size_best_effort(&path);
                let _ = fs::remove_dir_all(&path);
            }
        }
    }
    total_bytes
}

fn dir_size_best_effort(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                total += dir_size_best_effort(&path);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// Check for a crash sentinel from the previous run and log it, then create
/// a new sentinel. The sentinel is deleted on clean shutdown. If it exists at
/// startup, the previous session crashed without a clean exit.
fn check_crash_sentinel(app: &AppHandle) {
    let log_dir = resolve_log_dir(app);
    let sentinel = log_dir.join(".running");

    if sentinel.exists() {
        // Previous run did not shut down cleanly
        log::error!("[system] Previous session ended abnormally (crash or force-kill).");

        // Try to read the sentinel for session start time
        if let Ok(contents) = fs::read_to_string(&sentinel) {
            log::error!("[system] Crashed session started at: {}", contents.trim());
        }

        // Recover OS-level keyboard state: a crashed session may have left a
        // modifier in "down" state from an unbalanced SendInput (panic="abort"
        // skips our panic hook; force-kill bypasses it entirely). Blast key-ups
        // for all modifier variants — KeyUp for a non-held VK is an OS no-op.
        log::info!("[system] mod-startup-release-all reason=crash-sentinel");
        input_synthesis::release_all_modifiers();
    }

    // Write new sentinel with current timestamp
    let _ = fs::create_dir_all(&log_dir);
    let timestamp = epoch_seconds_string();
    let _ = fs::write(&sentinel, timestamp);
}

/// Remove the crash sentinel on clean shutdown.
fn remove_crash_sentinel(app: &AppHandle) {
    let log_dir = resolve_log_dir(app);
    let sentinel = log_dir.join(".running");
    let _ = fs::remove_file(sentinel);
}

/// Unix epoch seconds as a string — used for the crash sentinel. Not a calendar
/// timestamp; for a civil YYYY-MM-DD date see `backup::today_date_string`.
fn epoch_seconds_string() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    let _app_mutex = mouse_restore::claim_app();
    // Safety net: release all modifier keys if we panic while holding keys.
    // NOTE: This only works with panic="unwind" (the default). If Cargo.toml
    // sets panic="abort" for release, this hook won't run in release builds.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("[system] PANIC: {info}");
        // Guard against double-panic: if release_all_modifiers itself panics
        // (e.g. SendInput fails), we must not abort the process.
        let _ = std::panic::catch_unwind(input_synthesis::release_all_modifiers);
        default_hook(info);
    }));

    // Resolve portable-vs-roaming paths once before any plugin initialisation.
    // This must happen before `tauri_plugin_log` so the log target can point at
    // our portable `./data/logs/` when a marker file is present.
    let app_paths = Arc::new(paths::AppPaths::resolve());
    let _ = std::fs::create_dir_all(&app_paths.log_dir);
    let log_target_path = app_paths.log_dir.clone();
    let app_paths_for_setup = app_paths.clone();

    // Hybrid retention: 7 days OR 50 files, whichever is stricter.
    // Runs before the plugin opens any file so the deletes can't race with the writer.
    const LOG_RETENTION_DAYS: u64 = 7;
    const LOG_RETENTION_MAX_FILES: usize = 50;
    let (deleted, kept) = log_cleanup::sweep(
        &log_target_path,
        LOG_RETENTION_DAYS,
        LOG_RETENTION_MAX_FILES,
    );

    // Orphan sweep: when running in portable mode, also sweep any logs left
    // behind by previous roaming-mode runs in %LOCALAPPDATA%\com.sidearm.desktop\logs.
    // Symmetric: a switch back to roaming-only would similarly orphan
    // ./data/logs, but in practice the portable folder gets deleted manually.
    let mut orphan_deleted = 0;
    if app_paths.mode == paths::PathMode::Portable
        && let Some(roaming_log_dir) = legacy_local_app_data_log_dir()
        && roaming_log_dir.is_dir()
        && roaming_log_dir != log_target_path
    {
        let (d, _) = log_cleanup::sweep(
            &roaming_log_dir,
            LOG_RETENTION_DAYS,
            LOG_RETENTION_MAX_FILES,
        );
        orphan_deleted = d;
    }

    // True portable: redirect WebView2 user-data folder into ./data/EBWebView
    // instead of the default %LOCALAPPDATA%\com.sidearm.desktop\EBWebView.
    // Without this, "portable" cookies/IndexedDB/service workers stay on the
    // host machine and survive removal of the portable folder.  The env var
    // is read by webview2-com when the WebView2 environment is created.
    if app_paths.mode == paths::PathMode::Portable {
        let webview_dir = app_paths.config_dir.join("EBWebView");
        let _ = std::fs::create_dir_all(&webview_dir);
        // TODO: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir) };
    }

    // Best-effort removal of pre-rebrand orphan directories
    // (com.nagaworkflowstudio.app / .desktop) from %APPDATA% and
    // %LOCALAPPDATA%.  Done unconditionally — by v0.1.14 the rebrand is two
    // years old and any user still on a Naga-era install would have already
    // run a Sidearm release that copied their config over.
    let legacy_freed = cleanup_pre_rebrand_orphans();

    // Push-based debug log: RuntimeStore::push_log sends each new entry on
    // `log_tx`; a worker thread re-emits it as a single `debug_log_appended`
    // tauri event. Replaces the old poll-storm pattern where every capture
    // event made the frontend re-fetch all 1000 entries.
    //
    // SAFETY CAP: an unbounded mpsc would grow without limit when the bridge
    // thread can't drain it as fast as push_log produces. v0.1.14 exhibited
    // this: WebView2 errors triggered by emit() got captured by tauri-plugin-
    // log and snowballed into a 230 GB disk meltdown. `log_send_pending`
    // tracks in-flight entries; push_log drops silently when over the cap.
    let (log_tx, log_rx) = std::sync::mpsc::channel::<DebugLogEntry>();
    let log_send_pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let log_send_pending_for_bridge = log_send_pending.clone();
    let runtime_store = {
        let mut store = RuntimeStore::default();
        store.set_log_sender(log_tx, log_send_pending);
        Arc::new(Mutex::new(store))
    };
    let log_rx_for_setup = Mutex::new(Some((log_rx, log_send_pending_for_bridge)));
    // The guard thread outlives setup; the builder still needs the original for
    // `manage`, so hand the setup closure its own handle.
    let runtime_store_for_guard = runtime_store.clone();

    tauri::Builder::default()
        // Single-instance guard MUST be the first plugin registered. A second
        // independent main instance (e.g. admin-autostart racing a manual
        // launch) would fight over the keyboard hook and clobber config, so we
        // surface the already-running window instead. The capture helper is
        // exempt: it returns at main.rs on `--capture-helper` before the Tauri
        // Builder ever runs, so it never acquires this lock.
        // relaunch_as_admin starts the elevated Sidearm with `--relaunched`,
        // which waits for the old process to end before it gets here.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                bring_to_front(&window);
            }
            // Surface the blocked duplicate launch: log lands in Diagnostics, the
            // event drives a toast in the existing window.
            log::warn!("Duplicate launch ignored — focused the existing window");
            let _ = app.emit(EVENT_SINGLE_INSTANCE_BLOCKED, ());
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(Target::new(TargetKind::Folder {
                    path: log_target_path,
                    file_name: None,
                }))
                .target(Target::new(TargetKind::Stdout))
                .target(Target::new(TargetKind::Webview))
                .max_file_size(2_000_000)
                .rotation_strategy(RotationStrategy::KeepAll)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .level(log::LevelFilter::Info)
                // Drop tauri_runtime_wry Error spam. WebView2 emits a generic
                // "group or resource not in correct state" error (HRESULT
                // 0x8007139F) whenever app.emit() is called while the webview
                // is mid-tear-down. In v0.1.14 this produced 53 MB/s of disk
                // writes and 16 GB of RAM growth via the push_log channel.
                // The errors carry no actionable info — silencing them
                // doesn't hide real bugs.
                .filter(|metadata| {
                    !(metadata.target() == "tauri_runtime_wry"
                        && metadata.level() == log::Level::Error)
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            // One-time migration from old "com.nagaworkflowstudio.desktop" config dir.
            migrate_old_config(app.handle());

            log::info!(
                "[log-retention] sweep: deleted {deleted}, kept {kept} \
                 (max {LOG_RETENTION_DAYS}d / {LOG_RETENTION_MAX_FILES} files)"
            );
            if orphan_deleted > 0 {
                log::info!("[log-retention] orphan sweep (roaming logs): deleted {orphan_deleted}");
            }
            if legacy_freed > 0 {
                log::info!(
                    "[system] Removed pre-rebrand orphans (com.nagaworkflowstudio.*): {} MB freed",
                    legacy_freed / 1_048_576
                );
            }

            // Drain the push-based debug-log channel into tauri events on
            // a dedicated thread. recv() blocks until a sender is available,
            // so this thread is idle when no logs are being appended.
            //
            // CRITICAL: skip emit() when no webview window is registered.
            // Without this guard, a closed/dying webview makes emit() return
            // an HRESULT(0x8007139F) error which tauri_runtime_wry then
            // log::error!()'s — captured by tauri-plugin-log → written to
            // disk → push_log fires another channel entry → snowball. This
            // exact loop caused v0.1.14's 230 GB disk meltdown (53 MB/s).
            if let Some((rx, pending)) = log_rx_for_setup.lock().recover_poison().take() {
                let app_handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("debug-log-bridge".into())
                    .spawn(move || {
                        while let Ok(entry) = rx.recv() {
                            pending.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                            if app_handle.webview_windows().is_empty() {
                                continue;
                            }
                            let _ = app_handle.emit(EVENT_DEBUG_LOG_APPENDED, &entry);
                        }
                    })
                    .ok();
            }

            // Watch the mouse's onboard state while the runtime is active: Razer's
            // engine takes the device over (driver mode + its own slots) whenever it
            // runs, and the mapping Sidearm wrote would silently stop mattering.
            #[cfg(target_os = "windows")]
            match resolve_config_dir(app.handle()) {
                Ok(config_dir) => {
                    // Restores the mice should this Sidearm be killed with its helper.
                    mouse_restore::spawn_watchdog(&config_dir);
                    // Before the guard and the capture runtime read it.
                    let key_signals = config_dir.join(mouse_memory::KEY_SIGNALS_FILE).exists();
                    mouse_memory::set_consumer_signals(!key_signals);
                    if key_signals {
                        log::info!("[onboard] `{}` present: key buttons send F13..F24", mouse_memory::KEY_SIGNALS_FILE);
                    }
                    if std::fs::remove_file(config_dir.join(mouse_offline::OFFLINE_FAILED_FILE)).is_ok() {
                        mouse_status::notice(None, mouse_status::StatusKind::OfflineNotStored);
                    }
                    onboard_guard::spawn(
                        app.handle().clone(),
                        runtime_store_for_guard.clone(),
                        config_dir,
                    );
                    system_events::spawn(app.handle().clone());
                }
                Err(error) => {
                    log::warn!("[onboard-guard] not started: {}", error.message);
                }
            }

            // Log whether the process is running with elevated (admin) privileges.
            // This is informational — helps diagnose UIPI issues where hotkey
            // registration or SendInput fails against elevated target windows.
            if window_capture::is_current_process_elevated() {
                log::info!("[system] Running as administrator (elevated).");
            } else {
                log::info!("[system] Running as standard user (non-elevated).");
            }

            // Force-disable native decorations on the main window.
            // tauri-plugin-window-state may restore a saved state that had
            // decorations enabled (from before we set decorations:false in config).
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_decorations(false);

                // Re-assert the minimum window size in the OS.  With
                // decorations:false the borderless window does not get the
                // standard frame's WM_GETMINMAXINFO clamp, and toggling
                // decorations above can drop the constraint registered from
                // tauri.conf.json — so live resizing could drag the window far
                // below the design width and break the layout.  Setting it
                // explicitly here makes the OS clamp interactive resizes.
                // Below this the sidebar collapses to an icon rail (see the
                // 860px media query in App.css), so the floor only needs to
                // keep the rail + content column legible, not the full layout.
                // Keep in sync with tauri.conf.json and the clamp below.
                let _ = main_window.set_min_size(Some(tauri::LogicalSize::new(480.0, 600.0)));

                // Clamp restored size against the config minimums.  The
                // window-state plugin restores raw saved dimensions and does
                // NOT re-validate against `minWidth/minHeight` from
                // tauri.conf.json, so a tiny saved state (e.g. from a crash
                // mid-resize, or from a frame-dropped close-during-drag) would
                // otherwise leave the user with an unusable title-bar-only
                // window on next start.  Keep these in sync with tauri.conf.json.
                const MIN_W: u32 = 480;
                const MIN_H: u32 = 600;
                if let Ok(size) = main_window.inner_size()
                    && (size.width < MIN_W || size.height < MIN_H)
                {
                    let new_w = size.width.max(MIN_W);
                    let new_h = size.height.max(MIN_H);
                    log::warn!(
                        "[window] restored main size {}x{} below minimum {}x{} — clamping to {}x{}",
                        size.width,
                        size.height,
                        MIN_W,
                        MIN_H,
                        new_w,
                        new_h,
                    );
                    let _ = main_window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: new_w,
                        height: new_h,
                    }));
                }
            }

            // OSD window is created lazily on first profile switch (see show_osd).
            // Pre-creating at startup caused foreground watcher interference and
            // startup flash when WebView2 wasn't ready yet.

            check_crash_sentinel(app.handle());
            log::info!("[system] Sidearm v{} started", app.package_info().version);

            let is_elevated = window_capture::is_current_process_elevated();
            // Initial menu has no profile rows yet — rebuild_tray_menu (called
            // right after build, below) loads config and populates them. Keeping
            // one menu-construction path (build_tray_menu) avoids drift.
            let tray_menu = build_tray_menu(app.handle(), &[], None, false, is_elevated)?;

            let mut tray_builder = TrayIconBuilder::with_id("sidearm-tray");
            match app.default_window_icon() {
                Some(icon) => tray_builder = tray_builder.icon(icon.clone()),
                None => log::warn!("[system] No default window icon available for tray"),
            }
            tray_builder
                .tooltip("Sidearm")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "toggle_runtime" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let runtime_store: tauri::State<'_, Arc<Mutex<RuntimeStore>>> =
                                app.state();
                            let runtime_controller: tauri::State<
                                '_,
                                Arc<Mutex<RuntimeController>>,
                            > = app.state();

                            let is_running = match runtime_store.lock() {
                                Ok(store) => store.is_running(),
                                Err(_) => {
                                    log::error!("[tray] runtime_store lock poisoned");
                                    return;
                                }
                            };

                            if is_running {
                                let stop_result = match runtime_controller.lock() {
                                    Ok(mut controller) => controller.stop(),
                                    Err(_) => {
                                        log::error!("[tray] runtime_controller lock poisoned");
                                        return;
                                    }
                                };
                                if stop_result.is_ok() {
                                    let summary = match runtime_store.lock() {
                                        Ok(mut store) => store.stop(),
                                        Err(_) => return,
                                    };
                                    let _ = app.emit(EVENT_RUNTIME_STOPPED, &summary);
                                    rebuild_tray_menu(&app);
                                }
                            } else {
                                let config_dir = resolve_app_paths(&app).config_dir.clone();
                                let load_result = tauri::async_runtime::spawn_blocking(move || {
                                    load_or_initialize_config(&config_dir)
                                })
                                .await;

                                let load_response = match load_result {
                                    Ok(Ok(response)) => response,
                                    _ => return,
                                };

                                let start_result = match runtime_controller.lock() {
                                    Ok(mut controller) => controller.start(
                                        app.clone(),
                                        runtime_store.inner().clone(),
                                        load_response.config.clone(),
                                        app.package_info().name.clone(),
                                    ),
                                    Err(_) => {
                                        log::error!("[tray] runtime_controller lock poisoned");
                                        return;
                                    }
                                };

                                if start_result.is_ok() {
                                    let summary = match runtime_store.lock() {
                                        Ok(mut store) => store.start(
                                            load_response.config.version,
                                            load_response.warnings.len(),
                                        ),
                                        Err(_) => return,
                                    };
                                    let _ = app.emit(EVENT_RUNTIME_STARTED, &summary);
                                    rebuild_tray_menu(&app);
                                }
                            }
                        });
                    }
                    other if other.starts_with("profile:") => {
                        // Exact single-strip: trim_start_matches would peel a
                        // leading "profile:" off a profile id that itself began
                        // with it. starts_with guarantees the prefix is present.
                        let profile_id =
                            other.strip_prefix("profile:").unwrap_or(other).to_string();
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            // The override is already honored everywhere the resolver
                            // runs (dispatch, foreground watcher, OSD) — see runtime.rs.
                            if let Ok(mut store) = app.state::<Arc<Mutex<RuntimeStore>>>().lock() {
                                store.set_manual_profile_override(Some(profile_id.clone()));
                            }
                            let _ = app.emit(EVENT_TRAY_PROFILE_CHANGED, &profile_id);
                            rebuild_tray_menu(&app);
                            log::info!("[tray] active profile set to `{profile_id}` from tray");
                        });
                    }
                    "create_rule" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            // Instant foreground-window capture (no countdown), then
                            // hand the result to the UI to open a prefilled rule dialog.
                            let config_dir = match resolve_config_dir(&app) {
                                Ok(dir) => dir,
                                Err(_) => return,
                            };
                            let app_name = app.package_info().name.clone();
                            let live = tauri::async_runtime::spawn_blocking(move || {
                                let load = load_or_initialize_config(&config_dir).ok()?;
                                window_capture::capture_active_window_with_resolution(
                                    &load.config,
                                    &app_name,
                                    None,
                                )
                                .ok()
                            })
                            .await
                            .ok()
                            .flatten();

                            // At tray-click time the live foreground IS Sidearm's own
                            // window (self-ignored), so prefer a non-ignored live
                            // capture but fall back to the last real foreground window
                            // recorded by the watcher / tray-icon snapshot.
                            let result = match live {
                                Some(r) if !r.ignored => Some(r),
                                _ => app
                                    .state::<Arc<Mutex<RuntimeStore>>>()
                                    .lock()
                                    .ok()
                                    .and_then(|store| store.last_foreground_window().cloned()),
                            };

                            let Some(result) = result else {
                                log::info!("[tray] quick-rule: no usable foreground window");
                                let _ = app.emit(EVENT_QUICK_RULE_FAILED, ());
                                return;
                            };
                            // Surface the studio window so the dialog is visible.
                            if let Some(window) = app.get_webview_window("main") {
                                bring_to_front(&window);
                            }
                            let _ = app.emit(EVENT_QUICK_RULE_START, &result);
                            log::info!("[tray] quick-rule capture for `{}`", result.exe);
                        });
                    }
                    "quit" => app.exit(0),
                    "relaunch_as_admin" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = relaunch_as_admin(app).await {
                                log::warn!("[tray] relaunch_as_admin failed: {}", e.message);
                            }
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    let TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } = event
                    else {
                        return;
                    };

                    // Snapshot the real foreground window the instant the tray is
                    // clicked — before the right-click context menu steals focus —
                    // so "create rule for active window" sees the user's app, not
                    // Sidearm's own window. Best-effort: complements the watcher,
                    // and works even while interception is paused.
                    if matches!(button_state, MouseButtonState::Down) {
                        let app = tray.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            let config_dir = match resolve_config_dir(&app) {
                                Ok(dir) => dir,
                                Err(_) => return,
                            };
                            let app_name = app.package_info().name.clone();
                            let captured = tauri::async_runtime::spawn_blocking(move || {
                                let load = load_or_initialize_config(&config_dir).ok()?;
                                window_capture::capture_active_window_with_resolution(
                                    &load.config,
                                    &app_name,
                                    None,
                                )
                                .ok()
                            })
                            .await
                            .ok()
                            .flatten();
                            if let Some(result) = captured
                                && !result.ignored
                                && let Ok(mut store) =
                                    app.state::<Arc<Mutex<RuntimeStore>>>().lock()
                            {
                                store.set_last_foreground_window(result);
                            }
                        });
                    }

                    // Left-click toggles the window (shared with the global shortcut).
                    if matches!(button, MouseButton::Left)
                        && matches!(button_state, MouseButtonState::Up)
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Populate the tray menu with the real profile list now that the
            // tray exists and config can be loaded.
            rebuild_tray_menu(app.handle());

            // Register the OS-global show/hide shortcut via the shared helper so
            // a runtime change (save_config) re-registers exactly the same way.
            apply_global_shortcut(app.handle(), &configured_global_shortcut(app.handle()));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let minimize = window
                    .app_handle()
                    .state::<MinimizeToTray>()
                    .load(Ordering::Relaxed);

                if minimize {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .manage(app_paths_for_setup)
        .manage(Arc::new(AtomicBool::new(false)) as MinimizeToTray)
        .manage(Arc::new(Mutex::new(None)) as ConfigStamp)
        .manage(Arc::new(Mutex::new(None)) as CurrentGlobalShortcut)
        .manage(runtime_store.clone())
        .manage(Arc::new(Mutex::new(RuntimeController::default())))
        .manage(Arc::new(Mutex::new(MacroRecorder::new())))
        .invoke_handler(tauri::generate_handler![
            export_verification_session,
            load_config,
            save_config,
            get_app_paths,
            list_backups,
            restore_config_from_backup,
            export_full_config,
            import_full_config_preview,
            import_full_config_apply,
            open_config_folder,
            accept_portable_migration,
            parse_synapse_source,
            import_synapse_into_config,
            set_input_capture_mode,
            live_map_ready,
            start_runtime,
            stop_runtime,
            reload_runtime,
            set_native_texts,
            rehook_capture,
            get_debug_log,
            get_log_directory,
            open_log_directory,
            is_running_as_admin,
            relaunch_as_admin,
            get_admin_autostart_status,
            set_admin_autostart,
            capture_active_window,
            list_running_processes,
            list_bundled_presets,
            read_bundled_preset,
            preview_resolution,
            execute_preview_action,
            run_preview_action,
            live_test_action,
            get_exe_icon,
            export_profile,
            import_profile,
            export_snippets,
            import_device_image,
            read_device_image,
            delete_device_image,
            start_macro_recording,
            record_keystroke,
            stop_macro_recording,
            apply_onboard_mapping,
            verify_onboard_mapping,
            restore_onboard_control,
            get_synapse_status,
            recover_from_synapse,
            restore_synapse_startup,
            get_native_model,
            list_native_mice,
            get_onboard_banks,
            get_device_report,
            open_device_report_issue,
            get_mouse_status,
            set_key_signals,
            open_startup_apps_settings,
            get_mouse_settings,
            set_mouse_dpi,
            set_mouse_poll_rate
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                log::info!("[system] Clean shutdown.");
                shutdown_mouse(app);
                remove_crash_sentinel(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_home() -> TempDir {
        TempDir::new().expect("create temp home dir")
    }

    /// Merge-import must not orphan the base config's user devices: since v3
    /// devices/physicalControls/encoderMappings merge by id instead of being
    /// taken wholesale from the incoming file (which may predate the device).
    #[test]
    fn merge_configs_preserves_base_user_device() {
        let incoming = config::default_seed_config();
        let mut base = config::default_seed_config();
        base.devices.push(config::Device {
            id: "my-macropad".into(),
            name: "My Macropad".into(),
            builtin: false,
            image: None,
            hotspots: Vec::new(),
        });
        base.physical_controls.push(config::PhysicalControl {
            id: config::ControlId::new("my-macropad-b1"),
            device_id: "my-macropad".into(),
            family: config::ControlFamily::ThumbGrid,
            default_name: "Pad 1".into(),
            synapse_name: None,
            remappable: true,
            capability_status: config::CapabilityStatus::Verified,
            notes: None,
        });
        base.encoder_mappings.push(config::EncoderMapping {
            control_id: config::ControlId::new("my-macropad-b1"),
            layer: config::Layer::Standard,
            encoded_key: "Ctrl+Shift+F19".into(),
            source: config::MappingSource::Detected,
            verified: true,
        });

        let merged = merge_configs_by_id(base, incoming);
        assert!(
            merged.devices.iter().any(|d| d.id == "my-macropad"),
            "user device must survive a merge with a device-less import"
        );
        assert!(
            merged
                .physical_controls
                .iter()
                .any(|c| c.id.as_str() == "my-macropad-b1"),
            "user device's control must survive the merge"
        );
        assert!(
            merged
                .encoder_mappings
                .iter()
                .any(|m| m.control_id.as_str() == "my-macropad-b1"),
            "user device's mapping must survive the merge"
        );
    }

    #[test]
    fn plan_global_shortcut_noop_when_unchanged() {
        // A save that does not change the shortcut must NOT re-register — that
        // would needlessly tear down and re-add the OS hotkey on every unrelated
        // config save (profile switch, binding edit), briefly dropping it.
        let action = plan_global_shortcut(Some("ctrl+alt+n"), "ctrl+alt+n");
        assert_eq!(action, ShortcutAction::NoChange);
    }

    #[test]
    fn plan_global_shortcut_swaps_and_unregisters_previous_on_change() {
        // Changing the shortcut registers the new combo and reports the old one
        // for removal, so the previous hotkey does not stay live as a duplicate.
        let action = plan_global_shortcut(Some("ctrl+alt+n"), "ctrl+shift+f9");
        assert_eq!(
            action,
            ShortcutAction::Register {
                desired: "ctrl+shift+f9".to_string(),
                unregister_previous: Some("ctrl+alt+n".to_string()),
            }
        );
    }

    #[test]
    fn plan_global_shortcut_registers_without_previous_at_startup() {
        // At startup nothing is registered yet, so there is no previous to remove.
        let action = plan_global_shortcut(None, "ctrl+alt+n");
        assert_eq!(
            action,
            ShortcutAction::Register {
                desired: "ctrl+alt+n".to_string(),
                unregister_previous: None,
            }
        );
    }

    #[test]
    fn check_import_size_boundary() {
        // Boundary check for the shared import-size guard, against real files on
        // disk. A sparse file (set_len) gives the desired length without writing
        // the bytes. At the limit is accepted; one byte over is rejected with the
        // supplied error code (the FE maps on the code).
        let dir = temp_home();
        let cap = 1024u64;

        let at_limit = dir.path().join("at_limit.bin");
        let file = fs::File::create(&at_limit).expect("create file");
        file.set_len(cap).expect("set len");
        drop(file);
        assert!(check_import_size(&at_limit, cap, "import_too_large").is_ok());

        let over = dir.path().join("over.bin");
        let file = fs::File::create(&over).expect("create file");
        file.set_len(cap + 1).expect("set len");
        drop(file);
        let err = check_import_size(&over, cap, "import_too_large")
            .expect_err("oversized file must be rejected");
        assert_eq!(err.code, "import_too_large");
    }

    #[test]
    fn ensure_full_config_import_size_rejects_oversized_file() {
        // Audit F025: parse_synapse_source now bounds the input via this guard,
        // matching the JSON import commands. A too-large file on disk must be
        // rejected before it is read into memory. A sparse file (set_len) gives
        // the desired length without writing 16 MiB.
        let dir = temp_home();
        let big = dir.path().join("hostile.synapse4");
        let file = fs::File::create(&big).expect("create file");
        file.set_len(MAX_FULL_CONFIG_IMPORT_BYTES + 1)
            .expect("set len");
        drop(file);

        let err =
            ensure_full_config_import_size(&big).expect_err("oversized file must be rejected");
        assert_eq!(err.code, "import_too_large");

        // A file at the limit is accepted.
        let small = dir.path().join("ok.synapse4");
        let file = fs::File::create(&small).expect("create file");
        file.set_len(MAX_FULL_CONFIG_IMPORT_BYTES).expect("set len");
        drop(file);
        assert!(ensure_full_config_import_size(&small).is_ok());
    }

    #[test]
    fn validate_path_accepts_any_absolute_location() {
        // The OS dialog is the trust boundary, so an absolute path anywhere (e.g.
        // a backup folder on another drive) is accepted — not just under home.
        let dir = temp_home();
        let target = dir.path().join("export.json");
        assert!(validate_user_file_path(&target.to_string_lossy()).is_ok());
    }

    #[test]
    fn validate_path_rejects_relative() {
        assert!(validate_user_file_path("relative/file.json").is_err());
    }

    #[test]
    fn validate_path_rejects_parent_dir_segments() {
        // `..` segments are rejected as a cheap guard against obfuscated targets.
        let dir = temp_home();
        let escape = dir.path().join("..").join("escaped.json");
        assert!(validate_user_file_path(&escape.to_string_lossy()).is_err());
    }

    #[test]
    fn json_path_requires_json_extension() {
        let dir = temp_home();
        let json = dir.path().join("a.json");
        let json_upper = dir.path().join("a.JSON");
        let txt = dir.path().join("a.txt");
        let noext = dir.path().join("noext");
        assert!(validate_user_json_path(&json.to_string_lossy()).is_ok());
        assert!(
            validate_user_json_path(&json_upper.to_string_lossy()).is_ok(),
            "extension check must be case-insensitive"
        );
        assert!(validate_user_json_path(&txt.to_string_lossy()).is_err());
        assert!(validate_user_json_path(&noext.to_string_lossy()).is_err());
    }
}
