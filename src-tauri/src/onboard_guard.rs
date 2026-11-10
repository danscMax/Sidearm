//! Keeps the mouse's onboard mapping in Sidearm's hands.
//!
//! Razer's engine takes the mouse over for as long as it runs: it switches the
//! device to driver mode, where the firmware ignores onboard memory and the
//! driver's own mapping reaches the OS, and it rewrites the onboard records with
//! its own profile — including a firmware Hypershift on a mouse button, which
//! swallows that button. Measured: mode `Normal` makes the mouse emit the records
//! written by [`crate::mouse_memory`], mode `Driver` hands every button to Razer.
//!
//! The guard checks the mode, the key records (thumbs + top buttons) and the
//! plain mouse buttons while the runtime is active — read-only HID queries, with
//! a write only when something actually changed — puts them back, and reports
//! the takeover so the user sees Razer being undone instead of wondering why the
//! buttons moved. It checks at once on start, every [`POLL_INTERVAL`] after that,
//! every [`FAST_POLL`] while the mouse refuses queries (asleep) or Razer's engine
//! runs, and immediately on [`request_check`]. It stays idle while the runtime is
//! stopped: a stopped Sidearm is not fighting for the mouse.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::device_catalog::NativeModel;
use crate::mouse_memory::{OnboardBinding, VendorDevice, MODE_NORMAL};
use crate::runtime::RuntimeStore;

/// Regular poll period. The queries are read-only and answered in milliseconds.
const POLL_INTERVAL: Duration = Duration::from_secs(20);
/// Poll period while a takeover is likely or a check could not run: the mouse
/// refused the query (a sleeping wireless mouse answers status `0x04`), the
/// runtime is not running yet, or Razer's engine is up.
const FAST_POLL: Duration = Duration::from_secs(3);
/// Without a reason to suspect drift, a tick reads only the mode (one command);
/// the full scan — every guarded record and the battery, ~23 commands holding
/// the device lock for over a second — runs at most this often.
const FULL_SCAN_EVERY: Duration = Duration::from_secs(300);
/// The guard reports the mouse as unreachable after failing this long (an
/// asleep mouse is not unreachable).
const UNREACHABLE_AFTER: Duration = Duration::from_secs(60);
/// Minimum gap between two notifications of the same kind: Razer's engine can
/// take the device back right after we put it down, and that must not turn into a
/// toast loop.
const NOTIFY_COOLDOWN: Duration = Duration::from_secs(300);
/// Processes of Razer's engine that write the mouse's memory and mode.
const RAZER_PROCESSES: [&str; 2] = ["RazerAppEngine.exe", "RzEngineMon.exe"];

/// Emitted when the guard caught Razer holding the mouse back.
pub const EVENT_ONBOARD_TAKEOVER: &str = "onboard_takeover";

/// Wakes the guard for an immediate check.
static CHECK_NOW: OnceLock<Sender<()>> = OnceLock::new();

/// Emitted when the battery level changes: `{ percent, low }`.
pub const EVENT_MOUSE_BATTERY: &str = "mouse_battery";
/// Below this the user is warned…
const LOW_BATTERY_PERCENT: u8 = 10;
/// …at most once per this period, across restarts.
const LOW_BATTERY_WARN_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// File next to the config holding the unix time of the last low warning.
const LOW_BATTERY_STAMP_FILE: &str = "mouse-battery-warned";
/// Last battery level of each connected mouse. A mouse that sleeps keeps its
/// last reading; an unplugged one drops out.
static BATTERIES: Mutex<Vec<(&'static NativeModel, u8)>> = Mutex::new(Vec::new());
/// Config device of the mouse whose button Sidearm handled last.
static LAST_USED: Mutex<Option<String>> = Mutex::new(None);

fn batteries() -> std::sync::MutexGuard<'static, Vec<(&'static NativeModel, u8)>> {
    BATTERIES.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Each connected mouse's battery from the guard's last reads.
pub fn last_batteries() -> Vec<(&'static NativeModel, u8)> {
    batteries().clone()
}

/// The tray badge: the mouse used last, else the one to charge first.
pub fn last_battery_percent() -> Option<u8> {
    let used = LAST_USED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    let batteries = batteries();
    batteries
        .iter()
        .find(|(model, _)| used.as_deref() == Some(model.device_id))
        .map(|&(_, percent)| percent)
        .or_else(|| batteries.iter().map(|&(_, percent)| percent).min())
}

/// Called for every button press Sidearm handles: the tray badge follows the
/// mouse in use.
pub fn note_device_used(app: &AppHandle, config: &crate::config::AppConfig, device_id: &str) {
    let changed = {
        let mut used = LAST_USED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let changed = used.as_deref() != Some(device_id);
        if changed {
            *used = Some(device_id.to_owned());
        }
        changed
    };
    let tracked = batteries().iter().any(|(model, _)| model.device_id == device_id);
    if changed && tracked {
        crate::rebuild_tray_menu_from_config(app, config);
    }
}

/// Payload of [`EVENT_MOUSE_BATTERY`].
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct BatteryEvent {
    pub model: &'static str,
    pub percent: u8,
    /// `true` on the reading that warns (low, and none in the last 24 h).
    pub low: bool,
}

/// What had to be taken back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TakeoverKind {
    /// The device was in driver mode, so the firmware ignored onboard memory.
    Mode,
    /// Onboard records held someone else's mapping.
    Mappings,
    /// Razer's engine started; it will take the mouse over while it runs.
    RazerStarted,
}

