//! Onboard button-mapping memory of the mouse's vendor HID interface.
//!
//! Razer Synapse does not remap buttons at runtime: it writes a 90-byte record
//! into one of 31 onboard slots with a HID `SET_REPORT` control transfer and
//! reads it back with `GET_REPORT`. A USB capture of Synapse proves the mouse
//! then emits the mapped key itself, with Synapse closed, so this module can
//! own the mapping instead of the vendor app.
//!
//! Wire facts (reverse-engineered from `sidearm_map2.pcap`, see the slot
//! fixtures in the tests): the report id is `0x03`, so a Windows feature buffer
//! is 91 bytes with the id first. Inside the 90-byte payload, byte 0 is a
//! command/status byte (`0x00` on a write, non-zero in a reply), byte 1 is the
//! slot, bytes 5..8 are the record marker, the record itself is bytes 9..14
//! (`button_id, layer, 0x02, 0x02, modifier, hid_usage`) and byte 88 is a
//! checksum over bytes 2..87 — the status and slot bytes are excluded. `layer`
//! selects which of the button's two records is meant: `0x00` is the standard
//! one, `0x01` plays only while the firmware Hypershift key is held, so the
//! slot path writes `0x00` only (layer 1 goes through `write_record`).
//!
//! The slot query cannot cold-read: a `GET_REPORT` answers only with what the
//! previous `SET_REPORT` stored — selecting a slot with the empty marker
//! therefore returns the marker, not the slot's earlier record (proven on
//! hardware: a slot holding `F14` answered `02 07 80 00 00`). The command class
//! does answer honestly, and that is what the takeover guard watches:
//! `class 0x02 / command 0x8c` returns the record the device really holds (all
//! twelve thumbs read back as `F13`..`F24` after a write), and
//! `class 0x00 / command 0x84` returns the real device mode — it reported
//! `Driver` while Razer's engine was running, and `Driver` is never written from
//! here. Writes are still confirmed by their echo.
//!
//! Two hardware quirks are handled here rather than by callers. The vendor
//! collection is opened with no requested access rights: Razer's own driver
//! holds it, and asking for GENERIC rights fails with `ERROR_ACCESS_DENIED`.
//! And the reply to a write lags one transaction on some slots, so a write is
//! verified with two reads and one retry.

use std::io::Error;

use crate::device_catalog::NativeModel;

#[path = "live_overlay.rs"]
pub mod live_overlay;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::CreateFileW;
use windows_sys::Win32::System::Registry::HKEY;
use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;
use windows_sys::Win32::System::Registry::KEY_READ;
use windows_sys::Win32::System::Registry::RegCloseKey;
use windows_sys::Win32::System::Registry::RegEnumKeyExW;
use windows_sys::Win32::System::Registry::RegOpenKeyExW;
use windows_sys::Win32::Devices::HumanInterfaceDevice::HidD_GetFeature;
use windows_sys::Win32::Devices::HumanInterfaceDevice::HidD_SetFeature;

/// Report id of the vendor feature report, as sent in `wValue` by Synapse.
pub const REPORT_ID: u8 = 0x03;
/// Payload length on the wire (the Windows feature buffer adds the id byte).
pub const PAYLOAD_LEN: usize = 90;
const RECORD_MARKER: [u8; 4] = [0x0a, 0x02, 0x0c, 0x01];
/// First HID usage of the function keys the thumb column can be mapped to.
const USAGE_F13: u8 = 0x68;
/// HID modifier mask bits of a V2 HyperSpeed key record. Shift and Alt are the
/// RIGHT-hand keys: that firmware never plays the left Shift (`0x02`) or left
/// Alt (`0x04`) bit, alone or combined (measured 2026-10-27 at the Raw Input
/// level: every other bit — both Ctrl, both Win, right Shift, right Alt —
/// arrives). A model with `plain_left_modifiers` takes the standard mask
/// ([`left_modifier_bits`]) instead.
/// Limit: on a layout with AltGr (Russian) Windows adds Ctrl to the right Alt,
/// so `Alt+X` plays as `Ctrl+Alt+X` there. A thumb's bare `F13`..`F24` has
/// mask `0x00`.
const MOD_CTRL: u8 = 0x01;
const MOD_SHIFT: u8 = 0x20;
const MOD_ALT: u8 = 0x40;
const MOD_WIN: u8 = 0x08;
/// Device mode that makes the mouse emit the records written into onboard
/// memory — the only mode Sidearm works in.
pub const MODE_NORMAL: u8 = 0x00;
/// Device mode that hands the buttons to the vendor driver: Razer's engine
/// switches the mouse here on startup, and from then on the driver's own mapping
/// reaches the OS while onboard memory is ignored entirely. Anything but
/// [`MODE_NORMAL`] must be treated as a takeover.
pub const MODE_DRIVER: u8 = 0x03;

/// Command class of the device-mode get/set commands.
const CLASS_CONTROL: u8 = 0x00;
/// Command class that answers button queries.
const CLASS_BUTTON: u8 = 0x02;
const CMD_SET_MODE: u8 = 0x04;
/// Firmware version: reply bytes 8 and 9 are major and minor (OpenRazer).
const CMD_GET_FIRMWARE: u8 = 0x81;
const CMD_GET_MODE: u8 = 0x84;
/// Per-button query. Unlike the slot query the record path uses, this one answers
/// with the record the device actually holds, and it needs no preceding write.
const CMD_GET_BUTTON: u8 = 0x8c;
/// Per-button write, the twin of [`CMD_GET_BUTTON`]: arguments are profile,
/// button, layer, then the action (`category, len, value…`). The slot path's
/// "record marker" `0a 02 0c 01` is this same header (length, class, command,
/// profile) — proven on hardware by writing the right button back with it.
const CMD_SET_BUTTON: u8 = 0x0c;
/// Category byte of a button record that acts as a plain mouse button; its
/// value is the button number (`1` left, `2` right, `3` middle).
const CATEGORY_MOUSE: u8 = 0x01;
/// Category of a consumer-page record: the button sends `report_id, usage LE16`
/// on the model's consumer collection (`device_catalog::ConsumerSignals`).
const CATEGORY_CONSUMER: u8 = 0x0a;
/// Category of the firmware Hypershift key (seen on the right button after
/// Synapse stored its profile).
const CATEGORY_HYPERSHIFT: u8 = 0x0c;
/// Category of a "turbo" key record: `modifier, usage, period_hi, period_lo` —
/// the key is tapped every period while the button is held. Unlike a plain key
/// record it plays the LEFT Shift and Alt (measured 2026-10-27, Raw Input).
const CATEGORY_TURBO_KEY: u8 = 0x0d;
/// Turbo period of a [`OnboardAction::KeyTap`]: one tap per press for any press
/// shorter than this (`0xffff` played nothing on hardware).
const KEY_TAP_PERIOD_MS: u16 = 10_000;
/// Sensor class: DPI get/set (OpenRazer naming, confirmed on this device).
const CLASS_DPI: u8 = 0x04;
const CMD_SET_DPI: u8 = 0x05;
const CMD_GET_DPI: u8 = 0x85;
/// Power class: battery level as 0..=255 in reply byte 9.
const CLASS_POWER: u8 = 0x07;
const CMD_GET_BATTERY: u8 = 0x80;
/// Poll rate get/set live in the control class next to the device mode.
const CMD_SET_POLL_RATE: u8 = 0x05;
const CMD_GET_POLL_RATE: u8 = 0x85;
/// Storage selector of DPI commands: `0x01` keeps the value in the mouse across
/// power cycles (the device answered its stored DPI with it), `0x00` is the live
/// value only — a per-profile switch, which must not wear the mouse's storage.
const VARSTORE: u8 = 0x01;
const NOSTORE: u8 = 0x00;
/// Battery level 0..=255 as a rounded percentage.
pub fn battery_percent_from_raw(raw: u8) -> u8 {
    ((u16::from(raw) * 100 + 127) / 255) as u8
}
/// The onboard profile the onboard path keeps its records in.
const ONBOARD_PROFILE: u8 = 0x01;

/// Argument block of the per-button get/set commands: profile (`0` the live
/// map, `1` the onboard profile or a V3 bank `1..=5`), button, layer, then the
/// record (`category, len, values…`; empty for a get).
fn button_args(profile: u8, button_id: u8, layer: u8, record: &[u8]) -> [u8; 10] {
    let mut args = [0u8; 10];
    args[..3].copy_from_slice(&[profile, button_id, layer]);
    args[3..3 + record.len()].copy_from_slice(record);
    args
}
const COMMAND_STATUS_OK: u8 = 0x02;
const COMMAND_STATUS_BUSY: u8 = 0x01;
/// Status of a wireless mouse that did not answer: asleep or out of range.
const COMMAND_STATUS_NO_RESPONSE: u8 = 0x04;
/// Error text of a command the mouse did not answer ([`is_no_response`]).
const NO_RESPONSE: &str = "the mouse did not answer (asleep or out of range)";
/// The device answers `busy` while it finishes a write; retry, don't fail.
const COMMAND_RETRIES: u32 = 8;
const COMMAND_SETTLE: std::time::Duration = std::time::Duration::from_millis(50);
const COMMAND_BUSY_WAIT: std::time::Duration = std::time::Duration::from_millis(200);
/// A mode change is not visible immediately: for about a second the device still
/// answers from the mode it is leaving (measured on hardware — a `SET Normal`
/// whose read-back said `Driver` was `Normal` one second later). Never call that a
/// failed takeover.
const MODE_CONFIRM_ATTEMPTS: u32 = 4;
const MODE_CONFIRM_WAIT: std::time::Duration = std::time::Duration::from_millis(250);
/// Category byte of a button record that emits a key.
const CATEGORY_KEY: u8 = 0x02;

/// `open_connected` error when no catalog model is plugged in at all — absent,
/// not unreachable.
pub const NOT_CONNECTED: &str = "no supported Razer mouse is connected";
/// `find_paths` error for a device with no interface in the registry
/// (not plugged in).
const NO_INTERFACE: &str = "our device has no HID interface in the registry";
/// Registry home of device interface symbolic link names.
const DEVICE_CLASSES: &str = r"SYSTEM\CurrentControlSet\Control\DeviceClasses";
/// Interface class that owns the HID collections (not the HID *class* guid).
const HID_INTERFACE_GUID: &str = "{4d1e55b2-f16f-11cf-88cb-001111000030}";

/// Checksum byte: XOR of payload bytes 2..=87, excluding status and slot.
pub fn checksum(payload: &[u8; PAYLOAD_LEN]) -> u8 {
    payload[2..88].iter().fold(0u8, |acc, &byte| acc ^ byte)
}

/// The model whose tables the config-side helpers use.
// shortcut: the config does not name its model yet, so config-driven code
// (`onboard_bindings`, the offline plan) assumes the only catalog entry;
// step 2 of plans/multi-device/plan.md passes the config's model instead.
pub fn config_model() -> &'static NativeModel {
    &crate::device_catalog::NAGA_V2_HYPERSPEED
}

/// Vendor button id of a control whose onboard record emits a key: the thumbs
/// (`thumb_01` is the first button) and the two top buttons.
pub fn button_id_for_control(control_id: &str) -> Option<u8> {
    config_model().button_id_for(control_id)
}

/// HID modifier mask of a hotkey's modifiers.
fn modifier_mask(modifiers: &crate::hotkeys::HotkeyModifiers) -> u8 {
    modifier_bits(modifiers.ctrl, modifiers.shift, modifiers.alt, modifiers.win)
}

/// Standard HID modifier mask (left-hand keys), for a [`OnboardAction::KeyTap`].
pub fn left_modifier_bits(ctrl: bool, shift: bool, alt: bool, win: bool) -> u8 {
    u8::from(ctrl) | u8::from(shift) << 1 | u8::from(alt) << 2 | u8::from(win) << 3
}

/// Key-record modifier mask for these modifiers (see [`MOD_SHIFT`]).
pub fn modifier_bits(ctrl: bool, shift: bool, alt: bool, win: bool) -> u8 {
    [(ctrl, MOD_CTRL), (shift, MOD_SHIFT), (alt, MOD_ALT), (win, MOD_WIN)]
        .iter()
        .filter(|(held, _)| *held)
        .fold(0, |mask, (_, bit)| mask | bit)
}

/// HID usage for a key name; only `F13` through `F24` fit onboard memory.
pub fn usage_for_key(display_name: &str) -> Option<u8> {
    let number = display_name.strip_prefix('F')?.parse::<u8>().ok()?;
    if (13..=24).contains(&number) {
        Some(USAGE_F13 + (number - 13))
    } else {
        None
    }
}

/// Whether key buttons send consumer-page signals (default) or `F13`..`F24`.
/// Set once at startup: a file [`KEY_SIGNALS_FILE`] next to the config selects
/// the keyboard signals (rollback switch, plans/consumer-path/plan.md D2).
static CONSUMER_SIGNALS: AtomicBool = AtomicBool::new(true);

/// Present in the config folder when the key buttons must send `F13`..`F24`.
pub const KEY_SIGNALS_FILE: &str = "onboard-key-signals";

pub fn set_consumer_signals(enabled: bool) {
    CONSUMER_SIGNALS.store(enabled, Ordering::Relaxed);
}

pub fn consumer_signals_enabled() -> bool {
    CONSUMER_SIGNALS.load(Ordering::Relaxed)
}

