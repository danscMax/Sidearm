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

pub fn resolve_profile_for_app_context(
    config: &AppConfig,
    exe: &str,
    title: &str,
) -> ProfileResolutionSummary {
    let fallback_profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == config.settings.fallback_profile_id);
    let candidates = matching_app_mappings(config, exe, title);
    let winner = candidates.first().copied();
    let resolved_profile = winner
        .and_then(|mapping| find_profile(config, &mapping.profile_id))
        .or(fallback_profile);

    let used_fallback_profile = winner.is_none();
    let resolution_reason = if let Some(mapping) = winner {
        format!("Matched app mapping `{}`.", mapping.id)
    } else {
        format!(
            "No matching app mapping found. Using fallback profile `{}`.",
            config.settings.fallback_profile_id
        )
    };

    ProfileResolutionSummary {
        matched_app_mapping_id: winner.map(|mapping| mapping.id.clone()),
        resolved_profile_id: resolved_profile.map(|profile| profile.id.clone()),
        resolved_profile_name: resolved_profile.map(|profile| profile.name.clone()),
        used_fallback_profile,
        candidate_app_mapping_ids: candidates
            .into_iter()
            .map(|mapping| mapping.id.clone())
            .collect(),
        resolution_reason,
    }
}

pub fn resolve_input_preview(
    config: &AppConfig,
    encoded_key: &str,
    exe: &str,
    title: &str,
) -> ResolvedInputPreview {
    let normalized_key = normalized_encoded_key(encoded_key);
    let profile_resolution = resolve_profile_for_app_context(config, exe, title);
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
            .find(|action| action.id == binding.action_ref)
    });

    let (status, reason) = if binding.is_some() && action.is_some() {
        (
            ResolutionStatus::Resolved,
            format!(
                "Resolved `{normalized_key}` to `{}` / `{}`.",
                mapping.control_id.as_str(),
                mapping.layer.as_str()
            ),
        )
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
        action_pretty: action.map(|action| action.pretty.clone()),
        mapping_verified: Some(mapping.verified),
        mapping_source: Some(mapping_source_name(mapping).to_owned()),
        trigger_mode: binding.and_then(|b| b.trigger_mode),
    }
}

pub(crate) fn matching_app_mappings<'a>(
    config: &'a AppConfig,
    exe: &str,
    title: &str,
) -> Vec<&'a AppMapping> {
    let normalized_exe = exe.to_ascii_lowercase();
    let normalized_title = title.to_ascii_lowercase();
    let mut matches: Vec<&AppMapping> = config
        .app_mappings
        .iter()
        .filter(|mapping| mapping.enabled)
        .filter(|mapping| mapping.exe.eq_ignore_ascii_case(&normalized_exe))
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
        Action, ActionPayload, ActionType, Binding, CapabilityStatus, ControlFamily, ControlId,
        Layer, MappingSource, OsdAnimation, OsdFontSize, OsdPosition, PhysicalControl, Settings,
        SnippetLibraryItem, TriggerMode,
    };

    #[test]
    fn resolve_input_preview_uses_fallback_profile() {
        let config = test_config(vec![]);

        let result = resolve_input_preview(&config, "F13", "chrome.exe", "Docs");

        assert_eq!(result.status, ResolutionStatus::Resolved);
        assert_eq!(result.resolved_profile_id.as_deref(), Some("default"));
        assert!(result.used_fallback_profile);
    }

    #[test]
    fn resolve_input_preview_reports_missing_mapping() {
        let config = test_config(vec![]);

        let result = resolve_input_preview(&config, "F99", "chrome.exe", "Docs");

        assert_eq!(result.status, ResolutionStatus::Unresolved);
        assert!(result.reason.contains("No encoder mapping exists"));
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

        let result = resolve_input_preview(&config, "F13", "code.exe", "Pull Request Review");

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
                osd_enabled: true,
                osd_duration_ms: 2000,
                osd_position: OsdPosition::default(),
                osd_font_size: OsdFontSize::default(),
                osd_animation: OsdAnimation::default(),
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
                action_ref: "action-default-standard-thumb-01".into(),
                color_tag: None,
                trigger_mode: None,
                chord_partner: None,
                enabled: true,
            }],
            actions: vec![Action {
                id: "action-default-standard-thumb-01".into(),
                action_type: ActionType::Disabled,
                payload: ActionPayload::Disabled(Default::default()),
                pretty: "Disabled".into(),
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

        let result = resolve_input_preview(&config, "F13", "chrome.exe", "Docs");

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
}
