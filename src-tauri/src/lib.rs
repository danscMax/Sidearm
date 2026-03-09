mod clipboard;
mod capture_backend;
mod command_error;
mod config;
mod executor;
mod hotkeys;
mod input_synthesis;
mod resolver;
mod runtime;
mod window_capture;

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use capture_backend::RuntimeController;
use command_error::CommandError;
use config::{
    load_or_initialize_config, save_config as save_config_to_store, AppConfig, ConfigStoreError,
    LoadConfigResponse, SaveConfigResponse,
};
use executor::{ActionExecutionEvent, RuntimeErrorEvent};
use resolver::ResolvedInputPreview;
use runtime::{
    DebugLogEntry, RuntimeStateSummary, RuntimeStore, EVENT_ACTION_EXECUTED,
    EVENT_CONFIG_RELOADED, EVENT_CONTROL_RESOLVED, EVENT_PROFILE_RESOLVED, EVENT_RUNTIME_ERROR,
    EVENT_RUNTIME_STARTED, EVENT_RUNTIME_STOPPED,
};
use tauri::{AppHandle, Emitter, Manager, State};
use window_capture::WindowCaptureResult;

fn resolve_config_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path().app_config_dir().map_err(|error| {
        CommandError::from(ConfigStoreError::ConfigDirectoryUnavailable(format!(
            "Failed to resolve app config directory: {error}"
        )))
    })
}

#[tauri::command]
async fn export_verification_session(
    path: String,
    contents: String,
) -> Result<String, CommandError> {
    let export_path = PathBuf::from(path.trim());
    if export_path.as_os_str().is_empty() {
        return Err(CommandError::new(
            "invalid_request",
            "Export path must not be empty.",
            None,
        ));
    }

    let exported_path = export_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = export_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|error| {
                    CommandError::internal(format!(
                        "Failed to create export directory `{}`: {error}",
                        parent.display()
                    ))
                })?;
            }
        }

        fs::write(&export_path, contents).map_err(|error| {
            CommandError::internal(format!(
                "Failed to write verification export `{}`: {error}",
                export_path.display()
            ))
        })
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!(
            "export_verification_session task failed: {error}"
        ))
    })??;

    Ok(exported_path.display().to_string())
}

#[tauri::command]
async fn load_config(app: AppHandle) -> Result<LoadConfigResponse, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_or_initialize_config(&config_dir))
        .await
        .map_err(|error| CommandError::internal(format!("load_config task failed: {error}")))?
        .map_err(CommandError::from)
}

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

    let is_running = {
        let store = runtime_store
            .lock()
            .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
        store.is_running()
    };

    let maybe_runtime_summary = if is_running {
        let restart_result = {
            let mut controller = runtime_controller
                .lock()
                .map_err(|_| CommandError::internal("runtime controller lock poisoned"))?;
            controller
                .restart(
                    app.clone(),
                    runtime_store.inner().clone(),
                    result.config.clone(),
                    app.package_info().name.clone(),
                )
        };
        if let Err(message) = restart_result {
            let stopped_summary = {
                let mut store = runtime_store
                    .lock()
                    .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
                store.stop()
            };
            let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
            return Err(CommandError::new("runtime_reload_failed", message, None));
        }

        let mut store = runtime_store
            .lock()
            .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
        Some(store.reload(result.config.version, result.warnings.len()))
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
            .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
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
            .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
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
        controller
            .restart(
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
                .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
            store.stop()
        };
        let _ = app.emit(EVENT_RUNTIME_STOPPED, &stopped_summary);
        return Err(CommandError::new("runtime_reload_failed", message, None));
    }

    let summary = {
        let mut store = runtime_store
            .lock()
            .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
        store.reload(load_response.config.version, load_response.warnings.len())
    };

    app.emit(EVENT_CONFIG_RELOADED, &summary).map_err(|error| {
        CommandError::internal(format!("Failed to emit config_reloaded event: {error}"))
    })?;

    Ok(summary)
}

#[tauri::command]
async fn get_debug_log(
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
) -> Result<Vec<DebugLogEntry>, CommandError> {
    let store = runtime_store
        .lock()
        .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;

    Ok(store.logs())
}

