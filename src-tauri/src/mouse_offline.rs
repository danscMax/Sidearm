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

use crate::config::{ActionPayload, AppConfig, Layer, MouseActionKind};
use crate::mouse_memory::{
    OnboardAction, VendorDevice, hid_usage_for_vk, left_modifier_bits, modifier_bits, native_buttons, signal_action,
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

/// The records that make the mouse behave like `profile_id` on its own.
pub fn offline_records(config: &AppConfig, profile_id: &str) -> Vec<OfflineRecord> {
    let action_of = |control, layer| binding_action(config, profile_id, control, layer);
    // (control, button id, what the button does when nothing else applies):
    // Sidearm's own inert signal of a key control, so no leftover vendor macro
    // plays on a layer nothing else fills.
    let mut controls: Vec<(String, u8, Option<OnboardAction>)> = onboard_bindings(config)
        .into_iter()
        .filter_map(|binding| {
            let (button_id, signal) = signal_action(&binding)?;
            Some((binding.control_id, button_id, Some(signal)))
        })
        .collect();
    for (control, button_id, value) in native_buttons() {
        if matches!(*control, "mouse_4" | "mouse_5") {
            controls.push(((*control).to_string(), *button_id, Some(OnboardAction::Mouse(*value))));
        }
    }

    let mut records = Vec::new();
    let mut uses_hypershift = false;
    let mut layer_one = Vec::new();
    for (control, button_id, fallback) in &controls {
        let standard = action_of(control, Layer::Standard).flatten();
        let hypershift = action_of(control, Layer::Hypershift);
        uses_hypershift |= matches!(hypershift, Some(Some(_)));
        if let Some(action) = standard {
            records.push(OfflineRecord { button_id: *button_id, layer: 0, action });
        }
        // Like the resolver: the standard binding fills in only where the
        // hypershift layer has no binding at all. A hypershift binding the
        // firmware cannot play leaves Sidearm's inert signal instead.
        let layer_one_action = match hypershift {
            Some(Some(action)) => Some(action),
            Some(None) => *fallback,
            None => standard.or(*fallback),
        };
        if let Some(action) = layer_one_action {
            layer_one.push(OfflineRecord { button_id: *button_id, layer: 1, action });
        }
    }
    let trigger = native_buttons()
        .iter()
        .find(|(control, _, _)| *control == config.settings.hypershift_trigger.trim());
    if uses_hypershift && let Some((_, trigger_id, _)) = trigger {
        records.extend(layer_one);
        for layer in [0, 1] {
            records.push(OfflineRecord { button_id: *trigger_id, layer, action: OnboardAction::Hypershift });
        }
    }
    records
}

/// `None` means no binding; `Some(None)` means the firmware cannot play it.
pub(crate) fn binding_action(
    config: &AppConfig,
    profile_id: &str,
    control: &str,
    layer: Layer,
) -> Option<Option<OnboardAction>> {
    let binding = config.bindings.iter().find(|b| {
        b.enabled && b.profile_id == profile_id && b.layer == layer && b.control_id.as_str() == control
    })?;
    let action = config.actions.iter().find(|a| a.id == binding.action_id)?;
    Some(onboard_action(&action.payload))
}

/// The firmware form of an action, when it has one.
fn onboard_action(payload: &ActionPayload) -> Option<OnboardAction> {
    match payload {
        ActionPayload::Shortcut(shortcut) => {
            let (ctrl, shift, alt, win) = (shortcut.ctrl, shortcut.shift, shortcut.alt, shortcut.win);
            // Modifier-only (push-to-talk): usage 0 = no key, the firmware holds
            // just the modifiers while the button is down.
            if shortcut.key.trim().is_empty() {
                let modifier = modifier_bits(ctrl, shift, alt, win);
                return (modifier != 0).then_some(OnboardAction::Key { modifier, usage: 0 });
            }
            let usage = hid_usage_for_vk(crate::hotkeys::parse_primary_key(&shortcut.key).ok()?.code)?;
            // A plain key record drops the left Shift/Alt and the right Alt is
            // AltGr on some layouts: a shortcut with Shift or Alt is tapped by the
            // turbo record, which plays the real left keys (one tap per press).
            Some(if shift || alt {
                OnboardAction::KeyTap { modifier: left_modifier_bits(ctrl, shift, alt, win), usage }
            } else {
                OnboardAction::Key { modifier: modifier_bits(ctrl, shift, alt, win), usage }
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
    use crate::device_catalog::{CATALOG, Transport};
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
/// of a mouse that slept through it.
fn write_onboard_offline(config: &AppConfig, profile_id: &str, config_dir: &Path) -> Option<String> {
    let records = offline_records(config, profile_id);
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
    let failed = records
        .iter()
        .filter(|r| {
            device
                .write_record(r.button_id, r.layer, r.action)
                .inspect_err(|e| log::warn!("[mouse-offline] {e}"))
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
    None
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

    #[test]
    fn shortcuts_and_mouse_buttons_have_a_firmware_form() {
        use crate::config::{MouseActionPayload, ShortcutActionPayload};
        let shortcut = |key: &str, ctrl: bool, shift: bool| {
            ActionPayload::Shortcut(ShortcutActionPayload {
                key: key.into(),
                ctrl,
                shift,
                alt: false,
                win: false,
                raw: None,
            })
        };
        assert_eq!(
            onboard_action(&shortcut("T", true, true)),
            // Tapped through the turbo record, which plays the left Shift.
            Some(OnboardAction::KeyTap { modifier: 0x03, usage: 0x17 }),
            "Ctrl+Shift+T"
        );
        let alt_f4 = ActionPayload::Shortcut(ShortcutActionPayload {
            key: "F4".into(),
            ctrl: false,
            shift: false,
            alt: true,
            win: false,
            raw: None,
        });
        assert_eq!(
            onboard_action(&alt_f4),
            Some(OnboardAction::KeyTap { modifier: 0x04, usage: 0x3d }),
            "Alt+F4 taps the real left Alt"
        );
        assert_eq!(
            onboard_action(&shortcut("Delete", false, false)),
            Some(OnboardAction::Key { modifier: 0, usage: 0x4c })
        );
        assert_eq!(
            onboard_action(&shortcut("", true, true)),
            Some(OnboardAction::Key { modifier: 0x21, usage: 0 }),
            "modifier-only is held as bare modifiers"
        );
        assert_eq!(onboard_action(&shortcut("", false, false)), None, "empty shortcut");
        let back = ActionPayload::MouseAction(MouseActionPayload {
            action: MouseActionKind::MouseBack,
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
        });
        assert_eq!(onboard_action(&back), Some(OnboardAction::Mouse(4)));
        for (action, record) in [(MouseActionKind::ScrollUp, 9), (MouseActionKind::ScrollDown, 10)] {
            let scroll = ActionPayload::MouseAction(MouseActionPayload { action, ctrl: false, shift: false, alt: false, win: false });
            assert_eq!(onboard_action(&scroll), Some(OnboardAction::Mouse(record)), "{action:?}");
        }
    }
}

