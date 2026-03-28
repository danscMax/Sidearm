mod capture_backend;
mod chord;
mod clipboard;
mod command_error;
mod config;
#[cfg(target_os = "windows")]
mod exe_icon;
mod executor;
mod hotkeys;
mod input_synthesis;
mod platform;
mod recorder;
mod resolver;
mod runtime;
mod window_capture;

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

/// Managed state: cached `minimize_to_tray` setting for the close handler.
/// Updated by `load_config` and `save_config`; read by `CloseRequested`.
/// Initial value `false` (window closes) until config is loaded.
type MinimizeToTray = Arc<AtomicBool>;

pub use capture_backend::capture_helper_main;
use capture_backend::RuntimeController;
use command_error::CommandError;
use recorder::MacroRecorder;
use config::{
    load_or_initialize_config, save_config as save_config_to_store, AppConfig, ConfigStoreError,
    LoadConfigResponse, SaveConfigResponse,
};
use executor::{ActionExecutionEvent, RuntimeErrorEvent};
use resolver::ResolvedInputPreview;
use runtime::{
    DebugLogEntry, RuntimeStateSummary, RuntimeStore, EVENT_ACTION_EXECUTED, EVENT_CONFIG_RELOADED,
    EVENT_CONTROL_RESOLVED, EVENT_PROFILE_RESOLVED, EVENT_RUNTIME_ERROR, EVENT_RUNTIME_STARTED,
    EVENT_RUNTIME_STOPPED,
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_log::{Target, TargetKind, RotationStrategy, TimezoneStrategy};
use window_capture::WindowCaptureResult;

/// Generation counter for OSD hide timer cancellation.
/// Each show_osd call increments this; the hide thread only hides if the
/// generation hasn't changed, preventing premature hide on rapid switches.
static OSD_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Check whether the current foreground window is fullscreen on its monitor.
fn is_foreground_fullscreen() -> bool {
    #[cfg(target_os = "windows")]
    return crate::platform::window::is_foreground_fullscreen();
    #[cfg(not(target_os = "windows"))]
    return false;
}

/// Show the OSD notification bubble with the profile name.
///
/// OSD window lifecycle (lazy creation):
/// 1. First call: create the window and return without showing (let WebView load JS).
/// 2. Subsequent calls: window exists, emit event + position + show + auto-hide.
///
/// This avoids startup flash, event loss, and foreground watcher interference.
pub(crate) fn show_osd(app: &AppHandle, profile_name: &str, settings: &config::Settings) {
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
        { crate::platform::display::get_dpi_scale() }
        #[cfg(not(target_os = "windows"))]
        { 1.0_f64 }
    };

    let font_px = match settings.osd_font_size {
        config::OsdFontSize::Small => 11_i32,
        config::OsdFontSize::Medium => 12,
        config::OsdFontSize::Large => 14,
    };
    // Measure label (weight 500) and name (weight 700) separately
    let label_width = measure_text_width("Профиль:", "Segoe UI", font_px, 500);
    let name_width = measure_text_width(profile_name, "Segoe UI", font_px, 700);
    let logical_padding = 16 + 8 + 16 + 4; // left-pad + gap + right-pad + rounding safety
    let logical_width = label_width + name_width + logical_padding;

    // Convert to physical pixels for Tauri
    let win_width = (logical_width as f64 * dpi_scale).ceil() as i32;
    let height = (32.0 * dpi_scale).ceil() as i32;
    let margin = (6.0 * dpi_scale).ceil() as i32;

    log::debug!(
        "[osd] label_w={label_width} name_w={name_width} pad={logical_padding} \
         logical={logical_width} dpi={dpi_scale} physical_w={win_width} h={height}"
    );

    // --- Size → read actual outer size → Position → Show ---
    let _ = w.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: win_width as u32,
        height: height as u32,
    }));

    // Read back actual outer size (includes any window frame/border added
    // by the OS or WebView2).  This is what we need for positioning.
    let outer = w
        .outer_size()
        .unwrap_or(tauri::PhysicalSize {
            width: win_width as u32,
            height: height as u32,
        });
    let ow = outer.width as i32;
    let oh = outer.height as i32;

    #[cfg(target_os = "windows")]
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
            "fontSize": font_size_str,
            "animation": animation_str,
        }),
    );

    // Auto-hide
    let gen = OSD_GENERATION.fetch_add(1, Ordering::Release) + 1;
    let duration_ms = settings.osd_duration_ms.max(500).min(10000) as u64;
    let win = w.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(duration_ms));
        if OSD_GENERATION.load(Ordering::Acquire) == gen {
            let _ = win.hide();
        }
    });
}

