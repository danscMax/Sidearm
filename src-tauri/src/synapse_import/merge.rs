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
    ParsedMacro, ParsedProfile, ParsedSequenceStep, ParsedSynapseProfiles,
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
        if let Some(filter) = &selected
            && !filter.contains(profile.synapse_guid.as_str()) {
                summary.skipped += 1;
                continue;
            }
        if options.merge_strategy == MergeStrategy::ReplaceByName {
            remove_profile_by_name(&mut config, &profile.name, &mut warnings);
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
    // Guard against two Synapse inputs resolving to the same Sidearm
    // (control, layer) — e.g. a Naga side button present in the profile as both
    // `DKM_M_0X` and `KEY_X`. `validate_config` rejects duplicate binding
    // tuples, so keep the first occurrence and warn instead of producing an
    // invalid config that fails on save.
    let mut bound_controls: std::collections::HashSet<(Layer, ControlId)> =
        std::collections::HashSet::new();

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

        if !bound_controls.insert((layer, control_id)) {
            warnings.push(ImportWarning::new(
                "duplicate_control_binding",
                format!(
                    "Control `{}` is mapped more than once on the `{}` layer; keeping the first.",
                    pb.control_id, pb.layer
                ),
            ));
            continue;
        }

        match build_action_from_parsed(&pb.action, &macro_action_ids, warnings) {
            BuiltAction::New(action) => {
                let binding = Binding {
                    id: make_random_id("binding"),
                    profile_id: new_profile_id.clone(),
                    layer,
                    control_id,
                    label: pb.label.clone(),
                    action_id: action.id.clone(),
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
                    action_id,
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
            let display_name = shortcut_pretty(key, *ctrl, *shift, *alt, *win);
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
                display_name,
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
                display_name: format!("«{snippet}»"),
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
                    display_name: action.clone(),
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
                display_name: "—".into(),
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
                repeat: None,
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
        display_name: format!("🎬 {}", parsed.name),
        notes: Some(format!("Imported from Razer Synapse macro `{}`", parsed.name)),
        conditions: Vec::new(),
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// Remove the single profile that `MergeStrategy::ReplaceByName` should
/// overwrite, along with its bindings, appMappings, and any actions referenced
/// *only* by those bindings.
///
/// Profile names are NOT unique in `AppConfig` — the user can rename freely, and
/// the imported `name` comes from an untrusted file. Removing *every* same-named
/// profile would let importing one profile named e.g. "Default" wipe several
/// unrelated user profiles (and their bindings/macros). So we replace at most
/// ONE (the first match) and warn when the name was ambiguous.
fn remove_profile_by_name(config: &mut AppConfig, name: &str, warnings: &mut Vec<ImportWarning>) {
    let matching_ids: Vec<String> = config
        .profiles
        .iter()
        .filter(|p| p.name == name)
        .map(|p| p.id.clone())
        .collect();
    let Some(target_id) = matching_ids.first().cloned() else {
        return;
    };
    if matching_ids.len() > 1 {
        warnings.push(
            ImportWarning::new(
                "replace_by_name_ambiguous",
                format!(
                    "{} existing profiles are named `{name}`; replaced only the first and left the others untouched.",
                    matching_ids.len()
                ),
            )
            .with_context(name.to_string()),
        );
    }

    let dropped_action_ids: std::collections::HashSet<String> = config
        .bindings
        .iter()
        .filter(|b| b.profile_id == target_id)
        .map(|b| b.action_id.clone())
        .collect();

    config.profiles.retain(|p| p.id != target_id);
    config.bindings.retain(|b| b.profile_id != target_id);
    config.app_mappings.retain(|m| m.profile_id != target_id);

    // An action can be referenced by multiple bindings (e.g. macros shared
    // within a profile). Only drop actions whose *remaining* bindings are
    // all gone — play it safe and keep actions if any other binding still
    // refers to them.
    let still_referenced: std::collections::HashSet<String> = config
        .bindings
        .iter()
        .map(|b| b.action_id.clone())
        .collect();
    config.actions.retain(|a| {
        !dropped_action_ids.contains(&a.id) || still_referenced.contains(&a.id)
    });
}

fn unique_profile_name(base: &str, existing: &[Profile]) -> String {
    let base = if base.trim().is_empty() { "Imported" } else { base };
    let mut candidate = base.to_string();
    let mut n = 2usize;
    // Each iteration produces a DISTINCT candidate ("base", "base (импорт)",
    // "base (импорт 3)", …). With N existing profiles the pigeonhole principle
    // guarantees a free name within N+1 attempts, so bound the loop by
    // existing.len()+2 — always large enough to reach a unique name, unlike the
    // old fixed cap of 1000 which could return a still-colliding name once more
    // than ~1000 profiles shared the base name.
    let max_attempts = existing.len() + 2;
    while existing.iter().any(|p| p.name == candidate) {
        candidate = if n == 2 {
            format!("{base} (импорт)")
        } else {
            format!("{base} (импорт {n})")
        };
        n += 1;
        if n > max_attempts {
            break; // safety net — unreachable in practice
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
    super::types::format_chord(ctrl, shift, alt, win, key, || "—".to_string())
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
            .find(|a| a.id == binding.action_id)
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
    fn replace_by_name_with_duplicate_names_removes_only_one_and_warns() {
        let mut base = empty_config();
        // Two distinct user profiles share the name "Gaming" (names are not
        // unique). Importing a "Gaming" profile must NOT wipe both.
        base.profiles.push(serde_json::from_str(
            r#"{"id": "gaming-a", "name": "Gaming", "enabled": true, "priority": 5}"#,
        ).unwrap());
        base.profiles.push(serde_json::from_str(
            r#"{"id": "gaming-b", "name": "Gaming", "enabled": true, "priority": 6}"#,
        ).unwrap());

        let parsed = ParsedSynapseProfiles {
            source_kind: super::super::types::SourceKind::SynapseV4,
            source_path: "t".into(),
            profiles: vec![ParsedProfile {
                synapse_guid: "g".into(),
                name: "Gaming".into(),
                bindings: vec![],
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
        // Exactly ONE same-named profile was removed (the first match); the
        // unrelated duplicate survived.
        assert!(!result.config.profiles.iter().any(|p| p.id == "gaming-a"));
        assert!(result.config.profiles.iter().any(|p| p.id == "gaming-b"));
        // The ambiguity was surfaced as a warning.
        assert!(result
            .warnings
            .iter()
            .any(|w| w.code == "replace_by_name_ambiguous"));
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

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use crate::synapse_import::types::{
        ParsedAction, ParsedBinding, ParsedMacro, ParsedProfile,
        ParsedSequenceStep, ParsedSynapseProfiles, SourceKind,
    };
    use proptest::prelude::*;

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
                "profiles": [{"id":"default","name":"Default","enabled":true,"priority":10}],
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

    fn minimal_parsed(profiles: Vec<ParsedProfile>) -> ParsedSynapseProfiles {
        ParsedSynapseProfiles {
            source_kind: SourceKind::SynapseV4,
            source_path: "test".into(),
            profiles,
            warnings: vec![],
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: empty profiles list → config unchanged, summary all zeros
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_empty_parsed_profiles_no_change() {
        let base = empty_config();
        let n_before = base.profiles.len();
        let result = apply_parsed_into_config(base, minimal_parsed(vec![]), &ImportOptions::default());
        assert_eq!(result.config.profiles.len(), n_before);
        assert_eq!(result.summary.profiles_added, 0);
        assert_eq!(result.summary.bindings_added, 0);
    }

    // -----------------------------------------------------------------------
    // Boundary: profile with 0 bindings → profile added, 0 bindings added
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_profile_with_zero_bindings() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "Empty".into(),
            bindings: vec![],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        assert_eq!(result.summary.profiles_added, 1);
        assert_eq!(result.summary.bindings_added, 0);
        assert_eq!(result.config.bindings.len(), 0);
    }

    // -----------------------------------------------------------------------
    // Boundary: profile name is empty string → falls back to "Imported"
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_empty_profile_name_becomes_imported() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "".into(),
            bindings: vec![],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        let added = result.config.profiles.last().unwrap();
        assert_eq!(added.name, "Imported");
    }

    // -----------------------------------------------------------------------
    // Boundary: whitespace-only profile name → falls back to "Imported"
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_whitespace_profile_name_becomes_imported() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "   \t  ".into(),
            bindings: vec![],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        let added = result.config.profiles.last().unwrap();
        assert_eq!(added.name, "Imported");
    }

    // -----------------------------------------------------------------------
    // Boundary: priority arithmetic — existing profile priority + 10
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_priority_is_max_plus_ten() {
        let base = empty_config(); // Default profile has priority 10
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "New".into(),
            bindings: vec![],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        let added = result.config.profiles.last().unwrap();
        assert_eq!(added.priority, 20); // 10 + 10
    }

    // -----------------------------------------------------------------------
    // Null & empty: binding with unknown control_id → skipped with warning
    // -----------------------------------------------------------------------

    #[test]
    fn null_unknown_control_id_is_skipped_with_warning() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "X".into(),
            bindings: vec![ParsedBinding {
                control_id: "not_a_real_control_XYZZY".into(),
                layer: "standard".into(),
                source_input_id: "KEY_1".into(),
                label: "X".into(),
                action: ParsedAction::Shortcut { key: "A".into(), ctrl: false, shift: false, alt: false, win: false },
            }],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        assert_eq!(result.config.bindings.len(), 0);
        assert!(result.warnings.iter().any(|w| w.code == "control_id_not_in_enum"));
    }

    // -----------------------------------------------------------------------
    // Null & empty: binding with unknown layer → skipped with warning
    // -----------------------------------------------------------------------

    #[test]
    fn null_unknown_layer_is_skipped_with_warning() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "X".into(),
            bindings: vec![ParsedBinding {
                control_id: "thumb_01".into(),
                layer: "not_a_layer".into(),
                source_input_id: "KEY_1".into(),
                label: "X".into(),
                action: ParsedAction::Shortcut { key: "A".into(), ctrl: false, shift: false, alt: false, win: false },
            }],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        assert_eq!(result.config.bindings.len(), 0);
        assert!(result.warnings.iter().any(|w| w.code == "layer_unknown"));
    }

    // -----------------------------------------------------------------------
    // Null & empty: TextSnippet with whitespace-only text → skipped
    // -----------------------------------------------------------------------

    #[test]
    fn null_whitespace_text_snippet_is_skipped() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "X".into(),
            bindings: vec![ParsedBinding {
                control_id: "thumb_01".into(),
                layer: "standard".into(),
                source_input_id: "KEY_1".into(),
                label: "X".into(),
                action: ParsedAction::TextSnippet { text: "   ".into() },
            }],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        // Whitespace-only text → BuiltAction::Skipped → no binding produced.
        assert_eq!(result.config.bindings.len(), 0);
    }

    // -----------------------------------------------------------------------
    // Null & empty: Sequence binding with no matching macro → warning + skipped
    // -----------------------------------------------------------------------

    #[test]
    fn null_sequence_binding_with_no_macro_emits_warning() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "X".into(),
            bindings: vec![ParsedBinding {
                control_id: "thumb_01".into(),
                layer: "standard".into(),
                source_input_id: "KEY_1".into(),
                label: "X".into(),
                action: ParsedAction::Sequence { macro_guid: "nonexistent-guid".into() },
            }],
            macros: vec![], // no macros provided
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        assert_eq!(result.config.bindings.len(), 0);
        assert!(result.warnings.iter().any(|w| w.code == "sequence_ref_missing"));
    }

    // -----------------------------------------------------------------------
    // Overflow: macro with 10 000 steps → no panic, all steps are converted
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_large_macro_no_panic() {
        let steps: Vec<ParsedSequenceStep> = (0..10_000)
            .map(|i| if i % 2 == 0 {
                ParsedSequenceStep::Send { value: "A".into() }
            } else {
                ParsedSequenceStep::Sleep { delay_ms: 50 }
            })
            .collect();
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "X".into(),
            bindings: vec![ParsedBinding {
                control_id: "thumb_01".into(),
                layer: "standard".into(),
                source_input_id: "KEY_1".into(),
                label: "X".into(),
                action: ParsedAction::Sequence { macro_guid: "m1".into() },
            }],
            macros: vec![ParsedMacro {
                synapse_guid: "m1".into(),
                name: "Big".into(),
                steps,
            }],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        // The macro action must be created; binding links to it.
        assert_eq!(result.config.bindings.len(), 1);
        assert_eq!(result.summary.macros_added, 1);
    }

    // -----------------------------------------------------------------------
    // Overflow: empty macro (no steps) → schema-mandated placeholder Sleep(0)
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_empty_macro_gets_placeholder_step() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "X".into(),
            bindings: vec![ParsedBinding {
                control_id: "thumb_01".into(),
                layer: "standard".into(),
                source_input_id: "KEY_1".into(),
                label: "X".into(),
                action: ParsedAction::Sequence { macro_guid: "empty-macro".into() },
            }],
            macros: vec![ParsedMacro {
                synapse_guid: "empty-macro".into(),
                name: "E".into(),
                steps: vec![],
            }],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        // Binding and action are created; the action must have >= 1 step (schema).
        let binding = &result.config.bindings[0];
        let action = result.config.actions.iter().find(|a| a.id == binding.action_id).unwrap();
        if let crate::config::ActionPayload::Sequence(seq) = &action.payload {
            assert!(!seq.steps.is_empty(), "empty macro must have a placeholder step");
        } else {
            panic!("expected Sequence payload");
        }
    }

    // -----------------------------------------------------------------------
    // Overflow: 1001 profiles with the same name — unique_profile_name loop
    //           must terminate within its cap and not allocate a unique name
    //           after the cap (the 1001st collision is returned as-is + suffix).
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_many_name_collisions_loop_terminates() {
        // Seed the config with 1001 profiles all named "X".
        let mut base = empty_config();
        for i in 0..1001usize {
            base.profiles.push(serde_json::from_value(serde_json::json!({
                "id": format!("p-{i}"),
                "name": "X",
                "enabled": true,
                "priority": i
            })).unwrap());
        }
        // Importing "X" should not panic or loop indefinitely.
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "X".into(),
            bindings: vec![],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        // One profile was added (even if the name is a duplicate at the cap boundary).
        assert_eq!(result.summary.profiles_added, 1);
    }

    // -----------------------------------------------------------------------
    // Overflow: selected_profile_guids is an empty vec → all profiles skipped
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_empty_selected_guids_skips_all() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g1".into(),
            name: "P1".into(),
            bindings: vec![],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions {
            selected_profile_guids: Some(vec![]),  // empty filter → nothing matches
            merge_strategy: MergeStrategy::Append,
        });
        assert_eq!(result.summary.profiles_added, 0);
        assert_eq!(result.summary.skipped, 1);
    }

    // -----------------------------------------------------------------------
    // Invariant: make_random_id generates IDs matching the schema regex
    // -----------------------------------------------------------------------

    #[test]
    fn invariant_make_random_id_matches_schema_regex() {
        let re = regex::Regex::new("^[a-z][a-z0-9-]*$").unwrap();
        for prefix in &["profile", "action", "binding"] {
            for _ in 0..20 {
                let id = make_random_id(prefix);
                assert!(re.is_match(&id), "id {id:?} does not match schema regex");
            }
        }
    }

    // -----------------------------------------------------------------------
    // Invariant: ReplaceByName with a name that does not exist → no change in
    //            profile count, new profile is just appended.
    // -----------------------------------------------------------------------

    #[test]
    fn invariant_replace_by_name_no_match_is_plain_append() {
        let base = empty_config();
        let before_count = base.profiles.len();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "NewProfile".into(),
            bindings: vec![],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions {
            selected_profile_guids: None,
            merge_strategy: MergeStrategy::ReplaceByName,
        });
        assert_eq!(result.config.profiles.len(), before_count + 1);
    }

    // -----------------------------------------------------------------------
    // Invariant: Disabled action creates a Disabled action entry
    // -----------------------------------------------------------------------

    #[test]
    fn invariant_disabled_action_is_created() {
        let base = empty_config();
        let parsed = minimal_parsed(vec![ParsedProfile {
            synapse_guid: "g".into(),
            name: "X".into(),
            bindings: vec![ParsedBinding {
                control_id: "thumb_01".into(),
                layer: "standard".into(),
                source_input_id: "KEY_1".into(),
                label: "—".into(),
                action: ParsedAction::Disabled,
            }],
            macros: vec![],
        }]);
        let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        assert_eq!(result.config.bindings.len(), 1);
        assert_eq!(result.config.actions.len(), 1);
        assert_eq!(result.config.actions[0].action_type, ActionType::Disabled);
    }

    // -----------------------------------------------------------------------
    // Property: apply_parsed never panics on arbitrary profile names
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn prop_apply_parsed_never_panics_arbitrary_name(name in ".*") {
            let base = empty_config();
            let parsed = minimal_parsed(vec![ParsedProfile {
                synapse_guid: "g".into(),
                name,
                bindings: vec![],
                macros: vec![],
            }]);
            let _ = apply_parsed_into_config(base, parsed, &ImportOptions::default());
        }

        // Invariant: profile count never decreases when Append strategy is used.
        #[test]
        fn prop_append_never_decreases_profile_count(n in 0usize..20) {
            let base = empty_config();
            let before = base.profiles.len();
            let profiles: Vec<ParsedProfile> = (0..n).map(|i| ParsedProfile {
                synapse_guid: format!("g-{i}"),
                name: format!("P{i}"),
                bindings: vec![],
                macros: vec![],
            }).collect();
            let parsed = minimal_parsed(profiles);
            let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
            assert!(result.config.profiles.len() >= before);
        }

        // Invariant: summary.profiles_added == profiles imported when all pass.
        #[test]
        fn prop_summary_profiles_added_matches_count(n in 0usize..10) {
            let base = empty_config();
            let profiles: Vec<ParsedProfile> = (0..n).map(|i| ParsedProfile {
                synapse_guid: format!("g-{i}"),
                name: format!("Unique{i}"),
                bindings: vec![],
                macros: vec![],
            }).collect();
            let parsed = minimal_parsed(profiles);
            let result = apply_parsed_into_config(base, parsed, &ImportOptions::default());
            assert_eq!(result.summary.profiles_added, n);
        }
    }

    // Concurrency: N/A — apply_parsed_into_config takes ownership of AppConfig;
    //              make_random_id uses AtomicU64 for the counter (thread-safe),
    //              but the function itself is not designed for concurrent calls
    //              on the same config — no concurrency contract to test here.
    // Temporal:    shortcut_pretty and label generation involve no durations.
}
