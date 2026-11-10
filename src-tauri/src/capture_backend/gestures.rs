//! Press patterns on one button: a plain press, a long press, a double and a
//! triple press, each with its own binding.
//!
//! A button whose control has only a plain-press binding never comes here: it
//! fires on the press, as it always did. One with more patterns waits for the
//! press to tell itself apart — a long press fires once the button has been
//! held past [`LONG_PRESS`]; taps are counted until [`MULTI_PRESS_WINDOW`] passes
//! after the last release (or the most taps any of its bindings wants).
//! Pure state machine: the capture worker feeds it presses, releases and the
//! clock, and dispatches what it returns.

use std::time::{Duration, Instant};

use crate::config::Gesture;

/// Held this long, a press is a long press.
pub(super) const LONG_PRESS: Duration = Duration::from_millis(250);
/// After a release, another press within this counts as the next tap.
pub(super) const MULTI_PRESS_WINDOW: Duration = Duration::from_millis(300);

/// Which patterns a button's bindings answer besides the plain press.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Patterns {
    pub long: bool,
    pub double: bool,
    pub triple: bool,
}

impl Patterns {
    /// Whether the button needs this recognizer at all.
    pub fn any(self) -> bool {
        self.long || self.double || self.triple
    }

    fn max_taps(self) -> u8 {
        if self.triple {
            3
        } else if self.double {
            2
        } else {
            1
        }
    }
}

struct Pending<T> {
    key: String,
    patterns: Patterns,
    context: T,
    held_since: Option<Instant>,
    released_at: Option<Instant>,
    taps: u8,
    long_fired: bool,
}

/// The buttons whose pattern is still being told apart.
pub(super) struct Gestures<T> {
    pending: Vec<Pending<T>>,
}

impl<T: Clone> Default for Gestures<T> {
    fn default() -> Self {
        Self { pending: Vec::new() }
    }
}

impl<T: Clone> Gestures<T> {
    /// Whether `key` is being told apart (its release and repeats belong here).
    pub fn tracks(&self, key: &str) -> bool {
        self.pending.iter().any(|pending| pending.key == key)
    }

    /// A press of `key`. `context` is what a fired gesture is dispatched with
    /// (taken from the first press of a series).
    pub fn press(&mut self, key: &str, patterns: Patterns, context: T, now: Instant) {
        if let Some(pending) = self.pending.iter_mut().find(|pending| pending.key == key) {
            pending.held_since = Some(now);
            pending.released_at = None;
            return;
        }
        self.pending.push(Pending {
            key: key.to_owned(),
            patterns,
            context,
            held_since: Some(now),
            released_at: None,
            taps: 0,
            long_fired: false,
        });
    }

    /// A release of `key`: what fires now.
    pub fn release(&mut self, key: &str, now: Instant) -> Vec<(T, Gesture)> {
        let Some(index) = self.pending.iter().position(|pending| pending.key == key) else {
            return Vec::new();
        };
        let pending = &mut self.pending[index];
        pending.held_since = None;
        if pending.long_fired {
            self.pending.remove(index);
            return Vec::new();
        }
        pending.taps += 1;
        if pending.taps >= pending.patterns.max_taps() {
            let pending = self.pending.remove(index);
            return taps(&pending);
        }
        pending.released_at = Some(now);
        Vec::new()
    }

    /// The clock: long presses that reached their threshold, tap series whose
    /// window closed.
    pub fn tick(&mut self, now: Instant) -> Vec<(T, Gesture)> {
        let mut fired = Vec::new();
        self.pending.retain_mut(|pending| {
            if let Some(since) = pending.held_since
                && pending.patterns.long
                && !pending.long_fired
                && now.duration_since(since) >= LONG_PRESS
            {
                // Taps before a long press still count as presses.
                fired.extend(taps(pending));
                pending.taps = 0;
                pending.long_fired = true;
                fired.push((pending.context.clone(), Gesture::LongPress));
                return true;
            }
            if let Some(released) = pending.released_at
                && now.duration_since(released) >= MULTI_PRESS_WINDOW
            {
                fired.extend(taps(pending));
                return false;
            }
            true
        });
        fired
    }

    /// When [`Gestures::tick`] next has something to do.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.pending
            .iter()
            .filter_map(|pending| match (pending.held_since, pending.released_at) {
                (Some(since), _) if pending.patterns.long && !pending.long_fired => Some(since + LONG_PRESS),
                (None, Some(released)) => Some(released + MULTI_PRESS_WINDOW),
                _ => None,
            })
            .min()
    }
}

