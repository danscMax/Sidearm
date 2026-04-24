//! Parser for legacy `.synapse3` exports (ZIP of XML files).
//!
//! Archive layout (validated against real Razer Naga V2 HyperSpeed exports):
//! ```text
//! DeviceInfo.xml                                   ← product / vendor IDs
//! Profiles/{profileGuid}.xml                       ← profile name + GUID
//! Features/{profileGuid}/{featureGuid}.xml         ← per-feature config
//!                                                    (biggest one is mappings)
//! Macros/{macroGuid}.xml                           ← shared macro bodies
//! ```
//!
//! We extract profile names and their mapping set from the feature files,
//! decoding `<Mapping>` blocks into the same `ParsedBinding` shape used by
//! `format_v4`, and convert `Macros/*.xml` into `ParsedMacro` sequences via
//! the modifier-folding logic used elsewhere in this module.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use super::makecode;
use super::mapping::{
    self, input_id_to_control_id, parse_modifier_array, parse_modifier_string,
    translate_key_token, translate_mouse_assignment, vk_to_key, KeyTranslationError,
    ModifierFlags,
};
use super::types::{
    ImportWarning, ParsedAction, ParsedBinding, ParsedMacro, ParsedProfile,
    ParsedSequenceStep, ParsedSynapseProfiles, SourceKind,
};

#[derive(Debug, thiserror::Error)]
pub enum SynapseV3Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("XML error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("Not a Razer Synapse v3 archive (no DeviceInfo.xml or Profiles/ folder).")]
    NotSynapseV3,
}

pub fn parse_synapse_v3_file(path: &Path) -> Result<ParsedSynapseProfiles, SynapseV3Error> {
    let file = std::fs::File::open(path)?;
    parse_synapse_v3_reader(file, path.to_string_lossy().into_owned())
}

pub fn parse_synapse_v3_reader<R: Read + std::io::Seek>(
    reader: R,
    source_path: String,
) -> Result<ParsedSynapseProfiles, SynapseV3Error> {
    let mut archive = zip::ZipArchive::new(reader)?;
    let mut warnings: Vec<ImportWarning> = Vec::new();

    // Collect ZIP entries up-front (names + indices) — we need random access
    // by path pattern and ZipArchive borrows mutably on read.
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();

    if !names.iter().any(|n| n.ends_with("DeviceInfo.xml"))
        && !names.iter().any(|n| n.starts_with("Profiles/"))
    {
        return Err(SynapseV3Error::NotSynapseV3);
    }

    // 1. Macros pool — read first so bindings can reference by GUID.
    let mut macros_by_guid: HashMap<String, ParsedMacro> = HashMap::new();
    for name in &names {
        if name.starts_with("Macros/") && name.ends_with(".xml") {
            let raw = read_file(&mut archive, name)?;
            match parse_v3_macro(&raw, &mut warnings) {
                Ok(m) => {
                    macros_by_guid.insert(m.synapse_guid.clone(), m);
                }
                Err(e) => warnings.push(
                    ImportWarning::new(
                        "v3_macro_parse_failed",
                        format!("Could not parse macro `{name}`: {e}"),
                    )
                    .with_context(name.clone()),
                ),
            }
        }
    }

    // 2. Profiles — one XML per profile with guid + name.
    let mut profiles: Vec<ParsedProfile> = Vec::new();
    for name in &names {
        if name.starts_with("Profiles/") && name.ends_with(".xml") {
            let raw = read_file(&mut archive, name)?;
            match parse_v3_profile_meta(&raw) {
                Ok((guid, pname)) => {
                    let bindings = collect_profile_bindings(
                        &mut archive,
                        &names,
                        &guid,
                        &macros_by_guid,
                        &pname,
                        &mut warnings,
                    );
                    let referenced_macros = collect_referenced_macros(&bindings, &macros_by_guid);
                    profiles.push(ParsedProfile {
                        synapse_guid: guid,
                        name: pname,
                        bindings,
                        macros: referenced_macros,
                    });
                }
                Err(e) => warnings.push(
                    ImportWarning::new(
                        "v3_profile_parse_failed",
                        format!("Could not parse profile `{name}`: {e}"),
                    )
                    .with_context(name.clone()),
                ),
            }
        }
    }

    Ok(ParsedSynapseProfiles {
        source_kind: SourceKind::SynapseV4, // reusing the same wire tag for simplicity
        source_path,
        profiles,
        warnings,
    })
}

