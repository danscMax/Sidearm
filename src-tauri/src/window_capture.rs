use serde::Serialize;
use std::{
    path::Path,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::config::{AppConfig, AppMapping, Profile};

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
}

pub fn capture_active_window_with_resolution(
    config: &AppConfig,
    app_name: &str,
    delay_ms: Option<u64>,
) -> Result<WindowCaptureResult, String> {
    if let Some(delay_ms) = delay_ms {
        thread::sleep(Duration::from_millis(delay_ms.min(10_000)));
    }

    let raw_window = capture_foreground_window()?;
    let is_ignored = should_ignore_window(&raw_window.exe, &raw_window.process_path, app_name);
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
        }
    } else {
        resolve_capture_result(config, raw_window)
    };

    Ok(capture_result)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RawWindowCapture {
    hwnd: String,
    exe: String,
    process_path: String,
    title: String,
    captured_at: u64,
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
    }
}

fn matching_app_mappings<'a>(config: &'a AppConfig, exe: &str, title: &str) -> Vec<&'a AppMapping> {
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
                    .all(|needle| normalized_title.contains(&needle.to_ascii_lowercase()))
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

fn find_profile<'a>(config: &'a AppConfig, profile_id: &str) -> Option<&'a Profile> {
    config
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.enabled)
}

fn should_ignore_window(exe: &str, process_path: &str, app_name: &str) -> bool {
    let normalized_exe = exe.to_ascii_lowercase();
    let normalized_path = process_path.to_ascii_lowercase();
    let normalized_app_name = app_name.to_ascii_lowercase();

    normalized_exe == format!("{normalized_app_name}.exe")
        || Path::new(process_path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case(app_name))
        || normalized_path.contains(&normalized_app_name)
}

#[cfg(target_os = "windows")]
fn capture_foreground_window() -> Result<RawWindowCapture, String> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId},
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return Err("No foreground window is available.".into());
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return Err("Failed to resolve the foreground window process id.".into());
        }

        let mut title_buffer = vec![0u16; 2048];
        let title_length =
            GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title = String::from_utf16_lossy(&title_buffer[..title_length.max(0) as usize]);

        let process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process_handle.is_null() {
            return Err(format!("Failed to open foreground process {pid}."));
        }

        let process_path = {
            let mut path_buffer = vec![0u16; 260];
            let mut path_length = path_buffer.len() as u32;
            let success = QueryFullProcessImageNameW(
                process_handle,
                0,
                path_buffer.as_mut_ptr(),
                &mut path_length,
            );
            let process_path = if success == 0 {
                CloseHandle(process_handle);
                return Err("Failed to resolve the foreground process path.".into());
            } else {
                String::from_utf16_lossy(&path_buffer[..path_length as usize])
            };

            CloseHandle(process_handle);
            process_path
        };

        let exe = Path::new(&process_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&process_path)
            .to_ascii_lowercase();

        Ok(RawWindowCapture {
            hwnd: format!("0x{:X}", hwnd as usize),
            exe,
            process_path,
            title,
            captured_at: timestamp_millis(),
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_foreground_window() -> Result<RawWindowCapture, String> {
    Err("Foreground window capture is only implemented for Windows.".into())
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
    use crate::config::{
        Action, ActionPayload, ActionType, AppConfig, Binding, CapabilityStatus, ControlFamily,
        ControlId, EncoderMapping, Layer, MappingSource, PhysicalControl, Profile, Settings,
        SnippetLibraryItem,
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
                exe: "code.exe".into(),
                process_path: "C:\\Apps\\code.exe".into(),
                title: "Pull Request Review".into(),
                captured_at: 1,
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
                exe: "chrome.exe".into(),
                process_path: "C:\\Apps\\chrome.exe".into(),
                title: "Docs".into(),
                captured_at: 1,
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
                exe: "code.exe".into(),
                process_path: "C:\\Apps\\code.exe".into(),
                title: "Pull Request".into(),
                captured_at: 1,
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
                enabled: true,
            }],
            actions: vec![Action {
                id: "action-default-standard-thumb-01".into(),
                action_type: ActionType::Disabled,
                payload: ActionPayload::Disabled(Default::default()),
                pretty: "Disabled".into(),
                notes: None,
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
            title_includes: title_includes.into_iter().map(str::to_owned).collect(),
            profile_id: profile_id.into(),
            enabled: true,
            priority,
        }
    }
}