/// What a finished tap series fires: its own pattern when a binding wants it,
/// else that many plain presses.
fn taps<T: Clone>(pending: &Pending<T>) -> Vec<(T, Gesture)> {
    let gesture = match pending.taps {
        2 if pending.patterns.double => Some(Gesture::DoublePress),
        3 if pending.patterns.triple => Some(Gesture::TriplePress),
        _ => None,
    };
    match gesture {
        Some(gesture) => vec![(pending.context.clone(), gesture)],
        None => (0..pending.taps).map(|_| (pending.context.clone(), Gesture::Press)).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: Patterns = Patterns { long: true, double: true, triple: true };

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    fn gestures(fired: Vec<((), Gesture)>) -> Vec<Gesture> {
        fired.into_iter().map(|(_, gesture)| gesture).collect()
    }

    #[test]
    fn a_short_press_waits_for_a_second_tap_then_fires_as_a_press() {
        let t = Instant::now();
        let mut g = Gestures::default();
        g.press("F13", ALL, (), t);
        assert!(g.release("F13", at(t, 80)).is_empty());
        assert_eq!(g.next_deadline(), Some(at(t, 80) + MULTI_PRESS_WINDOW));
        assert!(g.tick(at(t, 300)).is_empty());
        assert_eq!(gestures(g.tick(at(t, 380))), [Gesture::Press]);
        assert!(!g.tracks("F13"));
    }

    #[test]
    fn a_held_button_fires_its_long_press_once_and_its_release_fires_nothing() {
        let t = Instant::now();
        let mut g = Gestures::default();
        g.press("F13", ALL, (), t);
        assert!(g.tick(at(t, 200)).is_empty());
        assert_eq!(gestures(g.tick(at(t, 250))), [Gesture::LongPress]);
        assert!(g.tick(at(t, 900)).is_empty(), "fires once");
        assert!(g.release("F13", at(t, 1000)).is_empty());
        assert!(!g.tracks("F13"));
    }

    #[test]
    fn taps_within_the_window_make_a_double_and_a_triple() {
        let t = Instant::now();
        let mut g = Gestures::default();
        g.press("F13", ALL, (), t);
        g.release("F13", at(t, 50));
        g.press("F13", ALL, (), at(t, 150));
        g.release("F13", at(t, 200));
        assert_eq!(gestures(g.tick(at(t, 500))), [Gesture::DoublePress]);

        g.press("F13", ALL, (), at(t, 1000));
        g.release("F13", at(t, 1050));
        g.press("F13", ALL, (), at(t, 1100));
        g.release("F13", at(t, 1150));
        g.press("F13", ALL, (), at(t, 1200));
        assert_eq!(gestures(g.release("F13", at(t, 1250))), [Gesture::TriplePress], "the most taps fire at once");
    }

    #[test]
    fn a_long_press_alone_fires_a_quick_press_on_release() {
        let long_only = Patterns { long: true, ..Patterns::default() };
        let t = Instant::now();
        let mut g = Gestures::default();
        g.press("F13", long_only, (), t);
        assert_eq!(gestures(g.release("F13", at(t, 100))), [Gesture::Press], "no tap to wait for");
    }

    #[test]
    fn a_double_tap_without_a_double_binding_is_two_presses() {
        let triple_only = Patterns { triple: true, ..Patterns::default() };
        let t = Instant::now();
        let mut g = Gestures::default();
        g.press("F13", triple_only, (), t);
        g.release("F13", at(t, 50));
        g.press("F13", triple_only, (), at(t, 100));
        g.release("F13", at(t, 150));
        assert_eq!(gestures(g.tick(at(t, 500))), [Gesture::Press, Gesture::Press]);
    }

    #[test]
    fn a_tap_then_a_hold_is_a_press_and_a_long_press() {
        let t = Instant::now();
        let mut g = Gestures::default();
        g.press("F13", ALL, (), t);
        g.release("F13", at(t, 50));
        g.press("F13", ALL, (), at(t, 100));
        assert_eq!(gestures(g.tick(at(t, 350))), [Gesture::Press, Gesture::LongPress]);
    }

    #[test]
    fn buttons_are_told_apart_independently() {
        let t = Instant::now();
        let mut g: Gestures<&str> = Gestures::default();
        g.press("F13", ALL, "a", t);
        g.press("F14", ALL, "b", at(t, 10));
        assert_eq!(g.tick(at(t, 255)), [("a", Gesture::LongPress)]);
        assert_eq!(g.tick(at(t, 265)), [("b", Gesture::LongPress)]);
    }
}