/// Onboard target of one binding: the button id and the record it should
/// hold. In consumer mode that is the model's reserved consumer usage for the
/// control; otherwise the binding's own key, of which only `F13`..`F24` (with
/// any modifiers) are accepted — keys no application uses, so the mouse can
/// never fire a real shortcut on its own. Shared by the write path and the
/// drift check so both agree on what "this binding is in place" means.
pub(crate) fn binding_target(model: &NativeModel, binding: &OnboardBinding) -> Result<(u8, OnboardAction), String> {
    target_in_mode(model, binding, CONSUMER_SIGNALS.load(Ordering::Relaxed))
}

fn target_in_mode(model: &NativeModel, binding: &OnboardBinding, consumer: bool) -> Result<(u8, OnboardAction), String> {
    let button_id = model
        .button_id_for(&binding.control_id)
        .ok_or_else(|| format!("{} has no onboard key record", binding.control_id))?;
    if consumer && let Some(usage) = model.consumer_usage_for(&binding.control_id) {
        return Ok((button_id, OnboardAction::Consumer(usage)));
    }
    let spec = crate::hotkeys::parse_hotkey(&binding.encoded_key)?;
    let usage = usage_for_key(&spec.key.display_name)
        .ok_or_else(|| format!("{} cannot live in onboard memory", spec.key.display_name))?;
    Ok((button_id, OnboardAction::Key { modifier: modifier_mask(&spec.modifiers), usage }))
}

/// One key button the capture helper reads from the consumer collection: its
/// usage and the encoded key the press stands for (the control's standard-layer
/// encoder mapping, so the resolver sees the same signal as from the keyboard).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerSignal {
    pub usage: u16,
    pub encoded_key: String,
    #[serde(default)]
    pub hypershift: bool,
}

/// The consumer signals the helper must translate; empty in key mode or for a
/// model without the consumer path.
pub fn consumer_signals(config: &crate::config::AppConfig) -> Vec<ConsumerSignal> {
    if !CONSUMER_SIGNALS.load(Ordering::Relaxed) {
        return Vec::new();
    }
    let model = config_model();
    onboard_bindings(config)
        .into_iter()
        .filter_map(|binding| {
            let usage = model.consumer_usage_for(&binding.control_id)?;
            let encoded_key = crate::hotkeys::parse_hotkey(&binding.encoded_key).ok()?.canonical;
            Some(ConsumerSignal { usage, encoded_key, hypershift: false })
        })
        .collect()
}

/// Key bindings (thumbs and top buttons) the mouse should hold on its own, mirroring the frontend's
/// `onboardBindings` (`src/lib/onboard-mapping.ts`): the standard layer only —
/// the mouse has no notion of Sidearm's layers, so hypershift stays a software
/// concern.
pub fn onboard_bindings(config: &crate::config::AppConfig) -> Vec<OnboardBinding> {
    thumb_bindings(&config.encoder_mappings)
}

/// The filter [`onboard_bindings`] applies, split out so it is testable without
/// building a whole config.
fn thumb_bindings(mappings: &[crate::config::EncoderMapping]) -> Vec<OnboardBinding> {
    mappings
        .iter()
        .filter(|mapping| mapping.layer == crate::config::Layer::Standard)
        .filter(|mapping| button_id_for_control(mapping.control_id.as_str()).is_some())
        .map(|mapping| OnboardBinding {
            control_id: mapping.control_id.as_str().to_string(),
            encoded_key: mapping.encoded_key.clone(),
        })
        .collect()
}

/// One requested button binding in the app's own terms: which control, and the
/// key it should emit. The config owns these; we only translate them.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardBinding {
    pub control_id: String,
    pub encoded_key: String,
}

/// What the mouse currently does, in the app's own terms: which control emits
/// which key. The frontend can show this without knowing the vendor protocol.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardMapping {
    pub control_id: String,
    pub encoded_key: String,
}

/// Which bindings the mouse confirmed, and which it did not.
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardReport {
    pub confirmed: Vec<OnboardMapping>,
    pub failed: Vec<String>,
}

/// One button record as the device holds it, read back with the per-button query
/// (no write in front of it, unlike the slot query the record path uses).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ButtonRecord {
    /// `0x02` when the button emits a key — the only category this app writes.
    pub category: u8,
    /// `0x00` for a bare `F13`..`F24`.
    pub modifier: u8,
    /// HID usage: `0x68`..`0x73` are `F13`..`F24`.
    pub usage: u8,
}

/// A record the firmware plays back on its own, without Sidearm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnboardAction {
    /// A key held while the button is down: the standard HID mask
    /// ([`left_modifier_bits`]) on a model with `plain_left_modifiers`, else
    /// [`modifier_bits`] (Shift and Alt as the right-hand keys).
    Key { modifier: u8, usage: u8 },
    /// One tap of a key per press, with a standard HID mask ([`left_modifier_bits`]):
    /// the turbo record, the V2 HyperSpeed's only one that plays the left Shift
    /// and Alt. Never for a model with `plain_left_modifiers`.
    KeyTap { modifier: u8, usage: u8 },
    /// A plain mouse button (`1` left … `5` forward).
    Mouse(u8),
    /// The firmware Hypershift key: while held, the buttons play their layer-1 records.
    Hypershift,
    /// A consumer-page usage; Sidearm's reserved ones produce no Windows input.
    Consumer(u16),
}

impl OnboardAction {
    /// `category, len, values…` as the set/get-button commands carry them.
    fn bytes(self) -> Vec<u8> {
        match self {
            Self::Key { modifier, usage } => vec![CATEGORY_KEY, 0x02, modifier, usage],
            Self::KeyTap { modifier, usage } => {
                let [hi, lo] = KEY_TAP_PERIOD_MS.to_be_bytes();
                vec![CATEGORY_TURBO_KEY, 0x04, modifier, usage, hi, lo]
            }
            Self::Mouse(value) => vec![CATEGORY_MOUSE, 0x01, value],
            Self::Hypershift => vec![CATEGORY_HYPERSHIFT, 0x01, 0x01],
            Self::Consumer(usage) => {
                let [hi, lo] = usage.to_be_bytes();
                vec![CATEGORY_CONSUMER, 0x02, hi, lo]
            }
        }
    }

    fn matches(self, held: &ButtonRecord) -> bool {
        match self {
            Self::Key { modifier, usage } => {
                held.category == CATEGORY_KEY && held.modifier == modifier && held.usage == usage
            }
            Self::KeyTap { modifier, usage } => {
                held.category == CATEGORY_TURBO_KEY && held.modifier == modifier && held.usage == usage
            }
            Self::Mouse(value) => held.is_mouse_button(value),
            Self::Hypershift => held.category == CATEGORY_HYPERSHIFT,
            Self::Consumer(usage) => {
                held.category == CATEGORY_CONSUMER && u16::from_be_bytes([held.modifier, held.usage]) == usage
            }
        }
    }
}

/// HID usage of a Windows virtual-key code, for the keys an onboard record
/// can carry. `None` for anything else (media keys, IME keys, …).
pub fn hid_usage_for_vk(vk: u16) -> Option<u8> {
    let vk = vk as u8;
    Some(match vk {
        0x41..=0x5A => 0x04 + (vk - 0x41),       // A..Z
        0x31..=0x39 => 0x1E + (vk - 0x31),       // 1..9
        0x30 => 0x27,                            // 0
        0x70..=0x7B => 0x3A + (vk - 0x70),       // F1..F12
        0x7C..=0x87 => USAGE_F13 + (vk - 0x7C),  // F13..F24
        0x60 => 0x62,                            // NumPad 0
        0x61..=0x69 => 0x59 + (vk - 0x61),       // NumPad 1..9
        0x0D => 0x28,
        0x1B => 0x29,
        0x08 => 0x2A,
        0x09 => 0x2B,
        0x20 => 0x2C,
        0xBD => 0x2D, // - _
        0xBB => 0x2E, // = +
        0xDB => 0x2F, // [ {
        0xDD => 0x30, // ] }
        0xDC => 0x31, // \ |
        0xBA => 0x33, // ; :
        0xDE => 0x34, // ' "
        0xC0 => 0x35, // ` ~
        0xBC => 0x36, // , <
        0xBE => 0x37, // . >
        0xBF => 0x38, // / ?
        0x14 => 0x39, // Caps Lock
        0x2C => 0x46, // Print Screen
        0x91 => 0x47, // Scroll Lock
        0x13 => 0x48, // Pause
        0x2D => 0x49, // Insert
        0x24 => 0x4A, // Home
        0x21 => 0x4B, // Page Up
        0x2E => 0x4C, // Delete
        0x23 => 0x4D, // End
        0x22 => 0x4E, // Page Down
        0x27 => 0x4F, // Right
        0x25 => 0x50, // Left
        0x28 => 0x51, // Down
        0x26 => 0x52, // Up
        0x5D => 0x65, // Menu
        _ => return None,
    })
}

impl ButtonRecord {
    /// A mouse-category record carries the button number in the byte a key
    /// record uses for its modifier.
    fn is_mouse_button(&self, value: u8) -> bool {
        self.category == CATEGORY_MOUSE && self.modifier == value
    }
}

/// Open handle to the vendor HID collection plus the feature-report plumbing.
pub struct VendorDevice {
    handle: HANDLE,
    /// Held for the handle's whole life: one exchange is a `SET_REPORT` followed
    /// by a separate `GET_REPORT`, so two users at once read each other's
    /// replies (measured: a restore read the guard's button reply, whose byte 8
    /// is the profile `0x01`, as "device stayed in mode 0x01", and the guard
    /// reported a rewritten button that was not). One user at a time.
    _exclusive: MutexGuard<'static, ()>,
    model: &'static NativeModel,
    pid: u16,
    path: String,
}

/// Serializes every [`VendorDevice`] of one catalog model in this process.
/// Two receivers never share replies, so two mice can be talked to at once.
static DEVICE_LOCKS: [Mutex<()>; crate::device_catalog::CATALOG_LEN] =
    [const { Mutex::new(()) }; crate::device_catalog::CATALOG_LEN];

fn device_lock(model: &'static NativeModel) -> MutexGuard<'static, ()> {
    let index = model.catalog_index();
    // A panic mid-exchange leaves no state behind the lock worth refusing for.
    DEVICE_LOCKS[index].lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The file a test run creates to make its fake-mice app quit.
#[cfg(feature = "fake-mice")]
pub(crate) fn fake_quit_file() -> Option<std::path::PathBuf> {
    Some(fake::files::dir()?.join("quit"))
}

#[cfg(not(feature = "fake-mice"))]
pub(crate) fn fake_quit_file() -> Option<std::path::PathBuf> {
    None
}

/// Catalog models whose vendor interface is present right now (the receiver
/// is plugged in; the mouse itself may sleep). When Windows cannot list (the
/// list changes mid-read during a plug burst), the last answer stands: a
/// failed read must not look like every mouse unplugged.
pub fn present_models() -> Vec<&'static NativeModel> {
    static LAST: Mutex<Vec<&'static NativeModel>> = Mutex::new(Vec::new());
    let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match present_hid_paths() {
        Ok(paths) => *last = models_in(&paths),
        Err(error) => log::warn!("[mouse] Could not list present HID devices, keeping the last list: {error}"),
    }
    last.clone()
}

/// Catalog models with a vendor interface among these upper-cased paths.
fn models_in(paths: &[String]) -> Vec<&'static NativeModel> {
    crate::device_catalog::CATALOG
        .iter()
        .copied()
        .filter(|model| {
            model.pids.iter().any(|pid| {
                let needle = interface_needle(model.vid, *pid, model.interface);
                paths.iter().any(|path| path.contains(&needle))
            })
        })
        .collect()
}

/// Upper-cased paths of every HID interface Windows reports as present.
fn present_hid_paths() -> Result<Vec<String>, String> {
    #[cfg(feature = "fake-mice")]
    if let Some(paths) = fake::files::present_paths() {
        return Ok(paths);
    }
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        CM_GET_DEVICE_INTERFACE_LIST_PRESENT, CM_Get_Device_Interface_List_SizeW, CM_Get_Device_Interface_ListW,
        CR_BUFFER_SMALL, CR_SUCCESS,
    };
    let guid = windows_sys::core::GUID::from_u128(0x4d1e55b2_f16f_11cf_88cb_001111000030);
    // The list can grow between the size query and the read: retry then.
    for _ in 0..3 {
        let mut len = 0u32;
        let status = unsafe {
            CM_Get_Device_Interface_List_SizeW(&mut len, &guid, std::ptr::null(), CM_GET_DEVICE_INTERFACE_LIST_PRESENT)
        };
        if status != CR_SUCCESS {
            return Err(format!("CM_Get_Device_Interface_List_SizeW returned {status}"));
        }
        let mut buffer = vec![0u16; len as usize];
        let status = unsafe {
            CM_Get_Device_Interface_ListW(
                &guid,
                std::ptr::null(),
                buffer.as_mut_ptr(),
                len,
                CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
            )
        };
        if status == CR_BUFFER_SMALL {
            continue;
        }
        if status != CR_SUCCESS {
            return Err(format!("CM_Get_Device_Interface_ListW returned {status}"));
        }
        return Ok(buffer
            .split(|&unit| unit == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf16_lossy(path).to_uppercase())
            .collect());
    }
    Err("the HID device list kept changing".into())
}

/// A failed open is still useful diagnostic evidence, without exporting the HID path.
pub fn unavailable_device_report(error: &str) -> String {
    format!("Sidearm {} device report\nWindows: {}\nDevice: unavailable\nReason: {}",
        env!("CARGO_PKG_VERSION"), windows_version(), crate::mouse_settings::public_read_error(error))
}

