use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
};
use tauri::{AppHandle, Emitter};

use super::{CAPTURE_BACKEND_NAME, EncodedKeyEvent, EventOutcome, process_encoded_key_event};
use crate::{
    config::AppConfig,
    hotkeys,
    runtime::{self, RuntimeStore},
    window_capture,
};

use crate::vk::{ModifierKind, classify_modifier_vk, is_modifier_vk};

const BACKEND_LL_HOOK: &str = "windows-ll-hook";

/// Backend tag of a press read from a mouse's own HID stream (`hid:<device>`).
fn hid_backend(model: &crate::device_catalog::NativeModel) -> String {
    format!("hid:{}", model.device_id)
}

/// One consumer reader the helper starts.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReaderInit {
    /// Catalog index of the mouse.
    model: usize,
    signals: Vec<crate::mouse_memory::ConsumerSignal>,
    /// The layer is the software trigger's state, not the signal's own.
    software_layer: bool,
}

/// What the helper reads from the mice besides the keyboard.
struct MouseInputs {
    readers: Vec<ReaderInit>,
    /// Every connected mouse keeps its HyperShift layer in its firmware: the
    /// software trigger is off.
    firmware_hypershift: bool,
    /// Where the live maps' rollback files are: the helper restores them if
    /// Sidearm dies without stopping it.
    config_dir: std::path::PathBuf,
}

const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_WIN: u32 = 0x0008;
const MOD_NOREPEAT: u32 = 0x4000;

/// Bitmask covering only the modifier-key bits (Alt/Ctrl/Shift/Win).
/// Used to strip RegisterHotKey-only flags like MOD_NOREPEAT (0x4000)
/// before passing masks to the LL hook helper.
const MOD_MODIFIER_BITS: u32 = MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WIN;

/// Build a RegisterHotKey modifier mask from hotkey modifiers.
fn register_hotkey_mask(mods: &hotkeys::HotkeyModifiers) -> u32 {
    let mut mask = MOD_NOREPEAT;
    if mods.alt {
        mask |= MOD_ALT;
    }
    if mods.ctrl {
        mask |= MOD_CONTROL;
    }
    if mods.shift {
        mask |= MOD_SHIFT;
    }
    if mods.win {
        mask |= MOD_WIN;
    }
    mask
}

// Modifier VK codes as u32 for the WinAPI hook boundary; the values come from
// the shared `crate::vk` table (single source of truth).
const VK_SHIFT: u32 = crate::vk::VK_SHIFT as u32;
const VK_CONTROL: u32 = crate::vk::VK_CONTROL as u32;
const VK_MENU: u32 = crate::vk::VK_MENU as u32;
const VK_LSHIFT: u32 = crate::vk::VK_LSHIFT as u32;
const VK_RSHIFT: u32 = crate::vk::VK_RSHIFT as u32;
const VK_LCONTROL: u32 = crate::vk::VK_LCONTROL as u32;
const VK_RCONTROL: u32 = crate::vk::VK_RCONTROL as u32;
const VK_LMENU: u32 = crate::vk::VK_LMENU as u32;
const VK_RMENU: u32 = crate::vk::VK_RMENU as u32;
const VK_LWIN: u32 = crate::vk::VK_LWIN as u32;
const VK_RWIN: u32 = crate::vk::VK_RWIN as u32;

/// "Menu Mask Key" — an unassigned VK used to prevent Windows from activating
/// menus/ribbon (SC_KEYMENU) or the Start menu when Alt or Win is released
/// after a hotkey combo.  Injecting this between modifier-down and modifier-up
/// makes DefWindowProc think a non-modifier key was pressed, suppressing the
/// system activation.  Pattern borrowed from AutoHotkey v2.
const VK_MASK_KEY: u16 = crate::vk::VK_MASK_KEY;

/// dwExtraInfo marker for hook health probe events.  Distinct from
/// `INTERNAL_SENDINPUT_EXTRA_INFO` so the hook callback can tell them apart.
/// Must fit in 32 bits for the same reason as that tag (a mouse LL hook sees
/// only the low dword) — otherwise the mouse probe is never acknowledged.
const HOOK_PROBE_EXTRA_INFO: usize = 0x4E41_4750usize; // "NAGP"

/// VK used for probe injection (same unassigned key as the mask key).
const VK_PROBE_KEY: u16 = 0xE8;

/// How often the health monitor checks (milliseconds).
const HOOK_HEALTH_CHECK_INTERVAL_MS: u32 = 5000;

/// How many consecutive probe failures required before reinstalling the hook.
/// A single failed probe can be caused by UIPI blocking SendInput (e.g. an
/// elevated window is in the foreground), not necessarily a dead hook.
const HOOK_PROBE_FAIL_THRESHOLD: u32 = 3;

// Thread-local state for the capture helper's LL keyboard hook callback.
/// Whether per-keystroke capture diagnostics are enabled (`SIDEARM_DEBUG_CAPTURE=1`).
/// Read once and cached for the process lifetime. Default OFF so the LL keyboard
/// hook does zero formatting/IPC per key at the default Info level — this is the
/// hot path implicated in the v0.1.15 framework-log OOM.
fn debug_capture_enabled() -> bool {
    use std::sync::OnceLock;
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("SIDEARM_DEBUG_CAPTURE")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

// ---------------------------------------------------------------------------
// Factory-defaults detector
// ---------------------------------------------------------------------------
// When the Razer software fails to apply the remap profile (known Synapse 4
// autostart bug: the RazerAppEngine container starts but the Synapse module
// never loads) while the Razer driver stack is still installed, every
// thumb-grid press reaches the LL hook TWICE: a real digit-row keydown
// (no LLKHF_INJECTED) followed shortly by a SendInput-injected duplicate with
// the same VK+scancode, re-emitted by the Razer stack. Physical typing never
// produces that pattern, and Sidearm's own synthesis is excluded upstream via
// INTERNAL_SENDINPUT_EXTRA_INFO, so the signature reliably means "the mouse is
// on factory defaults" (measured live 2026-07-02: 12/12 presses matched,
// real→injected gaps 64-138 ms). On detection the helper emits a single
// `ALERT:factory-defaults` line so the parent can warn the user instead of
// silently typing digits into the foreground app.

/// Scancode range of the Naga factory thumb-grid row: `1`..`=` (0x02..=0x0D).
const DEFAULTS_SC_FIRST: u32 = 0x02;
const DEFAULTS_SC_LAST: u32 = 0x0D;
/// Max age of a real keydown for an injected duplicate to pair with it.
const DEFAULTS_PAIR_WINDOW_MS: u32 = 1_000;
/// Alert once this many pairs are seen inside DEFAULTS_HIT_WINDOW_MS.
const DEFAULTS_ALERT_HITS: usize = 3;
const DEFAULTS_HIT_WINDOW_MS: u32 = 60_000;

const DEFAULTS_SC_COUNT: usize = (DEFAULTS_SC_LAST - DEFAULTS_SC_FIRST + 1) as usize;

#[derive(Default)]
struct FactoryDefaultsDetector {
    /// Last REAL keydown per thumb-row scancode: (vk, at_ms).
    last_real: [Option<(u32, u32)>; DEFAULTS_SC_COUNT],
    /// Timestamps (ms) of observed real→injected duplicate pairs.
    hits: Vec<u32>,
    alerted: bool,
}

impl FactoryDefaultsDetector {
    /// Feed a keydown; returns `true` exactly once — when the alert threshold
    /// is crossed. `now_ms` is any monotonic millisecond clock (the hook uses
    /// KBDLLHOOKSTRUCT.time; a wrap every 49.7 days at worst drops one pair).
    fn observe_keydown(&mut self, vk: u32, scan_code: u32, injected: bool, now_ms: u32) -> bool {
        if !(DEFAULTS_SC_FIRST..=DEFAULTS_SC_LAST).contains(&scan_code) {
            return false;
        }
        let idx = (scan_code - DEFAULTS_SC_FIRST) as usize;
        if !injected {
            self.last_real[idx] = Some((vk, now_ms));
            return false;
        }
        let Some((real_vk, real_at)) = self.last_real[idx] else {
            return false;
        };
        if real_vk != vk || now_ms.wrapping_sub(real_at) > DEFAULTS_PAIR_WINDOW_MS {
            return false;
        }
        // Consume the real keydown so injected auto-repeats can't inflate the
        // hit count from a single physical press.
        self.last_real[idx] = None;
        if self.alerted {
            return false;
        }
        self.hits
            .retain(|t| now_ms.wrapping_sub(*t) <= DEFAULTS_HIT_WINDOW_MS);
        self.hits.push(now_ms);
        if self.hits.len() >= DEFAULTS_ALERT_HITS {
            self.alerted = true;
            return true;
        }
        false
    }
}

/// Line pushed to the helper's stdout stream when the detector fires.
const HELPER_ALERT_FACTORY_DEFAULTS: &str = "ALERT:factory-defaults";

/// Prefix the helper puts on an encoded key that arrived while the Hypershift
/// trigger was held (`HS:F13`, `HS:UP:F13`, `HS:REPEAT:F13`). The parent strips
/// it and marks the event as hypershift-layer.
const HS_PREFIX: &str = "HS:";

/// Hook events the parent logs at `info` because they have no action dispatch
/// to be inferred from. A translated Hypershift click is the case: the user
/// sees a right click, and only this line says whether Sidearm produced it.
const NOTE_PREFIX: &str = "NOTE:";

thread_local! {
    static HELPER_REGISTRATIONS: std::cell::RefCell<Vec<HelperRegistration>> =
        const { std::cell::RefCell::new(Vec::new()) };
    static HELPER_MODIFIERS: std::cell::RefCell<HelperModifierState> =
        std::cell::RefCell::new(HelperModifierState::default());
    static HELPER_SUPPRESSIONS: std::cell::RefCell<std::collections::HashMap<u32, String>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static HELPER_MATCHES: std::cell::RefCell<Vec<String>> =
        const { std::cell::RefCell::new(Vec::new()) };
    static HELPER_THREAD_ID: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// Match line emitted for a held side button (index 0 = X1, 1 = X2), so its
    /// release emits the matching key-up even if the trigger changed meanwhile.
    static HELPER_SIDE_BUTTON_DOWN: std::cell::RefCell<[Option<String>; 2]> =
        const { std::cell::RefCell::new([None, None]) };
    /// Factory-defaults signature tracker (see FactoryDefaultsDetector above).
    static HELPER_DEFAULTS_DETECTOR: std::cell::RefCell<FactoryDefaultsDetector> =
        std::cell::RefCell::new(FactoryDefaultsDetector::default());
    /// Set to `true` by the hook callback when it receives a probe event
    /// (dwExtraInfo == HOOK_PROBE_EXTRA_INFO).  Consumed by the health monitor.
    static HELPER_PROBE_RECEIVED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Set to `true` by the hook callback on ANY invocation (real key or probe).
    /// Consumed (replaced with `false`) by the health monitor each cycle.
    /// When `true`, the hook is demonstrably alive — no probe needed.
    ///
    /// Keyboard-only on purpose: the mouse hook has its own flag, or a live mouse
    /// hook would mask a dead keyboard hook on the fast path below.
    static HOOK_HAD_CALLBACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Set to `true` by the MOUSE hook callback on any invocation (including
    /// moves).  Consumed by the mouse-hook health check, which has no probe to
    /// fall back on: Windows drops `WH_MOUSE_LL` silently after a low-level-hook
    /// timeout and never tells us, so silence has to be diagnosed from evidence.
    static HOOK_HAD_MOUSE_CALLBACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Set to `true` by the mouse hook when it sees the tagged 1-px probe move.
    static HELPER_MOUSE_PROBE_RECEIVED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };

    /// Buffered modifier-down events waiting for an F-key match.
    /// If an F-key match arrives within the timeout, these were Razer encoding
    /// and should stay suppressed. If timeout expires, replay them via SendInput.
    static PENDING_MODIFIERS: std::cell::RefCell<Vec<PendingModifier>> =
        const { std::cell::RefCell::new(Vec::new()) };

    /// VK codes of modifiers consumed by an F-key match, mapped to the time
    /// they were consumed.  Their key-up events must be suppressed (Razer
    /// encoding release, not real user keys).  Timestamp is used to GC stale
    /// entries when the expected key-up never arrives (e.g. focus change).
    static CONSUMED_MODIFIER_VKS: std::cell::RefCell<std::collections::HashMap<u32, std::time::Instant>> =
        std::cell::RefCell::new(std::collections::HashMap::new());

    /// VK codes of modifiers that were *replayed* via `replay_modifier_down`
    /// (injected key-down through SendInput because pending-buffer timed out
    /// without an F-key match, or because the F-key didn't match the encoding
    /// mask).  Each entry is awaiting its real key-up — when the user actually
    /// releases the modifier, we remove the entry and let the up flow through.
    ///
    /// If the real up is lost (alt-tab steals focus, RDP disconnect, Razer
    /// firmware drops the up), the entry stays.  After
    /// `REPLAYED_AWAITING_UP_THRESHOLD` we force-release the modifier via
    /// SendInput key-up — bounded recovery for the orphan-replay scenario
    /// (otherwise OS sees ctrl-down without ever receiving its up, and Ctrl
    /// is virtually held until the user manually presses Ctrl again, which
    /// triggers the fresh-down clear path).
    static REPLAYED_AWAITING_UP: std::cell::RefCell<std::collections::HashMap<u32, std::time::Instant>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub(super) struct CaptureBackendHandle {
    hook_thread_id: u32,
    hook_thread: JoinHandle<()>,
    worker_thread: JoinHandle<()>,
    helper: Option<HelperHandle>,
    /// One live button map per mouse that needs it (`live_overlay`).
    live_sessions: Vec<crate::mouse_memory::live_overlay::Session>,
    foreground_watcher_thread_id: Option<u32>,
    foreground_watcher_thread: Option<JoinHandle<()>>,
}

struct HelperHandle {
    /// Shared with the HyperShift 2 switch (`follow_profile_hypershift2`).
    stdin_pipe: Arc<Mutex<std::process::ChildStdin>>,
    child: std::process::Child,
    reader_thread: JoinHandle<()>,
    /// Set by `stop()` before it closes the helper: that exit is no crash.
    stopping: Arc<AtomicBool>,
}

impl HelperHandle {
    fn send_command(&mut self, cmd: &str) -> Result<(), String> {
        write_helper_line(&self.stdin_pipe, cmd).map_err(|e| format!("Failed to send command to helper: {e}"))
    }
}

/// A scroll-wheel direction. The firmware never turns a scroll tick into a
/// keystroke, so no registration can ever be matched by one — the mouse hook
/// synthesises the hypershift-layer encoding itself (see [`wheel_capture_action`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WheelAxis {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone)]
struct RegisteredHotkey {
    id: i32,
    encoded_key: String,
    modifiers_mask: u32,
    primary_vk: u32,
    /// Set on the hypershift-layer scroll-wheel encodings.
    wheel: Option<WheelAxis>,
    /// Set on a side button (mouse 4/5) bound on this layer: see [`ButtonCapture`].
    button: Option<ButtonCapture>,
}

/// A native side button (XBUTTON1/2) the mouse hook turns into `encoded_key`.
///
/// The mouse reports mouse 4/5 as plain X buttons (its onboard records are
/// native, so it still works without Sidearm), which no keyboard registration
/// can match — so bindings on them never fired. The hook emits the encoder
/// mapping instead, for the layer in effect, and only when that layer has an
/// enabled binding: an unbound button keeps its native back/forward.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ButtonCapture {
    /// `HYPER_TRIGGER_X1` / `HYPER_TRIGGER_X2`.
    code: u8,
    /// The registration is the hypershift-layer encoding.
    hypershift: bool,
}

/// IPC registration sent from the main process to the capture helper.
#[derive(Clone, Serialize, Deserialize)]
struct HelperRegistration {
    encoded_key: String,
    modifiers_mask: u32,
    primary_vk: u32,
    /// Set on the hypershift-layer scroll-wheel encodings: that wheel direction
    /// is captured while the trigger is held and emitted as `encoded_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wheel: Option<WheelAxis>,
    /// Set on a bound side button: emitted by the mouse hook (see [`ButtonCapture`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    button: Option<ButtonCapture>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct HelperModifierState {
    ctrl: bool,
    alt: bool,
    shift: bool,
    win: bool,
}

impl HelperModifierState {
    fn apply_vk_event(&mut self, vk: u32, is_down: bool) -> bool {
        if is_control_vk(vk) {
            self.ctrl = is_down;
            return true;
        }
        if is_alt_vk(vk) {
            self.alt = is_down;
            return true;
        }
        if is_shift_vk(vk) {
            self.shift = is_down;
            return true;
        }
        if is_win_vk(vk) {
            self.win = is_down;
            return true;
        }

        false
    }

    /// Returns the current modifier state as a bitmask compatible with
    /// MOD_ALT / MOD_CONTROL / MOD_SHIFT / MOD_WIN flags.
    fn as_modifier_flags(self) -> u32 {
        let mut flags = 0u32;
        if self.ctrl {
            flags |= MOD_CONTROL;
        }
        if self.alt {
            flags |= MOD_ALT;
        }
        if self.shift {
            flags |= MOD_SHIFT;
        }
        if self.win {
            flags |= MOD_WIN;
        }
        flags
    }

    /// Superset match: returns true when all required modifier bits in
    /// `modifiers_mask` are active.  Extra physical modifiers are allowed
    /// (e.g. user holds Shift while pressing a bare F-key mapping).
    fn matches_mask(self, modifiers_mask: u32) -> bool {
        let current = self.as_modifier_flags();
        let result = (current & modifiers_mask) == modifiers_mask;
        if result && current != modifiers_mask {
            let extra = current & !modifiers_mask;
            log::debug!(
                "[modifier-passthrough] Superset match: current=0x{:04X} mask=0x{:04X} extra=0x{:04X}",
                current,
                modifiers_mask,
                extra,
            );
        }
        result
    }
}

fn is_control_vk(vk: u32) -> bool {
    matches!(vk, VK_CONTROL | VK_LCONTROL | VK_RCONTROL)
}

fn is_alt_vk(vk: u32) -> bool {
    matches!(vk, VK_MENU | VK_LMENU | VK_RMENU)
}

fn is_shift_vk(vk: u32) -> bool {
    matches!(vk, VK_SHIFT | VK_LSHIFT | VK_RSHIFT)
}

fn is_win_vk(vk: u32) -> bool {
    matches!(vk, VK_LWIN | VK_RWIN)
}

/// RegisterHotKey modifier-mask bit for a modifier VK, or 0 if `vk` is not a
/// modifier. Single source for the VK→MOD mapping, shared by
/// `modifier_in_any_encoding` and the pending-modifier replay path.
fn modifier_mask_bit(vk: u32) -> u32 {
    match classify_modifier_vk(vk as u16) {
        Some(ModifierKind::Alt) => MOD_ALT,
        Some(ModifierKind::Ctrl) => MOD_CONTROL,
        Some(ModifierKind::Shift) => MOD_SHIFT,
        Some(ModifierKind::Win) => MOD_WIN,
        None => 0,
    }
}

/// Returns true if this modifier VK requires `KEYEVENTF_EXTENDEDKEY` when
/// injected via SendInput.  By the MSDN extended-key list, only the right
/// CTRL and right ALT have the 0xE0 prefix among modifiers — without the
/// flag, `wVk=VK_RCONTROL`/`VK_RMENU` with `wScan=0x1D`/`0x38` lands as a
/// LEFT-side variant in the OS input queue (same scan code, missing prefix).
/// That mismatch leaves the matching real key-up (which DOES carry
/// LLKHF_EXTENDED) unable to balance the prior injection — root cause of
/// the "RCtrl-only stuck" symptom.
///
/// Right SHIFT and Win keys are NOT in the MSDN extended list:
///  - VK_RSHIFT has its own scan code (0x36) without 0xE0 prefix.
///  - VK_LWIN/VK_RWIN behaviour varies by keyboard firmware (logs on the
///    test machine show real Win-down with no LLKHF_EXTENDED bit) — the
///    safer default is to leave them flagless and let `wVk` carry the
///    distinction.
fn is_extended_modifier_vk(vk: u32) -> bool {
    matches!(vk, VK_RCONTROL | VK_RMENU)
}

#[derive(Clone, Copy)]
struct PendingModifier {
    vk: u32,
    scan: u32,
    buffered_at: std::time::Instant,
}

/// Returns true if this modifier VK code appears in any registered hotkey's
/// modifier mask. Only these modifiers should be buffered.
fn modifier_in_any_encoding(vk: u32, regs: &[HelperRegistration]) -> bool {
    let mask_bit = modifier_mask_bit(vk);
    if mask_bit == 0 {
        return false;
    }
    regs.iter().any(|r| r.modifiers_mask & mask_bit != 0)
}

/// Build a keyboard `INPUT` event (`INPUT_KEYBOARD` / `KEYBDINPUT`) with the
/// given virtual key, scan code, flags, and `dwExtraInfo` marker (`time` is
/// always 0). Shared by the modifier-replay and mask/probe injection sites so
/// the INPUT/KEYBDINPUT assembly lives in one place. Pure struct construction —
/// no `unsafe` needed (writing a union is safe; only reading it is `unsafe`).
fn make_key_input(
    vk: u16,
    scan: u16,
    flags: u32,
    extra: usize,
) -> windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: extra,
            },
        },
    }
}

/// Send a batch of `INPUT` events via `SendInput`, returning the number the OS
/// accepted (a no-op returning 0 for an empty slice). Centralizes the
/// `size_of::<INPUT>()` argument that every injection site repeated.
fn send_inputs(inputs: &[windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT]) -> u32 {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{INPUT, SendInput};
    if inputs.is_empty() {
        return 0;
    }
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    }
}

/// Replay a buffered modifier-down event via SendInput.
/// Uses INTERNAL_SENDINPUT_EXTRA_INFO so our LL hook recognizes replayed
/// events and passes them through without re-buffering.
///
/// For extended-key modifiers (VK_RCONTROL/VK_RMENU) the
/// `KEYEVENTF_EXTENDEDKEY` flag is required — without it, the OS treats the
/// injection as the LEFT-side variant (same scan code) and the matching
/// real key-up (which carries LLKHF_EXTENDED) cannot balance it, leaving
/// the modifier virtually held.
unsafe fn replay_modifier_down(vk: u32, scan: u32) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_EXTENDEDKEY;
    let flags = if is_extended_modifier_vk(vk) {
        KEYEVENTF_EXTENDEDKEY
    } else {
        0
    };
    let input = make_key_input(
        vk as u16,
        scan as u16,
        flags,
        crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
    );
    send_inputs(&[input]);
}

/// Replay a complete down+up tap for a modifier via SendInput.  Used by the
/// solo-tap path (Case C2): the user's real key-up has already arrived but
/// the original key-down is still buffered.  We can't just replay the down
/// and let the real up pass through — SendInput queues the down at the END
/// of the input queue, so the OS would process up first (no-op) then down
/// (Ctrl held).  Replaying both keeps the events in the right order; the
/// caller suppresses the real up event.
///
/// Both the down and up events carry `KEYEVENTF_EXTENDEDKEY` for right-side
/// modifiers; see `replay_modifier_down` rationale.
unsafe fn replay_modifier_tap(vk: u32, scan: u32) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP};
    let extended_bit = if is_extended_modifier_vk(vk) {
        KEYEVENTF_EXTENDEDKEY
    } else {
        0
    };
    let make = |key_up: bool| {
        make_key_input(
            vk as u16,
            scan as u16,
            extended_bit | if key_up { KEYEVENTF_KEYUP } else { 0 },
            crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
        )
    };
    let inputs = [make(false), make(true)];
    send_inputs(&inputs);
}

/// Force-release a modifier via SendInput key-up.  Used by orphan-replay GC
/// and by teardown/REHOOK/health-reinstall to balance any prior
/// `replay_modifier_down` whose matching real-up was lost.
///
/// Carries `INTERNAL_SENDINPUT_EXTRA_INFO` so our own LL hook recognises
/// the event and passes it through without buffering.  Right-side modifiers
/// receive `KEYEVENTF_EXTENDEDKEY` so the up matches a prior extended-key
/// down (same key, not the L-variant with the same scan code).
unsafe fn replay_modifier_up(vk: u32, scan: u32) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP};
    let mut flags = KEYEVENTF_KEYUP;
    if is_extended_modifier_vk(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let input = make_key_input(
        vk as u16,
        scan as u16,
        flags,
        crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
    );
    send_inputs(&[input]);
}

/// Maximum age of a pending modifier-down when an F-key match arrives for
/// it to still be considered Razer encoding.  Razer Naga sends
/// modifier→F-key within ~1-5 ms; anything older is likely a user's physical
/// keyboard modifier that was merely buffered at the same time.  Consuming
/// a user modifier here used to break "hold Ctrl + mouse-Delete → Ctrl+Delete".
const RAZER_ENCODING_CHORD_WINDOW: std::time::Duration = std::time::Duration::from_millis(10);

/// Per-event freshness bound for a CONSUMED_MODIFIER_VKS entry to still
/// suppress a matching modifier-up at the C1 path.  Razer's encoding-up
/// follows the chord-down within ~100-150ms in production logs (typical
/// "press → release Razer button" cycle).  If a modifier-up arrives later
/// than this, the matching Razer up was almost certainly dropped (focus
/// change, alt-tab, slow firmware) and the up we now see is the user's
/// real modifier — letting it through avoids stuck-Ctrl.
///
/// This is a tight per-event check; the slower `gc_stale_consumed_modifiers`
/// sweep below remains as a belt-and-suspenders cleanup for entries that
/// never see any subsequent up at all.
const CONSUMED_MODIFIER_FRESHNESS_WINDOW: std::time::Duration =
    std::time::Duration::from_millis(200);

/// Default maximum lifetime of a CONSUMED_MODIFIER_VKS entry before it is
/// garbage collected.  Guards against a Razer modifier-up being lost (e.g.
/// focus change / window switch) leaving a stale entry that would suppress
/// a real subsequent Ctrl-up.
///
/// The right value is device-dependent:
///  - Too **short** and a slower Razer firmware loses its own modifier-up
///    match (observed on some Naga V2 HyperSpeed units: 1 s dropped events).
///  - Too **long** and a lost Razer up leaves Ctrl virtually held for the
///    full window (the bug the 81807d9 fix targeted: 5 s was painful).
///
/// 5 s is the safest default (matches pre-81807d9 behaviour).  Users can
/// tune via `Settings.modifierStaleGcMs`.
const DEFAULT_CONSUMED_MODIFIER_STALE_MS: u64 = 5000;

/// Default maximum age of a `REPLAYED_AWAITING_UP` entry before we
/// force-release the modifier via SendInput key-up.  Guards against
/// orphan-replays where the user's physical modifier-up was lost (alt-tab,
/// focus change, RDP, slow Razer firmware drop, external app injecting
/// modifier without matching up).
///
/// 3 s balances responsiveness against breaking legitimate long-presses:
///  - Too **short** and a force-release fires while the user is still
///    physically holding the modifier — OS thinks it is up, the next
///    Sidearm action that depends on the held modifier sees no Ctrl.
///  - Too **long** and the orphan-stuck window stretches uncomfortably.
///
/// 30 s (the historical default) was painful enough that users perceived
/// random "stuck Ctrl" episodes and reached for workarounds (re-pressing
/// Ctrl, restarting other tools).  3 s recovers fast enough that most
/// stuck-Ctrl events are imperceptible while still covering routine
/// hold-Ctrl-then-click multi-selects.  Combined with the OS-state probe
/// in `gc_orphan_replayed_modifiers`, holding Ctrl with periodic activity
/// in apps that GetAsyncKeyState-poll won't trigger spurious releases.
///
/// Users can tune via `Settings.replayedModifierForceReleaseMs`.
const DEFAULT_REPLAYED_AWAITING_UP_MS: u64 = 3_000;