fn measure_text_width(text: &str, font_family: &str, font_size_px: i32, font_weight: i32) -> i32 {
    #[cfg(target_os = "windows")]
    return crate::platform::display::measure_text_width(text, font_family, font_size_px, font_weight);
    #[cfg(not(target_os = "windows"))]
    { let _ = (text, font_family, font_weight); return font_size_px * 8; }
}

/// Create the hidden OSD window (called lazily on first show_osd).
/// Positioned off-screen and explicitly hidden to prevent any flash.
fn create_osd_window(app: &AppHandle) {
    use tauri::WebviewWindowBuilder;
    use tauri::WebviewUrl;

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

fn resolve_config_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path().app_config_dir().map_err(|error| {
        CommandError::from(ConfigStoreError::ConfigDirectoryUnavailable(format!(
            "Failed to resolve app config directory: {error}"
        )))
    })
}

/// Validate that a user-supplied file path is within an allowed directory.
/// Paths must be under the user's home directory and must not contain `..` segments.
fn validate_user_file_path(path: &str) -> Result<PathBuf, CommandError> {
    let path = PathBuf::from(path);

    // Reject relative paths
    if !path.is_absolute() {
        return Err(CommandError::new(
            "invalid_path",
            "File path must be absolute.",
            None,
        ));
    }

    // Must be under the user's home directory (canonicalized for consistent comparison)
    let home = dirs_next_home().ok_or_else(|| {
        CommandError::new(
            "invalid_path",
            "Could not determine user home directory.",
            None,
        )
    })?;
    let home = std::fs::canonicalize(&home).map_err(|e| {
        CommandError::new(
            "invalid_path",
            format!("Home directory canonicalization failed: {e}"),
            None,
        )
    })?;

    // For existing paths (reads): canonicalize the path itself.
    // For new files (writes): walk up to the nearest existing ancestor, canonicalize
    // it, then append the non-existent tail.  This handles writes where intermediate
    // directories don't exist yet (create_dir_all runs after validation).
    let canonical = if path.exists() {
        std::fs::canonicalize(&path).map_err(|e| {
            CommandError::new(
                "invalid_path",
                format!("Path canonicalization failed: {e}"),
                None,
            )
        })?
    } else {
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        let mut cursor = path.as_path();
        loop {
            tail.push(cursor.file_name().ok_or_else(|| {
                CommandError::new("invalid_path", "Path has no filename component.", None)
            })?.to_owned());
            cursor = cursor.parent().ok_or_else(|| {
                CommandError::new("invalid_path", "No existing ancestor directory found.", None)
            })?;
            if cursor.exists() {
                break;
            }
        }
        let mut canonical = std::fs::canonicalize(cursor).map_err(|e| {
            CommandError::new(
                "invalid_path",
                format!("Ancestor canonicalization failed: {e}"),
                None,
            )
        })?;
        for part in tail.into_iter().rev() {
            canonical.push(part);
        }
        canonical
    };

    if !canonical.starts_with(&home) {
        return Err(CommandError::new(
            "invalid_path",
            "File path must be within the user home directory.",
            None,
        ));
    }

    Ok(canonical)
}

