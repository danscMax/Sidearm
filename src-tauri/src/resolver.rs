use regex::Regex;
use serde::Serialize;

use crate::config::{AppConfig, AppMapping, EncoderMapping, Profile, TriggerMode};

const REGEX_PREFIX: &str = "regex:";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResolutionStatus {
    Resolved,
    Unresolved,
    Ambiguous,
    /// Mapping, binding, and action all resolved, but the action's conditions
    /// (active exe / window title) are not met for the current context — so it
    /// must not fire. Distinct from Unresolved for clear diagnostics.
    #[serde(rename = "conditionUnmet")]
    ConditionUnmet,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResolutionSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_app_mapping_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_profile_name: Option<String>,
    pub used_fallback_profile: bool,
    pub candidate_app_mapping_ids: Vec<String>,
    pub resolution_reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedInputPreview {
    pub status: ResolutionStatus,
    pub encoded_key: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_app_mapping_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_profile_name: Option<String>,
    pub used_fallback_profile: bool,
    pub candidate_app_mapping_ids: Vec<String>,
    pub candidate_control_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_pretty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mapping_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mapping_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_mode: Option<TriggerMode>,
}

/// Which profile applies to a foreground app context, plus the supporting
/// detail both call sites need.
///
/// Single source of truth for "given an app, which profile wins". The logic
/// used to be duplicated — once in `window_capture` (drives the OSD /
/// active-profile indicator) and once here (drives input-preview / dispatch) —
/// and the two copies drifted: only this side consulted
/// `last_selected_profile_id`. That made the indicator show the fallback
/// profile while dispatch silently used the editor-selected profile, so
/// selecting an empty profile made every unmapped app stop responding with no
/// visible reason. Resolution is now `app mapping > fallback` for everyone;
/// `last_selected_profile_id` is editor view state only, never a runtime
/// override.
pub(crate) struct ProfileSelection<'a> {
    pub matched_mapping: Option<&'a AppMapping>,
    pub profile: Option<&'a Profile>,
    pub used_fallback: bool,
    pub candidates: Vec<&'a AppMapping>,
    pub reason: String,
}

/// Natural (no-override) profile resolution — the plain `app mapping > fallback` rule.
/// Production always threads the manual override via
/// [`select_profile_for_app_context_with_override`]; this thin wrapper exists for the
/// tests that exercise the no-override path.
#[cfg(test)]
pub(crate) fn select_profile_for_app_context<'a>(
    config: &'a AppConfig,
    exe: &str,
    title: &str,
    process_path: Option<&str>,
) -> ProfileSelection<'a> {
    select_profile_for_app_context_with_override(config, exe, title, process_path, None)
}

/// Like [`select_profile_for_app_context`], but honours a runtime manual profile
/// override set by a ProfileSwitch action (audit F003). When the override names an
/// existing, enabled profile it wins over app-mapping and fallback; otherwise the
/// normal `app mapping > fallback` logic applies. Both the OSD indicator and the
/// dispatch path call THIS one function with the same override, so they can never
/// disagree (the very drift the module note above warns about).
pub(crate) fn select_profile_for_app_context_with_override<'a>(
    config: &'a AppConfig,
    exe: &str,
    title: &str,
    process_path: Option<&str>,
    override_profile_id: Option<&str>,
) -> ProfileSelection<'a> {
    if let Some(id) = override_profile_id {
        // `find_profile` returns Some only for an existing, enabled profile, so a
        // stale/disabled override gracefully falls through to app-mapping below.
        if let Some(profile) = find_profile(config, id) {
            return ProfileSelection {
                matched_mapping: None,
                profile: Some(profile),
                used_fallback: false,
                candidates: matching_app_mappings(config, exe, title, process_path),
                reason: format!("Manual profile override `{}`.", profile.id),
            };
        }
    }

    let fallback_profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == config.settings.fallback_profile_id);
    let candidates = matching_app_mappings(config, exe, title, process_path);
    let winner = candidates.first().copied();
    let profile = winner
        .and_then(|mapping| find_profile(config, &mapping.profile_id))
        .or(fallback_profile);
    let used_fallback = winner.is_none();
    let reason = if let Some(mapping) = winner {
        format!("Matched app mapping `{}`.", mapping.id)
    } else {
        format!(
            "No matching app mapping found. Using fallback profile `{}`.",
            config.settings.fallback_profile_id
        )
    };

    ProfileSelection {
        matched_mapping: winner,
        profile,
        used_fallback,
        candidates,
        reason,
    }
}

/// Test-only wrapper: natural resolution with no manual override (see the
/// `_with_override` form, which production uses).
#[cfg(test)]
pub fn resolve_profile_for_app_context(
    config: &AppConfig,
    exe: &str,
    title: &str,
    process_path: Option<&str>,
) -> ProfileResolutionSummary {
    resolve_profile_for_app_context_with_override(config, exe, title, process_path, None)
}

