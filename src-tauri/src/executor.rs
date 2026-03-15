use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};

/// Maximum delay (in milliseconds) allowed for a single sequence step sleep.
/// Prevents unbounded thread blocking from malformed or malicious configs.
const MAX_STEP_DELAY_MS: u64 = 30_000;

use crate::{
    clipboard,
    config::{
        Action, ActionCondition, ActionPayload, ActionType, AppConfig, MenuItem,
        MouseActionPayload, PasteMode, SequenceStep, TextSnippetPayload,
    },
    input_synthesis,
    resolver::{ResolutionStatus, ResolvedInputPreview},
    runtime::timestamp_millis,
};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionMode {
    DryRun,
    Live,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionOutcome {
    Spawned,
    Injected,
    Simulated,
    Noop,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionExecutionEvent {
    pub encoded_key: String,
    pub action_id: String,
    pub action_type: String,
    pub action_pretty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_app_mapping_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    pub mode: ExecutionMode,
    pub outcome: ExecutionOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
    pub summary: String,
    pub warnings: Vec<String>,
    pub executed_at: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeErrorEvent {
    pub category: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoded_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    pub created_at: u64,
}

#[derive(Debug)]
pub struct ExecutorError {
    pub code: &'static str,
    pub event: RuntimeErrorEvent,
}

pub fn execute_preview_action(
    config: &AppConfig,
    preview: &ResolvedInputPreview,
) -> Result<ActionExecutionEvent, ExecutorError> {
    if preview.status != ResolutionStatus::Resolved {
        return Err(execution_error(
            "execution_blocked",
            "выполнение",
            &preview.reason,
            Some(preview.encoded_key.clone()),
            preview.action_id.clone(),
        ));
    }

    let action_id = preview
        .action_id
        .as_deref()
        .ok_or_else(|| {
            execution_error(
                "missing_action",
                "выполнение",
                "В разрешённом превью отсутствует ID действия.",
                Some(preview.encoded_key.clone()),
                None,
            )
        })?
        .to_owned();
    let action = config
        .actions
        .iter()
        .find(|candidate| candidate.id == action_id)
        .ok_or_else(|| {
            execution_error(
                "missing_action",
                "выполнение",
                &format!("Действие `{action_id}` больше не существует в конфигурации."),
                Some(preview.encoded_key.clone()),
                Some(action_id.clone()),
            )
        })?;

    let (outcome, summary, warnings) = summarize_action(config, action).map_err(|message| {
        execution_error(
            "execution_failed",
            "выполнение",
            &message,
            Some(preview.encoded_key.clone()),
            Some(action_id.clone()),
        )
    })?;

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.pretty.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::DryRun,
        outcome,
        process_id: None,
        summary,
        warnings,
        executed_at: timestamp_millis(),
    })
}

pub fn run_preview_action(
    config: &AppConfig,
    preview: &ResolvedInputPreview,
) -> Result<ActionExecutionEvent, ExecutorError> {
    if preview.status != ResolutionStatus::Resolved {
        return Err(execution_error(
            "execution_blocked",
            "выполнение",
            &preview.reason,
            Some(preview.encoded_key.clone()),
            preview.action_id.clone(),
        ));
    }

    let action_id = preview
        .action_id
        .as_deref()
        .ok_or_else(|| {
            execution_error(
                "missing_action",
                "выполнение",
                "В разрешённом превью отсутствует ID действия.",
                Some(preview.encoded_key.clone()),
                None,
            )
        })?
        .to_owned();
    let action = config
        .actions
        .iter()
        .find(|candidate| candidate.id == action_id)
        .ok_or_else(|| {
            execution_error(
                "missing_action",
                "выполнение",
                &format!("Действие `{action_id}` больше не существует в конфигурации."),
                Some(preview.encoded_key.clone()),
                Some(action_id.clone()),
            )
        })?;

    match (&action.action_type, &action.payload) {
        (ActionType::Shortcut, ActionPayload::Shortcut(payload)) => run_live_shortcut_action(
            action,
            preview,
            payload,
            Some(action_id),
        ),
        (ActionType::TextSnippet, ActionPayload::TextSnippet(payload)) => {
            run_live_text_snippet_action(config, action, preview, payload, Some(action_id))
        }
        (ActionType::Launch, ActionPayload::Launch(payload)) => run_live_launch_action(
            action,
            preview,
            payload,
            Some(action_id),
        ),
        (ActionType::Sequence, ActionPayload::Sequence(payload)) => {
            run_live_sequence_action(action, preview, payload, Some(action_id))
        }
        (ActionType::MouseAction, ActionPayload::MouseAction(payload)) => {
            run_live_mouse_action(action, preview, payload, Some(action_id))
        }
        (ActionType::Disabled, ActionPayload::Disabled(_)) => Ok(ActionExecutionEvent {
            encoded_key: preview.encoded_key.clone(),
            action_id: action.id.clone(),
            action_type: action.action_type.as_str().into(),
            action_pretty: action.pretty.clone(),
            resolved_profile_id: preview.resolved_profile_id.clone(),
            resolved_profile_name: preview.resolved_profile_name.clone(),
            matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
            control_id: preview.control_id.clone(),
            layer: preview.layer.clone(),
            binding_id: preview.binding_id.clone(),
            mode: ExecutionMode::Live,
            outcome: ExecutionOutcome::Noop,
            process_id: None,
            summary: "Отключённое действие — ничего не выполнено.".into(),
            warnings: Vec::new(),
            executed_at: timestamp_millis(),
        }),
        _ => Err(execution_error(
            "unsupported_live_execution",
            "выполнение",
            "Выполнение вживую поддерживается для шорткатов, действий мыши, текстовых вставок, запуска программ, отключённых действий и последовательностей из поддерживаемых шагов.",
            Some(preview.encoded_key.clone()),
            Some(action_id),
        )),
    }
}

fn summarize_action(
    config: &AppConfig,
    action: &Action,
) -> Result<(ExecutionOutcome, String, Vec<String>), String> {
    match (&action.action_type, &action.payload) {
        (ActionType::Shortcut, ActionPayload::Shortcut(payload)) => Ok((
            ExecutionOutcome::Simulated,
            format!("Отправит шорткат `{}`.", format_shortcut(payload)),
            Vec::new(),
        )),
        (ActionType::TextSnippet, ActionPayload::TextSnippet(payload)) => {
            summarize_text_snippet(config, payload)
        }
        (ActionType::Sequence, ActionPayload::Sequence(payload)) => Ok((
            ExecutionOutcome::Simulated,
            format!(
                "Выполнит последовательность из {} шагов: {}.",
                payload.steps.len(),
                payload
                    .steps
                    .iter()
                    .map(sequence_step_summary)
                    .collect::<Vec<_>>()
                    .join(" -> ")
            ),
            Vec::new(),
        )),
        (ActionType::Launch, ActionPayload::Launch(payload)) => {
            let mut warnings = Vec::new();
            if Path::new(&payload.target).is_absolute() && !Path::new(&payload.target).exists() {
                warnings.push("Путь к цели запуска не существует.".into());
            }

            Ok((
                ExecutionOutcome::Simulated,
                format!(
                    "Запустит `{}`{}.",
                    payload.target,
                    if payload.args.is_empty() {
                        String::new()
                    } else {
                        format!(" с {} арг.", payload.args.len())
                    }
                ),
                warnings,
            ))
        }
        (ActionType::Menu, ActionPayload::Menu(payload)) => Ok((
            ExecutionOutcome::Simulated,
            format!(
                "Откроет меню с {} пунктами ({} активных).",
                payload.items.len(),
                count_enabled_menu_items(&payload.items)
            ),
            Vec::new(),
        )),
        (ActionType::MouseAction, ActionPayload::MouseAction(payload)) => Ok((
            ExecutionOutcome::Simulated,
            format_mouse_summary(payload),
            Vec::new(),
        )),
        (ActionType::MediaKey, ActionPayload::MediaKey(payload)) => Ok((
            ExecutionOutcome::Simulated,
            format!("Отправит медиа-клавишу `{}`.", payload.key),
            Vec::new(),
        )),
        (ActionType::ProfileSwitch, ActionPayload::ProfileSwitch(payload)) => Ok((
            ExecutionOutcome::Simulated,
            format!("Переключит на профиль `{}`.", payload.target_profile_id),
            Vec::new(),
        )),
        (ActionType::Disabled, ActionPayload::Disabled(_)) => Ok((
            ExecutionOutcome::Noop,
            "Отключённое действие — ничего не выполняется.".into(),
            Vec::new(),
        )),
        _ => Err(format!(
            "Действие `{}` имеет несовместимый тип/полезную нагрузку.",
            action.id
        )),
    }
}

#[derive(Debug)]
struct LaunchRequest {
    target: PathBuf,
    working_dir: Option<PathBuf>,
}

fn run_live_launch_action(
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &crate::config::LaunchActionPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    let process_id = spawn_launch_target(payload, preview, action_id.clone())?;

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.pretty.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome: ExecutionOutcome::Spawned,
        process_id: Some(process_id),
        summary: format!("Запущено `{}`.", payload.target),
        warnings: Vec::new(),
        executed_at: timestamp_millis(),
    })
}