thread_local! {
    /// Active threshold on the helper thread. Set once from the stdin init
    /// payload; defaults to the compile-time default if unset.
    static CONSUMED_MODIFIER_STALE_THRESHOLD: std::cell::Cell<std::time::Duration> =
        const { std::cell::Cell::new(std::time::Duration::from_millis(
            DEFAULT_CONSUMED_MODIFIER_STALE_MS,
        )) };

    /// Active threshold for force-releasing orphan replayed modifiers.
    /// Set from stdin init payload; defaults to compile-time default.
    static REPLAYED_AWAITING_UP_THRESHOLD: std::cell::Cell<std::time::Duration> =
        const { std::cell::Cell::new(std::time::Duration::from_millis(
            DEFAULT_REPLAYED_AWAITING_UP_MS,
        )) };

    /// Re-entrancy guard: set to `true` while `flush_expired_pending_modifiers`
    /// is between inserting into `REPLAYED_AWAITING_UP` and the matching
    /// SendInput call returning.  During this window a re-entrant LL hook
    /// callback (delivering a *real* physical event mid-SendInput) must NOT
    /// remove the just-inserted entry via the fresh-down clearing path —
    /// otherwise the injected key-down stays in the OS unbalanced.
    ///
    /// Cleared at the end of flush.  Read by the fresh-down clearing site to
    /// short-circuit `REPLAYED_AWAITING_UP.remove(&vk)` while flushing.
    static FLUSHING_REPLAYED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Pure decision: should a real (non-injected) modifier-down event be
/// suppressed because the OS already has an injected modifier-down for the
/// same VK awaiting its real-up?
///
/// Used to bypass the buffer/replay cycle for driver/firmware auto-repeats
/// of physical modifier keys.  Without this, every repeat triggers
/// fresh-down clearing → buffer → flush → SendInput, and each SendInput is
/// an unbalanced injection (no matching `replay_modifier_up`), eventually
/// leaving the modifier virtually held in the OS.
///
/// Returns `true` only when:
///  - the event is NOT externally injected (real keyboard / firmware),
///  - `REPLAYED_AWAITING_UP` already has an entry for this exact VK,
///  - that entry is younger than `threshold` (typically the orphan-GC
///    threshold — older than that means the tracker is stale and the
///    normal fresh-down cleanup path should run).
///
/// Pure / no side effects — caller updates the timestamp on `true`.
fn should_suppress_repeat_modifier_down(
    vk: u32,
    externally_injected: bool,
    replayed_map: &std::collections::HashMap<u32, std::time::Instant>,
    now: std::time::Instant,
    threshold: std::time::Duration,
) -> bool {
    if externally_injected {
        return false;
    }
    match replayed_map.get(&vk) {
        Some(inserted_at) => now.duration_since(*inserted_at) < threshold,
        None => false,
    }
}

/// Check for pending modifiers that have timed out (>20ms) and replay them
/// via SendInput. Called from the message pump loop.
///
/// IMPORTANT: `replay_modifier_down` invokes `SendInput`, which synchronously
/// dispatches the event through the LL hook chain.  `CallNextHookEx` in turn
/// lets other system hooks run, and Windows may deliver a *real* key event
/// to our own hook re-entrantly during that call.  That re-entrant callback
/// may try to buffer a new modifier via `PENDING_MODIFIERS.borrow_mut()`.
///
/// If we held the outer `borrow_mut()` during the replay, that would panic
/// (`RefCell already borrowed`) and abort the capture helper.  So we drain
/// expired entries into a local `Vec` FIRST, drop the borrow, THEN replay
/// each entry outside of any RefCell borrow.
fn flush_expired_pending_modifiers() {
    const MODIFIER_BUFFER_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(20);

    let expired: Vec<PendingModifier> = PENDING_MODIFIERS.with(|cell| {
        let mut pending = cell.borrow_mut();
        let now = std::time::Instant::now();
        let mut drained = Vec::new();
        pending.retain(|pm| {
            if now.duration_since(pm.buffered_at) >= MODIFIER_BUFFER_TIMEOUT {
                drained.push(*pm);
                false
            } else {
                true
            }
        });
        drained
    });

    if expired.is_empty() {
        return;
    }

    let replayed_vks: Vec<u32> = expired.iter().map(|pm| pm.vk).collect();

    // Track replayed modifiers awaiting their real key-up.  Insert BEFORE
    // SendInput so any re-entrant LL hook callback during SendInput's
    // synchronous chain delivery (real Ctrl-up arriving mid-replay — see
    // `replay_modifier_down` doc) can find and remove the entry.
    let now = std::time::Instant::now();
    REPLAYED_AWAITING_UP.with(|cell| {
        let mut map = cell.borrow_mut();
        for pm in &expired {
            map.insert(pm.vk, now);
        }
    });

    // Re-entrancy guard: while this flush is between insert and SendInput
    // return, a re-entrant LL hook callback delivering a real fresh
    // modifier-down (driver auto-repeat, racing physical event) must NOT
    // remove the entry we just inserted via the fresh-down clearing path —
    // doing so leaves the injected key-down in the OS unbalanced.
    //
    // The flag is read in the hook callback's fresh-down clearing site
    // (`is_modifier && is_keydown` block) and short-circuits the remove.
    FLUSHING_REPLAYED.with(|cell| cell.set(true));

    for pm in &expired {
        unsafe {
            replay_modifier_down(pm.vk, pm.scan);
        }
    }

    FLUSHING_REPLAYED.with(|cell| cell.set(false));

    HELPER_MATCHES.with(|mc| {
        let mut buf = mc.borrow_mut();
        buf.push(format!("DEBUG:mod-replay timeout vks={:?}", replayed_vks,));
        for vk in &replayed_vks {
            buf.push(format!(
                "DEBUG:mod-replayed-tracked vk=0x{:02X} reason=flush-timeout",
                vk,
            ));
        }
    });
    snapshot_modifier_state("after-flush-timeout");
}

/// Remove `CONSUMED_MODIFIER_VKS` entries that have been sitting in the set
/// longer than `CONSUMED_MODIFIER_STALE_THRESHOLD`.  Called from the message
/// pump loop.  A stuck entry would cause a real subsequent Ctrl-up (from the
/// user releasing the key after e.g. alt-tab ate Razer's Ctrl-up) to be
/// suppressed, leaving the OS in a phantom "Ctrl held" state until restart.
fn gc_stale_consumed_modifiers() {
    let threshold = CONSUMED_MODIFIER_STALE_THRESHOLD.with(|c| c.get());
    let removed_vks = CONSUMED_MODIFIER_VKS.with(|cell| {
        let now = std::time::Instant::now();
        let mut consumed = cell.borrow_mut();
        let mut removed = Vec::new();
        consumed.retain(|vk, at| {
            if now.duration_since(*at) >= threshold {
                removed.push(*vk);
                false
            } else {
                true
            }
        });
        removed
    });

    if !removed_vks.is_empty() {
        HELPER_MATCHES.with(|mc| {
            mc.borrow_mut().push(format!(
                "DEBUG:mod-consumed-gc stale-removed vks={:?}",
                removed_vks,
            ));
        });
        snapshot_modifier_state("after-consumed-gc");
    }
}

/// Drain `REPLAYED_AWAITING_UP` entries that have outlived their threshold.
/// Returns `(vk, age_ms)` pairs for each removed entry.  Pure state
/// manipulation — no SendInput.  Split out so unit tests can exercise the
/// expiry logic without injecting key events into the running OS.
fn drain_expired_replayed_modifiers() -> Vec<(u32, u128)> {
    let threshold = REPLAYED_AWAITING_UP_THRESHOLD.with(|c| c.get());
    REPLAYED_AWAITING_UP.with(|cell| {
        let now = std::time::Instant::now();
        let mut map = cell.borrow_mut();
        let mut out: Vec<(u32, u128)> = Vec::new();
        map.retain(|vk, at| {
            let age = now.duration_since(*at);
            if age >= threshold {
                out.push((*vk, age.as_millis()));
                false
            } else {
                true
            }
        });
        out
    })
}

/// Force-release `REPLAYED_AWAITING_UP` entries that have outlived their
/// expected real-up.  After `replay_modifier_down` we expect the user to
/// physically release the modifier (sending the up through the LL hook
/// chain → Case C0/C1/C2 removes the entry).  If that up is lost (alt-tab
/// focus change, RDP, slow Razer firmware), the entry stays and OS sees
/// ctrl-down without a balancing up — virtually held until force-release.
///
/// Before calling SendInput, probe the OS via `GetAsyncKeyState`: if the
/// modifier is already up at OS level, the real-up arrived but our tracker
/// missed clearing it (race in re-entrant LL hook callback path).  In that
/// case skip the SendInput — injecting another up could trip applications
/// that listen for KeyUp without a matching KeyDown.
///
/// True when the OS reports the physical key for `vk` as currently down
/// (`GetAsyncKeyState` high bit). The stale-hold sweep uses this to avoid
/// force-releasing a hold whose source button is still physically held but whose
/// auto-repeat stream paused (e.g. a wireless RF dropout). Thread-agnostic —
/// queries the global async key state, safe to call from the worker thread.
fn physical_key_down(vk: u32) -> bool {
    unsafe {
        (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk as i32) as u16
            & 0x8000)
            != 0
    }
}

/// Called from the message pump loop alongside `gc_stale_consumed_modifiers`.
fn gc_orphan_replayed_modifiers() {
    let expired = drain_expired_replayed_modifiers();

    if expired.is_empty() {
        return;
    }
    snapshot_modifier_state("before-orphan-gc");
    for (vk, age_ms) in &expired {
        let os_down = unsafe {
            (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(*vk as i32) as u16
                & 0x8000)
                != 0
        };
        if os_down {
            // scan=0 — we don't have the original buffered scan code at this
            // point, and Windows accepts wVk-only key-up for modifier VKs.
            unsafe {
                replay_modifier_up(*vk, 0);
            }
            HELPER_MATCHES.with(|mc| {
                mc.borrow_mut().push(format!(
                    "DEBUG:mod-replayed-force-release vk=0x{:02X} age={}ms reason=orphan-gc",
                    vk, age_ms,
                ));
            });
        } else {
            HELPER_MATCHES.with(|mc| {
                mc.borrow_mut().push(format!(
                    "DEBUG:mod-replayed-stale-cleared vk=0x{:02X} age={}ms reason=orphan-gc-os-up",
                    vk, age_ms,
                ));
            });
        }
    }
    snapshot_modifier_state("after-orphan-gc");
}

/// Diagnostic dump of all internal modifier-tracking state plus OS-level
/// `GetAsyncKeyState` for every modifier VK.  Pushed into `HELPER_MATCHES`
/// so it appears inline with the rest of the LL hook DEBUG: stream and
/// can be correlated by timestamp.  Use to diagnose stuck-Ctrl and other
/// state-divergence bugs — call from any place where the state may have
/// shifted unexpectedly.
fn snapshot_modifier_state(reason: &str) {
    let pending: Vec<u32> =
        PENDING_MODIFIERS.with(|cell| cell.borrow().iter().map(|pm| pm.vk).collect());
    let consumed: Vec<u32> =
        CONSUMED_MODIFIER_VKS.with(|cell| cell.borrow().keys().copied().collect());
    let replayed: Vec<u32> =
        REPLAYED_AWAITING_UP.with(|cell| cell.borrow().keys().copied().collect());
    let helper_state = HELPER_MODIFIERS.with(|cell| *cell.borrow());

    let probe = |vk: u32| -> bool {
        unsafe {
            (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk as i32) as u16
                & 0x8000)
                != 0
        }
    };
    let os_lctrl = probe(VK_LCONTROL);
    let os_rctrl = probe(VK_RCONTROL);
    let os_lmenu = probe(VK_LMENU);
    let os_rmenu = probe(VK_RMENU);
    let os_lshift = probe(VK_LSHIFT);
    let os_rshift = probe(VK_RSHIFT);
    let os_lwin = probe(VK_LWIN);
    let os_rwin = probe(VK_RWIN);

    HELPER_MATCHES.with(|cell| {
        cell.borrow_mut().push(format!(
            "DEBUG:state-snapshot reason={reason} pending={pending:?} consumed={consumed:?} \
             replayed={replayed:?} helper={{ctrl:{} alt:{} shift:{} win:{}}} \
             os={{LCtrl:{} RCtrl:{} LAlt:{} RAlt:{} LShift:{} RShift:{} LWin:{} RWin:{}}}",
            helper_state.ctrl,
            helper_state.alt,
            helper_state.shift,
            helper_state.win,
            os_lctrl,
            os_rctrl,
            os_lmenu,
            os_rmenu,
            os_lshift,
            os_rshift,
            os_lwin,
            os_rwin,
        ));
    });
}

/// Drain ALL entries from `REPLAYED_AWAITING_UP`, returning the VKs.  Pure
/// state manipulation — no SendInput.  Split out for unit tests.
fn take_all_replayed_modifiers() -> Vec<u32> {
    REPLAYED_AWAITING_UP.with(|cell| cell.borrow_mut().drain().map(|(vk, _)| vk).collect())
}

/// Force-release ALL entries in `REPLAYED_AWAITING_UP` via SendInput key-up.
/// Used at helper teardown (WM_QUIT), REHOOK, and health-reinstall — any
/// in-flight injected modifier-down without a matching real-up would leave
/// the OS in a stuck state if we tear down without releasing.
///
/// Pushes a DEBUG line into HELPER_MATCHES; caller is responsible for
/// `drain_helper_matches` to flush it through stdout.
fn force_release_all_replayed_modifiers(reason: &str) {
    let entries = take_all_replayed_modifiers();
    if entries.is_empty() {
        return;
    }
    for vk in &entries {
        unsafe {
            replay_modifier_up(*vk, 0);
        }
    }
    HELPER_MATCHES.with(|mc| {
        mc.borrow_mut().push(format!(
            "DEBUG:mod-replayed-force-release-all reason={reason} count={} vks={:?}",
            entries.len(),
            entries,
        ));
    });
}

/// Capacity of the bounded keyboard-event channel between the capture producer
/// (LL hook thread + helper stdout reader, hot path) and the worker consumer,
/// which a slow executor can stall. An unbounded channel would let events
/// accumulate to OOM during such a stall — the v0.1.15 log_tx failure mode.
/// 10_000 events ≈ 1–2 MB max, ~100 ms of typing on the fastest keyboards.
const CAPTURE_EVENT_CAPACITY: usize = 10_000;

impl CaptureBackendHandle {
    pub(super) fn start(
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<Self, String> {
        Self::start_with_sessions(app, runtime_store, config, app_name, Vec::new())
    }

    pub(super) fn restart_after_save(
        mut self,
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<Self, String> {
        let sessions = std::mem::take(&mut self.live_sessions);
        self.stop()?;
        Self::start_with_sessions(app, runtime_store, config, app_name, sessions)
    }

    fn start_with_sessions(
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        mut config: AppConfig,
        app_name: String,
        previous: Vec<crate::mouse_memory::live_overlay::Session>,
    ) -> Result<Self, String> {
        use crate::device_catalog::Transport;
        use crate::mouse_memory::{self, live_overlay};
        let config_dir = crate::resolve_app_paths(&app).config_dir.clone();
        let present = mouse_memory::present_models();
        live_overlay::configure(&mut config, &present);
        let consumer = mouse_memory::consumer_signals_enabled();
        let checking_extras = live_overlay::CHECK_EXTRA_CONTROLS.load(Ordering::Acquire);
        // The live maps this start drives: a live-only mouse needs its device
        // in the config; an onboard mouse is always built in.
        let mut plans = Vec::new();
        for model in live_overlay::live_models(&present) {
            if model.transport == Transport::LiveOverlay && !live_overlay::configured(&config, model) {
                continue;
            }
            match live_overlay::overlay(&config, model, consumer, checking_extras) {
                Ok(overlay) => plans.push((model, overlay)),
                Err(error) => {
                    log::warn!("[capture] {} live map not written: {error}", model.name);
                    if let Ok(mut store) = runtime_store.lock() {
                        store.record_warn(
                            "capture",
                            crate::ui_text!(
                                "capture.liveMapFailed",
                                "{model}: the side buttons could not be set up ({error}).",
                                model = model.name,
                                error = error
                            ),
                        );
                    }
                }
            }
        }
        let live: Vec<_> = plans.iter().map(|(model, _)| *model).collect();
        let registrations = build_hotkey_registrations(&config, &live, consumer)?;
        // A mouse on the onboard path reads its consumer signals the old way,
        // with the software trigger stamping the layer.
        let onboard_present = present.is_empty()
            || present.iter().any(|model| model.verified && model.transport == Transport::Onboard);
        let onboard_signals = if !onboard_present || live.iter().any(|model| model.transport == Transport::Onboard) {
            Vec::new()
        } else {
            mouse_memory::consumer_signals(&config)
        };
        let mut readers: Vec<ReaderInit> = plans
            .iter()
            .filter(|(_, overlay)| !overlay.signals.is_empty())
            .map(|(model, overlay)| ReaderInit {
                model: model.catalog_index(),
                signals: overlay.signals.clone(),
                software_layer: false,
            })
            .collect();
        if !onboard_signals.is_empty() {
            readers.push(ReaderInit {
                model: mouse_memory::config_model().catalog_index(),
                signals: onboard_signals,
                software_layer: true,
            });
        }
        let firmware_hypershift = !live_overlay::software_hypershift(&present, &live);
        // Keep a live map whose records did not change; restore the others
        // before their replacement writes over the same records.
        let mut kept = Vec::new();
        let mut stale = Vec::new();
        for session in previous {
            if plans.iter().any(|(model, overlay)| session.matches(model, &overlay.targets)) {
                kept.push(session);
            } else {
                stale.push(session);
            }
        }
        crate::mouse_memory::live_overlay::stop_sessions(stale);
        if !kept.is_empty() {
            log::info!("[capture] Keeping {} live button map(s) on config reload", kept.len());
        }
        // Map each held encoding back to its source physical VK so the stale-hold
        // sweep can probe whether the button is still physically down (RF-dropout
        // tolerance) before force-releasing. Moved into the worker thread below.
        let hold_source_vks: std::collections::HashMap<String, u32> = registrations
            .iter()
            .map(|r| (r.encoded_key.clone(), r.primary_vk))
            .collect();
        // Bounded keyboard event channel — see the module-level
        // CAPTURE_EVENT_CAPACITY for the OOM rationale.
        let (event_tx, event_rx) = mpsc::sync_channel::<EncodedKeyEvent>(CAPTURE_EVENT_CAPACITY);
        let helper_event_tx = event_tx.clone();
        // B-F4 Mode A: the helper's stdout reader flips this on EOF (helper
        // process crash). The worker then force-releases every hold whose
        // key-up the dead helper can no longer deliver, instead of waiting on
        // (and indefinitely deferring) the 2s stale sweep.
        let helper_died = Arc::new(AtomicBool::new(false));
        let worker_helper_died = helper_died.clone();
        let reader_helper_died = helper_died.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

        let worker_app = app.clone();
        let worker_runtime_store = runtime_store.clone();
        let worker_config = config.clone();
        let worker_app_name = app_name.clone();
        let worker_thread = thread::spawn(move || {
            use std::sync::mpsc::RecvTimeoutError;
            use std::time::{Duration, Instant};

            let mut held_actions: std::collections::HashMap<
                String,
                crate::input_synthesis::HeldShortcutState,
            > = std::collections::HashMap::new();
            // Track when we last observed a capture event for each held
            // encoding.  If we stop hearing from an encoding for this long
            // while it is still marked held, the capture pipeline has lost
            // the matching key-up (e.g. the helper subprocess crashed) and
            // we force-release to recover.
            let mut held_last_seen: std::collections::HashMap<String, Instant> =
                std::collections::HashMap::new();
            // Buttons whose press pattern (long, double, triple) is still open.
            let mut gestures = super::PendingGestures::default();
            // Generous timeout: a wireless source button can pause its auto-repeat
            // stream for several seconds mid-hold (RF dropout) while physically
            // held. 2s force-released those live holds, cutting off push-to-talk.
            // Before releasing on timeout we ALSO probe the source key's physical
            // state (see `hold_source_vks` below) so a still-down key survives even
            // past this window; the timeout is the belt-and-suspenders bound for a
            // genuinely lost key-up while the helper is alive (helper-death has its
            // own immediate path).
            const HOLD_STALE_THRESHOLD: Duration = Duration::from_secs(30);
            const POLL_INTERVAL: Duration = Duration::from_millis(500);

            loop {
                // Wake for the next long press or closing tap window too.
                let wait = gestures
                    .next_deadline()
                    .map_or(POLL_INTERVAL, |at| at.saturating_duration_since(Instant::now()).min(POLL_INTERVAL));
                let received = event_rx.recv_timeout(wait);
                // The clock goes after an event: a release that waited in the
                // channel still counts as the tap it was.
                if received.is_err() {
                    super::fire_due_gestures(&worker_app, &worker_runtime_store, &worker_config, &mut gestures);
                }
                match received {
                    Ok(event) => {
                        let encoded_key = event.encoded_key.clone();
                        let is_repeat = event.is_repeat;
                        let outcome = process_encoded_key_event(
                            &worker_app,
                            &worker_runtime_store,
                            &worker_config,
                            &worker_app_name,
                            event,
                            &mut held_actions,
                            &mut gestures,
                        );
                        super::fire_due_gestures(&worker_app, &worker_runtime_store, &worker_config, &mut gestures);
                        match hold_deadline_update(
                            outcome,
                            is_repeat,
                            held_actions.contains_key(&encoded_key),
                        ) {
                            HoldDeadlineUpdate::Refresh => {
                                held_last_seen.insert(encoded_key, Instant::now());
                            }
                            HoldDeadlineUpdate::Clear => {
                                held_last_seen.remove(&encoded_key);
                            }
                            HoldDeadlineUpdate::Leave => {}
                        }
                        // B-F4 Mode A: react at once if the helper just died.
                        if worker_helper_died.swap(false, Ordering::SeqCst) {
                            release_dead_helper_holds(&mut held_actions, &mut held_last_seen);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // B-F4 Mode A: if the helper process crashed (stdout
                        // EOF) during an idle period with no events flowing,
                        // react within one poll interval rather than waiting 2s.
                        if worker_helper_died.swap(false, Ordering::SeqCst) {
                            release_dead_helper_holds(&mut held_actions, &mut held_last_seen);
                        }
                        // Recover from stuck held_actions — happens when the
                        // capture helper dies mid-hold and no key-up event
                        // ever arrives.  Without this, subsequent presses of
                        // the same hotkey skip as "already held" forever.
                        let now = Instant::now();
                        let stale_keys: Vec<String> = held_last_seen
                            .iter()
                            .filter(|(_, last)| now.duration_since(**last) >= HOLD_STALE_THRESHOLD)
                            .map(|(k, _)| k.clone())
                            .collect();
                        for key in stale_keys {
                            // Don't force-release a hold whose source button is
                            // still physically down — the auto-repeat stream merely
                            // paused (wireless RF dropout). Probe the OS key state;
                            // only a genuinely-released key (reports up) or an
                            // unknown encoding is recovered. The log line records
                            // what the hardware reported either way.
                            let source_vk = hold_source_vks.get(&key).copied();
                            let physically_down = source_vk.map(physical_key_down).unwrap_or(false);
                            if physically_down {
                                log::info!(
                                    "[capture] Stale-hold check for `{key}`: source key \
                                     (vk={source_vk:?}) still physically DOWN — keeping hold \
                                     (auto-repeat paused {HOLD_STALE_THRESHOLD:?}, likely RF dropout)"
                                );
                                held_last_seen.insert(key, now);
                                continue;
                            }
                            if let Some(held) = held_actions.remove(&key) {
                                log::warn!(
                                    "[capture] Force-releasing stale hold for `{key}` \
                                     (no key-up within {HOLD_STALE_THRESHOLD:?}, source key \
                                     vk={source_vk:?} reports UP)"
                                );
                                if let Err(e) = crate::input_synthesis::send_shortcut_hold_up(&held)
                                {
                                    log::warn!("[capture] Force-release failed for `{key}`: {e}");
                                }
                            }
                            held_last_seen.remove(&key);
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }

            // Channel closed (graceful shutdown) — release all held keys
            for (encoded_key, held) in held_actions.drain() {
                if let Err(e) = crate::input_synthesis::send_shortcut_hold_up(&held) {
                    log::warn!(
                        "[capture] Failed to release held shortcut `{encoded_key}` on shutdown: {e}"
                    );
                }
            }
        });

        let hook_registrations = registrations.clone();
        let hook_thread = thread::spawn(move || {
            run_hotkey_message_loop(hook_registrations, event_tx, ready_tx);
        });

        let hook_thread_id = match ready_rx.recv() {
            Ok(Ok(thread_id)) => thread_id,
            Ok(Err(error)) => {
                drop(helper_event_tx);
                let _ = hook_thread.join();
                let _ = worker_thread.join();
                return Err(error);
            }
            Err(error) => {
                drop(helper_event_tx);
                let _ = hook_thread.join();
                let _ = worker_thread.join();
                return Err(format!(
                    "Failed to receive capture backend readiness: {error}"
                ));
            }
        };

        // Spawn helper process for LL hook (handles superset modifier matching
        // for all keys, not just modifier-combos).  Non-fatal if fails —
        // RegisterHotKey still handles bare keys with exact matching.
        let helper = spawn_capture_helper(
            app.clone(),
            runtime_store.clone(),
            &registrations,
            helper_event_tx,
            &config,
            MouseInputs { readers, firmware_hypershift, config_dir: config_dir.clone() },
            reader_helper_died,
        );
        let mut live_sessions = Vec::new();
        if helper.is_some() {
            for (model, overlay) in plans {
                if let Some(index) = kept.iter().position(|session| session.matches(model, &overlay.targets)) {
                    live_sessions.push(kept.swap_remove(index));
                } else if let Some(session) =
                    live_overlay::Session::start(model, config_dir.clone(), &config, overlay.targets)
                {
                    live_sessions.push(session);
                }
            }
        }
        if (!live_sessions.is_empty() || !registrations.is_empty())
            && helper.is_none()
            && let Ok(mut store) = runtime_store.lock()
        {
            store.record_warn(
                "capture",
                crate::ui_text!(
                    "capture.helperStartFailed",
                    "Could not start the capture helper process. Buttons with held modifiers (Ctrl/Shift) may not work."
                ),
            );
        }

        // Spawn foreground window watcher — detects window switches instantly
        let fg_app = app.clone();
        let fg_runtime_store = runtime_store.clone();
        let fg_config = config.clone();
        let fg_app_name = app_name.clone();
        let (fg_ready_tx, fg_ready_rx) = mpsc::channel::<u32>();
        let foreground_watcher_thread = thread::spawn(move || {
            run_foreground_watcher(
                fg_app,
                fg_runtime_store,
                fg_config,
                fg_app_name,
                fg_ready_tx,
            );
        });
        let foreground_watcher_thread_id = fg_ready_rx.recv().ok();

        Ok(Self {
            hook_thread_id,
            hook_thread,
            worker_thread,
            helper,
            live_sessions,
            foreground_watcher_thread_id,
            foreground_watcher_thread: Some(foreground_watcher_thread),
        })
    }

    pub(super) fn stop(self) -> Result<(), String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};

        // Every mouse restores at once, on its own thread: a mouse stuck in a
        // HID call must not hang the stop (and with it the app's exit).
        // The exit waits for them (`shutdown_mouse`), a restart per mouse
        // (`Session::start`).
        crate::mouse_memory::live_overlay::stop_sessions(self.live_sessions);
        let posted = unsafe { PostThreadMessageW(self.hook_thread_id, WM_QUIT, 0, 0) };
        if posted == 0 {
            return Err(format!(
                "Failed to post WM_QUIT to capture thread {}.",
                self.hook_thread_id
            ));
        }

        // Stop foreground watcher thread
        if let Some(fg_thread_id) = self.foreground_watcher_thread_id {
            unsafe { PostThreadMessageW(fg_thread_id, WM_QUIT, 0, 0) };
        }

        // Signal helper to exit by closing its stdin pipe, then wait for cleanup
        if let Some(helper) = self.helper {
            let HelperHandle {
                stdin_pipe,
                mut child,
                reader_thread,
                stopping,
            } = helper;
            stopping.store(true, Ordering::SeqCst);
            // A stop says so first: stdin closing without it means Sidearm died.
            let _ = write_helper_line(&stdin_pipe, HELPER_EXIT);
            drop(stdin_pipe);

            // Bounded wait: poll try_wait() up to 5 seconds, then force-kill
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }

            let _ = reader_thread.join();
        }

        // Join in a reaper thread with a bounded wait, so a wedged hook/worker
        // thread (e.g. SendInput blocked on a hung target window, so the thread
        // never pumps WM_QUIT) cannot freeze stop() — and with it the whole
        // Tauri async runtime, since stop() is awaited from the stop_runtime
        // command. A stuck thread is left as a zombie; it is torn down when the
        // process exits (the low-level hook is released with it).
        let hook_thread = self.hook_thread;
        let worker_thread = self.worker_thread;
        let foreground_watcher_thread = self.foreground_watcher_thread;
        let (done_tx, done_rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            let _ = hook_thread.join();
            let _ = worker_thread.join();
            if let Some(fg_thread) = foreground_watcher_thread {
                let _ = fg_thread.join();
            }
            let _ = done_tx.send(());
        });
        match done_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(()) => Ok(()),
            Err(_) => Err("Capture threads did not exit within 5s; forcing shutdown.".to_owned()),
        }
    }

    pub(super) fn rehook(&mut self) -> Result<(), String> {
        if let Some(ref mut helper) = self.helper {
            helper.send_command("REHOOK")
        } else {
            Err("No capture helper process is running.".to_owned())
        }
    }
}

/// Whether a device's encodings arrive another way than the keyboard: its
/// mouse sends consumer signals through a live map, or it is a live-only
/// mouse that is not connected (its aliases must not grab real shortcuts).
fn skips_keyboard(device: &str, live: &[&'static crate::device_catalog::NativeModel], consumer: bool) -> bool {
    use crate::device_catalog::{CATALOG, Transport};
    let live_now = live.iter().any(|model| model.device_id == device);
    (live_now && consumer)
        || (!live_now
            && CATALOG
                .iter()
                .any(|model| model.device_id == device && model.transport == Transport::LiveOverlay))
}

fn build_hotkey_registrations(
    config: &AppConfig,
    live: &[&'static crate::device_catalog::NativeModel],
    consumer: bool,
) -> Result<Vec<RegisteredHotkey>, String> {
    let mut registrations = Vec::with_capacity(config.encoder_mappings.len());
    for (index, mapping) in config.encoder_mappings.iter().enumerate() {
        let device = config.physical_controls.iter()
            .find(|control| control.id == mapping.control_id)
            .map(|control| control.device_id.as_str());
        if device.is_some_and(|device| skips_keyboard(device, live, consumer)) {
            continue;
        }
        let hotkey = hotkeys::parse_hotkey(&mapping.encoded_key).map_err(|message| {
            format!(
                "Failed to register encodedKey `{}` for `{}::{}`: {}",
                mapping.encoded_key,
                mapping.control_id.as_str(),
                mapping.layer.as_str(),
                message
            )
        })?;

        // A scroll wheel has no encoded key on the wire: the firmware only
        // emits `F13`..`F24` for buttons. Its hypershift-layer binding is still
        // stored as an encoder mapping (the legacy Synapse model, where Razer's
        // own driver did the translation), so tag it here and let the mouse hook
        // emit it while the trigger is held. Only capture a direction the user
        // actually bound somewhere — otherwise the wheel must keep scrolling.
        let wheel = (mapping.layer == crate::config::Layer::Hypershift)
            .then(|| wheel_axis_for_control(mapping.control_id.as_str()))
            .flatten()
            .filter(|_| {
                config.bindings.iter().any(|binding| {
                    binding.enabled
                        && binding.layer == crate::config::Layer::Hypershift
                        && binding.control_id == mapping.control_id
                })
            });

        // Side buttons are native X buttons on the wire (see `ButtonCapture`):
        // tag the mapping when its layer has an enabled binding to fire.
        let button = side_button_code(mapping.control_id.as_str())
            .filter(|_| {
                config.bindings.iter().any(|binding| {
                    binding.enabled
                        && binding.layer == mapping.layer
                        && binding.control_id == mapping.control_id
                })
            })
            .map(|code| ButtonCapture {
                code,
                hypershift: mapping.layer == crate::config::Layer::Hypershift,
            });

        registrations.push(RegisteredHotkey {
            id: (index + 1) as i32,
            encoded_key: hotkey.canonical,
            modifiers_mask: register_hotkey_mask(&hotkey.modifiers),
            primary_vk: u32::from(hotkey.key.code),
            wheel,
            button,
        });
    }

    Ok(registrations)
}

// ---------------------------------------------------------------------------
// LL hook key event processing
// ---------------------------------------------------------------------------

/// Returns `(suppress_key, new_match_added, inject_mask_key)`.
///
/// `inject_mask_key` is `true` when a combo matched while Alt or Win was active.
/// The caller must inject VK 0xE8 (down+up) via SendInput before returning from
/// the LL hook callback — this prevents Windows from generating SC_KEYMENU (Alt)
/// or activating the Start menu (Win).
fn process_helper_key_event(
    regs: &[HelperRegistration],
    modifiers: &mut HelperModifierState,
    suppressions: &mut std::collections::HashMap<u32, String>,
    matches: &mut Vec<String>,
    vk: u32,
    msg: u32,
) -> (bool, bool, bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    // Stamped at capture time: the parent resolves the layer immediately, so a
    // fast trigger release must not retro-classify a press already in flight.
    // Read here (the hook path), never at dispatch time.
    let hyper_prefix = if hyper_active_and_used() {
        HS_PREFIX
    } else {
        ""
    };

    match msg {
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            if modifiers.apply_vk_event(vk, true) {
                // Modifier event — diagnostic logging is done by caller.
                return (false, true, false);
            }

            // Collect all matching registrations for this VK, then pick
            // the most specific one (highest modifier bit count wins).
            // This prevents ambiguity when e.g. both F13 (mask=0) and
            // Shift+Ctrl+Alt+F13 (mask=0x0007) are registered.
            let mut best: Option<&HelperRegistration> = None;
            for reg in regs.iter() {
                if reg.primary_vk == vk && modifiers.matches_mask(reg.modifiers_mask) {
                    let dominated = best
                        .map(|b| reg.modifiers_mask.count_ones() > b.modifiers_mask.count_ones())
                        .unwrap_or(true);
                    if dominated {
                        best = Some(reg);
                    }
                }
            }

            if let Some(winner) = best {
                // Log when most-specific-match resolved ambiguity
                if log::log_enabled!(log::Level::Debug) {
                    let total_matches = regs
                        .iter()
                        .filter(|r| r.primary_vk == vk && modifiers.matches_mask(r.modifiers_mask))
                        .count();
                    if total_matches > 1 {
                        log::debug!(
                            "[modifier-passthrough] Most-specific-match: chose `{}` \
                             (mask=0x{:04X}, {} bits) over {} other candidate(s) for vk=0x{:02X}",
                            winner.encoded_key,
                            winner.modifiers_mask,
                            winner.modifiers_mask.count_ones(),
                            total_matches - 1,
                            vk,
                        );
                    }
                }

                let is_repeat = suppressions.contains_key(&vk);
                if !is_repeat {
                    suppressions.insert(vk, winner.encoded_key.clone());
                }
                // Always emit the match — including on auto-repeat.
                // This enables key-repeat for tap-mode actions (e.g.
                // holding a mouse button mapped to Backspace deletes
                // characters continuously).  The handler uses the
                // REPEAT: prefix to guard hold-mode and non-shortcut
                // actions from re-firing.
                if is_repeat {
                    matches.push(format!("{hyper_prefix}REPEAT:{}", winner.encoded_key));
                } else {
                    matches.push(format!("{hyper_prefix}{}", winner.encoded_key));
                }
                // Inject mask key only on first press — Alt/Win state
                // is stable during repeats.
                let need_mask = !is_repeat && (modifiers.alt || modifiers.win);
                return (true, true, need_mask);
            }

            (false, false, false)
        }
        WM_KEYUP | WM_SYSKEYUP => {
            if modifiers.apply_vk_event(vk, false) {
                // Modifier-up — diagnostic logging is done by caller.
                (false, true, false)
            } else if let Some(encoded_key) = suppressions.remove(&vk) {
                matches.push(format!("{hyper_prefix}UP:{encoded_key}"));
                (true, true, false)
            } else {
                (false, false, false)
            }
        }
        _ => (false, false, false),
    }
}

/// Inject VK 0xE8 (down + up) via SendInput.  This "Menu Mask Key" prevents
/// Windows from generating SC_KEYMENU or activating the Start menu when the
/// only keys between a modifier-down and modifier-up were suppressed by our
/// hook.  The events carry `INTERNAL_SENDINPUT_EXTRA_INFO` so our LL hook
/// passes them through without processing.
unsafe fn inject_mask_key() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP;

    let make_input = |key_up: bool| {
        make_key_input(
            VK_MASK_KEY,
            0,
            if key_up { KEYEVENTF_KEYUP } else { 0 },
            crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
        )
    };

    let inputs = [make_input(false), make_input(true)];
    send_inputs(&inputs);
}

/// Inject a VK 0xE8 probe event via SendInput to test hook health.
/// The event carries `HOOK_PROBE_EXTRA_INFO` so the hook callback can
/// recognize it and set the `HELPER_PROBE_RECEIVED` flag without treating
/// it as a real key event.
///
/// Returns `true` if SendInput accepted the events, `false` if injection
/// failed (e.g. UIPI blocked it because an elevated window is focused).
unsafe fn inject_hook_probe() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP;

