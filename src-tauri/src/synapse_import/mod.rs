//! Razer Synapse import subsystem.
//!
//! Supports `.synapse4` JSON+base64, `.synapse3` ZIP+XML, and sibling XML
//! macro folders, producing shared profile and macro DTOs for merging.

pub mod format_v3;
pub mod format_v4;
pub mod macro_steps;
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
///
/// For v4, if a sibling `Макросы/` (or `Macros/`) folder exists next to the
/// file, its `.xml` macros are also pulled in so GUID-referenced macros
/// resolve end-to-end.
pub fn parse_synapse_source(path: &Path) -> Result<ParsedSynapseProfiles, SynapseImportError> {
    let mut probe = [0u8; 2];
    let mut file = std::fs::File::open(path)
        .map_err(|e| SynapseImportError::Io(path.to_string_lossy().into_owned(), e))?;
    let bytes = file
        .read(&mut probe)
        .map_err(|e| SynapseImportError::Io(path.to_string_lossy().into_owned(), e))?;

    if bytes >= 2 && probe == *b"PK" {
        return Ok(parse_synapse_v3_file(path)?);
    }

    // Default to v4 JSON for anything else (covers `{`, BOM, whitespace…).
    let mut parsed = parse_synapse_v4_file(path)?;
    enrich_with_sibling_xml_macros(
        &mut parsed,
        path,
        format_v3::MAX_TOTAL_UNCOMPRESSED as usize,
    );
    Ok(parsed)
}

fn enrich_with_sibling_xml_macros(
    parsed: &mut ParsedSynapseProfiles,
    path: &Path,
    macro_byte_budget: usize,
) {
    let Some(parent) = path.parent() else { return };
    let candidates = [
        parent.join("Макросы"),
        parent.join("Macros"),
        parent.join("macros"),
    ];

    let mut extra_warnings: Vec<ImportWarning> = Vec::new();
    let mut extra_macros: Vec<ParsedMacro> = Vec::new();
    let mut folder_budget = macro_xml::MacroFolderBudget::default();
    // On a case-insensitive filesystem (Windows) "Macros" and "macros" resolve to
    // the same directory; canonicalize so each real dir is parsed once (otherwise
    // its XML-parse warnings get pushed twice).
    let mut seen_dirs: std::collections::HashSet<std::path::PathBuf> =
        std::collections::HashSet::new();
    for cand in &candidates {
        if !cand.is_dir() {
            continue;
        }
        let canonical = cand.canonicalize().unwrap_or_else(|_| cand.clone());
        if !seen_dirs.insert(canonical) {
            continue;
        }
        match macro_xml::parse_macros_in_dir(cand, &mut extra_warnings, &mut folder_budget) {
            Ok(mut macros) => extra_macros.append(&mut macros),
            Err(e) => {
                extra_warnings.push(ImportWarning::new(
                    "macro_dir_io_error",
                    format!("Could not read `{}`: {e}", cand.display()),
                ));
            }
        }
    }

    if extra_macros.is_empty() {
        parsed.warnings.extend(extra_warnings);
        return;
    }

    // Skip sibling macros with an empty GUID: they can never resolve a binding
    // (bindings reference a concrete macro_guid) and, more importantly, an empty
    // key would make `w.message.contains("")` below match EVERY warning, wrongly
    // suppressing all `macro_reference_missing` diagnostics. See finding F007.
    let by_guid: std::collections::HashMap<String, ParsedMacro> = extra_macros
        .into_iter()
        .filter(|m| !m.synapse_guid.is_empty())
        .map(|m| (m.synapse_guid.clone(), m))
        .collect();

    // Also bound the copies retained across profiles, including embedded V4 macros.
    let (mut copy_budget, mut byte_budget) = parsed.profiles.iter().flat_map(|p| &p.macros).fold(
        (format_v3::MAX_IMPORTED_MACRO_STEPS, macro_byte_budget),
        |(steps, bytes), m| {
            (
                steps.saturating_sub(m.steps.len()),
                bytes.saturating_sub(macro_copy_bytes(m)),
            )
        },
    );
    let mut unresolved = std::collections::HashSet::new();
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
                let Some((steps_left, bytes_left)) = copy_budget
                    .checked_sub(m.steps.len())
                    .zip(byte_budget.checked_sub(macro_copy_bytes(m)))
                else {
                    unresolved.insert(guid);
                    folder_budget.warn_exhausted(&mut extra_warnings);
                    continue;
                };
                copy_budget = steps_left;
                byte_budget = bytes_left;
                profile.macros.push(m.clone());
            }
        }
    }

    // Strip any now-resolved "macro_reference_missing" warnings to avoid
    // confusing users.
    strip_resolved_missing_macro_warnings(
        &mut parsed.warnings,
        by_guid.keys().filter(|guid| !unresolved.contains(*guid)),
    );
    parsed.warnings.extend(extra_warnings);
}

