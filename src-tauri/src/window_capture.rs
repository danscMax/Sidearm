use serde::Serialize;
use std::{thread, time::Duration};

use crate::config::AppConfig;
use crate::resolver::{find_profile, matching_app_mappings};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowCaptureResult {
    pub hwnd: String,
    pub exe: String,
    pub process_path: String,
    pub title: String,
    pub captured_at: u64,
    pub ignored: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignore_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_app_mapping_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_profile_name: Option<String>,
    pub used_fallback_profile: bool,
    pub candidate_app_mapping_ids: Vec<String>,
    pub resolution_reason: String,
    /// Whether the foreground process is running elevated (admin).
    /// When `true`, `SendInput` will fail silently due to UIPI.
    pub is_elevated: bool,
}

pub fn capture_active_window_with_resolution(
    config: &AppConfig,
    _app_name: &str,
    delay_ms: Option<u64>,
) -> Result<WindowCaptureResult, String> {
    if let Some(delay_ms) = delay_ms {
        thread::sleep(Duration::from_millis(delay_ms.min(10_000)));
    }

    let raw_window = capture_foreground_window()?;
    let is_ignored = should_ignore_window(raw_window.pid);
    let capture_result = if is_ignored {
        WindowCaptureResult {
            hwnd: raw_window.hwnd,
            exe: raw_window.exe,
            process_path: raw_window.process_path,
            title: raw_window.title,
            captured_at: raw_window.captured_at,
            ignored: true,
            ignore_reason: Some("Foreground window belongs to the Studio process.".into()),
            matched_app_mapping_id: None,
            resolved_profile_id: None,
            resolved_profile_name: None,
            used_fallback_profile: false,
            candidate_app_mapping_ids: Vec::new(),
            resolution_reason: "Ignored studio-owned window.".into(),
            is_elevated: raw_window.is_elevated,
        }
    } else {
        resolve_capture_result(config, raw_window)
    };

    Ok(capture_result)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RawWindowCapture {
    pub(crate) hwnd: String,
    pub(crate) pid: u32,
    pub(crate) exe: String,
    pub(crate) process_path: String,
    pub(crate) title: String,
    pub(crate) captured_at: u64,
    pub(crate) is_elevated: bool,
}

fn resolve_capture_result(config: &AppConfig, raw_window: RawWindowCapture) -> WindowCaptureResult {
    let fallback_profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == config.settings.fallback_profile_id);
    let candidates = matching_app_mappings(config, &raw_window.exe, &raw_window.title);
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

    WindowCaptureResult {
        hwnd: raw_window.hwnd,
        exe: raw_window.exe,
        process_path: raw_window.process_path,
        title: raw_window.title,
        captured_at: raw_window.captured_at,
        ignored: false,
        ignore_reason: None,
        matched_app_mapping_id: winner.map(|mapping| mapping.id.clone()),
        resolved_profile_id: resolved_profile.map(|profile| profile.id.clone()),
        resolved_profile_name: resolved_profile.map(|profile| profile.name.clone()),
        used_fallback_profile,
        candidate_app_mapping_ids: candidates
            .into_iter()
            .map(|mapping| mapping.id.clone())
            .collect(),
        resolution_reason,
        is_elevated: raw_window.is_elevated,
    }
}

/// Returns true if the foreground window belongs to our own process.
/// Uses PID comparison — foolproof regardless of exe naming (hyphens vs spaces).
fn should_ignore_window(foreground_pid: u32) -> bool {
    foreground_pid == std::process::id()
}

fn capture_foreground_window() -> Result<RawWindowCapture, String> {
    #[cfg(target_os = "windows")]
    return crate::platform::window::capture_foreground_window();
    #[cfg(target_os = "linux")]
    return crate::platform::window::capture_foreground_window();
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    return Err("Foreground window capture is not implemented for this platform.".into());
}

/// Check whether the current process itself is running elevated (admin/root).
///
/// Used at startup to log the privilege level — helps diagnose UIPI issues
/// on Windows or permission issues on Linux.
pub fn is_current_process_elevated() -> bool {
    #[cfg(target_os = "windows")]
    return crate::platform::window::is_current_process_elevated();
    #[cfg(target_os = "linux")]
    return crate::platform::window::is_current_process_elevated();
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    return false;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        Action, ActionPayload, ActionType, AppConfig, AppMapping, Binding, CapabilityStatus,
        ControlFamily, ControlId, EncoderMapping, Layer, MappingSource, OsdAnimation, OsdFontSize,
        OsdPosition, PhysicalControl, Profile, Settings, SnippetLibraryItem,
    };

    #[test]
    fn prefers_more_specific_title_filtered_mapping() {
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

        let result = resolve_capture_result(
            &config,
            RawWindowCapture {
                hwnd: "0x123".into(),
                pid: 9999,
                exe: "code.exe".into(),
                process_path: "C:\\Apps\\code.exe".into(),
                title: "Pull Request Review".into(),
                captured_at: 1,
                is_elevated: false,
            },
        );

        assert_eq!(
            result.matched_app_mapping_id.as_deref(),
            Some("app-code-review")
        );
        assert_eq!(result.resolved_profile_id.as_deref(), Some("review"));
    }

    #[test]
    fn falls_back_when_no_mapping_matches() {
        let config = test_config(vec![app_mapping(
            "app-code",
            "code.exe",
            "code",
            200,
            vec![],
        )]);

        let result = resolve_capture_result(
            &config,
            RawWindowCapture {
                hwnd: "0x123".into(),
                pid: 9999,
                exe: "chrome.exe".into(),
                process_path: "C:\\Apps\\chrome.exe".into(),
                title: "Docs".into(),
                captured_at: 1,
                is_elevated: false,
            },
        );

        assert!(result.used_fallback_profile);
        assert_eq!(result.resolved_profile_id.as_deref(), Some("default"));
        assert!(result.matched_app_mapping_id.is_none());
    }

    #[test]
    fn title_includes_requires_all_needles() {
        let config = test_config(vec![app_mapping(
            "app-code-review",
            "code.exe",
            "review",
            200,
            vec!["pull request", "review"],
        )]);

        let result = resolve_capture_result(
            &config,
            RawWindowCapture {
                hwnd: "0x123".into(),
                pid: 9999,
                exe: "code.exe".into(),
                process_path: "C:\\Apps\\code.exe".into(),
                title: "Pull Request".into(),
                captured_at: 1,
                is_elevated: false,
            },
        );

        assert!(result.used_fallback_profile);
        assert_eq!(result.resolved_profile_id.as_deref(), Some("default"));
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
                modifier_stale_gc_ms: None,
                last_selected_profile_id: None,
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

    #[cfg(target_os = "windows")]
    #[test]
    fn is_current_process_not_elevated_without_admin() {
        assert!(
            !super::is_current_process_elevated(),
            "Test process should not be elevated (running without admin)"
        );
    }
}
