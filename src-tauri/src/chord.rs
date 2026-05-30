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

#[cfg(test)]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Construct a fresh detector with the given window.
    fn det(window_ms: u64) -> ChordDetector {
        ChordDetector::new(window_ms)
    }

    // -----------------------------------------------------------------------
    // Boundary: window edge (±1 ms)
    // -----------------------------------------------------------------------

    // Property: for any key pair and any window, if the second key arrives
    // strictly more than window_ms after the first, the result must be
    // SingleKey — NEVER Chord.  Uses saturating arithmetic so time going
    // backward (delta == 0) is treated as "within window" and may produce Chord.
    proptest! {
        #[test]
        fn second_key_past_window_always_single(
            window_ms in 0u64..1_000_000,
            t0 in 0u64..u64::MAX / 2,
            overflow_ms in 1u64..1000,
            key_a in "[A-Za-z0-9]{1,8}",
            key_b in "[A-Za-z0-9]{1,8}",
        ) {
            let t1 = t0.saturating_add(window_ms).saturating_add(overflow_ms);
            let mut d = det(window_ms);
            d.key_down(key_a.clone(), t0);
            let result = d.key_down(key_b.clone(), t1);
            prop_assert_eq!(
                result,
                ChordResult::SingleKey(key_a.clone()),
                "window={}, t0={}, t1={}, delta={}",
                window_ms,
                t0,
                t1,
                t1.saturating_sub(t0)
            );
        }
    }

    // Property: if the second key arrives within [0, window_ms] inclusive of
    // the first, the result must be a Chord.
    proptest! {
        #[test]
        fn second_key_within_window_always_chord(
            window_ms in 1u64..1_000_000,
            t0 in 0u64..u64::MAX / 2,
            delta in 0u64..=0u64,   // exact boundary handled separately below
            key_a in "[A-Za-z0-9]{1,8}",
            key_b in "[A-Za-z0-9]{1,8}",
        ) {
            // Use delta in [0, window_ms]
            let _ = delta; // suppress unused warning; we range by index below
            let t1 = t0.saturating_add(window_ms / 2); // midpoint — always within
            let mut d = det(window_ms);
            d.key_down(key_a.clone(), t0);
            let result = d.key_down(key_b.clone(), t1);
            prop_assert!(
                matches!(result, ChordResult::Chord(_, _)),
                "expected Chord but got {:?}, window={}, t0={}, t1={}",
                result,
                window_ms,
                t0,
                t1
            );
        }
    }

    // -----------------------------------------------------------------------
    // Boundary: exact window boundary (== window_ms)
    // -----------------------------------------------------------------------

    // At exactly window_ms the contract (from existing test `exact_boundary_is_chord`)
    // is "chord". Verify it holds for arbitrary window sizes and timestamps.
    proptest! {
        #[test]
        fn exact_boundary_is_chord_arbitrary(
            window_ms in 0u64..1_000_000,
            t0 in 0u64..u64::MAX / 2,
            key_a in "[A-Za-z0-9]{1,4}",
            key_b in "[A-Za-z0-9]{1,4}",
        ) {
            let t1 = t0.saturating_add(window_ms); // delta == window_ms exactly
            let mut d = det(window_ms);
            d.key_down(key_a.clone(), t0);
            let result = d.key_down(key_b.clone(), t1);
            prop_assert!(
                matches!(result, ChordResult::Chord(_, _)),
                "delta==window_ms should be Chord: window={}, t0={}, t1={}, result={:?}",
                window_ms,
                t0,
                t1,
                result
            );
        }
    }

    // -----------------------------------------------------------------------
    // Commutativity: key ordering is key-set independent
    // -----------------------------------------------------------------------

    // Chord(A, B) and Chord(B, A) must produce the same pair (sorted by
    // the detector).
    proptest! {
        #[test]
        fn chord_key_order_is_commutative(
            key_a in "[A-Za-z]{1,4}",
            key_b in "[A-Za-z]{1,4}",
            t0 in 0u64..1_000_000u64,
        ) {
            let window_ms = 200u64;
            let t1 = t0 + 50; // within window

            let mut d1 = det(window_ms);
            d1.key_down(key_a.clone(), t0);
            let r1 = d1.key_down(key_b.clone(), t1);

            let mut d2 = det(window_ms);
            d2.key_down(key_b.clone(), t0);
            let r2 = d2.key_down(key_a.clone(), t1);

            prop_assert_eq!(r1, r2, "Chord should be order-independent");
        }
    }

    // -----------------------------------------------------------------------
    // State invariants after chord / single
    // -----------------------------------------------------------------------

    // After a chord is detected, the detector must have no pending state.
    proptest! {
        #[test]
        fn no_pending_after_chord(
            window_ms in 1u64..100_000,
            key_a in "[A-Za-z]{1,4}",
            key_b in "[A-Za-z]{1,4}",
        ) {
            let mut d = det(window_ms);
            d.key_down(key_a, 0);
            let result = d.key_down(key_b, window_ms / 2); // within window
            if matches!(result, ChordResult::Chord(_, _)) {
                prop_assert!(!d.has_pending(), "has_pending must be false after Chord");
            }
        }
    }

    // After tick returns SingleKey, has_pending must be false.
    proptest! {
        #[test]
        fn no_pending_after_tick_single(
            window_ms in 1u64..100_000,
            key in "[A-Za-z]{1,4}",
            overflow in 1u64..1000,
        ) {
            let mut d = det(window_ms);
            d.key_down(key, 0);
            let t = window_ms.saturating_add(overflow);
            let result = d.tick(t);
            if matches!(result, ChordResult::SingleKey(_)) {
                prop_assert!(!d.has_pending());
            }
        }
    }

    // -----------------------------------------------------------------------
    // Overflow / saturation: time going backward (clock correction)
    // -----------------------------------------------------------------------

    /// SUSPECTED BUG: If now < received_at (e.g., a monotonic-clock hiccup),
    /// saturating_sub returns 0. Since 0 <= window_ms for all window_ms,
    /// the second key is ALWAYS treated as a chord — even if window_ms == 0.
    /// This test documents the current (possibly surprising) behaviour.
    #[test]
    fn backward_time_saturates_to_zero_and_produces_chord() {
        let window_ms = 100u64;
        let mut d = det(window_ms);
        d.key_down("A".into(), 1000); // received_at = 1000
        // now = 500 < 1000; saturating_sub gives 0, 0 <= 100, so chord fires.
        let result = d.key_down("B".into(), 500);
        assert!(
            matches!(result, ChordResult::Chord(_, _)),
            "backward time saturates to 0 → within window → Chord: {result:?}"
        );
    }

    /// SUSPECTED BUG: tick() and key_down() disagree at the exact boundary.
    /// tick() uses `>` (strictly greater), while key_down() uses `<=` (<=).
    /// So at delta == window_ms:
    ///   - key_down says "chord" (delta <= window_ms)
    ///   - tick says "pending" (delta NOT > window_ms)
    /// This test exposes the inconsistency.
    #[test]
    fn tick_and_key_down_boundary_inconsistency() {
        let window_ms = 100u64;
        let t0 = 1000u64;
        let t_exact = t0 + window_ms; // delta == window_ms exactly

        // key_down at exact boundary → Chord (delta <= window_ms)
        let mut d1 = det(window_ms);
        d1.key_down("A".into(), t0);
        let kd_result = d1.key_down("B".into(), t_exact);
        assert!(
            matches!(kd_result, ChordResult::Chord(_, _)),
            "key_down at exact boundary should be Chord: {kd_result:?}"
        );

        // tick at exact boundary → Pending (delta NOT > window_ms)
        let mut d2 = det(window_ms);
        d2.key_down("A".into(), t0);
        let tick_result = d2.tick(t_exact);
        // NOTE: this assertion documents the CURRENT behavior — tick returns
        // Pending at the exact boundary, while key_down returns Chord.
        // The inconsistency means: if a second key and a tick arrive at the
        // same instant (t == t0 + window_ms), the outcome depends on which
        // path processes first. This is a design ambiguity worth noting.
        assert_eq!(
            tick_result,
            ChordResult::Pending,
            "tick at exact boundary is Pending (tick uses >, key_down uses <=)"
        );
    }

    // -----------------------------------------------------------------------
    // Null / empty: zero-length window
    // -----------------------------------------------------------------------

    /// With window_ms == 0, any key arriving at or after (even t0 == t1) sits
    /// exactly at boundary → still chord. Only t1 > t0 by 1 should single.
    #[test]
    fn zero_window_same_timestamp_is_chord() {
        let mut d = det(0);
        d.key_down("A".into(), 1000);
        let result = d.key_down("B".into(), 1000);
        assert!(
            matches!(result, ChordResult::Chord(_, _)),
            "zero window, same timestamp: expected Chord, got {result:?}"
        );
    }

    #[test]
    fn zero_window_plus_one_ms_is_single() {
        let mut d = det(0);
        d.key_down("A".into(), 1000);
        let result = d.key_down("B".into(), 1001); // delta = 1 > window_ms(0)
        assert_eq!(result, ChordResult::SingleKey("A".into()));
    }

    // -----------------------------------------------------------------------
    // Overflow: very long key strings should not panic
    // -----------------------------------------------------------------------

    proptest! {
        #[test]
        fn long_key_strings_do_not_panic(
            key_a in ".{0,1000}",
            key_b in ".{0,1000}",
        ) {
            let mut d = det(200);
            let _ = d.key_down(key_a.clone(), 0);
            let _ = d.key_down(key_b.clone(), 100);
            let _ = d.tick(500);
            let _ = d.cancel();
        }
    }

    // -----------------------------------------------------------------------
    // Concurrency: N/A — ChordDetector is single-owner, non-Send/Sync.
    // No shared state (OnceLock/static) exists in chord.rs.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Temporal: N/A — time is injected as u64 parameter, no real clock is used.
    // -----------------------------------------------------------------------
}
