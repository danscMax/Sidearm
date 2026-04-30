use serde::{Deserialize, Serialize};
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
};
use tauri::{AppHandle, Emitter};

use super::{process_encoded_key_event, EncodedKeyEvent, CAPTURE_BACKEND_NAME};
use crate::{
    config::AppConfig,
    hotkeys,
    runtime::{self, RuntimeStore, EVENT_PROFILE_RESOLVED},
    window_capture,
};

const BACKEND_LL_HOOK: &str = "windows-ll-hook";

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
    if mods.alt { mask |= MOD_ALT; }
    if mods.ctrl { mask |= MOD_CONTROL; }
    if mods.shift { mask |= MOD_SHIFT; }
    if mods.win { mask |= MOD_WIN; }
    mask
}

const VK_SHIFT: u32 = 0x10;
const VK_CONTROL: u32 = 0x11;
const VK_MENU: u32 = 0x12;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;

/// "Menu Mask Key" — an unassigned VK used to prevent Windows from activating
/// menus/ribbon (SC_KEYMENU) or the Start menu when Alt or Win is released
/// after a hotkey combo.  Injecting this between modifier-down and modifier-up
/// makes DefWindowProc think a non-modifier key was pressed, suppressing the
/// system activation.  Pattern borrowed from AutoHotkey v2.
const VK_MASK_KEY: u16 = 0xE8;

/// dwExtraInfo marker for hook health probe events.  Distinct from
/// `INTERNAL_SENDINPUT_EXTRA_INFO` so the hook callback can tell them apart.
const HOOK_PROBE_EXTRA_INFO: usize = 0x4E41_4741_5052_4F42usize;

/// VK used for probe injection (same unassigned key as the mask key).
const VK_PROBE_KEY: u16 = 0xE8;

/// How often the health monitor checks (milliseconds).
const HOOK_HEALTH_CHECK_INTERVAL_MS: u32 = 5000;

/// How many consecutive probe failures required before reinstalling the hook.
/// A single failed probe can be caused by UIPI blocking SendInput (e.g. an
/// elevated window is in the foreground), not necessarily a dead hook.
const HOOK_PROBE_FAIL_THRESHOLD: u32 = 3;

// Thread-local state for the capture helper's LL keyboard hook callback.
thread_local! {
    static HELPER_REGISTRATIONS: std::cell::RefCell<Vec<HelperRegistration>> =
        std::cell::RefCell::new(Vec::new());
    static HELPER_MODIFIERS: std::cell::RefCell<HelperModifierState> =
        std::cell::RefCell::new(HelperModifierState::default());
    static HELPER_SUPPRESSIONS: std::cell::RefCell<std::collections::HashMap<u32, String>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static HELPER_MATCHES: std::cell::RefCell<Vec<String>> =
        std::cell::RefCell::new(Vec::new());
    static HELPER_THREAD_ID: std::cell::Cell<u32> = std::cell::Cell::new(0);
    /// Set to `true` by the hook callback when it receives a probe event
    /// (dwExtraInfo == HOOK_PROBE_EXTRA_INFO).  Consumed by the health monitor.
    static HELPER_PROBE_RECEIVED: std::cell::Cell<bool> = std::cell::Cell::new(false);
    /// Set to `true` by the hook callback on ANY invocation (real key or probe).
    /// Consumed (replaced with `false`) by the health monitor each cycle.
    /// When `true`, the hook is demonstrably alive — no probe needed.
    static HOOK_HAD_CALLBACK: std::cell::Cell<bool> = std::cell::Cell::new(false);

    /// Buffered modifier-down events waiting for an F-key match.
    /// If an F-key match arrives within the timeout, these were Razer encoding
    /// and should stay suppressed. If timeout expires, replay them via SendInput.
    static PENDING_MODIFIERS: std::cell::RefCell<Vec<PendingModifier>> =
        std::cell::RefCell::new(Vec::new());

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
    foreground_watcher_thread_id: Option<u32>,
    foreground_watcher_thread: Option<JoinHandle<()>>,
}

struct HelperHandle {
    stdin_pipe: std::process::ChildStdin,
    child: std::process::Child,
    reader_thread: JoinHandle<()>,
}

impl HelperHandle {
    fn send_command(&mut self, cmd: &str) -> Result<(), String> {
        use std::io::Write;
        writeln!(self.stdin_pipe, "{cmd}")
            .and_then(|()| self.stdin_pipe.flush())
            .map_err(|e| format!("Failed to send command to helper: {e}"))
    }
}

#[derive(Clone)]
struct RegisteredHotkey {
    id: i32,
    encoded_key: String,
    modifiers_mask: u32,
    primary_vk: u32,
}

