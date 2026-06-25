mod admin_autostart;
mod backup;
mod capture_backend;
mod chord;
mod command_error;
mod config;
#[cfg(target_os = "windows")]
mod exe_icon;
mod executor;
mod hotkeys;
mod input_synthesis;
mod log_cleanup;
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
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
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

pub use capture_backend::capture_helper_main;
use capture_backend::RuntimeController;
use command_error::CommandError;
use recorder::MacroRecorder;
use config::{
    load_or_initialize_config, read_and_migrate_config_file, save_config as save_config_to_store,
    AppConfig, ConfigStoreError, LoadConfigResponse, SaveConfigResponse,
};
use executor::{ActionExecutionEvent, RuntimeErrorEvent};
use resolver::ResolvedInputPreview;
use runtime::{
    DebugLogEntry, RuntimeStateSummary, RuntimeStore, EVENT_ACTION_EXECUTED, EVENT_CONFIG_RELOADED,
    EVENT_CONTROL_RESOLVED, EVENT_DEBUG_LOG_APPENDED, EVENT_PROFILE_RESOLVED, EVENT_RUNTIME_ERROR,
    EVENT_RUNTIME_STARTED, EVENT_RUNTIME_STOPPED,
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_log::{Target, TargetKind, RotationStrategy, TimezoneStrategy};
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
        #[cfg(target_os = "linux")]
        { crate::platform::display::get_dpi_scale() }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
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
    return crate::platform::display::measure_text_width(text, font_family, font_size_px, font_weight);
    #[cfg(target_os = "linux")]
    return crate::platform::display::measure_text_width(text, font_family, font_size_px, font_weight);
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
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

fn resolve_app_paths(app: &AppHandle) -> Arc<paths::AppPaths> {
    app.state::<Arc<paths::AppPaths>>().inner().clone()
}

fn resolve_config_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(resolve_app_paths(app).config_dir.clone())
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
    let validated = validate_user_file_path(path)?;
    let is_json = validated
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));
    if !is_json {
        return Err(CommandError::new(
            "invalid_path",
            "File must have a .json extension.",
            None,
        ));
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
            fs::create_dir_all(parent).map_err(|e| {
                CommandError::internal(format!("Failed to create directory: {e}"))
            })?;
        }
        fs::write(&validated_path, contents)
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

/// Record this process's view of the on-disk config fingerprint so a later
/// `save_config` can detect a concurrent overwrite by another instance.
/// Best-effort: re-resolves the config dir and stores `None` if unreadable.
fn record_config_stamp(app: &AppHandle) {
    if let Ok(dir) = resolve_config_dir(app) {
        let stamp = config::config_file_stamp(&dir);
        *app.state::<ConfigStamp>().inner().lock().recover_poison() = stamp;
    }
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
/// points exist between `controller.restart()` and `store.reload()`.
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
        let store = runtime_store
            .lock()
            .recover_poison();
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
                .recover_poison()
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
                        .recover_poison();
                    store.stop()
                };
                let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
                return Err(CommandError::new("runtime_reload_failed", message, None));
            }
            Some(Ok(())) => {
                let mut store = runtime_store
                    .lock()
                    .recover_poison();
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
    Ok(AppPathsInfo {
        mode: paths.mode,
        config_dir: paths.config_dir.to_string_lossy().into_owned(),
        log_dir: paths.log_dir.to_string_lossy().into_owned(),
        snapshots_dir: paths.snapshots_dir.to_string_lossy().into_owned(),
        portable_marker_present: paths.portable_marker_present,
        fallback_reason: paths.fallback_reason.clone(),
        needs_portable_migration_prompt: paths.needs_portable_migration_prompt(),
    })
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
            let config =
                read_and_migrate_config_file(&backup_pb).map_err(CommandError::from)?;
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

    Ok(response)
}

