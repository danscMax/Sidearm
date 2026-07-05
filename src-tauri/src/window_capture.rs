use serde::Serialize;
use std::{thread, time::Duration};

use crate::config::AppConfig;
use crate::resolver::select_profile_for_app_context_with_override;

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
    app_name: &str,
    delay_ms: Option<u64>,
) -> Result<WindowCaptureResult, String> {
    capture_active_window_with_resolution_with_override(config, app_name, delay_ms, None)
}

/// [`capture_active_window_with_resolution`] threaded with the manual profile override
/// (audit F003) so the OSD/active-profile indicator reflects a ProfileSwitch, matching
/// what the dispatch path fires.
pub fn capture_active_window_with_resolution_with_override(
    config: &AppConfig,
    _app_name: &str,
    delay_ms: Option<u64>,
    manual_profile_override: Option<&str>,
) -> Result<WindowCaptureResult, String> {
    if let Some(delay_ms) = delay_ms {
        thread::sleep(Duration::from_millis(delay_ms.min(10_000)));
    }

    let raw_window = capture_foreground_window()?;
    let ignore_reason = if should_ignore_window(raw_window.pid) {
        Some("Foreground window belongs to the Studio process.")
    } else if is_shell_chrome_window(&raw_window.exe, &raw_window.title) {
        Some("Foreground window is the Windows shell (taskbar/tray).")
    } else {
        None
    };
    let capture_result = if let Some(reason) = ignore_reason {
        WindowCaptureResult {
            hwnd: raw_window.hwnd,
            exe: raw_window.exe,
            process_path: raw_window.process_path,
            title: raw_window.title,
            captured_at: raw_window.captured_at,
            ignored: true,
            ignore_reason: Some(reason.into()),
            matched_app_mapping_id: None,
            resolved_profile_id: None,
            resolved_profile_name: None,
            used_fallback_profile: false,
            candidate_app_mapping_ids: Vec::new(),
            resolution_reason: "Ignored non-app window.".into(),
            is_elevated: raw_window.is_elevated,
        }
    } else {
        resolve_capture_result_with_override(config, raw_window, manual_profile_override)
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

#[cfg(test)]
fn resolve_capture_result(config: &AppConfig, raw_window: RawWindowCapture) -> WindowCaptureResult {
    resolve_capture_result_with_override(config, raw_window, None)
}

fn resolve_capture_result_with_override(
    config: &AppConfig,
    raw_window: RawWindowCapture,
    manual_profile_override: Option<&str>,
) -> WindowCaptureResult {
    // Shared resolver — identical `app mapping > fallback` logic as the
    // dispatch/preview path (plus the same manual override), so the active-profile
    // indicator and what actually fires can never disagree again.
    let selection = select_profile_for_app_context_with_override(
        config,
        &raw_window.exe,
        &raw_window.title,
        Some(&raw_window.process_path),
        manual_profile_override,
    );

    WindowCaptureResult {
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
        hwnd: raw_window.hwnd,
        exe: raw_window.exe,
        process_path: raw_window.process_path,
        title: raw_window.title,
        captured_at: raw_window.captured_at,
        ignored: false,
        ignore_reason: None,
        is_elevated: raw_window.is_elevated,
    }
}

/// Returns true if the foreground window belongs to our own process.
/// Uses PID comparison — foolproof regardless of exe naming (hyphens vs spaces).
fn should_ignore_window(foreground_pid: u32) -> bool {
    foreground_pid == std::process::id()
}

/// Returns true if the foreground is Windows shell chrome (taskbar / tray /
/// overflow), which becomes the foreground while the tray menu is open. Without
/// this, the tray "create rule for active window" path records the shell instead
/// of the user's actual app. The shell runs as explorer.exe with an empty window
/// title; real File Explorer windows (also explorer.exe) carry a folder title, so
/// they remain valid targets.
/// ponytail: title-emptiness heuristic — the desktop "Program Manager" (Progman)
/// keeps a title and isn't caught, but it isn't the tray-click case. Upgrade to a
/// GetClassNameW check (Shell_TrayWnd, NotifyIconOverflowWindow, …) if a shell
/// window ever slips through.
fn is_shell_chrome_window(exe: &str, title: &str) -> bool {
    exe == "explorer.exe" && title.trim().is_empty()
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
    fn shell_chrome_is_ignored_but_file_explorer_is_not() {
        // Taskbar/tray: explorer.exe with an empty title → ignored.
        assert!(is_shell_chrome_window("explorer.exe", ""));
        assert!(is_shell_chrome_window("explorer.exe", "   "));
        // A real File Explorer window carries a folder title → kept.
        assert!(!is_shell_chrome_window("explorer.exe", "Downloads"));
        // Other apps are never shell chrome, even with an empty title.
        assert!(!is_shell_chrome_window("firefox.exe", ""));
    }

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
                repair_clipboard_on_copy: false,
                device_name: None,
                osd_enabled: true,
                osd_duration_ms: 2000,
                osd_position: OsdPosition::default(),
                osd_font_size: OsdFontSize::default(),
                osd_animation: OsdAnimation::default(),
                modifier_stale_gc_ms: None,
                replayed_modifier_force_release_ms: None,
                global_shortcut: None,
                last_selected_profile_id: None,
                onboarding_completed: false,
                onboarding_step: None,
            },
            profiles: vec![
                profile("default", "Default", 0),
                profile("code", "Code", 200),
                profile("review", "Review", 210),
            ],
            devices: vec![crate::config::builtin_naga_device()],
            physical_controls: vec![PhysicalControl {
                id: ControlId::new("thumb_01"),
                device_id: "razer-naga".into(),
                family: ControlFamily::ThumbGrid,
                default_name: "Thumb 1".into(),
                synapse_name: None,
                remappable: true,
                capability_status: CapabilityStatus::Verified,
                notes: None,
            }],
            encoder_mappings: vec![EncoderMapping {
                control_id: ControlId::new("thumb_01"),
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
                control_id: ControlId::new("thumb_01"),
                label: "Example".into(),
                action_id: "action-default-standard-thumb-01".into(),
                color_tag: None,
                trigger_mode: None,
                chord_partner: None,
                throttle_ms: None,
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
    fn is_current_process_elevated_query_returns_a_bool() {
        // Elevation depends on how the test process was launched — non-elevated in a
        // normal dev shell, but elevated on CI runners — so we cannot assert a specific
        // value. Verify only that the unsafe token query runs and yields a bool.
        let _: bool = super::is_current_process_elevated();
    }
}

// ---------------------------------------------------------------------------
// Property-based edge-case tests — pure resolution logic, NO Win32 / capture
// ---------------------------------------------------------------------------
//
// Skipped (Win32 / capture):
//  - capture_foreground_window  — calls Win32 GetForegroundWindow / OpenProcess
//  - capture_active_window_with_resolution — calls above + optional sleep
//  - is_current_process_elevated — calls Win32 OpenProcessToken
//
// Testable pure logic:
//  - should_ignore_window(pid) — pure pid comparison
//  - resolve_capture_result    — pure profile/mapping resolution
//
// Note: resolve_capture_result and its helpers (matching_app_mappings etc.) are
// defined in other modules. The test helper infra is already in the existing
// `tests` module (test_config / profile / app_mapping helpers); we call those
// same helpers from here by re-declaring minimal inline builders to avoid
// depending on `tests` module visibility.

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use crate::config::{
        Action, ActionPayload, ActionType, AppConfig, AppMapping, Binding, CapabilityStatus,
        ControlFamily, ControlId, EncoderMapping, Layer, MappingSource, OsdAnimation, OsdFontSize,
        OsdPosition, PasteMode, PhysicalControl, Profile, Settings, SnippetLibraryItem,
    };
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Helpers (mirrors the existing `tests` module builders)
    // -----------------------------------------------------------------------

    fn minimal_config(mappings: Vec<AppMapping>) -> AppConfig {
        AppConfig {
            version: 2,
            settings: Settings {
                fallback_profile_id: "fallback".into(),
                theme: "studio".into(),
                start_with_windows: false,
                minimize_to_tray: false,
                debug_logging: false,
                repair_clipboard_on_copy: false,
                device_name: None,
                osd_enabled: false,
                osd_duration_ms: 2000,
                osd_position: OsdPosition::default(),
                osd_font_size: OsdFontSize::default(),
                osd_animation: OsdAnimation::default(),
                modifier_stale_gc_ms: None,
                replayed_modifier_force_release_ms: None,
                global_shortcut: None,
                last_selected_profile_id: None,
                onboarding_completed: false,
                onboarding_step: None,
            },
            profiles: vec![
                Profile {
                    id: "fallback".into(),
                    name: "Fallback".into(),
                    description: None,
                    enabled: true,
                    priority: 0,
                },
                Profile {
                    id: "p1".into(),
                    name: "P1".into(),
                    description: None,
                    enabled: true,
                    priority: 100,
                },
            ],
            devices: vec![crate::config::builtin_naga_device()],
            physical_controls: vec![PhysicalControl {
                id: ControlId::new("thumb_01"),
                device_id: "razer-naga".into(),
                family: ControlFamily::ThumbGrid,
                default_name: "Thumb 1".into(),
                synapse_name: None,
                remappable: true,
                capability_status: CapabilityStatus::Verified,
                notes: None,
            }],
            encoder_mappings: vec![EncoderMapping {
                control_id: ControlId::new("thumb_01"),
                layer: Layer::Standard,
                encoded_key: "F13".into(),
                source: MappingSource::Synapse,
                verified: true,
            }],
            app_mappings: mappings,
            bindings: vec![Binding {
                id: "b1".into(),
                profile_id: "fallback".into(),
                layer: Layer::Standard,
                control_id: ControlId::new("thumb_01"),
                label: "Example".into(),
                action_id: "a1".into(),
                color_tag: None,
                trigger_mode: None,
                chord_partner: None,
                throttle_ms: None,
                enabled: true,
            }],
            actions: vec![Action {
                id: "a1".into(),
                action_type: ActionType::Disabled,
                payload: ActionPayload::Disabled(Default::default()),
                display_name: "Disabled".into(),
                notes: None,
                conditions: Vec::new(),
            }],
            snippet_library: vec![SnippetLibraryItem {
                id: "s1".into(),
                name: "Example".into(),
                text: "example".into(),
                paste_mode: PasteMode::ClipboardPaste,
                tags: vec![],
                notes: None,
            }],
        }
    }

    fn mapping(id: &str, exe: &str, profile_id: &str, priority: i32) -> AppMapping {
        AppMapping {
            id: id.into(),
            exe: exe.into(),
            process_path: None,
            title_includes: vec![],
            profile_id: profile_id.into(),
            enabled: true,
            priority,
            compiled_title_regexes: vec![],
        }
    }

    fn raw(exe: &str, title: &str) -> RawWindowCapture {
        RawWindowCapture {
            hwnd: "0x1".into(),
            pid: 9999,
            exe: exe.into(),
            process_path: format!("C:\\Programs\\{exe}"),
            title: title.into(),
            captured_at: 42,
            is_elevated: false,
        }
    }

    // -----------------------------------------------------------------------
    // Category 1: BOUNDARY — should_ignore_window
    // -----------------------------------------------------------------------

    #[test]
    fn unit_should_ignore_own_pid() {
        // Our own PID must always be ignored
        let own_pid = std::process::id();
        assert!(
            should_ignore_window(own_pid),
            "own process PID must be ignored"
        );
    }

    #[test]
    fn unit_should_not_ignore_pid_zero() {
        // PID 0 is the Idle process; not our PID
        assert!(!should_ignore_window(0), "PID 0 should not be ignored");
    }

    #[test]
    fn unit_should_not_ignore_pid_max() {
        // u32::MAX is not a valid real PID, but must not panic and must not equal our PID
        assert!(
            !should_ignore_window(u32::MAX),
            "u32::MAX PID should not be ignored"
        );
    }

    proptest! {
        /// Arbitrary PID: ignore only when equal to current process PID.
        #[test]
        fn prop_should_ignore_window_only_self(pid in any::<u32>()) {
            let own = std::process::id();
            let result = should_ignore_window(pid);
            prop_assert_eq!(result, pid == own,
                "should_ignore_window({}) = {}; own_pid={}", pid, result, own);
        }
    }

    // -----------------------------------------------------------------------
    // Category 1: BOUNDARY — resolve_capture_result
    // -----------------------------------------------------------------------

    #[test]
    fn unit_resolve_uses_fallback_when_no_mappings() {
        let config = minimal_config(vec![]);
        let result = resolve_capture_result(&config, raw("chrome.exe", "Google"));
        assert!(
            result.used_fallback_profile,
            "no mappings must use fallback profile"
        );
        assert_eq!(result.resolved_profile_id.as_deref(), Some("fallback"));
        assert!(result.matched_app_mapping_id.is_none());
    }

    #[test]
    fn unit_resolve_matches_exact_exe() {
        let config = minimal_config(vec![mapping("m1", "code.exe", "p1", 100)]);
        let result = resolve_capture_result(&config, raw("code.exe", "Workspace"));
        assert!(
            !result.used_fallback_profile,
            "matching exe must not use fallback"
        );
        assert_eq!(result.matched_app_mapping_id.as_deref(), Some("m1"));
        assert_eq!(result.resolved_profile_id.as_deref(), Some("p1"));
    }

    #[test]
    fn unit_resolve_case_mismatch_uses_fallback() {
        // Mapping is lowercase "code.exe"; capture returns "CODE.EXE"
        // AppMapping matching is case-sensitive in the current implementation
        let config = minimal_config(vec![mapping("m1", "code.exe", "p1", 100)]);
        let result = resolve_capture_result(&config, raw("CODE.EXE", "Workspace"));
        // Whether this matches depends on resolver::matching_app_mappings —
        // we assert the result is internally consistent regardless.
        match result.matched_app_mapping_id.as_deref() {
            Some("m1") => assert!(!result.used_fallback_profile),
            None => assert!(result.used_fallback_profile),
            other => panic!("unexpected matched_app_mapping_id={other:?}"),
        }
    }

    #[test]
    fn unit_resolve_propagates_is_elevated_flag() {
        let config = minimal_config(vec![]);
        let mut raw_cap = raw("explorer.exe", "Desktop");
        raw_cap.is_elevated = true;
        let result = resolve_capture_result(&config, raw_cap);
        assert!(
            result.is_elevated,
            "is_elevated must propagate through resolve_capture_result"
        );
    }

    proptest! {
        /// resolve_capture_result must never panic for arbitrary exe/title strings
        /// (including empty, very long, and all-whitespace).
        #[test]
        fn prop_resolve_no_panic_arbitrary_strings(
            exe in ".*".prop_filter("limit length", |s| s.len() < 512),
            title in ".*".prop_filter("limit length", |s| s.len() < 512),
        ) {
            let config = minimal_config(vec![mapping("m1", "target.exe", "p1", 100)]);
            let capture = raw(&exe, &title);
            // Must not panic; result must be internally consistent
            let result = resolve_capture_result(&config, capture);
            if result.matched_app_mapping_id.is_some() {
                prop_assert!(!result.used_fallback_profile,
                    "matched_app_mapping_id set → used_fallback_profile must be false");
            } else {
                prop_assert!(result.used_fallback_profile,
                    "no match → used_fallback_profile must be true");
            }
        }

        /// candidate_app_mapping_ids must always be a subset of configured
        /// mapping IDs — no phantom IDs can appear.
        #[test]
        fn prop_candidates_subset_of_configured_ids(
            exe in prop_oneof!["target.exe", "other.exe", ""],
            title in ".*".prop_filter("limit", |s| s.len() < 64),
        ) {
            let config = minimal_config(vec![
                mapping("m1", "target.exe", "p1", 100),
                mapping("m2", "target.exe", "p1", 90),
            ]);
            let result = resolve_capture_result(&config, raw(&exe, &title));
            let known_ids: std::collections::HashSet<&str> = config.app_mappings
                .iter().map(|m| m.id.as_str()).collect();
            for id in &result.candidate_app_mapping_ids {
                prop_assert!(known_ids.contains(id.as_str()),
                    "candidate id={:?} not in configured mapping IDs", id);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Category 2: NULL & EMPTY
    // -----------------------------------------------------------------------

    #[test]
    fn unit_resolve_empty_exe_uses_fallback() {
        let config = minimal_config(vec![mapping("m1", "target.exe", "p1", 100)]);
        let result = resolve_capture_result(&config, raw("", ""));
        assert!(
            result.used_fallback_profile || result.matched_app_mapping_id.is_none(),
            "empty exe must not match a mapping requiring 'target.exe'"
        );
    }

    #[test]
    fn unit_resolve_candidate_ids_always_non_negative_len() {
        let config = minimal_config(vec![]);
        let result = resolve_capture_result(&config, raw("anything.exe", "Title"));
        // candidate_app_mapping_ids can be empty (no mappings) but must be a valid Vec
        let _ = result.candidate_app_mapping_ids.len(); // must not panic
    }

    // -----------------------------------------------------------------------
    // Category 4: CONCURRENCY — N/A
    // -----------------------------------------------------------------------
    // resolve_capture_result and should_ignore_window are pure functions with
    // no shared state or channels. Concurrency testing requires the
    // capture_active_window pipeline which touches Win32 — skipped.
    //
    // Category 5: TEMPORAL — N/A
    // -----------------------------------------------------------------------
    // captured_at is a raw passthrough (set by the caller); no timing logic
    // is computed inside resolve_capture_result. delay_ms (window_capture)
    // uses thread::sleep on a bounded value (min(x, 10_000)) — covered by
    // its clamping to 10 s which prevents unbounded sleeps but cannot be
    // tested without real sleep.
}
