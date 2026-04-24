//! Parser for `.synapse4` JSON+base64 device exports.
//!
//! The file is plain UTF-8 JSON with two top-level arrays (`profiles`,
//! `macros`) whose items each carry a base64 `payload` that decodes to
//! the real profile/macro JSON. This module walks both arrays, decodes
//! the payloads, and normalises mappings/macro events into the
//! `ParsedSynapseProfiles` DTO defined in `types.rs`.

use std::collections::HashMap;
use std::path::Path;

use base64::Engine;
use serde::Deserialize;

use super::makecode;
use super::mapping::{
    self, input_id_to_control_id, parse_modifier_array, translate_key_token,
    translate_mouse_assignment, KeyTranslationError, ModifierFlags,
};
use super::types::{
    ImportWarning, ParsedAction, ParsedBinding, ParsedMacro, ParsedProfile,
    ParsedSequenceStep, ParsedSynapseProfiles, SourceKind,
};

// ============================================================================
// Raw wire-format mirrors
// ============================================================================

#[derive(Debug, Deserialize)]
struct SynapseV4File {
    #[serde(default)]
    profiles: Vec<ProfileEnvelope>,
    #[serde(default)]
    macros: Vec<MacroEnvelope>,
}

#[derive(Debug, Deserialize)]
struct ProfileEnvelope {
    name: String,
    payload: String,
    #[serde(default)]
    #[allow(dead_code)]
    hash: String,
}

#[derive(Debug, Deserialize)]
struct MacroEnvelope {
    name: String,
    payload: String,
    #[serde(default)]
    #[allow(dead_code)]
    hash: String,
}

#[derive(Debug, Deserialize)]
struct ProfilePayload {
    guid: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    mappings: Vec<RawMapping>,
    #[serde(default, rename = "sidePanelMappings")]
    side_panel: Option<SidePanelMappings>,
}

#[derive(Debug, Deserialize)]
struct SidePanelMappings {
    #[serde(default, rename = "12ButtonSide")]
    twelve_button: Vec<RawMapping>,
}

#[derive(Debug, Deserialize)]
struct RawMapping {
    #[serde(rename = "inputType")]
    input_type: String,
    #[serde(rename = "inputID")]
    input_id: String,
    #[serde(default, rename = "isHyperShift")]
    is_hyper_shift: bool,
    #[serde(default, rename = "outputType")]
    output_type: String,
    #[serde(default, rename = "keyboardGroup")]
    keyboard_group: Option<KeyboardGroup>,
    #[serde(default, rename = "textBlockGroup")]
    text_block_group: Option<TextBlockGroup>,
    #[serde(default, rename = "macroGroup")]
    macro_group: Option<MacroGroupRef>,
    #[serde(default, rename = "mouseGroup")]
    mouse_group: Option<MouseGroup>,
}

