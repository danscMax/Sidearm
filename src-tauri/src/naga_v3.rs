//! Reversible live assignments for the Naga V3 Pro receiver.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, mpsc,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};

use super::{ConsumerSignal, MODE_NORMAL, OnboardAction, VendorDevice};
use crate::{
    config::{
        AppConfig, CapabilityStatus, ControlId, Device, EncoderMapping, Layer, MappingSource,
        RAZER_NAGA_DEVICE_ID,
    },
    device_catalog::{NAGA_V2_HYPERSPEED, NAGA_V3_PRO, NativeModel},
};

pub const DEVICE_ID: &str = "razer-naga-v3";
const COPY_EXISTING: &str = "naga-v3-copy-existing";
const BACKUP: &str = "naga-v3-live.json";
const V2_BACKUP: &str = "naga-v2-live.json";
const LIVE_BANK: u8 = 0;
static V2_LIVE: AtomicBool = AtomicBool::new(false);
static V2_READY: AtomicBool = AtomicBool::new(false);
static V3_READY: AtomicBool = AtomicBool::new(false);

pub fn v2_live() -> bool {
    V2_LIVE.load(Ordering::Acquire)
}

pub fn hid_ready(v2: bool) -> bool {
    (if v2 { &V2_READY } else { &V3_READY }).load(Ordering::Acquire)
}
const RING: u8 = 0x39;
const RETRY: Duration = Duration::from_secs(2);
const EXTRAS: [(&str, u8); 10] = [
    ("top_aux_01", 0x0b),
    ("top_aux_02", 0x0c),
    ("wheel_left", 0x34),
    ("wheel_right", 0x35),
    ("wheel_click", 0x03),
    ("top_special_01", 0x6a),
    ("top_special_02", 0x80),
    ("top_special_03", 0x0e),
    ("wheel_up", 0x09),
    ("wheel_down", 0x0a),
];
// Reserved Consumer Page usages within the one-byte range the device emits.
const USAGES: [u16; 44] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x37, 0x38, 0x39,
    0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e,
];

pub fn connected() -> bool {
    VendorDevice::open(&NAGA_V3_PRO, NAGA_V3_PRO.pids[0]).is_ok()
}

pub fn configured(config: &AppConfig) -> bool {
    config.devices.iter().any(|device| device.id == DEVICE_ID)
}

pub fn configure(config: &mut AppConfig, config_dir: &Path) -> bool {
    if !configured(config) {
        let detected = connected();
        let copy = config_dir.join(COPY_EXISTING).is_file();
        prepare(config, detected, copy);
        return detected && copy;
    }
    false
}

pub fn clear_copy_request(config_dir: &Path) {
    if let Err(error) = std::fs::remove_file(config_dir.join(COPY_EXISTING))
        && error.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!("[naga-live] Could not remove completed V3 migration request: {error}");
    }
}
pub(crate) fn is_extra(control: &str) -> bool {
    EXTRAS.iter().any(|(id, _)| *id == control)
}

fn prepare(config: &mut AppConfig, detected: bool, copy_existing: bool) {
    restore_v2_surface(config);
    if !detected || configured(config) {
        return;
    }
    let device = Device {
        id: DEVICE_ID.into(),
        name: NAGA_V3_PRO.name.into(),
        builtin: true,
        image: None,
        hotspots: Vec::new(),
    };
    let index = config
        .devices
        .iter()
        .position(|item| item.id == RAZER_NAGA_DEVICE_ID);
    if let Some(index) = index {
        config.devices.insert(index + 1, device);
    } else {
        config.devices.push(device);
    }

    for mut control in crate::config::seed_physical_controls() {
        let id = control.id.as_str();
        let name = match id {
            "top_special_01" => Some("control.name.v3ScrollMode"),
            "top_special_02" => Some("control.name.v3ScrollAux"),
            "top_special_03" => Some("control.name.v3ProfileButton"),
            "wheel_left" => Some("control.name.v3TiltLeft"),
            "wheel_right" => Some("control.name.v3TiltRight"),
            "hypershift_button" => Some("control.name.v3Ring"),
            _ => None,
        };
        let remappable = controls().any(|(control, _)| control == id);
        if !remappable && !matches!(id, "mouse_left" | "mouse_right" | "hypershift_button") {
            continue;
        }
        control.id = control_id(id);
        control.device_id = DEVICE_ID.into();
        if let Some(name) = name {
            control.default_name = name.into();
        }
        control.remappable = remappable;
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
        "Ctrl+Shift",
        "Alt+Shift",
        "Ctrl+Win",
        "Shift+Win",
        "Alt+Win",
        "Ctrl+Shift+Win",
        "Ctrl+Alt+Win",
        "Alt+Shift+Win",
        "Ctrl+Alt+Shift+Win",
    ]
    .into_iter()
    .flat_map(|mods| (13..=24).map(move |key| format!("{mods}+F{key}")))
    .filter_map(|alias| crate::hotkeys::normalize_hotkey(&alias).ok());
    for (control, _) in controls() {
        for layer in [Layer::Standard, Layer::Hypershift] {
            if let Some(encoded_key) = aliases.find(|alias| taken.insert(alias.clone())) {
                config.encoder_mappings.push(EncoderMapping {
                    control_id: control_id(control),
                    layer,
                    encoded_key,
                    source: MappingSource::Reserved,
                    verified: true,
                });
            }
        }
    }
    if copy_existing {
        copy_v2_bindings(config);
    }
}

