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

use quick_xml::Reader;
use quick_xml::events::Event;

use super::macro_xml;
use super::makecode;
use super::mapping::{
    input_id_to_control_id, mouse_action_from_assignment, parse_modifier_string, vk_to_key,
};
use super::types::{
    ImportWarning, ParsedAction, ParsedBinding, ParsedMacro, ParsedProfile, ParsedSynapseProfiles,
    SourceKind, default_label_for,
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
    #[error("Archive has too many entries ({0}); refusing to read (possible zip bomb).")]
    TooManyEntries(usize),
    #[error(
        "Archive entry `{0}` is too large ({1} bytes uncompressed); refusing to read (possible zip bomb)."
    )]
    EntryTooLarge(String, u64),
    #[error(
        "Archive total uncompressed size ({0} bytes) exceeds the limit; refusing to read (possible zip bomb)."
    )]
    ArchiveTooLarge(u64),
}

// ============================================================================
// Zip-bomb defenses (FIXES P2-1)
// ============================================================================

/// Hard caps for untrusted Synapse `.synapse3` ZIP archives. Real exports are a
/// few dozen small XML files, so these limits are generous for legitimate input
/// while rejecting decompression bombs before any entry is read into memory.
pub(crate) const MAX_ZIP_ENTRIES: usize = 4096;
pub(crate) const MAX_ENTRY_UNCOMPRESSED: u64 = 16 * 1024 * 1024; // 16 MiB per entry
const MAX_TOTAL_UNCOMPRESSED: u64 = 128 * 1024 * 1024; // 128 MiB total