#[tauri::command]
async fn export_full_config(
    app: AppHandle,
    target_path: String,
) -> Result<String, CommandError> {
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
        fs::copy(&source, &validated)
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
async fn import_full_config_preview(
    source_path: String,
) -> Result<ImportPreview, CommandError> {
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
    source_path: String,
    mode: ImportMode,
) -> Result<SaveConfigResponse, CommandError> {
    let validated = validate_user_file_path(&source_path)?;
    let config_dir = resolve_config_dir(&app)?;
    let config_dir_for_task = config_dir.clone();

    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<SaveConfigResponse, CommandError> {
            ensure_full_config_import_size(&validated)?;
            let imported =
                read_and_migrate_config_file(&validated).map_err(CommandError::from)?;
            let final_config = match mode {
                ImportMode::Replace => imported,
                ImportMode::Merge => {
                    let base = load_or_initialize_config(&config_dir_for_task)
                        .map_err(CommandError::from)?
                        .config;
                    merge_configs_by_id(base, imported)
                }
            };
            save_config_to_store(&config_dir_for_task, final_config, None).map_err(CommandError::from)
        },
    )
    .await
    .map_err(|e| CommandError::internal(format!("import apply task failed: {e}")))??;

    app.state::<MinimizeToTray>()
        .store(result.config.settings.minimize_to_tray, Ordering::Relaxed);
    // Explicit overwrite — adopt the new on-disk fingerprint as our baseline so
    // the next save_config does not falsely report a concurrent change.
    record_config_stamp(&app);

    Ok(result)
}

/// Merge two configs by ID (incoming wins on ID conflicts). Non-array fields
/// (version, settings, physicalControls, encoderMappings) are taken from
/// `incoming`. Suitable for merging same-user configs where IDs are unique
/// random tokens (see `makeRandomId` in the frontend).
fn merge_configs_by_id(base: AppConfig, incoming: AppConfig) -> AppConfig {
    use std::collections::HashMap;

    fn merge_by<K: Eq + std::hash::Hash + Clone, T, F: Fn(&T) -> K>(
        base: Vec<T>,
        incoming: Vec<T>,
        key: F,
    ) -> Vec<T> {
        let mut map: HashMap<K, T> = HashMap::new();
        for item in base {
            map.insert(key(&item), item);
        }
        for item in incoming {
            map.insert(key(&item), item);
        }
        map.into_values().collect()
    }

    AppConfig {
        version: incoming.version,
        settings: incoming.settings,
        profiles: merge_by(base.profiles, incoming.profiles, |p| p.id.clone()),
        physical_controls: incoming.physical_controls,
        encoder_mappings: incoming.encoder_mappings,
        app_mappings: merge_by(base.app_mappings, incoming.app_mappings, |m| m.id.clone()),
        bindings: merge_by(base.bindings, incoming.bindings, |b| b.id.clone()),
        actions: merge_by(base.actions, incoming.actions, |a| a.id.clone()),
        snippet_library: merge_by(base.snippet_library, incoming.snippet_library, |s| s.id.clone()),
    }
}

#[tauri::command]
async fn open_config_folder(app: AppHandle) -> Result<(), CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let _ = fs::create_dir_all(&config_dir);
    #[cfg(target_os = "windows")]
    crate::platform::shell::open_in_explorer(&config_dir)
        .map_err(CommandError::internal)?;
    #[cfg(target_os = "linux")]
    crate::platform::shell::open_in_explorer(&config_dir)
        .map_err(CommandError::internal)?;
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        std::process::Command::new("xdg-open")
            .arg(config_dir.as_os_str())
            .spawn()
            .map_err(|e| {
                CommandError::internal(format!("Failed to open config folder: {e}"))
            })?;
    }
    Ok(())
}

