//! Shared macro-event → `Send`/`Sleep` step builder.
//!
//! Synapse v3, v4 (JSON payloads), and the standalone `.xml` macro files all
//! encode keyboard macros as a stream of key down/up events plus inter-event
//! delays. They differ only in their *input* shapes; the pairing logic that
//! folds down/up pairs into discrete keystrokes — and folds held modifiers into
//! a `Ctrl+Shift+Alt+Win+Key` string — is identical. Each format normalizes its
//! events into [`NormalizedEvent`] and calls [`build`]; this is the single
//! source of truth that previously drifted across three hand-maintained copies.

use super::makecode;
use super::mapping::ModifierFlags;
use super::types::{ImportWarning, ParsedSequenceStep};

/// A keyboard macro event normalized across Synapse formats.
pub enum NormalizedEvent {
    /// Inter-event pause, in milliseconds.
    Delay(u32),
    /// A key down or up for the given Windows scancode.
    Key {
        makecode: u16,
        is_extended: bool,
        is_down: bool,
    },
}

/// Walk normalized macro events, pairing key-down with the next key-up so the
/// sequence emits discrete `Send` steps (Sidearm's sequence primitive is full
/// keystrokes, not individual down/up events). Held modifiers are folded into
/// the emitted key string. Overlapping non-modifier holds cannot be expressed
/// as discrete keystrokes, so they are flattened with a `macro_hold_flattened`
/// warning.
pub fn build(
    events: &[NormalizedEvent],
    macro_name: &str,
    warnings: &mut Vec<ImportWarning>,
) -> Vec<ParsedSequenceStep> {
    let mut steps: Vec<ParsedSequenceStep> = Vec::new();
    let mut mods = ModifierFlags::default();
    let mut pending_down: Option<(u16, bool)> = None;

    for event in events {
        match *event {
            NormalizedEvent::Delay(delay_ms) => {
                if delay_ms > 0 {
                    steps.push(ParsedSequenceStep::Sleep { delay_ms });
                }
            }
            NormalizedEvent::Key {
                makecode,
                is_extended,
                is_down,
            } => {
                if is_down {
                    if let Some(canon) = makecode::modifier_canonical(makecode, is_extended) {
                        set_modifier(&mut mods, canon, true);
                    } else if pending_down.is_none() {
                        pending_down = Some((makecode, is_extended));
                    } else {
                        // Overlapping non-modifier downs — emit the first and warn
                        // that simultaneous holds fire as independent keystrokes.
                        let (prev_code, prev_ext) = pending_down.take().unwrap();
                        emit_send(&mut steps, prev_code, prev_ext, mods, macro_name, warnings);
                        pending_down = Some((makecode, is_extended));
                        warnings.push(ImportWarning::new(
                            "macro_hold_flattened",
                            format!(
                                "Macro `{macro_name}` had overlapping key-holds — they will fire as independent keystrokes."
                            ),
                        ));
                    }
                } else if let Some(canon) = makecode::modifier_canonical(makecode, is_extended) {
                    set_modifier(&mut mods, canon, false);
                } else if let Some((code, ext)) = pending_down.take() {
                    emit_send(&mut steps, code, ext, mods, macro_name, warnings);
                }
            }
        }
    }

    // Emit any pending key if the macro ended with a dangling down.
    if let Some((code, ext)) = pending_down {
        emit_send(&mut steps, code, ext, mods, macro_name, warnings);
    }

    steps
}

fn set_modifier(mods: &mut ModifierFlags, canon: &str, value: bool) {
    match canon {
        "Ctrl" => mods.ctrl = value,
        "Shift" => mods.shift = value,
        "Alt" => mods.alt = value,
        "Win" => mods.win = value,
        _ => {}
    }
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
                "unknown_scancode",
                format!(
                    "Macro `{macro_name}` uses unknown scancode 0x{makecode_val:02X} — emitted as a literal."
                ),
            ));
            format!("Scancode(0x{makecode_val:02X})")
        }
    };

    let mut parts: Vec<&str> = Vec::new();
    if mods.ctrl {
        parts.push("Ctrl");
    }
    if mods.shift {
        parts.push("Shift");
    }
    if mods.alt {
        parts.push("Alt");
    }
    if mods.win {
        parts.push("Win");
    }
    let value = if parts.is_empty() {
        key_name
    } else {
        format!("{}+{key_name}", parts.join("+"))
    };

    steps.push(ParsedSequenceStep::Send { value });
}
