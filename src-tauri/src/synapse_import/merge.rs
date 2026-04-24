//! Apply `ParsedSynapseProfiles` into an existing `AppConfig`.
//!
//! Slice 1 implements append-only merge: every imported profile gets a fresh
//! schema-valid ID and is added alongside existing profiles. Name collisions
//! get a `(импорт)` suffix, matching the existing `importProfile` convention
//! on the frontend.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::config::{
    Action, ActionPayload, ActionType, AppConfig, AppMapping, Binding, ControlId, EncoderMapping,
    Layer, MouseActionKind, MouseActionPayload, PasteMode, PhysicalControl, Profile,
    SequenceActionPayload, SequenceStep, ShortcutActionPayload, SnippetLibraryItem,
    TextSnippetPayload,
};

use super::types::{
    ImportOptions, ImportSummary, ImportWarning, ImportedConfig, MergeStrategy, ParsedAction,
    ParsedBinding, ParsedMacro, ParsedProfile, ParsedSequenceStep, ParsedSynapseProfiles,
};

// ============================================================================
// Public entry point
// ============================================================================

pub fn apply_parsed_into_config(
    base: AppConfig,
    parsed: ParsedSynapseProfiles,
    options: &ImportOptions,
) -> ImportedConfig {
    let mut config = base;
    let mut warnings = parsed.warnings.clone();
    let mut summary = ImportSummary::default();

    let selected: Option<std::collections::HashSet<&str>> =
        options.selected_profile_guids.as_ref().map(|v| {
            v.iter().map(String::as_str).collect()
        });

    for profile in &parsed.profiles {
        if let Some(filter) = &selected {
            if !filter.contains(profile.synapse_guid.as_str()) {
                summary.skipped += 1;
                continue;
            }
        }
        if options.merge_strategy == MergeStrategy::ReplaceByName {
            remove_profile_by_name(&mut config, &profile.name);
        }
        match append_profile(&mut config, profile, &mut warnings) {
            Ok(ProfileAddition { bindings, actions }) => {
                summary.profiles_added += 1;
                summary.bindings_added += bindings;
                summary.actions_added += actions;
                summary.macros_added += profile.macros.len();
            }
            Err(err) => {
                warnings.push(
                    ImportWarning::new(
                        "profile_append_failed",
                        format!("Profile `{}` could not be appended: {err}", profile.name),
                    )
                    .with_context(profile.name.clone()),
                );
            }
        }
    }

    ImportedConfig {
        config,
        warnings,
        summary,
    }
}

struct ProfileAddition {
    bindings: usize,
    actions: usize,
}

fn append_profile(
    config: &mut AppConfig,
    parsed: &ParsedProfile,
    warnings: &mut Vec<ImportWarning>,
) -> Result<ProfileAddition, String> {
    // Build a fresh Profile with a schema-valid ID and a unique human name.
    let new_profile_id = make_random_id("profile");
    let new_name = unique_profile_name(&parsed.name, &config.profiles);

    let next_priority = config
        .profiles
        .iter()
        .map(|p| p.priority)
        .max()
        .unwrap_or(0)
        + 10;

    let profile = Profile {
        id: new_profile_id.clone(),
        name: new_name,
        description: None,
        enabled: true,
        priority: next_priority,
    };

    // Pre-create sequence actions from referenced macros so bindings can link.
    // Map: synapse_guid → new Action id
    let mut macro_action_ids: HashMap<String, String> = HashMap::new();
    let mut new_actions: Vec<Action> = Vec::new();

    for m in &parsed.macros {
        let action_id = make_random_id("action");
        let action = build_sequence_action(&action_id, m, warnings);
        macro_action_ids.insert(m.synapse_guid.clone(), action_id);
        new_actions.push(action);
    }

    // Bindings + per-binding actions.
    let mut new_bindings: Vec<Binding> = Vec::new();

    for pb in &parsed.bindings {
        let control_id = match parse_control_id(&pb.control_id) {
            Some(c) => c,
            None => {
                warnings.push(ImportWarning::new(
                    "control_id_not_in_enum",
                    format!("Control `{}` is not a known Sidearm control.", pb.control_id),
                ));
                continue;
            }
        };
        let layer = match pb.layer.as_str() {
            "standard" => Layer::Standard,
            "hypershift" => Layer::Hypershift,
            other => {
                warnings.push(ImportWarning::new(
                    "layer_unknown",
                    format!("Layer `{other}` is not recognised."),
                ));
                continue;
            }
        };

        match build_action_from_parsed(&pb.action, &macro_action_ids, warnings) {
            BuiltAction::New(action) => {
                let binding = Binding {
                    id: make_random_id("binding"),
                    profile_id: new_profile_id.clone(),
                    layer,
                    control_id,
                    label: pb.label.clone(),
                    action_ref: action.id.clone(),
                    color_tag: None,
                    trigger_mode: None,
                    chord_partner: None,
                    enabled: true,
                };
                new_actions.push(action);
                new_bindings.push(binding);
            }
            BuiltAction::ExistingRef(action_id) => {
                let binding = Binding {
                    id: make_random_id("binding"),
                    profile_id: new_profile_id.clone(),
                    layer,
                    control_id,
                    label: pb.label.clone(),
                    action_ref: action_id,
                    color_tag: None,
                    trigger_mode: None,
                    chord_partner: None,
                    enabled: true,
                };
                new_bindings.push(binding);
            }
            BuiltAction::Skipped => {
                // Unmappable — already logged when parsed.
            }
        }
    }

    let added_bindings = new_bindings.len();
    let added_actions = new_actions.len();

    config.profiles.push(profile);
    config.actions.extend(new_actions);
    config.bindings.extend(new_bindings);

    Ok(ProfileAddition {
        bindings: added_bindings,
        actions: added_actions,
    })
}