/// Validate the archive's declared shape (entry count + per-entry and total
/// uncompressed sizes) before reading any entry. Pure and testable; the live
/// `read_file` path additionally clamps the actual read in case a header lies.
fn enforce_zip_budget<'a>(
    entry_count: usize,
    entries: impl Iterator<Item = (&'a str, u64)>,
) -> Result<(), SynapseV3Error> {
    if entry_count > MAX_ZIP_ENTRIES {
        return Err(SynapseV3Error::TooManyEntries(entry_count));
    }
    let mut total: u64 = 0;
    for (name, size) in entries {
        if size > MAX_ENTRY_UNCOMPRESSED {
            return Err(SynapseV3Error::EntryTooLarge(name.to_string(), size));
        }
        total = total.saturating_add(size);
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err(SynapseV3Error::ArchiveTooLarge(total));
        }
    }
    Ok(())
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

    // Zip-bomb defense (FIXES P2-1): inspect the central directory (name + declared
    // uncompressed size, no decompression yet) and reject oversized/over-count
    // archives before reading any entry into memory.
    let entry_meta: Vec<(String, u64)> = (0..archive.len())
        .filter_map(|i| {
            archive
                .by_index(i)
                .ok()
                .map(|f| (f.name().to_string(), f.size()))
        })
        .collect();
    enforce_zip_budget(
        archive.len(),
        entry_meta.iter().map(|(n, s)| (n.as_str(), *s)),
    )?;

    // Collect ZIP entry names — we need random access by path pattern and
    // ZipArchive borrows mutably on read.
    let names: Vec<String> = entry_meta.into_iter().map(|(n, _)| n).collect();

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
            // Route the in-ZIP macro through the shared, depth-aware XML parser
            // (`macro_xml::parse_macro_xml_str`) so v3 ZIP macros honor `<Number>`
            // (seconds) delays and reject empty/guidless bodies — the same
            // behavior the sibling-`Макросы/`-folder path already has. The
            // fallback name mirrors that caller: the entry's file stem, which for
            // `Macros/{macroGuid}.xml` is the macro GUID.
            let fallback_name = Path::new(name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("macro")
                .to_string();
            match macro_xml::parse_macro_xml_str(&raw, fallback_name, &mut warnings) {
                Ok(m) => {
                    macros_by_guid.insert(m.synapse_guid.clone(), m);
                }
                // Previously `parse_v3_macro` returned Ok with empty steps and a
                // synthesized guid for an empty body; the shared parser instead
                // returns `Err(MacroXmlError::Shape)` for a macro with no events
                // and no guid. Skip such macros with a warning rather than
                // aborting the whole import (accepted behavior change).
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
        if let Err(e) =
            parse_v3_mapping_list(&raw, macros_by_guid, profile_name, &mut bindings, warnings)
        {
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
        if let ParsedAction::Sequence { macro_guid } = &b.action
            && seen.insert(macro_guid.clone())
            && let Some(m) = macros_by_guid.get(macro_guid)
        {
            out.push(m.clone());
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
                if tag == "Mapping"
                    && let Some(b) = current_event.take()
                    && let Some(binding) = build_binding(b, macros_by_guid, profile_name, warnings)
                {
                    bindings.push(binding);
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
        // Only consume <Id> inside <MacroGroup>.
        "Id" if stack.iter().any(|s| s == "MacroGroup") => {
            b.macro_guid = text.to_string();
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
    let layer = if b.is_hypershift {
        "hypershift"
    } else {
        "standard"
    };

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
                    format!("Mouse input `{}` has no Sidearm equivalent.", b.mouse_input),
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
    let key_name: Option<String> =
        b.key_vk
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

    // Fold a bare-modifier key (a button mapped to just "hold Ctrl/Shift/Alt/Win")
    // into the modifier flags and drop it as the shortcut key. `key` here is a
    // human name from vk_to_key ("Ctrl", "LeftCtrl", "LeftWin", …), NOT a KEY_
    // token — matching it directly, rather than round-tripping through
    // translate_key_token's KEY_LEFT_CTRL token format (which these names never
    // matched, so the fold was dead code and the modifier leaked into `key`).
    let key_upper = key.to_ascii_uppercase();
    let bare = key_upper
        .strip_prefix("LEFT")
        .or_else(|| key_upper.strip_prefix("RIGHT"))
        .unwrap_or(&key_upper);
    if matches!(bare, "CTRL" | "SHIFT" | "ALT" | "WIN" | "GUI") {
        // add_token folds via substring (CTRL/SHIFT/ALT/WIN/GUI) → correct flag.
        mods.add_token(&key_upper);
        return ParsedAction::Shortcut {
            key: String::new(),
            ctrl: mods.ctrl,
            shift: mods.shift,
            alt: mods.alt,
            win: mods.win,
        };
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
    mouse_action_from_assignment(&b.mouse_assignment, profile_name, warnings)
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
    // Belt-and-suspenders against a lying header: clamp the actual read even
    // though enforce_zip_budget already vetted the declared sizes (FIXES P2-1).
    let mut buf = String::new();
    entry
        .by_ref()
        .take(MAX_ENTRY_UNCOMPRESSED + 1)
        .read_to_string(&mut buf)?;
    if buf.len() as u64 > MAX_ENTRY_UNCOMPRESSED {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("entry `{name}` exceeds {MAX_ENTRY_UNCOMPRESSED} bytes uncompressed"),
        ));
    }
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
        parse_v3_mapping_list(
            MAPPING_SAMPLE,
            &macros,
            "Test",
            &mut bindings,
            &mut warnings,
        )
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
            ParsedAction::Shortcut {
                key, ctrl, shift, ..
            } => {
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

    fn key_group_builder(vk: u16) -> MappingBuilder {
        MappingBuilder {
            is_hypershift: false,
            input_type: String::new(),
            mouse_input: String::new(),
            dkm_input: String::new(),
            key_hid_page: None,
            key_hid_id: None,
            key_scancode: None,
            key_vk: Some(vk),
            key_modifier: String::new(),
            mouse_assignment: String::new(),
            macro_guid: String::new(),
            output_group: OutputGroup::Key,
        }
    }

    #[test]
    fn build_shortcut_folds_bare_modifier_vk_into_flags() {
        // Regression for the C6 finding: a v3 button mapped to a bare modifier VK
        // (e.g. "hold Ctrl") must fold into the modifier flag with an empty key,
        // not leak the modifier's own name into the key field. Previously the
        // fold was dead code (KEY_CTRL token never matched KEY_LEFT_CTRL).
        let mut warnings = Vec::new();

        // VK_LCONTROL (0xA2) → "LeftCtrl" → ctrl flag, empty key.
        match build_shortcut_from_key_group(&key_group_builder(0xA2), "Test", &mut warnings) {
            ParsedAction::Shortcut {
                key,
                ctrl,
                shift,
                alt,
                win,
            } => {
                assert_eq!(key, "", "bare modifier must not leak into the key field");
                assert!(ctrl, "VK_LCONTROL must set ctrl");
                assert!(!shift && !alt && !win);
            }
            other => panic!("expected Shortcut, got {other:?}"),
        }

        // VK_LWIN (0x5B) → "LeftWin" → win flag.
        match build_shortcut_from_key_group(&key_group_builder(0x5B), "Test", &mut warnings) {
            ParsedAction::Shortcut { key, win, .. } => {
                assert_eq!(key, "");
                assert!(win, "VK_LWIN must set win");
            }
            other => panic!("expected Shortcut, got {other:?}"),
        }

        // Sanity: a real key (VK_H 0x48) is unaffected — key="H", no modifier.
        match build_shortcut_from_key_group(&key_group_builder(0x48), "Test", &mut warnings) {
            ParsedAction::Shortcut { key, ctrl, .. } => {
                assert_eq!(key, "H");
                assert!(!ctrl);
            }
            other => panic!("expected Shortcut, got {other:?}"),
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

    #[test]
    fn zip_budget_rejects_bombs_but_allows_real_exports() {
        // Too many entries.
        assert!(matches!(
            enforce_zip_budget(MAX_ZIP_ENTRIES + 1, std::iter::empty::<(&str, u64)>()),
            Err(SynapseV3Error::TooManyEntries(_))
        ));
        // A single entry over the per-entry cap.
        assert!(matches!(
            enforce_zip_budget(1, [("big.xml", MAX_ENTRY_UNCOMPRESSED + 1)].into_iter()),
            Err(SynapseV3Error::EntryTooLarge(_, _))
        ));
        // Many in-bounds entries whose total blows the budget.
        let n = (MAX_TOTAL_UNCOMPRESSED / MAX_ENTRY_UNCOMPRESSED) as usize + 2;
        assert!(matches!(
            enforce_zip_budget(n, (0..n).map(|_| ("x.xml", MAX_ENTRY_UNCOMPRESSED))),
            Err(SynapseV3Error::ArchiveTooLarge(_))
        ));
        // A realistic small export passes.
        assert!(
            enforce_zip_budget(
                3,
                [
                    ("DeviceInfo.xml", 1_000u64),
                    ("Profiles/p.xml", 2_000),
                    ("Macros/m.xml", 3_000)
                ]
                .into_iter()
            )
            .is_ok()
        );
    }
}

#[cfg(test)]
mod edge_proptests {
    use super::*;
    // `ParsedSequenceStep` is no longer used by production code in this file
    // (the v3 macro normalizer was deleted in R8); it is still asserted on in the
    // `<Number>`-delay regression test below.
    use super::super::types::ParsedSequenceStep;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Boundary: enforce_zip_budget with exactly MAX_ZIP_ENTRIES entries → ok
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_exactly_max_entries_passes() {
        assert!(enforce_zip_budget(MAX_ZIP_ENTRIES, std::iter::empty::<(&str, u64)>()).is_ok());
    }

    #[test]
    fn boundary_max_plus_one_entries_fails() {
        assert!(matches!(
            enforce_zip_budget(MAX_ZIP_ENTRIES + 1, std::iter::empty::<(&str, u64)>()),
            Err(SynapseV3Error::TooManyEntries(_))
        ));
    }

    // -----------------------------------------------------------------------
    // Boundary: exactly MAX_ENTRY_UNCOMPRESSED per entry → ok
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_exactly_max_entry_size_passes() {
        assert!(enforce_zip_budget(1, [("f.xml", MAX_ENTRY_UNCOMPRESSED)].into_iter()).is_ok());
    }

    // -----------------------------------------------------------------------
    // Boundary: single entry of MAX_ENTRY_UNCOMPRESSED+1 → EntryTooLarge
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_entry_size_one_over_max_fails() {
        assert!(matches!(
            enforce_zip_budget(1, [("f.xml", MAX_ENTRY_UNCOMPRESSED + 1)].into_iter()),
            Err(SynapseV3Error::EntryTooLarge(_, _))
        ));
    }

    // -----------------------------------------------------------------------
    // Overflow: saturating_add on total size — no integer overflow panic
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_saturating_add_no_panic() {
        // Two entries whose declared sizes would overflow u64 if added naively.
        // enforce_zip_budget uses saturating_add, so it must return ArchiveTooLarge.
        assert!(matches!(
            enforce_zip_budget(
                2,
                [("a.xml", u64::MAX / 2 + 1), ("b.xml", u64::MAX / 2 + 1)].into_iter()
            ),
            Err(SynapseV3Error::EntryTooLarge(_, _) | SynapseV3Error::ArchiveTooLarge(_))
        ));
    }

    // -----------------------------------------------------------------------
    // Overflow: zero-size entries — all pass, total stays at 0
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_zero_size_entries_all_pass() {
        let entries: Vec<(&str, u64)> = (0..100).map(|_| ("x.xml", 0u64)).collect();
        assert!(enforce_zip_budget(100, entries.into_iter()).is_ok());
    }

    // -----------------------------------------------------------------------
    // Property: enforce_zip_budget never panics for any (count, sizes) input
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn prop_enforce_zip_budget_never_panics(
            count in 0usize..10_000,
            sizes in prop::collection::vec(any::<u64>(), 0..20)
        ) {
            let entries: Vec<(&str, u64)> = sizes.iter().map(|&s| ("x.xml", s)).collect();
            let _ = enforce_zip_budget(count, entries.into_iter());
        }
    }

    // -----------------------------------------------------------------------
    // Null & empty: parse_v3_profile_meta with empty XML → fallback names
    // -----------------------------------------------------------------------

    #[test]
    fn null_empty_profile_xml_uses_fallbacks() {
        let (guid, name) = parse_v3_profile_meta("<Profile></Profile>").unwrap();
        // guid starts with "v3-" prefix when empty; name uses the guid.
        assert!(
            guid.starts_with("v3-"),
            "expected fallback guid, got {guid}"
        );
        assert!(!name.is_empty());
    }

    // -----------------------------------------------------------------------
    // Null & empty: parse_v3_profile_meta with only Name, no ProfileId
    // -----------------------------------------------------------------------

    #[test]
    fn null_profile_meta_missing_guid_generates_fallback() {
        let xml = "<Profile><Name>Test</Name></Profile>";
        let (guid, name) = parse_v3_profile_meta(xml).unwrap();
        assert_eq!(name, "Test");
        assert!(
            guid.starts_with("v3-"),
            "expected v3-{name} fallback, got {guid}"
        );
    }

    // -----------------------------------------------------------------------
    // Null & empty: an empty in-ZIP macro body is now rejected.
    //
    // R8 routes the in-ZIP v3 macro through `macro_xml::parse_macro_xml_str`,
    // which returns `Err(MacroXmlError::Shape)` for a body with no events and no
    // guid (the old `parse_v3_macro` instead returned Ok with empty steps and a
    // synthesized `v3-macro-{name}` guid). The call site turns that Err into a
    // skipped macro plus a `v3_macro_parse_failed` warning — the accepted
    // behavior change. This asserts the new contract directly.
    // -----------------------------------------------------------------------

    #[test]
    fn empty_macro_xml_is_shape_error_and_skipped() {
        let mut w = Vec::new();
        let res = macro_xml::parse_macro_xml_str("<Macro></Macro>", "v3-macro".into(), &mut w);
        assert!(
            matches!(res, Err(macro_xml::MacroXmlError::Shape)),
            "empty in-ZIP macro must now be a Shape error, got {res:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Overflow: deeply nested mapping XML — iterative parser, no stack overflow
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_deep_mapping_xml_no_stack_overflow() {
        // Build a deeply nested but well-formed XML to stress the iterative
        // quick-xml parser: <Mappings><X0><X1>...<X1999></X1999>...</X0></Mappings>
        let open: String = (0..2000).map(|i| format!("<X{i}>")).collect();
        let close: String = (0..2000).rev().map(|i| format!("</X{i}>")).collect();
        let xml = format!("<Mappings>{open}{close}</Mappings>");
        let macros = std::collections::HashMap::new();
        let mut bindings = Vec::new();
        let mut warnings = Vec::new();
        // Must not stack-overflow; may return Ok (no Mapping elements) or Err.
        let _ = parse_v3_mapping_list(&xml, &macros, "deep", &mut bindings, &mut warnings);
    }

    // -----------------------------------------------------------------------
    // R8 gain: a v3-style in-ZIP macro with a `<Number>` (seconds) delay now
    // produces a Sleep step. The old `parse_v3_macro` had no `<Number>` branch
    // and silently dropped such delays; routing through the shared, depth-aware
    // `macro_xml::parse_macro_xml_str` honors them (it converts seconds→ms).
    //
    // The makecode-overflow, delay-overflow, and u32::MAX-delay-clamp paths that
    // the deleted `parse_v3_macro` tests covered are exercised identically by the
    // routed parser's own tests in `macro_xml`
    // (`overflow_makecode_beyond_u16_is_skipped`,
    // `overflow_delay_beyond_u32_is_dropped_silently`,
    // `overflow_delay_u32_max_is_clamped`), so they are not duplicated here.
    // -----------------------------------------------------------------------

    #[test]
    fn v3_macro_number_seconds_delay_now_produces_sleep_step() {
        // Mirrors a real in-ZIP `Macros/{guid}.xml` body: nested <KeyEvent> for
        // keys (as the routed parser reads them) and a `<Number>` delay event.
        // 0.5 s must surface as a 500 ms Sleep — previously dropped by v3.
        let xml = r#"<Macro><Name>N</Name><MacroEvents>
              <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>0</State></KeyEvent></MacroEvent>
              <MacroEvent><Type>0</Type><Number>0.5</Number></MacroEvent>
              <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>1</State></KeyEvent></MacroEvent>
            </MacroEvents><Guid>g-num</Guid></Macro>"#;
        let mut w = Vec::new();
        let parsed =
            macro_xml::parse_macro_xml_str(xml, "v3-macro".into(), &mut w).expect("should parse");
        assert!(
            parsed
                .steps
                .iter()
                .any(|s| matches!(s, ParsedSequenceStep::Sleep { delay_ms: 500 })),
            "expected a 500ms Sleep from <Number>0.5</Number>, got {:?}",
            parsed.steps
        );
    }

    // -----------------------------------------------------------------------
    // Null & empty: mapping XML with no <Mapping> elements → 0 bindings
    // -----------------------------------------------------------------------

    #[test]
    fn null_empty_mappings_xml_no_bindings() {
        let xml = r#"<?xml version="1.0"?><Mappings><MappingList></MappingList></Mappings>"#;
        let macros = std::collections::HashMap::new();
        let mut bindings = Vec::new();
        let mut warnings = Vec::new();
        parse_v3_mapping_list(xml, &macros, "P", &mut bindings, &mut warnings).unwrap();
        assert!(bindings.is_empty());
    }

    // -----------------------------------------------------------------------
    // Null & empty: mapping with MacroGroup but empty <Id> → Unmappable
    // -----------------------------------------------------------------------

    #[test]
    fn null_macro_group_empty_id_is_unmappable() {
        let xml = r#"<Mappings><MappingList>
            <Mapping>
              <InputType>DKMInput</InputType>
              <DKMInput>DKM_M_01</DKMInput>
              <MacroGroup><Id></Id></MacroGroup>
            </Mapping>
        </MappingList></Mappings>"#;
        let macros = std::collections::HashMap::new();
        let mut bindings = Vec::new();
        let mut warnings = Vec::new();
        parse_v3_mapping_list(xml, &macros, "P", &mut bindings, &mut warnings).unwrap();
        // Empty <Id> → macro_guid is empty → Unmappable action.
        if let Some(b) = bindings.first() {
            assert!(matches!(b.action, ParsedAction::Unmappable { .. }));
        }
    }

    // -----------------------------------------------------------------------
    // Property: parsers never panic on arbitrary XML strings. The in-ZIP macro
    // parser is now `macro_xml::parse_macro_xml_str`, whose own
    // `prop_parse_never_panics_on_arbitrary_str` covers that path; here we keep
    // the v3-specific profile-meta and mapping-list fuzzers.
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn prop_parse_v3_profile_meta_never_panics(s in ".*") {
            let _ = parse_v3_profile_meta(&s);
        }

        #[test]
        fn prop_parse_v3_mapping_list_never_panics(s in ".*") {
            let macros = std::collections::HashMap::new();
            let mut bindings = Vec::new();
            let mut warnings = Vec::new();
            let _ = parse_v3_mapping_list(&s, &macros, "P", &mut bindings, &mut warnings);
        }
    }

    // Concurrency: N/A — all functions are pure; ZIP archive parsing (I/O) is
    //              not tested here (requires real files).
    // Temporal:    in-ZIP macro delay handling (u32::MAX clamp, overflow drop,
    //              `<Number>` seconds) is now owned by the routed
    //              `macro_xml::parse_macro_xml_str` and covered by its tests; the
    //              `<Number>`-delay gain is additionally pinned above.
}