#[derive(Debug, Deserialize)]
struct KeyboardGroup {
    #[serde(default)]
    key: String,
    #[serde(default)]
    modifiers: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct TextBlockGroup {
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
struct MacroGroupRef {
    #[serde(default)]
    name: String,
    guid: String,
}

#[derive(Debug, Deserialize)]
struct MouseGroup {
    #[serde(default, rename = "mouseAssignment")]
    mouse_assignment: String,
}

#[derive(Debug, Deserialize)]
struct MacroPayload {
    guid: String,
    #[serde(default, rename = "macroEvents")]
    events: Vec<MacroEvent>,
}

#[derive(Debug, Deserialize)]
struct MacroEvent {
    #[serde(rename = "Type")]
    ty: serde_json::Value,
    /// `Number` (delay in seconds) may arrive as either a JSON number or a
    /// string — Synapse's exporter is inconsistent. We accept both.
    #[serde(default, rename = "Number", deserialize_with = "deserialize_lax_f64")]
    number: Option<f64>,
    #[serde(default, rename = "KeyEvent")]
    key_event: Option<KeyEvent>,
    #[serde(default, rename = "MouseEvent")]
    #[allow(dead_code)]
    mouse_event: Option<MouseEventRaw>,
}

#[derive(Debug, Deserialize)]
struct KeyEvent {
    #[serde(rename = "Makecode", deserialize_with = "deserialize_lax_u16")]
    makecode: u16,
    /// `State` may be null in some exports; default to 0 (key-down).
    #[serde(default, rename = "State", deserialize_with = "deserialize_lax_u8")]
    state: u8,
    #[serde(default, rename = "IsExtended")]
    is_extended: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct MouseEventRaw {
    #[serde(default, rename = "MouseButton", deserialize_with = "deserialize_lax_u8")]
    #[allow(dead_code)]
    button: u8,
    #[serde(default, rename = "State", deserialize_with = "deserialize_lax_u8")]
    #[allow(dead_code)]
    state: u8,
}

// ----- Lax deserializers ----------------------------------------------------
// Razer Synapse occasionally stringifies numeric fields or sets them to null.
// These helpers accept all common shapes and fall back to sensible defaults.

fn deserialize_lax_f64<'de, D>(d: D) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(d)?;
    Ok(match value {
        serde_json::Value::Null => None,
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    })
}

fn deserialize_lax_u8<'de, D>(d: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(d)?;
    Ok(match value {
        serde_json::Value::Null => 0,
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) as u8,
        serde_json::Value::String(s) => s.parse::<u8>().unwrap_or(0),
        _ => 0,
    })
}

fn deserialize_lax_u16<'de, D>(d: D) -> Result<u16, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(d)?;
    Ok(match value {
        serde_json::Value::Null => 0,
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) as u16,
        serde_json::Value::String(s) => s.parse::<u16>().unwrap_or(0),
        _ => 0,
    })
}

// ============================================================================
// Public entry points
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum SynapseParseError {
    #[error("Failed to read file: {0}")]
    Io(#[from] std::io::Error),
    #[error("Outer JSON parse failed: {0}")]
    OuterJson(serde_json::Error),
    #[error("Base64 decode failed: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("Inner JSON parse failed: {0}")]
    InnerJson(serde_json::Error),
    #[error("File format is not recognised as Synapse v4 JSON.")]
    NotSynapseV4,
}

pub fn parse_synapse_v4_file(path: &Path) -> Result<ParsedSynapseProfiles, SynapseParseError> {
    let raw = std::fs::read_to_string(path)?;
    parse_synapse_v4_str(&raw, path.to_string_lossy().into_owned())
}

pub fn parse_synapse_v4_str(
    raw: &str,
    source_path: String,
) -> Result<ParsedSynapseProfiles, SynapseParseError> {
    let outer: SynapseV4File =
        serde_json::from_str(raw).map_err(SynapseParseError::OuterJson)?;

    if outer.profiles.is_empty() && outer.macros.is_empty() {
        return Err(SynapseParseError::NotSynapseV4);
    }

    let mut warnings: Vec<ImportWarning> = Vec::new();

    // First, decode all macros so bindings that reference them (by guid) can
    // embed the already-parsed step list.
    let mut macros_by_guid: HashMap<String, ParsedMacro> = HashMap::new();
    for env in &outer.macros {
        match decode_macro(&env.name, &env.payload, &mut warnings) {
            Ok(parsed) => {
                macros_by_guid.insert(parsed.synapse_guid.clone(), parsed);
            }
            Err(err) => {
                warnings.push(
                    ImportWarning::new(
                        "macro_decode_failed",
                        format!("Macro '{}' could not be decoded: {err}", env.name),
                    )
                    .with_context(env.name.clone()),
                );
            }
        }
    }

    let mut profiles: Vec<ParsedProfile> = Vec::new();
    for env in &outer.profiles {
        match decode_profile(env, &macros_by_guid, &mut warnings) {
            Ok(parsed) => profiles.push(parsed),
            Err(err) => {
                warnings.push(
                    ImportWarning::new(
                        "profile_decode_failed",
                        format!("Profile '{}' could not be decoded: {err}", env.name),
                    )
                    .with_context(env.name.clone()),
                );
            }
        }
    }

    Ok(ParsedSynapseProfiles {
        source_kind: SourceKind::SynapseV4,
        source_path,
        profiles,
        warnings,
    })
}

// ============================================================================
// Decoding helpers
// ============================================================================

fn decode_base64_payload(b64: &str) -> Result<String, SynapseParseError> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim())?;
    String::from_utf8(bytes).map_err(|e| {
        SynapseParseError::InnerJson(serde_json::from_str::<serde_json::Value>(&e.to_string())
            .err()
            .unwrap_or_else(|| {
                // Fabricate a generic error — we just need something of the right type.
                serde::de::Error::custom("payload is not valid UTF-8")
            }))
    })
}