/// [`resolve_profile_for_app_context`] threaded with a manual profile override (F003).
pub fn resolve_profile_for_app_context_with_override(
    config: &AppConfig,
    exe: &str,
    title: &str,
    process_path: Option<&str>,
    override_profile_id: Option<&str>,
) -> ProfileResolutionSummary {
    let selection = select_profile_for_app_context_with_override(
        config,
        exe,
        title,
        process_path,
        override_profile_id,
    );
    ProfileResolutionSummary {
        matched_app_mapping_id: selection.matched_mapping.map(|mapping| mapping.id.clone()),
        resolved_profile_id: selection.profile.map(|profile| profile.id.clone()),
        resolved_profile_name: selection.profile.map(|profile| profile.name.clone()),
        used_fallback_profile: selection.used_fallback,
        candidate_app_mapping_ids: selection
            .candidates
            .iter()
            .map(|mapping| mapping.id.clone())
            .collect(),
        resolution_reason: selection.reason,
    }
}

pub fn resolve_input_preview(
    config: &AppConfig,
    encoded_key: &str,
    exe: &str,
    title: &str,
    process_path: Option<&str>,
) -> ResolvedInputPreview {
    resolve_input_preview_with_override(config, encoded_key, exe, title, process_path, None)
}

/// [`resolve_input_preview`] threaded with a manual profile override (F003). The live
/// dispatch path passes the active override so the binding that fires belongs to the
/// switched-to profile.
pub fn resolve_input_preview_with_override(
    config: &AppConfig,
    encoded_key: &str,
    exe: &str,
    title: &str,
    process_path: Option<&str>,
    override_profile_id: Option<&str>,
) -> ResolvedInputPreview {
    let normalized_key = normalized_encoded_key(encoded_key);
    let profile_resolution = resolve_profile_for_app_context_with_override(
        config,
        exe,
        title,
        process_path,
        override_profile_id,
    );
    let matching_mappings: Vec<&EncoderMapping> = config
        .encoder_mappings
        .iter()
        .filter(|mapping| {
            normalized_encoded_key(&mapping.encoded_key).eq_ignore_ascii_case(&normalized_key)
        })
        .collect();

    if matching_mappings.is_empty() {
        return ResolvedInputPreview {
            status: ResolutionStatus::Unresolved,
            encoded_key: normalized_key.clone(),
            reason: format!("No encoder mapping exists for `{normalized_key}`."),
            matched_app_mapping_id: profile_resolution.matched_app_mapping_id,
            resolved_profile_id: profile_resolution.resolved_profile_id,
            resolved_profile_name: profile_resolution.resolved_profile_name,
            used_fallback_profile: profile_resolution.used_fallback_profile,
            candidate_app_mapping_ids: profile_resolution.candidate_app_mapping_ids,
            candidate_control_ids: Vec::new(),
            control_id: None,
            layer: None,
            binding_id: None,
            binding_label: None,
            action_id: None,
            action_type: None,
            action_pretty: None,
            mapping_verified: None,
            mapping_source: None,
            trigger_mode: None,
        };
    }

    if matching_mappings.len() > 1 {
        return ResolvedInputPreview {
            status: ResolutionStatus::Ambiguous,
            encoded_key: normalized_key.clone(),
            reason: format!(
                "Multiple encoder mappings match `{normalized_key}`. Refusing ambiguous resolution."
            ),
            matched_app_mapping_id: profile_resolution.matched_app_mapping_id,
            resolved_profile_id: profile_resolution.resolved_profile_id,
            resolved_profile_name: profile_resolution.resolved_profile_name,
            used_fallback_profile: profile_resolution.used_fallback_profile,
            candidate_app_mapping_ids: profile_resolution.candidate_app_mapping_ids,
            candidate_control_ids: matching_mappings
                .into_iter()
                .map(|mapping| mapping.control_id.as_str().to_owned())
                .collect(),
            control_id: None,
            layer: None,
            binding_id: None,
            binding_label: None,
            action_id: None,
            action_type: None,
            action_pretty: None,
            mapping_verified: None,
            mapping_source: None,
            trigger_mode: None,
        };
    }

    let mapping = matching_mappings[0];
    let binding = profile_resolution
        .resolved_profile_id
        .as_deref()
        .and_then(|profile_id| {
            config.bindings.iter().find(|binding| {
                binding.enabled
                    && binding.profile_id == profile_id
                    && binding.layer == mapping.layer
                    && binding.control_id == mapping.control_id
            })
        });
    let action = binding.and_then(|binding| {
        config
            .actions
            .iter()
            .find(|action| action.id == binding.action_id)
    });

    let (status, reason) = if let Some(action) = action {
        if crate::executor::evaluate_conditions(&action.conditions, exe, title) {
            (
                ResolutionStatus::Resolved,
                format!(
                    "Resolved `{normalized_key}` to `{}` / `{}`.",
                    mapping.control_id.as_str(),
                    mapping.layer.as_str()
                ),
            )
        } else {
            (
                ResolutionStatus::ConditionUnmet,
                format!(
                    "`{normalized_key}` is bound to `{}`, but its conditions are not met for the active window (exe `{exe}`).",
                    action.display_name
                ),
            )
        }
    } else if binding.is_some() {
        (
            ResolutionStatus::Unresolved,
            format!("Resolved mapping for `{normalized_key}` but binding action is missing."),
        )
    } else {
        (
            ResolutionStatus::Unresolved,
            format!(
                "Resolved mapping for `{normalized_key}` but no enabled binding exists for the selected profile/layer."
            ),
        )
    };

    ResolvedInputPreview {
        status,
        encoded_key: normalized_key,
        reason,
        matched_app_mapping_id: profile_resolution.matched_app_mapping_id,
        resolved_profile_id: profile_resolution.resolved_profile_id,
        resolved_profile_name: profile_resolution.resolved_profile_name,
        used_fallback_profile: profile_resolution.used_fallback_profile,
        candidate_app_mapping_ids: profile_resolution.candidate_app_mapping_ids,
        candidate_control_ids: vec![mapping.control_id.as_str().to_owned()],
        control_id: Some(mapping.control_id.as_str().to_owned()),
        layer: Some(mapping.layer.as_str().to_owned()),
        binding_id: binding.map(|binding| binding.id.clone()),
        binding_label: binding.map(|binding| binding.label.clone()),
        action_id: action.map(|action| action.id.clone()),
        action_type: action.map(|action| action.action_type.as_str().to_owned()),
        action_pretty: action.map(|action| action.display_name.clone()),
        mapping_verified: Some(mapping.verified),
        mapping_source: Some(mapping_source_name(mapping).to_owned()),
        trigger_mode: binding.and_then(|b| b.trigger_mode),
    }
}