#[tauri::command]
async fn capture_active_window(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    delay_ms: Option<u64>,
) -> Result<WindowCaptureResult, CommandError> {
    let config_dir = resolve_config_dir(&app)?;
    let app_name = app.package_info().name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let load_response = load_or_initialize_config(&config_dir)?;
        window_capture::capture_active_window_with_resolution(
            &load_response.config,
            &app_name,
            delay_ms,
        )
        .map_err(|message| CommandError::new("window_capture_error", message, None))
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!("capture_active_window task failed: {error}"))
    })??;

    {
        let mut store = runtime_store
            .lock()
            .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
        if result.ignored {
            store.record_warn(
                "window-capture",
                result
                    .ignore_reason
                    .clone()
                    .unwrap_or_else(|| "Ignored active window.".into()),
            );
        } else {
            store.record_info(
                "window-capture",
                format!(
                    "Captured `{}` and resolved profile `{}`.",
                    result.exe,
                    result.resolved_profile_id.as_deref().unwrap_or("n/a")
                ),
            );
        }
    }

    app.emit(EVENT_PROFILE_RESOLVED, &result).map_err(|error| {
        CommandError::internal(format!("Failed to emit profile_resolved event: {error}"))
    })?;

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
            .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
        match preview.status {
            resolver::ResolutionStatus::Resolved => store.record_info(
                "resolver",
                format!(
                    "Resolved `{}` to control `{}` for profile `{}`.",
                    preview.encoded_key,
                    preview.control_id.as_deref().unwrap_or("n/a"),
                    preview.resolved_profile_id.as_deref().unwrap_or("n/a")
                ),
            ),
            resolver::ResolutionStatus::Unresolved => store.record_warn(
                "resolver",
                format!(
                    "Unresolved preview for `{}`: {}",
                    preview.encoded_key, preview.reason
                ),
            ),
            resolver::ResolutionStatus::Ambiguous => store.record_warn(
                "resolver",
                format!(
                    "Ambiguous preview for `{}`: {}",
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

#[tauri::command]
async fn execute_preview_action(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
) -> Result<ActionExecutionEvent, CommandError> {
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        let load_response = load_or_initialize_config(&config_dir)?;
        let preview =
            resolver::resolve_input_preview(&load_response.config, &normalized_key, &exe, &title);
        let execution = executor::execute_preview_action(&load_response.config, &preview);
        Ok::<_, ConfigStoreError>((preview, execution))
    })
    .await
    .map_err(|error| {
        CommandError::internal(format!("execute_preview_action task failed: {error}"))
    })?
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
                    .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
                let message = format!(
                    "Dry-run executed `{}` for `{}`.",
                    event.action_pretty, event.encoded_key
                );
                match event.outcome {
                    executor::ExecutionOutcome::Spawned => {
                        store.record_info("execution", message);
                    }
                    executor::ExecutionOutcome::Injected => {
                        store.record_info("execution", message);
                    }
                    executor::ExecutionOutcome::Simulated => {
                        store.record_info("execution", message);
                    }
                    executor::ExecutionOutcome::Noop => {
                        store.record_warn("execution", message);
                    }
                }
                for warning in &event.warnings {
                    store.record_warn("execution", warning.clone());
                }
            }

            app.emit(EVENT_ACTION_EXECUTED, &event).map_err(|error| {
                CommandError::internal(format!("Failed to emit action_executed event: {error}"))
            })?;

            Ok(event)
        }
        Err(error) => {
            emit_runtime_error(&app, &runtime_store, &error.event)?;
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
async fn run_preview_action(
    app: AppHandle,
    runtime_store: State<'_, Arc<Mutex<RuntimeStore>>>,
    encoded_key: String,
    exe: Option<String>,
    title: Option<String>,
) -> Result<ActionExecutionEvent, CommandError> {
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        let load_response = load_or_initialize_config(&config_dir)?;
        let preview =
            resolver::resolve_input_preview(&load_response.config, &normalized_key, &exe, &title);
        let execution = executor::run_preview_action(&load_response.config, &preview);
        Ok::<_, ConfigStoreError>((preview, execution))
    })
    .await
    .map_err(|error| CommandError::internal(format!("run_preview_action task failed: {error}")))?
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
                    .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
                store.record_info(
                    "execution",
                    format!(
                        "Live execution launched `{}` for `{}`.",
                        event.action_pretty, event.encoded_key
                    ),
                );
            }

            app.emit(EVENT_ACTION_EXECUTED, &event).map_err(|error| {
                CommandError::internal(format!("Failed to emit action_executed event: {error}"))
            })?;

            Ok(event)
        }
        Err(error) => {
            emit_runtime_error(&app, &runtime_store, &error.event)?;
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

fn emit_runtime_error(
    app: &AppHandle,
    runtime_store: &State<'_, Arc<Mutex<RuntimeStore>>>,
    event: &RuntimeErrorEvent,
) -> Result<(), CommandError> {
    {
        let mut store = runtime_store
            .lock()
            .map_err(|_| CommandError::internal("runtime state lock poisoned"))?;
        store.record_warn(
            event.category.clone(),
            format!("{}{}", event.message, runtime_error_context(event)),
        );
    }

    app.emit(EVENT_RUNTIME_ERROR, event)
        .map_err(|error| {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(RuntimeStore::default())))
        .manage(Arc::new(Mutex::new(RuntimeController::default())))
        .invoke_handler(tauri::generate_handler![
            export_verification_session,
            load_config,
            save_config,
            start_runtime,
            stop_runtime,
            reload_runtime,
            get_debug_log,
            capture_active_window,
            preview_resolution,
            execute_preview_action,
            run_preview_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