/// Payload of [`EVENT_ONBOARD_TAKEOVER`].
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverEvent {
    pub kind: TakeoverKind,
    /// `false` when the guard could not take the mouse back — Razer held on.
    pub restored: bool,
    /// Controls whose stored mapping had been rewritten (mappings kind only).
    pub controls: Vec<String>,
}

/// How one check ended.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// No catalog mouse is plugged in.
    Absent,
    /// The mouse could not be asked (busy, not openable) — no evidence either way.
    Unreadable,
    /// The mouse did not answer (asleep or out of range): nothing can change it
    /// meanwhile, so the guard waits a whole period instead of polling it.
    Asleep,
    /// Light tick: the mode is `Normal`, the records were not read.
    ModeOnly,
    /// Mode and every guarded record matched; `usize` = guarded buttons.
    Clean(usize),
    /// Something was taken back (already reported).
    TookBack,
    /// An unverified model: read for its battery only, never guarded.
    ReadOnly,
}

/// Starts the guard on its own thread. It lives as long as the app does and idles
/// while the runtime is stopped.
pub fn spawn(app: AppHandle, runtime_store: Arc<Mutex<RuntimeStore>>, config_dir: PathBuf) {
    let (sender, receiver) = std::sync::mpsc::channel();
    if CHECK_NOW.set(sender).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("onboard-guard".into())
        .spawn(move || run(&app, &runtime_store, &config_dir, &receiver))
        .ok();
}

/// Held for one guard tick's work; the exit waits for a tick that began
/// before it ([`wait_tick`]), so no tick puts signals over the offline profile.
static TICK: Mutex<()> = Mutex::new(());