pub(crate) fn matching_app_mappings<'a>(
    config: &'a AppConfig,
    exe: &str,
    title: &str,
    process_path: Option<&str>,
) -> Vec<&'a AppMapping> {
    let normalized_title = title.to_ascii_lowercase();
    let mut matches: Vec<&AppMapping> = config
        .app_mappings
        .iter()
        .filter(|mapping| mapping.enabled)
        .filter(|mapping| mapping.exe.eq_ignore_ascii_case(exe))
        .filter(|mapping| match mapping.process_path.as_deref() {
            // A mapping that pins a full process path only matches when the
            // active process path matches it (case-insensitive). Mappings
            // without a pinned path (the common case) are unaffected — this
            // keeps the behaviour additive for existing configs.
            Some(pinned) => {
                process_path.is_some_and(|active| active.eq_ignore_ascii_case(pinned))
            }
            None => true,
        })
        .filter(|mapping| {
            mapping.title_includes.is_empty()
                || mapping
                    .title_includes
                    .iter()
                    .enumerate()
                    .all(|(i, needle)| {
                        if needle.starts_with(REGEX_PREFIX) {
                            // Use pre-compiled regex if available, fall back to compile-on-demand
                            if let Some(Some(re)) = mapping.compiled_title_regexes.get(i) {
                                re.is_match(&normalized_title)
                            } else if let Some(pattern) = needle.strip_prefix(REGEX_PREFIX) {
                                Regex::new(&format!("(?i){pattern}"))
                                    .map(|re| re.is_match(&normalized_title))
                                    .unwrap_or(false)
                            } else {
                                false
                            }
                        } else {
                            normalized_title.contains(&needle.to_ascii_lowercase())
                        }
                    })
        })
        .collect();

    matches.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| {
                left.title_includes
                    .is_empty()
                    .cmp(&right.title_includes.is_empty())
            })
            .then_with(|| right.title_includes.len().cmp(&left.title_includes.len()))
            .then_with(|| left.id.cmp(&right.id))
    });

    matches
}

pub(crate) fn find_profile<'a>(config: &'a AppConfig, profile_id: &str) -> Option<&'a Profile> {
    config
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.enabled)
}

fn mapping_source_name(mapping: &EncoderMapping) -> &'static str {
    match mapping.source {
        crate::config::MappingSource::Synapse => "synapse",
        crate::config::MappingSource::Reserved => "reserved",
        crate::config::MappingSource::Detected => "detected",
    }
}