/// IPC registration sent from the main process to the capture helper.
#[derive(Clone, Serialize, Deserialize)]
struct HelperRegistration {
    encoded_key: String,
    modifiers_mask: u32,
    primary_vk: u32,
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

#[derive(Clone, Copy)]
struct PendingModifier {
    vk: u32,
    scan: u32,
    #[allow(dead_code)] // stored for potential future use (e.g. extended-key flag replay)
    flags: u32,
    buffered_at: std::time::Instant,
}

/// Returns true if this modifier VK code appears in any registered hotkey's
/// modifier mask. Only these modifiers should be buffered.
fn modifier_in_any_encoding(vk: u32, regs: &[HelperRegistration]) -> bool {
    let mask_bit = match vk {
        VK_MENU | VK_LMENU | VK_RMENU => MOD_ALT,
        VK_CONTROL | VK_LCONTROL | VK_RCONTROL => MOD_CONTROL,
        VK_SHIFT | VK_LSHIFT | VK_RSHIFT => MOD_SHIFT,
        VK_LWIN | VK_RWIN => MOD_WIN,
        _ => return false,
    };
    regs.iter().any(|r| r.modifiers_mask & mask_bit != 0)
}

/// Replay a buffered modifier-down event via SendInput.
/// Uses INTERNAL_SENDINPUT_EXTRA_INFO so our LL hook recognizes replayed
/// events and passes them through without re-buffering.
unsafe fn replay_modifier_down(vk: u32, scan: u32) {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    };
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk as u16,
                wScan: scan as u16,
                dwFlags: 0,
                time: 0,
                dwExtraInfo: crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
            },
        },
    };
    SendInput(1, &input, size_of::<INPUT>() as i32);
}

/// Replay a complete down+up tap for a modifier via SendInput.  Used by the
/// solo-tap path (Case C2): the user's real key-up has already arrived but
/// the original key-down is still buffered.  We can't just replay the down
/// and let the real up pass through — SendInput queues the down at the END
/// of the input queue, so the OS would process up first (no-op) then down
/// (Ctrl held).  Replaying both keeps the events in the right order; the
/// caller suppresses the real up event.
unsafe fn replay_modifier_tap(vk: u32, scan: u32) {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };
    let make = |key_up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk as u16,
                wScan: scan as u16,
                dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
            },
        },
    };
    let inputs = [make(false), make(true)];
    SendInput(2, inputs.as_ptr(), size_of::<INPUT>() as i32);
}