    let make_input = |key_up: bool| {
        make_key_input(
            VK_PROBE_KEY,
            0,
            if key_up { KEYEVENTF_KEYUP } else { 0 },
            HOOK_PROBE_EXTRA_INFO,
        )
    };

    let inputs = [make_input(false), make_input(true)];
    let inserted = send_inputs(&inputs);
    if inserted == 0 {
        log::debug!(
            "[capture-helper] SendInput probe failed (UIPI?): {}",
            std::io::Error::last_os_error()
        );
    }
    inserted > 0
}

// ---------------------------------------------------------------------------
// Software Hypershift (WH_MOUSE_LL)
// ---------------------------------------------------------------------------
//
// The device stores two records per button but its firmware only ever emits the
// standard layer (measured on hardware 2026-10-16: holding the right button and
// pressing a thumb still emits `F13`..`F24`, never the layer-1 record). So
// Hypershift cannot be read out of the mouse — it has to be *imposed*: while the
// trigger button is held, a press belongs to the `hypershift` layer.
//
// The trigger button is a native mouse button (a button whose onboard record was
// rewritten into a keystroke never reaches a mouse hook), so the trigger state
// and the trigger's own suppression live in a mouse hook, and the keyboard hook
// only *reads* that state to stamp the encoded keys it emits.

/// No Hypershift trigger configured — no mouse hook is installed at all.
const HYPER_TRIGGER_OFF: u8 = 0;
const HYPER_TRIGGER_LEFT: u8 = 1;
const HYPER_TRIGGER_RIGHT: u8 = 2;
const HYPER_TRIGGER_MIDDLE: u8 = 3;
/// XBUTTON1 / XBUTTON2 — "mouse 4" / "mouse 5".
const HYPER_TRIGGER_X1: u8 = 4;
const HYPER_TRIGGER_X2: u8 = 5;

/// Maps `Settings.hypershift_trigger` (a control id) onto the wire code handed
/// to the capture helper. Unknown or absent values disable the trigger.
fn hypershift_trigger_code(control_id: &str) -> u8 {
    match control_id.trim() {
        "mouse_left" => HYPER_TRIGGER_LEFT,
        "mouse_right" => HYPER_TRIGGER_RIGHT,
        "wheel_click" => HYPER_TRIGGER_MIDDLE,
        "mouse_4" => HYPER_TRIGGER_X1,
        "mouse_5" => HYPER_TRIGGER_X2,
        _ => HYPER_TRIGGER_OFF,
    }
}

/// X-button code of a side-button control id.
fn side_button_code(control_id: &str) -> Option<u8> {
    match control_id.trim() {
        "mouse_4" => Some(HYPER_TRIGGER_X1),
        "mouse_5" => Some(HYPER_TRIGGER_X2),
        _ => None,
    }
}

/// The match line a side-button press becomes, or `None` to leave it native.
/// With the trigger held the hypershift encoding wins (stamped `HS:`); without
/// a hypershift binding the standard one still fires, stamped, so the resolver
/// falls back to the standard binding exactly as it does for the thumbs.
fn side_button_capture(regs: &[HelperRegistration], code: u8, trigger_held: bool) -> Option<String> {
    let find = |hypershift: bool| {
        regs.iter()
            .find(|reg| reg.button == Some(ButtonCapture { code, hypershift }))
            .map(|reg| reg.encoded_key.as_str())
    };
    let key = if trigger_held { find(true).or_else(|| find(false)) } else { find(false) }?;
    let prefix = if trigger_held { HS_PREFIX } else { "" };
    Some(format!("{prefix}{key}"))
}

/// Maps a scroll-wheel control id onto the axis the mouse hook captures.
fn wheel_axis_for_control(control_id: &str) -> Option<WheelAxis> {
    match control_id.trim() {
        "wheel_up" => Some(WheelAxis::Up),
        "wheel_down" => Some(WheelAxis::Down),
        "wheel_left" => Some(WheelAxis::Left),
        "wheel_right" => Some(WheelAxis::Right),
        _ => None,
    }
}

/// A registration captures a side button, so the mouse hook is needed even
/// with Hypershift off.
static HELPER_CAPTURES_SIDE_BUTTONS: AtomicBool = AtomicBool::new(false);

/// Whether the helper needs its mouse hook at all.
fn mouse_hook_wanted() -> bool {
    HELPER_HYPER_TRIGGER.load(Ordering::Relaxed) != HYPER_TRIGGER_OFF
        || HELPER_CAPTURES_SIDE_BUTTONS.load(Ordering::Relaxed)
        || HELPER_HYPER2_ENABLED.load(Ordering::Relaxed)
}

/// Trigger the helper acts on (`HYPER_TRIGGER_OFF` = Hypershift disabled).
static HELPER_HYPER_TRIGGER: AtomicU8 = AtomicU8::new(HYPER_TRIGGER_OFF);
/// True while the trigger button is physically held. Written by the mouse hook,
/// read by the keyboard hook when it stamps a matched key as hypershift-layer.
static HELPER_HYPER_ACTIVE: AtomicBool = AtomicBool::new(false);
/// `Settings.hypershift_tap`: a quick press of the trigger, with nothing else
/// pressed while it was held, plays the trigger button's own click.
static HELPER_HYPER_TAP: AtomicBool = AtomicBool::new(false);
/// Something was pressed while the trigger was held (the layer was used), so
/// its release is no click.
static HELPER_HYPER_USED: AtomicBool = AtomicBool::new(false);

/// The trigger is held: whatever arrives now uses the layer.
fn hyper_active_and_used() -> bool {
    let held = HELPER_HYPER_ACTIVE.load(Ordering::Relaxed);
    if held {
        HELPER_HYPER_USED.store(true, Ordering::Relaxed);
    }
    held
}
/// A mouse has a HyperShift 2 trigger in some profile: the mouse hook is
/// needed even while the profile in effect has none.
static HELPER_HYPER2_ENABLED: AtomicBool = AtomicBool::new(false);
/// The profile in effect's HyperShift 2 trigger (`HS2:<code>` from the
/// parent on every profile change), `HYPER_TRIGGER_OFF` = none.
static HELPER_HYPER2_TRIGGER: AtomicU8 = AtomicU8::new(HYPER_TRIGGER_OFF);
/// The HyperShift 2 trigger being held, kept apart from the setting so a
/// profile change mid-hold still sees its release.
static HELPER_HYPER2_HELD: AtomicU8 = AtomicU8::new(HYPER_TRIGGER_OFF);
/// Something was pressed while the HyperShift 2 trigger was held.
static HELPER_HYPER2_USED: AtomicBool = AtomicBool::new(false);
/// Parent → helper: `HS2:<code>`.
const HYPER2_COMMAND: &str = "HS2:";
/// Buttons that may be a HyperShift 2 trigger (never the left one).
const HYPER2_CODES: [u8; 4] = [HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_MIDDLE, HYPER_TRIGGER_X1, HYPER_TRIGGER_X2];

/// What a button event means for HyperShift 2: `Some(true)` the trigger goes
/// down, `Some(false)` the held one comes up, `None` not the trigger. A press
/// of the button already marked held starts a fresh hold: its release was
/// missed (the hook was dropped and reinstalled, the secure desktop took it),
/// and passing the press through would leave its release swallowed — a right
/// button stuck down.
fn hypershift2_step(trigger: u8, held: u8, button: u8, is_down: bool) -> Option<bool> {
    if is_down && button != HYPER_TRIGGER_OFF && (button == trigger || button == held) {
        Some(true)
    } else if !is_down && held != HYPER_TRIGGER_OFF && button == held {
        Some(false)
    } else {
        None
    }
}

/// A reader's `H2:` stamp: the trigger is held. A press in `lines` uses the
/// layer, so the trigger's release is no click.
fn hyper2_stamp(lines: &[String]) -> bool {
    let held = HELPER_HYPER2_HELD.load(Ordering::Relaxed) != HYPER_TRIGGER_OFF;
    let press = |line: &String| {
        let line = line.strip_prefix(HS_PREFIX).unwrap_or(line);
        !line.starts_with("UP:") && !line.starts_with("REPEAT:")
    };
    if held && lines.iter().any(press) {
        HELPER_HYPER2_USED.store(true, Ordering::Relaxed);
    }
    held
}

/// Each profile's HyperShift 2 trigger on `model` as a mouse-hook button code:
/// a button the mouse still reports natively (not in its live map), never
/// the left one or the software HyperShift trigger.
fn hypershift2_codes(config: &AppConfig, model: &crate::device_catalog::NativeModel, software_trigger: u8) -> Vec<(String, u8)> {
    config
        .profiles
        .iter()
        .filter_map(|profile| {
            let code = profile.hypershift2_triggers.iter().find_map(|id| {
                let name = id.strip_prefix(model.control_prefix)?;
                let code = hypershift_trigger_code(name);
                let native = !model.native_buttons.iter().any(|(button, _, _)| *button == name);
                (native && HYPER2_CODES.contains(&code) && code != software_trigger).then_some(code)
            })?;
            Some((profile.id.clone(), code))
        })
        .collect()
}

/// Writes one command line to the helper.
fn write_helper_line(stdin: &Mutex<std::process::ChildStdin>, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut pipe = stdin.lock().map_err(|_| std::io::Error::other("helper stdin lock poisoned"))?;
    writeln!(pipe, "{line}").and_then(|()| pipe.flush())
}

/// What a profile change needs to switch the HyperShift 2 trigger: the
/// running helper, each profile's trigger code, the code last sent.
struct Hypershift2Switch {
    stdin: std::sync::Weak<Mutex<std::process::ChildStdin>>,
    codes: Vec<(String, u8)>,
    sent: Option<u8>,
}

static HYPERSHIFT2_SWITCH: Mutex<Option<Hypershift2Switch>> = Mutex::new(None);

/// Points the switch at a new helper (`None`: no mouse has a trigger) and
/// sends the trigger of the profile in effect now.
fn install_hypershift2_switch(
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    codes: Option<Vec<(String, u8)>>,
    config: &AppConfig,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
) {
    let Ok(mut switch) = HYPERSHIFT2_SWITCH.lock() else { return };
    *switch = codes.map(|codes| Hypershift2Switch { stdin: Arc::downgrade(stdin), codes, sent: None });
    if switch.is_none() {
        return;
    }
    drop(switch);
    // A profile chosen by hand, else the window in front, else (Sidearm's own
    // window in front, as after a save) the last window seen.
    let (manual, last) = runtime_store
        .lock()
        .ok()
        .map(|store| {
            let last = store.last_foreground_window().and_then(|result| result.resolved_profile_id.clone());
            (store.manual_profile_override().map(str::to_owned), last)
        })
        .unwrap_or_default();
    let profile = manual.or_else(|| {
        window_capture::capture_active_window_with_resolution_with_override(config, "", None, None)
            .ok()
            .filter(|result| !result.ignored)
            .and_then(|result| result.resolved_profile_id)
            .or(last)
    });
    follow_profile_hypershift2(profile.as_deref());
}

/// Turns the HyperShift 2 trigger on or off for the profile now in effect.
pub(super) fn follow_profile_hypershift2(profile_id: Option<&str>) {
    let Ok(mut guard) = HYPERSHIFT2_SWITCH.lock() else { return };
    let Some(switch) = guard.as_mut() else { return };
    let code = profile_id
        .and_then(|id| switch.codes.iter().find(|(profile, _)| profile == id))
        .map_or(HYPER_TRIGGER_OFF, |(_, code)| *code);
    if switch.sent == Some(code) {
        return;
    }
    let Some(stdin) = switch.stdin.upgrade() else { return };
    match write_helper_line(&stdin, &format!("{HYPER2_COMMAND}{code}")) {
        Ok(()) => {
            switch.sent = Some(code);
            log::info!("[capture] HyperShift 2 trigger for this profile: {code}");
        }
        Err(error) => log::warn!("[capture] HyperShift 2 switch not sent: {error}"),
    }
}

/// True between a left-down we translated into a right-down and its matching
/// left-up, so the injected right click stays balanced even when the trigger is
/// released first — an application must never be left with the right button
/// stuck down. Deliberately *not* cleared on unhook: the matching left-up still
/// arrives after a reinstall and must close the pair.
static HELPER_LMB_TRANSLATED: AtomicBool = AtomicBool::new(false);

/// Cursor movement (px) that proves a live mouse hook must have received events.
/// Windows drops `WH_MOUSE_LL` silently once a callback exceeds
/// `LowLevelHooksTimeout` and never reports it, so the health monitor has to
/// infer death from evidence. Every cursor move reaches a live hook; a pointer
/// that crossed this distance in a check cycle with no callback means the hook
/// is gone.
const MOUSE_HEALTH_MOVE_PX: i32 = 2;
/// Consecutive trigger-held cycles with zero mouse callbacks before the health
/// monitor spends a probe. Holding the trigger with the pointer parked is
/// legitimate, so it takes two idle cycles (~10 s) before even asking.
const MOUSE_HEALTH_HELD_CYCLES: u32 = 2;
/// Consecutive failed mouse-hook probes before the hook is reinstalled.
const MOUSE_PROBE_FAIL_THRESHOLD: u32 = 2;

/// Queue of right-click injections requested by the mouse hook.
///
/// The hook callback must never call `SendInput` itself. Measured on Windows: a
/// `SendInput` issued from inside a `WH_MOUSE_LL` callback blocks for the whole
/// `LowLevelHooksTimeout` (~1000 ms), because the injected event has to travel
/// the very hook chain whose thread is still inside the callback. Every other
/// input event queues behind it, so the pointer freezes in ~1 s batches (two per
/// translated click: down + up) until Windows silently drops the hook. The
/// callback therefore only enqueues; a dedicated thread injects. A *passive*
/// mouse hook costs that thread nothing (same measurement: 1–4 ms per event).
static HYPER_INJECT_TX: OnceLock<mpsc::Sender<(u8, bool)>> = OnceLock::new();
/// Right-button injections enqueued but not yet performed. Drained before the
/// helper exits, so a translated click can never leave the right button down.
static HYPER_INJECT_PENDING: AtomicUsize = AtomicUsize::new(0);

/// What the mouse hook must do with one button or wheel message. Keeping this a
/// pure decision leaves the hook body free of Win32 calls beyond the
/// injected-event check, and makes the translation logic unit-testable.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HyperMouseAction {
    /// Not ours — pass the event to the next hook.
    Pass,
    /// Swallow the trigger press/release and record the new held state.
    SetTriggerHeld(bool),
    /// Swallow the HyperShift 2 trigger's press/release (that button, held).
    SetTrigger2Held(u8, bool),
    /// Swallow the left button and enqueue a synthetic right-down.
    InjectRightDown,
    /// Swallow the left button and enqueue the balancing right-up.
    InjectRightUp,
    /// Swallow a scroll tick and emit the hypershift-layer encoding of that
    /// wheel direction (the firmware can never produce it itself).
    CaptureWheel(String),
    /// Swallow a side-button press and emit this match line (see
    /// [`side_button_capture`]); the release must be swallowed too.
    CaptureButtonDown(u8, String),
    /// Swallow the release of a captured side button and emit its key-up.
    CaptureButtonUp(u8, String),
}

/// Maps a button message onto `(trigger code, is_down)`. `None` for every
/// message the Hypershift layer does not track (moves, wheel, …).
fn mouse_button_code(msg: u32, mouse_data: u32) -> Option<(u8, bool)> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
        WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON2,
    };

    Some(match msg {
        WM_LBUTTONDOWN => (HYPER_TRIGGER_LEFT, true),
        WM_LBUTTONUP => (HYPER_TRIGGER_LEFT, false),
        WM_RBUTTONDOWN => (HYPER_TRIGGER_RIGHT, true),
        WM_RBUTTONUP => (HYPER_TRIGGER_RIGHT, false),
        WM_MBUTTONDOWN => (HYPER_TRIGGER_MIDDLE, true),
        WM_MBUTTONUP => (HYPER_TRIGGER_MIDDLE, false),
        // Both X messages carry the button in the high word of mouseData.
        WM_XBUTTONDOWN | WM_XBUTTONUP => {
            let which = (mouse_data >> 16) as u16;
            let button = if which == XBUTTON2 {
                HYPER_TRIGGER_X2
            } else {
                HYPER_TRIGGER_X1
            };
            (button, msg == WM_XBUTTONDOWN)
        }
        _ => return None,
    })
}

/// Decides what one mouse button event means for the Hypershift layer.
///
/// Synapse semantics: the trigger button is a pure modifier (swallowed, only
/// toggling the held state) and, while it is held, the left button becomes a
/// right click. The pairing flag keeps a translated click balanced when the
/// trigger is released before the left button.
fn hyper_mouse_action(
    trigger: u8,
    button: u8,
    is_down: bool,
    trigger_held: bool,
    lmb_translated: bool,
    tap: bool,
) -> HyperMouseAction {
    if button == trigger {
        return HyperMouseAction::SetTriggerHeld(is_down);
    }
    if button != HYPER_TRIGGER_LEFT {
        return HyperMouseAction::Pass;
    }
    if !is_down {
        // Left-up: close the pair when the matching left-down was translated,
        // even if the trigger was already released.
        return if lmb_translated {
            HyperMouseAction::InjectRightUp
        } else {
            HyperMouseAction::Pass
        };
    }
    // Left-down becomes a right-down while the trigger is held. With the left
    // button itself as the trigger there is nothing to translate, and a
    // trigger that clicks on a quick press has its own right click.
    if trigger != HYPER_TRIGGER_LEFT && trigger_held && !tap {
        HyperMouseAction::InjectRightDown
    } else {
        HyperMouseAction::Pass
    }
}

/// Wake the helper's message loop so `drain_helper_matches` flushes what the
/// hooks buffered. LL hook callbacks are delivered as sent messages during
/// dispatch and do not make the loop's own wait return, so a callback that
/// produced output has to post this explicitly.
fn wake_helper_loop() {
    use windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW;

    const WM_APP: u32 = 0x8000;
    HELPER_THREAD_ID.with(|cell| {
        let tid = cell.get();
        if tid != 0 {
            unsafe { PostThreadMessageW(tid, WM_APP, 0, 0) };
        }
    });
}

/// Decides what one scroll-wheel message means while the Hypershift trigger is
/// held: the encoded key of that direction's hypershift-layer registration, or
/// `None` to leave the tick to the OS (native scrolling).
///
/// Measured on this device: the firmware never turns a scroll tick into a
/// keystroke, so no registration can ever match one — `F13`..`F24` only ever
/// describe buttons. An unstamped wheel event therefore always resolved to the
/// standard layer, which is why wheel bindings on the hypershift layer (e.g.
/// `Zoom In`) could never fire. The hook emits the encoding instead, and only
/// for a direction the user actually bound: a wheel with no binding must keep
/// scrolling.
fn wheel_capture_action(
    regs: &[HelperRegistration],
    msg: u32,
    mouse_data: u32,
    trigger_held: bool,
) -> Option<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_MOUSEHWHEEL, WM_MOUSEWHEEL};

    if !trigger_held {
        return None;
    }
    let delta = ((mouse_data >> 16) & 0xFFFF) as u16 as i16;
    if delta == 0 {
        return None;
    }
    let axis = match msg {
        WM_MOUSEWHEEL => {
            if delta > 0 {
                WheelAxis::Up
            } else {
                WheelAxis::Down
            }
        }
        WM_MOUSEHWHEEL => {
            if delta > 0 {
                WheelAxis::Right
            } else {
                WheelAxis::Left
            }
        }
        _ => return None,
    };
    regs.iter()
        .find(|reg| reg.wheel == Some(axis))
        .map(|reg| reg.encoded_key.clone())
}

/// True while this session is displayed through Remote Desktop. Re-read per
/// button event (a cheap user32 read, never on mouse moves) because a console
/// session can be taken over by RDP — and handed back — while the helper runs.
fn is_remote_session() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

/// Hand a right-button injection to the injector thread. Never blocks and never
/// calls Win32, so it is safe inside the hook callback.
fn queue_hyper_injection(button: u8, down: bool) {
    let Some(tx) = HYPER_INJECT_TX.get() else {
        return;
    };
    HYPER_INJECT_PENDING.fetch_add(1, Ordering::AcqRel);
    if tx.send((button, down)).is_err() {
        HYPER_INJECT_PENDING.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Spawn the thread that performs the mouse hook's right-button injections.
/// Idempotent; call before installing the mouse hook so no callback misses it.
fn start_hyper_injector() {
    let (tx, rx) = mpsc::channel::<(u8, bool)>();
    if HYPER_INJECT_TX.set(tx).is_err() {
        return;
    }
    let spawned = thread::Builder::new()
        .name("hyper-inject".to_string())
        .spawn(move || {
            unsafe {
                use windows_sys::Win32::System::Threading::{
                    GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
                };
                SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
            }
            while let Ok((button, down)) = rx.recv() {
                unsafe { inject_button(button, down) };
                HYPER_INJECT_PENDING.fetch_sub(1, Ordering::AcqRel);
            }
        });
    if spawned.is_err() {
        log::error!("[capture-helper] Failed to spawn the Hypershift injector thread.");
    }
}

/// Wait (bounded) for queued right-button injections to finish, so an exiting
/// helper cannot strand the right button in the down state.
fn drain_pending_hyper_injections(budget: std::time::Duration) {
    let deadline = std::time::Instant::now() + budget;
    while HYPER_INJECT_PENDING.load(Ordering::Acquire) > 0
        && std::time::Instant::now() < deadline
    {
        thread::sleep(std::time::Duration::from_millis(2));
    }
}

/// Send one synthetic right-button event carrying
/// [`crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO`] so our own mouse
/// hook passes it through instead of translating it again.
///
/// Runs on the injector thread only — never inside a hook callback (see
/// [`HYPER_INJECT_TX`]).
unsafe fn inject_button(button: u8, down: bool) {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, SendInput,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{XBUTTON1, XBUTTON2};

    let (flags, data) = match (button, down) {
        (HYPER_TRIGGER_LEFT, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (HYPER_TRIGGER_LEFT, false) => (MOUSEEVENTF_LEFTUP, 0),
        (HYPER_TRIGGER_MIDDLE, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (HYPER_TRIGGER_MIDDLE, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (HYPER_TRIGGER_X1, true) => (MOUSEEVENTF_XDOWN, i32::from(XBUTTON1)),
        (HYPER_TRIGGER_X1, false) => (MOUSEEVENTF_XUP, i32::from(XBUTTON1)),
        (HYPER_TRIGGER_X2, true) => (MOUSEEVENTF_XDOWN, i32::from(XBUTTON2)),
        (HYPER_TRIGGER_X2, false) => (MOUSEEVENTF_XUP, i32::from(XBUTTON2)),
        (_, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (_, false) => (MOUSEEVENTF_RIGHTUP, 0),
    };
    let input = crate::input_synthesis::make_mouse_input(flags, data);
    unsafe {
        SendInput(
            1,
            &input,
            size_of::<windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT>() as i32,
        );
    }
}

/// LL mouse hook callback for the capture helper process. Installed only while a
/// Hypershift trigger is configured.
///
/// Three jobs, all inside the ~200–300 ms LL-hook budget:
///  - the trigger button is swallowed and only toggles [`HELPER_HYPER_ACTIVE`]
///    (Synapse semantics: that button is the Hypershift modifier, not a click);
///  - while the trigger is held, the left button becomes a right click — queued
///    for the injector thread, never injected from here (see [`HYPER_INJECT_TX`]);
///  - it reports liveness to the health monitor, which is the only way to notice
///    that Windows silently removed the hook.
///
/// Everything else — mouse moves, wheel, our own injections — returns
/// `CallNextHookEx` untouched, so the per-move cost is one flag store.
unsafe extern "system" fn helper_ll_mouse_proc(code: i32, w_param: usize, l_param: isize) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, MSLLHOOKSTRUCT, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    };

    let pass_through = || unsafe { CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param) };

    if code < 0 {
        return pass_through();
    }
    let msg = w_param as u32;

    // Liveness evidence for the health monitor — set before any bail-out so that
    // ordinary moves count. This is the only signal able to detect Windows
    // dropping the hook after a low-level-hook timeout.
    HOOK_HAD_MOUSE_CALLBACK.with(|cell| cell.set(true));

    let ms = unsafe { &*(l_param as *const MSLLHOOKSTRUCT) };
    if msg == WM_MOUSEMOVE {
        // Health-monitor probe (a tagged 1-px nudge) — acknowledge it; the move
        // itself passes through untouched.
        if ms.dwExtraInfo == HOOK_PROBE_EXTRA_INFO {
            HELPER_MOUSE_PROBE_RECEIVED.with(|cell| cell.set(true));
        }
        return pass_through();
    }

    // A panic unwinding across this `extern "system"` boundary is UB — contain it
    // and fall through to CallNextHookEx (never suppress on a panic).
    let action = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let trigger = HELPER_HYPER_TRIGGER.load(Ordering::Relaxed);
        if ms.dwExtraInfo == crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO {
            // Our own synthetic right click / Ctrl+wheel / X button — pass it through.
            return HyperMouseAction::Pass;
        }
        // Under RDP the buttons come from the client's mouse, not this machine's:
        // swallowing the trigger there kills every remote right click, so the
        // software Hypershift layer stays off for the life of a remote session.
        let remote = is_remote_session();
        let trigger = if remote {
            HELPER_HYPER_ACTIVE.store(false, Ordering::Relaxed);
            HYPER_TRIGGER_OFF
        } else {
            trigger
        };
        // HyperShift 2 first: its trigger is never the software trigger, and
        // under RDP it is off too (the buttons are the client's).
        let held2 = if remote {
            HELPER_HYPER2_HELD.store(HYPER_TRIGGER_OFF, Ordering::Relaxed);
            HYPER_TRIGGER_OFF
        } else {
            HELPER_HYPER2_HELD.load(Ordering::Relaxed)
        };
        if let Some((button, is_down)) = mouse_button_code(msg, ms.mouseData) {
            let trigger2 = if remote { HYPER_TRIGGER_OFF } else { HELPER_HYPER2_TRIGGER.load(Ordering::Relaxed) };
            if let Some(held) = hypershift2_step(trigger2, held2, button, is_down) {
                if is_down && HELPER_HYPER_ACTIVE.load(Ordering::Relaxed) {
                    HELPER_HYPER_USED.store(true, Ordering::Relaxed);
                }
                return HyperMouseAction::SetTrigger2Held(button, held);
            }
            if held2 != HYPER_TRIGGER_OFF && is_down {
                HELPER_HYPER2_USED.store(true, Ordering::Relaxed);
            }
        } else if held2 != HYPER_TRIGGER_OFF && (msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL) {
            HELPER_HYPER2_USED.store(true, Ordering::Relaxed);
        }
        let trigger_held = HELPER_HYPER_ACTIVE.load(Ordering::Relaxed);
        if trigger_held
            && (msg == WM_MOUSEWHEEL
                || msg == WM_MOUSEHWHEEL
                || mouse_button_code(msg, ms.mouseData).is_some_and(|(button, down)| down && button != trigger))
        {
            HELPER_HYPER_USED.store(true, Ordering::Relaxed);
        }
        if let Some((button, is_down)) = mouse_button_code(msg, ms.mouseData)
            && (button == HYPER_TRIGGER_X1 || button == HYPER_TRIGGER_X2)
            && button != trigger
        {
            let slot = usize::from(button - HYPER_TRIGGER_X1);
            if is_down {
                let line = HELPER_REGISTRATIONS
                    .with(|cell| side_button_capture(&cell.borrow(), button, trigger_held));
                return line.map_or(HyperMouseAction::Pass, |line| {
                    HyperMouseAction::CaptureButtonDown(button, line)
                });
            }
            return HELPER_SIDE_BUTTON_DOWN
                .with(|cell| cell.borrow_mut()[slot].take())
                .map_or(HyperMouseAction::Pass, |line| {
                    HyperMouseAction::CaptureButtonUp(button, line)
                });
        }
        if trigger == HYPER_TRIGGER_OFF {
            return HyperMouseAction::Pass;
        }
        if let Some(encoded_key) = HELPER_REGISTRATIONS
            .with(|cell| wheel_capture_action(&cell.borrow(), msg, ms.mouseData, trigger_held))
        {
            return HyperMouseAction::CaptureWheel(encoded_key);
        }
        let Some((button, is_down)) = mouse_button_code(msg, ms.mouseData) else {
            return HyperMouseAction::Pass;
        };
        hyper_mouse_action(
            trigger,
            button,
            is_down,
            trigger_held,
            HELPER_LMB_TRANSLATED.load(Ordering::Relaxed),
            HELPER_HYPER_TAP.load(Ordering::Relaxed),
        )
    }))
    .unwrap_or(HyperMouseAction::Pass);

    // The trigger press/release and both halves of the translated click are
    // swallowed; the actual right-click injection happens on the injector thread.
    match action {
        HyperMouseAction::Pass => pass_through(),
        HyperMouseAction::SetTriggerHeld(held) => {
            let used = HELPER_HYPER_USED.swap(false, Ordering::Relaxed);
            HELPER_HYPER_ACTIVE.store(held, Ordering::Relaxed);
            // A quick press that used no layer: the button's own click.
            if !held && !used && HELPER_HYPER_TAP.load(Ordering::Relaxed) {
                let trigger = HELPER_HYPER_TRIGGER.load(Ordering::Relaxed);
                queue_hyper_injection(trigger, true);
                queue_hyper_injection(trigger, false);
            }
            1
        }
        HyperMouseAction::SetTrigger2Held(button, held) => {
            let used = HELPER_HYPER2_USED.swap(false, Ordering::Relaxed);
            HELPER_HYPER2_HELD.store(if held { button } else { HYPER_TRIGGER_OFF }, Ordering::Relaxed);
            // Let go with nothing pressed meanwhile: the button's own click.
            if !held && !used {
                queue_hyper_injection(button, true);
                queue_hyper_injection(button, false);
            }
            1
        }
        HyperMouseAction::InjectRightDown => {
            HELPER_LMB_TRANSLATED.store(true, Ordering::Relaxed);
            HELPER_MATCHES.with(|cell| {
                cell.borrow_mut().push(format!(
                    "{NOTE_PREFIX}Hypershift click: left button -> right click (trigger held)"
                ));
            });
            wake_helper_loop();
            queue_hyper_injection(HYPER_TRIGGER_RIGHT, true);
            1
        }
        HyperMouseAction::InjectRightUp => {
            HELPER_LMB_TRANSLATED.store(false, Ordering::Relaxed);
            queue_hyper_injection(HYPER_TRIGGER_RIGHT, false);
            1
        }
        HyperMouseAction::CaptureButtonDown(button, line) => {
            HELPER_SIDE_BUTTON_DOWN
                .with(|cell| cell.borrow_mut()[usize::from(button - HYPER_TRIGGER_X1)] = Some(line.clone()));
            HELPER_MATCHES.with(|cell| cell.borrow_mut().push(line));
            wake_helper_loop();
            1
        }
        HyperMouseAction::CaptureButtonUp(_, line) => {
            let up = match line.strip_prefix(HS_PREFIX) {
                Some(key) => format!("{HS_PREFIX}UP:{key}"),
                None => format!("UP:{line}"),
            };
            HELPER_MATCHES.with(|cell| cell.borrow_mut().push(up));
            wake_helper_loop();
            1
        }
        HyperMouseAction::CaptureWheel(encoded_key) => {
            HELPER_MATCHES.with(|cell| {
                let mut matches = cell.borrow_mut();
                // A wheel tick has no release of its own: emit the balancing
                // key-up too, so a hold-mode action cannot stick.
                matches.push(format!("{HS_PREFIX}{encoded_key}"));
                matches.push(format!("{HS_PREFIX}UP:{encoded_key}"));
                matches.push(format!("DEBUG:hypershift-wheel key={encoded_key}"));
            });
            wake_helper_loop();
            1
        }
    }
}