/// Executes a sequence of steps (send, text, sleep, launch) synchronously on the
/// worker thread.
///
/// **Limitation:** Launch steps within a sequence spawn detached processes (see
/// [`spawn_launch_target`] doc comment). If a later step in the sequence fails, any
/// processes spawned by earlier launch steps will remain running -- there is no
/// automatic rollback. Additionally, the studio only surfaces the PID of the *last*
/// launched process in the returned event; earlier PIDs are recorded in warnings but
/// not tracked for lifecycle management.
fn run_live_sequence_action(
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &crate::config::SequenceActionPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    validate_live_sequence(payload).map_err(|message| {
        execution_error(
            "unsupported_live_execution",
            "выполнение",
            &message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    let encoding_mods = crate::hotkeys::extract_encoding_modifiers(&preview.encoded_key);
    let mut launched_processes = Vec::new();
    let mut injected_input_steps = 0usize;
    for step in &payload.steps {
        match step {
            SequenceStep::Sleep { delay_ms } => {
                thread::sleep(Duration::from_millis(
                    u64::from(*delay_ms).min(MAX_STEP_DELAY_MS),
                ));
            }
            SequenceStep::Launch {
                value,
                args,
                working_dir,
                delay_ms,
            } => {
                let process_id = spawn_launch_target(
                    &crate::config::LaunchActionPayload {
                        target: value.clone(),
                        args: args.clone(),
                        working_dir: working_dir.clone(),
                    },
                    preview,
                    action_id.clone(),
                )?;
                launched_processes.push(process_id);
                if let Some(delay_ms) = delay_ms {
                    thread::sleep(Duration::from_millis(
                        u64::from(*delay_ms).min(MAX_STEP_DELAY_MS),
                    ));
                }
            }
            SequenceStep::Text { value, delay_ms } => {
                input_synthesis::send_text(value).map_err(|message| {
                    execution_error(
                        "execution_failed",
                        "выполнение",
                        &message,
                        Some(preview.encoded_key.clone()),
                        action_id.clone(),
                    )
                })?;
                injected_input_steps += 1;
                if let Some(delay_ms) = delay_ms {
                    thread::sleep(Duration::from_millis(
                        u64::from(*delay_ms).min(MAX_STEP_DELAY_MS),
                    ));
                }
            }
            SequenceStep::Send { value, delay_ms } => {
                input_synthesis::send_hotkey_string(value, &encoding_mods).map_err(|message| {
                    execution_error(
                        "execution_failed",
                        "выполнение",
                        &message,
                        Some(preview.encoded_key.clone()),
                        action_id.clone(),
                    )
                })?;
                injected_input_steps += 1;
                if let Some(delay_ms) = delay_ms {
                    thread::sleep(Duration::from_millis(
                        u64::from(*delay_ms).min(MAX_STEP_DELAY_MS),
                    ));
                }
            }
        }
    }

    let outcome = if !launched_processes.is_empty() {
        ExecutionOutcome::Spawned
    } else if injected_input_steps > 0 {
        ExecutionOutcome::Injected
    } else {
        ExecutionOutcome::Noop
    };

    let mut warnings = Vec::new();
    if launched_processes.len() > 1 {
        warnings.push(format!(
            "Последовательность запустила {} процессов; отображается только PID последнего.",
            launched_processes.len()
        ));
    }

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.pretty.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome,
        process_id: launched_processes.last().copied(),
        summary: format!(
            "Выполнена последовательность: {} шагов ввода, {} запусков.",
            injected_input_steps,
            launched_processes.len()
        ),
        warnings,
        executed_at: timestamp_millis(),
    })
}

fn validate_live_sequence(payload: &crate::config::SequenceActionPayload) -> Result<(), String> {
    for step in &payload.steps {
        match step {
            SequenceStep::Sleep { .. } => {}
            SequenceStep::Launch {
                value,
                args,
                working_dir,
                ..
            } => {
                validate_launch_request(&crate::config::LaunchActionPayload {
                    target: value.clone(),
                    args: args.clone(),
                    working_dir: working_dir.clone(),
                })?;
            }
            SequenceStep::Text { value, .. } => {
                if value.contains('\0') {
                    return Err(
                        "Текстовые шаги с NUL-символами не поддерживаются."
                            .into(),
                    );
                }
            }
            SequenceStep::Send { value, .. } => {
                crate::hotkeys::parse_hotkey(value).map_err(|message| {
                    format!(
                        "Шаг отправки `{value}` не является поддерживаемым шорткатом: {message}"
                    )
                })?;
            }
        }
    }

    Ok(())
}

fn run_live_shortcut_action(
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &crate::config::ShortcutActionPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    let encoding_mods = crate::hotkeys::extract_encoding_modifiers(&preview.encoded_key);
    let dispatch = input_synthesis::send_shortcut(payload, &encoding_mods).map_err(|message| {
        execution_error(
            "execution_failed",
            "выполнение",
            &message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.pretty.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome: ExecutionOutcome::Injected,
        process_id: None,
        summary: format!("Отправлен шорткат `{}`.", format_shortcut(payload)),
        warnings: dispatch.warnings,
        executed_at: timestamp_millis(),
    })
}

fn run_live_mouse_action(
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &MouseActionPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    let encoding_mods = crate::hotkeys::extract_encoding_modifiers(&preview.encoded_key);
    let dispatch =
        input_synthesis::send_mouse_action(payload, &encoding_mods).map_err(|message| {
            execution_error(
                "execution_failed",
                "выполнение",
                &message,
                Some(preview.encoded_key.clone()),
                action_id.clone(),
            )
        })?;

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.pretty.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome: ExecutionOutcome::Injected,
        process_id: None,
        summary: format_mouse_summary(payload),
        warnings: dispatch.warnings,
        executed_at: timestamp_millis(),
    })
}

