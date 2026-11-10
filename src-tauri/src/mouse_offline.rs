//! What the mouse does while Sidearm is closed.
//!
//! While Sidearm runs, the onboard memory holds Sidearm's own signals
//! (`F13`..`F24`, `Alt+F23`…) — meaningless without the app. On exit Sidearm
//! writes the active profile into the mouse the way Synapse did, so every
//! binding the firmware can play back on its own keeps working: a single key
//! with modifiers, or a plain mouse button. Text, macros, launches, menus and
//! per-app profiles cannot live in the mouse and stay inert until Sidearm runs
//! again. If the profile uses Hypershift, its trigger becomes the firmware
//! Hypershift key and the layer-1 records get the hypershift bindings.
//!
//! On the next start the marker file says the memory holds the offline
//! profile, and Sidearm writes its own signals back before the guard looks.

use std::path::Path;

use crate::config::{ActionPayload, AppConfig, Layer, MouseActionKind, TriggerMode};
use crate::device_catalog::{NativeModel, Transport};
use crate::mouse_memory::{
    OnboardAction, VendorDevice, binding_target, hid_usage_for_vk, left_modifier_bits, modifier_bits, native_buttons,
    onboard_bindings,
};

/// Present in the config folder while the mouse holds the offline profile.
pub const OFFLINE_MARKER_FILE: &str = "mouse-offline-written";
/// Left by an exit that could not store the offline profile (the mouse slept):
/// the next start tells the user why the buttons did nothing without Sidearm.
pub const OFFLINE_FAILED_FILE: &str = "mouse-offline-failed";

/// One record to store: button, layer (`0` standard, `1` Hypershift), action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfflineRecord {
    pub button_id: u8,
    pub layer: u8,
    pub action: OnboardAction,
}

/// The records that make `model` behave like `profile_id` on its own — one
/// rule for every model:
/// - a binding the firmware can play (a plain press of a key or mouse button)
///   gets its record; one it cannot (text, macro, launch, a double or triple
///   press, a chord) gets the model's inert signal, never the old record;
/// - an unbound control keeps its record, except on layer 1 of Sidearm's own
///   onboard profile (the onboard path), where a leftover of an earlier
///   offline profile would play: there it gets the inert signal too;
/// - layer 1 follows the resolver: the hypershift binding, else the standard
///   one; under a right-button trigger a left click is a right click;
/// - the trigger becomes the firmware Hypershift key when a hypershift binding
///   is playable; the profile button keeps switching banks.
pub fn plan(config: &AppConfig, model: &NativeModel, profile_id: &str) -> Vec<OfflineRecord> {
    use crate::mouse_memory::live_overlay::{USAGES, control_id, controls};
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
    let signals = onboard_bindings(config);
    let inert = |index: usize, control: &str, layer: u8| -> Option<OnboardAction> {
        if !own_profile {
            return USAGES.get(2 * index + usize::from(layer)).map(|&usage| OnboardAction::Consumer(usage));
        }
        if let Some(&(_, _, value)) = model.native_buttons.iter().find(|(id, _, _)| *id == control) {
            return Some(OnboardAction::Mouse(value));
        }
        let binding = signals.iter().find(|binding| binding.control_id == control)?;
        binding_target(model, binding).ok().map(|(_, action)| action)
    };

    let mut records = Vec::new();
    let mut layer_one = Vec::new();
    let mut uses_hypershift = false;
    for (index, (control, button)) in controls(model).into_iter().enumerate() {
        if Some(button) == live.and_then(|live| live.profile_button) {
            continue;
        }
        let id = control_id(model, control);
        let action = |layer| binding_action(config, model, profile_id, id.as_str(), layer);
        let standard = action(Layer::Standard);
        let hypershift = action(Layer::Hypershift);
        uses_hypershift |= matches!(hypershift, Some(Some(_)));
        if let Some(found) = standard
            && let Some(action) = found.or_else(|| inert(index, control, 0))
        {
            records.push(OfflineRecord { button_id: button, layer: 0, action });
        }
        let layer_one_action = if control == "mouse_left" && right_trigger {
            Some(OnboardAction::Mouse(2))
        } else {
            match hypershift.or(standard) {
                Some(found) => found.or_else(|| inert(index, control, 1)),
                None if own_profile => inert(index, control, 1),
                None => None,
            }
        };
        if let Some(action) = layer_one_action {
            layer_one.push(OfflineRecord { button_id: button, layer: 1, action });
        }
    }
    // Layer 1 plays only under the firmware Hypershift: the onboard path writes
    // it only with a trigger, a bank always (it may keep its own trigger).
    if (uses_hypershift && trigger.is_some()) || !own_profile {
        records.extend(layer_one);
    }
    if uses_hypershift && let Some(trigger) = trigger {
        records.retain(|record| record.button_id != trigger);
        records.extend([0, 1].map(|layer| OfflineRecord { button_id: trigger, layer, action: OnboardAction::Hypershift }));
    }
    records
}

