//! What the mouse does while Sidearm is closed.
//!
//! While Sidearm runs, the onboard memory holds Sidearm's own signals
//! (`F13`..`F24`, `Alt+F23`…) — meaningless without the app. On exit Sidearm
//! writes the active profile into the mouse the way Synapse did, so every
//! binding the firmware can play back on its own keeps working: a single key
//! with modifiers, or a plain mouse button. Text, macros, launches, menus and
//! per-app profiles cannot live in the mouse and stay inert until Sidearm runs
//! again. If the profile uses Hypershift, its trigger becomes the firmware
//! Hypershift key and the layer-1 records get the hypershift bindings. Own
//! `Offline` / `OfflineHypershift` plain presses override the respective records.
//!
//! On the next start the marker file says the memory holds the offline
//! profile, and Sidearm writes its own signals back before the guard looks.

use std::path::Path;

use crate::config::{ActionPayload, AppConfig, Layer, MouseActionKind, TriggerMode};
use crate::device_catalog::{NativeModel, Transport};
use crate::mouse_memory::{OnboardAction, VendorDevice, hid_usage_for_vk, left_modifier_bits, modifier_bits};

/// Left by an exit that could not finish storing the offline profile:
/// the next start tells the user why the buttons did nothing without Sidearm.
pub const OFFLINE_FAILED_FILE: &str = "mouse-offline-failed";
/// The consumer usage of a silent record in a V3 bank: usage 0 sends nothing
/// Windows or Sidearm reacts to (the record form a bank plays, measured).
pub const BANK_SILENT_USAGE: u16 = 0;

/// One record to store: button, layer (`0` standard, `1` Hypershift), action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfflineRecord {
    pub button_id: u8,
    pub layer: u8,
    pub action: OnboardAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OfflineKind { Own, Inherited, Preserved, Silent, Role, Unavailable }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OfflineRole { Hypershift, ProfileButton, NativeClick }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OfflineReason { ActionType, Gesture, Key, MouseModifiers, NoTrigger }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineControl {
    pub control_id: String,
    pub layer: Layer,
    pub kind: OfflineKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<OfflineRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<OfflineReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_action_type: Option<&'static str>,
    pub editable: bool,
}

#[derive(Debug)]
pub struct PlannedControl {
    pub preview: OfflineControl,
    pub record: Option<OfflineRecord>,
}

#[derive(Debug)]
pub struct OfflinePlan(pub Vec<PlannedControl>);

impl OfflinePlan {
    pub fn records(&self) -> Vec<OfflineRecord> {
        self.0.iter().filter_map(|control| control.record).collect()
    }
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
/// `Pending`: the onboard mouse's profile 1 should hold this profile, but
/// this run has not stored it yet (the mouse slept, or the change is not saved).
pub enum TargetState { Written, NotWritten, FollowsWindow, Unknown, Pending }

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineBank {
    pub bank: u8,
    pub profile_id: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hybrid: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineTarget {
    pub state: TargetState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bank: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub written_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banks: Option<Vec<OfflineBank>>,
    /// V3: the bank the exit selects, so the mouse plays it after Sidearm
    /// closes (the offline profile's, else the one playing) — the same
    /// `live_overlay::exit_bank` the exit uses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playing_bank: Option<u8>,
    /// V3: whether the effective writer stores this profile as a hybrid hardware
    /// bank (live keys + Sidearm consumer signals) rather than pure offline.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hybrid: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct OfflinePreview {
    pub target: OfflineTarget,
    pub controls: Vec<OfflineControl>,
}

pub fn preview(config: &AppConfig, model: &NativeModel, profile_id: &str, banks: Option<&crate::mouse_memory::live_overlay::Banks>) -> OfflinePreview {
    let follows = config.settings.offline_profile_id.as_deref() == Some(crate::config::OFFLINE_PROFILE_ACTIVE);
    let offline = if follows { crate::config::OFFLINE_PROFILE_ACTIVE.to_owned() } else { offline_profile_id(config, None) };
    let mut target = OfflineTarget { state: TargetState::NotWritten, bank: None, written_profile_id: None, banks: None, playing_bank: None, hybrid: false };
    if model.verified && model.transport == Transport::LiveOverlay {
        if let Some(banks) = banks {
            let planned = crate::mouse_memory::live_overlay::bank_plan(config, model, banks, &offline);
            if let Some(entry) = planned.iter().find(|entry| entry.profile_id == profile_id) {
                target.state = TargetState::Written;
                target.bank = Some(entry.bank);
                target.hybrid = entry.hybrid;
            } else if follows && planned.iter().any(|entry| entry.profile_id == crate::config::OFFLINE_PROFILE_ACTIVE) {
                target.state = TargetState::FollowsWindow;
            }
            if matches!(target.state, TargetState::Written | TargetState::NotWritten) {
                if !follows && !planned.is_empty() {
                    target.playing_bank = crate::mouse_memory::live_overlay::exit_bank(config, &planned, banks, &offline);
                }
                target.banks = Some(planned.into_iter().map(|entry| OfflineBank { bank: entry.bank, profile_id: entry.profile_id.into(), hybrid: entry.hybrid }).collect());
            }
        } else {
            target.state = TargetState::Unknown;
        }
    } else if model.verified {
        // Profile 1 keeps `@active` as the fallback: it is stored while Sidearm runs.
        let kept = onboard_offline_profile(config);
        target.state = if kept != profile_id { TargetState::NotWritten }
            else if crate::mouse_memory::live_overlay::onboard_offline_stored(config, model) { TargetState::Written }
            else { TargetState::Pending };
        if target.state == TargetState::NotWritten {
            target.written_profile_id = Some(kept);
        }
    }
    OfflinePreview { target, controls: plan(config, model, profile_id).0.into_iter().map(|control| control.preview).collect() }
}

fn native_action(value: u8) -> Option<&'static str> {
    match value {
        1 => Some("leftClick"), 2 => Some("rightClick"), 3 => Some("middleClick"),
        4 => Some("mouseBack"), 5 => Some("mouseForward"), 9 => Some("scrollUp"), 10 => Some("scrollDown"),
        _ => None,
    }
}

/// The decisions that make `model` behave like `profile_id` on its own — one
/// rule for every model:
/// - a binding the firmware can play (a plain press of a key or mouse button)
///   gets its record; one it cannot (text, macro, launch, a double or triple
///   press, a chord) gets the model's inert signal, never the old record;
/// - an unbound control keeps its record, except on layer 1 of Sidearm's own
///   onboard profile (the onboard path), where a leftover of an earlier
///   offline profile would play: there it gets the inert signal too;
/// - own offline bindings override layers 0 and 1 independently; otherwise
///   layer 1 follows the resolver: hypershift, else standard, with a left click
///   under a right-button trigger becoming a right click;
/// - the trigger becomes the firmware Hypershift key when a hypershift binding
///   is playable or an own offline-hypershift binding exists; the profile button
///   keeps switching banks.
pub fn plan(config: &AppConfig, model: &NativeModel, profile_id: &str) -> OfflinePlan {
    use crate::mouse_memory::live_overlay::{control_id, controls};
    let own_profile = model.transport == Transport::Onboard;
    let live = model.live.as_ref();
    let firmware_trigger = live.and_then(|live| live.firmware_trigger);
    let settings_trigger = config.settings.hypershift_trigger.trim();
    // The V3 has a firmware Hypershift button; the onboard path uses the
    // settings trigger, a native mouse button.
    let trigger = firmware_trigger.or_else(|| {
        own_profile
            .then(|| model.native_buttons.iter().find(|(control, _, _)| *control == settings_trigger))
            .flatten()
            .map(|&(_, button, _)| button)
    });
    let right_trigger = firmware_trigger.is_none() && settings_trigger == "mouse_right";
    let inert = |control: &str, own_binding: bool| -> Option<OnboardAction> {
        // A derived fallback keeps a native button's own behaviour; an explicit
        // silent assignment silences it too.
        if own_profile && !own_binding && let Some(&(_, _, value)) = model.native_buttons.iter().find(|(id, _, _)| *id == control) {
            return Some(OnboardAction::Mouse(value));
        }
        // Silent is consumer usage 0 (nothing), never one of Sidearm's signals:
        // those made a bank of silent buttons look like Sidearm's own bank, and
        // a profile the mouse plays (offline, or a V2 power cycle before its live
        // map is back) woke Sidearm's live actions.
        Some(OnboardAction::Consumer(BANK_SILENT_USAGE))
    };

    let mut planned = Vec::new();
    let mut uses_hypershift = false;
    for (control, button) in controls(model) {
        let id = control_id(model, control);
        let action = |layer| binding_action(config, model, profile_id, id.as_str(), layer);
        let standard = action(Layer::Standard);
        let hypershift = action(Layer::Hypershift);
        let offline = action(Layer::Offline);
        let offline_hypershift = action(Layer::OfflineHypershift);
        if Some(button) != live.and_then(|live| live.profile_button) {
            uses_hypershift |= offline_hypershift.is_some() || hypershift.is_some_and(|binding| binding.action.is_ok());
        }
        for (layer, logical, own, derived) in [
            (0, Layer::Offline, offline, standard),
            (1, Layer::OfflineHypershift, offline_hypershift, hypershift.or(standard)),
        ] {
            let chosen = own.or(derived);
            let translated = layer == 1 && own.is_none() && control == "mouse_left" && right_trigger;
            let action = if translated { Some(OnboardAction::Mouse(2)) } else {
                match chosen {
                    Some(binding) => binding.action.ok().or_else(|| inert(control, own.is_some())),
                    None if layer == 1 && own_profile => inert(control, false),
                    None => None,
                }
            };
            let role = (Some(button) == live.and_then(|live| live.profile_button)).then_some(OfflineRole::ProfileButton);
            let action = if role.is_some() { None } else { action };
            let native = match action { Some(OnboardAction::Mouse(value)) => native_action(value), _ => None };
            let kind = if role.is_some() { OfflineKind::Role } else if action.is_none() { OfflineKind::Preserved }
                else if matches!(action, Some(OnboardAction::Consumer(_))) || (chosen.is_some_and(|binding| binding.action.is_err()) && !matches!(action, Some(OnboardAction::Mouse(_)))) { OfflineKind::Silent }
                else if own.is_some() { OfflineKind::Own } else { OfflineKind::Inherited };
            let (reason, live_action_type) = if kind == OfflineKind::Silent {
                (chosen.and_then(|binding| binding.action.err()), chosen.and_then(|binding| binding.live_action_type))
            } else { (None, None) };
            planned.push(PlannedControl {
                preview: OfflineControl { control_id: id.as_str().into(), layer: logical, kind,
                    action_id: if role.is_some() || translated { None } else { chosen.filter(|binding| binding.action.is_ok() || native.is_none()).map(|binding| binding.action_id.to_owned()) }, native, role, reason, live_action_type, editable: role.is_none() },
                record: action.map(|action| OfflineRecord { button_id: button, layer, action }),
            });
        }
    }
    // Layer 1 plays only under the firmware Hypershift: the onboard path writes
    // it only with a trigger, a bank always (it may keep its own trigger).
    if own_profile && !(uses_hypershift && trigger.is_some()) {
        for control in planned.iter_mut().filter(|control| control.preview.layer == Layer::OfflineHypershift) {
            control.record = None;
            control.preview.kind = OfflineKind::Unavailable;
            control.preview.editable = false;
            control.preview.native = None;
            control.preview.reason = Some(OfflineReason::NoTrigger);
            control.preview.live_action_type = None;
        }
    }
    if uses_hypershift && let Some(trigger) = trigger {
        let trigger_id = controls(model).into_iter().find(|&(_, button)| button == trigger)
            .map_or_else(|| control_id(model, "hypershift_button"), |(id, _)| control_id(model, id));
        planned.retain(|control| control.preview.control_id != trigger_id.as_str());
        for (layer, logical) in [(0, Layer::Offline), (1, Layer::OfflineHypershift)] {
            planned.push(PlannedControl {
                preview: OfflineControl { control_id: trigger_id.as_str().into(), layer: logical, kind: OfflineKind::Role,
                    action_id: None, native: None, role: Some(OfflineRole::Hypershift), reason: None, live_action_type: None, editable: false },
                record: Some(OfflineRecord { button_id: trigger, layer, action: OnboardAction::Hypershift }),
            });
        }
    }
    if !own_profile {
        for (id, native) in [("mouse_left", "leftClick"), ("mouse_right", "rightClick")] {
            for layer in [Layer::Offline, Layer::OfflineHypershift] {
                planned.push(PlannedControl { preview: OfflineControl {
                    control_id: control_id(model, id).as_str().into(), layer, kind: OfflineKind::Role,
                    action_id: None, native: Some(native), role: Some(OfflineRole::NativeClick), reason: None, live_action_type: None, editable: false,
                }, record: None });
            }
        }
        if !uses_hypershift && firmware_trigger.is_some() {
            for layer in [Layer::Offline, Layer::OfflineHypershift] {
                planned.push(PlannedControl { preview: OfflineControl {
                    control_id: control_id(model, "hypershift_button").as_str().into(), layer, kind: OfflineKind::Role,
                    action_id: None, native: None, role: Some(OfflineRole::Hypershift), reason: None, live_action_type: None, editable: false,
                }, record: None });
            }
        }
    }
    OfflinePlan(planned)
}

#[derive(Clone, Copy)]
struct BindingAction<'a> {
    action_id: &'a str,
    action: Result<OnboardAction, OfflineReason>,
    live_action_type: Option<&'static str>,
}