fn control_id(control: &str) -> ControlId {
    ControlId::new(format!("v3_{control}"))
}

fn copy_v2_bindings(config: &mut AppConfig) {
    let old_controls: HashSet<_> = config
        .physical_controls
        .iter()
        .filter(|control| control.device_id == RAZER_NAGA_DEVICE_ID)
        .map(|control| control.id.clone())
        .collect();
    let translate = |id: &ControlId| {
        if !old_controls.contains(id) {
            return None;
        }
        let id = match id.as_str() {
            "mouse_4" => "wheel_left",
            "mouse_5" => "wheel_right",
            id => id,
        };
        controls()
            .any(|(control, _)| control == id)
            .then(|| control_id(id))
    };
    let mut action_ids = HashMap::new();
    let mut binding_ids: HashSet<_> = config
        .bindings
        .iter()
        .map(|binding| binding.id.clone())
        .collect();
    let mut slots = HashSet::new();
    let mut copies = Vec::new();
    // Prefer an existing V3 tilt assignment over the V2 X-button equivalent.
    for native_tilt in [false, true] {
        for binding in &config.bindings {
            if matches!(binding.control_id.as_str(), "mouse_4" | "mouse_5") != native_tilt {
                continue;
            }
            let Some(id) = translate(&binding.control_id) else {
                continue;
            };
            let mut copy = binding.clone();
            if let Some(partner) = &binding.chord_partner {
                let Some(partner) = translate(partner) else {
                    continue;
                };
                copy.chord_partner = Some(partner);
            }
            if !slots.insert((
                binding.profile_id.clone(),
                binding.layer,
                id.clone(),
                copy.trigger_mode,
                copy.chord_partner.clone(),
            )) {
                continue;
            }
            copy.control_id = id;
            copy.id = unique_copy_id(&binding.id, &mut binding_ids);
            copies.push(copy);
        }
    }
    let mut used_actions: HashSet<_> = config
        .actions
        .iter()
        .map(|action| action.id.clone())
        .collect();
    let mut actions = Vec::new();
    for binding in &mut copies {
        binding.action_id = action_ids
            .entry(binding.action_id.clone())
            .or_insert_with(|| {
                let Some(mut action) = config
                    .actions
                    .iter()
                    .find(|action| action.id == binding.action_id)
                    .cloned()
                else {
                    return binding.action_id.clone();
                };
                action.id = unique_copy_id(&action.id, &mut used_actions);
                let id = action.id.clone();
                actions.push(action);
                id
            })
            .clone();
    }
    config.actions.extend(actions);
    config.bindings.extend(copies);
}

fn unique_copy_id(id: &str, used: &mut HashSet<String>) -> String {
    let mut copy = format!("v3-{id}");
    while !used.insert(copy.clone()) {
        copy.insert_str(0, "v3-");
    }
    copy
}