impl VendorDevice {
    /// Opens the vendor collection of the first catalog model found in the
    /// registry. `Err` carries the last model's failure.
    pub fn open_connected() -> Result<Self, String> {
        Self::open_first_model(|_| true)
    }

    /// The connected V2-family mouse whose buttons hold onboard records.
    pub fn open_onboard() -> Result<Self, String> {
        Self::open_first_model(|model| model.transport == crate::device_catalog::Transport::Onboard)
    }

    /// The connected mouse of a config device (`razer-naga`, `razer-naga-v3`).
    pub fn open_for_device(device_id: &str) -> Result<Self, String> {
        Self::open_first_model(|model| model.device_id == device_id)
    }

    /// Opens `model` under whichever of its PIDs is connected.
    pub fn open_model(model: &'static NativeModel) -> Result<Self, String> {
        Self::open_first_model(|candidate| candidate.is(model))
    }

    /// Opens the first catalog model accepted by `wanted`. `Err` carries the
    /// last model's failure, or [`NOT_CONNECTED`].
    fn open_first_model(wanted: impl Fn(&NativeModel) -> bool) -> Result<Self, String> {
        // A model that is simply not plugged in is not worth reporting; an
        // interface that exists but does not open is.
        let mut last_error = NOT_CONNECTED.to_string();
        for model in crate::device_catalog::CATALOG.iter().filter(|model| wanted(model)) {
            for pid in model.pids {
                match Self::open(model, *pid) {
                    Ok(device) => return Ok(device),
                    Err(error) if error == NO_INTERFACE => {}
                    Err(error) => last_error = format!("{}: {error}", model.name),
                }
            }
        }
        Err(last_error)
    }

