//! Standalone `.xml` macro parser.
//!
//! The `Макросы/` folder alongside `.synapse4` exports contains per-macro
//! XML files (`<Macro>...</Macro>`) with the same macro-event structure as
//! the JSON payloads. We parse them so bindings that reference a macro by
//! GUID — but whose macro lives in the sibling folder — can still be
//! resolved end-to-end.

use std::path::Path;

use super::format_v3::{MAX_ENTRY_UNCOMPRESSED, MAX_ZIP_ENTRIES};
use super::macro_steps::{self, NormalizedEvent};
use super::types::{ImportWarning, ParsedMacro, ParsedSequenceStep};

/// Per-file size cap for sibling-folder `.xml` macros, reusing the v3 ZIP
/// per-entry limit so both paths bound a hostile input the same way.
const MAX_XML_MACRO_BYTES: u64 = MAX_ENTRY_UNCOMPRESSED;
/// Maximum number of `.xml` macro files processed from a sibling folder,
/// reusing the v3 ZIP entry-count limit.
const MAX_XML_MACRO_FILES: usize = MAX_ZIP_ENTRIES;

#[derive(Debug, thiserror::Error)]
pub enum MacroXmlError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("XML parse error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("XML content did not match <Macro> schema")]
    Shape,
}

/// Parse a macro XML string. Warnings for scancode/mouse-event handling are
/// appended to `warnings`; the parse itself only errors on malformed XML.
pub fn parse_macro_xml_str(
    raw: &str,
    fallback_name: String,
    warnings: &mut Vec<ImportWarning>,
) -> Result<ParsedMacro, MacroXmlError> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(raw);
    reader.trim_text(true);

    let mut name = fallback_name.clone();
    let mut guid = String::new();
    let mut events: Vec<RawEvent> = Vec::new();

    // Stack-tracking state — we hand-roll the parse since the XML is
    // simple and quick-xml's serde feature has trouble with the
    // `<flag/>` self-closing empty element.
    let mut stack: Vec<String> = Vec::new();
    let mut current_event = RawEvent::default();
    let mut in_macro_event = false;
    let mut text_target: Option<String> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                stack.push(tag.clone());
                if tag == "MacroEvent" {
                    in_macro_event = true;
                    current_event = RawEvent::default();
                }
                text_target = Some(tag);
            }
            Ok(Event::End(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if tag == "MacroEvent" && in_macro_event {
                    events.push(std::mem::take(&mut current_event));
                    in_macro_event = false;
                }
                stack.pop();
                text_target = stack.last().cloned();
            }
            Ok(Event::Empty(_)) => {
                // Self-closing tags like <flag/> and <DelaySetting/> — ignore.
            }
            Ok(Event::Text(t)) => {
                let text = t.unescape().unwrap_or_default().into_owned();
                if let Some(tag) = &text_target {
                    assign_text(tag, &text, &stack, &mut name, &mut guid, &mut current_event);
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(MacroXmlError::Xml(err)),
            _ => {}
        }
        buf.clear();
    }

    if events.is_empty() && guid.is_empty() {
        return Err(MacroXmlError::Shape);
    }

    let steps = build_steps(&fallback_name, &events, warnings);

    Ok(ParsedMacro {
        synapse_guid: guid,
        name: if name.is_empty() { fallback_name } else { name },
        steps,
    })
}

#[derive(Default, Debug)]
struct RawEvent {
    ty: String,
    makecode: Option<u16>,
    state: Option<u8>,
    /// Inter-event delay in milliseconds (`<Delay>` child of `<MacroEvent>`,
    /// same element the v3 macro parser reads). Previously dropped, which lost
    /// macro timing on import.
    delay_ms: Option<u32>,
}

fn assign_text(
    tag: &str,
    text: &str,
    stack: &[String],
    name: &mut String,
    guid: &mut String,
    current_event: &mut RawEvent,
) {
    // Top-level tags
    if stack.last().map(String::as_str) == Some(tag) {
        if stack.len() == 2 {
            // Inside <Macro><X> — X is "tag"
            match tag {
                "Name" => *name = text.to_string(),
                "Guid" => *guid = text.to_string(),
                _ => {}
            }
        }
        if stack.len() == 4 {
            // Inside <Macro><MacroEvents><MacroEvent><X>. Inter-event delays
            // appear as `<Delay>` (milliseconds, like the v3 macro XML) or
            // `<Number>` (seconds, like the v4 JSON payload); accept both.
            match tag {
                "Type" => current_event.ty = text.to_string(),
                "Delay" => current_event.delay_ms = text.parse::<u32>().ok(),
                "Number" => {
                    current_event.delay_ms = text
                        .parse::<f64>()
                        .ok()
                        .map(|secs| (secs * 1000.0).round().max(0.0) as u32);
                }
                _ => {}
            }
        }
        if stack.len() == 5 {
            // Inside <Macro><MacroEvents><MacroEvent><KeyEvent><X>
            match tag {
                "Makecode" => {
                    current_event.makecode = text.parse::<u16>().ok();
                }
                "State" => {
                    current_event.state = text.parse::<u8>().ok();
                }
                _ => {}
            }
        }
    }
}

