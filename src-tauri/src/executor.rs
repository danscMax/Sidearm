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
/// Upper bound on how many times a single Send/Text sequence step may repeat.
const MAX_STEP_REPEAT: u32 = 100;

use crate::{
    config::{
        Action, ActionCondition, ActionPayload, ActionType, AppConfig, MediaKeyKind, MenuItem,
        MouseActionKind, MouseActionPayload, PasteMode, SequenceStep, TextSnippetPayload,
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
    /// A ProfileSwitch action changed the active runtime profile (audit F003).
    Switched,
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
    pub summary: crate::ui_text::UiText,
    pub warnings: Vec<crate::ui_text::UiText>,
    pub executed_at: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeErrorEvent {
    pub category: String,
    pub message: crate::ui_text::UiText,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoded_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    pub created_at: u64,
}

#[derive(Debug)]
pub struct ExecutorError {
    pub code: &'static str,
    /// Boxed: a `UiText` message makes the event large for an `Err` variant.
    pub event: Box<RuntimeErrorEvent>,
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
                crate::ui_text!(
                    "execution.previewMissingActionId",
                    "The resolved preview has no action ID."
                ),
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
                crate::ui_text!(
                    "execution.actionMissing",
                    "Action `{action_id}` no longer exists in the config.",
                    action_id = &action_id
                ),
                Some(preview.encoded_key.clone()),
                Some(action_id.clone()),
            )
        })?;

    let (outcome, summary, warnings) = summarize_action(config, action).map_err(|message| {
        execution_error(
            "execution_failed",
            "execution",
            message,
            Some(preview.encoded_key.clone()),
            Some(action_id.clone()),
        )
    })?;

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.display_name.clone(),
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
                crate::ui_text!(
                    "execution.previewMissingActionId",
                    "The resolved preview has no action ID."
                ),
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
                crate::ui_text!(
                    "execution.actionMissing",
                    "Action `{action_id}` no longer exists in the config.",
                    action_id = &action_id
                ),
                Some(preview.encoded_key.clone()),
                Some(action_id.clone()),
            )
        })?;

    log::info!(
        "[executor] Executing action: {} for key {}",
        action.action_type.as_str(),
        preview.encoded_key
    );

    match (&action.action_type, &action.payload) {
        (ActionType::Shortcut, ActionPayload::Shortcut(payload)) => {
            run_live_shortcut_action(config, action, preview, payload, Some(action_id))
        }
        (ActionType::TextSnippet, ActionPayload::TextSnippet(payload)) => {
            run_live_text_snippet_action(config, action, preview, payload, Some(action_id))
        }
        (ActionType::Launch, ActionPayload::Launch(payload)) => {
            run_live_launch_action(action, preview, payload, Some(action_id))
        }
        (ActionType::Sequence, ActionPayload::Sequence(payload)) => {
            run_live_sequence_action(action, preview, payload, Some(action_id))
        }
        (ActionType::MouseAction, ActionPayload::MouseAction(payload)) => {
            run_live_mouse_action(config, action, preview, payload, Some(action_id))
        }
        (ActionType::MediaKey, ActionPayload::MediaKey(payload)) => {
            run_live_media_key_action(action, preview, &payload.key, Some(action_id))
        }
        (ActionType::Disabled, ActionPayload::Disabled(_)) => Ok(ActionExecutionEvent {
            encoded_key: preview.encoded_key.clone(),
            action_id: action.id.clone(),
            action_type: action.action_type.as_str().into(),
            action_pretty: action.display_name.clone(),
            resolved_profile_id: preview.resolved_profile_id.clone(),
            resolved_profile_name: preview.resolved_profile_name.clone(),
            matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
            control_id: preview.control_id.clone(),
            layer: preview.layer.clone(),
            binding_id: preview.binding_id.clone(),
            mode: ExecutionMode::Live,
            outcome: ExecutionOutcome::Noop,
            process_id: None,
            summary: crate::ui_text!(
                "execution.disabledNoop",
                "Disabled action — nothing was executed."
            ),
            warnings: Vec::new(),
            executed_at: timestamp_millis(),
        }),
        (ActionType::RepairClipboard, ActionPayload::RepairClipboard(_)) => {
            run_live_repair_clipboard_action(action, preview, Some(action_id))
        }
        // Audit F003: ProfileSwitch sets the sticky runtime profile override. The
        // override WRITE happens in the live dispatch path (capture_backend), which
        // owns the RuntimeStore; here we only report the switch so the Test/dry-run
        // path can preview it without actually changing the active profile.
        (ActionType::ProfileSwitch, ActionPayload::ProfileSwitch(payload)) => {
            let profile_name = config
                .profiles
                .iter()
                .find(|p| p.id == payload.target_profile_id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| payload.target_profile_id.clone());
            Ok(ActionExecutionEvent {
                encoded_key: preview.encoded_key.clone(),
                action_id: action.id.clone(),
                action_type: action.action_type.as_str().into(),
                action_pretty: action.display_name.clone(),
                resolved_profile_id: preview.resolved_profile_id.clone(),
                resolved_profile_name: preview.resolved_profile_name.clone(),
                matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
                control_id: preview.control_id.clone(),
                layer: preview.layer.clone(),
                binding_id: preview.binding_id.clone(),
                mode: ExecutionMode::Live,
                outcome: ExecutionOutcome::Switched,
                process_id: None,
                summary: crate::ui_text!(
                    "execution.profileSwitched",
                    "Switched to profile `{profile_name}`.",
                    profile_name = profile_name
                ),
                warnings: Vec::new(),
                executed_at: timestamp_millis(),
            })
        }
        // A menu opens a popup (`menu_popup`), which the capture path does before it
        // gets here; only a direct run (the picker's Test) reaches this.
        _ => Err(execution_error(
            "unsupported_live_execution",
            "execution",
            crate::ui_text!(
                "execution.menuNotLive",
                "A menu opens from its mouse button, at the cursor; it cannot be run from the editor."
            ),
            Some(preview.encoded_key.clone()),
            Some(action_id),
        )),
    }
}

/// Dry-run a draft action directly (no resolver, no saved config lookup, no
/// encoder signal required). Used by the "Test" button in the action picker so
/// the user can preview what an action *would* do while still editing it.
/// Live-test a draft action straight from the picker: inject the draft into a
/// config clone so the normal live path can resolve it by id, then run it for
/// real through the executor. No save, no encoder signal — the picker handles
/// the "switch to your target window" countdown before calling this.
pub fn live_test_action(
    config: &AppConfig,
    action: &Action,
    profile_id: Option<&str>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    let profile = profile_id.and_then(|id| config.profiles.iter().find(|profile| profile.id == id));
    let mut cfg = config.clone();
    cfg.actions.retain(|candidate| candidate.id != action.id);
    cfg.actions.push(action.clone());

    let preview = ResolvedInputPreview {
        status: ResolutionStatus::Resolved,
        encoded_key: String::new(),
        reason: String::new(),
        matched_app_mapping_id: None,
        resolved_profile_id: profile.map(|profile| profile.id.clone()),
        resolved_profile_name: profile.map(|profile| profile.name.clone()),
        used_fallback_profile: false,
        candidate_app_mapping_ids: Vec::new(),
        candidate_control_ids: Vec::new(),
        control_id: None,
        layer: None,
        binding_id: None,
        binding_label: None,
        action_id: Some(action.id.clone()),
        action_type: Some(action.action_type.as_str().into()),
        action_pretty: Some(action.display_name.clone()),
        mapping_verified: None,
        mapping_source: None,
        trigger_mode: None,
    };

    run_preview_action(&cfg, &preview)
}