fn restore_v2_surface(config: &mut AppConfig) {
    if !config.physical_controls.iter().any(|control| {
        control.device_id == RAZER_NAGA_DEVICE_ID && control.default_name == "control.name.v3Ring"
    }) {
        return;
    }
    let seed = crate::config::seed_physical_controls();
    if let Some(device) = config
        .devices
        .iter_mut()
        .find(|device| device.id == RAZER_NAGA_DEVICE_ID)
        && device.name == NAGA_V3_PRO.name
    {
        device.name = super::config_model().name.to_owned();
    }
    for control in &mut config.physical_controls {
        if control.device_id == RAZER_NAGA_DEVICE_ID
            && (is_extra(control.id.as_str())
                || matches!(
                    control.id.as_str(),
                    "hypershift_button" | "mouse_left" | "mouse_right"
                ))
            && let Some(original) = seed.iter().find(|item| item.id == control.id)
        {
            control.default_name = original.default_name.clone();
            control.capability_status = original.capability_status;
            control.remappable = original.remappable;
            control.notes = original.notes.clone();
        }
    }
}

fn controls() -> impl Iterator<Item = (&'static str, u8)> {
    NAGA_V3_PRO.key_buttons.iter().chain(&EXTRAS).copied()
}

fn offline_targets(config: &AppConfig, profile_id: &str) -> Vec<(u8, u8, OnboardAction)> {
    let mut targets = Vec::new();
    let mut uses_hypershift = false;
    for (control, button) in controls().filter(|(control, _)| *control != "top_special_03") {
        let control = control_id(control);
        let action = |layer| crate::mouse_offline::binding_action(config, profile_id, control.as_str(), layer);
        let standard = action(Layer::Standard).flatten();
        let hypershift = action(Layer::Hypershift);
        uses_hypershift |= matches!(hypershift, Some(Some(_)));
        if let Some(action) = standard {
            targets.push((button, 0, action));
        }
        if let Some(action) = hypershift.unwrap_or(standard) {
            targets.push((button, 1, action));
        }
    }
    if uses_hypershift {
        targets.extend([0, 1].map(|layer| (RING, layer, OnboardAction::Hypershift)));
    }
    targets
}

pub(crate) fn write_offline(config: &AppConfig, profile_id: &str, config_dir: &Path) -> Result<(), String> {
    let device = VendorDevice::open(&NAGA_V3_PRO, NAGA_V3_PRO.pids[0])?;
    let reply = device.command(0x05, 0x84, &[0])?;
    let bank = reply[8];
    if !(1..=5).contains(&bank) {
        return Err(format!("Unknown active onboard bank {bank}"));
    }
    let backup = config_dir.join(format!("naga-v3-onboard-{bank}.json"));
    let targets = offline_targets(config, profile_id);
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
    log::info!("[mouse-offline] Naga V3 Pro profile `{profile_id}` verified in bank {bank}: {} records", targets.len());
    Ok(())
}

fn usage(index: usize, layer: u8) -> u16 {
    USAGES[2 * index + usize::from(layer)]
}

fn remapped(config: &AppConfig, index: usize, control: &str, layer: Layer) -> bool {
    let control_id = control_id(control);
    index < NAGA_V3_PRO.key_buttons.len()
        || config.bindings.iter().any(|binding| {
            binding.enabled
                && binding.control_id == control_id
                && (binding.layer == layer || layer == Layer::Hypershift)
                && config.actions.iter().any(|action| {
                    action.id == binding.action_id
                        && action.action_type != crate::config::ActionType::Disabled
                })
        })
}

pub fn signals(config: &AppConfig, consumer: bool) -> Vec<ConsumerSignal> {
    if !consumer {
        return Vec::new();
    }
    controls()
        .enumerate()
        .flat_map(|(index, (control, _))| {
            let standard = config.encoder_mappings.iter().find(|mapping| {
                mapping.control_id == control_id(control) && mapping.layer == Layer::Standard
            });
            standard.into_iter().flat_map(move |mapping| {
                [0, 1].into_iter().filter_map(move |layer| {
                    let logical = if layer == 0 {
                        Layer::Standard
                    } else {
                        Layer::Hypershift
                    };
                    remapped(config, index, control, logical).then(|| ConsumerSignal {
                        usage: usage(index, layer),
                        encoded_key: mapping.encoded_key.clone(),
                        hypershift: layer == 1,
                    })
                })
            })
        })
        .collect()
}

