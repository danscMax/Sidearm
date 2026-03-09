use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    clipboard,
    config::{
        Action, ActionPayload, ActionType, AppConfig, MenuItem, PasteMode, SequenceStep,
        TextSnippetPayload,
    },
    input_synthesis,
    resolver::{ResolvedInputPreview, ResolutionStatus},
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
            "execution",
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
                "execution",
                "Resolved preview is missing action id.",
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
                "execution",
                &format!("Resolved action `{action_id}` no longer exists in config."),
                Some(preview.encoded_key.clone()),
                Some(action_id.clone()),
            )
        })?;

    let (outcome, summary, warnings) = summarize_action(config, action).map_err(|message| {
        execution_error(
            "execution_failed",
            "execution",
            &message,
            Some(preview.encoded_key.clone()),
            Some(action_id.clone()),
        )
    })?;

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action_type_name(action.action_type).into(),
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
            "execution",
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
                "execution",
                "Resolved preview is missing action id.",
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
                "execution",
                &format!("Resolved action `{action_id}` no longer exists in config."),
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
        (ActionType::Disabled, ActionPayload::Disabled(_)) => Ok(ActionExecutionEvent {
            encoded_key: preview.encoded_key.clone(),
            action_id: action.id.clone(),
            action_type: action_type_name(action.action_type).into(),
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
            summary: "Disabled action results in a live no-op.".into(),
            warnings: Vec::new(),
            executed_at: timestamp_millis(),
        }),
        _ => Err(execution_error(
            "unsupported_live_execution",
            "execution",
            "Live execution is currently implemented for `shortcut`, `textSnippet` with `sendText`, `launch`, `disabled`, and `sequence` actions composed of supported live steps.",
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
            format!("Would send shortcut `{}`.", format_shortcut(payload)),
            Vec::new(),
        )),
        (ActionType::TextSnippet, ActionPayload::TextSnippet(payload)) => {
            summarize_text_snippet(config, payload)
        }
        (ActionType::Sequence, ActionPayload::Sequence(payload)) => Ok((
            ExecutionOutcome::Simulated,
            format!(
                "Would execute sequence with {} step(s): {}.",
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
                warnings.push("Launch target path does not currently exist.".into());
            }

            Ok((
                ExecutionOutcome::Simulated,
                format!(
                    "Would launch `{}`{}.",
                    payload.target,
                    if payload.args.is_empty() {
                        String::new()
                    } else {
                        format!(" with {} arg(s)", payload.args.len())
                    }
                ),
                warnings,
            ))
        }
        (ActionType::Menu, ActionPayload::Menu(payload)) => Ok((
            ExecutionOutcome::Simulated,
            format!(
                "Would open menu with {} root item(s) and {} enabled item(s).",
                payload.items.len(),
                count_enabled_menu_items(&payload.items)
            ),
            Vec::new(),
        )),
        (ActionType::Disabled, ActionPayload::Disabled(_)) => Ok((
            ExecutionOutcome::Noop,
            "Disabled action results in a no-op.".into(),
            Vec::new(),
        )),
        _ => Err(format!(
            "Action `{}` has mismatched type/payload combination.",
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
        action_type: action_type_name(action.action_type).into(),
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
        summary: format!("Launched `{}`.", payload.target),
        warnings: Vec::new(),
        executed_at: timestamp_millis(),
    })
}

fn run_live_sequence_action(
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &crate::config::SequenceActionPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    validate_live_sequence(payload).map_err(|message| {
        execution_error(
            "unsupported_live_execution",
            "execution",
            &message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    let mut launched_processes = Vec::new();
    let mut injected_input_steps = 0usize;
    for step in &payload.steps {
        match step {
            SequenceStep::Sleep { delay_ms } => {
                thread::sleep(Duration::from_millis(u64::from(*delay_ms)));
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
                    thread::sleep(Duration::from_millis(u64::from(*delay_ms)));
                }
            }
            SequenceStep::Text { value, delay_ms } => {
                input_synthesis::send_text(value).map_err(|message| {
                    execution_error(
                        "execution_failed",
                        "execution",
                        &message,
                        Some(preview.encoded_key.clone()),
                        action_id.clone(),
                    )
                })?;
                injected_input_steps += 1;
                if let Some(delay_ms) = delay_ms {
                    thread::sleep(Duration::from_millis(u64::from(*delay_ms)));
                }
            }
            SequenceStep::Send { value, delay_ms } => {
                input_synthesis::send_hotkey_string(value).map_err(|message| {
                    execution_error(
                        "execution_failed",
                        "execution",
                        &message,
                        Some(preview.encoded_key.clone()),
                        action_id.clone(),
                    )
                })?;
                injected_input_steps += 1;
                if let Some(delay_ms) = delay_ms {
                    thread::sleep(Duration::from_millis(u64::from(*delay_ms)));
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
            "Sequence launched {} processes; only the last process id is surfaced in this event.",
            launched_processes.len()
        ));
    }

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action_type_name(action.action_type).into(),
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
            "Executed live sequence with {} injected input step(s) and {} launch step(s).",
            injected_input_steps,
            launched_processes.len()
        ),
        warnings,
        executed_at: timestamp_millis(),
    })
}