fn format_mouse_summary(payload: &MouseActionPayload) -> String {
    let modifiers: Vec<&str> = [
        (payload.ctrl, "Ctrl"),
        (payload.shift, "Shift"),
        (payload.alt, "Alt"),
        (payload.win, "Win"),
    ]
    .iter()
    .filter(|(active, _)| *active)
    .map(|(_, label)| *label)
    .collect();

    if modifiers.is_empty() {
        format!("Выполнено действие мыши `{}`.", payload.action)
    } else {
        format!(
            "Выполнено действие мыши `{}` + `{}`.",
            modifiers.join(" + "),
            payload.action
        )
    }
}

fn run_live_text_snippet_action(
    config: &AppConfig,
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &TextSnippetPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    let live_text = resolve_live_text_snippet(config, payload).map_err(|message| {
        execution_error(
            "execution_failed",
            "выполнение",
            &message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    let mut warnings = live_text.warnings;
    match live_text.paste_mode {
        PasteMode::SendText => {
            input_synthesis::send_text(&live_text.text).map_err(|message| {
                execution_error(
                    "execution_failed",
                    "выполнение",
                    &message,
                    Some(preview.encoded_key.clone()),
                    Some(action.id.clone()),
                )
            })?;
        }
        PasteMode::ClipboardPaste => {
            let paste_report = clipboard::paste_text(&live_text.text).map_err(|message| {
                execution_error(
                    "execution_failed",
                    "выполнение",
                    &message,
                    Some(preview.encoded_key.clone()),
                    Some(action.id.clone()),
                )
            })?;
            warnings.extend(paste_report.warnings);
        }
    }

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.pretty.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome: ExecutionOutcome::Injected,
        process_id: None,
        summary: live_text.summary,
        warnings,
        executed_at: timestamp_millis(),
    })
}

/// Spawns a launch target and returns its OS process ID.
///
/// **Design note:** The `Child` handle returned by `Command::spawn()` is intentionally
/// dropped immediately after extracting the PID. Launched programs are meant to run
/// independently of the studio process -- we do not wait on them, send signals, or
/// manage their lifecycle. Dropping the `Child` detaches the process on Windows (the
/// child continues running), which is the desired behaviour for "launch application"
/// actions.
///
/// A consequence is that we have no way to terminate these processes later. For
/// standalone launch actions this is fine, but for sequence steps it means the studio
/// cannot roll back a partially-executed sequence by killing processes spawned in
/// earlier steps. True child-process tracking would require storing `Child` handles
/// in `RuntimeStore`, which is a larger refactor tracked separately.
fn spawn_launch_target(
    payload: &crate::config::LaunchActionPayload,
    preview: &ResolvedInputPreview,
    action_id: Option<String>,
) -> Result<u32, ExecutorError> {
    let launch_request = validate_launch_request(payload).map_err(|message| {
        execution_error(
            "execution_failed",
            "выполнение",
            &message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    let mut command = Command::new(&launch_request.target);
    command.args(&payload.args);
    if let Some(working_dir) = &launch_request.working_dir {
        command.current_dir(working_dir);
    }

    command.spawn().map(|child| child.id()).map_err(|error| {
        execution_error(
            "execution_failed",
            "выполнение",
            &format!("Не удалось запустить `{}`: {error}", payload.target),
            Some(preview.encoded_key.clone()),
            action_id,
        )
    })
}

fn validate_launch_request(
    payload: &crate::config::LaunchActionPayload,
) -> Result<LaunchRequest, String> {
    let target = PathBuf::from(&payload.target);
    if !target.is_absolute() {
        return Err("Цель запуска должна быть абсолютным путём.".into());
    }
    if !target.exists() {
        return Err(format!(
            "Цель запуска `{}` не существует.",
            payload.target
        ));
    }
    if target.is_dir() {
        return Err(format!(
            "Цель запуска `{}` — это директория, а не файл.",
            payload.target
        ));
    }

    let working_dir = payload
        .working_dir
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);

    if let Some(working_dir) = &working_dir {
        if !working_dir.is_absolute() {
            return Err("Рабочая директория должна быть абсолютным путём.".into());
        }
        if !working_dir.exists() {
            return Err(format!(
                "Рабочая директория `{}` не существует.",
                working_dir.display()
            ));
        }
        if !working_dir.is_dir() {
            return Err(format!(
                "Рабочая директория `{}` — не директория.",
                working_dir.display()
            ));
        }
    }

    Ok(LaunchRequest {
        target,
        working_dir,
    })
}

fn summarize_text_snippet(
    config: &AppConfig,
    payload: &TextSnippetPayload,
) -> Result<(ExecutionOutcome, String, Vec<String>), String> {
    let live_text = resolve_live_text_snippet(config, payload)?;
    Ok((
        ExecutionOutcome::Simulated,
        format!(
            "Вставит {} через {}.",
            live_text.target_label,
            paste_mode_name(live_text.paste_mode)
        ),
        live_text.warnings,
    ))
}

struct ResolvedLiveTextSnippet {
    text: String,
    paste_mode: PasteMode,
    target_label: String,
    summary: String,
    warnings: Vec<String>,
}

fn resolve_live_text_snippet(
    config: &AppConfig,
    payload: &TextSnippetPayload,
) -> Result<ResolvedLiveTextSnippet, String> {
    match payload {
        TextSnippetPayload::Inline {
            text,
            paste_mode,
            tags,
        } => Ok(ResolvedLiveTextSnippet {
            text: text.clone(),
            paste_mode: *paste_mode,
            target_label: format!("инлайн-сниппет ({} симв.)", text.chars().count()),
            summary: format!(
                "Отправлен инлайн-сниппет ({} симв.) через {}.",
                text.chars().count(),
                paste_mode_name(*paste_mode)
            ),
            warnings: snippet_tag_warnings(tags),
        }),
        TextSnippetPayload::LibraryRef { snippet_id } => {
            let snippet = config
                .snippet_library
                .iter()
                .find(|candidate| candidate.id == *snippet_id)
                .ok_or_else(|| format!("Сниппет `{snippet_id}` не найден в библиотеке."))?;

            Ok(ResolvedLiveTextSnippet {
                text: snippet.text.clone(),
                paste_mode: snippet.paste_mode,
                target_label: format!(
                    "сниппет `{}` ({} симв.)",
                    snippet.name,
                    snippet.text.chars().count()
                ),
                summary: format!(
                    "Отправлен сниппет `{}` ({} симв.) через {}.",
                    snippet.name,
                    snippet.text.chars().count(),
                    paste_mode_name(snippet.paste_mode)
                ),
                warnings: snippet_tag_warnings(&snippet.tags),
            })
        }
    }
}

fn snippet_tag_warnings(tags: &[String]) -> Vec<String> {
    if tags.is_empty() {
        Vec::new()
    } else {
        vec![format!("Сниппет содержит теги: {}.", tags.join(", "))]
    }
}

fn count_enabled_menu_items(items: &[MenuItem]) -> usize {
    items
        .iter()
        .map(|item| match item {
            MenuItem::Action { enabled, .. } => usize::from(*enabled),
            MenuItem::Submenu { enabled, items, .. } => {
                usize::from(*enabled) + count_enabled_menu_items(items)
            }
        })
        .sum()
}

fn sequence_step_summary(step: &SequenceStep) -> String {
    match step {
        SequenceStep::Send { value, .. } => format!("шорткат `{value}`"),
        SequenceStep::Text { value, .. } => format!("текст {} симв.", value.chars().count()),
        SequenceStep::Sleep { delay_ms } => format!("пауза {delay_ms}мс"),
        SequenceStep::Launch { value, .. } => format!("запуск `{value}`"),
    }
}

fn format_shortcut(payload: &crate::config::ShortcutActionPayload) -> String {
    let mut parts = Vec::new();
    if payload.ctrl {
        parts.push("Ctrl");
    }
    if payload.shift {
        parts.push("Shift");
    }
    if payload.alt {
        parts.push("Alt");
    }
    if payload.win {
        parts.push("Win");
    }
    if !payload.key.trim().is_empty() {
        parts.push(payload.key.as_str());
    }
    parts.join(" + ")
}

fn paste_mode_name(paste_mode: PasteMode) -> &'static str {
    match paste_mode {
        PasteMode::ClipboardPaste => "буфер обмена",
        PasteMode::SendText => "ввод текста",
    }
}

/// Evaluate whether all conditions on an action are satisfied.
/// `exe` and `title` are the active window context at time of execution.
#[allow(dead_code)]
pub fn evaluate_conditions(conditions: &[ActionCondition], exe: &str, title: &str) -> bool {
    // Empty conditions = always pass
    if conditions.is_empty() {
        return true;
    }

    conditions.iter().all(|condition| match condition {
        ActionCondition::WindowTitleContains { value } => {
            title.to_lowercase().contains(&value.to_lowercase())
        }
        ActionCondition::WindowTitleNotContains { value } => {
            !title.to_lowercase().contains(&value.to_lowercase())
        }
        ActionCondition::ExeEquals { value } => exe.eq_ignore_ascii_case(value),
        ActionCondition::ExeNotEquals { value } => !exe.eq_ignore_ascii_case(value),
    })
}

fn execution_error(
    code: &'static str,
    category: &str,
    message: &str,
    encoded_key: Option<String>,
    action_id: Option<String>,
) -> ExecutorError {
    ExecutorError {
        code,
        event: RuntimeErrorEvent {
            category: category.into(),
            message: message.into(),
            encoded_key,
            action_id,
            created_at: timestamp_millis(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{default_seed_config, ActionCondition},
        resolver::{resolve_input_preview, ResolutionStatus},
    };

    #[test]
    fn execute_preview_action_simulates_shortcut() {
        let config = default_seed_config();
        let preview = resolve_input_preview(&config, "F13", "WINWORD.EXE", "Document");

        let result = execute_preview_action(&config, &preview).expect("expected execution result");

        assert_eq!(result.outcome, ExecutionOutcome::Simulated);
        assert_eq!(result.action_type, "shortcut");
        assert!(result.summary.contains("Отправит шорткат"));
    }

    #[test]
    fn execute_preview_action_blocks_unresolved_preview() {
        let config = default_seed_config();
        let preview = resolve_input_preview(&config, "UNKNOWN", "WINWORD.EXE", "Document");

        let error = execute_preview_action(&config, &preview).expect_err("expected blocked");

        assert_eq!(preview.status, ResolutionStatus::Unresolved);
        assert_eq!(error.code, "execution_blocked");
        assert_eq!(error.event.encoded_key.as_deref(), Some("UNKNOWN"));
    }

    #[test]
    fn execute_preview_action_errors_when_library_ref_is_missing() {
        let mut config = default_seed_config();
        let action_id = config
            .actions
            .iter()
            .find(|candidate| candidate.pretty == "Ask Me")
            .map(|candidate| candidate.id.clone())
            .expect("expected seed action");
        let action = config
            .actions
            .iter_mut()
            .find(|candidate| candidate.id == action_id)
            .expect("expected mutable seed action");
        action.action_type = ActionType::TextSnippet;
        action.payload = ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef {
            snippet_id: "missing-snippet".into(),
        });

        let preview = ResolvedInputPreview {
            status: ResolutionStatus::Resolved,
            encoded_key: "F13".into(),
            reason: "Resolved".into(),
            matched_app_mapping_id: Some("app-codex".into()),
            resolved_profile_id: Some("code".into()),
            resolved_profile_name: Some("Code".into()),
            used_fallback_profile: false,
            candidate_app_mapping_ids: vec!["app-code".into()],
            candidate_control_ids: vec!["thumb_01".into()],
            control_id: Some("thumb_01".into()),
            layer: Some("hypershift".into()),
            binding_id: Some("binding-code-hypershift-thumb-01".into()),
            binding_label: Some("Ask Me".into()),
            action_id: Some(action_id.clone()),
            action_type: Some("textSnippet".into()),
            action_pretty: Some("Ask Me".into()),
            mapping_verified: Some(true),
            mapping_source: Some("detected".into()),
            trigger_mode: None,
        };

        let error = execute_preview_action(&config, &preview).expect_err("expected failure");

        assert_eq!(error.code, "execution_failed");
        assert_eq!(error.event.action_id.as_deref(), Some(action_id.as_str()));
    }

    #[test]
    fn run_preview_action_rejects_unsupported_menu_actions() {
        let mut config = default_seed_config();
        let preview = resolve_input_preview(&config, "F13", "WINWORD.EXE", "Document");
        let action_id = preview
            .action_id
            .clone()
            .expect("expected resolved action id");
        let action = config
            .actions
            .iter_mut()
            .find(|candidate| candidate.id == action_id)
            .expect("expected mutable action");
        action.action_type = ActionType::Menu;
        action.payload = ActionPayload::Menu(crate::config::MenuActionPayload {
            items: vec![MenuItem::Action {
                id: "item-1".into(),
                label: "Copy".into(),
                action_ref: "action-default-standard-thumb-01".into(),
                enabled: true,
            }],
        });

        let error = run_preview_action(&config, &preview).expect_err("expected rejection");

        assert_eq!(error.code, "unsupported_live_execution");
    }

    #[test]
    fn validate_launch_request_requires_absolute_path() {
        let payload = crate::config::LaunchActionPayload {
            target: "notepad.exe".into(),
            args: Vec::new(),
            working_dir: None,
        };

        let error = validate_launch_request(&payload).expect_err("expected invalid");

        assert!(error.contains("абсолютным путём"));
    }

    #[test]
    fn validate_launch_request_accepts_existing_absolute_target() {
        let payload = crate::config::LaunchActionPayload {
            target: std::env::current_exe()
                .expect("expected current exe")
                .display()
                .to_string(),
            args: Vec::new(),
            working_dir: Some(
                std::env::current_dir()
                    .expect("expected current dir")
                    .display()
                    .to_string(),
            ),
        };

        let request = validate_launch_request(&payload).expect("expected valid launch");

        assert!(request.target.is_absolute());
        assert!(request.working_dir.is_some());
    }

    #[test]
    fn validate_live_sequence_rejects_invalid_send_steps() {
        let payload = crate::config::SequenceActionPayload {
            steps: vec![SequenceStep::Send {
                value: "Ctrl+F13+F14".into(),
                delay_ms: None,
            }],
        };

        let error = validate_live_sequence(&payload).expect_err("expected invalid sequence");

        assert!(error.contains("поддерживаемым шорткатом"));
    }

    #[test]
    fn validate_live_sequence_accepts_send_steps() {
        let payload = crate::config::SequenceActionPayload {
            steps: vec![SequenceStep::Send {
                value: "Ctrl+C".into(),
                delay_ms: Some(1),
            }],
        };

        validate_live_sequence(&payload).expect("expected send support");
    }

    #[test]
    fn validate_live_sequence_accepts_text_steps() {
        let payload = crate::config::SequenceActionPayload {
            steps: vec![SequenceStep::Text {
                value: "hello".into(),
                delay_ms: Some(1),
            }],
        };

        validate_live_sequence(&payload).expect("expected text support");
    }

    #[test]
    fn validate_live_sequence_accepts_sleep_and_launch_steps() {
        let payload = crate::config::SequenceActionPayload {
            steps: vec![
                SequenceStep::Sleep { delay_ms: 1 },
                SequenceStep::Launch {
                    value: std::env::current_exe()
                        .expect("expected current exe")
                        .display()
                        .to_string(),
                    args: Vec::new(),
                    working_dir: Some(
                        std::env::current_dir()
                            .expect("expected current dir")
                            .display()
                            .to_string(),
                    ),
                    delay_ms: Some(1),
                },
            ],
        };

        validate_live_sequence(&payload).expect("expected live sequence support");
    }

    #[test]
    fn evaluate_conditions_empty_always_passes() {
        assert!(evaluate_conditions(&[], "code.exe", "main.rs - VSCode"));
    }

    #[test]
    fn evaluate_conditions_title_contains_match() {
        let conditions = vec![ActionCondition::WindowTitleContains {
            value: "VSCode".into(),
        }];
        assert!(evaluate_conditions(
            &conditions,
            "code.exe",
            "main.rs - VSCode"
        ));
    }

    #[test]
    fn evaluate_conditions_title_contains_case_insensitive() {
        let conditions = vec![ActionCondition::WindowTitleContains {
            value: "vscode".into(),
        }];
        assert!(evaluate_conditions(
            &conditions,
            "code.exe",
            "main.rs - VSCode"
        ));
    }

    #[test]
    fn evaluate_conditions_title_contains_no_match() {
        let conditions = vec![ActionCondition::WindowTitleContains {
            value: "Notepad".into(),
        }];
        assert!(!evaluate_conditions(
            &conditions,
            "code.exe",
            "main.rs - VSCode"
        ));
    }

    #[test]
    fn evaluate_conditions_title_not_contains() {
        let conditions = vec![ActionCondition::WindowTitleNotContains {
            value: "Notepad".into(),
        }];
        assert!(evaluate_conditions(
            &conditions,
            "code.exe",
            "main.rs - VSCode"
        ));
    }

    #[test]
    fn evaluate_conditions_exe_equals() {
        let conditions = vec![ActionCondition::ExeEquals {
            value: "code.exe".into(),
        }];
        assert!(evaluate_conditions(&conditions, "code.exe", "anything"));
    }

    #[test]
    fn evaluate_conditions_exe_equals_case_insensitive() {
        let conditions = vec![ActionCondition::ExeEquals {
            value: "Code.EXE".into(),
        }];
        assert!(evaluate_conditions(&conditions, "code.exe", "anything"));
    }

    #[test]
    fn evaluate_conditions_exe_not_equals() {
        let conditions = vec![ActionCondition::ExeNotEquals {
            value: "explorer.exe".into(),
        }];
        assert!(evaluate_conditions(&conditions, "code.exe", "anything"));
    }

    #[test]
    fn evaluate_conditions_multiple_all_must_pass() {
        let conditions = vec![
            ActionCondition::WindowTitleContains {
                value: "VSCode".into(),
            },
            ActionCondition::ExeEquals {
                value: "code.exe".into(),
            },
        ];
        assert!(evaluate_conditions(
            &conditions,
            "code.exe",
            "main.rs - VSCode"
        ));
    }

    #[test]
    fn evaluate_conditions_multiple_one_fails() {
        let conditions = vec![
            ActionCondition::WindowTitleContains {
                value: "VSCode".into(),
            },
            ActionCondition::ExeEquals {
                value: "notepad.exe".into(),
            },
        ];
        assert!(!evaluate_conditions(
            &conditions,
            "code.exe",
            "main.rs - VSCode"
        ));
    }
}
