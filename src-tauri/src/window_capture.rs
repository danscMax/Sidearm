use serde::Serialize;
use std::{path::Path, thread, time::Duration};

use crate::config::AppConfig;
use crate::resolver::{find_profile, matching_app_mappings};
use crate::runtime::timestamp_millis;

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
struct RawWindowCapture {
    hwnd: String,
    pid: u32,
    exe: String,
    process_path: String,
    title: String,
    captured_at: u64,
    is_elevated: bool,
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

#[cfg(target_os = "windows")]
fn capture_foreground_window() -> Result<RawWindowCapture, String> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        },
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

        let title_len = GetWindowTextLengthW(hwnd);
        let mut title_buffer = vec![0u16; (title_len as usize).max(1) + 1];
        let actual_len = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title = String::from_utf16_lossy(&title_buffer[..actual_len.max(0) as usize]);

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
            if success == 0 {
                CloseHandle(process_handle);
                return Err("Failed to resolve the foreground process path.".into());
            }
            String::from_utf16_lossy(&path_buffer[..path_length as usize])
        };

        let is_elevated = is_process_elevated(process_handle);
        CloseHandle(process_handle);

        let exe = Path::new(&process_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&process_path)
            .to_ascii_lowercase();

        Ok(RawWindowCapture {
            hwnd: format!("0x{:X}", hwnd as usize),
            pid,
            exe,
            process_path,
            title,
            captured_at: timestamp_millis(),
            is_elevated,
        })
    }
}

/// Check whether a process is running with elevated privileges (admin token).
///
/// When our app runs non-elevated, `OpenProcessToken` fails with
/// `ERROR_ACCESS_DENIED` for elevated targets (UIPI blocks token access).
/// We treat access-denied as "elevated" — in all such cases `SendInput`
/// would also be blocked, so the warning is correct regardless.
#[cfg(target_os = "windows")]
unsafe fn is_process_elevated(process_handle: windows_sys::Win32::Foundation::HANDLE) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ACCESS_DENIED},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::OpenProcessToken,
    };

    let mut token_handle = std::ptr::null_mut();
    if OpenProcessToken(process_handle, TOKEN_QUERY, &mut token_handle) == 0 {
        // Access denied → target is likely elevated (or protected).
        // Either way, SendInput won't reach it.
        let err = std::io::Error::last_os_error();
        return err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32);
    }

    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut return_length = 0u32;
    let ok = GetTokenInformation(
        token_handle,
        TokenElevation,
        &mut elevation as *mut _ as *mut _,
        std::mem::size_of::<TOKEN_ELEVATION>() as u32,
        &mut return_length,
    );
    CloseHandle(token_handle);
    ok != 0 && elevation.TokenIsElevated != 0
}

/// Check whether the current process itself is running elevated (admin).
///
/// Used at startup to log the privilege level — helps diagnose UIPI issues
/// where `RegisterHotKey` or `SendInput` silently fail against elevated targets.
pub fn is_current_process_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        // Safety: GetCurrentProcess returns a pseudo-handle (-1) that is always valid
        // and does not need to be closed.
        unsafe { is_process_elevated(GetCurrentProcess()) }
    }
    #[cfg(not(target_os = "windows"))]
    false
}

#[cfg(not(target_os = "windows"))]
fn capture_foreground_window() -> Result<RawWindowCapture, String> {
    Err("Foreground window capture is only implemented for Windows.".into())
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
    fn is_process_elevated_returns_false_for_current_non_admin_process() {
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let elevated = unsafe {
            let handle = GetCurrentProcess();
            // GetCurrentProcess returns a pseudo-handle (-1) that does not need closing.
            super::is_process_elevated(handle)
        };

        assert!(
            !elevated,
            "Test process should not be elevated (running without admin)"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn is_process_elevated_returns_true_for_system_process() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        };

        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, 4);
            if handle.is_null() {
                // Cannot open System process — skip test.
                return;
            }

            let elevated = super::is_process_elevated(handle);
            CloseHandle(handle);

            // OpenProcessToken fails with ERROR_ACCESS_DENIED for PID 4,
            // which we now treat as "elevated" (SendInput would also fail).
            assert!(
                elevated,
                "is_process_elevated should return true when token access is denied"
            );
        }
    }
}
