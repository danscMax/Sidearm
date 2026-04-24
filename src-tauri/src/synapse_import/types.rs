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

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    /// If Some, only these profile GUIDs are imported. None = all.
    pub selected_profile_guids: Option<Vec<String>>,
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
