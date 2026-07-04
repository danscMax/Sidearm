use jsonschema::Validator;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tempfile::NamedTempFile;
use thiserror::Error;

const CONFIG_FILE_NAME: &str = "config.json";
const SCHEMA_VERSION: i32 = 2;
pub(crate) const DEFAULT_GLOBAL_SHORTCUT: &str = "ctrl+alt+n";
const CONFIG_SCHEMA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../schemas/config.v2.schema.json"
));

#[derive(Debug, Error)]
pub enum ConfigStoreError {
    // Retained for future readonly-fs scenarios; the public error code
    // `config_directory_unavailable` is still exposed via `From<CommandError>`.
    #[allow(dead_code)]
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
    // Another Sidearm instance changed config.json since this process loaded it.
    // Returned by `save_config` to prevent a stale instance from blindly
    // overwriting (clobbering) the other instance's edits — the caller reloads
    // from disk instead. See the concurrent-instance clobber bug.
    #[error("Config was modified by another instance.")]
    ConcurrentModification,
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

const REGEX_PREFIX: &str = "regex:";
const MAX_REGEX_PATTERN_LEN: usize = 500;
const REGEX_SIZE_LIMIT: usize = 10_240;

/// Compile a `title_includes` regex pattern under the SAME guards used at
/// pre-compilation time: reject patterns longer than [`MAX_REGEX_PATTERN_LEN`]
/// and cap the compiled program at [`REGEX_SIZE_LIMIT`] bytes. `pattern` is the
/// raw pattern WITHOUT the `regex:` prefix. Returns `None` (logging a warning)
/// when the pattern is rejected or fails to build, so callers treat it as
/// "does not match".
///
/// Shared by `AppConfig::compile_title_regexes` and the resolver's
/// compile-on-demand fallback so a pattern rejected at load time can never be
/// recompiled without limits on the hot path. See finding F020.
pub(crate) fn compile_title_regex(pattern: &str, context: &str) -> Option<regex::Regex> {
    if pattern.len() > MAX_REGEX_PATTERN_LEN {
        log::warn!(
            "[config] Regex pattern too long ({} chars, max {}) in {}",
            pattern.len(),
            MAX_REGEX_PATTERN_LEN,
            context
        );
        return None;
    }
    match regex::RegexBuilder::new(&format!("(?i){pattern}"))
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
    {
        Ok(re) => Some(re),
        Err(e) => {
            log::warn!("[config] Invalid regex in {context}: {e}");
            None
        }
    }
}

impl AppConfig {
    /// Pre-compile regex patterns in `title_includes` fields for all app mappings.
    /// Call after config load/save to avoid recompiling on every keypress.
    pub fn compile_title_regexes(&mut self) {
        for mapping in &mut self.app_mappings {
            let mapping_context = format!("app mapping `{}`", mapping.id);
            mapping.compiled_title_regexes = mapping
                .title_includes
                .iter()
                .map(|needle| {
                    needle
                        .strip_prefix(REGEX_PREFIX)
                        .and_then(|pattern| compile_title_regex(pattern, &mapping_context))
                })
                .collect();
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OsdPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    #[default]
    BottomRight,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OsdFontSize {
    Small,
    #[default]
    Medium,
    Large,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OsdAnimation {
    #[default]
    SlideIn,
    FadeIn,
    None,
}

fn default_osd_enabled() -> bool {
    true
}

fn default_osd_duration_ms() -> u32 {
    2000
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub fallback_profile_id: String,
    pub theme: String,
    pub start_with_windows: bool,
    pub minimize_to_tray: bool,
    pub debug_logging: bool,
    #[serde(default = "default_osd_enabled")]
    pub osd_enabled: bool,
    #[serde(default = "default_osd_duration_ms")]
    pub osd_duration_ms: u32,
    #[serde(default)]
    pub osd_position: OsdPosition,
    #[serde(default)]
    pub osd_font_size: OsdFontSize,
    #[serde(default)]
    pub osd_animation: OsdAnimation,
    /// Optional override for how long the capture helper keeps a CONSUMED
    /// modifier-VK entry before it is garbage-collected. Unit: milliseconds.
    /// Clamped server-side to 500..=30000. Default 5000 (5 s). Shorten if
    /// Ctrl/Shift/Alt occasionally stick; lengthen if mouse chords randomly
    /// fail to trigger (the chord's modifier-up was lost to a focus change).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifier_stale_gc_ms: Option<u64>,
    /// Optional override for how long the capture helper keeps a REPLAYED
    /// modifier-VK entry awaiting its real key-up before force-releasing the
    /// injected modifier via SendInput. Covers the "physical Ctrl-up was
    /// lost (alt-tab / RDP / Razer firmware drop)" case for replays from
    /// `flush_expired_pending_modifiers` / Case B/D non-encoding drain.
    /// Unit: milliseconds. Clamped server-side to 1000..=60000. Default
    /// 30000 (30 s) — large enough to not break "user holds Ctrl 5+ s and
    /// presses a Sidearm action" use case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replayed_modifier_force_release_ms: Option<u64>,
    /// Optional user override for the OS-global show/hide shortcut. `None`
    /// preserves the historical Ctrl+Alt+N default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_shortcut: Option<String>,
    /// Last profile the user opened in the sidebar editor. This is **editor
    /// view-state only** — the runtime resolver does NOT use it (resolution is
    /// `app mapping > fallback`). Kept so the UI reopens the last-edited profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_selected_profile_id: Option<String>,
    /// Whether the first-run onboarding wizard has been completed or skipped.
    /// Gates the full-screen wizard in the frontend.
    #[serde(default)]
    pub onboarding_completed: bool,
    /// Resume point (visible step index) for the onboarding wizard; `None`
    /// starts from the beginning. Only meaningful while onboarding is incomplete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onboarding_step: Option<u32>,
    /// Auto-repair the clipboard after a copy/cut shortcut if it was garbled by
    /// the terminal's OSC 52 path (valid UTF-8 read as Latin-1). Off by default;
    /// the conservative detector only rewrites unambiguous mojibake.
    #[serde(default)]
    pub repair_clipboard_on_copy: bool,
    /// User-facing device label shown in the sidebar brand block. `None` falls
    /// back to a localized "device not recognized" string. Purely cosmetic —
    /// the runtime never reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
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
    /// Pre-compiled regexes for `title_includes` entries starting with `regex:`.
    /// Populated by `compile_title_regexes()` after config load.
    #[serde(skip)]
    pub compiled_title_regexes: Vec<Option<regex::Regex>>,
}

impl PartialEq for AppMapping {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.exe == other.exe
            && self.process_path == other.process_path
            && self.title_includes == other.title_includes
            && self.profile_id == other.profile_id
            && self.enabled == other.enabled
            && self.priority == other.priority
    }
}

impl Eq for AppMapping {}

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
    // Renamed from `actionRef` (v0.1.22); `alias` keeps existing on-disk configs loadable.
    #[serde(alias = "actionRef")]
    pub action_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_mode: Option<TriggerMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chord_partner: Option<ControlId>,
    /// Optional per-binding throttle: ignore re-triggers that arrive within this
    /// many milliseconds of the last execution. `None`/0 = no throttle. Clamped
    /// to 0..=5000 in the UI. Off by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throttle_ms: Option<u32>,
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
    RepairClipboard,
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
            ActionType::RepairClipboard => "repairClipboard",
        }
    }