/// `None` means no binding; `Some(None)` means the firmware cannot play it.
fn binding_action(
    config: &AppConfig,
    model: &NativeModel,
    profile_id: &str,
    control: &str,
    layer: Layer,
) -> Option<Option<OnboardAction>> {
    let binding = config.bindings.iter().find(|b| {
        b.enabled && b.profile_id == profile_id && b.layer == layer && b.control_id.as_str() == control
    })?;
    // The firmware plays a record on every press, held while the button is
    // down (a hold): a double or triple press or a chord would fire on one.
    if matches!(binding.trigger_mode, Some(TriggerMode::DoublePress | TriggerMode::TriplePress | TriggerMode::Chord)) {
        return Some(None);
    }
    let action = config.actions.iter().find(|a| a.id == binding.action_id)?;
    Some(onboard_action(model, &action.payload))
}

/// The firmware form of an action on `model`, when it has one.
fn onboard_action(model: &NativeModel, payload: &ActionPayload) -> Option<OnboardAction> {
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
                return (modifier != 0).then_some(OnboardAction::Key { modifier, usage: 0 });
            }
            let usage = hid_usage_for_vk(crate::hotkeys::parse_primary_key(&shortcut.key).ok()?.code)?;
            // Such a firmware taps a shortcut with Shift or Alt through the
            // turbo record, which plays the real left keys (one tap per press).
            Some(if (shift || alt) && !model.plain_left_modifiers {
                OnboardAction::KeyTap { modifier: standard, usage }
            } else {
                OnboardAction::Key { modifier: standard, usage }
            })
        }
        ActionPayload::MouseAction(mouse) if !(mouse.ctrl || mouse.shift || mouse.alt || mouse.win) => {
            Some(OnboardAction::Mouse(match mouse.action {
                MouseActionKind::LeftClick => 1,
                MouseActionKind::RightClick => 2,
                MouseActionKind::MiddleClick => 3,
                MouseActionKind::MouseBack => 4,
                MouseActionKind::MouseForward => 5,
                // The wheel's own records (factory 0x09/0x0a hold these): a
                // plain scroll is played by the mouse itself without Sidearm.
                MouseActionKind::ScrollUp => 9,
                MouseActionKind::ScrollDown => 10,
                _ => return None,
            }))
        }
        _ => None,
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

/// Puts back the live speed the per-app profiles changed: the offline
/// profile's own poll rate (and DPI with `dpi_too`; a V3 bank switch sets its
/// own), else what the mouse had before Sidearm's first switch this run.
pub(crate) fn restore_live_speed(device: &VendorDevice, config: &AppConfig, profile_id: &str, dpi_too: bool) -> Result<(), String> {
    let model = device.model();
    let own = config.profiles.iter().find(|p| p.id == profile_id).and_then(|p| p.mouse_for(model.device_id));
    let original = crate::mouse_speed::originals(model.device_id);
    let poll = own.and_then(|own| own.mouse_poll_rate_hz).filter(|hz| model.poll_code_for_hz(*hz).is_some());
    let poll_result = match poll.or(original.poll_rate_hz) {
        Some(hz) if device.poll_rate_hz()? != hz => device.set_poll_rate_hz(hz),
        _ => Ok(()),
    };
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
pub fn write_offline_profile(config: &AppConfig, profile_id: &str, config_dir: &Path) {
    write_offline_to(config, profile_id, config_dir, None);
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
    let wanted = |device_id: &str| only.is_none_or(|ids| ids.iter().any(|id| id == device_id));
    let present = crate::mouse_memory::present_models();
    let mut slept: Vec<String> = Vec::new();
    for model in &present {
        if model.transport != Transport::LiveOverlay || !live_overlay::configured(config, model) || !wanted(model.device_id) {
            continue;
        }
        if let Err(error) = live_overlay::write_offline(config, model, profile_id, config_dir) {
            log::warn!("[mouse-offline] {} profile `{profile_id}` was not stored: {error}", model.name);
            if crate::mouse_memory::is_no_response(&error) {
                slept.push(model.device_id.to_owned());
            }
        }
    }
    let onboard_wanted = CATALOG.iter().any(|model| model.transport == Transport::Onboard && wanted(model.device_id));
    if onboard_wanted && let Some(device_id) = write_onboard_offline(config, profile_id, config_dir) {
        slept.push(device_id);
    }
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
        let _ = std::fs::write(&failed_marker, std::iter::once(profile_id.to_owned()).chain(slept).collect::<Vec<_>>().join("\n"));
    }
}

