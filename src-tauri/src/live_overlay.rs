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
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};

use super::{ConsumerSignal, MODE_NORMAL, OnboardAction, VendorDevice};
use crate::{
    config::{ActionType, AppConfig, CapabilityStatus, ControlId, Device, EncoderMapping, Layer, MappingSource, Profile},
    device_catalog::{CATALOG, CATALOG_LEN, NativeModel, Transport},
};

/// Reserved Consumer Page usages within the one-byte range the devices emit,
/// one per control index and layer (`2 * index + layer`).
pub(crate) const USAGES: [u16; 44] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x37, 0x38, 0x39,
    0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e,
];
const RETRY: Duration = Duration::from_secs(2);
/// A session told to stop before it took the mouse.
const STOPPING: &str = "stopping";
/// Bank argument of the live map; stored banks are `1..=MAX_BANKS`.
const LIVE_BANK: u8 = 0;

// Onboard bank commands (class `0x05`), measured on the V3 Pro receiver.
const CLASS_BANKS: u8 = 0x05;
const CMD_BANK_COUNT: u8 = 0x80;
const CMD_BANK_INVENTORY: u8 = 0x81;
const CMD_ACTIVE_BANK: u8 = 0x84;
const CMD_SELECT_BANK: u8 = 0x04;
const CMD_CREATE_BANK: u8 = 0x02;
const CMD_DELETE_BANK: u8 = 0x03;
pub const MAX_BANKS: u8 = 5;

static ACTIVE: [AtomicBool; CATALOG_LEN] = [const { AtomicBool::new(false) }; CATALOG_LEN];
static READY: [AtomicBool; CATALOG_LEN] = [const { AtomicBool::new(false) }; CATALOG_LEN];
/// Sidearm's own bank claimed by an active bank session (0 when no bank session owns the mouse).
static SIDEARM_BANK: [AtomicU8; CATALOG_LEN] = [const { AtomicU8::new(0) }; CATALOG_LEN];
/// The live bank Sidearm currently expects the mouse to play (`SIDEARM_BANK` or a profile's
/// hybrid hardware bank; 0 when no bank session owns the mouse).
static ACTIVE_LIVE_BANK: [AtomicU8; CATALOG_LEN] = [const { AtomicU8::new(0) }; CATALOG_LEN];
/// Bitmask (`1 << bank`, `bank in 1..=MAX_BANKS`) of hybrid banks verified stored for the
/// current config. A hybrid bank is never selected live until its bit is set here.
static VERIFIED_HYBRID_BANKS: [AtomicU8; CATALOG_LEN] = [const { AtomicU8::new(0) }; CATALOG_LEN];
/// True while the UI's input-capture / button-test mode is active: bank mice stay on
/// `SIDEARM_BANK` so native flash keys (like Delete) cannot fire during button testing.
static INPUT_TEST_MODE: AtomicBool = AtomicBool::new(false);
/// Monotonic revision for authoritative profile switches (tray, ProfileSwitch, foreground).
static PROFILE_REVISION: AtomicU64 = AtomicU64::new(0);
/// Latest desired live profile and config snapshot, replayed on readiness, wake, return
/// online, and background bank-store completion.
#[derive(Clone)]
struct DesiredProfile {
    revision: u64,
    profile: Option<Profile>,
    config: AppConfig,
}
static DESIRED_PROFILE: Mutex<Option<DesiredProfile>> = Mutex::new(None);
/// Active config directory for updating the Sidearm-bank recovery marker before switching
/// into a hybrid bank.
static SESSION_CONFIG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Sidearm's bank of each mouse its profile button took off it (offline
/// mode), else 0.
static OFFLINE: [AtomicU8; CATALOG_LEN] = [const { AtomicU8::new(0) }; CATALOG_LEN];

/// Allocates a strictly increasing profile-switch revision so out-of-order async
/// handlers (tray clicks) cannot overwrite a newer selection.
pub fn next_profile_revision() -> u64 {
    PROFILE_REVISION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Whether `model` is currently in manual offline mode (user pressed the mouse's
/// profile button to leave Sidearm's bank).
pub fn is_offline(model: &NativeModel) -> bool {
    OFFLINE[model.catalog_index()].load(Ordering::Acquire) != 0
}

/// Whether `model` is currently owned by a Sidearm bank session (used by `mouse_speed`
/// so bank-managed mice apply bank selection BEFORE live DPI under one device lock).
pub fn is_bank_managed(model: &NativeModel) -> bool {
    let index = model.catalog_index();
    SIDEARM_BANK[index].load(Ordering::Acquire) != 0 && !RELEASED[index].load(Ordering::Acquire)
}

/// The mice in offline mode: the profile button left Sidearm's bank.
pub fn offline_models() -> Vec<&'static NativeModel> {
    CATALOG.iter().copied().filter(|model| OFFLINE[model.catalog_index()].load(Ordering::Acquire) != 0).collect()
}

/// Puts every mouse in offline mode back on Sidearm's bank (its session sees
/// it play and is online again), then immediately reconciles the desired profile.
pub fn back_to_sidearm_bank() -> Result<(), String> {
    for model in offline_models() {
        let index = model.catalog_index();
        let bank = OFFLINE[index].load(Ordering::Acquire);
        let device = VendorDevice::open_model(model)?;
        // Holding the device: a session that stopped meanwhile cleared OFFLINE
        // first, and its mouse must not be put back on a bank nobody watches.
        if OFFLINE[index].load(Ordering::Acquire) != bank {
            continue;
        }
        select_bank(&device, bank)?;
        ACTIVE_LIVE_BANK[index].store(bank, Ordering::Release);
        set_offline(model, 0);
        log::info!("[naga-live] {} put back on the Sidearm bank {bank}", model.name);
        if let Err(error) = reconcile_on_device(&device, None, None) {
            log::warn!("[naga-live] {} desired profile not reconciled after returning online: {error}", model.name);
        }
    }
    Ok(())
}

/// Target live bank for `profile` on `model`: the profile's own verified hybrid slot
/// when `hardware_bank` is active and verified for the current config, else `sidearm`.
fn desired_live_bank(profile: Option<&Profile>, config: &AppConfig, model: &NativeModel, banks: &Banks, sidearm: u8) -> u8 {
    if INPUT_TEST_MODE.load(Ordering::Acquire) {
        return sidearm;
    }
    let Some(profile) = profile else { return sidearm };
    if !profile.enabled {
        return sidearm;
    }
    let user = Banks {
        assigned: banks.assigned.iter().copied().filter(|&bank| bank != sidearm).collect(),
        active: banks.active,
    };
    let offline = crate::mouse_offline::offline_profile_id(config, None);
    let plan = bank_plan(config, model, &user, &offline);
    let verified = VERIFIED_HYBRID_BANKS[model.catalog_index()].load(Ordering::Acquire);
    if let Some(entry) = plan.iter().find(|entry| entry.profile_id == profile.id && entry.hybrid) {
        if (verified & (1u8 << entry.bank)) != 0 {
            return entry.bank;
        }
        log::debug!(
            "[naga-live] {} profile `{}` hybrid bank {} is not yet verified stored; staying on Sidearm bank {sidearm}",
            model.name, profile.name, entry.bank,
        );
    }
    sidearm
}

/// Reconciles `device` (holding its `VendorDevice` lock) to the latest `DESIRED_PROFILE`:
/// selects the verified hybrid bank (or `SIDEARM_BANK`), then applies live DPI/poll rate
/// on the same device lock so `select_bank` never clobbers live DPI.
/// Treats any unexpected active hardware bank as a manual profile-button press rather
/// than overwriting the user's choice.
fn reconcile_on_device(
    device: &VendorDevice,
    config_dir: Option<&Path>,
    expected_revision: Option<u64>,
) -> Result<bool, String> {
    if crate::is_shutting_down() {
        return Ok(false);
    }
    let model = device.model();
    let index = model.catalog_index();
    let sidearm = SIDEARM_BANK[index].load(Ordering::Acquire);
    if sidearm == 0 || OFFLINE[index].load(Ordering::Acquire) != 0 || RELEASED[index].load(Ordering::Acquire) {
        return Ok(false);
    }
    let banks = read_banks(device)?;
    let expected = ACTIVE_LIVE_BANK[index].load(Ordering::Acquire);
    if expected != 0 && banks.active != expected {
        log::warn!(
            "[naga-live] {} plays bank {} (profile button): offline until the Sidearm bank {sidearm} plays again",
            model.name, banks.active,
        );
        set_offline(model, sidearm);
        return Ok(false);
    }
    let snapshot = DESIRED_PROFILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    if let Some(req_rev) = expected_revision
        && snapshot.as_ref().is_some_and(|desired| desired.revision != req_rev)
    {
        return Ok(false);
    }
    let mut effective_profile = snapshot.as_ref().and_then(|d| d.profile.clone());
    let mut target = match &snapshot {
        Some(desired) => desired_live_bank(desired.profile.as_ref(), &desired.config, model, &banks, sidearm),
        None => sidearm,
    };
    let mut switched = false;
    if banks.active != target {
        wait_released(model);
        if crate::is_shutting_down()
            || SIDEARM_BANK[index].load(Ordering::Acquire) != sidearm
            || OFFLINE[index].load(Ordering::Acquire) != 0
            || RELEASED[index].load(Ordering::Acquire)
        {
            return Ok(false);
        }
        let banks_now = read_banks(device)?;
        if expected != 0 && banks_now.active != expected {
            log::warn!(
                "[naga-live] {} plays bank {} (profile button): offline until the Sidearm bank {sidearm} plays again",
                model.name, banks_now.active,
            );
            set_offline(model, sidearm);
            return Ok(false);
        }
        // Re-read the latest desired profile after waiting for held buttons so a
        // newer switch arriving meanwhile wins instead of being overwritten.
        let latest = DESIRED_PROFILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        effective_profile = latest.as_ref().and_then(|d| d.profile.clone());
        target = match &latest {
            Some(desired) => desired_live_bank(desired.profile.as_ref(), &desired.config, model, &banks_now, sidearm),
            None => sidearm,
        };
        if banks_now.active != target {
            if target != sidearm {
                let marker_dir = config_dir.map(Path::to_path_buf).or_else(|| {
                    SESSION_CONFIG_DIR.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
                });
                if let Some(dir) = marker_dir {
                    record_managed_hybrid_bank(&dir, model, sidearm, target);
                }
            }
            select_bank(device, target)?;
            ACTIVE_LIVE_BANK[index].store(target, Ordering::Release);
            switched = true;
            if let Some(profile) = &effective_profile {
                log::info!("[naga-live] {} profile `{}` switched to live bank {target}", model.name, profile.name);
            } else {
                log::info!("[naga-live] {} switched to live bank {target}", model.name);
            }
        }
    }
    if !INPUT_TEST_MODE.load(Ordering::Acquire)
        && let Some(profile) = &effective_profile
    {
        crate::mouse_speed::apply_profile_to_device(device, profile);
    }
    Ok(switched)
}

fn spawn_reconcile_for_bank_mice(expected_revision: Option<u64>) {
    let pending: Vec<&'static NativeModel> = CATALOG
        .iter()
        .copied()
        .filter(|model| {
            if !model.live.as_ref().is_some_and(|live| live.banks) {
                return false;
            }
            let index = model.catalog_index();
            SIDEARM_BANK[index].load(Ordering::Acquire) != 0
                && OFFLINE[index].load(Ordering::Acquire) == 0
                && !RELEASED[index].load(Ordering::Acquire)
        })
        .collect();
    if pending.is_empty() {
        return;
    }
    let _ = thread::Builder::new().name("profile-bank".into()).spawn(move || {
        for model in pending {
            if crate::is_shutting_down() {
                return;
            }
            let device = match VendorDevice::open_model(model) {
                Ok(device) => device,
                Err(error) => {
                    log::warn!("[naga-live] {} profile bank reconcile skipped: {error}", model.name);
                    continue;
                }
            };
            if let Err(error) = reconcile_on_device(&device, None, expected_revision) {
                log::warn!("[naga-live] {} profile bank reconcile failed: {error}", model.name);
            }
        }
    });
}

/// Records the authoritative desired profile (or `None` when no enabled profile
/// resolves) and reconciles any active bank-managed mouse asynchronously.
pub fn set_desired_profile(profile: Option<&Profile>, config: &AppConfig, revision: Option<u64>) {
    let rev = {
        let mut guard = DESIRED_PROFILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let rev = match revision {
            Some(r) => {
                if guard.as_ref().is_some_and(|current| current.revision > r) {
                    return;
                }
                r
            }
            None => next_profile_revision(),
        };
        *guard = Some(DesiredProfile {
            revision: rev,
            profile: profile.cloned(),
            config: config.clone(),
        });
        rev
    };
    spawn_reconcile_for_bank_mice(Some(rev));
}

/// Enters or leaves UI input-capture / button-test mode. Entering synchronously
/// returns every bank-managed mouse to `SIDEARM_BANK` before acknowledging the
/// command so native flash keys (like Delete) cannot fire while testing buttons.
pub fn set_input_test_mode(enabled: bool) -> Result<(), String> {
    INPUT_TEST_MODE.store(enabled, Ordering::Release);
    if enabled {
        for model in CATALOG.iter().copied().filter(|m| is_bank_managed(m)) {
            let index = model.catalog_index();
            if OFFLINE[index].load(Ordering::Acquire) != 0 {
                continue;
            }
            let sidearm = SIDEARM_BANK[index].load(Ordering::Acquire);
            if ACTIVE_LIVE_BANK[index].load(Ordering::Acquire) == sidearm {
                continue;
            }
            let device = VendorDevice::open_model(model)?;
            reconcile_on_device(&device, None, None)?;
        }
    } else {
        spawn_reconcile_for_bank_mice(None);
    }
    Ok(())
}

/// Invalidates cached bank verification after a config save, returns any mouse
/// playing a now-unverified hybrid bank back to `SIDEARM_BANK`, and schedules a
/// background bank store for the new config.
pub fn invalidate_and_schedule_bank_store(config: AppConfig, config_dir: PathBuf) {
    let mut needs_return_to_sidearm = false;
    for model in CATALOG.iter().copied().filter(|m| m.live.as_ref().is_some_and(|live| live.banks)) {
        let index = model.catalog_index();
        VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
        STORED[index].store(0, Ordering::Release);
        let sidearm = SIDEARM_BANK[index].load(Ordering::Acquire);
        let active = ACTIVE_LIVE_BANK[index].load(Ordering::Acquire);
        if sidearm != 0 && active != 0 && active != sidearm {
            needs_return_to_sidearm = true;
        }
    }
    {
        let mut guard = DESIRED_PROFILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(desired) = guard.as_mut() {
            desired.profile = desired
                .profile
                .as_ref()
                .and_then(|p| config.profiles.iter().find(|c| c.id == p.id && c.enabled).cloned());
            desired.config = config.clone();
            desired.revision = next_profile_revision();
        }
    }
    if needs_return_to_sidearm {
        spawn_reconcile_for_bank_mice(None);
    }
    schedule_bank_store(config, config_dir);
}

/// Mice whose Sidearm bank the user gave back this run: no session claims one
/// again until the next start.
static RELEASED: [AtomicBool; CATALOG_LEN] = [const { AtomicBool::new(false) }; CATALOG_LEN];

/// No session of `model` claims Sidearm's bank again in this run (the start
/// after the next capture restart writes the live map).
pub fn keep_off_sidearm_bank(model: &NativeModel) {
    RELEASED[model.catalog_index()].store(true, Ordering::Release);
}

/// Sidearm's bank of the connected mouse of `model`, if it has one.
pub fn sidearm_bank_of(model: &'static NativeModel) -> Result<Option<u8>, String> {
    Ok(user_banks(&VendorDevice::open_model(model)?)?.1)
}

/// Result of relocating Sidearm's service bank to another slot (`1..=MAX_BANKS`).
/// When `target` was occupied by a user profile, `displaced_from` / `displaced_to`
/// tell the caller which slot number received that displaced user bank.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSidearmBankResult {
    pub banks: Banks,
    pub sidearm: u8,
    pub displaced_from: Option<u8>,
    pub displaced_to: Option<u8>,
}

/// Writes previously captured Sidearm bank records and DPI into `bank`.
fn write_saved_sidearm_bank(
    device: &VendorDevice,
    bank: u8,
    records: &[(u8, u8, [u8; 7])],
    dpi: Option<u16>,
) -> Result<(), String> {
    for &(button, layer, wanted) in records {
        if device.read_block(bank, button, layer)? != wanted {
            write_bank(device, bank, button, layer, wanted)?;
        }
    }
    if let Some(dpi) = dpi
        && let Err(error) = device.set_dpi_in(bank, dpi)
    {
        log::warn!("[naga-live] {} moved Sidearm bank {bank} DPI not set: {error}", device.model().name);
    }
    Ok(())
}

/// Relocates Sidearm's service bank to `target` (`1..=MAX_BANKS`) immediately,
/// even when `target` currently holds a user profile: a free slot receives the
/// displaced user bank (or the vacated old Sidearm slot when all 5 slots are full).
pub fn move_sidearm_bank(model: &'static NativeModel, target: u8, config_dir: &Path) -> Result<MoveSidearmBankResult, String> {
    if !model.live.as_ref().is_some_and(|live| live.banks) {
        return Err(format!("{} has no onboard banks", model.name));
    }
    if !(1..=MAX_BANKS).contains(&target) {
        return Err(format!("Bank {target} is out of range (1..={MAX_BANKS})"));
    }
    let device = VendorDevice::open_model(model)?;
    let (banks, sidearm) = user_banks(&device)?;
    let Some(old) = sidearm else {
        return Err("No Sidearm service slot found on the mouse".into());
    };
    if old == target {
        return Ok(MoveSidearmBankResult {
            banks,
            sidearm: old,
            displaced_from: None,
            displaced_to: None,
        });
    }
    let addresses = bank_addresses(model);
    let mut saved_records = Vec::with_capacity(addresses.len());
    for (button, layer) in addresses {
        saved_records.push((button, layer, device.read_block(old, button, layer)?));
    }
    let saved_dpi = device.dpi_in(old).ok();
    let was_active = active_bank(&device)? == old;
    let marker = read_sidearm_bank_marker(config_dir, model);
    let safe_base = marker
        .base
        .filter(|b| *b != target && banks.assigned.contains(b))
        .or_else(|| banks.assigned.iter().copied().find(|&b| b != target))
        .unwrap_or(1);

    let (displaced_from, displaced_to) = if !banks.assigned.contains(&target) {
        create_bank(&device, target)?;
        if let Err(error) = write_saved_sidearm_bank(&device, target, &saved_records, saved_dpi) {
            let _ = delete_bank(&device, target);
            return Err(error);
        }
        if was_active {
            write_sidearm_bank_marker(config_dir, model, target, safe_base, &marker.hybrids);
            if let Err(error) = select_bank(&device, target) {
                write_sidearm_bank_marker(config_dir, model, old, safe_base, &marker.hybrids);
                let _ = delete_bank(&device, target);
                return Err(error);
            }
        }
        if let Err(error) = delete_bank(&device, old) {
            if was_active {
                let _ = select_bank(&device, old);
                write_sidearm_bank_marker(config_dir, model, old, safe_base, &marker.hybrids);
            }
            let _ = delete_bank(&device, target);
            return Err(error);
        }
        (None, None)
    } else if let Some(free) = (1..=MAX_BANKS).find(|slot| !banks.assigned.contains(slot) && *slot != old) {
        create_bank(&device, free)?;
        if active_bank(&device)? == target {
            select_bank(&device, free)?;
        }
        delete_bank(&device, target)?;
        let _ = std::fs::remove_file(bank_backup(config_dir, model, target));
        create_bank(&device, target)?;
        if let Err(error) = write_saved_sidearm_bank(&device, target, &saved_records, saved_dpi) {
            let _ = delete_bank(&device, target);
            return Err(error);
        }
        let next_base = if marker.base == Some(target) { free } else { safe_base };
        if was_active {
            write_sidearm_bank_marker(config_dir, model, target, next_base, &[]);
            select_bank(&device, target)?;
        }
        delete_bank(&device, old)?;
        (Some(target), Some(free))
    } else {
        // All 5 slots are taken: park safely on another user bank, recycle `old`
        // for the displaced profile, then write Sidearm into `target`.
        let parking = banks
            .assigned
            .iter()
            .copied()
            .find(|&b| b != target)
            .ok_or_else(|| "No spare user slot available".to_owned())?;
        let current = active_bank(&device)?;
        if current == old || current == target {
            select_bank(&device, parking)?;
        }
        delete_bank(&device, old)?;
        create_bank(&device, old)?;
        delete_bank(&device, target)?;
        let _ = std::fs::remove_file(bank_backup(config_dir, model, target));
        create_bank(&device, target)?;
        write_saved_sidearm_bank(&device, target, &saved_records, saved_dpi)?;
        let next_base = if marker.base == Some(target) { old } else { safe_base };
        if was_active {
            write_sidearm_bank_marker(config_dir, model, target, next_base, &[]);
            select_bank(&device, target)?;
        }
        (Some(target), Some(old))
    };

    let index = model.catalog_index();
    if SIDEARM_BANK[index].load(Ordering::Acquire) == old {
        SIDEARM_BANK[index].store(target, Ordering::Release);
    }
    if ACTIVE_LIVE_BANK[index].load(Ordering::Acquire) == old {
        ACTIVE_LIVE_BANK[index].store(target, Ordering::Release);
    }
    if OFFLINE[index].load(Ordering::Acquire) == old {
        OFFLINE[index].store(target, Ordering::Release);
    }
    STORED[index].store(0, Ordering::Release);
    VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
    if marker.sidearm == Some(old) && !was_active {
        let next_base = if marker.base == Some(target) {
            displaced_to.unwrap_or(safe_base)
        } else {
            safe_base
        };
        write_sidearm_bank_marker(config_dir, model, target, next_base, &[]);
    }
    log::info!(
        "[naga-live] {} moved Sidearm bank {old} -> {target} (displaced: {:?} -> {:?})",
        model.name,
        displaced_from,
        displaced_to
    );
    Ok(MoveSidearmBankResult {
        banks: user_banks(&device)?.0,
        sidearm: target,
        displaced_from,
        displaced_to,
    })
}

/// Gives Sidearm's bank back: the mouse leaves it and the slot is unassigned.
/// Returns whether there was one.
pub fn release_sidearm_bank(model: &'static NativeModel, config_dir: &Path) -> Result<bool, String> {
    keep_off_sidearm_bank(model);
    let device = VendorDevice::open_model(model)?;
    let Some(bank) = user_banks(&device)?.1 else { return Ok(false) };
    leave_sidearm_bank(&device, None, config_dir)?;
    delete_bank(&device, bank)?;
    log::info!("[naga-live] {} gave the Sidearm bank {bank} back (slot free)", model.name);
    Ok(true)
}

/// Allocates a free onboard bank slot (`1..=MAX_BANKS`) on a bank model —
/// specifically `preferred` when supplied, or the lowest free slot otherwise —
/// and returns the updated user bank inventory (Sidearm's own bank excluded).
pub fn create_user_bank(model: &'static NativeModel, preferred: Option<u8>) -> Result<Banks, String> {
    if !model.live.as_ref().is_some_and(|live| live.banks) {
        return Err(format!("{} has no onboard banks", model.name));
    }
    let device = VendorDevice::open_model(model)?;
    let (banks, sidearm) = user_banks(&device)?;
    let free = match preferred {
        Some(slot) => {
            if !(1..=MAX_BANKS).contains(&slot) {
                return Err(format!("Bank {slot} is out of range (1..={MAX_BANKS})"));
            }
            if banks.assigned.contains(&slot) || sidearm == Some(slot) {
                return Err(format!("Bank {slot} is already in use"));
            }
            slot
        }
        None => {
            let Some(slot) = (1..=MAX_BANKS).find(|slot| !banks.assigned.contains(slot) && sidearm != Some(*slot)) else {
                return Err(format!("All {MAX_BANKS} onboard slots are already taken"));
            };
            slot
        }
    };
    create_bank(&device, free)?;
    STORED[model.catalog_index()].store(0, Ordering::Release);
    log::info!("[naga-live] {} created user onboard bank {free}", model.name);
    Ok(user_banks(&device)?.0)
}