/// Count owned macro data before cloning; even a zero-step macro can have a large name.
fn macro_copy_bytes(m: &ParsedMacro) -> usize {
    let ParsedMacro {
        synapse_guid,
        name,
        steps,
    } = m;
    let bytes = std::mem::size_of::<ParsedMacro>()
        .saturating_add(synapse_guid.len())
        .saturating_add(name.len());
    steps.iter().fold(bytes, |bytes, step| {
        bytes
            .saturating_add(std::mem::size_of::<ParsedSequenceStep>())
            .saturating_add(match step {
                ParsedSequenceStep::Send { value } => value.len(),
                ParsedSequenceStep::Sleep { .. } => 0,
            })
    })
}

/// Remove `macro_reference_missing` warnings whose message references one of the
/// now-resolved macro GUIDs. Empty GUID keys are ignored so a stray empty key
/// cannot match (and therefore suppress) every warning via a substring match on
/// the empty string. See finding F007.
fn strip_resolved_missing_macro_warnings<'a>(
    warnings: &mut Vec<ImportWarning>,
    resolved_guids: impl IntoIterator<Item = &'a String>,
) {
    let resolved: Vec<&str> = resolved_guids
        .into_iter()
        .map(String::as_str)
        .filter(|guid| !guid.is_empty())
        .collect();
    warnings.retain(|w| {
        if w.code != "macro_reference_missing" {
            return true;
        }
        !resolved.iter().any(|guid| w.message.contains(guid))
    });
}

#[cfg(test)]
mod enrich_tests {
    use super::*;

    #[test]
    fn sibling_folders_share_a_decoded_step_budget() {
        let dir = tempfile::tempdir().unwrap();
        let mut parsed = ParsedSynapseProfiles {
            source_kind: SourceKind::SynapseV4,
            source_path: "test".into(),
            warnings: vec![],
            profiles: vec![ParsedProfile {
                synapse_guid: "p".into(),
                name: "P".into(),
                bindings: vec![],
                macros: vec![],
            }],
        };
        for (index, folder) in ["Macros", "Макросы"].iter().enumerate() {
            let folder = dir.path().join(folder);
            std::fs::create_dir(&folder).unwrap();
            let guid = format!("macro-{index}");
            let events = "<MacroEvent><Type>0</Type><Delay>1</Delay></MacroEvent>".repeat(100_001);
            std::fs::write(
                folder.join("macro.xml"),
                format!("<Macro><Guid>{guid}</Guid><MacroEvents>{events}</MacroEvents></Macro>"),
            )
            .unwrap();
            parsed.profiles[0].bindings.push(ParsedBinding {
                control_id: format!("thumb_0{}", index + 1),
                layer: "standard".into(),
                source_input_id: String::new(),
                label: "Macro".into(),
                action: ParsedAction::Sequence { macro_guid: guid },
            });
        }
        enrich_with_sibling_xml_macros(
            &mut parsed,
            &dir.path().join("export.synapse4"),
            format_v3::MAX_TOTAL_UNCOMPRESSED as usize,
        );
        let steps: usize = parsed
            .profiles
            .iter()
            .flat_map(|p| &p.macros)
            .map(|m| m.steps.len())
            .sum();
        assert!(
            steps <= 200_000,
            "sibling macros exceeded the shared budget: {steps}"
        );
        assert!(
            parsed
                .warnings
                .iter()
                .any(|w| w.code == "macro_xml_budget_exceeded")
        );
    }

