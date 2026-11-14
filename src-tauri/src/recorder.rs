#![allow(dead_code)]

use serde::Serialize;

use crate::config::{MAX_SEQUENCE_STEPS, SequenceStep};

const MAX_STEP_DELAY_MS: u32 = 30_000;

/// Typed characters at most this far apart belong to one text step.
const TYPING_GAP_MS: u64 = 1_000;

/// Defence-in-depth bound on stored keystrokes: a typed text is one step but
/// many keys, so the step cap alone does not bound memory.
const MAX_RECORDED_KEYS: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroRecording {
    pub steps: Vec<SequenceStep>,
    pub started_at: u64,
    pub stopped_at: Option<u64>,
}

#[derive(Debug, Default)]
enum RecorderState {
    #[default]
    Idle,
    Recording {
        started_at: u64,
        last_event_at: u64,
        steps: Vec<RecordedEvent>,
        /// How many sequence steps `steps` makes (`convert_to_sequence_steps`).
        step_count: usize,
    },
    Stopped(MacroRecording),
}

#[derive(Debug, Clone)]
struct RecordedEvent {
    /// Key combination string (e.g., "Ctrl+C", "F13", "A")
    key: String,
    /// The character the key typed in the active layout (`event.key`), for a
    /// printable key pressed without Ctrl/Alt/Win; None for chords and special keys.
    text: Option<String>,
    /// Timestamp in milliseconds
    timestamp: u64,
}

/// `next` continues the text typed up to `prev`.
fn same_text_run(prev: &RecordedEvent, next: &RecordedEvent) -> bool {
    prev.text.is_some()
        && next.text.is_some()
        && next.timestamp.saturating_sub(prev.timestamp) <= TYPING_GAP_MS
}

#[derive(Debug, Default)]
pub struct MacroRecorder {
    state: Option<RecorderState>,
}

impl MacroRecorder {
    pub fn new() -> Self {
        Self {
            state: Some(RecorderState::Idle),
        }
    }

    /// Start recording. Returns error if already recording.
    pub fn start(&mut self, now: u64) -> Result<(), String> {
        match &self.state {
            Some(RecorderState::Idle) | Some(RecorderState::Stopped(_)) | None => {
                self.state = Some(RecorderState::Recording {
                    started_at: now,
                    last_event_at: now,
                    steps: Vec::new(),
                    step_count: 0,
                });
                Ok(())
            }
            Some(RecorderState::Recording { .. }) => Err("Already recording.".into()),
        }
    }

    /// Record a keystroke. The `key` is a formatted string like "Ctrl+C" or "F13";
    /// `text` is the character it typed (a printable key without Ctrl/Alt/Win).
    /// Returns how many steps the recording makes so far. Silently drops a key
    /// that would start a step past `MAX_SEQUENCE_STEPS` (or past
    /// `MAX_RECORDED_KEYS` keys) so a runaway recording can't grow unboundedly.
    pub fn record_keystroke(&mut self, key: String, text: Option<String>, now: u64) -> usize {
        let Some(RecorderState::Recording {
            last_event_at,
            steps,
            step_count,
            ..
        }) = &mut self.state
        else {
            return 0;
        };
        let event = RecordedEvent {
            key,
            text: text.filter(|text| !text.is_empty() && !text.contains('\0')),
            timestamp: now,
        };
        let new_step = steps.last().is_none_or(|prev| !same_text_run(prev, &event));
        if steps.len() >= MAX_RECORDED_KEYS || (new_step && *step_count >= MAX_SEQUENCE_STEPS) {
            return *step_count;
        }
        steps.push(event);
        *step_count += usize::from(new_step);
        *last_event_at = now;
        *step_count
    }

    /// Stop recording and produce the MacroRecording.
    pub fn stop(&mut self, now: u64) -> Result<MacroRecording, String> {
        match self.state.take() {
            Some(RecorderState::Recording {
                started_at, steps, ..
            }) => {
                let sequence_steps = convert_to_sequence_steps(&steps);
                let recording = MacroRecording {
                    steps: sequence_steps,
                    started_at,
                    stopped_at: Some(now),
                };
                self.state = Some(RecorderState::Stopped(recording.clone()));
                Ok(recording)
            }
            other => {
                self.state = other;
                Err("Not currently recording.".into())
            }
        }
    }

