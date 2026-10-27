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
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

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
/// Last battery level read by the guard; `u8::MAX` = not read yet.
static LAST_BATTERY: AtomicU8 = AtomicU8::new(u8::MAX);

/// Battery level from the guard's last successful read.
pub fn last_battery_percent() -> Option<u8> {
    match LAST_BATTERY.load(Ordering::Relaxed) {
        u8::MAX => None,
        percent => Some(percent),
    }
}

/// Payload of [`EVENT_MOUSE_BATTERY`].
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct BatteryEvent {
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

/// Applies a profile's own DPI / poll rate to the mouse (fields left unset keep
/// the mouse as it is). Runs on its own thread: it is called from the capture
/// path on a profile switch and must not delay the key that caused it. The
/// device lock serializes it with the guard tick.
pub fn apply_profile_mouse_settings(profile: &crate::config::Profile) {
    let (dpi, poll_rate_hz) = (profile.mouse_dpi, profile.mouse_poll_rate_hz);
    if dpi.is_none() && poll_rate_hz.is_none() {
        return;
    }
    let name = profile.name.clone();
    // Every switch spawns its own thread and the device lock does not keep their
    // order: a switch that waited behind a newer one must not undo it.
    let generation = PROFILE_SWITCHES.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::Builder::new()
        .name("profile-mouse".into())
        .spawn(move || {
            let result = VendorDevice::open_connected().and_then(|device| {
                if PROFILE_SWITCHES.load(Ordering::SeqCst) != generation {
                    return Ok(None);
                }
                let mut written = false;
                if let Some(hz) = poll_rate_hz
                    && device.poll_rate_hz()? != hz
                {
                    device.set_poll_rate_hz(hz)?;
                    written = true;
                }
                // Live only: the mouse keeps its stored DPI for use without
                // Sidearm, and a switch per alt-tab must not wear its storage.
                if let Some(dpi) = dpi
                    && device.dpi()? != dpi
                {
                    device.set_dpi(dpi, false)?;
                    written = true;
                }
                Ok(Some(written))
            });
            match result {
                Ok(None) => log::debug!("[onboard-guard] profile `{name}`: superseded by a newer switch"),
                Ok(Some(false)) => log::debug!("[onboard-guard] profile `{name}`: mouse settings already in place"),
                Ok(Some(true)) => log::info!(
                    "[onboard-guard] profile `{name}`: mouse DPI {dpi:?}, poll {poll_rate_hz:?} Hz written"
                ),
                Err(message) => {
                    log::warn!("[onboard-guard] profile `{name}`: mouse settings not applied: {message}")
                }
            }
        })
        .ok();
}

/// Set by the Mouse tab's signal switch: the rewrite it causes is not news.
pub static USER_SWITCHED_SIGNALS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

/// Apply a DPI Up/Down binding using the resolved profile's list, rather than
/// mutating another profile or the saved startup DPI. Device verification fails
/// explicitly when the wireless mouse is asleep or disconnected.
#[cfg(target_os = "windows")]
pub fn step_profile_dpi(profile: &crate::config::Profile, up: bool) -> Result<u16, String> {
    let stages = profile.mouse_dpi_stages.as_deref().ok_or_else(||
        "Configure DPI stages for the active profile first".to_string())?;
    let device = VendorDevice::open_connected()?;
    let current = device.dpi()?;
    let desired = next_dpi_stage(stages, current, up)?;
    if desired != current {
        device.set_dpi(desired, false)?;
    }
    Ok(desired)
}

#[cfg(test)]
mod dpi_stage_tests {
    use super::next_dpi_stage;

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
}

/// Asks the guard for a check now instead of at its next tick.
pub fn request_check() {
    if let Some(sender) = CHECK_NOW.get() {
        let _ = sender.send(());
    }
}

/// Feeds the guard a captured signal. Sidearm writes bare `F13`..`F24` (thumbs)
/// and `Alt+F23`/`Alt+F24` (top buttons) only, so an `F13`..`F24` with Ctrl, Shift
/// or Win came from a record someone else stored — Synapse's Hypershift encoding
/// is `Ctrl+Alt+Shift+Fxx`. Cheap enough for the per-keystroke path.
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
    let mut last_notified: Option<(TakeoverKind, Instant)> = None;
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

        let running = runtime_store
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

        // The mouse may still hold the offline profile written at the last exit:
        // put Sidearm's signals back quietly before the check would call it drift.
        if config_dir.join(crate::mouse_offline::OFFLINE_MARKER_FILE).exists()
            && let Some(config) = read_config(config_dir)
            && !crate::mouse_offline::restore_after_offline(&config, config_dir)
        {
            wait = FAST_POLL;
            continue;
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
    last_notified: &mut Option<(TakeoverKind, Instant)>,
    full: bool,
) -> Verdict {
    let device = match VendorDevice::open_connected() {
        Ok(device) => device,
        Err(message) if message == crate::mouse_memory::NOT_CONNECTED => return Verdict::Absent,
        // Its collection is not openable right now.
        Err(_) => return Verdict::Unreadable,
    };
    if !device.model().verified {
        if full
            && let Some(config) = read_config(config_dir)
            && let Ok(percent) = device.battery_percent()
        {
            report_battery(app, &config, config_dir, percent);
        }
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
    match device.battery_percent() {
        Ok(percent) => report_battery(app, &config, config_dir, percent),
        Err(message) => log::debug!("[onboard-guard] battery unreadable: {message}"),
    }
    let bindings = crate::mouse_memory::onboard_bindings(&config);
    match drifted_controls(&device, &bindings) {
        Ok((drifted_keys, drifted_native)) => {
            if drifted_keys.is_empty() && drifted_native.is_empty() {
                return if took_back {
                    Verdict::TookBack
                } else {
                    Verdict::Clean(bindings.len() + crate::mouse_memory::native_buttons().len())
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

/// Publishes a battery reading: remembers it, refreshes the tray (tooltip and
/// badge) and the UI when it changed, and warns when it is low — at most once a
/// day, remembered in [`LOW_BATTERY_STAMP_FILE`] so a restart does not repeat it.
fn report_battery(app: &AppHandle, config: &crate::config::AppConfig, config_dir: &Path, percent: u8) {
    let stamp_path = config_dir.join(LOW_BATTERY_STAMP_FILE);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last_warned = std::fs::read_to_string(&stamp_path)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok());
    let low = should_warn_low(percent, last_warned, now);
    let previous = LAST_BATTERY.swap(percent, Ordering::Relaxed);
    if previous != percent || low {
        crate::rebuild_tray_menu_from_config(app, config);
        let _ = app.emit(EVENT_MOUSE_BATTERY, BatteryEvent { percent, low });
    }
    if low {
        if let Err(error) = std::fs::write(&stamp_path, now.to_string()) {
            log::warn!("[onboard-guard] battery warning stamp not saved: {error}");
        }
        let message = format!("Заряд мыши: {percent}%");
        log::warn!("[onboard-guard] {message}");
        // The OSD window is created lazily and its first call only creates it:
        // give the WebView a moment so this warning is not the call that is lost.
        if app.get_webview_window("osd").is_none() {
            crate::show_osd(app, &message, &config.settings);
            std::thread::sleep(Duration::from_secs(1));
        }
        crate::show_osd(app, &message, &config.settings);
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
    let message =
        format!("Проверка мыши: режим Normal, все {buttons} кнопок совпадают с назначениями Sidearm.");
    log::info!("[onboard-guard] {message}");
    if let Ok(mut store) = runtime_store.lock() {
        store.record_info("перехват", message);
    }
}

/// Writes the takeover into the runtime log and tells the UI, at most once per
/// [`NOTIFY_COOLDOWN`] per kind.
fn notify(
    app: &AppHandle,
    runtime_store: &Arc<Mutex<RuntimeStore>>,
    last_notified: &mut Option<(TakeoverKind, Instant)>,
    event: TakeoverEvent,
) {
    let now = Instant::now();
    let throttled = matches!(
        last_notified,
        Some((kind, at)) if *kind == event.kind && now.duration_since(*at) < NOTIFY_COOLDOWN
    );
    let message = takeover_message(&event);
    if throttled {
        // The toast is throttled, the evidence is not: a silent log hid repeated
        // takeovers for a whole session.
        log::info!("[onboard-guard] {message}");
        return;
    }
    *last_notified = Some((event.kind, now));

    log::warn!("[onboard-guard] {message}");
    if let Ok(mut store) = runtime_store.lock() {
        store.record_warn("перехват", message);
    }
    if app.webview_windows().is_empty() {
        return;
    }
    let _ = app.emit(EVENT_ONBOARD_TAKEOVER, &event);
}

fn takeover_message(event: &TakeoverEvent) -> String {
    match (event.kind, event.restored) {
        (TakeoverKind::Mode, true) => {
            "Razer перехватил мышь (режим драйвера) — вернул управление Sidearm.".to_string()
        }
        (TakeoverKind::Mode, false) => {
            "Razer удерживает мышь в режиме драйвера — вернуть управление не удалось.".to_string()
        }
        (TakeoverKind::Mappings, true) => format!(
            "Razer перезаписал назначения кнопок ({}) — восстановил.",
            event.controls.join(", ")
        ),
        (TakeoverKind::Mappings, false) => format!(
            "Назначения кнопок перезаписаны ({}), восстановить не удалось.",
            event.controls.join(", ")
        ),
        (TakeoverKind::RazerStarted, _) => {
            "Запущен Razer Synapse — он будет перезаписывать кнопки; Sidearm проверяет мышь каждые 3 с."
                .to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
