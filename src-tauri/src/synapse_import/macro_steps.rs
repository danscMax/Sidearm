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

/// Upper bound on a single imported macro delay. Synapse stores delays as raw
/// milliseconds (v3/xml `<Delay>`) or seconds (v4/xml `<Number>`); a crafted or
/// fat-fingered value (e.g. `4294967` s ≈ 49 days) would otherwise be persisted
/// verbatim into a `Sleep` step and hang the runtime when the macro fires. Cap
/// each step so an import can never produce a multi-minute stall.
const MAX_MACRO_DELAY_MS: u32 = 60_000; // 60 s

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
                    let clamped = delay_ms.min(MAX_MACRO_DELAY_MS);
                    if clamped != delay_ms {
                        warnings.push(ImportWarning::new(
                            "macro_delay_clamped",
                            format!(
                                "Macro `{macro_name}` had a {delay_ms} ms delay — clamped to {MAX_MACRO_DELAY_MS} ms."
                            ),
                        ));
                    }
                    steps.push(ParsedSequenceStep::Sleep { delay_ms: clamped });
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

    let value =
        super::types::format_chord(mods.ctrl, mods.shift, mods.alt, mods.win, &key_name, || {
            key_name.clone()
        });

    steps.push(ParsedSequenceStep::Send { value });
}

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Boundary: empty event list → empty steps
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_empty_events_produce_no_steps() {
        let mut w = Vec::new();
        let steps = build(&[], "test", &mut w);
        assert!(steps.is_empty());
        assert!(w.is_empty());
    }

    // -----------------------------------------------------------------------
    // Boundary: single delay of 0 is dropped
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_zero_delay_is_dropped() {
        let events = vec![NormalizedEvent::Delay(0)];
        let mut w = Vec::new();
        let steps = build(&events, "m", &mut w);
        assert!(steps.is_empty(), "zero-delay must be dropped");
    }

    // -----------------------------------------------------------------------
    // Boundary: single key with no matching up → dangling down is emitted
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_dangling_key_down_is_emitted() {
        let events = vec![
            NormalizedEvent::Key {
                makecode: 0x1E,
                is_extended: false,
                is_down: true,
            }, // A down
        ];
        let mut w = Vec::new();
        let steps = build(&events, "m", &mut w);
        // The pending key must be flushed at end-of-stream.
        assert!(!steps.is_empty(), "dangling down must be flushed");
    }

    // -----------------------------------------------------------------------
    // Boundary: delay=1 and delay=u32::MAX are both emitted as Sleep steps
    // -----------------------------------------------------------------------

    #[test]
    fn boundary_delay_min_and_max() {
        // A small delay passes through unchanged, no warning.
        let mut w = Vec::new();
        let steps = build(&[NormalizedEvent::Delay(1)], "m", &mut w);
        assert_eq!(steps.len(), 1);
        assert!(matches!(&steps[0], ParsedSequenceStep::Sleep { delay_ms } if *delay_ms == 1));
        assert!(w.is_empty());

        // An absurd delay is clamped to the ceiling with a `macro_delay_clamped`
        // warning, so an imported macro can never stall the runtime for minutes.
        let mut w = Vec::new();
        let steps = build(&[NormalizedEvent::Delay(u32::MAX)], "m", &mut w);
        assert_eq!(steps.len(), 1);
        assert!(
            matches!(&steps[0], ParsedSequenceStep::Sleep { delay_ms } if *delay_ms == MAX_MACRO_DELAY_MS)
        );
        assert!(w.iter().any(|x| x.code == "macro_delay_clamped"));
    }

    // -----------------------------------------------------------------------
    // Null & empty: only key-ups (no downs) → no steps, no panic
    // -----------------------------------------------------------------------

    #[test]
    fn null_only_key_ups_produce_no_steps() {
        let events: Vec<NormalizedEvent> = (0..10)
            .map(|i| NormalizedEvent::Key {
                makecode: 0x10 + i,
                is_extended: false,
                is_down: false,
            })
            .collect();
        let mut w = Vec::new();
        let steps = build(&events, "up-only", &mut w);
        assert!(steps.is_empty());
    }

    // -----------------------------------------------------------------------
    // Overflow: 10 000 delays — output is bounded by input count
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_many_delays_bounded_output() {
        let events: Vec<NormalizedEvent> =
            (0..10_000).map(|_| NormalizedEvent::Delay(50)).collect();
        let mut w = Vec::new();
        let steps = build(&events, "flood", &mut w);
        assert_eq!(steps.len(), 10_000);
    }

    // -----------------------------------------------------------------------
    // Overflow: u32::MAX delay value does not cause arithmetic panic
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_u32_max_delay_is_safe() {
        let events = vec![NormalizedEvent::Delay(u32::MAX)];
        let mut w = Vec::new();
        let steps = build(&events, "maxdelay", &mut w);
        assert_eq!(steps.len(), 1);
    }

    // -----------------------------------------------------------------------
    // Invariant: all modifier codes produce no Send step (they fold into flags)
    // -----------------------------------------------------------------------

    #[test]
    fn null_modifier_only_events_produce_no_send() {
        // LeftCtrl=0x1D, LeftShift=0x2A, LeftAlt=0x38, LeftWin=0x5B ext
        let modifier_pairs: &[(u16, bool)] = &[
            (0x1D, false), // LeftCtrl
            (0x2A, false), // LeftShift
            (0x38, false), // LeftAlt
            (0x5B, true),  // LeftWin (extended)
        ];
        for &(code, ext) in modifier_pairs {
            let events = vec![
                NormalizedEvent::Key {
                    makecode: code,
                    is_extended: ext,
                    is_down: true,
                },
                NormalizedEvent::Key {
                    makecode: code,
                    is_extended: ext,
                    is_down: false,
                },
            ];
            let mut w = Vec::new();
            let steps = build(&events, "mod-test", &mut w);
            assert!(
                steps.is_empty(),
                "modifier-only events should not produce Send steps, code=0x{code:02X} ext={ext}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Invariant: overlapping non-modifier keys emit a warning
    // -----------------------------------------------------------------------

    #[test]
    fn overflow_overlapping_keys_emit_warning() {
        // Two key-downs without intervening key-ups triggers the "overlapping" path.
        let events = vec![
            NormalizedEvent::Key {
                makecode: 0x1E,
                is_extended: false,
                is_down: true,
            }, // A
            NormalizedEvent::Key {
                makecode: 0x30,
                is_extended: false,
                is_down: true,
            }, // B
            NormalizedEvent::Key {
                makecode: 0x30,
                is_extended: false,
                is_down: false,
            },
            NormalizedEvent::Key {
                makecode: 0x1E,
                is_extended: false,
                is_down: false,
            },
        ];
        let mut w = Vec::new();
        let _ = build(&events, "overlap", &mut w);
        assert!(
            w.iter().any(|x| x.code == "macro_hold_flattened"),
            "expected macro_hold_flattened warning"
        );
    }

    // -----------------------------------------------------------------------
    // Property: build never panics on arbitrary event sequences
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn prop_build_never_panics(
            // Random mix of delays and key events.
            delays in prop::collection::vec(any::<u32>(), 0..200),
            codes in prop::collection::vec(any::<u16>(), 0..200),
            extended_flags in prop::collection::vec(any::<bool>(), 0..200),
            down_flags in prop::collection::vec(any::<bool>(), 0..200),
        ) {
            let len = delays.len().min(codes.len()).min(extended_flags.len()).min(down_flags.len());
            let mut events = Vec::with_capacity(len * 2);
            for i in 0..len {
                events.push(NormalizedEvent::Delay(delays[i]));
                events.push(NormalizedEvent::Key {
                    makecode: codes[i],
                    is_extended: extended_flags[i],
                    is_down: down_flags[i],
                });
            }
            let mut w = Vec::new();
            let _ = build(&events, "prop-test", &mut w);
        }

        // Invariant: output length ≤ number of input events + 1 (pending flush).
        // Uses parallel vectors to avoid requiring Debug/Clone on NormalizedEvent.
        #[test]
        fn prop_output_bounded_by_input(
            // is_delay: true = Delay event, false = Key event
            is_delays in prop::collection::vec(any::<bool>(), 0..500),
            delays   in prop::collection::vec(any::<u32>(),  0..500),
            codes    in prop::collection::vec(any::<u16>(),  0..500),
            exts     in prop::collection::vec(any::<bool>(), 0..500),
            downs    in prop::collection::vec(any::<bool>(), 0..500),
        ) {
            let n = is_delays.len()
                .min(delays.len())
                .min(codes.len())
                .min(exts.len())
                .min(downs.len());
            let mut events: Vec<NormalizedEvent> = Vec::with_capacity(n);
            let mut n_key = 0usize;
            let mut n_delay = 0usize;
            for i in 0..n {
                if is_delays[i] {
                    events.push(NormalizedEvent::Delay(delays[i]));
                    n_delay += 1;
                } else {
                    events.push(NormalizedEvent::Key {
                        makecode: codes[i],
                        is_extended: exts[i],
                        is_down: downs[i],
                    });
                    n_key += 1;
                }
            }
            let mut w = Vec::new();
            let steps = build(&events, "bound-test", &mut w);
            // Each step is either a Send (from a key event) or a Sleep (from a Delay).
            // Upper bound: one step per input event + 1 for the pending-down flush.
            assert!(steps.len() <= n_key + n_delay + 1);
        }
    }

    // Concurrency: N/A — build() takes only immutable slices and owned Vecs.
    // Temporal: delay values are u32 milliseconds; values above MAX_MACRO_DELAY_MS
    // are clamped (see boundary_delay_min_and_max).
}