    /// Opens the vendor collection of `model` under `pid`, discovering its
    /// interface path in the registry. `Err` carries an OS-error description.
    fn open(model: &'static NativeModel, pid: u16) -> Result<Self, String> {
        let exclusive = device_lock(model);
        let paths = find_paths(&interface_needle(model.vid, pid, model.interface))?;
        // A fake mouse answers through `fake::exchange`: no handle to open.
        #[cfg(feature = "fake-mice")]
        if fake::files::dir().is_some() {
            let path = paths.into_iter().next().ok_or_else(|| NO_INTERFACE.to_string())?;
            return Ok(Self { handle: INVALID_HANDLE_VALUE, _exclusive: exclusive, model, pid, path });
        }
        let (handle, path) = open_first(&paths, |path| {
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            // No requested rights: the vendor collection is held by Razer's driver
            // and refuses GENERIC_READ|GENERIC_WRITE to non-owners.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    0,
                    0x00000003, // FILE_SHARE_READ | FILE_SHARE_WRITE
                    std::ptr::null(),
                    3,          // OPEN_EXISTING
                    0x00000080, // FILE_ATTRIBUTE_NORMAL
                    INVALID_HANDLE_VALUE,
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok((handle, path.to_owned()));
            }
            let error = Error::last_os_error();
            // A leaf of a device no longer plugged in: absent, not failing.
            if matches!(error.raw_os_error(), Some(2 | 3 | 1167)) {
                // ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_DEVICE_NOT_CONNECTED
                Err(NO_INTERFACE.to_string())
            } else {
                Err(format!("{error}: CreateFileW({path})"))
            }
        })?;
        Ok(Self { handle, _exclusive: exclusive, model, pid, path })
    }

    /// A handle that reaches no device, for tests of pure checks.
    #[cfg(test)]
    pub(crate) fn test_handle(model: &'static NativeModel, pid: u16, path: &str) -> Self {
        Self { handle: INVALID_HANDLE_VALUE, _exclusive: device_lock(model), model, pid, path: path.into() }
    }

    /// The model this device was opened as.
    pub fn model(&self) -> &'static NativeModel {
        self.model
    }

    /// Every write that changes what a button does goes through here first: a
    /// model not proven on hardware may hold wrong button ids, and a wrong
    /// record can leave a button dead outside Sidearm.
    fn require_verified(&self) -> Result<(), String> {
        if !self.model.verified {
            Err(format!("{} is not verified yet: button records are not written", self.model.name))
        } else if self.model.transport != crate::device_catalog::Transport::Onboard {
            // Its buttons live in the reversible live map only (`live_overlay`).
            Err(format!("{} keeps no onboard profile records", self.model.name))
        } else {
            Ok(())
        }
    }

    /// Writes one button record into its slot and verifies it read back.
    /// `Err` means the mouse did not echo what we wrote.
    pub fn write_button(&self, button_id: u8, usage: u8, modifier: u8) -> Result<(), String> {
        self.require_verified()?;
        // A button with no vendor slot (the top buttons) takes the per-button command.
        let Some(slot) = self.model.slot_for(button_id) else {
            return self.write_record(button_id, 0, OnboardAction::Key { modifier, usage });
        };
        let payload = build_record(slot, button_id, usage, modifier);
        for _ in 0..2 {
            self.set_payload(&payload)?;
            for _ in 0..2 {
                let read = self.get_payload(slot)?;
                if record_matches(&payload, &read) {
                    return Ok(());
                }
            }
        }
        Err(format!("mouse did not confirm button {button_id:#02x} -> usage {usage:#02x}"))
    }

    /// Stores one binding target and requires it to read back. A consumer
    /// signal goes into both layers: should the firmware Hypershift ever fire,
    /// the button still sends Sidearm's inert signal instead of a leftover
    /// offline-profile shortcut.
    fn write_target(&self, button_id: u8, action: OnboardAction) -> Result<(), String> {
        match action {
            OnboardAction::Key { modifier, usage } => self.write_button(button_id, usage, modifier),
            OnboardAction::Consumer(_) => {
                self.write_record(button_id, 0, action)?;
                self.write_record(button_id, 1, action)
            }
            other => self.write_record(button_id, 0, other),
        }
    }

    /// Writes every requested binding in order, stopping at the first failed
    /// write. Bindings onboard memory cannot express are skipped, as in
    /// [`Self::drifted_bindings`]: they were never the mouse's job.
    pub fn apply_bindings(&self, bindings: &[OnboardBinding]) -> Result<(), String> {
        for binding in bindings {
            let Ok((button_id, action)) = binding_target(self.model, binding) else {
                continue;
            };
            self.write_target(button_id, action)?;
        }
        Ok(())
    }

    /// Confirms which bindings the mouse actually holds, by writing each one
    /// and requiring the mouse to echo it back. The vendor collection answers
    /// only with what the previous write stored, so the mouse cannot be read:
    /// a `GET_REPORT` after selecting a slot returns the marker we just wrote,
    /// never the slot's earlier content (proven on hardware, twice).
    pub fn verify(&self, bindings: &[OnboardBinding]) -> Result<OnboardReport, String> {
        let mut report = OnboardReport::default();
        for binding in bindings {
            let Ok((button_id, action)) = binding_target(self.model, binding) else {
                continue;
            };
            if self.write_target(button_id, action).is_ok() {
                report.confirmed.push(OnboardMapping {
                    control_id: binding.control_id.clone(),
                    encoded_key: binding.encoded_key.clone(),
                });
            } else {
                report.failed.push(binding.control_id.clone());
            }
        }
        Ok(report)
    }

    /// Current device mode: [`MODE_NORMAL`], [`MODE_DRIVER`], or a value this app
    /// does not know. Read from the device, not echoed from our last write — the
    /// command class answers with its own state (proven: it reported `Driver`
    /// while Razer's engine was running, and `Driver` is never written here).
    pub fn mode(&self) -> Result<u8, String> {
        let reply = self.command(CLASS_CONTROL, CMD_GET_MODE, &[0x00, 0x00])?;
        Ok(reply[8])
    }

    /// Puts the device back into [`MODE_NORMAL`] so the mouse emits the records
    /// written here, and returns the mode it replaced. The read-back is retried
    /// ([`MODE_CONFIRM_ATTEMPTS`]) because a transition is not a failure — only a
    /// mode that is still wrong after every attempt is an error.
    pub fn ensure_normal_mode(&self) -> Result<u8, String> {
        self.require_verified()?;
        let before = self.mode()?;
        if before == MODE_NORMAL {
            return Ok(before);
        }
        self.command(CLASS_CONTROL, CMD_SET_MODE, &[MODE_NORMAL, 0x00])?;
        let mut last = "no reply".to_string();
        for attempt in 0..MODE_CONFIRM_ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(MODE_CONFIRM_WAIT);
            }
            match self.mode() {
                Ok(MODE_NORMAL) => return Ok(before),
                Ok(after) if after == MODE_DRIVER => {
                    last = "Razer's driver re-asserted driver mode".to_string();
                }
                Ok(after) => last = format!("device stayed in mode {after:#04x}"),
                Err(message) => last = message,
            }
        }
        Err(last)
    }

    /// The record the device holds for one thumb button, read without writing
    /// anything. This is the only honest way to see what another program stored —
    /// the slot query answers with whatever the last write put there.
    pub fn read_button(&self, button_id: u8) -> Result<ButtonRecord, String> {
        self.read_button_at(button_id, 0)
    }

    /// The stored record of `button_id` on `layer` (`0` standard, `1` the
    /// firmware Hypershift layer).
    pub fn read_button_at(&self, button_id: u8, layer: u8) -> Result<ButtonRecord, String> {
        let block = self.read_block(ONBOARD_PROFILE, button_id, layer)?;
        Ok(ButtonRecord {
            category: block[0],
            modifier: block[2],
            usage: block[3],
        })
    }

    /// The 7 record bytes stored at `profile` / `button_id` / `layer`. A reply
    /// naming another address (another process's request) is refused.
    pub(crate) fn read_block(&self, profile: u8, button_id: u8, layer: u8) -> Result<[u8; 7], String> {
        let reply = self.command(CLASS_BUTTON, CMD_GET_BUTTON, &button_args(profile, button_id, layer, &[]))?;
        if reply[8..10] != [profile, button_id] {
            return Err(format!("readback returned the wrong address for profile {profile}, button {button_id:#04x}/{layer}"));
        }
        let mut block = [0u8; 7];
        block.copy_from_slice(&reply[11..18]);
        Ok(block)
    }

    /// Sends one record to `profile` / `button_id` / `layer`, unverified: the
    /// callers read it back their own way.
    pub(crate) fn set_block(&self, profile: u8, button_id: u8, layer: u8, record: &[u8]) -> Result<(), String> {
        self.command(CLASS_BUTTON, CMD_SET_BUTTON, &button_args(profile, button_id, layer, record)).map(|_| ())
    }

    /// Evaluate every independent query; only a failed field becomes unavailable.
    pub fn settings(&self) -> crate::mouse_settings::MouseSettings {
        let dpi = self.dpi().and_then(|value| {
            if (self.model.dpi_min..=self.model.dpi_max).contains(&value) { Ok(value) }
            else { Err(format!("DPI {value} is outside the model range")) }
        });
        crate::mouse_settings::MouseSettings::from_reads(self.battery_percent(), dpi, self.poll_rate_hz())
    }

    /// Shared header for summary and full reports; no serial or HID paths.
    fn report_header(&self) -> Vec<String> {
        let model = self.model;
        let show = |read: Result<String, String>| read.unwrap_or_else(|error| format!("error: {}", crate::mouse_settings::public_read_error(&error)));
        let settings = self.settings();
        let mut lines = vec![
            format!("Sidearm {} device report", env!("CARGO_PKG_VERSION")),
            format!("Windows: {}", windows_version()),
            format!("Model: {} ({})", model.name, if model.verified { "verified" } else { "not verified" }),
            format!("VID:PID {:04X}:{:04X}, interface MI_{:02X}", model.vid, self.pid, model.interface),
            format!("Firmware: {}", show(self.command(CLASS_CONTROL, CMD_GET_FIRMWARE, &[0x00, 0x00]).map(|reply| format!("v{}.{}", reply[8], reply[9])))),
            format!("Mode: {}", show(self.mode().map(|mode| format!("{mode:#04x}")))),
            format!("Readings: {:?}", settings.status),
            format!("DPI: {}", settings.dpi.map_or_else(|| "unavailable".into(), |n| n.to_string())),
            format!("Poll rate Hz: {}", settings.poll_rate_hz.map_or_else(|| "unavailable".into(), |n| n.to_string())),
            format!("Battery: {}", settings.battery_percent.map_or_else(|| "unavailable".into(), |n| format!("{n}%"))),
        ];
        for warning in settings.warnings {
            lines.push(format!("{:?}: {} {}", warning.field, warning.message.text, warning.details));
        }
        lines
    }

    /// Read-only summary, without the long button-record scan.
    pub fn probe_summary(&self) -> String {
        crate::mouse_settings::format_report(self.report_header(), crate::mouse_settings::ReportDetail::Summary, Vec::new)
    }

    /// Preserve the existing full model-verification report.
    pub fn probe_report(&self) -> String {
        crate::mouse_settings::format_report(self.report_header(), crate::mouse_settings::ReportDetail::Full, || {
            let mut lines = vec![String::new(), "Button records (class 0x02 / command 0x8c): id layer: record bytes".into()];
            let mut silent = 0;
            for button_id in 0..=u8::MAX {
                match self.raw_button_record(button_id, 0) {
                    Ok(record) => {
                        lines.push(record_line(button_id, 0, &record));
                        lines.push(match self.raw_button_record(button_id, 1) {
                            Ok(record) => record_line(button_id, 1, &record),
                            Err(error) => format!("{button_id:#04x} L1: error: {error}"),
                        });
                    }
                    Err(_) => silent += 1,
                }
            }
            lines.push(format!("{silent} ids did not answer"));
            lines
        })
    }

    /// The 10 record bytes `GET_BUTTON` answers for `button_id` on `layer`
    /// (address, then the record) exactly as the mouse sent them, unchecked:
    /// the device report characterizes models whose replies are not known yet.
    fn raw_button_record(&self, button_id: u8, layer: u8) -> Result<[u8; 10], String> {
        let reply = self.command(CLASS_BUTTON, CMD_GET_BUTTON, &button_args(ONBOARD_PROFILE, button_id, layer, &[]))?;
        let mut record = [0u8; 10];
        record.copy_from_slice(&reply[8..18]);
        Ok(record)
    }

    /// Battery charge in percent.
    pub fn battery_percent(&self) -> Result<u8, String> {
        let reply = self.command(CLASS_POWER, CMD_GET_BATTERY, &[0x00, 0x00])?;
        Ok(battery_percent_from_raw(reply[9]))
    }

    /// Current (live) DPI (X; this app always writes X = Y).
    pub fn dpi(&self) -> Result<u16, String> {
        self.dpi_in(NOSTORE)
    }

    fn dpi_in(&self, storage: u8) -> Result<u16, String> {
        let mut args = [0u8; 7];
        args[0] = storage;
        let reply = self.command(CLASS_DPI, CMD_GET_DPI, &args)?;
        Ok(u16::from_be_bytes([reply[9], reply[10]]))
    }

    /// Sets `dpi` for both axes — live only, or also kept across power cycles
    /// with `store` — and requires it to read back.
    pub fn set_dpi(&self, dpi: u16, store: bool) -> Result<(), String> {
        self.set_dpi_in(if store { VARSTORE } else { NOSTORE }, dpi)
    }

    /// Sets `dpi` in one storage: `NOSTORE` (live), `VARSTORE`, or — on a
    /// mouse with onboard banks — a bank number (the V3 keeps a DPI per bank,
    /// read with the same selector). Confirmed by reading that storage back.
    pub fn set_dpi_in(&self, storage: u8, dpi: u16) -> Result<(), String> {
        let (min, max) = (self.model.dpi_min, self.model.dpi_max);
        if !(min..=max).contains(&dpi) {
            return Err(format!("DPI {dpi} is outside {min}..={max}"));
        }
        let [hi, lo] = dpi.to_be_bytes();
        // Every exit stores the offline DPI: one already held on both axes is
        // not rewritten.
        let mut args = [0u8; 7];
        args[0] = storage;
        if self.command(CLASS_DPI, CMD_GET_DPI, &args)?[9..13] == [hi, lo, hi, lo] {
            return Ok(());
        }
        self.command(CLASS_DPI, CMD_SET_DPI, &[storage, hi, lo, hi, lo, 0x00, 0x00])?;
        match self.dpi_in(storage)? {
            read if read == dpi => Ok(()),
            read => Err(format!("mouse kept DPI {read} after a write of {dpi}")),
        }
    }

    /// Current poll rate in Hz.
    pub fn poll_rate_hz(&self) -> Result<u16, String> {
        let reply = self.command(CLASS_CONTROL, CMD_GET_POLL_RATE, &[0x00])?;
        self.model
            .hz_for_poll_code(reply[8]).ok_or_else(|| format!("unknown poll rate code {:#04x}", reply[8]))
    }

    /// Sets the poll rate and requires it to read back.
    pub fn set_poll_rate_hz(&self, hz: u16) -> Result<(), String> {
        let code = self.model.poll_code_for_hz(hz).ok_or_else(|| format!("unsupported poll rate {hz} Hz"))?;
        self.command(CLASS_CONTROL, CMD_SET_POLL_RATE, &[code])?;
        match self.poll_rate_hz()? {
            read if read == hz => Ok(()),
            read => Err(format!("mouse kept {read} Hz after a write of {hz} Hz")),
        }
    }

    /// Stores `action` as the record of `button_id` on `layer` and requires it
    /// to read back (measured: a layer-1 key and a layer-0 mouse button both
    /// read back exactly as written). A record already in place is not written
    /// again: every exit and every retry of a sleeping mouse would wear it.
    pub fn write_record(&self, button_id: u8, layer: u8, action: OnboardAction) -> Result<(), String> {
        self.require_verified()?;
        if action.matches(&self.read_button_at(button_id, layer)?) {
            return Ok(());
        }
        self.set_block(ONBOARD_PROFILE, button_id, layer, &action.bytes())?;
        let held = self.read_button_at(button_id, layer)?;
        if action.matches(&held) {
            Ok(())
        } else {
            Err(format!("button {button_id:#04x} layer {layer} did not read back as {action:?}"))
        }
    }

    /// Puts every listed native control back to its plain mouse button; `Err`
    /// names the first one the device did not confirm.
    pub fn restore_native_buttons(&self, control_ids: &[&str]) -> Result<(), String> {
        for &(control_id, button_id, value) in self.model.native_buttons {
            if control_ids.contains(&control_id) {
                self.restore_native_button(button_id, value)
                    .map_err(|error| format!("{control_id}: {error}"))?;
            }
        }
        Ok(())
    }

    /// Whether the button still acts as the plain mouse button `value`. Razer's
    /// engine stores its own profile here too, and with Hypershift assigned to a
    /// button (category `0x0c`) the firmware swallows that button — the software
    /// Hypershift trigger then never reaches the mouse hook (measured: the right
    /// button read `0c 01 01` on both layers while Synapse's layer-1 shortcuts
    /// were emitted by the mouse itself). Read twice before it counts, like
    /// [`Self::drifted_bindings`].
    pub fn native_button_drifted(&self, button_id: u8, value: u8) -> Result<bool, String> {
        for _ in 0..2 {
            if self.read_button(button_id)?.is_mouse_button(value) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Writes the standard-layer record of `button_id` back to the plain mouse
    /// button `value` and requires the device to read it back.
    pub fn restore_native_button(&self, button_id: u8, value: u8) -> Result<(), String> {
        self.write_record(button_id, 0, OnboardAction::Mouse(value))
    }

    /// Control ids whose stored record no longer matches `bindings` — the buttons
    /// another program rewrote (Razer stores its own profile in the same slots).
    /// Read-only, so it is safe to run on a timer while the user works. Bindings
    /// this app cannot express are skipped: they were never written here.
    ///
    /// A mismatch is read twice before it counts: a read that catches the device
    /// mid-transition answers with plausible but wrong bytes (measured on hardware
    /// while the mode was being switched back).
    pub fn drifted_bindings(&self, bindings: &[OnboardBinding]) -> Result<Vec<String>, String> {
        let mut drifted = Vec::new();
        for binding in bindings {
            let Ok((button_id, action)) = binding_target(self.model, binding) else {
                continue;
            };
            if self.holds(button_id, action)? {
                continue;
            }
            if self.holds(button_id, action)? {
                continue;
            }
            drifted.push(binding.control_id.clone());
        }
        Ok(drifted)
    }

    /// Whether `control_id`'s button holds Sidearm's own signal of the *other*
    /// mode (`F13`..`F24` while consumer signals are on, or the reverse): a
    /// switch of signal kind, rewritten quietly instead of reported as Razer
    /// taking the mouse over.
    pub fn holds_other_signal(&self, bindings: &[OnboardBinding], control_id: &str) -> Result<bool, String> {
        let Some(binding) = bindings.iter().find(|b| b.control_id == control_id) else {
            return Ok(false);
        };
        let other_mode = !CONSUMER_SIGNALS.load(Ordering::Relaxed);
        match (target_in_mode(self.model, binding, other_mode), binding_target(self.model, binding)) {
            (Ok(other), Ok(current)) if other != current => self.holds(other.0, other.1),
            _ => Ok(false),
        }
    }

    /// Control ids of the model's native buttons that no longer act as their plain mouse
    /// button — Hypershift (`0x0c`), a key or a macro stored over them.
    pub fn drifted_native_buttons(&self) -> Result<Vec<&'static str>, String> {
        let mut drifted = Vec::new();
        for &(control_id, button_id, value) in self.model.native_buttons {
            if self.native_button_drifted(button_id, value)? {
                drifted.push(control_id);
            }
        }
        Ok(drifted)
    }

    /// Whether the device's stored standard-layer record for `button_id` is
    /// `action`, as this app writes it.
    fn holds(&self, button_id: u8, action: OnboardAction) -> Result<bool, String> {
        Ok(action.matches(&self.read_button(button_id)?))
    }

    /// Sends one command-class request and returns the reply payload, whose byte
    /// 0 carries the status. The device answers `busy` while it finishes an
    /// internal write, so a busy reply is retried instead of reported.
    fn command(&self, class: u8, command: u8, args: &[u8]) -> Result<[u8; PAYLOAD_LEN], String> {
        let payload = build_command(self.model.transaction_id, class, command, args);
        for _ in 0..COMMAND_RETRIES {
            let reply = self.exchange(&payload)?;
            match reply[0] {
                // Razer's driver shares this report from another process: a
                // reply to someone else's request is not ours — ask again.
                COMMAND_STATUS_OK if !reply_matches(&payload, &reply) => {}
                COMMAND_STATUS_OK => return Ok(reply),
                COMMAND_STATUS_BUSY => std::thread::sleep(COMMAND_BUSY_WAIT),
                COMMAND_STATUS_NO_RESPONSE => {
                    return Err(format!("{NO_RESPONSE}: command {class:#04x}/{command:#04x}"));
                }
                status => {
                    return Err(format!(
                        "command {class:#04x}/{command:#04x} answered status {status:#04x}"
                    ));
                }
            }
        }
        Err(format!("command {class:#04x}/{command:#04x} stayed busy"))
    }

    /// One request and its reply.
    fn exchange(&self, payload: &[u8; PAYLOAD_LEN]) -> Result<[u8; PAYLOAD_LEN], String> {
        #[cfg(any(test, feature = "fake-mice"))]
        if let Some(reply) = fake::exchange(self.model, payload) {
            return Ok(reply);
        }
        self.set_payload(payload)?;
        std::thread::sleep(COMMAND_SETTLE);
        self.read_reply()
    }

    /// Reads a feature reply without selecting a slot: command-class replies
    /// describe the device's own state, not a slot's content.
    fn read_reply(&self) -> Result<[u8; PAYLOAD_LEN], String> {
        self.get_payload(0)
    }

    fn set_payload(&self, payload: &[u8; PAYLOAD_LEN]) -> Result<(), String> {
        #[cfg(any(test, feature = "fake-mice"))]
        if fake::set_slot(self.model, payload) {
            return Ok(());
        }
        let mut buffer = [0u8; PAYLOAD_LEN + 1];
        buffer[0] = REPORT_ID;
        buffer[1..].copy_from_slice(payload);
        if !unsafe {
            HidD_SetFeature(self.handle, buffer.as_ptr() as *const core::ffi::c_void,
                            buffer.len() as u32)
        } {
            return Err(format!("HidD_SetFeature: {}", Error::last_os_error()));
        }
        Ok(())
    }

    fn get_payload(&self, slot: u8) -> Result<[u8; PAYLOAD_LEN], String> {
        #[cfg(any(test, feature = "fake-mice"))]
        if let Some(payload) = fake::get_slot(self.model, slot) {
            return Ok(payload);
        }
        let mut buffer = [0u8; PAYLOAD_LEN + 1];
        buffer[0] = REPORT_ID;
        buffer[1] = slot;
        if !unsafe {
            HidD_GetFeature(self.handle, buffer.as_mut_ptr() as *mut core::ffi::c_void,
                            buffer.len() as u32)
        } {
            return Err(format!("HidD_GetFeature: {}", Error::last_os_error()));
        }
        let mut payload = [0u8; PAYLOAD_LEN];
        payload.copy_from_slice(&buffer[1..]);
        Ok(payload)
    }
}

impl Drop for VendorDevice {
    fn drop(&mut self) {
        unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            CloseHandle(self.handle);
        }
    }
}

/// Windows edition and build for the device report, e.g. `24H2 (build 26100)`.
fn windows_version() -> String {
    use windows_sys::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};
    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() };
    let key = wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let read = |name: &str| -> String {
        let name = wide(name);
        let mut buffer = [0u16; 64];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        let status = unsafe {
            RegGetValueW(HKEY_LOCAL_MACHINE, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ,
                         std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size)
        };
        if status != 0 {
            return "?".to_string();
        }
        let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..len])
    };
    format!("{} (build {})", read("DisplayVersion"), read("CurrentBuild"))
}

