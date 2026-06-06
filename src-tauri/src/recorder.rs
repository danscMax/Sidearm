#![allow(dead_code)]

use serde::Serialize;

use crate::config::SequenceStep;

const MAX_STEP_DELAY_MS: u32 = 30_000;

/// Hard cap on recorded steps.  The frontend enforces the same limit and shows
/// a live count badge, but a Rust-side cap is a safety net: if the UI cap is
/// bypassed or broken, a stuck recorder could otherwise grow `steps` until
/// process OOM. Same defence-in-depth pattern as the v0.1.15 log channel cap.
const MAX_RECORDED_STEPS: usize = 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroRecording {
    pub steps: Vec<SequenceStep>,
    pub started_at: u64,
    pub stopped_at: Option<u64>,
}

#[derive(Debug)]
#[derive(Default)]
enum RecorderState {
    #[default]
    Idle,
    Recording {
        started_at: u64,
        last_event_at: u64,
        steps: Vec<RecordedEvent>,
    },
    Stopped(MacroRecording),
}

#[derive(Debug, Clone)]
struct RecordedEvent {
    /// Key combination string (e.g., "Ctrl+C", "F13", "A")
    key: String,
    /// Timestamp in milliseconds
    timestamp: u64,
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
                });
                Ok(())
            }
            Some(RecorderState::Recording { .. }) => Err("Already recording.".into()),
        }
    }

    /// Record a keystroke. The `key` is a formatted string like "Ctrl+C" or "F13".
    /// Silently drops events once `MAX_RECORDED_STEPS` is reached so a runaway
    /// recording can't grow unboundedly (defence-in-depth alongside the UI cap).
    pub fn record_keystroke(&mut self, key: String, now: u64) {
        if let Some(RecorderState::Recording {
            last_event_at,
            steps,
            ..
        }) = &mut self.state
        {
            if steps.len() >= MAX_RECORDED_STEPS {
                return;
            }
            steps.push(RecordedEvent {
                key,
                timestamp: now,
            });
            *last_event_at = now;
        }
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

fn convert_to_sequence_steps(events: &[RecordedEvent]) -> Vec<SequenceStep> {
    events
        .iter()
        .enumerate()
        .map(|(i, event)| {
            let delay_ms = if i == 0 {
                None
            } else {
                let delta = event.timestamp.saturating_sub(events[i - 1].timestamp);
                let capped = delta.min(MAX_STEP_DELAY_MS as u64) as u32;
                if capped > 0 {
                    Some(capped)
                } else {
                    None
                }
            };
            SequenceStep::Send {
                value: event.key.clone(),
                delay_ms,
                repeat: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        recorder.record_keystroke("F13".into(), 1100);
        let recording = recorder.stop(1200).unwrap();

        assert_eq!(recording.steps.len(), 1);
        match &recording.steps[0] {
            SequenceStep::Send { value, delay_ms, .. } => {
                assert_eq!(value, "F13");
                assert_eq!(*delay_ms, None); // first step has no delay
            }
            _ => panic!("Expected Send step"),
        }
    }

    #[test]
    fn records_multiple_keystrokes_with_timing() {
        let mut recorder = MacroRecorder::new();
        recorder.start(1000).unwrap();
        recorder.record_keystroke("Ctrl+C".into(), 1000);
        recorder.record_keystroke("Ctrl+V".into(), 1250);
        recorder.record_keystroke("Enter".into(), 1500);
        let recording = recorder.stop(2000).unwrap();

        assert_eq!(recording.steps.len(), 3);
        // First step: no delay
        match &recording.steps[0] {
            SequenceStep::Send { value, delay_ms, .. } => {
                assert_eq!(value, "Ctrl+C");
                assert_eq!(*delay_ms, None);
            }
            _ => panic!("Expected Send step"),
        }
        // Second step: 250ms delay
        match &recording.steps[1] {
            SequenceStep::Send { value, delay_ms, .. } => {
                assert_eq!(value, "Ctrl+V");
                assert_eq!(*delay_ms, Some(250));
            }
            _ => panic!("Expected Send step"),
        }
        // Third step: 250ms delay
        match &recording.steps[2] {
            SequenceStep::Send { value, delay_ms, .. } => {
                assert_eq!(value, "Enter");
                assert_eq!(*delay_ms, Some(250));
            }
            _ => panic!("Expected Send step"),
        }
    }

    #[test]
    fn caps_delay_at_30_seconds() {
        let mut recorder = MacroRecorder::new();
        recorder.start(0).unwrap();
        recorder.record_keystroke("A".into(), 0);
        recorder.record_keystroke("B".into(), 60_000); // 60s gap
        let recording = recorder.stop(60_001).unwrap();

        match &recording.steps[1] {
            SequenceStep::Send { delay_ms, .. } => {
                assert_eq!(*delay_ms, Some(30_000)); // capped
            }
            _ => panic!("Expected Send step"),
        }
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
        recorder.record_keystroke("A".into(), 50);
        recorder.stop(100).unwrap();

        // Start a new recording
        recorder.start(200).unwrap();
        recorder.record_keystroke("B".into(), 250);
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
        recorder.record_keystroke("X".into(), 50);
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
        recorder.record_keystroke("A".into(), 100);
        recorder.record_keystroke("B".into(), 100); // same timestamp
        let recording = recorder.stop(200).unwrap();

        match &recording.steps[1] {
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
        /// Recording N keystrokes (0 ≤ N ≤ 1001) must produce min(N, MAX_RECORDED_STEPS) steps.
        /// This is the primary cap invariant: the Rust-side hard cap must never be exceeded.
        #[test]
        fn prop_max_steps_cap_never_exceeded(
            count in 0usize..=1100usize,
        ) {
            let mut recorder = MacroRecorder::new();
            recorder.start(0).unwrap();
            for i in 0u64..count as u64 {
                recorder.record_keystroke(format!("K{i}"), i * 10);
            }
            let recording = recorder.stop(count as u64 * 10 + 1).unwrap();
            prop_assert!(
                recording.steps.len() <= MAX_RECORDED_STEPS,
                "steps.len()={} must be ≤ MAX_RECORDED_STEPS={}",
                recording.steps.len(), MAX_RECORDED_STEPS
            );
            let expected_len = count.min(MAX_RECORDED_STEPS);
            prop_assert_eq!(
                recording.steps.len(), expected_len,
                "expected exactly min({}, {}) steps", count, MAX_RECORDED_STEPS
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
            recorder.record_keystroke("A".into(), 0);
            recorder.record_keystroke("B".into(), gap_ms);
            let recording = recorder.stop(gap_ms + 1).unwrap();

            if let Some(SequenceStep::Send { delay_ms: Some(d), .. }) = recording.steps.get(1) {
                prop_assert!(
                    *d <= MAX_STEP_DELAY_MS,
                    "delay {} exceeds MAX_STEP_DELAY_MS={}", d, MAX_STEP_DELAY_MS
                );
            }
        }

        /// Zero-gap events (same timestamp) must produce delay_ms = None, not Some(0).
        #[test]
        fn prop_zero_gap_produces_none_delay(
            ts in 0u64..=u64::MAX / 2,
        ) {
            let mut recorder = MacroRecorder::new();
            recorder.start(0).unwrap();
            recorder.record_keystroke("A".into(), ts);
            recorder.record_keystroke("B".into(), ts); // same timestamp
            let recording = recorder.stop(ts + 1).unwrap();

            if let SequenceStep::Send { delay_ms, .. } = &recording.steps[1] {
                prop_assert_eq!(*delay_ms, None, "zero-gap must produce None delay");
            }
        }

        /// First step must ALWAYS have delay_ms = None, regardless of start_at timestamp.
        #[test]
        fn prop_first_step_delay_always_none(
            start_ts in 0u64..=u64::MAX / 2,
            key_ts in 0u64..=u64::MAX / 2,
        ) {
            let mut recorder = MacroRecorder::new();
            recorder.start(start_ts).unwrap();
            // key_ts could be before or after start_ts; recorder doesn't validate ordering
            recorder.record_keystroke("X".into(), key_ts);
            let recording = recorder.stop(key_ts.saturating_add(1)).unwrap();
            if let SequenceStep::Send { delay_ms, .. } = &recording.steps[0] {
                prop_assert_eq!(*delay_ms, None, "first step delay must always be None");
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
        assert!(recording.steps.is_empty(), "empty recording must have no steps");
        assert_eq!(recording.started_at, 0);
        assert_eq!(recording.stopped_at, Some(100));
    }

    #[test]
    fn unit_no_keystrokes_while_idle_noop() {
        let mut recorder = MacroRecorder::new();
        // record_keystroke while Idle (not recording) must silently do nothing
        recorder.record_keystroke("X".into(), 100);
        assert!(!recorder.is_recording(), "recorder must still be Idle");
        assert!(recorder.last_recording().is_none());
    }

    #[test]
    fn unit_stop_while_idle_returns_err() {
        let mut recorder = MacroRecorder::new();
        assert!(recorder.stop(100).is_err(), "stop without start must return Err");
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
            RecordedEvent { key: "A".into(), timestamp: 1000 },
            RecordedEvent { key: "B".into(), timestamp: 0 }, // earlier timestamp (pathological)
        ];
        let steps = convert_to_sequence_steps(&events);
        // saturating_sub(0, 1000) = 0 → capped = 0 → delay_ms = None
        match &steps[1] {
            SequenceStep::Send { delay_ms, .. } => {
                assert_eq!(*delay_ms, None,
                    "backward timestamp must produce None delay (saturating_sub prevents underflow)");
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
                RecordedEvent { key: "A".into(), timestamp: t0 },
                RecordedEvent { key: "B".into(), timestamp: t1 },
                RecordedEvent { key: "C".into(), timestamp: t2 },
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

        /// At the exact cap boundary (MAX_RECORDED_STEPS keystrokes followed
        /// by one more) the extra keystroke must be silently dropped.
        #[test]
        fn prop_cap_at_boundary_exact(extra in 0usize..=10usize) {
            let mut recorder = MacroRecorder::new();
            recorder.start(0).unwrap();
            for i in 0u64..(MAX_RECORDED_STEPS + extra) as u64 {
                recorder.record_keystroke(format!("K{i}"), i);
            }
            let recording = recorder.stop(10_000_000).unwrap();
            prop_assert_eq!(
                recording.steps.len(), MAX_RECORDED_STEPS,
                "steps must be capped at exactly MAX_RECORDED_STEPS={}", MAX_RECORDED_STEPS
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
                RecordedEvent { key: "A".into(), timestamp: t0 },
                RecordedEvent { key: "B".into(), timestamp: t1 },
            ];
            let steps = convert_to_sequence_steps(&events);
            if let SequenceStep::Send { delay_ms: Some(d), .. } = &steps[1] {
                prop_assert_eq!(*d, MAX_STEP_DELAY_MS,
                    "near-overflow gap must be capped at MAX_STEP_DELAY_MS");
            }
        }
    }
}