/// No value means no binding; an unplayable binding retains its action id and reason.
fn binding_action<'a>(
    config: &'a AppConfig,
    model: &NativeModel,
    profile_id: &str,
    control: &str,
    layer: Layer,
) -> Option<BindingAction<'a>> {
    use crate::config::Gesture;
    let mut bindings = config.bindings.iter().filter(|b| {
        b.enabled && b.profile_id == profile_id && b.layer == layer && b.control_id.as_str() == control
    });
    // The firmware plays a record on every press, held while the button is
    // down (a hold): it can only play the plain press. A button with only a
    // long, double or triple press, or a chord, would fire on any press.
    let Some(binding) = bindings.clone().find(|b| Gesture::of(b.trigger_mode) == Gesture::Press) else {
        // Under HyperShift a press without its own binding plays the standard
        // one, as it does while Sidearm runs.
        return bindings.next().filter(|_| layer != Layer::Hypershift).map(|binding| BindingAction {
            action_id: binding.action_id.as_str(), action: Err(OfflineReason::Gesture), live_action_type: None,
        });
    };
    if binding.trigger_mode == Some(TriggerMode::Chord) {
        return Some(BindingAction { action_id: binding.action_id.as_str(), action: Err(OfflineReason::Gesture), live_action_type: None });
    }
    let action = config.actions.iter().find(|a| a.id == binding.action_id)?;
    let onboard = onboard_action(model, &action.payload);
    Some(BindingAction { action_id: action.id.as_str(), action: onboard,
        live_action_type: (onboard == Err(OfflineReason::ActionType)).then_some(action.action_type.as_str()) })
}

/// Native firmware action for `(profile_id, control, layer)` in a live hybrid bank,
/// or `None` when Sidearm must receive the press over a silent consumer signal.
/// Rejects unplayable action types, non-press gestures, chords, throttled bindings,
/// any extra enabled gesture on the effective layer (including Standard gestures
/// inherited under HyperShift), non-empty `action.conditions`, any enabled
/// `Hypershift2` / `HypershiftBoth` binding on `(profile_id, control)`, and any
/// profile that configures a HyperShift 2 trigger on `model` (holding HS2 must
/// suppress unbound buttons rather than firing native flash keys).
pub(crate) fn hybrid_native_action(
    config: &AppConfig,
    model: &NativeModel,
    profile_id: &str,
    control: &str,
    layer: Layer,
) -> Option<OnboardAction> {
    use crate::config::Gesture;
    if !matches!(layer, Layer::Standard | Layer::Hypershift) {
        return None;
    }
    // If this profile configures a HyperShift 2 trigger on `model`, holding HS2
    // must silence unbound buttons instead of letting native flash keys fire.
    if let Some(profile) = config.profiles.iter().find(|p| p.id == profile_id)
        && profile.hypershift2_triggers.iter().any(|trigger| {
            config.physical_controls.iter().any(|c| c.device_id == model.device_id && c.id.as_str() == trigger.as_str())
                || (!model.control_prefix.is_empty() && trigger.starts_with(model.control_prefix))
        })
    {
        return None;
    }
    // Any enabled HS2 / HS+HS2 binding on this control needs Sidearm to see presses.
    if config.bindings.iter().any(|b| {
        b.enabled
            && b.profile_id == profile_id
            && b.control_id.as_str() == control
            && matches!(b.layer, Layer::Hypershift2 | Layer::HypershiftBoth)
    }) {
        return None;
    }
    let layer_bindings = |wanted: Layer| -> Vec<&crate::config::Binding> {
        config
            .bindings
            .iter()
            .filter(|b| b.enabled && b.profile_id == profile_id && b.layer == wanted && b.control_id.as_str() == control)
            .collect()
    };
    let own = layer_bindings(layer);
    let standard = if layer == Layer::Hypershift {
        layer_bindings(Layer::Standard)
    } else {
        Vec::new()
    };
    // Per-gesture fallback: under HyperShift, extra gestures (Long/Double/Triple)
    // or chords on Standard remain reachable unless overridden, so ANY extra
    // gesture or chord on either layer requires Sidearm's timing engine.
    let has_timing_or_chord = |bindings: &[&crate::config::Binding]| {
        bindings.iter().any(|b| Gesture::of(b.trigger_mode) != Gesture::Press || b.trigger_mode == Some(TriggerMode::Chord))
    };
    if has_timing_or_chord(&own) || has_timing_or_chord(&standard) {
        return None;
    }
    let binding = own
        .into_iter()
        .find(|b| Gesture::of(b.trigger_mode) == Gesture::Press)
        .or_else(|| standard.into_iter().find(|b| Gesture::of(b.trigger_mode) == Gesture::Press))?;
    if binding.throttle_ms.unwrap_or(0) > 0 {
        return None;
    }
    let action = config.actions.iter().find(|a| a.id == binding.action_id)?;
    if !action.conditions.is_empty() {
        return None;
    }
    onboard_action(model, &action.payload).ok()
}

/// The firmware form of an action on `model`, when it has one.
fn onboard_action(model: &NativeModel, payload: &ActionPayload) -> Result<OnboardAction, OfflineReason> {
    match payload {
        ActionPayload::Shortcut(shortcut) => {
            let (ctrl, shift, alt, win) = (shortcut.ctrl, shortcut.shift, shortcut.alt, shortcut.win);
            let standard = left_modifier_bits(ctrl, shift, alt, win);
            // Modifier-only (push-to-talk): usage 0 = no key, the firmware holds
            // just the modifiers while the button is down. A firmware that drops
            // the left Shift/Alt gets the right-hand ones (a turbo record cannot
            // hold; the right Alt is AltGr on some layouts — a known limit).
            if shortcut.key.trim().is_empty() {
                let modifier = if model.plain_left_modifiers { standard } else { modifier_bits(ctrl, shift, alt, win) };
                return (modifier != 0).then_some(OnboardAction::Key { modifier, usage: 0 }).ok_or(OfflineReason::Key);
            }
            let key = crate::hotkeys::parse_primary_key(&shortcut.key).map_err(|_| OfflineReason::Key)?;
            let usage = hid_usage_for_vk(key.code).ok_or(OfflineReason::Key)?;
            // Such a firmware taps a shortcut with Shift or Alt through the
            // turbo record, which plays the real left keys (one tap per press).
            Ok(if (shift || alt) && !model.plain_left_modifiers {
                OnboardAction::KeyTap { modifier: standard, usage }
            } else {
                OnboardAction::Key { modifier: standard, usage }
            })
        }
        ActionPayload::MouseAction(mouse) => {
            if mouse.ctrl || mouse.shift || mouse.alt || mouse.win {
                return Err(OfflineReason::MouseModifiers);
            }
            Ok(OnboardAction::Mouse(match mouse.action {
                MouseActionKind::LeftClick => 1,
                MouseActionKind::RightClick => 2,
                MouseActionKind::MiddleClick => 3,
                MouseActionKind::MouseBack => 4,
                MouseActionKind::MouseForward => 5,
                // The wheel's own records (factory 0x09/0x0a hold these): a
                // plain scroll is played by the mouse itself without Sidearm.
                MouseActionKind::ScrollUp => 9,
                MouseActionKind::ScrollDown => 10,
                _ => return Err(OfflineReason::MouseModifiers),
            }))
        }
        _ => Err(OfflineReason::ActionType),
    }
}

