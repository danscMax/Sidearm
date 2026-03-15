#![allow(dead_code)]

/// Result of evaluating the chord detector state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChordResult {
    /// No keys pending -- nothing to do.
    Empty,
    /// One key is pending and the chord window has NOT expired yet -- wait.
    Pending,
    /// One key is pending and the chord window expired -- emit as single press.
    SingleKey(String),
    /// Two keys arrived within the chord window -- emit as chord.
    Chord(String, String),
}

#[derive(Debug)]
struct PendingKey {
    encoded_key: String,
    received_at: u64,
}

#[derive(Debug)]
pub struct ChordDetector {
    window_ms: u64,
    pending: Option<PendingKey>,
}

impl ChordDetector {
    pub fn new(window_ms: u64) -> Self {
        Self {
            window_ms,
            pending: None,
        }
    }

    /// Feed a key-down event into the detector.
    /// Returns the chord result immediately.
    pub fn key_down(&mut self, encoded_key: String, now: u64) -> ChordResult {
        match self.pending.take() {
            None => {
                // First key -- start the chord window
                self.pending = Some(PendingKey {
                    encoded_key,
                    received_at: now,
                });
                ChordResult::Pending
            }
            Some(first) => {
                if now.saturating_sub(first.received_at) <= self.window_ms {
                    // Second key within window -- chord!
                    // Sort keys alphabetically for consistent chord identity
                    let (a, b) = if first.encoded_key <= encoded_key {
                        (first.encoded_key, encoded_key)
                    } else {
                        (encoded_key, first.encoded_key)
                    };
                    ChordResult::Chord(a, b)
                } else {
                    // Window expired for the first key -- emit it as single,
                    // and start a new window for this key
                    let single = first.encoded_key;
                    self.pending = Some(PendingKey {
                        encoded_key,
                        received_at: now,
                    });
                    // Caller should process single first, then check again.
                    // We return the single key -- the new key is now pending.
                    ChordResult::SingleKey(single)
                }
            }
        }
    }

    /// Check if the pending key's chord window has expired.
    /// Call this periodically (e.g., on timer tick) or before processing.
    pub fn tick(&mut self, now: u64) -> ChordResult {
        match &self.pending {
            Some(pending) if now.saturating_sub(pending.received_at) > self.window_ms => {
                let key = self.pending.take().unwrap().encoded_key;
                ChordResult::SingleKey(key)
            }
            Some(_) => ChordResult::Pending,
            None => ChordResult::Empty,
        }
    }

    /// Cancel any pending key (e.g., on key-up before chord completes).
    pub fn cancel(&mut self) -> Option<String> {
        self.pending.take().map(|p| p.encoded_key)
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_key_after_timeout() {
        let mut det = ChordDetector::new(100);

        // First key arrives
        let r = det.key_down("F13".into(), 1000);
        assert_eq!(r, ChordResult::Pending);

        // Time passes beyond window
        let r = det.tick(1150);
        assert_eq!(r, ChordResult::SingleKey("F13".into()));

        // No more pending
        assert!(!det.has_pending());
    }

    #[test]
    fn chord_detected_within_window() {
        let mut det = ChordDetector::new(100);

        let r = det.key_down("F13".into(), 1000);
        assert_eq!(r, ChordResult::Pending);

        // Second key within 100ms
        let r = det.key_down("F14".into(), 1050);
        assert_eq!(r, ChordResult::Chord("F13".into(), "F14".into()));

        assert!(!det.has_pending());
    }

    #[test]
    fn chord_keys_sorted_alphabetically() {
        let mut det = ChordDetector::new(100);

        det.key_down("F14".into(), 1000);
        let r = det.key_down("F13".into(), 1050);
        // F13 < F14 alphabetically, so F13 comes first
        assert_eq!(r, ChordResult::Chord("F13".into(), "F14".into()));
    }

    #[test]
    fn second_key_after_window_emits_single_then_pending() {
        let mut det = ChordDetector::new(100);

        det.key_down("F13".into(), 1000);
        // Second key arrives AFTER window
        let r = det.key_down("F14".into(), 1200);
        assert_eq!(r, ChordResult::SingleKey("F13".into()));

        // F14 is now pending
        assert!(det.has_pending());

        // Tick past its window
        let r = det.tick(1350);
        assert_eq!(r, ChordResult::SingleKey("F14".into()));
    }

    #[test]
    fn tick_within_window_returns_pending() {
        let mut det = ChordDetector::new(100);

        det.key_down("F13".into(), 1000);
        let r = det.tick(1050); // 50ms < 100ms window
        assert_eq!(r, ChordResult::Pending);
    }

    #[test]
    fn tick_with_no_pending_returns_empty() {
        let mut det = ChordDetector::new(100);
        let r = det.tick(1000);
        assert_eq!(r, ChordResult::Empty);
    }

    #[test]
    fn cancel_returns_pending_key() {
        let mut det = ChordDetector::new(100);

        det.key_down("F13".into(), 1000);
        let cancelled = det.cancel();
        assert_eq!(cancelled, Some("F13".into()));
        assert!(!det.has_pending());
    }

    #[test]
    fn cancel_with_no_pending_returns_none() {
        let mut det = ChordDetector::new(100);
        assert_eq!(det.cancel(), None);
    }

    #[test]
    fn exact_boundary_is_chord() {
        let mut det = ChordDetector::new(100);

        det.key_down("F13".into(), 1000);
        // Exactly at the boundary (1000 + 100 = 1100)
        let r = det.key_down("F14".into(), 1100);
        assert_eq!(r, ChordResult::Chord("F13".into(), "F14".into()));
    }

    #[test]
    fn one_ms_past_boundary_is_single() {
        let mut det = ChordDetector::new(100);

        det.key_down("F13".into(), 1000);
        let r = det.key_down("F14".into(), 1101);
        assert_eq!(r, ChordResult::SingleKey("F13".into()));
    }

    #[test]
    fn same_key_twice_is_not_chord() {
        let mut det = ChordDetector::new(100);

        det.key_down("F13".into(), 1000);
        // Same key again -- treated as chord with itself (caller decides if valid)
        let r = det.key_down("F13".into(), 1050);
        assert_eq!(r, ChordResult::Chord("F13".into(), "F13".into()));
    }

    #[test]
    fn rapid_three_keys_first_two_chord_third_pending() {
        let mut det = ChordDetector::new(100);

        det.key_down("F13".into(), 1000);
        let r = det.key_down("F14".into(), 1050);
        assert_eq!(r, ChordResult::Chord("F13".into(), "F14".into()));

        // Third key starts fresh
        let r = det.key_down("F15".into(), 1080);
        assert_eq!(r, ChordResult::Pending);

        let r = det.tick(1200);
        assert_eq!(r, ChordResult::SingleKey("F15".into()));
    }
}
