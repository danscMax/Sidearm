//! Pure evdev interface selection and capture-session teardown.

use std::collections::HashMap;

use super::{EncodedKeyEvent, gestures::Gestures};
use crate::input_synthesis::HeldShortcutState;

pub(super) const KEY_F13: u16 = 183;
pub(super) const KEY_F24: u16 = 194;
pub(super) const KEY_LEFTCTRL: u16 = 29;
pub(super) const KEY_RIGHTCTRL: u16 = 97;
pub(super) const KEY_LEFTSHIFT: u16 = 42;
pub(super) const KEY_RIGHTSHIFT: u16 = 54;
pub(super) const KEY_LEFTALT: u16 = 56;
pub(super) const KEY_RIGHTALT: u16 = 100;
pub(super) const KEY_LEFTMETA: u16 = 125;
pub(super) const KEY_RIGHTMETA: u16 = 126;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CaptureAccess {
    Exclusive,
    Shared,
}

pub(super) fn keyboard_capture_access(
    keys: impl Iterator<Item = u16>,
    has_pointer_axes: bool,
) -> Option<CaptureAccess> {
    let mut encoded = false;
    let mut exclusive = !has_pointer_axes;
    for key in keys {
        if (KEY_F13..=KEY_F24).contains(&key) {
            encoded = true;
        } else if !matches!(key, KEY_LEFTCTRL | KEY_RIGHTCTRL | KEY_LEFTSHIFT | KEY_RIGHTSHIFT | KEY_LEFTALT | KEY_RIGHTALT | KEY_LEFTMETA | KEY_RIGHTMETA) {
            exclusive = false;
        }
    }
    encoded.then_some(if exclusive { CaptureAccess::Exclusive } else { CaptureAccess::Shared })
}

pub(super) enum CaptureEvent {
    Input(EncodedKeyEvent),
    SessionLost,
}

pub(super) fn session_input<T: Clone>(
    event: CaptureEvent,
    held: &mut HashMap<String, HeldShortcutState>,
    gestures: &mut Gestures<T>,
    mut release: impl FnMut(&HeldShortcutState) -> Result<(), String>,
) -> Option<EncodedKeyEvent> {
    match event {
        CaptureEvent::Input(event) => Some(event),
        CaptureEvent::SessionLost => {
            gestures.clear();
            for (key, held) in held.drain() {
                if let Err(error) = release(&held) {
                    log::warn!("[capture] Failed to release `{key}` after evdev disconnect: {error}");
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn pointer_interfaces_are_not_grabbed_as_encoder_keyboards() {
        assert_eq!(keyboard_capture_access([272, 273].into_iter(), true), None);
        assert_eq!(keyboard_capture_access([183, 194, 29, 56].into_iter(), false), Some(CaptureAccess::Exclusive));
        assert_eq!(keyboard_capture_access([183, 272].into_iter(), true), Some(CaptureAccess::Shared));
        assert_eq!(keyboard_capture_access([183, 30].into_iter(), false), Some(CaptureAccess::Shared));
        assert_eq!(keyboard_capture_access([183].into_iter(), true), Some(CaptureAccess::Shared));
    }

    #[test]
    fn unplug_releases_holds_and_cancels_gestures_before_reconnect() {
        let mut held = HashMap::new();
        let mut gestures = Gestures::default();
        let now = Instant::now();
        gestures.press("F14", super::super::gestures::Patterns { long: true, ..Default::default() }, (), now);
        let event = EncodedKeyEvent {
            encoded_key: "Ctrl+F13".into(), backend: "evdev".into(), received_at: 0,
            is_repeat: false, is_key_up: false, is_hypershift: false, is_hypershift2: false,
        };
        let down = session_input(CaptureEvent::Input(event), &mut held, &mut gestures, |_| Ok(())).unwrap();
        held.insert(down.encoded_key, HeldShortcutState {
            pressed_modifier_vks: vec![crate::input_synthesis::VirtualKeySpec { code: 0xA2, extended: false }],
            primary_key: None,
        });
        let mut released = Vec::new();
        for _ in 0..2 {
            assert!(session_input(CaptureEvent::SessionLost, &mut held, &mut gestures, |state| {
                released.extend(state.pressed_modifier_vks.iter().map(|key| key.code));
                Ok(())
            }).is_none());
        }
        assert_eq!(released, [0xA2]);
        assert!(held.is_empty());
        assert!(gestures.tick(now + Duration::from_secs(1)).is_empty());
    }
}
