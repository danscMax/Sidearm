#![allow(dead_code)]

use serde::Serialize;

use crate::config::SequenceStep;

const MAX_STEP_DELAY_MS: u32 = 30_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroRecording {
    pub steps: Vec<SequenceStep>,
    pub started_at: u64,
    pub stopped_at: Option<u64>,
}

#[derive(Debug)]
enum RecorderState {
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

impl Default for RecorderState {
    fn default() -> Self {
        RecorderState::Idle
    }
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
    pub fn record_keystroke(&mut self, key: String, now: u64) {
        if let Some(RecorderState::Recording {
            last_event_at,
            steps,
            ..
        }) = &mut self.state
        {
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
            SequenceStep::Send { value, delay_ms } => {
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
            SequenceStep::Send { value, delay_ms } => {
                assert_eq!(value, "Ctrl+C");
                assert_eq!(*delay_ms, None);
            }
            _ => panic!("Expected Send step"),
        }
        // Second step: 250ms delay
        match &recording.steps[1] {
            SequenceStep::Send { value, delay_ms } => {
                assert_eq!(value, "Ctrl+V");
                assert_eq!(*delay_ms, Some(250));
            }
            _ => panic!("Expected Send step"),
        }
        // Third step: 250ms delay
        match &recording.steps[2] {
            SequenceStep::Send { value, delay_ms } => {
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