    /// Every variant, in declaration order. Test-only: the set-equality guard
    /// `action_type_set_matches_schema_enum` iterates this and asserts it equals
    /// `$defs.actionType.enum` in `schemas/config.v2.schema.json`. The always-on
    /// `match` below forces a new variant to be added here and to the schema
    /// (a missed schema entry is a save-breaker).
    #[cfg(test)]
    const ALL: [ActionType; 10] = [
        ActionType::Shortcut,
        ActionType::TextSnippet,
        ActionType::Sequence,
        ActionType::Launch,
        ActionType::Menu,
        ActionType::MouseAction,
        ActionType::MediaKey,
        ActionType::ProfileSwitch,
        ActionType::Disabled,
        ActionType::RepairClipboard,
    ];
}

// Compile-time exhaustiveness: adding an ActionType variant breaks this match
// (no `_` arm), forcing you to also update `ActionType::ALL` above and
// `$defs.actionType.enum` in schemas/config.v2.schema.json — the JSON contract a
// saved config is validated against, where a missed entry is a save-breaker.
const _: fn(ActionType) = |a| match a {
    ActionType::Shortcut
    | ActionType::TextSnippet
    | ActionType::Sequence
    | ActionType::Launch
    | ActionType::Menu
    | ActionType::MouseAction
    | ActionType::MediaKey
    | ActionType::ProfileSwitch
    | ActionType::Disabled
    | ActionType::RepairClipboard => {}
};

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
    // Renamed from `display_name` (v0.1.22); `alias` keeps existing on-disk configs loadable.
    #[serde(alias = "pretty")]
    pub display_name: String,
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
    RepairClipboard(RepairClipboardActionPayload),
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repeat: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delay_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repeat: Option<u32>,
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
        #[serde(alias = "actionRef")]
        action_id: String,
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

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MouseActionKind {
    LeftClick,
    RightClick,
    MiddleClick,
    DoubleClick,
    ScrollUp,
    ScrollDown,
    ScrollLeft,
    ScrollRight,
    MouseBack,
    MouseForward,
}

impl MouseActionKind {
    /// Every variant, in UI order. Test-only: `mouse_action_kind_set_matches_schema_enum`
    /// iterates this and asserts it equals `$defs.mouseActionKind.enum` in the schema.
    /// The always-on `match` below forces a new variant to be added here and to the
    /// schema. Mirrors `ActionType::ALL`.
    #[cfg(test)]
    const ALL: [MouseActionKind; 10] = [
        MouseActionKind::LeftClick,
        MouseActionKind::RightClick,
        MouseActionKind::MiddleClick,
        MouseActionKind::DoubleClick,
        MouseActionKind::ScrollUp,
        MouseActionKind::ScrollDown,
        MouseActionKind::ScrollLeft,
        MouseActionKind::ScrollRight,
        MouseActionKind::MouseBack,
        MouseActionKind::MouseForward,
    ];
}

// Compile-time exhaustiveness: adding a MouseActionKind variant breaks this match
// (no `_` arm), forcing you to also update `MouseActionKind::ALL` above and
// `$defs.mouseActionKind.enum` in schemas/config.v2.schema.json.
const _: fn(MouseActionKind) = |k| match k {
    MouseActionKind::LeftClick
    | MouseActionKind::RightClick
    | MouseActionKind::MiddleClick
    | MouseActionKind::DoubleClick
    | MouseActionKind::ScrollUp
    | MouseActionKind::ScrollDown
    | MouseActionKind::ScrollLeft
    | MouseActionKind::ScrollRight
    | MouseActionKind::MouseBack
    | MouseActionKind::MouseForward => {}
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MouseActionPayload {
    pub action: MouseActionKind,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub win: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaKeyKind {
    PlayPause,
    NextTrack,
    PrevTrack,
    Stop,
    VolumeUp,
    VolumeDown,
    Mute,
}

impl MediaKeyKind {
    /// Every variant, in UI order. Test-only: `media_key_kind_set_matches_schema_enum`
    /// iterates this and asserts it equals `$defs.mediaKeyKind.enum` in the schema.
    /// The always-on `match` below forces a new variant to be added here and to the
    /// schema. Mirrors `ActionType::ALL`.
    #[cfg(test)]
    const ALL: [MediaKeyKind; 7] = [
        MediaKeyKind::PlayPause,
        MediaKeyKind::NextTrack,
        MediaKeyKind::PrevTrack,
        MediaKeyKind::Stop,
        MediaKeyKind::VolumeUp,
        MediaKeyKind::VolumeDown,
        MediaKeyKind::Mute,
    ];
}

// Compile-time exhaustiveness: adding a MediaKeyKind variant breaks this match
// (no `_` arm), forcing you to also update `MediaKeyKind::ALL` above and
// `$defs.mediaKeyKind.enum` in schemas/config.v2.schema.json.
const _: fn(MediaKeyKind) = |k| match k {
    MediaKeyKind::PlayPause
    | MediaKeyKind::NextTrack
    | MediaKeyKind::PrevTrack
    | MediaKeyKind::Stop
    | MediaKeyKind::VolumeUp
    | MediaKeyKind::VolumeDown
    | MediaKeyKind::Mute => {}
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaKeyPayload {
    pub key: MediaKeyKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSwitchPayload {
    pub target_profile_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisabledActionPayload {}

/// Repair strategy for [`RepairClipboardActionPayload`]. Kept as a required field
/// (no `#[serde(default)]`) so the payload serializes as `{"strategy":"latin1"}`
/// and never collides with the empty `DisabledActionPayload` in the untagged
/// `ActionPayload` enum.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum RepairStrategy {
    /// Re-decode UTF-8 bytes that were read as Latin-1 (the OSC 52 terminal bug).
    #[default]
    Latin1,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepairClipboardActionPayload {
    pub strategy: RepairStrategy,
}

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

/// Migrate legacy clipboardPaste to sendText (avoids COM/OLE crashes).
fn migrate_paste_mode(config: &mut AppConfig) {
    for action in &mut config.actions {
        if let ActionPayload::TextSnippet(TextSnippetPayload::Inline { paste_mode, .. }) =
            &mut action.payload
            && *paste_mode == PasteMode::ClipboardPaste
        {
            *paste_mode = PasteMode::SendText;
        }
    }
    for snippet in &mut config.snippet_library {
        if snippet.paste_mode == PasteMode::ClipboardPaste {
            snippet.paste_mode = PasteMode::SendText;
        }
    }
}

pub fn load_or_initialize_config(
    config_dir: &Path,
) -> Result<LoadConfigResponse, ConfigStoreError> {
    fs::create_dir_all(config_dir).map_err(|error| io_error(Some(config_dir), error))?;

    let config_path = config_dir.join(CONFIG_FILE_NAME);

    if config_path.exists() {
        let mut config = read_config_from_path(&config_path)?;
        migrate_paste_mode(&mut config);
        let warnings = validate_config(&config)?;
        config.compile_title_regexes();

        // Mark the current config as last-known-good *after* it has loaded and
        // validated cleanly. Failure is non-fatal — log and continue.
        if let Err(err) = crate::backup::mark_last_known_good(config_dir) {
            log::warn!("[config] Failed to update last-known-good marker: {err}");
        }

        return Ok(LoadConfigResponse {
            config,
            warnings,
            path: path_string(&config_path),
            created_default: false,
        });
    }

    let mut config = default_seed_config();
    let warnings = validate_config(&config)?;
    config.compile_title_regexes();
    write_config_to_path(config_dir, &config)?;

    Ok(LoadConfigResponse {
        config,
        warnings,
        path: path_string(&config_path),
        created_default: true,
    })
}

/// A cheap content fingerprint of the on-disk `config.json`, used to detect
/// concurrent modification by another Sidearm instance before a blind
/// overwrite. Returns `None` when the file is absent or unreadable (treated as
/// "no conflict": the writer simply creates it).
// ponytail: DefaultHasher (non-crypto) is enough for change-detection — a hash
// collision merely misses one guard (degrades to the old overwrite behavior),
// it can never corrupt. Swap for an on-disk version field only if collisions
// ever actually matter.
pub fn config_file_stamp(config_dir: &Path) -> Option<u64> {
    let bytes = fs::read(config_dir.join(CONFIG_FILE_NAME)).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
}

/// Persist `config` to `config_dir`. When `expected_stamp` is `Some`, the save
/// is guarded against concurrent modification: if the on-disk file's current
/// fingerprint differs from `expected_stamp`, another instance wrote it since
/// the caller loaded it, so we return [`ConfigStoreError::ConcurrentModification`]
/// instead of clobbering those edits. Pass `None` to force an unconditional
/// overwrite (explicit restore/import/migration).
pub fn save_config(
    config_dir: &Path,
    config: AppConfig,
    expected_stamp: Option<u64>,
) -> Result<SaveConfigResponse, ConfigStoreError> {
    fs::create_dir_all(config_dir).map_err(|error| io_error(Some(config_dir), error))?;
    let schema_value = serde_json::to_value(&config)
        .map_err(|error| ConfigStoreError::Serialize(error.to_string()))?;
    validate_config_schema_value(&schema_value)?;
    let warnings = validate_config(&config)?;

    // Concurrency guard: refuse to overwrite if another instance changed the
    // file since the caller loaded it. Checked as late as possible (right
    // before the write) to keep the race window minimal; `None` opts out.
    if let Some(expected) = expected_stamp
        && let Some(current) = config_file_stamp(config_dir)
        && current != expected
    {
        return Err(ConfigStoreError::ConcurrentModification);
    }

    let backup_path = write_config_to_path(config_dir, &config)?;
    let config_path = config_dir.join(CONFIG_FILE_NAME);

    let mut config = config;
    config.compile_title_regexes();

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

/// Read an `AppConfig` from `config_path`, applying the same schema validation,
/// `paste_mode` migration, and title-regex compilation as the canonical loader.
/// Use this anywhere a config file is loaded outside `load_or_initialize_config`
/// (backup restore, full-config import) so those paths cannot skip migrations.
pub fn read_and_migrate_config_file(config_path: &Path) -> Result<AppConfig, ConfigStoreError> {
    let mut config = read_config_from_path(config_path)?;
    migrate_paste_mode(&mut config);
    config.compile_title_regexes();
    Ok(config)
}

/// Write `dst` atomically: create a temp file in `dst`'s directory, fill it via
/// `fill`, fsync, then rename over `dst`. A crash/IO error mid-write leaves `dst`
/// untouched. Shared skeleton for config saves and `lib::atomic_copy_file`.
pub(crate) fn persist_atomically(
    dst: &Path,
    fill: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let dir = dst.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination has no parent directory",
        )
    })?;
    let mut tmp = NamedTempFile::new_in(dir)?;
    fill(tmp.as_file_mut())?;
    tmp.as_file().sync_all()?;
    tmp.persist(dst).map_err(|e| e.error)?;
    Ok(())
}

fn write_config_to_path(
    config_dir: &Path,
    config: &AppConfig,
) -> Result<Option<PathBuf>, ConfigStoreError> {
    let config_path = config_dir.join(CONFIG_FILE_NAME);

    // Rotate .bak.N → .bak.N+1 and copy current config.json → .bak.1 before
    // overwriting. Returns the path to the just-created .bak.1 (or None if
    // there was no existing config to back up). Best-effort, like the daily
    // snapshot below: a transient lock on config.bak.1 (AV / indexer / another
    // process) must not block persisting the user's actual config changes.
    let backup_path = match crate::backup::rotate_rolling_backups(config_dir) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("[config] Failed to rotate rolling backup: {error}");
            None
        }
    };

    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| ConfigStoreError::Serialize(error.to_string()))?;

    persist_atomically(&config_path, |file| {
        file.write_all(serialized.as_bytes())?;
        file.write_all(b"\n")
    })
    .map_err(|error| ConfigStoreError::Io {
        path: Some(path_string(&config_path)),
        message: format!("Failed to write config atomically: {error}"),
    })?;

    // Daily snapshot — best-effort, never fails the save.
    if let Err(err) = crate::backup::write_daily_snapshot_and_prune(config_dir) {
        log::warn!("[config] Failed to write daily snapshot: {err}");
    }

    Ok(backup_path)
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

/// Validate a raw JSON value against the bundled config schema and return a
/// flat list of human-readable error strings. Non-fatal: callers decide what
/// to do with the errors.
pub fn collect_schema_errors(value: &Value) -> Vec<String> {
    match validate_config_schema_value(value) {
        Ok(()) => Vec::new(),
        Err(ConfigStoreError::SchemaViolation { errors }) => errors,
        Err(other) => vec![other.to_string()],
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
    if let Some(shortcut) = config
        .settings
        .global_shortcut
        .as_deref()
        .map(str::trim)
        .filter(|shortcut| !shortcut.is_empty())
        && shortcut
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .is_err()
    {
        errors.push(format!(
            "settings.globalShortcut `{shortcut}` is not a valid global shortcut."
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
            config,
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
        if !action_ids.contains(&binding.action_id) {
            errors.push(format!(
                "binding `{}` references missing action `{}`.",
                binding.id, binding.action_id
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

        // Warn when encoder mapping references a non-remappable control
        if let Some(ctrl) = config
            .physical_controls
            .iter()
            .find(|c| c.id == mapping.control_id)
            && !ctrl.remappable
        {
            warnings.push(ValidationWarning {
                code: "non_remappable_encoder_mapping".into(),
                message: format!(
                    "encoder mapping references non-remappable control `{}`",
                    mapping.control_id.as_str()
                ),
                path: Some(format!(
                    "encoderMappings.{}::{}",
                    mapping.control_id.as_str(),
                    mapping.layer.as_str()
                )),
                severity: ValidationSeverity::Warning,
            });
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
    config: &AppConfig,
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
            // Cap total step count so a malformed/malicious config can't block the
            // worker thread for hours. The executor already clamps per-step delay
            // (MAX_STEP_DELAY_MS) and repeat (MAX_STEP_REPEAT); this bounds the
            // multiplier those clamps sit inside. 200 steps * 30s max each is
            // already a pathological upper bound no legitimate macro approaches.
            const MAX_SEQUENCE_STEPS: usize = 200;
            if payload.steps.is_empty() {
                errors.push(format!(
                    "action `{}` sequence must contain at least one step.",
                    action.id
                ));
            } else if payload.steps.len() > MAX_SEQUENCE_STEPS {
                errors.push(format!(
                    "action `{}` sequence has {} steps; the maximum is {MAX_SEQUENCE_STEPS}.",
                    action.id,
                    payload.steps.len()
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
        // MouseAction and MediaKey use typed enums — serde validates values at deserialization.
        (ActionType::MouseAction, ActionPayload::MouseAction(_)) => {}
        (ActionType::MediaKey, ActionPayload::MediaKey(_)) => {}
        (ActionType::ProfileSwitch, ActionPayload::ProfileSwitch(payload)) => {
            if payload.target_profile_id.trim().is_empty() {
                errors.push(format!(
                    "action `{}` profileSwitch must specify a targetProfileId.",
                    action.id
                ));
            } else if !config
                .profiles
                .iter()
                .any(|p| p.id == payload.target_profile_id)
            {
                errors.push(format!(
                    "profileSwitch action `{}` references non-existent profile `{}`",
                    action.id, payload.target_profile_id
                ));
            }
        }
        (ActionType::Disabled, ActionPayload::Disabled(_)) => {}
        // RepairClipboard's payload carries only a typed `strategy` enum, which serde
        // validates at deserialization — no further semantic invariants to check.
        // (Audit F001: a missing arm here sent every repairClipboard action to the
        // catch-all below, so validate_config rejected save/load of any config using it.)
        (ActionType::RepairClipboard, ActionPayload::RepairClipboard(_)) => {}
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
            MenuItem::Action {
                id,
                action_id: referenced_id,
                ..
            } => {
                if !menu_item_ids.insert(id.clone()) {
                    errors.push(format!(
                        "menu action `{action_id}` contains duplicate menu item id `{id}`."
                    ));
                }
                if !action_ids.contains(referenced_id) {
                    errors.push(format!(
                        "menu action `{action_id}` references missing action `{referenced_id}`."
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
        MenuItem::Action { action_id, .. } => {
            if action_id == root_action_id {
                return true;
            }
            actions_by_id.get(action_id.as_str()).is_some_and(|_| {
                has_menu_cycle(root_action_id, action_id, actions_by_id, visited, stack)
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

    for (profile, layer, control, display_name, key, ctrl, shift, alt, win, raw) in [
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
            display_name,
            key,
            ctrl,
            shift,
            alt,
            win,
            raw,
        ));
    }

    for (profile, layer, control, display_name, snippet_id) in [
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
            display_name,
            snippet_id,
        ));
    }

    for (profile, layer, control, display_name, notes) in [
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb05,
            "Right Ctrl + Right Shift + -",
            "Unresolved exact semantics. Preserve as placeholder until device validation confirms whether this is a shortcut or text payload.",
        ),
        (
            "main",
            Layer::Hypershift,
            ControlId::Thumb09,
            "Copy without paragraphs",
            "Unresolved exact logic. Preserve as placeholder until the text or sequence behavior is confirmed.",
        ),
        (
            "code",
            Layer::Hypershift,
            ControlId::Thumb12,
            "Paste Win",
            "Unresolved exact intent. Preserve as placeholder until the real action is confirmed.",
        ),
    ] {
        actions.push(disabled_placeholder_action(
            action_id(profile, layer, control),
            display_name,
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
        compiled_title_regexes: Vec::new(),
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

#[allow(clippy::too_many_arguments)] // test helper mirroring a shortcut's fields
fn shortcut_action(
    id: String,
    display_name: &str,
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
        display_name: display_name.into(),
        notes: None,
        conditions: Vec::new(),
    }
}

fn text_snippet_library_action(id: String, display_name: &str, snippet_id: &str) -> Action {
    Action {
        id,
        action_type: ActionType::TextSnippet,
        payload: ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef {
            snippet_id: snippet_id.into(),
        }),
        display_name: display_name.into(),
        notes: None,
        conditions: Vec::new(),
    }
}

fn disabled_placeholder_action(id: String, display_name: &str, notes: &str) -> Action {
    Action {
        id,
        action_type: ActionType::Disabled,
        payload: ActionPayload::Disabled(DisabledActionPayload::default()),
        display_name: display_name.into(),
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
    action_id: String,
) -> Binding {
    Binding {
        id,
        profile_id: profile_id.into(),
        layer,
        control_id,
        label: label.into(),
        action_id,
        color_tag: None,
        trigger_mode: None,
        chord_partner: None,
        throttle_ms: None,
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
    fn repair_clipboard_payload_roundtrips_and_avoids_disabled_collision() {
        // The required `strategy` discriminator keeps the untagged ActionPayload
        // enum unambiguous: RepairClipboard serializes as {"strategy":"latin1"}.
        let payload = ActionPayload::RepairClipboard(RepairClipboardActionPayload {
            strategy: RepairStrategy::Latin1,
        });
        let json = serde_json::to_string(&payload).expect("serialize");
        assert_eq!(json, r#"{"strategy":"latin1"}"#);
        assert_eq!(
            serde_json::from_str::<ActionPayload>(&json).expect("roundtrip"),
            payload
        );
        // An empty payload still deserializes as Disabled, never RepairClipboard.
        assert_eq!(
            serde_json::from_str::<ActionPayload>("{}").expect("empty payload"),
            ActionPayload::Disabled(DisabledActionPayload {})
        );
    }

    #[test]
    fn sequence_step_repeat_is_optional_and_roundtrips() {
        // Backward compat: a step without `repeat` deserializes with repeat = None.
        let legacy: SequenceStep =
            serde_json::from_str(r#"{"type":"send","value":"Ctrl+C"}"#).expect("legacy send");
        assert!(matches!(legacy, SequenceStep::Send { repeat: None, .. }));

        // New `repeat` round-trips through serialization.
        let step = SequenceStep::Send {
            value: "Down".into(),
            delay_ms: Some(10),
            repeat: Some(5),
        };
        let json = serde_json::to_string(&step).expect("serialize");
        let back: SequenceStep = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(step, back);
    }

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
    fn repair_clipboard_action_is_schema_valid() {
        // Guard against the actionType-enum gap in config.v2.schema.json: a config
        // holding a repairClipboard action must pass JSON-schema validation (the
        // omission previously broke saving/exporting any profile using it).
        let mut config = default_seed_config();
        config.actions.push(Action {
            id: "repair-clipboard-test".into(),
            action_type: ActionType::RepairClipboard,
            payload: ActionPayload::RepairClipboard(RepairClipboardActionPayload {
                strategy: RepairStrategy::Latin1,
            }),
            display_name: "Repair clipboard".into(),
            notes: None,
            conditions: Vec::new(),
        });
        let value = serde_json::to_value(&config).expect("serialize config");
        let errors = collect_schema_errors(&value);
        assert!(
            errors.is_empty(),
            "repairClipboard action must be schema-valid: {errors:?}"
        );
    }

    #[test]
    fn repair_clipboard_action_with_bad_payload_is_schema_rejected() {
        // Audit F023: the schema gained an if/then branch + $defs entry for
        // repairClipboard so its payload is validated like the other action types
        // (not just the permissive base `payload: { "type": "object" }`). A
        // repairClipboard action whose payload is missing `strategy` or carries an
        // unknown strategy must now produce schema errors.
        let mut config = default_seed_config();
        config.actions.push(Action {
            id: "repair-clipboard-bad".into(),
            action_type: ActionType::RepairClipboard,
            payload: ActionPayload::RepairClipboard(RepairClipboardActionPayload {
                strategy: RepairStrategy::Latin1,
            }),
            display_name: "Repair clipboard".into(),
            notes: None,
            conditions: Vec::new(),
        });
        let mut value = serde_json::to_value(&config).expect("serialize config");

        // Find the freshly pushed action in the serialized JSON and corrupt its
        // payload, then assert the schema now rejects it.
        let actions = value
            .get_mut("actions")
            .and_then(|a| a.as_array_mut())
            .expect("actions array");
        let action = actions
            .iter_mut()
            .find(|a| a.get("id").and_then(Value::as_str) == Some("repair-clipboard-bad"))
            .expect("repair-clipboard-bad action present");

        // Unknown strategy → rejected (enum violation).
        action["payload"] = serde_json::json!({ "strategy": "rot13" });
        assert!(
            !collect_schema_errors(&value).is_empty(),
            "repairClipboard with an unknown strategy must be schema-rejected"
        );

        // Missing required `strategy` → rejected.
        let actions = value
            .get_mut("actions")
            .and_then(|a| a.as_array_mut())
            .expect("actions array");
        let action = actions
            .iter_mut()
            .find(|a| a.get("id").and_then(Value::as_str) == Some("repair-clipboard-bad"))
            .expect("repair-clipboard-bad action present");
        action["payload"] = serde_json::json!({});
        assert!(
            !collect_schema_errors(&value).is_empty(),
            "repairClipboard with no strategy must be schema-rejected"
        );
    }

    #[test]
    fn repair_clipboard_action_passes_semantic_validation() {
        // Audit F001 regression: validate_action lacked a RepairClipboard arm, so a
        // repairClipboard action fell through to the catch-all and validate_config
        // rejected it — breaking save/load of any config using it. The schema-only
        // test above did not cover the semantic (validate_config) path.
        let mut config = default_seed_config();
        config.actions.push(Action {
            id: "repair-clipboard-semantic".into(),
            action_type: ActionType::RepairClipboard,
            payload: ActionPayload::RepairClipboard(RepairClipboardActionPayload {
                strategy: RepairStrategy::Latin1,
            }),
            display_name: "Repair clipboard".into(),
            notes: None,
            conditions: Vec::new(),
        });
        validate_config(&config)
            .expect("repairClipboard action must pass semantic validation (validate_config)");
    }

    /// Regression: the Razer Synapse profile we ship for onboarding has the
    /// Naga side buttons 1–2 represented twice (`DKM_M_0X` and `KEY_X`), which
    /// previously produced duplicate (control, layer) bindings — schema-valid
    /// but rejected by `validate_config` on save. Importer dedup must keep the
    /// merged config valid.
    #[test]
    fn bundled_synapse_profile_imports_to_valid_config() {
        use std::io::Write;
        let base = default_seed_config();
        let dir = tempdir().expect("temp");
        let path = dir.path().join("p.synapse4");
        let bytes: &[u8] = include_bytes!("../resources/Sidearm_profile.synapse4");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        let parsed = crate::synapse_import::parse_synapse_source(&path).expect("parse");
        let opts = crate::synapse_import::ImportOptions {
            selected_profile_guids: None,
            merge_strategy: crate::synapse_import::MergeStrategy::ReplaceByName,
        };
        let result = crate::synapse_import::apply_parsed_into_config(base, parsed, &opts);
        let v = serde_json::to_value(&result.config).unwrap();
        assert!(
            collect_schema_errors(&v).is_empty(),
            "imported config must be schema-valid"
        );
        validate_config(&result.config)
            .expect("imported bundled profile must pass full validation (no duplicate tuples)");
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
    fn save_creates_rolling_backup_when_config_exists() {
        let temp_dir = tempdir().expect("temp dir");
        let first = load_or_initialize_config(temp_dir.path()).expect("seed load");

        let response =
            save_config(temp_dir.path(), first.config, None).expect("save should succeed");

        let bak1 = temp_dir.path().join("config.bak.1");
        assert_eq!(response.backup_path, Some(path_string(&bak1)));
        assert!(
            bak1.exists(),
            "rolling backup .bak.1 should exist after save"
        );
    }

    #[test]
    fn load_updates_last_known_good_marker() {
        let temp_dir = tempdir().expect("temp dir");
        // First load seeds a default config (no lkg marker yet because the
        // config file is created inside load, then loaded back on next call).
        let _seed = load_or_initialize_config(temp_dir.path()).expect("seed");
        // Second load reads the existing config → should update lkg.
        let _second = load_or_initialize_config(temp_dir.path()).expect("reload");
        assert!(
            temp_dir.path().join("config.last-known-good.json").exists(),
            "last-known-good marker should exist after successful load"
        );
    }

    #[test]
    fn daily_snapshot_written_on_save() {
        let temp_dir = tempdir().expect("temp dir");
        let first = load_or_initialize_config(temp_dir.path()).expect("seed");
        save_config(temp_dir.path(), first.config, None).expect("save");

        let snapshots_dir = temp_dir.path().join("snapshots");
        assert!(snapshots_dir.is_dir());
        let count = fs::read_dir(&snapshots_dir)
            .expect("read snapshots")
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
            .count();
        assert_eq!(count, 1, "exactly one snapshot after one save within a day");
    }

    #[test]
    fn save_rejects_schema_invalid_empty_binding_label() {
        let temp_dir = tempdir().expect("temp dir");
        let mut config = default_seed_config();
        config.bindings[0].label = String::new();

        let result = save_config(temp_dir.path(), config, None);

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

        let result = save_config(temp_dir.path(), config, None);

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

        let result = save_config(temp_dir.path(), config, None);

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
    fn save_with_stale_stamp_rejects_concurrent_overwrite() {
        let temp_dir = tempdir().expect("temp dir");
        let first = load_or_initialize_config(temp_dir.path()).expect("seed");
        // Baseline fingerprint after the seed write.
        let stamp = config_file_stamp(temp_dir.path()).expect("stamp exists");

        // Simulate ANOTHER instance writing the file (changes the on-disk bytes).
        let mut other = first.config.clone();
        other.settings.theme = "synapse-dark".into();
        save_config(temp_dir.path(), other, None).expect("other instance save");

        // Our save still carries the OLD stamp → must be refused, not clobber.
        let result = save_config(temp_dir.path(), first.config.clone(), Some(stamp));
        assert!(
            matches!(result, Err(ConfigStoreError::ConcurrentModification)),
            "stale-stamp save must be rejected, got {result:?}"
        );

        // The other instance's change survived (no clobber).
        let loaded = load_or_initialize_config(temp_dir.path()).expect("reload");
        assert_eq!(loaded.config.settings.theme, "synapse-dark");
    }

    #[test]
    fn save_with_matching_stamp_succeeds() {
        let temp_dir = tempdir().expect("temp dir");
        let first = load_or_initialize_config(temp_dir.path()).expect("seed");
        let stamp = config_file_stamp(temp_dir.path()).expect("stamp exists");
        // Matching stamp → no concurrent change → save proceeds.
        save_config(temp_dir.path(), first.config, Some(stamp)).expect("save should succeed");
    }

    #[test]
    fn save_and_load_preserves_trigger_mode() {
        let temp_dir = tempdir().expect("temp dir");
        let mut config = default_seed_config();
        config.bindings[0].trigger_mode = Some(TriggerMode::Hold);

        save_config(temp_dir.path(), config.clone(), None).expect("save should succeed");

        let loaded = load_or_initialize_config(temp_dir.path()).expect("load should succeed");
        assert_eq!(
            loaded.config.bindings[0].trigger_mode,
            Some(TriggerMode::Hold)
        );
        // Other bindings remain None
        assert_eq!(loaded.config.bindings[1].trigger_mode, None);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Property-based / edge-case tests
//
// Rules:
//  * No real FS access — all tests operate on pure in-memory transforms.
//  * Never edit production code or the `mod tests` above.
//  * `proptest!` macros follow the standard `proptest = "1"` idiom.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // ─── Helpers ────────────────────────────────────────────────────────────

    /// Build a minimal, self-consistent AppConfig that passes validate_config.
    /// Every collection references the single profile "p1" and the single
    /// physical-controls set that satisfies ALL 27 required controls.
    fn minimal_valid_config() -> AppConfig {
        let mut cfg = default_seed_config();
        // Strip everything down to one profile so our helpers stay small.
        // Keep the full physical_controls (required by validation) and
        // encoder_mappings.  Clear user-data-heavy tables.
        cfg.profiles = vec![Profile {
            id: "p1".into(),
            name: "Test".into(),
            description: None,
            enabled: true,
            priority: 0,
        }];
        cfg.settings.fallback_profile_id = "p1".into();
        cfg.app_mappings = vec![];
        cfg.bindings = vec![];
        cfg.actions = vec![];
        cfg.snippet_library = vec![];
        cfg
    }

    fn make_shortcut_action(id: &str) -> Action {
        Action {
            id: id.into(),
            action_type: ActionType::Shortcut,
            payload: ActionPayload::Shortcut(ShortcutActionPayload {
                key: "A".into(),
                ctrl: true,
                shift: false,
                alt: false,
                win: false,
                raw: None,
            }),
            display_name: id.into(),
            notes: None,
            conditions: vec![],
        }
    }

    fn make_binding(id: &str, action_id: &str) -> Binding {
        Binding {
            id: id.into(),
            profile_id: "p1".into(),
            layer: Layer::Standard,
            control_id: ControlId::Thumb01,
            label: "lbl".into(),
            action_id: action_id.into(),
            color_tag: None,
            trigger_mode: None,
            chord_partner: None,
            throttle_ms: None,
            enabled: true,
        }
    }

    // ─── Backward-compatible serde rename (v0.1.22) ──────────────────────────

    /// A config persisted by an OLDER Sidearm (pre-rename wire names `actionRef` /
    /// `pretty`) must still (a) pass JSON-schema validation, (b) deserialize via the
    /// serde aliases onto the renamed `action_id` / `display_name` fields with zero
    /// data loss, and (c) re-serialize under the NEW names — migrating the file on
    /// the next save. Guards existing user configs against breaking on upgrade.
    #[test]
    fn legacy_action_ref_and_pretty_names_still_load() {
        let config = default_seed_config();
        let modern = serde_json::to_string(&config).expect("serialize seed config");
        assert!(
            modern.contains("\"actionId\"") && modern.contains("\"displayName\""),
            "current version must write the new wire names"
        );

        // Rewrite the on-disk keys back to the pre-rename names. These keys only ever
        // name the renamed Binding/MenuItem/Action fields in a persisted AppConfig.
        let legacy = modern
            .replace("\"actionId\"", "\"actionRef\"")
            .replace("\"displayName\"", "\"pretty\"");
        let legacy_value: serde_json::Value =
            serde_json::from_str(&legacy).expect("legacy json parses");

        // (a) embedded JSON schema still accepts the legacy field names
        validate_config_schema_value(&legacy_value)
            .expect("legacy actionRef/pretty must pass schema validation");

        // (b) serde aliases map them onto the renamed fields with no data loss
        let loaded: AppConfig =
            serde_json::from_value(legacy_value).expect("legacy config must deserialize");
        assert_eq!(
            loaded.bindings, config.bindings,
            "binding.action_id preserved via alias"
        );
        assert_eq!(
            loaded.actions, config.actions,
            "action.display_name preserved via alias"
        );

        // (c) re-serialization migrates the file to the new names, dropping the old
        let migrated = serde_json::to_string(&loaded).expect("re-serialize");
        assert!(migrated.contains("\"actionId\"") && migrated.contains("\"displayName\""));
        assert!(
            !migrated.contains("\"actionRef\""),
            "legacy binding key must be dropped"
        );
        assert!(
            !migrated.contains("\"pretty\""),
            "legacy action key must be dropped"
        );
    }

    /// The optional `deviceName` / `globalShortcut` (Settings) and `throttleMs` (Binding) fields,
    /// added without a schema-version bump like every prior optional field, must
    /// survive the full save contract: serialize → JSON-schema validate →
    /// deserialize, values intact and new wire names present. Guards against a
    /// `deny_unknown_fields` / `additionalProperties:false` regression silently
    /// breaking save the moment a user sets either field.
    #[test]
    fn device_name_and_throttle_ms_survive_schema_roundtrip() {
        let mut config = default_seed_config();
        config.settings.device_name = Some("Razer Naga V2".into());
        config.settings.global_shortcut = Some("ctrl+shift+space".into());
        config
            .bindings
            .first_mut()
            .expect("seed config has at least one binding")
            .throttle_ms = Some(250);

        let json = serde_json::to_string(&config).expect("serialize");
        assert!(
            json.contains("\"deviceName\""),
            "deviceName must be written"
        );
        assert!(
            json.contains("\"globalShortcut\""),
            "globalShortcut must be written"
        );
        assert!(
            json.contains("\"throttleMs\""),
            "throttleMs must be written"
        );

        let value: serde_json::Value = serde_json::from_str(&json).expect("parse");
        validate_config_schema_value(&value)
            .expect("config with deviceName/globalShortcut/throttleMs must pass schema validation");

        let loaded: AppConfig = serde_json::from_value(value).expect("deserialize");
        assert_eq!(
            loaded.settings.device_name.as_deref(),
            Some("Razer Naga V2")
        );
        assert_eq!(
            loaded.settings.global_shortcut.as_deref(),
            Some("ctrl+shift+space")
        );
        assert_eq!(
            loaded.bindings.first().and_then(|b| b.throttle_ms),
            Some(250)
        );
    }

    // ─── Serialization round-trips ──────────────────────────────────────────

    /// Profile round-trips through JSON without any field loss.
    #[test]
    fn profile_json_roundtrip_deterministic() {
        let p = Profile {
            id: "x".into(),
            name: "X".into(),
            description: Some("desc".into()),
            enabled: false,
            priority: i32::MAX,
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    proptest! {
        /// Shortcut payload with arbitrary modifier combos round-trips.
        #[test]
        fn shortcut_payload_roundtrip(
            key in "[A-Za-z0-9]{1,8}",
            ctrl in any::<bool>(),
            shift in any::<bool>(),
            alt in any::<bool>(),
            win in any::<bool>(),
        ) {
            let p = ShortcutActionPayload { key, ctrl, shift, alt, win, raw: None };
            let json = serde_json::to_string(&p).unwrap();
            let back: ShortcutActionPayload = serde_json::from_str(&json).unwrap();
            prop_assert_eq!(p, back);
        }
    }

    proptest! {
        /// Binding round-trips across all TriggerMode variants and all ControlIds.
        #[test]
        fn binding_roundtrip(
            trigger_mode in prop_oneof![
                Just(None::<TriggerMode>),
                Just(Some(TriggerMode::Press)),
                Just(Some(TriggerMode::DoublePress)),
                Just(Some(TriggerMode::TriplePress)),
                Just(Some(TriggerMode::Hold)),
                Just(Some(TriggerMode::Chord)),
            ],
            layer in prop_oneof![Just(Layer::Standard), Just(Layer::Hypershift)],
        ) {
            let b = Binding {
                id: "b1".into(),
                profile_id: "p1".into(),
                layer,
                control_id: ControlId::Thumb01,
                label: "lbl".into(),
                action_id: "a1".into(),
                color_tag: None,
                trigger_mode,
                chord_partner: None,
                throttle_ms: None,
                enabled: true,
            };
            let json = serde_json::to_string(&b).unwrap();
            let back: Binding = serde_json::from_str(&json).unwrap();
            prop_assert_eq!(b, back);
        }
    }

    proptest! {
        /// TextSnippetPayload::Inline round-trips for both PasteMode variants.
        #[test]
        fn text_snippet_inline_roundtrip(
            text in ".{1,200}",
            paste_mode in prop_oneof![
                Just(PasteMode::ClipboardPaste),
                Just(PasteMode::SendText),
            ],
            tags in prop::collection::vec("[a-z]{1,10}", 0..5),
        ) {
            let p = TextSnippetPayload::Inline { text, paste_mode, tags };
            let json = serde_json::to_string(&p).unwrap();
            let back: TextSnippetPayload = serde_json::from_str(&json).unwrap();
            prop_assert_eq!(p, back);
        }
    }

    proptest! {
        /// SequenceStep::Sleep delay_ms round-trips for full u32 range.
        #[test]
        fn sequence_sleep_delay_roundtrip(delay_ms in any::<u32>()) {
            let step = SequenceStep::Sleep { delay_ms };
            let json = serde_json::to_string(&step).unwrap();
            let back: SequenceStep = serde_json::from_str(&json).unwrap();
            prop_assert_eq!(step, back);
        }
    }

    proptest! {
        /// SequenceStep::Send with optional delay and repeat round-trips.
        #[test]
        fn sequence_send_roundtrip(
            delay_ms in prop::option::of(any::<u32>()),
            repeat in prop::option::of(any::<u32>()),
        ) {
            let step = SequenceStep::Send {
                value: "Ctrl+C".into(),
                delay_ms,
                repeat,
            };
            let json = serde_json::to_string(&step).unwrap();
            let back: SequenceStep = serde_json::from_str(&json).unwrap();
            prop_assert_eq!(step, back);
        }
    }

    proptest! {
        /// Profile round-trips for a wide range of priority values including extremes.
        #[test]
        fn profile_priority_roundtrip(priority in any::<i32>()) {
            let p = Profile {
                id: "x".into(),
                name: "X".into(),
                description: None,
                enabled: true,
                priority,
            };
            let json = serde_json::to_string(&p).unwrap();
            let back: Profile = serde_json::from_str(&json).unwrap();
            prop_assert_eq!(p.priority, back.priority);
        }
    }

    proptest! {
        /// Settings optional u64 fields round-trip without clamping at the serde layer.
        #[test]
        fn settings_optional_u64_roundtrip(
            stale_gc in prop::option::of(any::<u64>()),
            force_release in prop::option::of(any::<u64>()),
        ) {
            let mut cfg = minimal_valid_config();
            cfg.settings.modifier_stale_gc_ms = stale_gc;
            cfg.settings.replayed_modifier_force_release_ms = force_release;
            let json = serde_json::to_string(&cfg.settings).unwrap();
            let back: Settings = serde_json::from_str(&json).unwrap();
            prop_assert_eq!(back.modifier_stale_gc_ms, stale_gc);
            prop_assert_eq!(back.replayed_modifier_force_release_ms, force_release);
        }
    }

    // ─── Boundary: numeric limits ────────────────────────────────────────────

    /// osd_duration_ms = 0 deserializes fine (serde does not clamp).
    #[test]
    fn osd_duration_zero_accepted_by_serde() {
        let json = r#"{"fallbackProfileId":"p","theme":"t","startWithWindows":false,
            "minimizeToTray":false,"debugLogging":false,"osdEnabled":false,
            "osdDurationMs":0,"osdPosition":"bottomRight","osdFontSize":"medium",
            "osdAnimation":"slideIn"}"#;
        let s: Settings = serde_json::from_str(json).expect("parse settings");
        assert_eq!(s.osd_duration_ms, 0);
    }

    /// osd_duration_ms = u32::MAX deserializes fine.
    #[test]
    fn osd_duration_max_accepted_by_serde() {
        let v = u32::MAX;
        let json = format!(
            r#"{{"fallbackProfileId":"p","theme":"t","startWithWindows":false,
            "minimizeToTray":false,"debugLogging":false,"osdEnabled":false,
            "osdDurationMs":{v},"osdPosition":"bottomRight","osdFontSize":"medium",
            "osdAnimation":"slideIn"}}"#
        );
        let s: Settings = serde_json::from_str(&json).expect("parse settings");
        assert_eq!(s.osd_duration_ms, v);
    }

    // ─── Boundary: empty / missing collections ───────────────────────────────

    /// validate_config with zero profiles → error (fallback profile missing).
    #[test]
    fn validation_empty_profiles_is_error() {
        let mut cfg = minimal_valid_config();
        cfg.profiles.clear();
        let result = validate_config(&cfg);
        assert!(result.is_err(), "empty profiles must fail validation");
    }

    /// validate_config with zero actions and zero bindings → valid (no cross-refs).
    #[test]
    fn validation_empty_actions_and_bindings_is_ok() {
        let cfg = minimal_valid_config();
        let result = validate_config(&cfg);
        assert!(
            result.is_ok(),
            "minimal config (no actions/bindings) must be valid"
        );
    }

    /// A single valid binding + action pair validates cleanly.
    #[test]
    fn validation_single_action_single_binding_ok() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![make_shortcut_action("a1")];
        cfg.bindings = vec![make_binding("b1", "a1")];
        assert!(validate_config(&cfg).is_ok());
    }

    fn make_sequence_action(id: &str, step_count: usize) -> Action {
        let mut action = make_shortcut_action(id);
        action.action_type = ActionType::Sequence;
        action.payload = ActionPayload::Sequence(SequenceActionPayload {
            steps: (0..step_count)
                .map(|_| SequenceStep::Sleep { delay_ms: 1 })
                .collect(),
        });
        action
    }

    /// C2: a Sequence with more than MAX_SEQUENCE_STEPS (200) is rejected so a
    /// malformed/malicious config can't block the worker thread indefinitely.
    #[test]
    fn validation_rejects_oversized_sequence() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![make_sequence_action("seq", 201)];
        assert!(
            validate_config(&cfg).is_err(),
            "sequence with >200 steps must be rejected"
        );
    }

    /// C2: exactly the cap (200 steps) is still accepted.
    #[test]
    fn validation_accepts_max_sequence_steps() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![make_sequence_action("seq", 200)];
        assert!(
            validate_config(&cfg).is_ok(),
            "sequence with exactly 200 steps must be accepted"
        );
    }

    // ─── Boundary: profile count ─────────────────────────────────────────────

    proptest! {
        /// N ≥ 1 distinct profiles all accepted by validation (fallback = first).
        #[test]
        fn validation_accepts_n_profiles(n in 1usize..=20) {
            let mut cfg = minimal_valid_config();
            cfg.profiles = (0..n)
                .map(|i| Profile {
                    id: format!("p{}", i),
                    name: format!("Profile {}", i),
                    description: None,
                    enabled: true,
                    priority: i as i32,
                })
                .collect();
            cfg.settings.fallback_profile_id = "p0".into();
            prop_assert!(validate_config(&cfg).is_ok());
        }
    }

    // ─── Null & empty: id fields ─────────────────────────────────────────────

    /// Profile with empty id is rejected by validate_config (not just schema).
    #[test]
    fn validation_rejects_empty_profile_id() {
        let mut cfg = minimal_valid_config();
        cfg.profiles[0].id = String::new();
        let result = validate_config(&cfg);
        assert!(result.is_err(), "empty profile id must be rejected");
    }

    /// Action with empty id is rejected.
    #[test]
    fn validation_rejects_empty_action_id() {
        let mut cfg = minimal_valid_config();
        let mut action = make_shortcut_action("");
        action.id = String::new();
        cfg.actions = vec![action];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "empty action id must be rejected");
    }

    /// Binding with empty id is rejected.
    #[test]
    fn validation_rejects_empty_binding_id() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![make_shortcut_action("a1")];
        let mut b = make_binding("", "a1");
        b.id = String::new();
        cfg.bindings = vec![b];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "empty binding id must be rejected");
    }

    /// Whitespace-only ids behave identically to empty ids.
    #[test]
    fn validation_rejects_whitespace_only_profile_id() {
        let mut cfg = minimal_valid_config();
        cfg.profiles[0].id = "   ".into();
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "whitespace-only profile id must be rejected"
        );
    }

    /// Snippet with blank text is rejected.
    #[test]
    fn validation_rejects_blank_snippet_text() {
        let mut cfg = minimal_valid_config();
        cfg.snippet_library = vec![SnippetLibraryItem {
            id: "s1".into(),
            name: "S".into(),
            text: "   ".into(),
            paste_mode: PasteMode::SendText,
            tags: vec![],
            notes: None,
        }];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "blank snippet text must be rejected");
    }

    /// AppMapping with blank exe is rejected.
    #[test]
    fn validation_rejects_blank_app_mapping_exe() {
        let mut cfg = minimal_valid_config();
        cfg.app_mappings = vec![AppMapping {
            id: "m1".into(),
            exe: "   ".into(),
            process_path: None,
            title_includes: vec![],
            profile_id: "p1".into(),
            enabled: true,
            priority: 0,
            compiled_title_regexes: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "blank exe must be rejected");
    }

    /// EncoderMapping with empty encoded_key is rejected.
    #[test]
    fn validation_rejects_empty_encoded_key() {
        let mut cfg = minimal_valid_config();
        cfg.encoder_mappings[0].encoded_key = String::new();
        let result = validate_config(&cfg);
        assert!(result.is_err(), "empty encoded_key must be rejected");
    }

    /// EncoderMapping with whitespace-only encoded_key is rejected.
    #[test]
    fn validation_rejects_whitespace_encoded_key() {
        let mut cfg = minimal_valid_config();
        cfg.encoder_mappings[0].encoded_key = "   ".into();
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "whitespace-only encoded_key must be rejected"
        );
    }

    // ─── Null & empty: serde defaults fill optional fields ───────────────────

    /// osd_enabled defaults to true when field is absent.
    #[test]
    fn settings_osd_enabled_defaults_to_true() {
        let json = r#"{"fallbackProfileId":"p","theme":"t","startWithWindows":false,
            "minimizeToTray":false,"debugLogging":false}"#;
        let s: Settings = serde_json::from_str(json).expect("parse");
        assert!(s.osd_enabled, "osd_enabled should default to true");
    }

    /// osd_duration_ms defaults to 2000 when field is absent.
    #[test]
    fn settings_osd_duration_defaults_to_2000() {
        let json = r#"{"fallbackProfileId":"p","theme":"t","startWithWindows":false,
            "minimizeToTray":false,"debugLogging":false}"#;
        let s: Settings = serde_json::from_str(json).expect("parse");
        assert_eq!(s.osd_duration_ms, 2000);
    }

    /// modifier_stale_gc_ms defaults to None (field is entirely optional).
    #[test]
    fn settings_modifier_stale_gc_ms_defaults_none() {
        let json = r#"{"fallbackProfileId":"p","theme":"t","startWithWindows":false,
            "minimizeToTray":false,"debugLogging":false}"#;
        let s: Settings = serde_json::from_str(json).expect("parse");
        assert_eq!(s.modifier_stale_gc_ms, None);
    }

    // ─── Overflow / duplicate-id handling ────────────────────────────────────

    /// Duplicate profile ids are detected.
    #[test]
    fn validation_rejects_duplicate_profile_ids() {
        let mut cfg = minimal_valid_config();
        // Add a second profile with the same id as the first.
        let dup = cfg.profiles[0].clone();
        cfg.profiles.push(dup);
        let result = validate_config(&cfg);
        assert!(result.is_err(), "duplicate profile ids must be rejected");
    }

    /// Duplicate action ids are detected.
    #[test]
    fn validation_rejects_duplicate_action_ids() {
        let mut cfg = minimal_valid_config();
        let a = make_shortcut_action("a1");
        cfg.actions = vec![a.clone(), a];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "duplicate action ids must be rejected");
    }

    /// Duplicate binding ids are detected.
    #[test]
    fn validation_rejects_duplicate_binding_ids() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![make_shortcut_action("a1")];
        let b = make_binding("b1", "a1");
        cfg.bindings = vec![b.clone(), b];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "duplicate binding ids must be rejected");
    }

    /// Duplicate (profile_id, control_id, layer) tuple in bindings is rejected.
    #[test]
    fn validation_rejects_duplicate_binding_tuple() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![make_shortcut_action("a1"), make_shortcut_action("a2")];
        // Two bindings with distinct ids but same tuple.
        let mut b2 = make_binding("b2", "a2");
        b2.id = "b2".into();
        cfg.bindings = vec![make_binding("b1", "a1"), b2];
        // Both use profile_id="p1", control_id=Thumb01, layer=Standard → duplicate tuple.
        let result = validate_config(&cfg);
        assert!(result.is_err(), "duplicate binding tuple must be rejected");
    }

    /// Duplicate encoder mapping (control_id, layer) is rejected.
    #[test]
    fn validation_rejects_duplicate_encoder_tuple() {
        let mut cfg = minimal_valid_config();
        let dup = cfg.encoder_mappings[0].clone();
        cfg.encoder_mappings.push(dup);
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "duplicate encoder mapping tuple must be rejected"
        );
    }

    proptest! {
        /// Very long strings in Profile.name do NOT crash validation (no length limit).
        #[test]
        fn long_profile_name_does_not_panic(len in 1usize..=8192) {
            let mut cfg = minimal_valid_config();
            cfg.profiles[0].name = "x".repeat(len);
            // Validation must not panic; whether it passes or fails is acceptable.
            let _ = validate_config(&cfg);
        }
    }

    proptest! {
        /// Very long strings in SnippetLibraryItem.text do NOT panic validation.
        #[test]
        fn long_snippet_text_does_not_panic(len in 1usize..=8192) {
            let mut cfg = minimal_valid_config();
            cfg.snippet_library = vec![SnippetLibraryItem {
                id: "s1".into(),
                name: "S".into(),
                text: "x".repeat(len),
                paste_mode: PasteMode::SendText,
                tags: vec![],
                notes: None,
            }];
            let _ = validate_config(&cfg);
        }
    }

    proptest! {
        /// N duplicate snippet ids: exactly one "duplicate id" error emitted per extra.
        #[test]
        fn duplicate_snippet_ids_n_times(n in 2usize..=10) {
            let mut cfg = minimal_valid_config();
            cfg.snippet_library = (0..n)
                .map(|_| SnippetLibraryItem {
                    id: "dup".into(),
                    name: "D".into(),
                    text: "hello".into(),
                    paste_mode: PasteMode::SendText,
                    tags: vec![],
                    notes: None,
                })
                .collect();
            let result = validate_config(&cfg);
            prop_assert!(result.is_err());
        }
    }

    // ─── Migration: migrate_paste_mode ───────────────────────────────────────

    /// migrate_paste_mode: ClipboardPaste in an inline action becomes SendText.
    #[test]
    fn migration_clipboard_paste_in_inline_action_becomes_send_text() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::TextSnippet,
            payload: ActionPayload::TextSnippet(TextSnippetPayload::Inline {
                text: "hello".into(),
                paste_mode: PasteMode::ClipboardPaste,
                tags: vec![],
            }),
            display_name: "a1".into(),
            notes: None,
            conditions: vec![],
        }];
        migrate_paste_mode(&mut cfg);
        match &cfg.actions[0].payload {
            ActionPayload::TextSnippet(TextSnippetPayload::Inline { paste_mode, .. }) => {
                assert_eq!(
                    *paste_mode,
                    PasteMode::SendText,
                    "should be migrated to SendText"
                );
            }
            _ => panic!("unexpected payload shape"),
        }
    }

    /// migrate_paste_mode: ClipboardPaste in snippet_library becomes SendText.
    #[test]
    fn migration_clipboard_paste_in_snippet_library_becomes_send_text() {
        let mut cfg = minimal_valid_config();
        cfg.snippet_library = vec![SnippetLibraryItem {
            id: "s1".into(),
            name: "S".into(),
            text: "hi".into(),
            paste_mode: PasteMode::ClipboardPaste,
            tags: vec![],
            notes: None,
        }];
        migrate_paste_mode(&mut cfg);
        assert_eq!(cfg.snippet_library[0].paste_mode, PasteMode::SendText);
    }

    /// migrate_paste_mode: SendText is NOT changed (already up-to-date).
    #[test]
    fn migration_send_text_unchanged() {
        let mut cfg = minimal_valid_config();
        cfg.snippet_library = vec![SnippetLibraryItem {
            id: "s1".into(),
            name: "S".into(),
            text: "hi".into(),
            paste_mode: PasteMode::SendText,
            tags: vec![],
            notes: None,
        }];
        migrate_paste_mode(&mut cfg);
        assert_eq!(cfg.snippet_library[0].paste_mode, PasteMode::SendText);
    }

    /// migrate_paste_mode idempotent: applying twice equals applying once.
    #[test]
    fn migration_idempotent_inline_action() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::TextSnippet,
            payload: ActionPayload::TextSnippet(TextSnippetPayload::Inline {
                text: "hello".into(),
                paste_mode: PasteMode::ClipboardPaste,
                tags: vec![],
            }),
            display_name: "a1".into(),
            notes: None,
            conditions: vec![],
        }];
        migrate_paste_mode(&mut cfg);
        let after_once = cfg.clone();
        migrate_paste_mode(&mut cfg);
        // Payload must be identical after a second application.
        match (&after_once.actions[0].payload, &cfg.actions[0].payload) {
            (
                ActionPayload::TextSnippet(TextSnippetPayload::Inline {
                    paste_mode: pm1, ..
                }),
                ActionPayload::TextSnippet(TextSnippetPayload::Inline {
                    paste_mode: pm2, ..
                }),
            ) => assert_eq!(pm1, pm2),
            _ => panic!("shape changed"),
        }
    }

    proptest! {
        /// migrate_paste_mode idempotent for N snippets with random paste modes.
        #[test]
        fn migration_idempotent_snippet_library(
            modes in prop::collection::vec(
                prop_oneof![Just(PasteMode::ClipboardPaste), Just(PasteMode::SendText)],
                1..=20,
            )
        ) {
            let mut cfg = minimal_valid_config();
            cfg.snippet_library = modes
                .iter()
                .enumerate()
                .map(|(i, &m)| SnippetLibraryItem {
                    id: format!("s{}", i),
                    name: format!("S{}", i),
                    text: "hi".into(),
                    paste_mode: m,
                    tags: vec![],
                    notes: None,
                })
                .collect();
            migrate_paste_mode(&mut cfg);
            let after_once = cfg.clone();
            migrate_paste_mode(&mut cfg);
            prop_assert_eq!(after_once.snippet_library, cfg.snippet_library);
        }
    }

    /// LibraryRef TextSnippetPayload is NOT touched by migration (no paste_mode field).
    #[test]
    fn migration_does_not_touch_library_ref_action() {
        let mut cfg = minimal_valid_config();
        cfg.snippet_library = vec![SnippetLibraryItem {
            id: "s1".into(),
            name: "S".into(),
            text: "hi".into(),
            paste_mode: PasteMode::SendText,
            tags: vec![],
            notes: None,
        }];
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::TextSnippet,
            payload: ActionPayload::TextSnippet(TextSnippetPayload::LibraryRef {
                snippet_id: "s1".into(),
            }),
            display_name: "a1".into(),
            notes: None,
            conditions: vec![],
        }];
        let before = cfg.actions[0].payload.clone();
        migrate_paste_mode(&mut cfg);
        assert_eq!(
            cfg.actions[0].payload, before,
            "LibraryRef should be untouched"
        );
    }

    // ─── Validation totality: never panics on adversarial input ──────────────

    proptest! {
        /// validate_config always returns Ok or Err, never panics, for
        /// configs with garbage string ids and a valid version number.
        #[test]
        fn validation_never_panics_garbage_ids(
            profile_id in "[a-z]{0,5}",
            action_id_str in "[a-z]{0,5}",
            binding_id_str in "[a-z]{0,5}",
        ) {
            let mut cfg = minimal_valid_config();
            if !profile_id.is_empty() {
                cfg.profiles[0].id = profile_id.clone();
                cfg.settings.fallback_profile_id = profile_id.clone();
            }
            if !action_id_str.is_empty() {
                let mut a = make_shortcut_action(&action_id_str);
                a.id = action_id_str.clone();
                cfg.actions = vec![a];
            }
            if !binding_id_str.is_empty() {
                let mut b = make_binding(&binding_id_str, &action_id_str);
                b.id = binding_id_str.clone();
                cfg.bindings = vec![b];
            }
            // Must not panic.
            let _ = validate_config(&cfg);
        }
    }

    proptest! {
        /// validate_config with wrong version always returns an error.
        #[test]
        fn validation_rejects_wrong_version(v in prop_oneof![
            Just(0i32),
            Just(1i32),
            Just(3i32),
            Just(i32::MAX),
            Just(i32::MIN),
        ]) {
            let mut cfg = minimal_valid_config();
            cfg.version = v;
            prop_assert!(validate_config(&cfg).is_err());
        }
    }

    // ─── Unknown-field tolerance via serde ───────────────────────────────────

    /// Profile (deny_unknown_fields) rejects extra JSON keys.
    #[test]
    fn profile_rejects_unknown_fields() {
        let json = r#"{"id":"x","name":"X","enabled":true,"priority":0,"unexpectedKey":true}"#;
        let result: Result<Profile, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "Profile has deny_unknown_fields — unknown key must be rejected"
        );
    }

    /// Binding (deny_unknown_fields) rejects extra JSON keys.
    #[test]
    fn binding_rejects_unknown_fields() {
        let json = r#"{
            "id":"b1","profileId":"p1","layer":"standard","controlId":"thumb_01",
            "label":"lbl","actionRef":"a1","enabled":true,"unknownField":42
        }"#;
        let result: Result<Binding, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "Binding has deny_unknown_fields — unknown key must be rejected"
        );
    }

    /// AppConfig (deny_unknown_fields) rejects extra top-level JSON keys.
    #[test]
    fn app_config_rejects_unknown_top_level_field() {
        // Build valid config JSON and inject a spurious top-level key.
        let cfg = minimal_valid_config();
        let mut v = serde_json::to_value(&cfg).unwrap();
        v["surpriseField"] = serde_json::json!("boom");
        let result: Result<AppConfig, _> = serde_json::from_value(v);
        assert!(
            result.is_err(),
            "AppConfig has deny_unknown_fields — unknown key must fail"
        );
    }

    // ─── Validation cross-references ─────────────────────────────────────────

    /// Binding referencing non-existent action is rejected.
    #[test]
    fn validation_rejects_binding_with_missing_action_ref() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![make_shortcut_action("a1")];
        let mut b = make_binding("b1", "does-not-exist");
        b.action_id = "does-not-exist".into();
        cfg.bindings = vec![b];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "missing action_id must be rejected");
    }

    /// Binding referencing non-existent profile is rejected.
    #[test]
    fn validation_rejects_binding_with_missing_profile_ref() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![make_shortcut_action("a1")];
        let mut b = make_binding("b1", "a1");
        b.profile_id = "no-such-profile".into();
        cfg.bindings = vec![b];
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "missing profile ref in binding must be rejected"
        );
    }

    /// ProfileSwitch action referencing non-existent profile is rejected.
    #[test]
    fn validation_rejects_profile_switch_with_missing_target() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::ProfileSwitch,
            payload: ActionPayload::ProfileSwitch(ProfileSwitchPayload {
                target_profile_id: "ghost-profile".into(),
            }),
            display_name: "switch".into(),
            notes: None,
            conditions: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "profileSwitch to non-existent profile must fail"
        );
    }

    /// ProfileSwitch with empty target_profile_id is rejected.
    #[test]
    fn validation_rejects_profile_switch_empty_target() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::ProfileSwitch,
            payload: ActionPayload::ProfileSwitch(ProfileSwitchPayload {
                target_profile_id: String::new(),
            }),
            display_name: "switch".into(),
            notes: None,
            conditions: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "empty profileSwitch target must fail");
    }

    /// AppMapping referencing non-existent profile is rejected.
    #[test]
    fn validation_rejects_app_mapping_with_missing_profile() {
        let mut cfg = minimal_valid_config();
        cfg.app_mappings = vec![AppMapping {
            id: "m1".into(),
            exe: "foo.exe".into(),
            process_path: None,
            title_includes: vec![],
            profile_id: "nonexistent".into(),
            enabled: true,
            priority: 0,
            compiled_title_regexes: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "app mapping with missing profile must fail"
        );
    }

    // ─── Validation: action type / payload mismatch ──────────────────────────

    /// Shortcut action type paired with MediaKey payload → mismatch error.
    /// (Tests the catch-all `_ =>` arm in validate_action.)
    #[test]
    fn validation_rejects_action_type_payload_mismatch() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::Shortcut, // type says Shortcut…
            payload: ActionPayload::MediaKey(MediaKeyPayload {
                // …but payload is MediaKey
                key: MediaKeyKind::PlayPause,
            }),
            display_name: "mismatch".into(),
            notes: None,
            conditions: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "type/payload mismatch must be rejected");
    }

    // ─── Validation: sequence & launch ───────────────────────────────────────

    /// Sequence action with zero steps is rejected.
    #[test]
    fn validation_rejects_sequence_with_no_steps() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::Sequence,
            payload: ActionPayload::Sequence(SequenceActionPayload { steps: vec![] }),
            display_name: "empty sequence".into(),
            notes: None,
            conditions: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "sequence with zero steps must fail");
    }

    /// Launch action with empty target is rejected.
    #[test]
    fn validation_rejects_launch_with_empty_target() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::Launch,
            payload: ActionPayload::Launch(LaunchActionPayload {
                target: String::new(),
                args: vec![],
                working_dir: None,
            }),
            display_name: "launch".into(),
            notes: None,
            conditions: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "launch with empty target must fail");
    }

    /// Launch action with whitespace-only target is rejected.
    #[test]
    fn validation_rejects_launch_with_whitespace_target() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![Action {
            id: "a1".into(),
            action_type: ActionType::Launch,
            payload: ActionPayload::Launch(LaunchActionPayload {
                target: "   ".into(),
                args: vec![],
                working_dir: None,
            }),
            display_name: "launch".into(),
            notes: None,
            conditions: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(result.is_err(), "whitespace launch target must fail");
    }

    #[test]
    fn validation_accepts_valid_global_shortcut() {
        let mut cfg = minimal_valid_config();
        cfg.settings.global_shortcut = Some("ctrl+shift+space".into());
        validate_config(&cfg).expect("valid global shortcut must pass");
    }

    #[test]
    fn validation_rejects_invalid_global_shortcut() {
        let mut cfg = minimal_valid_config();
        cfg.settings.global_shortcut = Some("ctrl+alt+".into());
        let result = validate_config(&cfg);
        assert!(result.is_err(), "invalid global shortcut must fail");
    }

    // ─── Validation: menu cycles ─────────────────────────────────────────────

    /// A menu action that directly references itself (via action_id == own id)
    /// must be detected as a cycle.
    /// NOTE: this is a SUSPECTED BUG test — see findings.
    #[test]
    fn validation_detects_menu_self_reference_cycle() {
        let mut cfg = minimal_valid_config();
        // menu action "m1" has a single menu item that points back to "m1".
        cfg.actions = vec![Action {
            id: "m1".into(),
            action_type: ActionType::Menu,
            payload: ActionPayload::Menu(MenuActionPayload {
                items: vec![MenuItem::Action {
                    id: "item1".into(),
                    label: "Self".into(),
                    action_id: "m1".into(), // self-reference
                    enabled: true,
                }],
            }),
            display_name: "menu".into(),
            notes: None,
            conditions: vec![],
        }];
        let result = validate_config(&cfg);
        // Expect a cycle error (or at minimum an error).
        assert!(
            result.is_err(),
            "menu self-reference must be detected as a cycle"
        );
    }

    /// Two menu actions that reference each other form an indirect cycle.
    #[test]
    fn validation_detects_menu_indirect_cycle() {
        let mut cfg = minimal_valid_config();
        cfg.actions = vec![
            Action {
                id: "m1".into(),
                action_type: ActionType::Menu,
                payload: ActionPayload::Menu(MenuActionPayload {
                    items: vec![MenuItem::Action {
                        id: "item-m1".into(),
                        label: "Go to m2".into(),
                        action_id: "m2".into(),
                        enabled: true,
                    }],
                }),
                display_name: "m1".into(),
                notes: None,
                conditions: vec![],
            },
            Action {
                id: "m2".into(),
                action_type: ActionType::Menu,
                payload: ActionPayload::Menu(MenuActionPayload {
                    items: vec![MenuItem::Action {
                        id: "item-m2".into(),
                        label: "Go to m1".into(),
                        action_id: "m1".into(), // cycle: m2 → m1
                        enabled: true,
                    }],
                }),
                display_name: "m2".into(),
                notes: None,
                conditions: vec![],
            },
        ];
        // Cycle should be detected for at least one of the two menus.
        let result = validate_config(&cfg);
        assert!(result.is_err(), "mutual menu cycle must be detected");
    }

    // ─── Validation: AppMapping title_includes edge cases ────────────────────

    /// AppMapping with an empty string in title_includes is rejected.
    #[test]
    fn validation_rejects_empty_title_includes_entry() {
        let mut cfg = minimal_valid_config();
        cfg.app_mappings = vec![AppMapping {
            id: "m1".into(),
            exe: "foo.exe".into(),
            process_path: None,
            title_includes: vec!["".into()],
            profile_id: "p1".into(),
            enabled: true,
            priority: 0,
            compiled_title_regexes: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "empty titleIncludes entry must be rejected"
        );
    }

    /// AppMapping with a whitespace-only title_includes entry is rejected.
    #[test]
    fn validation_rejects_whitespace_title_includes_entry() {
        let mut cfg = minimal_valid_config();
        cfg.app_mappings = vec![AppMapping {
            id: "m1".into(),
            exe: "foo.exe".into(),
            process_path: None,
            title_includes: vec!["   ".into()],
            profile_id: "p1".into(),
            enabled: true,
            priority: 0,
            compiled_title_regexes: vec![],
        }];
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "whitespace titleIncludes entry must be rejected"
        );
    }

    /// Duplicate title_includes entries emit a warning (not an error).
    #[test]
    fn validation_warns_on_duplicate_title_includes() {
        let mut cfg = minimal_valid_config();
        cfg.app_mappings = vec![AppMapping {
            id: "m1".into(),
            exe: "foo.exe".into(),
            process_path: None,
            title_includes: vec!["Chrome".into(), "Chrome".into()],
            profile_id: "p1".into(),
            enabled: true,
            priority: 0,
            compiled_title_regexes: vec![],
        }];
        let result = validate_config(&cfg);
        match result {
            Ok(warnings) => assert!(
                warnings.iter().any(|w| w.code == "duplicate_title_filter"),
                "expected duplicate_title_filter warning"
            ),
            Err(e) => panic!("expected Ok(warnings), got Err: {e:?}"),
        }
    }

    // ─── Validation: disabled fallback profile warning ────────────────────────

    /// A disabled fallback profile emits a warning, not an error.
    #[test]
    fn validation_warns_when_fallback_profile_is_disabled() {
        let mut cfg = minimal_valid_config();
        cfg.profiles[0].enabled = false;
        let result = validate_config(&cfg);
        match result {
            Ok(warnings) => assert!(
                warnings
                    .iter()
                    .any(|w| w.code == "disabled_fallback_profile"),
                "expected disabled_fallback_profile warning"
            ),
            Err(e) => panic!("expected Ok(warnings) for disabled fallback, got Err: {e:?}"),
        }
    }

    // ─── Serialization: ControlId as_str == JSON repr ────────────────────────

    /// ControlId::as_str() must exactly match the JSON serde rename for every variant.
    /// This property guards against drift between `as_str` and `#[serde(rename)]`.
    #[test]
    fn control_id_as_str_matches_serde_rename() {
        for id in ControlId::ALL {
            let json = serde_json::to_string(&id).expect("serialize ControlId");
            // JSON wraps strings in quotes.
            let expected_json = format!("\"{}\"", id.as_str());
            assert_eq!(
                json,
                expected_json,
                "ControlId::{id:?} as_str() `{}` does not match serde JSON `{json}`",
                id.as_str()
            );
        }
    }

    /// ActionType (Rust) and `$defs.actionType.enum` in config.v2.schema.json must
    /// list the SAME set. The schema is the contract a saved config is validated
    /// against; a variant in one but not the other is a save-breaker (this is how
    /// `repairClipboard` once broke saving). The per-variant tests above only cover
    /// known cases — this closes the whole class against a future added/renamed type.
    #[test]
    fn action_type_set_matches_schema_enum() {
        let schema: Value = serde_json::from_str(CONFIG_SCHEMA_JSON).expect("schema is valid JSON");
        let schema_enum: std::collections::BTreeSet<&str> = schema["$defs"]["actionType"]["enum"]
            .as_array()
            .expect("$defs.actionType.enum is an array")
            .iter()
            .map(|v| v.as_str().expect("actionType.enum values are strings"))
            .collect();
        let rust: std::collections::BTreeSet<&str> =
            ActionType::ALL.iter().map(|a| a.as_str()).collect();
        assert_eq!(
            rust, schema_enum,
            "ActionType (Rust) and config.v2.schema.json $defs.actionType.enum drifted apart"
        );
    }

    /// MouseActionKind (Rust) and `$defs.mouseActionKind.enum` must list the SAME
    /// set — the sibling of `action_type_set_matches_schema_enum`. The schema `$ref`
    /// from `mouseActionPayload.action` validates a saved value against this enum, and
    /// the FE `MOUSE_ACTION_OPTIONS` derives from `Record<MouseActionKind>`, so the
    /// three layers cannot drift. Strings come from serde (the wire SoT), not a
    /// hand-written `as_str`, so serde stays the single source of the wire name.
    #[test]
    fn mouse_action_kind_set_matches_schema_enum() {
        let schema: Value = serde_json::from_str(CONFIG_SCHEMA_JSON).expect("schema is valid JSON");
        let schema_enum: std::collections::BTreeSet<String> =
            schema["$defs"]["mouseActionKind"]["enum"]
                .as_array()
                .expect("$defs.mouseActionKind.enum is an array")
                .iter()
                .map(|v| {
                    v.as_str()
                        .expect("mouseActionKind.enum values are strings")
                        .to_string()
                })
                .collect();
        let rust: std::collections::BTreeSet<String> = MouseActionKind::ALL
            .iter()
            .map(|k| {
                serde_json::to_value(k)
                    .expect("serialize MouseActionKind")
                    .as_str()
                    .expect("MouseActionKind serializes to a string")
                    .to_string()
            })
            .collect();
        assert_eq!(
            rust, schema_enum,
            "MouseActionKind (Rust) and config.v2.schema.json $defs.mouseActionKind.enum drifted apart"
        );
    }

    /// MediaKeyKind (Rust) and `$defs.mediaKeyKind.enum` must list the SAME set — the
    /// sibling of `action_type_set_matches_schema_enum`. Same three-layer arrangement
    /// as `mouse_action_kind_set_matches_schema_enum` above.
    #[test]
    fn media_key_kind_set_matches_schema_enum() {
        let schema: Value = serde_json::from_str(CONFIG_SCHEMA_JSON).expect("schema is valid JSON");
        let schema_enum: std::collections::BTreeSet<String> =
            schema["$defs"]["mediaKeyKind"]["enum"]
                .as_array()
                .expect("$defs.mediaKeyKind.enum is an array")
                .iter()
                .map(|v| {
                    v.as_str()
                        .expect("mediaKeyKind.enum values are strings")
                        .to_string()
                })
                .collect();
        let rust: std::collections::BTreeSet<String> = MediaKeyKind::ALL
            .iter()
            .map(|k| {
                serde_json::to_value(k)
                    .expect("serialize MediaKeyKind")
                    .as_str()
                    .expect("MediaKeyKind serializes to a string")
                    .to_string()
            })
            .collect();
        assert_eq!(
            rust, schema_enum,
            "MediaKeyKind (Rust) and config.v2.schema.json $defs.mediaKeyKind.enum drifted apart"
        );
    }

    /// Layer::as_str() must match its serde JSON representation.
    #[test]
    fn layer_as_str_matches_serde_rename() {
        for layer in [Layer::Standard, Layer::Hypershift] {
            let json = serde_json::to_string(&layer).expect("serialize Layer");
            let expected_json = format!("\"{}\"", layer.as_str());
            assert_eq!(
                json,
                expected_json,
                "Layer::{layer:?} as_str() `{}` does not match serde JSON `{json}`",
                layer.as_str()
            );
        }
    }

    // ─── Overflow: physical_controls missing required entries ─────────────────

    /// Missing any single required control triggers a validation error.
    #[test]
    fn validation_rejects_each_missing_required_control() {
        for removed in ControlId::ALL {
            let mut cfg = minimal_valid_config();
            cfg.physical_controls.retain(|c| c.id != removed);
            let result = validate_config(&cfg);
            assert!(
                result.is_err(),
                "removing control {:?} should fail validation",
                removed
            );
        }
    }

    /// Duplicate physical controls (same ControlId) are rejected.
    #[test]
    fn validation_rejects_duplicate_physical_controls() {
        let mut cfg = minimal_valid_config();
        let dup = cfg.physical_controls[0].clone();
        cfg.physical_controls.push(dup);
        let result = validate_config(&cfg);
        assert!(
            result.is_err(),
            "duplicate physical control must be rejected"
        );
    }

    // ─── Concurrency: N/A justification ──────────────────────────────────────
    // config_schema_validator() uses OnceLock (std, not once_cell), which provides
    // safe single-init-many-readers semantics.  The only "shared state" is the
    // compiled Validator, which is read-only after init.  There is no mutable
    // shared state in the pure validation/migration paths, so concurrency races
    // on config data structures cannot occur without an external mutex that lives
    // outside this file.  Concurrency tests are therefore N/A.

    // ─── Snapshot: default_seed_config is stable ─────────────────────────────

    /// default_seed_config serializes to valid JSON and roundtrips to an equal value.
    #[test]
    fn default_seed_config_json_roundtrip() {
        let cfg = default_seed_config();
        let json = serde_json::to_string_pretty(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            cfg, back,
            "default seed config must survive a JSON roundtrip unchanged"
        );
    }

    /// Deserializing default seed JSON again produces equal AppConfig.
    #[test]
    fn default_seed_config_deterministic() {
        let cfg1 = default_seed_config();
        let cfg2 = default_seed_config();
        assert_eq!(cfg1, cfg2, "default_seed_config must be deterministic");
    }

    // ─── collect_schema_errors: non-panicking public surface ─────────────────

    /// collect_schema_errors on a valid config returns empty vec.
    #[test]
    fn collect_schema_errors_empty_for_valid_config() {
        let cfg = default_seed_config();
        let v = serde_json::to_value(&cfg).unwrap();
        let errs = collect_schema_errors(&v);
        assert!(
            errs.is_empty(),
            "expected no schema errors for default config, got {errs:?}"
        );
    }

    /// collect_schema_errors on a null value returns at least one error (not a panic).
    #[test]
    fn collect_schema_errors_null_value_does_not_panic() {
        let errs = collect_schema_errors(&serde_json::Value::Null);
        assert!(!errs.is_empty(), "null value must produce schema errors");
    }

    /// collect_schema_errors on empty object returns at least one error.
    #[test]
    fn collect_schema_errors_empty_object_produces_errors() {
        let errs = collect_schema_errors(&serde_json::json!({}));
        assert!(!errs.is_empty(), "empty object must produce schema errors");
    }
}