    /// Get the last recording (if any).
    pub fn last_recording(&self) -> Option<&MacroRecording> {
        match &self.state {
            Some(RecorderState::Stopped(recording)) => Some(recording),
            _ => None,
        }
    }

    pub fn is_recording(&self) -> bool {
        matches!(&self.state, Some(RecorderState::Recording { .. }))
    }
}

/// One step per key, except that characters typed close together become one
/// Text step with what they typed (in any layout). A lone typed key stays a
/// key press: a game or a one-key shortcut wants the key, not a character.
fn convert_to_sequence_steps(events: &[RecordedEvent]) -> Vec<SequenceStep> {
    let runs: Vec<&[RecordedEvent]> = events.chunk_by(same_text_run).collect();
    runs.iter()
        .enumerate()
        .map(|(i, run)| {
            let last = &run[run.len() - 1];
            // A step waits after its input, so each step owns the gap before the next.
            let delay_ms = runs.get(i + 1).and_then(|next| {
                let delta = next[0].timestamp.saturating_sub(last.timestamp);
                let capped = delta.min(MAX_STEP_DELAY_MS as u64) as u32;
                (capped > 0).then_some(capped)
            });
            if run.len() > 1 {
                SequenceStep::Text {
                    value: literal_text(run.iter().filter_map(|event| event.text.as_deref()).collect()),
                    delay_ms,
                    repeat: None,
                }
            } else {
                SequenceStep::Send {
                    value: run[0].key.clone(),
                    delay_ms,
                    repeat: None,
                }
            }
        })
        .collect()
}