/// One button line of [`VendorDevice::probe_report`]: `0x40 L0: 01 40 00 02 …`.
fn record_line(button_id: u8, layer: u8, record: &[u8]) -> String {
    let bytes: Vec<String> = record.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{button_id:#04x} L{layer}: {}", bytes.join(" "))
}

/// Payload of one command-class request: transaction byte, argument length,
/// class, command, arguments, checksum. Every command in this module goes
/// through here, so its golden tests pin the bytes on the wire.
fn build_command(transaction_id: u8, class: u8, command: u8, args: &[u8]) -> [u8; PAYLOAD_LEN] {
    let mut payload = [0u8; PAYLOAD_LEN];
    payload[1] = transaction_id;
    payload[5] = args.len() as u8;
    payload[6] = class;
    payload[7] = command;
    payload[8..8 + args.len()].copy_from_slice(args);
    payload[88] = checksum(&payload);
    payload
}

/// Whether a command reply answers `request`: the device echoes the class and
/// the command (OpenRazer checks the same two bytes).
fn reply_matches(request: &[u8; PAYLOAD_LEN], reply: &[u8; PAYLOAD_LEN]) -> bool {
    reply[6..8] == request[6..8]
}

/// Whether `error` is a command the mouse did not answer — asleep, not taken
/// over: the guard backs off instead of polling it every few seconds.
pub fn is_no_response(error: &str) -> bool {
    error.starts_with(NO_RESPONSE)
}

/// Opens the first of `paths` that `open` accepts: the registry keeps leaves of
/// devices no longer present (another USB port, a re-paired dongle) and only
/// the live one opens. `Err` carries the last failure.
pub fn open_first<T>(paths: &[String], mut open: impl FnMut(&str) -> Result<T, String>) -> Result<T, String> {
    let mut last = NO_INTERFACE.to_string();
    for path in paths {
        match open(path) {
            Ok(opened) => return Ok(opened),
            Err(error) => last = error,
        }
    }
    Err(last)
}

fn build_record(slot: u8, button_id: u8, usage: u8, modifier: u8) -> [u8; PAYLOAD_LEN] {
    let mut payload = [0u8; PAYLOAD_LEN];
    payload[0] = 0x00;
    payload[1] = slot;
    payload[5..9].copy_from_slice(&RECORD_MARKER);
    payload[9] = button_id;
    // The standard record; layer 1 plays only under the firmware Hypershift.
    payload[10] = 0x00;
    payload[11] = 0x02;
    payload[12] = 0x02;
    payload[13] = modifier;
    payload[14] = usage;
    payload[88] = checksum(&payload);
    payload
}

fn record_matches(written: &[u8; PAYLOAD_LEN], read: &[u8; PAYLOAD_LEN]) -> bool {
    written[5..15] == read[5..15] && written[88] == read[88]
}

/// Device paths of the config model's consumer collection (`…&MI_01&Col03#…`)
/// for the capture helper's reader: every matching leaf of every PID, since the
/// registry keeps leaves of devices no longer present (another USB port, a
/// re-paired dongle) and only the live one opens.
pub fn consumer_collection_paths(model: &NativeModel) -> Result<Vec<String>, String> {
    // A fake mouse's buttons come through a pipe a test writes.
    #[cfg(feature = "fake-mice")]
    if fake::files::dir().is_some() {
        return Ok(vec![fake::files::report_pipe(model)]);
    }
    let consumer = model.consumer.as_ref().ok_or_else(|| format!("{} has no consumer signals", model.name))?;
    let paths: Vec<String> = model
        .pids
        .iter()
        .filter_map(|pid| find_paths(&collection_needle(model.vid, *pid, consumer.interface, consumer.collection)).ok())
        .flatten()
        .collect();
    if paths.is_empty() { Err(NO_INTERFACE.to_string()) } else { Ok(paths) }
}

/// A top-level collection's leaf: the interface needle plus `&COLxx`, closed by
/// the `#` that ends the hardware id so `Col03` never matches `Col03&Col01`.
fn collection_needle(vid: u16, pid: u16, interface: u8, collection: u8) -> String {
    format!("{}&COL{collection:02X}#", interface_needle(vid, pid, interface))
}

fn find_paths(needle: &str) -> Result<Vec<String>, String> {
    #[cfg(feature = "fake-mice")]
    if let Some(paths) = fake::files::present_paths() {
        return Ok(paths.into_iter().filter(|path| path.contains(needle)).collect());
    }
    let classes_path: Vec<u16> = DEVICE_CLASSES
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut classes: HKEY = std::ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            classes_path.as_ptr(),
            0,
            KEY_READ,
            &mut classes,
        )
    };
    if status != 0 {
        return Err(format!("RegOpenKeyExW({DEVICE_CLASSES}): {}", Error::last_os_error()));
    }
    let result = find_class_key(classes, needle);
    unsafe { RegCloseKey(classes) };
    result
}

/// What a vendor collection's registry leaf contains: the device and the USB
/// interface carrying the vendor reports (`&MI_00` on the V2 HyperSpeed; its
/// `MI_01`/`MI_02` collections answer no vendor command).
fn interface_needle(vid: u16, pid: u16, interface: u8) -> String {
    format!("VID_{vid:04X}&PID_{pid:04X}&MI_{interface:02X}")
}

/// Device path of a registry leaf (`##?#HID#VID_…&MI_00#…#{guid}` →
/// `\\?\HID#VID_…#{guid}`) when it belongs to the wanted interface. The first
/// matching leaf wins; on the V2 HyperSpeed that is the bare `MI_00`, listed
/// before its `MI_00&Col03&…` sub-collections.
fn interface_path(leaf: &str, needle: &str) -> Option<String> {
    let rest = leaf.strip_prefix("##?#")?;
    rest.to_uppercase().contains(needle).then(|| format!(r"\\?\{rest}"))
}

fn find_class_key(classes: HKEY, needle: &str) -> Result<Vec<String>, String> {
    let mut index = 0u32;
    loop {
        let mut name = [0u16; 64];
        let mut len = name.len() as u32;
        if unsafe { RegEnumKeyExW(classes, index, name.as_mut_ptr(), &mut len,
                                  std::ptr::null_mut(), std::ptr::null_mut(),
                                  std::ptr::null_mut(), std::ptr::null_mut()) }
            != 0
        {
            return Err("no HID interface class found in the registry".to_string());
        }
        let candidate = String::from_utf16_lossy(&name[..len as usize]);
        if candidate.eq_ignore_ascii_case(HID_INTERFACE_GUID) {
            return find_leaf(classes, candidate, needle);
        }
        index += 1;
    }
}

/// Opens the class key through the already-open `DeviceClasses` handle: its name
/// is only a subkey, so it cannot be resolved from the root of HKLM.
fn find_leaf(parent: HKEY, class: String, needle: &str) -> Result<Vec<String>, String> {
    let mut class_key: HKEY = std::ptr::null_mut();
    let wide: Vec<u16> = class
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let status = unsafe { RegOpenKeyExW(parent, wide.as_ptr(), 0, KEY_READ, &mut class_key) };
    if status != 0 {
        return Err(format!(
            "RegOpenKeyExW({DEVICE_CLASSES}\\{class}): {}",
            Error::last_os_error()
        ));
    }
    // Every matching leaf, in registry order: the first is what the vendor
    // collection opens; the consumer reader tries them all.
    let mut paths = Vec::new();
    let mut index = 0u32;
    loop {
        let mut name = [0u16; 512];
        let mut len = name.len() as u32;
        if unsafe { RegEnumKeyExW(class_key, index, name.as_mut_ptr(), &mut len,
                                  std::ptr::null_mut(), std::ptr::null_mut(),
                                  std::ptr::null_mut(), std::ptr::null_mut()) }
            != 0
        {
            break;
        }
        let leaf = String::from_utf16_lossy(&name[..len as usize]);
        paths.extend(interface_path(&leaf, needle));
        index += 1;
    }
    unsafe { RegCloseKey(class_key) };
    if paths.is_empty() { Err(NO_INTERFACE.to_string()) } else { Ok(paths) }
}

/// A mouse that answers [`VendorDevice::command`] without hardware: records
/// per (profile or bank, button, layer), DPI per storage, the poll code, the
/// battery, a V3's onboard banks and a slot path; it can sleep (status `0x04`)
/// or refuse (status `0x03`) chosen commands. Unit tests install one on their
/// thread; a build with the `fake-mice` feature run with `SIDEARM_FAKE_MICE`
/// set keeps one per model in `<dir>/<device id>.json`, shared by the app, its
/// capture helper and the restore process (no file = not plugged in).
#[cfg(any(test, feature = "fake-mice"))]
pub(crate) mod fake {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
    #[serde(default, rename_all = "camelCase")]
    pub(crate) struct FakeMouse {
        #[serde(with = "record_list")]
        pub records: HashMap<(u8, u8, u8), [u8; 7]>,
        /// Every record write, in order.
        #[serde(skip)]
        pub writes: Vec<(u8, u8, u8)>,
        /// A block one next read of that address returns instead (a firmware
        /// transition), then the stored one again.
        #[serde(skip)]
        pub odd_once: HashMap<(u8, u8, u8), [u8; 7]>,
        pub dpi: HashMap<u8, u16>,
        #[serde(skip)]
        pub dpi_writes: usize,
        pub poll_code: u8,
        /// Commands answered as a sleeping mouse, as `(class, command)`.
        #[serde(skip)]
        pub asleep_for: Vec<(u8, u8)>,
        /// Commands refused with another status.
        #[serde(skip)]
        pub refused: Vec<(u8, u8)>,
        /// Every command is answered as a sleeping mouse.
        pub asleep: bool,
        /// Raw battery level (`0..=255`).
        pub battery: u8,
        /// Onboard banks holding a profile, and the one playing (a V3).
        pub banks: Vec<u8>,
        pub active_bank: u8,
        /// Slot-path payloads by slot, as the last `SET_REPORT` left them.
        pub slots: HashMap<u8, Vec<u8>>,
    }

    /// JSON object keys are strings: records travel as a list.
    mod record_list {
        use std::collections::HashMap;

        type Records = HashMap<(u8, u8, u8), [u8; 7]>;

        pub fn serialize<S: serde::Serializer>(records: &Records, serializer: S) -> Result<S::Ok, S::Error> {
            let mut list: Vec<(u8, u8, u8, [u8; 7])> = records.iter().map(|(&(p, b, l), &block)| (p, b, l, block)).collect();
            list.sort_unstable();
            serde::Serialize::serialize(&list, serializer)
        }

        pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Records, D::Error> {
            let list: Vec<(u8, u8, u8, [u8; 7])> = serde::Deserialize::deserialize(deserializer)?;
            Ok(list.into_iter().map(|(p, b, l, block)| ((p, b, l), block)).collect())
        }
    }

    thread_local! {
        static FAKE: RefCell<Option<FakeMouse>> = const { RefCell::new(None) };
    }

    #[cfg(test)]
    /// Installs `mouse` on this thread until the returned guard drops.
    #[must_use]
    pub(crate) fn install(mouse: FakeMouse) -> Installed {
        FAKE.with(|cell| *cell.borrow_mut() = Some(mouse));
        Installed
    }

    #[cfg(test)]
    pub(crate) struct Installed;

    #[cfg(test)]
    impl Drop for Installed {
        fn drop(&mut self) {
            FAKE.with(|cell| *cell.borrow_mut() = None);
        }
    }

    #[cfg(test)]
    pub(crate) fn with<R>(work: impl FnOnce(&mut FakeMouse) -> R) -> R {
        FAKE.with(|cell| work(cell.borrow_mut().as_mut().expect("a fake mouse is installed")))
    }

    /// The reply of the fake mouse `model` stands for, when there is one.
    pub(super) fn exchange(model: &NativeModel, payload: &[u8; PAYLOAD_LEN]) -> Option<[u8; PAYLOAD_LEN]> {
        if let Some(reply) = FAKE.with(|cell| cell.borrow_mut().as_mut().map(|mouse| answer(mouse, payload))) {
            return Some(reply);
        }
        #[cfg(feature = "fake-mice")]
        if let Some(reply) = files::with(model, |mouse| answer(mouse, payload)) {
            return Some(reply);
        }
        let _ = model;
        None
    }

    fn answer(mouse: &mut FakeMouse, payload: &[u8; PAYLOAD_LEN]) -> [u8; PAYLOAD_LEN] {
        let (class, command) = (payload[6], payload[7]);
        let args = &payload[8..18];
        let key = (args[0], args[1], args[2]);
        let mut reply = *payload;
        reply[0] = if mouse.asleep || mouse.asleep_for.contains(&(class, command)) {
            COMMAND_STATUS_NO_RESPONSE
        } else if mouse.refused.contains(&(class, command)) {
            0x03
        } else {
            COMMAND_STATUS_OK
        };
        if reply[0] != COMMAND_STATUS_OK {
            return reply;
        }
        match (class, command) {
            (CLASS_BUTTON, CMD_GET_BUTTON) => {
                let block = mouse.odd_once.remove(&key).or_else(|| mouse.records.get(&key).copied()).unwrap_or_default();
                reply[11..18].copy_from_slice(&block);
            }
            (CLASS_BUTTON, CMD_SET_BUTTON) => {
                let mut block = [0u8; 7];
                block.copy_from_slice(&args[3..10]);
                mouse.records.insert(key, block);
                mouse.writes.push(key);
            }
            (CLASS_DPI, CMD_GET_DPI) => {
                let [hi, lo] = mouse.dpi.get(&args[0]).copied().unwrap_or(800).to_be_bytes();
                reply[9..13].copy_from_slice(&[hi, lo, hi, lo]);
            }
            (CLASS_DPI, CMD_SET_DPI) => {
                mouse.dpi.insert(args[0], u16::from_be_bytes([args[1], args[2]]));
                mouse.dpi_writes += 1;
            }
            (CLASS_CONTROL, CMD_GET_POLL_RATE) => reply[8] = mouse.poll_code,
            (CLASS_CONTROL, CMD_SET_POLL_RATE) => mouse.poll_code = args[0],
            (CLASS_POWER, CMD_GET_BATTERY) => reply[9] = mouse.battery,
            (FAKE_CLASS_BANKS, 0x80) => reply[8] = mouse.banks.len() as u8,
            (FAKE_CLASS_BANKS, 0x81) => {
                reply[8] = 5;
                reply[9..14].fill(0);
                for (slot, bank) in reply[9..14].iter_mut().zip(&mouse.banks) {
                    *slot = *bank;
                }
            }
            (FAKE_CLASS_BANKS, 0x84) => reply[8] = mouse.active_bank,
            // Selecting a bank reloads the live map (bank 0) from it.
            (FAKE_CLASS_BANKS, 0x04) if mouse.banks.contains(&args[0]) => {
                mouse.active_bank = args[0];
                let loaded: Vec<_> = mouse.records.iter().filter(|((bank, _, _), _)| *bank == args[0]).map(|(&(_, b, l), &block)| ((0, b, l), block)).collect();
                mouse.records.extend(loaded);
            }
            // Mode reads answer `MODE_NORMAL` (args echo zeros).
            _ => {}
        }
        reply
    }