    #[test]
    fn sibling_macro_copies_are_bounded_without_hiding_unresolved_references() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Macros");
        std::fs::create_dir(&folder).unwrap();
        let events = "<MacroEvent><Type>0</Type><Delay>1</Delay></MacroEvent>".repeat(100_001);
        std::fs::write(
            folder.join("macro.xml"),
            format!("<Macro><Guid>m</Guid><MacroEvents>{events}</MacroEvents></Macro>"),
        )
        .unwrap();
        let profile = ParsedProfile {
            synapse_guid: "p".into(),
            name: "P".into(),
            macros: vec![],
            bindings: vec![ParsedBinding {
                control_id: "thumb_01".into(),
                layer: "standard".into(),
                source_input_id: String::new(),
                label: "M".into(),
                action: ParsedAction::Sequence {
                    macro_guid: "m".into(),
                },
            }],
        };
        let mut parsed = ParsedSynapseProfiles {
            source_kind: SourceKind::SynapseV4,
            source_path: "test".into(),
            profiles: vec![profile.clone(), profile],
            warnings: vec![warn("macro_reference_missing", "Macro `m` is missing.")],
        };
        enrich_with_sibling_xml_macros(
            &mut parsed,
            &dir.path().join("export.synapse4"),
            format_v3::MAX_TOTAL_UNCOMPRESSED as usize,
        );
        assert_eq!(
            parsed
                .profiles
                .iter()
                .map(|p| p.macros.len())
                .sum::<usize>(),
            1
        );
        assert!(
            parsed
                .warnings
                .iter()
                .any(|w| w.code == "macro_reference_missing")
        );
        assert!(
            parsed
                .warnings
                .iter()
                .any(|w| w.code == "macro_xml_budget_exceeded")
        );
    }

    #[test]
    fn sibling_macro_byte_budget_bounds_long_names_with_zero_or_one_step() {
        for step_count in [0, 1] {
            let dir = tempfile::tempdir().unwrap();
            let folder = dir.path().join("Macros");
            std::fs::create_dir(&folder).unwrap();
            let name = "Long macro name-".repeat(256);
            let guid = format!("large-{}", "g".repeat(512));
            let event = "<MacroEvent><Type>0</Type><Delay>1</Delay></MacroEvent>";
            std::fs::write(
                folder.join("large.xml"),
                format!(
                    "<Macro><Guid>{guid}</Guid><Name>{name}</Name><MacroEvents>{}</MacroEvents></Macro>",
                    event.repeat(step_count)
                ),
            )
            .unwrap();
            std::fs::write(
                folder.join("good.xml"),
                "<Macro><Guid>good-macro</Guid><Name>Good</Name></Macro>",
            )
            .unwrap();
            let mut parsed = ParsedSynapseProfiles {
                source_kind: SourceKind::SynapseV4,
                source_path: "test".into(),
                profiles: (0..4)
                    .map(|index| ParsedProfile {
                        synapse_guid: format!("p{index}"),
                        name: format!("P{index}"),
                        macros: vec![],
                        bindings: vec![ParsedBinding {
                            control_id: "thumb_01".into(),
                            layer: "standard".into(),
                            source_input_id: String::new(),
                            label: "Macro".into(),
                            action: ParsedAction::Sequence {
                                macro_guid: if index < 3 {
                                    guid.clone()
                                } else {
                                    "good-macro".into()
                                },
                            },
                        }],
                    })
                    .collect(),
                warnings: vec![
                    warn(
                        "macro_reference_missing",
                        &format!("Macro `{guid}` is missing."),
                    ),
                    warn("macro_reference_missing", "Macro `good-macro` is missing."),
                    warn(
                        "macro_reference_missing",
                        "Macro `absent-macro` is missing.",
                    ),
                ],
            };
            let large_bytes = std::mem::size_of::<ParsedMacro>()
                + name.len()
                + guid.len()
                + step_count * std::mem::size_of::<ParsedSequenceStep>();
            let good_bytes = std::mem::size_of::<ParsedMacro>() + "Good".len() + "good-macro".len();
            enrich_with_sibling_xml_macros(
                &mut parsed,
                &dir.path().join("export.synapse4"),
                large_bytes + good_bytes,
            );
            assert_eq!(
                parsed
                    .profiles
                    .iter()
                    .map(|p| p.macros.len())
                    .collect::<Vec<_>>(),
                [1, 0, 0, 1],
                "only one long-name copy and the later small macro fit ({step_count} steps)"
            );
            assert_eq!(parsed.profiles[0].macros[0].name, name);
            assert_eq!(parsed.profiles[0].macros[0].steps.len(), step_count);
            assert_eq!(parsed.profiles[3].macros[0].synapse_guid, "good-macro");
            assert_eq!(
                parsed
                    .warnings
                    .iter()
                    .filter(|w| w.code == "macro_xml_budget_exceeded")
                    .count(),
                1
            );
            let missing: Vec<_> = parsed
                .warnings
                .iter()
                .filter(|w| w.code == "macro_reference_missing")
                .map(|w| w.message.as_str())
                .collect();
            assert_eq!(
                missing,
                [
                    format!("Macro `{guid}` is missing."),
                    "Macro `absent-macro` is missing.".into()
                ]
            );
        }
    }

    #[test]
    fn sibling_macro_byte_budget_counts_embedded_strings_and_send_values() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Macros");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(
            folder.join("sibling.xml"),
            "<Macro><Guid>sibling</Guid><Name>Sibling</Name><MacroEvents><MacroEvent><Type>0</Type><Delay>1</Delay></MacroEvent></MacroEvents></Macro>",
        )
        .unwrap();
        let embedded = ParsedMacro {
            synapse_guid: format!("embedded-{}", "g".repeat(512)),
            name: "Embedded ".repeat(128),
            steps: vec![ParsedSequenceStep::Send {
                value: "Ctrl+".repeat(128),
            }],
        };
        let embedded_bytes = std::mem::size_of::<ParsedMacro>()
            + embedded.synapse_guid.len()
            + embedded.name.len()
            + std::mem::size_of::<ParsedSequenceStep>()
            + "Ctrl+".len() * 128;
        let sibling_bytes = std::mem::size_of::<ParsedMacro>()
            + "sibling".len()
            + "Sibling".len()
            + std::mem::size_of::<ParsedSequenceStep>();
        for (budget, fits) in [
            (embedded_bytes - 1, false),
            (embedded_bytes + sibling_bytes - 1, false),
            (embedded_bytes + sibling_bytes, true),
        ] {
            let mut parsed = ParsedSynapseProfiles {
                source_kind: SourceKind::SynapseV4,
                source_path: "test".into(),
                profiles: vec![ParsedProfile {
                    synapse_guid: "p".into(),
                    name: "P".into(),
                    macros: vec![embedded.clone()],
                    bindings: vec![ParsedBinding {
                        control_id: "thumb_01".into(),
                        layer: "standard".into(),
                        source_input_id: String::new(),
                        label: "Macro".into(),
                        action: ParsedAction::Sequence {
                            macro_guid: "sibling".into(),
                        },
                    }],
                }],
                warnings: vec![warn(
                    "macro_reference_missing",
                    "Macro `sibling` is missing.",
                )],
            };
            enrich_with_sibling_xml_macros(
                &mut parsed,
                &dir.path().join("export.synapse4"),
                budget,
            );
            assert_eq!(
                parsed.profiles[0].macros.len(),
                1 + usize::from(fits),
                "budget {budget}"
            );
            assert_eq!(parsed.profiles[0].macros[0].name, embedded.name);
            assert_eq!(
                serde_json::to_value(&parsed.profiles[0].macros[0]).unwrap(),
                serde_json::to_value(&embedded).unwrap()
            );
            assert_eq!(
                parsed
                    .warnings
                    .iter()
                    .any(|w| w.code == "macro_xml_budget_exceeded"),
                !fits
            );
            assert_eq!(
                parsed
                    .warnings
                    .iter()
                    .any(|w| w.code == "macro_reference_missing"),
                !fits
            );
        }
    }

    fn warn(code: &str, message: &str) -> ImportWarning {
        ImportWarning::new(code, message.to_string())
    }

    #[test]
    fn empty_guid_does_not_suppress_unrelated_warnings() {
        // Regression for F007: a resolved set containing an empty GUID must NOT
        // strip warnings for genuinely-unresolved macros.
        let mut warnings = vec![
            warn(
                "macro_reference_missing",
                "Binding references missing macro {ABC-123}.",
            ),
            warn("other_warning", "unrelated"),
        ];
        let guids = [String::new()]; // empty GUID from a malformed sibling XML
        strip_resolved_missing_macro_warnings(&mut warnings, guids.iter());
        assert_eq!(
            warnings.len(),
            2,
            "empty GUID must not suppress unrelated macro_reference_missing warnings"
        );
        assert!(warnings.iter().any(|w| w.code == "macro_reference_missing"));
    }

    #[test]
    fn matching_guid_strips_only_resolved_warning() {
        let mut warnings = vec![
            warn(
                "macro_reference_missing",
                "Binding references missing macro {ABC-123}.",
            ),
            warn(
                "macro_reference_missing",
                "Binding references missing macro {DEF-456}.",
            ),
        ];
        let guids = ["{ABC-123}".to_string()];
        strip_resolved_missing_macro_warnings(&mut warnings, guids.iter());
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].message.contains("{DEF-456}"),
            "only the resolved-GUID warning should be stripped"
        );
    }
}