enum BuiltAction {
    New(Action),
    ExistingRef(String),
    Skipped,
}

fn build_action_from_parsed(
    parsed: &ParsedAction,
    macro_action_ids: &HashMap<String, String>,
    warnings: &mut Vec<ImportWarning>,
) -> BuiltAction {
    match parsed {
        ParsedAction::Shortcut { key, ctrl, shift, alt, win } => {
            let id = make_random_id("action");
            let pretty = shortcut_pretty(key, *ctrl, *shift, *alt, *win);
            BuiltAction::New(Action {
                id,
                action_type: ActionType::Shortcut,
                payload: ActionPayload::Shortcut(ShortcutActionPayload {
                    key: key.clone(),
                    ctrl: *ctrl,
                    shift: *shift,
                    alt: *alt,
                    win: *win,
                    raw: None,
                }),
                pretty,
                notes: None,
                conditions: Vec::new(),
            })
        }
        ParsedAction::TextSnippet { text } => {
            if text.trim().is_empty() {
                return BuiltAction::Skipped;
            }
            let id = make_random_id("action");
            let snippet: String = text.chars().take(32).collect();
            BuiltAction::New(Action {
                id,
                action_type: ActionType::TextSnippet,
                payload: ActionPayload::TextSnippet(TextSnippetPayload::Inline {
                    text: text.clone(),
                    paste_mode: PasteMode::SendText,
                    tags: Vec::new(),
                }),
                pretty: format!("«{snippet}»"),
                notes: None,
                conditions: Vec::new(),
            })
        }
        ParsedAction::Sequence { macro_guid } => {
            if let Some(existing_id) = macro_action_ids.get(macro_guid) {
                BuiltAction::ExistingRef(existing_id.clone())
            } else {
                warnings.push(ImportWarning::new(
                    "sequence_ref_missing",
                    format!("Macro guid `{macro_guid}` referenced by a binding was not decoded."),
                ));
                BuiltAction::Skipped
            }
        }
        ParsedAction::MouseAction { action } => match parse_mouse_action_kind(action) {
            Some(kind) => {
                let id = make_random_id("action");
                BuiltAction::New(Action {
                    id,
                    action_type: ActionType::MouseAction,
                    payload: ActionPayload::MouseAction(MouseActionPayload {
                        action: kind,
                        ctrl: false,
                        shift: false,
                        alt: false,
                        win: false,
                    }),
                    pretty: action.clone(),
                    notes: None,
                    conditions: Vec::new(),
                })
            }
            None => {
                warnings.push(ImportWarning::new(
                    "mouse_action_unknown",
                    format!("Mouse action `{action}` not recognised."),
                ));
                BuiltAction::Skipped
            }
        },
        ParsedAction::Disabled => {
            let id = make_random_id("action");
            BuiltAction::New(Action {
                id,
                action_type: ActionType::Disabled,
                payload: ActionPayload::Disabled(Default::default()),
                pretty: "—".into(),
                notes: None,
                conditions: Vec::new(),
            })
        }
        ParsedAction::Unmappable { reason } => {
            warnings.push(ImportWarning::new(
                "unmappable_binding_skipped",
                reason.clone(),
            ));
            BuiltAction::Skipped
        }
    }
}