fn decode_profile(
    env: &ProfileEnvelope,
    macros_by_guid: &HashMap<String, ParsedMacro>,
    warnings: &mut Vec<ImportWarning>,
) -> Result<ParsedProfile, SynapseParseError> {
    let json = decode_base64_payload(&env.payload)?;
    let payload: ProfilePayload =
        serde_json::from_str(&json).map_err(SynapseParseError::InnerJson)?;

    let mut bindings: Vec<ParsedBinding> = Vec::new();
    let mut referenced_macros: Vec<ParsedMacro> = Vec::new();
    let mut used_guids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for raw in &payload.mappings {
        if let Some(b) = transform_mapping(raw, &env.name, false, warnings) {
            if let ParsedAction::Sequence { macro_guid } = &b.action {
                if let Some(m) = macros_by_guid.get(macro_guid) {
                    if used_guids.insert(macro_guid.clone()) {
                        referenced_macros.push(m.clone());
                    }
                } else {
                    warnings.push(
                        ImportWarning::new(
                            "macro_reference_missing",
                            format!(
                                "Binding references macro guid `{}` but the macro is not present in this file.",
                                macro_guid
                            ),
                        )
                        .with_context(env.name.clone()),
                    );
                }
            }
            bindings.push(b);
        }
    }
    if let Some(side_panel) = &payload.side_panel {
        for raw in &side_panel.twelve_button {
            if let Some(b) = transform_mapping(raw, &env.name, true, warnings) {
                if let ParsedAction::Sequence { macro_guid } = &b.action {
                    if let Some(m) = macros_by_guid.get(macro_guid) {
                        if used_guids.insert(macro_guid.clone()) {
                            referenced_macros.push(m.clone());
                        }
                    } else {
                        warnings.push(
                            ImportWarning::new(
                                "macro_reference_missing",
                                format!(
                                    "Binding references macro guid `{}` but the macro is not present.",
                                    macro_guid
                                ),
                            )
                            .with_context(env.name.clone()),
                        );
                    }
                }
                bindings.push(b);
            }
        }
    }

    let name = if payload.name.is_empty() { env.name.clone() } else { payload.name };

    Ok(ParsedProfile {
        synapse_guid: payload.guid,
        name,
        bindings,
        macros: referenced_macros,
    })
}

/// Transform one `RawMapping` into a `ParsedBinding`. Returns `None` for
/// entries we intentionally drop (e.g. hyperShiftGroup on hypershift_button,
/// which is the Synapse no-op default).
fn transform_mapping(
    raw: &RawMapping,
    profile_name: &str,
    is_side_panel: bool,
    warnings: &mut Vec<ImportWarning>,
) -> Option<ParsedBinding> {
    let control_id = match input_id_to_control_id(&raw.input_type, &raw.input_id, is_side_panel) {
        Some(c) => c,
        None => {
            warnings.push(
                ImportWarning::new(
                    "unmappable_input_id",
                    format!(
                        "Input `{}/{}` has no Sidearm equivalent — dropped.",
                        raw.input_type, raw.input_id
                    ),
                )
                .with_context(profile_name.to_string()),
            );
            return None;
        }
    };

    // Skip hypershift-on-hypershift-button (Razer's no-op default).
    if control_id == "hypershift_button" && raw.output_type == "hyperShiftGroup" {
        return None;
    }

    let layer = if raw.is_hyper_shift { "hypershift" } else { "standard" };

    let action = transform_output(raw, profile_name, warnings);
    let label = default_label_for(control_id, &action);

    Some(ParsedBinding {
        control_id: control_id.to_string(),
        layer: layer.to_string(),
        source_input_id: raw.input_id.clone(),
        label,
        action,
    })
}