/// Force-release a modifier via SendInput key-up.  Used by orphan-replay GC
/// and by teardown/REHOOK/health-reinstall to balance any prior
/// `replay_modifier_down` whose matching real-up was lost.
///
/// Carries `INTERNAL_SENDINPUT_EXTRA_INFO` so our own LL hook recognises
/// the event and passes it through without buffering.
unsafe fn replay_modifier_up(vk: u32, scan: u32) {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk as u16,
                wScan: scan as u16,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
            },
        },
    };
    SendInput(1, &input, size_of::<INPUT>() as i32);
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
        std::cell::Cell::new(std::time::Duration::from_millis(
            DEFAULT_CONSUMED_MODIFIER_STALE_MS,
        ));

    /// Active threshold for force-releasing orphan replayed modifiers.
    /// Set from stdin init payload; defaults to compile-time default.
    static REPLAYED_AWAITING_UP_THRESHOLD: std::cell::Cell<std::time::Duration> =
        std::cell::Cell::new(std::time::Duration::from_millis(
            DEFAULT_REPLAYED_AWAITING_UP_MS,
        ));

    /// Re-entrancy guard: set to `true` while `flush_expired_pending_modifiers`
    /// is between inserting into `REPLAYED_AWAITING_UP` and the matching
    /// SendInput call returning.  During this window a re-entrant LL hook
    /// callback (delivering a *real* physical event mid-SendInput) must NOT
    /// remove the just-inserted entry via the fresh-down clearing path —
    /// otherwise the injected key-down stays in the OS unbalanced.
    ///
    /// Cleared at the end of flush.  Read by the fresh-down clearing site to
    /// short-circuit `REPLAYED_AWAITING_UP.remove(&vk)` while flushing.
    static FLUSHING_REPLAYED: std::cell::Cell<bool> = std::cell::Cell::new(false);
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
        unsafe { replay_modifier_down(pm.vk, pm.scan); }
    }

    FLUSHING_REPLAYED.with(|cell| cell.set(false));

    HELPER_MATCHES.with(|mc| {
        let mut buf = mc.borrow_mut();
        buf.push(format!(
            "DEBUG:mod-replay timeout vks={:?}",
            replayed_vks,
        ));
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
/// Called from the message pump loop alongside `gc_stale_consumed_modifiers`.
fn gc_orphan_replayed_modifiers() {
    let expired = drain_expired_replayed_modifiers();

    if expired.is_empty() {
        return;
    }
    snapshot_modifier_state("before-orphan-gc");
    for (vk, age_ms) in &expired {
        let os_down = unsafe {
            (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(*vk as i32)
                as u16
                & 0x8000)
                != 0
        };
        if os_down {
            // scan=0 — we don't have the original buffered scan code at this
            // point, and Windows accepts wVk-only key-up for modifier VKs.
            unsafe { replay_modifier_up(*vk, 0); }
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
    let pending: Vec<u32> = PENDING_MODIFIERS.with(|cell| {
        cell.borrow().iter().map(|pm| pm.vk).collect()
    });
    let consumed: Vec<u32> = CONSUMED_MODIFIER_VKS.with(|cell| {
        cell.borrow().keys().copied().collect()
    });
    let replayed: Vec<u32> = REPLAYED_AWAITING_UP.with(|cell| {
        cell.borrow().keys().copied().collect()
    });
    let helper_state = HELPER_MODIFIERS.with(|cell| *cell.borrow());

    let probe = |vk: u32| -> bool {
        unsafe {
            (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk as i32)
                as u16
                & 0x8000)
                != 0
        }
    };
    let os_lctrl  = probe(VK_LCONTROL);
    let os_rctrl  = probe(VK_RCONTROL);
    let os_lmenu  = probe(VK_LMENU);
    let os_rmenu  = probe(VK_RMENU);
    let os_lshift = probe(VK_LSHIFT);
    let os_rshift = probe(VK_RSHIFT);
    let os_lwin   = probe(VK_LWIN);
    let os_rwin   = probe(VK_RWIN);

    HELPER_MATCHES.with(|cell| {
        cell.borrow_mut().push(format!(
            "DEBUG:state-snapshot reason={reason} pending={pending:?} consumed={consumed:?} \
             replayed={replayed:?} helper={{ctrl:{} alt:{} shift:{} win:{}}} \
             os={{LCtrl:{} RCtrl:{} LAlt:{} RAlt:{} LShift:{} RShift:{} LWin:{} RWin:{}}}",
            helper_state.ctrl, helper_state.alt, helper_state.shift, helper_state.win,
            os_lctrl, os_rctrl, os_lmenu, os_rmenu, os_lshift, os_rshift, os_lwin, os_rwin,
        ));
    });
}

/// Drain ALL entries from `REPLAYED_AWAITING_UP`, returning the VKs.  Pure
/// state manipulation — no SendInput.  Split out for unit tests.
fn take_all_replayed_modifiers() -> Vec<u32> {
    REPLAYED_AWAITING_UP.with(|cell| {
        cell.borrow_mut().drain().map(|(vk, _)| vk).collect()
    })
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
        unsafe { replay_modifier_up(*vk, 0); }
    }
    HELPER_MATCHES.with(|mc| {
        mc.borrow_mut().push(format!(
            "DEBUG:mod-replayed-force-release-all reason={reason} count={} vks={:?}",
            entries.len(),
            entries,
        ));
    });
}

impl CaptureBackendHandle {
    pub(super) fn start(
        app: AppHandle,
        runtime_store: Arc<Mutex<RuntimeStore>>,
        config: AppConfig,
        app_name: String,
    ) -> Result<Self, String> {
        let registrations = build_hotkey_registrations(&config)?;
        let (event_tx, event_rx) = mpsc::channel::<EncodedKeyEvent>();
        let helper_event_tx = event_tx.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

        let worker_app = app.clone();
        let worker_runtime_store = runtime_store.clone();
        let worker_config = config.clone();
        let worker_app_name = app_name.clone();
        let worker_thread = thread::spawn(move || {
            use std::sync::mpsc::RecvTimeoutError;
            use std::time::{Duration, Instant};

            let mut held_actions: std::collections::HashMap<String, crate::input_synthesis::HeldShortcutState> =
                std::collections::HashMap::new();
            // Track when we last observed a capture event for each held
            // encoding.  If we stop hearing from an encoding for this long
            // while it is still marked held, the capture pipeline has lost
            // the matching key-up (e.g. the helper subprocess crashed) and
            // we force-release to recover.
            let mut held_last_seen: std::collections::HashMap<String, Instant> =
                std::collections::HashMap::new();
            const HOLD_STALE_THRESHOLD: Duration = Duration::from_secs(2);
            const POLL_INTERVAL: Duration = Duration::from_millis(500);

            loop {
                match event_rx.recv_timeout(POLL_INTERVAL) {
                    Ok(event) => {
                        let encoded_key = event.encoded_key.clone();
                        process_encoded_key_event(
                            &worker_app,
                            &worker_runtime_store,
                            &worker_config,
                            &worker_app_name,
                            event,
                            &mut held_actions,
                        );
                        if held_actions.contains_key(&encoded_key) {
                            held_last_seen.insert(encoded_key, Instant::now());
                        } else {
                            held_last_seen.remove(&encoded_key);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
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
                            if let Some(held) = held_actions.remove(&key) {
                                log::warn!(
                                    "[capture] Force-releasing stale hold for `{key}` \
                                     (no key-up within {:?})",
                                    HOLD_STALE_THRESHOLD,
                                );
                                if let Err(e) = crate::input_synthesis::send_shortcut_hold_up(&held) {
                                    log::warn!(
                                        "[capture] Force-release failed for `{key}`: {e}"
                                    );
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
                    log::warn!("[capture] Failed to release held shortcut `{encoded_key}` on shutdown: {e}");
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
        let modifier_stale_gc_ms = config.settings.modifier_stale_gc_ms;
        let replayed_modifier_force_release_ms = config.settings.replayed_modifier_force_release_ms;
        let helper = spawn_capture_helper(
            &registrations,
            helper_event_tx,
            modifier_stale_gc_ms,
            replayed_modifier_force_release_ms,
        );
        if !registrations.is_empty() && helper.is_none() {
            if let Ok(mut store) = runtime_store.lock() {
                store.record_warn(
                    "перехват",
                    "Не удалось запустить вспомогательный процесс перехвата. \
                     Кнопки с зажатыми модификаторами (Ctrl/Shift) могут не срабатывать.",
                );
            }
        }

        // Spawn foreground window watcher — detects window switches instantly
        let fg_app = app.clone();
        let fg_runtime_store = runtime_store.clone();
        let fg_config = config.clone();
        let fg_app_name = app_name.clone();
        let (fg_ready_tx, fg_ready_rx) = mpsc::channel::<u32>();
        let foreground_watcher_thread = thread::spawn(move || {
            run_foreground_watcher(fg_app, fg_runtime_store, fg_config, fg_app_name, fg_ready_tx);
        });
        let foreground_watcher_thread_id = fg_ready_rx.recv().ok();

        Ok(Self {
            hook_thread_id,
            hook_thread,
            worker_thread,
            helper,
            foreground_watcher_thread_id,
            foreground_watcher_thread: Some(foreground_watcher_thread),
        })
    }

    pub(super) fn stop(self) -> Result<(), String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};

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
            } = helper;
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

        self.hook_thread
            .join()
            .map_err(|_| "Capture hook thread panicked.".to_owned())?;
        self.worker_thread
            .join()
            .map_err(|_| "Capture worker thread panicked.".to_owned())?;
        if let Some(fg_thread) = self.foreground_watcher_thread {
            let _ = fg_thread.join();
        }
        Ok(())
    }

    pub(super) fn rehook(&mut self) -> Result<(), String> {
        if let Some(ref mut helper) = self.helper {
            helper.send_command("REHOOK")
        } else {
            Err("No capture helper process is running.".to_owned())
        }
    }
}

fn build_hotkey_registrations(config: &AppConfig) -> Result<Vec<RegisteredHotkey>, String> {
    let mut registrations = Vec::with_capacity(config.encoder_mappings.len());
    for (index, mapping) in config.encoder_mappings.iter().enumerate() {
        let hotkey = hotkeys::parse_hotkey(&mapping.encoded_key).map_err(|message| {
            format!(
                "Failed to register encodedKey `{}` for `{}::{}`: {}",
                mapping.encoded_key,
                mapping.control_id.as_str(),
                mapping.layer.as_str(),
                message
            )
        })?;

        registrations.push(RegisteredHotkey {
            id: (index + 1) as i32,
            encoded_key: hotkey.canonical,
            modifiers_mask: register_hotkey_mask(&hotkey.modifiers),
            primary_vk: u32::from(hotkey.key.code),
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
                    matches.push(format!("REPEAT:{}", winner.encoded_key));
                } else {
                    matches.push(winner.encoded_key.clone());
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
                matches.push(format!("UP:{encoded_key}"));
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
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };

    let make_input = |key_up: bool| -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_MASK_KEY,
                    wScan: 0,
                    dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO,
                },
            },
        }
    };

    let inputs = [make_input(false), make_input(true)];
    SendInput(
        inputs.len() as u32,
        inputs.as_ptr(),
        size_of::<INPUT>() as i32,
    );
}

/// Inject a VK 0xE8 probe event via SendInput to test hook health.
/// The event carries `HOOK_PROBE_EXTRA_INFO` so the hook callback can
/// recognize it and set the `HELPER_PROBE_RECEIVED` flag without treating
/// it as a real key event.
///
/// Returns `true` if SendInput accepted the events, `false` if injection
/// failed (e.g. UIPI blocked it because an elevated window is focused).
unsafe fn inject_hook_probe() -> bool {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };

    let make_input = |key_up: bool| -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_PROBE_KEY,
                    wScan: 0,
                    dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: HOOK_PROBE_EXTRA_INFO,
                },
            },
        }
    };

    let inputs = [make_input(false), make_input(true)];
    let inserted = SendInput(
        inputs.len() as u32,
        inputs.as_ptr(),
        size_of::<INPUT>() as i32,
    );
    if inserted == 0 {
        log::debug!(
            "[capture-helper] SendInput probe failed (UIPI?): {}",
            std::io::Error::last_os_error()
        );
    }
    inserted > 0
}