/// Deletes an assigned user onboard bank (`1..=MAX_BANKS`), refusing to delete
/// Sidearm's own bank, the last remaining user bank, or the last clean offline
/// bank while another slot holds hybrid Sidearm signals. Switches off `bank`
/// first if it is currently playing, removes its stale backup, updates recovery
/// markers, and returns the updated user bank inventory.
pub fn delete_user_bank(model: &'static NativeModel, bank: u8, config_dir: &Path) -> Result<Banks, String> {
    if !model.live.as_ref().is_some_and(|live| live.banks) {
        return Err(format!("{} has no onboard banks", model.name));
    }
    if !(1..=MAX_BANKS).contains(&bank) {
        return Err(format!("Bank {bank} is out of range (1..={MAX_BANKS})"));
    }
    let device = VendorDevice::open_model(model)?;
    let (banks, sidearm) = user_banks(&device)?;
    if sidearm == Some(bank) {
        return Err(format!("Bank {bank} is Sidearm's own slot"));
    }
    if !banks.assigned.contains(&bank) {
        return Err(format!("Bank {bank} holds no profile on the mouse"));
    }
    if banks.assigned.len() <= 1 {
        return Err("Cannot remove the last user profile slot on the mouse".into());
    }
    // Single-clean-bank invariant: deleting `bank` must leave at least one clean
    // (non-hybrid) user bank in flash so exit/crash restoration always succeeds.
    let mut clean_remaining = None;
    for &candidate in &banks.assigned {
        if candidate == bank {
            continue;
        }
        if !bank_holds_sidearm_signal(&device, candidate)? {
            clean_remaining = Some(candidate);
            break;
        }
    }
    let Some(clean_fallback) = clean_remaining else {
        return Err("Cannot remove the last clean offline slot while other slots use Hardware bank".into());
    };
    let index = model.catalog_index();
    let sidearm_owned = SIDEARM_BANK[index].load(Ordering::Acquire);
    let staying_online = sidearm_owned != 0
        && sidearm == Some(sidearm_owned)
        && OFFLINE[index].load(Ordering::Acquire) == 0
        && !RELEASED[index].load(Ordering::Acquire);
    if banks.active == bank {
        wait_released(model);
        let dest = if staying_online { sidearm_owned } else { clean_fallback };
        select_bank(&device, dest)?;
        if staying_online {
            ACTIVE_LIVE_BANK[index].store(dest, Ordering::Release);
        }
    }
    delete_bank(&device, bank)?;
    STORED[index].store(0, Ordering::Release);
    if banks.assigned.len() <= 2 {
        // At most one user bank remains: hybrid mode is no longer allowed.
        VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
    } else {
        VERIFIED_HYBRID_BANKS[index].fetch_and(!(1u8 << bank), Ordering::AcqRel);
    }
    let _ = std::fs::remove_file(bank_backup(config_dir, model, bank));
    let mut marker = read_sidearm_bank_marker(config_dir, model);
    let base_changed = marker.base == Some(bank);
    let hybrids_changed = marker.hybrids.contains(&bank);
    if (base_changed || hybrids_changed)
        && let Some(sb) = marker.sidearm
    {
        marker.hybrids.retain(|&b| b != bank);
        let next_base = if base_changed { clean_fallback } else { marker.base.unwrap_or(clean_fallback) };
        write_sidearm_bank_marker(config_dir, model, sb, next_base, &marker.hybrids);
    }
    log::info!("[naga-live] {} deleted user onboard bank {bank}", model.name);
    Ok(user_banks(&device)?.0)
}

/// Immediately writes and verifies all planned onboard banks for `model`,
/// cancelling only this model's pending delayed background store and reconciling
/// any waiting hybrid profile once verified.
pub fn flush_bank_store_now(model: &'static NativeModel, config: &AppConfig, config_dir: &Path) -> Result<(), String> {
    if !model.live.as_ref().is_some_and(|live| live.banks) {
        return Err(format!("{} has no onboard banks", model.name));
    }
    if crate::is_shutting_down() {
        return Err("Sidearm is shutting down".into());
    }
    let index = model.catalog_index();
    if OFFLINE[index].load(Ordering::Acquire) != 0 {
        return Err("Mouse is in manual offline mode; return to Sidearm before writing slots".into());
    }
    *SESSION_CONFIG_DIR.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(config_dir.to_path_buf());
    // Refresh the desired profile's config snapshot so post-store reconcile sees
    // the exact config being flushed rather than a stale debounced snapshot.
    {
        let mut guard = DESIRED_PROFILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(desired) = guard.as_mut() {
            desired.profile = desired
                .profile
                .as_ref()
                .and_then(|p| config.profiles.iter().find(|c| c.id == p.id && c.enabled).cloned());
            desired.config = config.clone();
            desired.revision = next_profile_revision();
        }
    }
    let generation = STORE_GENERATION[index].fetch_add(1, Ordering::AcqRel) + 1;
    let device = VendorDevice::open_model(model)?;
    // Re-check generation, shutdown, and manual offline after acquiring the device lock.
    if crate::is_shutting_down() {
        return Err("Sidearm is shutting down".into());
    }
    if OFFLINE[index].load(Ordering::Acquire) != 0 {
        return Err("Mouse is in manual offline mode; return to Sidearm before writing slots".into());
    }
    if STORE_GENERATION[index].load(Ordering::Acquire) != generation {
        return Ok(());
    }
    let offline = crate::mouse_offline::offline_profile_id(config, None);
    // On the live-map path (capture running without Sidearm's own bank), writing
    // or restoring the currently playing bank would clobber the active live map.
    if ACTIVE[index].load(Ordering::Acquire) && SIDEARM_BANK[index].load(Ordering::Acquire) == 0 {
        let (banks, _) = user_banks(&device)?;
        let plan = bank_plan(config, model, &banks, &offline);
        let touches_active = plan.iter().any(|entry| entry.bank == banks.active)
            || bank_backup(config_dir, model, banks.active).exists();
        if touches_active {
            return Err("Cannot write the active bank while capture runs without Sidearm's own slot".into());
        }
    }
    store_banks(&device, config, model, &offline, config_dir, false)
}

fn set_offline(model: &'static NativeModel, bank: u8) {
    if OFFLINE[model.catalog_index()].swap(bank, Ordering::AcqRel) != bank {
        crate::mouse_offline_mode_changed(model, bank != 0);
    }
}
/// Presses of each mouse dropped while its live map was being written
/// ([`events_allowed`]), logged as one line once it is ready.
static DROPPED: [AtomicU32; CATALOG_LEN] = [const { AtomicU32::new(0) }; CATALOG_LEN];
/// Inputs of each mouse that are down right now: its signals as the capture
/// helper reads them, and the keys and buttons its firmware sends, as raw input
/// reports them (`system_events`). A live record rewritten while its button is
/// held strands what the old record pressed: the firmware sends the release
/// of the new record, and a key stays down (measured 2026-11-10: a stuck
/// Shift+Enter repeating until Sidearm was killed).
static HELD: [Mutex<Vec<String>>; CATALOG_LEN] = [const { Mutex::new(Vec::new()) }; CATALOG_LEN];
/// How long a live-map write waits for the mouse's buttons to be let go.
const RELEASE_WAIT: Duration = Duration::from_secs(5);