fn build_sequence_action(
    action_id: &str,
    parsed: &ParsedMacro,
    _warnings: &mut Vec<ImportWarning>,
) -> Action {
    let steps: Vec<SequenceStep> = parsed
        .steps
        .iter()
        .map(|s| match s {
            ParsedSequenceStep::Send { value } => SequenceStep::Send {
                value: value.clone(),
                delay_ms: None,
            },
            ParsedSequenceStep::Sleep { delay_ms } => SequenceStep::Sleep {
                delay_ms: *delay_ms,
            },
        })
        .collect();

    // Ensure at least one step (schema requires minItems: 1).
    let steps = if steps.is_empty() {
        vec![SequenceStep::Sleep { delay_ms: 0 }]
    } else {
        steps
    };

    Action {
        id: action_id.to_string(),
        action_type: ActionType::Sequence,
        payload: ActionPayload::Sequence(SequenceActionPayload { steps }),
        pretty: format!("🎬 {}", parsed.name),
        notes: Some(format!("Imported from Razer Synapse macro `{}`", parsed.name)),
        conditions: Vec::new(),
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// Remove any profile whose name matches `name`, along with all of its
/// bindings, actions referenced only by those bindings, and appMappings.
/// Used by `MergeStrategy::ReplaceByName`.
fn remove_profile_by_name(config: &mut AppConfig, name: &str) {
    let target_ids: Vec<String> = config
        .profiles
        .iter()
        .filter(|p| p.name == name)
        .map(|p| p.id.clone())
        .collect();
    if target_ids.is_empty() {
        return;
    }
    let target_set: std::collections::HashSet<&str> =
        target_ids.iter().map(String::as_str).collect();

    let dropped_action_ids: std::collections::HashSet<String> = config
        .bindings
        .iter()
        .filter(|b| target_set.contains(b.profile_id.as_str()))
        .map(|b| b.action_ref.clone())
        .collect();

    config
        .profiles
        .retain(|p| !target_set.contains(p.id.as_str()));
    config
        .bindings
        .retain(|b| !target_set.contains(b.profile_id.as_str()));
    config
        .app_mappings
        .retain(|m| !target_set.contains(m.profile_id.as_str()));

    // An action can be referenced by multiple bindings (e.g. macros shared
    // within a profile). Only drop actions whose *remaining* bindings are
    // all gone — play it safe and keep actions if any other binding still
    // refers to them.
    let still_referenced: std::collections::HashSet<String> = config
        .bindings
        .iter()
        .map(|b| b.action_ref.clone())
        .collect();
    config.actions.retain(|a| {
        !(dropped_action_ids.contains(&a.id) && !still_referenced.contains(&a.id))
    });
}

fn unique_profile_name(base: &str, existing: &[Profile]) -> String {
    let base = if base.trim().is_empty() { "Imported" } else { base };
    let mut candidate = base.to_string();
    let mut n = 2;
    while existing.iter().any(|p| p.name == candidate) {
        if n == 2 {
            candidate = format!("{base} (импорт)");
        } else {
            candidate = format!("{base} (импорт {n})");
        }
        n += 1;
        if n > 1000 {
            break;
        }
    }
    candidate
}

fn parse_control_id(s: &str) -> Option<ControlId> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
}

fn parse_mouse_action_kind(s: &str) -> Option<MouseActionKind> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
}

fn shortcut_pretty(key: &str, ctrl: bool, shift: bool, alt: bool, win: bool) -> String {
    let mut parts = Vec::new();
    if ctrl { parts.push("Ctrl"); }
    if shift { parts.push("Shift"); }
    if alt { parts.push("Alt"); }
    if win { parts.push("Win"); }
    let mut s = parts.join("+");
    if !key.is_empty() {
        if !s.is_empty() { s.push('+'); }
        s.push_str(key);
    }
    if s.is_empty() { "—".to_string() } else { s }
}