/// Install the LL mouse hook — only when a Hypershift trigger is configured.
/// Returns a null handle when Hypershift is off or the install failed (the
/// trigger then simply stays inactive; capture keeps working, and the health
/// monitor retries the install on later cycles).
unsafe fn install_mouse_hook(
    hmod: windows_sys::Win32::Foundation::HMODULE,
) -> windows_sys::Win32::UI::WindowsAndMessaging::HHOOK {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowsHookExW, WH_MOUSE_LL};

    if !mouse_hook_wanted() {
        return std::ptr::null_mut();
    }
    let handle = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(helper_ll_mouse_proc), hmod, 0) };
    if handle.is_null() {
        log::warn!(
            "[capture-helper] SetWindowsHookExW(WH_MOUSE_LL) failed: {} — Hypershift trigger disabled.",
            std::io::Error::last_os_error()
        );
    } else {
        log::info!("[capture-helper] LL mouse hook installed (Hypershift trigger code {}).", HELPER_HYPER_TRIGGER.load(Ordering::Relaxed));
    }
    handle
}

/// Verdict of one health cycle for the mouse hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseHookHealth {
    /// Callback seen (or no evidence of trouble) — leave the hook alone.
    Alive,
    /// Nothing proves the hook is alive: spend a probe to find out.
    Probe,
    /// The hook must be dead: reinstall it.
    Dead,
}

/// Decides what the health monitor must do about the mouse hook.
///
/// `callback_seen` — the hook saw any mouse message this cycle (or the previous
/// probe was acknowledged); `cursor_moved` — the pointer crossed
/// [`MOUSE_HEALTH_MOVE_PX`] since the last cycle; `probe_pending` — a probe was
/// injected last cycle and not yet acknowledged; `held_cycles` — consecutive
/// cycles with the trigger held and no callback.
fn mouse_hook_health(
    callback_seen: bool,
    cursor_moved: bool,
    probe_pending: bool,
    held_cycles: u32,
) -> MouseHookHealth {
    if callback_seen {
        return MouseHookHealth::Alive;
    }
    if probe_pending {
        // A probe that was injected a full cycle ago and never came back.
        return MouseHookHealth::Dead;
    }
    if cursor_moved {
        // A live hook sees every move; silence while the pointer is moving is
        // proof that Windows removed it.
        return MouseHookHealth::Dead;
    }
    if held_cycles >= MOUSE_HEALTH_HELD_CYCLES {
        return MouseHookHealth::Probe;
    }
    MouseHookHealth::Alive
}

/// Current cursor position in screen coordinates, or `None` if the query failed.
fn current_cursor_pos() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) } != 0 {
        Some((point.x, point.y))
    } else {
        None
    }
}

/// Inject the mouse-hook liveness probe: a 1-px nudge that returns immediately.
///
/// A move is the only mouse event guaranteed to travel the LL hook chain, and a
/// 1-px round trip is invisible to the user. The probe carries
/// [`HOOK_PROBE_EXTRA_INFO`] (not [`crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO`])
/// so the hook can tell it apart; it stays a move, which the hook passes
/// through, so the tag can never be mistaken for a real button press.
/// Returns `false` when the OS refused the injection (UIPI, no input desktop),
/// in which case the cycle draws no conclusion.
unsafe fn inject_mouse_hook_probe() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE;

    let inputs: Vec<_> = [1, -1]
        .into_iter()
        .map(|dx| {
            let mut input = crate::input_synthesis::make_mouse_input(MOUSEEVENTF_MOVE, 0);
            input.Anonymous.mi.dx = dx;
            input.Anonymous.mi.dwExtraInfo = HOOK_PROBE_EXTRA_INFO;
            input
        })
        .collect();
    send_inputs(&inputs) > 0
}

/// Unhook the LL mouse hook and clear the held state, so a reinstall can never
/// leave the trigger stuck as "held".
unsafe fn unhook_mouse_hook(handle: &mut windows_sys::Win32::UI::WindowsAndMessaging::HHOOK) {
    unsafe {
        if !handle.is_null() {
            use windows_sys::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx;
            UnhookWindowsHookEx(*handle);
            *handle = std::ptr::null_mut();
        }
    }
    HELPER_HYPER_ACTIVE.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod mouse_hook_tests {
    use super::{
        HYPER_TRIGGER_LEFT, HYPER_TRIGGER_MIDDLE, HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_X1,
        HYPER_TRIGGER_X2, HelperRegistration, HyperMouseAction, MOUSE_HEALTH_HELD_CYCLES,
        MouseHookHealth, WheelAxis, hyper_mouse_action, mouse_button_code, mouse_hook_health,
        wheel_axis_for_control, wheel_capture_action, ButtonCapture, side_button_capture,
        side_button_code,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEHWHEEL, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
        WM_RBUTTONUP, WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON1, XBUTTON2,
    };

    /// One wheel tick, as the high word of `mouseData` carries it.
    fn tick(delta: i16) -> u32 {
        (delta as u16 as u32) << 16
    }

    fn wheel_reg(encoded_key: &str, axis: WheelAxis) -> HelperRegistration {
        HelperRegistration {
            encoded_key: encoded_key.into(),
            modifiers_mask: 0,
            primary_vk: 0,
            wheel: Some(axis),
            button: None,
        }
    }

    /// HyperShift 2: the profile's trigger goes down; the held one comes up
    /// even after a profile change turned the trigger off.
    #[test]
    fn hypershift2_trigger_holds_and_its_release_follows_the_held_button() {
        use super::{HYPER_TRIGGER_OFF, hypershift2_step};
        assert_eq!(hypershift2_step(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_OFF, HYPER_TRIGGER_RIGHT, true), Some(true));
        assert_eq!(hypershift2_step(HYPER_TRIGGER_OFF, HYPER_TRIGGER_OFF, HYPER_TRIGGER_RIGHT, true), None);
        assert_eq!(hypershift2_step(HYPER_TRIGGER_OFF, HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, false), Some(false));
        // A release without its press (held before the profile had it) is not ours.
        assert_eq!(hypershift2_step(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_OFF, HYPER_TRIGGER_RIGHT, false), None);
        // Its release was missed: the next press starts a fresh hold, never
        // passes through (its release would be swallowed — stuck down).
        assert_eq!(hypershift2_step(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, true), Some(true));
        assert_eq!(hypershift2_step(HYPER_TRIGGER_OFF, HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, true), Some(true));
        assert_eq!(hypershift2_step(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_LEFT, true), None);
    }

    /// Per profile, only a button the mouse reports natively, never the left
    /// one or the software trigger, and only for the mouse it names.
    #[test]
    fn hypershift2_codes_take_each_profiles_native_trigger() {
        use super::{HYPER_TRIGGER_OFF, hypershift2_codes};
        use crate::device_catalog::{NAGA_V2_HYPERSPEED, NAGA_V3_PRO};
        let mut config = crate::config::default_seed_config();
        let mut work = config.profiles[0].clone();
        work.id = "work".into();
        work.hypershift2_triggers = vec!["v3_mouse_right".into()];
        let mut game = work.clone();
        game.id = "game".into();
        game.hypershift2_triggers = Vec::new();
        let mut odd = work.clone();
        odd.id = "odd".into();
        odd.hypershift2_triggers = vec!["v3_mouse_left".into(), "mouse_right".into()];
        config.profiles = vec![work, game, odd];
        assert_eq!(hypershift2_codes(&config, &NAGA_V3_PRO, HYPER_TRIGGER_OFF), vec![("work".to_owned(), HYPER_TRIGGER_RIGHT)]);
        assert!(hypershift2_codes(&config, &NAGA_V3_PRO, HYPER_TRIGGER_RIGHT).is_empty());
        // The V2's right button is in its live map (firmware HyperShift).
        assert!(hypershift2_codes(&config, &NAGA_V2_HYPERSPEED, HYPER_TRIGGER_OFF).is_empty());
    }

    /// The trigger button is a pure modifier: swallowed, never clicked.
    #[test]
    fn trigger_press_and_release_only_toggle_the_held_state() {
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, true, false, false, false),
            HyperMouseAction::SetTriggerHeld(true),
        );
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, false, true, false, false),
            HyperMouseAction::SetTriggerHeld(false),
        );
    }

    /// Only the trigger and the left button are ever swallowed.
    #[test]
    fn other_buttons_always_pass_through() {
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_MIDDLE, true, true, false, false),
            HyperMouseAction::Pass,
        );
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_X1, true, true, false, false),
            HyperMouseAction::Pass,
        );
    }

    /// Synapse behaviour: trigger held + left click = right click.
    #[test]
    fn left_click_becomes_a_right_click_while_the_trigger_is_held() {
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_LEFT, true, true, false, false),
            HyperMouseAction::InjectRightDown,
        );
    }

    /// A left click without the trigger stays a left click.
    #[test]
    fn a_clicking_trigger_leaves_the_left_button_alone() {
        // `hypershiftTap`: the right button clicks itself on a quick press, so
        // the left one stays a left click (assignable on the layer).
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_LEFT, true, true, false, true),
            HyperMouseAction::Pass
        );
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, true, false, false, true),
            HyperMouseAction::SetTriggerHeld(true)
        );
    }

    #[test]
    fn left_click_passes_through_without_the_trigger() {
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_LEFT, true, false, false, false),
            HyperMouseAction::Pass,
        );
    }

    /// Left button as the trigger: the button *is* the modifier, so nothing to
    /// translate — and its own press must not click.
    #[test]
    fn left_trigger_never_translates_itself() {
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_LEFT, HYPER_TRIGGER_LEFT, true, true, false, false),
            HyperMouseAction::SetTriggerHeld(true),
        );
    }

    /// Releasing the trigger before the left button must still close the pair,
    /// or the application is left with a stuck right button.
    #[test]
    fn translated_click_stays_balanced_when_the_trigger_is_released_first() {
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_LEFT, true, true, false, false),
            HyperMouseAction::InjectRightDown,
        );
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_RIGHT, false, true, false, false),
            HyperMouseAction::SetTriggerHeld(false),
        );
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_LEFT, false, false, true, false),
            HyperMouseAction::InjectRightUp,
        );
    }

    /// An untranslated left-up must not inject a stray right-up.
    #[test]
    fn untranslated_left_up_passes_through() {
        assert_eq!(
            hyper_mouse_action(HYPER_TRIGGER_RIGHT, HYPER_TRIGGER_LEFT, false, true, false, false),
            HyperMouseAction::Pass,
        );
    }

    #[test]
    fn button_messages_map_to_the_trigger_codes() {
        assert_eq!(
            mouse_button_code(WM_RBUTTONDOWN, 0),
            Some((HYPER_TRIGGER_RIGHT, true))
        );
        assert_eq!(
            mouse_button_code(WM_RBUTTONUP, 0),
            Some((HYPER_TRIGGER_RIGHT, false))
        );
        assert_eq!(
            mouse_button_code(WM_LBUTTONDOWN, 0),
            Some((HYPER_TRIGGER_LEFT, true))
        );
        assert_eq!(
            mouse_button_code(WM_LBUTTONUP, 0),
            Some((HYPER_TRIGGER_LEFT, false))
        );
        // mouse 4 / mouse 5: the button lives in the high word of mouseData.
        assert_eq!(
            mouse_button_code(WM_XBUTTONDOWN, u32::from(XBUTTON1) << 16),
            Some((HYPER_TRIGGER_X1, true))
        );
        assert_eq!(
            mouse_button_code(WM_XBUTTONUP, u32::from(XBUTTON2) << 16),
            Some((HYPER_TRIGGER_X2, false))
        );
        assert_eq!(mouse_button_code(WM_MOUSEMOVE, 0), None);
    }

    /// Any callback proves the hook is installed.
    #[test]
    fn a_callback_means_the_mouse_hook_is_alive() {
        assert_eq!(
            mouse_hook_health(true, false, true, MOUSE_HEALTH_HELD_CYCLES),
            MouseHookHealth::Alive,
        );
    }

    /// The pointer moved and the hook stayed silent: Windows removed it.
    #[test]
    fn silence_while_the_pointer_moves_means_dead() {
        assert_eq!(mouse_hook_health(false, true, false, 0), MouseHookHealth::Dead,);
    }

    /// An unanswered probe condemns the hook even with a parked pointer.
    #[test]
    fn unanswered_probe_means_dead() {
        assert_eq!(mouse_hook_health(false, false, true, 0), MouseHookHealth::Dead,);
    }

    /// Holding the trigger with the mouse parked is legitimate for a while —
    /// the probe only goes out after the grace cycles.
    #[test]
    fn parked_pointer_probes_only_after_the_grace_cycles() {
        assert_eq!(
            mouse_hook_health(false, false, false, 1),
            MouseHookHealth::Alive,
        );
        assert_eq!(
            mouse_hook_health(false, false, false, MOUSE_HEALTH_HELD_CYCLES),
            MouseHookHealth::Probe,
        );
    }

    /// The firmware never turns a scroll tick into a keystroke, so the hook has
    /// to emit the hypershift-layer encoding itself.
    #[test]
    fn wheel_tick_emits_the_hypershift_encoding_while_the_trigger_is_held() {
        let regs = vec![
            wheel_reg("Ctrl+Alt+F16", WheelAxis::Up),
            wheel_reg("Ctrl+Alt+F17", WheelAxis::Down),
        ];
        assert_eq!(
            wheel_capture_action(&regs, WM_MOUSEWHEEL, tick(120), true).as_deref(),
            Some("Ctrl+Alt+F16"),
        );
        assert_eq!(
            wheel_capture_action(&regs, WM_MOUSEWHEEL, tick(-120), true).as_deref(),
            Some("Ctrl+Alt+F17"),
        );
    }

    /// Without the trigger the wheel must stay native scrolling.
    #[test]
    fn wheel_tick_passes_through_without_the_trigger() {
        let regs = vec![wheel_reg("Ctrl+Alt+F16", WheelAxis::Up)];
        assert_eq!(
            wheel_capture_action(&regs, WM_MOUSEWHEEL, tick(120), false),
            None,
        );
    }

    /// A direction the user never bound must keep scrolling, and a message that
    /// is not a wheel tick (or carries a zero delta) is never captured.
    #[test]
    fn unbound_wheel_direction_is_left_to_the_os() {
        let regs = vec![wheel_reg("Ctrl+Alt+F16", WheelAxis::Up)];
        assert_eq!(
            wheel_capture_action(&regs, WM_MOUSEWHEEL, tick(-120), true),
            None,
        );
        assert_eq!(
            wheel_capture_action(&regs, WM_MOUSEHWHEEL, tick(120), true),
            None,
        );
        assert_eq!(wheel_capture_action(&regs, WM_MOUSEMOVE, 0, true), None);
        assert_eq!(
            wheel_capture_action(&regs, WM_MOUSEWHEEL, tick(0), true),
            None,
        );
    }

    /// The tilt wheel maps on its own axis (right = away, left = toward).
    #[test]
    fn horizontal_wheel_uses_the_tilt_axis() {
        let regs = vec![
            wheel_reg("Shift+Alt+F16", WheelAxis::Right),
            wheel_reg("Shift+Alt+F17", WheelAxis::Left),
        ];
        assert_eq!(
            wheel_capture_action(&regs, WM_MOUSEHWHEEL, tick(120), true).as_deref(),
            Some("Shift+Alt+F16"),
        );
        assert_eq!(
            wheel_capture_action(&regs, WM_MOUSEHWHEEL, tick(-120), true).as_deref(),
            Some("Shift+Alt+F17"),
        );
    }

    fn side_reg(encoded_key: &str, code: u8, hypershift: bool) -> HelperRegistration {
        HelperRegistration {
            encoded_key: encoded_key.into(),
            modifiers_mask: 0,
            primary_vk: 0,
            wheel: None,
            button: Some(ButtonCapture { code, hypershift }),
        }
    }

    /// Side buttons fire their layer's binding; an unbound one stays native.
    #[test]
    fn side_button_emits_the_layer_in_effect() {
        let regs = vec![
            side_reg("Alt+F13", HYPER_TRIGGER_X1, false),
            side_reg("Ctrl+Alt+F13", HYPER_TRIGGER_X1, true),
            side_reg("Alt+F14", HYPER_TRIGGER_X2, false),
        ];
        assert_eq!(side_button_capture(&regs, HYPER_TRIGGER_X1, false).as_deref(), Some("Alt+F13"));
        assert_eq!(
            side_button_capture(&regs, HYPER_TRIGGER_X1, true).as_deref(),
            Some("HS:Ctrl+Alt+F13")
        );
        // No hypershift binding: the stamped standard encoding lets the
        // resolver fall back to the standard binding.
        assert_eq!(side_button_capture(&regs, HYPER_TRIGGER_X2, true).as_deref(), Some("HS:Alt+F14"));
        assert_eq!(side_button_capture(&regs[..1], HYPER_TRIGGER_X2, false), None, "unbound stays native");
        assert_eq!(side_button_code("mouse_4"), Some(HYPER_TRIGGER_X1));
        assert_eq!(side_button_code("mouse_5"), Some(HYPER_TRIGGER_X2));
        assert_eq!(side_button_code("thumb_01"), None);
    }

    #[test]
    fn wheel_controls_map_to_their_axis() {
        assert_eq!(wheel_axis_for_control("wheel_up"), Some(WheelAxis::Up));
        assert_eq!(wheel_axis_for_control("wheel_down"), Some(WheelAxis::Down));
        assert_eq!(wheel_axis_for_control("wheel_left"), Some(WheelAxis::Left));
        assert_eq!(wheel_axis_for_control("wheel_right"), Some(WheelAxis::Right));
        assert_eq!(wheel_axis_for_control("wheel_click"), None);
        assert_eq!(wheel_axis_for_control("thumb_01"), None);
        // Whitespace in a user-edited config must not defeat the match.
        assert_eq!(wheel_axis_for_control(" wheel_up "), Some(WheelAxis::Up));
    }
}

/// LL keyboard hook callback for the capture helper process.
/// Matches modifier+F-key combos and buffers the encoded key in HELPER_MATCHES.
unsafe extern "system" fn helper_ll_keyboard_proc(code: i32, w_param: usize, l_param: isize) -> isize {
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CallNextHookEx, KBDLLHOOKSTRUCT,
        };

        // A panic unwinding across this `extern "system"` boundary is UB. Contain any
        // panic in the hook body (RefCell borrows, allocation, FFI) and fall through
        // to CallNextHookEx (don't suppress) instead of unwinding. The closure does
        // not inherit the `unsafe fn` context; under edition 2024 each unsafe op inside
        // it carries its own `unsafe {}` block, so the scope below is a plain block.
        let should_suppress = if code >= 0 {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || -> bool {
            {
        // Record that the hook callback fired — the health monitor uses this
        // to skip unnecessary SendInput probes when the hook is clearly alive.
        HOOK_HAD_CALLBACK.with(|cell| cell.set(true));

        let kb = &*(l_param as *const KBDLLHOOKSTRUCT);
        let msg = w_param as u32;
        let vk = kb.vkCode;
        // Probe event from the health monitor — acknowledge and pass through.
        // `return false` (passthrough) is intentional: VK 0xE8 is an unassigned
        // key with no symbol/action in virtually every application (the same key
        // AutoHotkey uses as a mask), and the probe only fires after 5 s of zero
        // hook activity, so delivering it to the focused window is harmless. We
        // deliberately do NOT suppress it. See finding F033 (Low/defensive).
        if kb.dwExtraInfo == HOOK_PROBE_EXTRA_INFO {
            HELPER_PROBE_RECEIVED.with(|cell| cell.set(true));
            return false;
        }

        let internal_injection =
            kb.dwExtraInfo == crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO;

        // Diagnostic: emit DEBUG lines for modifier and F-key events with raw
        // KBDLLHOOKSTRUCT fields. Used to measure Razer Alt→F-key gap and
        // leak window between Razer Alt-down and our SendInput Alt-up.
        // Logged BEFORE the internal_injection bypass so we capture our own
        // SendInput too — marked with prefix `int-` for distinction.
        let is_modifier = is_modifier_vk(vk as u16);
        let is_fkey = (0x70..=0x87).contains(&vk);
        let is_keydown = msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_KEYDOWN
            || msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_SYSKEYDOWN;
        let is_keyup = msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_KEYUP
            || msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_SYSKEYUP;
        if (is_keydown || is_keyup) && debug_capture_enabled() {
            let prefix = if internal_injection { "int-" } else { "" };
            let kind = if is_modifier {
                if is_keydown { "mod-down" } else { "mod-up" }
            } else if is_fkey {
                if is_keydown { "fkey-down" } else { "fkey-up" }
            } else if is_keydown {
                "key-down"
            } else {
                "key-up"
            };
            HELPER_MATCHES.with(|cell| {
                cell.borrow_mut().push(format!(
                    "DEBUG:{}{} vk=0x{:02X} scan=0x{:02X} flags=0x{:02X} extra=0x{:X} time={}",
                    prefix, kind, vk, kb.scanCode, kb.flags, kb.dwExtraInfo, kb.time,
                ));
            });
        }

        if internal_injection {
            // For our own injections, only log (above) — skip state update and
            // let the event pass through to the OS.
            // Wake the message pump so the DEBUG line flushes promptly to parent.
            wake_helper_loop();
            return false;
        }

        // Returns (suppress_key, new_match_added, inject_mask_key)
        let (mut suppress, mut wake, inject_mask) = HELPER_MODIFIERS.with(|mods_cell| {
            HELPER_SUPPRESSIONS.with(|sup_cell| {
                HELPER_REGISTRATIONS.with(|reg_cell| {
                    HELPER_MATCHES.with(|match_cell| {
                        let regs = reg_cell.borrow();
                        let mut modifiers = mods_cell.borrow_mut();
                        let mut suppressions = sup_cell.borrow_mut();
                        let mut matches = match_cell.borrow_mut();

                        process_helper_key_event(
                            &regs,
                            &mut modifiers,
                            &mut suppressions,
                            &mut matches,
                            vk,
                            msg,
                        )
                    })
                })
            })
        });

        // --- Modifier buffering (delayed modifier / chord detection) ---
        //
        // Razer Naga sends modifier+F-key combos as real keyboard events.
        // The modifier-down arrives first and leaks to apps before the F-key
        // tells us this is a Razer encoding.  We buffer modifier-downs for
        // up to 20ms; if an F-key match arrives in time we consume them,
        // otherwise we replay them via SendInput.

        // KBDLLHOOKSTRUCT flag bit set when the event was synthesized by a
        // SendInput call (any process).  Per Win32 docs: LLKHF_INJECTED = 0x10.
        // Razer firmware emits real hardware events (flags=0x00), not software
        // injects.  INTERNAL_SENDINPUT_EXTRA_INFO events are already
        // short-circuited above before reaching this block.
        const LLKHF_INJECTED: u32 = 0x10;
        let externally_injected = (kb.flags & LLKHF_INJECTED) != 0;

        // Factory-defaults detection: watch digit-row keydowns (real and
        // externally-injected) for the Razer "real press + injected duplicate"
        // signature. Independent of registration matching — digit keys are
        // never registered, so this is their only observation point.
        if is_keydown {
            let defaults_alert = HELPER_DEFAULTS_DETECTOR.with(|cell| {
                cell.borrow_mut()
                    .observe_keydown(vk, kb.scanCode, externally_injected, kb.time)
            });
            if defaults_alert {
                HELPER_MATCHES.with(|cell| {
                    cell.borrow_mut()
                        .push(HELPER_ALERT_FACTORY_DEFAULTS.to_string())
                });
                wake = true;
            }
        }

        // A real modifier-down arrives while we may have prior state for
        // this VK.  Three paths:
        //
        //  1. REPLAYED_AWAITING_UP[vk] non-stale → user is still holding
        //     a modifier we already proxied into the OS via SendInput.
        //     This event is a driver/firmware auto-repeat of the held key.
        //     Suppress to prevent buffer→flush→inject cycle accumulation
        //     (root cause of stuck-Ctrl during held Ctrl+arrow word-jump:
        //     each repeat generated +1 unbalanced injected key-down).
        //     Refresh the tracker timestamp so orphan-GC defers while the
        //     user keeps holding.
        //
        //  2. REPLAYED stale/absent → fresh user press (or the prior
        //     replay's real-up was lost via alt-tab/RDP/focus change
        //     before orphan-GC fired).  Standard CONSUMED + REPLAYED
        //     fresh-down clearing path; subsequent buffer/flush handles
        //     the new press.
        //
        //  3. Re-entrancy: this callback may run inside
        //     `flush_expired_pending_modifiers`'s SendInput synchronous
        //     hook chain delivery.  In that case `FLUSHING_REPLAYED` is
        //     true and clearing the just-inserted REPLAYED entry would
        //     leave the in-flight injected key-down unbalanced — skip
        //     the remove (the entry is fresh by construction).
        if is_modifier && is_keydown {
            let now = std::time::Instant::now();
            let threshold = REPLAYED_AWAITING_UP_THRESHOLD.with(|c| c.get());
            let suppress_repeat = REPLAYED_AWAITING_UP.with(|cell| {
                should_suppress_repeat_modifier_down(
                    vk,
                    externally_injected,
                    &cell.borrow(),
                    now,
                    threshold,
                )
            });
            if suppress_repeat {
                REPLAYED_AWAITING_UP.with(|cell| {
                    cell.borrow_mut().insert(vk, now);
                });
                HELPER_MATCHES.with(|cell| {
                    cell.borrow_mut().push(format!(
                        "DEBUG:mod-passthrough-suppressed-repeat vk=0x{:02X}",
                        vk,
                    ));
                });
                suppress = true;
                wake = true;
            } else {
                let cleared_consumed = CONSUMED_MODIFIER_VKS.with(|cell| {
                    cell.borrow_mut().remove(&vk).is_some()
                });
                if cleared_consumed {
                    HELPER_MATCHES.with(|cell| {
                        cell.borrow_mut().push(format!(
                            "DEBUG:consumed-stale-cleared vk=0x{:02X}",
                            vk,
                        ));
                    });
                }
                let flushing = FLUSHING_REPLAYED.with(|cell| cell.get());
                if flushing {
                    HELPER_MATCHES.with(|cell| {
                        cell.borrow_mut().push(format!(
                            "DEBUG:mod-replayed-clear-skipped vk=0x{:02X} \
                             reason=re-entrant-during-flush",
                            vk,
                        ));
                    });
                } else {
                    let cleared_replayed = REPLAYED_AWAITING_UP.with(|cell| {
                        cell.borrow_mut().remove(&vk).is_some()
                    });
                    if cleared_replayed {
                        HELPER_MATCHES.with(|cell| {
                            cell.borrow_mut().push(format!(
                                "DEBUG:mod-replayed-cleared vk=0x{:02X} \
                                 reason=fresh-down",
                                vk,
                            ));
                        });
                    }
                }
            }
        }

        // Case A: Modifier-down that should be buffered.
        // process_helper_key_event already updated HELPER_MODIFIERS state,
        // so F-key matching will work correctly when the F-key arrives.
        //
        // SKIP buffering for externally-injected events.  Buffering INJECTED
        // Ctrl/Shift/Alt from e.g. Windows clipboard popup, AHK scripts, RDP
        // forwards, or speech-recog tools desyncs the modifier+key timing
        // across the LL-hook→OS-queue boundary — the modifier reaches the
        // focused app late, and a following V (Ctrl+V paste) lands without
        // Ctrl held.  Their flow: direct passthrough is correct (no Razer
        // encoding to detect).
        if is_modifier && is_keydown && !suppress && !externally_injected {
            let should_buffer = HELPER_REGISTRATIONS.with(|reg_cell| {
                let regs = reg_cell.borrow();
                modifier_in_any_encoding(vk, &regs)
            });
            if should_buffer {
                PENDING_MODIFIERS.with(|cell| {
                    cell.borrow_mut().push(PendingModifier {
                        vk,
                        scan: kb.scanCode,
                        buffered_at: std::time::Instant::now(),
                    });
                });
                HELPER_MATCHES.with(|cell| {
                    cell.borrow_mut().push(format!(
                        "DEBUG:mod-buffered vk=0x{:02X}",
                        vk,
                    ));
                });
                suppress = true;
                wake = true;
            }
        } else if is_modifier && is_keydown && externally_injected {
            HELPER_MATCHES.with(|cell| {
                cell.borrow_mut().push(format!(
                    "DEBUG:mod-passthrough-injected vk=0x{:02X} reason=external-injection",
                    vk,
                ));
            });
        }

        // Case B+D: F-key matched OR non-modifier key-down while modifiers
        // are pending.  Decide per-modifier: consume (Razer encoding) or
        // replay (real keyboard).
        if is_keydown && !is_modifier {
            // Find the matched encoding's modifier mask (0 if not matched / not F-key)
            let matched_mask = if suppress && is_fkey {
                HELPER_SUPPRESSIONS.with(|sup_cell| {
                    HELPER_REGISTRATIONS.with(|reg_cell| {
                        let sup = sup_cell.borrow();
                        let regs = reg_cell.borrow();
                        sup.get(&vk)
                            .and_then(|ek| regs.iter().find(|r| r.encoded_key == *ek))
                            .map(|r| r.modifiers_mask)
                            .unwrap_or(0)
                    })
                })
            } else {
                0 // non-F-key or unmatched F-key → no encoding modifiers
            };

            // Drain pending modifiers: consume those that are (a) in the
            // encoding mask AND (b) were buffered within the Razer chord
            // window.  Replay the rest — they're either a different modifier
            // the user happened to press, or the user's physical modifier
            // that was buffered long before this F-key.
            // Collect first, then process — avoids holding RefCell borrow
            // during SendInput (which triggers re-entrant LL hook callback).
            let items: Vec<PendingModifier> = PENDING_MODIFIERS.with(|cell| {
                cell.borrow_mut().drain(..).collect()
            });
            if !items.is_empty() {
                let mut consumed_vks = Vec::new();
                let mut replayed_vks = Vec::new();
                let now = std::time::Instant::now();
                for pm in &items {
                    let mask_bit = modifier_mask_bit(pm.vk);
                    let in_encoding = matched_mask & mask_bit != 0;
                    let recent = now.duration_since(pm.buffered_at)
                        < RAZER_ENCODING_CHORD_WINDOW;
                    if in_encoding && recent {
                        // Razer encoding → consume (suppress its key-up too).
                        CONSUMED_MODIFIER_VKS.with(|cell| {
                            cell.borrow_mut().insert(pm.vk, now);
                        });
                        consumed_vks.push(pm.vk);
                    } else {
                        // Not in encoding, or older than Razer chord window
                        // (→ user's physical modifier).  Replay so the OS
                        // sees the key-down we buffered away.
                        //
                        // Track in REPLAYED_AWAITING_UP BEFORE SendInput so a
                        // re-entrant callback for the matching real-up (or
                        // any other lifecycle event during the synchronous
                        // SendInput hook chain) can find and remove it.
                        REPLAYED_AWAITING_UP.with(|cell| {
                            cell.borrow_mut().insert(pm.vk, now);
                        });
                        replay_modifier_down(pm.vk, pm.scan);
                        replayed_vks.push(pm.vk);
                    }
                }
                HELPER_MATCHES.with(|mc| {
                    let mut buf = mc.borrow_mut();
                    buf.push(format!(
                        "DEBUG:mod-resolve mask=0x{:04X} consumed={consumed_vks:?} replayed={replayed_vks:?}",
                        matched_mask,
                    ));
                    for vk in &replayed_vks {
                        buf.push(format!(
                            "DEBUG:mod-replayed-tracked vk=0x{:02X} reason=non-encoding",
                            vk,
                        ));
                    }
                });
                wake = true;
            }
        }

        // Case C: Modifier-up — check consumed, pending, and replayed sets.
        if is_modifier && is_keyup {
            // C0: Was this modifier replayed earlier (injected key-down via
            // SendInput because pending-buffer timed out, or because the
            // F-key didn't match the encoding mask)?  If so, the real up is
            // the expected balancing event — remove the tracker and let the
            // up flow through to the OS (do NOT suppress).
            let replayed_cleared = REPLAYED_AWAITING_UP.with(|cell| {
                cell.borrow_mut().remove(&vk).is_some()
            });
            if replayed_cleared {
                HELPER_MATCHES.with(|cell| {
                    cell.borrow_mut().push(format!(
                        "DEBUG:mod-replayed-cleared vk=0x{:02X} reason=real-up",
                        vk,
                    ));
                });
            }

            // C1: Was this modifier consumed by an F-key match?
            // If so, suppress the up event too — but only if the entry is
            // still FRESH.  A stale consumed entry (>200ms) means Razer's
            // own encoding-up was dropped; the up we see now is the user's
            // real modifier and must flow through to the OS, otherwise the
            // stuck-Ctrl symptom appears.
            let consumed_age = CONSUMED_MODIFIER_VKS.with(|cell| {
                cell.borrow_mut()
                    .remove(&vk)
                    .map(|inserted_at| std::time::Instant::now().duration_since(inserted_at))
            });
            if let Some(age) = consumed_age {
                if age < CONSUMED_MODIFIER_FRESHNESS_WINDOW {
                    HELPER_MATCHES.with(|cell| {
                        cell.borrow_mut().push(format!(
                            "DEBUG:mod-up-suppressed vk=0x{:02X}",
                            vk,
                        ));
                    });
                    suppress = true;
                    wake = true;
                } else {
                    HELPER_MATCHES.with(|cell| {
                        cell.borrow_mut().push(format!(
                            "DEBUG:consumed-stale-passthrough vk=0x{:02X} age_ms={}",
                            vk,
                            age.as_millis(),
                        ));
                    });
                    wake = true;
                }
            } else {
                // C2: Was this modifier still pending (buffered but F-key never came)?
                // This is a solo modifier tap.  We replay the entire tap
                // (down+up) and SUPPRESS the user's real up event.
                //
                // Why not just replay-down + let real up pass through:
                // SendInput queues the down at the END of the OS input
                // queue, but the current real up event continues through
                // the hook chain immediately.  The OS would then process:
                // up first (no-op, key wasn't down at OS level), then down
                // (key now stuck pressed).  This was the "tap Ctrl in
                // terminal → Ctrl stays held until I press Ctrl again" bug.
                let pending_entry = PENDING_MODIFIERS.with(|cell| {
                    let mut pending = cell.borrow_mut();
                    pending.iter().position(|pm| pm.vk == vk).map(|pos| pending.remove(pos))
                });
                if let Some(pm) = pending_entry {
                    HELPER_MATCHES.with(|cell| {
                        cell.borrow_mut().push(format!(
                            "DEBUG:mod-replay solo-tap vk=0x{:02X}",
                            vk,
                        ));
                    });
                    replay_modifier_tap(pm.vk, pm.scan);
                    // Suppress the real up — replay_modifier_tap already
                    // emitted both down and up in the correct order.
                    suppress = true;
                    wake = true;
                }
            }
        }

        // --- End modifier buffering ---

        // AHK-style "Menu Mask Key": inject VK 0xE8 (down+up) to prevent
        // Windows from interpreting bare Alt-up or Win-up as menu / Start
        // activation.  The injected events carry INTERNAL_SENDINPUT_EXTRA_INFO
        // so our own hook passes them straight through — the 2 re-entrant
        // hook calls cost microseconds, well within LowLevelHooksTimeout.
        if inject_mask {
            inject_mask_key();
        }

        // Post a wake-up message so GetMessageW returns and drain_helper_matches
        // can flush the buffered match to stdout. LL hook callbacks are dispatched
        // via sent-message delivery during GetMessageW, which does NOT cause
        // GetMessageW to return on its own.
        if wake {
            wake_helper_loop();
        }

        if suppress {
            return true;
        }
        // Natural end of the hook body — pass the key through (don't suppress).
        false
            }
        }))
        .unwrap_or(false)
        } else {
            false
        };

        if should_suppress {
            return 1;
        }
        CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param)
    }
}