fn held(model: &NativeModel) -> std::sync::MutexGuard<'static, Vec<String>> {
    HELD[model.catalog_index()].lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Forgets every held input (the capture helper's stream ended: no release
/// it reports can arrive).
pub fn clear_held() {
    for held in &HELD {
        held.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    }
}

/// A press (`down`) or release of `input` on `model`.
pub fn note_input(model: &NativeModel, input: &str, down: bool) {
    let mut held = held(model);
    if down {
        if !held.iter().any(|known| known == input) {
            held.push(input.to_owned());
        }
    } else {
        held.retain(|known| known != input);
    }
}

/// Waits until nothing is held on `model` (at most [`RELEASE_WAIT`]; a release
/// lost to a sleeping mouse must not stop the map for good).
fn wait_released(model: &NativeModel) {
    // Windows is ending the session on the thread that reports releases.
    if crate::is_shutting_down() {
        return;
    }
    let until = std::time::Instant::now() + RELEASE_WAIT;
    let mut waited = false;
    while !held(model).is_empty() {
        if std::time::Instant::now() >= until {
            log::warn!("[naga-live] {} still reports {:?} held; writing anyway", model.name, held(model));
            held(model).clear();
            return;
        }
        if !waited {
            log::info!("[naga-live] {} waits for its buttons to be released before writing", model.name);
            waited = true;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// The setup wizard's button test: every extra control joins the standard layer.
pub(crate) static CHECK_EXTRA_CONTROLS: AtomicBool = AtomicBool::new(false);

/// A session owns this model's live map (its legacy guard must stay away).
pub fn is_active(model: &NativeModel) -> bool {
    ACTIVE[model.catalog_index()].load(Ordering::Acquire)
}

/// This model's live map is written and verified.
pub fn is_ready(model: &NativeModel) -> bool {
    READY[model.catalog_index()].load(Ordering::Acquire)
}

/// Whether a press read from this model's HID stream may be dispatched: a
/// live map still being written could deliver another session's signal.
pub fn events_allowed(model: &NativeModel) -> bool {
    !is_active(model) || is_ready(model)
}

/// A press of `model` dropped because [`events_allowed`] said no.
pub fn note_dropped(model: &NativeModel) {
    DROPPED[model.catalog_index()].fetch_add(1, Ordering::Relaxed);
}

/// One line for the presses dropped since the session began (`since`).
fn log_dropped(model: &NativeModel, since: std::time::Instant, outcome: &str) {
    let count = DROPPED[model.catalog_index()].swap(0, Ordering::Relaxed);
    if count > 0 {
        log::info!("[naga-live] {} dropped {count} press(es) in {} ms while its live map was written ({outcome})", model.name, since.elapsed().as_millis());
    }
}

/// The models that need a live-map session, given the ones plugged in: every
/// verified model with a live path. An onboard model's (the V2's) signals live
/// only there: its profile 1 keeps the offline profile ([`store_onboard_offline`]).
pub fn live_models(present: &[&'static NativeModel]) -> Vec<&'static NativeModel> {
    // Only mice Sidearm writes count: an unverified one keeps its own buttons.
    present.iter().copied().filter(|model| model.live.is_some() && model.verified).collect()
}

/// Whether the mouse hook's software Hypershift is needed: some connected
/// mouse uses the onboard path, nothing is connected yet, or a live mouse
/// takes its layer from the software trigger (`software_layer`).
pub fn software_hypershift(present: &[&'static NativeModel], live: &[&'static NativeModel], config: &AppConfig) -> bool {
    present.is_empty()
        || present
            .iter()
            .any(|model| model.transport == Transport::Onboard && !live.iter().any(|item| item.is(model)))
        || live.iter().any(|model| software_layer(config, model, present))
}

/// Whether `model`'s live map leaves its trigger a plain mouse button and
/// takes the layer from the mouse hook: with `hypershiftTap` (a quick press
/// clicks — the firmware's Hypershift swallows the button), and always for an
/// onboard model that is the only mouse connected (the V2 alone keeps the
/// software trigger it had on the onboard path); only for a model without a
/// firmware Hypershift button whose settings trigger is one of its native
/// buttons. Raw input tells its trigger from another mouse's.
pub fn software_layer(config: &AppConfig, model: &NativeModel, present: &[&'static NativeModel]) -> bool {
    let alone = present.iter().filter(|other| other.verified && !other.is(model)).count() == 0;
    settings_trigger(config, model).is_some()
        && (config.settings.hypershift_tap || (model.transport == Transport::Onboard && alone))
}

/// The settings trigger as `model`'s native button `(id, button, value)`, when
/// the model has no firmware Hypershift button of its own.
fn settings_trigger(config: &AppConfig, model: &NativeModel) -> Option<(&'static str, u8, u8)> {
    let live = model.live.as_ref()?;
    if live.firmware_trigger.is_some() {
        return None;
    }
    let trigger = config.settings.hypershift_trigger.trim();
    model.native_buttons.iter().find(|(id, _, _)| *id == trigger).copied()
}

/// Every control of `model` in usage order: key buttons, extras, then the
/// native buttons (the V2's mouse buttons and wheel).
pub(crate) fn controls(model: &NativeModel) -> Vec<(&'static str, u8)> {
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

/// Modifier sets of the reserved key-mode aliases (`<mods>+F13`..`F24`). Never
/// `Ctrl+Alt+Shift` alone: that is Synapse's Hypershift encoding.
const ALIAS_MODIFIERS: [&str; 9] = [
    "Ctrl+Shift", "Alt+Shift", "Ctrl+Win", "Shift+Win", "Alt+Win",
    "Ctrl+Shift+Win", "Ctrl+Alt+Win", "Alt+Shift+Win", "Ctrl+Alt+Shift+Win",
];

/// Every reserved key-mode alias, normalized, in assignment order.
fn key_aliases() -> impl Iterator<Item = String> {
    ALIAS_MODIFIERS
        .into_iter()
        .flat_map(|mods| (13..=24).map(move |key| format!("{mods}+F{key}")))
        .filter_map(|alias| crate::hotkeys::normalize_hotkey(&alias).ok())
}

/// Whether `encoded_key` is one of Sidearm's own key-mode aliases.
pub fn is_key_alias(encoded_key: &str) -> bool {
    static ALIASES: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    let aliases = ALIASES.get_or_init(|| key_aliases().collect());
    crate::hotkeys::normalize_hotkey(encoded_key).is_ok_and(|key| aliases.contains(&key))
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
    let mut aliases = key_aliases();
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
            && binding.layer.is_live()
            && binding.control_id == *control
            // The hypershift layer falls back to the standard binding; a
            // HyperShift 2 press arrives as the standard record's signal.
            && (binding.layer == layer
                || layer == Layer::Hypershift
                || (layer == Layer::Standard && binding.layer == Layer::Hypershift2))
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
pub fn overlay(config: &AppConfig, model: &NativeModel, present: &[&'static NativeModel], consumer: bool, checking_extras: bool) -> Result<Overlay, String> {
    let Some(live) = &model.live else { return Ok(Overlay::default()) };
    let trigger = live.firmware_trigger.is_none().then(|| config.settings.hypershift_trigger.trim());
    let mut overlay = Overlay::default();
    // The hook holds the layer: the trigger stays a plain button (written, as
    // the base bank may hold Hypershift there) and layer 1 never plays.
    let software = software_layer(config, model, present);
    for (index, (control, button)) in controls(model).into_iter().enumerate() {
        let id = control_id(model, control);
        let key_button = index < model.key_buttons.len();
        for (layer, logical) in [(0u8, Layer::Standard), (1, Layer::Hypershift)] {
            if software && layer == 1 {
                continue;
            }
            if software && trigger == Some(control) {
                if let Some((_, _, value)) = settings_trigger(config, model) {
                    overlay.targets.push((button, layer, OnboardAction::Mouse(value)));
                }
                continue;
            }
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

/// The offline plan of `profile_id` ([`crate::mouse_offline::plan`]) as bank
/// targets.
fn offline_targets(config: &AppConfig, model: &NativeModel, profile_id: &str) -> Vec<(u8, u8, OnboardAction)> {
    crate::mouse_offline::plan(config, model, profile_id)
        .records()
        .into_iter()
        .map(|record| (record.button_id, record.layer, record.action))
        .collect()
}

/// The profile whose onboard bank is reserved exclusively for clean offline use
/// (never allowed to hold hybrid Sidearm signals): an explicit `offline_profile_id`
/// if it points to a real profile, else `fallback_profile_id`.
pub(crate) fn dedicated_offline_profile_id(config: &AppConfig) -> &str {
    match config.settings.offline_profile_id.as_deref() {
        Some(id) if id != crate::config::OFFLINE_PROFILE_ACTIVE && config.profiles.iter().any(|p| p.id == id) => id,
        _ => config.settings.fallback_profile_id.as_str(),
    }
}

/// Whether `profile_id` has an enabled non-Disabled live binding that needs
/// Sidearm to receive the silent consumer signal on `(control_id, logical)`.
fn profile_needs_sidearm_signal(config: &AppConfig, profile_id: &str, control: &ControlId, logical: Layer) -> bool {
    let active_on = |wanted: Layer| {
        config.bindings.iter().any(|b| {
            b.enabled
                && b.profile_id == profile_id
                && b.control_id == *control
                && b.layer == wanted
                && config.actions.iter().any(|a| a.id == b.action_id && a.action_type != ActionType::Disabled)
        })
    };
    match logical {
        Layer::Standard => active_on(Layer::Standard) || active_on(Layer::Hypershift2),
        Layer::Hypershift => {
            active_on(Layer::Hypershift)
                || active_on(Layer::HypershiftBoth)
                || (!config.bindings.iter().any(|b| b.enabled && b.profile_id == profile_id && b.control_id == *control && b.layer == Layer::Hypershift)
                    && active_on(Layer::Standard))
        }
        _ => false,
    }
}

/// Builds the hybrid bank targets for `profile_id` on a bank model: playable plain
/// bindings become native firmware records; Sidearm-only bindings (including gestures,
/// chords, throttled bindings, conditions, and HS2/HS+HS2 overrides) keep their reserved
/// consumer signals; unbound or Disabled key buttons become silent `Consumer(0)`; firmware
/// trigger stays `Hypershift` and profile button / non-key HS2 triggers are left untouched.
pub(crate) fn hybrid_bank_targets(config: &AppConfig, model: &NativeModel, profile_id: &str) -> Vec<(u8, u8, OnboardAction)> {
    let Some(live) = &model.live else { return Vec::new() };
    let hs2_triggers: &[String] = config
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .map_or(&[], |p| p.hypershift2_triggers.as_slice());
    let mut targets = Vec::new();
    for (index, (control, button)) in controls(model).into_iter().enumerate() {
        if Some(button) == live.profile_button {
            continue;
        }
        let id = control_id(model, control);
        let key_button = index < model.key_buttons.len();
        // Only native mouse buttons can be HS2 triggers; never skip a key button
        // (skipping a thumb could leave a pre-existing Sidearm signal in flash).
        if !key_button && hs2_triggers.iter().any(|trigger| trigger.as_str() == id.as_str()) {
            continue;
        }
        for (layer, logical) in [(0u8, Layer::Standard), (1u8, Layer::Hypershift)] {
            if let Some(native) = crate::mouse_offline::hybrid_native_action(config, model, profile_id, id.as_str(), logical) {
                targets.push((button, layer, native));
                continue;
            }
            if profile_needs_sidearm_signal(config, profile_id, &id, logical) {
                if let Some(&usage) = USAGES.get(2 * index + usize::from(layer)) {
                    targets.push((button, layer, OnboardAction::Consumer(usage)));
                }
                continue;
            }
            let explicitly_disabled = config.bindings.iter().any(|b| {
                b.enabled
                    && b.profile_id == profile_id
                    && b.control_id == id
                    && b.layer == logical
                    && config.actions.iter().any(|a| a.id == b.action_id && a.action_type == ActionType::Disabled)
            });
            if key_button || explicitly_disabled {
                targets.push((button, layer, OnboardAction::Consumer(crate::mouse_offline::BANK_SILENT_USAGE)));
            }
        }
    }
    if let Some(trigger) = live.firmware_trigger {
        targets.push((trigger, 0, OnboardAction::Hypershift));
        targets.push((trigger, 1, OnboardAction::Hypershift));
    }
    targets
}

/// Destination-aware planned bank entry: carries the physical slot, owning profile,
/// and whether that slot is written as a hybrid hardware bank or a pure offline bank.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PlannedBank<'a> {
    pub bank: u8,
    pub profile_id: &'a str,
    pub hybrid: bool,
}

/// Physical bank slot claimed by the dedicated offline profile (if linked on `model`).
/// Defensively reserved so no other profile can turn that slot into a hybrid bank.
fn dedicated_offline_slot(config: &AppConfig, model: &NativeModel) -> Option<u8> {
    let dedicated = dedicated_offline_profile_id(config);
    config
        .profiles
        .iter()
        .find(|p| p.id == dedicated)
        .and_then(|p| p.device_slots.as_ref()?.get(model.device_id).copied())
}

/// Profile-level eligibility for hybrid hardware bank mode (before checking the
/// mouse's bank inventory for at least one other clean user bank): requires a bank
/// model, consumer signals enabled, an enabled non-dedicated profile linked to a
/// non-dedicated slot with `hardware_bank == Some(true)`, and at least one explicitly
/// written layer-0 key button that is NOT Sidearm's own consumer signal (preventing
/// collision with `sidearm_bank` content detection).
pub(crate) fn profile_uses_hardware_bank(config: &AppConfig, model: &NativeModel, profile_id: &str) -> bool {
    if !model.live.as_ref().is_some_and(|live| live.banks) {
        return false;
    }
    if !crate::mouse_memory::consumer_signals_enabled() {
        return false;
    }
    if profile_id == dedicated_offline_profile_id(config) {
        return false;
    }
    let Some(profile) = config.profiles.iter().find(|p| p.id == profile_id && p.enabled) else {
        return false;
    };
    let Some(slot) = profile.device_slots.as_ref().and_then(|slots| slots.get(model.device_id)).copied() else {
        return false;
    };
    if dedicated_offline_slot(config, model) == Some(slot) {
        return false;
    }
    if profile.mouse_for(model.device_id).and_then(|own| own.hardware_bank) != Some(true) {
        return false;
    }
    let targets = hybrid_bank_targets(config, model, profile_id);
    // Require at least one explicitly written layer-0 key button that is not Sidearm's
    // own signature signal so `sidearm_bank` can never mistake this bank for Sidearm's.
    !model.key_buttons.is_empty()
        && model.key_buttons.iter().any(|&(_, button)| {
            targets
                .iter()
                .any(|&(b, l, action)| (b, l) == (button, 0) && !is_own_signal(model, b, 0, block(action)))
        })
}

/// Targets stored in a planned onboard bank: strictly follows `entry.hybrid`.
fn bank_targets_for(config: &AppConfig, model: &NativeModel, entry: PlannedBank<'_>) -> Vec<(u8, u8, OnboardAction)> {
    if entry.hybrid {
        hybrid_bank_targets(config, model, entry.profile_id)
    } else {
        offline_targets(config, model, entry.profile_id)
    }
}

/// Inspects every address of `bank` on `device` for any of Sidearm's reserved consumer
/// signals (which never appear in a clean offline bank). Propagates HID read errors
/// so uncertain reads are never mistaken for a clean bank during crash recovery.
fn bank_holds_sidearm_signal(device: &VendorDevice, bank: u8) -> Result<bool, String> {
    let model = device.model();
    for (button, layer) in bank_addresses(model) {
        if is_own_signal(model, button, layer, device.read_block(bank, button, layer)?) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Keeps the first error of a mouse that did not answer: the store is retried
/// once it wakes. Any other refusal is only logged — retrying it every two
/// seconds would wear the mouse's storage.
fn note_asleep(asleep: &mut Option<String>, error: String) {
    if super::is_no_response(&error) && asleep.is_none() {
        *asleep = Some(error);
    }
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

/// The banks of the connected mouse of `model` a profile may use (Sidearm's
/// own bank left out).
pub fn banks(model: &'static NativeModel) -> Result<Banks, String> {
    if !model.live.as_ref().is_some_and(|live| live.banks) {
        return Err(format!("{} has no onboard banks", model.name));
    }
    Ok(user_banks(&VendorDevice::open_model(model)?)?.0)
}

/// The bank Sidearm owns: every key button holds Sidearm's own signal there on
/// layer 0. Found by its content, so it follows the mouse to another PC or port.
fn sidearm_bank(device: &VendorDevice, banks: &Banks) -> Result<Option<u8>, String> {
    let model = device.model();
    'banks: for &bank in &banks.assigned {
        for &(_, button) in model.key_buttons {
            if !is_own_signal(model, button, 0, device.read_block(bank, button, 0)?) {
                continue 'banks;
            }
        }
        return Ok(Some(bank));
    }
    Ok(None)
}

/// The banks the user's profiles hold (Sidearm's bank left out of `assigned`;
/// `active` stays what plays) and Sidearm's bank.
fn user_banks(device: &VendorDevice) -> Result<(Banks, Option<u8>), String> {
    let mut banks = read_banks(device)?;
    let sidearm = sidearm_bank(device, &banks)?;
    banks.assigned.retain(|&bank| Some(bank) != sidearm);
    Ok((banks, sidearm))
}

/// `05:02`: assigns a free slot. The firmware fills it with factory records and
/// leaves the live map alone (measured 2026-11-15).
fn create_bank(device: &VendorDevice, bank: u8) -> Result<(), String> {
    if read_banks(device)?.assigned.contains(&bank) {
        return Err(format!("Bank {bank} already holds a profile"));
    }
    device.command(CLASS_BANKS, CMD_CREATE_BANK, &[bank])?;
    if !read_banks(device)?.assigned.contains(&bank) {
        return Err(format!("Could not confirm new bank {bank}"));
    }
    Ok(())
}

/// `05:03`: unassigns a bank that is not playing; a select of it is refused
/// afterwards (measured 2026-11-15).
fn delete_bank(device: &VendorDevice, bank: u8) -> Result<(), String> {
    if read_banks(device)?.active == bank {
        return Err(format!("Bank {bank} plays now"));
    }
    device.command(CLASS_BANKS, CMD_DELETE_BANK, &[bank])?;
    if read_banks(device)?.assigned.contains(&bank) {
        return Err(format!("Could not confirm bank {bank} unassigned"));
    }
    Ok(())
}

/// Every address a bank holds for `model`: its controls and its firmware
/// trigger, on both layers.
fn bank_addresses(model: &NativeModel) -> Vec<(u8, u8)> {
    let trigger = model.live.as_ref().and_then(|live| live.firmware_trigger);
    controls(model)
        .into_iter()
        .map(|(_, button)| button)
        .chain(trigger)
        .flat_map(|button| [(button, 0), (button, 1)])
        .collect()
}

/// The clean bank that plays without Sidearm: the offline profile's, else the one
/// playing (never Sidearm's own and never a hybrid bank; `banks` has Sidearm's left out).
/// `remembered`: the bank that played before Sidearm's, kept for when the offline
/// profile has no bank of its own.
fn base_bank(config: &AppConfig, model: &NativeModel, banks: &Banks, remembered: Option<u8>) -> Result<u8, String> {
    let offline = crate::mouse_offline::offline_profile_id(config, None);
    let plan = bank_plan(config, model, banks, &offline);
    let is_clean = |bank: u8| banks.assigned.contains(&bank) && !plan.iter().any(|p| p.bank == bank && p.hybrid);
    if let Some(entry) = plan.iter().find(|entry| entry.profile_id == offline && !entry.hybrid && banks.assigned.contains(&entry.bank)) {
        return Ok(entry.bank);
    }
    if let Some(bank) = remembered.filter(|&bank| is_clean(bank)) {
        return Ok(bank);
    }
    exit_bank(config, &plan, banks, &offline).ok_or_else(|| "No clean offline bank found on the mouse".to_owned())
}

/// Makes Sidearm's bank hold `base`'s records with `targets` over them, writing
/// only the records that differ, and gives it `base`'s DPI (the bank switch
/// sets the speed). A record Sidearm stored in `base` for use without it plays
/// its original here: offline-only assignments must not play while Sidearm
/// runs. Returns how many records it wrote.
fn sync_sidearm_bank(device: &VendorDevice, bank: u8, base: u8, targets: &[(u8, u8, OnboardAction)], config_dir: &Path) -> Result<usize, String> {
    let model = device.model();
    let stored = load_snapshot(device, &bank_backup(config_dir, model, base))?.map(|snapshot| snapshot.records).unwrap_or_default();
    let mut written = 0;
    for (button, layer) in bank_addresses(model) {
        let wanted = match targets.iter().find(|&&(b, l, _)| (b, l) == (button, layer)) {
            Some(&(_, _, action)) => bank_block(bank, action),
            None => match stored.iter().find(|record| (record.button, record.layer) == (button, layer) && record.before != record.target) {
                Some(record) => record.before,
                None => device.read_block(base, button, layer)?,
            },
        };
        if device.read_block(bank, button, layer)? != wanted {
            // Rewriting a record under a held button strands its key: the
            // playing bank is the live map. Asked per write: the profile button
            // may select this bank meanwhile.
            if active_bank(device)? == bank {
                wait_released(model);
            }
            write_bank(device, bank, button, layer, wanted)?;
            written += 1;
        }
    }
    match device.dpi_in(base) {
        Ok(dpi) => {
            if let Err(error) = device.set_dpi_in(bank, dpi) {
                log::warn!("[naga-live] {} Sidearm bank {bank} DPI not set: {error}", model.name);
            }
        }
        Err(error) => log::warn!("[naga-live] {} bank {base} DPI not read: {error}", model.name),
    }
    Ok(written)
}

/// Relocates a legacy Sidearm bank from `old` to the last slot (`MAX_BANKS`)
/// when `MAX_BANKS` is free, keeping user slots `1..=4` contiguous. Rolls back
/// cleanly on any hardware error so two Sidearm banks are never left behind.
fn try_relocate_sidearm_bank(
    device: &VendorDevice,
    old: u8,
    base: u8,
    targets: &[(u8, u8, OnboardAction)],
    config_dir: &Path,
) -> Result<usize, String> {
    let model = device.model();
    create_bank(device, MAX_BANKS)?;
    let written = match sync_sidearm_bank(device, MAX_BANKS, base, targets, config_dir) {
        Ok(written) => written,
        Err(error) => {
            if let Err(release) = delete_bank(device, MAX_BANKS) {
                log::warn!("[naga-live] {} half-filled slot {MAX_BANKS} not given back during relocate: {release}", model.name);
            }
            return Err(error);
        }
    };
    let was_active = active_bank(device)? == old;
    if was_active {
        mark_in_sidearm_bank(config_dir, model, MAX_BANKS, base);
        if let Err(error) = select_bank(device, MAX_BANKS) {
            mark_in_sidearm_bank(config_dir, model, old, base);
            let _ = delete_bank(device, MAX_BANKS);
            return Err(error);
        }
    }
    if let Err(error) = delete_bank(device, old) {
        if was_active {
            let _ = select_bank(device, old);
            mark_in_sidearm_bank(config_dir, model, old, base);
        }
        let _ = delete_bank(device, MAX_BANKS);
        return Err(error);
    }
    Ok(written)
}

/// Sidearm's bank, brought up to date with `targets` — claimed in the last
/// free slot (`MAX_BANKS` down to `1`) so user slots stay contiguous at the
/// front. If an older Sidearm bank sits in an earlier slot and `MAX_BANKS` is
/// free, migrates it to `MAX_BANKS`. `None`: every slot holds a user profile.
fn claim_sidearm_bank(device: &VendorDevice, config: &AppConfig, targets: &[(u8, u8, OnboardAction)], config_dir: &Path) -> Result<Option<(u8, u8)>, String> {
    let model = device.model();
    let (banks, sidearm) = user_banks(device)?;
    let base = base_bank(config, model, &banks, remembered_base(config_dir, model))?;
    if let Some(old) = sidearm
        && old != MAX_BANKS
        && !banks.assigned.contains(&MAX_BANKS)
    {
        match try_relocate_sidearm_bank(device, old, base, targets, config_dir) {
            Ok(written) => {
                log::info!(
                    "[naga-live] {} relocated Sidearm bank from slot {old} to last slot {MAX_BANKS} ({written} records written, base bank {base})",
                    model.name
                );
                return Ok(Some((MAX_BANKS, base)));
            }
            Err(error) => {
                log::warn!(
                    "[naga-live] {} could not relocate Sidearm bank {old} to {MAX_BANKS} ({error}); keeping slot {old}",
                    model.name
                );
            }
        }
    }
    let (bank, created) = match sidearm {
        Some(bank) => (bank, false),
        None => {
            let Some(free) = (1..=MAX_BANKS).rev().find(|bank| !banks.assigned.contains(bank)) else { return Ok(None) };
            create_bank(device, free)?;
            log::info!("[naga-live] {} claimed free slot {free} as the Sidearm bank", model.name);
            (free, true)
        }
    };
    let written = match sync_sidearm_bank(device, bank, base, targets, config_dir) {
        Ok(written) => written,
        Err(error) => {
            // Half filled it is no Sidearm bank anyone finds again: give the
            // slot back, or every retry would take another one.
            if created && let Err(release) = delete_bank(device, bank) {
                log::warn!("[naga-live] {} half-filled slot {bank} not given back: {release}", model.name);
            }
            return Err(error);
        }
    };
    log::info!("[naga-live] {} Sidearm bank {bank} up to date ({written} records written, base bank {base})", model.name);
    Ok(Some((bank, base)))
}

/// Marks that the mouse of `model` plays Sidearm's bank (and optionally any
/// managed hybrid bank selected this run): a restorer finding it after a kill
/// selects the verified clean bank that plays without Sidearm.
fn in_sidearm_bank_marker(config_dir: &Path, model: &NativeModel) -> PathBuf {
    config_dir.join(format!("{}-in-sidearm-bank", model.device_id))
}

#[derive(Debug, Default)]
struct SidearmBankMarker {
    sidearm: Option<u8>,
    base: Option<u8>,
    hybrids: Vec<u8>,
}

fn read_sidearm_bank_marker(config_dir: &Path, model: &NativeModel) -> SidearmBankMarker {
    let Ok(text) = std::fs::read_to_string(in_sidearm_bank_marker(config_dir, model)) else {
        return SidearmBankMarker::default();
    };
    let mut parts = text.split_whitespace();
    let sidearm = parts.next().and_then(|s| s.parse().ok());
    let base = parts.next().and_then(|s| s.parse().ok());
    let hybrids = parts
        .next()
        .map(|csv| csv.split(',').filter_map(|s| s.parse::<u8>().ok()).collect())
        .unwrap_or_default();
    SidearmBankMarker { sidearm, base, hybrids }
}

fn write_sidearm_bank_marker(config_dir: &Path, model: &NativeModel, bank: u8, base: u8, hybrids: &[u8]) {
    let text = if hybrids.is_empty() {
        format!("{bank} {base}")
    } else {
        let csv: Vec<String> = hybrids.iter().map(u8::to_string).collect();
        format!("{bank} {base} {}", csv.join(","))
    };
    crate::mouse_offline::write_marker(&in_sidearm_bank_marker(config_dir, model), &text);
}

/// Writes the marker before Sidearm's bank is selected (a kill in between
/// must still find it): Sidearm's bank and the clean one that played before it.
fn mark_in_sidearm_bank(config_dir: &Path, model: &NativeModel, bank: u8, base: u8) {
    let mut marker = read_sidearm_bank_marker(config_dir, model);
    marker.hybrids.retain(|&b| b != bank && b != base);
    write_sidearm_bank_marker(config_dir, model, bank, base, &marker.hybrids);
}

/// Records `hybrid_bank` in the recovery marker BEFORE switching into it so a
/// crash or config change before the next store still knows that bank is managed.
fn record_managed_hybrid_bank(config_dir: &Path, model: &NativeModel, sidearm: u8, hybrid_bank: u8) {
    let mut marker = read_sidearm_bank_marker(config_dir, model);
    let base = marker.base.unwrap_or(1);
    if !marker.hybrids.contains(&hybrid_bank) {
        marker.hybrids.push(hybrid_bank);
        marker.hybrids.sort_unstable();
    }
    write_sidearm_bank_marker(config_dir, model, marker.sidearm.unwrap_or(sidearm), base, &marker.hybrids);
}

/// The bank that played before Sidearm's, as the marker keeps it.
fn remembered_base(config_dir: &Path, model: &NativeModel) -> Option<u8> {
    read_sidearm_bank_marker(config_dir, model).base
}

/// Selects a verified clean offline bank when the mouse is currently playing
/// Sidearm's own bank or a profile's hybrid hardware bank, and removes the
/// marker only after confirmed restoration.
/// `config` (else the one in `config_dir`) names that bank.
fn leave_sidearm_bank(device: &VendorDevice, config: Option<&AppConfig>, config_dir: &Path) -> Result<(), String> {
    let model = device.model();
    let (banks, sidearm) = user_banks(device)?;
    let marker = read_sidearm_bank_marker(config_dir, model);
    let from_disk = config.is_none().then(|| crate::config::read_and_migrate_config_file(&config_dir.join("config.json")).ok()).flatten();
    let effective_config = config.or(from_disk.as_ref());
    let on_sidearm = sidearm == Some(banks.active);
    let on_marker_hybrid = !on_sidearm && marker.hybrids.contains(&banks.active);
    let on_config_hybrid = !on_sidearm
        && effective_config.is_some_and(|cfg| {
            let offline = crate::mouse_offline::offline_profile_id(cfg, None);
            bank_plan(cfg, model, &banks, &offline).iter().any(|p| p.bank == banks.active && p.hybrid)
        });
    let on_signal_hybrid = if !on_sidearm && !on_marker_hybrid && !on_config_hybrid && effective_config.is_none() {
        bank_holds_sidearm_signal(device, banks.active)?
    } else {
        false
    };
    if on_sidearm || on_marker_hybrid || on_config_hybrid || on_signal_hybrid {
        let playing = banks.active;
        let mut candidates: Vec<u8> = Vec::new();
        if let Some(cfg) = effective_config
            && let Ok(preferred) = base_bank(cfg, model, &banks, marker.base)
        {
            candidates.push(preferred);
        }
        if let Some(rem) = marker.base
            && banks.assigned.contains(&rem)
            && !candidates.contains(&rem)
        {
            candidates.push(rem);
        }
        for &bank in &banks.assigned {
            if !candidates.contains(&bank) {
                candidates.push(bank);
            }
        }
        // Pick the first candidate that is not the unclean playing bank, not in
        // config's hybrid set, and verified in flash to hold zero Sidearm signals.
        let mut chosen = None;
        for bank in candidates {
            if bank == playing || Some(bank) == sidearm {
                continue;
            }
            if let Some(cfg) = effective_config {
                let offline = crate::mouse_offline::offline_profile_id(cfg, None);
                if bank_plan(cfg, model, &banks, &offline).iter().any(|p| p.bank == bank && p.hybrid) {
                    continue;
                }
            }
            if bank_holds_sidearm_signal(device, bank)? {
                continue;
            }
            chosen = Some(bank);
            break;
        }
        let base = chosen.ok_or_else(|| "No verified clean offline bank available to restore".to_owned())?;
        select_bank(device, base)?;
        if on_sidearm {
            log::info!("[naga-live] {} left the Sidearm bank {playing}: bank {base} plays", model.name);
        } else {
            log::info!("[naga-live] {} left the hybrid bank {playing}: bank {base} plays", model.name);
        }
    }
    match std::fs::remove_file(in_sidearm_bank_marker(config_dir, model)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

/// Makes `bank` the one the mouse plays, confirmed by reading it back. The
/// firmware reloads the live map from it only when it was not the active one:
/// reselecting the bank already playing reloads nothing (measured 2026-11-14).
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

/// The clean offline bank to play after exit: never Sidearm's own bank and never a
/// hybrid `hardware_bank` slot (even when `offline_profile_id == "@active"`).
/// Returns `None` if no clean assigned user bank exists.
pub(crate) fn exit_bank(
    config: &AppConfig,
    plan: &[PlannedBank<'_>],
    banks: &Banks,
    offline_profile: &str,
) -> Option<u8> {
    let is_clean = |bank: u8| banks.assigned.contains(&bank) && !plan.iter().any(|p| p.bank == bank && p.hybrid);
    if let Some(entry) = plan.iter().find(|entry| entry.profile_id == offline_profile && is_clean(entry.bank)) {
        return Some(entry.bank);
    }
    let dedicated = dedicated_offline_profile_id(config);
    if let Some(entry) = plan.iter().find(|entry| entry.profile_id == dedicated && is_clean(entry.bank)) {
        return Some(entry.bank);
    }
    if is_clean(banks.active) {
        return Some(banks.active);
    }
    banks.assigned.iter().copied().find(|&bank| is_clean(bank))
}

/// Which profile and mode each bank gets: every profile linked to an assigned user
/// bank, or — with one user bank and no link — the offline profile (ALWAYS pure
/// offline, never hybrid).
/// Enforces two invariants defensively:
/// 1. At most one profile owns any physical bank slot (the dedicated offline profile
///    wins ties if a hand-edited config contains duplicates).
/// 2. At least one assigned user bank remains clean (non-hybrid); if enabling hybrid
///    on every requested slot would leave zero clean user banks, hybrid is refused
///    so offline restoration always has a guaranteed clean destination.
pub(crate) fn bank_plan<'a>(config: &'a AppConfig, model: &NativeModel, banks: &Banks, offline_profile: &'a str) -> Vec<PlannedBank<'a>> {
    let dedicated = dedicated_offline_profile_id(config);
    let mut linked: Vec<PlannedBank<'a>> = Vec::new();
    // Reserve the dedicated offline profile's slot first so no other profile can claim it.
    if let Some(profile) = config.profiles.iter().find(|p| p.id == dedicated)
        && let Some(&bank) = profile.device_slots.as_ref().and_then(|slots| slots.get(model.device_id))
        && banks.assigned.contains(&bank)
    {
        linked.push(PlannedBank { bank, profile_id: profile.id.as_str(), hybrid: false });
    }
    for profile in &config.profiles {
        if profile.id == dedicated {
            continue;
        }
        let Some(&bank) = profile.device_slots.as_ref().and_then(|slots| slots.get(model.device_id)) else {
            continue;
        };
        if !banks.assigned.contains(&bank) || linked.iter().any(|entry| entry.bank == bank) {
            continue;
        }
        let hybrid = profile_uses_hardware_bank(config, model, &profile.id);
        linked.push(PlannedBank { bank, profile_id: profile.id.as_str(), hybrid });
    }
    if linked.is_empty() && banks.assigned.len() == 1 {
        return vec![PlannedBank { bank: banks.assigned[0], profile_id: offline_profile, hybrid: false }];
    }
    // Single-clean-bank invariant: hybrid storage is allowed ONLY when at least one
    // assigned user bank on the mouse stays clean (non-hybrid).
    let has_clean_bank = banks
        .assigned
        .iter()
        .any(|&bank| !linked.iter().any(|entry| entry.bank == bank && entry.hybrid));
    if !has_clean_bank {
        for entry in &mut linked {
            entry.hybrid = false;
        }
    }
    linked
}

/// Stores the profiles linked to banks in the mouse of `model`, each verified
/// by reading it back. Banks with no linked profile are left as they are. An
/// error from a mouse that stopped answering anywhere in it (a bank, its DPI,
/// the bank reselect) is returned, so the store is retried as a whole.
pub(crate) fn write_offline(
    config: &AppConfig,
    model: &'static NativeModel,
    offline_profile: &str,
    config_dir: &Path,
) -> Result<(), String> {
    let device = VendorDevice::open_model(model)?;
    store_banks(&device, config, model, offline_profile, config_dir, true)
}

/// What the last background store wrote into each mouse's banks
/// ([`store_key`]; an onboard mouse's profile 1, `onboard_offline_key`), 0 for
/// nothing: an exit or a session that would write the same skips it.
static STORED: [std::sync::atomic::AtomicU64; CATALOG_LEN] = [const { std::sync::atomic::AtomicU64::new(0) }; CATALOG_LEN];
/// Bumped per model by config changes or explicit flushes: a background store
/// that waited past a newer generation for that model does nothing.
static STORE_GENERATION: [AtomicU32; CATALOG_LEN] = [const { AtomicU32::new(0) }; CATALOG_LEN];
/// A burst of saves (typing in a field) is one store.
const STORE_PAUSE: Duration = Duration::from_secs(5);
/// The config whose offline profile the onboard mouse's live session stores
/// next ([`store_onboard_offline`]): set by [`schedule_bank_store`], taken by
/// the session, which owns the live map a profile-1 write replaces.
static ONBOARD_STORE: Mutex<Option<AppConfig>> = Mutex::new(None);

/// Whether this run stored `config`'s offline profile in `model`'s profile 1.
pub(crate) fn onboard_offline_stored(config: &AppConfig, model: &NativeModel) -> bool {
    STORED[model.catalog_index()].load(Ordering::Acquire) == crate::mouse_offline::onboard_offline_key(config, model)
}

fn take_onboard_store() -> Option<AppConfig> {
    ONBOARD_STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take()
}

/// Stores the offline profile in `device`'s profile 1 (an onboard mouse) unless
/// it holds what this run stored last, waiting for no button to be held: the
/// write plays at once. The live map must be rewritten after a `true`.
fn store_onboard_offline(device: &VendorDevice, config: &AppConfig) -> Result<bool, String> {
    let model = device.model();
    let key = crate::mouse_offline::onboard_offline_key(config, model);
    if STORED[model.catalog_index()].load(Ordering::Acquire) == key {
        return Ok(false);
    }
    wait_released(model);
    crate::mouse_offline::store_onboard_offline(device, config)?;
    STORED[model.catalog_index()].store(key, Ordering::Release);
    Ok(true)
}

/// The DPI a bank gets with `profile_id`: the profile's own for this mouse.
fn bank_dpi(config: &AppConfig, model: &NativeModel, profile_id: &str) -> Option<u16> {
    config.profiles.iter().find(|profile| profile.id == profile_id)
        .and_then(|profile| profile.mouse_for(model.device_id))
        .and_then(|own| own.mouse_dpi)
        .map(|dpi| dpi.clamp(model.dpi_min, model.dpi_max))
}

/// A fingerprint of what a store of `model`'s banks writes: the banks, each
/// planned bank's mode, records and DPI.
fn store_key(config: &AppConfig, model: &NativeModel, banks: &Banks, offline_profile: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let plan = bank_plan(config, model, banks, offline_profile);
    let what: Vec<_> = plan
        .iter()
        .map(|&entry| (entry.bank, entry.hybrid, bank_targets_for(config, model, entry), bank_dpi(config, model, entry.profile_id)))
        .collect();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!("{:?}{what:?}", banks.assigned).hash(&mut hasher);
    hasher.finish().max(1)
}

/// Bitmask of verified hybrid banks from a verified `plan`.
fn verified_hybrid_mask(plan: &[PlannedBank<'_>]) -> u8 {
    plan.iter()
        .filter(|entry| entry.hybrid && (1..=MAX_BANKS).contains(&entry.bank))
        .fold(0u8, |mask, entry| mask | (1u8 << entry.bank))
}

/// Stores the offline banks of every bank mouse in the background, once the
/// config has stopped changing for [`STORE_PAUSE`], so an exit only selects a
/// bank. Only beside Sidearm's own bank: on the live-map path the playing bank
/// is the user's, and writing it would replace the live map.
pub fn schedule_bank_store(config: AppConfig, config_dir: PathBuf) {
    *SESSION_CONFIG_DIR.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(config_dir.clone());
    let mut generations = [0u32; CATALOG_LEN];
    for (index, slot) in STORE_GENERATION.iter().enumerate() {
        generations[index] = slot.fetch_add(1, Ordering::AcqRel) + 1;
    }
    let spawned = thread::Builder::new().name("bank-store".into()).spawn(move || {
        thread::sleep(STORE_PAUSE);
        if crate::is_shutting_down() {
            return;
        }
        *ONBOARD_STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(config.clone());
        let offline = crate::mouse_offline::offline_profile_id(&config, None);
        for model in CATALOG.iter().copied().filter(|model| model.live.as_ref().is_some_and(|live| live.banks) && configured(&config, model)) {
            let index = model.catalog_index();
            if STORE_GENERATION[index].load(Ordering::Acquire) != generations[index] {
                continue;
            }
            let stored = VendorDevice::open_model(model).and_then(|device| {
                // Re-check generation, shutdown, and session ownership AFTER
                // acquiring the device lock so a superseded or relinquished
                // store never writes flash.
                if STORE_GENERATION[index].load(Ordering::Acquire) != generations[index]
                    || crate::is_shutting_down()
                    || RELEASED[index].load(Ordering::Acquire)
                    || OFFLINE[index].load(Ordering::Acquire) != 0
                {
                    return Ok(false);
                }
                let sidearm_owned = SIDEARM_BANK[index].load(Ordering::Acquire);
                let expected = ACTIVE_LIVE_BANK[index].load(Ordering::Acquire);
                if sidearm_owned == 0 || expected == 0 {
                    return Ok(false);
                }
                let (banks, sidearm) = user_banks(&device)?;
                if sidearm != Some(sidearm_owned) || banks.active != expected {
                    return Ok(false);
                }
                store_banks(&device, &config, model, &offline, &config_dir, false).map(|()| true)
            });
            match stored {
                Ok(true) => log::info!("[mouse-offline] {} offline banks stored in the background", model.name),
                Ok(false) => {}
                Err(error) => log::warn!("[mouse-offline] {} offline banks not stored in the background (the exit stores them): {error}", model.name),
            }
        }
    });
    if let Err(error) = spawned {
        log::warn!("[mouse-offline] background bank store not started: {error}");
    }
}

/// The banks part of [`write_offline`]. The live map is already back (its
/// session restores it record by record when it stops): leaving it to the bank
/// reselect below was tried and failed on the real V3 (2026-11-14: after an
/// exit only the 2 records restored first played, the 38 left to the reselect
/// stayed Sidearm's silent signals — reselecting the bank already playing
/// reloads nothing).
fn store_banks(
    device: &VendorDevice,
    config: &AppConfig,
    model: &'static NativeModel,
    offline_profile: &str,
    config_dir: &Path,
    exiting: bool,
) -> Result<(), String> {
    // Sidearm's own bank never stores a profile.
    let (banks, _) = user_banks(device)?;
    let plan = bank_plan(config, model, &banks, offline_profile);
    let key = store_key(config, model, &banks, offline_profile);
    let index = model.catalog_index();
    let mut asleep = None;
    // Whether a write had Sidearm's bank play instead of the bank it wrote.
    let mut moved = false;
    // The bank reselect below sets the DPI (no linked bank: no reselect); the
    // poll rate stays what the last profile switch left. A store while
    // Sidearm runs leaves the live speed alone.
    if exiting && let Err(error) = crate::mouse_offline::restore_live_speed(device, config, offline_profile, plan.is_empty()) {
        log::warn!("[mouse-offline] {} poll rate not put back: {error}", model.name);
        note_asleep(&mut asleep, error);
    }
    // A save that left this mouse's banks as they were (another mouse's, a
    // setting) stores nothing: every bank was read back record by record.
    if STORED[index].load(Ordering::Acquire) == key {
        log::info!("[mouse-offline] {} banks already stored in the background", model.name);
        VERIFIED_HYBRID_BANKS[index].store(verified_hybrid_mask(&plan), Ordering::Release);
    } else {
        match store_planned_banks(device, config, model, &banks, &plan, config_dir, &mut asleep, &mut moved) {
            Ok(()) => {
                if asleep.is_none() {
                    STORED[index].store(key, Ordering::Release);
                    VERIFIED_HYBRID_BANKS[index].store(verified_hybrid_mask(&plan), Ordering::Release);
                }
            }
            Err(error) => {
                // Reconcile ACTIVE_LIVE_BANK to actual hardware bank before
                // returning so the Session monitor never mistakes our move to
                // SIDEARM_BANK for a manual profile-button press.
                if moved
                    && SIDEARM_BANK[index].load(Ordering::Acquire) != 0
                    && OFFLINE[index].load(Ordering::Acquire) == 0
                    && !RELEASED[index].load(Ordering::Acquire)
                    && let Ok(current) = active_bank(device)
                {
                    ACTIVE_LIVE_BANK[index].store(current, Ordering::Release);
                }
                return Err(error);
            }
        }
    }
    // The records are stored either way; playing them at once is a
    // convenience. Never while Sidearm runs: it plays its own bank.
    // Sidearm's own bank played for a write: the bank that played before
    // comes back (an exit's own bank wins below).
    let exit_select = exiting && !plan.is_empty();
    let online_bank_managed = SIDEARM_BANK[index].load(Ordering::Acquire) != 0
        && OFFLINE[index].load(Ordering::Acquire) == 0
        && !RELEASED[index].load(Ordering::Acquire);
    if moved && !exit_select {
        match select_bank(device, banks.active) {
            Ok(()) => {
                if online_bank_managed {
                    ACTIVE_LIVE_BANK[index].store(banks.active, Ordering::Release);
                }
            }
            Err(error) => {
                log::warn!("[mouse-offline] {} bank {} not reselected after storing: {error}", model.name, banks.active);
                if online_bank_managed
                    && let Ok(current) = active_bank(device)
                {
                    ACTIVE_LIVE_BANK[index].store(current, Ordering::Release);
                }
                note_asleep(&mut asleep, error);
            }
        }
    }
    if exit_select {
        let dest = exit_bank(config, &plan, &banks, offline_profile)
            .ok_or_else(|| "No verified clean offline bank available for exit".to_owned())?;
        if let Err(error) = select_bank(device, dest) {
            log::warn!("[mouse-offline] {} bank {dest} not reselected after storing: {error}", model.name);
            note_asleep(&mut asleep, error);
        }
    } else if !exiting && asleep.is_none() {
        // Now that hybrid banks are verified stored, immediately apply any
        // desired hybrid profile waiting for verification.
        if let Err(error) = reconcile_on_device(device, Some(config_dir), None) {
            log::warn!("[naga-live] {} desired profile not reconciled after bank store: {error}", model.name);
        }
    }
    asleep.map_or(Ok(()), Err)
}

/// Before `bank` is written: when it plays and the mouse has Sidearm's own bank,
/// that one plays meanwhile. Writing the playing bank changes the live map at
/// once, and a record rewritten under a held button strands its key (a stuck
/// Ctrl). Waits for held inputs before switching. Returns whether it switched.
fn off_the_playing_bank(device: &VendorDevice, bank: u8) -> Result<bool, String> {
    let banks = read_banks(device)?;
    if banks.active != bank {
        return Ok(false);
    }
    let Some(sidearm) = sidearm_bank(device, &banks)? else { return Ok(false) };
    let model = device.model();
    wait_released(model);
    select_bank(device, sidearm)?;
    let index = model.catalog_index();
    if SIDEARM_BANK[index].load(Ordering::Acquire) != 0
        && OFFLINE[index].load(Ordering::Acquire) == 0
        && !RELEASED[index].load(Ordering::Acquire)
    {
        ACTIVE_LIVE_BANK[index].store(sidearm, Ordering::Release);
    }
    log::info!("[mouse-offline] {} Sidearm bank {sidearm} plays while bank {bank} is written", model.name);
    Ok(true)
}

/// The writes of [`store_banks`]: unlinked banks get their records back, each
/// planned bank its profile and DPI.
#[allow(clippy::too_many_arguments)]
fn store_planned_banks(
    device: &VendorDevice,
    config: &AppConfig,
    model: &'static NativeModel,
    banks: &Banks,
    plan: &[PlannedBank<'_>],
    config_dir: &Path,
    asleep: &mut Option<String>,
    moved: &mut bool,
) -> Result<(), String> {
    // A bank no profile is linked to any more gets its own records back: what
    // Sidearm stored there earlier (an old turbo record included) would play on.
    for &bank in banks.assigned.iter().filter(|&&bank| !plan.iter().any(|entry| entry.bank == bank)) {
        let backup = bank_backup(config_dir, model, bank);
        if backup.exists() && let Err(error) = off_the_playing_bank(device, bank).and_then(|switched| {
            *moved |= switched;
            restore_bank(device, bank, &backup)
        }) {
            log::warn!("[mouse-offline] {} unlinked bank {bank} not restored: {error}", model.name);
            note_asleep(asleep, error);
        }
    }
    if plan.is_empty() {
        log::info!("[mouse-offline] {} keeps its {} onboard profiles: none is linked", model.name, banks.assigned.len());
        return Ok(());
    }
    for &entry in plan {
        let bank = entry.bank;
        let profile_id = entry.profile_id;
        let backup = bank_backup(config_dir, model, bank);
        let targets = bank_targets_for(config, model, entry);
        let already_stored = load_snapshot(device, &backup)?.is_some_and(|snapshot| {
            snapshot.records.len() == targets.len()
                && snapshot.records.iter().zip(&targets).all(|(record, &(button, layer, action))| {
                    (record.button, record.layer, record.target) == (button, layer, bank_block(bank, action))
                })
                && verify_bank(device, bank, &snapshot.records).is_ok()
        });
        if !already_stored {
            *moved |= off_the_playing_bank(device, bank)?;
            apply_bank(device, bank, &backup, &targets)?;
        }
        log::info!("[mouse-offline] {} profile `{profile_id}` verified in bank {bank}: {} records", model.name, targets.len());
        // Each bank keeps its own DPI and the mouse switches to it with the
        // bank: store the profile's own DPI for this mouse there.
        if let Some(dpi) = bank_dpi(config, model, profile_id) {
            match device.set_dpi_in(bank, dpi) {
                Ok(()) => log::info!("[mouse-offline] {} bank {bank} DPI {dpi} stored", model.name),
                Err(error) => {
                    log::warn!("[mouse-offline] {} bank {bank} DPI not stored: {error}", model.name);
                    note_asleep(asleep, error);
                }
            }
        }
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

/// Stops `sessions` on a thread of their own and returns at once: each
/// restores its mouse there, and a mouse stuck in a HID call must not hang
/// the caller. A new session of the same mouse waits for it (`Session::start`).
pub fn stop_sessions(mut sessions: Vec<Session>) {
    if sessions.is_empty() {
        return;
    }
    sessions.iter_mut().for_each(Session::request_stop);
    let _ = thread::Builder::new().name("live-map-stop".into()).spawn(move || drop(sessions));
}


/// Puts back every live map a Sidearm process left when it died without
/// restoring (killed, crashed): run by its capture helper, which outlives it.
/// Until then the mouse plays Sidearm's signals — every mapped button and the
/// wheel stay silent until a bank switch reloads the map from flash.
///
/// Returns whether nothing is left to restore.
pub fn restore_orphaned(config_dir: &Path) -> bool {
    let mut done = true;
    // The onboard mice (V2) go last: a sleeping one takes ~5 s to not answer,
    // and a bank mouse (V3) must not stay silent behind it.
    let mut models: Vec<_> = CATALOG.iter().filter(|model| model.live.is_some()).collect();
    models.sort_by_key(|model| model.transport == Transport::Onboard);
    for model in models {
        // A Sidearm that died on its own bank: one select gives the mouse back.
        if in_sidearm_bank_marker(config_dir, model).exists()
            && let Err(error) = VendorDevice::open_model(model).and_then(|device| leave_sidearm_bank(&device, None, config_dir))
        {
            log::warn!("[naga-live] {} still on the Sidearm bank a stopped Sidearm left: {error}", model.name);
            done = false;
        }
        let backup = live_backup(config_dir, model);
        if !backup.exists() {
            continue;
        }
        match VendorDevice::open_model(model).and_then(|device| restore_bank(&device, LIVE_BANK, &backup)) {
            Ok(()) => {}
            Err(error) => {
                log::warn!("[naga-live] {} live map left by a stopped Sidearm not restored: {error}", model.name);
                done = false;
            }
        }
    }
    done
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

/// Whether `block` is exactly the reserved consumer signal Sidearm writes for
/// `button` on `layer` of `model` — never a user's own record of that shape
/// (an F13 the user bound stays theirs).
fn is_own_signal(model: &NativeModel, button: u8, layer: u8, block: [u8; 7]) -> bool {
    let controls = controls(model);
    let Some(index) = controls.iter().position(|&(_, id)| id == button) else { return false };
    // The V2's onboard signal for thumb_01 is the same usage as this slot's
    // live signal: there it is the button's own record, not a leftover.
    let onboard = model.consumer_usage_for(controls[index].0).map(|usage| self::block(OnboardAction::Consumer(usage)));
    USAGES
        .get(2 * index + usize::from(layer))
        .is_some_and(|&usage| block == self::block(OnboardAction::Consumer(usage)) && Some(block) != onboard)
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

fn write_bank(device: &VendorDevice, bank: u8, button: u8, layer: u8, block: [u8; 7]) -> Result<(), String> {
    // A stored bank is not playing; the live map is.
    if bank == LIVE_BANK {
        wait_released(device.model());
    }
    device.set_block(bank, button, layer, &block)?;
    if device.read_block(bank, button, layer)? != block {
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

/// A bank switch replaced the whole live map, ending ownership of the old one.
/// Persist that fact before reading or writing any of the new bank's records.
fn forget_reloaded_map(backup: &Path, active: &mut Option<Snapshot>) -> Result<(), String> {
    if let Some(snapshot) = active {
        save_snapshot(backup, &Snapshot { path: snapshot.path.clone(), records: Vec::new() })?;
        *active = None;
    }
    Ok(())
}

/// Puts back every record Sidearm still owns (the user's own changes stay).
fn restore_bank(device: &VendorDevice, bank: u8, backup: &Path) -> Result<(), String> {
    restore_bank_except(device, bank, backup, |_, _| false)
}

/// [`restore_bank`] for every record but the addresses `keep` names, which stay
/// in the rollback file (it goes once none is left).
fn restore_bank_except(device: &VendorDevice, bank: u8, backup: &Path, keep: impl Fn(u8, u8) -> bool) -> Result<(), String> {
    let Some(mut snapshot) = load_snapshot(device, backup)? else { return Ok(()) };
    let mut failure = None;
    for record in snapshot.records.iter().rev().filter(|record| record.before != record.target && !keep(record.button, record.layer)) {
        // Read as something else twice: the user's own change, kept. A single
        // odd read is a firmware transition, not a reason to give the record up.
        let result = confirmed_drift(record.target, || device.read_block(bank, record.button, record.layer)).and_then(|changed| {
            if changed { Ok(()) } else { write_bank(device, bank, record.button, record.layer, record.before) }
        });
        if let Err(error) = result {
            failure.get_or_insert(error);
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    snapshot.records.retain(|record| keep(record.button, record.layer));
    if snapshot.records.is_empty() {
        std::fs::remove_file(backup).map_err(|error| error.to_string())?;
        log::info!("[naga-live] {} restored previous assignments in bank {bank}", device.model().name);
    } else {
        save_snapshot(backup, &snapshot)?;
        log::info!("[naga-live] {} restored previous assignments in bank {bank}, {} kept", device.model().name, snapshot.records.len());
    }
    Ok(())
}

fn verify_bank(device: &VendorDevice, bank: u8, records: &[Record]) -> Result<(), String> {
    for record in records {
        if device.read_block(bank, record.button, record.layer)? != record.target {
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
    let pending = plan_repair(&mut updated.records, |button, layer| device.read_block(LIVE_BANK, button, layer))?;
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
    let previous = load_snapshot(device, backup)?.map(|snapshot| snapshot.records).unwrap_or_default();
    let mut targets: Vec<_> = targets.iter().map(|&(button, layer, action)| (button, layer, bank_block(bank, action))).collect();
    if bank == LIVE_BANK && device.model().live.as_ref().is_some_and(|live| live.banks) {
        let playing = read_banks(device)?.active;
        let dir = backup.parent().ok_or("Live backup has no parent directory")?;
        if let Some(stored) = load_snapshot(device, &bank_backup(dir, device.model(), playing))? {
            // Undo only our stored offline records outside the live map. Keep
            // their current values in the live rollback, so stopping puts them back.
            for record in stored.records {
                if device.model().live.as_ref().is_some_and(|live| live.extras.iter().any(|&(_, button)| button == record.button))
                    && !targets.iter().any(|&(button, layer, _)| (button, layer) == (record.button, record.layer))
                    && record.before != record.target
                    && (!confirmed_drift(record.target, || device.read_block(bank, record.button, record.layer))?
                        || previous.iter().any(|owned| (owned.button, owned.layer, owned.before, owned.target) == (record.button, record.layer, record.target, record.before)))
                {
                    targets.push((record.button, record.layer, record.before));
                }
            }
        }
    }
    // A record Sidearm wrote earlier that stays the same keeps it and its
    // original: putting the original back only to write the same record again
    // cost five commands a record. Every other one goes back first, as before.
    let mut kept: Vec<Record> = Vec::new();
    for &(button, layer, target) in &targets {
        if let Some(record) = previous.iter().find(|record| {
            (record.button, record.layer) == (button, layer) && record.before != record.target && record.target == target
        }) && !confirmed_drift(record.target, || device.read_block(bank, button, layer))?
        {
            kept.push(record.clone());
        }
    }
    let is_kept = |button: u8, layer: u8| kept.iter().any(|record| (record.button, record.layer) == (button, layer));
    restore_bank_except(device, bank, backup, is_kept)?;
    let mut records = Vec::with_capacity(targets.len());
    let model = device.model();
    // A live map of a mouse with banks is what the firmware loaded from the
    // bank playing: that bank's record is the address's true original.
    let playing = (bank == LIVE_BANK && model.live.as_ref().is_some_and(|live| live.banks))
        .then(|| read_banks(device).map(|banks| banks.active).ok())
        .flatten();
    for &(button, layer, target) in &targets {
        if let Some(record) = kept.iter().find(|record| (record.button, record.layer) == (button, layer)) {
            records.push(record.clone());
            continue;
        }
        let mut before = device.read_block(bank, button, layer)?;
        // A map no session restored (its rollback file lost) still holds
        // Sidearm's signal: the playing bank's record is its original, else a
        // native button's plain record; anything else keeps it and says so.
        if is_own_signal(model, button, layer, before) {
            let stored = playing.and_then(|active| device.read_block(active, button, layer).ok()).filter(|stored| !is_own_signal(model, button, layer, *stored));
            match (stored, model.native_buttons.iter().find(|&&(_, id, _)| id == button)) {
                (Some(stored), _) => before = stored,
                (None, Some(&(_, _, value))) => before = block(OnboardAction::Mouse(value)),
                (None, None) => log::warn!("[naga-live] {} {button:#04x}/{layer} holds a Sidearm signal with no original", model.name),
            }
        }
        records.push(Record { button, layer, before, target });
    }
    let snapshot = Snapshot { path: device.path.clone(), records };
    if snapshot.records.is_empty() {
        return Ok(snapshot);
    }
    save_snapshot(backup, &snapshot)?;
    let result = snapshot
        .records
        .iter()
        .filter(|record| record.before != record.target && !is_kept(record.button, record.layer))
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
    /// Set once the worker holds this mouse's `ACTIVE` flag.
    claimed: Arc<AtomicBool>,
}

impl Session {
    pub fn matches(&self, model: &NativeModel, targets: &[(u8, u8, OnboardAction)]) -> bool {
        self.model.is(model) && self.targets.as_ref() == targets
    }

    /// Starts the worker; `None` when there is nothing to write. An onboard
    /// model first stores the offline profile in its profile 1 (`config`'s,
    /// or a newer one a config change queued).
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
        let onboard = model.transport == Transport::Onboard;
        let session_config = config.clone();
        let index = model.catalog_index();
        // A free mouse is claimed at once, so it reads as active as soon as
        // this returns; a busy one is waited for on the worker.
        let claimed = Arc::new(AtomicBool::new(ACTIVE[index].compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()));
        let worker_claimed = Arc::clone(&claimed);
        let (stop, stopped) = mpsc::channel();
        let started = std::time::Instant::now();
        let worker = thread::Builder::new()
            .name("naga-live".into())
            .spawn(move || {
                // One session per mouse: `ACTIVE` stays set until the previous
                // one's drop has restored its map and is done with the rollback
                // file, which may take a while on the stop thread
                // (`stop_sessions`). Wait for it here, as long as it takes,
                // without holding up whoever started this session.
                if !worker_claimed.load(Ordering::Acquire) {
                    log::info!("[naga-live] {} waits for its previous session to finish restoring", model.name);
                    loop {
                        if stopped.recv_timeout(Duration::from_millis(100)) != Err(mpsc::RecvTimeoutError::Timeout) {
                            return;
                        }
                        if ACTIVE[index].compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                            // Stopped meanwhile (the exit may already have
                            // seen every mouse idle): give the mouse back.
                            if stopped.try_recv() != Err(mpsc::TryRecvError::Empty) {
                                ACTIVE[index].store(false, Ordering::Release);
                                return;
                            }
                            worker_claimed.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
                let open = || VendorDevice::open_model(model);
                let has_banks = model.live.as_ref().is_some_and(|live| live.banks);
                // Sidearm's own bank needs its consumer signals on every key
                // button: that is how it is found again (`sidearm_bank`).
                let bank_path = has_banks
                    && !RELEASED[index].load(Ordering::Acquire)
                    && model.key_buttons.iter().all(|&(_, button)| {
                        worker_targets.iter().any(|&(b, l, action)| (b, l) == (button, 0) && is_own_signal(model, b, 0, block(action)))
                    });
                let no_free_bank_said = std::cell::Cell::new(false);
                let attempt = |active: &mut Option<Snapshot>, playing_bank: &mut Option<u8>, sidearm: &mut Option<u8>| {
                    // The last session's maps are still being restored by another process.
                    if crate::live_map_restore_running() {
                        return Err("The previous session's live maps are still being restored".to_owned());
                    }
                    if bank_path {
                        let device = open()?;
                        match claim_sidearm_bank(&device, &session_config, &worker_targets, &config_dir)? {
                            Some((bank, base)) => {
                                *SESSION_CONFIG_DIR.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(config_dir.clone());
                                mark_in_sidearm_bank(&config_dir, model, bank, base);
                                select_bank(&device, bank)?;
                                // The bank switch reloaded the live map: a rollback of an older one is moot.
                                if backup.exists() {
                                    std::fs::remove_file(&backup).map_err(|error| error.to_string())?;
                                }
                                log::info!("[naga-live] {} plays the Sidearm bank {bank}", model.name);
                                *sidearm = Some(bank);
                                SIDEARM_BANK[index].store(bank, Ordering::Release);
                                ACTIVE_LIVE_BANK[index].store(bank, Ordering::Release);
                                // Replay any desired profile if hybrid banks are already verified.
                                if let Err(error) = reconcile_on_device(&device, Some(&config_dir), None) {
                                    log::warn!("[naga-live] {} initial desired profile reconcile skipped: {error}", model.name);
                                }
                                // Bring the offline banks up to date now, so the exit only selects one.
                                schedule_bank_store(session_config.clone(), config_dir.clone());
                                return Ok(());
                            }
                            None if !no_free_bank_said.replace(true) => {
                                log::warn!("[naga-live] {} has no free bank slot for Sidearm: writing the live map instead (a free slot makes start and exit faster)", model.name);
                                crate::no_free_bank_slot();
                            }
                            None => {}
                        }
                    }
                    if has_banks {
                        let playing = read_banks(&open()?)?.active;
                        if playing_bank.is_some_and(|before| before != playing) {
                            forget_reloaded_map(&backup, active)?;
                        }
                        *playing_bank = Some(playing);
                    }
                    if let Some(snapshot) = active {
                        return repair(&open()?, &backup, snapshot);
                    }
                    // Profile 1 keeps the offline profile; written before the live
                    // map, whose originals it then is (the write plays at once).
                    if onboard {
                        let config = take_onboard_store().unwrap_or_else(|| session_config.clone());
                        store_onboard_offline(&open()?, &config)?;
                    }
                    // Stopped meanwhile (an exit): leave the mouse as it is
                    // rather than write a map only to undo it.
                    if stopped.try_recv() != Err(mpsc::TryRecvError::Empty) {
                        return Err(STOPPING.to_owned());
                    }
                    let snapshot = apply_bank(&open()?, LIVE_BANK, &backup, &worker_targets)?;
                    log::info!("[naga-live] {} verified {} live assignments", model.name, snapshot.records.len());
                    *active = Some(snapshot);
                    Ok(())
                };
                let mut last_error = None;
                let mut active = None;
                let mut playing_bank = None;
                let mut sidearm = None;
                'session: loop {
                    loop {
                        match attempt(&mut active, &mut playing_bank, &mut sidearm) {
                            Ok(()) => break,
                            Err(message) if message != super::NO_INTERFACE && message != STOPPING && last_error.as_ref() != Some(&message) => {
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
                    log_dropped(model, started, "ready");
                    // On Sidearm's bank there is nothing to repair: a reload
                    // plays the same bank. The profile button is the user's own
                    // way out (offline) and back.
                    if let Some(bank) = sidearm {
                        let mut away = false;
                        loop {
                            if stopped.recv_timeout(RETRY) != Err(mpsc::RecvTimeoutError::Timeout) {
                                break 'session;
                            }
                            let observed = open().and_then(|device| {
                                let expected = ACTIVE_LIVE_BANK[index].load(Ordering::Acquire);
                                let playing = active_bank(&device)?;
                                Ok((expected, playing))
                            });
                            match observed {
                                Ok((expected, playing)) if expected != 0 && playing != expected && !away => {
                                    log::warn!("[naga-live] {} plays bank {playing} (profile button): offline until the Sidearm bank {bank} plays again", model.name);
                                    away = true;
                                    set_offline(model, bank);
                                }
                                Ok((expected, playing)) if away && (playing == bank || (expected != 0 && playing == expected)) => {
                                    if playing == bank {
                                        log::info!("[naga-live] {} plays the Sidearm bank {playing} again", model.name);
                                    } else {
                                        log::info!("[naga-live] {} plays the hybrid bank {playing} again", model.name);
                                    }
                                    ACTIVE_LIVE_BANK[index].store(playing, Ordering::Release);
                                    away = false;
                                    set_offline(model, 0);
                                    if let Ok(device) = open()
                                        && let Err(error) = reconcile_on_device(&device, Some(&config_dir), None)
                                    {
                                        log::warn!("[naga-live] {} desired profile not reconciled after returning online: {error}", model.name);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    // The profile button reloads the whole live map from another
                    // bank: watching the active bank catches it at once, where the
                    // record-by-record check would take a full cycle.
                    let watched = active.as_ref().map(|snapshot| snapshot.records.clone()).unwrap_or_default();
                    for record in watched.iter().cycle() {
                        if stopped.recv_timeout(RETRY) != Err(mpsc::RecvTimeoutError::Timeout) {
                            break 'session;
                        }
                        if has_banks
                            && let Ok(bank) = open().and_then(|device| active_bank(&device))
                            && playing_bank.is_some_and(|last| last != bank)
                        {
                            log::warn!("[naga-live] {} switched to bank {bank}; repairing the live map", model.name);
                            break;
                        }
                        // A changed offline profile: stored, then the repair below
                        // rewrites the live map the write replaced.
                        if onboard && let Some(config) = take_onboard_store() {
                            match open().and_then(|device| store_onboard_offline(&device, &config)) {
                                Ok(true) => break,
                                Ok(false) => {}
                                Err(error) => {
                                    log::warn!("[naga-live] {} offline profile not stored yet: {error}", model.name);
                                    ONBOARD_STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_or_insert(config);
                                }
                            }
                        }
                        let drift = open().and_then(|device| {
                            confirmed_drift(record.target, || device.read_block(LIVE_BANK, record.button, record.layer))
                        });
                        if drift == Ok(true) {
                            // Keep forwarding releases for inputs held before recovery.
                            log::warn!("[naga-live] {} live assignment {:#04x}/{} changed; repairing", model.name, record.button, record.layer);
                            break;
                        }
                    }
                }
                READY[index].store(false, Ordering::Release);
                SIDEARM_BANK[index].store(0, Ordering::Release);
                ACTIVE_LIVE_BANK[index].store(0, Ordering::Release);
                VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
                log_dropped(model, started, "stopped before it was ready");
                set_offline(model, 0);
                if sidearm.is_some()
                    && let Err(error) = open().and_then(|device| leave_sidearm_bank(&device, Some(&session_config), &config_dir))
                {
                    log::warn!("[naga-live] {} still on the Sidearm bank (the exit or a restorer selects another): {error}", model.name);
                }
                if active.is_some() {
                    // The restored map plays profile 1: the offline profile.
                    if let Err(error) = open().and_then(|device| restore_bank(&device, LIVE_BANK, &backup)) {
                        log::warn!("[naga-live] {} recovery pending until next start: {error}", model.name);
                    }
                }
            })
            .inspect_err(|error| {
                if claimed.load(Ordering::Acquire) {
                    ACTIVE[index].store(false, Ordering::Release);
                }
                log::warn!("[naga-live] {} could not start worker: {error}", model.name);
            })
            .ok()?;
        Some(Self { stop: Some(stop), worker: Some(worker), model, targets, claimed })
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
        // Only a session that got the mouse gives it up: one stopped while it
        // still waited must not clear its predecessor's flag.
        if self.claimed.load(Ordering::Acquire) {
            ACTIVE[self.model.catalog_index()].store(false, Ordering::Release);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::device_catalog::{NAGA_PRO, NAGA_V2_HYPERSPEED, NAGA_V3_PRO};

    /// Tests that store into the V2 share its `STORED` entry: one at a time.
    pub(crate) static V2_STORE: Mutex<()> = Mutex::new(());
    /// Tests that mutate V3 global bank/reconcile statics (`SIDEARM_BANK`,
    /// `ACTIVE_LIVE_BANK`, `VERIFIED_HYBRID_BANKS`, `STORED`, `RELEASED`,
    /// `OFFLINE`, `INPUT_TEST_MODE`, `DESIRED_PROFILE`) serialize on this lock.
    static V3_GLOBAL_STATE: Mutex<()> = Mutex::new(());

    /// Stores `config`'s offline profile in a (fake) V2 as its session does.
    pub(crate) fn store_v2_offline(device: &VendorDevice, config: &AppConfig) -> Result<bool, String> {
        store_onboard_offline(device, config)
    }

    pub(crate) fn forget_v2_store() {
        STORED[NAGA_V2_HYPERSPEED.catalog_index()].store(0, Ordering::Release);
    }

    /// Both mice connected: the V2's trigger follows `hypershiftTap`.
    const BOTH: &[&NativeModel] = &[&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO];

    pub(crate) fn config_with_v3() -> AppConfig {
        let mut config = crate::config::default_seed_config();
        add_device(&mut config, &NAGA_V3_PRO);
        config
    }

    /// A single odd read while restoring does not cost a record its original.
    #[test]
    fn one_odd_read_does_not_drop_the_original() {
        use crate::mouse_memory::fake::{self, FakeMouse};
        let dir = tempfile::tempdir().unwrap();
        let path = r"\\?\hid#vid_1532&pid_00e8&mi_00#x";
        let (before, target) = (block(OnboardAction::Mouse(1)), block(OnboardAction::Consumer(USAGES[0])));
        let backup = dir.path().join("v3-live.json");
        save_snapshot(&backup, &Snapshot { path: path.into(), records: vec![Record { button: 0x40, layer: 0, before, target }] }).unwrap();
        let _fake = fake::install(FakeMouse::default());
        fake::with(|mouse| {
            mouse.records.insert((LIVE_BANK, 0x40, 0), target);
            mouse.odd_once.insert((LIVE_BANK, 0x40, 0), block(OnboardAction::Mouse(3)));
        });
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, path);
        restore_bank(&device, LIVE_BANK, &backup).unwrap();
        assert_eq!(fake::with(|mouse| mouse.records[&(LIVE_BANK, 0x40, 0)]), before);
        assert!(!backup.exists());

        // Read as the user's own record twice: it stays.
        let users = block(OnboardAction::Key { modifier: 0, usage: 0x68 });
        save_snapshot(&backup, &Snapshot { path: path.into(), records: vec![Record { button: 0x40, layer: 0, before, target }] }).unwrap();
        fake::with(|mouse| mouse.records.insert((LIVE_BANK, 0x40, 0), users));
        restore_bank(&device, LIVE_BANK, &backup).unwrap();
        assert_eq!(fake::with(|mouse| mouse.records[&(LIVE_BANK, 0x40, 0)]), users);
    }

    #[test]
    fn held_inputs_are_counted_per_mouse_and_a_release_frees_them() {
        // NAGA_PRO: no other test sends it input.
        note_input(&NAGA_PRO, "vk0x0d", true);
        note_input(&NAGA_PRO, "vk0x0d", true);
        note_input(&NAGA_PRO, "button1", true);
        assert_eq!(*held(&NAGA_PRO), ["vk0x0d", "button1"], "a repeated press counts once");
        note_input(&NAGA_PRO, "vk0x0d", false);
        note_input(&NAGA_PRO, "button1", false);
        assert!(held(&NAGA_PRO).is_empty());
        wait_released(&NAGA_PRO);
    }

    #[test]
    fn sidearm_signals_are_told_apart_from_records_to_keep() {
        let (index, (_, button)) = controls(&NAGA_V3_PRO).into_iter().enumerate().nth(1).unwrap();
        let own = |layer: u8| block(OnboardAction::Consumer(USAGES[2 * index + usize::from(layer)]));
        assert!(is_own_signal(&NAGA_V3_PRO, button, 0, own(0)));
        assert!(is_own_signal(&NAGA_V3_PRO, button, 1, own(1)));
        assert!(!is_own_signal(&NAGA_V3_PRO, button, 0, own(1)), "another layer's signal");
        assert!(!is_own_signal(&NAGA_V3_PRO, button, 0, block(OnboardAction::Key { modifier: 0, usage: 0x68 })), "the user's F13");
        assert!(!is_own_signal(&NAGA_V3_PRO, button, 0, block(OnboardAction::Mouse(1))));
        // V2 thumb_01 stores consumer 0x10 while Sidearm runs, which is also
        // its live signal on layer 0: that record is the original.
        assert!(!is_own_signal(&NAGA_V2_HYPERSPEED, 0x40, 0, block(OnboardAction::Consumer(0x10))));
        assert!(is_own_signal(&NAGA_V2_HYPERSPEED, 0x40, 1, block(OnboardAction::Consumer(0x11))));
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
        // The V2 alone too: its signals live only in its live map (stage 2).
        assert_eq!(names(live_models(&[&NAGA_V2_HYPERSPEED])), ["Razer Naga V2 HyperSpeed"]);
        assert_eq!(names(live_models(&[&NAGA_V3_PRO])), ["Razer Naga V3 Pro"]);
        assert_eq!(
            names(live_models(&[&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO])),
            ["Razer Naga V2 HyperSpeed", "Razer Naga V3 Pro"]
        );
        // An unverified model keeps its own buttons.
        assert_eq!(names(live_models(&[&NAGA_PRO, &NAGA_V3_PRO])), ["Razer Naga V3 Pro"]);
        assert_eq!(names(live_models(&[&NAGA_V2_HYPERSPEED, &NAGA_PRO])), ["Razer Naga V2 HyperSpeed"]);
    }

    /// The V2's profile 1 is written once per offline profile, not on every
    /// start or save: a store that holds it already reads only.
    #[test]
    fn the_v2_offline_profile_is_stored_once_per_change() {
        use crate::mouse_memory::fake::{self, FakeMouse};
        let _one = V2_STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let _fake = fake::install(FakeMouse { poll_code: 0x01, ..Default::default() });
        let device = VendorDevice::test_handle(&NAGA_V2_HYPERSPEED, 0x00b4, "");
        let mut config = crate::config::default_seed_config();
        STORED[NAGA_V2_HYPERSPEED.catalog_index()].store(0, Ordering::Release);
        assert_eq!(store_onboard_offline(&device, &config), Ok(true));
        let writes = fake::with(|mouse| mouse.writes.len());
        assert!(writes > 0);
        assert_eq!(store_onboard_offline(&device, &config), Ok(false), "the same profile again");
        assert_eq!(fake::with(|mouse| mouse.writes.len()), writes);
        config.settings.fallback_profile_id = config.profiles.last().unwrap().id.clone();
        if config.profiles.len() > 1 {
            assert_eq!(store_onboard_offline(&device, &config), Ok(true), "another offline profile");
        }
        STORED[NAGA_V2_HYPERSPEED.catalog_index()].store(0, Ordering::Release);
    }

    #[test]
    fn software_hypershift_serves_only_onboard_mice() {
        let mut config = config_with_v3();
        config.settings.hypershift_tap = false;
        assert!(software_hypershift(&[], &[], &config));
        assert!(software_hypershift(&[&NAGA_V2_HYPERSPEED], &[], &config));
        // The V2 alone on its live map keeps the software trigger.
        let v2 = [&NAGA_V2_HYPERSPEED];
        assert!(software_hypershift(&v2, &live_models(&v2), &config));
        let v2_pro = [&NAGA_V2_HYPERSPEED, &NAGA_PRO];
        assert!(software_hypershift(&v2_pro, &live_models(&v2_pro), &config), "an unverified mouse does not count");
        assert!(!software_hypershift(&[&NAGA_V3_PRO], &[&NAGA_V3_PRO], &config));
        let both = [&NAGA_V2_HYPERSPEED, &NAGA_V3_PRO];
        assert!(!software_hypershift(&both, &live_models(&both), &config));
        let pro = [&NAGA_PRO, &NAGA_V3_PRO];
        assert!(software_hypershift(&pro, &live_models(&pro), &config));
        // A clicking trigger: the V2's live map leaves the layer to the hook.
        config.settings.hypershift_tap = true;
        assert!(software_hypershift(&both, &live_models(&both), &config));
        assert!(!software_hypershift(&[&NAGA_V3_PRO], &[&NAGA_V3_PRO], &config));
    }

    #[test]
    fn the_v2_alone_keeps_its_right_button_a_plain_button_without_hypershift_tap() {
        let mut config = config_with_v3();
        config.settings.hypershift_tap = false;
        let alone: &[&NativeModel] = &[&NAGA_V2_HYPERSPEED];
        assert!(software_layer(&config, &NAGA_V2_HYPERSPEED, alone));
        assert!(!software_layer(&config, &NAGA_V2_HYPERSPEED, BOTH), "beside the V3 its firmware holds the layer");
        let v2 = overlay(&config, &NAGA_V2_HYPERSPEED, alone, true, false).unwrap();
        assert!(v2.targets.contains(&(0x02, 0, OnboardAction::Mouse(2))));
        assert!(!v2.targets.iter().any(|&(_, layer, _)| layer == 1));
        assert!(!v2.targets.iter().any(|&(_, _, action)| action == OnboardAction::Hypershift));
    }

    #[test]
    fn a_clicking_trigger_keeps_the_v2s_right_button_a_plain_button() {
        let mut config = config_with_v3();
        config.settings.hypershift_tap = true;
        assert!(software_layer(&config, &NAGA_V2_HYPERSPEED, BOTH));
        assert!(!software_layer(&config, &NAGA_V3_PRO, BOTH));
        let v2 = overlay(&config, &NAGA_V2_HYPERSPEED, BOTH, true, false).unwrap();
        assert!(v2.targets.contains(&(0x02, 0, OnboardAction::Mouse(2))));
        assert!(!v2.targets.iter().any(|&(_, _, action)| action == OnboardAction::Hypershift));
        assert!(!v2.targets.iter().any(|&(_, layer, _)| layer == 1));
        assert!(!v2.signals.iter().any(|signal| signal.hypershift));
        assert_eq!(v2.signals.iter().filter(|signal| signal.encoded_key == "F13").count(), 1);
        // The V3 keeps its firmware HyperShift button.
        let v3 = overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap();
        assert!(v3.targets.iter().any(|&(_, _, action)| action == OnboardAction::Hypershift));
    }

    #[test]
    fn v3_setup_maps_unassigned_extra_controls_only_in_live_standard_layer() {
        let config = config_with_v3();
        let normal = overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap();
        let setup = overlay(&config, &NAGA_V3_PRO, BOTH, true, true).unwrap();
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
    fn offline_only_assignments_do_not_capture_extra_controls_live() {
        let mut config = config_with_v3();
        let before = overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap();
        let template = config.bindings[0].clone();
        for layer in [Layer::Offline, Layer::OfflineHypershift] {
            config.bindings.push(crate::config::Binding {
                id: format!("offline-extra-{layer:?}"),
                layer,
                control_id: control_id(&NAGA_V3_PRO, "wheel_down"),
                ..template.clone()
            });
        }
        assert_eq!(overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap(), before);
        for layer in [Layer::Standard, Layer::Hypershift] {
            assert!(!has_action(&config, &control_id(&NAGA_V3_PRO, "wheel_down"), layer));
        }
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
        let v2 = overlay(&config, &NAGA_V2_HYPERSPEED, BOTH, true, false).unwrap();
        let v3 = overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap();
        assert!(v2.targets.contains(&(0x02, 0, OnboardAction::Hypershift)));
        assert!(v2.targets.contains(&(0x01, 1, OnboardAction::Mouse(2))));
        assert!(!v2.targets.iter().any(|&(button, layer, _)| button == 0x01 && layer == 0));
        assert_eq!(v2.signals.iter().filter(|signal| signal.encoded_key == "F13").count(), 2);
        assert!(!v2.signals.iter().any(|a| v3.signals.iter().any(|b| a.encoded_key == b.encoded_key)));
    }

    #[test]
    fn v2_overlay_follows_the_keyboard_fallback() {
        let config = config_with_v3();
        let keys = overlay(&config, &NAGA_V2_HYPERSPEED, BOTH, false, false).unwrap();
        assert!(keys.signals.is_empty());
        assert!(keys.targets.contains(&(0x40, 0, OnboardAction::Key { modifier: 0, usage: 0x68 })));
        assert!(keys.targets.contains(&(0x02, 0, OnboardAction::Hypershift)));
    }

    #[test]
    fn editing_an_action_keeps_both_maps_but_moving_v2_hypershift_changes_only_v2() {
        let mut config = config_with_v3();
        let v2 = overlay(&config, &NAGA_V2_HYPERSPEED, BOTH, true, false).unwrap();
        let v3 = overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap();
        config.actions[0].display_name = "Renamed shortcut".into();
        assert_eq!(overlay(&config, &NAGA_V2_HYPERSPEED, BOTH, true, false).unwrap(), v2);
        assert_eq!(overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap(), v3);
        config.settings.hypershift_trigger = "mouse_4".into();
        assert_ne!(overlay(&config, &NAGA_V2_HYPERSPEED, BOTH, true, false).unwrap(), v2);
        assert_eq!(overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap(), v3);
    }

    #[test]
    fn all_thumb_layers_have_distinct_hid_usages_and_keyboard_fallback() {
        let config = config_with_v3();
        let hid = overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap();
        let keys = overlay(&config, &NAGA_V3_PRO, BOTH, false, false).unwrap();
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
        assert_eq!(bank_plan(&config, &NAGA_V3_PRO, &one, "main"), [PlannedBank { bank: 1, profile_id: "main", hybrid: false }]);
        assert!(bank_plan(&config, &NAGA_V3_PRO, &three, "main").is_empty(), "unlinked banks are preserved");
        let profile = config.profiles[0].id.clone();
        config.profiles[0].device_slots = Some([(NAGA_V3_PRO.device_id.to_owned(), 2)].into());
        assert_eq!(bank_plan(&config, &NAGA_V3_PRO, &three, "main"), [PlannedBank { bank: 2, profile_id: profile.as_str(), hybrid: false }]);
        assert!(bank_plan(&config, &NAGA_V3_PRO, &Banks { assigned: vec![1, 3], active: 1 }, "main").is_empty(),
            "a link to a bank the mouse does not hold is ignored");
        let plan = [
            PlannedBank { bank: 2, profile_id: "code", hybrid: false },
            PlannedBank { bank: 3, profile_id: "game", hybrid: false },
        ];
        assert_eq!(exit_bank(&config, &plan, &three, "game"), Some(3), "the offline profile's bank plays after exit");
        assert_eq!(exit_bank(&config, &plan, &three, "main"), Some(2), "else the bank that was playing");
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
        assert!(targets.contains(&(0x42, 0, OnboardAction::Consumer(crate::mouse_offline::BANK_SILENT_USAGE))));
        assert!(targets.contains(&(0x42, 1, OnboardAction::Consumer(crate::mouse_offline::BANK_SILENT_USAGE))));
        assert!(!targets.iter().any(|&(button, _, _)| button == 0x43), "an unbound button keeps its record");
        assert_eq!(bank_block(1, OnboardAction::Key { modifier: 0, usage: 0x2a }), [2, 1, 0, 0x2a, 0, 0, 0]);
        assert_eq!(bank_block(1, OnboardAction::Key { modifier: 1, usage: 0x19 }), [2, 2, 1, 0x19, 0, 0, 0]);
        // Alt+F4 is held as a plain record, never the turbo one the V3 repeats.
        let shortcut = config.bindings.iter().find(|binding| binding.id == "v3-test").unwrap().action_id.clone();
        if let Some(crate::config::ActionPayload::Shortcut(keys)) =
            config.actions.iter_mut().find(|action| action.id == shortcut).map(|action| &mut action.payload)
        {
            (keys.key, keys.ctrl, keys.shift, keys.alt, keys.win) = ("F4".into(), false, false, true, false);
        }
        let targets = offline_targets(&config, &NAGA_V3_PRO, &profile);
        assert!(targets.contains(&(0x41, 1, OnboardAction::Key { modifier: 0x04, usage: 0x3d })));
        assert!(!targets.iter().any(|(_, _, action)| matches!(action, OnboardAction::KeyTap { .. })));
    }

    /// Hardware, interactive — **close Sidearm first**; writes the V3's live map
    /// (RAM, not a bank) and puts it back. Thumbs 1..4 get plain key records
    /// with the standard mask, as Synapse stores them: LShift, LAlt, then the
    /// right-hand RShift, RAlt the V2 needs, all with F24. Press 1..4 within 45 s; prints
    /// what Windows saw. Run: `cargo test v3_plain_left_modifiers -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn v3_plain_left_modifiers() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let device = VendorDevice::open_model(&NAGA_V3_PRO).expect("turn the V3 on");
        let probes = [(0x40, 0x02), (0x41, 0x04), (0x42, 0x20), (0x43, 0x40)];
        let saved: Vec<(u8, [u8; 7])> = probes.iter().map(|&(button, _)| (button, device.read_block(LIVE_BANK, button, 0).unwrap())).collect();
        for (index, &(button, modifier)) in probes.iter().enumerate() {
            println!("thumb {}: modifier {modifier:#04x} + F24", index + 1);
            write_bank(&device, LIVE_BANK, button, 0, block(OnboardAction::Key { modifier, usage: 0x73 })).unwrap();
        }
        drop(device);
        println!("press thumbs 1..4 now, one at a time");
        // Every virtual key, with the time since the start: what each press sent.
        let start = std::time::Instant::now();
        let mut held = [false; 256];
        while start.elapsed() < std::time::Duration::from_secs(45) {
            for vk in 1..=254u16 {
                // Mouse buttons are not keys.
                if matches!(vk, 0x01 | 0x02 | 0x04 | 0x05 | 0x06) {
                    continue;
                }
                let down = unsafe { GetAsyncKeyState(i32::from(vk)) } as u16 & 0x8000 != 0;
                if down != held[usize::from(vk)] {
                    held[usize::from(vk)] = down;
                    println!("{:5.1}s vk {vk:#04x} {}", start.elapsed().as_secs_f32(), if down { "DOWN" } else { "up" });
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let device = VendorDevice::open_model(&NAGA_V3_PRO).expect("reopen");
        for (button, record) in saved {
            write_bank(&device, LIVE_BANK, button, 0, record).unwrap();
        }
        println!("records put back");
    }

    /// Hardware, interactive — **close every Sidearm first** (a running one
    /// repairs the live map). Needs two banks on the V3. Thumb 12 only; its
    /// record in the live map and in both banks is saved and put back, also on
    /// a panic. Answers the questions a "Sidearm bank" depends on:
    /// 1. does writing the playing bank also change the live map;
    /// 2. does a consumer record play from a stored bank (volume up);
    /// 3. does a bank switch under a held button strand its key.
    ///
    /// Run: `cargo test v3_bank_probes -- --ignored --nocapture --test-threads=1`.
    #[test]
    #[ignore]
    fn v3_bank_probes() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_F24};
        const THUMB_12: u8 = 0x4b;
        const VOLUME_UP: u16 = 0x00e9;
        let f24_down = || unsafe { GetAsyncKeyState(i32::from(VK_F24)) } as u16 & 0x8000 != 0;
        let enter = |what: &str| {
            println!("\n>>> {what}\n    then press Enter here");
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            line.trim().to_lowercase()
        };
        let watch_f24 = |seconds: u64| {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
            let mut seen = false;
            while std::time::Instant::now() < until {
                seen |= f24_down();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            seen
        };
        let device = VendorDevice::open_model(&NAGA_V3_PRO).expect("turn the V3 on");
        let banks = read_banks(&device).expect("banks");
        let (a, b) = (banks.active, *banks.assigned.iter().find(|&&bank| bank != banks.active).expect("the V3 needs a second bank"));
        println!("playing bank {a}, other bank {b}, assigned {:?}", banks.assigned);
        let saved = [LIVE_BANK, a, b].map(|bank| (bank, device.read_block(bank, THUMB_12, 0).unwrap()));
        println!("saved thumb 12: {saved:02x?}");

        /// Puts thumb 12 back and bank `a` playing, whatever happened.
        struct Restore(VendorDevice, [(u8, [u8; 7]); 3], u8);
        impl Drop for Restore {
            fn drop(&mut self) {
                let Restore(device, saved, a) = self;
                for &(bank, record) in &saved[1..] {
                    if let Err(error) = device.set_block(bank, THUMB_12, 0, &record) {
                        println!("!! bank {bank} not put back: {error}");
                    }
                }
                if let Err(error) = select_bank(device, *a) {
                    println!("!! bank {a} not reselected: {error}");
                }
                if let Err(error) = device.set_block(LIVE_BANK, THUMB_12, 0, &saved[0].1) {
                    println!("!! live record not put back: {error}");
                }
                println!("thumb 12 put back: live {:02x?}, bank {a} {:02x?}", device.read_block(LIVE_BANK, THUMB_12, 0), device.read_block(*a, THUMB_12, 0));
            }
        }
        let guard = Restore(device, saved, a);
        let device = &guard.0;

        // 1. The playing bank's record written: does the live map follow?
        let f24 = OnboardAction::Key { modifier: 0, usage: 0x73 };
        write_bank(device, a, THUMB_12, 0, bank_block(a, f24)).unwrap();
        let live = device.read_block(LIVE_BANK, THUMB_12, 0).unwrap();
        println!("1. live record after writing bank {a}: {live:02x?} (changed: {})", live != saved[0].1);
        enter("1. Press thumb 12 a few times within 8 s after Enter");
        println!("1. F24 played (the live map follows the playing bank's flash): {}", watch_f24(8));

        // 2. A consumer record stored in bank b, played after switching to it.
        write_bank(device, b, THUMB_12, 0, block(OnboardAction::Consumer(VOLUME_UP))).unwrap();
        select_bank(device, b).unwrap();
        println!("2. live record after selecting bank {b}: {:02x?}", device.read_block(LIVE_BANK, THUMB_12, 0).unwrap());
        let answer = enter("2. Press thumb 12 twice: does the volume go up? Type y or n");
        println!("2. consumer record plays from a stored bank: {answer}");

        // 3. Back on bank a (thumb 12 = F24 there): switch to b while it is held.
        select_bank(device, a).unwrap();
        enter("3. HOLD thumb 12 down and keep holding; with the other hand");
        let held = f24_down();
        select_bank(device, b).unwrap();
        enter("3. Now RELEASE thumb 12, wait a second");
        let stranded = f24_down();
        println!("3. F24 down while held: {held}; still down after the release (stranded): {stranded}");
        if stranded {
            // Windows' own key state: the firmware sent the new record's release.
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput};
            let up = INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_F24, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } };
            // SAFETY: one initialised INPUT of the size passed.
            unsafe { SendInput(1, &up, std::mem::size_of::<INPUT>() as i32) };
            println!("3. F24 released by hand");
        }
        drop(guard);
    }

    /// Hardware, interactive — **close every Sidearm first**. Needs a free
    /// bank slot on the V3. Answers what a Sidearm-owned bank depends on
    /// (`plans/sidearm-bank/plan.md`, П0):
    /// 1. what `05:02` (assign a free slot) leaves in the new bank;
    /// 2. does a consumer record played from that bank reach Windows (volume up);
    /// 3. the new bank's DPI and LED colour;
    /// 4. does `05:03` (unassign) remove it, and a select of it is refused.
    ///
    /// Only the new bank is written. The old bank is reselected, the new one
    /// unassigned and the live thumb 12 put back, also on a panic.
    /// Run: `cargo test v3_sidearm_bank_probes -- --ignored --nocapture --test-threads=1`.
    #[test]
    #[ignore]
    fn v3_sidearm_bank_probes() {
        const THUMB_12: u8 = 0x4b;
        const VOLUME_UP: u16 = 0x00e9;
        let enter = |what: &str| {
            println!("\n>>> {what}\n    then press Enter here");
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            line.trim().to_lowercase()
        };
        let device = VendorDevice::open_model(&NAGA_V3_PRO).expect("turn the V3 on");
        let before = read_banks(&device).expect("banks");
        let free = (1..=MAX_BANKS).find(|bank| !before.assigned.contains(bank)).expect("the V3 needs a free bank slot");
        println!("banks before: {before:?}; free slot {free}");
        let saved_live = device.read_block(LIVE_BANK, THUMB_12, 0).expect("live thumb 12");

        /// Reselects the old bank, unassigns the probe bank, puts live thumb 12 back.
        struct Restore(VendorDevice, u8, u8, [u8; 7]);
        impl Drop for Restore {
            fn drop(&mut self) {
                let Restore(device, old, free, live) = self;
                if read_banks(device).is_ok_and(|banks| banks.active != *old)
                    && let Err(error) = select_bank(device, *old)
                {
                    println!("!! bank {old} not reselected: {error}");
                }
                if read_banks(device).is_ok_and(|banks| banks.assigned.contains(free))
                    && let Err(error) = device.command(CLASS_BANKS, 0x03, &[*free])
                {
                    println!("!! bank {free} not unassigned: {error}");
                }
                if let Err(error) = device.set_block(LIVE_BANK, THUMB_12, 0, live) {
                    println!("!! live thumb 12 not put back: {error}");
                }
                println!("restored: banks {:?}, live thumb 12 {:02x?}", read_banks(device), device.read_block(LIVE_BANK, THUMB_12, 0));
            }
        }
        let guard = Restore(device, before.active, free, saved_live);
        let device = &guard.0;
        let addresses: Vec<u8> = controls(&NAGA_V3_PRO).iter().map(|&(_, id)| id).collect();
        let dump = |bank: u8| -> Vec<(u8, u8, Result<[u8; 7], String>)> {
            addresses.iter().flat_map(|&id| [0, 1].map(|layer| (id, layer, device.read_block(bank, id, layer)))).collect()
        };
        let live_before = dump(LIVE_BANK);

        // 1. Assign the free slot; what is in it, and did anything else move?
        let reply = device.command(CLASS_BANKS, 0x02, &[free]);
        println!("1. 05:02 {free}: {:02x?}", reply.as_ref().map(|r| &r[..12]));
        let after = read_banks(device);
        println!("1. banks after: {after:?}");
        assert!(after.as_ref().is_ok_and(|banks| banks.assigned.contains(&free)), "05:02 did not assign bank {free}");
        let playing = dump(before.active);
        let fresh = dump(free);
        let same_as_playing = fresh.iter().zip(&playing).filter(|(a, b)| a.2.is_ok() && a.2 == b.2).count();
        println!("1. new bank {free}: {same_as_playing} of {} records equal the playing bank's", fresh.len());
        for (id, layer, record) in &fresh {
            println!("   {id:#04x}/{layer}: {record:02x?}");
        }
        let live_moved = dump(LIVE_BANK).iter().zip(&live_before).filter(|(a, b)| a.2 != b.2).count();
        println!("1. live map records changed by 05:02: {live_moved}");
        let dpi_reply = device.command(0x04, 0x85, &[free, 0, 0, 0, 0, 0, 0]);
        println!("3. new bank DPI reply bytes 8..13: {:02x?}", dpi_reply.as_ref().map(|r| &r[8..13]));

        // 2. A consumer record in the new bank, played after selecting it.
        write_bank(device, free, THUMB_12, 0, block(OnboardAction::Consumer(VOLUME_UP))).unwrap();
        select_bank(device, free).unwrap();
        println!("2. live thumb 12 after selecting bank {free}: {:02x?}", device.read_block(LIVE_BANK, THUMB_12, 0));
        let volume = enter("2. Press thumb 12 twice: does the volume go up? Type y or n");
        println!("2. consumer record from a stored bank reaches Windows: {volume}");
        let colour = enter(&format!("3. What colour is the V3's bottom LED now (bank {free})? Type it"));
        println!("3. LED colour of the new bank: {colour}");

        // 4. Back to the old bank, then unassign the new one.
        select_bank(device, before.active).unwrap();
        let reply = device.command(CLASS_BANKS, 0x03, &[free]);
        println!("4. 05:03 {free}: {:02x?}", reply.as_ref().map(|r| &r[..12]));
        println!("4. banks after unassign: {:?}", read_banks(device));
        println!("4. select of the unassigned bank: {:?}", device.command(CLASS_BANKS, CMD_SELECT_BANK, &[free]).map(|r| r[..12].to_vec()));
        println!("4. active after that select: {:?}", active_bank(device));
        drop(guard);
    }

    /// Stage 3 P0 hardware probe: verifies on a real Naga V3 Pro that a single
    /// onboard bank can hold BOTH native key records (thumb 12 L0 = F24, L1 = Ctrl+C)
    /// and silent consumer signals (thumb 11 L0/L1) alongside firmware HyperShift
    /// (0x39), that `select_bank` loads all of them into `LIVE_BANK` cleanly and
    /// switches back and forth fast, and that restoring the original bank + deleting
    /// the temporary bank (`05:03`) leaves the mouse unchanged (even on panic).
    /// Non-interactive by default; set `SIDEARM_PROBE_INTERACTIVE=1` to also prompt
    /// for manual button presses.
    /// Run: `cargo test --manifest-path src-tauri/Cargo.toml v3_hybrid_bank_probe -- --ignored --nocapture --test-threads=1`.
    #[test]
    #[ignore]
    fn v3_hybrid_bank_probe() {
        const THUMB_11: u8 = 0x4a;
        const THUMB_12: u8 = 0x4b;
        const RING_TRIGGER: u8 = 0x39;
        const USAGE_F24: u8 = 0x73;
        const USAGE_C: u8 = 0x06;
        const CONSUMER_L0: u16 = 0x0010;
        const CONSUMER_L1: u16 = 0x0011;
        let interactive = std::env::var_os("SIDEARM_PROBE_INTERACTIVE").is_some();

        let device = VendorDevice::open_model(&NAGA_V3_PRO).expect("turn the V3 Pro on");
        let before = read_banks(&device).expect("read banks");
        let free = (1..=MAX_BANKS)
            .find(|bank| !before.assigned.contains(bank))
            .expect("the V3 Pro needs at least one free bank slot (out of 5)");
        println!("banks before: {before:?}; allocating temporary probe slot {free}");
        let saved_live_11_0 = device.read_block(LIVE_BANK, THUMB_11, 0).expect("live thumb 11 L0");
        let saved_live_11_1 = device.read_block(LIVE_BANK, THUMB_11, 1).expect("live thumb 11 L1");
        let saved_live_12_0 = device.read_block(LIVE_BANK, THUMB_12, 0).expect("live thumb 12 L0");
        let saved_live_12_1 = device.read_block(LIVE_BANK, THUMB_12, 1).expect("live thumb 12 L1");

        struct RestoreHybrid(VendorDevice, u8, u8, [(u8, u8, [u8; 7]); 4]);
        impl Drop for RestoreHybrid {
            fn drop(&mut self) {
                let RestoreHybrid(device, old, free, saved) = self;
                if read_banks(device).is_ok_and(|banks| banks.active != *old)
                    && let Err(error) = select_bank(device, *old)
                {
                    println!("!! bank {old} not reselected: {error}");
                }
                if read_banks(device).is_ok_and(|banks| banks.assigned.contains(free))
                    && let Err(error) = delete_bank(device, *free)
                {
                    println!("!! bank {free} not deleted: {error}");
                }
                for (btn, layer, rec) in saved {
                    let _ = device.set_block(LIVE_BANK, *btn, *layer, rec);
                }
                println!("restored: banks {:?}", read_banks(device));
            }
        }
        let guard = RestoreHybrid(
            device,
            before.active,
            free,
            [
                (THUMB_11, 0, saved_live_11_0),
                (THUMB_11, 1, saved_live_11_1),
                (THUMB_12, 0, saved_live_12_0),
                (THUMB_12, 1, saved_live_12_1),
            ],
        );
        let device = &guard.0;

        create_bank(device, free).expect("create probe bank");
        let want_12_0 = bank_block(free, OnboardAction::Key { modifier: 0, usage: USAGE_F24 });
        let want_12_1 = bank_block(free, OnboardAction::Key { modifier: 0x01, usage: USAGE_C });
        let want_11_0 = bank_block(free, OnboardAction::Consumer(CONSUMER_L0));
        let want_11_1 = bank_block(free, OnboardAction::Consumer(CONSUMER_L1));
        let want_hs = bank_block(free, OnboardAction::Hypershift);

        write_bank(device, free, THUMB_12, 0, want_12_0).expect("write native F24 to thumb 12 L0");
        write_bank(device, free, THUMB_12, 1, want_12_1).expect("write native Ctrl+C to thumb 12 L1");
        write_bank(device, free, THUMB_11, 0, want_11_0).expect("write consumer L0 to thumb 11");
        write_bank(device, free, THUMB_11, 1, want_11_1).expect("write consumer L1 to thumb 11");
        write_bank(device, free, RING_TRIGGER, 0, want_hs).expect("write firmware HS L0");
        write_bank(device, free, RING_TRIGGER, 1, want_hs).expect("write firmware HS L1");

        let t0 = std::time::Instant::now();
        select_bank(device, free).expect("select hybrid probe bank");
        let switch_to_hybrid_ms = t0.elapsed().as_millis();

        let live_11_0 = device.read_block(LIVE_BANK, THUMB_11, 0).expect("live thumb 11 L0");
        let live_11_1 = device.read_block(LIVE_BANK, THUMB_11, 1).expect("live thumb 11 L1");
        let live_12_0 = device.read_block(LIVE_BANK, THUMB_12, 0).expect("live thumb 12 L0");
        let live_12_1 = device.read_block(LIVE_BANK, THUMB_12, 1).expect("live thumb 12 L1");
        let live_hs = device.read_block(LIVE_BANK, RING_TRIGGER, 0).expect("live ring trigger L0");
        println!("selected hybrid bank {free} in {switch_to_hybrid_ms} ms");
        println!("  live thumb 11 L0 (consumer 0x0010): {live_11_0:02x?}");
        println!("  live thumb 11 L1 (consumer 0x0011): {live_11_1:02x?}");
        println!("  live thumb 12 L0 (native F24):      {live_12_0:02x?}");
        println!("  live thumb 12 L1 (native Ctrl+C):   {live_12_1:02x?}");
        println!("  live ring 0x39 L0 (hypershift):     {live_hs:02x?}");

        assert_eq!(live_11_0, want_11_0, "thumb 11 L0 consumer mismatch");
        assert_eq!(live_11_1, want_11_1, "thumb 11 L1 consumer mismatch");
        assert_eq!(live_12_0, want_12_0, "thumb 12 L0 F24 mismatch");
        assert_eq!(live_12_1, want_12_1, "thumb 12 L1 Ctrl+C mismatch");
        assert_eq!(live_hs, want_hs, "ring trigger hypershift mismatch");

        if interactive {
            println!("\n>>> Press thumb 11 and thumb 12 if desired, then press Enter:");
            let mut line = String::new();
            let _ = std::io::stdin().read_line(&mut line);
        }

        let t1 = std::time::Instant::now();
        select_bank(device, before.active).expect("reselect original bank");
        let switch_back_ms = t1.elapsed().as_millis();
        let t2 = std::time::Instant::now();
        select_bank(device, free).expect("reselect hybrid bank (2nd switch)");
        let switch_again_ms = t2.elapsed().as_millis();
        select_bank(device, before.active).expect("reselect original bank (final)");
        println!("switch timings: to_hybrid={switch_to_hybrid_ms} ms, back={switch_back_ms} ms, again={switch_again_ms} ms");

        delete_bank(device, free).expect("delete temporary probe bank");
        for (btn, layer, rec) in &guard.3 {
            write_bank(device, LIVE_BANK, *btn, *layer, *rec).expect("restore live probe record");
        }
        let after = read_banks(device).expect("banks after cleanup");
        assert_eq!(after.assigned, before.assigned, "bank inventory restored");
        assert_eq!(after.active, before.active, "active bank restored");
        drop(guard);
        println!("v3_hybrid_bank_probe PASSED cleanly.");
    }

    /// Deferred V2 hardware check: verifies whether the Naga V2 HyperSpeed
    /// accepts and echoes an inert `Consumer(0)` record on live map thumb 12,
    /// restoring the original record in `Drop`. Skips cleanly if V2 is asleep.
    #[test]
    #[ignore]
    fn v2_consumer_zero_probe() {
        const THUMB_12: u8 = 0x4b;
        let Ok(device) = VendorDevice::open_model(&NAGA_V2_HYPERSPEED) else {
            println!("v2_consumer_zero_probe: V2 not connected (skipped)");
            return;
        };
        let saved = match device.read_block(LIVE_BANK, THUMB_12, 0) {
            Ok(rec) => rec,
            Err(error) if crate::mouse_memory::is_no_response(&error) => {
                println!("v2_consumer_zero_probe: V2 asleep (skipped): {error}");
                return;
            }
            Err(error) => panic!("read V2 live thumb 12: {error}"),
        };
        struct RestoreV2(VendorDevice, [u8; 7]);
        impl Drop for RestoreV2 {
            fn drop(&mut self) {
                let _ = self.0.set_block(LIVE_BANK, THUMB_12, 0, &self.1);
                println!("v2_consumer_zero_probe restored live thumb 12: {:02x?}", self.0.read_block(LIVE_BANK, THUMB_12, 0));
            }
        }
        let guard = RestoreV2(device, saved);
        let target = block(OnboardAction::Consumer(0));
        write_bank(&guard.0, LIVE_BANK, THUMB_12, 0, target).expect("V2 rejected Consumer(0) record");
        let readback = guard.0.read_block(LIVE_BANK, THUMB_12, 0).expect("read back V2 Consumer(0)");
        println!("v2_consumer_zero_probe: wrote {target:02x?}, read back {readback:02x?}");
        assert_eq!(readback, target, "V2 Consumer(0) readback mismatch");
        write_bank(&guard.0, LIVE_BANK, THUMB_12, 0, saved).expect("restore V2 live thumb 12");
        assert_eq!(guard.0.read_block(LIVE_BANK, THUMB_12, 0).expect("verify restored V2 thumb 12"), saved);
        drop(guard);
        println!("v2_consumer_zero_probe PASSED cleanly.");
    }

    /// A V3 with banks 1 and 2 (bank 1 playing at 1100 DPI) and the seed
    /// config's live targets.
    fn sidearm_bank_mouse() -> (crate::mouse_memory::fake::FakeMouse, Vec<(u8, u8, OnboardAction)>) {
        let mut mouse = crate::mouse_memory::fake::FakeMouse { banks: vec![1, 2], active_bank: 1, ..Default::default() };
        for (index, (button, layer)) in bank_addresses(&NAGA_V3_PRO).into_iter().enumerate() {
            mouse.records.insert((1, button, layer), block(OnboardAction::Key { modifier: 0, usage: 0x04 + index as u8 }));
        }
        mouse.dpi.insert(1, 1100);
        (mouse, overlay(&config_with_v3(), &NAGA_V3_PRO, BOTH, true, false).unwrap().targets)
    }

    #[test]
    fn the_sidearm_bank_takes_the_last_free_slot_with_the_base_under_its_signals() {
        use crate::mouse_memory::fake;
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        assert_eq!(claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap(), Some((5, 1)));
        fake::with(|mouse| {
            assert_eq!(mouse.banks, vec![1, 2, 5]);
            assert_eq!(mouse.dpi.get(&5), Some(&1100));
            for (button, layer) in bank_addresses(&NAGA_V3_PRO) {
                let wanted = targets.iter().find(|&&(b, l, _)| (b, l) == (button, layer))
                    .map_or(mouse.records[&(1, button, layer)], |&(_, _, action)| bank_block(5, action));
                assert_eq!(mouse.records.get(&(5, button, layer)), Some(&wanted), "{button:#04x}/{layer}");
            }
        });
        assert_eq!(sidearm_bank(&device, &read_banks(&device).unwrap()).unwrap(), Some(5));
        // A second start finds it again and writes nothing.
        fake::with(|mouse| mouse.writes.clear());
        assert_eq!(claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap(), Some((5, 1)));
        fake::with(|mouse| assert!(mouse.writes.is_empty(), "{:?}", mouse.writes));
    }

    #[test]
    fn claim_sidearm_bank_relocates_legacy_slot_to_last_slot_when_free() {
        use crate::mouse_memory::fake;
        let (mut mouse, targets) = sidearm_bank_mouse();
        // Simulate an older version that claimed Slot 2 while Slot 5 is free, and the mouse is playing Slot 2.
        mouse.banks = vec![1, 2, 3];
        mouse.active_bank = 2;
        for (button, layer) in bank_addresses(&NAGA_V3_PRO) {
            let wanted = targets
                .iter()
                .find(|&&(b, l, _)| (b, l) == (button, layer))
                .map_or(mouse.records[&(1, button, layer)], |&(_, _, action)| bank_block(2, action));
            mouse.records.insert((2, button, layer), wanted);
        }
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        assert_eq!(sidearm_bank(&device, &read_banks(&device).unwrap()).unwrap(), Some(2));
        assert_eq!(claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap(), Some((5, 1)));
        fake::with(|mouse| {
            assert_eq!(mouse.banks, vec![1, 3, 5], "legacy slot 2 freed and relocated to slot 5");
            assert_eq!(mouse.active_bank, 5, "mouse switched to slot 5 before deleting slot 2");
        });
        assert_eq!(sidearm_bank(&device, &read_banks(&device).unwrap()).unwrap(), Some(5));
    }

    #[test]
    fn a_bank_with_one_record_of_the_users_is_not_sidearms() {
        use crate::mouse_memory::fake;
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap();
        // The user's own F13 on thumb 12 of that bank (a Synapse copy, say).
        fake::with(|mouse| { mouse.records.insert((5, 0x4b, 0), block(OnboardAction::Key { modifier: 0, usage: 0x68 })); });
        assert_eq!(sidearm_bank(&device, &read_banks(&device).unwrap()).unwrap(), None);
    }

    #[test]
    fn every_slot_taken_leaves_the_mouse_alone() {
        use crate::mouse_memory::fake;
        let (mut mouse, targets) = sidearm_bank_mouse();
        mouse.banks = vec![1, 2, 3, 4, 5];
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        assert_eq!(claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap(), None);
        fake::with(|mouse| {
            assert_eq!(mouse.banks, vec![1, 2, 3, 4, 5]);
            assert!(mouse.writes.is_empty());
        });
    }

    #[test]
    fn an_offline_only_record_plays_its_original_in_the_sidearm_bank() {
        use crate::mouse_memory::fake;
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        // An exit stored an offline-only wheel-down record in bank 1.
        let wheel_down = OnboardAction::Key { modifier: 1, usage: 6 };
        let native = fake::with(|mouse| mouse.records[&(1, 0x0a, 0)]);
        apply_bank(&device, 1, &bank_backup(dir.path(), &NAGA_V3_PRO, 1), &[(0x0a, 0, wheel_down)]).unwrap();
        assert!(!targets.iter().any(|&(button, _, _)| button == 0x0a), "the seed config leaves wheel down alone live");
        claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap();
        fake::with(|mouse| assert_eq!(mouse.records[&(5, 0x0a, 0)], native));
    }

    #[test]
    fn the_sidearm_bank_is_never_a_profiles_bank_nor_the_one_to_exit_to() {
        use crate::mouse_memory::fake;
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap();
        select_bank(&device, 5).unwrap();
        let (banks, sidearm) = user_banks(&device).unwrap();
        assert_eq!((banks.assigned.clone(), banks.active, sidearm), (vec![1, 2], 5, Some(5)));
        let v3_cfg = config_with_v3();
        let offline = crate::mouse_offline::offline_profile_id(&v3_cfg, None);
        assert_eq!(exit_bank(&v3_cfg, &bank_plan(&v3_cfg, &NAGA_V3_PRO, &banks, &offline), &banks, &offline), Some(1));
    }

    #[test]
    fn a_stopped_sidearm_on_its_bank_is_put_back_on_the_base() {
        use crate::mouse_memory::fake;
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        fake::set_present_models(vec![&NAGA_V3_PRO]);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap();
        select_bank(&device, 5).unwrap();
        drop(device);
        let marker = in_sidearm_bank_marker(dir.path(), &NAGA_V3_PRO);
        std::fs::write(&marker, "5").unwrap();
        // The restorer of a killed Sidearm: no config next to it, so the first
        // bank of the user's.
        assert!(restore_orphaned(dir.path()));
        fake::with(|mouse| assert_eq!(mouse.active_bank, 1));
        assert!(!marker.exists());
        // Without the marker nothing is asked of the mouse.
        fake::with(|mouse| { mouse.active_bank = 5; mouse.asked = 0; });
        assert!(restore_orphaned(dir.path()));
        fake::with(|mouse| assert_eq!((mouse.active_bank, mouse.asked), (5, 0)));
    }

    #[test]
    fn a_store_while_sidearm_runs_writes_the_banks_and_selects_nothing() {
        use crate::mouse_memory::fake;
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let mut config = config_with_v3();
        let profile = config.settings.fallback_profile_id.clone();
        config.profiles.iter_mut().find(|p| p.id == profile).unwrap().device_slots = Some([(NAGA_V3_PRO.device_id.to_owned(), 1)].into());
        claim_sidearm_bank(&device, &config, &targets, dir.path()).unwrap();
        select_bank(&device, 5).unwrap();
        fake::with(|mouse| { mouse.poll_code = 2; mouse.writes.clear(); });
        store_banks(&device, &config, &NAGA_V3_PRO, &profile, dir.path(), false).unwrap();
        fake::with(|mouse| {
            assert_eq!(mouse.active_bank, 5, "Sidearm's bank keeps playing");
            assert_eq!(mouse.poll_code, 2, "the live speed is left alone");
            assert!(mouse.writes.iter().all(|&(bank, _, _)| bank == 1), "only bank 1 is written: {:?}", mouse.writes);
        });
    }

    #[test]
    fn the_store_fingerprint_follows_what_a_bank_gets() {
        use crate::mouse_memory::fake;
        let (mouse, _) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let mut config = config_with_v3();
        let profile = config.settings.fallback_profile_id.clone();
        config.profiles.iter_mut().find(|p| p.id == profile).unwrap().device_slots = Some([(NAGA_V3_PRO.device_id.to_owned(), 1)].into());
        let banks = Banks { assigned: vec![1, 2], active: 1 };
        let key = store_key(&config, &NAGA_V3_PRO, &banks, &profile);
        assert_eq!(key, store_key(&config.clone(), &NAGA_V3_PRO, &banks, &profile));
        let mut faster = config.clone();
        faster.profiles.iter_mut().find(|p| p.id == profile).unwrap().device_mouse = Some([(
            NAGA_V3_PRO.device_id.to_owned(),
            crate::config::MouseOverrides { mouse_dpi: Some(2400), ..Default::default() },
        )].into());
        assert_ne!(key, store_key(&faster, &NAGA_V3_PRO, &banks, &profile));
    }

    #[test]
    fn giving_the_bank_back_leaves_it_and_frees_the_slot() {
        use crate::mouse_memory::fake;
        let _v3 = V3_GLOBAL_STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        fake::set_present_models(vec![&NAGA_V3_PRO]);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap();
        select_bank(&device, 5).unwrap();
        drop(device);
        assert!(release_sidearm_bank(&NAGA_V3_PRO, dir.path()).unwrap());
        fake::with(|mouse| assert_eq!((mouse.banks.clone(), mouse.active_bank), (vec![1, 2], 1)));
        // Nothing left to give back.
        assert!(!release_sidearm_bank(&NAGA_V3_PRO, dir.path()).unwrap());
    }

    #[test]
    fn leaving_goes_back_to_the_bank_that_played_before_sidearms() {
        use crate::mouse_memory::fake;
        let (mut mouse, targets) = sidearm_bank_mouse();
        mouse.active_bank = 2;
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        // No profile is linked to a bank: only the marker knows bank 2 played.
        let (bank, base) = claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap().unwrap();
        assert_eq!((bank, base), (5, 2));
        mark_in_sidearm_bank(dir.path(), &NAGA_V3_PRO, bank, base);
        select_bank(&device, bank).unwrap();
        leave_sidearm_bank(&device, None, dir.path()).unwrap();
        fake::with(|mouse| assert_eq!(mouse.active_bank, 2));
    }

    #[test]
    fn a_slot_that_could_not_be_filled_is_given_back() {
        use crate::mouse_memory::fake;
        let (mut mouse, targets) = sidearm_bank_mouse();
        // Record writes refused (the button class's set command); the rest answers.
        mouse.refused = vec![(0x02, 0x0c)];
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        assert!(claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).is_err());
        fake::with(|mouse| assert_eq!(mouse.banks, vec![1, 2], "no half-filled slot is left taken"));
    }

    #[test]
    fn an_exit_writes_the_playing_bank_only_while_sidearms_bank_plays() {
        use crate::mouse_memory::fake;
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let mut config = config_with_v3();
        let profile = config.settings.fallback_profile_id.clone();
        config.profiles.iter_mut().find(|p| p.id == profile).unwrap().device_slots = Some([(NAGA_V3_PRO.device_id.to_owned(), 1)].into());
        // A DPI no other test uses: its own store fingerprint (STORED is shared).
        config.profiles.iter_mut().find(|p| p.id == profile).unwrap().device_mouse = Some([(
            NAGA_V3_PRO.device_id.to_owned(),
            crate::config::MouseOverrides { mouse_dpi: Some(1234), ..Default::default() },
        )].into());
        STORED[NAGA_V3_PRO.catalog_index()].store(0, Ordering::Release);
        // A shortcut on thumb 3, so the offline profile has a record to write.
        let shortcut = config.actions.iter().find(|action| action.action_type == ActionType::Shortcut).unwrap().id.clone();
        config.bindings.push(crate::config::Binding {
            id: "v3-shortcut".into(),
            profile_id: profile.clone(),
            control_id: control_id(&NAGA_V3_PRO, "thumb_03"),
            layer: Layer::Standard,
            action_id: shortcut,
            ..config.bindings.last().unwrap().clone()
        });
        claim_sidearm_bank(&device, &config, &targets, dir.path()).unwrap();
        // The session already left Sidearm's bank: bank 1 plays and gets the profile.
        fake::with(|mouse| { mouse.active_bank = 1; mouse.playing_writes = 0; mouse.writes.clear(); });
        store_banks(&device, &config, &NAGA_V3_PRO, &profile, dir.path(), true).unwrap();
        fake::with(|mouse| {
            assert!(mouse.writes.iter().any(|&(bank, _, _)| bank == 1), "bank 1 is written");
            assert_eq!(mouse.playing_writes, 0, "never while it plays");
            assert_eq!(mouse.active_bank, 1, "and it plays again afterwards");
        });
    }

    #[test]
    fn leaving_after_the_profile_button_keeps_the_users_bank() {
        use crate::mouse_memory::fake;
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        claim_sidearm_bank(&device, &config_with_v3(), &targets, dir.path()).unwrap();
        // The profile button took the mouse to bank 2 while Sidearm ran.
        select_bank(&device, 2).unwrap();
        leave_sidearm_bank(&device, Some(&config_with_v3()), dir.path()).unwrap();
        fake::with(|mouse| assert_eq!(mouse.active_bank, 2));
    }

    /// Hardware, read-only — **close Sidearm first**. Prints every record of the
    /// live map and each bank of the V3 (diagnosing a bank that plays wrong).
    /// Run: `cargo test v3_dump_banks -- --ignored --nocapture --test-threads=1`.
    #[test]
    #[ignore]
    fn v3_dump_banks() {
        let device = VendorDevice::open_model(&NAGA_V3_PRO).expect("turn the V3 on");
        let banks = read_banks(&device).expect("banks");
        println!("banks {banks:?}, Sidearm's {:?}", sidearm_bank(&device, &banks));
        for bank in std::iter::once(LIVE_BANK).chain(banks.assigned.iter().copied()) {
            println!("== bank {bank}");
            for (button, layer) in bank_addresses(&NAGA_V3_PRO) {
                println!("   {button:#04x}/{layer}: {:02x?}", device.read_block(bank, button, layer));
            }
        }
    }

    const V3_PATH: &str = r"\\?\hid#vid_1532&pid_00e8&mi_00#x";

    #[test]
    fn offline_only_wheel_is_restored_reversibly_during_live_use() {
        use crate::mouse_memory::fake::{self, FakeMouse};
        for offline in [OnboardAction::Key { modifier: 1, usage: 6 }, OnboardAction::Consumer(USAGES[42])] {
            // Bank 2 plays, so selecting bank 1 below reloads the live map.
            let _fake = fake::install(FakeMouse { banks: vec![1, 2], active_bank: 2, ..Default::default() });
            let dir = tempfile::tempdir().unwrap();
            let config = config_with_v3();
            let live = overlay(&config, &NAGA_V3_PRO, BOTH, true, false).unwrap().targets;
            assert!(!live.iter().any(|&(button, _, _)| button == 0x0a));
            let native = block(OnboardAction::Mouse(10));
            fake::with(|mouse| {
                mouse.records.insert((1, 0x0a, 0), native);
                mouse.records.insert((LIVE_BANK, 0x0a, 0), native);
            });
            let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
            let stored = bank_backup(dir.path(), &NAGA_V3_PRO, 1);
            apply_bank(&device, 1, &stored, &[(0x0a, 0, offline)]).unwrap();
            select_bank(&device, 1).unwrap();
            let offline_block = bank_block(1, offline);
            assert_eq!(device.read_block(LIVE_BANK, 0x0a, 0).unwrap(), offline_block);
            let backup = live_backup(dir.path(), &NAGA_V3_PRO);
            let mut session = apply_bank(&device, LIVE_BANK, &backup, &live).unwrap();
            assert_eq!(device.read_block(LIVE_BANK, 0x0a, 0).unwrap(), native);
            let extra = session.records.iter().find(|record| record.button == 0x0a && record.layer == 0).unwrap();
            assert_eq!((extra.before, extra.target), (offline_block, native));
            assert_eq!(device.read_block(1, 0x0a, 0).unwrap(), offline_block, "stored bank is untouched");
            fake::with(|mouse| { mouse.records.insert((LIVE_BANK, 0x0a, 0), offline_block); });
            repair(&device, &backup, &mut session).unwrap();
            assert_eq!(device.read_block(LIVE_BANK, 0x0a, 0).unwrap(), native);
            apply_bank(&device, LIVE_BANK, &backup, &live).unwrap();
            assert_eq!(device.read_block(LIVE_BANK, 0x0a, 0).unwrap(), native, "reapplying keeps the restoration");
            restore_bank(&device, LIVE_BANK, &backup).unwrap();
            assert_eq!(device.read_block(LIVE_BANK, 0x0a, 0).unwrap(), offline_block);
            assert!(!backup.exists());
            assert!(stored.exists());
        }
    }

    #[test]
    fn v3_preview_decisions_match_exit_records_and_preserve_unbound_records() {
        use crate::{config::{Binding, Layer}, mouse_memory::fake::{self, FakeMouse}, mouse_offline::{self, OfflineKind}};
        let mut config = config_with_v3();
        let profile = config.profiles[0].id.clone();
        config.bindings.retain(|b| b.profile_id != profile);
        let key = config.actions.iter().find(|a| matches!(a.payload, crate::config::ActionPayload::Shortcut(_))).unwrap().id.clone();
        for (id, layer) in [("v3_wheel_down", Layer::Offline), ("v3_thumb_02", Layer::OfflineHypershift),
            ("v3_top_special_03", Layer::Offline), ("v3_mouse_left", Layer::Offline), ("v3_hypershift_button", Layer::Offline)] {
            config.bindings.push(Binding {
                id: format!("preview-{id}"), profile_id: profile.clone(), layer, control_id: ControlId::new(id), label: String::new(),
                action_id: key.clone(), enabled: true, color_tag: None, trigger_mode: None, chord_partner: None, throttle_ms: None,
            });
        }
        let _fake = fake::install(FakeMouse { banks: vec![1], active_bank: 1, ..Default::default() });
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let keep = bank_block(1, OnboardAction::Key { modifier: 0, usage: 0x1e });
        fake::with(|mouse| { mouse.records.insert((1, 0x40, 0), keep); });
        let banks = read_banks(&device).unwrap();
        let shown = mouse_offline::preview(&config, &NAGA_V3_PRO, &profile, Some(&banks));
        let planned = mouse_offline::plan(&config, &NAGA_V3_PRO, &profile);
        assert_eq!(shown.controls, planned.0.iter().map(|c| c.preview.clone()).collect::<Vec<_>>());
        assert_eq!(shown.target.state, mouse_offline::TargetState::Written);
        assert_eq!(shown.target.bank, Some(1));
        let dir = tempfile::tempdir().unwrap();
        store_banks(&device, &config, &NAGA_V3_PRO, &profile, dir.path(), true).unwrap();
        for record in planned.records() {
            assert_eq!(device.read_block(1, record.button_id, record.layer).unwrap(), bank_block(1, record.action));
        }
        assert_eq!(device.read_block(1, 0x40, 0).unwrap(), keep);
        assert_eq!(shown.controls.iter().find(|c| c.control_id == "v3_thumb_01" && c.layer == Layer::Offline).unwrap().kind, OfflineKind::Preserved);
    }

    #[test]
    fn preview_target_is_unknown_when_bank_inventory_sleeps_or_is_absent() {
        use crate::{mouse_memory::fake::{self, FakeMouse}, mouse_offline::{self, TargetState}};
        let _fake = fake::install(FakeMouse { asleep: true, ..Default::default() });
        let config = config_with_v3();
        for present in [vec![&NAGA_V3_PRO], vec![]] {
            fake::set_present_models(present);
            let inventory = banks(&NAGA_V3_PRO).ok();
            assert!(inventory.is_none());
            let preview = mouse_offline::preview(&config, &NAGA_V3_PRO, &config.profiles[0].id, inventory.as_ref());
            assert_eq!(preview.target.state, TargetState::Unknown);
            assert!(preview.target.bank.is_none());
        }
    }

    #[test]
    fn switching_banks_replans_uncovered_extras_from_the_new_banks_snapshot() {
        use crate::mouse_memory::fake::{self, FakeMouse};
        // Bank 2 plays, so selecting bank 1 below reloads the live map.
        let _fake = fake::install(FakeMouse { banks: vec![1, 2], active_bank: 2, ..Default::default() });
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let live = overlay(&config_with_v3(), &NAGA_V3_PRO, BOTH, true, false).unwrap().targets;
        let offline = OnboardAction::Key { modifier: 1, usage: 6 };
        for (bank, button, native) in [(1, 0x0a, 10), (2, 0x09, 9)] {
            fake::with(|mouse| { mouse.records.insert((bank, button, 0), block(OnboardAction::Mouse(native))); });
            apply_bank(&device, bank, &bank_backup(dir.path(), &NAGA_V3_PRO, bank), &[(button, 0, offline)]).unwrap();
        }
        select_bank(&device, 1).unwrap();
        let backup = live_backup(dir.path(), &NAGA_V3_PRO);
        let mut active = Some(apply_bank(&device, LIVE_BANK, &backup, &live).unwrap());
        assert_eq!(device.read_block(LIVE_BANK, 0x0a, 0).unwrap(), block(OnboardAction::Mouse(10)));
        select_bank(&device, 2).unwrap();
        forget_reloaded_map(&backup, &mut active).unwrap();
        assert!(active.is_none());
        assert!(snapshot_at(&backup).unwrap().is_empty());
        let snapshot = apply_bank(&device, LIVE_BANK, &backup, &live).unwrap();
        assert!(!snapshot.records.iter().any(|r| r.button == 0x0a));
        assert_eq!(device.read_block(LIVE_BANK, 0x09, 0).unwrap(), block(OnboardAction::Mouse(9)));
        restore_bank(&device, LIVE_BANK, &backup).unwrap();
        assert_eq!(device.read_block(LIVE_BANK, 0x09, 0).unwrap(), bank_block(2, offline));
    }

    fn snapshot_at(path: &Path) -> Option<Vec<Record>> {
        std::fs::read(path).ok().map(|bytes| serde_json::from_slice::<Snapshot>(&bytes).unwrap().records)
    }

    /// What the mouse holds, the rollback files left, how many commands it took.
    type FlowEnd = (std::collections::BTreeMap<(u8, u8, u8), [u8; 7]>, Vec<(String, Option<Vec<Record>>)>, usize);

    /// Runs `flow` on a copy of `start` (the fake's records) in a fresh copy of
    /// `files`.
    fn run_flow(start: &crate::mouse_memory::fake::FakeMouse, files: &[(String, Vec<u8>)], flow: impl FnOnce(&VendorDevice, &Path)) -> FlowEnd {
        use crate::mouse_memory::fake;
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in files {
            std::fs::write(dir.path().join(name), bytes).unwrap();
        }
        fake::with(|mouse| {
            *mouse = start.clone();
            mouse.asked = 0;
            mouse.writes.clear();
        });
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        flow(&device, dir.path());
        drop(device);
        let left = files
            .iter()
            .map(|(name, _)| name.clone())
            .chain(["razer-naga-v3-live.json".to_owned(), "razer-naga-v3-bank-1.json".to_owned()])
            .map(|name| {
                let records = snapshot_at(&dir.path().join(&name));
                (name, records)
            })
            .collect();
        fake::with(|mouse| (mouse.records.iter().map(|(&key, &block)| (key, block)).collect(), left, mouse.asked))
    }

    /// A live map left holding Sidearm's signals with its rollback file gone
    /// (an exit that left it to a bank reselect, 2026-11-14): the next session
    /// takes the playing bank's records as the originals, so its stop gives the
    /// buttons back instead of the silent signals.
    #[test]
    fn a_live_map_left_with_sidearms_signals_takes_the_playing_banks_records_as_originals() {
        use crate::mouse_memory::fake::{self, FakeMouse};
        let live = overlay(&config_with_v3(), &NAGA_V3_PRO, BOTH, true, false).unwrap().targets;
        let _fake = fake::install(FakeMouse::default());
        let mut mouse = FakeMouse { banks: vec![1, 2], active_bank: 2, poll_code: 1, ..Default::default() };
        for (index, &(button, layer, action)) in live.iter().enumerate() {
            mouse.records.insert((LIVE_BANK, button, layer), bank_block(LIVE_BANK, action));
            mouse.records.insert((2, button, layer), block(OnboardAction::Key { modifier: 0, usage: 0x04 + index as u8 }));
        }
        fake::with(|fake| *fake = mouse);
        let dir = tempfile::tempdir().unwrap();
        let backup = live_backup(dir.path(), &NAGA_V3_PRO);
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        apply_bank(&device, LIVE_BANK, &backup, &live).unwrap();
        restore_bank(&device, LIVE_BANK, &backup).unwrap();
        drop(device);
        let own: Vec<_> = live.iter().filter(|&&(button, layer, action)| is_own_signal(&NAGA_V3_PRO, button, layer, bank_block(LIVE_BANK, action))).collect();
        assert!(!own.is_empty());
        fake::with(|mouse| {
            for &&(button, layer, _) in &own {
                assert_eq!(mouse.records[&(LIVE_BANK, button, layer)], mouse.records[&(2, button, layer)], "{button:#04x}/{layer} plays bank 2's record again");
            }
        });
    }

    /// Rewriting a bank used to put every record Sidearm wrote there back first.
    /// A record that stays the same now keeps it: same records and the same
    /// rollback file, fewer commands — also with a record the user changed
    /// meanwhile and one odd read.
    #[test]
    fn rewriting_a_bank_ends_as_restoring_it_first() {
        use crate::mouse_memory::fake::{self, FakeMouse};
        let key = |usage| OnboardAction::Key { modifier: 0, usage };
        let first = [(0x40, 0, key(0x10)), (0x41, 0, key(0x11)), (0x42, 0, key(0x12)), (0x43, 1, key(0x13)), (0x44, 0, key(0x14))];
        // Same, changed, same (but the user changes it), dropped, same; and a new one.
        let second = [(0x40, 0, key(0x10)), (0x41, 0, key(0x21)), (0x42, 0, key(0x12)), (0x44, 0, key(0x14)), (0x45, 1, key(0x15))];
        let _fake = fake::install(FakeMouse::default());
        let (mut start, files) = {
            let mut mouse = FakeMouse { banks: vec![1], active_bank: 1, ..Default::default() };
            for (index, button) in (0x40..=0x45).enumerate() {
                for layer in [0, 1] {
                    mouse.records.insert((1, button, layer), block(key(0x30 + index as u8)));
                }
            }
            fake::with(|fake| *fake = mouse);
            let dir = tempfile::tempdir().unwrap();
            let backup = bank_backup(dir.path(), &NAGA_V3_PRO, 1);
            let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
            apply_bank(&device, 1, &backup, &first).unwrap();
            drop(device);
            let name = backup.file_name().unwrap().to_string_lossy().into_owned();
            (fake::with(|mouse| mouse.clone()), vec![(name, std::fs::read(&backup).unwrap())])
        };
        start.records.insert((1, 0x42, 0), block(key(0x55)));
        start.odd_once.insert((1, 0x40, 0), block(key(0x66)));
        let restored_first = run_flow(&start, &files, |device, dir| {
            let backup = bank_backup(dir, &NAGA_V3_PRO, 1);
            restore_bank(device, 1, &backup).unwrap();
            apply_bank(device, 1, &backup, &second).unwrap();
        });
        let kept = run_flow(&start, &files, |device, dir| {
            apply_bank(device, 1, &bank_backup(dir, &NAGA_V3_PRO, 1), &second).unwrap();
        });
        assert_eq!(kept.0, restored_first.0, "the mouse holds the same records");
        assert_eq!(kept.1, restored_first.1, "the rollback file holds the same originals");
        assert!(kept.2 < restored_first.2, "{} commands, not {}", kept.2, restored_first.2);
        let originals = kept.1.iter().find_map(|(name, records)| name.ends_with("-bank-1.json").then_some(records.clone())).flatten().unwrap();
        assert_eq!(originals.iter().find(|record| record.button == 0x42).unwrap().before, block(key(0x55)), "the user's change is the original now");
        assert_eq!(originals.iter().find(|record| record.button == 0x40).unwrap().before, block(key(0x30)));
    }

    #[test]
    fn a_rollback_file_follows_the_receiver_to_another_port() {
        let device = |path: &str| VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, path);
        let saved = r"\\?\HID#VID_1532&PID_00E8&MI_03#7&1a2b3c&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";
        assert!(same_receiver(saved, &device(r"\\?\hid#vid_1532&pid_00e8&mi_03#8&ffff&0&0000#{guid}")));
        assert!(!same_receiver(saved, &VendorDevice::test_handle(&NAGA_V2_HYPERSPEED, 0x00b4, "")));
    }

    fn hybrid_test_config() -> (AppConfig, String, String) {
        use crate::config::{
            Action, ActionCondition, ActionPayload, Binding, MouseOverrides, PasteMode, Profile,
            ShortcutActionPayload, TextSnippetPayload, TriggerMode,
        };
        let mut config = config_with_v3();
        let default_id = config.settings.fallback_profile_id.clone();
        let game_id = "profile-game".to_owned();
        config.profiles.push(Profile {
            id: game_id.clone(),
            name: "Game".into(),
            description: None,
            enabled: true,
            priority: 10,
            mouse_dpi: None,
            mouse_poll_rate_hz: None,
            mouse_dpi_stages: None,
            device_slots: Some([(NAGA_V3_PRO.device_id.to_owned(), 2)].into()),
            device_mouse: Some([(
                NAGA_V3_PRO.device_id.to_owned(),
                MouseOverrides { hardware_bank: Some(true), ..Default::default() },
            )].into()),
            hypershift2_triggers: Vec::new(),
        });
        config.profiles.iter_mut().find(|p| p.id == default_id).unwrap().device_slots =
            Some([(NAGA_V3_PRO.device_id.to_owned(), 1)].into());

        let act_copy = "act-copy".to_owned();
        let act_paste = "act-paste".to_owned();
        let act_text = "act-text".to_owned();
        let act_cond = "act-cond".to_owned();
        config.actions.extend([
            Action {
                id: act_copy.clone(),
                action_type: ActionType::Shortcut,
                display_name: "Copy".into(),
                payload: ActionPayload::Shortcut(ShortcutActionPayload { key: "C".into(), ctrl: true, shift: false, alt: false, win: false, raw: None }),
                conditions: Vec::new(),
                notes: None,
            },
            Action {
                id: act_paste.clone(),
                action_type: ActionType::Shortcut,
                display_name: "Paste".into(),
                payload: ActionPayload::Shortcut(ShortcutActionPayload { key: "V".into(), ctrl: true, shift: false, alt: false, win: false, raw: None }),
                conditions: Vec::new(),
                notes: None,
            },
            Action {
                id: act_text.clone(),
                action_type: ActionType::TextSnippet,
                display_name: "Hi".into(),
                payload: ActionPayload::TextSnippet(TextSnippetPayload::Inline { text: "hi".into(), paste_mode: PasteMode::SendText, tags: Vec::new(), press_enter: false }),
                conditions: Vec::new(),
                notes: None,
            },
            Action {
                id: act_cond.clone(),
                action_type: ActionType::Shortcut,
                display_name: "Cond Copy".into(),
                payload: ActionPayload::Shortcut(ShortcutActionPayload { key: "X".into(), ctrl: true, shift: false, alt: false, win: false, raw: None }),
                conditions: vec![ActionCondition::WindowTitleContains { value: "Game".into() }],
                notes: None,
            },
        ]);

        let mut add = |id: &str, ctrl: &str, layer: Layer, action: &str, trigger_mode: Option<TriggerMode>| {
            config.bindings.push(Binding {
                id: id.into(),
                profile_id: game_id.clone(),
                control_id: control_id(&NAGA_V3_PRO, ctrl),
                layer,
                action_id: action.into(),
                label: id.into(),
                enabled: true,
                trigger_mode,
                color_tag: None,
                chord_partner: None,
                throttle_ms: None,
            });
        };
        // thumb_01: native Ctrl+C on L0, native Ctrl+V on L1
        add("b-t1-l0", "thumb_01", Layer::Standard, &act_copy, None);
        add("b-t1-l1", "thumb_01", Layer::Hypershift, &act_paste, None);
        // thumb_02: text snippet on L0 -> consumer signal on L0 and inherited L1
        add("b-t2-l0", "thumb_02", Layer::Standard, &act_text, None);
        // thumb_03: plain shortcut + extra LongPress on L0 -> consumer signal
        add("b-t3-l0", "thumb_03", Layer::Standard, &act_copy, None);
        add("b-t3-lp", "thumb_03", Layer::Standard, &act_text, Some(TriggerMode::LongPress));
        // thumb_04: shortcut with window condition -> consumer signal
        add("b-t4-l0", "thumb_04", Layer::Standard, &act_cond, None);
        // thumb_05: plain shortcut on L0, but also has HS2 binding -> consumer signal
        add("b-t5-l0", "thumb_05", Layer::Standard, &act_copy, None);
        add("b-t5-hs2", "thumb_05", Layer::Hypershift2, &act_paste, None);

        (config, default_id, game_id)
    }

    #[test]
    fn hybrid_bank_targets_splits_native_keys_and_sidearm_only_signals() {
        use crate::mouse_memory::fake;
        let (config, _default_id, game_id) = hybrid_test_config();
        assert!(profile_uses_hardware_bank(&config, &NAGA_V3_PRO, &game_id));
        let targets = hybrid_bank_targets(&config, &NAGA_V3_PRO, &game_id);
        let find = |ctrl: &str, layer: u8| {
            let btn = NAGA_V3_PRO.button_id_for(ctrl).unwrap();
            targets.iter().find(|&&(b, l, _)| (b, l) == (btn, layer)).map(|&(_, _, a)| a)
        };
        // Native Ctrl+C / Ctrl+V on thumb_01
        assert_eq!(find("thumb_01", 0), Some(OnboardAction::Key { modifier: 0x01, usage: 0x06 }));
        assert_eq!(find("thumb_01", 1), Some(OnboardAction::Key { modifier: 0x01, usage: 0x19 }));
        // Sidearm-only buttons get reserved consumer usages (index 1, 2, 3, 4 -> USAGES[2*i + layer])
        assert_eq!(find("thumb_02", 0), Some(OnboardAction::Consumer(USAGES[2])));
        assert_eq!(find("thumb_02", 1), Some(OnboardAction::Consumer(USAGES[3])));
        assert_eq!(find("thumb_03", 0), Some(OnboardAction::Consumer(USAGES[4])));
        assert_eq!(find("thumb_04", 0), Some(OnboardAction::Consumer(USAGES[6])));
        assert_eq!(find("thumb_05", 0), Some(OnboardAction::Consumer(USAGES[8])));
        // Unbound thumb_06 gets inert Consumer(0), never an own Sidearm signal
        assert_eq!(find("thumb_06", 0), Some(OnboardAction::Consumer(crate::mouse_offline::BANK_SILENT_USAGE)));
        // Firmware trigger (0x39) preserved as Hypershift on both layers; profile button (0x0e) never touched
        let trigger = NAGA_V3_PRO.live.as_ref().unwrap().firmware_trigger.unwrap();
        let profile_btn = NAGA_V3_PRO.live.as_ref().unwrap().profile_button.unwrap();
        assert!(targets.contains(&(trigger, 0, OnboardAction::Hypershift)));
        assert!(targets.contains(&(trigger, 1, OnboardAction::Hypershift)));
        assert!(!targets.iter().any(|&(b, _, _)| b == profile_btn));

        // Toggling hardware_bank changes store_key and persists hybrid records into bank 2
        let (mouse, _) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let banks = Banks { assigned: vec![1, 2], active: 1 };
        let offline = crate::mouse_offline::offline_profile_id(&config, None);
        let hybrid_key = store_key(&config, &NAGA_V3_PRO, &banks, &offline);
        let mut plain_cfg = config.clone();
        plain_cfg.profiles.iter_mut().find(|p| p.id == game_id).unwrap().device_mouse = None;
        assert_ne!(hybrid_key, store_key(&plain_cfg, &NAGA_V3_PRO, &banks, &offline));
        STORED[NAGA_V3_PRO.catalog_index()].store(0, Ordering::Release);
        store_banks(&device, &config, &NAGA_V3_PRO, &offline, dir.path(), false).unwrap();
        let t1 = NAGA_V3_PRO.button_id_for("thumb_01").unwrap();
        let t2 = NAGA_V3_PRO.button_id_for("thumb_02").unwrap();
        fake::with(|mouse| {
            assert_eq!(mouse.records[&(2, t1, 0)], bank_block(2, OnboardAction::Key { modifier: 0x01, usage: 0x06 }));
            assert_eq!(mouse.records[&(2, t2, 0)], bank_block(2, OnboardAction::Consumer(USAGES[2])));
        });
    }

    #[test]
    fn dedicated_offline_profile_is_never_hybrid_and_exit_bank_skips_hybrid_under_active() {
        let (mut config, default_id, game_id) = hybrid_test_config();
        // Trying to enable hardware_bank on the dedicated offline profile is ignored.
        config.profiles.iter_mut().find(|p| p.id == default_id).unwrap().device_mouse = Some([(
            NAGA_V3_PRO.device_id.to_owned(),
            crate::config::MouseOverrides { hardware_bank: Some(true), ..Default::default() },
        )].into());
        assert!(!profile_uses_hardware_bank(&config, &NAGA_V3_PRO, &default_id));
        assert!(profile_uses_hardware_bank(&config, &NAGA_V3_PRO, &game_id));

        // Under @active when the active profile at exit is the hybrid profile on bank 2,
        // exit_bank must select clean bank 1, never hybrid bank 2.
        config.settings.offline_profile_id = Some(crate::config::OFFLINE_PROFILE_ACTIVE.into());
        let banks = Banks { assigned: vec![1, 2], active: 2 };
        let plan = bank_plan(&config, &NAGA_V3_PRO, &banks, &game_id);
        assert_eq!(exit_bank(&config, &plan, &banks, &game_id), Some(1));

        // Single-clean-bank invariant: a mouse with only ONE user bank refuses hybrid mode
        // so offline restoration always has a clean bank.
        let one_bank = Banks { assigned: vec![2], active: 2 };
        let one_plan = bank_plan(&config, &NAGA_V3_PRO, &one_bank, &game_id);
        assert_eq!(one_plan, [PlannedBank { bank: 2, profile_id: game_id.as_str(), hybrid: false }]);
        assert_eq!(exit_bank(&config, &one_plan, &one_bank, &game_id), Some(2));

        // Implicit sole-bank fallback (hybrid profile linked to missing slot 5, mouse only has bank 1)
        // must ALWAYS be pure offline (`hybrid: false`).
        let mut missing_slot_cfg = config.clone();
        missing_slot_cfg.profiles.iter_mut().find(|p| p.id == default_id).unwrap().device_slots = None;
        missing_slot_cfg.profiles.iter_mut().find(|p| p.id == game_id).unwrap().device_slots =
            Some([(NAGA_V3_PRO.device_id.to_owned(), 5)].into());
        let sole = Banks { assigned: vec![1], active: 1 };
        assert_eq!(
            bank_plan(&missing_slot_cfg, &NAGA_V3_PRO, &sole, &game_id),
            [PlannedBank { bank: 1, profile_id: game_id.as_str(), hybrid: false }]
        );

        // Duplicate physical slot: dedicated offline profile defensively owns slot 1
        // and blocks the hybrid profile from claiming it.
        let mut dup_cfg = config.clone();
        dup_cfg.profiles.iter_mut().find(|p| p.id == game_id).unwrap().device_slots =
            Some([(NAGA_V3_PRO.device_id.to_owned(), 1)].into());
        assert!(crate::config::validate_config(&dup_cfg).is_err());
        assert!(!profile_uses_hardware_bank(&dup_cfg, &NAGA_V3_PRO, &game_id));
        let dup_plan = bank_plan(&dup_cfg, &NAGA_V3_PRO, &banks, &default_id);
        assert_eq!(dup_plan, [PlannedBank { bank: 1, profile_id: default_id.as_str(), hybrid: false }]);
    }

    #[test]
    fn hybrid_classifier_rejects_throttle_inherited_gestures_hs2_trigger_and_key_mode() {
        let (mut config, _default_id, game_id) = hybrid_test_config();
        // Throttled plain shortcut on thumb_01 must stay on consumer signal.
        config.bindings.iter_mut().find(|b| b.id == "b-t1-l0").unwrap().throttle_ms = Some(250);
        // Standard LongPress on thumb_03 must also keep HyperShift plain press on consumer signal.
        config.bindings.push(crate::config::Binding {
            id: "b-t3-hs-plain".into(),
            profile_id: game_id.clone(),
            control_id: control_id(&NAGA_V3_PRO, "thumb_03"),
            layer: Layer::Hypershift,
            action_id: "act-paste".into(),
            label: "Paste".into(),
            enabled: true,
            trigger_mode: None,
            color_tag: None,
            chord_partner: None,
            throttle_ms: None,
        });
        let targets = hybrid_bank_targets(&config, &NAGA_V3_PRO, &game_id);
        let find = |ctrl: &str, layer: u8| {
            let btn = NAGA_V3_PRO.button_id_for(ctrl).unwrap();
            targets.iter().find(|&&(b, l, _)| (b, l) == (btn, layer)).map(|&(_, _, a)| a)
        };
        assert_eq!(find("thumb_01", 0), Some(OnboardAction::Consumer(USAGES[0])), "throttled binding stays on consumer signal");
        assert_eq!(find("thumb_03", 1), Some(OnboardAction::Consumer(USAGES[5])), "HyperShift inherits Standard LongPress -> consumer signal");

        // Adding an HS2 trigger on V3 suppresses native keys across the profile so holding HS2 silences unbound buttons.
        let mut hs2_cfg = config.clone();
        hs2_cfg.profiles.iter_mut().find(|p| p.id == game_id).unwrap().hypershift2_triggers = vec!["v3_mouse_right".into()];
        let hs2_targets = hybrid_bank_targets(&hs2_cfg, &NAGA_V3_PRO, &game_id);
        let t1 = NAGA_V3_PRO.button_id_for("thumb_01").unwrap();
        assert_eq!(
            hs2_targets.iter().find(|&&(b, l, _)| (b, l) == (t1, 1)).map(|&(_, _, a)| a),
            Some(OnboardAction::Consumer(USAGES[1])),
            "HS2 trigger keeps controls on consumer signals"
        );

        // Key-fallback mode (consumer signals disabled) refuses hybrid mode cleanly.
        crate::mouse_memory::set_consumer_signals(false);
        let allowed_in_key_mode = profile_uses_hardware_bank(&config, &NAGA_V3_PRO, &game_id);
        crate::mouse_memory::set_consumer_signals(true);
        assert!(!allowed_in_key_mode, "hybrid mode requires consumer signals");
    }

    #[test]
    fn apply_profile_bank_switches_to_hybrid_and_back_and_respects_offline_and_released() {
        use crate::mouse_memory::fake;
        let _v3 = V3_GLOBAL_STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (mut config, default_id, game_id) = hybrid_test_config();
        // Give the hybrid profile a distinct live DPI to verify bank-then-DPI ordering.
        config.profiles.iter_mut().find(|p| p.id == game_id).unwrap()
            .device_mouse.as_mut().unwrap().get_mut(NAGA_V3_PRO.device_id).unwrap().mouse_dpi = Some(2400);
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let (sidearm, base) = claim_sidearm_bank(&device, &config, &targets, dir.path()).unwrap().unwrap();
        assert_eq!(sidearm, 5);
        mark_in_sidearm_bank(dir.path(), &NAGA_V3_PRO, sidearm, base);
        select_bank(&device, sidearm).unwrap();

        let index = NAGA_V3_PRO.catalog_index();
        SIDEARM_BANK[index].store(sidearm, Ordering::Release);
        ACTIVE_LIVE_BANK[index].store(sidearm, Ordering::Release);
        VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
        OFFLINE[index].store(0, Ordering::Release);
        RELEASED[index].store(false, Ordering::Release);
        INPUT_TEST_MODE.store(false, Ordering::Release);

        let game = config.profiles.iter().find(|p| p.id == game_id).unwrap().clone();
        let default = config.profiles.iter().find(|p| p.id == default_id).unwrap().clone();

        // Unverified hybrid bank MUST stay on Sidearm bank until verified stored!
        *DESIRED_PROFILE.lock().unwrap() = Some(DesiredProfile { revision: next_profile_revision(), profile: Some(game.clone()), config: config.clone() });
        assert!(!reconcile_on_device(&device, Some(dir.path()), None).unwrap());
        fake::with(|m| assert_eq!(m.active_bank, 5, "unverified hybrid slot must not be selected"));

        // Store banks -> verifies bank 2 and immediately reconciles desired hybrid profile + live DPI!
        let offline = crate::mouse_offline::offline_profile_id(&config, None);
        STORED[index].store(0, Ordering::Release);
        store_banks(&device, &config, &NAGA_V3_PRO, &offline, dir.path(), false).unwrap();
        assert_ne!(VERIFIED_HYBRID_BANKS[index].load(Ordering::Acquire) & (1 << 2), 0);
        fake::with(|m| {
            assert_eq!(m.active_bank, 2, "verified hybrid bank selected automatically after store");
            assert_eq!(m.dpi.get(&0), Some(&2400), "live DPI applied after bank switch");
        });
        assert_eq!(ACTIVE_LIVE_BANK[index].load(Ordering::Acquire), 2);
        // Repeating the same profile is a no-op.
        assert!(!reconcile_on_device(&device, Some(dir.path()), None).unwrap());

        // Input test mode forces Sidearm bank so native flash keys cannot fire while testing.
        INPUT_TEST_MODE.store(true, Ordering::Release);
        assert!(reconcile_on_device(&device, Some(dir.path()), None).unwrap());
        fake::with(|m| assert_eq!(m.active_bank, 5));
        INPUT_TEST_MODE.store(false, Ordering::Release);
        assert!(reconcile_on_device(&device, Some(dir.path()), None).unwrap());
        fake::with(|m| assert_eq!(m.active_bank, 2));

        // Physical profile-button press detected before monitor tick: do NOT overwrite user's bank!
        fake::with(|m| m.active_bank = 1);
        *DESIRED_PROFILE.lock().unwrap() = Some(DesiredProfile { revision: next_profile_revision(), profile: Some(default.clone()), config: config.clone() });
        assert!(!reconcile_on_device(&device, Some(dir.path()), None).unwrap());
        fake::with(|m| assert_eq!(m.active_bank, 1, "manual profile button choice preserved"));
        assert!(is_offline(&NAGA_V3_PRO));
        // Clear manual offline and restore bank 2 for next checks.
        set_offline(&NAGA_V3_PRO, 0);
        select_bank(&device, 2).unwrap();
        ACTIVE_LIVE_BANK[index].store(2, Ordering::Release);

        // Switching back to normal profile returns to Sidearm bank 5.
        assert!(reconcile_on_device(&device, Some(dir.path()), None).unwrap());
        fake::with(|m| assert_eq!(m.active_bank, 5));
        assert_eq!(ACTIVE_LIVE_BANK[index].load(Ordering::Acquire), 5);

        // Manual offline mode pauses switching.
        *DESIRED_PROFILE.lock().unwrap() = Some(DesiredProfile { revision: next_profile_revision(), profile: Some(game.clone()), config: config.clone() });
        OFFLINE[index].store(sidearm, Ordering::Release);
        assert!(!reconcile_on_device(&device, Some(dir.path()), None).unwrap());
        fake::with(|m| assert_eq!(m.active_bank, 5));
        OFFLINE[index].store(0, Ordering::Release);

        // "Return slot" (RELEASED) pauses switching.
        RELEASED[index].store(true, Ordering::Release);
        assert!(!reconcile_on_device(&device, Some(dir.path()), None).unwrap());
        fake::with(|m| assert_eq!(m.active_bank, 5));
        RELEASED[index].store(false, Ordering::Release);

        // Cleanup global test state
        *DESIRED_PROFILE.lock().unwrap() = None;
        SIDEARM_BANK[index].store(0, Ordering::Release);
        ACTIVE_LIVE_BANK[index].store(0, Ordering::Release);
        VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
    }

    #[test]
    fn leave_sidearm_bank_and_restore_orphaned_return_to_clean_bank_from_hybrid() {
        use crate::mouse_memory::fake;
        let (config, _default_id, _game_id) = hybrid_test_config();
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        fake::set_present_models(vec![&NAGA_V3_PRO]);
        let dir = tempfile::tempdir().unwrap();
        crate::config::save_config(dir.path(), config.clone(), None).unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let (sidearm, base) = claim_sidearm_bank(&device, &config, &targets, dir.path()).unwrap().unwrap();
        mark_in_sidearm_bank(dir.path(), &NAGA_V3_PRO, sidearm, base);
        record_managed_hybrid_bank(dir.path(), &NAGA_V3_PRO, sidearm, 2);
        // Simulate active hybrid bank 2 when Sidearm exits cleanly.
        select_bank(&device, 2).unwrap();
        leave_sidearm_bank(&device, Some(&config), dir.path()).unwrap();
        fake::with(|m| assert_eq!(m.active_bank, 1, "clean exit from hybrid bank restores clean bank 1"));

        // Simulate crash/kill while on hybrid bank 2 with config.json unreadable -> marker still restores clean bank 1!
        std::fs::remove_file(dir.path().join("config.json")).unwrap();
        mark_in_sidearm_bank(dir.path(), &NAGA_V3_PRO, sidearm, base);
        record_managed_hybrid_bank(dir.path(), &NAGA_V3_PRO, sidearm, 2);
        select_bank(&device, 2).unwrap();
        drop(device);
        assert!(restore_orphaned(dir.path()));
        fake::with(|m| assert_eq!(m.active_bank, 1, "crash recovery from hybrid bank restores clean bank 1 without config.json"));
        assert!(!in_sidearm_bank_marker(dir.path(), &NAGA_V3_PRO).exists());
    }

    #[test]
    fn create_and_delete_user_bank_enforce_safety_guards() {
        use crate::mouse_memory::fake;
        let _v3 = V3_GLOBAL_STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (config, _default_id, _game_id) = hybrid_test_config();
        let (mut mouse, targets) = sidearm_bank_mouse();
        // Start with only user bank 1 so we can test adding, deleting, and guards.
        mouse.banks = vec![1];
        mouse.active_bank = 1;
        let _fake = fake::install(mouse);
        fake::set_present_models(vec![&NAGA_V3_PRO]);
        let dir = tempfile::tempdir().unwrap();
        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let (sidearm, _base) = claim_sidearm_bank(&device, &config, &targets, dir.path()).unwrap().unwrap();
        assert_eq!(sidearm, 5, "Sidearm claims last free slot 5");
        drop(device);

        // Cannot delete the last remaining user bank or Sidearm's own bank.
        assert!(delete_user_bank(&NAGA_V3_PRO, 1, dir.path()).is_err(), "cannot delete last user bank");
        assert!(delete_user_bank(&NAGA_V3_PRO, sidearm, dir.path()).is_err(), "cannot delete Sidearm bank");

        // Creating specific slots and lowest-free slots works and respects Sidearm's slot 5.
        assert!(create_user_bank(&NAGA_V3_PRO, Some(5)).is_err(), "cannot take Sidearm slot");
        assert!(create_user_bank(&NAGA_V3_PRO, Some(1)).is_err(), "cannot take existing slot");
        let after_specific = create_user_bank(&NAGA_V3_PRO, Some(4)).unwrap();
        assert_eq!(after_specific.assigned, vec![1, 4]);
        assert_eq!(create_user_bank(&NAGA_V3_PRO, None).unwrap().assigned, vec![1, 2, 4]);
        assert_eq!(create_user_bank(&NAGA_V3_PRO, Some(3)).unwrap().assigned, vec![1, 2, 3, 4]);
        assert!(create_user_bank(&NAGA_V3_PRO, None).is_err(), "all 5 slots full");

        // Deleting the currently active user bank switches safely to another bank first.
        fake::with(|m| m.active_bank = 3);
        let after_del = delete_user_bank(&NAGA_V3_PRO, 3, dir.path()).unwrap();
        assert_eq!(after_del.assigned, vec![1, 2, 4]);
        assert_ne!(after_del.active, 3, "active bank switched before deletion");

        // Deleting a non-assigned slot fails cleanly.
        assert!(delete_user_bank(&NAGA_V3_PRO, 3, dir.path()).is_err());
    }

    #[test]
    fn flush_bank_store_now_verifies_hybrid_banks_and_reconciles() {
        use crate::mouse_memory::fake;
        let _v3 = V3_GLOBAL_STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (config, _default_id, game_id) = hybrid_test_config();
        let game = config.profiles.iter().find(|p| p.id == game_id).unwrap().clone();
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        fake::set_present_models(vec![&NAGA_V3_PRO]);
        let dir = tempfile::tempdir().unwrap();
        let index = NAGA_V3_PRO.catalog_index();

        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let (sidearm, _base) = claim_sidearm_bank(&device, &config, &targets, dir.path()).unwrap().unwrap();
        select_bank(&device, sidearm).unwrap();
        drop(device);

        SIDEARM_BANK[index].store(sidearm, Ordering::Release);
        ACTIVE_LIVE_BANK[index].store(sidearm, Ordering::Release);
        VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
        STORED[index].store(0, Ordering::Release);
        OFFLINE[index].store(0, Ordering::Release);
        RELEASED[index].store(false, Ordering::Release);
        INPUT_TEST_MODE.store(false, Ordering::Release);
        ACTIVE[index].store(false, Ordering::Release);
        *DESIRED_PROFILE.lock().unwrap() = Some(DesiredProfile {
            revision: next_profile_revision(),
            profile: Some(game),
            config: config.clone(),
        });

        flush_bank_store_now(&NAGA_V3_PRO, &config, dir.path()).unwrap();
        assert_ne!(VERIFIED_HYBRID_BANKS[index].load(Ordering::Acquire) & (1u8 << 2), 0, "hybrid bank 2 verified");
        assert_ne!(STORED[index].load(Ordering::Acquire), 0, "stored fingerprint recorded");
        fake::with(|m| assert_eq!(m.active_bank, 2, "desired hybrid profile reconciled immediately"));

        // Cleanup global state.
        *DESIRED_PROFILE.lock().unwrap() = None;
        SIDEARM_BANK[index].store(0, Ordering::Release);
        ACTIVE_LIVE_BANK[index].store(0, Ordering::Release);
        VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
        STORED[index].store(0, Ordering::Release);
    }

    #[test]
    fn delete_and_flush_protect_clean_offline_bank_manual_offline_and_unlinked_backup() {
        use crate::mouse_memory::fake;
        let _v3 = V3_GLOBAL_STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (config, _default_id, _game_id) = hybrid_test_config();
        let (mouse, targets) = sidearm_bank_mouse();
        let _fake = fake::install(mouse);
        fake::set_present_models(vec![&NAGA_V3_PRO]);
        let dir = tempfile::tempdir().unwrap();
        let index = NAGA_V3_PRO.catalog_index();

        let device = VendorDevice::test_handle(&NAGA_V3_PRO, 0x00e8, V3_PATH);
        let (sidearm, base) = claim_sidearm_bank(&device, &config, &targets, dir.path()).unwrap().unwrap();
        mark_in_sidearm_bank(dir.path(), &NAGA_V3_PRO, sidearm, base);
        let offline = crate::mouse_offline::offline_profile_id(&config, None);
        STORED[index].store(0, Ordering::Release);
        store_banks(&device, &config, &NAGA_V3_PRO, &offline, dir.path(), false).unwrap();
        drop(device);

        // Bank 1 is the ONLY clean offline bank while bank 2 holds hybrid Sidearm signals -> MUST refuse deleting bank 1!
        assert!(delete_user_bank(&NAGA_V3_PRO, 1, dir.path()).is_err(), "must not delete last clean offline bank");

        // Deleting a clean bank while in manual offline mode never overwrites ACTIVE_LIVE_BANK and updates marker.base!
        let _ = create_user_bank(&NAGA_V3_PRO, None).unwrap(); // creates clean bank 3
        SIDEARM_BANK[index].store(sidearm, Ordering::Release);
        ACTIVE_LIVE_BANK[index].store(sidearm, Ordering::Release);
        OFFLINE[index].store(sidearm, Ordering::Release);
        RELEASED[index].store(false, Ordering::Release);
        fake::with(|m| m.active_bank = 1);
        let after = delete_user_bank(&NAGA_V3_PRO, 1, dir.path()).unwrap();
        assert_eq!(after.active, 3, "offline active bank switches to remaining clean bank 3");
        assert_eq!(ACTIVE_LIVE_BANK[index].load(Ordering::Acquire), sidearm, "manual offline mode preserves ACTIVE_LIVE_BANK");
        assert_eq!(read_sidearm_bank_marker(dir.path(), &NAGA_V3_PRO).base, Some(3), "marker.base updated to clean bank 3");

        // flush_bank_store_now refuses during manual offline mode.
        assert!(flush_bank_store_now(&NAGA_V3_PRO, &config, dir.path()).is_err());

        // On live-map path (ACTIVE=true, SIDEARM_BANK=0), flush refuses when active unlinked bank still has a rollback backup.
        OFFLINE[index].store(0, Ordering::Release);
        SIDEARM_BANK[index].store(0, Ordering::Release);
        ACTIVE[index].store(true, Ordering::Release);
        fake::with(|m| m.active_bank = 3);
        std::fs::write(bank_backup(dir.path(), &NAGA_V3_PRO, 3), "{}").unwrap();
        assert!(flush_bank_store_now(&NAGA_V3_PRO, &config, dir.path()).is_err(), "unlinked active bank backup guarded");

        // Cleanup global state.
        ACTIVE[index].store(false, Ordering::Release);
        SIDEARM_BANK[index].store(0, Ordering::Release);
        ACTIVE_LIVE_BANK[index].store(0, Ordering::Release);
        VERIFIED_HYBRID_BANKS[index].store(0, Ordering::Release);
        STORED[index].store(0, Ordering::Release);
    }

    #[test]
    fn move_sidearm_bank_relocates_onto_free_and_occupied_slots_including_full_5_slots() {
        use crate::mouse_memory::fake;
        let _v3 = V3_GLOBAL_STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (mut mouse, targets) = sidearm_bank_mouse();
        // Realistic scenario matching user's V3 Pro: slots 1, 4, 5 are user banks, slot 2 is Sidearm (playing), slot 3 is free!
        mouse.banks = vec![1, 2, 4, 5];
        mouse.active_bank = 2;
        for (button, layer) in bank_addresses(&NAGA_V3_PRO) {
            let wanted = targets
                .iter()
                .find(|&&(b, l, _)| (b, l) == (button, layer))
                .map_or(mouse.records[&(1, button, layer)], |&(_, _, action)| bank_block(2, action));
            mouse.records.insert((2, button, layer), wanted);
        }
        mouse.dpi.insert(2, 1100);
        let _fake = fake::install(mouse);
        fake::set_present_models(vec![&NAGA_V3_PRO]);
        let dir = tempfile::tempdir().unwrap();
        let index = NAGA_V3_PRO.catalog_index();
        SIDEARM_BANK[index].store(2, Ordering::Release);
        ACTIVE_LIVE_BANK[index].store(2, Ordering::Release);

        // Move Sidearm from slot 2 -> occupied slot 5: slot 5's user profile moves to free slot 3!
        let res = move_sidearm_bank(&NAGA_V3_PRO, 5, dir.path()).unwrap();
        assert_eq!(res.sidearm, 5);
        assert_eq!(res.displaced_from, Some(5));
        assert_eq!(res.displaced_to, Some(3));
        assert_eq!(res.banks.assigned, vec![1, 3, 4]);
        assert_eq!(SIDEARM_BANK[index].load(Ordering::Acquire), 5);
        assert_eq!(ACTIVE_LIVE_BANK[index].load(Ordering::Acquire), 5);
        fake::with(|m| assert_eq!(m.active_bank, 5, "mouse stays on playing Sidearm bank after move"));

        // Move Sidearm from slot 5 -> free slot 2 cleanly (no displacement).
        let res2 = move_sidearm_bank(&NAGA_V3_PRO, 2, dir.path()).unwrap();
        assert_eq!(res2.sidearm, 2);
        assert_eq!(res2.displaced_from, None);
        assert_eq!(res2.displaced_to, None);
        assert_eq!(res2.banks.assigned, vec![1, 3, 4]);

        // Fill all 5 slots (add user slot 5), then move Sidearm from slot 2 -> slot 5 (displaces 5 -> 2)!
        let _ = create_user_bank(&NAGA_V3_PRO, Some(5)).unwrap();
        let res3 = move_sidearm_bank(&NAGA_V3_PRO, 5, dir.path()).unwrap();
        assert_eq!(res3.sidearm, 5);
        assert_eq!(res3.displaced_from, Some(5));
        assert_eq!(res3.displaced_to, Some(2));
        assert_eq!(res3.banks.assigned, vec![1, 2, 3, 4]);
        fake::with(|m| assert_eq!(m.active_bank, 5));

        SIDEARM_BANK[index].store(0, Ordering::Release);
        ACTIVE_LIVE_BANK[index].store(0, Ordering::Release);
    }
}