/// Typed text is sent as typed: braces that would form a snippet token
/// (`{date}`…) or an input field (`{input:…}`) are escaped, other text is left
/// alone (it is sent verbatim).
fn literal_text(text: String) -> String {
    if crate::input_synthesis::has_snippet_token(&text) || text.contains("{input:") {
        text.replace('{', "{{").replace('}', "}}")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_at_and_beyond_save_limit_is_saveable() {
        use crate::config::{Action, ActionPayload, ActionType, SequenceActionPayload};
        for count in [200, 201, 1000] {
            let mut recorder = MacroRecorder::new();
            recorder.start(0).unwrap();
            for i in 0..count { recorder.record_keystroke("A".into(), None, i); }
            let recording = recorder.stop(count).unwrap();
            assert_eq!(recording.steps.len(), 200, "recorded {count} inputs");
            let mut config = crate::config::default_seed_config();
            config.actions.push(Action {
                id: "recorded-sequence".into(), action_type: ActionType::Sequence,
                display_name: "Recorded".into(), notes: None, conditions: Vec::new(),
                payload: ActionPayload::Sequence(SequenceActionPayload { steps: recording.steps }),
            });
            let dir = tempfile::tempdir().unwrap();
            crate::config::save_config(dir.path(), config, None).unwrap();
        }
    }

    #[test]
    fn starts_and_stops_recording() {
        let mut recorder = MacroRecorder::new();
        assert!(!recorder.is_recording());

        recorder.start(1000).unwrap();
        assert!(recorder.is_recording());

        let recording = recorder.stop(2000).unwrap();
        assert!(!recorder.is_recording());
        assert_eq!(recording.started_at, 1000);
        assert_eq!(recording.stopped_at, Some(2000));
        assert!(recording.steps.is_empty());
    }

    #[test]
    fn records_single_keystroke() {
        let mut recorder = MacroRecorder::new();
        recorder.start(1000).unwrap();
        recorder.record_keystroke("F13".into(), None, 1100);
        let recording = recorder.stop(1200).unwrap();

        assert_eq!(recording.steps.len(), 1);
        match &recording.steps[0] {
            SequenceStep::Send {
                value, delay_ms, ..
            } => {
                assert_eq!(value, "F13");
                assert_eq!(*delay_ms, None); // no trailing delay
            }
            _ => panic!("Expected Send step"),
        }
    }

    #[test]
    fn records_multiple_keystrokes_with_timing() {
        let mut recorder = MacroRecorder::new();
        recorder.start(1000).unwrap();
        recorder.record_keystroke("Ctrl+C".into(), None, 1000);
        recorder.record_keystroke("Ctrl+V".into(), None, 3000);
        recorder.record_keystroke("Enter".into(), None, 3100);
        let recording = recorder.stop(4000).unwrap();

        assert_eq!(recording.steps.len(), 3);
        // Wait after Copy, before Paste.
        match &recording.steps[0] {
            SequenceStep::Send {
                value, delay_ms, ..
            } => {
                assert_eq!(value, "Ctrl+C");
                assert_eq!(*delay_ms, Some(2000));
            }
            _ => panic!("Expected Send step"),
        }
        // Wait after Paste, before Enter.
        match &recording.steps[1] {
            SequenceStep::Send {
                value, delay_ms, ..
            } => {
                assert_eq!(value, "Ctrl+V");
                assert_eq!(*delay_ms, Some(100));
            }
            _ => panic!("Expected Send step"),
        }
        // No trailing pause after the final input.
        match &recording.steps[2] {
            SequenceStep::Send {
                value, delay_ms, ..
            } => {
                assert_eq!(value, "Enter");
                assert_eq!(*delay_ms, None);
            }
            _ => panic!("Expected Send step"),
        }
    }

    #[test]
    fn caps_delay_at_30_seconds() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        recorder.record_keystroke("A".into(), None, 0);
        recorder.record_keystroke("B".into(), None, 60_000); // 60s gap
        let recording = recorder.stop(60_001).unwrap();

        match &recording.steps[0] {
            SequenceStep::Send { delay_ms, .. } => {
                assert_eq!(*delay_ms, Some(30_000)); // capped
            }
            _ => panic!("Expected Send step"),
        }
    }

    fn typed(recorder: &mut MacroRecorder, key: &str, text: &str, now: u64) -> usize {
        recorder.record_keystroke(key.into(), Some(text.into()), now)
    }

    fn send(value: &str, delay_ms: Option<u32>) -> SequenceStep {
        SequenceStep::Send { value: value.into(), delay_ms, repeat: None }
    }

    fn text(value: &str, delay_ms: Option<u32>) -> SequenceStep {
        SequenceStep::Text { value: value.into(), delay_ms, repeat: None }
    }

    #[test]
    fn a_typed_word_is_one_text_step_in_the_layout_it_was_typed_in() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        // "блокнот" on the Russian layout: "б" is the comma key.
        for (i, (key, ch)) in [(",", "б"), ("Л", "л"), ("О", "о"), ("К", "к"), ("Н", "н"), ("О", "о"), ("Т", "т")]
            .into_iter()
            .enumerate()
        {
            assert_eq!(typed(&mut recorder, key, ch, i as u64 * 100), 1);
        }
        assert_eq!(recorder.record_keystroke("Enter".into(), None, 1600), 2);
        assert_eq!(recorder.record_keystroke("Ctrl+L".into(), None, 1700), 3);
        let recording = recorder.stop(2000).unwrap();
        assert_eq!(
            recording.steps,
            vec![text("блокнот", Some(1000)), send("Enter", Some(100)), send("Ctrl+L", None)]
        );
    }

    #[test]
    fn shift_capitals_and_spaces_stay_in_the_text() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        typed(&mut recorder, "Shift+H", "H", 0);
        typed(&mut recorder, "I", "i", 80);
        typed(&mut recorder, "Space", " ", 160);
        typed(&mut recorder, "Shift+1", "!", 240);
        let recording = recorder.stop(1000).unwrap();
        assert_eq!(recording.steps, vec![text("Hi !", None)]);
    }

    #[test]
    fn a_long_pause_or_a_chord_ends_the_text() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        typed(&mut recorder, "A", "a", 0);
        typed(&mut recorder, "B", "b", 100);
        typed(&mut recorder, "C", "c", 100 + TYPING_GAP_MS + 1);
        typed(&mut recorder, "D", "d", 200 + TYPING_GAP_MS);
        recorder.record_keystroke("Ctrl+A".into(), None, 300 + TYPING_GAP_MS);
        typed(&mut recorder, "E", "e", 400 + TYPING_GAP_MS);
        let recording = recorder.stop(5000).unwrap();
        assert_eq!(
            recording.steps,
            vec![
                text("ab", Some(TYPING_GAP_MS as u32 + 1)),
                text("cd", Some(100)),
                send("Ctrl+A", Some(100)),
                // A lone key stays a key press (games, one-key shortcuts).
                send("E", None),
            ]
        );
    }

    #[test]
    fn typed_braces_never_become_a_token() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        for (i, ch) in "{date} a{b".chars().enumerate() {
            typed(&mut recorder, "X", &ch.to_string(), i as u64 * 10);
        }
        let recording = recorder.stop(1000).unwrap();
        assert_eq!(recording.steps, vec![text("{{date}} a{{b", None)]);
        assert_eq!(literal_text("a{b}".into()), "a{b}", "no token: verbatim");
        assert_eq!(literal_text("{input:host}".into()), "{{input:host}}");
    }

    #[test]
    fn the_step_cap_counts_steps_not_keys() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        for i in 0..300u64 {
            assert_eq!(typed(&mut recorder, "A", "a", i), 1);
        }
        for i in 0..250u64 {
            recorder.record_keystroke("Enter".into(), None, 10_000 + i);
        }
        assert_eq!(recorder.record_keystroke("Enter".into(), None, 20_000), MAX_SEQUENCE_STEPS);
        let recording = recorder.stop(30_000).unwrap();
        assert_eq!(recording.steps.len(), MAX_SEQUENCE_STEPS);
        assert!(matches!(&recording.steps[0], SequenceStep::Text { value, .. } if value.len() == 300));
    }

    #[test]
    fn error_on_double_start() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        assert!(recorder.start(100).is_err());
    }

    #[test]
    fn error_on_stop_without_start() {
        let mut recorder = MacroRecorder::new();
        assert!(recorder.stop(0).is_err());
    }

    #[test]
    fn can_restart_after_stop() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        recorder.record_keystroke("A".into(), None, 50);
        recorder.stop(100).unwrap();

        // Start a new recording
        recorder.start(200).unwrap();
        recorder.record_keystroke("B".into(), None, 250);
        let recording = recorder.stop(300).unwrap();

        assert_eq!(recording.steps.len(), 1);
        match &recording.steps[0] {
            SequenceStep::Send { value, .. } => assert_eq!(value, "B"),
            _ => panic!("Expected Send step"),
        }
    }

    #[test]
    fn last_recording_returns_most_recent() {
        let mut recorder = MacroRecorder::new();
        assert!(recorder.last_recording().is_none());

        recorder.start(0).unwrap();
        recorder.record_keystroke("X".into(), None, 50);
        recorder.stop(100).unwrap();

        let last = recorder.last_recording().unwrap();
        assert_eq!(last.steps.len(), 1);
    }

    #[test]
    fn empty_recording_produces_no_steps() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        let recording = recorder.stop(100).unwrap();
        assert!(recording.steps.is_empty());
    }

    #[test]
    fn zero_delay_between_simultaneous_keys_is_none() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        recorder.record_keystroke("A".into(), None, 100);
        recorder.record_keystroke("B".into(), None, 100); // same timestamp
        let recording = recorder.stop(200).unwrap();

        match &recording.steps[0] {
            SequenceStep::Send { delay_ms, .. } => {
                assert_eq!(*delay_ms, None); // zero delay -> None
            }
            _ => panic!("Expected Send step"),
        }
    }
}