/// Resolve the user's home directory via the HOME / USERPROFILE env var.
fn dirs_next_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Write text to a user-chosen file path (for profile export).
/// Path must be absolute and within the user's home directory.
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), CommandError> {
    let validated_path = validate_user_file_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = validated_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                CommandError::internal(format!("Failed to create directory: {e}"))
            })?;
        }
        fs::write(&validated_path, contents).map_err(|e| {
            CommandError::internal(format!("Failed to write file: {e}"))
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("write_text_file task failed: {e}")))?
}

/// Read text from a user-chosen file path (for profile import).
/// Path must be absolute and within the user's home directory.
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, CommandError> {
    let validated_path = validate_user_file_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::read_to_string(&validated_path).map_err(|e| {
            CommandError::internal(format!("Failed to read file: {e}"))
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("read_text_file task failed: {e}")))?
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

    // Construct the export path under app_data_dir/exports/
    let data_dir = app.path().app_data_dir().map_err(|error| {
        CommandError::internal(format!("Failed to resolve app data directory: {error}"))
    })?;
    let export_dir = data_dir.join("exports");
    let export_path = export_dir.join(&filename);

    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&export_dir).map_err(|error| {
            CommandError::internal(format!(
                "Failed to create export directory `{}`: {error}",
                export_dir.display()
            ))
        })?;

        fs::write(&export_path, contents).map_err(|error| {
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

#[tauri::command]
async fn load_config(app: AppHandle) -> Result<LoadConfigResponse, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let response =
        tauri::async_runtime::spawn_blocking(move || load_or_initialize_config(&config_dir))
            .await
            .map_err(|error| CommandError::internal(format!("load_config task failed: {error}")))?
            .map_err(CommandError::from)?;

    // Sync the cached minimize_to_tray flag for the close handler
    app.state::<MinimizeToTray>()
        .store(response.config.settings.minimize_to_tray, Ordering::Relaxed);

    Ok(response)
}

/// Save the config to disk and, if the runtime is active, restart the capture
/// backend so it picks up the new config.
///
/// CONCURRENCY NOTE: The `runtime_controller` lock serializes concurrent
/// `save_config` calls through the restart path. The `runtime_store` lock is
/// re-acquired immediately after restart to update the version. No async yield
/// points exist between `controller.restart()` and `store.reload()`.
#[tauri::command]
async fn save_config(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    runtime_controller: State<'_, Arc<Mutex<RuntimeController>>>,
    config: AppConfig,
) -> Result<SaveConfigResponse, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let result =
        tauri::async_runtime::spawn_blocking(move || save_config_to_store(&config_dir, config))
            .await
            .map_err(|error| CommandError::internal(format!("save_config task failed: {error}")))?
            .map_err(CommandError::from)?;

    // Sync the cached minimize_to_tray flag for the close handler
    app.state::<MinimizeToTray>()
        .store(result.config.settings.minimize_to_tray, Ordering::Relaxed);

    let is_running = {
        let store = runtime_store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        store.is_running()
    };

    let maybe_runtime_summary = if is_running {
        let restart_result = {
            let mut controller = runtime_controller
                .lock()
                .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;

            // TOCTOU guard: re-check runtime status after acquiring the controller lock.
            // The runtime may have been stopped between the initial check and lock acquisition.
            let still_running = runtime_store
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_running();
            if !still_running {
                None
            } else {
                Some(controller.restart(
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
                    let mut store = runtime_store
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    store.stop()
                };
                let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
                return Err(CommandError::new("runtime_reload_failed", message, None));
            }
            Some(Ok(())) => {
                let mut store = runtime_store
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
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

    Ok(result)
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
        let store = runtime_store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        let mut store = runtime_store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        store.start(load_response.config.version, load_response.warnings.len())
    };

    app.emit(EVENT_RUNTIME_STARTED, &summary).map_err(|error| {
        CommandError::internal(format!("Failed to emit runtime_started event: {error}"))
    })?;

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
        let mut store = runtime_store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        store.stop()
    };

    app.emit(EVENT_RUNTIME_STOPPED, &summary).map_err(|error| {
        CommandError::internal(format!("Failed to emit runtime_stopped event: {error}"))
    })?;

    Ok(summary)
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
            let mut store = runtime_store
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            store.stop()
        };
        let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
        return Err(CommandError::new("runtime_reload_failed", message, None));
    }

    let summary = {
        let mut store = runtime_store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        store.reload(load_response.config.version, load_response.warnings.len())
    };

    app.emit(EVENT_CONFIG_RELOADED, &summary).map_err(|error| {
        CommandError::internal(format!("Failed to emit config_reloaded event: {error}"))
    })?;

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
    let store = runtime_store
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    Ok(store.logs())
}

