//! Reversible live button maps (`profile 0`) for every model with a
//! [`LiveSpec`](crate::device_catalog::LiveSpec): the Naga V3 Pro always, the
//! V2 HyperSpeed while a second native mouse is connected (firmware Hypershift
//! keeps each mouse's layer to itself).
//!
//! A session writes Sidearm's signals over the live map, keeps a rollback file
//! of every record it replaced, checks for drift and restores on stop. Onboard
//! banks (the V3's stored profiles) are only written on exit, for profiles the
//! user linked to a bank (`Profile.device_slots`).

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};

use super::{ConsumerSignal, MODE_NORMAL, OnboardAction, VendorDevice};
use crate::{
    config::{ActionType, AppConfig, CapabilityStatus, ControlId, Device, EncoderMapping, Layer, MappingSource},
    device_catalog::{CATALOG, CATALOG_LEN, NativeModel, Transport},
};

/// Reserved Consumer Page usages within the one-byte range the devices emit,
/// one per control index and layer (`2 * index + layer`).
const USAGES: [u16; 44] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x37, 0x38, 0x39,
    0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e,
];
const RETRY: Duration = Duration::from_secs(2);
/// Bank argument of the live map; stored banks are `1..=MAX_BANKS`.
const LIVE_BANK: u8 = 0;

// Onboard bank commands (class `0x05`), measured on the V3 Pro receiver.
const CLASS_BANKS: u8 = 0x05;
const CMD_BANK_COUNT: u8 = 0x80;
const CMD_BANK_INVENTORY: u8 = 0x81;
const CMD_ACTIVE_BANK: u8 = 0x84;
const CMD_SELECT_BANK: u8 = 0x04;
pub const MAX_BANKS: u8 = 5;

static ACTIVE: [AtomicBool; CATALOG_LEN] = [const { AtomicBool::new(false) }; CATALOG_LEN];
static READY: [AtomicBool; CATALOG_LEN] = [const { AtomicBool::new(false) }; CATALOG_LEN];
/// The setup wizard's button test: every extra control joins the standard layer.
pub(crate) static CHECK_EXTRA_CONTROLS: AtomicBool = AtomicBool::new(false);

pub fn catalog_index(model: &NativeModel) -> usize {
    CATALOG.iter().position(|entry| std::ptr::eq(*entry, model)).unwrap_or(0)
}

/// A session owns this model's live map (its legacy guard must stay away).
pub fn is_active(model: &NativeModel) -> bool {
    ACTIVE[catalog_index(model)].load(Ordering::Acquire)
}

/// This model's live map is written and verified.
pub fn is_ready(model: &NativeModel) -> bool {
    READY[catalog_index(model)].load(Ordering::Acquire)
}

/// Whether a press read from this model's HID stream may be dispatched: a
/// live map still being written could deliver another session's signal.
pub fn events_allowed(model: &NativeModel) -> bool {
    !is_active(model) || is_ready(model)
}