/// The profile an exit stores: `Settings.offline_profile_id`, absent = the
/// fallback profile, `@active` = `in_effect` (the one following the focused
/// window; a restore process does not know it and takes the fallback).
pub fn offline_profile_id(config: &AppConfig, in_effect: Option<String>) -> String {
    match config.settings.offline_profile_id.as_deref() {
        Some(crate::config::OFFLINE_PROFILE_ACTIVE) => in_effect,
        Some(id) => config.profiles.iter().any(|p| p.id == id).then(|| id.to_owned()),
        None => None,
    }
    .unwrap_or_else(|| config.settings.fallback_profile_id.clone())
}

/// Writes a marker file atomically; a failure is logged (the marker is the only
/// trace of what the mouse holds).
pub(crate) fn write_marker(path: &Path, text: &str) {
    if let Err(error) = crate::config::persist_atomically(path, |file| std::io::Write::write_all(file, text.as_bytes())) {
        log::warn!("[mouse-offline] {} not written: {error}", path.display());
    }
}

/// Puts back the live speed the per-app profiles changed: the offline
/// profile's own poll rate (and DPI with `dpi_too`; a V3 bank switch sets its
/// own), else what the mouse had before Sidearm's first switch this run.
pub(crate) fn restore_live_speed(device: &VendorDevice, config: &AppConfig, profile_id: &str, dpi_too: bool) -> Result<(), String> {
    let model = device.model();
    let own = config.profiles.iter().find(|p| p.id == profile_id).and_then(|p| p.mouse_for(model.device_id));
    let original = crate::mouse_speed::originals(model.device_id);
    let poll = own.and_then(|own| own.mouse_poll_rate_hz).filter(|hz| model.poll_code_for_hz(*hz).is_some());
    let poll_result = (|| match poll.or(original.poll_rate_hz) {
        Some(hz) if device.poll_rate_hz()? != hz => device.set_poll_rate_hz(hz),
        _ => Ok(()),
    })();
    let dpi = own.and_then(|own| own.mouse_dpi).map(|dpi| dpi.clamp(model.dpi_min, model.dpi_max));
    let dpi_result = match dpi.or(original.dpi) {
        Some(dpi) if dpi_too && device.dpi()? != dpi => device.set_dpi(dpi, false),
        _ => Ok(()),
    };
    poll_result.and(dpi_result)
}

/// Writes the offline profile into every connected mouse. Best effort: a
/// record the mouse refuses is logged and skipped. The onboard path leaves the
/// marker only when the mouse took a record; any mouse that took nothing
/// because it slept leaves [`OFFLINE_FAILED_FILE`] instead (the profile on its
/// first line, then the device id of each such mouse), which the next start
/// reports and the restore process retries ([`retry_offline_profile`]).
/// A stalled exit worker leaves the target device ids pending, even if a
/// receiver is temporarily absent when the restore process first retries.
pub fn write_offline_profile(config: &AppConfig, profile_id: &str, config_dir: &Path) {
    let (worker_config, profile, dir) = (config.clone(), profile_id.to_owned(), config_dir.to_owned());
    write_offline_bounded(config, config_dir, profile_id, std::time::Duration::from_secs(30), move |targets| {
        write_offline_to(&worker_config, &profile, &dir, Some(&targets));
    });
}

fn write_offline_bounded(config: &AppConfig, config_dir: &Path, profile_id: &str, timeout: std::time::Duration, work: impl FnOnce(Vec<String>) + Send + 'static) -> bool {
    let targets: Vec<_> = crate::mouse_memory::present_models().into_iter()
        // An onboard mouse's profile 1 already holds the offline profile (`store_onboard_offline`).
        .filter(|model| model.verified && model.transport == Transport::LiveOverlay && crate::mouse_memory::live_overlay::configured(config, model))
        .map(|model| model.device_id.to_owned())
        .collect();
    // Queue before touching HID: neither a held device lock nor a driver call
    // may keep the app alive and prevent its restore process from taking over.
    write_marker(&config_dir.join(OFFLINE_FAILED_FILE), &std::iter::once(profile_id.to_owned()).chain(targets.iter().cloned()).collect::<Vec<_>>().join("\n"));
    let (done, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::Builder::new().name("mouse-offline".into()).spawn(move || {
        work(targets);
        let _ = done.send(());
    });
    if let Err(error) = worker {
        log::warn!("[mouse-offline] exit worker not started; restore pending: {error}");
        return false;
    }
    // Do not join: a detached worker ends with the process, releasing its HID
    // handle and lock before the existing restorer can open the receiver.
    if receiver.recv_timeout(timeout).is_err() {
        log::warn!("[mouse-offline] exit write did not finish; restore pending");
        return false;
    }
    true
}

/// Writes the profile [`OFFLINE_FAILED_FILE`] names into the mice it names,
/// and no other (a mouse that took it must not be rewritten every retry).
/// Returns whether nothing is left pending.
pub fn retry_offline_profile(config: &AppConfig, config_dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(config_dir.join(OFFLINE_FAILED_FILE)) else { return true };
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let Some(profile_id) = lines.next() else { return true };
    let pending: Vec<String> = lines.map(str::to_owned).collect();
    // A marker without mice (older format) retries them all.
    write_offline_to(config, profile_id, config_dir, (!pending.is_empty()).then_some(pending.as_slice()));
    !config_dir.join(OFFLINE_FAILED_FILE).exists()
}

fn write_offline_to(config: &AppConfig, profile_id: &str, config_dir: &Path, only: Option<&[String]>) {
    use crate::device_catalog::CATALOG;
    use crate::mouse_memory::live_overlay;
    // An onboard mouse is never written here (an older marker may still name it).
    let only: Option<Vec<String>> = only.map(|ids| {
        ids.iter().filter(|id| CATALOG.iter().any(|model| model.device_id == id.as_str() && model.transport == Transport::LiveOverlay)).cloned().collect()
    });
    let only = only.as_deref();
    let wanted = |device_id: &str| only.is_none_or(|ids| ids.iter().any(|id| id == device_id));
    let present = crate::mouse_memory::present_models();
    // One writer per mouse; each returns the device id of a mouse that slept.
    let mut writers: Vec<Box<dyn FnOnce() -> Option<String> + Send + '_>> = Vec::new();
    for &model in &present {
        if model.transport != Transport::LiveOverlay || !live_overlay::configured(config, model) || !wanted(model.device_id) {
            continue;
        }
        writers.push(Box::new(move || {
            let error = live_overlay::write_offline(config, model, profile_id, config_dir).err()?;
            log::warn!("[mouse-offline] {} profile `{profile_id}` was not stored: {error}", model.name);
            crate::mouse_memory::is_no_response(&error).then(|| model.device_id.to_owned())
        }));
    }
    if only.is_none() {
        writers.push(Box::new(|| restore_onboard_speed(config)));
    }
    // Each model has its own device lock (`DEVICE_LOCKS`): two mice are written
    // side by side, so a sleeping one does not hold up the other.
    let mut slept: Vec<String> = if writers.len() < 2 {
        writers.into_iter().filter_map(|write| write()).collect()
    } else {
        std::thread::scope(|scope| {
            let running: Vec<_> = writers.into_iter().map(|write| scope.spawn(write)).collect();
            running.into_iter().filter_map(|writer| writer.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))).collect()
        })
    };
    // A retry keeps waiting for a mouse that is switched off for now.
    if let Some(ids) = only {
        for id in ids {
            if !present.iter().any(|model| model.device_id == id.as_str()) && !slept.contains(id) {
                slept.push(id.clone());
            }
        }
    }
    let failed_marker = config_dir.join(OFFLINE_FAILED_FILE);
    if slept.is_empty() {
        let _ = std::fs::remove_file(&failed_marker);
    } else {
        write_marker(&failed_marker, &std::iter::once(profile_id.to_owned()).chain(slept).collect::<Vec<_>>().join("\n"));
    }
}

/// An exit gives the onboard mouse back the live speed the per-app profiles
/// changed (RAM only: its profile 1 already holds the offline profile). Best
/// effort; never queued for a retry.
fn restore_onboard_speed(config: &AppConfig) -> Option<String> {
    let Ok(device) = VendorDevice::open_onboard() else { return None };
    if device.model().verified
        && let Err(message) = restore_live_speed(&device, config, &offline_profile_id(config, None), true)
    {
        log::warn!("[mouse-offline] {} live DPI / poll rate not put back: {message}", device.model().name);
    }
    None
}

/// The profile an onboard mouse keeps in profile 1: the offline profile, with
/// `@active` taken as the fallback (owner's call 2026-11-19 — it is stored
/// while Sidearm runs, not at the exit that knows the window in front).
fn onboard_offline_profile(config: &AppConfig) -> String {
    offline_profile_id(config, None)
}

fn onboard_offline_dpi(config: &AppConfig, model: &crate::device_catalog::NativeModel, profile_id: &str) -> Option<u16> {
    config.profiles.iter().find(|p| p.id == profile_id)
        .and_then(|p| p.mouse_for(model.device_id))
        .and_then(|own| own.mouse_dpi)
        .map(|dpi| dpi.clamp(model.dpi_min, model.dpi_max))
}

/// A fingerprint of what [`store_onboard_offline`] writes into `model`.
pub(crate) fn onboard_offline_key(config: &AppConfig, model: &crate::device_catalog::NativeModel) -> u64 {
    use std::hash::{Hash, Hasher};
    let profile_id = onboard_offline_profile(config);
    let what = (plan(config, model, &profile_id).records(), onboard_offline_dpi(config, model, &profile_id));
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!("{what:?}").hash(&mut hasher);
    hasher.finish().max(1)
}