/// The line a stop writes to the helper before closing its stdin.
const HELPER_EXIT: &str = "EXIT";

/// Entry point for the `--capture-helper` child process.
/// Reads modifier-combo registrations from stdin (one JSON line),
/// installs WH_KEYBOARD_LL, and writes matched encoded keys to stdout.
/// Exits when stdin is closed (parent process stopped).
pub fn capture_helper_main() {
    // Initialize a stderr logger for the helper subprocess (no Tauri runtime here).
    env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .target(env_logger::Target::Stderr)
        .init();

    use std::io::BufRead;
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        Foundation::{WAIT_FAILED, WAIT_TIMEOUT},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::WindowsAndMessaging::{
            DispatchMessageW, MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE,
            PeekMessageW, PostThreadMessageW, QS_ALLINPUT, SetWindowsHookExW, TranslateMessage,
            UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_QUIT,
        },
    };

    // 1. Read registrations from stdin (one JSON line).
    // Accepts either a bare array (legacy protocol) or a wrapper object
    // `{registrations: [...], modifierStaleGcMs: <u64>}`.
    let stdin = std::io::stdin();
    let mut line = String::new();
    if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 {
        log::warn!("[capture-helper] No input received on stdin, exiting.");
        return;
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HelperInit {
        registrations: Vec<HelperRegistration>,
        #[serde(default)]
        modifier_stale_gc_ms: Option<u64>,
        #[serde(default)]
        replayed_modifier_force_release_ms: Option<u64>,
        /// `Settings.hypershift_trigger` (a control id). Absent = Hypershift off.
        #[serde(default)]
        hypershift_trigger: Option<String>,
        #[serde(default)]
        hypershift_tap: bool,
        /// Catalog index of the mouse a HyperShift 2 trigger belongs to; the
        /// trigger itself follows the profile (`HS2:<code>` commands).
        #[serde(default)]
        hypershift2_model: Option<usize>,
        /// Key buttons read from the mouse's consumer collection. Empty = the
        /// mouse sends `F13`..`F24`, which the keyboard hook catches.
        #[serde(default)]
        readers: Vec<ReaderInit>,
        #[serde(default)]
        firmware_hypershift: bool,
        /// Sidearm's config folder: when Sidearm dies without stopping the
        /// helper, the live maps it left are restored from there.
        #[serde(default)]
        config_dir: Option<std::path::PathBuf>,
    }

    let init: HelperInit = match serde_json::from_str::<HelperInit>(line.trim()) {
        Ok(init) => init,
        Err(_) => {
            // Fallback: legacy bare-array payload.
            match serde_json::from_str::<Vec<HelperRegistration>>(line.trim()) {
                Ok(regs) => HelperInit {
                    registrations: regs,
                    modifier_stale_gc_ms: None,
                    replayed_modifier_force_release_ms: None,
                    hypershift_trigger: None,
                    hypershift_tap: false,
                    hypershift2_model: None,
                    readers: Vec::new(),
                    firmware_hypershift: false,
                    config_dir: None,
                },
                Err(e) => {
                    log::error!("[capture-helper] Failed to parse init payload: {e}");
                    return;
                }
            }
        }
    };

    let HelperInit {
        registrations,
        modifier_stale_gc_ms,
        replayed_modifier_force_release_ms,
        hypershift_trigger,
        hypershift_tap,
        hypershift2_model,
        readers,
        firmware_hypershift,
        config_dir,
    } = init;
    HELPER_HYPER_TAP.store(hypershift_tap, Ordering::Relaxed);

    // Software Hypershift: resolved to a wire code once here, then read by both
    // hooks (keyboard stamps the layer, mouse swallows/translates the buttons).
    // A test run against virtual mice must not take the real mouse's buttons.
    HELPER_HYPER_TRIGGER.store(
        hypershift_trigger
            .filter(|_| !firmware_hypershift && !crate::fake_mode())
            .as_deref()
            .map(hypershift_trigger_code)
            .unwrap_or(HYPER_TRIGGER_OFF),
        Ordering::Relaxed,
    );
    HELPER_HYPER2_ENABLED.store(hypershift2_model.is_some() && !crate::fake_mode(), Ordering::Relaxed);

    if let Some(ms) = modifier_stale_gc_ms {
        let clamped = ms.clamp(500, 30_000);
        CONSUMED_MODIFIER_STALE_THRESHOLD.with(|c| {
            c.set(std::time::Duration::from_millis(clamped));
        });
        log::info!("[capture-helper] CONSUMED stale threshold set to {clamped} ms.");
    }

    if let Some(ms) = replayed_modifier_force_release_ms {
        let clamped = ms.clamp(1_000, 60_000);
        REPLAYED_AWAITING_UP_THRESHOLD.with(|c| {
            c.set(std::time::Duration::from_millis(clamped));
        });
        log::info!("[capture-helper] REPLAYED awaiting-up threshold set to {clamped} ms.");
    }

    if registrations.is_empty() && readers.is_empty() {
        log::warn!("[capture-helper] No input mappings, exiting.");
        return;
    }

    log::info!(
        "[capture-helper] Loaded {} modifier-combo registrations.",
        registrations.len()
    );

    // 2. Initialize thread-local state for the LL hook callback
    HELPER_CAPTURES_SIDE_BUTTONS.store(
        !crate::fake_mode() && registrations.iter().any(|reg| reg.button.is_some()),
        Ordering::Relaxed,
    );
    HELPER_REGISTRATIONS.with(|cell| *cell.borrow_mut() = registrations);
    for reader in readers {
        let Some(model) = crate::device_catalog::CATALOG.get(reader.model) else { continue };
        log::info!("[capture-helper] {}: {} button signals read from the mouse.", model.name, reader.signals.len());
        // A firmware layer arrives in the signal itself; the onboard path's
        // layer is the software trigger's state.
        let hyper: fn() -> bool = if reader.software_layer { hyper_active_and_used } else { || false };
        let stamp2: fn(&[String]) -> bool =
            if hypershift2_model == Some(reader.model) { hyper2_stamp } else { |_| false };
        super::consumer::spawn_reader(reader.signals, model, hyper, stamp2, true);
    }
    HELPER_MODIFIERS.with(|cell| *cell.borrow_mut() = HelperModifierState::default());
    HELPER_SUPPRESSIONS.with(|cell| cell.borrow_mut().clear());
    HELPER_MATCHES.with(|cell| cell.borrow_mut().clear());
    PENDING_MODIFIERS.with(|cell| cell.borrow_mut().clear());
    CONSUMED_MODIFIER_VKS.with(|cell| cell.borrow_mut().clear());
    REPLAYED_AWAITING_UP.with(|cell| cell.borrow_mut().clear());

    // 2b. Elevate thread priority — LL hook callbacks must return within the
    //     LowLevelHooksTimeout (~200-300ms) or Windows silently removes the
    //     hook.  TIME_CRITICAL (priority 15) ensures our thread gets CPU time
    //     even under heavy load.  Pattern from AutoHotkey v2 (hook.cpp:4004).
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
    log::info!("[capture-helper] Thread priority set to TIME_CRITICAL.");

    // 3. Install WH_KEYBOARD_LL hook
    let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(helper_ll_keyboard_proc), hmod, 0) };
    if hook.is_null() {
        log::error!(
            "[capture-helper] SetWindowsHookExW failed: {}",
            std::io::Error::last_os_error()
        );
        return;
    }
    log::info!("[capture-helper] LL keyboard hook installed successfully.");

    // 3b. Install WH_MOUSE_LL when a Hypershift trigger is configured — it owns
    //     the trigger button's suppression and the LMB→RMB translation.  The
    //     injector thread must exist first: the hook callback only *queues* the
    //     right-click (injecting from inside the callback stalls input for a full
    //     LowLevelHooksTimeout — see HYPER_INJECT_TX).
    start_hyper_injector();
    let mut mouse_hook = unsafe { install_mouse_hook(hmod) };

    // 4. Spawn stdin watcher — reads commands from parent.
    //    "REHOOK" → reinstall LL hook (WM_APP + 1)
    //    stdin close → exit (WM_QUIT)
    const WM_REHOOK: u32 = 0x8000 + 1; // WM_APP + 1
    let hook_tid = unsafe { GetCurrentThreadId() };
    HELPER_THREAD_ID.with(|cell| cell.set(hook_tid));
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = String::new();
        let mut exit_requested = false;
        loop {
            buf.clear();
            match stdin.lock().read_line(&mut buf) {
                Ok(0) | Err(_) => {
                    // A stop sends HELPER_EXIT first; stdin closing without it
                    // is Sidearm's death. A hook-free process restores the maps
                    // (and makes sure Sidearm is really gone), so this one exits
                    // at once and releases its hooks.
                    if !exit_requested && let Some(dir) = &config_dir {
                        crate::spawn_live_map_restore(dir, true);
                    }
                    log::info!("[capture-helper] stdin closed, posting WM_QUIT.");
                    unsafe {
                        PostThreadMessageW(hook_tid, WM_QUIT, 0, 0);
                    }
                    break;
                }
                Ok(_) => {
                    let cmd = buf.trim();
                    if cmd == HELPER_EXIT {
                        exit_requested = true;
                    } else if let Some(code) = cmd.strip_prefix(HYPER2_COMMAND) {
                        let code = code.parse().ok().filter(|code| HYPER2_CODES.contains(code)).unwrap_or(HYPER_TRIGGER_OFF);
                        if HELPER_HYPER2_ENABLED.load(Ordering::Relaxed) {
                            HELPER_HYPER2_TRIGGER.store(code, Ordering::Relaxed);
                        }
                    } else if cmd == "REHOOK" {
                        log::info!("[capture-helper] REHOOK command received.");
                        unsafe {
                            PostThreadMessageW(hook_tid, WM_REHOOK, 0, 0);
                        }
                    } else {
                        log::warn!("[capture-helper] Unknown command: {cmd:?}");
                    }
                }
            }
        }
    });

    // 5. Message pump — drives the LL hook callbacks.
    //    Uses MsgWaitForMultipleObjectsEx instead of GetMessageW so we get a
    //    periodic timeout for hook health monitoring.  Windows silently removes
    //    WH_KEYBOARD_LL hooks when the callback exceeds LowLevelHooksTimeout
    //    (~200-300 ms) and provides NO notification, so we must self-test.
    // Locked per drain, not for the helper's life: the consumer reader thread
    // writes its lines to the same pipe.
    let stdout = std::io::stdout();
    let mut msg = MaybeUninit::<MSG>::zeroed();
    let mut hook = hook; // make mutable for reinstallation
    let mut probe_sent = false;
    let mut consecutive_probe_failures: u32 = 0;
    let mut hook_reinstall_count: u32 = 0;
    // Mouse-hook health (see `mouse_hook_health`): the mouse hook can be dropped
    // by Windows without affecting the keyboard hook, so it gets its own state.
    let mut mouse_probe_sent = false;
    let mut mouse_probe_failures: u32 = 0;
    let mut mouse_held_cycles: u32 = 0;
    let mut mouse_reinstall_count: u32 = 0;
    let mut last_mouse_pos = current_cursor_pos();

    // Every exit below leaves the process: an inner `break` alone would keep a
    // hookless helper alive until the parent kills it (5 s on every stop).
    'pump: loop {
        // Compute wait timeout: if we have pending modifiers, wake up in
        // time to replay them (20ms buffer).  Otherwise use the normal
        // health check interval.
        let wait_timeout = PENDING_MODIFIERS.with(|cell| {
            let pending = cell.borrow();
            if pending.is_empty() {
                HOOK_HEALTH_CHECK_INTERVAL_MS
            } else {
                let oldest = pending.iter().map(|pm| pm.buffered_at).min().unwrap();
                let elapsed = std::time::Instant::now().duration_since(oldest).as_millis() as u32;
                let remaining = 20u32.saturating_sub(elapsed);
                remaining.max(1) // at least 1ms to avoid busy-wait
            }
        });

        // Wait for messages OR timeout (health check / modifier replay).
        let wait_result = unsafe {
            MsgWaitForMultipleObjectsEx(
                0,
                std::ptr::null(),
                wait_timeout,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            )
        };

        if wait_result == WAIT_FAILED {
            log::warn!(
                "[capture-helper] MsgWaitForMultipleObjectsEx failed: {}",
                std::io::Error::last_os_error()
            );
            // Continue the loop — next iteration will retry.
            continue;
        }

        if wait_result == WAIT_TIMEOUT {
            // Timeout fired — could be for modifier replay (20ms) or health
            // check (5000ms).  Only run health check logic when the timeout
            // was the full health check interval (no pending modifiers).
            let was_health_timeout = wait_timeout == HOOK_HEALTH_CHECK_INTERVAL_MS;

            if was_health_timeout {
                // No messages arrived within the interval — run health check.

                // Fast path: if ANY LL hook callback fired since the last check,
                // the hook is demonstrably alive — no probe needed.
                let had_callback = HOOK_HAD_CALLBACK.with(|cell| cell.replace(false));
                if had_callback {
                    probe_sent = false;
                    consecutive_probe_failures = 0;
                } else if probe_sent {
                    // We sent a probe last cycle.  Check if the hook saw it.
                    let received = HELPER_PROBE_RECEIVED.with(|cell| cell.replace(false));
                    if received {
                        // Hook is alive.
                        probe_sent = false;
                        consecutive_probe_failures = 0;
                    } else {
                        consecutive_probe_failures += 1;
                        if consecutive_probe_failures >= HOOK_PROBE_FAIL_THRESHOLD {
                            // Hook is dead — reinstall it.
                            log::warn!(
                                "[capture-helper] Hook health probe not received \
                             ({consecutive_probe_failures} consecutive failures) — \
                             hook appears dead.  Reinstalling WH_KEYBOARD_LL..."
                            );
                            // Force-release any orphan replayed modifiers BEFORE
                            // tearing down the hook — otherwise the injected
                            // modifier-downs we sent stay applied at OS level
                            // with no balancing up.
                            force_release_all_replayed_modifiers("health-reinstall");
                            // Reset modifier-tracking state symmetrically with
                            // the REHOOK path below.  Any in-flight events when
                            // the old hook is uninstalled are stale.
                            let cleared_pending = PENDING_MODIFIERS.with(|cell| {
                                let n = cell.borrow().len();
                                cell.borrow_mut().clear();
                                n
                            });
                            let cleared_consumed = CONSUMED_MODIFIER_VKS.with(|cell| {
                                let n = cell.borrow().len();
                                cell.borrow_mut().clear();
                                n
                            });
                            HELPER_SUPPRESSIONS.with(|cell| cell.borrow_mut().clear());
                            HELPER_MODIFIERS
                                .with(|cell| *cell.borrow_mut() = HelperModifierState::default());
                            HELPER_MATCHES.with(|cell| {
                                cell.borrow_mut().push(format!(
                                    "DEBUG:mod-clear-on-health-reinstall pending={} consumed={}",
                                    cleared_pending, cleared_consumed,
                                ));
                            });
                            unsafe {
                                UnhookWindowsHookEx(hook);
                            }
                            unsafe { unhook_mouse_hook(&mut mouse_hook); }
                            let new_hook = unsafe {
                                SetWindowsHookExW(
                                    WH_KEYBOARD_LL,
                                    Some(helper_ll_keyboard_proc),
                                    hmod,
                                    0,
                                )
                            };
                            if new_hook.is_null() {
                                log::error!(
                                    "[capture-helper] Failed to reinstall hook: {}. Exiting.",
                                    std::io::Error::last_os_error()
                                );
                                break;
                            }
                            hook = new_hook;
                            mouse_hook = unsafe { install_mouse_hook(hmod) };
                            hook_reinstall_count += 1;
                            log::info!(
                                "[capture-helper] Hook reinstalled successfully \
                             (total reinstalls: {hook_reinstall_count})."
                            );
                            consecutive_probe_failures = 0;
                        }
                        // Re-send probe for the next cycle.
                        probe_sent = unsafe { inject_hook_probe() };
                        if probe_sent {
                            HELPER_PROBE_RECEIVED.with(|cell| cell.set(false));
                        }
                    }
                } else {
                    // No callbacks, no probe in-flight — send a probe.
                    probe_sent = unsafe { inject_hook_probe() };
                    if probe_sent {
                        HELPER_PROBE_RECEIVED.with(|cell| cell.set(false));
                    }
                }

                // Mouse hook: same silent removal, but worse — the keyboard probe
                // only reports a dead *keyboard* hook, so a dropped mouse hook
                // would otherwise stay gone for the rest of the session (the
                // trigger button silently turns into a plain right click).
                // Diagnose it from evidence instead: a live mouse hook sees every
                // cursor move, so silence while the pointer moves — or after a
                // probe — proves Windows removed it.
                if mouse_hook_wanted() {
                    if mouse_hook.is_null() {
                        // An install that failed at startup keeps retrying; the
                        // trigger is otherwise dead for the whole session.
                        mouse_hook = unsafe { install_mouse_hook(hmod) };
                    }
                    if !mouse_hook.is_null() {
                        let callback_seen =
                            HOOK_HAD_MOUSE_CALLBACK.with(|cell| cell.replace(false));
                        let probe_received =
                            HELPER_MOUSE_PROBE_RECEIVED.with(|cell| cell.replace(false));
                        let cursor_now = current_cursor_pos();
                        let cursor_moved = matches!(
                            (cursor_now, last_mouse_pos),
                            (Some(now), Some(prev))
                                if (now.0 - prev.0).abs() >= MOUSE_HEALTH_MOVE_PX
                                    || (now.1 - prev.1).abs() >= MOUSE_HEALTH_MOVE_PX
                        );
                        if cursor_now.is_some() {
                            last_mouse_pos = cursor_now;
                        }
                        if callback_seen {
                            mouse_held_cycles = 0;
                        } else if HELPER_HYPER_ACTIVE.load(Ordering::Relaxed) {
                            // Holding the trigger with the pointer parked is
                            // legitimate — count cycles before probing.
                            mouse_held_cycles += 1;
                        } else {
                            mouse_held_cycles = 0;
                        }

                        match mouse_hook_health(
                            callback_seen || probe_received,
                            cursor_moved,
                            mouse_probe_sent,
                            mouse_held_cycles,
                        ) {
                            MouseHookHealth::Alive => {
                                mouse_probe_sent = false;
                                mouse_probe_failures = 0;
                            }
                            MouseHookHealth::Probe => {
                                mouse_probe_sent = unsafe { inject_mouse_hook_probe() };
                                if mouse_probe_sent {
                                    HELPER_MOUSE_PROBE_RECEIVED.with(|cell| cell.set(false));
                                }
                            }
                            MouseHookHealth::Dead => {
                                mouse_probe_sent = false;
                                mouse_probe_failures += 1;
                                if mouse_probe_failures >= MOUSE_PROBE_FAIL_THRESHOLD {
                                    log::warn!(
                                        "[capture-helper] LL mouse hook stopped receiving \
                                     events ({mouse_probe_failures} consecutive cycles) — \
                                     Windows removed it.  Reinstalling WH_MOUSE_LL..."
                                    );
                                    unsafe { unhook_mouse_hook(&mut mouse_hook); }
                                    mouse_hook = unsafe { install_mouse_hook(hmod) };
                                    mouse_reinstall_count += 1;
                                    mouse_probe_failures = 0;
                                    mouse_held_cycles = 0;
                                    last_mouse_pos = current_cursor_pos();
                                    log::info!(
                                        "[capture-helper] Mouse hook reinstalled \
                                     (total mouse reinstalls: {mouse_reinstall_count})."
                                    );
                                }
                            }
                        }
                    }
                }
            } // was_health_timeout
            // Fall through to pump any messages that may have arrived.
        }

        // Pump all pending messages (PeekMessageW is non-blocking).
        loop {
            let found =
                unsafe { PeekMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0, PM_REMOVE) };
            if found == 0 {
                break;
            }

            let m = unsafe { msg.assume_init() };
            if m.message == WM_QUIT {
                // Force-release any orphan replayed modifiers BEFORE drain so
                // the DEBUG: line is included in the final flush.
                force_release_all_replayed_modifiers("wm-quit");
                // Drain any remaining matches before exiting.
                let _ = drain_helper_matches(&stdout);
                unsafe {
                    UnhookWindowsHookEx(hook);
                }
                unsafe { unhook_mouse_hook(&mut mouse_hook); }
                log::info!("[capture-helper] Hook uninstalled, exiting.");
                break 'pump;
            }
            if m.message == WM_REHOOK {
                log::info!("[capture-helper] REHOOK: reinstalling WH_KEYBOARD_LL...");
                // Force-release injected-modifier orphans first so their up
                // events are queued before the hook tears down.
                force_release_all_replayed_modifiers("rehook");
                unsafe {
                    UnhookWindowsHookEx(hook);
                }
                unsafe { unhook_mouse_hook(&mut mouse_hook); }
                // Reset all modifier-tracking state.  Any events in flight
                // when the old hook was uninstalled are stale — their
                // matching up/down may have been dropped.  Better to start
                // clean than to leak a stuck modifier.
                PENDING_MODIFIERS.with(|cell| cell.borrow_mut().clear());
                CONSUMED_MODIFIER_VKS.with(|cell| cell.borrow_mut().clear());
                HELPER_SUPPRESSIONS.with(|cell| cell.borrow_mut().clear());
                HELPER_MODIFIERS.with(|cell| *cell.borrow_mut() = HelperModifierState::default());
                let new_hook = unsafe {
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(helper_ll_keyboard_proc), hmod, 0)
                };
                if new_hook.is_null() {
                    log::error!(
                        "[capture-helper] Failed to reinstall hook on REHOOK: {}. Exiting.",
                        std::io::Error::last_os_error()
                    );
                    break 'pump;
                }
                hook = new_hook;
                mouse_hook = unsafe { install_mouse_hook(hmod) };
                hook_reinstall_count += 1;
                probe_sent = false;
                mouse_probe_sent = false;
                mouse_probe_failures = 0;
                mouse_held_cycles = 0;
                last_mouse_pos = current_cursor_pos();
                log::info!(
                    "[capture-helper] Hook reinstalled via REHOOK \
                     (total reinstalls: {hook_reinstall_count})."
                );
                continue;
            }

            // Drain matches buffered by the hook callback.
            if drain_helper_matches(&stdout).is_err() {
                log::warn!("[capture-helper] stdout pipe broken — parent likely crashed. Exiting.");
                unsafe {
                    UnhookWindowsHookEx(hook);
                }
                unsafe { unhook_mouse_hook(&mut mouse_hook); }
                break 'pump;
            }

            unsafe {
                TranslateMessage(&m);
                DispatchMessageW(&m);
            }

            // Also drain after dispatch (hooks may fire during DispatchMessageW).
            if drain_helper_matches(&stdout).is_err() {
                log::warn!("[capture-helper] stdout pipe broken — parent likely crashed. Exiting.");
                unsafe {
                    UnhookWindowsHookEx(hook);
                }
                unsafe { unhook_mouse_hook(&mut mouse_hook); }
                break 'pump;
            }
        }

        // Check for pending modifiers that have timed out and replay them.
        flush_expired_pending_modifiers();

        // Garbage-collect stale CONSUMED_MODIFIER_VKS entries.  Prevents a
        // lost Razer modifier-up (e.g. from alt-tab focus change) from
        // leaving a stuck entry that suppresses a real subsequent Ctrl-up.
        gc_stale_consumed_modifiers();

        // Force-release REPLAYED_AWAITING_UP entries whose real-up never
        // arrived (alt-tab/RDP/firmware drop).  Bounded recovery for the
        // orphan-replay scenario — without this, OS sees ctrl-down without
        // its balancing up and Ctrl is virtually held.
        gc_orphan_replayed_modifiers();

        // Drain any DEBUG lines generated by flush/gc above.
        if drain_helper_matches(&stdout).is_err() {
            log::warn!("[capture-helper] stdout pipe broken — parent likely crashed. Exiting.");
            unsafe {
                UnhookWindowsHookEx(hook);
            }
            unsafe { unhook_mouse_hook(&mut mouse_hook); }
            break;
        }

        // If the probe was just received inline (during message pumping after
        // we injected it), acknowledge it immediately so we don't have to wait
        // another full interval.
        if probe_sent {
            let received = HELPER_PROBE_RECEIVED.with(|cell| cell.replace(false));
            if received {
                probe_sent = false;
            }
        }
    }

    // 6. Cleanup (reached only on reinstall failure)
    // Let a queued right-click finish before the process goes away: exiting with
    // a pending right-up still queued would leave the button down at OS level.
    drain_pending_hyper_injections(std::time::Duration::from_millis(300));
    log::info!("[capture-helper] Exiting message pump.");
}