/// The models that need a live-map session, given the ones plugged in: every
/// live-only model, and an onboard model with a live path while another
/// native mouse is connected (one shared software trigger cannot tell which
/// mouse's right button is held).
pub fn live_models(present: &[&'static NativeModel]) -> Vec<&'static NativeModel> {
    // Only mice Sidearm writes count: an unverified one keeps its own buttons.
    let several = present.iter().filter(|model| model.verified).count() > 1;
    present
        .iter()
        .copied()
        .filter(|model| {
            model.live.is_some() && model.verified && (model.transport == Transport::LiveOverlay || several)
        })
        .collect()
}

/// Whether the mouse hook's software Hypershift is needed: some connected
/// mouse uses the onboard path, or nothing is connected yet.
pub fn software_hypershift(present: &[&'static NativeModel], live: &[&'static NativeModel]) -> bool {
    present.is_empty()
        || present
            .iter()
            .any(|model| model.transport == Transport::Onboard && !live.iter().any(|item| std::ptr::eq(*item, *model)))
}

/// Every control of `model` in usage order: key buttons, extras, then the
/// native buttons (the V2's mouse buttons and wheel).
fn controls(model: &NativeModel) -> Vec<(&'static str, u8)> {
    let extras = model.live.as_ref().map_or(&[][..], |live| live.extras);
    model
        .key_buttons
        .iter()
        .chain(extras)
        .copied()
        .chain(model.native_buttons.iter().map(|&(id, button, _)| (id, button)))
        .collect()
}

pub fn control_id(model: &NativeModel, control: &str) -> ControlId {
    ControlId::new(format!("{}{control}", model.control_prefix))
}

pub fn configured(config: &AppConfig, model: &NativeModel) -> bool {
    config.devices.iter().any(|device| device.id == model.device_id)
}

/// Adds the config device of every connected live-only model that is not in
/// the config yet. Returns whether the config changed.
pub fn configure(config: &mut AppConfig, present: &[&'static NativeModel]) -> bool {
    let mut changed = false;
    for model in present {
        if model.transport == Transport::LiveOverlay && model.verified && !configured(config, model) {
            add_device(config, model);
            changed = true;
        }
    }
    changed
}

/// The model's device with its controls and one reserved encoding per control
/// and layer, and no bindings.
fn add_device(config: &mut AppConfig, model: &NativeModel) {
    let Some(live) = &model.live else { return };
    config.devices.push(Device {
        id: model.device_id.into(),
        name: model.name.into(),
        builtin: true,
        image: None,
        hotspots: Vec::new(),
    });
    let remappable: Vec<&str> = controls(model).iter().map(|(id, _)| *id).collect();
    for mut control in crate::config::seed_physical_controls() {
        let id = control.id.as_str().to_owned();
        let wanted = remappable.contains(&id.as_str())
            || matches!(id.as_str(), "mouse_left" | "mouse_right")
            || (id == "hypershift_button" && live.firmware_trigger.is_some());
        if !wanted {
            continue;
        }
        control.id = control_id(model, &id);
        control.device_id = model.device_id.into();
        if let Some((_, name)) = live.names.iter().find(|(control, _)| *control == id) {
            control.default_name = (*name).into();
        }
        control.remappable = remappable.contains(&id.as_str());
        control.capability_status = CapabilityStatus::Verified;
        control.notes = None;
        config.physical_controls.push(control);
    }

    let mut taken: HashSet<_> = config
        .encoder_mappings
        .iter()
        .filter_map(|mapping| crate::hotkeys::normalize_hotkey(&mapping.encoded_key).ok())
        .collect();
    let mut aliases = [
        "Ctrl+Shift", "Alt+Shift", "Ctrl+Win", "Shift+Win", "Alt+Win",
        "Ctrl+Shift+Win", "Ctrl+Alt+Win", "Alt+Shift+Win", "Ctrl+Alt+Shift+Win",
    ]
    .into_iter()
    .flat_map(|mods| (13..=24).map(move |key| format!("{mods}+F{key}")))
    .filter_map(|alias| crate::hotkeys::normalize_hotkey(&alias).ok());
    for id in remappable {
        for layer in [Layer::Standard, Layer::Hypershift] {
            if let Some(encoded_key) = aliases.find(|alias| taken.insert(alias.clone())) {
                config.encoder_mappings.push(EncoderMapping {
                    control_id: control_id(model, id),
                    layer,
                    encoded_key,
                    source: MappingSource::Reserved,
                    verified: true,
                });
            }
        }
    }
}

/// What a live session writes and what its HID stream sends back.
#[derive(Debug, Default, PartialEq)]
pub struct Overlay {
    pub targets: Vec<(u8, u8, OnboardAction)>,
    pub signals: Vec<ConsumerSignal>,
}

fn has_action(config: &AppConfig, control: &ControlId, layer: Layer) -> bool {
    config.bindings.iter().any(|binding| {
        binding.enabled
            && binding.control_id == *control
            // The hypershift layer falls back to the standard binding.
            && (binding.layer == layer || layer == Layer::Hypershift)
            && config
                .actions
                .iter()
                .any(|action| action.id == binding.action_id && action.action_type != ActionType::Disabled)
    })
}

/// The live map of `model`. Key buttons always carry a signal; other controls
/// only where an enabled action needs them (or during the setup check), so the
/// rest keep their native behaviour. `consumer` picks reserved consumer usages
/// over the `F13`..`F24` keyboard fallback.
pub fn overlay(config: &AppConfig, model: &NativeModel, consumer: bool, checking_extras: bool) -> Result<Overlay, String> {
    let Some(live) = &model.live else { return Ok(Overlay::default()) };
    let trigger = live.firmware_trigger.is_none().then(|| config.settings.hypershift_trigger.trim());
    let mut overlay = Overlay::default();
    for (index, (control, button)) in controls(model).into_iter().enumerate() {
        let id = control_id(model, control);
        let key_button = index < model.key_buttons.len();
        for (layer, logical) in [(0u8, Layer::Standard), (1, Layer::Hypershift)] {
            if trigger == Some(control) {
                overlay.targets.push((button, layer, OnboardAction::Hypershift));
                continue;
            }
            // While the right button is the trigger, a left click under it is a
            // right click — as the software trigger does it.
            if layer == 1 && control == "mouse_left" && trigger == Some("mouse_right") {
                overlay.targets.push((button, layer, OnboardAction::Mouse(2)));
                continue;
            }
            if !(key_button || (checking_extras && consumer && layer == 0) || has_action(config, &id, logical)) {
                continue;
            }
            let mapping = |wanted: Layer| {
                config
                    .encoder_mappings
                    .iter()
                    .find(|mapping| mapping.control_id == id && mapping.layer == wanted)
            };
            let preferred = if consumer { Layer::Standard } else { logical };
            let Some(mapping) = mapping(preferred).or_else(|| mapping(Layer::Standard)) else {
                continue;
            };
            if consumer {
                let usage = *USAGES.get(2 * index + usize::from(layer)).ok_or_else(|| {
                    format!("{} has more controls than reserved usages", model.name)
                })?;
                overlay.targets.push((button, layer, OnboardAction::Consumer(usage)));
                overlay.signals.push(ConsumerSignal {
                    usage,
                    encoded_key: mapping.encoded_key.clone(),
                    hypershift: layer == 1,
                });
                continue;
            }
            match key_action(&mapping.encoded_key) {
                Some(action) => overlay.targets.push((button, layer, action)),
                // A key button with no F13..F24 signal would be dead.
                None if key_button => {
                    return Err(format!("Fallback for {} requires F13–F24", id.as_str()));
                }
                // Other controls keep their native records.
                None => {}
            }
        }
    }
    if let Some(trigger) = live.firmware_trigger
        && !overlay.targets.is_empty()
    {
        overlay.targets.extend([0, 1].map(|layer| (trigger, layer, OnboardAction::Hypershift)));
    }
    Ok(overlay)
}

/// The `F13`..`F24` key record of an encoded key, when it is one.
fn key_action(encoded_key: &str) -> Option<OnboardAction> {
    let key = crate::hotkeys::parse_hotkey(encoded_key).ok()?;
    let usage = super::usage_for_key(&key.key.display_name)?;
    let modifiers = key.modifiers;
    Some(OnboardAction::Key {
        modifier: super::left_modifier_bits(modifiers.ctrl, modifiers.shift, modifiers.alt, modifiers.win),
        usage,
    })
}

/// Records a bank needs so that `profile_id` works without Sidearm.
fn offline_targets(config: &AppConfig, model: &NativeModel, profile_id: &str) -> Vec<(u8, u8, OnboardAction)> {
    let Some(live) = &model.live else { return Vec::new() };
    let mut targets = Vec::new();
    let mut uses_hypershift = false;
    for (index, (control, button)) in controls(model).into_iter().enumerate() {
        // The profile button keeps switching banks without Sidearm.
        if Some(button) == live.profile_button {
            continue;
        }
        let id = control_id(model, control);
        let action = |layer| crate::mouse_offline::binding_action(config, profile_id, id.as_str(), layer);
        // A binding the firmware cannot play (text, macro, launch) gets a
        // reserved signal that does nothing, never the bank's old record —
        // a factory digit would type into whatever has focus. No binding at
        // all keeps the bank's own record.
        let play = |layer: u8, found: Option<Option<OnboardAction>>| {
            found.map(|action| action.unwrap_or(OnboardAction::Consumer(USAGES[2 * index + usize::from(layer)])))
        };
        let standard = action(Layer::Standard);
        let hypershift = action(Layer::Hypershift);
        uses_hypershift |= matches!(hypershift, Some(Some(_)));
        if let Some(action) = play(0, standard) {
            targets.push((button, 0, action));
        }
        // Like the resolver: the standard binding fills in only where the
        // hypershift layer has none.
        if let Some(action) = play(1, hypershift.or(standard)) {
            targets.push((button, 1, action));
        }
    }
    if uses_hypershift && let Some(trigger) = live.firmware_trigger {
        targets.extend([0, 1].map(|layer| (trigger, layer, OnboardAction::Hypershift)));
    }
    targets
}

/// The onboard banks a mouse reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Banks {
    /// Banks holding a profile, ascending.
    pub assigned: Vec<u8>,
    /// The bank the mouse plays now.
    pub active: u8,
}

/// Parses the three bank replies (count, inventory, active).
fn parse_banks(count: &[u8], inventory: &[u8], active: &[u8]) -> Result<Banks, String> {
    let count = count[8];
    let mut assigned: Vec<u8> = inventory[9..9 + usize::from(MAX_BANKS)].iter().copied().filter(|&bank| bank != 0).collect();
    assigned.sort_unstable();
    let active = active[8];
    let consistent = inventory[8] == MAX_BANKS
        && (1..=MAX_BANKS).contains(&count)
        && usize::from(count) == assigned.len()
        && assigned.iter().all(|bank| (1..=MAX_BANKS).contains(bank))
        && assigned.contains(&active);
    if !consistent {
        return Err(format!("Unexpected onboard bank state (count {count}, active {active}, assigned {assigned:?})"));
    }
    Ok(Banks { assigned, active })
}

/// The bank the mouse plays now (one command; [`read_banks`] checks it too).
fn active_bank(device: &VendorDevice) -> Result<u8, String> {
    Ok(device.command(CLASS_BANKS, CMD_ACTIVE_BANK, &[])?[8])
}

fn read_banks(device: &VendorDevice) -> Result<Banks, String> {
    parse_banks(
        &device.command(CLASS_BANKS, CMD_BANK_COUNT, &[0])?,
        &device.command(CLASS_BANKS, CMD_BANK_INVENTORY, &[0; 6])?,
        &device.command(CLASS_BANKS, CMD_ACTIVE_BANK, &[])?,
    )
}

/// The banks of the connected mouse of `model`.
pub fn banks(model: &'static NativeModel) -> Result<Banks, String> {
    if !model.live.as_ref().is_some_and(|live| live.banks) {
        return Err(format!("{} has no onboard banks", model.name));
    }
    read_banks(&VendorDevice::open_model(model)?)
}

/// Makes `bank` the one the mouse plays, confirmed by reading it back. The
/// firmware then reloads the live map from that bank — also when it already
/// was the active one, which is how a freshly written bank takes effect.
fn select_bank(device: &VendorDevice, bank: u8) -> Result<(), String> {
    if !read_banks(device)?.assigned.contains(&bank) {
        return Err(format!("Bank {bank} holds no profile on the mouse"));
    }
    device.command(CLASS_BANKS, CMD_SELECT_BANK, &[bank])?;
    if read_banks(device)?.active != bank {
        return Err(format!("Could not confirm bank {bank}"));
    }
    Ok(())
}

/// The bank to play after exit: the offline profile's own bank, else the one
/// that was playing.
fn exit_bank(plan: &[(u8, &str)], banks: &Banks, offline_profile: &str) -> u8 {
    plan.iter().find(|(_, profile)| *profile == offline_profile).map_or(banks.active, |(bank, _)| *bank)
}

/// Which profile each bank gets on exit: every profile linked to a bank, or —
/// with one bank and no link — the offline profile.
fn bank_plan<'a>(config: &'a AppConfig, model: &NativeModel, banks: &Banks, offline_profile: &'a str) -> Vec<(u8, &'a str)> {
    let linked: Vec<(u8, &str)> = config
        .profiles
        .iter()
        .filter_map(|profile| {
            let bank = *profile.device_slots.as_ref()?.get(model.device_id)?;
            banks.assigned.contains(&bank).then_some((bank, profile.id.as_str()))
        })
        .collect();
    if linked.is_empty() && banks.assigned.len() == 1 {
        return vec![(banks.assigned[0], offline_profile)];
    }
    linked
}

/// Stores the profiles linked to banks in the mouse of `model`, each verified
/// by reading it back. Banks with no linked profile are left as they are.
pub(crate) fn write_offline(
    config: &AppConfig,
    model: &'static NativeModel,
    offline_profile: &str,
    config_dir: &Path,
) -> Result<(), String> {
    let device = VendorDevice::open_model(model)?;
    let banks = read_banks(&device)?;
    let plan = bank_plan(config, model, &banks, offline_profile);
    if plan.is_empty() {
        log::info!("[mouse-offline] {} keeps its {} onboard profiles: none is linked", model.name, banks.assigned.len());
        return Ok(());
    }
    for &(bank, profile_id) in &plan {
        let backup = bank_backup(config_dir, model, bank);
        let targets = offline_targets(config, model, profile_id);
        let already_stored = load_snapshot(&device, &backup)?.is_some_and(|snapshot| {
            snapshot.records.len() == targets.len()
                && snapshot.records.iter().zip(&targets).all(|(record, &(button, layer, action))| {
                    (record.button, record.layer, record.target) == (button, layer, bank_block(bank, action))
                })
                && verify_bank(&device, bank, &snapshot.records).is_ok()
        });
        if !already_stored {
            apply_bank(&device, bank, &backup, &targets)?;
        }
        log::info!("[mouse-offline] {} profile `{profile_id}` verified in bank {bank}: {} records", model.name, targets.len());
        // Each bank keeps its own DPI and the mouse switches to it with the
        // bank: store the profile's own DPI for this mouse there.
        if let Some(dpi) = config.profiles.iter().find(|profile| profile.id == profile_id)
            .and_then(|profile| profile.mouse_for(model.device_id))
            .and_then(|own| own.mouse_dpi)
        {
            let dpi = dpi.clamp(model.dpi_min, model.dpi_max);
            match device.set_dpi_in(bank, dpi) {
                Ok(()) => log::info!("[mouse-offline] {} bank {bank} DPI {dpi} stored", model.name),
                Err(error) => log::warn!("[mouse-offline] {} bank {bank} DPI not stored: {error}", model.name),
            }
        }
    }
    // The records are stored either way; playing them at once is a convenience.
    if let Err(error) = select_bank(&device, exit_bank(&plan, &banks, offline_profile)) {
        log::warn!("[mouse-offline] {} bank not reselected after storing: {error}", model.name);
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Record {
    button: u8,
    layer: u8,
    before: [u8; 7],
    target: [u8; 7],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Snapshot {
    /// The receiver's device path when the file was written; only its VID/PID
    /// must match later — another USB port changes the rest.
    path: String,
    records: Vec<Record>,
}

/// Waits until every live session has restored its map and ended, at most
/// `limit`: the process must not exit while a mouse still plays Sidearm's
/// signals, which are silent without it.
pub fn wait_idle(limit: Duration) -> bool {
    let deadline = std::time::Instant::now() + limit;
    while ACTIVE.iter().any(|active| active.load(Ordering::Acquire)) {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
    true
}

/// Puts back every live map a Sidearm process left when it died without
/// restoring (killed, crashed): run by its capture helper, which outlives it.
/// Until then the mouse plays Sidearm's signals — every mapped button and the
/// wheel stay silent until a bank switch reloads the map from flash.
///
/// Returns whether nothing is left to restore.
pub fn restore_orphaned(config_dir: &Path) -> bool {
    let mut done = true;
    for model in CATALOG.iter().filter(|model| model.live.is_some()) {
        let backup = live_backup(config_dir, model);
        if !backup.exists() {
            continue;
        }
        match VendorDevice::open_model(model).and_then(|device| restore_bank(&device, LIVE_BANK, &backup)) {
            // Same as a session's end: the onboard path's signals come back at the next start.
            Ok(()) if model.transport == Transport::Onboard => {
                if let Err(error) = std::fs::write(config_dir.join(crate::mouse_offline::OFFLINE_MARKER_FILE), "live map") {
                    log::warn!("[naga-live] {} signals marker not written: {error}", model.name);
                }
            }
            Ok(()) => {}
            Err(error) => {
                log::warn!("[naga-live] {} live map left by a stopped Sidearm not restored: {error}", model.name);
                done = false;
            }
        }
    }
    done
}

/// A rollback file of `model`'s live map that no session restored (the mouse
/// slept until the session ended, or Sidearm was killed): the mouse may still
/// play that live map instead of its onboard signals.
pub fn unrestored_map(config_dir: &Path, model: &NativeModel) -> Option<PathBuf> {
    let backup = live_backup(config_dir, model);
    (!is_active(model) && backup.exists()).then_some(backup)
}

fn live_backup(config_dir: &Path, model: &NativeModel) -> PathBuf {
    // shortcut: rc builds of 2026-11-08 used these names; drop after 0.13.
    let legacy = match model.transport {
        Transport::Onboard => "naga-v2-live.json",
        Transport::LiveOverlay => "naga-v3-live.json",
    };
    migrate_legacy(config_dir, legacy, format!("{}-live.json", model.device_id))
}

fn bank_backup(config_dir: &Path, model: &NativeModel, bank: u8) -> PathBuf {
    // shortcut: rc builds of 2026-11-08 used this name; drop after 0.13.
    migrate_legacy(config_dir, &format!("naga-v3-onboard-{bank}.json"), format!("{}-bank-{bank}.json", model.device_id))
}

fn migrate_legacy(config_dir: &Path, legacy: &str, name: String) -> PathBuf {
    let path = config_dir.join(name);
    let legacy = config_dir.join(legacy);
    if !path.exists()
        && legacy.exists()
        && let Err(error) = std::fs::rename(&legacy, &path)
    {
        log::warn!("[naga-live] Could not rename {}: {error}", legacy.display());
    }
    path
}

fn block(action: OnboardAction) -> [u8; 7] {
    let bytes = action.bytes();
    let mut block = [0; 7];
    block[..bytes.len()].copy_from_slice(&bytes);
    block
}

/// A stored bank plays an unmodified key from a shorter record than the live map.
fn bank_block(bank: u8, action: OnboardAction) -> [u8; 7] {
    if bank != LIVE_BANK && let OnboardAction::Key { modifier: 0, usage } = action {
        return [0x02, 0x01, 0, usage, 0, 0, 0];
    }
    block(action)
}

fn read_bank(device: &VendorDevice, bank: u8, button: u8, layer: u8) -> Result<[u8; 7], String> {
    let mut args = [0; 10];
    args[0] = bank;
    args[1] = button;
    args[2] = layer;
    let reply = device.command(super::CLASS_BUTTON, super::CMD_GET_BUTTON, &args)?;
    if reply[8..10] != args[..2] {
        return Err(format!("Readback returned the wrong address for bank {bank}, button {button:#04x}/{layer}"));
    }
    let mut record = [0; 7];
    record.copy_from_slice(&reply[11..18]);
    Ok(record)
}

fn write_bank(device: &VendorDevice, bank: u8, button: u8, layer: u8, block: [u8; 7]) -> Result<(), String> {
    let mut args = [0; 10];
    args[0] = bank;
    args[1] = button;
    args[2] = layer;
    args[3..].copy_from_slice(&block);
    device.command(super::CLASS_BUTTON, super::CMD_SET_BUTTON, &args)?;
    if read_bank(device, bank, button, layer)? != block {
        return Err(format!("Write did not read back for bank {bank}, button {button:#04x}/{layer}"));
    }
    Ok(())
}

fn confirmed_drift(expected: [u8; 7], mut read_record: impl FnMut() -> Result<[u8; 7], String>) -> Result<bool, String> {
    // A firmware transition can return plausible but incorrect bytes once.
    Ok(read_record()? != expected && read_record()? != expected)
}

/// A rollback file only belongs to the same model's receiver, on any port.
fn same_receiver(snapshot_path: &str, device: &VendorDevice) -> bool {
    let needle = format!("VID_{:04X}&PID_{:04X}", device.model.vid, device.pid);
    snapshot_path.to_uppercase().contains(&needle)
}

fn load_snapshot(device: &VendorDevice, backup: &Path) -> Result<Option<Snapshot>, String> {
    let bytes = match std::fs::read(backup) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if !same_receiver(&snapshot.path, device) {
        return Err(format!("{} belongs to another receiver", backup.display()));
    }
    let model = device.model();
    let trigger = model.live.as_ref().and_then(|live| live.firmware_trigger);
    let known = |button| Some(button) == trigger || controls(model).iter().any(|&(_, id)| id == button);
    if snapshot.records.iter().any(|record| !known(record.button) || record.layer > 1) {
        return Err(format!("{} names an address {} does not have", backup.display(), model.name));
    }
    Ok(Some(snapshot))
}

fn save_snapshot(backup: &Path, snapshot: &Snapshot) -> Result<(), String> {
    crate::config::persist_atomically(backup, |file| serde_json::to_writer(file, snapshot).map_err(std::io::Error::other))
        .map_err(|error| error.to_string())
}

/// Puts back every record Sidearm still owns (the user's own changes stay).
fn restore_bank(device: &VendorDevice, bank: u8, backup: &Path) -> Result<(), String> {
    let Some(snapshot) = load_snapshot(device, backup)? else { return Ok(()) };
    let mut failure = None;
    for record in snapshot.records.iter().rev().filter(|record| record.before != record.target) {
        let result = read_bank(device, bank, record.button, record.layer).and_then(|current| {
            if current == record.target {
                write_bank(device, bank, record.button, record.layer, record.before)
            } else {
                Ok(())
            }
        });
        if let Err(error) = result {
            failure.get_or_insert(error);
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    std::fs::remove_file(backup).map_err(|error| error.to_string())?;
    log::info!("[naga-live] {} restored previous assignments in bank {bank}", device.model().name);
    Ok(())
}

fn verify_bank(device: &VendorDevice, bank: u8, records: &[Record]) -> Result<(), String> {
    for record in records {
        if read_bank(device, bank, record.button, record.layer)? != record.target {
            return Err(format!("Bank {bank} assignments changed after programming {:#04x}/{}", record.button, record.layer));
        }
    }
    Ok(())
}

/// Records to rewrite after drift. A record read as something else twice in a
/// row is someone else's change and becomes its new original; a single odd
/// read is a firmware transition and keeps the saved original.
fn plan_repair(records: &mut [Record], mut read_record: impl FnMut(u8, u8) -> Result<[u8; 7], String>) -> Result<Vec<usize>, String> {
    let mut pending = Vec::new();
    for (index, record) in records.iter_mut().enumerate() {
        let current = read_record(record.button, record.layer)?;
        if current == record.target {
            continue;
        }
        let again = read_record(record.button, record.layer)?;
        if again == record.target {
            continue;
        }
        if again == current {
            record.before = current;
        }
        pending.push(index);
    }
    Ok(pending)
}

fn repair(device: &VendorDevice, backup: &Path, snapshot: &mut Snapshot) -> Result<(), String> {
    let started = std::time::Instant::now();
    if !same_receiver(&snapshot.path, device) {
        return Err("Live backup belongs to another receiver".into());
    }
    if device.mode()? != MODE_NORMAL {
        return Err("Mouse is not in firmware mode".into());
    }
    let mut updated = snapshot.clone();
    let pending = plan_repair(&mut updated.records, |button, layer| read_bank(device, LIVE_BANK, button, layer))?;
    // Save any newly observed original values before taking ownership of them.
    if updated.records != snapshot.records {
        save_snapshot(backup, &updated)?;
        *snapshot = updated;
    }
    if !pending.is_empty() {
        for &index in &pending {
            let record = &snapshot.records[index];
            write_bank(device, LIVE_BANK, record.button, record.layer, record.target)?;
        }
        verify_bank(device, LIVE_BANK, &snapshot.records)?;
    }
    log::info!(
        "[naga-live] {} repaired {} of {} live assignments in {} ms",
        device.model().name,
        pending.len(),
        snapshot.records.len(),
        started.elapsed().as_millis()
    );
    Ok(())
}

fn apply_bank(device: &VendorDevice, bank: u8, backup: &Path, targets: &[(u8, u8, OnboardAction)]) -> Result<Snapshot, String> {
    if device.mode()? != MODE_NORMAL {
        return Err("Mouse is not in firmware mode".into());
    }
    restore_bank(device, bank, backup)?;
    let mut records = Vec::with_capacity(targets.len());
    for &(button, layer, action) in targets {
        records.push(Record {
            button,
            layer,
            before: read_bank(device, bank, button, layer)?,
            target: bank_block(bank, action),
        });
    }
    let snapshot = Snapshot { path: device.path.clone(), records };
    if snapshot.records.is_empty() {
        return Ok(snapshot);
    }
    save_snapshot(backup, &snapshot)?;
    let result = snapshot
        .records
        .iter()
        .filter(|record| record.before != record.target)
        .try_for_each(|record| write_bank(device, bank, record.button, record.layer, record.target))
        .and_then(|()| verify_bank(device, bank, &snapshot.records));
    if let Err(error) = result {
        if let Err(rollback) = restore_bank(device, bank, backup) {
            log::warn!("[naga-live] {} rollback of bank {bank} pending: {rollback}", device.model().name);
        }
        return Err(error);
    }
    Ok(snapshot)
}

/// One model's live map, owned by a worker thread for the life of the value.
pub struct Session {
    stop: Option<mpsc::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
    model: &'static NativeModel,
    targets: Arc<[(u8, u8, OnboardAction)]>,
}

impl Session {
    pub fn matches(&self, model: &NativeModel, targets: &[(u8, u8, OnboardAction)]) -> bool {
        std::ptr::eq(self.model, model) && self.targets.as_ref() == targets
    }

    /// Starts the worker; `None` when there is nothing to write. A model with
    /// onboard records first puts back the offline profile the last exit left
    /// in it (`config` is the one that profile came from).
    pub fn start(
        model: &'static NativeModel,
        config_dir: PathBuf,
        config: &AppConfig,
        targets: Vec<(u8, u8, OnboardAction)>,
    ) -> Option<Self> {
        if targets.is_empty() {
            return None;
        }
        let targets: Arc<[(u8, u8, OnboardAction)]> = Arc::from(targets);
        let worker_targets = Arc::clone(&targets);
        let backup = live_backup(&config_dir, model);
        let onboard = (model.transport == Transport::Onboard).then(|| config.clone());
        let index = catalog_index(model);
        ACTIVE[index].store(true, Ordering::Release);
        let (stop, stopped) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("naga-live".into())
            .spawn(move || {
                let open = || VendorDevice::open_model(model);
                let attempt = |active: &mut Option<Snapshot>| {
                    // The last session's maps are still being restored by another process.
                    if crate::live_map_restore_running() {
                        return Err("The previous session's live maps are still being restored".to_owned());
                    }
                    if let Some(snapshot) = active {
                        return repair(&open()?, &backup, snapshot);
                    }
                    if let Some(config) = &onboard
                        && config_dir.join(crate::mouse_offline::OFFLINE_MARKER_FILE).exists()
                    {
                        restore_bank(&open()?, LIVE_BANK, &backup)?;
                        if !crate::mouse_offline::restore_after_offline(config, &config_dir) {
                            return Err("Offline assignments are still pending".into());
                        }
                    }
                    let snapshot = apply_bank(&open()?, LIVE_BANK, &backup, &worker_targets)?;
                    log::info!("[naga-live] {} verified {} live assignments", model.name, snapshot.records.len());
                    *active = Some(snapshot);
                    Ok(())
                };
                let mut last_error = None;
                let mut active = None;
                'session: loop {
                    loop {
                        match attempt(&mut active) {
                            Ok(()) => break,
                            Err(message) if message != super::NO_INTERFACE && last_error.as_ref() != Some(&message) => {
                                log::warn!("[naga-live] {} waiting to configure live assignments: {message}", model.name);
                                last_error = Some(message);
                            }
                            Err(_) => {}
                        }
                        if stopped.recv_timeout(RETRY) != Err(mpsc::RecvTimeoutError::Timeout) {
                            break 'session;
                        }
                    }
                    last_error = None;
                    READY[index].store(true, Ordering::Release);
                    // The profile button reloads the whole live map from another
                    // bank: watching the active bank catches it at once, where the
                    // record-by-record check would take a full cycle.
                    let has_banks = model.live.as_ref().is_some_and(|live| live.banks);
                    let mut last_bank = None;
                    for &(button, layer, action) in worker_targets.iter().cycle() {
                        if stopped.recv_timeout(RETRY) != Err(mpsc::RecvTimeoutError::Timeout) {
                            break 'session;
                        }
                        if has_banks
                            && let Ok(bank) = open().and_then(|device| active_bank(&device))
                        {
                            if last_bank.is_some_and(|last| last != bank) {
                                log::warn!("[naga-live] {} switched to bank {bank}; repairing the live map", model.name);
                                break;
                            }
                            last_bank = Some(bank);
                        }
                        let drift = open().and_then(|device| {
                            confirmed_drift(block(action), || read_bank(&device, LIVE_BANK, button, layer))
                        });
                        if drift == Ok(true) {
                            // Keep forwarding releases for inputs held before recovery.
                            log::warn!("[naga-live] {} live assignment {button:#04x}/{layer} changed; repairing", model.name);
                            break;
                        }
                    }
                }
                READY[index].store(false, Ordering::Release);
                if active.is_some() {
                    if let Err(error) = open().and_then(|device| restore_bank(&device, LIVE_BANK, &backup)) {
                        log::warn!("[naga-live] {} recovery pending until next start: {error}", model.name);
                    }
                    // The restored map plays what the mouse had stored (often the
                    // offline profile), not Sidearm's onboard signals: mark it so
                    // the guard, or the next live session, writes them back.
                    if onboard.is_some()
                        && let Err(error) = std::fs::write(config_dir.join(crate::mouse_offline::OFFLINE_MARKER_FILE), "live map")
                    {
                        log::warn!("[naga-live] {} signals marker not written: {error}", model.name);
                    }
                }
            })
            .inspect_err(|error| {
                ACTIVE[index].store(false, Ordering::Release);
                log::warn!("[naga-live] {} could not start worker: {error}", model.name);
            })
            .ok()?;
        Some(Self { stop: Some(stop), worker: Some(worker), model, targets })
    }

    /// Asks the worker to restore and stop without waiting for it, so several
    /// mice restore at once; dropping the session waits.
    pub fn request_stop(&mut self) {
        drop(self.stop.take());
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.request_stop();
        if let Some(worker) = self.worker.take()
            && worker.join().is_err()
        {
            log::error!("[naga-live] {} worker panicked; its live map is restored on the next start", self.model.name);
        }
        ACTIVE[catalog_index(self.model)].store(false, Ordering::Release);
        // Back on the onboard path: the guard restores its signals at once.
        if self.model.transport == Transport::Onboard {
            crate::onboard_guard::request_check();
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::device_catalog::{NAGA_PRO, NAGA_V2_HYPERSPEED, NAGA_V3_PRO};

    pub(crate) fn config_with_v3() -> AppConfig {
        let mut config = crate::config::default_seed_config();
        add_device(&mut config, &NAGA_V3_PRO);
        config
    }

    #[test]
    fn every_live_model_fits_the_reserved_usages() {
        for model in CATALOG.iter().filter(|model| model.live.is_some()) {
            assert!(2 * controls(model).len() <= USAGES.len(), "{}", model.name);
        }
        let mut usages = USAGES.to_vec();
        usages.sort_unstable();
        usages.dedup();
        assert_eq!(usages.len(), USAGES.len());
    }

    #[test]
    fn live_sessions_follow_the_connected_mice() {
        let names = |models: Vec<&NativeModel>| models.iter().map(|model| model.name).collect::<Vec<_>>();
        assert_eq!(names(live_models(&[&NAGA_V2_HYPERSPEED])), Vec::<&str>::new());
        assert_eq!(names(live_models(&[&NAGA_V3_PRO])), ["Razer Naga V3 Pro"]);
        assert_eq!(
            names(live_models(&[&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO])),
            ["Razer Naga V2 HyperSpeed", "Razer Naga V3 Pro"]
        );
        // A model with no live path keeps the onboard path even with two mice,
        // and an unverified one does not make a second mouse.
        assert_eq!(names(live_models(&[&NAGA_PRO, &NAGA_V3_PRO])), ["Razer Naga V3 Pro"]);
        assert_eq!(names(live_models(&[&NAGA_V2_HYPERSPEED, &NAGA_PRO])), Vec::<&str>::new());
    }

    #[test]
    fn a_rollback_file_nobody_restored_is_found_by_model() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unrestored_map(dir.path(), &NAGA_V2_HYPERSPEED), None);
        std::fs::write(dir.path().join("naga-v2-live.json"), "{}").unwrap();
        let found = unrestored_map(dir.path(), &NAGA_V2_HYPERSPEED).expect("an rc-era file counts too");
        assert!(found.ends_with("razer-naga-live.json"));
        assert_eq!(unrestored_map(dir.path(), &NAGA_V3_PRO), None, "another model's file is not this one's");
    }

    #[test]
    fn software_hypershift_serves_only_onboard_mice() {
        assert!(software_hypershift(&[], &[]));
        assert!(software_hypershift(&[&NAGA_V2_HYPERSPEED], &[]));
        assert!(!software_hypershift(&[&NAGA_V3_PRO], &[&NAGA_V3_PRO]));
        let both = [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO];
        assert!(!software_hypershift(&both, &live_models(&both)));
        let pro = [&NAGA_PRO, &NAGA_V3_PRO];
        assert!(software_hypershift(&pro, &live_models(&pro)));
    }

    #[test]
    fn v3_setup_maps_unassigned_extra_controls_only_in_live_standard_layer() {
        let config = config_with_v3();
        let normal = overlay(&config, &NAGA_V3_PRO, true, false).unwrap();
        let setup = overlay(&config, &NAGA_V3_PRO, true, true).unwrap();
        let extras = NAGA_V3_PRO.live.as_ref().unwrap().extras;
        assert_eq!(setup.targets.len() - normal.targets.len(), extras.len());
        for &(control, button) in extras {
            assert!(!normal.targets.iter().any(|target| target.0 == button));
            let index = controls(&NAGA_V3_PRO).iter().position(|entry| entry.0 == control).unwrap();
            let signal = USAGES[2 * index];
            assert!(setup.targets.contains(&(button, 0, OnboardAction::Consumer(signal))));
            assert!(!setup.targets.iter().any(|target| target.0 == button && target.1 == 1));
            assert!(setup.signals.iter().any(|entry| entry.usage == signal && !entry.hypershift));
        }
        assert!(offline_targets(&config, &NAGA_V3_PRO, "main").is_empty());
    }

    #[test]
    fn new_v3_has_no_bindings_and_preserves_v2() {
        let mut config = crate::config::default_seed_config();
        let original = config.clone();
        assert!(configure(&mut config, &[&NAGA_V3_PRO]));
        assert!(configured(&config, &NAGA_V3_PRO));
        assert!(!configure(&mut config, &[&NAGA_V3_PRO]), "added once");
        assert!(!configure(&mut config, &[&NAGA_V2_HYPERSPEED]), "V2 is built in");
        assert_eq!(config.profiles, original.profiles);
        assert_eq!(config.bindings, original.bindings);
        assert_eq!(config.actions, original.actions);
        assert_eq!(&config.physical_controls[..original.physical_controls.len()], original.physical_controls);
        assert!(config.physical_controls.iter().any(|control| control.device_id == NAGA_V3_PRO.device_id
            && control.id == control_id(&NAGA_V3_PRO, "hypershift_button")
            && control.default_name == "control.name.v3Ring"));
        let folder = tempfile::tempdir().unwrap();
        crate::config::save_config(folder.path(), config, None).unwrap();
    }

    #[test]
    fn v2_overlay_keeps_left_click_and_uses_its_own_trigger_and_aliases() {
        let config = config_with_v3();
        let v2 = overlay(&config, &NAGA_V2_HYPERSPEED, true, false).unwrap();
        let v3 = overlay(&config, &NAGA_V3_PRO, true, false).unwrap();
        assert!(v2.targets.contains(&(0x02, 0, OnboardAction::Hypershift)));
        assert!(v2.targets.contains(&(0x01, 1, OnboardAction::Mouse(2))));
        assert!(!v2.targets.iter().any(|&(button, layer, _)| button == 0x01 && layer == 0));
        assert_eq!(v2.signals.iter().filter(|signal| signal.encoded_key == "F13").count(), 2);
        assert!(!v2.signals.iter().any(|a| v3.signals.iter().any(|b| a.encoded_key == b.encoded_key)));
    }

    #[test]
    fn v2_overlay_follows_the_keyboard_fallback() {
        let config = config_with_v3();
        let keys = overlay(&config, &NAGA_V2_HYPERSPEED, false, false).unwrap();
        assert!(keys.signals.is_empty());
        assert!(keys.targets.contains(&(0x40, 0, OnboardAction::Key { modifier: 0, usage: 0x68 })));
        assert!(keys.targets.contains(&(0x02, 0, OnboardAction::Hypershift)));
    }

    #[test]
    fn editing_an_action_keeps_both_maps_but_moving_v2_hypershift_changes_only_v2() {
        let mut config = config_with_v3();
        let v2 = overlay(&config, &NAGA_V2_HYPERSPEED, true, false).unwrap();
        let v3 = overlay(&config, &NAGA_V3_PRO, true, false).unwrap();
        config.actions[0].display_name = "Renamed shortcut".into();
        assert_eq!(overlay(&config, &NAGA_V2_HYPERSPEED, true, false).unwrap(), v2);
        assert_eq!(overlay(&config, &NAGA_V3_PRO, true, false).unwrap(), v3);
        config.settings.hypershift_trigger = "mouse_4".into();
        assert_ne!(overlay(&config, &NAGA_V2_HYPERSPEED, true, false).unwrap(), v2);
        assert_eq!(overlay(&config, &NAGA_V3_PRO, true, false).unwrap(), v3);
    }

    #[test]
    fn all_thumb_layers_have_distinct_hid_usages_and_keyboard_fallback() {
        let config = config_with_v3();
        let hid = overlay(&config, &NAGA_V3_PRO, true, false).unwrap();
        let keys = overlay(&config, &NAGA_V3_PRO, false, false).unwrap();
        let mut seen = HashSet::new();
        for index in 0..12 {
            for layer in 0..2 {
                let signal = &hid.signals[2 * index + layer];
                let button = 0x40 + index as u8;
                assert!(seen.insert(signal.usage));
                assert_eq!(signal.hypershift, layer == 1);
                assert!(hid.targets.contains(&(button, layer as u8, OnboardAction::Consumer(signal.usage))));
                assert!(keys.targets.iter().any(|&(id, slot, action)| {
                    id == button && usize::from(slot) == layer && matches!(action, OnboardAction::Key { .. })
                }));
            }
        }
        assert!(hid.targets.contains(&(0x39, 0, OnboardAction::Hypershift)));
    }

    #[test]
    fn live_drift_requires_two_mismatches_and_ignores_unreadable_records() {
        let expected = block(OnboardAction::Consumer(0x10));
        let factory = block(OnboardAction::Key { modifier: 0, usage: 0x1e });
        let mut reset = [Ok(factory), Ok(factory)].into_iter();
        assert_eq!(confirmed_drift(expected, || reset.next().unwrap()), Ok(true));
        let mut transition = [Ok(factory), Ok(expected)].into_iter();
        assert_eq!(confirmed_drift(expected, || transition.next().unwrap()), Ok(false));
        let mut asleep = [Ok(factory), Err("Mouse asleep".into())].into_iter();
        assert!(confirmed_drift(expected, || asleep.next().unwrap()).is_err());
    }

    #[test]
    fn repair_adopts_only_a_stable_foreign_value_as_the_original() {
        let original = block(OnboardAction::Key { modifier: 0, usage: 0x1e });
        let changed = block(OnboardAction::Key { modifier: 0, usage: 0x1f });
        let glitch = block(OnboardAction::Key { modifier: 0, usage: 0x20 });
        let standard = block(OnboardAction::Consumer(0x10));
        let hypershift = block(OnboardAction::Consumer(0x11));
        let mut records = [
            Record { button: 0x40, layer: 0, before: original, target: standard },
            Record { button: 0x40, layer: 1, before: original, target: hypershift },
        ];
        // Layer 1 was really changed by someone: adopted.
        let pending = plan_repair(&mut records, |_, layer| Ok(if layer == 0 { standard } else { changed }));
        assert_eq!(pending, Ok(vec![1]));
        assert_eq!(records[0].before, original);
        assert_eq!(records[1].before, changed);
        // One odd read then another value: rewritten, but the original stays.
        let mut reads = [Ok(standard), Ok(glitch), Ok(original)].into_iter();
        let pending = plan_repair(&mut records, |_, _| reads.next().unwrap());
        assert_eq!(pending, Ok(vec![1]));
        assert_eq!(records[1].before, changed);
        // A second read that shows the target is a transition: nothing to do.
        let mut reads = [Ok(standard), Ok(glitch), Ok(hypershift)].into_iter();
        assert_eq!(plan_repair(&mut records, |_, _| reads.next().unwrap()), Ok(vec![]));
    }

    fn bank_replies(count: u8, slots: [u8; 5], active: u8) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let mut count_reply = vec![0; 90];
        count_reply[8] = count;
        let mut inventory = vec![0; 90];
        inventory[8] = MAX_BANKS;
        inventory[9..14].copy_from_slice(&slots);
        let mut active_reply = vec![0; 90];
        active_reply[8] = active;
        (count_reply, inventory, active_reply)
    }

    #[test]
    fn bank_inventory_is_parsed_and_checked() {
        let (count, inventory, active) = bank_replies(3, [1, 2, 3, 0, 0], 2);
        assert_eq!(parse_banks(&count, &inventory, &active), Ok(Banks { assigned: vec![1, 2, 3], active: 2 }));
        let (count, inventory, active) = bank_replies(2, [1, 2, 3, 0, 0], 2);
        assert!(parse_banks(&count, &inventory, &active).is_err(), "count disagrees with the inventory");
        let (count, inventory, active) = bank_replies(1, [1, 0, 0, 0, 0], 4);
        assert!(parse_banks(&count, &inventory, &active).is_err(), "active bank is not assigned");
    }

    #[test]
    fn exit_writes_linked_banks_or_the_only_bank() {
        let mut config = config_with_v3();
        let one = Banks { assigned: vec![1], active: 1 };
        let three = Banks { assigned: vec![1, 2, 3], active: 2 };
        assert_eq!(bank_plan(&config, &NAGA_V3_PRO, &one, "main"), [(1, "main")]);
        assert!(bank_plan(&config, &NAGA_V3_PRO, &three, "main").is_empty(), "unlinked banks are preserved");
        let profile = config.profiles[0].id.clone();
        config.profiles[0].device_slots = Some([(NAGA_V3_PRO.device_id.to_owned(), 2)].into());
        assert_eq!(bank_plan(&config, &NAGA_V3_PRO, &three, "main"), [(2, profile.as_str())]);
        assert!(bank_plan(&config, &NAGA_V3_PRO, &Banks { assigned: vec![1, 3], active: 1 }, "main").is_empty(),
            "a link to a bank the mouse does not hold is ignored");
        let plan = [(2, "code"), (3, "game")];
        assert_eq!(exit_bank(&plan, &three, "game"), 3, "the offline profile's bank plays after exit");
        assert_eq!(exit_bank(&plan, &three, "main"), 2, "else the bank that was playing");
    }

    #[test]
    fn v3_offline_profile_exports_its_own_hypershift() {
        let mut config = config_with_v3();
        let profile = config.profiles[0].id.clone();
        let action = config.actions.iter().find(|action| action.action_type == ActionType::Shortcut).unwrap().id.clone();
        config.bindings.push(crate::config::Binding {
            id: "v3-test".into(),
            profile_id: profile.clone(),
            layer: Layer::Hypershift,
            control_id: control_id(&NAGA_V3_PRO, "thumb_02"),
            label: "test".into(),
            action_id: action,
            color_tag: None,
            trigger_mode: None,
            chord_partner: None,
            enabled: true,
            throttle_ms: None,
        });
        let targets = offline_targets(&config, &NAGA_V3_PRO, &profile);
        assert!(targets.iter().any(|&(button, layer, _)| button == 0x41 && layer == 1));
        assert!(targets.contains(&(0x39, 0, OnboardAction::Hypershift)));
        config.bindings.push(crate::config::Binding {
            id: "v3-profile".into(),
            control_id: control_id(&NAGA_V3_PRO, "top_special_03"),
            layer: Layer::Standard,
            ..config.bindings.last().unwrap().clone()
        });
        assert!(!offline_targets(&config, &NAGA_V3_PRO, &profile).iter().any(|&(button, _, _)| button == 0x0e),
            "the profile button stays the mouse's own");
        // A text binding has no firmware form: the bank gets a silent signal,
        // not its old record (a factory digit).
        let text = config.actions.iter().find(|action| action.action_type == ActionType::TextSnippet).unwrap().id.clone();
        config.bindings.push(crate::config::Binding {
            id: "v3-text".into(),
            control_id: control_id(&NAGA_V3_PRO, "thumb_03"),
            layer: Layer::Standard,
            action_id: text,
            ..config.bindings.last().unwrap().clone()
        });
        let targets = offline_targets(&config, &NAGA_V3_PRO, &profile);
        assert!(targets.contains(&(0x42, 0, OnboardAction::Consumer(USAGES[4]))));
        assert!(targets.contains(&(0x42, 1, OnboardAction::Consumer(USAGES[5]))));
        assert!(!targets.iter().any(|&(button, _, _)| button == 0x43), "an unbound button keeps its record");
        assert_eq!(bank_block(1, OnboardAction::Key { modifier: 0, usage: 0x2a }), [2, 1, 0, 0x2a, 0, 0, 0]);
        assert_eq!(bank_block(1, OnboardAction::Key { modifier: 1, usage: 0x19 }), [2, 2, 1, 0x19, 0, 0, 0]);
    }

    #[test]
    fn a_rollback_file_follows_the_receiver_to_another_port() {
        let device = |path: &str| VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, path);
        let saved = r"\\?\HID#VID_1532&PID_00E8&MI_03#7&1a2b3c&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";
        assert!(same_receiver(saved, &device(r"\\?\hid#vid_1532&pid_00e8&mi_03#8&ffff&0&0000#{guid}")));
        assert!(!same_receiver(saved, &VendorDevice::test_handle(&NAGA_V2_HYPERSPEED, 0x00b4, "")));
    }
}