// ============================================================================
// Per-profile binding collection
// ============================================================================

fn collect_profile_bindings<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    names: &[String],
    profile_guid: &str,
    macros_by_guid: &HashMap<String, ParsedMacro>,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> Vec<ParsedBinding> {
    let mut bindings = Vec::new();
    let prefix = format!("Features/{profile_guid}/");
    let feature_names: Vec<String> = names
        .iter()
        .filter(|n| n.starts_with(&prefix) && n.ends_with(".xml"))
        .cloned()
        .collect();

    for feature_name in feature_names {
        let raw = match read_file(archive, &feature_name) {
            Ok(r) => r,
            Err(e) => {
                warnings.push(
                    ImportWarning::new(
                        "v3_feature_read_failed",
                        format!("Could not read feature `{feature_name}`: {e}"),
                    )
                    .with_context(profile_name.to_string()),
                );
                continue;
            }
        };
        // Only feature files that contain a <Mappings> root carry bindings.
        if !raw.contains("<Mappings") {
            continue;
        }
        if let Err(e) = parse_v3_mapping_list(
            &raw,
            macros_by_guid,
            profile_name,
            &mut bindings,
            warnings,
        ) {
            warnings.push(
                ImportWarning::new(
                    "v3_mappings_parse_failed",
                    format!("Mapping XML parse failed: {e}"),
                )
                .with_context(profile_name.to_string()),
            );
        }
    }

    bindings
}

fn collect_referenced_macros(
    bindings: &[ParsedBinding],
    macros_by_guid: &HashMap<String, ParsedMacro>,
) -> Vec<ParsedMacro> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<ParsedMacro> = Vec::new();
    for b in bindings {
        if let ParsedAction::Sequence { macro_guid } = &b.action {
            if seen.insert(macro_guid.clone()) {
                if let Some(m) = macros_by_guid.get(macro_guid) {
                    out.push(m.clone());
                }
            }
        }
    }
    out
}

// ============================================================================
// Mapping XML parser (hand-rolled, quick-xml event stream)
// ============================================================================