#[tauri::command]
async fn get_log_directory(app: AppHandle) -> Result<String, CommandError> {
    let log_dir = app.path().app_log_dir().map_err(|error| {
        CommandError::internal(format!("Failed to resolve log directory: {error}"))
    })?;
    Ok(log_dir.to_string_lossy().into_owned())
}

#[tauri::command]
async fn open_log_directory(app: AppHandle) -> Result<(), CommandError> {
    let log_dir = app.path().app_log_dir().map_err(|error| {
        CommandError::internal(format!("Failed to resolve log directory: {error}"))
    })?;
    if log_dir.exists() {
        #[cfg(target_os = "windows")]
        crate::platform::shell::open_in_explorer(&log_dir)
            .map_err(CommandError::internal)?;
        #[cfg(not(target_os = "windows"))]
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
        let mut store = runtime_store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
            let mut store = runtime_store
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if result.ignored {
                store.record_warn(
                    "захват окна",
                    result
                        .ignore_reason
                        .clone()
                        .unwrap_or_else(|| "Окно игнорируется.".into()),
                );
            } else {
                store.record_info(
                    "захват окна",
                    format!(
                        "Захвачено `{}`, профиль `{}`.",
                        result.exe,
                        result.resolved_profile_id.as_deref().unwrap_or("н/д")
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
                let mut store = runtime_store
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                store.notify_profile_change(result.resolved_profile_id.as_deref())
            };
            if should_notify {
                let profile_name = result.resolved_profile_name.as_deref().unwrap_or("Default");
                show_osd(&app, profile_name, &settings);
            }
        }

        Ok(result)
    }
    .await;

    // Always reset capture_in_progress regardless of success/failure
    {
        if let Ok(mut store) = runtime_store.lock() {
            store.set_capture_in_progress(false);
            log::info!("[system] capture_in_progress = false (auto-switching resumed)");
        }
    }

    let result = capture_result?;

    // Return focus to the studio window after capture
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    Ok(result)
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
        ))
    })
    .await
    .map_err(|error| CommandError::internal(format!("preview_resolution task failed: {error}")))?
    .map_err(CommandError::from)?;

    {
        let mut store = runtime_store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match preview.status {
            resolver::ResolutionStatus::Resolved => store.record_info(
                "разрешение",
                format!(
                    "Разрешено `{}` в кнопку `{}` для профиля `{}`.",
                    preview.encoded_key,
                    preview.control_id.as_deref().unwrap_or("н/д"),
                    preview.resolved_profile_id.as_deref().unwrap_or("н/д")
                ),
            ),
            resolver::ResolutionStatus::Unresolved => store.record_warn(
                "разрешение",
                format!(
                    "Не разрешено `{}`: {}",
                    preview.encoded_key, preview.reason
                ),
            ),
            resolver::ResolutionStatus::Ambiguous => store.record_warn(
                "разрешение",
                format!(
                    "Неоднозначный результат `{}`: {}",
                    preview.encoded_key, preview.reason
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
        let preview =
            resolver::resolve_input_preview(&load_response.config, &normalized_key, &exe, &title);
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
                let mut store = runtime_store
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                match mode {
                    ActionRunMode::DryRun => {
                        let message = format!(
                            "Пробное выполнение `{}` для `{}`.",
                            event.action_pretty, event.encoded_key
                        );
                        match event.outcome {
                            executor::ExecutionOutcome::Noop => {
                                store.record_warn("выполнение", message);
                            }
                            _ => {
                                store.record_info("выполнение", message);
                            }
                        }
                        for warning in &event.warnings {
                            store.record_warn("выполнение", warning.clone());
                        }
                    }
                    ActionRunMode::Live => {
                        store.record_info(
                            "выполнение",
                            format!(
                                "Выполнено вживую `{}` для `{}`.",
                                event.action_pretty, event.encoded_key
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
            Err(CommandError::new(
                error.code,
                error.event.message.clone(),
                Some(
                    [
                        error.event.encoded_key.clone(),
                        error.event.action_id.clone(),
                    ]
                    .into_iter()
                    .flatten()
                    .collect(),
                ),
            ))
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

fn emit_runtime_error(
    app: &AppHandle,
    runtime_store: &State<'_, Arc<Mutex<RuntimeStore>>>,
    event: &RuntimeErrorEvent,
) -> Result<(), CommandError> {
    {
        let mut store = runtime_store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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

#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_exe_icon(
    exe_name: String,
    process_path: Option<String>,
) -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Try the known process path first (most reliable — captured from OS)
        if let Some(ref path) = process_path {
            if std::path::Path::new(path).exists() {
                if let Some(b64) = exe_icon::extract_icon_base64(path) {
                    return Ok(Some(b64));
                }
            }
        }
        // 2. Fall back to API-based search (App Paths registry + SearchPathW)
        let candidates = exe_icon_search_paths(&exe_name);
        for path in &candidates {
            if let Some(b64) = exe_icon::extract_icon_base64(path) {
                return Ok(Some(b64));
            }
        }
        // 3. Try to find path from a running process with this exe name
        if let Some(path) = find_running_process_path(&exe_name) {
            if let Some(b64) = exe_icon::extract_icon_base64(&path) {
                return Ok(Some(b64));
            }
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
    if let Some(path) = crate::platform::shell::search_path_win32(exe_name) {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

fn find_running_process_path(exe_name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    return crate::platform::shell::find_running_process_path(exe_name);
    #[cfg(not(target_os = "windows"))]
    { let _ = exe_name; return None; }
}

/// Migrate config from the old "com.nagaworkflowstudio.desktop" directory
/// to the new "com.sidearm.desktop" directory (one-time).
/// Overwrites the new config if the old one is larger (has real user data
/// vs a freshly-generated default).
fn migrate_old_config(app: &AppHandle) {
    let Ok(new_config_dir) = app.path().app_config_dir() else { return };
    let Some(roaming) = dirs_fallback_roaming() else { return };

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

    let _ = fs::create_dir_all(&new_config_dir);
    // Copy all json files (config + backups + window-state)
    if let Ok(entries) = fs::read_dir(&old_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let dest = new_config_dir.join(entry.file_name());
                let _ = fs::copy(&path, &dest);
            }
        }
    }
    log::info!("[system] Migrated config from old directory: {}", old_dir.display());
}

/// Get %APPDATA% without depending on the Tauri path resolver (which uses the new identifier).
fn dirs_fallback_roaming() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(PathBuf::from)
}

/// Check for a crash sentinel from the previous run and log it, then create
/// a new sentinel. The sentinel is deleted on clean shutdown. If it exists at
/// startup, the previous session crashed without a clean exit.
fn check_crash_sentinel(app: &AppHandle) {
    let Ok(log_dir) = app.path().app_log_dir() else { return };
    let sentinel = log_dir.join(".running");

    if sentinel.exists() {
        // Previous run did not shut down cleanly
        log::error!("[system] Previous session ended abnormally (crash or force-kill).");

        // Try to read the sentinel for session start time
        if let Ok(contents) = fs::read_to_string(&sentinel) {
            log::error!("[system] Crashed session started at: {}", contents.trim());
        }
    }

    // Write new sentinel with current timestamp
    let _ = fs::create_dir_all(&log_dir);
    let timestamp = chrono_like_timestamp();
    let _ = fs::write(&sentinel, timestamp);
}

/// Remove the crash sentinel on clean shutdown.
fn remove_crash_sentinel(app: &AppHandle) {
    let Ok(log_dir) = app.path().app_log_dir() else { return };
    let sentinel = log_dir.join(".running");
    let _ = fs::remove_file(sentinel);
}

/// Simple timestamp without external crates.
fn chrono_like_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Return Unix timestamp — good enough for crash diagnostics
    format!("{now}")
}

/// Delete log files older than 30 days from the log directory.
fn cleanup_old_logs(app: &AppHandle) {
    let Ok(log_dir) = app.path().app_log_dir() else {
        return;
    };
    if !log_dir.exists() {
        return;
    }

    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(30 * 24 * 60 * 60);

    let Ok(entries) = fs::read_dir(&log_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "log")
            || path.to_string_lossy().contains(".log.")
        {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if modified < cutoff {
                        let _ = fs::remove_file(&path);
                        log::info!("[system] Deleted old log: {}", path.display());
                    }
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(Target::new(TargetKind::LogDir { file_name: None }))
                .target(Target::new(TargetKind::Stdout))
                .target(Target::new(TargetKind::Webview))
                .max_file_size(10_000_000)
                .rotation_strategy(RotationStrategy::KeepAll)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // One-time migration from old "com.nagaworkflowstudio.desktop" config dir.
            migrate_old_config(&app.handle());

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
            }

            // OSD window is created lazily on first profile switch (see show_osd).
            // Pre-creating at startup caused foreground watcher interference and
            // startup flash when WebView2 wasn't ready yet.

            check_crash_sentinel(&app.handle());
            cleanup_old_logs(&app.handle());
            log::info!(
                "[system] Sidearm v{} started",
                app.package_info().version
            );

            let toggle_item = MenuItem::with_id(app, "toggle_runtime", "Включить перехват", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &toggle_item,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?,
                ],
            )?;

            // Store the toggle menu item handle so we can update its text
            let toggle_item_handle = toggle_item.clone();

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "toggle_runtime" => {
                        let app = app.clone();
                        let toggle_item = toggle_item_handle.clone();
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
                                    let _ = toggle_item.set_text("Включить перехват");
                                }
                            } else {
                                let config_dir = match app.path().app_config_dir() {
                                    Ok(dir) => dir,
                                    Err(_) => return,
                                };
                                let load_result =
                                    tauri::async_runtime::spawn_blocking(move || {
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
                                    let _ = toggle_item.set_text("Выключить перехват");
                                }
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            let shortcut: Shortcut = "ctrl+alt+n".parse()
                .expect("Failed to parse global shortcut Ctrl+Alt+N");

            // Non-fatal: if the shortcut is already registered (e.g. previous
            // instance didn't clean up yet), log a warning and continue.
            if let Err(e) = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            }) {
                log::warn!("[system] Could not register Ctrl+Alt+N shortcut: {e}");
            }

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
        .manage(Arc::new(AtomicBool::new(false)) as MinimizeToTray)
        .manage(Arc::new(Mutex::new(RuntimeStore::default())))
        .manage(Arc::new(Mutex::new(RuntimeController::default())))
        .manage(Arc::new(Mutex::new(MacroRecorder::new())))
        .invoke_handler(tauri::generate_handler![
            export_verification_session,
            load_config,
            save_config,
            start_runtime,
            stop_runtime,
            reload_runtime,
            rehook_capture,
            get_debug_log,
            get_log_directory,
            open_log_directory,
            capture_active_window,
            preview_resolution,
            execute_preview_action,
            run_preview_action,
            get_exe_icon,
            write_text_file,
            read_text_file,
            start_macro_recording,
            record_keystroke,
            stop_macro_recording
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                log::info!("[system] Clean shutdown.");
                remove_crash_sentinel(app);
            }
        });
}
