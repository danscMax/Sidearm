use jsonschema::Validator;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tempfile::NamedTempFile;
use thiserror::Error;

const CONFIG_FILE_NAME: &str = "config.json";
const BACKUP_FILE_NAME: &str = "config.last-known-good.json";
const SCHEMA_VERSION: i32 = 2;
const CONFIG_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../schemas/config.v2.schema.json"
));

#[derive(Debug, Error)]
pub enum ConfigStoreError {
    #[error("{0}")]
    ConfigDirectoryUnavailable(String),
    #[error("{message}")]
    Io {
        path: Option<String>,
        message: String,
    },
    #[error("{message}")]
    Parse { path: String, message: String },
    #[error("{0}")]
    SchemaEngine(String),
    #[error("Config schema validation failed.")]
    SchemaViolation { errors: Vec<String> },
    #[error("{0}")]
    Serialize(String),
    #[error("Config validation failed.")]
    InvalidConfig { errors: Vec<String> },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ValidationSeverity {
    Warning,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationWarning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub severity: ValidationSeverity,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadConfigResponse {
    pub config: AppConfig,
    pub warnings: Vec<ValidationWarning>,
    pub path: String,
    pub created_default: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveConfigResponse {
    pub config: AppConfig,
    pub warnings: Vec<ValidationWarning>,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub version: i32,
    pub settings: Settings,
    pub profiles: Vec<Profile>,
    pub physical_controls: Vec<PhysicalControl>,
    pub encoder_mappings: Vec<EncoderMapping>,
    pub app_mappings: Vec<AppMapping>,
    pub bindings: Vec<Binding>,
    pub actions: Vec<Action>,
    pub snippet_library: Vec<SnippetLibraryItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub fallback_profile_id: String,
    pub theme: String,
    pub start_with_windows: bool,
    pub minimize_to_tray: bool,
    pub debug_logging: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    pub priority: i32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ControlFamily {
    ThumbGrid,
    TopPanel,
    Wheel,
    System,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityStatus {
    Verified,
    NeedsValidation,
    Reserved,
    PartiallyRemappable,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum ControlId {
    #[serde(rename = "thumb_01")]
    Thumb01,
    #[serde(rename = "thumb_02")]
    Thumb02,
    #[serde(rename = "thumb_03")]
    Thumb03,
    #[serde(rename = "thumb_04")]
    Thumb04,
    #[serde(rename = "thumb_05")]
    Thumb05,
    #[serde(rename = "thumb_06")]
    Thumb06,
    #[serde(rename = "thumb_07")]
    Thumb07,
    #[serde(rename = "thumb_08")]
    Thumb08,
    #[serde(rename = "thumb_09")]
    Thumb09,
    #[serde(rename = "thumb_10")]
    Thumb10,
    #[serde(rename = "thumb_11")]
    Thumb11,
    #[serde(rename = "thumb_12")]
    Thumb12,
    #[serde(rename = "mouse_left")]
    MouseLeft,
    #[serde(rename = "mouse_right")]
    MouseRight,
    #[serde(rename = "top_aux_01")]
    TopAux01,
    #[serde(rename = "top_aux_02")]
    TopAux02,
    #[serde(rename = "mouse_4")]
    Mouse4,
    #[serde(rename = "mouse_5")]
    Mouse5,
    #[serde(rename = "wheel_up")]
    WheelUp,
    #[serde(rename = "wheel_down")]
    WheelDown,
    #[serde(rename = "wheel_click")]
    WheelClick,
    #[serde(rename = "wheel_left")]
    WheelLeft,
    #[serde(rename = "wheel_right")]
    WheelRight,
    #[serde(rename = "hypershift_button")]
    HypershiftButton,
    #[serde(rename = "top_special_01")]
    TopSpecial01,
    #[serde(rename = "top_special_02")]
    TopSpecial02,
    #[serde(rename = "top_special_03")]
    TopSpecial03,
}

impl ControlId {
    pub const ALL: [Self; 27] = [
        Self::Thumb01,
        Self::Thumb02,
        Self::Thumb03,
        Self::Thumb04,
        Self::Thumb05,
        Self::Thumb06,
        Self::Thumb07,
        Self::Thumb08,
        Self::Thumb09,
        Self::Thumb10,
        Self::Thumb11,
        Self::Thumb12,
        Self::MouseLeft,
        Self::MouseRight,
        Self::TopAux01,
        Self::TopAux02,
        Self::Mouse4,
        Self::Mouse5,
        Self::WheelUp,
        Self::WheelDown,
        Self::WheelClick,
        Self::WheelLeft,
        Self::WheelRight,
        Self::HypershiftButton,
        Self::TopSpecial01,
        Self::TopSpecial02,
        Self::TopSpecial03,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thumb01 => "thumb_01",
            Self::Thumb02 => "thumb_02",
            Self::Thumb03 => "thumb_03",
            Self::Thumb04 => "thumb_04",
            Self::Thumb05 => "thumb_05",
            Self::Thumb06 => "thumb_06",
            Self::Thumb07 => "thumb_07",
            Self::Thumb08 => "thumb_08",
            Self::Thumb09 => "thumb_09",
            Self::Thumb10 => "thumb_10",
            Self::Thumb11 => "thumb_11",
            Self::Thumb12 => "thumb_12",
            Self::MouseLeft => "mouse_left",
            Self::MouseRight => "mouse_right",
            Self::TopAux01 => "top_aux_01",
            Self::TopAux02 => "top_aux_02",
            Self::Mouse4 => "mouse_4",
            Self::Mouse5 => "mouse_5",
            Self::WheelUp => "wheel_up",
            Self::WheelDown => "wheel_down",
            Self::WheelClick => "wheel_click",
            Self::WheelLeft => "wheel_left",
            Self::WheelRight => "wheel_right",
            Self::HypershiftButton => "hypershift_button",
            Self::TopSpecial01 => "top_special_01",
            Self::TopSpecial02 => "top_special_02",
            Self::TopSpecial03 => "top_special_03",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhysicalControl {
    pub id: ControlId,
    pub family: ControlFamily,
    pub default_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synapse_name: Option<String>,
    pub remappable: bool,
    pub capability_status: CapabilityStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Standard,
    Hypershift,
}

impl Layer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Hypershift => "hypershift",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum MappingSource {
    Synapse,
    Reserved,
    Detected,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncoderMapping {
    pub control_id: ControlId,
    pub layer: Layer,
    pub encoded_key: String,
    pub source: MappingSource,
    pub verified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppMapping {
    pub id: String,
    pub exe: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub title_includes: Vec<String>,
    pub profile_id: String,
    pub enabled: bool,
    pub priority: i32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum TriggerMode {
    Press,
    DoublePress,
    TriplePress,
    Hold,
    Chord,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub id: String,
    pub profile_id: String,
    pub layer: Layer,
    pub control_id: ControlId,
    pub label: String,
    pub action_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_mode: Option<TriggerMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chord_partner: Option<ControlId>,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ActionType {
    Shortcut,
    TextSnippet,
    Sequence,
    Launch,
    Menu,
    MouseAction,
    MediaKey,
    ProfileSwitch,
    Disabled,
}

impl ActionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionType::Shortcut => "shortcut",
            ActionType::TextSnippet => "textSnippet",
            ActionType::Sequence => "sequence",
            ActionType::Launch => "launch",
            ActionType::Menu => "menu",
            ActionType::MouseAction => "mouseAction",
            ActionType::MediaKey => "mediaKey",
            ActionType::ProfileSwitch => "profileSwitch",
            ActionType::Disabled => "disabled",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ActionCondition {
    #[serde(rename_all = "camelCase")]
    WindowTitleContains { value: String },
    #[serde(rename_all = "camelCase")]
    WindowTitleNotContains { value: String },
    #[serde(rename_all = "camelCase")]
    ExeEquals { value: String },
    #[serde(rename_all = "camelCase")]
    ExeNotEquals { value: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub id: String,
    #[serde(rename = "type")]
    pub action_type: ActionType,
    pub payload: ActionPayload,
    pub pretty: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<ActionCondition>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ActionPayload {
    Shortcut(ShortcutActionPayload),
    TextSnippet(TextSnippetPayload),
    Sequence(SequenceActionPayload),
    Launch(LaunchActionPayload),
    Menu(MenuActionPayload),
    MouseAction(MouseActionPayload),
    MediaKey(MediaKeyPayload),
    ProfileSwitch(ProfileSwitchPayload),
    Disabled(DisabledActionPayload),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShortcutActionPayload {
    pub key: String,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum PasteMode {
    ClipboardPaste,
    #[default]
    SendText,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "camelCase")]
pub enum TextSnippetPayload {
    #[serde(rename_all = "camelCase")]
    Inline {
        text: String,
        paste_mode: PasteMode,
        tags: Vec<String>,
    },
    LibraryRef {
        #[serde(rename = "snippetId")]
        snippet_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SequenceActionPayload {
    pub steps: Vec<SequenceStep>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SequenceStep {
    #[serde(rename_all = "camelCase")]
    Send {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delay_ms: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delay_ms: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Sleep { delay_ms: u32 },
    #[serde(rename_all = "camelCase")]
    Launch {
        value: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        working_dir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delay_ms: Option<u32>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchActionPayload {
    pub target: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuActionPayload {
    pub items: Vec<MenuItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuItem {
    #[serde(rename_all = "camelCase")]
    Action {
        id: String,
        label: String,
        action_ref: String,
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Submenu {
        id: String,
        label: String,
        items: Vec<MenuItem>,
        enabled: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MouseActionPayload {
    pub action: String,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub win: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaKeyPayload {
    pub key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSwitchPayload {
    pub target_profile_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisabledActionPayload {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnippetLibraryItem {
    pub id: String,
    pub name: String,
    pub text: String,
    pub paste_mode: PasteMode,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

pub fn load_or_initialize_config(
    config_dir: &Path,
) -> Result<LoadConfigResponse, ConfigStoreError> {
    fs::create_dir_all(config_dir).map_err(|error| io_error(Some(config_dir), error))?;

    let config_path = config_dir.join(CONFIG_FILE_NAME);

    if config_path.exists() {
        let config = read_config_from_path(&config_path)?;
        let warnings = validate_config(&config)?;
        return Ok(LoadConfigResponse {
            config,
            warnings,
            path: path_string(&config_path),
            created_default: false,
        });
    }

    let config = default_seed_config();
    let warnings = validate_config(&config)?;
    write_config_to_path(config_dir, &config)?;

    Ok(LoadConfigResponse {
        config,
        warnings,
        path: path_string(&config_path),
        created_default: true,
    })
}

pub fn save_config(
    config_dir: &Path,
    config: AppConfig,
) -> Result<SaveConfigResponse, ConfigStoreError> {
    fs::create_dir_all(config_dir).map_err(|error| io_error(Some(config_dir), error))?;
    let schema_value = serde_json::to_value(&config)
        .map_err(|error| ConfigStoreError::Serialize(error.to_string()))?;
    validate_config_schema_value(&schema_value)?;
    let warnings = validate_config(&config)?;
    let backup_path = write_config_to_path(config_dir, &config)?;
    let config_path = config_dir.join(CONFIG_FILE_NAME);

    Ok(SaveConfigResponse {
        config,
        warnings,
        path: path_string(&config_path),
        backup_path: backup_path.map(|path| path_string(&path)),
    })
}

fn read_config_from_path(config_path: &Path) -> Result<AppConfig, ConfigStoreError> {
    let raw =
        fs::read_to_string(config_path).map_err(|error| io_error(Some(config_path), error))?;
    let raw_value: Value = serde_json::from_str(&raw).map_err(|error| ConfigStoreError::Parse {
        path: path_string(config_path),
        message: format!("Failed to parse config JSON: {error}"),
    })?;

    validate_config_schema_value(&raw_value)?;

    serde_json::from_value(raw_value).map_err(|error| ConfigStoreError::Parse {
        path: path_string(config_path),
        message: format!("Failed to deserialize schema-valid config JSON: {error}"),
    })
}

fn write_config_to_path(
    config_dir: &Path,
    config: &AppConfig,
) -> Result<Option<PathBuf>, ConfigStoreError> {
    let config_path = config_dir.join(CONFIG_FILE_NAME);
    let backup_path = config_dir.join(BACKUP_FILE_NAME);
    let had_existing_config = config_path.exists();

    if had_existing_config {
        fs::copy(&config_path, &backup_path)
            .map_err(|error| io_error(Some(&backup_path), error))?;
    }

    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| ConfigStoreError::Serialize(error.to_string()))?;

    let mut temp_file =
        NamedTempFile::new_in(config_dir).map_err(|error| io_error(Some(config_dir), error))?;
    temp_file
        .write_all(serialized.as_bytes())
        .map_err(|error| io_error(Some(temp_file.path()), error))?;
    temp_file
        .write_all(b"\n")
        .map_err(|error| io_error(Some(temp_file.path()), error))?;
    temp_file
        .flush()
        .map_err(|error| io_error(Some(temp_file.path()), error))?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|error| io_error(Some(temp_file.path()), error))?;

    temp_file
        .persist(&config_path)
        .map_err(|error| ConfigStoreError::Io {
            path: Some(path_string(&config_path)),
            message: format!("Failed to replace config atomically: {}", error.error),
        })?;

    Ok(had_existing_config.then_some(backup_path))
}

fn config_schema_validator() -> Result<&'static Validator, ConfigStoreError> {
    static VALIDATOR: OnceLock<Result<Validator, String>> = OnceLock::new();

    match VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(CONFIG_SCHEMA_JSON)
            .map_err(|error| format!("Failed to parse bundled config schema JSON: {error}"))?;
        jsonschema::validator_for(&schema)
            .map_err(|error| format!("Failed to compile bundled config schema: {error}"))
    }) {
        Ok(validator) => Ok(validator),
        Err(message) => Err(ConfigStoreError::SchemaEngine(message.clone())),
    }
}

fn validate_config_schema_value(value: &Value) -> Result<(), ConfigStoreError> {
    let validator = config_schema_validator()?;
    let errors: Vec<String> = validator
        .iter_errors(value)
        .map(|error| {
            let instance_path = error.instance_path().to_string();
            if instance_path.is_empty() {
                error.to_string()
            } else {
                format!("{instance_path}: {error}")
            }
        })
        .collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(ConfigStoreError::SchemaViolation { errors })
    }
}

fn validate_config(config: &AppConfig) -> Result<Vec<ValidationWarning>, ConfigStoreError> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if config.version != SCHEMA_VERSION {
        errors.push(format!(
            "Expected config version {SCHEMA_VERSION}, found {}.",
            config.version
        ));
    }

    let profile_ids = collect_unique_strings(
        config
            .profiles
            .iter()
            .map(|profile| (&profile.id, "profiles")),
        &mut errors,
    );
    if !profile_ids.contains(&config.settings.fallback_profile_id) {
        errors.push(format!(
            "settings.fallbackProfileId references missing profile `{}`.",
            config.settings.fallback_profile_id
        ));
    }
    if let Some(profile) = config
        .profiles
        .iter()
        .find(|profile| profile.id == config.settings.fallback_profile_id && !profile.enabled)
    {
        warnings.push(ValidationWarning {
            code: "disabled_fallback_profile".into(),
            message: format!("Fallback profile `{}` is disabled.", profile.id),
            path: Some("settings.fallbackProfileId".into()),
            severity: ValidationSeverity::Warning,
        });
    }

    let control_set = collect_unique_controls(
        config
            .physical_controls
            .iter()
            .map(|control| (control.id, "physicalControls")),
        &mut errors,
    );
    for expected_control in ControlId::ALL {
        if !control_set.contains(&expected_control) {
            errors.push(format!(
                "physicalControls is missing required control `{}`.",
                expected_control.as_str()
            ));
        }
    }

    let snippet_ids = collect_unique_strings(
        config
            .snippet_library
            .iter()
            .map(|snippet| (&snippet.id, "snippetLibrary")),
        &mut errors,
    );
    for snippet in &config.snippet_library {
        if snippet.text.trim().is_empty() {
            errors.push(format!(
                "snippetLibrary item `{}` must contain non-empty text.",
                snippet.id
            ));
        }
    }

    let action_ids = collect_unique_strings(
        config.actions.iter().map(|action| (&action.id, "actions")),
        &mut errors,
    );
    let actions_by_id: HashMap<&str, &Action> = config
        .actions
        .iter()
        .map(|action| (action.id.as_str(), action))
        .collect();

    for action in &config.actions {
        validate_action(
            action,
            &snippet_ids,
            &action_ids,
            &actions_by_id,
            &mut errors,
        );
    }

    let mut binding_keys = HashSet::new();
    collect_unique_strings(
        config
            .bindings
            .iter()
            .map(|binding| (&binding.id, "bindings")),
        &mut errors,
    );
    for binding in &config.bindings {
        if !profile_ids.contains(&binding.profile_id) {
            errors.push(format!(
                "binding `{}` references missing profile `{}`.",
                binding.id, binding.profile_id
            ));
        }
        if !action_ids.contains(&binding.action_ref) {
            errors.push(format!(
                "binding `{}` references missing action `{}`.",
                binding.id, binding.action_ref
            ));
        }
        let binding_key = format!(
            "{}::{}::{}",
            binding.profile_id,
            binding.control_id.as_str(),
            binding.layer.as_str()
        );
        if !binding_keys.insert(binding_key.clone()) {
            errors.push(format!(
                "Duplicate binding tuple detected for `{binding_key}`."
            ));
        }
    }

    let mut encoder_keys = HashSet::new();
    let mut encoded_inputs = HashSet::new();
    for mapping in &config.encoder_mappings {
        let key = format!(
            "{}::{}",
            mapping.control_id.as_str(),
            mapping.layer.as_str()
        );
        if !encoder_keys.insert(key.clone()) {
            errors.push(format!("Duplicate encoder mapping detected for `{key}`."));
        }

        let normalized_encoded_key = mapping.encoded_key.trim();
        if normalized_encoded_key.is_empty() {
            errors.push(format!(
                "encoderMapping `{}::{}` must define a non-empty encodedKey.",
                mapping.control_id.as_str(),
                mapping.layer.as_str()
            ));
            continue;
        }

        let canonical_encoded_key = match crate::hotkeys::normalize_hotkey(normalized_encoded_key) {
            Ok(canonical) => canonical,
            Err(message) => {
                errors.push(format!(
                    "encoderMapping `{}::{}` encodedKey `{}` is not a supported hotkey: {}",
                    mapping.control_id.as_str(),
                    mapping.layer.as_str(),
                    normalized_encoded_key,
                    message
                ));
                continue;
            }
        };

        if !encoded_inputs.insert(canonical_encoded_key.clone()) {
            errors.push(format!(
                "Duplicate encoderMappings encodedKey detected for canonical hotkey `{canonical_encoded_key}`."
            ));
        }
    }

    collect_unique_strings(
        config
            .app_mappings
            .iter()
            .map(|mapping| (&mapping.id, "appMappings")),
        &mut errors,
    );
    for mapping in &config.app_mappings {
        if !profile_ids.contains(&mapping.profile_id) {
            errors.push(format!(
                "appMapping `{}` references missing profile `{}`.",
                mapping.id, mapping.profile_id
            ));
        }
        if mapping.exe.trim().is_empty() {
            errors.push(format!("appMapping `{}` must define exe.", mapping.id));
        }
        if !mapping.title_includes.is_empty() {
            let mut seen = HashSet::new();
            for title in &mapping.title_includes {
                let normalized = title.trim();
                if normalized.is_empty() {
                    errors.push(format!(
                        "appMapping `{}` contains an empty titleIncludes entry.",
                        mapping.id
                    ));
                }
                if !seen.insert(normalized.to_owned()) {
                    warnings.push(ValidationWarning {
                        code: "duplicate_title_filter".into(),
                        message: format!(
                            "appMapping `{}` contains duplicated title filter `{normalized}`.",
                            mapping.id
                        ),
                        path: Some(format!("appMappings.{}.titleIncludes", mapping.id)),
                        severity: ValidationSeverity::Warning,
                    });
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(warnings)
    } else {
        Err(ConfigStoreError::InvalidConfig { errors })
    }
}

fn validate_action<'a>(
    action: &'a Action,
    snippet_ids: &HashSet<String>,
    action_ids: &HashSet<String>,
    actions_by_id: &HashMap<&'a str, &'a Action>,
    errors: &mut Vec<String>,
) {
    match (&action.action_type, &action.payload) {
        (ActionType::Shortcut, ActionPayload::Shortcut(payload)) => {
            let has_modifier = payload.ctrl || payload.shift || payload.alt || payload.win;
            if payload.key.trim().is_empty() && !has_modifier {
                errors.push(format!(
                    "action `{}` shortcut must have a key or at least one modifier.",
                    action.id
                ));
            }
        }
        (ActionType::TextSnippet, ActionPayload::TextSnippet(payload)) => match payload {
            TextSnippetPayload::Inline { text, .. } => {
                if text.trim().is_empty() {
                    errors.push(format!(
                        "action `{}` inline textSnippet payload must contain text.",
                        action.id
                    ));
                }
            }
            TextSnippetPayload::LibraryRef { snippet_id } => {
                if !snippet_ids.contains(snippet_id) {
                    errors.push(format!(
                        "action `{}` references missing snippet `{snippet_id}`.",
                        action.id
                    ));
                }
            }
        },
        (ActionType::Sequence, ActionPayload::Sequence(payload)) => {
            if payload.steps.is_empty() {
                errors.push(format!(
                    "action `{}` sequence must contain at least one step.",
                    action.id
                ));
            }
        }
        (ActionType::Launch, ActionPayload::Launch(payload)) => {
            if payload.target.trim().is_empty() {
                errors.push(format!(
                    "action `{}` launch target must not be empty.",
                    action.id
                ));
            }
        }
        (ActionType::Menu, ActionPayload::Menu(payload)) => {
            if payload.items.is_empty() {
                errors.push(format!(
                    "action `{}` menu must contain at least one item.",
                    action.id
                ));
            }
            validate_menu_items(
                &action.id,
                &payload.items,
                action_ids,
                actions_by_id,
                errors,
            );
        }
        (ActionType::MouseAction, ActionPayload::MouseAction(payload)) => {
            if payload.action.trim().is_empty() {
                errors.push(format!(
                    "action `{}` mouseAction must specify an action.",
                    action.id
                ));
            }
        }
        (ActionType::MediaKey, ActionPayload::MediaKey(payload)) => {
            if payload.key.trim().is_empty() {
                errors.push(format!(
                    "action `{}` mediaKey must specify a key.",
                    action.id
                ));
            }
        }
        (ActionType::ProfileSwitch, ActionPayload::ProfileSwitch(payload)) => {
            if payload.target_profile_id.trim().is_empty() {
                errors.push(format!(
                    "action `{}` profileSwitch must specify a targetProfileId.",
                    action.id
                ));
            }
        }
        (ActionType::Disabled, ActionPayload::Disabled(_)) => {}
        _ => errors.push(format!(
            "action `{}` type `{}` does not match payload shape.",
            action.id,
            action.action_type.as_str()
        )),
    }
}

fn validate_menu_items<'a>(
    action_id: &str,
    items: &'a [MenuItem],
    action_ids: &HashSet<String>,
    actions_by_id: &HashMap<&'a str, &'a Action>,
    errors: &mut Vec<String>,
) {
    let mut menu_item_ids = HashSet::new();
    for item in items {
        match item {
            MenuItem::Action { id, action_ref, .. } => {
                if !menu_item_ids.insert(id.clone()) {
                    errors.push(format!(
                        "menu action `{action_id}` contains duplicate menu item id `{id}`."
                    ));
                }
                if !action_ids.contains(action_ref) {
                    errors.push(format!(
                        "menu action `{action_id}` references missing action `{action_ref}`."
                    ));
                }
            }
            MenuItem::Submenu { id, items, .. } => {
                if !menu_item_ids.insert(id.clone()) {
                    errors.push(format!(
                        "menu action `{action_id}` contains duplicate menu item id `{id}`."
                    ));
                }
                validate_menu_items(action_id, items, action_ids, actions_by_id, errors);
            }
        }
    }

    let mut visited = HashSet::new();
    let mut stack = HashSet::new();
    if has_menu_cycle(
        action_id,
        action_id,
        actions_by_id,
        &mut visited,
        &mut stack,
    ) {
        errors.push(format!(
            "menu action `{action_id}` contains a cyclic action reference."
        ));
    }
}

fn has_menu_cycle<'a>(
    root_action_id: &str,
    current_action_id: &'a str,
    actions_by_id: &HashMap<&'a str, &'a Action>,
    visited: &mut HashSet<&'a str>,
    stack: &mut HashSet<&'a str>,
) -> bool {
    if !visited.insert(current_action_id) {
        return stack.contains(current_action_id);
    }

    stack.insert(current_action_id);

    let has_cycle = actions_by_id
        .get(current_action_id)
        .and_then(|action| match &action.payload {
            ActionPayload::Menu(payload) => Some(payload),
            _ => None,
        })
        .map(|payload| {
            payload.items.iter().any(|item| {
                menu_item_has_cycle(root_action_id, item, actions_by_id, visited, stack)
            })
        })
        .unwrap_or(false);

    stack.remove(current_action_id);
    has_cycle
}

fn menu_item_has_cycle<'a>(
    root_action_id: &str,
    item: &'a MenuItem,
    actions_by_id: &HashMap<&'a str, &'a Action>,
    visited: &mut HashSet<&'a str>,
    stack: &mut HashSet<&'a str>,
) -> bool {
    match item {
        MenuItem::Action { action_ref, .. } => {
            if action_ref == root_action_id {
                return true;
            }
            actions_by_id.get(action_ref.as_str()).is_some_and(|_| {
                has_menu_cycle(root_action_id, action_ref, actions_by_id, visited, stack)
            })
        }
        MenuItem::Submenu { items, .. } => items.iter().any(|nested_item| {
            menu_item_has_cycle(root_action_id, nested_item, actions_by_id, visited, stack)
        }),
    }
}

fn collect_unique_strings<'a>(
    items: impl Iterator<Item = (&'a String, &'static str)>,
    errors: &mut Vec<String>,
) -> HashSet<String> {
    let mut values = HashSet::new();
    for (value, collection_name) in items {
        if value.trim().is_empty() {
            errors.push(format!("{collection_name} contains an empty id."));
            continue;
        }
        if !values.insert(value.clone()) {
            errors.push(format!(
                "{collection_name} contains duplicate id `{value}`."
            ));
        }
    }
    values
}

fn collect_unique_controls(
    items: impl Iterator<Item = (ControlId, &'static str)>,
    errors: &mut Vec<String>,
) -> HashSet<ControlId> {
    let mut values = HashSet::new();
    for (value, collection_name) in items {
        if !values.insert(value) {
            errors.push(format!(
                "{collection_name} contains duplicate control `{}`.",
                value.as_str()
            ));
        }
    }
    values
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn io_error(path: Option<&Path>, error: std::io::Error) -> ConfigStoreError {
    ConfigStoreError::Io {
        path: path.map(path_string),
        message: match path {
            Some(path) => format!("I/O error at {}: {error}", path_string(path)),
            None => format!("I/O error: {error}"),
        },
    }
}

pub(crate) fn default_seed_config() -> AppConfig {
    AppConfig {
        version: SCHEMA_VERSION,
        settings: Settings {
            fallback_profile_id: "default".into(),
            theme: "synapse-light".into(),
            start_with_windows: true,
            minimize_to_tray: true,
            debug_logging: true,
        },
        profiles: seed_profiles(),
        physical_controls: seed_physical_controls(),
        encoder_mappings: seed_encoder_mappings(),
        app_mappings: seed_app_mappings(),
        bindings: seed_bindings(),
        actions: seed_actions(),
        snippet_library: seed_snippet_library(),
    }
}

fn seed_profiles() -> Vec<Profile> {
    vec![
        profile(
            "default",
            "Default",
            0,
            Some("Fallback profile for unmatched applications."),
        ),
        profile(
            "main",
            "Main",
            100,
            Some("Primary general workflow profile."),
        ),
        profile("code", "Code", 200, Some("Coding-focused profile.")),
        profile(
            "browser",
            "Browser",
            100,
            Some("General browsing workflow profile."),
        ),
        profile(
            "terminal",
            "Terminal",
            150,
            Some("Shell and terminal workflow profile."),
        ),
        profile(
            "telegram",
            "Telegram",
            100,
            Some("Messaging workflow profile."),
        ),
        profile(
            "writing",
            "Writing",
            100,
            Some("Long-form writing workflow profile."),
        ),
    ]
}

fn seed_physical_controls() -> Vec<PhysicalControl> {
    vec![
        physical_control(
            ControlId::Thumb01,
            ControlFamily::ThumbGrid,
            "Thumb 1",
            Some("Button 1"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb02,
            ControlFamily::ThumbGrid,
            "Thumb 2",
            Some("Button 2"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb03,
            ControlFamily::ThumbGrid,
            "Thumb 3",
            Some("Button 3"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb04,
            ControlFamily::ThumbGrid,
            "Thumb 4",
            Some("Button 4"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb05,
            ControlFamily::ThumbGrid,
            "Thumb 5",
            Some("Button 5"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb06,
            ControlFamily::ThumbGrid,
            "Thumb 6",
            Some("Button 6"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb07,
            ControlFamily::ThumbGrid,
            "Thumb 7",
            Some("Button 7"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb08,
            ControlFamily::ThumbGrid,
            "Thumb 8",
            Some("Button 8"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb09,
            ControlFamily::ThumbGrid,
            "Thumb 9",
            Some("Button 9"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb10,
            ControlFamily::ThumbGrid,
            "Thumb 10",
            Some("Button 10"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb11,
            ControlFamily::ThumbGrid,
            "Thumb 11",
            Some("Button 11"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::Thumb12,
            ControlFamily::ThumbGrid,
            "Thumb 12",
            Some("Button 12"),
            true,
            CapabilityStatus::Verified,
            Some("Seeded from the working side-grid mapping model."),
        ),
        physical_control(
            ControlId::MouseLeft,
            ControlFamily::TopPanel,
            "Left Click",
            Some("Left Click"),
            false,
            CapabilityStatus::Reserved,
            Some("Present in the model, but intentionally reserved in iteration 1."),
        ),
        physical_control(
            ControlId::MouseRight,
            ControlFamily::TopPanel,
            "Right Click",
            Some("Right Click"),
            false,
            CapabilityStatus::Reserved,
            Some(
                "Remapped to Hypershift in Synapse. Actual right-click = Hypershift + Left Click.",
            ),
        ),
        physical_control(
            ControlId::TopAux01,
            ControlFamily::TopPanel,
            "Top Aux 1",
            Some("DPI Stage Up"),
            true,
            CapabilityStatus::Verified,
            Some("Verified: Alt+F23 standard layer confirmed via hardware test."),
        ),
        physical_control(
            ControlId::TopAux02,
            ControlFamily::TopPanel,
            "Top Aux 2",
            Some("DPI Stage Down"),
            true,
            CapabilityStatus::Verified,
            Some("Verified: Alt+F24 standard layer confirmed via hardware test."),
        ),
        physical_control(
            ControlId::Mouse4,
            ControlFamily::TopPanel,
            "Mouse 4",
            Some("Forward"),
            true,
            CapabilityStatus::Verified,
            Some("Verified: Alt+F13 standard layer confirmed via hardware test."),
        ),
        physical_control(
            ControlId::Mouse5,
            ControlFamily::TopPanel,
            "Mouse 5",
            Some("Back"),
            true,
            CapabilityStatus::Verified,
            Some("Verified: Alt+F14 standard layer confirmed via hardware test."),
        ),
        physical_control(
            ControlId::WheelUp,
            ControlFamily::TopPanel,
            "Wheel Up",
            Some("Scroll Up"),
            true,
            CapabilityStatus::PartiallyRemappable,
            Some("Standard layer: native scroll (not intercepted). Hypershift: Ctrl+Alt+F16."),
        ),
        physical_control(
            ControlId::WheelDown,
            ControlFamily::TopPanel,
            "Wheel Down",
            Some("Scroll Down"),
            true,
            CapabilityStatus::PartiallyRemappable,
            Some("Standard layer: native scroll (not intercepted). Hypershift: Ctrl+Alt+F17."),
        ),
        physical_control(
            ControlId::WheelClick,
            ControlFamily::TopPanel,
            "Wheel Click",
            Some("Middle Click"),
            true,
            CapabilityStatus::Verified,
            Some("Verified: Alt+F15 standard layer confirmed via hardware test."),
        ),
        physical_control(
            ControlId::WheelLeft,
            ControlFamily::TopPanel,
            "Wheel Tilt Left",
            Some("Scroll Left Tilt"),
            false,
            CapabilityStatus::Reserved,
            Some("Not present on Naga V2 HyperSpeed. Kept for config compat."),
        ),
        physical_control(
            ControlId::WheelRight,
            ControlFamily::TopPanel,
            "Wheel Tilt Right",
            Some("Scroll Right Tilt"),
            false,
            CapabilityStatus::Reserved,
            Some("Not present on Naga V2 HyperSpeed. Kept for config compat."),
        ),
        physical_control(
            ControlId::HypershiftButton,
            ControlFamily::System,
            "Hypershift Button",
            Some("Razer Hypershift"),
            true,
            CapabilityStatus::NeedsValidation,
            Some("Exact encoder-model semantics remain unresolved."),
        ),
        physical_control(
            ControlId::TopSpecial01,
            ControlFamily::TopPanel,
            "Top Special 1",
            Some("Unknown special control 1"),
            false,
            CapabilityStatus::Reserved,
            Some("Phantom control — not present on Naga V2 HyperSpeed. Kept for config compat."),
        ),
        physical_control(
            ControlId::TopSpecial02,
            ControlFamily::TopPanel,
            "Top Special 2",
            Some("Unknown special control 2"),
            false,
            CapabilityStatus::Reserved,
            Some("Phantom control — not present on Naga V2 HyperSpeed. Kept for config compat."),
        ),
        physical_control(
            ControlId::TopSpecial03,
            ControlFamily::TopPanel,
            "Top Special 3",
            Some("Unknown special control 3"),
            false,
            CapabilityStatus::Reserved,
            Some("Phantom control — not present on Naga V2 HyperSpeed. Kept for config compat."),
        ),
    ]
}

fn seed_encoder_mappings() -> Vec<EncoderMapping> {
    vec![
        encoder_mapping(ControlId::Thumb01, Layer::Standard, "F13"),
        encoder_mapping(ControlId::Thumb02, Layer::Standard, "F14"),
        encoder_mapping(ControlId::Thumb03, Layer::Standard, "F15"),
        encoder_mapping(ControlId::Thumb04, Layer::Standard, "F16"),
        encoder_mapping(ControlId::Thumb05, Layer::Standard, "F17"),
        encoder_mapping(ControlId::Thumb06, Layer::Standard, "F18"),
        encoder_mapping(ControlId::Thumb07, Layer::Standard, "F19"),
        encoder_mapping(ControlId::Thumb08, Layer::Standard, "F20"),
        encoder_mapping(ControlId::Thumb09, Layer::Standard, "F21"),
        encoder_mapping(ControlId::Thumb10, Layer::Standard, "F22"),
        encoder_mapping(ControlId::Thumb11, Layer::Standard, "F23"),
        encoder_mapping(ControlId::Thumb12, Layer::Standard, "F24"),
        encoder_mapping(ControlId::Thumb01, Layer::Hypershift, "Ctrl+Alt+Shift+F13"),
        encoder_mapping(ControlId::Thumb02, Layer::Hypershift, "Ctrl+Alt+Shift+F14"),
        encoder_mapping(ControlId::Thumb03, Layer::Hypershift, "Ctrl+Alt+Shift+F15"),
        encoder_mapping(ControlId::Thumb04, Layer::Hypershift, "Ctrl+Alt+Shift+F16"),
        encoder_mapping(ControlId::Thumb05, Layer::Hypershift, "Ctrl+Alt+Shift+F17"),
        encoder_mapping(ControlId::Thumb06, Layer::Hypershift, "Ctrl+Alt+Shift+F18"),
        encoder_mapping(ControlId::Thumb07, Layer::Hypershift, "Ctrl+Alt+Shift+F19"),
        encoder_mapping(ControlId::Thumb08, Layer::Hypershift, "Ctrl+Alt+Shift+F20"),
        encoder_mapping(ControlId::Thumb09, Layer::Hypershift, "Ctrl+Alt+Shift+F21"),
        encoder_mapping(ControlId::Thumb10, Layer::Hypershift, "Ctrl+Alt+Shift+F22"),
        encoder_mapping(ControlId::Thumb11, Layer::Hypershift, "Ctrl+Alt+Shift+F23"),
        encoder_mapping(ControlId::Thumb12, Layer::Hypershift, "Ctrl+Alt+Shift+F24"),
        // Top panel – standard layer (Alt+F-key avoids Win+F-key system conflicts)
        encoder_mapping(ControlId::TopAux01, Layer::Standard, "Alt+F23"),
        encoder_mapping(ControlId::TopAux02, Layer::Standard, "Alt+F24"),
        encoder_mapping(ControlId::Mouse4, Layer::Standard, "Alt+F13"),
        encoder_mapping(ControlId::Mouse5, Layer::Standard, "Alt+F14"),
        encoder_mapping(ControlId::WheelClick, Layer::Standard, "Alt+F15"),
        // Top panel – hypershift layer
        encoder_mapping(ControlId::TopAux01, Layer::Hypershift, "Ctrl+Alt+F23"),
        encoder_mapping(ControlId::TopAux02, Layer::Hypershift, "Ctrl+Alt+F24"),
        encoder_mapping(ControlId::Mouse4, Layer::Hypershift, "Ctrl+Alt+F13"),
        encoder_mapping(ControlId::Mouse5, Layer::Hypershift, "Ctrl+Alt+F14"),
        encoder_mapping(ControlId::WheelClick, Layer::Hypershift, "Ctrl+Alt+F15"),
        encoder_mapping(ControlId::WheelUp, Layer::Hypershift, "Ctrl+Alt+F16"),
        encoder_mapping(ControlId::WheelDown, Layer::Hypershift, "Ctrl+Alt+F17"),
    ]
}

fn seed_app_mappings() -> Vec<AppMapping> {
    vec![
        app_mapping("app-code", "code.exe", "code", 200),
        app_mapping("app-cursor", "cursor.exe", "code", 200),
        app_mapping("app-chrome", "chrome.exe", "browser", 100),
        app_mapping("app-msedge", "msedge.exe", "browser", 100),
        app_mapping("app-firefox", "firefox.exe", "browser", 100),
        app_mapping(
            "app-windowsterminal",
            "windowsterminal.exe",
            "terminal",
            150,
        ),
        app_mapping("app-pwsh", "pwsh.exe", "terminal", 150),
        app_mapping("app-cmd", "cmd.exe", "terminal", 150),
        app_mapping("app-telegram", "telegram.exe", "telegram", 100),
        app_mapping("app-notepadpp", "notepad++.exe", "writing", 100),
    ]
}

fn seed_snippet_library() -> Vec<SnippetLibraryItem> {
    vec![
        snippet(
            "snippet-code-validation",
            "Validation",
            "Проверь валидацию, null, empty, edge cases, race conditions",
            &["code", "review"],
        ),
        snippet(
            "snippet-ask-me",
            "Ask Me",
            "Спроси меня",
            &["code", "prompt"],
        ),
        snippet(
            "snippet-agents-for-analysis",
            "Agents for Analysis",
            "Агенты для анализа",
            &["code", "prompt"],
        ),
        snippet(
            "snippet-best-practices",
            "Best Practices",
            "Best Practices",
            &["code", "prompt"],
        ),
        snippet("snippet-resume", "/resume", "/resume", &["command"]),
        snippet("snippet-max", "/max", "/max", &["command"]),
        snippet(
            "snippet-agent-team",
            "Agent Team",
            "Agent Team",
            &["code", "prompt"],
        ),
        snippet(
            "snippet-danger-skip-permissions",
            "Danger Skip Permissions",
            "dangerously-skip-permissions-check",
            &["code", "prompt"],
        ),
        snippet(
            "snippet-fix-by-gos",
            "Fix by GOS",
            "предложи правильный fix по ГОС",
            &["code", "prompt"],
        ),
        snippet(
            "snippet-danger-bypass-restrictions",
            "Danger Bypass Restrictions",
            "dangerously-bypass-approvals-and-restrictions",
            &["code", "prompt"],
        ),
    ]
}

fn seed_actions() -> Vec<Action> {
    let mut actions = Vec::new();

    for (profile, layer, control, pretty, key, ctrl, shift, alt, win, raw) in [
        (
            "default",
            Layer::Standard,
            ControlId::Thumb01,
            "Ctrl + C",
            "C",
            true,
            false,
            false,
            false,
            "^c",
        ),
        (
            "default",
            Layer::Standard,
            ControlId::Thumb02,
            "Ctrl + V",
            "V",
            true,
            false,
            false,
            false,
            "^v",
        ),
        (
            "default",
            Layer::Standard,
            ControlId::Thumb03,
            "Ctrl + F",
            "F",
            true,
            false,
            false,
            false,
            "^f",
        ),
        (
            "default",
            Layer::Standard,
            ControlId::Thumb04,
            "Ctrl + Z",
            "Z",
            true,
            false,
            false,
            false,
            "^z",
        ),
        (
            "default",
            Layer::Standard,
            ControlId::Thumb05,
            "Ctrl + S",
            "S",
            true,
            false,
            false,
            false,
            "^s",
        ),
        (
            "default",
            Layer::Standard,
            ControlId::Thumb06,
            "Ctrl + W",
            "W",
            true,
            false,
            false,
            false,
            "^w",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb01,
            "Delete",
            "Delete",
            false,
            false,
            false,
            false,
            "{Delete}",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb02,
            "Backspace",
            "Backspace",
            false,
            false,
            false,
            false,
            "{Backspace}",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb03,
            "Shift + F3",
            "F3",
            false,
            true,
            false,
            false,
            "+{F3}",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb04,
            "Ctrl + F",
            "F",
            true,
            false,
            false,
            false,
            "^f",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb05,
            "Ctrl + S",
            "S",
            true,
            false,
            false,
            false,
            "^s",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb06,
            "Ctrl + Z",
            "Z",
            true,
            false,
            false,
            false,
            "^z",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb07,
            "Alt + F4",
            "F4",
            false,
            false,
            true,
            false,
            "!{F4}",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb08,
            "Enter",
            "Enter",
            false,
            false,
            false,
            false,
            "{Enter}",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb09,
            "Ctrl + C",
            "C",
            true,
            false,
            false,
            false,
            "^c",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb10,
            "Ctrl + W",
            "W",
            true,
            false,
            false,
            false,
            "^w",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb11,
            "Space",
            "Space",
            false,
            false,
            false,
            false,
            "{Space}",
        ),
        (
            "main",
            Layer::Standard,
            ControlId::Thumb12,
            "Ctrl + V",
            "V",
            true,
            false,
            false,
            false,
            "^v",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb01,
            "Minus",
            "-",
            false,
            false,
            false,
            false,
            "-",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb02,
            "Ctrl + Shift + =",
            "=",
            true,
            true,
            false,
            false,
            "^+=",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb03,
            "Alt + Ctrl + Shift + R",
            "R",
            true,
            true,
            true,
            false,
            "!^+r",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb04,
            "Ctrl + H",
            "H",
            true,
            false,
            false,
            false,
            "^h",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb06,
            "Ctrl + Y",
            "Y",
            true,
            false,
            false,
            false,
            "^y",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb07,
            "Alt + Ctrl + Shift + I",
            "I",
            true,
            true,
            true,
            false,
            "!^+i",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb08,
            "Shift + Enter",
            "Enter",
            false,
            true,
            false,
            false,
            "+{Enter}",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb10,
            "Ctrl + Shift + T",
            "T",
            true,
            true,
            false,
            false,
            "^+t",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb11,
            "Ctrl + Shift + 8",
            "8",
            true,
            true,
            false,
            false,
            "^+8",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb12,
            "Win + V",
            "V",
            false,
            false,
            false,
            true,
            "#v",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb01,
            "Delete",
            "Delete",
            false,
            false,
            false,
            false,
            "{Delete}",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb02,
            "Backspace",
            "Backspace",
            false,
            false,
            false,
            false,
            "{Backspace}",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb04,
            "Ctrl + F",
            "F",
            true,
            false,
            false,
            false,
            "^f",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb05,
            "Ctrl + S",
            "S",
            true,
            false,
            false,
            false,
            "^s",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb06,
            "Ctrl + Z",
            "Z",
            true,
            false,
            false,
            false,
            "^z",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb07,
            "Alt + F4",
            "F4",
            false,
            false,
            true,
            false,
            "!{F4}",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb08,
            "Enter",
            "Enter",
            false,
            false,
            false,
            false,
            "{Enter}",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb09,
            "Ctrl + Insert",
            "Insert",
            true,
            false,
            false,
            false,
            "Ctrl+Insert",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb10,
            "Ctrl + W",
            "W",
            true,
            false,
            false,
            false,
            "^w",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb11,
            "Space",
            "Space",
            false,
            false,
            false,
            false,
            "{Space}",
        ),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb12,
            "Shift + Insert",
            "Insert",
            false,
            true,
            false,
            false,
            "Shift+Insert",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb08,
            "Shift + Enter",
            "Enter",
            false,
            true,
            false,
            false,
            "+{Enter}",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb10,
            "Shift + Tab",
            "Tab",
            false,
            true,
            false,
            false,
            "+{Tab}",
        ),
    ] {
        actions.push(shortcut_action(
            action_id(profile, layer, control),
            pretty,
            key,
            ctrl,
            shift,
            alt,
            win,
            raw,
        ));
    }

    for (profile, layer, control, pretty, snippet_id) in [
        (
            "code",
            Layer::Standard,
            ControlId::Thumb03,
            "Validation",
            "snippet-code-validation",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb01,
            "Ask Me",
            "snippet-ask-me",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb02,
            "Agents for Analysis",
            "snippet-agents-for-analysis",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb03,
            "Best Practices",
            "snippet-best-practices",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb04,
            "/resume",
            "snippet-resume",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb05,
            "/max",
            "snippet-max",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb06,
            "Agent Team",
            "snippet-agent-team",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb07,
            "dangerously-skip-permissions-check",
            "snippet-danger-skip-permissions",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb09,
            "Fix by GOS",
            "snippet-fix-by-gos",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb11,
            "dangerously-bypass-approvals-and-restrictions",
            "snippet-danger-bypass-restrictions",
        ),
    ] {
        actions.push(text_snippet_library_action(
            action_id(profile, layer, control),
            pretty,
            snippet_id,
        ));
    }

    for (profile, layer, control, pretty, notes) in [
        ("main", Layer::Hypershift, ControlId::Thumb05, "Right Ctrl + Right Shift + -", "Unresolved exact semantics. Preserve as placeholder until device validation confirms whether this is a shortcut or text payload."),
        ("main", Layer::Hypershift, ControlId::Thumb09, "Copy without paragraphs", "Unresolved exact logic. Preserve as placeholder until the text or sequence behavior is confirmed."),
        ("code", Layer::Hypershift, ControlId::Thumb12, "Paste Win", "Unresolved exact intent. Preserve as placeholder until the real action is confirmed."),
    ] {
        actions.push(disabled_placeholder_action(
            action_id(profile, layer, control),
            pretty,
            notes,
        ));
    }

    actions
}

fn seed_bindings() -> Vec<Binding> {
    let mut bindings = Vec::new();

    for (profile, layer, control, label) in [
        ("default", Layer::Standard, ControlId::Thumb01, "Copy"),
        ("default", Layer::Standard, ControlId::Thumb02, "Paste"),
        ("default", Layer::Standard, ControlId::Thumb03, "Find"),
        ("default", Layer::Standard, ControlId::Thumb04, "Undo"),
        ("default", Layer::Standard, ControlId::Thumb05, "Save"),
        ("default", Layer::Standard, ControlId::Thumb06, "Close tab"),
        ("main", Layer::Standard, ControlId::Thumb01, "Delete"),
        ("main", Layer::Standard, ControlId::Thumb02, "Backspace"),
        ("main", Layer::Standard, ControlId::Thumb03, "Shift + F3"),
        ("main", Layer::Standard, ControlId::Thumb04, "Ctrl + F"),
        ("main", Layer::Standard, ControlId::Thumb05, "Ctrl + S"),
        ("main", Layer::Standard, ControlId::Thumb06, "Ctrl + Z"),
        ("main", Layer::Standard, ControlId::Thumb07, "Alt + F4"),
        ("main", Layer::Standard, ControlId::Thumb08, "Enter"),
        ("main", Layer::Standard, ControlId::Thumb09, "Ctrl + C"),
        ("main", Layer::Standard, ControlId::Thumb10, "Ctrl + W"),
        ("main", Layer::Standard, ControlId::Thumb11, "Space"),
        ("main", Layer::Standard, ControlId::Thumb12, "Ctrl + V"),
        ("main", Layer::Hypershift, ControlId::Thumb01, "Minus"),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb02,
            "Ctrl + Shift + =",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb03,
            "Alt + Ctrl + Shift + R",
        ),
        ("main", Layer::Hypershift, ControlId::Thumb04, "Ctrl + H"),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb05,
            "Right Ctrl + Right Shift + -",
        ),
        ("main", Layer::Hypershift, ControlId::Thumb06, "Ctrl + Y"),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb07,
            "Alt + Ctrl + Shift + I",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb08,
            "Shift + Enter",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb09,
            "Copy without paragraphs",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb10,
            "Ctrl + Shift + T",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb11,
            "Ctrl + Shift + 8",
        ),
        ("main", Layer::Hypershift, ControlId::Thumb12, "Win + V"),
        ("code", Layer::Standard, ControlId::Thumb01, "Delete"),
        ("code", Layer::Standard, ControlId::Thumb02, "Backspace"),
        ("code", Layer::Standard, ControlId::Thumb03, "Validation"),
        ("code", Layer::Standard, ControlId::Thumb04, "Ctrl + F"),
        ("code", Layer::Standard, ControlId::Thumb05, "Ctrl + S"),
        ("code", Layer::Standard, ControlId::Thumb06, "Ctrl + Z"),
        ("code", Layer::Standard, ControlId::Thumb07, "Alt + F4"),
        ("code", Layer::Standard, ControlId::Thumb08, "Enter"),
        ("code", Layer::Standard, ControlId::Thumb09, "Ctrl + Insert"),
        ("code", Layer::Standard, ControlId::Thumb10, "Ctrl + W"),
        ("code", Layer::Standard, ControlId::Thumb11, "Space"),
        (
            "code",
            Layer::Standard,
            ControlId::Thumb12,
            "Shift + Insert",
        ),
        ("code", Layer::Hypershift, ControlId::Thumb01, "Ask Me"),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb02,
            "Agents for Analysis",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb03,
            "Best Practices",
        ),
        ("code", Layer::Hypershift, ControlId::Thumb04, "/resume"),
        ("code", Layer::Hypershift, ControlId::Thumb05, "/max"),
        ("code", Layer::Hypershift, ControlId::Thumb06, "Agent Team"),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb07,
            "dangerously-skip-permissions-check",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb08,
            "Shift + Enter",
        ),
        ("code", Layer::Hypershift, ControlId::Thumb09, "Fix by GOS"),
        ("code", Layer::Hypershift, ControlId::Thumb10, "Shift + Tab"),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb11,
            "dangerously-bypass-approvals-and-restrictions",
        ),
        ("code", Layer::Hypershift, ControlId::Thumb12, "Paste Win"),
    ] {
        bindings.push(binding(
            binding_id(profile, layer, control),
            profile,
            layer,
            control,
            label,
            action_id(profile, layer, control),
        ));
    }

    bindings
}

fn profile(id: &str, name: &str, priority: i32, description: Option<&str>) -> Profile {
    Profile {
        id: id.into(),
        name: name.into(),
        description: description.map(str::to_owned),
        enabled: true,
        priority,
    }
}

fn physical_control(
    id: ControlId,
    family: ControlFamily,
    default_name: &str,
    synapse_name: Option<&str>,
    remappable: bool,
    capability_status: CapabilityStatus,
    notes: Option<&str>,
) -> PhysicalControl {
    PhysicalControl {
        id,
        family,
        default_name: default_name.into(),
        synapse_name: synapse_name.map(str::to_owned),
        remappable,
        capability_status,
        notes: notes.map(str::to_owned),
    }
}

fn encoder_mapping(control_id: ControlId, layer: Layer, encoded_key: &str) -> EncoderMapping {
    EncoderMapping {
        control_id,
        layer,
        encoded_key: encoded_key.into(),
        source: MappingSource::Synapse,
        verified: true,
    }
}

fn app_mapping(id: &str, exe: &str, profile_id: &str, priority: i32) -> AppMapping {
    AppMapping {
        id: id.into(),
        exe: exe.into(),
        process_path: None,
        title_includes: Vec::new(),
        profile_id: profile_id.into(),
        enabled: true,
        priority,
    }
}

fn snippet(id: &str, name: &str, text: &str, tags: &[&str]) -> SnippetLibraryItem {
    SnippetLibraryItem {
        id: id.into(),
        name: name.into(),
        text: text.into(),
        paste_mode: PasteMode::SendText,
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        notes: None,
    }
}

fn shortcut_action(
    id: String,
    pretty: &str,
    key: &str,
    ctrl: bool,
    shift: bool,
    alt: bool,
    win: bool,
    raw: &str,
) -> Action {
    Action {
        id,
        action_type: ActionType::Shortcut,
        payload: ActionPayload::Shortcut(ShortcutActionPayload {
            key: key.into(),
            ctrl,
            shift,
            alt,
            win,
            raw: Some(raw.into()),
        }),
        pretty: pretty.into(),
        notes: None,
        conditions: Vec::new(),
    }
}

fn text_snippet_library_action(id: String, pretty: &str, snippet_id: &str) -> Action {
    Action {
        id,
        action_type: ActionType::TextSnippet,
        payload: ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef {
            snippet_id: snippet_id.into(),
        }),
        pretty: pretty.into(),
        notes: None,
        conditions: Vec::new(),
    }
}

fn disabled_placeholder_action(id: String, pretty: &str, notes: &str) -> Action {
    Action {
        id,
        action_type: ActionType::Disabled,
        payload: ActionPayload::Disabled(DisabledActionPayload::default()),
        pretty: pretty.into(),
        notes: Some(notes.into()),
        conditions: Vec::new(),
    }
}

fn binding(
    id: String,
    profile_id: &str,
    layer: Layer,
    control_id: ControlId,
    label: &str,
    action_ref: String,
) -> Binding {
    Binding {
        id,
        profile_id: profile_id.into(),
        layer,
        control_id,
        label: label.into(),
        action_ref,
        color_tag: None,
        trigger_mode: None,
        chord_partner: None,
        enabled: true,
    }
}

fn action_id(profile_id: &str, layer: Layer, control_id: ControlId) -> String {
    format!(
        "action-{profile_id}-{}-{}",
        layer.as_str(),
        control_id.as_str().replace('_', "-")
    )
}

fn binding_id(profile_id: &str, layer: Layer, control_id: ControlId) -> String {
    format!(
        "binding-{profile_id}-{}-{}",
        layer.as_str(),
        control_id.as_str().replace('_', "-")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_seed_config_validates() {
        let config = default_seed_config();
        let schema_value = serde_json::to_value(&config).expect("serialize config");
        validate_config_schema_value(&schema_value).expect("default config should match schema");
        let warnings = validate_config(&config).expect("default config should validate");
        assert!(
            warnings.is_empty(),
            "default config should not emit warnings"
        );
        assert_eq!(config.profiles.len(), 7);
        assert_eq!(config.physical_controls.len(), ControlId::ALL.len());
    }

    #[test]
    fn load_missing_config_creates_seed_file() {
        let temp_dir = tempdir().expect("temp dir");
        let response = load_or_initialize_config(temp_dir.path()).expect("load should succeed");

        assert!(response.created_default);
        assert!(temp_dir.path().join(CONFIG_FILE_NAME).exists());
        assert_eq!(response.config.version, SCHEMA_VERSION);
    }

    #[test]
    fn save_creates_backup_when_config_exists() {
        let temp_dir = tempdir().expect("temp dir");
        let first = load_or_initialize_config(temp_dir.path()).expect("seed load");

        let response = save_config(temp_dir.path(), first.config).expect("save should succeed");

        assert_eq!(
            response.backup_path,
            Some(path_string(&temp_dir.path().join(BACKUP_FILE_NAME)))
        );
        assert!(temp_dir.path().join(BACKUP_FILE_NAME).exists());
    }

    #[test]
    fn save_rejects_schema_invalid_empty_binding_label() {
        let temp_dir = tempdir().expect("temp dir");
        let mut config = default_seed_config();
        config.bindings[0].label = String::new();

        let result = save_config(temp_dir.path(), config);

        match result {
            Err(ConfigStoreError::SchemaViolation { errors }) => {
                assert!(
                    errors
                        .iter()
                        .any(|error| error.contains("/bindings/0/label")),
                    "expected binding label schema error, got {errors:?}"
                );
            }
            other => panic!("expected schema violation, got {other:?}"),
        }
    }

    #[test]
    fn save_rejects_duplicate_encoded_keys() {
        let temp_dir = tempdir().expect("temp dir");
        let mut config = default_seed_config();
        let duplicate_key = config.encoder_mappings[0].encoded_key.clone();
        config.encoder_mappings[1].encoded_key = duplicate_key;

        let result = save_config(temp_dir.path(), config);

        match result {
            Err(ConfigStoreError::InvalidConfig { errors }) => {
                assert!(
                    errors
                        .iter()
                        .any(|error| error.contains("Duplicate encoderMappings encodedKey")),
                    "expected duplicate encodedKey validation error, got {errors:?}"
                );
            }
            other => panic!("expected invalid config, got {other:?}"),
        }
    }

    #[test]
    fn save_rejects_canonical_duplicate_encoded_keys() {
        let temp_dir = tempdir().expect("temp dir");
        let mut config = default_seed_config();
        config.encoder_mappings[0].encoded_key = "Ctrl+Alt+Shift+F13".into();
        config.encoder_mappings[12].encoded_key = " ctrl + alt + shift + f13 ".into();

        let result = save_config(temp_dir.path(), config);

        match result {
            Err(ConfigStoreError::InvalidConfig { errors }) => {
                assert!(
                    errors
                        .iter()
                        .any(|error| error.contains("Ctrl+Alt+Shift+F13")),
                    "expected canonical duplicate encodedKey validation error, got {errors:?}"
                );
            }
            other => panic!("expected invalid config, got {other:?}"),
        }
    }

    #[test]
    fn save_and_load_preserves_trigger_mode() {
        let temp_dir = tempdir().expect("temp dir");
        let mut config = default_seed_config();
        config.bindings[0].trigger_mode = Some(TriggerMode::Hold);

        save_config(temp_dir.path(), config.clone()).expect("save should succeed");

        let loaded = load_or_initialize_config(temp_dir.path()).expect("load should succeed");
        assert_eq!(loaded.config.bindings[0].trigger_mode, Some(TriggerMode::Hold));
        // Other bindings remain None
        assert_eq!(loaded.config.bindings[1].trigger_mode, None);
    }
}