fn drain_helper_matches(stdout: &std::io::Stdout) -> std::io::Result<()> {
    use std::io::Write;

    let matches: Vec<String> = HELPER_MATCHES.with(|cell| cell.borrow_mut().drain(..).collect());
    if matches.is_empty() {
        return Ok(());
    }
    let mut stdout = stdout.lock();
    for encoded_key in &matches {
        writeln!(stdout, "{encoded_key}")?;
    }
    stdout.flush() // single flush for entire batch
}

/// Drain all held shortcuts and the stale-tracking map, returning the held
/// states so the caller can inject their key-ups. Pure (no OS calls, no
/// threads) so the B-F4 helper-death recovery is unit-testable in isolation.
fn drain_dead_helper_holds(
    held_actions: &mut std::collections::HashMap<String, crate::input_synthesis::HeldShortcutState>,
    held_last_seen: &mut std::collections::HashMap<String, std::time::Instant>,
) -> Vec<(String, crate::input_synthesis::HeldShortcutState)> {
    held_last_seen.clear();
    held_actions.drain().collect()
}

/// Force-release every hold the dead helper can no longer send a key-up for
/// (B-F4 Mode A). The SendInput injection is kept out of
/// `drain_dead_helper_holds` so the bookkeeping stays pure and testable.
fn release_dead_helper_holds(
    held_actions: &mut std::collections::HashMap<String, crate::input_synthesis::HeldShortcutState>,
    held_last_seen: &mut std::collections::HashMap<String, std::time::Instant>,
) {
    for (key, held) in drain_dead_helper_holds(held_actions, held_last_seen) {
        log::warn!("[capture] Helper died — force-releasing stuck hold `{key}`");
        if let Err(e) = crate::input_synthesis::send_shortcut_hold_up(&held) {
            log::warn!("[capture] Helper-death release failed for `{key}`: {e}");
        }
    }
}

/// What the worker should do to a held encoding's stale-hold recovery deadline
/// after processing one capture event.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HoldDeadlineUpdate {
    /// Mark the key seen "now" — it is (still) actively held.
    Refresh,
    /// The key is no longer held — drop its deadline entry.
    Clear,
    /// Leave the deadline untouched.
    Leave,
}

/// Decide how one processed event updates the stale-hold recovery deadline.
///
/// The 2s sweep exists only to recover a hold whose key-up was lost (e.g. a
/// silently-wedged pipeline). A *sustained physical hold* streams OS auto-repeat
/// events the whole time, so those MUST refresh the deadline — otherwise the
/// sweep force-releases a live hold mid-press, cutting off push-to-talk (a
/// held mouse button → Alt+Shift dropping every ~2s). Auto-repeat only flows
/// while the key is physically down; once released it stops and the sweep can
/// still recover a genuinely-lost key-up.
///
/// A re-tap *duplicate* (a fresh down of an already-held key from a second
/// source, `is_repeat == false`) must NOT refresh — that preserves B-F4 Mode B
/// (rapid re-taps after a helper death must not defer the sweep forever).
fn hold_deadline_update(
    outcome: EventOutcome,
    is_repeat: bool,
    still_held: bool,
) -> HoldDeadlineUpdate {
    match outcome {
        EventOutcome::Handled if still_held => HoldDeadlineUpdate::Refresh,
        EventOutcome::Handled => HoldDeadlineUpdate::Clear,
        EventOutcome::DroppedAsHeldDuplicate if is_repeat && still_held => {
            HoldDeadlineUpdate::Refresh
        }
        EventOutcome::DroppedAsHeldDuplicate => HoldDeadlineUpdate::Leave,
    }
}

/// Spawns the capture helper child process for modifier-combo hotkeys.
/// Returns None if there are no modifier combos or if spawning fails (non-fatal).
fn spawn_capture_helper(
    app: AppHandle,
    runtime_store: Arc<Mutex<RuntimeStore>>,
    registrations: &[RegisteredHotkey],
    event_tx: mpsc::SyncSender<EncodedKeyEvent>,
    config: &AppConfig,
    mouse: MouseInputs,
    helper_died: Arc<AtomicBool>,
) -> Option<HelperHandle> {
    let MouseInputs { readers, firmware_hypershift, config_dir } = mouse;
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Send ALL registrations to the helper so that bare keys (mask=0)
    // also benefit from superset modifier matching.  When the user holds
    // a physical modifier (e.g. Shift) and presses a bare-key button,
    // the LL hook still matches via (current & 0) == 0, while
    // RegisterHotKey (exact matching) would reject the extra modifier.
    let helper_regs: Vec<HelperRegistration> = registrations
        .iter()
        .map(|r| HelperRegistration {
            encoded_key: r.encoded_key.clone(),
            // Strip MOD_NOREPEAT — it's a RegisterHotKey API flag that has
            // no meaning for the LL hook's superset modifier matching.
            modifiers_mask: r.modifiers_mask & MOD_MODIFIER_BITS,
            primary_vk: r.primary_vk,
            wheel: r.wheel,
            button: r.button,
        })
        .collect();

    if helper_regs.is_empty() && readers.is_empty() {
        return None;
    }

    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[capture] Failed to get current exe path for helper: {e}");
            return None;
        }
    };

    let mut child = match Command::new(&exe_path)
        .arg("--capture-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[capture] Failed to spawn capture helper: {e}");
            return None;
        }
    };

    let mut stdin_pipe = match child.stdin.take() {
        Some(pipe) => pipe,
        None => {
            log::warn!("[capture] Capture helper stdin pipe missing");
            let _ = child.kill();
            return None;
        }
    };
    let stdout_pipe = match child.stdout.take() {
        Some(pipe) => pipe,
        None => {
            log::warn!("[capture] Capture helper stdout pipe missing");
            let _ = child.kill();
            return None;
        }
    };

    // Helper diagnostics: the helper's stderr used to be inherited — i.e. lost,
    // in a windowed app — so hook reinstalls, probe failures and panics never
    // reached Sidearm.log.  Exactly those events have to be visible after the
    // fact (a silently dropped LL hook explains "the trigger stopped working"),
    // so pipe the helper's stderr into the parent log.
    if let Some(stderr_pipe) = child.stderr.take() {
        thread::spawn(move || {
            use std::io::BufRead;

            let reader = std::io::BufReader::new(stderr_pipe);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.contains("ERROR") || trimmed.contains("WARN") {
                    log::warn!("[helper] {trimmed}");
                } else {
                    log::info!("[helper] {trimmed}");
                }
            }
        });
    }

    // Write init payload as one JSON line to the helper's stdin.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct HelperInit<'a> {
        registrations: &'a [HelperRegistration],
        #[serde(skip_serializing_if = "Option::is_none")]
        modifier_stale_gc_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        replayed_modifier_force_release_ms: Option<u64>,
        hypershift_trigger: &'a str,
        hypershift_tap: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        hypershift2_model: Option<usize>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        readers: Vec<ReaderInit>,
        firmware_hypershift: bool,
        config_dir: &'a std::path::Path,
    }
    let software_trigger = if firmware_hypershift {
        HYPER_TRIGGER_OFF
    } else {
        hypershift_trigger_code(&config.settings.hypershift_trigger)
    };
    // The mouse whose native button is some profile's HyperShift 2 trigger.
    // shortcut: the hook cannot tell pointing devices apart, so one such mouse
    // at a time, and in a profile with the trigger every mouse's and touchpad's
    // button of that kind is the trigger; raw input could attribute it.
    let hypershift2 = if crate::fake_mode() {
        None
    } else {
        readers.iter().filter(|reader| !reader.software_layer).find_map(|reader| {
            let model = crate::device_catalog::CATALOG.get(reader.model)?;
            let codes = hypershift2_codes(config, model, software_trigger);
            (!codes.is_empty()).then_some((reader.model, codes))
        })
    };
    let init = HelperInit {
        registrations: &helper_regs,
        modifier_stale_gc_ms: config.settings.modifier_stale_gc_ms,
        replayed_modifier_force_release_ms: config.settings.replayed_modifier_force_release_ms,
        hypershift_trigger: config.settings.hypershift_trigger.trim(),
        hypershift_tap: config.settings.hypershift_tap,
        hypershift2_model: hypershift2.as_ref().map(|(model, _)| *model),
        readers,
        firmware_hypershift,
        config_dir: &config_dir,
    };
    let json = match serde_json::to_string(&init) {
        Ok(j) => j,
        Err(e) => {
            log::warn!("[capture] Failed to serialize helper init: {e}");
            let _ = child.kill();
            return None;
        }
    };

    let write_result = writeln!(stdin_pipe, "{json}").and_then(|()| stdin_pipe.flush());
    if let Err(e) = write_result {
        log::warn!("[capture] Failed to write to helper stdin: {e}");
        let _ = child.kill();
        return None;
    }
    let stdin_pipe = Arc::new(Mutex::new(stdin_pipe));
    install_hypershift2_switch(&stdin_pipe, hypershift2.map(|(_, codes)| codes), config, &runtime_store);

    log::info!(
        "[capture] Capture helper spawned (pid {}), {} modifier-combo registrations.",
        child.id(),
        helper_regs.len()
    );
    crate::mouse_status::set_state(Some(&app), crate::mouse_status::StatusKind::HelperLost, false);
    // A new reader reports again; one that is not started (F13..F24) never would.
    crate::mouse_status::set_state(Some(&app), crate::mouse_status::StatusKind::ButtonsUnreadable, false);
    let generation = HELPER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let stopping = Arc::new(AtomicBool::new(false));
    let reader_stopping = stopping.clone();

    // Reader thread: reads encoded keys from helper stdout, converts to events
    let reader_thread = thread::spawn(move || {
        use std::io::BufRead;

        let reader = std::io::BufReader::new(stdout_pipe);
        // Dropped-event diagnostics: the try_send below silently drops when the
        // bounded channel is full (consumer stalled). That surfaces to the user
        // as "a button press sometimes doesn't fire" with nothing in the log.
        // Count drops and warn at most once every 5s (this reader is a single
        // thread, so plain locals suffice — no shared state needed).
        let mut dropped_events: u64 = 0;
        let mut unreadable = [false; crate::device_catalog::CATALOG_LEN];
        let mut last_drop_warn = std::time::Instant::now();
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Whether the consumer reader can read the side buttons (Mouse tab).
            let reader_line = super::consumer::split_reader_line(trimmed);
            if let Some((model, status)) = reader_line.filter(|(_, rest)| rest.starts_with("STATUS:")) {
                // Unreadable while any mouse's reader cannot read its collection.
                let index = model.catalog_index();
                unreadable[index] = status == super::consumer::STATUS_UNREADABLE;
                crate::mouse_status::set_state(
                    Some(&app),
                    crate::mouse_status::StatusKind::ButtonsUnreadable,
                    unreadable.iter().any(|&state| state),
                );
                continue;
            }
            // Diagnostic lines from helper — routed to log::debug! so at the
            // default Info level they never reach the disk/Webview sinks (the
            // per-keystroke feedback loop behind the v0.1.15 OOM). Enable with
            // SIDEARM_DEBUG_CAPTURE=1 plus a Debug log level to see them.
            if let Some(rest) = trimmed.strip_prefix("DEBUG:") {
                log::debug!("[helper] {rest}");
                continue;
            }
            // Hook events worth a normal-level line (see `NOTE_PREFIX`).
            if let Some(rest) = trimmed.strip_prefix(NOTE_PREFIX) {
                log::info!("[capture] {rest}");
                continue;
            }
            // Factory-defaults signature detected by the hook (see
            // FactoryDefaultsDetector): warn loudly instead of letting the
            // mouse silently type digits into the foreground app.
            if trimmed == HELPER_ALERT_FACTORY_DEFAULTS {
                log::warn!(
                    "[capture] The mouse is sending factory digits (1-12) instead of the configured keys — \
                     the Razer profile is not applied (Synapse did not start or the onboard memory was reset)."
                );
                if let Ok(mut store) = runtime_store.lock() {
                    store.record_warn(
                        "capture",
                        crate::ui_text!(
                            "capture.factoryDigitsDetected",
                            "The mouse is sending factory digits (1-12) instead of the configured keys — \
                             the Razer profile is not applied (Synapse did not start or the onboard \
                             memory was reset). Sidearm buttons will not work."
                        ),
                    );
                }
                let _ = app.emit(runtime::EVENT_MOUSE_DEFAULTS_SUSPECTED, ());
                continue;
            }
            // `HS:` is stamped by the helper when the press arrived while the
            // Hypershift trigger was held; it wraps the other prefixes.
            let (input, backend) = match reader_line {
                Some((model, input)) => {
                    // What is held on this mouse, so its live map is never
                    // rewritten under a held button (counted even while the
                    // map is not ready: that is when it is being written).
                    let signal = input.strip_prefix(super::consumer::H2_PREFIX).unwrap_or(input);
                    let signal = signal.strip_prefix(HS_PREFIX).unwrap_or(signal);
                    if let Some(released) = signal.strip_prefix("UP:") {
                        crate::mouse_memory::live_overlay::note_input(model, released, false);
                    } else if !signal.starts_with("REPEAT:") {
                        crate::mouse_memory::live_overlay::note_input(model, signal, true);
                    }
                    if !crate::mouse_memory::live_overlay::events_allowed(model) {
                        continue;
                    }
                    (input, hid_backend(model))
                }
                None => (trimmed, BACKEND_LL_HOOK.to_owned()),
            };
            let (is_hypershift2, input) = match input.strip_prefix(super::consumer::H2_PREFIX) {
                Some(rest) => (true, rest),
                None => (false, input),
            };
            let (is_hypershift, rest) = match input.strip_prefix(HS_PREFIX) {
                Some(rest) => (true, rest),
                None => (false, input),
            };
            let (is_key_up, is_repeat, encoded_key) =
                if let Some(rest) = rest.strip_prefix("UP:") {
                    (true, false, rest.to_owned())
                } else if let Some(rest) = rest.strip_prefix("REPEAT:") {
                    (false, true, rest.to_owned())
                } else {
                    (false, false, rest.to_owned())
                };
            // An unstamped press with a foreign encoding means the firmware's own
            // Hypershift fired (it swallowed our trigger). Our wheel ticks carry
            // `HS:`, so they never trip this.
            if backend == BACKEND_LL_HOOK && !is_hypershift && !is_key_up {
                crate::onboard_guard::note_signal(&encoded_key);
            }
            // try_send instead of send: when the bounded channel is full
            // (consumer stalled), drop the event rather than block this hot
            // path.  See CAPTURE_EVENT_CAPACITY for rationale.
            if let Err(mpsc::TrySendError::Full(_)) = event_tx.try_send(EncodedKeyEvent {
                encoded_key,
                backend,
                received_at: runtime::timestamp_millis(),
                is_repeat,
                is_key_up,
                is_hypershift,
                is_hypershift2,
            }) {
                // Consumer stalled — this key press was dropped. Rate-limit the
                // warning so a sustained stall can't re-create the v0.1.15 log
                // feedback loop.
                dropped_events += 1;
                if last_drop_warn.elapsed() >= std::time::Duration::from_secs(5) {
                    log::warn!(
                        "[capture] Consumer stalled: dropped {dropped_events} keyboard \
                         event(s) from the full bounded channel (cap {CAPTURE_EVENT_CAPACITY}). \
                         Some button presses will not have fired."
                    );
                    dropped_events = 0;
                    last_drop_warn = std::time::Instant::now();
                }
            }
        }
        // B-F4 Mode A: the read loop only exits when the helper's stdout hits
        // EOF — i.e. the helper process has exited/crashed. Flag it so the
        // worker releases holds whose key-ups will now never arrive.
        helper_died.store(true, Ordering::SeqCst);
        // No release of a reader-reported button can arrive any more.
        crate::mouse_memory::live_overlay::clear_held();
        if reader_stopping.load(Ordering::SeqCst) {
            return; // `stop()` closed it
        }
        // Silence used to be the only symptom: capture kept "running" while the
        // helper was gone, so no button fired and nothing was logged.
        log::warn!("[capture] Capture helper exited (stdout closed) — restarting capture.");
        schedule_helper_restart(app, runtime_store, generation);
    });

    Some(HelperHandle {
        stdin_pipe,
        child,
        reader_thread,
        stopping,
    })
}

/// Restart delays after successive helper deaths within [`HELPER_RESTART_WINDOW`];
/// one more death gives up and tells the user.
const HELPER_RESTART_DELAYS: [std::time::Duration; 3] =
    [std::time::Duration::from_secs(1), std::time::Duration::from_secs(5), std::time::Duration::from_secs(30)];
const HELPER_RESTART_WINDOW: std::time::Duration = std::time::Duration::from_secs(600);
static HELPER_RESTARTS: Mutex<Vec<std::time::Instant>> = Mutex::new(Vec::new());
/// Helpers spawned so far: a restart is only for the helper that died, not for
/// one a reload or a stop/start replaced meanwhile.
static HELPER_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Restarts capture after the helper died — every mouse button and modifier
/// combo depends on it, and a tray app may run for days with nobody watching
/// Diagnostics. Gives up after [`HELPER_RESTART_DELAYS`] within the window.
fn schedule_helper_restart(app: AppHandle, runtime_store: Arc<Mutex<RuntimeStore>>, generation: u64) {
    let attempt = {
        let mut restarts = HELPER_RESTARTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        restarts.retain(|at| at.elapsed() < HELPER_RESTART_WINDOW);
        restarts.push(std::time::Instant::now());
        restarts.len() - 1
    };
    let give_up = |app: &AppHandle, runtime_store: &Arc<Mutex<RuntimeStore>>| {
        log::warn!("[capture] Capture helper keeps exiting — gave up restarting it.");
        if let Ok(mut store) = runtime_store.lock() {
            store.record_warn(
                "capture",
                crate::ui_text!(
                    "capture.helperExited",
                    "The capture helper process exited. Mouse buttons and modifier combinations \
                     will stop working — restart capture."
                ),
            );
        }
        crate::mouse_status::set_state(Some(app), crate::mouse_status::StatusKind::HelperLost, true);
    };
    let Some(delay) = HELPER_RESTART_DELAYS.get(attempt).copied() else {
        give_up(&app, &runtime_store);
        return;
    };
    let spawned = thread::Builder::new().name("helper-restart".into()).spawn(move || {
        thread::sleep(delay);
        let current = || HELPER_GENERATION.load(Ordering::SeqCst) == generation;
        match crate::restart_capture(&app, current) {
            Ok(false) => {} // replaced or stopped meanwhile
            // A backend whose helper did not spawn starts fine but leaves the
            // buttons dead with nothing left to notice a further death.
            Ok(true) if current() => {
                log::warn!("[capture] Capture restarted without its helper.");
                give_up(&app, &runtime_store);
            }
            Ok(true) => log::info!("[capture] Capture restarted after the helper exited (attempt {}).", attempt + 1),
            Err(message) => {
                log::warn!("[capture] Capture restart failed: {message}");
                give_up(&app, &runtime_store);
            }
        }
    });
    if let Err(error) = spawned {
        log::warn!("[capture] Capture restart thread not started: {error}");
    }
}

// ---------------------------------------------------------------------------
// RegisterHotKey capture loop
// ---------------------------------------------------------------------------

fn run_hotkey_message_loop(
    registrations: Vec<RegisteredHotkey>,
    event_tx: mpsc::SyncSender<EncodedKeyEvent>,
    ready_tx: mpsc::Sender<Result<u32, String>>,
) {
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        System::Threading::GetCurrentThreadId,
        UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey},
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, MSG, TranslateMessage, WM_HOTKEY,
        },
    };

    // Elevate thread priority (AHK pattern) — RegisterHotKey thread also
    // benefits from responsive message processing.
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }

    // --- 1. Register all hotkeys via RegisterHotKey ---
    let mut registered_ids = Vec::new();
    for reg in &registrations {
        let registered = unsafe {
            RegisterHotKey(
                std::ptr::null_mut(),
                reg.id,
                reg.modifiers_mask,
                reg.primary_vk,
            )
        };
        if registered == 0 {
            for registered_id in registered_ids.iter().copied() {
                unsafe {
                    UnregisterHotKey(std::ptr::null_mut(), registered_id);
                }
            }
            let last_error = std::io::Error::last_os_error();
            let hint = if last_error.raw_os_error() == Some(5) {
                // ERROR_ACCESS_DENIED (5) — another process (likely elevated)
                // already owns this hotkey and UIPI blocks our registration.
                " Hotkey may be owned by an elevated process. \
                 Try running as administrator."
            } else {
                ""
            };
            let _ = ready_tx.send(Err(format!(
                "RegisterHotKey failed for `{}`. {last_error}{hint}",
                reg.encoded_key
            )));
            return;
        }
        registered_ids.push(reg.id);
    }

    let thread_id = unsafe { GetCurrentThreadId() };
    let _ = ready_tx.send(Ok(thread_id));

    // --- 2. Message loop ---
    let mut msg = MaybeUninit::<MSG>::zeroed();
    loop {
        let status = unsafe { GetMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0) };
        if status <= 0 {
            break; // 0 = WM_QUIT, -1 = error
        }

        let m = unsafe { msg.assume_init() };
        if m.message == WM_HOTKEY {
            let hotkey_id = m.wParam as i32;
            let index = (hotkey_id as usize).checked_sub(1);
            let registration = index.and_then(|i| registrations.get(i));
            if let Some(registration) = registration {
                let _ = event_tx.try_send(EncodedKeyEvent {
                    encoded_key: registration.encoded_key.clone(),
                    backend: CAPTURE_BACKEND_NAME.into(),
                    received_at: runtime::timestamp_millis(),
                    is_repeat: false,
                    is_key_up: false,
                    // The RegisterHotKey path has no mouse hook, so it cannot
                    // observe the Hypershift trigger.
                    is_hypershift: false,
                    is_hypershift2: false,
                });
            } else {
                log::warn!("[capture] Received WM_HOTKEY with unrecognized id {hotkey_id}");
            }
        }

        unsafe {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    }

    // --- 3. Cleanup ---
    for registered_id in registered_ids {
        unsafe {
            UnregisterHotKey(std::ptr::null_mut(), registered_id);
        }
    }
}

// ---------------------------------------------------------------------------
// Foreground window watcher — detects window switches instantly via WinEvent
// ---------------------------------------------------------------------------

