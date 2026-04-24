//! Razer Synapse import subsystem.
//!
//! Slice 1 (this module) supports `.synapse4` JSON+base64 format for
//! profiles and macros. Later slices will add `.synapse3` ZIP+XML and
//! standalone `.xml` macro folders.

pub mod format_v3;
pub mod format_v4;
pub mod macro_xml;
pub mod makecode;
pub mod mapping;
pub mod merge;
pub mod types;

pub use format_v3::parse_synapse_v3_file;
pub use format_v4::parse_synapse_v4_file;
pub use merge::apply_parsed_into_config;
pub use types::*;

use std::io::Read;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum SynapseImportError {
    #[error("{0}")]
    V4(#[from] format_v4::SynapseParseError),
    #[error("{0}")]
    V3(#[from] format_v3::SynapseV3Error),
    #[error("Failed to read `{0}`: {1}")]
    Io(String, std::io::Error),
}

/// High-level entry point: detect Synapse export format from the file's
/// first bytes and dispatch to the right parser.
///  - `{`  (0x7B) → v4 JSON
///  - `PK` (0x50 0x4B) → v3 ZIP archive
/// For v4, if a sibling `Макросы/` (or `Macros/`) folder exists next to the
/// file, its `.xml` macros are also pulled in so GUID-referenced macros
/// resolve end-to-end.
pub fn parse_synapse_source(path: &Path) -> Result<ParsedSynapseProfiles, SynapseImportError> {
    let mut probe = [0u8; 2];
    let mut file = std::fs::File::open(path)
        .map_err(|e| SynapseImportError::Io(path.to_string_lossy().into_owned(), e))?;
    let bytes = file.read(&mut probe)
        .map_err(|e| SynapseImportError::Io(path.to_string_lossy().into_owned(), e))?;

    if bytes >= 2 && probe == *b"PK" {
        return Ok(parse_synapse_v3_file(path)?);
    }

    // Default to v4 JSON for anything else (covers `{`, BOM, whitespace…).
    let mut parsed = parse_synapse_v4_file(path)?;
    enrich_with_sibling_xml_macros(&mut parsed, path);
    Ok(parsed)
}

fn enrich_with_sibling_xml_macros(parsed: &mut ParsedSynapseProfiles, path: &Path) {
    let Some(parent) = path.parent() else { return };
    let candidates = [
        parent.join("Макросы"),
        parent.join("Macros"),
        parent.join("macros"),
    ];

    let mut extra_warnings: Vec<ImportWarning> = Vec::new();
    let mut extra_macros: Vec<ParsedMacro> = Vec::new();
    for cand in &candidates {
        if !cand.is_dir() {
            continue;
        }
        match macro_xml::parse_macros_in_dir(cand, &mut extra_warnings) {
            Ok(mut macros) => extra_macros.append(&mut macros),
            Err(e) => {
                extra_warnings.push(
                    ImportWarning::new(
                        "macro_dir_io_error",
                        format!("Could not read `{}`: {e}", cand.display()),
                    ),
                );
            }
        }
    }

    if extra_macros.is_empty() {
        return;
    }

    let by_guid: std::collections::HashMap<String, ParsedMacro> = extra_macros
        .into_iter()
        .map(|m| (m.synapse_guid.clone(), m))
        .collect();

    // For each profile, resolve any bindings that referenced missing macros.
    for profile in &mut parsed.profiles {
        let mut inject: std::collections::HashSet<String> = std::collections::HashSet::new();
        for binding in &profile.bindings {
            if let ParsedAction::Sequence { macro_guid } = &binding.action {
                let already_in = profile.macros.iter().any(|m| m.synapse_guid == *macro_guid);
                if !already_in && by_guid.contains_key(macro_guid) {
                    inject.insert(macro_guid.clone());
                }
            }
        }
        for guid in inject {
            if let Some(m) = by_guid.get(&guid) {
                profile.macros.push(m.clone());
            }
        }
    }

    // Strip any now-resolved "macro_reference_missing" warnings to avoid
    // confusing users.
    parsed.warnings.retain(|w| {
        if w.code != "macro_reference_missing" {
            return true;
        }
        !by_guid
            .keys()
            .any(|guid| w.message.contains(guid.as_str()))
    });
    parsed.warnings.extend(extra_warnings);
}