    /// The onboard banks' command class (`live_overlay`).
    const FAKE_CLASS_BANKS: u8 = 0x05;

    /// The slot path (`write_button`): a `SET_REPORT` stores the payload under
    /// its slot, a `GET_REPORT` of that slot returns it.
    pub(super) fn set_slot(model: &NativeModel, payload: &[u8; PAYLOAD_LEN]) -> bool {
        let stored = FAKE.with(|cell| cell.borrow_mut().as_mut().map(|mouse| mouse.slots.insert(payload[0], payload.to_vec())).is_some());
        #[cfg(feature = "fake-mice")]
        let stored = stored || files::with(model, |mouse| mouse.slots.insert(payload[0], payload.to_vec())).is_some();
        let _ = model;
        stored
    }

    pub(super) fn get_slot(model: &NativeModel, slot: u8) -> Option<[u8; PAYLOAD_LEN]> {
        let read = |mouse: &mut FakeMouse| {
            let mut payload = [0u8; PAYLOAD_LEN];
            if let Some(stored) = mouse.slots.get(&slot) {
                payload.copy_from_slice(stored);
            }
            payload
        };
        if let Some(payload) = FAKE.with(|cell| cell.borrow_mut().as_mut().map(read)) {
            return Some(payload);
        }
        #[cfg(feature = "fake-mice")]
        if let Some(payload) = files::with(model, read) {
            return Some(payload);
        }
        let _ = model;
        None
    }

    /// The app's fake mice: one JSON file per plugged-in model.
    #[cfg(feature = "fake-mice")]
    pub(crate) mod files {
        use super::FakeMouse;
        use crate::device_catalog::{CATALOG, NativeModel};
        use std::path::PathBuf;

        /// `SIDEARM_FAKE_MICE`: the folder of the fake mice; unset = real hardware.
        pub(crate) fn dir() -> Option<PathBuf> {
            std::env::var_os("SIDEARM_FAKE_MICE").map(PathBuf::from)
        }

        fn state_path(model: &NativeModel) -> Option<PathBuf> {
            Some(dir()?.join(format!("{}.json", model.device_id)))
        }

        /// Runs `work` on `model`'s fake mouse under a file lock (the app, its
        /// helper and the restore process share it; the lock goes with a killed
        /// process). `None`: fake mode is off or the mouse is unplugged.
        pub(crate) fn with<R>(model: &NativeModel, work: impl FnOnce(&mut FakeMouse) -> R) -> Option<R> {
            let path = state_path(model)?;
            if !path.exists() {
                return None;
            }
            let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path.with_extension("lock")).ok()?;
            lock.lock().ok()?;
            let mut mouse: FakeMouse = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
            let result = work(&mut mouse);
            let temp = path.with_extension("tmp");
            let saved = serde_json::to_vec_pretty(&mouse).ok().and_then(|bytes| std::fs::write(&temp, bytes).ok()).and_then(|()| std::fs::rename(&temp, &path).ok());
            if saved.is_none() {
                log::warn!("[fake-mice] {} not saved", path.display());
            }
            Some(result)
        }

        /// Upper-cased HID paths of the plugged-in fake mice: the vendor
        /// interface and, for a model with signals, the consumer collection.
        pub(crate) fn present_paths() -> Option<Vec<String>> {
            dir()?;
            Some(
                CATALOG
                    .iter()
                    .filter(|model| state_path(model).is_some_and(|path| path.exists()))
                    .flat_map(|model| {
                        let pid = model.pids[0];
                        let mut paths = vec![format!("\\\\?\\HID#VID_{:04X}&PID_{pid:04X}&MI_{:02X}#FAKE", model.vid, model.interface)];
                        if let Some(consumer) = &model.consumer {
                            paths.push(format!(
                                "\\\\?\\HID#VID_{:04X}&PID_{pid:04X}&MI_{:02X}&COL{:02X}#FAKE",
                                model.vid, consumer.interface, consumer.collection
                            ));
                        }
                        paths
                    })
                    .collect(),
            )
        }