fn run_foreground_watcher(
    app: AppHandle,
    runtime_store: Arc<Mutex<RuntimeStore>>,
    config: AppConfig,
    app_name: String,
    ready_tx: mpsc::Sender<u32>,
) {
    use std::cell::RefCell;
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        System::Threading::GetCurrentThreadId,
        UI::Accessibility::{SetWinEventHook, UnhookWinEvent},
        UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG, TranslateMessage},
    };

    // Thread-local storage for the callback to access our context.
    thread_local! {
        static FG_CTX: RefCell<Option<ForegroundWatcherCtx>> = const { RefCell::new(None) };
    }

    struct ForegroundWatcherCtx {
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    }

    unsafe extern "system" fn winevent_callback(
        _hook: *mut std::ffi::c_void,
        _event: u32,
        _hwnd: *mut std::ffi::c_void,
        _id_object: i32,
        _id_child: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        // A panic unwinding across this `extern "system"` boundary is UB, and
        // this callback runs on a thread in the MAIN app process. Contain any
        // panic (heavy capture/emit, poisoned lock, re-entrant borrow) and drop
        // the foreground event instead of unwinding.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            FG_CTX.with(|cell| {
                let borrow = cell.borrow();
                let Some(ctx) = borrow.as_ref() else { return };

                // Skip auto-profile-switching while a manual window capture is
                // in progress (the user is Alt+Tabbing to the target window).
                {
                    let is_capturing = ctx
                        .runtime_store
                        .lock()
                        .ok()
                        .map(|store| store.is_capture_in_progress())
                        .unwrap_or(false);
                    if is_capturing {
                        log::debug!("[capture] Foreground change ignored (capture in progress)");
                        return;
                    }
                }

                // Audit F003: the indicator must reflect a ProfileSwitch override too,
                // matching what the dispatch path fires.
                let manual_profile_override = ctx
                    .runtime_store
                    .lock()
                    .ok()
                    .and_then(|store| store.manual_profile_override().map(str::to_owned));
                let capture_result =
                    match window_capture::capture_active_window_with_resolution_with_override(
                        &ctx.config,
                        &ctx.app_name,
                        None,
                        manual_profile_override.as_deref(),
                    ) {
                        Ok(result) => result,
                        Err(_) => return,
                    };

                super::emit_profile_resolved_and_notify(
                    &ctx.app,
                    &ctx.runtime_store,
                    &capture_result,
                    &ctx.config,
                );
            });
        }));
        if outcome.is_err() {
            log::error!("[capture] winevent_callback panicked; foreground event dropped.");
        }
    }

    // Store context in thread-local
    FG_CTX.with(|cell| {
        *cell.borrow_mut() = Some(ForegroundWatcherCtx {
            app,
            runtime_store,
            config,
            app_name,
        });
    });

    const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;

    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            std::ptr::null_mut(), // no DLL — callback in our process
            Some(winevent_callback),
            0, // all processes
            0, // all threads
            0, // WINEVENT_OUTOFCONTEXT (default)
        )
    };

    if hook.is_null() {
        log::warn!("[capture] SetWinEventHook(EVENT_SYSTEM_FOREGROUND) failed.");
        let _ = ready_tx.send(0);
        return;
    }

    let thread_id = unsafe { GetCurrentThreadId() };
    let _ = ready_tx.send(thread_id);

    // Message loop — required for WinEvent callbacks to fire
    let mut msg = MaybeUninit::<MSG>::zeroed();
    loop {
        let status = unsafe { GetMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0) };
        if status <= 0 {
            break;
        }
        unsafe {
            let m = msg.assume_init();
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    }

    unsafe { UnhookWinEvent(hook) };

    // Clean up thread-local
    FG_CTX.with(|cell| {
        *cell.borrow_mut() = None;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod factory_defaults_detector_tests {
    use super::{DEFAULTS_ALERT_HITS, FactoryDefaultsDetector};

    const VK_4: u32 = 0x34;
    const SC_4: u32 = 0x05;

    /// One physical press in the broken state, timings from the live capture
    /// (2026-07-02): real down, then the injected duplicate ~64-138ms later.
    fn feed_pair(d: &mut FactoryDefaultsDetector, vk: u32, sc: u32, at_ms: u32) -> bool {
        let fired_real = d.observe_keydown(vk, sc, false, at_ms);
        assert!(!fired_real, "real keydown alone must never fire");
        d.observe_keydown(vk, sc, true, at_ms + 100)
    }

    #[test]
    fn fires_once_after_threshold_pairs() {
        let mut d = FactoryDefaultsDetector::default();
        for i in 0..DEFAULTS_ALERT_HITS - 1 {
            assert!(!feed_pair(&mut d, VK_4, SC_4, 1_000 * (i as u32 + 1)));
        }
        assert!(
            feed_pair(&mut d, VK_4, SC_4, 10_000),
            "threshold pair fires"
        );
        // Once alerted, stays silent (once per helper lifetime).
        assert!(!feed_pair(&mut d, VK_4, SC_4, 20_000));
    }

    #[test]
    fn plain_typing_never_fires() {
        let mut d = FactoryDefaultsDetector::default();
        for i in 0..100 {
            assert!(!d.observe_keydown(VK_4, SC_4, false, i * 50));
        }
    }

    #[test]
    fn injected_only_stream_never_fires() {
        // Sidearm snippets typing digits are injected-only: no real precursor.
        let mut d = FactoryDefaultsDetector::default();
        for i in 0..100 {
            assert!(!d.observe_keydown(VK_4, SC_4, true, i * 50));
        }
    }

    #[test]
    fn vk_mismatch_or_stale_real_does_not_pair() {
        let mut d = FactoryDefaultsDetector::default();
        // Different VK on the same scancode (layout weirdness) — no pair.
        assert!(!d.observe_keydown(VK_4, SC_4, false, 1_000));
        assert!(!d.observe_keydown(0x35, SC_4, true, 1_050));
        // Real older than the pair window — no pair.
        assert!(!d.observe_keydown(VK_4, SC_4, false, 10_000));
        assert!(!d.observe_keydown(VK_4, SC_4, true, 12_000));
    }

    #[test]
    fn injected_autorepeat_counts_single_press_once() {
        let mut d = FactoryDefaultsDetector::default();
        assert!(!d.observe_keydown(VK_4, SC_4, false, 1_000));
        assert!(!d.observe_keydown(VK_4, SC_4, true, 1_100)); // pair #1
        // Injected repeats without a fresh real press must not add hits.
        assert!(!d.observe_keydown(VK_4, SC_4, true, 1_150));
        assert!(!d.observe_keydown(VK_4, SC_4, true, 1_200));
    }

    #[test]
    fn pairs_outside_hit_window_never_accumulate() {
        // One pair per 70s: each new hit evicts the previous one from the
        // 60s window, so the threshold is never reached.
        let mut d = FactoryDefaultsDetector::default();
        for i in 0..10u32 {
            assert!(!feed_pair(&mut d, VK_4, SC_4, i * 70_000));
        }
    }

    #[test]
    fn non_digit_scancodes_ignored() {
        let mut d = FactoryDefaultsDetector::default();
        // 'Q' (sc 0x10) real + injected duplicate — outside the thumb row.
        assert!(!d.observe_keydown(0x51, 0x10, false, 1_000));
        assert!(!d.observe_keydown(0x51, 0x10, true, 1_050));
    }
}

#[cfg(test)]
mod helper_death_recovery_tests {
    use super::drain_dead_helper_holds;
    use crate::input_synthesis::HeldShortcutState;
    use std::collections::HashMap;
    use std::time::Instant;

    fn dummy_held() -> HeldShortcutState {
        HeldShortcutState {
            pressed_modifier_vks: Vec::new(),
            primary_key: None,
        }
    }

    /// B-F4: after a helper-death drain, `held_actions` and `held_last_seen`
    /// are both empty, so the `held_actions.contains_key(K)` gate that drops
    /// taps (the hold-shortcut dedup + the worker refresh) is false — the next
    /// tap of the same key is delivered instead of being silently skipped.
    #[test]
    fn drain_releases_holds_so_next_tap_is_not_dropped() {
        let mut held: HashMap<String, HeldShortcutState> = HashMap::new();
        let mut seen: HashMap<String, Instant> = HashMap::new();
        let k = "Ctrl+F13".to_string();
        held.insert(k.clone(), dummy_held());
        seen.insert(k.clone(), Instant::now());

        let released = drain_dead_helper_holds(&mut held, &mut seen);

        assert_eq!(
            released.len(),
            1,
            "the held entry must be returned for key-up injection"
        );
        assert_eq!(released[0].0, k);
        assert!(
            held.is_empty(),
            "held_actions must be drained on helper death"
        );
        assert!(
            seen.is_empty(),
            "held_last_seen must be cleared on helper death"
        );
        assert!(
            !held.contains_key(&k),
            "next tap of the same key must not be skipped as already-held"
        );
    }

    /// Helper death while nothing is held is a harmless no-op.
    #[test]
    fn drain_with_no_holds_is_empty() {
        let mut held: HashMap<String, HeldShortcutState> = HashMap::new();
        let mut seen: HashMap<String, Instant> = HashMap::new();

        let released = drain_dead_helper_holds(&mut held, &mut seen);

        assert!(released.is_empty());
        assert!(held.is_empty());
        assert!(seen.is_empty());
    }
}

#[cfg(test)]
mod hold_deadline_tests {
    use super::{HoldDeadlineUpdate, hold_deadline_update};
    use crate::capture_backend::EventOutcome;

    /// The regression: a sustained physical hold streams auto-repeat events that
    /// land as already-held duplicates. They MUST refresh the recovery deadline,
    /// or the 2s stale sweep force-releases a live hold mid-press (push-to-talk
    /// cut off every ~2s).
    #[test]
    fn auto_repeat_of_held_key_refreshes_deadline() {
        assert_eq!(
            hold_deadline_update(EventOutcome::DroppedAsHeldDuplicate, true, true),
            HoldDeadlineUpdate::Refresh,
        );
    }

    /// B-F4 Mode B preserved: a re-tap duplicate (fresh down, not a repeat) must
    /// NOT refresh — rapid re-taps after a helper death must not defer the sweep.
    #[test]
    fn retap_duplicate_does_not_refresh_deadline() {
        assert_eq!(
            hold_deadline_update(EventOutcome::DroppedAsHeldDuplicate, false, true),
            HoldDeadlineUpdate::Leave,
        );
    }

    #[test]
    fn handled_while_held_refreshes_and_clears_when_released() {
        assert_eq!(
            hold_deadline_update(EventOutcome::Handled, false, true),
            HoldDeadlineUpdate::Refresh,
        );
        assert_eq!(
            hold_deadline_update(EventOutcome::Handled, false, false),
            HoldDeadlineUpdate::Clear,
        );
    }

    /// A repeat that no longer maps to a held action leaves the deadline alone.
    #[test]
    fn repeat_without_active_hold_leaves_deadline() {
        assert_eq!(
            hold_deadline_update(EventOutcome::DroppedAsHeldDuplicate, true, false),
            HoldDeadlineUpdate::Leave,
        );
    }
}

#[cfg(test)]
mod helper_modifier_state_tests {
    use super::*;

    #[test]
    fn tracks_left_and_right_modifier_variants() {
        let mut state = HelperModifierState::default();

        assert!(state.apply_vk_event(VK_LCONTROL, true));
        assert!(state.ctrl);
        assert!(state.apply_vk_event(VK_RSHIFT, true));
        assert!(state.shift);
        assert!(state.apply_vk_event(VK_RMENU, true));
        assert!(state.alt);
        assert!(state.apply_vk_event(VK_LWIN, true));
        assert!(state.win);

        assert!(state.apply_vk_event(VK_CONTROL, false));
        assert!(!state.ctrl);
        assert!(state.apply_vk_event(VK_SHIFT, false));
        assert!(!state.shift);
        assert!(state.apply_vk_event(VK_MENU, false));
        assert!(!state.alt);
        assert!(state.apply_vk_event(VK_RWIN, false));
        assert!(!state.win);
    }

    #[test]
    fn matches_modifier_mask_superset() {
        let state = HelperModifierState {
            ctrl: true,
            alt: false,
            shift: true,
            win: false,
        };

        // Exact match
        assert!(state.matches_mask(MOD_CONTROL | MOD_SHIFT));
        // Superset: Ctrl+Shift held, only Ctrl required — should match
        assert!(state.matches_mask(MOD_CONTROL));
        // Bare (mask=0) — always matches regardless of held modifiers
        assert!(state.matches_mask(0));
        // Requires Alt which is not held — should NOT match
        assert!(!state.matches_mask(MOD_CONTROL | MOD_SHIFT | MOD_ALT));
    }

    #[test]
    fn as_modifier_flags_roundtrip() {
        let state = HelperModifierState {
            ctrl: true,
            alt: true,
            shift: false,
            win: false,
        };
        assert_eq!(state.as_modifier_flags(), MOD_CONTROL | MOD_ALT);
    }
}

#[cfg(test)]
mod replayed_awaiting_up_tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Reset thread-local state at the start of each test so order is
    /// independent. (Cargo runs tests in parallel by default; thread_local
    /// keeps state per-thread, so state can leak between tests scheduled
    /// onto the same worker thread.)
    fn reset_state() {
        REPLAYED_AWAITING_UP.with(|cell| cell.borrow_mut().clear());
        REPLAYED_AWAITING_UP_THRESHOLD.with(|c| {
            c.set(Duration::from_millis(DEFAULT_REPLAYED_AWAITING_UP_MS));
        });
    }

    #[test]
    fn drain_expired_drains_old_skips_recent() {
        reset_state();
        REPLAYED_AWAITING_UP_THRESHOLD.with(|c| c.set(Duration::from_millis(100)));
        let now = Instant::now();
        REPLAYED_AWAITING_UP.with(|cell| {
            let mut map = cell.borrow_mut();
            // Old entry: should be drained.
            map.insert(0xA2, now - Duration::from_millis(500)); // VK_LCONTROL
            // Recent entry: should remain.
            map.insert(0xA0, now); // VK_LSHIFT
        });

        let expired = drain_expired_replayed_modifiers();
        let expired_vks: Vec<u32> = expired.iter().map(|(vk, _)| *vk).collect();
        assert!(expired_vks.contains(&0xA2));
        assert!(!expired_vks.contains(&0xA0));

        REPLAYED_AWAITING_UP.with(|cell| {
            let map = cell.borrow();
            assert!(!map.contains_key(&0xA2), "old should be drained");
            assert!(map.contains_key(&0xA0), "recent should remain");
        });
    }

    #[test]
    fn drain_expired_returns_empty_when_no_entries() {
        reset_state();
        let expired = drain_expired_replayed_modifiers();
        assert!(expired.is_empty());
    }

    #[test]
    fn drain_expired_keeps_all_when_threshold_huge() {
        reset_state();
        REPLAYED_AWAITING_UP_THRESHOLD.with(|c| c.set(Duration::from_secs(3600)));
        REPLAYED_AWAITING_UP.with(|cell| {
            let mut map = cell.borrow_mut();
            map.insert(0xA2, Instant::now() - Duration::from_secs(1));
            map.insert(0xA0, Instant::now() - Duration::from_secs(10));
        });
        let expired = drain_expired_replayed_modifiers();
        assert!(
            expired.is_empty(),
            "no entries should expire under 1 h threshold"
        );
        REPLAYED_AWAITING_UP.with(|cell| {
            assert_eq!(cell.borrow().len(), 2);
        });
    }

    #[test]
    fn take_all_replayed_drains_map() {
        reset_state();
        REPLAYED_AWAITING_UP.with(|cell| {
            let mut map = cell.borrow_mut();
            map.insert(0xA2, Instant::now());
            map.insert(0xA0, Instant::now());
            map.insert(0xA4, Instant::now());
        });
        let drained = take_all_replayed_modifiers();
        assert_eq!(drained.len(), 3);
        REPLAYED_AWAITING_UP.with(|cell| {
            assert!(cell.borrow().is_empty());
        });
    }

    #[test]
    fn take_all_replayed_returns_empty_when_no_entries() {
        reset_state();
        let drained = take_all_replayed_modifiers();
        assert!(drained.is_empty());
    }

    #[test]
    fn drain_expired_at_exact_threshold_drains() {
        reset_state();
        REPLAYED_AWAITING_UP_THRESHOLD.with(|c| c.set(Duration::from_millis(50)));
        REPLAYED_AWAITING_UP.with(|cell| {
            cell.borrow_mut()
                .insert(0xA2, Instant::now() - Duration::from_millis(60));
        });
        let expired = drain_expired_replayed_modifiers();
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].0, 0xA2);
    }

    // ------------------------------------------------------------------
    // Tests for `should_suppress_repeat_modifier_down` (auto-repeat guard)
    // ------------------------------------------------------------------

    #[test]
    fn suppress_repeat_when_replayed_present_and_fresh() {
        let mut map = std::collections::HashMap::new();
        let now = Instant::now();
        map.insert(0xA2u32, now); // VK_LCONTROL just replayed
        let threshold = Duration::from_millis(3000);

        assert!(should_suppress_repeat_modifier_down(
            0xA2,
            false,
            &map,
            now + Duration::from_millis(31),
            threshold,
        ));
    }

    #[test]
    fn no_suppress_when_replayed_absent() {
        let map: std::collections::HashMap<u32, Instant> = std::collections::HashMap::new();
        let threshold = Duration::from_millis(3000);
        assert!(!should_suppress_repeat_modifier_down(
            0xA2,
            false,
            &map,
            Instant::now(),
            threshold,
        ));
    }

    #[test]
    fn no_suppress_when_replayed_stale() {
        let mut map = std::collections::HashMap::new();
        let now = Instant::now();
        // Entry inserted 5 s ago; threshold is 3 s — stale.
        map.insert(0xA2u32, now - Duration::from_secs(5));
        let threshold = Duration::from_secs(3);

        assert!(!should_suppress_repeat_modifier_down(
            0xA2, false, &map, now, threshold,
        ));
    }

    #[test]
    fn no_suppress_when_externally_injected() {
        let mut map = std::collections::HashMap::new();
        let now = Instant::now();
        map.insert(0xA2u32, now);
        let threshold = Duration::from_millis(3000);

        // External injection (other process's SendInput) should NEVER be
        // suppressed — that breaks paste flows etc.
        assert!(!should_suppress_repeat_modifier_down(
            0xA2, true, &map, now, threshold,
        ));
    }

    #[test]
    fn no_suppress_for_different_vk() {
        let mut map = std::collections::HashMap::new();
        let now = Instant::now();
        map.insert(0xA2u32, now); // LCtrl tracked
        let threshold = Duration::from_millis(3000);

        // RShift (0xA1) arrives — different VK, must NOT be suppressed.
        assert!(!should_suppress_repeat_modifier_down(
            0xA1, false, &map, now, threshold,
        ));
    }

    #[test]
    fn suppress_at_exact_age_boundary() {
        let mut map = std::collections::HashMap::new();
        let now = Instant::now();
        let threshold = Duration::from_millis(100);
        // Age == threshold → NOT suppressed (`<` strict).
        map.insert(0xA2u32, now - threshold);
        assert!(!should_suppress_repeat_modifier_down(
            0xA2, false, &map, now, threshold,
        ));
        // Age 1 ms below threshold → suppressed.
        map.insert(0xA2u32, now - threshold + Duration::from_millis(1));
        assert!(should_suppress_repeat_modifier_down(
            0xA2, false, &map, now, threshold,
        ));
    }

    // ------------------------------------------------------------------
    // Race-guard flag: ensure flush sets and clears it correctly.
    // ------------------------------------------------------------------

    #[test]
    fn flushing_flag_starts_clear() {
        FLUSHING_REPLAYED.with(|c| c.set(false));
        assert!(!FLUSHING_REPLAYED.with(|c| c.get()));
    }

    #[test]
    fn flush_with_no_pending_does_not_set_flag() {
        // Sanity: empty pending means flush returns early before touching
        // the flag, so it stays whatever caller set it to.
        FLUSHING_REPLAYED.with(|c| c.set(false));
        PENDING_MODIFIERS.with(|c| c.borrow_mut().clear());
        flush_expired_pending_modifiers();
        assert!(
            !FLUSHING_REPLAYED.with(|c| c.get()),
            "empty flush must leave flag clear"
        );
    }

    // ------------------------------------------------------------------
    // Tests for `is_extended_modifier_vk` (KEYEVENTF_EXTENDEDKEY gating)
    // ------------------------------------------------------------------

    #[test]
    fn extended_modifier_vk_true_for_rcontrol_rmenu() {
        assert!(is_extended_modifier_vk(VK_RCONTROL));
        assert!(is_extended_modifier_vk(VK_RMENU));
    }

    #[test]
    fn extended_modifier_vk_false_for_left_modifiers() {
        // Left-side variants share the same scan code as their right
        // counterparts but do NOT carry the 0xE0 prefix — flag must be off.
        assert!(!is_extended_modifier_vk(VK_LCONTROL));
        assert!(!is_extended_modifier_vk(VK_LSHIFT));
        assert!(!is_extended_modifier_vk(VK_LMENU));
    }

    #[test]
    fn extended_modifier_vk_false_for_rshift_and_win() {
        // Per MSDN extended-key list: RSHIFT and Win keys are NOT extended.
        // RSHIFT has its own scan code (0x36) without the 0xE0 prefix.
        // LWIN/RWIN are absent from the official extended list.
        assert!(!is_extended_modifier_vk(VK_RSHIFT));
        assert!(!is_extended_modifier_vk(VK_LWIN));
        assert!(!is_extended_modifier_vk(VK_RWIN));
    }

    #[test]
    fn extended_modifier_vk_false_for_generic_and_non_modifiers() {
        // The generic VK_CONTROL / VK_SHIFT / VK_MENU codes are sentinel
        // virtual keys (used for state queries) — they should never be
        // injected directly, but if they are, they aren't extended.
        assert!(!is_extended_modifier_vk(VK_CONTROL));
        assert!(!is_extended_modifier_vk(VK_SHIFT));
        assert!(!is_extended_modifier_vk(VK_MENU));
        // Letters / arrows / F-keys: not modifiers at all.
        assert!(!is_extended_modifier_vk(0x41)); // 'A'
        assert!(!is_extended_modifier_vk(0x25)); // VK_LEFT (extended key but not modifier)
        assert!(!is_extended_modifier_vk(0x70)); // VK_F1
    }

    #[test]
    fn flush_clears_flag_after_run() {
        // With an expired pending entry, flush sets the flag during
        // SendInput and clears it before returning.  Post-condition: flag
        // is false.  (We can't easily observe the flag DURING the flush
        // from a unit test without a re-entrant SendInput interceptor,
        // but we can confirm the post-condition.)
        reset_state();
        FLUSHING_REPLAYED.with(|c| c.set(false));
        PENDING_MODIFIERS.with(|cell| {
            cell.borrow_mut().push(PendingModifier {
                vk: 0xA0,
                scan: 0x2A,
                buffered_at: Instant::now() - Duration::from_millis(50),
            });
        });
        flush_expired_pending_modifiers();
        assert!(
            !FLUSHING_REPLAYED.with(|c| c.get()),
            "flush must clear FLUSHING_REPLAYED on exit"
        );
        // Cleanup: the flush also injected a key-down via SendInput.
        // Force-release it so the unit test doesn't leave the OS in a
        // virtually-held state (the test process IS the OS-visible app).
        unsafe {
            replay_modifier_up(0xA0, 0x2A);
        }
        REPLAYED_AWAITING_UP.with(|c| c.borrow_mut().clear());
    }
}

