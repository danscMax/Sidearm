//! DTOs shared between the Rust parser/merger and the frontend preview UI.
//!
//! Wire format is camelCase. `controlId` and `layer` are kept as strings at
//! the DTO boundary; the merge step validates them against the AppConfig
//! schema before returning.

use crate::config::AppConfig;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    SynapseV4,
    // Future: SynapseV3Zip, MacroFolder, MacroXml
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSynapseProfiles {
    pub source_kind: SourceKind,
    pub source_path: String,
    pub profiles: Vec<ParsedProfile>,
    #[serde(default)]
    pub warnings: Vec<ImportWarning>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedProfile {
    pub synapse_guid: String,
    pub name: String,
    pub bindings: Vec<ParsedBinding>,
    pub macros: Vec<ParsedMacro>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedBinding {
    pub control_id: String,
    pub layer: String,
    pub source_input_id: String,
    pub label: String,
    pub action: ParsedAction,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ParsedAction {
    Shortcut {
        key: String,
        #[serde(default)]
        ctrl: bool,
        #[serde(default)]
        shift: bool,
        #[serde(default)]
        alt: bool,
        #[serde(default)]
        win: bool,
    },
    TextSnippet {
        text: String,
    },
    Sequence {
        macro_guid: String,
    },
    MouseAction {
        action: String,
    },
    Disabled,
    Unmappable {
        reason: String,
    },
}

/// Join active modifier flags (canonical Ctrl→Shift→Alt→Win order) with a key
/// into a `+`-separated chord string. `on_empty` supplies the fallback when both
/// the modifier set and the key are empty. Single source for the import-preview
/// label (`default_label_for`), the action display name (`merge::shortcut_pretty`),
/// and macro step values (`macro_steps::emit_send`) — a reorder here stays in sync
/// across all three.
pub(crate) fn format_chord(
    ctrl: bool,
    shift: bool,
    alt: bool,
    win: bool,
    key: &str,
    on_empty: impl FnOnce() -> String,
) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if ctrl {
        parts.push("Ctrl");
    }
    if shift {
        parts.push("Shift");
    }
    if alt {
        parts.push("Alt");
    }
    if win {
        parts.push("Win");
    }
    let mut s = parts.join("+");
    if !key.is_empty() {
        if !s.is_empty() {
            s.push('+');
        }
        s.push_str(key);
    }
    if s.is_empty() { on_empty() } else { s }
}

/// Build a human-readable label for a parsed action, used as the binding's
/// default name in the import preview. Shared by the v3 and v4 parsers (canon).
pub fn default_label_for(control_id: &str, action: &ParsedAction) -> String {
    match action {
        ParsedAction::Shortcut {
            key,
            ctrl,
            shift,
            alt,
            win,
        } => format_chord(*ctrl, *shift, *alt, *win, key, || control_id.to_string()),
        ParsedAction::TextSnippet { text } => {
            let snippet: String = text.chars().take(24).collect();
            format!("«{snippet}»")
        }
        ParsedAction::Sequence { .. } => "Macro".to_string(),
        ParsedAction::MouseAction { action } => action.clone(),
        ParsedAction::Disabled => "—".to_string(),
        ParsedAction::Unmappable { .. } => format!("? {control_id}"),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMacro {
    pub synapse_guid: String,
    pub name: String,
    pub steps: Vec<ParsedSequenceStep>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ParsedSequenceStep {
    Send { value: String },
    Sleep { delay_ms: u32 },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWarning {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeStrategy {
    /// Append imported profiles as new entries. Name collisions get a
    /// "(импорт)" suffix. (Default.)
    #[default]
    Append,
    /// Delete at most one existing profile whose name matches the imported one
    /// (along with its bindings/actions/appMappings), then append. If several
    /// profiles share the name, only the first is replaced and a
    /// `replace_by_name_ambiguous` warning is emitted.
    ReplaceByName,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    /// If Some, only these profile GUIDs are imported. None = all.
    pub selected_profile_guids: Option<Vec<String>>,
    pub merge_strategy: MergeStrategy,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConfig {
    pub config: AppConfig,
    pub warnings: Vec<ImportWarning>,
    pub summary: ImportSummary,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub profiles_added: usize,
    pub bindings_added: usize,
    pub actions_added: usize,
    pub macros_added: usize,
    pub skipped: usize,
}

impl ImportWarning {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            context: None,
        }
    }

    pub fn with_context(mut self, context: impl Into<String>) -> Self {
        self.context = Some(context.into());
        self
    }
}

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Boundary: default_label_for with empty key and no modifiers
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_shortcut_empty_key_no_mods_falls_back_to_control_id() {
        let action = ParsedAction::Shortcut {
            key: "".into(),
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
        };
        let label = default_label_for("thumb_01", &action);
        // All booleans false + empty key → label must be the control_id.
        assert_eq!(label, "thumb_01");
    }

    #[test]
    fn boundary_shortcut_empty_key_with_ctrl_mod() {
        let action = ParsedAction::Shortcut {
            key: "".into(),
            ctrl: true,
            shift: false,
            alt: false,
            win: false,
        };
        let label = default_label_for("thumb_01", &action);
        // "Ctrl" alone (no key) — label must not be empty.
        assert_eq!(label, "Ctrl");
    }

    // -----------------------------------------------------------------------
    // Boundary: TextSnippet truncation at 24 chars
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_text_snippet_label_truncated_at_24_chars() {
        let text = "A".repeat(100);
        let action = ParsedAction::TextSnippet { text: text.clone() };
        let label = default_label_for("x", &action);
        // Format is «<first 24 chars>».
        let expected = format!("«{}»", &text[..24]);
        assert_eq!(label, expected);
    }

    #[test]
    fn boundary_text_snippet_exactly_24_chars_not_truncated() {
        let text = "B".repeat(24);
        let action = ParsedAction::TextSnippet { text: text.clone() };
        let label = default_label_for("x", &action);
        assert_eq!(label, format!("«{text}»"));
    }

    #[test]
    fn boundary_text_snippet_23_chars_not_truncated() {
        let text = "C".repeat(23);
        let action = ParsedAction::TextSnippet { text: text.clone() };
        let label = default_label_for("x", &action);
        assert_eq!(label, format!("«{text}»"));
    }

    // -----------------------------------------------------------------------
    // Null & empty: TextSnippet with empty text → «»
    // -----------------------------------------------------------------------

    #[test]
    fn null_empty_text_snippet_label() {
        let action = ParsedAction::TextSnippet { text: "".into() };
        let label = default_label_for("x", &action);
        assert_eq!(label, "«»");
    }

    // -----------------------------------------------------------------------
    // Null & empty: Disabled → "—"
    // -----------------------------------------------------------------------

    #[test]
    fn null_disabled_action_label() {
        assert_eq!(default_label_for("x", &ParsedAction::Disabled), "—");
    }

    // -----------------------------------------------------------------------
    // Null & empty: Sequence → "Macro"
    // -----------------------------------------------------------------------

    #[test]
    fn null_sequence_action_label() {
        let action = ParsedAction::Sequence {
            macro_guid: "".into(),
        };
        assert_eq!(default_label_for("x", &action), "Macro");
    }

    // -----------------------------------------------------------------------
    // Null & empty: Unmappable → "? {control_id}"
    // -----------------------------------------------------------------------

    #[test]
    fn null_unmappable_label_contains_control_id() {
        let action = ParsedAction::Unmappable {
            reason: "test".into(),
        };
        let label = default_label_for("thumb_05", &action);
        assert_eq!(label, "? thumb_05");
    }

    // -----------------------------------------------------------------------
    // Overflow: TextSnippet with multi-byte UTF-8 chars — truncation is by
    //           char boundary (chars().take(24)), not by byte — verify no panic
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_multibyte_text_snippet_truncated_by_char_not_byte() {
        // "ф" is 2 bytes in UTF-8; 100 of them is 200 bytes but 100 chars.
        let text = "ф".repeat(100);
        let action = ParsedAction::TextSnippet { text };
        let label = default_label_for("x", &action);
        // Must not panic; must be truncated to 24 chars.
        // Strip the «» guillemets (each is multi-byte in UTF-8).
        let inner: String = label
            .chars()
            .skip(1)
            .take(label.chars().count() - 2)
            .collect();
        let char_count: usize = inner.chars().count();
        assert_eq!(char_count, 24);
    }

    // -----------------------------------------------------------------------
    // Property: default_label_for never panics on arbitrary inputs
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn prop_default_label_for_shortcut_never_panics(
            key in ".*",
            ctrl in any::<bool>(),
            shift in any::<bool>(),
            alt in any::<bool>(),
            win in any::<bool>(),
            control_id in ".*",
        ) {
            let action = ParsedAction::Shortcut { key, ctrl, shift, alt, win };
            let _ = default_label_for(&control_id, &action);
        }

        #[test]
        fn prop_default_label_for_text_snippet_never_panics(
            text in ".*",
            control_id in ".*",
        ) {
            let action = ParsedAction::TextSnippet { text };
            let _ = default_label_for(&control_id, &action);
        }

        // Invariant: label is never empty (always falls back to something).
        #[test]
        fn prop_label_never_empty(
            key in ".*",
            ctrl in any::<bool>(),
            shift in any::<bool>(),
            alt in any::<bool>(),
            win in any::<bool>(),
            control_id in "[a-z][a-z0-9_]{0,30}",
        ) {
            let action = ParsedAction::Shortcut { key, ctrl, shift, alt, win };
            let label = default_label_for(&control_id, &action);
            assert!(!label.is_empty(), "label must never be empty");
        }

        // Invariant: TextSnippet label always starts with «.
        #[test]
        fn prop_text_snippet_label_starts_with_guillemet(text in ".*") {
            let action = ParsedAction::TextSnippet { text };
            let label = default_label_for("x", &action);
            assert!(label.starts_with('«'));
        }
    }

    // Concurrency: N/A — default_label_for is a pure function.
    // Temporal:    N/A — no durations in this module.
}