        /// The pipe a test writes `model`'s button reports into (the consumer
        /// reader opens it instead of the HID collection).
        pub(crate) fn report_pipe(model: &NativeModel) -> String {
            format!("\\\\.\\pipe\\sidearm-fake-{}", model.device_id)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_catalog::NAGA_V2_HYPERSPEED;

    /// The turbo record the hardware played with the left Shift/Alt: category
    /// `0d`, four data bytes, period 10 000 ms big-endian.
    #[test]
    fn a_key_tap_is_a_turbo_record_with_a_long_period() {
        let tap = OnboardAction::KeyTap { modifier: 0x04, usage: 0x3d };
        assert_eq!(tap.bytes(), [0x0d, 0x04, 0x04, 0x3d, 0x27, 0x10]);
        assert_eq!(left_modifier_bits(true, true, true, true), 0x0f);
        let held = ButtonRecord { category: 0x0d, modifier: 0x04, usage: 0x3d };
        assert!(tap.matches(&held));
        assert!(!OnboardAction::Key { modifier: 0x04, usage: 0x3d }.matches(&held));
    }

    /// Alt+F4 as Synapse stores it: a plain record with the standard mask.
    #[test]
    fn a_plain_key_record_is_the_form_synapse_stores() {
        let alt_f4 = OnboardAction::Key { modifier: left_modifier_bits(false, false, true, false), usage: 0x3d };
        assert_eq!(alt_f4.bytes(), [0x02, 0x02, 0x04, 0x3d]);
    }

    #[test]
    fn modifier_bits_use_the_keys_the_firmware_plays() {
        assert_eq!(modifier_bits(true, false, false, false), 0x01);
        assert_eq!(modifier_bits(false, true, false, false), 0x20);
        assert_eq!(modifier_bits(false, false, true, false), 0x40);
        assert_eq!(modifier_bits(false, true, true, true), 0x68);
    }

    /// A reply counts only when it echoes the request's class and command:
    /// Razer's driver can read our report slot first and leave us its reply.
    #[test]
    fn a_reply_must_echo_the_class_and_command() {
        let request = build_command(0x1f, CLASS_CONTROL, CMD_GET_MODE, &[0x00, 0x00]);
        let mut reply = request;
        reply[0] = COMMAND_STATUS_OK;
        reply[8] = 0x03;
        assert!(reply_matches(&request, &reply));
        let foreign = build_command(0x1f, CLASS_BUTTON, CMD_GET_BUTTON, &button_args(ONBOARD_PROFILE, 0, 0, &[]));
        assert!(!reply_matches(&request, &foreign));
    }

    #[test]
    fn no_response_is_told_apart_from_other_failures() {
        assert!(is_no_response(&format!("{NO_RESPONSE}: command 0x00/0x84")));
        assert!(!is_no_response("command 0x00/0x84 answered status 0x03"));
    }

    /// The first path that opens wins; stale leaves before it are skipped.
    #[test]
    fn open_first_skips_paths_that_do_not_open() {
        let paths = ["stale".to_string(), "live".to_string(), "later".to_string()];
        let opened = open_first(&paths, |path| if path == "stale" { Err(format!("{path}: gone")) } else { Ok(path.to_string()) });
        assert_eq!(opened, Ok("live".to_string()));
        assert_eq!(open_first(&paths[..1], |path| Err::<(), _>(format!("{path}: gone"))), Err("stale: gone".to_string()));
        assert_eq!(open_first(&[], |_| Ok(())), Err(NO_INTERFACE.to_string()));
    }

    #[test]
    fn probe_record_line_is_id_layer_and_hex_bytes() {
        let record = [0x01, 0x40, 0x00, 0x02, 0x02, 0x00, 0x68, 0x00, 0x00, 0x00];
        assert_eq!(record_line(0x40, 1, &record), "0x40 L1: 01 40 00 02 02 00 68 00 00 00");
    }

    /// Slot payloads captured from Synapse's own `GET_REPORT` replies, with the
    /// checksum byte it stored at offset 88.
    /// Slot, the ten record bytes the vendor traffic shows at offset 5, and the
    /// checksum byte the mouse itself stored for that slot.
    const CAPTURED: &[(u8, [u8; 10], u8)] = &[
        (0x07, [0x0a, 0x02, 0x0c, 0x01, 0x40, 0x01, 0x02, 0x02, 0x07, 0x68], 0x2b),
        (0x1c, [0x0a, 0x02, 0x0c, 0x01, 0x41, 0x01, 0x02, 0x02, 0x07, 0x69], 0x2b),
        (0x1d, [0x0a, 0x02, 0x0c, 0x01, 0x42, 0x01, 0x02, 0x02, 0x07, 0x6a], 0x2b),
        (0x1e, [0x0a, 0x02, 0x0c, 0x01, 0x43, 0x01, 0x02, 0x02, 0x07, 0x6b], 0x2b),
        (0x00, [0x0a, 0x02, 0x0c, 0x01, 0x44, 0x01, 0x02, 0x02, 0x07, 0x6c], 0x2b),
        (0x01, [0x0a, 0x02, 0x0c, 0x01, 0x45, 0x01, 0x02, 0x02, 0x07, 0x6d], 0x2b),
        (0x02, [0x0a, 0x02, 0x0c, 0x01, 0x46, 0x01, 0x02, 0x02, 0x07, 0x6e], 0x2b),
        (0x03, [0x0a, 0x02, 0x0c, 0x01, 0x47, 0x01, 0x02, 0x02, 0x07, 0x6f], 0x2b),
        (0x08, [0x0a, 0x02, 0x0c, 0x01, 0x48, 0x01, 0x02, 0x02, 0x07, 0x70], 0x3b),
        (0x04, [0x0a, 0x02, 0x0c, 0x01, 0x49, 0x01, 0x02, 0x02, 0x07, 0x71], 0x3b),
        (0x05, [0x0a, 0x02, 0x0c, 0x01, 0x4a, 0x01, 0x02, 0x02, 0x07, 0x72], 0x3b),
        (0x06, [0x0a, 0x02, 0x0c, 0x01, 0x4b, 0x01, 0x02, 0x02, 0x07, 0x73], 0x3b),
        (0x1b, [0x0a, 0x02, 0x0c, 0x01, 0x4b, 0x00, 0x02, 0x02, 0x00, 0x73], 0x3d),
        (0x1a, [0x02, 0x07, 0x80, 0x00, 0xb3, 0x00, 0x00, 0x00, 0x00, 0x00], 0x36),
        (0x18, [0x02, 0x07, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0x81),
    ];

    /// What an empty slot carries instead of a record.
    const EMPTY_REGION: [u8; 10] =
        [0x02, 0x07, 0x80, 0x00, 0xb3, 0x00, 0x00, 0x00, 0x00, 0x00];

    fn captured_payload(slot: u8, region: [u8; 10]) -> [u8; PAYLOAD_LEN] {
        let mut payload = [0u8; PAYLOAD_LEN];
        payload[0] = 0x02;
        payload[1] = slot;
        payload[5..15].copy_from_slice(&region);
        payload
    }

    #[test]
    fn checksum_matches_the_captured_vectors() {
        for (slot, region, expected) in CAPTURED {
            let payload = captured_payload(*slot, *region);
            assert_eq!(checksum(&payload), *expected, "slot {slot:#02x}");
        }
    }

    #[test]
    fn empty_slots_carry_the_vendor_marker_not_a_record() {
        let empty = captured_payload(0x1a, EMPTY_REGION);
        assert_ne!(&empty[5..9], &RECORD_MARKER);
        let written = captured_payload(0x1c, [0x0a, 0x02, 0x0c, 0x01, 0x41,
                                              0x01, 0x02, 0x02, 0x07, 0x69]);
        assert_eq!(&written[5..9], &RECORD_MARKER);
        assert_eq!(written[9], 0x41);
    }

    #[test]
    fn thumb_buttons_map_onto_the_vendor_slots() {
        assert_eq!(NAGA_V2_HYPERSPEED.slot_for(0x40), Some(0x07));
        assert_eq!(NAGA_V2_HYPERSPEED.slot_for(0x44), Some(0x00));
        assert_eq!(NAGA_V2_HYPERSPEED.slot_for(0x4b), Some(0x06));
        assert_eq!(NAGA_V2_HYPERSPEED.slot_for(0x34), None);
    }

    /// The whole chain the app depends on: config control id to the slot and
    /// usage the captured vendor traffic actually stored for that button.
    #[test]
    fn thumb_controls_resolve_onto_the_captured_slots_and_usages() {
        const EXPECTED: [(u8, u8, u8); 12] = [
            (0x40, 0x07, 0x68), (0x41, 0x1c, 0x69), (0x42, 0x1d, 0x6a), (0x43, 0x1e, 0x6b),
            (0x44, 0x00, 0x6c), (0x45, 0x01, 0x6d), (0x46, 0x02, 0x6e), (0x47, 0x03, 0x6f),
            (0x48, 0x08, 0x70), (0x49, 0x04, 0x71), (0x4a, 0x05, 0x72), (0x4b, 0x06, 0x73),
        ];
        for (index, (button_id, slot, usage)) in EXPECTED.iter().copied().enumerate() {
            let control = format!("thumb_{:02}", index + 1);
            assert_eq!(button_id_for_control(&control), Some(button_id), "{control}");
            assert_eq!(NAGA_V2_HYPERSPEED.slot_for(button_id), Some(slot), "{control}");
            assert_eq!(usage_for_key(&format!("F{}", 13 + index)), Some(usage), "{control}");
        }
        assert_eq!(button_id_for_control("mouse_left"), None);
        assert_eq!(usage_for_key("F12"), None);
    }

    #[test]
    fn written_record_is_verified_against_its_own_echo() {
        let written = build_record(0x1c, 0x41, 0x69, 0x07);
        let mut echoed = written;
        echoed[0] = 0x02;
        assert!(record_matches(&written, &echoed));
        let mut stale = captured_payload(0x1c, EMPTY_REGION);
        stale[88] = checksum(&stale);
        assert!(!record_matches(&written, &stale));
    }

    /// Raw records (layers 0 and 1) of `bindings`' buttons, for [`put_back`]:
    /// the hardware tests write the mouse's memory and must leave it as found.
    fn snapshot(device: &VendorDevice, bindings: &[OnboardBinding]) -> Vec<[u8; 10]> {
        bindings
            .iter()
            .filter_map(|b| device.model().button_id_for(&b.control_id))
            .flat_map(|id| {
                [0, 1].map(|layer| {
                    let mut record = device.raw_button_record(id, layer).expect("record readable");
                    // Byte 2 of a reply is the layer of the LAST write, not the
                    // one asked for (fang, and measured: written back as read, a
                    // layer-0 record landed on layer 1 and layer 0 kept the test's).
                    record[2] = layer;
                    record
                })
            })
            .collect()
    }

    /// Writes snapshot records back: the `SET` arguments have the `GET` reply's
    /// layout (profile, button, layer, category, length, value…).
    fn put_back(device: &VendorDevice, records: &[[u8; 10]]) {
        for record in records {
            device.command(CLASS_BUTTON, CMD_SET_BUTTON, record).expect("record written back");
        }
    }

    /// Hardware only — **writes the mouse's memory**, then puts it back: writes
    /// Sidearm's consumer signals into the live mouse, requires the drift check
    /// to call them in place and the `F13`..`F24` signals "the other kind", and
    /// opens the consumer collection the helper reads (shared, next to Razer's
    /// driver). Any model with consumer signals. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn consumer_signals_round_trip_on_the_live_device() {
        let device = VendorDevice::open_connected().expect("connect a catalog mouse");
        assert!(device.model().consumer.is_some(), "{} has no consumer signals", device.model().name);
        let bindings: Vec<OnboardBinding> = key_bindings(device.model());
        let saved = snapshot(&device, &bindings);
        for b in &bindings {
            let (button_id, action) = target_in_mode(device.model(), b, true).unwrap();
            device.write_target(button_id, action).unwrap_or_else(|e| panic!("{}: {e}", b.control_id));
            assert!(action.matches(&device.read_button_at(button_id, 1).unwrap()), "{} layer 1", b.control_id);
        }
        assert_eq!(device.drifted_bindings(&bindings), Ok(Vec::new()));
        for b in &bindings {
            assert_eq!(device.holds_other_signal(&bindings, &b.control_id), Ok(false), "{}", b.control_id);
        }
        put_back(&device, &saved);
        let paths = consumer_collection_paths(device.model()).expect("consumer collection in the registry");
        let opened = paths.iter().find(|path| std::fs::File::open(path).is_ok());
        println!("consumer collection: {opened:?} of {paths:?}");
        assert!(opened.is_some(), "no consumer collection opens: {paths:?}");
    }

    /// Every key button of `model` with Sidearm's own `F13`.. signal: thumbs
    /// bare, the rest (top buttons) with Alt, as the config seeds them.
    fn key_bindings(model: &NativeModel) -> Vec<OnboardBinding> {
        let thumbs = model.key_buttons.iter().filter(|(id, _)| id.starts_with("thumb_")).count();
        model
            .key_buttons
            .iter()
            .enumerate()
            .map(|(index, (control, _))| {
                let key = if index < thumbs { format!("F{}", 13 + index) } else { format!("Alt+F{}", 23 + index - thumbs) };
                binding(control, &key)
            })
            .collect()
    }

    /// Hardware only: a live DPI write changes the live value and leaves the
    /// stored one (what the mouse keeps without Sidearm). Restores the live DPI.
    #[test]
    #[ignore]
    fn live_dpi_write_leaves_the_stored_dpi() {
        let device = VendorDevice::open_connected().expect("connect a catalog mouse");
        let (live, stored) = (device.dpi().unwrap(), device.dpi_in(VARSTORE).unwrap());
        println!("live DPI {live}, stored DPI {stored}");
        let probe = if live + 100 <= device.model().dpi_max { live + 100 } else { live - 100 };
        device.set_dpi(probe, false).unwrap();
        let after = (device.dpi().unwrap(), device.dpi_in(VARSTORE).unwrap());
        device.set_dpi(live, false).unwrap();
        assert_eq!(after, (probe, stored), "live write of {probe}: (live, stored)");
    }

    /// Hardware, interactive — **writes the mouse's memory**, then puts it back:
    /// thumbs 1..8 get `F24` with one modifier bit each (`0x01`..`0x80`); press
    /// them in order within 45 s. Prints which keys Windows saw, i.e. what each
    /// bit of a key record's modifier byte means to this firmware.
    #[test]
    #[ignore]
    fn modifier_bits_as_the_firmware_plays_them() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let device = VendorDevice::open_connected().expect("connect a catalog mouse");
        let bindings: Vec<OnboardBinding> = (1..=8).map(|i| binding(&format!("thumb_{i:02}"), "F24")).collect();
        let saved = snapshot(&device, &bindings);
        for (index, b) in bindings.iter().enumerate() {
            let button_id = device.model().button_id_for(&b.control_id).unwrap();
            // The command path, as the offline profile writes it.
            // `SIDEARM_PROBE_MODS=02,03,...` (hex) overrides the single bits.
            let modifier = std::env::var("SIDEARM_PROBE_MODS")
                .ok()
                .and_then(|list| list.split(',').nth(index).and_then(|hex| u8::from_str_radix(hex.trim(), 16).ok()))
                .unwrap_or(1 << index);
            println!("thumb {}: modifier {modifier:#04x}", index + 1);
            device.write_record(button_id, 0, OnboardAction::Key { modifier, usage: USAGE_F13 + 11 }).unwrap();
        }
        drop(device);
        println!("press thumbs 1..8 now, one at a time");
        let watched = [
            ("LCtrl", 0xA2), ("LShift", 0xA0), ("LAlt", 0xA4), ("LWin", 0x5B),
            ("RCtrl", 0xA3), ("RShift", 0xA1), ("RAlt", 0xA5), ("RWin", 0x5C), ("F24", 0x87),
        ];
        let mut held = [false; 9];
        let end = std::time::Instant::now() + std::time::Duration::from_secs(45);
        while std::time::Instant::now() < end {
            for (i, (name, vk)) in watched.iter().enumerate() {
                let down = unsafe { GetAsyncKeyState(*vk) } as u16 & 0x8000 != 0;
                if down != held[i] {
                    held[i] = down;
                    println!("{:?} {name} {}", std::time::SystemTime::now(), if down { "DOWN" } else { "up" });
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let device = VendorDevice::open_connected().expect("reopen");
        put_back(&device, &saved);
        println!("records put back");
    }

    /// Hardware, interactive — **writes the mouse's memory**, then puts it back:
    /// thumbs 1..4 get raw key records that spell the left Alt / Shift as key
    /// usages (`E2`/`E1`) instead of modifier bits, and a 3-byte record with two
    /// usages. Press 1..4 within 45 s; prints what Windows saw.
    #[test]
    #[ignore]
    fn left_modifiers_as_key_usages() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let device = VendorDevice::open_connected().expect("connect a catalog mouse");
        let bindings: Vec<OnboardBinding> = (1..=4).map(|i| binding(&format!("thumb_{i:02}"), "F24")).collect();
        let saved = snapshot(&device, &bindings);
        // `SIDEARM_PROBE_TURBO=1`: TurboModeKey (`0d`, period 10 s) records
        // with the left modifiers instead.
        let turbo: [&[u8]; 4] = [&[0x0d, 0x04, 0x04, 0x73, 0x27, 0x10], &[0x0d, 0x04, 0x02, 0x73, 0x27, 0x10], &[0x0d, 0x04, 0x06, 0x73, 0x27, 0x10], &[0x0d, 0x04, 0x05, 0x73, 0x27, 0x10]];
        let usages: [&[u8]; 4] = [&[0x02, 0x02, 0x00, 0xe2], &[0x02, 0x02, 0x20, 0xe2], &[0x02, 0x02, 0x00, 0xe1], &[0x02, 0x03, 0x00, 0xe2, 0x3d]];
        let records = if std::env::var("SIDEARM_PROBE_TURBO").is_ok() { turbo } else { usages };
        for (b, record) in bindings.iter().zip(records) {
            let id = device.model().button_id_for(&b.control_id).unwrap();
            let mut args = vec![0x01, id, 0x00];
            args.extend_from_slice(record);
            args.resize(10, 0);
            let written = device.command(CLASS_BUTTON, CMD_SET_BUTTON, &args).map(|_| ());
            let held = device.raw_button_record(id, 0);
            println!("{}: wrote {record:02x?} -> {written:?}, reads {held:02x?}", b.control_id);
        }
        drop(device);
        println!("press thumbs 1..4 now");
        let watched = [("LCtrl", 0xA2), ("LShift", 0xA0), ("LAlt", 0xA4), ("RShift", 0xA1), ("RAlt", 0xA5), ("F24", 0x87)];
        let mut held = [false; 6];
        let end = std::time::Instant::now() + std::time::Duration::from_secs(45);
        while std::time::Instant::now() < end {
            for (i, (name, vk)) in watched.iter().enumerate() {
                let down = unsafe { GetAsyncKeyState(*vk) } as u16 & 0x8000 != 0;
                if down != held[i] {
                    held[i] = down;
                    println!("{:?} {name} {}", std::time::SystemTime::now(), if down { "DOWN" } else { "up" });
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let device = VendorDevice::open_connected().expect("reopen");
        put_back(&device, &saved);
        println!("records put back");
    }

    /// Hardware, read-only: the input usages each keyboard-page collection of the
    /// mouse declares (HID report descriptor), to see which keys it can send.
    #[test]
    #[ignore]
    fn keyboard_collections_declare_their_keys() {
        use windows_sys::Win32::Devices::HumanInterfaceDevice::*;
        for leaf in ["MI_01&COL01#", "MI_02#", "MI_00&COL03&COL01#", "MI_00&COL03&COL02#"] {
            let needle = format!("VID_1532&PID_00B4&{leaf}");
            let Ok(paths) = find_paths(&needle) else { println!("{leaf}: not in the registry"); continue };
            for path in paths {
                let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
                let handle = unsafe { CreateFileW(wide.as_ptr(), 0, 3, std::ptr::null(), 3, 0x80, INVALID_HANDLE_VALUE) };
                if handle == INVALID_HANDLE_VALUE {
                    println!("{leaf}: {}", Error::last_os_error());
                    continue;
                }
                let mut data: PHIDP_PREPARSED_DATA = 0;
                if !unsafe { HidD_GetPreparsedData(handle, &mut data) } {
                    println!("{leaf}: no preparsed data");
                    continue;
                }
                let mut caps: HIDP_CAPS = unsafe { std::mem::zeroed() };
                unsafe { HidP_GetCaps(data, &mut caps) };
                println!("{leaf}: page {:#06x} usage {:#04x}, input report {} bytes, {} button caps",
                    caps.UsagePage, caps.Usage, caps.InputReportByteLength, caps.NumberInputButtonCaps);
                let mut count = caps.NumberInputButtonCaps;
                let mut buttons: Vec<HIDP_BUTTON_CAPS> = vec![unsafe { std::mem::zeroed() }; count as usize];
                unsafe { HidP_GetButtonCaps(HidP_Input, buttons.as_mut_ptr(), &mut count, data) };
                for b in &buttons[..count as usize] {
                    let (min, max) = if b.IsRange {
                        unsafe { (b.Anonymous.Range.UsageMin, b.Anonymous.Range.UsageMax) }
                    } else {
                        unsafe { (b.Anonymous.NotRange.Usage, b.Anonymous.NotRange.Usage) }
                    };
                    println!("    report {:#04x} page {:#06x} usages {min:#04x}..={max:#04x}", b.ReportID, b.UsagePage);
                }
                unsafe { HidD_FreePreparsedData(data) };
                unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            }
        }
    }

    /// Read-only: prints the "Help verify" report of the connected mouse.
    #[test]
    #[ignore]
    fn prints_the_live_device_report() {
        let device = VendorDevice::open_connected().expect("connect a catalog mouse to run this test");
        println!("{}", device.probe_report());
    }

    /// Hardware only — **writes the mouse's memory**, then puts it back: writes
    /// the `F13`..`F24` key signals through the slot path, so every write must
    /// be echoed by the mouse, and `verify` must then confirm every binding.
    /// Any catalog model (an unverified one refuses the writes until it is
    /// marked verified locally). Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn writes_the_captured_mapping_into_the_live_device() {
        let device = VendorDevice::open_connected().expect("connect a catalog mouse");
        let bindings = key_bindings(device.model());
        let saved = snapshot(&device, &bindings);
        set_consumer_signals(false);
        let written = device.apply_bindings(&bindings);
        let report = device.verify(&bindings);
        set_consumer_signals(true);
        put_back(&device, &saved);
        written.expect("the mouse must echo every button write");
        let report = report.expect("the mouse must confirm the bindings it stores");
        assert!(report.failed.is_empty(), "no binding may fail to confirm: {:?}", report.failed);
        assert_eq!(report.confirmed.len(), bindings.len(), "every binding is confirmed");
    }

    /// Records as the device answered them: the right button after Synapse
    /// stored Hypershift on it (`0c 01 01`), and after it was written back.
    #[test]
    fn hypershift_on_the_trigger_is_not_a_mouse_button() {
        let parse = |bytes: [u8; 7]| ButtonRecord {
            category: bytes[3],
            modifier: bytes[5],
            usage: bytes[6],
        };
        let hypershift = parse([0x01, 0x02, 0x01, 0x0c, 0x01, 0x01, 0x00]);
        let right = parse([0x01, 0x02, 0x00, 0x01, 0x01, 0x02, 0x00]);
        let left = parse([0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00]);
        assert!(!hypershift.is_mouse_button(2));
        assert!(right.is_mouse_button(2));
        assert!(!left.is_mouse_button(2), "a left click on the right button is drift too");
        assert!(config_model().native_buttons.contains(&("mouse_right", 0x02, 2)));
        assert!(config_model().native_buttons.contains(&("mouse_4", 0x34, 4)));
    }

    /// Values the hardware answered with (2026-10-17): battery `0xa9`, poll
    /// code `0x02` at 500 Hz, a `0x01` write read back as 1000 Hz.
    #[test]
    fn settings_conversions_match_the_hardware() {
        assert_eq!(battery_percent_from_raw(0xa9), 66);
        assert_eq!(battery_percent_from_raw(0), 0);
        assert_eq!(battery_percent_from_raw(255), 100);
        assert_eq!(NAGA_V2_HYPERSPEED.hz_for_poll_code(0x02), Some(500));
        assert_eq!(NAGA_V2_HYPERSPEED.poll_code_for_hz(1000), Some(0x01));
        assert_eq!(NAGA_V2_HYPERSPEED.poll_code_for_hz(125), Some(0x08));
        assert_eq!(NAGA_V2_HYPERSPEED.poll_code_for_hz(250), None);
    }

    #[test]
    fn mode_values_name_the_takeover() {
        assert_eq!(MODE_NORMAL, 0x00);
        assert_eq!(MODE_DRIVER, 0x03);
    }

    fn binding(control: &str, key: &str) -> OnboardBinding {
        OnboardBinding { control_id: control.to_string(), encoded_key: key.to_string() }
    }

    #[test]
    fn key_mode_target_accepts_f13_to_f24_on_key_buttons() {
        let target = |control: &str, key: &str| target_in_mode(&NAGA_V2_HYPERSPEED, &binding(control, key), false);
        let key = |modifier, usage| OnboardAction::Key { modifier, usage };
        assert_eq!(target("thumb_01", "F13"), Ok((0x40, key(0x00, 0x68))));
        assert_eq!(target("thumb_12", "F24"), Ok((0x4b, key(0x00, 0x73))));
        // Alt and Shift as the right-hand keys the firmware plays.
        assert_eq!(target("top_aux_01", "Alt+F23"), Ok((0x0b, key(0x40, 0x72))));
        assert_eq!(target("thumb_01", "Ctrl+Alt+Shift+F13"), Ok((0x40, key(0x61, 0x68))));
        assert!(target("mouse_left", "F13").is_err());
        assert!(target("thumb_01", "F12").is_err());
    }

    /// Consumer mode ignores the encoded key: the button's catalog usage is the
    /// signal, and the encoded key only names it for the resolver.
    #[test]
    fn consumer_mode_target_is_the_catalog_usage() {
        let target = |control: &str, key: &str| target_in_mode(&NAGA_V2_HYPERSPEED, &binding(control, key), true);
        assert_eq!(target("thumb_01", "F13"), Ok((0x40, OnboardAction::Consumer(0x10))));
        assert_eq!(target("top_aux_02", "Alt+F24"), Ok((0x0c, OnboardAction::Consumer(0xfe))));
        assert!(target("mouse_left", "F13").is_err());
        // A model without the path keeps the keyboard signal.
        let keys_only = crate::device_catalog::NativeModel { consumer: None, ..NAGA_V2_HYPERSPEED };
        assert_eq!(
            target_in_mode(&keys_only, &binding("thumb_01", "F13"), true),
            Ok((0x40, OnboardAction::Key { modifier: 0, usage: 0x68 }))
        );
    }

    /// Record bytes of a consumer signal, and how a read-back record matches:
    /// `0x8c` answers `profile, button, layer, 0a, 02, usage_hi, usage_lo`.
    #[test]
    fn consumer_records_are_category_0a_with_a_big_endian_usage() {
        assert_eq!(OnboardAction::Consumer(0x023c).bytes(), [0x0a, 0x02, 0x02, 0x3c]);
        let held = |category, modifier, usage| ButtonRecord { category, modifier, usage };
        assert!(OnboardAction::Consumer(0x10).matches(&held(0x0a, 0x00, 0x10)));
        assert!(!OnboardAction::Consumer(0x10).matches(&held(0x0a, 0x00, 0x11)));
        assert!(!OnboardAction::Consumer(0x10).matches(&held(0x02, 0x00, 0x10)));
        assert!(!OnboardAction::Key { modifier: 0, usage: 0x10 }.matches(&held(0x0a, 0x00, 0x10)));
    }

    /// The same filter `src/lib/onboard-mapping.ts` applies: standard layer and
    /// thumb controls only, because only those reach the mouse's own memory.
    #[test]
    fn thumb_bindings_keep_the_standard_layer_only() {
        use crate::config::{ControlId, EncoderMapping, Layer, MappingSource};
        let mapping = |control: &str, layer: Layer, key: &str| EncoderMapping {
            control_id: ControlId::new(control),
            layer,
            encoded_key: key.to_string(),
            source: MappingSource::Detected,
            verified: false,
        };
        let bindings = thumb_bindings(&[
            mapping("thumb_01", Layer::Standard, "F13"),
            mapping("thumb_01", Layer::Hypershift, "F14"),
            mapping("mouse_left", Layer::Standard, "F15"),
        ]);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].control_id, "thumb_01");
        assert_eq!(bindings[0].encoded_key, "F13");
    }

    /// Expected wire payload from its leading bytes and checksum, written out
    /// by hand from the Razer report layout (openrazer `razer_report`: status,
    /// transaction id, 3 reserved, size, class, id, args; byte 88 = XOR 2..=87)
    /// — never computed by the code under test.
    fn wire(head: &[u8], checksum: u8) -> [u8; PAYLOAD_LEN] {
        let mut payload = [0u8; PAYLOAD_LEN];
        payload[..head.len()].copy_from_slice(head);
        payload[88] = checksum;
        payload
    }

    /// Golden bytes of every command the Naga V2 HyperSpeed is sent, with the
    /// arguments each `VendorDevice` method uses. A catalog refactor must not
    /// change a single byte here.
    #[test]
    fn commands_match_their_golden_bytes() {
        let tx = NAGA_V2_HYPERSPEED.transaction_id;
        let cases: [(&str, [u8; PAYLOAD_LEN], [u8; PAYLOAD_LEN]); 12] = [
            ("get mode", build_command(tx, CLASS_CONTROL, CMD_GET_MODE, &[0x00, 0x00]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x02, 0x00, 0x84, 0x00, 0x00], 0x86)),
            ("set mode normal", build_command(tx, CLASS_CONTROL, CMD_SET_MODE, &[MODE_NORMAL, 0x00]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x02, 0x00, 0x04, 0x00, 0x00], 0x06)),
            ("get thumb_01 layer 0",
             build_command(tx, CLASS_BUTTON, CMD_GET_BUTTON, &[0x01, 0x40, 0x00, 0, 0, 0, 0, 0, 0, 0]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x0a, 0x02, 0x8c, 0x01, 0x40, 0x00], 0xc5)),
            ("get right button layer 1",
             build_command(tx, CLASS_BUTTON, CMD_GET_BUTTON, &[0x01, 0x02, 0x01, 0, 0, 0, 0, 0, 0, 0]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x0a, 0x02, 0x8c, 0x01, 0x02, 0x01], 0x86)),
            ("set top_aux_01 = Alt+F23",
             build_command(tx, CLASS_BUTTON, CMD_SET_BUTTON, &[0x01, 0x0b, 0x00, 0x02, 0x02, 0x04, 0x72, 0, 0, 0]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x0a, 0x02, 0x0c, 0x01, 0x0b, 0x00, 0x02, 0x02, 0x04, 0x72], 0x78)),
            ("restore right button",
             build_command(tx, CLASS_BUTTON, CMD_SET_BUTTON, &[0x01, 0x02, 0x00, 0x01, 0x01, 0x02, 0, 0, 0, 0]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x0a, 0x02, 0x0c, 0x01, 0x02, 0x00, 0x01, 0x01, 0x02], 0x05)),
            ("hypershift on right button layer 1",
             build_command(tx, CLASS_BUTTON, CMD_SET_BUTTON, &[0x01, 0x02, 0x01, 0x0c, 0x01, 0x01, 0, 0, 0, 0]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x0a, 0x02, 0x0c, 0x01, 0x02, 0x01, 0x0c, 0x01, 0x01], 0x0a)),
            ("get dpi", build_command(tx, CLASS_DPI, CMD_GET_DPI, &[VARSTORE, 0, 0, 0, 0, 0, 0]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x07, 0x04, 0x85, 0x01], 0x87)),
            ("set dpi 1600",
             build_command(tx, CLASS_DPI, CMD_SET_DPI, &[VARSTORE, 0x06, 0x40, 0x06, 0x40, 0x00, 0x00]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x07, 0x04, 0x05, 0x01, 0x06, 0x40, 0x06, 0x40], 0x07)),
            ("get poll rate", build_command(tx, CLASS_CONTROL, CMD_GET_POLL_RATE, &[0x00]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x01, 0x00, 0x85, 0x00], 0x84)),
            ("set poll 1000 Hz", build_command(tx, CLASS_CONTROL, CMD_SET_POLL_RATE, &[0x01]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x01, 0x00, 0x05, 0x01], 0x05)),
            ("get battery", build_command(tx, CLASS_POWER, CMD_GET_BATTERY, &[0x00, 0x00]),
             wire(&[0x00, 0x1f, 0, 0, 0, 0x02, 0x07, 0x80, 0x00, 0x00], 0x85)),
        ];
        for (name, built, expected) in cases {
            assert_eq!(built.to_vec(), expected.to_vec(), "{name}");
        }
    }

    /// An unverified model refuses every write that changes a button before
    /// any HID traffic: the handle here is invalid, so reaching the device
    /// would fail with an OS error instead of the refusal.
    #[test]
    fn unverified_model_refuses_button_writes() {
        static UNVERIFIED: NativeModel = NativeModel {
            name: "Test mouse",
            verified: false,
            ..crate::device_catalog::NAGA_V2_HYPERSPEED
        };
        let device = VendorDevice::test_handle(&UNVERIFIED, 0, "");
        let refused = |result: Result<(), String>| {
            assert_eq!(result, Err("Test mouse is not verified yet: button records are not written".into()));
        };
        refused(device.write_button(0x40, 0x68, 0x00));
        refused(device.write_record(0x02, 1, OnboardAction::Hypershift));
        refused(device.restore_native_button(0x02, 2));
        refused(device.ensure_normal_mode().map(|_| ()));
    }

    /// Real leaf names of the V2 HyperSpeed in registry order (2026-10-21):
    /// the interface filter keeps the bare `MI_00` collection v0.9.0 opened.
    #[test]
    fn interface_filter_picks_the_vendor_collection() {
        let leaves = [
            "##?#HID#VID_1532&PID_00B4&MI_00#9&175a7019&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}",
            "##?#HID#VID_1532&PID_00B4&MI_00&Col03&Col01#a&1d1ebcfa&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}",
            "##?#HID#VID_1532&PID_00B4&MI_01&Col01#9&42a53db&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}",
            "##?#HID#VID_1532&PID_00B4&MI_02#9&2c9501a4&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}",
        ];
        let first = |interface: u8| {
            let needle = interface_needle(0x1532, 0x00B4, interface);
            leaves.iter().find_map(|leaf| interface_path(leaf, &needle))
        };
        assert_eq!(
            first(0).as_deref(),
            Some(r"\\?\HID#VID_1532&PID_00B4&MI_00#9&175a7019&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}")
        );
        assert!(first(2).unwrap().contains("&MI_02#"));
        assert_eq!(first(3), None);
        assert_eq!(interface_path("HID#VID_1532&PID_00B4&MI_00#x", &interface_needle(0x1532, 0x00B4, 0)), None);
        assert_eq!(interface_path("##?#HID#VID_1532&PID_00B5&MI_00#x", &interface_needle(0x1532, 0x00B4, 0)), None);
    }
}