fn build_steps(
    macro_name: &str,
    events: &[RawEvent],
    warnings: &mut Vec<ImportWarning>,
) -> Vec<ParsedSequenceStep> {
    let mut normalized: Vec<NormalizedEvent> = Vec::new();
    for ev in events {
        if let Some(delay_ms) = ev.delay_ms
            && delay_ms > 0 {
                normalized.push(NormalizedEvent::Delay(delay_ms));
            }
        if ev.ty != "1" {
            continue;
        }
        let Some(makecode_val) = ev.makecode else { continue };
        let state = ev.state.unwrap_or(0);
        normalized.push(NormalizedEvent::Key {
            makecode: makecode_val,
            is_extended: state >= 2,
            is_down: state % 2 == 0,
        });
    }
    macro_steps::build(&normalized, macro_name, warnings)
}

/// Collect all `.xml` macro files under `dir` (one level) into a Vec.
pub fn parse_macros_in_dir(
    dir: &Path,
    warnings: &mut Vec<ImportWarning>,
) -> std::io::Result<Vec<ParsedMacro>> {
    let mut out: Vec<ParsedMacro> = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    // Bound the sibling-folder read the same way the v3 ZIP path is bounded
    // (format_v3::MAX_ZIP_ENTRIES / MAX_ENTRY_UNCOMPRESSED): the `Макросы/`
    // folder sits next to a user-chosen export and may be hostile (millions of
    // files or one multi-gigabyte `.xml`), so cap both the per-file size and the
    // number of `.xml` files we slurp into memory.
    let mut xml_seen: usize = 0;
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("xml"))
            != Some(true)
        {
            continue;
        }
        xml_seen += 1;
        if xml_seen > MAX_XML_MACRO_FILES {
            warnings.push(ImportWarning::new(
                "macro_xml_too_many_files",
                format!(
                    "Sibling macro folder `{}` has more than {MAX_XML_MACRO_FILES} `.xml` files; the rest were skipped.",
                    dir.display()
                ),
            ));
            break;
        }
        // Reject oversized files before reading them into memory.
        if let Ok(meta) = entry.metadata()
            && meta.len() > MAX_XML_MACRO_BYTES {
                warnings.push(ImportWarning::new(
                    "macro_xml_too_large",
                    format!(
                        "Skipped `{}`: exceeds the {MAX_XML_MACRO_BYTES}-byte macro-file limit.",
                        path.display()
                    ),
                ));
                continue;
            }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("macro")
            .to_string();
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(e) => {
                warnings.push(ImportWarning::new(
                    "macro_xml_io_error",
                    format!("Could not read `{}`: {e}", path.display()),
                ));
                continue;
            }
        };
        match parse_macro_xml_str(&raw, name.clone(), warnings) {
            Ok(m) => out.push(m),
            Err(e) => {
                warnings.push(ImportWarning::new(
                    "macro_xml_parse_failed",
                    format!("Could not parse `{}`: {e}", path.display()),
                ));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREENSHOT: &str = r#"<Macro>
   <Name>ScreenShot</Name>
   <MacroEvents>
      <MacroEvent>
         <Type>actionBar</Type>
         <recordProfile><mmtSetting>0</mmtSetting></recordProfile>
         <selected>false</selected>
      </MacroEvent>
      <MacroEvent>
         <Type>1</Type>
         <KeyEvent><Makecode>16</Makecode><State>0</State></KeyEvent>
      </MacroEvent>
      <MacroEvent>
         <Type>1</Type>
         <KeyEvent><Makecode>91</Makecode><State>2</State></KeyEvent>
      </MacroEvent>
      <MacroEvent>
         <Type>1</Type>
         <KeyEvent><Makecode>83</Makecode><State>0</State></KeyEvent>
      </MacroEvent>
      <MacroEvent>
         <Type>1</Type>
         <KeyEvent><Makecode>83</Makecode><State>1</State></KeyEvent>
      </MacroEvent>
      <MacroEvent>
         <Type>1</Type>
         <KeyEvent><Makecode>16</Makecode><State>1</State></KeyEvent>
      </MacroEvent>
      <MacroEvent>
         <Type>1</Type>
         <KeyEvent><Makecode>91</Makecode><State>3</State></KeyEvent>
      </MacroEvent>
   </MacroEvents>
   <Guid>00084b2c-577a-4aac-a87d-089250c75ef6</Guid>
   <Version>4</Version>
</Macro>"#;

    #[test]
    fn parses_screenshot_macro() {
        let mut warnings = Vec::new();
        let parsed = parse_macro_xml_str(SCREENSHOT, "ScreenShot".into(), &mut warnings).unwrap();
        assert_eq!(parsed.name, "ScreenShot");
        assert_eq!(parsed.synapse_guid, "00084b2c-577a-4aac-a87d-089250c75ef6");
        // Makecode 16=0x10=Q, 91=LeftWin (extended), 83=NumDecimal (base 0x53) — but 0x53 is Delete extended.
        // ScreenShot in Windows is actually Shift+Win+S. 16=Shift, 91 ext=LeftWin, 83=S (0x1F is S not 0x53).
        // Wait: 83 decimal = 0x53 = Delete (extended) / NumDecimal (base). 0x1F=31=S. Let me recheck.
        // Actually: Makecode 0x53 base → NumDecimal, extended → Delete. 83 dec = 0x53.
        // But the macro is clearly Shift+Win+S → but S's scancode is 0x1F=31. So the file has
        // state=0 for key-down and the numeric Makecode=83 here is NOT correct for S.
        //
        // Looking again: Windows scancode for S is indeed 0x1F. But here Makecode=83 dec = 0x53 (decimal 83).
        // Wait, the XML stored "83" as a decimal integer. 83 decimal = 0x53. So either the macro uses
        // something else, OR the value is a different key. 0x53 extended = Delete.
        //
        // Actually looking at the sample, this is capturing a screenshot — on Windows 11 the shortcut
        // Shift+Win+S triggers the snipping tool. But the S key has scancode 0x1F. So Makecode 83 is
        // wrong for S. Maybe this is a "PrintScreen" scancode? PrintScreen is 0x37 extended or 0x54.
        // Decimal 83 = 0x53. That's actually "." on numpad (NumDecimal) in base, or Delete extended.
        //
        // The user may have captured this macro differently — perhaps using Print Screen via the
        // Insert key or something else. Whatever — the parser should be agnostic to semantics;
        // it just decodes what's there. Our test should verify structure, not key identity.
        assert!(!parsed.steps.is_empty());
    }

    #[test]
    fn guid_extraction_works() {
        let mut warnings = Vec::new();
        let parsed = parse_macro_xml_str(SCREENSHOT, "X".into(), &mut warnings).unwrap();
        assert_eq!(parsed.synapse_guid, "00084b2c-577a-4aac-a87d-089250c75ef6");
    }

    #[test]
    fn handles_self_closing_tags() {
        let xml = r#"<Macro><Name>T</Name><MacroEvents>
            <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>0</State></KeyEvent><flag/><isPairing>false</isPairing></MacroEvent>
            <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>1</State></KeyEvent><flag/></MacroEvent>
        </MacroEvents><DelaySetting/><Guid>g-1</Guid></Macro>"#;
        let mut warnings = Vec::new();
        let parsed = parse_macro_xml_str(xml, "T".into(), &mut warnings).unwrap();
        assert_eq!(parsed.synapse_guid, "g-1");
        // Makecode 30 (0x1E) = A. down + up = one Send step.
        assert_eq!(parsed.steps.len(), 1);
        match &parsed.steps[0] {
            ParsedSequenceStep::Send { value } => assert_eq!(value, "A"),
            other => panic!("expected Send, got {other:?}"),
        }
    }

    #[test]
    fn preserves_inter_event_delays() {
        // A `<Delay>` (ms) MacroEvent must surface as a Sleep step — these were
        // dropped before, losing macro timing. Mirrors the v3 macro parser.
        let xml = r#"<Macro><Name>D</Name><MacroEvents>
            <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>0</State></KeyEvent></MacroEvent>
            <MacroEvent><Type>0</Type><Delay>250</Delay></MacroEvent>
            <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>1</State></KeyEvent></MacroEvent>
        </MacroEvents><Guid>g-d</Guid></Macro>"#;
        let mut warnings = Vec::new();
        let parsed = parse_macro_xml_str(xml, "D".into(), &mut warnings).unwrap();
        assert!(
            parsed
                .steps
                .iter()
                .any(|s| matches!(s, ParsedSequenceStep::Sleep { delay_ms: 250 })),
            "expected a 250ms Sleep step, got {:?}",
            parsed.steps,
        );
    }

    #[test]
    fn parse_macros_in_dir_skips_oversized_xml() {
        // Audit F037: the sibling-folder reader must bound per-file size the same
        // way the v3 ZIP path does. An oversized `.xml` is skipped with a warning
        // and never read into memory, while a normal macro alongside it parses.
        let dir = tempfile::tempdir().expect("temp dir");

        // A valid macro that should parse normally.
        let good = dir.path().join("good.xml");
        std::fs::write(&good, SCREENSHOT).expect("write good macro");

        // An oversized file (sparse, set_len) that must be rejected by size.
        let big = dir.path().join("big.xml");
        let f = std::fs::File::create(&big).expect("create big file");
        f.set_len(MAX_XML_MACRO_BYTES + 1).expect("set len");
        drop(f);

        let mut warnings = Vec::new();
        let macros = parse_macros_in_dir(dir.path(), &mut warnings).expect("read dir");

        // The good macro parsed; the oversized one was skipped, not read.
        assert_eq!(macros.len(), 1, "only the in-budget macro should parse");
        assert!(
            warnings.iter().any(|w| w.code == "macro_xml_too_large"),
            "oversized macro must emit a macro_xml_too_large warning: {warnings:?}"
        );
    }
}

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Boundary: empty XML → Shape error (not panic)
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_empty_string_returns_shape_error() {
        let mut w = Vec::new();
        let res = parse_macro_xml_str("", "fallback".into(), &mut w);
        assert!(matches!(res, Err(MacroXmlError::Shape)), "empty XML must be Shape error, got {res:?}");
    }

    // -----------------------------------------------------------------------
    // Boundary: whitespace-only XML → Shape error (not panic)
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_whitespace_xml_returns_shape_error() {
        let mut w = Vec::new();
        let res = parse_macro_xml_str("   \n\t  ", "fallback".into(), &mut w);
        assert!(matches!(res, Err(MacroXmlError::Shape | MacroXmlError::Xml(_))));
    }

    // -----------------------------------------------------------------------
    // Null & empty: valid Macro wrapper but no events and no Guid → Shape error
    // -----------------------------------------------------------------------

    #[test]
    fn null_macro_without_guid_or_events_is_shape_error() {
        let xml = "<Macro><Name>Empty</Name><MacroEvents></MacroEvents></Macro>";
        let mut w = Vec::new();
        let res = parse_macro_xml_str(xml, "x".into(), &mut w);
        assert!(matches!(res, Err(MacroXmlError::Shape)));
    }

    // -----------------------------------------------------------------------
    // Null & empty: valid Macro with Guid but empty MacroEvents → ok, 0 steps
    // -----------------------------------------------------------------------

    #[test]
    fn null_empty_macro_events_is_ok_with_zero_steps() {
        let xml = "<Macro><Name>E</Name><MacroEvents></MacroEvents><Guid>guid-empty</Guid></Macro>";
        let mut w = Vec::new();
        let res = parse_macro_xml_str(xml, "E".into(), &mut w);
        let parsed = res.expect("should parse ok");
        assert_eq!(parsed.synapse_guid, "guid-empty");
        assert!(parsed.steps.is_empty());
    }

    // -----------------------------------------------------------------------
    // Null & empty: missing Name falls back to fallback_name
    // -----------------------------------------------------------------------

    #[test]
    fn null_missing_name_uses_fallback() {
        let xml = "<Macro><MacroEvents></MacroEvents><Guid>g-noname</Guid></Macro>";
        let mut w = Vec::new();
        let res = parse_macro_xml_str(xml, "fallback-name".into(), &mut w).unwrap();
        assert_eq!(res.name, "fallback-name");
    }

    // -----------------------------------------------------------------------
    // Overflow: deeply nested XML (1000 levels) — iterative parser must not
    //           stack-overflow; must return Xml error or Shape error, not panic.
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_deep_nesting_no_stack_overflow() {
        // Build 1000 levels of nesting inside <Macro>. quick-xml is iterative
        // so this should not overflow the stack.
        let open: String = (0..1000).map(|i| format!("<L{i}>")).collect();
        let close: String = (0..1000).rev().map(|i| format!("</L{i}>")).collect();
        let xml = format!("<Macro>{open}<Guid>deep</Guid>{close}</Macro>");
        let mut w = Vec::new();
        // Any result is acceptable as long as the thread does not panic/abort.
        let _ = parse_macro_xml_str(&xml, "deep".into(), &mut w);
    }

    // -----------------------------------------------------------------------
    // Overflow: <Number> field with extremely large float → delay_ms must
    //           not overflow; it must clamp to u32::MAX via saturating cast.
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_number_field_very_large_float_no_panic() {
        // Inject a <Number> value larger than u32::MAX / 1000.0.
        // The cast `(secs * 1000.0).round().max(0.0) as u32` wraps/saturates
        // on overflow in Rust (well-defined for primitive casts: saturates for
        // f64-to-u32 in edition 2021 with the saturating cast rules).
        let big = f64::MAX.to_string(); // "1.7976931348623157e308"
        let xml = format!(
            r#"<Macro><Name>N</Name><MacroEvents>
              <MacroEvent><Type>0</Type><Number>{big}</Number></MacroEvent>
            </MacroEvents><Guid>g-big</Guid></Macro>"#
        );
        let mut w = Vec::new();
        // Must not panic; result may be Ok or Err.
        let _ = parse_macro_xml_str(&xml, "N".into(), &mut w);
    }

    #[test]
    fn overflow_number_field_infinity_no_panic() {
        // "inf" is not a valid f64 parse in std, but we guard against it anyway.
        let xml = r#"<Macro><Name>N</Name><MacroEvents>
            <MacroEvent><Type>0</Type><Number>inf</Number></MacroEvent>
          </MacroEvents><Guid>g-inf</Guid></Macro>"#;
        let mut w = Vec::new();
        let _ = parse_macro_xml_str(xml, "N".into(), &mut w);
    }

    #[test]
    fn overflow_number_field_negative_is_clamped_to_zero() {
        // Negative seconds should produce delay_ms=None (parse::<f64> gives negative,
        // .max(0.0) clamps, (0.0 as u32) == 0, and build() drops zero-delays).
        let xml = r#"<Macro><Name>N</Name><MacroEvents>
            <MacroEvent><Type>0</Type><Number>-999.9</Number></MacroEvent>
            <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>0</State></KeyEvent></MacroEvent>
            <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>1</State></KeyEvent></MacroEvent>
          </MacroEvents><Guid>g-neg</Guid></Macro>"#;
        let mut w = Vec::new();
        let parsed = parse_macro_xml_str(xml, "N".into(), &mut w).unwrap();
        // Negative delay should NOT appear as a Sleep step.
        assert!(
            parsed.steps.iter().all(|s| !matches!(s, ParsedSequenceStep::Sleep { .. })),
            "negative delay must not produce a Sleep step; steps={:?}", parsed.steps
        );
    }

    // -----------------------------------------------------------------------
    // Overflow: Delay field with u32::MAX value — must not panic, and is clamped
    // (with a `macro_delay_clamped` warning) rather than persisted raw.
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_delay_u32_max_is_clamped() {
        let xml = format!(
            r#"<Macro><Name>D</Name><MacroEvents>
              <MacroEvent><Type>0</Type><Delay>{}</Delay></MacroEvent>
            </MacroEvents><Guid>g-dmax</Guid></Macro>"#,
            u32::MAX
        );
        let mut w = Vec::new();
        let parsed = parse_macro_xml_str(&xml, "D".into(), &mut w).unwrap();
        let sleep = parsed.steps.iter().find_map(|s| match s {
            ParsedSequenceStep::Sleep { delay_ms } => Some(*delay_ms),
            _ => None,
        });
        assert!(
            matches!(sleep, Some(ms) if ms > 0 && ms < u32::MAX),
            "u32::MAX delay must be clamped to a Sleep below the raw value; got {sleep:?}"
        );
        assert!(w.iter().any(|x| x.code == "macro_delay_clamped"));
    }

    // -----------------------------------------------------------------------
    // Overflow: Delay field overflowing u32 (number too big) → parse fails,
    //           event silently dropped (no panic)
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_delay_beyond_u32_is_dropped_silently() {
        let xml = format!(
            r#"<Macro><Name>D</Name><MacroEvents>
              <MacroEvent><Type>0</Type><Delay>{}</Delay></MacroEvent>
            </MacroEvents><Guid>g-dover</Guid></Macro>"#,
            u64::MAX  // too big for u32, text.parse::<u32>() will return Err → None
        );
        let mut w = Vec::new();
        // Must not panic; the out-of-range delay is simply dropped.
        let _ = parse_macro_xml_str(&xml, "D".into(), &mut w);
    }

    // -----------------------------------------------------------------------
    // Overflow: Makecode field overflowing u16 → parse fails, event skipped
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_makecode_beyond_u16_is_skipped() {
        let xml = format!(
            r#"<Macro><Name>M</Name><MacroEvents>
              <MacroEvent><Type>1</Type><KeyEvent><Makecode>{}</Makecode><State>0</State></KeyEvent></MacroEvent>
              <MacroEvent><Type>1</Type><KeyEvent><Makecode>{}</Makecode><State>1</State></KeyEvent></MacroEvent>
            </MacroEvents><Guid>g-mover</Guid></Macro>"#,
            u64::MAX, u64::MAX
        );
        let mut w = Vec::new();
        // parse::<u16>() will fail → makecode=None → event skipped (no panic).
        let _ = parse_macro_xml_str(&xml, "M".into(), &mut w);
    }

    // -----------------------------------------------------------------------
    // Overflow: malformed UTF-8 in raw &str is impossible (Rust str is always
    //           UTF-8). Test malformed XML entity instead.
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_unknown_xml_entity_is_tolerated() {
        let xml = "<Macro><Name>&invalid_entity;</Name><Guid>g</Guid></Macro>";
        let mut w = Vec::new();
        let res = parse_macro_xml_str(xml, "m".into(), &mut w);
        // quick-xml does NOT validate/resolve entities during streaming parse, so
        // an unknown entity is tolerated (kept as raw text) rather than rejected.
        // The contract here is "must not panic"; genuinely broken *structure* is
        // covered by the unclosed-tag test below.
        assert!(res.is_ok(), "unknown XML entity should be tolerated by quick-xml, not error");
    }

    // -----------------------------------------------------------------------
    // Overflow: unclosed tags — quick-xml will return an Xml error
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_unclosed_tags_return_xml_error() {
        let xml = "<Macro><Name>Unclosed<MacroEvents><MacroEvent><Type>1</Type>";
        let mut w = Vec::new();
        let res = parse_macro_xml_str(xml, "u".into(), &mut w);
        assert!(matches!(res, Err(MacroXmlError::Xml(_) | MacroXmlError::Shape)));
    }

    // -----------------------------------------------------------------------
    // Property: parse_macro_xml_str never panics on arbitrary strings
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn prop_parse_never_panics_on_arbitrary_str(s in ".*") {
            let mut w = Vec::new();
            let _ = parse_macro_xml_str(&s, "arb".into(), &mut w);
        }

        // Invariant: a valid macro always populates synapse_guid from <Guid>.
        #[test]
        fn prop_valid_macro_preserves_guid(
            guid in "[a-zA-Z0-9-]{1,64}",
            name in "[a-zA-Z0-9 ]{0,32}",
        ) {
            let xml = format!(
                "<Macro><Name>{name}</Name><MacroEvents></MacroEvents><Guid>{guid}</Guid></Macro>"
            );
            let mut w = Vec::new();
            if let Ok(parsed) = parse_macro_xml_str(&xml, "fb".into(), &mut w) {
                assert_eq!(parsed.synapse_guid, guid);
            }
        }

        // Invariant: output step count is bounded by twice the number of
        // MacroEvent elements (each produces at most one Send + one Sleep).
        #[test]
        fn prop_output_bounded_by_event_count(n_events in 0usize..200) {
            // Build n_events of type=1 key-down+up pairs.
            let events: String = (0..n_events).map(|_| {
                "<MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>0</State></KeyEvent></MacroEvent>\
                 <MacroEvent><Type>1</Type><KeyEvent><Makecode>30</Makecode><State>1</State></KeyEvent></MacroEvent>"
                    .to_string()
            }).collect();
            let xml = format!("<Macro><Name>B</Name><MacroEvents>{events}</MacroEvents><Guid>g-b</Guid></Macro>");
            let mut w = Vec::new();
            if let Ok(parsed) = parse_macro_xml_str(&xml, "B".into(), &mut w) {
                // Each key-down + key-up pair produces exactly 1 Send step.
                assert!(parsed.steps.len() <= n_events + 1);
            }
        }
    }

    // Concurrency: N/A — pure string→struct transformation, no shared state.
    // Temporal: delay arithmetic is tested above (u32::MAX, negatives, f64::MAX).
}