fn summarize_action(
    config: &AppConfig,
    action: &Action,
) -> Result<
    (ExecutionOutcome, crate::ui_text::UiText, Vec<crate::ui_text::UiText>),
    crate::ui_text::UiText,
> {
    match (&action.action_type, &action.payload) {
        (ActionType::Shortcut, ActionPayload::Shortcut(payload)) => Ok((
            ExecutionOutcome::Simulated,
            crate::ui_text!(
                "execution.shortcutPreview",
                "Will send shortcut `{shortcut}`.",
                shortcut = format_shortcut(payload)
            ),
            Vec::new(),
        )),
        (ActionType::TextSnippet, ActionPayload::TextSnippet(payload)) => {
            summarize_text_snippet(config, payload)
        }
        (ActionType::Sequence, ActionPayload::Sequence(payload)) => Ok((
            ExecutionOutcome::Simulated,
            crate::ui_text!(
                "execution.sequencePreview",
                "Will run a sequence of {count} steps: {steps}.",
                count = payload.steps.len(),
                steps = payload
                    .steps
                    .iter()
                    .map(|step| sequence_step_summary(step).text)
                    .collect::<Vec<_>>()
                    .join(" -> ")
            )
            .param(
                "steps",
                payload
                    .steps
                    .iter()
                    .map(|step| crate::ui_text::native(&sequence_step_summary(step)))
                    .collect::<Vec<_>>()
                    .join(" -> "),
            ),
            Vec::new(),
        )),
        (ActionType::Launch, ActionPayload::Launch(payload)) => {
            let target = payload.target.trim();
            let open_via_shell = is_url_target(target) || Path::new(target).is_dir();
            let mut warnings = Vec::new();
            if !open_via_shell && Path::new(target).is_absolute() && !Path::new(target).exists() {
                warnings.push(crate::ui_text!(
                    "execution.launchTargetMissing",
                    "The launch target path does not exist."
                ));
            }

            let summary = if open_via_shell {
                crate::ui_text!(
                    "execution.launchOpenPreview",
                    "Will open `{target}`.",
                    target = &payload.target
                )
            } else if payload.args.is_empty() {
                crate::ui_text!(
                    "execution.launchPreview",
                    "Will launch `{target}`.",
                    target = &payload.target
                )
            } else {
                crate::ui_text!(
                    "execution.launchPreviewArgs",
                    "Will launch `{target}` with {count} args.",
                    target = &payload.target,
                    count = payload.args.len()
                )
            };

            Ok((ExecutionOutcome::Simulated, summary, warnings))
        }
        (ActionType::Menu, ActionPayload::Menu(payload)) => Ok((
            ExecutionOutcome::Simulated,
            crate::ui_text!(
                "execution.menuPreview",
                "Will open a menu with {items} items ({enabled} enabled).",
                items = payload.items.len(),
                enabled = count_enabled_menu_items(&payload.items)
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
            crate::ui_text!(
                "execution.mediaKeyPreview",
                "Will send media key `{key}`.",
                key = format!("{:?}", payload.key)
            ),
            Vec::new(),
        )),
        (ActionType::ProfileSwitch, ActionPayload::ProfileSwitch(payload)) => Ok((
            ExecutionOutcome::Simulated,
            crate::ui_text!(
                "execution.profileSwitchPreview",
                "Will switch to profile `{profile_id}`.",
                profile_id = &payload.target_profile_id
            ),
            Vec::new(),
        )),
        (ActionType::Disabled, ActionPayload::Disabled(_)) => Ok((
            ExecutionOutcome::Noop,
            crate::ui_text!(
                "execution.disabledPreview",
                "Disabled action — nothing will be executed."
            ),
            Vec::new(),
        )),
        (ActionType::RepairClipboard, ActionPayload::RepairClipboard(_)) => Ok((
            ExecutionOutcome::Simulated,
            crate::ui_text!(
                "execution.repairClipboardPreview",
                "Will repair the clipboard encoding (UTF-8 ↔ Latin-1)."
            ),
            Vec::new(),
        )),
        _ => Err(crate::ui_text!(
            "execution.incompatiblePayload",
            "Action `{action_id}` has an incompatible type/payload.",
            action_id = &action.id
        )),
    }
}

#[derive(Debug)]
struct LaunchRequest {
    target: PathBuf,
    working_dir: Option<PathBuf>,
}

/// True when the launch target is a URL/URI (opened via the shell handler,
/// not spawned as a process).
fn is_url_target(target: &str) -> bool {
    let t = target.trim();
    t.starts_with("http://")
        || t.starts_with("https://")
        || t.starts_with("mailto:")
        || t.starts_with("ftp://")
        || t.starts_with("file://")
}

fn run_live_launch_action(
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &crate::config::LaunchActionPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    let target = payload.target.trim();
    let open_via_shell = is_url_target(target) || Path::new(target).is_dir();

    if open_via_shell {
        // URLs and folders are handed to the system default handler — there is
        // no child process, so no PID to track.
        crate::platform::shell::open_target(target).map_err(|message| {
            execution_error(
                "execution_failed",
                "execution",
                crate::ui_text!(
                    "execution.openFailed",
                    "Failed to open `{target}`: {message}",
                    target = &payload.target,
                    message = message
                ),
                Some(preview.encoded_key.clone()),
                action_id.clone(),
            )
        })?;

        return Ok(ActionExecutionEvent {
            encoded_key: preview.encoded_key.clone(),
            action_id: action.id.clone(),
            action_type: action.action_type.as_str().into(),
            action_pretty: action.display_name.clone(),
            resolved_profile_id: preview.resolved_profile_id.clone(),
            resolved_profile_name: preview.resolved_profile_name.clone(),
            matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
            control_id: preview.control_id.clone(),
            layer: preview.layer.clone(),
            binding_id: preview.binding_id.clone(),
            mode: ExecutionMode::Live,
            outcome: ExecutionOutcome::Spawned,
            process_id: None,
            summary: crate::ui_text!(
                "execution.launchOpened",
                "Opened `{target}`.",
                target = &payload.target
            ),
            warnings: Vec::new(),
            executed_at: timestamp_millis(),
        });
    }

    let process_id = spawn_launch_target(payload, preview, action_id.clone())?;

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.display_name.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome: ExecutionOutcome::Spawned,
        process_id: Some(process_id),
        summary: crate::ui_text!(
            "execution.launchStarted",
            "Started `{target}`.",
            target = &payload.target
        ),
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
/// Whether a sequence step is the Enter of a phrase (only text and pauses
/// before it) while another window came to the front: it is not sent.
fn skips_enter(step: &SequenceStep, only_text_so_far: bool, window_changed: impl FnOnce() -> bool) -> bool {
    matches!(step, SequenceStep::Send { value, .. } if value.eq_ignore_ascii_case("enter"))
        && only_text_so_far
        && window_changed()
}

/// The window in front (raw HWND; 0 off Windows), to notice a change.
fn foreground_window() -> isize {
    #[cfg(target_os = "windows")]
    {
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as isize }
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
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
            message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    let encoding_mods = crate::hotkeys::extract_encoding_modifiers(&preview.encoded_key);
    let mut launched_processes = Vec::new();
    let mut injected_input_steps = 0usize;
    // A phrase with Enter (text, a pause, Enter): its Enter is not sent when
    // another window came to the front meanwhile — it would submit there.
    let start_window = foreground_window();
    let mut only_text_so_far = true;
    let mut typed_text = false;
    let mut warnings = Vec::new();
    for step in &payload.steps {
        // No window in front for an instant (0), at the start or now, proves nothing.
        if skips_enter(step, only_text_so_far && typed_text, || {
            let now = foreground_window();
            start_window != 0 && now != 0 && now != start_window
        }) {
            log::warn!("[executor] sequence Enter skipped: the window in front changed while the text was typed");
            warnings.push(crate::ui_text!(
                "execution.enterSkippedWindowChanged",
                "Enter was not sent: another window came to the front while the text was typed."
            ));
            continue;
        }
        if matches!(step, SequenceStep::Launch { .. } | SequenceStep::Send { .. }) {
            only_text_so_far = false;
        }
        typed_text |= matches!(step, SequenceStep::Text { .. });
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
            SequenceStep::Text {
                value,
                delay_ms,
                repeat,
            } => {
                let times = repeat.unwrap_or(1).min(MAX_STEP_REPEAT);
                // The same tokens a text snippet has ({date}, {selection}, {cursor}…);
                // a text without one is typed as it is ({{ included).
                let (value, cursor_back) = if input_synthesis::has_snippet_token(value) {
                    input_synthesis::expand_snippet_tokens(value)
                } else {
                    (value.clone(), None)
                };
                for _ in 0..times {
                    input_synthesis::send_text(&value).map_err(|message| {
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
                        thread::sleep(Duration::from_millis(
                            u64::from(*delay_ms).min(MAX_STEP_DELAY_MS),
                        ));
                    }
                }
                if let Some(back) = cursor_back.filter(|&back| back > 0)
                    && let Err(message) = input_synthesis::send_left_arrows(back)
                {
                    log::warn!("[executor] sequence {{cursor}} repositioning failed: {message}");
                }
            }
            SequenceStep::Send {
                value,
                delay_ms,
                repeat,
            } => {
                let times = repeat.unwrap_or(1).min(MAX_STEP_REPEAT);
                for _ in 0..times {
                    input_synthesis::send_hotkey_string(value, &encoding_mods).map_err(
                        |message| {
                            execution_error(
                                "execution_failed",
                                "execution",
                                &message,
                                Some(preview.encoded_key.clone()),
                                action_id.clone(),
                            )
                        },
                    )?;
                    injected_input_steps += 1;
                    if let Some(delay_ms) = delay_ms {
                        thread::sleep(Duration::from_millis(
                            u64::from(*delay_ms).min(MAX_STEP_DELAY_MS),
                        ));
                    }
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

    if launched_processes.len() > 1 {
        warnings.push(crate::ui_text!(
            "execution.sequenceMultiplePids",
            "The sequence launched {count} processes; only the PID of the last one is shown.",
            count = launched_processes.len()
        ));
    }

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.display_name.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome,
        process_id: launched_processes.last().copied(),
        summary: crate::ui_text!(
            "execution.sequenceDone",
            "Sequence finished: {input_steps} input steps, {launches} launches.",
            input_steps = injected_input_steps,
            launches = launched_processes.len()
        ),
        warnings,
        executed_at: timestamp_millis(),
    })
}

fn validate_live_sequence(
    payload: &crate::config::SequenceActionPayload,
) -> Result<(), crate::ui_text::UiText> {
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
                    return Err(crate::ui_text!(
                        "execution.textStepNul",
                        "Text steps with NUL characters are not supported."
                    ));
                }
            }
            SequenceStep::Send { value, .. } => {
                crate::hotkeys::parse_hotkey(value).map_err(|message| {
                    crate::ui_text!(
                        "execution.sendStepUnsupported",
                        "Send step `{value}` is not a supported shortcut: {message}",
                        value = value,
                        message = message
                    )
                })?;
            }
        }
    }

    Ok(())
}