/// Returns once a guard tick in progress has finished, or after 5 s: a tick
/// can wait on the main thread (tray, OSD), which may be the one calling this.
pub fn wait_tick() {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while matches!(TICK.try_lock(), Err(std::sync::TryLockError::WouldBlock)) {
        if std::time::Instant::now() >= deadline {
            log::warn!("[onboard-guard] a tick still runs at exit");
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Set by the Mouse tab's signal switch: the rewrite it causes is not news.
pub static USER_SWITCHED_SIGNALS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Asks the guard for a check now instead of at its next tick.
pub fn request_check() {
    if let Some(sender) = CHECK_NOW.get() {
        let _ = sender.send(());
    }
}

/// Feeds the guard a captured signal. The onboard path writes bare `F13`..`F24`
/// (thumbs) and `Alt+F23`/`Alt+F24` (top buttons), a live map its reserved
/// key-mode aliases (`live_overlay::is_key_alias`); any other `F13`..`F24`
/// with Ctrl, Shift or Win came from a record someone else stored — Synapse's
/// Hypershift encoding is `Ctrl+Alt+Shift+Fxx`. Cheap enough for the
/// per-keystroke path.
pub fn note_signal(encoded_key: &str) {
    if is_foreign_encoding(encoded_key) {
        request_check();
    }
}

fn is_foreign_encoding(encoded_key: &str) -> bool {
    let key = encoded_key.rsplit('+').next().unwrap_or("");
    let is_f13_to_f24 = key
        .strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (13..=24).contains(&n));
    is_f13_to_f24
        && ["Ctrl+", "Shift+", "Win+"]
            .iter()
            .any(|modifier| encoded_key.contains(modifier))
        && !crate::mouse_memory::live_overlay::is_key_alias(encoded_key)
}

fn run(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config_dir: &Path,
    requests: &Receiver<()>,
) {
    log::info!(
        "[onboard-guard] watching (every {}s while the runtime runs, at once on request)",
        POLL_INTERVAL.as_secs()
    );
    let mut last_notified = Vec::new();
    let mut razer_was_running = false;
    let mut last_clean: Option<usize> = None;
    // The first check runs right away instead of after a whole period, and scans
    // everything.
    let mut wait = Duration::ZERO;
    let mut last_full: Option<Instant> = None;
    let mut suspect = true;
    let mut unreadable_since: Option<Instant> = None;
    loop {
        let requested = match requests.recv_timeout(wait) {
            Ok(()) => true,
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        while requests.try_recv().is_ok() {}

        // A restore process still talking to the receiver counts as not running.
        let running = !crate::live_map_restore_running()
            && runtime_store
                .lock()
                .map(|store| store.is_running())
                .unwrap_or(false);
        if !running {
            // A stopped Sidearm reads nothing: its warnings would be stale.
            crate::mouse_status::set_state(Some(app), crate::mouse_status::StatusKind::MouseUnreachable, false);
            crate::mouse_status::set_state(Some(app), crate::mouse_status::StatusKind::ButtonsUnreadable, false);
            unreadable_since = None;
            wait = FAST_POLL;
            continue;
        }

        let razer_running = razer_engine_running();
        if razer_running && !razer_was_running {
            notify(
                app,
                runtime_store,
                &mut last_notified,
                TakeoverEvent {
                    kind: TakeoverKind::RazerStarted,
                    restored: true,
                    controls: Vec::new(),
                },
            );
        }
        razer_was_running = razer_running;

        // The exit is writing the offline profile: never put signals over it.
        // Held to the end of the tick, which the exit waits for.
        let _tick = TICK.lock();
        if crate::is_shutting_down() {
            wait = POLL_INTERVAL;
            continue;
        }
        // The mouse may still hold the offline profile written at the last exit,
        // what it had stored under a live map that just ended, or a live map no
        // session restored: put Sidearm's signals back quietly before the check
        // would call it drift.
        let model = crate::mouse_memory::config_model();
        let marker = config_dir.join(crate::mouse_offline::OFFLINE_MARKER_FILE).exists();
        let stale_map = crate::mouse_memory::live_overlay::unrestored_map(config_dir, model);
        if !crate::mouse_memory::live_overlay::is_active(model)
            && (marker || stale_map.is_some())
            && let Some(config) = read_config(config_dir)
        {
            let restored = if marker {
                crate::mouse_offline::restore_after_offline(&config, config_dir)
            } else {
                crate::mouse_offline::restore_signals(&config)
                    .inspect_err(|error| log::warn!("[onboard-guard] signals not restored over a stale live map: {error}"))
                    .is_ok()
            };
            if !restored {
                wait = FAST_POLL;
                continue;
            }
            // The mouse plays Sidearm's signals again: that rollback is moot.
            if let Some(path) = stale_map
                && let Err(error) = std::fs::remove_file(&path)
            {
                log::warn!("[onboard-guard] {} not removed: {error}", path.display());
            }
        }

        // Only Razer's engine rewrites the records, so a full scan is worth its
        // bus traffic on request, while Razer runs, after anything but a clean
        // check (a wake-up included), and every FULL_SCAN_EVERY as a backstop.
        let full = requested
            || razer_running
            || suspect
            || last_full.is_none_or(|at| at.elapsed() >= FULL_SCAN_EVERY);
        let verdict = check_once(
            app,
            runtime_store,
            config_dir,
            &mut last_notified,
            full,
        );
        if full {
            last_full = Some(Instant::now());
        }
        poll_batteries(app, config_dir, !full);
        // `Absent` stays suspect: a mouse plugged back in gets a full scan.
        suspect = !matches!(verdict, Verdict::Clean(_) | Verdict::ModeOnly | Verdict::ReadOnly);
        if full {
            // A full check consumed the user's switch, or found nothing to
            // switch: either way the flag must not swallow a later notice.
            USER_SWITCHED_SIGNALS.store(false, Ordering::SeqCst);
        }
        if verdict == Verdict::Unreadable {
            let since = *unreadable_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= UNREACHABLE_AFTER {
                crate::mouse_status::set_state(Some(app), crate::mouse_status::StatusKind::MouseUnreachable, true);
            }
        } else {
            unreadable_since = None;
            crate::mouse_status::set_state(Some(app), crate::mouse_status::StatusKind::MouseUnreachable, false);
        }
        match verdict {
            Verdict::Clean(buttons) if last_clean != Some(buttons) => {
                record_clean(runtime_store, buttons);
                last_clean = Some(buttons);
            }
            Verdict::TookBack => last_clean = None,
            _ => {}
        }
        wait = match verdict {
            Verdict::Asleep | Verdict::Absent => POLL_INTERVAL,
            Verdict::Unreadable => FAST_POLL,
            _ if razer_running => FAST_POLL,
            _ => POLL_INTERVAL,
        };
    }
}

fn check_once(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    config_dir: &Path,
    last_notified: &mut Vec<(TakeoverKind, bool, Instant)>,
    full: bool,
) -> Verdict {
    let device = match VendorDevice::open_onboard() {
        Ok(device) => device,
        // A live-only mouse has nothing to guard here but still reports its battery.
        Err(message) if message == crate::mouse_memory::NOT_CONNECTED => {
            if crate::mouse_memory::present_models().is_empty() {
                return Verdict::Absent;
            }
            return Verdict::ReadOnly;
        }
        // Its collection is not openable right now.
        Err(_) => return Verdict::Unreadable,
    };
    if !device.model().verified || crate::mouse_memory::live_overlay::is_active(device.model()) {
        return Verdict::ReadOnly;
    }

    // Read the mode first and only act on a mode we actually read. A sleeping
    // mouse (or a busy dongle) answers every vendor command with a refusal
    // instead of a status, and that is not evidence of a takeover — waking it
    // up is the user's job, not ours.
    let mode = match device.mode() {
        Ok(mode) => mode,
        Err(message) => {
            log::debug!("[onboard-guard] mode unreadable: {message}");
            return if crate::mouse_memory::is_no_response(&message) {
                Verdict::Asleep
            } else {
                Verdict::Unreadable
            };
        }
    };
    let mut took_back = false;
    if mode != MODE_NORMAL {
        let result = device.ensure_normal_mode();
        // `ensure_normal_mode` reads the mode again first: `Normal` there means
        // the first read caught a transition, not a takeover — nothing to report.
        if !matches!(result, Ok(before) if before == MODE_NORMAL) {
            let restored = result.is_ok();
            notify(
                app,
                runtime_store,
                last_notified,
                TakeoverEvent {
                    kind: TakeoverKind::Mode,
                    restored,
                    controls: Vec::new(),
                },
            );
            if !restored {
                // Still in driver mode: the stored records say nothing about what
                // the user's buttons will do, so re-check on the next tick.
                return Verdict::TookBack;
            }
            took_back = true;
        }
    }
    if !full && !took_back {
        return Verdict::ModeOnly;
    }

    let Some(config) = read_config(config_dir) else {
        return Verdict::Unreadable;
    };
    let bindings = crate::mouse_memory::onboard_bindings(&config);
    match drifted_controls(&device, &bindings) {
        Ok((drifted_keys, drifted_native)) => {
            if drifted_keys.is_empty() && drifted_native.is_empty() {
                return if took_back {
                    Verdict::TookBack
                } else {
                    Verdict::Clean(bindings.len() + device.model().native_buttons.len())
                };
            }
            // A button still holding Sidearm's signal of the other kind (the
            // F13..F24 of an older version, or the rollback switch flipped) is a
            // signal switch, not a takeover: rewritten below, not reported.
            // Read before the rewrite, which erases the evidence. Read twice like
            // the drift check, and an unreadable record counts as a switch: a
            // transient misread must not report Razer taking the mouse over.
            let switched = |control: &String| {
                (0..2).any(|_| device.holds_other_signal(&bindings, control).unwrap_or(true))
            };
            let foreign_keys: Vec<String> = drifted_keys.iter().filter(|c| !switched(c)).cloned().collect();
            let mut restored = true;
            if !drifted_keys.is_empty() {
                restored &= device.apply_bindings(&bindings).is_ok();
            }
            if !drifted_native.is_empty() {
                restored &= device.restore_native_buttons(&drifted_native).is_ok();
            }
            if restored && foreign_keys.is_empty() && drifted_native.is_empty() {
                log::info!("[onboard-guard] button signals switched to the configured kind: {drifted_keys:?}");
                // The user's own switch in the Mouse tab needs no announcement.
                if !USER_SWITCHED_SIGNALS.swap(false, Ordering::SeqCst) {
                    crate::mouse_status::notice(Some(app), crate::mouse_status::StatusKind::SignalsSwitched);
                }
                return Verdict::TookBack;
            }
            let reported = if restored { foreign_keys } else { drifted_keys };
            let controls = reported
                .into_iter()
                .chain(drifted_native.iter().map(|id| id.to_string()))
                .collect();
            notify(
                app,
                runtime_store,
                last_notified,
                TakeoverEvent {
                    kind: TakeoverKind::Mappings,
                    restored,
                    controls,
                },
            );
            Verdict::TookBack
        }
        Err(message) => {
            log::debug!("[onboard-guard] drift check failed: {message}");
            Verdict::Unreadable
        }
    }
}

/// Reads the battery of every connected mouse, not just the one the guard
/// checks, and drops the mice that were unplugged.
/// With `only_silent`, only the mice whose last read failed are asked: every
/// tick, so a mouse that wakes shows up within one tick, not at the next full
/// scan.
fn poll_batteries(app: &AppHandle, config_dir: &Path, only_silent: bool) {
    // Mice whose last battery read got no answer (asleep, out of range).
    static SILENT: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let silent = || SILENT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if only_silent && silent().is_empty() {
        return;
    }
    let Some(config) = read_config(config_dir) else { return };
    let mut present = crate::mouse_memory::present_models();
    silent().retain(|name| present.iter().any(|model| model.name == *name));
    if only_silent {
        present.retain(|model| silent().contains(&model.name));
    }
    let unplugged = {
        let mut batteries = batteries();
        let before = batteries.len();
        batteries.retain(|(kept, _)| present.iter().any(|model| model.name == kept.name));
        batteries.len() != before
    };
    if unplugged {
        crate::rebuild_tray_menu_from_config(app, &config);
    }
    for model in present {
        match VendorDevice::open_model(model).and_then(|device| device.battery_percent()) {
            Ok(percent) => {
                let woke = {
                    let mut silent = silent();
                    let before = silent.len();
                    silent.retain(|name| *name != model.name);
                    silent.len() != before
                };
                report_battery(app, &config, config_dir, model, percent, woke);
            }
            Err(message) => {
                log::debug!("[onboard-guard] {} battery unreadable: {message}", model.name);
                let mut silent = silent();
                if !silent.contains(&model.name) {
                    silent.push(model.name);
                }
            }
        }
    }
}

/// Publishes a battery reading: remembers it, refreshes the tray (tooltip and
/// badge) and the UI when it changed, and warns when it is low — at most once a
/// day per mouse, remembered in [`LOW_BATTERY_STAMP_FILE`] so a restart does
/// not repeat it.
fn report_battery(app: &AppHandle, config: &crate::config::AppConfig, config_dir: &Path, model: &'static NativeModel, percent: u8, woke: bool) {
    let stamp_path = config_dir.join(format!("{LOW_BATTERY_STAMP_FILE}-{}", model.device_id));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last_warned = std::fs::read_to_string(&stamp_path)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok());
    let low = should_warn_low(percent, last_warned, now);
    let previous = {
        let mut batteries = batteries();
        match batteries.iter_mut().find(|(kept, _)| kept.name == model.name) {
            Some(entry) => Some(std::mem::replace(&mut entry.1, percent)),
            None => {
                batteries.push((model, percent));
                None
            }
        }
    };
    if previous != Some(percent) || low || woke {
        crate::rebuild_tray_menu_from_config(app, config);
        let _ = app.emit(EVENT_MOUSE_BATTERY, BatteryEvent { model: model.name, percent, low });
    }
    if low {
        if let Err(error) = std::fs::write(&stamp_path, now.to_string()) {
            log::warn!("[onboard-guard] battery warning stamp not saved: {error}");
        }
        let text = crate::ui_text!("guard.batteryLow", "{model} battery: {percent}%", model = model.name, percent = percent);
        log::warn!("[onboard-guard] {text}");
        let message = crate::ui_text::native(&text);
        // Off the guard tick, which holds the mouse: the OSD window is created
        // lazily and its first call only creates it, so give the WebView a
        // moment and show it again — this warning must not be the call lost.
        let (app, settings) = (app.clone(), config.settings.clone());
        let _ = std::thread::Builder::new().name("battery-osd".into()).spawn(move || {
            if app.get_webview_window("osd").is_none() {
                crate::show_osd(&app, "", &message, &settings);
                std::thread::sleep(Duration::from_secs(1));
            }
            crate::show_osd(&app, "", &message, &settings);
        });
    }
}

/// Whether a reading of `percent` should warn: below [`LOW_BATTERY_PERCENT`]
/// and no warning in the last [`LOW_BATTERY_WARN_EVERY`] (`last_warned` and
/// `now` are unix seconds).
fn should_warn_low(percent: u8, last_warned: Option<u64>, now: u64) -> bool {
    percent < LOW_BATTERY_PERCENT
        && last_warned.is_none_or(|last| now.saturating_sub(last) >= LOW_BATTERY_WARN_EVERY.as_secs())
}

/// Key controls whose record drifted, and native buttons that stopped being
/// their plain mouse button.
fn drifted_controls(
    device: &VendorDevice,
    bindings: &[OnboardBinding],
) -> Result<(Vec<String>, Vec<&'static str>), String> {
    Ok((device.drifted_bindings(bindings)?, device.drifted_native_buttons()?))
}

fn razer_engine_running() -> bool {
    crate::platform::shell::list_running_processes()
        .iter()
        .any(|process| {
            RAZER_PROCESSES
                .iter()
                .any(|name| process.exe.eq_ignore_ascii_case(name))
        })
}

/// The current config, or nothing when it cannot be read — then there is no
/// expectation to guard.
fn read_config(config_dir: &Path) -> Option<crate::config::AppConfig> {
    let path = config_dir.join("config.json");
    match crate::config::read_and_migrate_config_file(&path) {
        Ok(config) => Some(config),
        Err(error) => {
            log::debug!("[onboard-guard] config unreadable: {error}");
            None
        }
    }
}

/// Puts a clean verdict into the runtime log (the Diagnostics panel) — once per
/// change, not every tick.
fn record_clean(runtime_store: &Arc<Mutex<RuntimeStore>>, buttons: usize) {
    let message = crate::ui_text!(
        "guard.mouseClean",
        "Mouse check: Normal mode, all {buttons} buttons match the Sidearm assignments.",
        buttons = buttons
    );
    log::info!("[onboard-guard] {message}");
    if let Ok(mut store) = runtime_store.lock() {
        store.record_info("capture", message);
    }
}

/// Writes the takeover into the runtime log and tells the UI, at most once per
/// [`NOTIFY_COOLDOWN`] per kind.
fn notification_allowed(
    history: &mut Vec<(TakeoverKind, bool, Instant)>,
    kind: TakeoverKind,
    restored: bool,
    now: Instant,
) -> bool {
    if let Some(entry) = history.iter_mut().find(|(previous, _, _)| *previous == kind) {
        if entry.1 == restored && now.duration_since(entry.2) < NOTIFY_COOLDOWN {
            return false;
        }
        *entry = (kind, restored, now);
    } else {
        history.push((kind, restored, now));
    }
    true
}

fn notify(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    last_notified: &mut Vec<(TakeoverKind, bool, Instant)>,
    event: TakeoverEvent,
) {
    let now = Instant::now();
    let throttled = !notification_allowed(last_notified, event.kind, event.restored, now);
    let message = takeover_message(&event);
    if throttled {
        // The toast is throttled, the evidence is not: a silent log hid repeated
        // takeovers for a whole session.
        log::info!("[onboard-guard] {message}");
        // The consolidated card represents state, not notification frequency.
        // A throttled recovery transition must still replace a visible failure.
        let _ = app.emit(EVENT_ONBOARD_TAKEOVER, &event);
        return;
    }
    log::warn!("[onboard-guard] {message}");
    if let Ok(mut store) = runtime_store.lock() {
        store.record_warn("capture", message);
    }
    if app.webview_windows().is_empty() {
        return;
    }
    let _ = app.emit(EVENT_ONBOARD_TAKEOVER, &event);
}

fn takeover_message(event: &TakeoverEvent) -> crate::ui_text::UiText {
    match (event.kind, event.restored) {
        (TakeoverKind::Mode, true) => crate::ui_text!(
            "guard.modeRestored",
            "Razer took the mouse over (driver mode) — control returned to Sidearm."
        ),
        (TakeoverKind::Mode, false) => crate::ui_text!(
            "guard.modeNotRestored",
            "Razer holds the mouse in driver mode — could not return control to Sidearm."
        ),
        (TakeoverKind::Mappings, true) => crate::ui_text!(
            "guard.mappingsRestored",
            "Razer overwrote the button assignments ({controls}) — restored them.",
            controls = event.controls.join(", ")
        ),
        (TakeoverKind::Mappings, false) => crate::ui_text!(
            "guard.mappingsNotRestored",
            "Button assignments were overwritten ({controls}), could not restore them.",
            controls = event.controls.join(", ")
        ),
        (TakeoverKind::RazerStarted, _) => crate::ui_text!(
            "guard.razerStarted",
            "Razer Synapse started — it will overwrite the buttons; Sidearm checks the mouse every 3 s."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tray_badge_follows_the_mouse_in_use() {
        use crate::device_catalog::{NAGA_V2_HYPERSPEED, NAGA_V3_PRO};
        *batteries() = vec![(&NAGA_V2_HYPERSPEED, 9), (&NAGA_V3_PRO, 100)];
        *LAST_USED.lock().unwrap() = None;
        assert_eq!(last_battery_percent(), Some(9), "nothing used yet: the one to charge");
        *LAST_USED.lock().unwrap() = Some(NAGA_V3_PRO.device_id.into());
        assert_eq!(last_battery_percent(), Some(100));
        *LAST_USED.lock().unwrap() = Some("custom".into());
        assert_eq!(last_battery_percent(), Some(9), "a device without a battery");
        batteries().clear();
        *LAST_USED.lock().unwrap() = None;
    }

    #[test]
    fn recovery_transitions_are_not_hidden_by_notification_cooldown() {
        let now = Instant::now();
        let mut history = Vec::new();
        assert!(notification_allowed(&mut history, TakeoverKind::Mode, false, now));
        assert!(!notification_allowed(&mut history, TakeoverKind::Mode, false, now + Duration::from_secs(1)));
        assert!(notification_allowed(&mut history, TakeoverKind::Mode, true, now + Duration::from_secs(2)));
    }

    #[test]
    fn alternating_takeover_kinds_keep_independent_cooldowns() {
        let now = Instant::now();
        let mut history = Vec::new();
        assert!(notification_allowed(&mut history, TakeoverKind::Mode, false, now));
        assert!(notification_allowed(&mut history, TakeoverKind::Mappings, false, now));
        assert!(!notification_allowed(&mut history, TakeoverKind::Mode, false, now + Duration::from_secs(1)));
    }

    /// Below 10 %, at most once a day — a restart within the day does not repeat it.
    #[test]
    fn low_battery_warns_at_most_once_a_day() {
        let day = 24 * 60 * 60;
        assert!(!should_warn_low(10, None, 1_000), "10 % is not below 10 %");
        assert!(should_warn_low(9, None, 1_000));
        assert!(!should_warn_low(5, Some(1_000), 1_000 + day - 1));
        assert!(should_warn_low(5, Some(1_000), 1_000 + day));
        assert!(!should_warn_low(50, None, 1_000));
    }

    /// Only an `F13`..`F24` carrying a modifier Sidearm never writes is foreign.
    #[test]
    fn foreign_encodings_are_the_ones_sidearm_never_writes() {
        assert!(is_foreign_encoding("Ctrl+Alt+Shift+F13"));
        assert!(is_foreign_encoding("Ctrl+Alt+F16"));
        assert!(is_foreign_encoding("Win+F24"));
        assert!(!is_foreign_encoding("F13"));
        assert!(!is_foreign_encoding("Alt+F23"));
        assert!(!is_foreign_encoding("Ctrl+F12"));
        assert!(!is_foreign_encoding("Ctrl+Shift+T"));
        // The V3's own key-mode aliases are Sidearm's.
        assert!(!is_foreign_encoding("Ctrl+Shift+F13"));
        assert!(!is_foreign_encoding("Ctrl+Alt+Shift+Win+F24"));
    }
}