pub fn parallel_v2(config: &AppConfig) -> bool {
    configured(config)
        && config
            .devices
            .iter()
            .any(|device| device.id == RAZER_NAGA_DEVICE_ID)
}

pub fn v2_overlay(config: &AppConfig) -> (Vec<ConsumerSignal>, Vec<(u8, u8, OnboardAction)>) {
    let model = &NAGA_V2_HYPERSPEED;
    let trigger = config.settings.hypershift_trigger.trim();
    let mut signals = Vec::new();
    let mut targets = Vec::new();
    for (index, (control, button)) in model
        .key_buttons
        .iter()
        .copied()
        .chain(
            model
                .native_buttons
                .iter()
                .map(|&(id, button, _)| (id, button)),
        )
        .enumerate()
    {
        for (layer, logical) in [(0, Layer::Standard), (1, Layer::Hypershift)] {
            if control == trigger {
                targets.push((button, layer, OnboardAction::Hypershift));
                continue;
            }
            if layer == 1 && control == "mouse_left" && trigger == "mouse_right" {
                targets.push((button, layer, OnboardAction::Mouse(2)));
                continue;
            }
            let standard = config.encoder_mappings.iter().find(|mapping| {
                mapping.control_id.as_str() == control && mapping.layer == Layer::Standard
            });
            let mapping = if layer == 0 {
                standard
            } else {
                standard.or_else(|| {
                    config.encoder_mappings.iter().find(|mapping| {
                        mapping.control_id.as_str() == control && mapping.layer == logical
                    })
                })
            };
            let Some(mapping) = mapping else { continue };
            if index >= model.key_buttons.len()
                && !config.bindings.iter().any(|binding| {
                    binding.enabled
                        && binding.control_id == mapping.control_id
                        && (binding.layer == logical || layer == 1 && standard.is_some())
                        && config.actions.iter().any(|action| {
                            action.id == binding.action_id
                                && action.action_type != crate::config::ActionType::Disabled
                        })
                })
            {
                continue;
            }
            let usage = usage(index, layer);
            signals.push(ConsumerSignal {
                usage,
                encoded_key: mapping.encoded_key.clone(),
                hypershift: layer == 1,
            });
            targets.push((button, layer, OnboardAction::Consumer(usage)));
        }
    }
    (signals, targets)
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
    path: String,
    records: Vec<Record>,
}

pub(crate) fn targets(config: &AppConfig, consumer: bool) -> Result<Vec<(u8, u8, OnboardAction)>, String> {
    let mut targets = Vec::new();
    for (index, (control, button)) in controls().enumerate() {
        for (layer, logical) in [(0, Layer::Standard), (1, Layer::Hypershift)] {
            if !remapped(config, index, control, logical) {
                continue;
            }
            let mapping_layer = if consumer { Layer::Standard } else { logical };
            let Some(mapping) = config.encoder_mappings.iter().find(|mapping| {
                mapping.control_id == control_id(control) && mapping.layer == mapping_layer
            }) else {
                continue;
            };
            let action = if consumer {
                OnboardAction::Consumer(usage(index, layer))
            } else {
                let key = crate::hotkeys::parse_hotkey(&mapping.encoded_key)?;
                let usage = super::usage_for_key(&key.key.display_name)
                    .ok_or_else(|| format!("Fallback for {control} requires F13–F24"))?;
                let modifiers = key.modifiers;
                OnboardAction::Key {
                    modifier: super::left_modifier_bits(
                        modifiers.ctrl,
                        modifiers.shift,
                        modifiers.alt,
                        modifiers.win,
                    ),
                    usage,
                }
            };
            targets.push((button, layer, action));
        }
    }
    if !targets.is_empty() {
        targets.extend([0, 1].map(|layer| (RING, layer, OnboardAction::Hypershift)));
    }
    Ok(targets)
}

fn block(action: OnboardAction) -> [u8; 7] {
    let bytes = action.bytes();
    let mut block = [0; 7];
    block[..bytes.len()].copy_from_slice(&bytes);
    block
}

fn read(device: &VendorDevice, button: u8, layer: u8) -> Result<[u8; 7], String> {
    read_bank(device, LIVE_BANK, button, layer)
}

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
        return Err(format!(
            "Readback returned the wrong address for bank {bank}, button {button:#04x}/{layer}"
        ));
    }
    Ok(reply[11..18].try_into().expect("fixed-size function block"))
}