// ---------------------------------------------------------------------------
// Property-based edge-case tests — pure recorder logic, NO Win32 / OS calls
// ---------------------------------------------------------------------------
//
// Skipped (outside recorder.rs scope):
//  - capture_active_window / Win32 foreground capture
//  - SendInput / hotkey hooks
//
// All tests use the public API of MacroRecorder plus the private
// convert_to_sequence_steps function (same module).

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Category 1: BOUNDARY
    // -----------------------------------------------------------------------

    proptest! {
        /// Recording N keystrokes must produce min(N, MAX_SEQUENCE_STEPS) steps.
        /// This is the primary cap invariant: the Rust-side hard cap must never be exceeded.
        #[test]
        fn prop_max_steps_cap_never_exceeded(
            count in 0usize..=1100usize,
        ) {
            let mut recorder = MacroRecorder::new();
            recorder.start(0).unwrap();
            for i in 0u64..count as u64 {
                recorder.record_keystroke(format!("K{i}"), None, i * 10);
            }
            let recording = recorder.stop(count as u64 * 10 + 1).unwrap();
            prop_assert!(
                recording.steps.len() <= MAX_SEQUENCE_STEPS,
                "steps.len()={} must be ≤ MAX_SEQUENCE_STEPS={}",
                recording.steps.len(), MAX_SEQUENCE_STEPS
            );
            let expected_len = count.min(MAX_SEQUENCE_STEPS);
            prop_assert_eq!(
                recording.steps.len(), expected_len,
                "expected exactly min({}, {}) steps", count, MAX_SEQUENCE_STEPS
            );
        }

        /// Any delay between two consecutive keystrokes must be capped at
        /// MAX_STEP_DELAY_MS and never exceed it regardless of the gap.
        #[test]
        fn prop_delay_cap_never_exceeded(
            gap_ms in 0u64..=600_000u64, // up to 10 minutes
        ) {
            let mut recorder = MacroRecorder::new();
            recorder.start(0).unwrap();
            recorder.record_keystroke("A".into(), None, 0);
            recorder.record_keystroke("B".into(), None, gap_ms);
            let recording = recorder.stop(gap_ms + 1).unwrap();

            let SequenceStep::Send { delay_ms, .. } = &recording.steps[0] else {
                panic!("expected Send step");
            };
            let expected = if gap_ms == 0 { None } else {
                Some(gap_ms.min(u64::from(MAX_STEP_DELAY_MS)) as u32)
            };
            prop_assert_eq!(*delay_ms, expected);
        }

        /// Zero-gap events (same timestamp) must produce delay_ms = None, not Some(0).
        #[test]
        fn prop_zero_gap_produces_none_delay(
            ts in 0u64..=u64::MAX / 2,
        ) {
            let mut recorder = MacroRecorder::new();
            recorder.start(0).unwrap();
            recorder.record_keystroke("A".into(), None, ts);
            recorder.record_keystroke("B".into(), None, ts); // same timestamp
            let recording = recorder.stop(ts + 1).unwrap();

            if let SequenceStep::Send { delay_ms, .. } = &recording.steps[0] {
                prop_assert_eq!(*delay_ms, None, "zero-gap must produce None delay");
            }
        }

        /// A single input has no trailing delay, regardless of the start timestamp.
        #[test]
        fn prop_single_step_has_no_trailing_delay(
            start_ts in 0u64..=u64::MAX / 2,
            key_ts in 0u64..=u64::MAX / 2,
        ) {
            let mut recorder = MacroRecorder::new();
            recorder.start(start_ts).unwrap();
            // key_ts could be before or after start_ts; recorder doesn't validate ordering
            recorder.record_keystroke("X".into(), None, key_ts);
            let recording = recorder.stop(key_ts.saturating_add(1)).unwrap();
            if let SequenceStep::Send { delay_ms, .. } = &recording.steps[0] {
                prop_assert_eq!(*delay_ms, None, "single input must have no trailing delay");
            }
        }
    }

    // -----------------------------------------------------------------------
    // Category 2: NULL & EMPTY
    // -----------------------------------------------------------------------

    #[test]
    fn unit_start_stop_empty_produces_no_steps() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        let recording = recorder.stop(100).unwrap();
        assert!(
            recording.steps.is_empty(),
            "empty recording must have no steps"
        );
        assert_eq!(recording.started_at, 0);
        assert_eq!(recording.stopped_at, Some(100));
    }

    #[test]
    fn unit_no_keystrokes_while_idle_noop() {
        let mut recorder = MacroRecorder::new();
        // record_keystroke while Idle (not recording) must silently do nothing
        recorder.record_keystroke("X".into(), None, 100);
        assert!(!recorder.is_recording(), "recorder must still be Idle");
        assert!(recorder.last_recording().is_none());
    }

    #[test]
    fn unit_stop_while_idle_returns_err() {
        let mut recorder = MacroRecorder::new();
        assert!(
            recorder.stop(100).is_err(),
            "stop without start must return Err"
        );
    }

    #[test]
    fn unit_double_start_returns_err() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        assert!(recorder.start(10).is_err(), "second start must return Err");
    }

    #[test]
    fn unit_last_recording_none_before_any_stop() {
        let mut recorder = MacroRecorder::new();
        assert!(recorder.last_recording().is_none());
        recorder.start(0).unwrap();
        assert!(recorder.last_recording().is_none());
    }

    // -----------------------------------------------------------------------
    // Category 3: OVERFLOW
    // -----------------------------------------------------------------------

    /// Verify that the delay computation uses saturating_sub:
    /// a timestamp that wraps (later < earlier) must produce 0, not underflow.
    #[test]
    fn unit_delay_saturating_sub_no_underflow() {
        // We can test convert_to_sequence_steps directly since it's in the same module
        let events = vec![
            RecordedEvent { text: None,
                key: "A".into(),
                timestamp: 1000,
            },
            RecordedEvent { text: None,
                key: "B".into(),
                timestamp: 0,
            }, // earlier timestamp (pathological)
        ];
        let steps = convert_to_sequence_steps(&events);
        // saturating_sub(0, 1000) = 0 → capped = 0 → delay_ms = None
        match &steps[0] {
            SequenceStep::Send { delay_ms, .. } => {
                assert_eq!(
                    *delay_ms, None,
                    "backward timestamp must produce None delay (saturating_sub prevents underflow)"
                );
            }
            _ => panic!("expected Send step"),
        }
    }

    proptest! {
        /// No timestamp combination must cause a panic in convert_to_sequence_steps.
        /// Exercises the saturating_sub + min cap pipeline with arbitrary u64 values.
        #[test]
        fn prop_convert_steps_no_panic_arbitrary_timestamps(
            t0 in any::<u64>(),
            t1 in any::<u64>(),
            t2 in any::<u64>(),
        ) {
            let events = vec![
                RecordedEvent { text: None, key: "A".into(), timestamp: t0 },
                RecordedEvent { text: None, key: "B".into(), timestamp: t1 },
                RecordedEvent { text: None, key: "C".into(), timestamp: t2 },
            ];
            // Must not panic; delay caps must be respected
            let steps = convert_to_sequence_steps(&events);
            prop_assert_eq!(steps.len(), 3);
            for step in &steps {
                if let SequenceStep::Send { delay_ms: Some(d), .. } = step {
                    prop_assert!(*d <= MAX_STEP_DELAY_MS,
                        "delay {} must not exceed MAX_STEP_DELAY_MS={}", d, MAX_STEP_DELAY_MS);
                }
            }
        }

        /// At the exact cap boundary (MAX_SEQUENCE_STEPS keystrokes followed
        /// by one more) the extra keystroke must be silently dropped.
        #[test]
        fn prop_cap_at_boundary_exact(extra in 0usize..=10usize) {
            let mut recorder = MacroRecorder::new();
            recorder.start(0).unwrap();
            for i in 0u64..(MAX_SEQUENCE_STEPS + extra) as u64 {
                recorder.record_keystroke(format!("K{i}"), None, i);
            }
            let recording = recorder.stop(10_000_000).unwrap();
            prop_assert_eq!(
                recording.steps.len(), MAX_SEQUENCE_STEPS,
                "steps must be capped at exactly MAX_SEQUENCE_STEPS={}", MAX_SEQUENCE_STEPS
            );
        }
    }

    // -----------------------------------------------------------------------
    // Category 4: CONCURRENCY
    // -----------------------------------------------------------------------
    // MacroRecorder has no interior concurrency — it is a plain &mut self API
    // and explicitly NOT Send (it holds Vec<SequenceStep> which is Send, but
    // the recorder is always used from a single command thread in Tauri).
    // N/A: no shared-state concurrent path to test here without the Tauri runtime.

    // -----------------------------------------------------------------------
    // Category 5: TEMPORAL — timing boundary arithmetic
    // -----------------------------------------------------------------------

    proptest! {
        /// started_at / stopped_at in the recording must reflect the exact values
        /// passed to start() and stop() — no time arithmetic is applied to them.
        #[test]
        fn prop_timestamps_pass_through_unmodified(
            start_ts in 0u64..=u64::MAX / 2,
            stop_ts in 0u64..=u64::MAX / 2,
        ) {
            let mut recorder = MacroRecorder::new();
            recorder.start(start_ts).unwrap();
            let recording = recorder.stop(stop_ts).unwrap();
            prop_assert_eq!(recording.started_at, start_ts);
            prop_assert_eq!(recording.stopped_at, Some(stop_ts));
        }

        /// MAX_STEP_DELAY_MS cap must survive the extreme delay of
        /// (u64::MAX - 1) → 1 (near-overflow range).
        #[test]
        fn prop_delay_cap_near_u64_max(
            t0 in 0u64..=1_000u64,
            t1 in (u64::MAX - 1_000)..=u64::MAX,
        ) {
            let events = vec![
                RecordedEvent { text: None, key: "A".into(), timestamp: t0 },
                RecordedEvent { text: None, key: "B".into(), timestamp: t1 },
            ];
            let steps = convert_to_sequence_steps(&events);
            let SequenceStep::Send { delay_ms, .. } = &steps[0] else {
                panic!("expected Send step");
            };
            prop_assert_eq!(*delay_ms, Some(MAX_STEP_DELAY_MS),
                "near-overflow gap must be capped at MAX_STEP_DELAY_MS");
        }
    }
}