#[derive(Default)]
struct MappingBuilder {
    is_hypershift: bool,
    input_type: String,
    mouse_input: String,
    dkm_input: String,
    key_hid_page: Option<u16>,
    key_hid_id: Option<u16>,
    // Output-shape fields:
    key_scancode: Option<u16>,
    key_vk: Option<u16>,
    key_modifier: String,
    mouse_assignment: String,
    macro_guid: String,
    output_group: OutputGroup,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum OutputGroup {
    #[default]
    None,
    Key,
    Mouse,
    Macro,
}

fn parse_v3_mapping_list(
    xml: &str,
    macros_by_guid: &HashMap<String, ParsedMacro>,
    profile_name: &str,
    bindings: &mut Vec<ParsedBinding>,
    warnings: &mut Vec<ImportWarning>,
) -> Result<(), quick_xml::Error> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);

    let mut stack: Vec<String> = Vec::new();
    let mut current_event: Option<MappingBuilder> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                stack.push(tag.clone());
                if tag == "Mapping" {
                    current_event = Some(MappingBuilder::default());
                } else if let Some(b) = current_event.as_mut() {
                    match tag.as_str() {
                        "KeyGroup" => b.output_group = OutputGroup::Key,
                        "MouseGroup" => b.output_group = OutputGroup::Mouse,
                        "MacroGroup" => b.output_group = OutputGroup::Macro,
                        _ => {}
                    }
                }
            }
            Event::End(e) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if tag == "Mapping" {
                    if let Some(b) = current_event.take() {
                        if let Some(binding) = build_binding(b, macros_by_guid, profile_name, warnings)
                        {
                            bindings.push(binding);
                        }
                    }
                }
                stack.pop();
            }
            Event::Empty(_) => {
                // Self-closing tags like <Request /> — ignored.
            }
            Event::Text(t) => {
                let text = t.unescape()?.into_owned();
                if let Some(b) = current_event.as_mut() {
                    assign_mapping_text(b, &stack, &text);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(())
}

fn assign_mapping_text(b: &mut MappingBuilder, stack: &[String], text: &str) {
    let Some(leaf) = stack.last() else { return };
    match leaf.as_str() {
        "IsHyperShift" => b.is_hypershift = text.eq_ignore_ascii_case("true"),
        "InputType" => b.input_type = text.to_string(),
        "MouseInput" => {
            // Only at direct mapping level, not nested.
            if stack.iter().rev().nth(1).map(String::as_str) == Some("Mapping") {
                b.mouse_input = text.to_string();
            }
        }
        "DKMInput" => b.dkm_input = text.to_string(),
        "HID_Page" => b.key_hid_page = text.parse().ok(),
        "HID_Id" => b.key_hid_id = text.parse().ok(),
        "Scancode" => b.key_scancode = text.parse().ok(),
        "VirtualKey" => b.key_vk = text.parse().ok(),
        "Modifier" => b.key_modifier = text.to_string(),
        "MouseAssignment" => b.mouse_assignment = text.to_string(),
        "Id" => {
            // Only consume <Id> inside <MacroGroup>.
            if stack.iter().any(|s| s == "MacroGroup") {
                b.macro_guid = text.to_string();
            }
        }
        _ => {}
    }
}

fn build_binding(
    b: MappingBuilder,
    _macros_by_guid: &HashMap<String, ParsedMacro>,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> Option<ParsedBinding> {
    let (source_input_id, control_id) = resolve_input(&b, profile_name, warnings)?;
    let layer = if b.is_hypershift { "hypershift" } else { "standard" };

    // Skip hypershift-on-hypershift-button silently (Razer no-op default).
    if control_id == "hypershift_button" && b.output_group == OutputGroup::None {
        return None;
    }

    let action = build_action(&b, profile_name, warnings);
    let label = default_label_for(control_id, &action);

    Some(ParsedBinding {
        control_id: control_id.to_string(),
        layer: layer.to_string(),
        source_input_id,
        label,
        action,
    })
}

fn resolve_input(
    b: &MappingBuilder,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> Option<(String, &'static str)> {
    match b.input_type.as_str() {
        "DKMInput" => {
            let control = input_id_to_control_id("DKMInput", &b.dkm_input, false);
            if let Some(c) = control {
                return Some((b.dkm_input.clone(), c));
            }
            warnings.push(
                ImportWarning::new(
                    "v3_unmappable_dkm",
                    format!("DKM input `{}` has no Sidearm equivalent.", b.dkm_input),
                )
                .with_context(profile_name.to_string()),
            );
            None
        }
        "MouseInput" => {
            let control = input_id_to_control_id("MouseInput", &b.mouse_input, false);
            if let Some(c) = control {
                return Some((b.mouse_input.clone(), c));
            }
            warnings.push(
                ImportWarning::new(
                    "v3_unmappable_mouse",
                    format!(
                        "Mouse input `{}` has no Sidearm equivalent.",
                        b.mouse_input
                    ),
                )
                .with_context(profile_name.to_string()),
            );
            None
        }
        "KeyInput" => {
            // HID-encoded physical key. We don't currently map arbitrary HID
            // IDs to Sidearm controls (Sidearm controls are device-specific).
            // Emit a warning and drop. The user can still see what was there
            // via the preview.
            warnings.push(
                ImportWarning::new(
                    "v3_keyinput_dropped",
                    format!(
                        "KeyInput (HID_Page={:?}, HID_Id={:?}) is not a Sidearm-mappable control — dropped.",
                        b.key_hid_page, b.key_hid_id
                    ),
                )
                .with_context(profile_name.to_string()),
            );
            None
        }
        other => {
            warnings.push(
                ImportWarning::new(
                    "v3_unsupported_input_type",
                    format!("Input type `{other}` is not supported."),
                )
                .with_context(profile_name.to_string()),
            );
            None
        }
    }
}

fn build_action(
    b: &MappingBuilder,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> ParsedAction {
    match b.output_group {
        OutputGroup::Key => build_shortcut_from_key_group(b, profile_name, warnings),
        OutputGroup::Mouse => build_mouse_action(b, profile_name, warnings),
        OutputGroup::Macro => {
            if b.macro_guid.is_empty() {
                ParsedAction::Unmappable {
                    reason: "<MacroGroup> without <Id>".into(),
                }
            } else {
                ParsedAction::Sequence {
                    macro_guid: b.macro_guid.clone(),
                }
            }
        }
        OutputGroup::None => {
            // Some v3 mappings omit output entirely (e.g. HyperShift
            // activator on RightClick has no group).  Treat as disabled-
            // equivalent rather than unmappable.
            ParsedAction::Disabled
        }
    }
}

fn build_shortcut_from_key_group(
    b: &MappingBuilder,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> ParsedAction {
    let mut mods = parse_modifier_string(&b.key_modifier);
    let key_name: Option<String> = b
        .key_vk
        .and_then(vk_to_key)
        .map(|s| s.to_string())
        .or_else(|| {
            // Fallback to scancode via our makecode table.
            b.key_scancode
                .and_then(|code| makecode::makecode_to_key(code, false))
                .map(|s| s.to_string())
        });

    let key = match key_name {
        Some(k) => k,
        None => {
            warnings.push(
                ImportWarning::new(
                    "v3_unknown_keycode",
                    format!(
                        "Shortcut <KeyAssignment> has no recognisable VK or scancode \
                         (vk={:?}, scancode={:?}).",
                        b.key_vk, b.key_scancode
                    ),
                )
                .with_context(profile_name.to_string()),
            );
            return ParsedAction::Unmappable {
                reason: "unknown VK/scancode".into(),
            };
        }
    };

    // Fold modifier-only key tokens back into flags (e.g. VK_CONTROL).
    if let Ok(()) = (|| -> Result<(), KeyTranslationError> {
        let token = format!("KEY_{}", key.to_ascii_uppercase());
        match translate_key_token(&token) {
            Ok(_) => Ok(()),
            Err(KeyTranslationError::ModifierOnly) => {
                mods.add_token(&token);
                Err(KeyTranslationError::ModifierOnly)
            }
            Err(other) => Err(other),
        }
    })() {
        // translate succeeded as non-modifier, do nothing.
    }

    ParsedAction::Shortcut {
        key,
        ctrl: mods.ctrl,
        shift: mods.shift,
        alt: mods.alt,
        win: mods.win,
    }
}

fn build_mouse_action(
    b: &MappingBuilder,
    profile_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> ParsedAction {
    if b.mouse_assignment.is_empty() {
        return ParsedAction::Unmappable {
            reason: "<MouseAssignment> missing".into(),
        };
    }
    match translate_mouse_assignment(&b.mouse_assignment) {
        Some(action) => ParsedAction::MouseAction {
            action: action.to_string(),
        },
        None => {
            warnings.push(
                ImportWarning::new(
                    "v3_unsupported_mouse_assignment",
                    format!(
                        "Mouse assignment `{}` is not supported.",
                        b.mouse_assignment
                    ),
                )
                .with_context(profile_name.to_string()),
            );
            ParsedAction::Unmappable {
                reason: format!("mouse assignment `{}`", b.mouse_assignment),
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
        ParsedAction::MouseAction { action } => action.clone(),
        ParsedAction::Sequence { .. } => "Macro".to_string(),
        ParsedAction::Disabled => "—".to_string(),
        ParsedAction::Unmappable { .. } => format!("? {control_id}"),
        ParsedAction::TextSnippet { .. } => "TextSnippet".to_string(),
    }
}

// ============================================================================
// Profile meta + macro XML parsing
// ============================================================================

fn parse_v3_profile_meta(xml: &str) -> Result<(String, String), quick_xml::Error> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut stack: Vec<String> = Vec::new();
    let mut name = String::new();
    let mut guid = String::new();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                stack.push(String::from_utf8_lossy(e.name().as_ref()).into_owned());
            }
            Event::End(_) => {
                stack.pop();
            }
            Event::Text(t) => {
                let text = t.unescape()?.into_owned();
                match stack.last().map(String::as_str) {
                    Some("Name") => name = text,
                    Some("ProfileId") => guid = text,
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if guid.is_empty() {
        guid = format!("v3-{name}");
    }
    if name.is_empty() {
        name = format!("Profile {guid}");
    }
    Ok((guid, name))
}

#[derive(Default)]
struct V3MacroEvent {
    ty: String,
    makecode: Option<u16>,
    state: Option<u8>,
    delay_ms: Option<u32>,
}

fn parse_v3_macro(
    xml: &str,
    warnings: &mut Vec<ImportWarning>,
) -> Result<ParsedMacro, quick_xml::Error> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut stack: Vec<String> = Vec::new();
    let mut name = String::new();
    let mut guid = String::new();
    let mut events: Vec<V3MacroEvent> = Vec::new();
    let mut current: Option<V3MacroEvent> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                stack.push(tag.clone());
                if tag == "MacroEvent" {
                    current = Some(V3MacroEvent::default());
                }
            }
            Event::End(e) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if tag == "MacroEvent" {
                    if let Some(ev) = current.take() {
                        events.push(ev);
                    }
                }
                stack.pop();
            }
            Event::Empty(_) => {}
            Event::Text(t) => {
                let text = t.unescape()?.into_owned();
                let leaf = stack.last().cloned();
                let leaf = leaf.as_deref();
                if let Some(ev) = current.as_mut() {
                    match leaf {
                        Some("Type") => ev.ty = text,
                        Some("Makecode") => ev.makecode = text.parse().ok(),
                        Some("State") => ev.state = text.parse().ok(),
                        Some("Delay") => ev.delay_ms = text.parse().ok(),
                        _ => {}
                    }
                } else {
                    // Outside MacroEvent — root-level fields.
                    if leaf == Some("Name") {
                        name = text;
                    } else if leaf == Some("Guid") {
                        guid = text;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    let steps = build_macro_steps(&name, &events, warnings);
    if guid.is_empty() {
        guid = format!("v3-macro-{name}");
    }
    Ok(ParsedMacro {
        synapse_guid: guid,
        name,
        steps,
    })
}

/// Walk v3 macro events, emitting Sleep steps for inter-event delays and
/// Send steps for paired key down/ups (modifier-folded via the same pairing
/// logic as format_v4).
fn build_macro_steps(
    macro_name: &str,
    events: &[V3MacroEvent],
    warnings: &mut Vec<ImportWarning>,
) -> Vec<ParsedSequenceStep> {
    let mut steps: Vec<ParsedSequenceStep> = Vec::new();
    let mut mods = ModifierFlags::default();
    let mut pending_down: Option<(u16, bool)> = None;

    for ev in events {
        if let Some(delay_ms) = ev.delay_ms {
            if delay_ms > 0 {
                steps.push(ParsedSequenceStep::Sleep { delay_ms });
            }
        }
        if ev.ty != "1" {
            continue;
        }
        let Some(makecode_val) = ev.makecode else { continue };
        let state = ev.state.unwrap_or(0);
        let is_extended = state >= 2;
        let is_down = state % 2 == 0;

        if is_down {
            if let Some(canon) = makecode::modifier_canonical(makecode_val, is_extended) {
                match canon {
                    "Ctrl" => mods.ctrl = true,
                    "Shift" => mods.shift = true,
                    "Alt" => mods.alt = true,
                    "Win" => mods.win = true,
                    _ => {}
                }
            } else if pending_down.is_none() {
                pending_down = Some((makecode_val, is_extended));
            } else {
                let (pc, pe) = pending_down.take().unwrap();
                emit_send(&mut steps, pc, pe, mods, macro_name, warnings);
                pending_down = Some((makecode_val, is_extended));
            }
        } else if let Some(canon) = makecode::modifier_canonical(makecode_val, is_extended) {
            match canon {
                "Ctrl" => mods.ctrl = false,
                "Shift" => mods.shift = false,
                "Alt" => mods.alt = false,
                "Win" => mods.win = false,
                _ => {}
            }
        } else if let Some((code, ext)) = pending_down.take() {
            emit_send(&mut steps, code, ext, mods, macro_name, warnings);
        }
    }

    if let Some((code, ext)) = pending_down {
        emit_send(&mut steps, code, ext, mods, macro_name, warnings);
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
            warnings.push(ImportWarning::new(
                "v3_unknown_scancode",
                format!(
                    "Macro `{macro_name}` uses unknown scancode 0x{makecode_val:02X}."
                ),
            ));
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
    // Keep a reference so the linker doesn't strip `parse_modifier_array` in
    // debug builds when format_v4 happens to be inlined away.
    let _ = parse_modifier_array;
    let _ = mapping::MODIFIER_TOKENS.len();
}

// ============================================================================
// ZIP helpers
// ============================================================================

fn read_file<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> std::io::Result<String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, e.to_string()))?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAPPING_SAMPLE: &str = r#"<?xml version="1.0"?>
<Mappings>
  <MappingList>
    <Mapping>
      <MappingGroup>Mouse</MappingGroup>
      <InputType>MouseInput</InputType>
      <MouseInput>LeftClick</MouseInput>
      <MouseGroup>
        <MouseAssignment>Click</MouseAssignment>
      </MouseGroup>
    </Mapping>
    <Mapping>
      <MappingGroup>Keyboard</MappingGroup>
      <InputType>DKMInput</InputType>
      <DKMInput>DKM_M_01</DKMInput>
      <KeyGroup>
        <KeyAssignment>
          <Scancode>35</Scancode>
          <VirtualKey>72</VirtualKey>
          <Modifier>Left_Ctrl Left_Shift</Modifier>
        </KeyAssignment>
      </KeyGroup>
    </Mapping>
    <Mapping>
      <IsHyperShift>true</IsHyperShift>
      <MappingGroup>Macro</MappingGroup>
      <InputType>DKMInput</InputType>
      <DKMInput>DKM_M_02</DKMInput>
      <MacroGroup>
        <Id>deadbeef-dead-beef-dead-beefdeadbeef</Id>
        <MacroPlaybackOption>Once</MacroPlaybackOption>
        <RepeatCount>1</RepeatCount>
      </MacroGroup>
    </Mapping>
  </MappingList>
</Mappings>"#;

    #[test]
    fn parses_v3_mapping_list_mouse_key_and_macro() {
        let macros: HashMap<String, ParsedMacro> = HashMap::new();
        let mut bindings: Vec<ParsedBinding> = Vec::new();
        let mut warnings: Vec<ImportWarning> = Vec::new();
        parse_v3_mapping_list(MAPPING_SAMPLE, &macros, "Test", &mut bindings, &mut warnings)
            .expect("parse");
        assert_eq!(bindings.len(), 3);
        // LeftClick → mouse_left → Click → leftClick
        assert_eq!(bindings[0].control_id, "mouse_left");
        match &bindings[0].action {
            ParsedAction::MouseAction { action } => assert_eq!(action, "leftClick"),
            _ => panic!("expected mouse"),
        }
        // DKM_M_01 → thumb_01, VK 72 = VK_H → "H", modifiers Ctrl+Shift
        assert_eq!(bindings[1].control_id, "thumb_01");
        match &bindings[1].action {
            ParsedAction::Shortcut { key, ctrl, shift, .. } => {
                assert_eq!(key, "H");
                assert!(*ctrl);
                assert!(*shift);
            }
            _ => panic!("expected shortcut"),
        }
        // DKM_M_02 hypershift macro
        assert_eq!(bindings[2].control_id, "thumb_02");
        assert_eq!(bindings[2].layer, "hypershift");
        match &bindings[2].action {
            ParsedAction::Sequence { macro_guid } => {
                assert_eq!(macro_guid, "deadbeef-dead-beef-dead-beefdeadbeef");
            }
            _ => panic!("expected sequence"),
        }
    }

    #[test]
    fn parse_profile_meta_extracts_name_and_guid() {
        let xml = r#"<?xml version="1.0"?>
<Profile>
  <Name>MAIN-Default</Name>
  <ProfileId>d1c2a543-9749-43b9-afc6-4b2e4a380b5f</ProfileId>
  <Request />
</Profile>"#;
        let (guid, name) = parse_v3_profile_meta(xml).unwrap();
        assert_eq!(guid, "d1c2a543-9749-43b9-afc6-4b2e4a380b5f");
        assert_eq!(name, "MAIN-Default");
    }

    #[test]
    fn vk_table_covers_common_keys() {
        assert_eq!(vk_to_key(0x08), Some("Backspace"));
        assert_eq!(vk_to_key(0x2E), Some("Delete"));
        assert_eq!(vk_to_key(0x48), Some("H"));
        assert_eq!(vk_to_key(0x7B), Some("F12"));
        assert_eq!(vk_to_key(0x7C), Some("F13"));
        assert_eq!(vk_to_key(0x87), Some("F24"));
    }

    #[test]
    fn modifier_string_parses_synapse_format() {
        let flags = parse_modifier_string("Left_Ctrl Left_Shift Extended_Key");
        assert!(flags.ctrl);
        assert!(flags.shift);
        assert!(!flags.alt);
        assert!(!flags.win);
    }
}