fn confirmed_drift(
    expected: [u8; 7],
    mut read_record: impl FnMut() -> Result<[u8; 7], String>,
) -> Result<bool, String> {
    // A firmware transition can return plausible but incorrect bytes once.
    Ok(read_record()? != expected && read_record()? != expected)
}

fn write(device: &VendorDevice, button: u8, layer: u8, block: [u8; 7]) -> Result<(), String> {
    write_bank(device, LIVE_BANK, button, layer, block)
}

fn write_bank(device: &VendorDevice, bank: u8, button: u8, layer: u8, block: [u8; 7]) -> Result<(), String> {
    let mut args = [0; 10];
    args[0] = bank;
    args[1] = button;
    args[2] = layer;
    args[3..].copy_from_slice(&block);
    device.command(super::CLASS_BUTTON, super::CMD_SET_BUTTON, &args)?;
    if read_bank(device, bank, button, layer)? != block {
        return Err(format!(
            "Write did not read back for bank {bank}, button {button:#04x}/{layer}"
        ));
    }
    Ok(())
}

fn restore(device: &VendorDevice, backup: &Path) -> Result<(), String> {
    restore_bank(device, LIVE_BANK, backup)
}

fn load_snapshot(device: &VendorDevice, backup: &Path) -> Result<Option<Snapshot>, String> {
    let bytes = match std::fs::read(backup) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if snapshot.path != device.path {
        return Err("Backup belongs to another receiver".into());
    }
    for record in &snapshot.records {
        let model = device.model();
        let known = if std::ptr::eq(model, &NAGA_V3_PRO) {
            record.button == RING || controls().any(|(_, button)| button == record.button)
        } else {
            model
                .key_buttons
                .iter()
                .any(|&(_, button)| button == record.button)
                || model
                    .native_buttons
                    .iter()
                    .any(|&(_, button, _)| button == record.button)
        };
        if !known || record.layer > 1 {
            return Err("Invalid recovery address".into());
        }
    }
    Ok(Some(snapshot))
}