#[tauri::command]
async fn accept_portable_migration(
    app: AppHandle,
    copy_from_roaming: bool,
) -> Result<LoadConfigResponse, CommandError> {
    let paths_state = resolve_app_paths(&app);
    let config_dir = paths_state.config_dir.clone();
    let roaming_config = paths::AppPaths::roaming_config_file();

    let response = tauri::async_runtime::spawn_blocking(
        move || -> Result<LoadConfigResponse, CommandError> {
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
            load_or_initialize_config(&config_dir).map_err(CommandError::from)
        },
    )
    .await
    .map_err(|e| CommandError::internal(format!("migration task failed: {e}")))??;

    app.state::<MinimizeToTray>()
        .store(response.config.settings.minimize_to_tray, Ordering::Relaxed);
    // Explicit overwrite — adopt the new on-disk fingerprint as our baseline so
    // the next save_config does not falsely report a concurrent change.
    record_config_stamp(&app);

    Ok(response)
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
// Onboarding — bundled Synapse profile + environment checks
// ============================================================================

/// The Razer Synapse profile shipped with Sidearm. The user imports it into
/// Razer Synapse so the Naga emits F13–F24; it also seeds Sidearm's own
/// bindings via the normal Synapse-import pipeline. Embedded with
/// `include_bytes!` because the portable build assembles by hand and does not
/// run Tauri's resource bundler.
const BUNDLED_SYNAPSE_PROFILE: &[u8] = include_bytes!("../resources/Sidearm_profile.synapse4");
const BUNDLED_SYNAPSE_FILENAME: &str = "Sidearm_profile.synapse4";

/// Write the bundled Synapse profile into the user's Downloads folder so they
/// can import it into Razer Synapse, optionally revealing the folder. Returns
/// the absolute path written — the onboarding wizard reuses it as the source
/// for `parse_synapse_source` when seeding Sidearm's own bindings.
#[tauri::command]
async fn save_bundled_synapse_profile(app: AppHandle, reveal: bool) -> Result<String, CommandError> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| CommandError::internal(format!("download_dir: {e}")))?;
    let dest = dir.join(BUNDLED_SYNAPSE_FILENAME);
    fs::write(&dest, BUNDLED_SYNAPSE_PROFILE)
        .map_err(|e| CommandError::internal(format!("write bundled profile: {e}")))?;
    if reveal {
        // Open the containing folder — passing the file itself would make
        // Explorer try to "open" the unknown .synapse4 type.
        let _ = crate::platform::shell::open_in_explorer(&dir);
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// Best-effort check for the onboarding pre-flight: is Razer Synapse installed
/// or running? Windows-only signal; returns false on other platforms.
#[tauri::command]
async fn check_synapse_installed() -> Result<bool, CommandError> {
    let running =
        crate::platform::shell::find_running_process_path("RazerAppEngine.exe").is_some();
    #[cfg(target_os = "windows")]
    let installed = crate::platform::shell::lookup_app_paths_registry("RazerAppEngine.exe")
        .is_some()
        || crate::platform::shell::lookup_app_paths_registry("Razer Synapse 3.exe").is_some();
    #[cfg(not(target_os = "windows"))]
    let installed = false;
    Ok(running || installed)
}

/// Toggle "live capture" mode. While enabled, captured Naga keys are surfaced
/// to the UI via `encoded_key_received` but are NOT resolved/executed/injected.
/// The onboarding hardware test enables it so pressing buttons lights up the
/// tester without firing their real actions; it is always cleared on exit.
#[tauri::command]
async fn set_input_capture_mode(enabled: bool) -> Result<(), CommandError> {
    capture_backend::SUPPRESS_EXECUTION.store(enabled, Ordering::Relaxed);
    Ok(())
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
            .recover_poison();
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
            .recover_poison();
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
            .recover_poison();
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
                .recover_poison();
            store.stop()
        };
        let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
        return Err(CommandError::new("runtime_reload_failed", message, None));
    }

    let summary = {
        let mut store = runtime_store
            .lock()
            .recover_poison();
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
        .recover_poison();

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
async fn get_admin_autostart_status() -> Result<admin_autostart::AdminAutostartStatus, CommandError> {
    Ok(admin_autostart::query())
}

/// Enable or disable the elevated autostart-at-logon scheduled task.
/// Enabling triggers a UAC prompt (schtasks needs admin to create a task
/// with RunLevel=Highest).  After enabling, the frontend should disable the
/// regular tauri-plugin-autostart entry to avoid two launchers competing.
#[tauri::command]
async fn set_admin_autostart(enabled: bool) -> Result<admin_autostart::AdminAutostartStatus, CommandError> {
    let result = if enabled {
        admin_autostart::enable()
    } else {
        admin_autostart::disable()
    };
    if let Err(message) = result {
        return Err(CommandError::new("admin_autostart_failed", message, None));
    }
    Ok(admin_autostart::query())
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
        return Err(CommandError::new(
            "already_elevated",
            "Sidearm уже запущен с правами администратора.",
            None,
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

        // ShellExecuteW returns an HINSTANCE; values <= 32 indicate failure.
        // SE_ERR_ACCESSDENIED (5) is the code we get when the user cancels UAC.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb_w.as_ptr(),
                exe_w.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        let code = result as isize;
        if code <= 32 {
            let message = if code == 5 {
                "Запуск от администратора отменён в окне UAC."
            } else {
                "Не удалось перезапустить от администратора."
            };
            return Err(CommandError::new("relaunch_cancelled", message, None));
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
            "Перезапуск от администратора поддерживается только в Windows.",
            None,
        ))
    }
}

#[tauri::command]
async fn open_log_directory(app: AppHandle) -> Result<(), CommandError> {
    let log_dir = resolve_log_dir(&app);
    if log_dir.exists() {
        #[cfg(target_os = "windows")]
        crate::platform::shell::open_in_explorer(&log_dir)
            .map_err(CommandError::internal)?;
        #[cfg(target_os = "linux")]
        crate::platform::shell::open_in_explorer(&log_dir)
            .map_err(CommandError::internal)?;
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
        let mut store = runtime_store
            .lock()
            .recover_poison();
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
                .recover_poison();
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
                    .recover_poison();
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
        let _ = window.show();
        let _ = window.set_focus();
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
                .map(|p| RunningProcessInfo { exe: p.exe, path: p.path, pid: p.pid })
                .collect()
        }
        #[cfg(target_os = "linux")]
        {
            return crate::platform::shell::list_running_processes()
                .into_iter()
                .map(|p| RunningProcessInfo { exe: p.exe, path: p.path, pid: p.pid })
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
    for entry in entries.flatten() {
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
            Err(_) => continue,
        };
        let meta: PresetFileMeta = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(_) => continue,
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
        let mut store = runtime_store
            .lock()
            .recover_poison();
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
            resolver::ResolutionStatus::ConditionUnmet => store.record_info(
                "разрешение",
                format!(
                    "Условия не выполнены для `{}`: {}",
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
            resolver::resolve_input_preview(&load_response.config, &normalized_key, &exe, &title, None);
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
                    .recover_poison();
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

/// Live-test a draft action straight from the picker (no save, no encoder signal).
/// Actually executes the action; the frontend runs the "switch to your window"
/// countdown before calling this. Loads the on-disk config only to resolve
/// library snippets / profile names referenced by the draft.
#[tauri::command]
async fn live_test_action(
    app: AppHandle,
    action: config::Action,
) -> Result<ActionExecutionEvent, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let config = tauri::async_runtime::spawn_blocking(move || load_or_initialize_config(&config_dir))
        .await
        .map_err(|error| CommandError::internal(format!("live_test_action task failed: {error}")))?
        .map_err(CommandError::from)?
        .config;

    executor::live_test_action(&config, &action).map_err(|error| {
        CommandError::new(
            error.code,
            error.event.message.clone(),
            error.event.action_id.clone().map(|id| vec![id]),
        )
    })
}

fn emit_runtime_error(
    app: &AppHandle,
    runtime_store: &State<'_, Arc<Mutex<RuntimeStore>>>,
    event: &RuntimeErrorEvent,
) -> Result<(), CommandError> {
    {
        let mut store = runtime_store
            .lock()
            .recover_poison();
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
        if let Some(ref path) = process_path
            && std::path::Path::new(path).exists()
                && let Some(b64) = exe_icon::extract_icon_base64(path) {
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
            && let Some(b64) = exe_icon::extract_icon_base64(&path) {
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
        && !paths.contains(&path) {
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
    { let _ = exe_name; return None; }
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
                let _ = atomic_copy_file(&path, &dest);
            }
        }
    }
    log::info!("[system] Migrated config from old directory: {}", old_dir.display());
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
    for base in [dirs_fallback_local(), dirs_fallback_roaming()].into_iter().flatten() {
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
    let (deleted, kept) =
        log_cleanup::sweep(&log_target_path, LOG_RETENTION_DAYS, LOG_RETENTION_MAX_FILES);

    // Orphan sweep: when running in portable mode, also sweep any logs left
    // behind by previous roaming-mode runs in %LOCALAPPDATA%\com.sidearm.desktop\logs.
    // Symmetric: a switch back to roaming-only would similarly orphan
    // ./data/logs, but in practice the portable folder gets deleted manually.
    let mut orphan_deleted = 0;
    if app_paths.mode == paths::PathMode::Portable
        && let Some(roaming_log_dir) = legacy_local_app_data_log_dir()
            && roaming_log_dir.is_dir() && roaming_log_dir != log_target_path {
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

    tauri::Builder::default()
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
        .plugin(tauri_plugin_notification::init())
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
            if let Some((rx, pending)) =
                log_rx_for_setup.lock().recover_poison().take()
            {
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
                    && (size.width < MIN_W || size.height < MIN_H) {
                        let new_w = size.width.max(MIN_W);
                        let new_h = size.height.max(MIN_H);
                        log::warn!(
                            "[window] restored main size {}x{} below minimum {}x{} — clamping to {}x{}",
                            size.width, size.height, MIN_W, MIN_H, new_w, new_h,
                        );
                        let _ = main_window.set_size(tauri::Size::Physical(
                            tauri::PhysicalSize { width: new_w, height: new_h },
                        ));
                    }
            }

            // OSD window is created lazily on first profile switch (see show_osd).
            // Pre-creating at startup caused foreground watcher interference and
            // startup flash when WebView2 wasn't ready yet.

            check_crash_sentinel(app.handle());
            log::info!(
                "[system] Sidearm v{} started",
                app.package_info().version
            );

            let toggle_item = MenuItem::with_id(app, "toggle_runtime", "Слушать мышь", true, None::<&str>)?;
            let is_elevated = window_capture::is_current_process_elevated();
            // Build the tray menu. The "Restart as administrator" entry is
            // shown only when Sidearm itself is non-elevated — that's the
            // case where UIPI blocks SendInput into elevated foreground
            // windows (Task Manager, regedit, UAC dialogs).
            let tray_menu = if is_elevated {
                Menu::with_items(
                    app,
                    &[
                        &toggle_item,
                        &PredefinedMenuItem::separator(app)?,
                        &MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?,
                    ],
                )?
            } else {
                Menu::with_items(
                    app,
                    &[
                        &toggle_item,
                        &PredefinedMenuItem::separator(app)?,
                        &MenuItem::with_id(
                            app,
                            "relaunch_as_admin",
                            "Перезапустить от администратора",
                            true,
                            None::<&str>,
                        )?,
                        &PredefinedMenuItem::separator(app)?,
                        &MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?,
                    ],
                )?
            };

            // Store the toggle menu item handle so we can update its text
            let toggle_item_handle = toggle_item.clone();

            let mut tray_builder = TrayIconBuilder::new();
            match app.default_window_icon() {
                Some(icon) => tray_builder = tray_builder.icon(icon.clone()),
                None => log::warn!("[system] No default window icon available for tray"),
            }
            tray_builder
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
                                    let _ = toggle_item.set_text("Слушать мышь");
                                }
                            } else {
                                let config_dir = resolve_app_paths(&app).config_dir.clone();
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
                                    let _ = toggle_item.set_text("Приостановить");
                                }
                            }
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
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                        && let Some(window) = tray.app_handle().get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                })
                .build(app)?;

            // Optional global shortcut; never panic in setup if parsing ever
            // regresses. This is the tail of setup, so skipping registration on
            // a parse error is safe.
            let shortcut: Shortcut = match "ctrl+alt+n".parse() {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[system] Could not parse Ctrl+Alt+N shortcut: {e}");
                    return Ok(());
                }
            };

            // Non-fatal: if the shortcut is already registered (e.g. previous
            // instance didn't clean up yet), log a warning and continue.
            if let Err(e) = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed
                    && let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
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
        .manage(app_paths_for_setup)
        .manage(Arc::new(AtomicBool::new(false)) as MinimizeToTray)
        .manage(Arc::new(Mutex::new(None)) as ConfigStamp)
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
            save_bundled_synapse_profile,
            check_synapse_installed,
            set_input_capture_mode,
            start_runtime,
            stop_runtime,
            reload_runtime,
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_home() -> TempDir {
        TempDir::new().expect("create temp home dir")
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

        let err = ensure_full_config_import_size(&big).expect_err("oversized file must be rejected");
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