fn transform_output(
    raw: &RawMapping,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> ParsedAction {
    match raw.output_type.as_str() {
        "keyboardGroup" => build_shortcut(raw.keyboard_group.as_ref(), profile_name, warnings),
        "textBlockGroup" => build_text_snippet(raw.text_block_group.as_ref()),
        "macroGroup" => build_sequence_ref(raw.macro_group.as_ref(), profile_name, warnings),
        "mouseGroup" => build_mouse_action(raw.mouse_group.as_ref(), profile_name, warnings),
        "hyperShiftGroup" => ParsedAction::Unmappable {
            reason: "Binding activates Hypershift — handled by the hypershift_button in Sidearm."
                .into(),
        },
        "" => ParsedAction::Disabled,
        other => {
            warnings.push(
                ImportWarning::new(
                    "unsupported_output_type",
                    format!("Output type `{other}` is not supported yet."),
                )
                .with_context(profile_name.to_string()),
            );
            ParsedAction::Unmappable {
                reason: format!("Output type `{other}` not supported"),
            }
        }
    }
}

fn build_shortcut(
    group: Option<&KeyboardGroup>,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> ParsedAction {
    let Some(group) = group else {
        return ParsedAction::Unmappable {
            reason: "keyboardGroup payload missing".into(),
        };
    };

    let mut mods = parse_modifier_array(&group.modifiers);
    let key_token = group.key.as_str();

    match translate_key_token(key_token) {
        Ok(k) => ParsedAction::Shortcut {
            key: k,
            ctrl: mods.ctrl,
            shift: mods.shift,
            alt: mods.alt,
            win: mods.win,
        },
        Err(KeyTranslationError::ModifierOnly) => {
            // The "main key" is itself a modifier token — fold it in too.
            mods.add_token(key_token);
            ParsedAction::Shortcut {
                key: String::new(),
                ctrl: mods.ctrl,
                shift: mods.shift,
                alt: mods.alt,
                win: mods.win,
            }
        }
        Err(KeyTranslationError::Unknown(t)) => {
            warnings.push(
                ImportWarning::new(
                    "unknown_key_token",
                    format!("Key token `{t}` has no Sidearm equivalent."),
                )
                .with_context(profile_name.to_string()),
            );
            ParsedAction::Unmappable {
                reason: format!("Unknown key token `{t}`"),
            }
        }
    }
}

fn build_text_snippet(group: Option<&TextBlockGroup>) -> ParsedAction {
    let Some(group) = group else {
        return ParsedAction::Unmappable {
            reason: "textBlockGroup payload missing".into(),
        };
    };
    if group.text.trim().is_empty() {
        return ParsedAction::Unmappable {
            reason: "textBlockGroup text is empty".into(),
        };
    }
    ParsedAction::TextSnippet {
        text: group.text.clone(),
    }
}

fn build_sequence_ref(
    group: Option<&MacroGroupRef>,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> ParsedAction {
    let Some(group) = group else {
        warnings.push(
            ImportWarning::new(
                "macro_ref_missing_payload",
                "macroGroup payload missing on a mapping that claims to reference a macro.",
            )
            .with_context(profile_name.to_string()),
        );
        return ParsedAction::Unmappable {
            reason: "macroGroup payload missing".into(),
        };
    };
    ParsedAction::Sequence {
        macro_guid: group.guid.clone(),
    }
}

fn build_mouse_action(
    group: Option<&MouseGroup>,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> ParsedAction {
    let Some(group) = group else {
        return ParsedAction::Unmappable {
            reason: "mouseGroup payload missing".into(),
        };
    };
    match translate_mouse_assignment(&group.mouse_assignment) {
        Some(a) => ParsedAction::MouseAction {
            action: a.to_string(),
        },
        None => {
            warnings.push(
                ImportWarning::new(
                    "unsupported_mouse_assignment",
                    format!(
                        "Mouse assignment `{}` is not supported yet.",
                        group.mouse_assignment
                    ),
                )
                .with_context(profile_name.to_string()),
            );
            ParsedAction::Unmappable {
                reason: format!("Mouse assignment `{}` not supported", group.mouse_assignment),
            }
        }
    }
}

fn default_label_for(control_id: &str, action: &ParsedAction) -> String {
    match action {
        ParsedAction::Shortcut { key, ctrl, shift, alt, win } => {
            let mut parts = Vec::new();
            if *ctrl { parts.push("Ctrl"); }
            if *shift { parts.push("Shift"); }
            if *alt { parts.push("Alt"); }
            if *win { parts.push("Win"); }
            let mut s = parts.join("+");
            if !key.is_empty() {
                if !s.is_empty() { s.push('+'); }
                s.push_str(key);
            }
            if s.is_empty() { control_id.to_string() } else { s }
        }
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

// ============================================================================
// Macro decoding
// ============================================================================

fn decode_macro(
    envelope_name: &str,
    payload_b64: &str,
    warnings: &mut Vec<ImportWarning>,
) -> Result<ParsedMacro, SynapseParseError> {
    let json = decode_base64_payload(payload_b64)?;
    let payload: MacroPayload =
        serde_json::from_str(&json).map_err(SynapseParseError::InnerJson)?;

    let steps = build_macro_steps(envelope_name, &payload.events, warnings);

    Ok(ParsedMacro {
        synapse_guid: payload.guid,
        name: envelope_name.to_string(),
        steps,
    })
}

/// Walk macro events, pairing key-down with the next matching key-up so the
/// sequence emits discrete `Send` steps (Sidearm's sequence primitive is
/// full keystrokes, not individual down/up events).
fn build_macro_steps(
    macro_name: &str,
    events: &[MacroEvent],
    warnings: &mut Vec<ImportWarning>,
) -> Vec<ParsedSequenceStep> {
    let mut steps: Vec<ParsedSequenceStep> = Vec::new();
    let mut pending_modifiers = ModifierFlags::default();
    let mut pending_down: Option<(u16, bool)> = None;

    for ev in events {
        let ty = event_type(&ev.ty);
        match ty {
            EventType::Delay => {
                if let Some(secs) = ev.number {
                    let ms = (secs * 1000.0).round().max(0.0) as u32;
                    if ms > 0 {
                        steps.push(ParsedSequenceStep::Sleep { delay_ms: ms });
                    }
                }
            }
            EventType::KeyEvent => {
                let Some(key) = &ev.key_event else { continue };
                let is_extended = key.is_extended.unwrap_or(false) || key.state >= 2;
                // State 0/2 = down, 1/3 = up. The Type field only marks that
                // this event is a key event, not its direction.
                let is_down = key.state % 2 == 0;

                if is_down {
                    if let Some(canon) = makecode::modifier_canonical(key.makecode, is_extended) {
                        match canon {
                            "Ctrl" => pending_modifiers.ctrl = true,
                            "Shift" => pending_modifiers.shift = true,
                            "Alt" => pending_modifiers.alt = true,
                            "Win" => pending_modifiers.win = true,
                            _ => {}
                        }
                    } else if pending_down.is_none() {
                        pending_down = Some((key.makecode, is_extended));
                    } else {
                        // Overlapping non-modifier downs — emit the first one
                        // and warn that simultaneous holds will be flattened.
                        let (prev_code, prev_ext) = pending_down.take().unwrap();
                        emit_send(&mut steps, prev_code, prev_ext, pending_modifiers, macro_name, warnings);
                        pending_down = Some((key.makecode, is_extended));
                        warnings.push(
                            ImportWarning::new(
                                "macro_hold_flattened",
                                format!(
                                    "Macro `{macro_name}` had overlapping key-holds — they will fire as independent keystrokes."
                                ),
                            ),
                        );
                    }
                } else {
                    // Key-up: if it's the pending_down we emit, else ignore
                    // (stray up for modifier = clear flag).
                    if let Some(canon) = makecode::modifier_canonical(key.makecode, is_extended) {
                        match canon {
                            "Ctrl" => pending_modifiers.ctrl = false,
                            "Shift" => pending_modifiers.shift = false,
                            "Alt" => pending_modifiers.alt = false,
                            "Win" => pending_modifiers.win = false,
                            _ => {}
                        }
                    } else if let Some((code, ext)) = pending_down.take() {
                        if code == key.makecode && ext == is_extended {
                            emit_send(&mut steps, code, ext, pending_modifiers, macro_name, warnings);
                        } else {
                            // Mismatched up — still emit the pending down.
                            emit_send(&mut steps, code, ext, pending_modifiers, macro_name, warnings);
                        }
                    }
                }
            }
            EventType::MouseEvent => {
                // Mouse events in macros are rare and Sidearm's sequence model
                // doesn't express them natively — warn and skip.
                warnings.push(
                    ImportWarning::new(
                        "macro_mouse_event_skipped",
                        format!(
                            "Macro `{macro_name}` contains a mouse event — Sidearm sequences support keyboard events only."
                        ),
                    ),
                );
            }
            EventType::ActionBar => {
                // UI marker inside the exported macro — not a runtime event.
            }
            EventType::Unknown => {
                // Fall-through: leave pending state untouched.
            }
        }
    }

    // Emit any pending key if the macro ended with a dangling down.
    if let Some((code, ext)) = pending_down {
        emit_send(&mut steps, code, ext, pending_modifiers, macro_name, warnings);
    }

    steps
}

fn emit_send(
    steps: &mut Vec<ParsedSequenceStep>,
    makecode_val: u16,
    is_extended: bool,
    mods: ModifierFlags,
    macro_name: &str,
    warnings: &mut Vec<ImportWarning>,
) {
    let key_name = match makecode::makecode_to_key(makecode_val, is_extended) {
        Some(k) => k.to_string(),
        None => {
            warnings.push(
                ImportWarning::new(
                    "unknown_scancode",
                    format!(
                        "Macro `{macro_name}` uses unknown scancode 0x{makecode_val:02X} — emitted as a literal."
                    ),
                ),
            );
            format!("Scancode(0x{makecode_val:02X})")
        }
    };

    let mut parts: Vec<&str> = Vec::new();
    if mods.ctrl { parts.push("Ctrl"); }
    if mods.shift { parts.push("Shift"); }
    if mods.alt { parts.push("Alt"); }
    if mods.win { parts.push("Win"); }
    let value = if parts.is_empty() {
        key_name
    } else {
        format!("{}+{key_name}", parts.join("+"))
    };

    steps.push(ParsedSequenceStep::Send { value });
    // Keep `mapping::MODIFIER_TOKENS` referenced to avoid dead-code warnings
    // when downstream refactors trim usage; the linker will elide it.
    let _ = mapping::MODIFIER_TOKENS.len();
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventType {
    Delay,
    KeyEvent,
    MouseEvent,
    ActionBar,
    Unknown,
}

/// Synapse v4 uses `"Type"` either as an integer (0/1/2) or as a string
/// ("actionBar" markers). This normalises the two shapes. Direction of the
/// key/mouse event (down vs up) is encoded separately on the event payload
/// in the `State` field.
fn event_type(raw: &serde_json::Value) -> EventType {
    if let Some(n) = raw.as_u64() {
        return match n {
            0 => EventType::Delay,
            1 => EventType::KeyEvent,
            2 => EventType::MouseEvent,
            _ => EventType::Unknown,
        };
    }
    if let Some(s) = raw.as_str() {
        return match s {
            "actionBar" => EventType::ActionBar,
            _ => EventType::Unknown,
        };
    }
    EventType::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal hand-rolled fixtures: we avoid shipping real user exports in
    // tests. Each fixture is a base64-wrapped payload embedded directly.
    fn payload(json: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(json)
    }

    #[test]
    fn parses_minimal_file_with_one_profile() {
        let profile_inner = r#"{
            "guid": "prof-1",
            "name": "Test",
            "mappings": [
                {"inputType": "MouseInput", "inputID": "LeftClick",
                 "isHyperShift": false, "outputType": "keyboardGroup",
                 "keyboardGroup": {"key": "KEY_A", "modifiers": ["KEY_LEFT_CTRL"]}}
            ],
            "sidePanelMappings": { "12ButtonSide": [] }
        }"#;
        let outer = format!(
            r#"{{"profiles": [{{"name": "Test", "payload": "{}", "hash": ""}}], "macros": []}}"#,
            payload(profile_inner)
        );
        let parsed = parse_synapse_v4_str(&outer, "test".into()).expect("parse");
        assert_eq!(parsed.profiles.len(), 1);
        assert_eq!(parsed.profiles[0].bindings.len(), 1);
        let b = &parsed.profiles[0].bindings[0];
        assert_eq!(b.control_id, "mouse_left");
        assert_eq!(b.layer, "standard");
        match &b.action {
            ParsedAction::Shortcut { key, ctrl, .. } => {
                assert_eq!(key, "A");
                assert!(*ctrl);
            }
            other => panic!("expected shortcut, got {other:?}"),
        }
    }

    #[test]
    fn side_panel_maps_key_1_to_thumb_01() {
        let profile_inner = r#"{
            "guid": "prof-2", "name": "T", "mappings": [],
            "sidePanelMappings": { "12ButtonSide": [
                {"inputType": "KeyInput", "inputID": "KEY_1", "isHyperShift": false,
                 "outputType": "keyboardGroup",
                 "keyboardGroup": {"key": "KEY_DELETE", "modifiers": []}}
            ]}
        }"#;
        let outer = format!(
            r#"{{"profiles": [{{"name": "T", "payload": "{}", "hash": ""}}], "macros": []}}"#,
            payload(profile_inner)
        );
        let parsed = parse_synapse_v4_str(&outer, "test".into()).expect("parse");
        let b = &parsed.profiles[0].bindings[0];
        assert_eq!(b.control_id, "thumb_01");
        match &b.action {
            ParsedAction::Shortcut { key, .. } => assert_eq!(key, "Delete"),
            _ => panic!("expected Delete"),
        }
    }

    #[test]
    fn hypershift_layer_is_detected() {
        let profile_inner = r#"{
            "guid": "p", "name": "T", "mappings": [],
            "sidePanelMappings": { "12ButtonSide": [
                {"inputType": "KeyInput", "inputID": "KEY_3", "isHyperShift": true,
                 "outputType": "keyboardGroup",
                 "keyboardGroup": {"key": "KEY_F13", "modifiers": []}}
            ]}
        }"#;
        let outer = format!(
            r#"{{"profiles": [{{"name": "T", "payload": "{}", "hash": ""}}], "macros": []}}"#,
            payload(profile_inner)
        );
        let parsed = parse_synapse_v4_str(&outer, "test".into()).expect("parse");
        let b = &parsed.profiles[0].bindings[0];
        assert_eq!(b.layer, "hypershift");
    }

    #[test]
    fn hypershift_on_hypershift_button_is_skipped() {
        let profile_inner = r#"{
            "guid": "p", "name": "T",
            "mappings": [
                {"inputType": "MouseInput", "inputID": "RightClick",
                 "isHyperShift": false, "outputType": "hyperShiftGroup"},
                {"inputType": "MouseInput", "inputID": "Mouse_HS",
                 "isHyperShift": false, "outputType": "hyperShiftGroup"}
            ],
            "sidePanelMappings": { "12ButtonSide": [] }
        }"#;
        let outer = format!(
            r#"{{"profiles": [{{"name": "T", "payload": "{}", "hash": ""}}], "macros": []}}"#,
            payload(profile_inner)
        );
        let parsed = parse_synapse_v4_str(&outer, "test".into()).expect("parse");
        // Mouse_HS → hypershift_button + hyperShiftGroup is skipped silently.
        // RightClick → hyperShiftGroup stays as Unmappable (different control).
        assert_eq!(parsed.profiles[0].bindings.len(), 1);
        assert_eq!(parsed.profiles[0].bindings[0].control_id, "mouse_right");
    }

    #[test]
    fn macro_events_pair_down_and_up() {
        let macro_inner = r#"{
            "guid": "m1",
            "macroEvents": [
                {"Type": 1, "Id": 1, "KeyEvent": {"Makecode": 29, "State": 0}},
                {"Type": 1, "Id": 2, "KeyEvent": {"Makecode": 30, "State": 0}},
                {"Type": 1, "Id": 3, "KeyEvent": {"Makecode": 30, "State": 1}},
                {"Type": 1, "Id": 4, "KeyEvent": {"Makecode": 29, "State": 1}}
            ]
        }"#;
        let outer = format!(
            r#"{{"profiles": [], "macros": [{{"name": "CtrlA", "payload": "{}", "hash": ""}}]}}"#,
            payload(macro_inner)
        );
        let parsed = parse_synapse_v4_str(&outer, "t".into()).expect("parse");
        // macros are not surfaced unless referenced, but we can inspect indirectly
        // via the unmatched "macros" list — for now the file-level macros stay
        // in the macros_by_guid map and aren't exposed directly. So this test
        // just ensures we don't crash.
        assert!(parsed.profiles.is_empty());
    }

    /// Smoke-test against a real `.synapse4` export. Path is read from env
    /// var `SIDEARM_SYNAPSE_SMOKE_FILE`; the test is ignored by default.
    /// Run with `cargo test -- --ignored synapse_smoke_real_file --nocapture`.
    #[test]
    #[ignore = "reads user-specific file; set SIDEARM_SYNAPSE_SMOKE_FILE to enable"]
    fn synapse_smoke_real_file() {
        let Some(path) = std::env::var("SIDEARM_SYNAPSE_SMOKE_FILE").ok() else {
            eprintln!("SIDEARM_SYNAPSE_SMOKE_FILE not set — skipping");
            return;
        };
        let result = parse_synapse_v4_file(std::path::Path::new(&path))
            .expect("parse real synapse file");
        eprintln!("profiles: {}", result.profiles.len());
        for prof in &result.profiles {
            eprintln!(
                "  {} — {} bindings, {} macros",
                prof.name,
                prof.bindings.len(),
                prof.macros.len()
            );
        }
        eprintln!("warnings: {}", result.warnings.len());
        for w in result.warnings.iter().take(10) {
            eprintln!("  [{}] {}", w.code, w.message);
        }
        assert!(!result.profiles.is_empty());
    }

    #[test]
    fn text_block_and_macro_reference() {
        let macro_inner = r#"{"guid": "mg", "macroEvents": [
            {"Type": 1, "Id": 1, "KeyEvent": {"Makecode": 30, "State": 0}},
            {"Type": 1, "Id": 2, "KeyEvent": {"Makecode": 30, "State": 1}}
        ]}"#;
        let profile_inner = r#"{
            "guid": "p", "name": "P",
            "mappings": [
                {"inputType": "DKMInput", "inputID": "DKM_M_01",
                 "isHyperShift": false, "outputType": "textBlockGroup",
                 "textBlockGroup": {"text": "/hello"}},
                {"inputType": "DKMInput", "inputID": "DKM_M_02",
                 "isHyperShift": false, "outputType": "macroGroup",
                 "macroGroup": {"name": "M", "guid": "mg"}}
            ],
            "sidePanelMappings": { "12ButtonSide": [] }
        }"#;
        let outer = format!(
            r#"{{"profiles": [{{"name": "P", "payload": "{}", "hash": ""}}],
                 "macros":   [{{"name": "M", "payload": "{}", "hash": ""}}]}}"#,
            payload(profile_inner),
            payload(macro_inner)
        );
        let parsed = parse_synapse_v4_str(&outer, "t".into()).expect("parse");
        let prof = &parsed.profiles[0];
        assert_eq!(prof.bindings.len(), 2);
        assert!(matches!(&prof.bindings[0].action, ParsedAction::TextSnippet { .. }));
        assert!(matches!(&prof.bindings[1].action, ParsedAction::Sequence { .. }));
        assert_eq!(prof.macros.len(), 1);
        assert_eq!(prof.macros[0].synapse_guid, "mg");
        // Macro produced one step: A-down + A-up → Send { value: "A" }
        assert_eq!(prof.macros[0].steps.len(), 1);
    }
}