fn restore_bank(device: &VendorDevice, bank: u8, backup: &Path) -> Result<(), String> {
    let Some(snapshot) = load_snapshot(device, backup)? else { return Ok(()) };
    let mut failure = None;
    for record in snapshot.records.iter().rev() {
        if record.before != record.target {
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
    }
    if let Some(error) = failure {
        return Err(error);
    }
    std::fs::remove_file(backup).map_err(|error| error.to_string())?;
    log::info!(
        "[naga-live] {} restored previous assignments in bank {bank}", device.model().name
    );
    Ok(())
}

fn save_snapshot(backup: &Path, snapshot: &Snapshot) -> Result<(), String> {
    crate::config::persist_atomically(backup, |file| {
        serde_json::to_writer(file, snapshot).map_err(std::io::Error::other)
    })
    .map_err(|error| error.to_string())
}

fn verify(device: &VendorDevice, records: &[Record]) -> Result<(), String> {
    verify_bank(device, LIVE_BANK, records)
}

fn verify_bank(device: &VendorDevice, bank: u8, records: &[Record]) -> Result<(), String> {
    for record in records {
        if read_bank(device, bank, record.button, record.layer)? != record.target {
            return Err(format!(
                "Bank {bank} assignments changed after programming {:#04x}/{}",
                record.button, record.layer
            ));
        }
    }
    Ok(())
}

fn plan_repair(
    records: &mut [Record],
    mut read_record: impl FnMut(u8, u8) -> Result<[u8; 7], String>,
) -> Result<Vec<usize>, String> {
    let mut pending = Vec::new();
    for (index, record) in records.iter_mut().enumerate() {
        let current = read_record(record.button, record.layer)?;
        if current != record.target {
            record.before = current;
            pending.push(index);
        }
    }
    Ok(pending)
}

fn repair(device: &VendorDevice, backup: &Path, snapshot: &mut Snapshot) -> Result<(), String> {
    let started = std::time::Instant::now();
    if snapshot.path != device.path {
        return Err("Live backup belongs to another receiver".into());
    }
    if device.mode()? != MODE_NORMAL {
        return Err("Mouse is not in firmware mode".into());
    }

    let mut updated = snapshot.clone();
    let pending = plan_repair(&mut updated.records, |button, layer| read(device, button, layer))?;
    // Save any newly observed original values before taking ownership of them.
    if updated.records != snapshot.records {
        save_snapshot(backup, &updated)?;
        *snapshot = updated;
    }
    if !pending.is_empty() {
        for &index in &pending {
            let record = &snapshot.records[index];
            write(device, record.button, record.layer, record.target)?;
        }
        verify(device, &snapshot.records)?;
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

fn apply(
    device: &VendorDevice,
    backup: &Path,
    targets: &[(u8, u8, OnboardAction)],
) -> Result<Snapshot, String> {
    let snapshot = apply_bank(device, LIVE_BANK, backup, targets)?;
    log::info!("[naga-live] {} verified {} live assignments", device.model().name, snapshot.records.len());
    Ok(snapshot)
}

fn apply_bank(
    device: &VendorDevice,
    bank: u8,
    backup: &Path,
    targets: &[(u8, u8, OnboardAction)],
) -> Result<Snapshot, String> {
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
    let snapshot = Snapshot {
        path: device.path.clone(),
        records,
    };
    if snapshot.records.is_empty() {
        return Ok(snapshot);
    }
    save_snapshot(backup, &snapshot)?;
    let result: Result<(), String> = snapshot.records.iter().try_for_each(|record| {
        if record.before != record.target {
            write_bank(device, bank, record.button, record.layer, record.target)?;
        }
        Ok(())
    });
    let result = result.and_then(|()| verify_bank(device, bank, &snapshot.records));
    if result.is_err() {
        restore_bank(device, bank, backup)?;
    }
    result?;
    Ok(snapshot)
}

pub struct Session {
    stop: Option<mpsc::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
    v2: bool,
    targets: Arc<[(u8, u8, OnboardAction)]>,
}

impl Session {
    pub fn matches(&self, targets: &[(u8, u8, OnboardAction)]) -> bool {
        self.targets.as_ref() == targets
    }

    pub fn start_v3(config_dir: PathBuf, targets: Vec<(u8, u8, OnboardAction)>) -> Option<Self> {
        Self::start_worker(config_dir, &NAGA_V3_PRO, BACKUP, targets, None)
    }

    pub fn start_v2(
        config_dir: PathBuf,
        config: &AppConfig,
        targets: Vec<(u8, u8, OnboardAction)>,
    ) -> Option<Self> {
        Self::start_worker(
            config_dir,
            &NAGA_V2_HYPERSPEED,
            V2_BACKUP,
            targets,
            Some(config.clone()),
        )
    }

    fn start_worker(
        config_dir: PathBuf,
        model: &'static NativeModel,
        backup: &str,
        targets: Vec<(u8, u8, OnboardAction)>,
        offline: Option<AppConfig>,
    ) -> Option<Self> {
        if targets.is_empty() {
            return None;
        }
        let targets = Arc::from(targets);
        let worker_targets = Arc::clone(&targets);
        let backup = config_dir.join(backup);
        let v2 = offline.is_some();
        if v2 {
            V2_LIVE.store(true, Ordering::Release);
        }
        let (stop, stopped) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("naga-live".into())
            .spawn(move || {
                let mut last_error = None;
                let open = || VendorDevice::open(model, model.pids[0]);
                let attempt = |active: &mut Option<Snapshot>| {
                    if let Some(snapshot) = active {
                        return repair(&open()?, &backup, snapshot);
                    }
                    if let Some(config) = &offline
                        && config_dir
                            .join(crate::mouse_offline::OFFLINE_MARKER_FILE)
                            .exists()
                    {
                        restore(&open()?, &backup)?;
                        if !crate::mouse_offline::restore_after_offline(config, &config_dir) {
                            return Err("Offline assignments are still pending".into());
                        }
                    }
                    *active = Some(apply(&open()?, &backup, &worker_targets)?);
                    Ok(())
                };
                let ready = if v2 { &V2_READY } else { &V3_READY };
                let mut active = None;
                'session: loop {
                    loop {
                        match attempt(&mut active) {
                            Ok(()) => break,
                            Err(message)
                                if message != super::NO_INTERFACE
                                    && last_error.as_ref() != Some(&message) =>
                            {
                                log::warn!(
                                    "[naga-live] {} waiting to configure live assignments: {message}",
                                    model.name
                                );
                                last_error = Some(message);
                            }
                            Err(_) => {}
                        }
                        if stopped.recv_timeout(RETRY) != Err(mpsc::RecvTimeoutError::Timeout) {
                            break 'session;
                        }
                    }
                    last_error = None;
                    ready.store(true, Ordering::Release);

                    for &(button, layer, action) in worker_targets.iter().cycle() {
                        if stopped.recv_timeout(RETRY) != Err(mpsc::RecvTimeoutError::Timeout) {
                            break 'session;
                        }
                        let drift = open().and_then(|device| {
                            confirmed_drift(block(action), || read(&device, button, layer))
                        });
                        if drift == Ok(true) {
                            // Keep forwarding releases for inputs held before recovery.
                            log::warn!(
                                "[naga-live] {} live assignment {button:#04x}/{layer} changed; repairing",
                                model.name
                            );
                            break;
                        }
                    }
                }
                ready.store(false, Ordering::Release);
                if active.is_some() && let Err(error) = open().and_then(|device| restore(&device, &backup)) {
                    log::warn!(
                        "[naga-live] {} recovery pending until next start: {error}",
                        model.name
                    );
                }
            })
            .inspect_err(|error| {
                if v2 {
                    V2_LIVE.store(false, Ordering::Release);
                }
                log::warn!("[naga-live] {} could not start worker: {error}", model.name);
            })
            .ok()?;
        Some(Self {
            stop: Some(stop),
            worker: Some(worker),
            v2,
            targets,
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if self.v2 {
            V2_LIVE.store(false, Ordering::Release);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn v3_offline_profile_exports_paste_backspace_and_its_own_hypershift() {
        let mut config = crate::config::default_seed_config();
        prepare(&mut config, true, true);
        let targets = offline_targets(&config, "main");
        let backspace = OnboardAction::Key { modifier: 0, usage: 0x2a };
        let paste = OnboardAction::Key { modifier: 1, usage: 0x19 };
        assert!(targets.contains(&(0x41, 0, backspace)));
        assert!(targets.contains(&(0x4b, 0, paste)));
        assert!(targets.contains(&(RING, 0, OnboardAction::Hypershift)));
        assert!(!targets.iter().any(|&(button, _, _)| button == 0x0e));
        assert_eq!(bank_block(1, backspace), [2, 1, 0, 0x2a, 0, 0, 0]);
        assert_eq!(bank_block(1, paste), [2, 2, 1, 0x19, 0, 0, 0]);
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
    fn live_repair_skips_correct_layers_and_preserves_their_original_values() {
        let original = block(OnboardAction::Key { modifier: 0, usage: 0x1e });
        let changed = block(OnboardAction::Key { modifier: 0, usage: 0x1f });
        let standard = block(OnboardAction::Consumer(0x10));
        let hypershift = block(OnboardAction::Consumer(0x11));
        let mut records = [
            Record { button: 0x40, layer: 0, before: original, target: standard },
            Record { button: 0x40, layer: 1, before: original, target: hypershift },
        ];

        let pending = plan_repair(&mut records, |_, layer| {
            Ok(if layer == 0 { standard } else { changed })
        });
        assert_eq!(pending, Ok(vec![1]));
        assert_eq!(records[0].before, original);
        assert_eq!(records[1].before, changed);
        assert_eq!(records[1].target, hypershift);

        let retried = plan_repair(&mut records, |_, layer| {
            Ok(if layer == 0 { standard } else { hypershift })
        });
        assert_eq!(retried, Ok(vec![]));
        assert_eq!(records[1].before, changed);
    }

    pub(crate) fn config_with_v3() -> AppConfig {
        let mut config = crate::config::default_seed_config();
        prepare(&mut config, true, false);
        config
    }

    #[test]
    fn new_v3_has_no_bindings_and_preserves_v2() {
        let mut config = crate::config::default_seed_config();
        let original = config.clone();
        prepare(&mut config, true, false);
        assert!(configured(&config));
        assert_eq!(config.profiles, original.profiles);
        assert_eq!(config.bindings, original.bindings);
        assert_eq!(config.actions, original.actions);
        let folder = tempfile::tempdir().unwrap();
        crate::config::save_config(folder.path(), config.clone(), None).unwrap();
        assert_eq!(
            &config.physical_controls[..original.physical_controls.len()],
            original.physical_controls
        );
        assert!(
            config
                .physical_controls
                .iter()
                .any(|control| control.device_id == DEVICE_ID
                    && control.id == control_id("hypershift_button"))
        );
        let count = config.encoder_mappings.len();
        prepare(&mut config, true, true);
        assert_eq!(config.encoder_mappings.len(), count);
        assert_eq!(config.bindings, original.bindings);
    }

    #[test]
    fn explicit_v3_migration_clones_existing_actions() {
        let mut config = crate::config::default_seed_config();
        let original = config.clone();
        prepare(&mut config, true, true);
        assert!(config.bindings.starts_with(&original.bindings));
        let source = original
            .bindings
            .iter()
            .find(|binding| binding.control_id.as_str() == "thumb_01")
            .unwrap();
        let copy = config
            .bindings
            .iter()
            .find(|binding| {
                binding.control_id == control_id("thumb_01")
                    && binding.layer == source.layer
                    && binding.profile_id == source.profile_id
            })
            .unwrap();
        assert_ne!(copy.action_id, source.action_id);
        assert_eq!(copy.label, source.label);
        let source = config
            .actions
            .iter()
            .find(|action| action.id == source.action_id)
            .unwrap();
        let copy = config
            .actions
            .iter()
            .find(|action| action.id == copy.action_id)
            .unwrap();
        assert_eq!(copy.payload, source.payload);
        let folder = tempfile::tempdir().unwrap();
        crate::config::save_config(folder.path(), config, None).unwrap();
    }

    #[test]
    fn simultaneous_v2_overlay_keeps_left_click_and_uses_its_own_trigger_and_aliases() {
        let mut config = crate::config::default_seed_config();
        prepare(&mut config, true, false);
        let (v2, targets) = v2_overlay(&config);
        let v3 = signals(&config, true);
        assert!(targets.contains(&(0x02, 0, OnboardAction::Hypershift)));
        assert!(targets.contains(&(0x01, 1, OnboardAction::Mouse(2))));
        assert!(
            !targets
                .iter()
                .any(|&(button, layer, _)| button == 0x01 && layer == 0)
        );
        assert_eq!(
            v2.iter()
                .filter(|signal| signal.encoded_key == "F13")
                .count(),
            2
        );
        assert!(
            !v2.iter()
                .any(|v2| v3.iter().any(|v3| v2.encoded_key == v3.encoded_key))
        );
    }

    #[test]
    fn editing_an_action_keeps_both_maps_but_moving_v2_hypershift_changes_only_v2() {
        let mut config = config_with_v3();
        let v2 = v2_overlay(&config).1;
        let v3 = targets(&config, true).unwrap();
        config.actions[0].display_name = "Renamed shortcut".into();
        assert_eq!(v2_overlay(&config).1, v2);
        assert_eq!(targets(&config, true).unwrap(), v3);
        config.settings.hypershift_trigger = "mouse_4".into();
        assert_ne!(v2_overlay(&config).1, v2);
        assert_eq!(targets(&config, true).unwrap(), v3);
    }

    #[test]
    fn all_thumb_layers_have_distinct_hid_usages_and_keyboard_fallback() {
        let config = config_with_v3();
        let encoded = signals(&config, true);
        let hid = targets(&config, true).unwrap();
        let keys = targets(&config, false).unwrap();
        assert!(signals(&config, false).is_empty());
        let mut seen = std::collections::HashSet::new();
        for index in 0..12 {
            for layer in 0..2 {
                let signal = &encoded[2 * index + layer];
                let button = 0x40 + index as u8;
                assert!(seen.insert(signal.usage));
                assert_eq!(signal.hypershift, layer == 1);
                assert!(hid.contains(&(
                    button,
                    layer as u8,
                    OnboardAction::Consumer(signal.usage)
                )));
                assert!(keys.iter().any(|&(id, slot, action)| {
                    id == button
                        && usize::from(slot) == layer
                        && matches!(action, OnboardAction::Key { .. })
                }));
            }
        }
    }
}
