//! What the user must know about the mouse path that is not a takeover: the
//! capture helper gone for good, side buttons that cannot be read, a mouse the
//! guard cannot reach, no watchdog to restore the mice after a kill, an
//! offline profile that was not stored, a signal switch.
//!
//! States (`set_state`) hold until cleared and show in the Mouse tab; notices
//! (`notice`) are shown once as a toast. Both are emitted as
//! [`EVENT_MOUSE_STATUS`] and kept here for a window that opens later
//! (`snapshot`) — a notice raised at startup must not be lost before the UI
//! listens.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

/// Emitted on every change: `{ kind, active }`.
pub const EVENT_MOUSE_STATUS: &str = "mouse_status";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusKind {
    /// State: the capture helper died and could not be restarted.
    HelperLost,
    /// State: the side buttons' signal collection does not open.
    ButtonsUnreadable,
    /// State: the guard has not reached the mouse for a while.
    MouseUnreachable,
    /// State: no watchdog outlives this Sidearm (it did not come up, or it is
    /// in a job that ends with Sidearm): a kill leaves the mice unrestored.
    WatchdogOff,
    /// State: the profile button took a mouse off Sidearm's own bank (offline mode).
    MouseOffline,
    /// Notice: every bank slot of the mouse holds a profile, so Sidearm writes
    /// its live map instead of using a bank of its own (slower start and exit).
    NoFreeBankSlot,
    /// Notice: the mouse slept at the last exit, its offline profile was not stored.
    OfflineNotStored,
}

/// Payload of [`EVENT_MOUSE_STATUS`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct StatusEvent {
    pub kind: StatusKind,
    pub active: bool,
    /// The mouse a notice is about, when it names one (`short_name`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<&'static str>,
}

/// Active states and notices the UI has not taken yet.
/// A pending notice and the mouse it names.
type Notice = (StatusKind, Option<&'static str>);
static STATUS: Mutex<(Vec<StatusKind>, Vec<Notice>)> = Mutex::new((Vec::new(), Vec::new()));

/// Sets or clears a state; emits only a change.
pub fn set_state(app: Option<&AppHandle>, kind: StatusKind, active: bool) {
    let changed = {
        let mut status = STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let held = status.0.contains(&kind);
        if active && !held {
            status.0.push(kind);
        } else if !active && held {
            status.0.retain(|k| *k != kind);
        }
        held != active
    };
    if changed && let Some(app) = app {
        let _ = app.emit(EVENT_MOUSE_STATUS, StatusEvent { kind, active, model: None });
    }
}

/// Raises a one-time notice: kept until a [`snapshot`] takes it; the event only
/// tells an open window to take it now.
pub fn notice(app: Option<&AppHandle>, kind: StatusKind) {
    notice_about(app, kind, None);
}

/// [`notice`] naming the mouse it is about.
pub fn notice_about(app: Option<&AppHandle>, kind: StatusKind, model: Option<&'static str>) {
    STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).1.push((kind, model));
    if let Some(app) = app {
        let _ = app.emit(EVENT_MOUSE_STATUS, StatusEvent { kind, active: true, model });
    }
}

/// The active states plus the pending notices, which it takes.
pub fn snapshot() -> Vec<StatusEvent> {
    let mut status = STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let notices = std::mem::take(&mut status.1);
    status
        .0
        .iter()
        .map(|&kind| StatusEvent { kind, active: true, model: None })
        .chain(notices.into_iter().map(|(kind, model)| StatusEvent { kind, active: true, model }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// States persist until cleared; a notice is taken by the first snapshot.
    #[test]
    fn states_hold_and_notices_are_taken_once() {
        set_state(None, StatusKind::ButtonsUnreadable, true);
        set_state(None, StatusKind::ButtonsUnreadable, true);
        notice_about(None, StatusKind::OfflineNotStored, Some("V2 HyperSpeed"));
        let first = snapshot();
        assert!(first.contains(&StatusEvent { kind: StatusKind::ButtonsUnreadable, active: true, model: None }));
        assert!(first.contains(&StatusEvent { kind: StatusKind::OfflineNotStored, active: true, model: Some("V2 HyperSpeed") }));
        assert_eq!(first.len(), 2, "a repeated state is held once");
        assert_eq!(snapshot(), vec![StatusEvent { kind: StatusKind::ButtonsUnreadable, active: true, model: None }]);
        set_state(None, StatusKind::ButtonsUnreadable, false);
        assert!(snapshot().is_empty());
    }
}