/// The onboard path's part of [`write_offline_profile`]. Returns the device id
/// of a mouse that slept through any of it (a record or the DPI): the whole
/// profile is retried once it answers. A record it refused otherwise is only
/// logged.
fn write_onboard_offline(config: &AppConfig, profile_id: &str, config_dir: &Path) -> Option<String> {
    let device = match VendorDevice::open_onboard() {
        Ok(device) => device,
        Err(message) => {
            // No mouse at all (or one that does not open) is not a sleeping
            // mouse: nothing to tell the user next time.
            log::info!("[mouse-offline] no onboard mouse reachable, onboard profile not written: {message}");
            return None;
        }
    };
    if !device.model().verified {
        log::info!("[mouse-offline] {} is not verified: offline profile not written", device.model().name);
        return None;
    }
    let records = plan(config, device.model(), profile_id);
    let mut asleep = false;
    let failed = records
        .iter()
        .filter(|r| {
            device
                .write_record(r.button_id, r.layer, r.action)
                .inspect_err(|e| {
                    log::warn!("[mouse-offline] {e}");
                    asleep |= crate::mouse_memory::is_no_response(e);
                })
                .is_err()
        })
        .count();
    // Profile switches set the DPI live only: store the offline profile's own
    // DPI; a profile without one leaves the mouse's stored DPI alone.
    if let Some(dpi) = config.profiles.iter().find(|p| p.id == profile_id)
        .and_then(|p| p.mouse_for(device.model().device_id))
        .and_then(|own| own.mouse_dpi)
        .map(|dpi| dpi.clamp(device.model().dpi_min, device.model().dpi_max))
        && let Err(message) = device.set_dpi(dpi, true)
    {
        log::warn!("[mouse-offline] DPI not stored: {message}");
        asleep |= crate::mouse_memory::is_no_response(&message);
    }
    if let Err(message) = restore_live_speed(&device, config, profile_id, true) {
        log::warn!("[mouse-offline] live DPI / poll rate not put back: {message}");
        asleep |= crate::mouse_memory::is_no_response(&message);
    }
    if failed == records.len() && !records.is_empty() {
        log::warn!("[mouse-offline] the mouse took none of {} records: offline profile not written", records.len());
        return Some(device.model().device_id.to_owned());
    }
    let _ = std::fs::write(config_dir.join(OFFLINE_MARKER_FILE), profile_id);
    log::info!(
        "[mouse-offline] profile `{profile_id}` written for use without Sidearm: {} records, {failed} failed",
        records.len()
    );
    asleep.then(|| device.model().device_id.to_owned())
}

/// Writes Sidearm's own signals into the onboard-path mouse: its key buttons
/// and its plain mouse buttons (no firmware Hypershift). Used after the
/// offline profile and when a mouse leaves the live map for the onboard path —
/// its live map then plays whatever the mouse stored, not Sidearm's signals.
pub fn restore_signals(config: &AppConfig) -> Result<(), String> {
    let device = VendorDevice::open_onboard()?;
    if !device.model().verified {
        return Err(format!("{} is not verified", device.model().name));
    }
    write_signals(&device, config)
}

/// Sidearm's own signals into `device`: its key buttons, then its plain mouse
/// buttons (no firmware Hypershift).
pub fn write_signals(device: &VendorDevice, config: &AppConfig) -> Result<(), String> {
    device.apply_bindings(&onboard_bindings(config))?;
    let natives: Vec<&str> = native_buttons().iter().map(|(id, _, _)| *id).collect();
    device.restore_native_buttons(&natives)
}

