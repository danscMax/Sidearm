//! The mice's live speed per profile: each profile's own DPI / poll rate is
//! written into every connected mouse on a switch (live only), DPI Up/Down
//! bindings step through its stages, and the values a switch replaced are kept
//! so the exit can put them back (`mouse_offline::restore_live_speed`).

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::mouse_memory::VendorDevice;

/// The live DPI / poll rate of a mouse before Sidearm's per-profile switches
/// first changed them this run: an exit puts them back where the offline
/// profile sets none (without Sidearm the mouse would keep the last app's speed).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Originals {
    pub dpi: Option<u16>,
    pub poll_rate_hz: Option<u16>,
}

static ORIGINALS: Mutex<Vec<(&'static str, Originals)>> = Mutex::new(Vec::new());

/// Keeps the first value seen for each field of `device_id`.
fn remember(device_id: &'static str, seen: Originals) {
    let Ok(mut all) = ORIGINALS.lock() else { return };
    let index = all.iter().position(|(id, _)| *id == device_id).unwrap_or_else(|| {
        all.push((device_id, Originals::default()));
        all.len() - 1
    });
    let kept = &mut all[index].1;
    kept.dpi = kept.dpi.or(seen.dpi);
    kept.poll_rate_hz = kept.poll_rate_hz.or(seen.poll_rate_hz);
}

pub fn originals(device_id: &str) -> Originals {
    ORIGINALS.lock().ok().and_then(|all| all.iter().find(|(id, _)| *id == device_id).map(|(_, kept)| *kept)).unwrap_or_default()
}

/// The user set the mouse's DPI and/or poll rate by hand (`true` fields): that
/// is the value to come back to.
pub fn forget_originals(device_id: &str, dpi: bool, poll_rate: bool) {
    if let Ok(mut all) = ORIGINALS.lock()
        && let Some((_, kept)) = all.iter_mut().find(|(id, _)| *id == device_id)
    {
        if dpi {
            kept.dpi = None;
        }
        if poll_rate {
            kept.poll_rate_hz = None;
        }
    }
}

/// Applies a profile's own DPI / poll rate to each connected mouse, from that
/// mouse's own settings (fields left unset keep the mouse as it is). Runs on its own thread: it is called from the capture
/// path on a profile switch and must not delay the key that caused it. The
/// device lock serializes it with the guard tick.
pub fn apply_profile_mouse_settings(profile: &crate::config::Profile) {
    // Every switch spawns its own thread and the device lock does not keep their
    // order: a switch that waited behind a newer one must not undo it — a newer
    // switch to a profile without settings included.
    let generation = PROFILE_SWITCHES.fetch_add(1, Ordering::SeqCst) + 1;
    if profile.device_mouse.as_ref().is_none_or(|own| own.values().all(|own| own.mouse_dpi.is_none() && own.mouse_poll_rate_hz.is_none())) {
        return;
    }
    let name = profile.name.clone();
    let profile = profile.clone();
    std::thread::Builder::new()
        .name("profile-mouse".into())
        .spawn(move || {
            // Every connected mouse takes its own settings; one asleep mouse
            // does not hold back the other.
            let mice = match connected_mice() {
                Ok(mice) => mice,
                Err(message) => {
                    log::warn!("[mouse-speed] profile `{name}`: mouse settings not applied: {message}");
                    return;
                }
            };
            for device in mice {
                if PROFILE_SWITCHES.load(Ordering::SeqCst) != generation {
                    log::debug!("[mouse-speed] profile `{name}`: superseded by a newer switch");
                    return;
                }
                // The exit puts the mouse's own speed back.
                if crate::is_shutting_down() {
                    return;
                }
                let model = device.model();
                let Some((dpi, poll_rate_hz)) = switch_values(&profile, model) else { continue };
                let result = (|| {
                    let mut written = false;
                    if let Some(hz) = poll_rate_hz {
                        let current = device.poll_rate_hz()?;
                        if current != hz {
                            remember(model.device_id, Originals { poll_rate_hz: Some(current), ..Default::default() });
                            device.set_poll_rate_hz(hz)?;
                            written = true;
                        }
                    }
                    // Live only: the mouse keeps its stored DPI for use without
                    // Sidearm, and a switch per alt-tab must not wear its storage.
                    if let Some(dpi) = dpi {
                        let current = device.dpi()?;
                        if current != dpi {
                            remember(model.device_id, Originals { dpi: Some(current), ..Default::default() });
                            device.set_dpi(dpi, false)?;
                            written = true;
                        }
                    }
                    Ok::<_, String>(written)
                })();
                match result {
                    Ok(false) => log::debug!("[mouse-speed] profile `{name}`: {} settings already in place", model.name),
                    Ok(true) => log::info!(
                        "[mouse-speed] profile `{name}`: {} DPI {dpi:?}, poll {poll_rate_hz:?} Hz written", model.name
                    ),
                    Err(message) => {
                        log::warn!("[mouse-speed] profile `{name}`: {} settings not applied: {message}", model.name)
                    }
                }
            }
        })
        .ok();
}

/// Profile switches so far; the newest one owns the mouse's DPI / poll rate.
static PROFILE_SWITCHES: AtomicU64 = AtomicU64::new(0);

/// Select the next higher/lower configured stage. The end stops rather than wrapping.
/// A DPI value not exactly on a stage (e.g. after Synapse takes control) moves
/// to the nearest stage in the requested direction.
fn next_dpi_stage(stages: &[u16], current: u16, up: bool) -> Result<u16, String> {
    if stages.is_empty() {
        return Err("Configure DPI stages for the active profile first".into());
    }
    let mut sorted = stages.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if up {
        Ok(sorted.iter().copied().find(|value| *value > current).unwrap_or(current))
    } else {
        Ok(sorted.iter().copied().rev().find(|value| *value < current).unwrap_or(current))
    }
}

/// The DPI and poll rate a profile switch writes into `model`: that mouse's
/// own settings, within its range. `None`: the profile has none for it.
fn switch_values(profile: &crate::config::Profile, model: &crate::device_catalog::NativeModel) -> Option<(Option<u16>, Option<u16>)> {
    let own = profile.mouse_for(model.device_id)?;
    Some((
        own.mouse_dpi.map(|dpi| dpi.clamp(model.dpi_min, model.dpi_max)),
        own.mouse_poll_rate_hz.filter(|hz| model.poll_code_for_hz(*hz).is_some()),
    ))
}

/// The DPI stages `model` steps through: its own, within its range.
fn playable_stages(profile: &crate::config::Profile, model: &crate::device_catalog::NativeModel) -> Option<Vec<u16>> {
    let stages = profile.mouse_for(model.device_id)?.mouse_dpi_stages.as_deref()?;
    Some(stages.iter().copied().filter(|dpi| (model.dpi_min..=model.dpi_max).contains(dpi)).collect())
}

/// `step_profile_dpi` error when no connected mouse has stages in the profile.
pub const NO_DPI_STAGES: &str = "no connected mouse has DPI stages in this profile";

/// Apply a DPI Up/Down binding using the resolved profile's list, rather than
/// mutating another profile or the saved startup DPI. Device verification fails
/// explicitly when the wireless mouse is asleep or disconnected.
pub fn step_profile_dpi(profile: &crate::config::Profile, up: bool) -> Result<u16, String> {
    // Each mouse steps through its own stages within its range; one without
    // stages, or asleep, is skipped.
    let mut last = Err(NO_DPI_STAGES.to_string());
    for device in connected_mice()? {
        let model = device.model();
        let Some(playable) = playable_stages(profile, model) else { continue };
        let step = (|| {
            let current = device.dpi()?;
            let desired = next_dpi_stage(&playable, current, up)?;
            if desired != current {
                remember(model.device_id, Originals { dpi: Some(current), ..Default::default() });
                device.set_dpi(desired, false)?;
            }
            Ok::<_, String>(desired)
        })();
        if let Err(message) = &step {
            log::warn!("[mouse-speed] {} DPI step not applied: {message}", model.name);
        }
        if last.is_err() {
            last = step;
        }
    }
    last
}

/// Every connected native mouse, opened one after another (each holds only its
/// own device lock). `Err` when none opens.
fn connected_mice() -> Result<Vec<VendorDevice>, String> {
    let present = crate::mouse_memory::present_models();
    let mice: Vec<_> = present.iter().filter_map(|model| VendorDevice::open_model(model).ok()).collect();
    if mice.is_empty() {
        // Same error as before for a missing or unopenable mouse.
        return VendorDevice::open_connected().map(|device| vec![device]);
    }
    Ok(mice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MouseOverrides, Profile};
    use crate::device_catalog::{NAGA_V2_HYPERSPEED, NAGA_V3_PRO};

    #[test]
    fn each_mouse_takes_its_own_settings_within_its_range() {
        let mut profile: Profile = crate::config::default_seed_config().profiles[0].clone();
        profile.device_mouse = Some([
            ("razer-naga".to_owned(), MouseOverrides { mouse_dpi: Some(1600), mouse_poll_rate_hz: Some(250), mouse_dpi_stages: None }),
            ("razer-naga-v3".to_owned(), MouseOverrides { mouse_dpi: Some(45_000), mouse_poll_rate_hz: Some(1000), mouse_dpi_stages: Some(vec![800, 45_000]) }),
        ].into());
        assert_eq!(switch_values(&profile, &NAGA_V2_HYPERSPEED), Some((Some(1600), None)), "250 Hz is not a V2 rate");
        assert_eq!(switch_values(&profile, &NAGA_V3_PRO), Some((Some(45_000), Some(1000))));
        assert_eq!(playable_stages(&profile, &NAGA_V2_HYPERSPEED), None, "no stages of its own");
        assert_eq!(playable_stages(&profile, &NAGA_V3_PRO), Some(vec![800, 45_000]));
        profile.device_mouse.as_mut().unwrap().get_mut("razer-naga").unwrap().mouse_dpi_stages = Some(vec![800, 40_000]);
        assert_eq!(playable_stages(&profile, &NAGA_V2_HYPERSPEED), Some(vec![800]), "beyond the V2's range");
        profile.device_mouse = None;
        assert_eq!(switch_values(&profile, &NAGA_V3_PRO), None);
    }

    #[test]
    fn steps_clamp_and_recover_from_unknown_values() {
        let s = [1600, 400, 3200, 800];
        assert_eq!(next_dpi_stage(&s, 800, true).unwrap(), 1600);
        assert_eq!(next_dpi_stage(&s, 800, false).unwrap(), 400);
        assert_eq!(next_dpi_stage(&s, 1600, true).unwrap(), 3200);
        assert_eq!(next_dpi_stage(&s, 400, false).unwrap(), 400);
        assert_eq!(next_dpi_stage(&s, 3200, true).unwrap(), 3200);
        assert_eq!(next_dpi_stage(&s, 900, true).unwrap(), 1600);
        assert_eq!(next_dpi_stage(&s, 900, false).unwrap(), 800);
        assert_eq!(next_dpi_stage(&s, 6400, true).unwrap(), 6400);
        assert_eq!(next_dpi_stage(&s, 100, false).unwrap(), 100);
        assert!(next_dpi_stage(&[], 800, true).is_err());
    }

    #[test]
    fn originals_keep_the_first_value_until_forgotten() {
        remember("test-mouse", Originals { poll_rate_hz: Some(1000), ..Default::default() });
        remember("test-mouse", Originals { dpi: Some(800), poll_rate_hz: Some(125) });
        assert_eq!(originals("test-mouse"), Originals { dpi: Some(800), poll_rate_hz: Some(1000) });
        forget_originals("test-mouse", true, false);
        assert_eq!(originals("test-mouse"), Originals { dpi: None, poll_rate_hz: Some(1000) });
        forget_originals("test-mouse", false, true);
        assert_eq!(originals("test-mouse"), Originals::default());
    }
}