/// LL keyboard hook callback for the capture helper process.
/// Matches modifier+F-key combos and buffers the encoded key in HELPER_MATCHES.
unsafe extern "system" fn helper_ll_keyboard_proc(
    code: i32,
    w_param: usize,
    l_param: isize,
) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, PostThreadMessageW, KBDLLHOOKSTRUCT,
    };

    if code >= 0 {
        // Record that the hook callback fired — the health monitor uses this
        // to skip unnecessary SendInput probes when the hook is clearly alive.
        HOOK_HAD_CALLBACK.with(|cell| cell.set(true));

        let kb = &*(l_param as *const KBDLLHOOKSTRUCT);
        let msg = w_param as u32;
        let vk = kb.vkCode;
        // Probe event from the health monitor — acknowledge and pass through.
        if kb.dwExtraInfo == HOOK_PROBE_EXTRA_INFO {
            HELPER_PROBE_RECEIVED.with(|cell| cell.set(true));
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
        }

        let internal_injection =
            kb.dwExtraInfo == crate::input_synthesis::INTERNAL_SENDINPUT_EXTRA_INFO;

        // Diagnostic: emit DEBUG lines for modifier and F-key events with raw
        // KBDLLHOOKSTRUCT fields. Used to measure Razer Alt→F-key gap and
        // leak window between Razer Alt-down and our SendInput Alt-up.
        // Logged BEFORE the internal_injection bypass so we capture our own
        // SendInput too — marked with prefix `int-` for distinction.
        let is_modifier = matches!(
            vk,
            VK_CONTROL | VK_LCONTROL | VK_RCONTROL |
            VK_SHIFT | VK_LSHIFT | VK_RSHIFT |
            VK_MENU | VK_LMENU | VK_RMENU |
            VK_LWIN | VK_RWIN
        );
        let is_fkey = (0x70..=0x87).contains(&vk);
        let is_keydown = msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_KEYDOWN
            || msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_SYSKEYDOWN;
        let is_keyup = msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_KEYUP
            || msg == windows_sys::Win32::UI::WindowsAndMessaging::WM_SYSKEYUP;
        if is_keydown || is_keyup {
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
            const WM_APP: u32 = 0x8000;
            HELPER_THREAD_ID.with(|cell| {
                let tid = cell.get();
                if tid != 0 {
                    PostThreadMessageW(tid, WM_APP, 0, 0);
                }
            });
            return CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param);
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
                        flags: kb.flags,
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
                    let mask_bit = match pm.vk {
                        VK_MENU | VK_LMENU | VK_RMENU => MOD_ALT,
                        VK_CONTROL | VK_LCONTROL | VK_RCONTROL => MOD_CONTROL,
                        VK_SHIFT | VK_LSHIFT | VK_RSHIFT => MOD_SHIFT,
                        VK_LWIN | VK_RWIN => MOD_WIN,
                        _ => 0,
                    };
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
                        unsafe { replay_modifier_down(pm.vk, pm.scan); }
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
                    if let Some(pos) = pending.iter().position(|pm| pm.vk == vk) {
                        Some(pending.remove(pos))
                    } else {
                        None
                    }
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
            const WM_APP: u32 = 0x8000;
            HELPER_THREAD_ID.with(|cell| {
                let tid = cell.get();
                if tid != 0 {
                    PostThreadMessageW(tid, WM_APP, 0, 0);
                }
            });
        }

        if suppress {
            return 1;
        }
    }

    CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param)
}

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
            DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW, PostThreadMessageW,
            SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, MSG, MWMO_INPUTAVAILABLE,
            PM_REMOVE, QS_ALLINPUT, WH_KEYBOARD_LL, WM_QUIT,
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
    } = init;

    if let Some(ms) = modifier_stale_gc_ms {
        let clamped = ms.clamp(500, 30_000);
        CONSUMED_MODIFIER_STALE_THRESHOLD.with(|c| {
            c.set(std::time::Duration::from_millis(clamped));
        });
        log::info!(
            "[capture-helper] CONSUMED stale threshold set to {clamped} ms."
        );
    }

    if let Some(ms) = replayed_modifier_force_release_ms {
        let clamped = ms.clamp(1_000, 60_000);
        REPLAYED_AWAITING_UP_THRESHOLD.with(|c| {
            c.set(std::time::Duration::from_millis(clamped));
        });
        log::info!(
            "[capture-helper] REPLAYED awaiting-up threshold set to {clamped} ms."
        );
    }

    if registrations.is_empty() {
        log::warn!("[capture-helper] No registrations, exiting.");
        return;
    }

    log::info!(
        "[capture-helper] Loaded {} modifier-combo registrations.",
        registrations.len()
    );

    // 2. Initialize thread-local state for the LL hook callback
    HELPER_REGISTRATIONS.with(|cell| *cell.borrow_mut() = registrations);
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

    // 4. Spawn stdin watcher — reads commands from parent.
    //    "REHOOK" → reinstall LL hook (WM_APP + 1)
    //    stdin close → exit (WM_QUIT)
    const WM_REHOOK: u32 = 0x8000 + 1; // WM_APP + 1
    let hook_tid = unsafe { GetCurrentThreadId() };
    HELPER_THREAD_ID.with(|cell| cell.set(hook_tid));
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = String::new();
        loop {
            buf.clear();
            match stdin.lock().read_line(&mut buf) {
                Ok(0) | Err(_) => {
                    log::info!("[capture-helper] stdin closed, posting WM_QUIT.");
                    unsafe { PostThreadMessageW(hook_tid, WM_QUIT, 0, 0); }
                    break;
                }
                Ok(_) => {
                    let cmd = buf.trim();
                    if cmd == "REHOOK" {
                        log::info!("[capture-helper] REHOOK command received.");
                        unsafe { PostThreadMessageW(hook_tid, WM_REHOOK, 0, 0); }
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
    let stdout_handle = std::io::stdout();
    let mut stdout = stdout_handle.lock();
    let mut msg = MaybeUninit::<MSG>::zeroed();
    let mut hook = hook; // make mutable for reinstallation
    let mut probe_sent = false;
    let mut consecutive_probe_failures: u32 = 0;
    let mut hook_reinstall_count: u32 = 0;

    loop {
        // Compute wait timeout: if we have pending modifiers, wake up in
        // time to replay them (20ms buffer).  Otherwise use the normal
        // health check interval.
        let wait_timeout = PENDING_MODIFIERS.with(|cell| {
            let pending = cell.borrow();
            if pending.is_empty() {
                HOOK_HEALTH_CHECK_INTERVAL_MS
            } else {
                let oldest = pending.iter()
                    .map(|pm| pm.buffered_at)
                    .min()
                    .unwrap();
                let elapsed = std::time::Instant::now()
                    .duration_since(oldest)
                    .as_millis() as u32;
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
                        HELPER_MODIFIERS.with(|cell| *cell.borrow_mut() = HelperModifierState::default());
                        HELPER_MATCHES.with(|cell| {
                            cell.borrow_mut().push(format!(
                                "DEBUG:mod-clear-on-health-reinstall pending={} consumed={}",
                                cleared_pending, cleared_consumed,
                            ));
                        });
                        unsafe { UnhookWindowsHookEx(hook); }
                        let new_hook = unsafe {
                            SetWindowsHookExW(WH_KEYBOARD_LL, Some(helper_ll_keyboard_proc), hmod, 0)
                        };
                        if new_hook.is_null() {
                            log::error!(
                                "[capture-helper] Failed to reinstall hook: {}. Exiting.",
                                std::io::Error::last_os_error()
                            );
                            break;
                        }
                        hook = new_hook;
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
            } // was_health_timeout
            // Fall through to pump any messages that may have arrived.
        }

        // Pump all pending messages (PeekMessageW is non-blocking).
        loop {
            let found = unsafe {
                PeekMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0, PM_REMOVE)
            };
            if found == 0 {
                break;
            }

            let m = unsafe { msg.assume_init() };
            if m.message == WM_QUIT {
                // Force-release any orphan replayed modifiers BEFORE drain so
                // the DEBUG: line is included in the final flush.
                force_release_all_replayed_modifiers("wm-quit");
                // Drain any remaining matches before exiting.
                let _ = drain_helper_matches(&mut stdout);
                unsafe { UnhookWindowsHookEx(hook); }
                log::info!("[capture-helper] Hook uninstalled, exiting.");
                return;
            }
            if m.message == WM_REHOOK {
                log::info!("[capture-helper] REHOOK: reinstalling WH_KEYBOARD_LL...");
                // Force-release injected-modifier orphans first so their up
                // events are queued before the hook tears down.
                force_release_all_replayed_modifiers("rehook");
                unsafe { UnhookWindowsHookEx(hook); }
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
                    break;
                }
                hook = new_hook;
                hook_reinstall_count += 1;
                probe_sent = false;
                log::info!(
                    "[capture-helper] Hook reinstalled via REHOOK \
                     (total reinstalls: {hook_reinstall_count})."
                );
                continue;
            }

            // Drain matches buffered by the hook callback.
            if drain_helper_matches(&mut stdout).is_err() {
                log::warn!("[capture-helper] stdout pipe broken — parent likely crashed. Exiting.");
                unsafe { UnhookWindowsHookEx(hook); }
                break;
            }

            unsafe {
                TranslateMessage(&m);
                DispatchMessageW(&m);
            }

            // Also drain after dispatch (hooks may fire during DispatchMessageW).
            if drain_helper_matches(&mut stdout).is_err() {
                log::warn!("[capture-helper] stdout pipe broken — parent likely crashed. Exiting.");
                unsafe { UnhookWindowsHookEx(hook); }
                break;
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
        if drain_helper_matches(&mut stdout).is_err() {
            log::warn!("[capture-helper] stdout pipe broken — parent likely crashed. Exiting.");
            unsafe { UnhookWindowsHookEx(hook); }
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
    log::info!("[capture-helper] Exiting message pump.");
}

fn drain_helper_matches(stdout: &mut std::io::StdoutLock<'_>) -> std::io::Result<()> {
    use std::io::Write;

    let matches: Vec<String> = HELPER_MATCHES.with(|cell| cell.borrow_mut().drain(..).collect());
    for encoded_key in &matches {
        writeln!(stdout, "{encoded_key}")?;
    }
    if !matches.is_empty() {
        stdout.flush()?; // single flush for entire batch
    }
    Ok(())
}

/// Spawns the capture helper child process for modifier-combo hotkeys.
/// Returns None if there are no modifier combos or if spawning fails (non-fatal).
fn spawn_capture_helper(
    registrations: &[RegisteredHotkey],
    event_tx: mpsc::Sender<EncodedKeyEvent>,
    modifier_stale_gc_ms: Option<u64>,
    replayed_modifier_force_release_ms: Option<u64>,
) -> Option<HelperHandle> {
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
        })
        .collect();

    if helper_regs.is_empty() {
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
        .stderr(Stdio::inherit())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[capture] Failed to spawn capture helper: {e}");
            return None;
        }
    };

    let mut stdin_pipe = child.stdin.take().expect("stdin was piped");
    let stdout_pipe = child.stdout.take().expect("stdout was piped");

    // Write init payload as one JSON line to the helper's stdin.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct HelperInit<'a> {
        registrations: &'a [HelperRegistration],
        #[serde(skip_serializing_if = "Option::is_none")]
        modifier_stale_gc_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        replayed_modifier_force_release_ms: Option<u64>,
    }
    let init = HelperInit {
        registrations: &helper_regs,
        modifier_stale_gc_ms,
        replayed_modifier_force_release_ms,
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

    log::info!(
        "[capture] Capture helper spawned (pid {}), {} modifier-combo registrations.",
        child.id(),
        helper_regs.len()
    );

    // Reader thread: reads encoded keys from helper stdout, converts to events
    let reader_thread = thread::spawn(move || {
        use std::io::BufRead;

        let reader = std::io::BufReader::new(stdout_pipe);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Diagnostic lines from helper — route to log::info! so they
            // appear in the Webview log panel via tauri-plugin-log.
            if let Some(rest) = trimmed.strip_prefix("DEBUG:") {
                log::info!("[helper] {rest}");
                continue;
            }
            let (is_key_up, is_repeat, encoded_key) =
                if let Some(rest) = trimmed.strip_prefix("UP:") {
                    (true, false, rest.to_owned())
                } else if let Some(rest) = trimmed.strip_prefix("REPEAT:") {
                    (false, true, rest.to_owned())
                } else {
                    (false, false, trimmed.to_owned())
                };
            let _ = event_tx.send(EncodedKeyEvent {
                encoded_key,
                backend: BACKEND_LL_HOOK.into(),
                received_at: runtime::timestamp_millis(),
                is_repeat,
                is_key_up,
            });
        }
    });

    Some(HelperHandle {
        stdin_pipe,
        child,
        reader_thread,
    })
}

// ---------------------------------------------------------------------------
// RegisterHotKey capture loop
// ---------------------------------------------------------------------------

fn run_hotkey_message_loop(
    registrations: Vec<RegisteredHotkey>,
    event_tx: mpsc::Sender<EncodedKeyEvent>,
    ready_tx: mpsc::Sender<Result<u32, String>>,
) {
    use std::mem::MaybeUninit;
    use windows_sys::Win32::{
        System::Threading::GetCurrentThreadId,
        UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey},
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, TranslateMessage, MSG, WM_HOTKEY,
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
                let _ = event_tx.send(EncodedKeyEvent {
                    encoded_key: registration.encoded_key.clone(),
                    backend: CAPTURE_BACKEND_NAME.into(),
                    received_at: runtime::timestamp_millis(),
                    is_repeat: false,
                    is_key_up: false,
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
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, TranslateMessage, MSG,
        },
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

            let capture_result = match window_capture::capture_active_window_with_resolution(
                &ctx.config,
                &ctx.app_name,
                None,
            ) {
                Ok(result) => result,
                Err(_) => return,
            };

            let _ = ctx.app.emit(EVENT_PROFILE_RESOLVED, &capture_result);

            if !capture_result.ignored {
                let should_notify = ctx
                    .runtime_store
                    .lock()
                    .ok()
                    .map(|mut store| {
                        store.notify_profile_change(capture_result.resolved_profile_id.as_deref())
                    })
                    .unwrap_or(false);
                if should_notify {
                    let profile_name = capture_result
                        .resolved_profile_name
                        .as_deref()
                        .unwrap_or("Default");
                    crate::show_osd(&ctx.app, profile_name, &ctx.config.settings);
                }
            }
        });
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
        assert!(expired.is_empty(), "no entries should expire under 1 h threshold");
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
            cell.borrow_mut().insert(0xA2, Instant::now() - Duration::from_millis(60));
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
            0xA2, false, &map, now + Duration::from_millis(31), threshold,
        ));
    }

    #[test]
    fn no_suppress_when_replayed_absent() {
        let map: std::collections::HashMap<u32, Instant> = std::collections::HashMap::new();
        let threshold = Duration::from_millis(3000);
        assert!(!should_suppress_repeat_modifier_down(
            0xA2, false, &map, Instant::now(), threshold,
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
        assert!(!FLUSHING_REPLAYED.with(|c| c.get()),
            "empty flush must leave flag clear");
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
                flags: 0x00,
                buffered_at: Instant::now() - Duration::from_millis(50),
            });
        });
        flush_expired_pending_modifiers();
        assert!(!FLUSHING_REPLAYED.with(|c| c.get()),
            "flush must clear FLUSHING_REPLAYED on exit");
        // Cleanup: the flush also injected a key-down via SendInput.
        // Force-release it so the unit test doesn't leave the OS in a
        // virtually-held state (the test process IS the OS-visible app).
        unsafe { replay_modifier_up(0xA0, 0x2A); }
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        assert_eq!(matches, vec!["Ctrl+Shift+F24"]);
        matches.clear();

        // Simulate F24 up — should emit UP: event
        let (suppress, wake, _inject_mask) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYUP,
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYUP,
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
            reg("Shift+Ctrl+Alt+F24", MOD_SHIFT | MOD_CONTROL | MOD_ALT, VK_F24),
        ];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        // Press Shift+Ctrl+Alt then F24 — most specific (3 bits) should win
        modifiers.apply_vk_event(VK_LSHIFT, true);
        modifiers.apply_vk_event(VK_LCONTROL, true);
        modifiers.apply_vk_event(VK_LMENU, true);

        let (suppress, wake, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
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
            reg("Shift+Ctrl+Alt+F24", MOD_SHIFT | MOD_CONTROL | MOD_ALT, VK_F24),
        ];
        let mut modifiers = HelperModifierState::default();
        let mut suppressions = std::collections::HashMap::new();
        let mut matches = Vec::new();

        let (suppress, wake, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        assert_eq!(matches.len(), 1);

        // Auto-repeat (same VK, still key-down, already in suppressions)
        let (suppress2, wake2, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
        );
        assert!(inject_mask, "first press with Alt should inject mask key");

        // Repeat — inject_mask should be false
        let (_, _, inject_mask2) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
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

        modifiers.apply_vk_event(VK_LMENU, true);  // Alt (encoding)
        modifiers.apply_vk_event(VK_LSHIFT, true);  // Shift (physical, extra)

        let (suppress, wake, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
        );
        assert!(suppress);
        assert!(wake);
        assert_eq!(matches, vec!["Ctrl+Alt+F24"], "most-specific mask should win");
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
        );
        assert!(s && w);
        assert_eq!(matches.len(), 1);

        // 2. Repeat
        let (s, w, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
        );
        assert!(s && w);
        assert_eq!(matches.len(), 2);

        // 3. Another repeat
        let (s, w, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
        );
        assert!(s && w);
        assert_eq!(matches.len(), 3);

        // 4. Release
        let (s, w, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYUP,
        );
        assert!(s && w);
        assert_eq!(matches[3], "UP:F24");

        // 5. Suppressions are now empty — another release does nothing
        let (s, w, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYUP,
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_LCONTROL, WM_KEYDOWN,
        );
        assert!(!suppress, "modifier key-down must not be suppressed");
        assert!(modifiers.ctrl);

        // Ctrl up — should pass through
        let (suppress, _, _) = process_helper_key_event(
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_LCONTROL, WM_KEYUP,
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
            &regs, &mut modifiers, &mut suppressions, &mut matches, VK_F24, WM_KEYDOWN,
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
        RegisterHotKey, SendInput, UnregisterHotKey, INPUT, INPUT_KEYBOARD, KEYBDINPUT,
        KEYEVENTF_KEYUP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY,
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

    #[test]
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
    fn diag_ll_hook_ctrl_shift_f23() {
        use std::cell::RefCell;
        use windows_sys::Win32::{
            System::LibraryLoader::GetModuleHandleW,
            UI::Input::KeyboardAndMouse::GetAsyncKeyState,
            UI::WindowsAndMessaging::{
                CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
            },
        };

        log::debug!("\n=== TEST: WH_KEYBOARD_LL + SendInput(Ctrl+Shift+F23) ===");

        struct TestHookState {
            hits: Vec<(u32, bool, bool)>, // (vk, ctrl_down, shift_down)
        }

        thread_local! {
            static TEST_HOOK: RefCell<Option<TestHookState>> = RefCell::new(None);
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
    fn diag_ll_hook_simple_f13() {
        use std::cell::RefCell;
        use windows_sys::Win32::{
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{
                CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
            },
        };

        log::debug!("\n=== TEST: WH_KEYBOARD_LL + SendInput(F13) ===");

        thread_local! {
            static TEST_HITS: RefCell<Vec<u32>> = RefCell::new(Vec::new());
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

        let f13_hit = hits.iter().any(|vk| *vk == VK_F13 as u32);
        if f13_hit {
            log::debug!("  RESULT: LL hook CAN catch simple F13 via SendInput");
        } else {
            log::debug!("  RESULT: LL hook CANNOT catch F13 — hook callbacks not firing!");
        }

        unsafe { UnhookWindowsHookEx(hook) };

        assert!(f13_hit, "LL hook should receive F13 keydown from SendInput");
    }
}