/// Puts Sidearm's own signals back when the mouse still holds the offline
/// profile. Returns `true` when it restored (the marker was there).
pub fn restore_after_offline(config: &AppConfig, config_dir: &Path) -> bool {
    let marker = config_dir.join(OFFLINE_MARKER_FILE);
    if !marker.exists() {
        return false;
    }
    // An unverified mouse is not the one the profile was written into; the
    // marker stays for it.
    match restore_signals(config) {
        Ok(()) => {
            let _ = std::fs::remove_file(&marker);
            log::info!("[mouse-offline] Sidearm signals restored after the offline profile");
            true
        }
        Err(message) => {
            log::warn!("[mouse-offline] restore after the offline profile failed: {message}");
            false
        }
    }
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
        assert_eq!(onboard_action(v2, &shortcut("T", true, true, false)), Some(OnboardAction::KeyTap { modifier: 0x03, usage: 0x17 }));
        assert_eq!(onboard_action(v2, &shortcut("F4", false, false, true)), Some(OnboardAction::KeyTap { modifier: 0x04, usage: 0x3d }));
        assert_eq!(onboard_action(v2, &shortcut("Delete", false, false, false)), Some(OnboardAction::Key { modifier: 0, usage: 0x4c }));
        // A hold cannot be a turbo record: the right-hand keys this firmware plays.
        assert_eq!(onboard_action(v2, &shortcut("", true, true, false)), Some(OnboardAction::Key { modifier: 0x21, usage: 0 }));
        assert_eq!(onboard_action(v2, &shortcut("", false, false, false)), None, "empty shortcut");
    }

    /// The V3 repeats a stored turbo record on its own: plain records with the
    /// standard mask only, push-to-talk included (its right Alt is AltGr).
    #[test]
    fn the_v3_gets_plain_records_with_the_standard_mask() {
        let v3 = &NAGA_V3_PRO;
        assert_eq!(onboard_action(v3, &shortcut("F4", false, false, true)), Some(OnboardAction::Key { modifier: 0x04, usage: 0x3d }));
        assert_eq!(onboard_action(v3, &shortcut("T", true, true, false)), Some(OnboardAction::Key { modifier: 0x03, usage: 0x17 }));
        assert_eq!(onboard_action(v3, &shortcut("", false, false, true)), Some(OnboardAction::Key { modifier: 0x04, usage: 0 }));
    }

    #[test]
    fn mouse_buttons_and_the_wheel_have_a_firmware_form() {
        let mouse = |action| ActionPayload::MouseAction(MouseActionPayload { action, ctrl: false, shift: false, alt: false, win: false });
        for model in [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO] {
            assert_eq!(onboard_action(model, &mouse(MouseActionKind::MouseBack)), Some(OnboardAction::Mouse(4)));
            assert_eq!(onboard_action(model, &mouse(MouseActionKind::ScrollUp)), Some(OnboardAction::Mouse(9)));
            assert_eq!(onboard_action(model, &mouse(MouseActionKind::ScrollDown)), Some(OnboardAction::Mouse(10)));
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

    /// The V2's own signal of a key button: its inert offline record.
    fn v2_signal(config: &AppConfig, control: &str) -> OnboardAction {
        let binding = onboard_bindings(config).into_iter().find(|binding| binding.control_id == control).unwrap();
        binding_target(&NAGA_V2_HYPERSPEED, &binding).unwrap().1
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
        let records = plan(&config, &NAGA_V2_HYPERSPEED, &profile);
        let button = |control| NAGA_V2_HYPERSPEED.button_id_for(control).unwrap();
        assert_eq!(record(&records, button("thumb_01"), 0), Some(v2_signal(&config, "thumb_01")));
        assert_eq!(record(&records, button("thumb_02"), 0), Some(v2_signal(&config, "thumb_02")));
        assert_eq!(record(&records, button("thumb_03"), 0), Some(OnboardAction::KeyTap { modifier: 0x04, usage: 0x3d }));
        assert_eq!(record(&records, button("thumb_04"), 0), None, "an unbound button keeps the session's signal");
        assert!(records.iter().all(|record| record.layer == 0), "no hypershift binding: layer 1 stays untouched");

        let v3 = |control: &str| crate::mouse_memory::live_overlay::control_id(&NAGA_V3_PRO, control);
        let mut config = crate::mouse_memory::live_overlay::tests::config_with_v3();
        let profile = config.profiles[0].id.clone();
        config.bindings.retain(|binding| binding.profile_id != profile);
        bind(&mut config, &profile, v3("thumb_01").as_str(), Layer::Standard, shortcut("F4", false, false, true), Some(TriggerMode::DoublePress));
        let records = plan(&config, &NAGA_V3_PRO, &profile);
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
        let records = plan(&config, &NAGA_V2_HYPERSPEED, &profile);
        let button = |control| NAGA_V2_HYPERSPEED.button_id_for(control).unwrap();
        assert_eq!(record(&records, 0x02, 0), Some(OnboardAction::Hypershift));
        assert_eq!(record(&records, 0x02, 1), Some(OnboardAction::Hypershift));
        assert_eq!(record(&records, 0x01, 1), Some(OnboardAction::Mouse(2)));
        assert_eq!(record(&records, button("thumb_01"), 1), Some(OnboardAction::Key { modifier: 0x01, usage: 0x17 }));
        assert_eq!(record(&records, button("thumb_02"), 1), Some(v2_signal(&config, "thumb_02")));
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
}