/// Stores the offline profile in an onboard mouse's profile 1 (the V2's), where
/// it stays: its records (`write_record` skips one that already holds it) and
/// its own DPI. Run by the mouse's live session while Sidearm runs, never at an
/// exit, so an exit, a kill or a sleeping mouse leaves its buttons working
/// without Sidearm. A profile-1 write plays at once (measured 2026-11-20): the
/// caller rewrites its live map after it. `Err`: the mouse did not answer;
/// a record it refused otherwise is logged.
pub(crate) fn store_onboard_offline(device: &VendorDevice, config: &AppConfig) -> Result<(), String> {
    let model = device.model();
    let profile_id = onboard_offline_profile(config);
    let records = plan(config, model, &profile_id).records();
    let mut failed = 0;
    for record in &records {
        if let Err(error) = device.write_record(record.button_id, record.layer, record.action) {
            if crate::mouse_memory::is_no_response(&error) {
                return Err(error);
            }
            log::warn!("[mouse-offline] {error}");
            failed += 1;
        }
    }
    // Profile switches set the DPI live only: store the offline profile's own;
    // a profile without one leaves the mouse's stored DPI alone.
    if let Some(dpi) = onboard_offline_dpi(config, model, &profile_id)
        && let Err(message) = device.set_dpi(dpi, true)
    {
        if crate::mouse_memory::is_no_response(&message) {
            return Err(message);
        }
        log::warn!("[mouse-offline] DPI not stored: {message}");
    }
    log::info!("[mouse-offline] {} keeps profile `{profile_id}` for use without Sidearm: {} records, {failed} failed", model.name, records.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Binding, ControlId, MouseActionPayload, ShortcutActionPayload};
    use crate::device_catalog::{NAGA_V2_HYPERSPEED, NAGA_V3_PRO};

    fn shortcut(key: &str, ctrl: bool, shift: bool, alt: bool) -> ActionPayload {
        ActionPayload::Shortcut(ShortcutActionPayload { key: key.into(), ctrl, shift, alt, win: false, raw: None })
    }

    #[test]
    fn the_v2_taps_shift_and_alt_through_the_turbo_record() {
        let v2 = &NAGA_V2_HYPERSPEED;
        assert_eq!(onboard_action(v2, &shortcut("T", true, true, false)), Ok(OnboardAction::KeyTap { modifier: 0x03, usage: 0x17 }));
        assert_eq!(onboard_action(v2, &shortcut("F4", false, false, true)), Ok(OnboardAction::KeyTap { modifier: 0x04, usage: 0x3d }));
        assert_eq!(onboard_action(v2, &shortcut("Delete", false, false, false)), Ok(OnboardAction::Key { modifier: 0, usage: 0x4c }));
        // A hold cannot be a turbo record: the right-hand keys this firmware plays.
        assert_eq!(onboard_action(v2, &shortcut("", true, true, false)), Ok(OnboardAction::Key { modifier: 0x21, usage: 0 }));
        assert_eq!(onboard_action(v2, &shortcut("", false, false, false)), Err(OfflineReason::Key), "empty shortcut");
    }

    /// The V3 repeats a stored turbo record on its own: plain records with the
    /// standard mask only, push-to-talk included (its right Alt is AltGr).
    #[test]
    fn the_v3_gets_plain_records_with_the_standard_mask() {
        let v3 = &NAGA_V3_PRO;
        assert_eq!(onboard_action(v3, &shortcut("F4", false, false, true)), Ok(OnboardAction::Key { modifier: 0x04, usage: 0x3d }));
        assert_eq!(onboard_action(v3, &shortcut("T", true, true, false)), Ok(OnboardAction::Key { modifier: 0x03, usage: 0x17 }));
        assert_eq!(onboard_action(v3, &shortcut("", false, false, true)), Ok(OnboardAction::Key { modifier: 0x04, usage: 0 }));
    }

    #[test]
    fn mouse_buttons_and_the_wheel_have_a_firmware_form() {
        let mouse = |action| ActionPayload::MouseAction(MouseActionPayload { action, ctrl: false, shift: false, alt: false, win: false });
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            assert_eq!(onboard_action(model, &mouse(MouseActionKind::MouseBack)), Ok(OnboardAction::Mouse(4)));
            assert_eq!(onboard_action(model, &mouse(MouseActionKind::ScrollUp)), Ok(OnboardAction::Mouse(9)));
            assert_eq!(onboard_action(model, &mouse(MouseActionKind::ScrollDown)), Ok(OnboardAction::Mouse(10)));
        }
    }

    /// The seed config with no bindings in its first profile, and that profile.
    fn empty_profile() -> (AppConfig, String) {
        let mut config = crate::config::default_seed_config();
        let profile = config.profiles[0].id.clone();
        config.bindings.retain(|binding| binding.profile_id != profile);
        (config, profile)
    }

    fn bind(config: &mut AppConfig, profile: &str, control: &str, layer: Layer, payload: ActionPayload, trigger_mode: Option<TriggerMode>) {
        let id = format!("test-{control}-{layer:?}");
        let mut action = config.actions[0].clone();
        action.id = id.clone();
        action.payload = payload;
        config.actions.push(action);
        config.bindings.push(Binding {
            id: id.clone(),
            profile_id: profile.into(),
            layer,
            control_id: ControlId::new(control),
            label: "test".into(),
            action_id: id,
            color_tag: None,
            trigger_mode,
            chord_partner: None,
            enabled: true,
            throttle_ms: None,
        });
    }

    fn record(records: &[OfflineRecord], button_id: u8, layer: u8) -> Option<OnboardAction> {
        records.iter().find(|record| record.button_id == button_id && record.layer == layer).map(|record| record.action)
    }

    fn preview_control(config: &AppConfig, model: &NativeModel, profile: &str, id: &str, layer: Layer) -> OfflineControl {
        let shown = preview(config, model, profile, None);
        let planned = plan(config, model, profile);
        assert_eq!(shown.controls, planned.0.iter().map(|control| control.preview.clone()).collect::<Vec<_>>());
        for control in &planned.0 {
            let view = &control.preview;
            let expected = match view.kind {
                OfflineKind::Preserved | OfflineKind::Unavailable => None,
                OfflineKind::Role => match view.role {
                    Some(OfflineRole::Hypershift) if control.record.is_some() => Some(OnboardAction::Hypershift),
                    _ => None,
                },
                OfflineKind::Silent => {
                    assert!(matches!(control.record.map(|r| r.action), Some(OnboardAction::Consumer(_) | OnboardAction::Key { .. } | OnboardAction::KeyTap { .. })));
                    control.record.map(|r| r.action)
                }
                OfflineKind::Own | OfflineKind::Inherited => view.native.and_then(|native| {
                    (1..=10).find(|&value| native_action(value) == Some(native)).map(OnboardAction::Mouse)
                }).or_else(|| view.action_id.as_ref().and_then(|id| config.actions.iter().find(|a| a.id == *id)).and_then(|a| onboard_action(model, &a.payload).ok())),
            };
            assert_eq!(control.record.map(|r| r.action), expected, "{view:?}");
            let serialized = serde_json::to_value(view).unwrap();
            if !matches!(view.kind, OfflineKind::Silent | OfflineKind::Unavailable) {
                assert!(serialized.get("reason").is_none(), "{view:?}");
            }
            if serialized["reason"] != "actionType" {
                assert!(serialized.get("liveActionType").is_none(), "{view:?}");
            }
        }
        shown.controls.into_iter().find(|control| control.control_id == id && control.layer == layer).unwrap()
    }

    #[test]
    fn preview_f1_firmware_trigger_wins_over_own_key_or_silence() {
        for (model, id) in [(&NAGA_V2_HYPERSPEED, "mouse_right"), (&NAGA_V3_PRO, "v3_hypershift_button")] {
            for payload in [shortcut("C", true, false, false), ActionPayload::Disabled(Default::default())] {
                let (mut config, profile) = empty_profile();
                let thumb = crate::mouse_memory::live_overlay::control_id(model, "thumb_01");
                bind(&mut config, &profile, thumb.as_str(), Layer::OfflineHypershift, shortcut("A", false, false, false), None);
                for layer in [Layer::Offline, Layer::OfflineHypershift] {
                    bind(&mut config, &profile, id, layer, payload.clone(), None);
                    let view = preview_control(&config, model, &profile, id, layer);
                    assert_eq!(view.kind, OfflineKind::Role);
                    assert_eq!(view.role, Some(OfflineRole::Hypershift));
                    assert!(!view.editable);
                    assert!(view.action_id.is_none());
                }
            }
        }
    }

    #[test]
    fn preview_f2_f3_v3_profile_button_and_native_clicks_keep_their_roles() {
        for payload in [shortcut("C", true, false, false), ActionPayload::Disabled(Default::default())] {
            let (mut config, profile) = empty_profile();
            for (id, role, native) in [("v3_top_special_03", OfflineRole::ProfileButton, None),
                ("v3_mouse_left", OfflineRole::NativeClick, Some("leftClick")), ("v3_mouse_right", OfflineRole::NativeClick, Some("rightClick"))] {
                for layer in [Layer::Offline, Layer::OfflineHypershift] {
                    bind(&mut config, &profile, id, layer, payload.clone(), None);
                    let view = preview_control(&config, &NAGA_V3_PRO, &profile, id, layer);
                    assert_eq!((view.kind, view.role, view.native, view.editable), (OfflineKind::Role, Some(role), native, false));
                    assert!(view.action_id.is_none());
                }
            }
        }
    }

    #[test]
    fn preview_f4_absent_bindings_preserve_records_without_claiming_an_action() {
        let (config, profile) = empty_profile();
        for (model, id) in [(&NAGA_V3_PRO, "v3_thumb_01"), (&NAGA_V2_HYPERSPEED, "wheel_click")] {
            let view = preview_control(&config, model, &profile, id, Layer::Offline);
            assert_eq!((view.kind, view.native, view.editable), (OfflineKind::Preserved, None, true));
            assert!(view.action_id.is_none());
        }
    }

    #[test]
    fn preview_b16_preserved_v3_wheel_click_keeps_its_unknown_record() {
        let (config, profile) = empty_profile();
        for layer in [Layer::Offline, Layer::OfflineHypershift] {
            let view = preview_control(&config, &NAGA_V3_PRO, &profile, "v3_wheel_click", layer);
            assert_eq!((view.kind, view.native, view.action_id), (OfflineKind::Preserved, None, None));
        }
        assert!(plan(&config, &NAGA_V3_PRO, &profile).0.iter()
            .filter(|control| control.preview.control_id == "v3_wheel_click")
            .all(|control| control.record.is_none()));
    }

    #[test]
    fn preview_f5_inherited_unplayable_native_keeps_its_native_click() {
        for payload in [ActionPayload::Disabled(Default::default()),
            ActionPayload::MouseAction(MouseActionPayload { action: MouseActionKind::LeftClick, ctrl: true, shift: false, alt: false, win: false }),
            crate::config::default_seed_config().actions.into_iter().find(|a| matches!(a.payload, ActionPayload::TextSnippet(_))).unwrap().payload] {
            let (mut config, profile) = empty_profile();
            bind(&mut config, &profile, "wheel_click", Layer::Standard, payload, None);
            let view = preview_control(&config, &NAGA_V2_HYPERSPEED, &profile, "wheel_click", Layer::Offline);
            assert_eq!((view.kind, view.native), (OfflineKind::Inherited, Some("middleClick")));
            assert!(view.action_id.is_none());
        }
    }

    #[test]
    fn preview_b17_v2_text_binding_shows_the_written_native_fallback() {
        let (mut config, profile) = empty_profile();
        let text = config.actions.iter().find(|action| matches!(action.payload, ActionPayload::TextSnippet(_))).unwrap().payload.clone();
        bind(&mut config, &profile, "wheel_click", Layer::Standard, text, None);
        let view = preview_control(&config, &NAGA_V2_HYPERSPEED, &profile, "wheel_click", Layer::Offline);
        assert_eq!((view.kind, view.action_id, view.native), (OfflineKind::Inherited, None, Some("middleClick")));
        assert_eq!(record(&plan(&config, &NAGA_V2_HYPERSPEED, &profile).records(), 3, 0), Some(OnboardAction::Mouse(3)));
    }

    #[test]
    fn preview_f6_right_trigger_translates_left_click_unless_it_has_an_own_override() {
        let (mut config, profile) = empty_profile();
        bind(&mut config, &profile, "thumb_01", Layer::Hypershift, shortcut("A", false, false, false), None);
        bind(&mut config, &profile, "mouse_left", Layer::Standard, shortcut("C", true, false, false), None);
        let view = preview_control(&config, &NAGA_V2_HYPERSPEED, &profile, "mouse_left", Layer::OfflineHypershift);
        assert_eq!((view.kind, view.native, view.action_id), (OfflineKind::Inherited, Some("rightClick"), None));
        bind(&mut config, &profile, "mouse_left", Layer::OfflineHypershift, shortcut("C", true, false, false), None);
        let view = preview_control(&config, &NAGA_V2_HYPERSPEED, &profile, "mouse_left", Layer::OfflineHypershift);
        assert_eq!(view.kind, OfflineKind::Own);
        assert!(view.native.is_none());
    }

    #[test]
    fn preview_f7_layer_one_is_unavailable_without_a_trigger() {
        let (mut config, profile) = empty_profile();
        config.settings.hypershift_trigger = "none".into();
        bind(&mut config, &profile, "thumb_01", Layer::OfflineHypershift, shortcut("C", true, false, false), None);
        let view = preview_control(&config, &NAGA_V2_HYPERSPEED, &profile, "thumb_01", Layer::OfflineHypershift);
        assert_eq!((view.kind, view.editable), (OfflineKind::Unavailable, false));
        assert!(plan(&config, &NAGA_V2_HYPERSPEED, &profile).records().iter().all(|r| r.layer == 0));
    }

    #[test]
    fn preview_f8_bank_target_uses_actual_inventory_and_shared_bank_plan() {
        let _one = crate::mouse_memory::live_overlay::tests::V2_STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        use crate::mouse_memory::live_overlay::Banks;
        let (mut config, profile) = empty_profile();
        config.settings.offline_profile_id = Some(profile.clone());
        let target = |config: &AppConfig, assigned: Vec<u8>| preview(config, &NAGA_V3_PRO, &profile, Some(&Banks { active: assigned[0], assigned })).target;
        assert_eq!(target(&config, vec![1, 2]).state, TargetState::NotWritten);
        assert_eq!(target(&config, vec![2]).state, TargetState::Written);
        assert_eq!(target(&config, vec![2]).bank, Some(2));
        config.profiles[0].device_slots = Some([("razer-naga-v3".into(), 3)].into());
        assert_eq!(target(&config, vec![1, 2]).state, TargetState::NotWritten);
        assert_eq!(target(&config, vec![1, 3]).bank, Some(3));
        assert_eq!(preview(&config, &NAGA_V3_PRO, &profile, None).target.state, TargetState::Unknown);
        config.profiles[0].device_slots = None;
        config.settings.offline_profile_id = Some(crate::config::OFFLINE_PROFILE_ACTIVE.into());
        assert_eq!(target(&config, vec![1]).state, TargetState::FollowsWindow);
        // The V2 keeps the fallback for `@active` (stored while Sidearm runs).
        let v2 = preview(&config, &NAGA_V2_HYPERSPEED, &profile, None).target.state;
        // Not stored by this run (no session here): pending, not written.
        assert_eq!(v2, if config.settings.fallback_profile_id == profile { TargetState::Pending } else { TargetState::NotWritten });
        config.settings.offline_profile_id = Some(config.profiles[1].id.clone());
        assert_eq!(preview(&config, &NAGA_V2_HYPERSPEED, &profile, None).target.state, TargetState::NotWritten);
    }

    #[test]
    fn preview_b15_active_profile_with_linked_banks_does_not_claim_a_playing_bank() {
        use crate::mouse_memory::live_overlay::Banks;
        let (mut config, profile) = empty_profile();
        let other = config.profiles[1].id.clone();
        config.settings.offline_profile_id = Some(crate::config::OFFLINE_PROFILE_ACTIVE.into());
        config.profiles[0].device_slots = Some([("razer-naga-v3".into(), 3)].into());
        config.profiles[1].device_slots = Some([("razer-naga-v3".into(), 2)].into());
        let inventory = Banks { active: 4, assigned: vec![1, 2, 3] };
        for (requested, state, bank) in [(&profile, TargetState::Written, Some(3)), (&other, TargetState::Written, Some(2)),
            (&"unlinked".into(), TargetState::NotWritten, None)] {
            let target = preview(&config, &NAGA_V3_PRO, requested, Some(&inventory)).target;
            assert_eq!((target.state, target.bank, target.playing_bank), (state, bank, None));
            assert_eq!(serde_json::to_value(target.banks).unwrap(),
                serde_json::json!([{"bank": 3, "profileId": profile}, {"bank": 2, "profileId": other}]));
        }
    }

    #[test]
    fn preview_w5_action_type_reason_names_the_live_action() {
        use crate::config::{ActionType, MenuActionPayload, SequenceActionPayload};
        let text = crate::config::default_seed_config().actions.into_iter()
            .find(|action| action.action_type == ActionType::TextSnippet).unwrap().payload;
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            for (action_type, payload, name) in [
                (ActionType::TextSnippet, text.clone(), "textSnippet"),
                (ActionType::Menu, ActionPayload::Menu(MenuActionPayload { items: vec![] }), "menu"),
                (ActionType::Sequence, ActionPayload::Sequence(SequenceActionPayload { steps: vec![] }), "sequence"),
                (ActionType::Disabled, ActionPayload::Disabled(Default::default()), "disabled"),
            ] {
                let (mut config, profile) = empty_profile();
                let id = crate::mouse_memory::live_overlay::control_id(model, "thumb_01");
                bind(&mut config, &profile, id.as_str(), Layer::Standard, payload, None);
                config.actions.last_mut().unwrap().action_type = action_type;
                let view = serde_json::to_value(preview_control(&config, model, &profile, id.as_str(), Layer::Offline)).unwrap();
                assert_eq!(view["kind"], "silent");
                assert_eq!(view["reason"], "actionType");
                assert_eq!(view["liveActionType"], name);
                assert_eq!(view["actionId"], format!("test-{}-Standard", id.as_str()));
            }
        }
    }

    #[test]
    fn preview_w5_gesture_reason_comes_from_binding_selection() {
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            for mode in [TriggerMode::LongPress, TriggerMode::DoublePress, TriggerMode::TriplePress, TriggerMode::Chord] {
                for layer in [Layer::Standard, Layer::Offline] {
                    let (mut config, profile) = empty_profile();
                    let id = crate::mouse_memory::live_overlay::control_id(model, "thumb_01");
                    bind(&mut config, &profile, id.as_str(), layer, shortcut("A", false, false, false), Some(mode));
                    let view = serde_json::to_value(preview_control(&config, model, &profile, id.as_str(), Layer::Offline)).unwrap();
                    assert_eq!(view["kind"], "silent");
                    assert_eq!(view["reason"], "gesture", "{model:?} {mode:?} {layer:?}");
                    assert!(view.get("liveActionType").is_none());
                }
            }
        }
    }

    #[test]
    fn preview_w5_key_reason_covers_unparsable_unstorable_and_empty_keys() {
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            for key in ["VK_175", "VK_107", "not-a-key", ""] {
                let (mut config, profile) = empty_profile();
                let id = crate::mouse_memory::live_overlay::control_id(model, "thumb_01");
                bind(&mut config, &profile, id.as_str(), Layer::Offline, shortcut(key, false, false, false), None);
                let view = serde_json::to_value(preview_control(&config, model, &profile, id.as_str(), Layer::Offline)).unwrap();
                assert_eq!(view["kind"], "silent");
                assert_eq!(view["reason"], "key", "{key}");
                assert!(view.get("liveActionType").is_none());
            }
        }
    }

    #[test]
    fn preview_w5_mouse_reason_covers_each_modifier_and_unsupported_actions() {
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            for (action, ctrl, shift, alt, win) in [
                (MouseActionKind::LeftClick, true, false, false, false),
                (MouseActionKind::LeftClick, false, true, false, false),
                (MouseActionKind::LeftClick, false, false, true, false),
                (MouseActionKind::LeftClick, false, false, false, true),
                (MouseActionKind::DpiUp, false, false, false, false),
            ] {
                let (mut config, profile) = empty_profile();
                let id = crate::mouse_memory::live_overlay::control_id(model, "thumb_01");
                bind(&mut config, &profile, id.as_str(), Layer::Offline,
                    ActionPayload::MouseAction(MouseActionPayload { action, ctrl, shift, alt, win }), None);
                let view = serde_json::to_value(preview_control(&config, model, &profile, id.as_str(), Layer::Offline)).unwrap();
                assert_eq!(view["kind"], "silent");
                assert_eq!(view["reason"], "mouseModifiers");
                assert!(view.get("liveActionType").is_none());
            }
        }
    }

    #[test]
    fn preview_w5_unavailable_layer_replaces_binding_reason_with_no_trigger() {
        for trigger in ["none", "mouse_right"] {
            let (mut config, profile) = empty_profile();
            config.settings.hypershift_trigger = trigger.into();
            if trigger == "none" {
                bind(&mut config, &profile, "thumb_01", Layer::OfflineHypershift, ActionPayload::Disabled(Default::default()), None);
            }
            let view = serde_json::to_value(preview_control(&config, &NAGA_V2_HYPERSPEED, &profile, "thumb_01", Layer::OfflineHypershift)).unwrap();
            assert_eq!(view["kind"], "unavailable");
            assert_eq!(view["reason"], "noTrigger");
            assert!(view.get("liveActionType").is_none());
        }
    }

    /// "Written" only once this run stored that very profile in the V2.
    #[test]
    fn the_v2_preview_says_written_only_after_the_store() {
        let _one = crate::mouse_memory::live_overlay::tests::V2_STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (mut config, profile) = empty_profile();
        config.settings.fallback_profile_id = profile.clone();
        let state = |config: &AppConfig| preview(config, &NAGA_V2_HYPERSPEED, &profile, None).target.state;
        let (device, _fake) = fake_v2();
        assert_eq!(state(&config), TargetState::Pending);
        let _ = crate::mouse_memory::live_overlay::tests::store_v2_offline(&device, &config);
        assert_eq!(state(&config), TargetState::Written);
        bind(&mut config, &profile, "thumb_01", Layer::Offline, shortcut("U", true, false, false), None);
        assert_eq!(state(&config), TargetState::Pending, "an unsaved change is not in the mouse");
        crate::mouse_memory::live_overlay::tests::forget_v2_store();
    }

    #[test]
    fn preview_w5_v2_not_written_names_the_exit_profile() {
        let _one = crate::mouse_memory::live_overlay::tests::V2_STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (mut config, profile) = empty_profile();
        let other = config.profiles[1].id.clone();
        for setting in [None, Some(other.clone()), Some("missing-profile".into())] {
            config.settings.offline_profile_id = setting.clone();
            config.settings.fallback_profile_id = if setting.is_none() { other.clone() } else { profile.clone() };
            let target = serde_json::to_value(preview(&config, &NAGA_V2_HYPERSPEED, &profile, None).target).unwrap();
            if setting.as_deref() == Some("missing-profile") {
                assert_eq!(target, serde_json::json!({"state": "pending"}), "kept, not stored by this run yet");
            } else {
                assert_eq!(target, serde_json::json!({"state": "notWritten", "writtenProfileId": other}));
            }
        }
    }

    #[test]
    fn preview_w5_v3_banks_are_the_exit_plan_for_written_and_unwritten_profiles() {
        use crate::mouse_memory::live_overlay::Banks;
        let (mut config, profile) = empty_profile();
        let other = config.profiles[1].id.clone();
        config.settings.offline_profile_id = Some(profile.clone());
        config.profiles[0].device_slots = Some([("razer-naga-v3".into(), 3)].into());
        config.profiles[1].device_slots = Some([("razer-naga-v3".into(), 2)].into());
        let inventory = Banks { active: 1, assigned: vec![1, 2, 3] };
        for (requested, state, bank) in [(&profile, "written", Some(3)), (&other, "written", Some(2)), (&"unlinked".into(), "notWritten", None)] {
            let target = serde_json::to_value(preview(&config, &NAGA_V3_PRO, requested, Some(&inventory)).target).unwrap();
            assert_eq!(target["state"], state);
            assert_eq!(target["bank"], serde_json::json!(bank));
            assert_eq!(target["banks"], serde_json::json!([{"bank": 3, "profileId": profile}, {"bank": 2, "profileId": other}]));
            assert!(target.get("writtenProfileId").is_none());
            // The exit selects the offline profile's bank: bank 3, whichever profile is shown.
            assert_eq!(target["playingBank"], 3);
        }
        config.profiles[0].device_slots = Some([("razer-naga-v3".into(), 5)].into());
        config.profiles[1].device_slots = None;
        let target = serde_json::to_value(preview(&config, &NAGA_V3_PRO, &other, Some(&inventory)).target).unwrap();
        assert_eq!(target, serde_json::json!({"state": "notWritten", "banks": []}));
        let one = Banks { active: 2, assigned: vec![2] };
        let target = serde_json::to_value(preview(&config, &NAGA_V3_PRO, &other, Some(&one)).target).unwrap();
        assert_eq!(target, serde_json::json!({"state": "notWritten", "banks": [{"bank": 2, "profileId": profile}], "playingBank": 2}));
    }

    #[test]
    fn preview_w5_dynamic_and_unknown_targets_omit_unresolved_fields() {
        let _one = crate::mouse_memory::live_overlay::tests::V2_STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        use crate::mouse_memory::live_overlay::Banks;
        let (mut config, profile) = empty_profile();
        config.settings.offline_profile_id = Some(crate::config::OFFLINE_PROFILE_ACTIVE.into());
        let one = Banks { active: 1, assigned: vec![1] };
        for (model, banks, state) in [(&NAGA_V3_PRO, Some(&one), "followsWindow"), (&NAGA_V3_PRO, None, "unknown")] {
            let target = serde_json::to_value(preview(&config, model, &profile, banks).target).unwrap();
            assert_eq!(target, serde_json::json!({"state": state}));
        }
        // The V2 keeps the fallback for `@active` (stored while Sidearm runs).
        let v2 = serde_json::to_value(preview(&config, &NAGA_V2_HYPERSPEED, &profile, None).target).unwrap();
        let fallback = config.settings.fallback_profile_id.clone();
        if fallback == profile {
            assert_eq!(v2, serde_json::json!({"state": "pending"}));
        } else {
            assert_eq!(v2, serde_json::json!({"state": "notWritten", "writtenProfileId": fallback}));
        }
    }

    #[test]
    fn own_silence_without_standard_mapping_is_stored_and_previewed() {
        for payload in [ActionPayload::Disabled(Default::default()), shortcut("VK_175", false, false, false)] {
            let (mut config, profile) = empty_profile();
            config.encoder_mappings.retain(|mapping| mapping.control_id.as_str() != "thumb_01");
            for layer in [Layer::Offline, Layer::OfflineHypershift] {
                bind(&mut config, &profile, "thumb_01", layer, payload.clone(), None);
                let view = preview_control(&config, &NAGA_V2_HYPERSPEED, &profile, "thumb_01", layer);
                assert_eq!(view.kind, OfflineKind::Silent);
            }
            let (device, _fake) = fake_v2();
            fake::with(|mouse| { mouse.records.insert((1, 0x40, 0), [2, 2, 1, 6, 0, 0, 0]); });
            store(&device, &config, &profile).unwrap();
            // Silent is consumer usage 0, never one of Sidearm's live signals.
            for layer in [0, 1] {
                assert_eq!(device.read_block(1, 0x40, layer).unwrap(), [0x0a, 2, 0, 0, 0, 0, 0]);
            }
        }
    }

    #[test]
    fn v2_store_matches_preview_roles_native_fallback_translation_and_preservation() {
        let (mut config, profile) = empty_profile();
        bind(&mut config, &profile, "thumb_01", Layer::Offline, shortcut("A", false, false, false), None);
        bind(&mut config, &profile, "thumb_02", Layer::Hypershift, shortcut("C", true, false, false), None);
        bind(&mut config, &profile, "mouse_right", Layer::Offline, shortcut("A", false, false, false), None);
        bind(&mut config, &profile, "mouse_left", Layer::Standard, shortcut("C", true, false, false), None);
        bind(&mut config, &profile, "wheel_click", Layer::Standard, ActionPayload::Disabled(Default::default()), None);
        for (id, layer) in [("thumb_01", Layer::Offline), ("mouse_right", Layer::Offline), ("mouse_left", Layer::OfflineHypershift),
            ("wheel_click", Layer::Offline), ("thumb_03", Layer::Offline)] {
            preview_control(&config, &NAGA_V2_HYPERSPEED, &profile, id, layer);
        }
        let (device, _fake) = fake_v2();
        let digit = [2, 2, 0, 0x1e, 0, 0, 0];
        fake::with(|mouse| { mouse.records.insert((1, 0x42, 0), digit); });
        store(&device, &config, &profile).unwrap();
        for (button, layer, raw) in [(0x40, 0, [2, 2, 0, 4, 0, 0, 0]), (0x41, 1, [2, 2, 1, 6, 0, 0, 0]),
            (2, 0, [0x0c, 1, 1, 0, 0, 0, 0]), (2, 1, [0x0c, 1, 1, 0, 0, 0, 0]),
            (1, 1, [1, 1, 2, 0, 0, 0, 0]), (3, 0, [1, 1, 3, 0, 0, 0, 0]), (0x42, 0, digit)] {
            assert_eq!(device.read_block(1, button, layer).unwrap(), raw);
        }
        let serialized = serde_json::to_value(preview(&config, &NAGA_V2_HYPERSPEED, &profile, None)).unwrap();
        let trigger = serialized["controls"].as_array().unwrap().iter().find(|control| control["controlId"] == "mouse_right" && control["layer"] == "offline").unwrap();
        assert_eq!(trigger, &serde_json::json!({"controlId":"mouse_right", "layer":"offline", "kind":"role", "role":"hypershift", "editable":false}));
    }

    /// The inert offline record of every model: consumer usage 0 (nothing).
    const SILENT: OnboardAction = OnboardAction::Consumer(BANK_SILENT_USAGE);

    #[test]
    fn an_own_offline_press_overrides_only_layer_zero() {
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            let (mut config, profile) = empty_profile();
            let id = crate::mouse_memory::live_overlay::control_id(model, "thumb_01");
            bind(&mut config, &profile, id.as_str(), Layer::Standard, shortcut("T", true, false, false), None);
            let other = crate::mouse_memory::live_overlay::control_id(model, "thumb_02");
            bind(&mut config, &profile, other.as_str(), Layer::Hypershift, shortcut("U", true, false, false), None);
            let before = plan(&config, model, &profile).records();
            bind(&mut config, &profile, id.as_str(), Layer::Offline, shortcut("F4", false, false, true), Some(TriggerMode::Press));
            let records = plan(&config, model, &profile).records();
            let button = model.button_id_for("thumb_01").unwrap();
            assert_eq!(record(&records, button, 0), onboard_action(model, &shortcut("F4", false, false, true)).ok());
            assert_eq!(record(&records, button, 1), record(&before, button, 1), "layer 1 keeps its live fallback");
            config.bindings.last_mut().unwrap().enabled = false;
            assert_eq!(plan(&config, model, &profile).records(), before, "a disabled own binding falls back");
        }
    }

    #[test]
    fn a_disabled_or_unplayable_own_offline_action_is_inert() {
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            for payload in [
                ActionPayload::Disabled(Default::default()),
                ActionPayload::MouseAction(MouseActionPayload { action: MouseActionKind::DpiUp, ctrl: false, shift: false, alt: false, win: false }),
            ] {
                let (mut config, profile) = empty_profile();
                let id = crate::mouse_memory::live_overlay::control_id(model, "thumb_01");
                bind(&mut config, &profile, id.as_str(), Layer::Standard, shortcut("T", true, false, false), None);
                bind(&mut config, &profile, id.as_str(), Layer::Offline, payload, None);
                assert_eq!(record(&plan(&config, model, &profile).records(), model.button_id_for("thumb_01").unwrap(), 0), Some(SILENT));
            }
        }
    }

    #[test]
    fn an_own_offline_hypershift_action_overrides_layer_one_and_enables_the_trigger() {
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            let (mut config, profile) = empty_profile();
            let id = crate::mouse_memory::live_overlay::control_id(model, "thumb_01");
            bind(&mut config, &profile, id.as_str(), Layer::Standard, shortcut("T", true, false, false), None);
            let mouse = ActionPayload::MouseAction(MouseActionPayload { action: MouseActionKind::MouseBack, ctrl: false, shift: false, alt: false, win: false });
            bind(&mut config, &profile, id.as_str(), Layer::OfflineHypershift, mouse, None);
            let trigger = model.live.as_ref().and_then(|live| live.firmware_trigger).unwrap_or(0x02);
            let button = model.button_id_for("thumb_01").unwrap();
            let records = plan(&config, model, &profile).records();
            assert_eq!(record(&records, button, 0), Some(OnboardAction::Key { modifier: 1, usage: 0x17 }));
            assert_eq!(record(&records, button, 1), Some(OnboardAction::Mouse(4)));
            for layer in [0, 1] {
                assert_eq!(record(&records, trigger, layer), Some(OnboardAction::Hypershift));
            }
            bind(&mut config, &profile, id.as_str(), Layer::Hypershift, shortcut("U", true, false, false), None);
            assert_eq!(plan(&config, model, &profile).records(), records, "the own assignment also wins over a live HyperShift binding");
        }
    }

    #[test]
    fn a_silent_own_hypershift_assignment_still_needs_the_firmware_trigger() {
        let (mut config, profile) = empty_profile();
        bind(&mut config, &profile, "thumb_01", Layer::Standard, shortcut("T", true, false, false), None);
        bind(&mut config, &profile, "thumb_01", Layer::OfflineHypershift, ActionPayload::Disabled(Default::default()), None);
        let records = plan(&config, &NAGA_V2_HYPERSPEED, &profile).records();
        assert_eq!(record(&records, 0x02, 0), Some(OnboardAction::Hypershift));
        assert_eq!(record(&records, NAGA_V2_HYPERSPEED.button_id_for("thumb_01").unwrap(), 1), Some(SILENT));
    }

    #[test]
    fn an_own_offline_hypershift_left_click_overrides_the_right_trigger_translation() {
        let (mut config, profile) = empty_profile();
        bind(&mut config, &profile, "mouse_left", Layer::OfflineHypershift, shortcut("T", true, false, false), None);
        assert_eq!(record(&plan(&config, &NAGA_V2_HYPERSPEED, &profile).records(), 0x01, 1), Some(OnboardAction::Key { modifier: 1, usage: 0x17 }));
    }

    #[test]
    fn an_explicit_disabled_mouse_button_is_silent_on_both_layers() {
        for (model, control) in [(&NAGA_V2_HYPERSPEED, "mouse_left"), (&NAGA_V3_PRO, "wheel_click")] {
            let (mut config, profile) = empty_profile();
            let id = crate::mouse_memory::live_overlay::control_id(model, control);
            for layer in [Layer::Offline, Layer::OfflineHypershift] {
                bind(&mut config, &profile, id.as_str(), layer, ActionPayload::Disabled(Default::default()), None);
            }
            let button = crate::mouse_memory::live_overlay::controls(model).into_iter().find(|(id, _)| *id == control).unwrap().1;
            let records = plan(&config, model, &profile).records();
            for layer in [0, 1] {
                assert!(matches!(record(&records, button, layer), Some(OnboardAction::Consumer(_))), "{}/{layer}: {records:?}", model.name);
            }
        }
    }

    /// A double press or a text binding would play wrong (a single press, an
    /// old record): both get the inert signal, on the V2 and in a V3 bank.
    #[test]
    fn what_the_firmware_cannot_play_gets_the_inert_signal() {
        let (mut config, profile) = empty_profile();
        bind(&mut config, &profile, "thumb_01", Layer::Standard, shortcut("F4", false, false, true), Some(TriggerMode::DoublePress));
        let text = config.actions.iter().find(|action| action.action_type == crate::config::ActionType::TextSnippet).unwrap().payload.clone();
        bind(&mut config, &profile, "thumb_02", Layer::Standard, text, None);
        bind(&mut config, &profile, "thumb_03", Layer::Standard, shortcut("F4", false, false, true), Some(TriggerMode::Hold));
        let records = plan(&config, &NAGA_V2_HYPERSPEED, &profile).records();
        let button = |control| NAGA_V2_HYPERSPEED.button_id_for(control).unwrap();
        assert_eq!(record(&records, button("thumb_01"), 0), Some(SILENT));
        assert_eq!(record(&records, button("thumb_02"), 0), Some(SILENT));
        assert_eq!(record(&records, button("thumb_03"), 0), Some(OnboardAction::KeyTap { modifier: 0x04, usage: 0x3d }));
        assert_eq!(record(&records, button("thumb_04"), 0), None, "an unbound button keeps the session's signal");
        assert!(records.iter().all(|record| record.layer == 0), "no hypershift binding: layer 1 stays untouched");

        let v3 = |control: &str| crate::mouse_memory::live_overlay::control_id(&NAGA_V3_PRO, control);
        let mut config = crate::mouse_memory::live_overlay::tests::config_with_v3();
        let profile = config.profiles[0].id.clone();
        config.bindings.retain(|binding| binding.profile_id != profile);
        bind(&mut config, &profile, v3("thumb_01").as_str(), Layer::Standard, shortcut("F4", false, false, true), Some(TriggerMode::DoublePress));
        let records = plan(&config, &NAGA_V3_PRO, &profile).records();
        assert!(matches!(record(&records, 0x40, 0), Some(OnboardAction::Consumer(_))), "{records:?}");
    }

    /// The V2's offline Hypershift: the settings trigger (the right button)
    /// becomes the firmware key, a left click under it is a right click, and
    /// layer 1 of the other key buttons is reset to the inert signal.
    #[test]
    fn the_v2_hypershift_follows_the_live_rules() {
        let (mut config, profile) = empty_profile();
        assert_eq!(config.settings.hypershift_trigger, "mouse_right");
        bind(&mut config, &profile, "thumb_01", Layer::Hypershift, shortcut("T", true, false, false), None);
        let records = plan(&config, &NAGA_V2_HYPERSPEED, &profile).records();
        let button = |control| NAGA_V2_HYPERSPEED.button_id_for(control).unwrap();
        assert_eq!(record(&records, 0x02, 0), Some(OnboardAction::Hypershift));
        assert_eq!(record(&records, 0x02, 1), Some(OnboardAction::Hypershift));
        assert_eq!(record(&records, 0x01, 1), Some(OnboardAction::Mouse(2)));
        assert_eq!(record(&records, button("thumb_01"), 1), Some(OnboardAction::Key { modifier: 0x01, usage: 0x17 }));
        assert_eq!(record(&records, button("thumb_02"), 1), Some(SILENT));
    }

    #[test]
    fn the_offline_profile_falls_back_to_the_fallback_profile() {
        let (mut config, profile) = empty_profile();
        let fallback = config.settings.fallback_profile_id.clone();
        assert_eq!(offline_profile_id(&config, Some(profile.clone())), fallback, "absent setting");
        config.settings.offline_profile_id = Some(crate::config::OFFLINE_PROFILE_ACTIVE.into());
        assert_eq!(offline_profile_id(&config, Some(profile.clone())), profile);
        assert_eq!(offline_profile_id(&config, None), fallback, "a restore process does not know the profile in effect");
        config.settings.offline_profile_id = Some("deleted-profile".into());
        assert_eq!(offline_profile_id(&config, None), fallback);
    }

    use crate::mouse_memory::fake::{self, FakeMouse};

    /// Stores `profile` in the fake V2's profile 1, as its live session does.
    fn store(device: &VendorDevice, config: &AppConfig, profile: &str) -> Result<(), String> {
        let mut config = config.clone();
        config.settings.offline_profile_id = Some(profile.to_owned());
        store_onboard_offline(device, &config)
    }

    fn fake_v2() -> (VendorDevice, fake::Installed) {
        let installed = fake::install(FakeMouse { poll_code: 0x01, ..Default::default() });
        (VendorDevice::test_handle(&NAGA_V2_HYPERSPEED, 0x00b4, ""), installed)
    }

    #[test]
    fn an_own_offline_record_is_stored_in_profile_1() {
        let (mut config, profile) = empty_profile();
        bind(&mut config, &profile, "thumb_01", Layer::Standard, shortcut("T", true, false, false), None);
        bind(&mut config, &profile, "thumb_01", Layer::Offline, shortcut("U", true, false, false), None);
        let (device, _fake) = fake_v2();
        store(&device, &config, &profile).unwrap();
        let button = NAGA_V2_HYPERSPEED.button_id_for("thumb_01").unwrap();
        assert_eq!(fake::with(|mouse| mouse.records[&(1, button, 0)][..4].to_vec()), vec![0x02, 0x02, 0x01, 0x18]);
        assert_eq!(fake::with(|mouse| mouse.records[&(0, button, 0)][..4].to_vec()), vec![0x02, 0x02, 0x01, 0x18], "the write plays at once (the live map is rewritten after it)");
    }

    #[test]
    fn a_dpi_already_stored_is_not_written_again() {
        let (device, _fake) = fake_v2();
        device.set_dpi(1600, true).unwrap();
        device.set_dpi(1600, true).unwrap();
        assert_eq!(fake::with(|mouse| mouse.dpi_writes), 1);
    }

    #[test]
    fn a_record_already_in_place_is_not_written_again() {
        let (device, _fake) = fake_v2();
        let f13 = OnboardAction::Key { modifier: 0, usage: 0x68 };
        device.write_record(0x40, 0, f13).unwrap();
        device.write_record(0x40, 0, f13).unwrap();
        assert_eq!(fake::with(|mouse| mouse.writes.len()), 1);
        device.write_record(0x40, 0, OnboardAction::Key { modifier: 0, usage: 0x69 }).unwrap();
        assert_eq!(fake::with(|mouse| mouse.writes.len()), 2);
    }

    /// The V2's offline profile lands in the mouse as planned; only a mouse
    /// that slept through part of it is an error (its session tries again).
    #[test]
    fn the_v2_store_fails_only_for_a_sleeping_mouse() {
        use crate::config::MouseOverrides;
        let (mut config, profile) = empty_profile();
        bind(&mut config, &profile, "thumb_01", Layer::Standard, shortcut("T", true, false, false), None);
        let own = config.profiles.iter_mut().find(|p| p.id == profile).unwrap();
        own.device_mouse = Some([("razer-naga".to_owned(), MouseOverrides { mouse_dpi: Some(1600), ..Default::default() })].into());

        let (device, _fake) = fake_v2();
        store(&device, &config, &profile).unwrap();
        let button = NAGA_V2_HYPERSPEED.button_id_for("thumb_01").unwrap();
        assert_eq!(fake::with(|mouse| mouse.records[&(1, button, 0)][..4].to_vec()), vec![0x02, 0x02, 0x01, 0x17]);
        drop((device, _fake));

        let (device, _fake) = fake_v2();
        fake::with(|mouse| mouse.asleep_for.push((0x04, 0x85)));
        assert!(store(&device, &config, &profile).is_err(), "the DPI slept");
        drop((device, _fake));

        let (device, _fake) = fake_v2();
        fake::with(|mouse| mouse.refused.push((0x04, 0x85)));
        assert_eq!(store(&device, &config, &profile), Ok(()), "a refusal is not retried");
    }

    /// `@active` is the fallback in the V2's profile 1: it is stored while
    /// Sidearm runs, not at the exit that knows the window in front.
    #[test]
    fn the_v2_keeps_the_fallback_for_the_profile_active_at_exit() {
        let (mut config, _) = empty_profile();
        config.settings.offline_profile_id = Some(crate::config::OFFLINE_PROFILE_ACTIVE.into());
        assert_eq!(onboard_offline_profile(&config), config.settings.fallback_profile_id);
    }

    /// The exit puts back the speed a per-app profile changed.
    #[test]
    fn the_exit_puts_the_mouse_speed_back() {
        let (config, profile) = empty_profile();
        let (device, _fake) = fake_v2();
        fake::with(|mouse| {
            mouse.poll_code = 0x08;
            mouse.dpi.insert(0x00, 1600);
        });
        crate::mouse_speed::remember("razer-naga", crate::mouse_speed::Originals { dpi: Some(800), poll_rate_hz: Some(1000) });
        restore_live_speed(&device, &config, &profile, true).unwrap();
        crate::mouse_speed::forget_originals("razer-naga", true, true);
        assert_eq!(fake::with(|mouse| (mouse.poll_code, mouse.dpi[&0x00])), (0x01, 800));
    }

    /// A sleeping mouse is asked once, not once per record (an exit waited
    /// for every record's silence and took a minute).
    #[test]
    fn a_sleeping_mouse_is_not_asked_for_every_record() {
        let asked = |controls: &[&str]| {
            let (mut config, profile) = empty_profile();
            for control in controls {
                bind(&mut config, &profile, control, Layer::Standard, shortcut("T", true, false, false), None);
            }
            let (device, _fake) = fake_v2();
            fake::with(|mouse| mouse.asleep = true);
            assert!(store(&device, &config, &profile).is_err());
            fake::with(|mouse| mouse.asked)
        };
        assert_eq!(asked(&["thumb_01", "thumb_02", "thumb_03", "thumb_04"]), asked(&["thumb_01"]));
    }

    #[test]
    fn r07_04_only_sleep_fails_a_store() {
        let (mut config, profile) = empty_profile();
        bind(&mut config, &profile, "thumb_01", Layer::Standard, shortcut("T", true, false, false), None);
        for command in [0x8c, 0x0c] {
            for asleep in [false, true] {
                let (device, _fake) = fake_v2();
                fake::with(|mouse| {
                    if asleep { mouse.asleep_for.push((0x02, command)); }
                    else { mouse.refused.push((0x02, command)); }
                });
                assert_eq!(store(&device, &config, &profile).is_err(), asleep, "command {command:#04x}, asleep {asleep}");
            }
        }
    }

    /// An exit never writes the V2 (its profile 1 holds the offline profile):
    /// an older queue naming it is dropped, not waited on for good.
    #[test]
    fn an_exit_queue_naming_the_v2_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let (config, profile) = empty_profile();
        let _fake = fake::install(FakeMouse { poll_code: 0x01, ..Default::default() });
        fake::set_present_models(vec![]);
        write_marker(&dir.path().join(OFFLINE_FAILED_FILE), &format!("{profile}\nrazer-naga"));
        assert!(retry_offline_profile(&config, dir.path()));
        assert!(!dir.path().join(OFFLINE_FAILED_FILE).exists());
        assert!(fake::with(|mouse| mouse.writes.is_empty()));
    }

    #[test]
    fn r07_05_poll_read_failure_still_restores_original_dpi() {
        let (config, profile) = empty_profile();
        let (device, _fake) = fake_v2();
        fake::with(|mouse| {
            mouse.refused.push((0x00, 0x85));
            mouse.dpi.insert(0, 1600);
        });
        crate::mouse_speed::remember("razer-naga", crate::mouse_speed::Originals { dpi: Some(800), poll_rate_hz: Some(1000) });
        let result = restore_live_speed(&device, &config, &profile, true);
        crate::mouse_speed::forget_originals("razer-naga", true, true);
        assert!(result.unwrap_err().contains("command 0x00/0x85"));
        assert_eq!(fake::with(|mouse| mouse.dpi[&0]), 800);
    }

    #[test]
    fn r07_01_exit_does_not_wait_for_a_held_device_lock() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, "");
        let (done_tx, done_rx) = channel();
        let (written_tx, written_rx) = channel();
        let path = dir.path().to_owned();
        let caller = std::thread::spawn(move || {
            let _discovery = fake::install(FakeMouse::default());
            fake::set_present_models(vec![&NAGA_V3_PRO]);
            let finished = write_offline_bounded(&crate::mouse_memory::live_overlay::tests::config_with_v3(), &path, "offline-profile", Duration::from_millis(30), move |_| {
                let _fake = fake::install(FakeMouse::default());
                let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, "");
                device.battery_percent().unwrap();
                written_tx.send(()).unwrap();
            });
            done_tx.send(finished).unwrap();
        });
        let result = done_rx.recv_timeout(Duration::from_secs(1));
        let pending = std::fs::read_to_string(dir.path().join(OFFLINE_FAILED_FILE));
        drop(device);
        caller.join().unwrap();
        written_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(result, Ok(false), "the exit must return before the device lock is released");
        assert_eq!(pending.unwrap(), "offline-profile\nrazer-naga-v3");
    }

    #[test]
    fn r07_01_exit_does_not_wait_for_a_stalled_hid_worker() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let (release_tx, release_rx) = channel();
        let (started_tx, started_rx) = channel();
        let (written_tx, written_rx) = channel();
        let path = dir.path().to_owned();
        let (done_tx, done_rx) = channel();
        let caller = std::thread::spawn(move || {
            let _discovery = fake::install(FakeMouse::default());
            fake::set_present_models(vec![&NAGA_V3_PRO]);
            let finished = write_offline_bounded(&crate::mouse_memory::live_overlay::tests::config_with_v3(), &path, "offline-profile", Duration::from_millis(30), move |_| {
                let _fake = fake::install(FakeMouse::default());
                let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, "");
                started_tx.send(()).unwrap();
                // A feature call that does not return until the driver recovers.
                release_rx.recv().unwrap();
                device.battery_percent().unwrap();
                written_tx.send(()).unwrap();
            });
            done_tx.send(finished).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let result = done_rx.recv_timeout(Duration::from_secs(1));
        let pending = std::fs::read_to_string(dir.path().join(OFFLINE_FAILED_FILE));
        release_tx.send(()).unwrap();
        caller.join().unwrap();
        written_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(result, Ok(false));
        assert_eq!(pending.unwrap(), "offline-profile\nrazer-naga-v3");
    }

    #[test]
    fn r07_01_worker_keeps_the_exit_targets_if_discovery_changes() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::mouse_memory::live_overlay::tests::config_with_v3();
        let profile = config.profiles[0].id.clone();
        let _fake = fake::install(FakeMouse::default());
        fake::set_present_models(vec![&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO, &crate::device_catalog::NAGA_X]);
        let (worker_config, worker_profile, path) = (config.clone(), profile.clone(), dir.path().to_owned());
        assert!(write_offline_bounded(&config, dir.path(), &profile, std::time::Duration::from_secs(5), move |targets| {
            let _fake = fake::install(FakeMouse::default());
            fake::set_present_models(vec![]);
            write_offline_to(&worker_config, &worker_profile, &path, Some(&targets));
        }));
        assert_eq!(std::fs::read_to_string(dir.path().join(OFFLINE_FAILED_FILE)).unwrap(), format!("{profile}\nrazer-naga-v3"));
    }
}