fn validate_live_sequence(
    payload: &crate::config::SequenceActionPayload,
) -> Result<(), String> {
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
                        "Live sequence execution does not support text steps containing NUL characters."
                            .into(),
                    );
                }
            }
            SequenceStep::Send { value, .. } => {
                crate::hotkeys::parse_hotkey(value).map_err(|message| {
                    format!("Live sequence send step `{value}` is not a supported hotkey: {message}")
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
    let dispatch = input_synthesis::send_shortcut(payload).map_err(|message| {
        execution_error(
            "execution_failed",
            "execution",
            &message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action_type_name(action.action_type).into(),
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
        summary: format!("Sent shortcut `{}`.", format_shortcut(payload)),
        warnings: dispatch.warnings,
        executed_at: timestamp_millis(),
    })
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
            "execution",
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
                    "execution",
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
                    "execution",
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
        action_type: action_type_name(action.action_type).into(),
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

fn spawn_launch_target(
    payload: &crate::config::LaunchActionPayload,
    preview: &ResolvedInputPreview,
    action_id: Option<String>,
) -> Result<u32, ExecutorError> {
    let launch_request = validate_launch_request(payload).map_err(|message| {
        execution_error(
            "execution_failed",
            "execution",
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

    command
        .spawn()
        .map(|child| child.id())
        .map_err(|error| {
            execution_error(
                "execution_failed",
                "execution",
                &format!("Failed to launch `{}`: {error}", payload.target),
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
        return Err("Launch target must be an absolute path for live execution.".into());
    }
    if !target.exists() {
        return Err(format!("Launch target `{}` does not exist.", payload.target));
    }
    if target.is_dir() {
        return Err(format!("Launch target `{}` points to a directory.", payload.target));
    }

    let working_dir = payload
        .working_dir
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);

    if let Some(working_dir) = &working_dir {
        if !working_dir.is_absolute() {
            return Err("Working directory must be an absolute path for live execution.".into());
        }
        if !working_dir.exists() {
            return Err(format!(
                "Working directory `{}` does not exist.",
                working_dir.display()
            ));
        }
        if !working_dir.is_dir() {
            return Err(format!(
                "Working directory `{}` is not a directory.",
                working_dir.display()
            ));
        }
    }

    Ok(LaunchRequest { target, working_dir })
}

fn summarize_text_snippet(
    config: &AppConfig,
    payload: &TextSnippetPayload,
) -> Result<(ExecutionOutcome, String, Vec<String>), String> {
    let live_text = resolve_live_text_snippet(config, payload)?;
    Ok((
        ExecutionOutcome::Simulated,
        format!(
            "Would insert {} via {}.",
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
            target_label: format!("inline snippet ({} chars)", text.chars().count()),
            summary: format!(
                "Sent inline snippet ({} chars) via {}.",
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
                .ok_or_else(|| format!("textSnippet references missing snippet `{snippet_id}`."))?;

            Ok(ResolvedLiveTextSnippet {
                text: snippet.text.clone(),
                paste_mode: snippet.paste_mode,
                target_label: format!(
                    "library snippet `{}` ({} chars)",
                    snippet.name,
                    snippet.text.chars().count()
                ),
                summary: format!(
                    "Sent library snippet `{}` ({} chars) via {}.",
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
        vec![format!("Snippet carries tags: {}.", tags.join(", "))]
    }
}

fn count_enabled_menu_items(items: &[MenuItem]) -> usize {
    items.iter()
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
        SequenceStep::Send { value, .. } => format!("send `{value}`"),
        SequenceStep::Text { value, .. } => format!("text {} chars", value.chars().count()),
        SequenceStep::Sleep { delay_ms } => format!("sleep {delay_ms}ms"),
        SequenceStep::Launch { value, .. } => format!("launch `{value}`"),
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
    parts.push(payload.key.as_str());
    parts.join(" + ")
}

fn action_type_name(action_type: ActionType) -> &'static str {
    match action_type {
        ActionType::Shortcut => "shortcut",
        ActionType::TextSnippet => "textSnippet",
        ActionType::Sequence => "sequence",
        ActionType::Launch => "launch",
        ActionType::Menu => "menu",
        ActionType::Disabled => "disabled",
    }
}

fn paste_mode_name(paste_mode: PasteMode) -> &'static str {
    match paste_mode {
        PasteMode::ClipboardPaste => "clipboardPaste",
        PasteMode::SendText => "sendText",
    }
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

fn timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::default_seed_config,
        resolver::{resolve_input_preview, ResolutionStatus},
    };

    #[test]
    fn execute_preview_action_simulates_shortcut() {
        let config = default_seed_config();
        let preview = resolve_input_preview(&config, "F13", "WINWORD.EXE", "Document");

        let result = execute_preview_action(&config, &preview).expect("expected execution result");

        assert_eq!(result.outcome, ExecutionOutcome::Simulated);
        assert_eq!(result.action_type, "shortcut");
        assert!(result.summary.contains("Would send shortcut"));
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

        assert!(error.contains("absolute path"));
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

        assert!(error.contains("supported hotkey"));
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
}