/// Generate a schema-valid ID matching `^[a-z][a-z0-9-]*$`.
/// Uses a nanosecond timestamp + monotonic counter so parallel imports inside
/// the same process still produce unique IDs.
fn make_random_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{ts:016x}{n:04x}")
}

// Silence unused-warning on types that become relevant in later slices.
#[allow(dead_code)]
fn _reserved_types(
    _: &[EncoderMapping],
    _: &[AppMapping],
    _: &[PhysicalControl],
    _: &[SnippetLibraryItem],
) {
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synapse_import::types::{ParsedAction, ParsedBinding, ParsedProfile};

    fn empty_config() -> AppConfig {
        serde_json::from_str(
            r#"{
                "version": 2,
                "settings": {
                    "fallbackProfileId": "default",
                    "theme": "synapse-light",
                    "startWithWindows": true,
                    "minimizeToTray": true,
                    "debugLogging": true
                },
                "profiles": [{"id": "default", "name": "Default", "enabled": true, "priority": 10}],
                "physicalControls": [],
                "encoderMappings": [],
                "appMappings": [],
                "bindings": [],
                "actions": [],
                "snippetLibrary": []
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn apply_appends_profile_with_unique_id() {
        let base = empty_config();
        let parsed = ParsedSynapseProfiles {
            source_kind: super::super::types::SourceKind::SynapseV4,
            source_path: "test".into(),
            profiles: vec![ParsedProfile {
                synapse_guid: "g-1".into(),
                name: "Default".into(),
                bindings: vec![ParsedBinding {
                    control_id: "thumb_01".into(),
                    layer: "standard".into(),
                    source_input_id: "KEY_1".into(),
                    label: "Ctrl+A".into(),
                    action: ParsedAction::Shortcut {
                        key: "A".into(),
                        ctrl: true,
                        shift: false,
                        alt: false,
                        win: false,
                    },
                }],
                macros: vec![],
            }],
            warnings: vec![],
        };
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        assert_eq!(result.config.profiles.len(), 2);
        // Name collision resolution: Default → "Default (импорт)"
        let imported = result.config.profiles.last().unwrap();
        assert_eq!(imported.name, "Default (импорт)");
        assert!(imported.id.starts_with("profile-"));
        // IDs are schema-valid
        assert!(
            regex::Regex::new("^[a-z][a-z0-9-]*$")
                .unwrap()
                .is_match(&imported.id)
        );
        assert_eq!(result.config.bindings.len(), 1);
        assert_eq!(result.config.actions.len(), 1);
        assert_eq!(result.summary.profiles_added, 1);
        assert_eq!(result.summary.bindings_added, 1);
        assert_eq!(result.summary.actions_added, 1);
    }

    #[test]
    fn unmappable_action_is_skipped_with_warning() {
        let base = empty_config();
        let parsed = ParsedSynapseProfiles {
            source_kind: super::super::types::SourceKind::SynapseV4,
            source_path: "t".into(),
            profiles: vec![ParsedProfile {
                synapse_guid: "g".into(),
                name: "X".into(),
                bindings: vec![ParsedBinding {
                    control_id: "thumb_01".into(),
                    layer: "standard".into(),
                    source_input_id: "KEY_1".into(),
                    label: "?".into(),
                    action: ParsedAction::Unmappable {
                        reason: "test".into(),
                    },
                }],
                macros: vec![],
            }],
            warnings: vec![],
        };
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        assert_eq!(result.config.bindings.len(), 0);
        assert!(result
            .warnings
            .iter()
            .any(|w| w.code == "unmappable_binding_skipped"));
    }

    #[test]
    fn macro_reference_resolves_to_sequence_action() {
        let base = empty_config();
        let parsed = ParsedSynapseProfiles {
            source_kind: super::super::types::SourceKind::SynapseV4,
            source_path: "t".into(),
            profiles: vec![ParsedProfile {
                synapse_guid: "g".into(),
                name: "X".into(),
                bindings: vec![ParsedBinding {
                    control_id: "thumb_03".into(),
                    layer: "standard".into(),
                    source_input_id: "KEY_3".into(),
                    label: "Macro".into(),
                    action: ParsedAction::Sequence {
                        macro_guid: "macro-1".into(),
                    },
                }],
                macros: vec![ParsedMacro {
                    synapse_guid: "macro-1".into(),
                    name: "Test".into(),
                    steps: vec![ParsedSequenceStep::Send {
                        value: "Ctrl+A".into(),
                    }],
                }],
            }],
            warnings: vec![],
        };
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        assert_eq!(result.config.bindings.len(), 1);
        assert_eq!(result.config.actions.len(), 1); // just the macro action, shared
        let binding = &result.config.bindings[0];
        let action = result
            .config
            .actions
            .iter()
            .find(|a| a.id == binding.action_ref)
            .expect("action referenced by binding");
        assert_eq!(action.action_type, ActionType::Sequence);
    }

    #[test]
    fn replace_by_name_removes_existing_profile_and_its_bindings() {
        let mut base = empty_config();
        // Pre-seed base with a profile "Gaming" + 1 binding + 1 action.
        base.profiles.push(serde_json::from_str(
            r#"{"id": "old-gaming", "name": "Gaming", "enabled": true, "priority": 5}"#,
        ).unwrap());
        base.actions.push(serde_json::from_str(
            r#"{"id": "a-old", "type": "shortcut", "pretty": "Old",
                "payload": {"key": "Q", "ctrl": false, "shift": false, "alt": false, "win": false}}"#
        ).unwrap());
        base.bindings.push(serde_json::from_str(
            r#"{"id": "b-old", "profileId": "old-gaming", "layer": "standard",
                "controlId": "thumb_01", "label": "Old", "actionRef": "a-old", "enabled": true}"#
        ).unwrap());

        let parsed = ParsedSynapseProfiles {
            source_kind: super::super::types::SourceKind::SynapseV4,
            source_path: "t".into(),
            profiles: vec![ParsedProfile {
                synapse_guid: "g".into(),
                name: "Gaming".into(),
                bindings: vec![ParsedBinding {
                    control_id: "thumb_01".into(),
                    layer: "standard".into(),
                    source_input_id: "KEY_1".into(),
                    label: "New".into(),
                    action: ParsedAction::Shortcut {
                        key: "A".into(),
                        ctrl: true,
                        shift: false,
                        alt: false,
                        win: false,
                    },
                }],
                macros: vec![],
            }],
            warnings: vec![],
        };
        let result = apply_parsed_into_config(
            base,
            parsed,
            &ImportOptions {
                selected_profile_guids: None,
                merge_strategy: MergeStrategy::ReplaceByName,
            },
        );
        // Profile "Gaming" exists exactly once (the new one), with the new name.
        let gaming: Vec<_> = result
            .config
            .profiles
            .iter()
            .filter(|p| p.name == "Gaming")
            .collect();
        assert_eq!(gaming.len(), 1);
        // Old profile, action, binding are gone
        assert!(!result.config.profiles.iter().any(|p| p.id == "old-gaming"));
        assert!(!result.config.bindings.iter().any(|b| b.id == "b-old"));
        assert!(!result.config.actions.iter().any(|a| a.id == "a-old"));
        // New binding + action present
        assert_eq!(result.config.bindings.len(), 1);
        assert_eq!(result.config.actions.len(), 1);
    }

    #[test]
    fn merged_config_passes_schema_validation() {
        let base = empty_config();
        let parsed = ParsedSynapseProfiles {
            source_kind: super::super::types::SourceKind::SynapseV4,
            source_path: "t".into(),
            profiles: vec![ParsedProfile {
                synapse_guid: "g".into(),
                name: "Gaming".into(),
                bindings: vec![
                    ParsedBinding {
                        control_id: "thumb_01".into(),
                        layer: "standard".into(),
                        source_input_id: "KEY_1".into(),
                        label: "Ctrl+A".into(),
                        action: ParsedAction::Shortcut {
                            key: "A".into(),
                            ctrl: true,
                            shift: false,
                            alt: false,
                            win: false,
                        },
                    },
                    ParsedBinding {
                        control_id: "thumb_02".into(),
                        layer: "hypershift".into(),
                        source_input_id: "KEY_2".into(),
                        label: "Hello".into(),
                        action: ParsedAction::TextSnippet {
                            text: "Hello".into(),
                        },
                    },
                ],
                macros: vec![],
            }],
            warnings: vec![],
        };
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        let value = serde_json::to_value(&result.config).expect("serialize");
        let errors = crate::config::collect_schema_errors(&value);
        assert!(errors.is_empty(), "schema errors: {errors:?}");
    }
}