#[cfg(test)]
mod helper_key_event_tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_KEYUP};

    const VK_F24: u32 = 0x87;

    fn reg(encoded_key: &str, modifiers_mask: u32, primary_vk: u32) -> HelperRegistration {
        HelperRegistration {
            encoded_key: encoded_key.into(),
            modifiers_mask,
            primary_vk,
            wheel: None,
            button: None,
        }
    }

    #[test]
    fn key_up_emits_release_event() {
        let regs = vec![reg("Ctrl+Shift+F24", MOD_CONTROL | MOD_SHIFT, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // Simulate Ctrl down, Shift down, F24 down
        modifiers.apply_vk_event(VK_LCONTROL, true);
        modifiers.apply_vk_event(VK_LSHIFT, true);
        let (suppress, wake, _inject_mask) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        assert_eq!(matches, vec!["Ctrl+Shift+F24"]);
        matches.clear();

        // Simulate F24 up — should emit UP: event
        let (suppress, wake, _inject_mask) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYUP,
        );
        assert!(suppress);
        assert!(wake, "key-up of suppressed key should wake for drain");
        assert_eq!(matches, vec!["UP:Ctrl+Shift+F24"]);
    }

    #[test]
    fn key_up_of_unsuppressed_key_does_not_emit() {
        let regs = vec![reg("Ctrl+Shift+F24", MOD_CONTROL | MOD_SHIFT, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // F24 up without prior down — should not emit
        let (suppress, wake, _inject_mask) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYUP,
        );
        assert!(!suppress);
        assert!(!wake);
        assert!(matches.is_empty());
    }

    #[test]
    fn most_specific_match_wins_over_bare() {
        // Register both bare F24 (mask=0) and Shift+Ctrl+Alt+F24 (mask=0x0007)
        let regs = vec![
            reg("F24", 0, VK_F24),
            reg(
                "Shift+Ctrl+Alt+F24",
                MOD_SHIFT | MOD_CONTROL | MOD_ALT,
                VK_F24,
            ),
        ];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // Press Shift+Ctrl+Alt then F24 — most specific (3 bits) should win
        modifiers.apply_vk_event(VK_LSHIFT, true);
        modifiers.apply_vk_event(VK_LCONTROL, true);
        modifiers.apply_vk_event(VK_LMENU, true);

        let (suppress, wake, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        assert_eq!(matches, vec!["Shift+Ctrl+Alt+F24"]);
    }

    #[test]
    fn bare_match_fires_when_no_modifiers_held() {
        // Both registrations exist but no modifiers are held — bare should win
        let regs = vec![
            reg("F24", 0, VK_F24),
            reg(
                "Shift+Ctrl+Alt+F24",
                MOD_SHIFT | MOD_CONTROL | MOD_ALT,
                VK_F24,
            ),
        ];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        let (suppress, wake, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        // Only bare F24 qualifies (Shift+Ctrl+Alt requires those modifiers)
        assert_eq!(matches, vec!["F24"]);
    }

    #[test]
    fn superset_fires_bare_when_extra_modifiers_held() {
        // Only a bare F24 is registered; user holds Shift physically
        let regs = vec![reg("F24", 0, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        modifiers.apply_vk_event(VK_LSHIFT, true);
        let (suppress, wake, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(suppress, "bare F24 should fire even with extra Shift held");
        assert!(wake);
        assert_eq!(matches, vec!["F24"]);
    }

    #[test]
    fn auto_repeat_emits_match() {
        // Holding a mouse button should emit matches on every repeat
        // key-down so tap-mode actions (e.g. Backspace) auto-repeat.
        let regs = vec![reg("F24", 0, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // First press
        let (suppress, wake, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        assert_eq!(matches.len(), 1);

        // Auto-repeat (same VK, still key-down, already in suppressions)
        let (suppress2, wake2, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(suppress2, "repeat should still be suppressed");
        assert!(wake2, "repeat should wake to emit match");
        assert_eq!(matches.len(), 2, "repeat should emit a second match");
        assert_eq!(
            matches[1], "REPEAT:F24",
            "repeat match should carry REPEAT: prefix"
        );
    }

    #[test]
    fn auto_repeat_does_not_inject_mask_key() {
        // The mask key (VK 0xE8) prevents Alt/Win menu activation.
        // It should only fire on the FIRST press, not on auto-repeats.
        let regs = vec![reg("Alt+F24", MOD_ALT, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        modifiers.apply_vk_event(VK_LMENU, true); // Alt held (encoding)

        // First press — inject_mask should be true (Alt active)
        let (_, _, inject_mask) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(inject_mask, "first press with Alt should inject mask key");

        // Repeat — inject_mask should be false
        let (_, _, inject_mask2) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(!inject_mask2, "repeat should NOT inject mask key");
    }

    #[test]
    fn superset_match_modifier_combo_with_extra_physical() {
        // Alt+F24 registered (mask=MOD_ALT). User holds Shift+Alt physically.
        // Should match via superset: (Shift|Alt & Alt) == Alt.
        let regs = vec![reg("Alt+F24", MOD_ALT, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        modifiers.apply_vk_event(VK_LMENU, true); // Alt (encoding)
        modifiers.apply_vk_event(VK_LSHIFT, true); // Shift (physical, extra)

        let (suppress, wake, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(suppress, "should match with extra physical Shift");
        assert!(wake);
        assert_eq!(matches, vec!["Alt+F24"]);
    }

    #[test]
    fn overlapping_modifier_combo_masks_resolved() {
        // Ctrl+F24 (mask=0x0002) and Ctrl+Alt+F24 (mask=0x0003) both registered.
        // Pressing Ctrl+Alt+F24 should pick Ctrl+Alt+F24 (more specific).
        let regs = vec![
            reg("Ctrl+F24", MOD_CONTROL, VK_F24),
            reg("Ctrl+Alt+F24", MOD_CONTROL | MOD_ALT, VK_F24),
        ];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        modifiers.apply_vk_event(VK_LCONTROL, true);
        modifiers.apply_vk_event(VK_LMENU, true);

        let (suppress, wake, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        assert_eq!(
            matches,
            vec!["Ctrl+Alt+F24"],
            "most-specific mask should win"
        );
    }

    #[test]
    fn full_press_repeat_release_lifecycle() {
        // Simulate complete lifecycle: press → repeat → repeat → release
        let regs = vec![reg("F24", 0, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // 1. First press
        let (s, w, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(s && w);
        assert_eq!(matches.len(), 1);

        // 2. Repeat
        let (s, w, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(s && w);
        assert_eq!(matches.len(), 2);

        // 3. Another repeat
        let (s, w, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(s && w);
        assert_eq!(matches.len(), 3);

        // 4. Release
        let (s, w, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYUP,
        );
        assert!(s && w);
        assert_eq!(matches[3], "UP:F24");

        // 5. Suppressions are now empty — another release does nothing
        let (s, w, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYUP,
        );
        assert!(!s && !w, "second release should be a no-op");
    }

    #[test]
    fn modifier_key_up_not_suppressed() {
        // Modifier key events (Shift, Ctrl, etc.) should never be suppressed —
        // they pass through so the OS tracks modifier state correctly.
        let regs = vec![reg("Ctrl+F24", MOD_CONTROL, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // Ctrl down — should pass through
        let (suppress, _, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_LCONTROL,
            WM_KEYDOWN,
        );
        assert!(!suppress, "modifier key-down must not be suppressed");
        assert!(modifiers.ctrl);

        // Ctrl up — should pass through
        let (suppress, _, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_LCONTROL,
            WM_KEYUP,
        );
        assert!(!suppress, "modifier key-up must not be suppressed");
        assert!(!modifiers.ctrl);
    }

    #[test]
    fn no_match_when_required_modifier_missing() {
        // Ctrl+F24 registered but only Shift is held — should NOT match.
        let regs = vec![reg("Ctrl+F24", MOD_CONTROL, VK_F24)];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        modifiers.apply_vk_event(VK_LSHIFT, true); // wrong modifier

        let (suppress, wake, _) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            VK_F24,
            WM_KEYDOWN,
        );
        assert!(!suppress, "should not match without required Ctrl");
        assert!(!wake);
        assert!(matches.is_empty());
    }

    #[test]
    fn mod_norepeat_stripped_from_helper_mask() {
        // register_hotkey_mask() includes MOD_NOREPEAT (0x4000).
        // Verify that MOD_MODIFIER_BITS correctly strips it.
        let mask_with_norepeat = MOD_ALT | 0x4000; // e.g. Alt+F24
        let clean = mask_with_norepeat & MOD_MODIFIER_BITS;
        assert_eq!(clean, MOD_ALT);

        // Verify superset matching works with the cleaned mask
        let mut modifiers = HelperModifierState::default();
        modifiers.apply_vk_event(VK_LMENU, true); // Alt held
        assert!(
            modifiers.matches_mask(clean),
            "Alt+F24 should match when Alt is held and mask is clean"
        );
        assert!(
            !modifiers.matches_mask(mask_with_norepeat),
            "mask with MOD_NOREPEAT should NOT match (bit 0x4000 never set in current)"
        );
    }
}

// ---------------------------------------------------------------------------
// Diagnostic tests — verify Win32 capture mechanisms via SendInput
// Run with: cargo test -p sidearm capture_diag -- --nocapture
// ---------------------------------------------------------------------------

#[cfg(test)]
mod capture_diag {
    use std::mem::MaybeUninit;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, RegisterHotKey, SendInput,
        UnregisterHotKey,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, WM_HOTKEY,
    };

    const VK_F13: u16 = 0x7C;
    const VK_F23: u16 = 0x86;
    const VK_CONTROL: u16 = 0x11;
    const VK_SHIFT: u16 = 0x10;
    const MOD_NOREPEAT: u32 = 0x4000;
    const MOD_CONTROL: u32 = 0x0002;
    const MOD_SHIFT: u32 = 0x0004;

    fn kbd_down(vk: u16) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn kbd_up(vk: u16) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Pump messages and look for WM_HOTKEY within `timeout`.
    fn poll_wm_hotkey(timeout: Duration) -> Option<i32> {
        let start = Instant::now();
        let mut msg = MaybeUninit::<MSG>::zeroed();
        while start.elapsed() < timeout {
            let found = unsafe {
                PeekMessageW(
                    msg.as_mut_ptr(),
                    std::ptr::null_mut(),
                    WM_HOTKEY,
                    WM_HOTKEY,
                    PM_REMOVE,
                )
            };
            if found != 0 {
                let m = unsafe { msg.assume_init() };
                return Some(m.wParam as i32);
            }
            // Also pump other messages (needed for LL hook callbacks)
            let found_any =
                unsafe { PeekMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0, PM_REMOVE) };
            if found_any != 0 {
                let m = unsafe { msg.assume_init() };
                unsafe {
                    DispatchMessageW(&m);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        None
    }

    /// Pump messages to let LL hook callbacks fire.
    fn pump_messages(duration: Duration) {
        let start = Instant::now();
        let mut msg = MaybeUninit::<MSG>::zeroed();
        while start.elapsed() < duration {
            let found =
                unsafe { PeekMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0, PM_REMOVE) };
            if found != 0 {
                let m = unsafe { msg.assume_init() };
                unsafe {
                    DispatchMessageW(&m);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    // The `diag_*` tests are exploratory diagnostics, not unit tests.  They
    // register global hotkeys (F13, Ctrl+Shift+F23) and install LL keyboard
    // hooks on the current process.  Both fail noisily when another instance
    // of Sidearm is running (it already holds those hotkeys), and they don't
    // verify a stable contract — they verify Windows itself.  Keep them in
    // tree for future investigation but mark `#[ignore]` so `cargo test`
    // doesn't run them by default.  Run explicitly with:
    //   cargo test -- --ignored diag_

    #[test]
    #[ignore]
    fn diag_register_hotkey_simple_f13() {
        log::debug!("\n=== TEST: RegisterHotKey + SendInput(F13) ===");
        let id = 8001;
        let ok = unsafe { RegisterHotKey(std::ptr::null_mut(), id, MOD_NOREPEAT, VK_F13 as u32) };
        assert!(
            ok != 0,
            "RegisterHotKey(F13) failed: {}",
            std::io::Error::last_os_error()
        );

        let mut inputs = [kbd_down(VK_F13), kbd_up(VK_F13)];
        let sent =
            unsafe { SendInput(2, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
        log::debug!("  SendInput returned {sent}");

        let received = poll_wm_hotkey(Duration::from_millis(500));
        log::debug!("  WM_HOTKEY received: {:?} (expected Some({id}))", received);

        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };

        assert_eq!(
            received,
            Some(id),
            "RegisterHotKey should catch SendInput(F13)"
        );
    }

    #[test]
    #[ignore]
    fn diag_register_hotkey_ctrl_shift_f23() {
        log::debug!("\n=== TEST: RegisterHotKey + SendInput(Ctrl+Shift+F23) ===");
        let id = 8002;
        let mask = MOD_NOREPEAT | MOD_CONTROL | MOD_SHIFT;
        let ok = unsafe { RegisterHotKey(std::ptr::null_mut(), id, mask, VK_F23 as u32) };
        assert!(
            ok != 0,
            "RegisterHotKey(Ctrl+Shift+F23) failed: {}",
            std::io::Error::last_os_error()
        );

        // Send modifiers then primary (how Razer Synapse does it)
        let mut inputs = [
            kbd_down(VK_CONTROL),
            kbd_down(VK_SHIFT),
            kbd_down(VK_F23),
            kbd_up(VK_F23),
            kbd_up(VK_SHIFT),
            kbd_up(VK_CONTROL),
        ];
        let sent =
            unsafe { SendInput(6, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
        log::debug!("  SendInput returned {sent}");

        let received = poll_wm_hotkey(Duration::from_millis(500));
        log::debug!(
            "  WM_HOTKEY received: {:?} (expected Some({id}) if working)",
            received
        );

        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };

        // This test documents behavior — it may or may not pass depending on system
        if received.is_some() {
            log::debug!("  RESULT: RegisterHotKey CAN catch Ctrl+Shift+F23 via SendInput");
        } else {
            log::debug!("  RESULT: RegisterHotKey CANNOT catch Ctrl+Shift+F23 via SendInput");
        }
    }

    #[test]
    #[ignore]
    fn diag_ll_hook_ctrl_shift_f23() {
        use std::cell::RefCell;
        use windows_sys::Win32::{
            System::LibraryLoader::GetModuleHandleW,
            UI::Input::KeyboardAndMouse::GetAsyncKeyState,
            UI::WindowsAndMessaging::{
                CallNextHookEx, KBDLLHOOKSTRUCT, SetWindowsHookExW, UnhookWindowsHookEx,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
            },
        };

        log::debug!("\n=== TEST: WH_KEYBOARD_LL + SendInput(Ctrl+Shift+F23) ===");

        struct TestHookState {
            hits: Vec<(u32, bool, bool)>, // (vk, ctrl_down, shift_down)
        }

        thread_local! {
            static TEST_HOOK: RefCell<Option<TestHookState>> = const { RefCell::new(None) };
        }

        unsafe extern "system" fn test_hook_proc(
            code: i32,
            w_param: usize,
            l_param: isize,
        ) -> isize {
            if code >= 0 {
                let kb = unsafe { &*(l_param as *const KBDLLHOOKSTRUCT) };
                let msg = w_param as u32;
                if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                    let ctrl = (unsafe { GetAsyncKeyState(0x11) } as u16 & 0x8000) != 0;
                    let shift = (unsafe { GetAsyncKeyState(0x10) } as u16 & 0x8000) != 0;
                    TEST_HOOK.with(|cell| {
                        if let Some(state) = cell.borrow_mut().as_mut() {
                            state.hits.push((kb.vkCode, ctrl, shift));
                        }
                    });
                }
            }
            unsafe { CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param) }
        }

        TEST_HOOK.with(|cell| {
            *cell.borrow_mut() = Some(TestHookState { hits: Vec::new() });
        });

        let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
        log::debug!("  GetModuleHandleW(NULL) = {:?}", hmod);

        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(test_hook_proc), hmod, 0) };
        log::debug!("  SetWindowsHookExW result: {:?} (null=failed)", hook);
        assert!(
            !hook.is_null(),
            "SetWindowsHookExW failed: {}",
            std::io::Error::last_os_error()
        );

        // Send Ctrl+Shift+F23
        let mut inputs = [
            kbd_down(VK_CONTROL),
            kbd_down(VK_SHIFT),
            kbd_down(VK_F23),
            kbd_up(VK_F23),
            kbd_up(VK_SHIFT),
            kbd_up(VK_CONTROL),
        ];
        let sent =
            unsafe { SendInput(6, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
        log::debug!("  SendInput returned {sent}");

        // Pump messages to let hook callbacks fire
        pump_messages(Duration::from_millis(300));

        let hits = TEST_HOOK.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|s| s.hits.clone())
                .unwrap_or_default()
        });

        log::debug!("  Hook received {} key-down events:", hits.len());
        for (vk, ctrl, shift) in &hits {
            let name = match *vk as u16 {
                0x11 => "VK_CONTROL",
                0x10 => "VK_SHIFT",
                0x86 => "VK_F23",
                other => {
                    log::debug!("    vk=0x{other:02X} ctrl={ctrl} shift={shift}");
                    continue;
                }
            };
            log::debug!("    {name} (0x{vk:02X}) ctrl={ctrl} shift={shift}");
        }

        let f23_hit = hits.iter().find(|(vk, _, _)| *vk == VK_F23 as u32);
        if let Some((_, ctrl, shift)) = f23_hit {
            log::debug!("  RESULT: LL hook DID catch F23. ctrl={ctrl}, shift={shift}");
            if *ctrl && *shift {
                log::debug!(
                    "  RESULT: Modifier state CORRECT — LL hook can intercept Ctrl+Shift+F23"
                );
            } else {
                log::debug!("  RESULT: Modifier state WRONG — GetAsyncKeyState unreliable in hook");
            }
        } else {
            log::debug!("  RESULT: LL hook did NOT receive F23 key event at all!");
        }

        unsafe { UnhookWindowsHookEx(hook) };
        TEST_HOOK.with(|cell| {
            *cell.borrow_mut() = None;
        });
    }

    #[test]
    #[ignore]
    fn diag_ll_hook_simple_f13() {
        use std::cell::RefCell;
        use windows_sys::Win32::{
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{
                CallNextHookEx, KBDLLHOOKSTRUCT, SetWindowsHookExW, UnhookWindowsHookEx,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
            },
        };

        log::debug!("\n=== TEST: WH_KEYBOARD_LL + SendInput(F13) ===");

        thread_local! {
            static TEST_HITS: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
        }

        unsafe extern "system" fn test_hook_proc(
            code: i32,
            w_param: usize,
            l_param: isize,
        ) -> isize {
            if code >= 0 {
                let kb = unsafe { &*(l_param as *const KBDLLHOOKSTRUCT) };
                let msg = w_param as u32;
                if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                    TEST_HITS.with(|cell| {
                        cell.borrow_mut().push(kb.vkCode);
                    });
                }
            }
            unsafe { CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param) }
        }

        TEST_HITS.with(|cell| cell.borrow_mut().clear());

        let hmod = unsafe { GetModuleHandleW(std::ptr::null()) };
        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(test_hook_proc), hmod, 0) };
        assert!(
            !hook.is_null(),
            "SetWindowsHookExW failed: {}",
            std::io::Error::last_os_error()
        );

        let mut inputs = [kbd_down(VK_F13), kbd_up(VK_F13)];
        let sent =
            unsafe { SendInput(2, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32) };
        log::debug!("  SendInput returned {sent}");

        pump_messages(Duration::from_millis(300));

        let hits = TEST_HITS.with(|cell| cell.borrow().clone());
        log::debug!("  Hook received {} key-down events: {:?}", hits.len(), hits);

        let f13_hit = hits.contains(&(VK_F13 as u32));
        if f13_hit {
            log::debug!("  RESULT: LL hook CAN catch simple F13 via SendInput");
        } else {
            log::debug!("  RESULT: LL hook CANNOT catch F13 — hook callbacks not firing!");
        }

        unsafe { UnhookWindowsHookEx(hook) };

        assert!(f13_hit, "LL hook should receive F13 keydown from SendInput");
    }
}

// ---------------------------------------------------------------------------
// Property-based edge-case tests — pure logic only, NO Win32 / capture calls
// ---------------------------------------------------------------------------
//
// These tests exercise only the pure helper/decision functions that are safe
// to call without a running OS message loop, open handles, or actual threads.
//
// Skipped (Win32 / capture / spawn):
//  - CaptureBackendHandle::start/stop/rehook — owns threads, channels, handles
//  - flush_expired_pending_modifiers          — calls unsafe replay_modifier_down → SendInput
//  - gc_orphan_replayed_modifiers             — calls GetAsyncKeyState + SendInput
//  - force_release_all_replayed_modifiers     — calls unsafe replay_modifier_up
//  - helper_ll_keyboard_proc                  — extern "system" LL hook callback
//  - inject_mask_key / inject_hook_probe      — unsafe SendInput
//  - run_hotkey_message_loop / run_foreground_watcher / capture_helper_main — spawn / Win32
//  - snapshot_modifier_state                  — calls GetAsyncKeyState

#[cfg(test)]
#[cfg(target_os = "windows")]
mod edge_proptests {
    use super::*;
    use proptest::prelude::*;
    use std::collections::HashMap;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_KEYUP};

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn reset_replayed_state() {
        REPLAYED_AWAITING_UP.with(|c| c.borrow_mut().clear());
        REPLAYED_AWAITING_UP_THRESHOLD.with(|c| {
            c.set(Duration::from_millis(DEFAULT_REPLAYED_AWAITING_UP_MS));
        });
    }

    fn reg(encoded_key: &str, modifiers_mask: u32, primary_vk: u32) -> HelperRegistration {
        HelperRegistration {
            encoded_key: encoded_key.into(),
            modifiers_mask,
            primary_vk,
            wheel: None,
            button: None,
        }
    }

    // Concrete modifier VK codes for generating arbitrary modifier events
    const ALL_MODIFIER_VKS: &[u32] = &[
        VK_CONTROL,
        VK_LCONTROL,
        VK_RCONTROL,
        VK_MENU,
        VK_LMENU,
        VK_RMENU,
        VK_SHIFT,
        VK_LSHIFT,
        VK_RSHIFT,
        VK_LWIN,
        VK_RWIN,
    ];

    // The four MOD_* bits we care about
    const ALL_MOD_BITS: &[u32] = &[MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN];

    // -----------------------------------------------------------------------
    // Category 1: BOUNDARY — HelperModifierState flag coverage
    // -----------------------------------------------------------------------

    proptest! {
        /// Every modifier VK down/up must return `true` and flip exactly the
        /// correct flag; no flag pollution between different modifiers.
        #[test]
        fn prop_apply_vk_event_correct_flag(
            vk_idx in 0..ALL_MODIFIER_VKS.len(),
            is_down in any::<bool>(),
        ) {
            let vk = ALL_MODIFIER_VKS[vk_idx];
            let mut state = HelperModifierState::default();
            let result = state.apply_vk_event(vk, is_down);
            prop_assert!(result, "apply_vk_event must return true for modifier vk={:#04X}", vk);

            let flags = state.as_modifier_flags();
            // If is_down, exactly one MOD_* bit must be set (no more, no less)
            let set_bits: u32 = ALL_MOD_BITS.iter().map(|b| flags & b).sum();
            if is_down {
                prop_assert!(set_bits > 0, "at least one MOD bit must be set after down event");
                prop_assert_eq!(
                    flags.count_ones(), 1,
                    "exactly one MOD bit must be set after a single down event; got flags={:#06X}",
                    flags
                );
            } else {
                prop_assert_eq!(flags, 0u32, "all flags must be clear after up on default state");
            }
        }

        /// Non-modifier VK must return `false` and leave all flags clear.
        #[test]
        fn prop_apply_vk_event_non_modifier_noop(
            // F-keys and letter keys are never modifier VKs
            vk in prop_oneof![0x70u32..=0x87u32, 0x41u32..=0x5Au32],
            is_down in any::<bool>(),
        ) {
            let mut state = HelperModifierState::default();
            let result = state.apply_vk_event(vk, is_down);
            prop_assert!(!result, "non-modifier vk={:#04X} must return false", vk);
            prop_assert_eq!(state.as_modifier_flags(), 0u32);
        }

        /// as_modifier_flags output must be a subset of MOD_MODIFIER_BITS;
        /// no bits outside that mask can ever appear.
        #[test]
        fn prop_modifier_flags_within_known_mask(
            ctrl in any::<bool>(),
            alt in any::<bool>(),
            shift in any::<bool>(),
            win in any::<bool>(),
        ) {
            let state = HelperModifierState { ctrl, alt, shift, win };
            let flags = state.as_modifier_flags();
            prop_assert_eq!(flags & !MOD_MODIFIER_BITS, 0,
                "as_modifier_flags must not set bits outside MOD_MODIFIER_BITS; got {:#010X}", flags);
        }

        /// matches_mask: if mask == 0 (bare key) it must ALWAYS return true,
        /// regardless of which modifiers are held.
        #[test]
        fn prop_matches_mask_zero_always_true(
            ctrl in any::<bool>(),
            alt in any::<bool>(),
            shift in any::<bool>(),
            win in any::<bool>(),
        ) {
            let state = HelperModifierState { ctrl, alt, shift, win };
            prop_assert!(state.matches_mask(0),
                "bare (mask=0) must always match regardless of modifier state");
        }

        /// matches_mask: full-mask (all four MOD bits) must require all four
        /// modifiers to be held.
        #[test]
        fn prop_matches_mask_full_requires_all(
            ctrl in any::<bool>(),
            alt in any::<bool>(),
            shift in any::<bool>(),
            win in any::<bool>(),
        ) {
            let state = HelperModifierState { ctrl, alt, shift, win };
            let result = state.matches_mask(MOD_MODIFIER_BITS);
            let expected = ctrl && alt && shift && win;
            prop_assert_eq!(result, expected,
                "full mask requires all modifiers: ctrl={} alt={} shift={} win={}", ctrl, alt, shift, win);
        }

        /// matches_mask is a superset check: if all required bits are covered,
        /// extra held modifiers must NOT cause a false negative.
        #[test]
        fn prop_matches_mask_superset_allowed(
            mask_bits in 0u32..=0xFu32,  // 4-bit subset of MOD flags
            extra_bits in 0u32..=0xFu32,
        ) {
            // Build a mask from the low 4 bits mapped to MOD constants
            let mask = build_mask_from_nibble(mask_bits);
            let extra = build_mask_from_nibble(extra_bits);
            let current = mask | extra;
            let state = flags_to_state(current);
            // If state covers mask, matches_mask must return true
            if current & mask == mask {
                prop_assert!(state.matches_mask(mask),
                    "superset should match: current={:#06X} mask={:#06X}", current, mask);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Category 1: BOUNDARY — modifier_mask_bit / modifier_in_any_encoding
    // -----------------------------------------------------------------------

    proptest! {
        /// modifier_mask_bit must return 0 for all non-modifier VKs.
        /// Uses F-key range (0x70–0x87) which are never modifiers.
        #[test]
        fn prop_modifier_mask_bit_zero_for_non_modifier(
            vk in 0x70u32..=0x87u32,
        ) {
            prop_assert_eq!(modifier_mask_bit(vk), 0u32,
                "F-key vk={:#04X} must map to mask_bit=0", vk);
        }

        /// modifier_mask_bit must return a nonzero value for every concrete modifier VK.
        #[test]
        fn prop_modifier_mask_bit_nonzero_for_modifier(
            vk_idx in 0..ALL_MODIFIER_VKS.len(),
        ) {
            let vk = ALL_MODIFIER_VKS[vk_idx];
            let bit = modifier_mask_bit(vk);
            prop_assert!(bit != 0,
                "modifier vk={:#04X} must produce nonzero mask_bit", vk);
            // The returned bit must be exactly one of the four known MOD_ constants
            prop_assert!(ALL_MOD_BITS.contains(&bit),
                "mask_bit={:#06X} must be one of the four MOD_* constants", bit);
        }

        /// modifier_in_any_encoding: if registrations list is empty, must be false.
        #[test]
        fn prop_modifier_in_any_encoding_empty_regs(
            vk_idx in 0..ALL_MODIFIER_VKS.len(),
        ) {
            let vk = ALL_MODIFIER_VKS[vk_idx];
            prop_assert!(!modifier_in_any_encoding(vk, &[]),
                "empty registrations → modifier_in_any_encoding must be false");
        }

        /// modifier_in_any_encoding: VK present in at least one reg's mask → true.
        #[test]
        fn prop_modifier_in_any_encoding_hit(
            vk_idx in 0..ALL_MODIFIER_VKS.len(),
        ) {
            let vk = ALL_MODIFIER_VKS[vk_idx];
            let bit = modifier_mask_bit(vk);
            if bit == 0 { return Ok(()); }
            let regs = vec![reg("F13", bit, 0x7C)];
            prop_assert!(modifier_in_any_encoding(vk, &regs),
                "vk={:#04X} bit={:#06X} must be found in registration", vk, bit);
        }

        /// modifier_in_any_encoding: VK whose bit is NOT in any reg → false.
        #[test]
        fn prop_modifier_in_any_encoding_miss(
            vk_idx in 0..ALL_MODIFIER_VKS.len(),
        ) {
            let vk = ALL_MODIFIER_VKS[vk_idx];
            let bit = modifier_mask_bit(vk);
            if bit == 0 { return Ok(()); }
            // Register only the complement bits
            let other_bits = MOD_MODIFIER_BITS & !bit;
            let regs = vec![reg("F13", other_bits, 0x7C)];
            prop_assert!(!modifier_in_any_encoding(vk, &regs),
                "vk={:#04X} bit={:#06X} must NOT be found when reg has only complement bits", vk, bit);
        }
    }

    // -----------------------------------------------------------------------
    // Category 1: BOUNDARY — is_extended_modifier_vk
    // -----------------------------------------------------------------------

    proptest! {
        /// Arbitrary VK input must not panic and must return bool coherently:
        /// only VK_RCONTROL and VK_RMENU should return true.
        #[test]
        fn prop_is_extended_modifier_vk_only_rctrl_rmenu(vk in any::<u32>()) {
            let result = is_extended_modifier_vk(vk);
            let expected = vk == VK_RCONTROL || vk == VK_RMENU;
            prop_assert_eq!(result, expected,
                "is_extended_modifier_vk({:#06X}) = {}, expected {}", vk, result, expected);
        }
    }

    // -----------------------------------------------------------------------
    // Category 2: NULL & EMPTY
    // -----------------------------------------------------------------------

    #[test]
    fn unit_modifier_state_default_all_flags_zero() {
        let state = HelperModifierState::default();
        assert_eq!(
            state.as_modifier_flags(),
            0,
            "default HelperModifierState must produce zero flags"
        );
    }

    #[test]
    fn unit_modifier_in_any_encoding_empty_vec_false() {
        for &vk in ALL_MODIFIER_VKS {
            assert!(
                !modifier_in_any_encoding(vk, &[]),
                "empty regs must always return false for vk={vk:#04X}"
            );
        }
    }

    #[test]
    fn unit_process_helper_key_event_empty_regs_no_suppress() {
        // No registrations — nothing should be suppressed or matched
        let regs: Vec<HelperRegistration> = vec![];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = HashMap::new();
        let mut matches = Vec::new();
        let (suppress, _wake, _mask) = process_helper_key_event(
            &regs,
            &mut modifiers,
            &mut suppressions,
            &mut matches,
            0x7C,
            WM_KEYDOWN,
        );
        assert!(!suppress, "empty regs must not suppress");
        assert!(matches.is_empty(), "empty regs must produce no match");
    }

    #[test]
    fn unit_should_suppress_repeat_empty_map_false() {
        // Empty REPLAYED_AWAITING_UP map → no suppression possible
        let map: HashMap<u32, Instant> = HashMap::new();
        let threshold = Duration::from_secs(3);
        for &vk in ALL_MODIFIER_VKS {
            assert!(
                !should_suppress_repeat_modifier_down(vk, false, &map, Instant::now(), threshold,),
                "empty map must never suppress vk={vk:#04X}"
            );
        }
    }

    #[test]
    fn unit_drain_expired_empty_returns_empty() {
        reset_replayed_state();
        let result = drain_expired_replayed_modifiers();
        assert!(
            result.is_empty(),
            "draining empty map must return empty vec"
        );
    }

    #[test]
    fn unit_take_all_replayed_empty_returns_empty() {
        reset_replayed_state();
        let result = take_all_replayed_modifiers();
        assert!(result.is_empty());
    }

    // -----------------------------------------------------------------------
    // Category 3: OVERFLOW — key point: register_hotkey_mask bit arithmetic
    //   The MOD_* constants are u32; OR-ing four u32 flags can at most produce
    //   MOD_MODIFIER_BITS = 0x000F | MOD_NOREPEAT = 0x4000 → 0x400F.
    //   There is NO multiplication path in this file that could overflow u32.
    //   (Screen-pixel buffers are not present here.)
    //   We verify: the result never exceeds 0x4000 | 0x000F regardless of
    //   arbitrary boolean inputs.
    // -----------------------------------------------------------------------

    proptest! {
        /// register_hotkey_mask result must be bounded — at most
        /// MOD_NOREPEAT | MOD_MODIFIER_BITS; never sets unknown bits.
        #[test]
        fn prop_register_hotkey_mask_bounded(
            ctrl in any::<bool>(),
            alt in any::<bool>(),
            shift in any::<bool>(),
            win in any::<bool>(),
        ) {
            use crate::hotkeys::HotkeyModifiers;
            let mods = HotkeyModifiers { ctrl, alt, shift, win };
            let mask = register_hotkey_mask(&mods);
            let allowed = MOD_NOREPEAT | MOD_MODIFIER_BITS;
            prop_assert_eq!(mask & !allowed, 0,
                "register_hotkey_mask must not set bits outside allowed mask; got mask={:#010X}", mask);
            // MOD_NOREPEAT must always be set
            prop_assert_ne!(mask & MOD_NOREPEAT, 0,
                "MOD_NOREPEAT must always be set in register_hotkey_mask");
        }

        /// as_modifier_flags applied to arbitrary flag combos must not overflow u32
        /// beyond the four known MOD bits and must be idempotent: flags_to_state →
        /// as_modifier_flags → flags must round-trip through the 4-bit mask.
        #[test]
        fn prop_modifier_flags_round_trip_4bit(bits in 0u32..=0xFu32) {
            let flags = build_mask_from_nibble(bits);
            let state = flags_to_state(flags);
            let reconstructed = state.as_modifier_flags();
            prop_assert_eq!(reconstructed, flags,
                "round-trip failed: bits={:#06b} flags={:#06X} reconstructed={:#06X}", bits, flags, reconstructed);
        }

        /// modifier_mask_bit must only return values that are strict subsets of
        /// MOD_MODIFIER_BITS — ensures no unexpected bit is ever returned.
        #[test]
        fn prop_modifier_mask_bit_subset_of_modifier_bits(vk in any::<u32>()) {
            let bit = modifier_mask_bit(vk);
            prop_assert_eq!(bit & !MOD_MODIFIER_BITS, 0,
                "modifier_mask_bit({:#06X})={:#06X} must be subset of MOD_MODIFIER_BITS", vk, bit);
        }
    }

    // -----------------------------------------------------------------------
    // Category 4: CONCURRENCY — bounded-channel capacity invariant
    //   The bounded mpsc::sync_channel is created inside CaptureBackendHandle::start
    //   (a spawning function we cannot call).  We therefore test the CAPACITY
    //   CONSTANT directly and verify that the stated invariant (capacity chosen
    //   to bound memory) is not accidentally changed to an unbounded value.
    // -----------------------------------------------------------------------

    // Deliberate const range-guard: clippy flags the always-true asserts, but that
    // is the point — they fail the build if the const is later edited out of range.
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn unit_capture_event_channel_capacity_is_bounded_and_reasonable() {
        // CAPTURE_EVENT_CAPACITY is now a module-level const, so this test
        // references the real production value by name — a change to an
        // unbounded sentinel or zero is caught here. Assert range [1, 1_000_000].
        assert!(
            CAPTURE_EVENT_CAPACITY >= 1,
            "channel capacity must be at least 1 (nonzero)"
        );
        assert!(
            CAPTURE_EVENT_CAPACITY <= 1_000_000,
            "channel capacity {} is suspiciously large — OOM risk",
            CAPTURE_EVENT_CAPACITY
        );
        // Sanity: ~10 µs per event × 10k events = 100ms of burst headroom
        // without the worker being stalled = reasonable bound
        let approx_bytes_per_event: usize = 200; // EncodedKeyEvent is ~80 bytes; 200 is conservative
        let max_memory = CAPTURE_EVENT_CAPACITY * approx_bytes_per_event;
        assert!(
            max_memory < 4 * 1024 * 1024,
            "bounded channel memory footprint {max_memory} bytes must be < 4 MB"
        );
    }

    proptest! {
        /// Simulate N producers and a slow consumer through a real bounded
        /// sync_channel.  Senders must block (not panic/OOM) once capacity
        /// is reached.  We use capacity=4 (small but exercisable without a
        /// real Sidearm runtime) and verify:
        ///  - total sent ≤ N (some may block → try_send)
        ///  - receiver drains exactly what was sent
        ///  - channel never holds more than capacity items simultaneously
        #[test]
        fn prop_sync_channel_bounded_no_oom(
            capacity in 1usize..=8usize,
            send_count in 0usize..=16usize,
        ) {
            use std::sync::mpsc;
            let (tx, rx) = mpsc::sync_channel::<u32>(capacity);

            let mut sent = 0usize;
            for i in 0u32..(send_count as u32) {
                match tx.try_send(i) {
                    Ok(()) => sent += 1,
                    Err(mpsc::TrySendError::Full(_)) => break, // backpressure fired
                    Err(mpsc::TrySendError::Disconnected(_)) => break,
                }
            }

            // Drain everything the receiver side can see
            let mut received = 0usize;
            while rx.try_recv().is_ok() {
                received += 1;
            }

            prop_assert_eq!(sent, received,
                "all sent items must be receivable: sent={} received={}", sent, received);
            // At no point did the in-flight count exceed capacity (we only
            // ever sent try_send; once Full the loop breaks).
            prop_assert!(sent <= capacity,
                "sent={} must not exceed capacity={}", sent, capacity);
        }
    }

    // -----------------------------------------------------------------------
    // Category 5: TEMPORAL — should_suppress_repeat_modifier_down timing
    // -----------------------------------------------------------------------

    proptest! {
        /// At age == threshold the function must return false (strict less-than).
        /// At age just below threshold it must return true.
        #[test]
        fn prop_suppress_repeat_strict_lt_threshold(
            threshold_ms in 1u64..=10_000u64,
            vk_idx in 0..ALL_MODIFIER_VKS.len(),
        ) {
            let vk = ALL_MODIFIER_VKS[vk_idx];
            let threshold = Duration::from_millis(threshold_ms);
            let now = Instant::now();

            // Age == threshold → NOT suppressed (strict `<` boundary)
            let mut map = HashMap::new();
            map.insert(vk, now - threshold);
            prop_assert!(
                !should_suppress_repeat_modifier_down(vk, false, &map, now, threshold),
                "age == threshold must NOT suppress (boundary: age={}ms)", threshold_ms
            );

            // Age == threshold - 1ms → suppressed
            if threshold_ms >= 1 {
                map.insert(vk, now - threshold + Duration::from_millis(1));
                prop_assert!(
                    should_suppress_repeat_modifier_down(vk, false, &map, now, threshold),
                    "age just below threshold must suppress (age={}ms threshold={}ms)",
                    threshold_ms - 1, threshold_ms
                );
            }
        }

        /// External injection must ALWAYS return false, regardless of VK,
        /// threshold, or age — tests the first guard in the function.
        #[test]
        fn prop_suppress_repeat_external_injection_never_suppressed(
            vk_idx in 0..ALL_MODIFIER_VKS.len(),
            age_ms in 0u64..=1_000u64,
            threshold_ms in 1u64..=10_000u64,
        ) {
            let vk = ALL_MODIFIER_VKS[vk_idx];
            let threshold = Duration::from_millis(threshold_ms);
            let now = Instant::now();
            let mut map = HashMap::new();
            // Insert a fresh entry so the VK is present
            map.insert(vk, now - Duration::from_millis(age_ms));
            prop_assert!(
                !should_suppress_repeat_modifier_down(vk, true, &map, now, threshold),
                "externally injected event must never be suppressed"
            );
        }

        /// drain_expired_replayed_modifiers timing: age >= threshold → drained.
        #[test]
        fn prop_drain_expired_age_vs_threshold(
            age_ms in 0u64..=10_000u64,
            threshold_ms in 1u64..=10_000u64,
        ) {
            reset_replayed_state();
            const VK_TEST: u32 = VK_LCONTROL;
            let threshold = Duration::from_millis(threshold_ms);
            REPLAYED_AWAITING_UP_THRESHOLD.with(|c| c.set(threshold));

            let now = Instant::now();
            REPLAYED_AWAITING_UP.with(|cell| {
                cell.borrow_mut().insert(VK_TEST, now - Duration::from_millis(age_ms));
            });

            let expired = drain_expired_replayed_modifiers();
            let was_drained = expired.iter().any(|(vk, _)| *vk == VK_TEST);
            let expected_drained = age_ms >= threshold_ms;

            prop_assert_eq!(
                was_drained, expected_drained,
                "age={}ms threshold={}ms: expected_drained={}", age_ms, threshold_ms, expected_drained
            );

            // Cleanup: ensure thread-local is clean for next test
            REPLAYED_AWAITING_UP.with(|c| c.borrow_mut().clear());
        }
    }

    // -----------------------------------------------------------------------
    // Category 3+1: OVERFLOW — process_helper_key_event suppression map
    //   The `suppressions` map grows by at most one entry per key-down and
    //   shrinks on key-up.  Verify it never grows unboundedly for a bounded
    //   set of keys even under adversarial repeated down events.
    // -----------------------------------------------------------------------

    proptest! {
        /// With N distinct VKs, the suppressions map must never hold more than N
        /// entries (one per VK), regardless of how many down events are fired.
        #[test]
        fn prop_suppressions_map_bounded_by_vk_count(
            repeat_count in 1usize..=20usize,
        ) {
            // Register 3 distinct F-keys with different modifier masks
            let regs = vec![
                reg("F13",       0,                     0x7C),
                reg("Ctrl+F14",  MOD_CONTROL,           0x7D),
                reg("Shift+F15", MOD_SHIFT,             0x7E),
            ];
            let mut modifiers = HelperModifierState { ctrl: true, shift: true, alt: false, win: false };
            let mut suppressions: HashMap<u32, String> = HashMap::new();
            let mut matches = Vec::new();

            // Fire repeat_count down events for each key
            for _ in 0..repeat_count {
                for &vk in &[0x7Cu32, 0x7Du32, 0x7Eu32] {
                    let _ = process_helper_key_event(
                        &regs, &mut modifiers, &mut suppressions, &mut matches, vk, WM_KEYDOWN,
                    );
                }
            }

            // Suppressions map must be bounded by distinct VK count (3)
            prop_assert!(suppressions.len() <= 3,
                "suppressions map grew to {} entries; expected ≤ 3", suppressions.len());
        }

        /// After a down+up cycle for every registered key, suppressions map
        /// must be empty — no orphan entries leak across cycles.
        #[test]
        fn prop_suppressions_map_cleared_after_up(
            ctrl in any::<bool>(),
            shift in any::<bool>(),
        ) {
            // Use bare F13 (no modifier needed) for simplicity
            let regs = vec![reg("F13", 0, 0x7C)];
            let mut modifiers = HelperModifierState { ctrl, shift, alt: false, win: false };
            let mut suppressions: HashMap<u32, String> = HashMap::new();
            let mut matches = Vec::new();

            // Down
            let _ = process_helper_key_event(
                &regs, &mut modifiers, &mut suppressions, &mut matches, 0x7C, WM_KEYDOWN,
            );
            prop_assert_eq!(suppressions.len(), 1, "one suppression entry after key-down");

            // Up
            let _ = process_helper_key_event(
                &regs, &mut modifiers, &mut suppressions, &mut matches, 0x7C, WM_KEYUP,
            );
            prop_assert!(suppressions.is_empty(),
                "suppressions map must be empty after matching key-up");
        }
    }

    // -----------------------------------------------------------------------
    // Category 3: OVERFLOW — specific unit tests for arithmetic safety
    // -----------------------------------------------------------------------

    #[test]
    fn unit_mod_modifier_bits_no_overflow() {
        // Verify MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WIN fits cleanly
        // in u32 without truncation and equals the constant used in the code.
        let computed: u32 = MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WIN;
        assert_eq!(
            computed, MOD_MODIFIER_BITS,
            "MOD_MODIFIER_BITS constant must equal the OR of all four modifier bits"
        );
        // Ensure no high-bit contamination
        assert_eq!(
            computed & 0xFFFF_0000,
            0,
            "modifier bit mask must fit in low 16 bits"
        );
    }

    // Deliberate const range-guard (see note above): asserts catch a future edit
    // that pushes these thresholds out of the sane millisecond range.
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn unit_default_thresholds_within_sane_range() {
        // DEFAULT_CONSUMED_MODIFIER_STALE_MS and DEFAULT_REPLAYED_AWAITING_UP_MS
        // are used as Duration::from_millis arguments.  A value of u64::MAX would
        // effectively disable the GC; 0 would fire every cycle.
        assert!(
            DEFAULT_CONSUMED_MODIFIER_STALE_MS > 0,
            "stale-GC threshold must be nonzero (>0 ms)"
        );
        assert!(
            DEFAULT_CONSUMED_MODIFIER_STALE_MS <= 60_000,
            "stale-GC threshold {}ms is unreasonably large (>60s)",
            DEFAULT_CONSUMED_MODIFIER_STALE_MS
        );
        assert!(
            DEFAULT_REPLAYED_AWAITING_UP_MS > 0,
            "replayed-up threshold must be nonzero"
        );
        assert!(
            DEFAULT_REPLAYED_AWAITING_UP_MS <= 60_000,
            "replayed-up threshold {}ms is unreasonably large (>60s)",
            DEFAULT_REPLAYED_AWAITING_UP_MS
        );
        // Replayed threshold < stale threshold is the expected ordering:
        // orphan-GC fires before the consumed-GC removes the matching entry,
        // preventing a stuck-modifier window from spanning the full stale window.
        assert!(
            DEFAULT_REPLAYED_AWAITING_UP_MS < DEFAULT_CONSUMED_MODIFIER_STALE_MS,
            "replayed-up threshold should be shorter than consumed-stale threshold to bound stuck-key window"
        );
    }

    #[test]
    fn unit_consumed_freshness_window_shorter_than_stale_threshold() {
        // CONSUMED_MODIFIER_FRESHNESS_WINDOW is the per-event tight guard.
        // It must be strictly shorter than the GC threshold to avoid a race
        // where the tight guard fires AND the stale GC also fires on the same entry.
        let freshness_ms = CONSUMED_MODIFIER_FRESHNESS_WINDOW.as_millis() as u64;
        assert!(freshness_ms > 0, "freshness window must be nonzero");
        assert!(
            freshness_ms < DEFAULT_CONSUMED_MODIFIER_STALE_MS,
            "freshness window {freshness_ms}ms must be < stale threshold {}ms",
            DEFAULT_CONSUMED_MODIFIER_STALE_MS
        );
        // Also check Razer chord window is shorter than freshness window:
        // chord detection fires first, then consumed suppression, then GC.
        let chord_ms = RAZER_ENCODING_CHORD_WINDOW.as_millis() as u64;
        assert!(
            chord_ms < freshness_ms,
            "Razer chord window {chord_ms}ms must be < consumed freshness window {freshness_ms}ms"
        );
    }

    // -----------------------------------------------------------------------
    // Helpers for proptest generators
    // -----------------------------------------------------------------------

    /// Map a 4-bit nibble to a combination of the four MOD_ constants.
    fn build_mask_from_nibble(bits: u32) -> u32 {
        let mut mask = 0u32;
        if bits & 1 != 0 {
            mask |= MOD_ALT;
        }
        if bits & 2 != 0 {
            mask |= MOD_CONTROL;
        }
        if bits & 4 != 0 {
            mask |= MOD_SHIFT;
        }
        if bits & 8 != 0 {
            mask |= MOD_WIN;
        }
        mask
    }

    /// Convert a MOD_* flags value back to a HelperModifierState.
    fn flags_to_state(flags: u32) -> HelperModifierState {
        HelperModifierState {
            ctrl: flags & MOD_CONTROL != 0,
            alt: flags & MOD_ALT != 0,
            shift: flags & MOD_SHIFT != 0,
            win: flags & MOD_WIN != 0,
        }
    }
}