fn normalized_encoded_key(raw: &str) -> String {
    crate::hotkeys::normalize_hotkey(raw).unwrap_or_else(|_| raw.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        Action, ActionCondition, ActionPayload, ActionType, Binding, CapabilityStatus,
        ControlFamily, ControlId, Layer, MappingSource, OsdAnimation, OsdFontSize, OsdPosition,
        PhysicalControl, Settings, SnippetLibraryItem, TriggerMode,
    };

    #[test]
    fn resolve_input_preview_uses_fallback_profile() {
        let config = test_config(vec![]);

        let result = resolve_input_preview(&config, "F13", "chrome.exe", "Docs", None);

        assert_eq!(result.status, ResolutionStatus::Resolved);
        assert_eq!(result.resolved_profile_id.as_deref(), Some("default"));
        assert!(result.used_fallback_profile);
    }

    #[test]
    fn resolve_input_preview_reports_missing_mapping() {
        let config = test_config(vec![]);

        let result = resolve_input_preview(&config, "F99", "chrome.exe", "Docs", None);

        assert_eq!(result.status, ResolutionStatus::Unresolved);
        assert!(result.reason.contains("No encoder mapping exists"));
    }

    #[test]
    fn resolve_ignores_manual_selection_and_uses_fallback() {
        // `last_selected_profile_id` is the editor's view state, not a runtime
        // override. An unmapped app must resolve to the fallback profile so the
        // dispatch path agrees with the OSD/indicator (window_capture) path —
        // otherwise selecting an empty profile silently breaks unmapped apps.
        let mut config = test_config(vec![]);
        config.settings.last_selected_profile_id = Some("code".into());

        let summary = resolve_profile_for_app_context(&config, "chrome.exe", "Docs", None);

        assert_eq!(summary.resolved_profile_id.as_deref(), Some("default"));
        assert!(summary.used_fallback_profile);
    }

    #[test]
    fn resolve_prefers_app_mapping_over_manual() {
        let mut config = test_config(vec![app_mapping(
            "app-code",
            "code.exe",
            "review",
            200,
            vec![],
        )]);
        config.settings.last_selected_profile_id = Some("code".into());

        let summary = resolve_profile_for_app_context(&config, "code.exe", "Pull Request", None);

        assert_eq!(summary.resolved_profile_id.as_deref(), Some("review"));
        assert_eq!(summary.matched_app_mapping_id.as_deref(), Some("app-code"));
    }

    #[test]
    fn manual_override_beats_app_mapping_and_falls_through_when_invalid() {
        // Audit F003: a ProfileSwitch override wins over app-mapping when it names a
        // real, enabled profile, and a stale/missing override gracefully falls back to
        // the normal `app mapping > fallback` resolution.
        let config = test_config(vec![app_mapping("app-code", "code.exe", "review", 200, vec![])]);

        // No override: app-mapping wins -> "review".
        let base = select_profile_for_app_context(&config, "code.exe", "Pull Request", None);
        assert_eq!(base.profile.map(|p| p.id.as_str()), Some("review"));

        // Valid override -> wins over the app-mapping, not a fallback.
        let overridden = select_profile_for_app_context_with_override(
            &config,
            "code.exe",
            "Pull Request",
            None,
            Some("default"),
        );
        assert_eq!(overridden.profile.map(|p| p.id.as_str()), Some("default"));
        assert!(overridden.matched_mapping.is_none());
        assert!(!overridden.used_fallback);

        // Stale override (no such profile) -> falls through to the app-mapping.
        let stale = select_profile_for_app_context_with_override(
            &config,
            "code.exe",
            "Pull Request",
            None,
            Some("ghost"),
        );
        assert_eq!(stale.profile.map(|p| p.id.as_str()), Some("review"));
    }

    #[test]
    fn resolve_ignores_stale_manual_profile_id() {
        let mut config = test_config(vec![]);
        config.settings.last_selected_profile_id = Some("ghost".into());

        let summary = resolve_profile_for_app_context(&config, "chrome.exe", "Docs", None);

        assert_eq!(summary.resolved_profile_id.as_deref(), Some("default"));
        assert!(summary.used_fallback_profile);
    }

    #[test]
    fn resolve_input_preview_picks_more_specific_app_mapping() {
        let config = test_config(vec![
            app_mapping("app-code", "code.exe", "code", 200, vec![]),
            app_mapping(
                "app-code-review",
                "code.exe",
                "review",
                200,
                vec!["pull request"],
            ),
        ]);

        let result = resolve_input_preview(&config, "F13", "code.exe", "Pull Request Review", None);

        assert_eq!(result.resolved_profile_id.as_deref(), Some("review"));
        assert_eq!(
            result.matched_app_mapping_id.as_deref(),
            Some("app-code-review")
        );
    }

    fn test_config(app_mappings: Vec<AppMapping>) -> AppConfig {
        AppConfig {
            version: 2,
            settings: Settings {
                fallback_profile_id: "default".into(),
                theme: "studio".into(),
                start_with_windows: false,
                minimize_to_tray: false,
                debug_logging: true,
                repair_clipboard_on_copy: false,
                osd_enabled: true,
                osd_duration_ms: 2000,
                osd_position: OsdPosition::default(),
                osd_font_size: OsdFontSize::default(),
                osd_animation: OsdAnimation::default(),
                modifier_stale_gc_ms: None,
                replayed_modifier_force_release_ms: None,
                last_selected_profile_id: None,
                onboarding_completed: false,
                onboarding_step: None,
            },
            profiles: vec![
                profile("default", "Default", 0),
                profile("code", "Code", 200),
                profile("review", "Review", 210),
            ],
            physical_controls: vec![PhysicalControl {
                id: ControlId::Thumb01,
                family: ControlFamily::ThumbGrid,
                default_name: "Thumb 1".into(),
                synapse_name: None,
                remappable: true,
                capability_status: CapabilityStatus::Verified,
                notes: None,
            }],
            encoder_mappings: vec![EncoderMapping {
                control_id: ControlId::Thumb01,
                layer: Layer::Standard,
                encoded_key: "F13".into(),
                source: MappingSource::Synapse,
                verified: true,
            }],
            app_mappings,
            bindings: vec![Binding {
                id: "binding-default-standard-thumb-01".into(),
                profile_id: "default".into(),
                layer: Layer::Standard,
                control_id: ControlId::Thumb01,
                label: "Example".into(),
                action_id: "action-default-standard-thumb-01".into(),
                color_tag: None,
                trigger_mode: None,
                chord_partner: None,
                enabled: true,
            }],
            actions: vec![Action {
                id: "action-default-standard-thumb-01".into(),
                action_type: ActionType::Disabled,
                payload: ActionPayload::Disabled(Default::default()),
                display_name: "Disabled".into(),
                notes: None,
                conditions: Vec::new(),
            }],
            snippet_library: vec![SnippetLibraryItem {
                id: "snippet-example".into(),
                name: "Example".into(),
                text: "Example".into(),
                paste_mode: crate::config::PasteMode::ClipboardPaste,
                tags: vec!["example".into()],
                notes: None,
            }],
        }
    }

    fn profile(id: &str, name: &str, priority: i32) -> Profile {
        Profile {
            id: id.into(),
            name: name.into(),
            description: None,
            enabled: true,
            priority,
        }
    }

    #[test]
    fn resolve_input_preview_includes_trigger_mode_from_binding() {
        let mut config = test_config(vec![]);
        config.bindings[0].trigger_mode = Some(TriggerMode::Hold);

        let result = resolve_input_preview(&config, "F13", "chrome.exe", "Docs", None);

        assert_eq!(result.trigger_mode, Some(TriggerMode::Hold));
    }

    fn app_mapping(
        id: &str,
        exe: &str,
        profile_id: &str,
        priority: i32,
        title_includes: Vec<&str>,
    ) -> AppMapping {
        AppMapping {
            id: id.into(),
            exe: exe.into(),
            process_path: None,
            title_includes: title_includes.into_iter().map(str::to_owned).collect(),
            profile_id: profile_id.into(),
            enabled: true,
            priority,
            compiled_title_regexes: Vec::new(),
        }
    }

    /// Attach the given conditions to every action in the test config.
    fn with_action_conditions(mut config: AppConfig, conditions: Vec<ActionCondition>) -> AppConfig {
        for action in &mut config.actions {
            action.conditions = conditions.clone();
        }
        config
    }

    #[test]
    fn resolve_exe_equals_met_resolves() {
        let config = with_action_conditions(
            test_config(vec![]),
            vec![ActionCondition::ExeEquals { value: "excel.exe".into() }],
        );
        let result = resolve_input_preview(&config, "F13", "EXCEL.EXE", "Book1", None);
        assert_eq!(result.status, ResolutionStatus::Resolved);
    }

    #[test]
    fn resolve_exe_equals_unmet_is_condition_unmet() {
        let config = with_action_conditions(
            test_config(vec![]),
            vec![ActionCondition::ExeEquals { value: "excel.exe".into() }],
        );
        let result = resolve_input_preview(&config, "F13", "notepad.exe", "Untitled", None);
        assert_eq!(result.status, ResolutionStatus::ConditionUnmet);
    }

    #[test]
    fn resolve_exe_not_equals_gates_on_active_exe() {
        let config = with_action_conditions(
            test_config(vec![]),
            vec![ActionCondition::ExeNotEquals { value: "notepad.exe".into() }],
        );
        assert_eq!(
            resolve_input_preview(&config, "F13", "notepad.exe", "x", None).status,
            ResolutionStatus::ConditionUnmet
        );
        assert_eq!(
            resolve_input_preview(&config, "F13", "chrome.exe", "x", None).status,
            ResolutionStatus::Resolved
        );
    }

    #[test]
    fn resolve_window_title_contains_gates() {
        let config = with_action_conditions(
            test_config(vec![]),
            vec![ActionCondition::WindowTitleContains { value: "Inbox".into() }],
        );
        assert_eq!(
            resolve_input_preview(&config, "F13", "chrome.exe", "Gmail - Inbox (3)", None).status,
            ResolutionStatus::Resolved
        );
        assert_eq!(
            resolve_input_preview(&config, "F13", "chrome.exe", "Settings", None).status,
            ResolutionStatus::ConditionUnmet
        );
    }

    #[test]
    fn resolve_window_title_not_contains_gates() {
        let config = with_action_conditions(
            test_config(vec![]),
            vec![ActionCondition::WindowTitleNotContains { value: "Private".into() }],
        );
        assert_eq!(
            resolve_input_preview(&config, "F13", "chrome.exe", "Public Doc", None).status,
            ResolutionStatus::Resolved
        );
        assert_eq!(
            resolve_input_preview(&config, "F13", "chrome.exe", "Private Doc", None).status,
            ResolutionStatus::ConditionUnmet
        );
    }

    #[test]
    fn resolve_empty_conditions_resolves_anywhere() {
        let config = test_config(vec![]);
        assert_eq!(
            resolve_input_preview(&config, "F13", "anything.exe", "x", None).status,
            ResolutionStatus::Resolved
        );
    }

    #[test]
    fn matching_respects_pinned_process_path() {
        // Two mappings share the same exe but pin different full paths.
        let mut env_a = app_mapping("env-a", "python.exe", "code", 100, vec![]);
        env_a.process_path = Some("C:\\envA\\python.exe".into());
        let mut env_b = app_mapping("env-b", "python.exe", "review", 100, vec![]);
        env_b.process_path = Some("C:\\envB\\python.exe".into());
        let config = test_config(vec![env_a, env_b]);

        // Active process matches env-b's pinned path → only env-b matches.
        let matches =
            matching_app_mappings(&config, "python.exe", "", Some("C:\\envB\\python.exe"));
        assert_eq!(matches.first().map(|m| m.id.as_str()), Some("env-b"));

        // Without a known process path, pinned-path mappings do not match.
        let none = matching_app_mappings(&config, "python.exe", "", None);
        assert!(none.is_empty());
    }
}

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use crate::config::{
        Action, ActionPayload, ActionType, Binding, CapabilityStatus, ControlFamily, ControlId,
        DisabledActionPayload, Layer, MappingSource, OsdAnimation, OsdFontSize, OsdPosition,
        PhysicalControl, Settings,
    };
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Minimal helpers (self-contained, mirrors the style of `mod tests`)
    // -----------------------------------------------------------------------

    fn minimal_config(app_mappings: Vec<AppMapping>) -> AppConfig {
        AppConfig {
            version: 2,
            settings: Settings {
                fallback_profile_id: "default".into(),
                theme: "studio".into(),
                start_with_windows: false,
                minimize_to_tray: false,
                debug_logging: false,
                repair_clipboard_on_copy: false,
                osd_enabled: true,
                osd_duration_ms: 2000,
                osd_position: OsdPosition::default(),
                osd_font_size: OsdFontSize::default(),
                osd_animation: OsdAnimation::default(),
                modifier_stale_gc_ms: None,
                replayed_modifier_force_release_ms: None,
                last_selected_profile_id: None,
                onboarding_completed: false,
                onboarding_step: None,
            },
            profiles: vec![
                minimal_profile("default", "Default", true),
                minimal_profile("other", "Other", true),
                minimal_profile("disabled-profile", "Disabled", false),
            ],
            physical_controls: vec![PhysicalControl {
                id: ControlId::Thumb01,
                family: ControlFamily::ThumbGrid,
                default_name: "Thumb 1".into(),
                synapse_name: None,
                remappable: true,
                capability_status: CapabilityStatus::Verified,
                notes: None,
            }],
            encoder_mappings: vec![crate::config::EncoderMapping {
                control_id: ControlId::Thumb01,
                layer: Layer::Standard,
                encoded_key: "F13".into(),
                source: MappingSource::Synapse,
                verified: true,
            }],
            app_mappings,
            bindings: vec![Binding {
                id: "b1".into(),
                profile_id: "default".into(),
                layer: Layer::Standard,
                control_id: ControlId::Thumb01,
                label: "Test".into(),
                action_id: "a1".into(),
                color_tag: None,
                trigger_mode: None,
                chord_partner: None,
                enabled: true,
            }],
            actions: vec![Action {
                id: "a1".into(),
                action_type: ActionType::Disabled,
                payload: ActionPayload::Disabled(DisabledActionPayload::default()),
                display_name: "Disabled".into(),
                notes: None,
                conditions: Vec::new(),
            }],
            snippet_library: vec![],
        }
    }

    fn minimal_profile(id: &str, name: &str, enabled: bool) -> crate::config::Profile {
        crate::config::Profile {
            id: id.into(),
            name: name.into(),
            description: None,
            enabled,
            priority: 0,
        }
    }

    fn simple_app_mapping(id: &str, exe: &str, profile_id: &str) -> AppMapping {
        AppMapping {
            id: id.into(),
            exe: exe.into(),
            process_path: None,
            title_includes: Vec::new(),
            profile_id: profile_id.into(),
            enabled: true,
            priority: 100,
            compiled_title_regexes: Vec::new(),
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: find_profile respects enabled flag
    // -----------------------------------------------------------------------

    /// find_profile must return None for any profile with enabled=false,
    /// regardless of whether the id matches.
    #[test]
    fn find_profile_disabled_profile_returns_none() {
        let config = minimal_config(vec![]);
        // "disabled-profile" is in the list but has enabled=false
        assert_eq!(find_profile(&config, "disabled-profile"), None);
    }

    #[test]
    fn find_profile_enabled_profile_returns_some() {
        let config = minimal_config(vec![]);
        assert!(find_profile(&config, "default").is_some());
        assert!(find_profile(&config, "other").is_some());
    }

    #[test]
    fn find_profile_unknown_id_returns_none() {
        let config = minimal_config(vec![]);
        assert_eq!(find_profile(&config, ""), None);
        assert_eq!(find_profile(&config, "ghost"), None);
        assert_eq!(find_profile(&config, "DEFAULT"), None); // case-sensitive
    }

    // -----------------------------------------------------------------------
    // BUG: used_fallback_profile is incorrect when last_selected_profile_id
    // refers to a DISABLED profile and no app mapping matches.
    // The flag reports `true` (fell back) but the intent is ambiguous:
    // the user explicitly chose "disabled-profile", it just can't be activated.
    // -----------------------------------------------------------------------

    #[test]
    fn used_fallback_profile_when_manual_profile_is_disabled() {
        let mut config = minimal_config(vec![]);
        config.settings.last_selected_profile_id = Some("disabled-profile".into());

        let summary = resolve_profile_for_app_context(&config, "any.exe", "title", None);

        // Because disabled-profile is not returned by find_profile, manual_profile = None,
        // winner = None → used_fallback_profile = true (the code falls back to default).
        // This is the current behaviour — documenting it as a suspected bug:
        // a user who deliberately selected "disabled-profile" will silently get
        // the fallback without any distinct indication.
        assert!(
            summary.used_fallback_profile,
            "current behaviour: disabled manual-profile selection is silently treated as fallback"
        );
        assert_eq!(
            summary.resolved_profile_id.as_deref(),
            Some("default"),
            "resolved to fallback because disabled profile is invisible to find_profile"
        );
    }

    // -----------------------------------------------------------------------
    // Null / empty exe and title must not panic
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn matching_app_mappings_never_panics(
            exe in ".*",
            title in ".*",
        ) {
            let config = minimal_config(vec![
                simple_app_mapping("m1", "chrome.exe", "default"),
                simple_app_mapping("m2", "code.exe", "other"),
            ]);
            // Must not panic regardless of input
            let _result = matching_app_mappings(&config, &exe, &title, None);
        }
    }

    proptest! {
        #[test]
        fn resolve_profile_never_panics(
            exe in ".*",
            title in ".*",
        ) {
            let config = minimal_config(vec![]);
            let _result = resolve_profile_for_app_context(&config, &exe, &title, None);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: matching_app_mappings is case-insensitive on exe
    // -----------------------------------------------------------------------

    #[test]
    fn matching_app_mappings_case_insensitive_exe() {
        let config = minimal_config(vec![simple_app_mapping("m1", "Chrome.EXE", "other")]);

        // All of these should match
        assert!(!matching_app_mappings(&config, "chrome.exe", "", None).is_empty());
        assert!(!matching_app_mappings(&config, "CHROME.EXE", "", None).is_empty());
        assert!(!matching_app_mappings(&config, "Chrome.Exe", "", None).is_empty());

        // Different name should not match
        assert!(matching_app_mappings(&config, "firefox.exe", "", None).is_empty());
    }

    // -----------------------------------------------------------------------
    // Boundary: disabled app mappings are excluded from candidates
    // -----------------------------------------------------------------------

    #[test]
    fn disabled_app_mapping_is_excluded() {
        let mut mapping = simple_app_mapping("disabled-map", "test.exe", "other");
        mapping.enabled = false;
        let config = minimal_config(vec![mapping]);
        let result = matching_app_mappings(&config, "test.exe", "", None);
        assert!(result.is_empty(), "disabled mapping must not appear in candidates");
    }

    // -----------------------------------------------------------------------
    // Boundary: title_includes all-filter vs empty-filter
    // -----------------------------------------------------------------------

    #[test]
    fn title_includes_empty_matches_any_title() {
        let config = minimal_config(vec![simple_app_mapping("m1", "app.exe", "other")]);
        // title_includes is empty → no title constraint → any title matches
        assert!(!matching_app_mappings(&config, "app.exe", "anything at all", None).is_empty());
        assert!(!matching_app_mappings(&config, "app.exe", "", None).is_empty());
    }

    #[test]
    fn title_includes_nonempty_must_all_match() {
        let mut config = minimal_config(vec![]);
        let mut mapping = simple_app_mapping("m1", "app.exe", "other");
        mapping.title_includes = vec!["Inbox".into(), "Gmail".into()];
        config.app_mappings.push(mapping);

        // Title contains both → matches
        assert!(
            !matching_app_mappings(&config, "app.exe", "Gmail - Inbox", None).is_empty()
        );
        // Title contains only one → does NOT match (ALL must match)
        assert!(
            matching_app_mappings(&config, "app.exe", "Gmail - Sent", None).is_empty()
        );
        // Title contains neither → does not match
        assert!(
            matching_app_mappings(&config, "app.exe", "Other App", None).is_empty()
        );
    }

    // -----------------------------------------------------------------------
    // Priority sort: higher priority wins over lower priority
    // -----------------------------------------------------------------------

    #[test]
    fn higher_priority_mapping_wins() {
        let mut low = simple_app_mapping("low", "app.exe", "default");
        low.priority = 10;
        let mut high = simple_app_mapping("high", "app.exe", "other");
        high.priority = 200;
        let config = minimal_config(vec![low, high]);

        let result = matching_app_mappings(&config, "app.exe", "", None);
        assert!(!result.is_empty());
        assert_eq!(result[0].id, "high", "higher priority should be first");
    }

    // -----------------------------------------------------------------------
    // Overflow / null: empty encoder_mappings → Unresolved
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_input_preview_empty_encoder_mappings_is_unresolved() {
        let mut config = minimal_config(vec![]);
        config.encoder_mappings.clear();
        let result = resolve_input_preview(&config, "F13", "any.exe", "title", None);
        assert_eq!(result.status, ResolutionStatus::Unresolved);
    }

    // -----------------------------------------------------------------------
    // Overflow: duplicate encoder_mappings for the same encoded_key → Ambiguous
    // -----------------------------------------------------------------------

    #[test]
    fn duplicate_encoder_mappings_for_same_key_is_ambiguous() {
        let mut config = minimal_config(vec![]);
        // Add a second mapping with a different control but the same encoded_key
        config.encoder_mappings.push(crate::config::EncoderMapping {
            control_id: ControlId::Thumb02,
            layer: Layer::Standard,
            encoded_key: "F13".into(),
            source: MappingSource::Synapse,
            verified: false,
        });
        let result = resolve_input_preview(&config, "F13", "any.exe", "title", None);
        assert_eq!(result.status, ResolutionStatus::Ambiguous);
        assert_eq!(result.candidate_control_ids.len(), 2);
    }

    // -----------------------------------------------------------------------
    // Null: normalized_encoded_key never panics on arbitrary input
    // -----------------------------------------------------------------------

    proptest! {
        // Regression guard for the BUG-1 stack overflow: `.*` generates Cyrillic
        // chars outside the ЙЦУКЕН map (e.g. 'Ђ' U+0402, 'Є' U+0404, 'Ї' U+0407),
        // which previously made `parse_primary_key` (hotkeys.rs) recurse forever.
        // The recursion is now guarded to only recurse when normalization makes
        // progress, so this must never panic/overflow for any input.
        #[test]
        fn normalized_encoded_key_never_panics(s in ".*") {
            let _result = normalized_encoded_key(&s);
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: normalized_encoded_key is idempotent — normalizing twice
    // should give the same result as normalizing once (for valid hotkeys).
    // -----------------------------------------------------------------------

    #[test]
    fn normalized_encoded_key_idempotent_for_valid_keys() {
        let keys = ["F13", "Ctrl+F13", "ctrl+alt+f13", "  F13  ", "CTRL+SHIFT+F13"];
        for &key in &keys {
            let once = normalized_encoded_key(key);
            let twice = normalized_encoded_key(&once);
            assert_eq!(once, twice, "normalizing `{key}` twice should be idempotent");
        }
    }

    // -----------------------------------------------------------------------
    // Null: whitespace-only and empty encoded_key falls back gracefully
    // -----------------------------------------------------------------------

    #[test]
    fn normalized_encoded_key_empty_string_no_panic() {
        let result = normalized_encoded_key("");
        // Should return the trimmed original ("") rather than panic
        assert_eq!(result, "");
    }

    #[test]
    fn normalized_encoded_key_whitespace_only_no_panic() {
        let result = normalized_encoded_key("   ");
        // normalize_hotkey returns Err for whitespace-only → fallback is raw.trim()
        assert_eq!(result, "");
    }

    // -----------------------------------------------------------------------
    // Concurrency: N/A — resolver functions are stateless, all state lives in
    // the caller-provided &AppConfig; no OnceLock/static in resolver.rs.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Temporal: N/A — no time-dependent logic in resolver.rs.
    // -----------------------------------------------------------------------
}