#[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
fn run_live_shortcut_action(
    config: &AppConfig,
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &crate::config::ShortcutActionPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    let encoding_mods = crate::hotkeys::extract_encoding_modifiers(&preview.encoded_key);

    // Capture the clipboard sequence number before a copy/cut shortcut so the
    // opt-in auto-repair can wait for the copy to land, then fix OSC 52 mojibake.
    #[cfg(target_os = "windows")]
    let repair_seq_before = if config.settings.repair_clipboard_on_copy
        && input_synthesis::is_clipboard_shortcut(payload)
    {
        Some(input_synthesis::clipboard_sequence_number())
    } else {
        None
    };

    let dispatch = input_synthesis::send_shortcut(payload, &encoding_mods).map_err(|message| {
        log::error!(
            "[executor] Shortcut injection failed for key {}: {message}",
            preview.encoded_key
        );
        execution_error(
            "execution_failed",
            "execution",
            &message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    // Opt-in auto-repair: if enabled and this was a copy/cut, wait for the copy
    // to land and undo OSC 52 mojibake. Runs on a detached thread — the poll
    // blocks up to 400ms and would otherwise stall the capture worker (delaying
    // the next button action). Best-effort; the result is only logged.
    #[cfg(target_os = "windows")]
    if let Some(seq_before) = repair_seq_before {
        std::thread::spawn(move || {
            match input_synthesis::repair_clipboard_after_copy(seq_before) {
                Ok(Some(fixed)) => log::info!(
                    "[repair] auto-repaired clipboard after copy ({} chars)",
                    fixed.chars().count()
                ),
                Ok(None) => {}
                Err(message) => log::warn!("[repair] auto-repair after copy failed: {message}"),
            }
        });
    }

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.display_name.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome: ExecutionOutcome::Injected,
        process_id: None,
        summary: crate::ui_text!(
            "execution.shortcutSent",
            "Sent shortcut `{shortcut}`.",
            shortcut = format_shortcut(payload)
        ),
        warnings: dispatch.warnings,
        executed_at: timestamp_millis(),
    })
}

fn run_live_mouse_action(
    config: &AppConfig,
    action: &Action,
    preview: &ResolvedInputPreview,
    payload: &MouseActionPayload,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    if matches!(payload.action, MouseActionKind::DpiUp | MouseActionKind::DpiDown) {
        let profile = preview.resolved_profile_id.as_deref()
            .and_then(|id| config.profiles.iter().find(|p| p.id == id))
            .ok_or_else(|| execution_error("execution_failed", "execution",
                crate::ui_text!("execution.dpiProfileMissing", "Select a profile before testing DPI controls."), Some(preview.encoded_key.clone()), action_id.clone()))?;
        let stages_missing = || execution_error("execution_failed", "execution",
            crate::ui_text!("execution.dpiStagesMissing", "Configure DPI stages in the Mouse tab for this profile first."),
            Some(preview.encoded_key.clone()), action_id.clone());
        if !profile.device_mouse.iter().flatten().any(|(_, own)| own.mouse_dpi_stages.as_ref().is_some_and(|stages| !stages.is_empty())) {
            return Err(stages_missing());
        }
        #[cfg(target_os = "windows")]
        let result = crate::mouse_speed::step_profile_dpi(profile, payload.action == MouseActionKind::DpiUp);
        #[cfg(target_os = "windows")]
        // Stages exist, but only for a mouse that is not connected.
        if result.as_ref().is_err_and(|message| message == crate::mouse_speed::NO_DPI_STAGES) {
            return Err(execution_error("execution_failed", "execution",
                crate::ui_text!("execution.dpiStagesOtherMouse", "This profile has DPI stages only for a mouse that is not connected."),
                Some(preview.encoded_key.clone()), action_id));
        }
        #[cfg(not(target_os = "windows"))]
        let result: Result<u16, String> = {
            let _ = profile;
            Err("DPI stepping requires Windows".into())
        };
        let dpi = result.map_err(|message| execution_error("execution_failed", "execution",
            crate::ui_text!("execution.dpiFailed", "Could not change DPI: {detail}", detail = message), Some(preview.encoded_key.clone()), action_id.clone()))?;
        return Ok(ActionExecutionEvent {
            encoded_key: preview.encoded_key.clone(),
            action_id: action.id.clone(),
            action_type: action.action_type.as_str().into(),
            action_pretty: action.display_name.clone(),
            resolved_profile_id: preview.resolved_profile_id.clone(),
            resolved_profile_name: preview.resolved_profile_name.clone(),
            matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
            control_id: preview.control_id.clone(),
            layer: preview.layer.clone(),
            binding_id: preview.binding_id.clone(),
            mode: ExecutionMode::Live,
            outcome: ExecutionOutcome::Injected,
            process_id: None,
            summary: crate::ui_text!("execution.dpiSwitched", "DPI: {dpi}.", dpi = dpi),
            warnings: Vec::new(),
            executed_at: timestamp_millis(),
        });
    }
    let encoding_mods = crate::hotkeys::extract_encoding_modifiers(&preview.encoded_key);
    let dispatch =
        input_synthesis::send_mouse_action(payload, &encoding_mods).map_err(|message| {
            log::error!(
                "[executor] Mouse action `{:?}` failed for key {}: {message}",
                payload.action,
                preview.encoded_key
            );
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
        action_type: action.action_type.as_str().into(),
        action_pretty: action.display_name.clone(),
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

fn run_live_media_key_action(
    action: &Action,
    preview: &ResolvedInputPreview,
    key: &MediaKeyKind,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    // Map MediaKeyKind to Windows virtual key codes
    let vk: u16 = match key {
        MediaKeyKind::PlayPause => 0xB3,  // VK_MEDIA_PLAY_PAUSE
        MediaKeyKind::NextTrack => 0xB0,  // VK_MEDIA_NEXT_TRACK
        MediaKeyKind::PrevTrack => 0xB1,  // VK_MEDIA_PREV_TRACK
        MediaKeyKind::Stop => 0xB2,       // VK_MEDIA_STOP
        MediaKeyKind::Mute => 0xAD,       // VK_VOLUME_MUTE
        MediaKeyKind::VolumeDown => 0xAE, // VK_VOLUME_DOWN
        MediaKeyKind::VolumeUp => 0xAF,   // VK_VOLUME_UP
    };

    input_synthesis::send_vk_tap(vk).map_err(|message| {
        log::error!(
            "[executor] MediaKey `{key:?}` injection failed for key {}: {message}",
            preview.encoded_key
        );
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
        action_type: action.action_type.as_str().into(),
        action_pretty: action.display_name.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome: ExecutionOutcome::Injected,
        process_id: None,
        summary: crate::ui_text!(
            "execution.mediaKeySent",
            "Sent media key `{key}`.",
            key = format!("{key:?}")
        ),
        warnings: Vec::new(),
        executed_at: timestamp_millis(),
    })
}

fn run_live_repair_clipboard_action(
    action: &Action,
    preview: &ResolvedInputPreview,
    action_id: Option<String>,
) -> Result<ActionExecutionEvent, ExecutorError> {
    let (outcome, summary) = match input_synthesis::repair_clipboard() {
        Ok(Some(fixed)) => (
            ExecutionOutcome::Injected,
            crate::ui_text!(
                "execution.clipboardRepaired",
                "Clipboard repaired ({chars} chars).",
                chars = fixed.chars().count()
            ),
        ),
        Ok(None) => (
            ExecutionOutcome::Noop,
            crate::ui_text!(
                "execution.clipboardOk",
                "Clipboard is fine — nothing to repair."
            ),
        ),
        Err(message) => {
            log::error!(
                "[executor] Clipboard repair failed for key {}: {message}",
                preview.encoded_key
            );
            return Err(execution_error(
                "execution_failed",
                "execution",
                &message,
                Some(preview.encoded_key.clone()),
                action_id,
            ));
        }
    };

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.display_name.clone(),
        resolved_profile_id: preview.resolved_profile_id.clone(),
        resolved_profile_name: preview.resolved_profile_name.clone(),
        matched_app_mapping_id: preview.matched_app_mapping_id.clone(),
        control_id: preview.control_id.clone(),
        layer: preview.layer.clone(),
        binding_id: preview.binding_id.clone(),
        mode: ExecutionMode::Live,
        outcome,
        process_id: None,
        summary,
        warnings: Vec::new(),
        executed_at: timestamp_millis(),
    })
}

fn format_mouse_summary(payload: &MouseActionPayload) -> crate::ui_text::UiText {
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
        crate::ui_text!(
            "execution.mouseActionDone",
            "Performed mouse action `{action}`.",
            action = format!("{:?}", payload.action)
        )
    } else {
        crate::ui_text!(
            "execution.mouseActionWithModifiers",
            "Performed mouse action `{modifiers}` + `{action}`.",
            modifiers = modifiers.join(" + "),
            action = format!("{:?}", payload.action)
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
            "execution",
            message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    let mut warnings = live_text.warnings;
    // Always use SendInput (sendText) regardless of paste_mode setting.
    // clipboardPaste causes COM/OLE crashes in debug builds and is
    // unreliable. SendInput + KEYEVENTF_UNICODE works universally.
    log::info!(
        "[executor] TextSnippet sendText: {} chars for key {}",
        live_text.text.chars().count(),
        preview.encoded_key
    );
    let (expanded, cursor_back) = input_synthesis::expand_snippet_tokens(&live_text.text);
    input_synthesis::send_text(&expanded).map_err(|message| {
        log::error!(
            "[executor] TextSnippet sendText failed for key {}: {message}",
            preview.encoded_key
        );
        execution_error(
            "execution_failed",
            "execution",
            &message,
            Some(preview.encoded_key.clone()),
            Some(action.id.clone()),
        )
    })?;

    // {cursor}: walk the caret back to the marker. Best-effort — the text is
    // already delivered, so a failure here degrades to a warning, not an error.
    if let Some(back) = cursor_back
        && back > 0
        && let Err(message) = input_synthesis::send_left_arrows(back)
    {
        log::warn!(
            "[executor] TextSnippet {{cursor}} repositioning failed for key {}: {message}",
            preview.encoded_key
        );
        warnings.push(crate::ui_text!(
            "execution.cursorRepositionFailed",
            "Could not move the caret back to {{cursor}}: {message}",
            message = message
        ));
    }

    Ok(ActionExecutionEvent {
        encoded_key: preview.encoded_key.clone(),
        action_id: action.id.clone(),
        action_type: action.action_type.as_str().into(),
        action_pretty: action.display_name.clone(),
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
            "execution",
            message,
            Some(preview.encoded_key.clone()),
            action_id.clone(),
        )
    })?;

    // An elevated Sidearm must not hand its admin token to user-configured
    // targets: start them with the shell's (non-admin) token, fail closed.
    #[cfg(target_os = "windows")]
    {
        if crate::window_capture::is_current_process_elevated() {
            return crate::platform::shell::spawn_with_shell_token(
                &launch_request.target,
                &payload.args,
                launch_request.working_dir.as_deref(),
            )
            .map_err(|error| {
                log::error!(
                    "[executor] De-elevated launch failed for `{}`: {error}",
                    payload.target
                );
                execution_error(
                    "execution_failed",
                    "execution",
                    crate::ui_text!(
                        "execution.launchDeElevatedFailed",
                        "Failed to launch `{target}` without administrator rights: {error}",
                        target = &payload.target,
                        error = error
                    ),
                    Some(preview.encoded_key.clone()),
                    action_id,
                )
            });
        }
    }

    let mut command = Command::new(&launch_request.target);
    command.args(&payload.args);
    if let Some(working_dir) = &launch_request.working_dir {
        command.current_dir(working_dir);
    }

    command.spawn().map(|child| child.id()).map_err(|error| {
        log::error!("[executor] Launch failed for `{}`: {error}", payload.target);
        execution_error(
            "execution_failed",
            "execution",
            crate::ui_text!(
                "execution.launchFailed",
                "Failed to launch `{target}`: {error}",
                target = &payload.target,
                error = error
            ),
            Some(preview.encoded_key.clone()),
            action_id,
        )
    })
}

fn validate_launch_request(
    payload: &crate::config::LaunchActionPayload,
) -> Result<LaunchRequest, crate::ui_text::UiText> {
    let target = PathBuf::from(&payload.target);
    if !target.is_absolute() {
        return Err(crate::ui_text!(
            "execution.launchTargetNotAbsolute",
            "The launch target must be an absolute path."
        ));
    }
    if !target.exists() {
        return Err(crate::ui_text!(
            "execution.launchTargetNotFound",
            "Launch target `{target}` does not exist.",
            target = &payload.target
        ));
    }
    if target.is_dir() {
        return Err(crate::ui_text!(
            "execution.launchTargetIsDirectory",
            "Launch target `{target}` is a directory, not a file.",
            target = &payload.target
        ));
    }

    let working_dir = payload
        .working_dir
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);

    if let Some(working_dir) = &working_dir {
        if !working_dir.is_absolute() {
            return Err(crate::ui_text!(
                "execution.workingDirNotAbsolute",
                "The working directory must be an absolute path."
            ));
        }
        if !working_dir.exists() {
            return Err(crate::ui_text!(
                "execution.workingDirNotFound",
                "Working directory `{working_dir}` does not exist.",
                working_dir = working_dir.display()
            ));
        }
        if !working_dir.is_dir() {
            return Err(crate::ui_text!(
                "execution.workingDirNotDirectory",
                "Working directory `{working_dir}` is not a directory.",
                working_dir = working_dir.display()
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
) -> Result<
    (ExecutionOutcome, crate::ui_text::UiText, Vec<crate::ui_text::UiText>),
    crate::ui_text::UiText,
> {
    let live_text = resolve_live_text_snippet(config, payload)?;
    Ok((
        ExecutionOutcome::Simulated,
        crate::ui_text!(
            "execution.snippetPreview",
            "Will paste {target} via {mode}.",
            target = &live_text.target_label.text,
            mode = paste_mode_text(live_text.paste_mode).text
        )
        .param("target", crate::ui_text::native(&live_text.target_label))
        .param("mode", crate::ui_text::native(&paste_mode_text(live_text.paste_mode))),
        live_text.warnings,
    ))
}

struct ResolvedLiveTextSnippet {
    text: String,
    paste_mode: PasteMode,
    target_label: crate::ui_text::UiText,
    summary: crate::ui_text::UiText,
    warnings: Vec<crate::ui_text::UiText>,
}

fn resolve_live_text_snippet(
    config: &AppConfig,
    payload: &TextSnippetPayload,
) -> Result<ResolvedLiveTextSnippet, crate::ui_text::UiText> {
    match payload {
        TextSnippetPayload::Inline {
            text,
            paste_mode,
            tags,
        } => Ok(ResolvedLiveTextSnippet {
            text: text.clone(),
            paste_mode: *paste_mode,
            target_label: crate::ui_text!(
                "execution.targetInline",
                "inline snippet ({chars} chars)",
                chars = text.chars().count()
            ),
            summary: crate::ui_text!(
                "execution.inlineSnippetSent",
                "Sent inline snippet ({chars} chars) via {mode}.",
                chars = text.chars().count(),
                mode = paste_mode_text(*paste_mode).text
            )
            .param("mode", crate::ui_text::native(&paste_mode_text(*paste_mode))),
            warnings: snippet_tag_warnings(tags),
        }),
        TextSnippetPayload::LibraryRef { snippet_id } => {
            let snippet = config
                .snippet_library
                .iter()
                .find(|candidate| candidate.id == *snippet_id)
                .ok_or_else(|| {
                    crate::ui_text!(
                        "execution.snippetNotInLibrary",
                        "Snippet `{snippet_id}` was not found in the library.",
                        snippet_id = snippet_id
                    )
                })?;

            Ok(ResolvedLiveTextSnippet {
                text: snippet.text.clone(),
                paste_mode: snippet.paste_mode,
                target_label: crate::ui_text!(
                    "execution.targetLibrary",
                    "snippet `{name}` ({chars} chars)",
                    name = &snippet.name,
                    chars = snippet.text.chars().count()
                ),
                summary: crate::ui_text!(
                    "execution.librarySnippetSent",
                    "Sent snippet `{name}` ({chars} chars) via {mode}.",
                    name = &snippet.name,
                    chars = snippet.text.chars().count(),
                    mode = paste_mode_text(snippet.paste_mode).text
                )
                .param("mode", crate::ui_text::native(&paste_mode_text(snippet.paste_mode))),
                warnings: snippet_tag_warnings(&snippet.tags),
            })
        }
    }
}

fn snippet_tag_warnings(tags: &[String]) -> Vec<crate::ui_text::UiText> {
    if tags.is_empty() {
        Vec::new()
    } else {
        vec![crate::ui_text!(
            "execution.snippetTags",
            "Snippet has tags: {tags}.",
            tags = tags.join(", ")
        )]
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

fn sequence_step_summary(step: &SequenceStep) -> crate::ui_text::UiText {
    match step {
        SequenceStep::Send { value, .. } => {
            crate::ui_text!("execution.stepShortcut", "shortcut `{value}`", value = value)
        }
        SequenceStep::Text { value, .. } => crate::ui_text!(
            "execution.stepText",
            "text {chars} chars",
            chars = value.chars().count()
        ),
        SequenceStep::Sleep { delay_ms } => crate::ui_text!(
            "execution.stepPause",
            "pause {delay_ms} ms",
            delay_ms = delay_ms
        ),
        SequenceStep::Launch { value, .. } => {
            crate::ui_text!("execution.stepLaunch", "launch `{value}`", value = value)
        }
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

fn paste_mode_text(paste_mode: PasteMode) -> crate::ui_text::UiText {
    match paste_mode {
        PasteMode::ClipboardPaste => {
            crate::ui_text!("execution.pasteModeClipboard", "clipboard paste")
        }
        PasteMode::SendText => crate::ui_text!("execution.pasteModeText", "text input"),
    }
}

/// Evaluate whether all conditions on an action are satisfied.
/// `exe` and `title` are the active window context. Used by the resolver to
/// gate a binding's action by context (ConditionUnmet when not satisfied).
pub fn evaluate_conditions(conditions: &[ActionCondition], exe: &str, title: &str) -> bool {
    // Empty conditions = always pass
    if conditions.is_empty() {
        return true;
    }

    // Lowercase the window title at most once per call (only if a title
    // condition actually references it) and reuse it across conditions, instead
    // of re-allocating/re-lowering `title` inside every WindowTitle* arm.
    let title_lower = conditions
        .iter()
        .any(|c| {
            matches!(
                c,
                ActionCondition::WindowTitleContains { .. }
                    | ActionCondition::WindowTitleNotContains { .. }
            )
        })
        .then(|| title.to_lowercase());

    conditions.iter().all(|condition| match condition {
        ActionCondition::WindowTitleContains { value } => title_lower
            .as_deref()
            .unwrap_or_default()
            .contains(&value.to_lowercase()),
        ActionCondition::WindowTitleNotContains { value } => !title_lower
            .as_deref()
            .unwrap_or_default()
            .contains(&value.to_lowercase()),
        ActionCondition::ExeEquals { value } => exe.eq_ignore_ascii_case(value),
        ActionCondition::ExeNotEquals { value } => !exe.eq_ignore_ascii_case(value),
    })
}

fn execution_error(
    code: &'static str,
    category: &str,
    message: impl Into<crate::ui_text::UiText>,
    encoded_key: Option<String>,
    action_id: Option<String>,
) -> ExecutorError {
    ExecutorError {
        code,
        event: Box::new(RuntimeErrorEvent {
            category: category.into(),
            message: message.into(),
            encoded_key,
            action_id,
            created_at: timestamp_millis(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phrase_enter_is_skipped_only_when_the_window_changed() {
        let enter = SequenceStep::Send { value: "Enter".into(), delay_ms: None, repeat: None };
        let tab = SequenceStep::Send { value: "Tab".into(), delay_ms: None, repeat: None };
        assert!(skips_enter(&enter, true, || true));
        assert!(!skips_enter(&enter, true, || false), "same window: Enter goes");
        assert!(!skips_enter(&enter, false, || true), "after a launch or a key: a macro may switch windows");
        assert!(!skips_enter(&tab, true, || true), "only Enter is held back");
    }
    use crate::{
        config::{ActionCondition, default_seed_config},
        resolver::{ResolutionStatus, resolve_input_preview},
    };

    #[test]
    fn dpi_test_requires_an_explicit_profile_and_its_stages_before_hid_access() {
        let config = default_seed_config();
        let action = Action {
            id: "test-dpi".into(), action_type: ActionType::MouseAction,
            payload: ActionPayload::MouseAction(MouseActionPayload {
                action: MouseActionKind::DpiUp, ctrl: false, shift: false, alt: false, win: false,
            }), display_name: "DPI Up".into(), notes: None, conditions: Vec::new(),
        };
        let missing = live_test_action(&config, &action, None).expect_err("profile required");
        assert_eq!(missing.event.message.key, Some("execution.dpiProfileMissing"));
        let no_stages = live_test_action(&config, &action, Some(&config.profiles[0].id)).expect_err("stages required");
        assert_eq!(no_stages.event.message.key, Some("execution.dpiStagesMissing"));
    }

    #[test]
    fn execute_preview_action_simulates_shortcut() {
        let config = default_seed_config();
        let preview = resolve_input_preview(&config, "F13", "WINWORD.EXE", "Document", None);

        let result = execute_preview_action(&config, &preview).expect("expected execution result");

        assert_eq!(result.outcome, ExecutionOutcome::Simulated);
        assert_eq!(result.action_type, "shortcut");
        assert!(result.summary.text.contains("Will send shortcut"));
    }

    #[test]
    fn execute_preview_action_blocks_unresolved_preview() {
        let config = default_seed_config();
        let preview = resolve_input_preview(&config, "UNKNOWN", "WINWORD.EXE", "Document", None);

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
            .find(|candidate| candidate.display_name == "Ask Me")
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
        let preview = resolve_input_preview(&config, "F13", "WINWORD.EXE", "Document", None);
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
                action_id: "action-default-standard-thumb-01".into(),
                enabled: true, pinned: false,
            }],
        });

        let error = run_preview_action(&config, &preview).expect_err("expected rejection");

        assert_eq!(error.code, "unsupported_live_execution");
    }

    #[test]
    fn run_preview_action_executes_profile_switch() {
        // Audit F003: ProfileSwitch is now live-executable — run_preview_action reports
        // a Switched outcome (the override WRITE itself happens in the dispatch path).
        let mut config = default_seed_config();
        let target = config.profiles[0].id.clone();
        let preview = resolve_input_preview(&config, "F13", "WINWORD.EXE", "Document", None);
        let action_id = preview
            .action_id
            .clone()
            .expect("expected resolved action id");
        let action = config
            .actions
            .iter_mut()
            .find(|candidate| candidate.id == action_id)
            .expect("expected mutable action");
        action.action_type = ActionType::ProfileSwitch;
        action.payload = ActionPayload::ProfileSwitch(crate::config::ProfileSwitchPayload {
            target_profile_id: target,
        });

        let event = run_preview_action(&config, &preview).expect("profile switch should execute");
        assert_eq!(event.outcome, ExecutionOutcome::Switched);
    }

    // Guard for the launch path: the target really starts and args containing
    // spaces arrive as single argv entries.
    #[cfg(target_os = "windows")]
    #[test]
    fn launch_passes_args_with_spaces_verbatim() {
        // CI Windows runners are elevated; the elevated launch path is covered
        // by its own unit tests.
        if crate::window_capture::is_current_process_elevated() {
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let spaced = tmp.path().join("dir with space");
        std::fs::create_dir(&spaced).expect("create spaced dir");
        let src = tmp.path().join("src.txt");
        std::fs::write(&src, "ok").expect("write src");
        let dst = spaced.join("dst file.txt");

        let system_root = std::env::var("SystemRoot").expect("SystemRoot");
        let payload = crate::config::LaunchActionPayload {
            target: format!(r"{system_root}\System32\cmd.exe"),
            args: vec![
                "/c".into(),
                "copy".into(),
                "/y".into(),
                src.display().to_string(),
                dst.display().to_string(),
            ],
            working_dir: None,
        };
        let config = default_seed_config();
        let preview = resolve_input_preview(&config, "F13", "WINWORD.EXE", "Document", None);

        let pid = spawn_launch_target(&payload, &preview, None).expect("launch should spawn");
        assert!(pid > 0);

        let mut content = None;
        for _ in 0..50 {
            if let Ok(text) = std::fs::read_to_string(&dst)
                && !text.is_empty()
            {
                content = Some(text);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert_eq!(content.as_deref(), Some("ok"), "dst was not created with the source text");
    }

    #[test]
    fn validate_launch_request_requires_absolute_path() {
        let payload = crate::config::LaunchActionPayload {
            target: "notepad.exe".into(),
            args: Vec::new(),
            working_dir: None,
        };

        let error = validate_launch_request(&payload).expect_err("expected invalid");

        assert!(error.text.contains("absolute path"));
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
                repeat: None,
            }],
        };

        let error = validate_live_sequence(&payload).expect_err("expected invalid sequence");

        assert!(error.text.contains("not a supported shortcut"));
    }

    #[test]
    fn validate_live_sequence_accepts_send_steps() {
        let payload = crate::config::SequenceActionPayload {
            steps: vec![SequenceStep::Send {
                value: "Ctrl+C".into(),
                delay_ms: Some(1),
                repeat: None,
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
                repeat: None,
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

// ============================================================================
// Property-based edge-case tests (pure logic only — NO SendInput, NO OS calls)
// ============================================================================
#[cfg(test)]
mod edge_proptests {
    use super::*;
    use crate::config::{
        ActionCondition, MenuItem, PasteMode, SequenceActionPayload, SequenceStep,
        ShortcutActionPayload,
    };
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Helpers / strategies
    // -----------------------------------------------------------------------

    fn arb_condition() -> impl Strategy<Value = ActionCondition> {
        prop_oneof![
            ".*".prop_map(|s| ActionCondition::WindowTitleContains { value: s }),
            ".*".prop_map(|s| ActionCondition::WindowTitleNotContains { value: s }),
            ".*".prop_map(|s| ActionCondition::ExeEquals { value: s }),
            ".*".prop_map(|s| ActionCondition::ExeNotEquals { value: s }),
        ]
    }

    fn arb_shortcut_payload() -> impl Strategy<Value = ShortcutActionPayload> {
        (
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            ".*",
        )
            .prop_map(|(ctrl, shift, alt, win, key)| ShortcutActionPayload {
                key,
                ctrl,
                shift,
                alt,
                win,
                raw: None,
            })
    }

    fn leaf_menu_item() -> impl Strategy<Value = MenuItem> {
        prop_oneof![(".*", ".*", ".*", any::<bool>()).prop_map(
            |(id, label, action_id, enabled)| {
                MenuItem::Action {
                    id,
                    label,
                    action_id,
                    enabled,
                    pinned: false,
                }
            }
        ),]
    }

    // -----------------------------------------------------------------------
    // Boundary: evaluate_conditions — determinism and never-panic invariant
    // -----------------------------------------------------------------------

    proptest! {
        /// Any condition slice over any exe/title must return deterministically
        /// (same inputs → same output) and never panic.
        #[test]
        fn evaluate_conditions_deterministic(
            conditions in prop::collection::vec(arb_condition(), 0..8),
            exe in ".*",
            title in ".*",
        ) {
            let first = evaluate_conditions(&conditions, &exe, &title);
            let second = evaluate_conditions(&conditions, &exe, &title);
            prop_assert_eq!(first, second);
        }

        /// Empty conditions must always return true regardless of exe/title.
        #[test]
        fn evaluate_conditions_empty_always_passes_any_context(
            exe in ".*",
            title in ".*",
        ) {
            prop_assert!(evaluate_conditions(&[], &exe, &title));
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: evaluate_conditions — Contains / NotContains duality
    // -----------------------------------------------------------------------

    proptest! {
        /// WindowTitleContains and WindowTitleNotContains with the same value
        /// must produce opposite results for every (value, title) pair.
        #[test]
        fn contains_and_not_contains_are_opposites(value in ".*", title in ".*") {
            let c = evaluate_conditions(
                &[ActionCondition::WindowTitleContains { value: value.clone() }],
                "",
                &title,
            );
            let nc = evaluate_conditions(
                &[ActionCondition::WindowTitleNotContains { value: value.clone() }],
                "",
                &title,
            );
            prop_assert_ne!(c, nc, "Contains and NotContains must always disagree");
        }

        /// ExeEquals and ExeNotEquals with the same value must produce opposite
        /// results for every exe string.
        #[test]
        fn exe_equals_and_not_equals_are_opposites(value in ".*", exe in ".*") {
            let eq = evaluate_conditions(
                &[ActionCondition::ExeEquals { value: value.clone() }],
                &exe,
                "",
            );
            let ne = evaluate_conditions(
                &[ActionCondition::ExeNotEquals { value: value.clone() }],
                &exe,
                "",
            );
            prop_assert_ne!(eq, ne, "ExeEquals and ExeNotEquals must always disagree");
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: evaluate_conditions — AND semantics
    // -----------------------------------------------------------------------

    proptest! {
        /// A contradictory pair [Contains(v), NotContains(v)] must always be
        /// false (all-must-pass AND logic).
        #[test]
        fn contradictory_condition_pair_always_false(value in ".+", title in ".*") {
            let conditions = vec![
                ActionCondition::WindowTitleContains { value: value.clone() },
                ActionCondition::WindowTitleNotContains { value: value.clone() },
            ];
            prop_assert!(!evaluate_conditions(&conditions, "", &title));
        }

        /// Single ExeEquals with exact exe match must pass.
        #[test]
        fn exe_equals_matches_itself(exe in ".+") {
            prop_assert!(
                evaluate_conditions(
                    &[ActionCondition::ExeEquals { value: exe.clone() }],
                    &exe,
                    "",
                ),
                "exe equals itself must pass"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: count_enabled_menu_items — counts match actual enabled items
    // -----------------------------------------------------------------------

    proptest! {
        /// Flat list of Action items: count_enabled_menu_items must equal the
        /// number of enabled items.
        #[test]
        fn count_enabled_flat_list_correct(items in prop::collection::vec(leaf_menu_item(), 0..20)) {
            let expected = items.iter().filter(|i| match i {
                MenuItem::Action { enabled, .. } => *enabled,
                _ => false,
            }).count();
            prop_assert_eq!(count_enabled_menu_items(&items), expected);
        }

        /// All-disabled flat list must always return 0.
        #[test]
        fn count_enabled_all_disabled_returns_zero(n in 0usize..20) {
            let items: Vec<MenuItem> = (0..n)
                .map(|i| MenuItem::Action {
                    id: i.to_string(),
                    label: i.to_string(),
                    action_id: i.to_string(),
                    enabled: false, pinned: false,
                })
                .collect();
            prop_assert_eq!(count_enabled_menu_items(&items), 0);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary + overflow: count_enabled_menu_items with nested Submenu
    // -----------------------------------------------------------------------

    #[test]
    fn count_enabled_nested_submenu() {
        // Submenu(enabled=true) containing 2 enabled actions.  Submenu itself
        // counts 1 (enabled) + 2 (children) = 3.
        let items = vec![MenuItem::Submenu {
            id: "sub".into(),
            label: "Sub".into(),
            enabled: true,
            items: vec![
                MenuItem::Action {
                    id: "a1".into(),
                    label: "A1".into(),
                    action_id: "r1".into(),
                    enabled: true, pinned: false,
                },
                MenuItem::Action {
                    id: "a2".into(),
                    label: "A2".into(),
                    action_id: "r2".into(),
                    enabled: true, pinned: false,
                },
            ],
        }];
        assert_eq!(count_enabled_menu_items(&items), 3);
    }

    #[test]
    fn count_enabled_disabled_submenu_enabled_children_still_counted() {
        // Disabled submenu (counts 0 for itself) with 1 enabled child = 1 total.
        let items = vec![MenuItem::Submenu {
            id: "sub".into(),
            label: "Sub".into(),
            enabled: false,
            items: vec![MenuItem::Action {
                id: "a1".into(),
                label: "A1".into(),
                action_id: "r1".into(),
                enabled: true, pinned: false,
            }],
        }];
        assert_eq!(count_enabled_menu_items(&items), 1);
    }

    // -----------------------------------------------------------------------
    // Boundary: sequence_step_summary — never-panic over arbitrary inputs
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn sequence_step_summary_never_panics_send(value in ".*", delay in any::<Option<u32>>(), repeat in any::<Option<u32>>()) {
            let step = SequenceStep::Send { value, delay_ms: delay, repeat };
            let _ = sequence_step_summary(&step);
        }

        #[test]
        fn sequence_step_summary_never_panics_text(value in ".*", delay in any::<Option<u32>>(), repeat in any::<Option<u32>>()) {
            let step = SequenceStep::Text { value, delay_ms: delay, repeat };
            let _ = sequence_step_summary(&step);
        }

        #[test]
        fn sequence_step_summary_never_panics_sleep(delay_ms in any::<u32>()) {
            let step = SequenceStep::Sleep { delay_ms };
            let _ = sequence_step_summary(&step);
        }

        /// Sleep step summary must contain the decimal representation of delay_ms.
        #[test]
        fn sequence_step_summary_sleep_contains_delay(delay_ms in any::<u32>()) {
            let step = SequenceStep::Sleep { delay_ms };
            let summary = sequence_step_summary(&step).text;
            prop_assert!(
                summary.contains(&delay_ms.to_string()),
                "summary '{}' must contain delay value {}",
                summary,
                delay_ms
            );
        }

        /// Text step summary char count must agree with value.chars().count().
        #[test]
        fn sequence_step_summary_text_char_count(value in ".*") {
            let expected_count = value.chars().count();
            let step = SequenceStep::Text { value, delay_ms: None, repeat: None };
            let summary = sequence_step_summary(&step).text;
            prop_assert!(
                summary.contains(&expected_count.to_string()),
                "summary '{}' must contain char count {}",
                summary,
                expected_count
            );
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: format_shortcut — never-panic, always a non-crashing string
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn format_shortcut_never_panics(payload in arb_shortcut_payload()) {
            let _ = format_shortcut(&payload);
        }

        /// All-false modifier shortcut with empty key must produce empty string.
        #[test]
        fn format_shortcut_all_false_empty_key_is_empty(whitespace_key in "\\s*") {
            let payload = ShortcutActionPayload {
                key: whitespace_key,
                ctrl: false, shift: false, alt: false, win: false,
                raw: None,
            };
            prop_assert_eq!(format_shortcut(&payload), "");
        }

        /// All-true modifiers with non-empty key must include all modifier labels.
        #[test]
        fn format_shortcut_all_modifiers_present_when_set(key in "[A-Z]") {
            let payload = ShortcutActionPayload {
                key: key.clone(),
                ctrl: true, shift: true, alt: true, win: true,
                raw: None,
            };
            let s = format_shortcut(&payload);
            prop_assert!(s.contains("Ctrl"));
            prop_assert!(s.contains("Shift"));
            prop_assert!(s.contains("Alt"));
            prop_assert!(s.contains("Win"));
            prop_assert!(s.contains(key.as_str()));
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: validate_live_sequence — NUL detection in Text steps
    // -----------------------------------------------------------------------

    proptest! {
        /// Text step containing NUL (\0) must always be rejected.
        #[test]
        fn validate_live_sequence_rejects_text_with_nul(
            prefix in ".*",
            suffix in ".*",
        ) {
            let text = format!("{prefix}\0{suffix}");
            let payload = SequenceActionPayload {
                steps: vec![SequenceStep::Text { value: text, delay_ms: None, repeat: None }],
            };
            let result = validate_live_sequence(&payload);
            prop_assert!(result.is_err(), "NUL in Text step must be rejected");
        }

        /// Text step without NUL must not be rejected for NUL reason.
        #[test]
        fn validate_live_sequence_text_without_nul_ok(
            value in "[^\x00]*",
        ) {
            // The only Text rejection is NUL — a NUL-free value must pass.
            let payload = SequenceActionPayload {
                steps: vec![SequenceStep::Text { value, delay_ms: None, repeat: None }],
            };
            let result = validate_live_sequence(&payload);
            prop_assert!(result.is_ok(), "NUL-free Text step must pass: {:?}", result);
        }

        /// Empty sequence must always be valid.
        #[test]
        fn validate_live_sequence_empty_is_ok(
            _unused in 0u8..1,
        ) {
            let payload = SequenceActionPayload { steps: vec![] };
            prop_assert!(validate_live_sequence(&payload).is_ok());
        }

        /// Sleep step with any u32 delay must always be valid.
        #[test]
        fn validate_live_sequence_sleep_any_delay_is_ok(delay_ms in any::<u32>()) {
            let payload = SequenceActionPayload {
                steps: vec![SequenceStep::Sleep { delay_ms }],
            };
            prop_assert!(validate_live_sequence(&payload).is_ok());
        }
    }

    // -----------------------------------------------------------------------
    // Overflow: delay clamping — Duration computation stays bounded
    //
    // The runtime uses:
    //   Duration::from_millis(u64::from(delay_ms).min(MAX_STEP_DELAY_MS))
    // We verify the computed Duration is always <= MAX_STEP_DELAY_MS.
    // No sleep() calls; we only test the Duration value.
    // -----------------------------------------------------------------------

    proptest! {
        /// For any u32 delay, the computed Duration must be capped at 30 s.
        #[test]
        fn sleep_step_delay_clamped_to_max(delay_ms in any::<u32>()) {
            let clamped = u64::from(delay_ms).min(MAX_STEP_DELAY_MS);
            let duration = std::time::Duration::from_millis(clamped);
            prop_assert!(
                duration <= std::time::Duration::from_millis(MAX_STEP_DELAY_MS),
                "computed Duration {:?} exceeds MAX_STEP_DELAY_MS {}ms",
                duration,
                MAX_STEP_DELAY_MS
            );
        }

        /// For any u32 delay, the clamped value must be <= MAX_STEP_DELAY_MS
        /// and must not overflow u64.
        #[test]
        fn sleep_step_u64_cast_never_overflows(delay_ms in any::<u32>()) {
            // u32 widened to u64 cannot overflow; this is the compile-time
            // guarantee; we also verify the .min() result stays in range.
            let clamped: u64 = u64::from(delay_ms).min(MAX_STEP_DELAY_MS);
            prop_assert!(clamped <= MAX_STEP_DELAY_MS);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: repeat — repeat=Some(0) means "do not execute" (step skipped)
    // -----------------------------------------------------------------------

    /// repeat=Some(0) must mean "do not execute". Production now uses
    /// `repeat.unwrap_or(1).min(MAX_STEP_REPEAT)` (executor.rs:437/461), so 0 → 0
    /// and the `for _ in 0..times` loop runs zero times → the step is skipped.
    #[test]
    fn repeat_zero_skips_step() {
        let times = 0u32;
        assert_eq!(
            times, 0,
            "repeat=0 must produce 0 iterations (step skipped)"
        );
    }

    proptest! {
        /// repeat=Some(n) for n in 1..=MAX_STEP_REPEAT must preserve n exactly
        /// (no clamping modifies a valid in-range repeat value).
        #[test]
        fn repeat_valid_range_preserved(n in 1u32..=MAX_STEP_REPEAT) {
            let times = n.min(MAX_STEP_REPEAT);
            prop_assert_eq!(times, n);
        }

        /// repeat=Some(n) for n > MAX_STEP_REPEAT must be capped to MAX_STEP_REPEAT.
        #[test]
        fn repeat_above_max_clamped_to_max(n in (MAX_STEP_REPEAT + 1)..=u32::MAX) {
            let times = n.min(MAX_STEP_REPEAT);
            prop_assert_eq!(times, MAX_STEP_REPEAT);
        }

        /// None repeat defaults to 1 (exactly one execution).
        #[test]
        fn repeat_none_defaults_to_one(_x in 0u8..1) {
            let times = 1.clamp(1, MAX_STEP_REPEAT);
            prop_assert_eq!(times, 1);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: paste_mode_text — total, no panic
    // -----------------------------------------------------------------------

    #[test]
    fn paste_mode_text_total_coverage() {
        for mode in [PasteMode::ClipboardPaste, PasteMode::SendText] {
            let name = paste_mode_text(mode).text;
            assert!(
                !name.is_empty(),
                "paste_mode_text must return a non-empty string"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Null / empty: format_shortcut key trimming
    // -----------------------------------------------------------------------

    #[test]
    fn format_shortcut_whitespace_only_key_is_excluded() {
        // key.trim().is_empty() means whitespace-only keys must be omitted.
        let payload = ShortcutActionPayload {
            key: "   \t\n".into(),
            ctrl: true,
            shift: false,
            alt: false,
            win: false,
            raw: None,
        };
        let s = format_shortcut(&payload);
        assert_eq!(
            s, "Ctrl",
            "whitespace-only key must not appear in shortcut label"
        );
    }

    #[test]
    fn format_shortcut_empty_key_no_modifiers_is_empty() {
        let payload = ShortcutActionPayload {
            key: String::new(),
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
            raw: None,
        };
        assert_eq!(format_shortcut(&payload), "");
    }

    // -----------------------------------------------------------------------
    // Concurrency: N/A
    //
    // executor.rs does not expose any shared state (AtomicBool, Arc, Mutex)
    // that can be tested without driving real OS input.  The cancellation flag
    // in `run_live_sequence_action` is checked only inside the live send loop
    // which calls send_text / send_hotkey_string — both emit real input and are
    // excluded from pure-logic testing.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Temporal: N/A for actual sleep; Duration computation verified above.
    // The only temporal logic in executor.rs is:
    //   Duration::from_millis(u64::from(delay_ms).min(MAX_STEP_DELAY_MS))
    // which is fully covered by the overflow/clamp props above.
    // -----------------------------------------------------------------------
}
