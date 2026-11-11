//! Consumer-page button signals (plans/consumer-path/plan.md). The mouse's key
//! buttons hold reserved consumer usages that Windows ignores, so the capture
//! helper reads the presses straight from the HID collection and writes the
//! same lines the keyboard hook writes for `F13`..`F24` (`F13`, `HS:F13`,
//! `REPEAT:F13`, `UP:F13`) — the parent, the resolver and holds see no
//! difference. The collection opens shared next to Razer's driver (measured).

use std::time::{Duration, Instant};

use crate::mouse_memory::ConsumerSignal;
use crate::device_catalog::NativeModel;

const HS_PREFIX: &str = "HS:";
/// Outermost stamp of a reader line sent while its mouse's HyperShift 2
/// trigger is held (`H2:HS:F13`).
pub(super) const H2_PREFIX: &str = "H2:";
/// A hold with no report for this long is released: the device reports changes
/// only, so a mouse that powered off mid-press (dongle still present) never
/// sends the release. It cannot be asked instead — measured 2026-10-27: its
/// `HidD_GetInputReport` answers "nothing held" while a button is held.
// shortcut: a fixed bound also cuts a genuine hold this long (push-to-talk past
// 10 min); make it a setting if someone holds a button that long.
const HOLD_GIVE_UP_AFTER: Duration = Duration::from_secs(600);
/// Helper lines telling the parent whether the button signals can be read.
pub(super) const STATUS_UNREADABLE: &str = "STATUS:buttonsUnreadable";
pub(super) const STATUS_READABLE: &str = "STATUS:buttonsReadable";

/// Usages held according to one input report: after the report id, little-
/// endian `u16` slots up to the first zero (`02 10 00` = usage `0x10` down,
/// `02 00 00` = nothing held). `None` for a report of another id.
pub(super) fn held_usages(report: &[u8], report_id: u8) -> Option<Vec<u16>> {
    let (&id, slots) = report.split_first()?;
    if id != report_id {
        return None;
    }
    Some(
        slots
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|usage| *usage != 0)
            .collect(),
    )
}

/// Turns successive held-usage sets into helper lines and synthesises the
/// auto-repeat a keyboard key gets from Windows (tap-mode shortcuts rely on
/// `REPEAT:`; the resolver drops it for everything else).
pub(super) struct Translator {
    signals: Vec<ConsumerSignal>,
    /// Usage held, and when its next `REPEAT:` is due.
    held: Vec<(u16, Instant)>,
    delay: Duration,
    period: Duration,
    /// When the device last told its state (a report or an answered query).
    last_report: Instant,
}

impl Translator {
    pub(super) fn new(signals: Vec<ConsumerSignal>, delay: Duration, period: Duration) -> Self {
        Self { signals, held: Vec::new(), delay, period, last_report: Instant::now() }
    }

    /// Whether something is held and the device has said nothing for `after`.
    pub(super) fn silent_hold(&self, now: Instant, after: Duration) -> bool {
        !self.held.is_empty() && now.saturating_duration_since(self.last_report) >= after
    }

    fn signal(&self, usage: u16) -> Option<&ConsumerSignal> {
        self.signals.iter().find(|signal| signal.usage == usage)
    }

    /// Lines for a new report: `UP:` for every usage no longer held, a press
    /// for every newly held one. A report repeating the held set yields none.
    pub(super) fn report(&mut self, usages: &[u16], now: Instant, hyper: bool) -> Vec<String> {
        self.last_report = now;
        let mut lines = Vec::new();
        let released: Vec<u16> =
            self.held.iter().map(|(u, _)| *u).filter(|u| !usages.contains(u)).collect();
        for usage in released {
            self.held.retain(|(u, _)| *u != usage);
            if let Some(signal) = self.signal(usage) {
                lines.push(signal_line(signal, "UP:", hyper));
            }
        }
        for &usage in usages {
            if self.held.iter().any(|(u, _)| *u == usage) {
                continue;
            }
            // An unknown usage is not ours (or not bound): never held, never sent.
            if let Some(signal) = self.signal(usage) {
                lines.push(signal_line(signal, "", hyper));
                self.held.push((usage, now + self.delay));
            }
        }
        lines
    }

    /// `REPEAT:` lines for every held usage whose repeat is due.
    pub(super) fn repeats(&mut self, now: Instant, hyper: bool) -> Vec<String> {
        let mut due = Vec::new();
        for (usage, next) in &mut self.held {
            if *next <= now {
                due.push(*usage);
                *next = now + self.period;
            }
        }
        due.into_iter()
            .filter_map(|usage| self.signal(usage).map(|signal| signal_line(signal, "REPEAT:", hyper)))
            .collect()
    }

    /// The earliest due repeat, to bound the wait for the next report.
    pub(super) fn next_deadline(&self) -> Option<Instant> {
        self.held.iter().map(|(_, next)| *next).min()
    }

    /// `UP:` for everything held: the device went away mid-press, and a hold
    /// must never outlive the button.
    pub(super) fn release_all(&mut self, hyper: bool) -> Vec<String> {
        self.report(&[], Instant::now(), hyper)
    }
}

fn signal_line(signal: &ConsumerSignal, kind: &str, hyper: bool) -> String {
    let layer = if hyper || signal.hypershift { HS_PREFIX } else { "" };
    format!("{layer}{kind}{}", signal.encoded_key)
}

/// Windows' own keyboard repeat timing (Control Panel → Keyboard), so a held
/// mouse button repeats like the `F13` it replaces did.
fn keyboard_repeat_timing() -> (Duration, Duration) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SPI_GETKEYBOARDDELAY, SPI_GETKEYBOARDSPEED, SystemParametersInfoW,
    };
    let mut delay: u32 = 1;
    let mut speed: u32 = 31;
    unsafe {
        SystemParametersInfoW(SPI_GETKEYBOARDDELAY, 0, (&mut delay as *mut u32).cast(), 0);
        SystemParametersInfoW(SPI_GETKEYBOARDSPEED, 0, (&mut speed as *mut u32).cast(), 0);
    }
    repeat_timing(delay, speed)
}

/// `SPI_GETKEYBOARDDELAY` 0..=3 is 250..=1000 ms; `SPI_GETKEYBOARDSPEED`
/// 0..=31 is about 2.5..=30 repeats per second.
fn repeat_timing(delay: u32, speed: u32) -> (Duration, Duration) {
    let delay = Duration::from_millis(250 * (u64::from(delay.min(3)) + 1));
    let per_second = 2.5 + f64::from(speed.min(31)) * (27.5 / 31.0);
    (delay, Duration::from_secs_f64(1.0 / per_second))
}

/// Starts the reader thread. It opens the consumer collection, translates every
/// report, and reopens after the dongle sleeps or is unplugged; `hyper` tells
/// whether the Hypershift trigger is held, read when a report arrives (the
/// stamp is a capture-time decision, as for the keyboard hook).
/// Prefix of every line a reader writes: `M<catalog index>:`, so the parent
/// knows which mouse sent it.
pub(super) fn reader_prefix(model: &NativeModel) -> String {
    format!("M{}:", model.catalog_index())
}

/// The catalog model of a reader line, and the line without its prefix.
pub(super) fn split_reader_line(line: &str) -> Option<(&'static NativeModel, &str)> {
    let rest = line.strip_prefix('M')?;
    let (index, rest) = rest.split_once(':')?;
    let model = crate::device_catalog::CATALOG.get(index.parse::<usize>().ok()?)?;
    Some((model, rest))
}

/// `stamp2` tells whether lines about to be sent belong to the HyperShift 2
/// layer (it sees them, so a press can mark the trigger as used).
pub(super) fn spawn_reader(
    signals: Vec<ConsumerSignal>,
    model: &'static NativeModel,
    hyper: fn() -> bool,
    stamp2: fn(&[String]) -> bool,
    report_status: bool,
) {
    let signal_prefix = reader_prefix(model);
    let Some(consumer) = &model.consumer else { return };
    let report_id = consumer.report_id;
    let (delay, period) = keyboard_repeat_timing();
    let spawned = std::thread::Builder::new().name("consumer-reader".into()).spawn(move || {
        let mut translator = Translator::new(signals, delay, period);
        // Logged once per distinct failure: a mouse that stays away retries
        // every two seconds and must not flood the log.
        let mut last_error = String::new();
        loop {
            match read_until_lost(&mut translator, model, report_id, hyper, stamp2, report_status, &signal_prefix) {
                Ok(()) => return, // the parent is gone
                Err(message) => {
                    if !emit_stamped(&translator.release_all(hyper()), &signal_prefix, stamp2) {
                        return;
                    }
                    // Warn level: the parent logs it as a warning — while this
                    // lasts the key buttons do nothing; the status line puts it
                    // in the Mouse tab.
                    // The parent keeps the state, so repeating it is harmless.
                    if report_status && !emit(&[STATUS_UNREADABLE.to_string()], &signal_prefix) {
                        return;
                    }
                    if message != last_error && report_status {
                        log::warn!("[consumer] no button signals right now: {message}");
                        last_error = message;
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
    if let Err(error) = spawned {
        log::error!("[consumer] reader thread not started: {error}");
    }
}

/// Writes helper lines to stdout. `false` once the parent closed the pipe.
fn emit(lines: &[String], prefix: &str) -> bool {
    use std::io::Write;
    if lines.is_empty() {
        return true;
    }
    let mut out = std::io::stdout().lock();
    lines.iter().all(|line| writeln!(out, "{prefix}{line}").is_ok()) && out.flush().is_ok()
}

/// [`emit`] with the `H2:` stamp when `stamp2` says so.
fn emit_stamped(lines: &[String], prefix: &str, stamp2: fn(&[String]) -> bool) -> bool {
    if stamp2(lines) {
        emit(lines, &format!("{prefix}{H2_PREFIX}"))
    } else {
        emit(lines, prefix)
    }
}

/// Reads reports until the device fails (`Err`, reopen) or stdout closes (`Ok`).
fn read_until_lost(
    translator: &mut Translator,
    model: &NativeModel,
    report_id: u8,
    hyper: fn() -> bool,
    stamp2: fn(&[String]) -> bool,
    report_status: bool,
    signal_prefix: &str,
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_IO_PENDING, GENERIC_READ, GetLastError, INVALID_HANDLE_VALUE,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, ReadFile,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};

    let paths = crate::mouse_memory::consumer_collection_paths(model)?;
    let (handle, path) = crate::mouse_memory::open_first(&paths, |path| {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            Err(format!("CreateFileW({path}): {}", std::io::Error::last_os_error()))
        } else {
            Ok((handle, path.to_string()))
        }
    })?;
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        unsafe { CloseHandle(handle) };
        return Err(format!("CreateEventW: {}", std::io::Error::last_os_error()));
    }
    log::info!("[consumer] reading button signals from {path}");
    if report_status && !emit(&[STATUS_READABLE.to_string()], signal_prefix) {
        unsafe {
            CloseHandle(event);
            CloseHandle(handle);
        }
        return Ok(());
    }

    // Larger than the 16-byte report; HID reads need at least the report size.
    let mut buffer = [0u8; 64];
    let result = loop {
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event;
        let mut read: u32 = 0;
        let started = unsafe {
            ReadFile(handle, buffer.as_mut_ptr(), buffer.len() as u32, &mut read, &mut overlapped)
        };
        if started == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            break Err(format!("ReadFile: {}", std::io::Error::last_os_error()));
        }
        // Wait for the report, waking for every due auto-repeat meanwhile.
        // `None` = completed; `Some(result)` = give up this handle.
        let stop: Option<Result<(), String>> = loop {
            let timeout = translator.next_deadline().map_or(INFINITE, |due| {
                due.saturating_duration_since(Instant::now()).as_millis().min(u128::from(INFINITE - 1)) as u32
            });
            match unsafe { WaitForSingleObject(event, timeout) } {
                WAIT_OBJECT_0 => break None,
                WAIT_TIMEOUT => {
                    let now = Instant::now();
                    let mut lines = translator.repeats(now, hyper());
                    if translator.silent_hold(now, HOLD_GIVE_UP_AFTER) {
                        log::warn!("[consumer] hold released after {HOLD_GIVE_UP_AFTER:?} without a report");
                        lines.extend(translator.release_all(hyper()));
                    }
                    if !emit_stamped(&lines, signal_prefix, stamp2) {
                        break Some(Ok(()));
                    }
                }
                _ => break Some(Err(format!("wait: {}", std::io::Error::last_os_error()))),
            }
        };
        if let Some(result) = stop {
            unsafe { CancelIoEx(handle, &overlapped) };
            // The cancelled read still owns `buffer` until it completes.
            unsafe { GetOverlappedResult(handle, &overlapped, &mut read, 1) };
            break result;
        }
        if unsafe { GetOverlappedResult(handle, &overlapped, &mut read, 0) } == 0 {
            break Err(format!("read: {}", std::io::Error::last_os_error()));
        }
        let Some(usages) = held_usages(&buffer[..read as usize], report_id) else {
            continue;
        };
        if !emit_stamped(&translator.report(&usages, Instant::now(), hyper()), signal_prefix, stamp2) {
            break Ok(());
        }
    };
    unsafe {
        CloseHandle(event);
        CloseHandle(handle);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn translator() -> Translator {
        let signals = vec![
            ConsumerSignal { usage: 0x10, encoded_key: "F13".into(), hypershift: false },
            ConsumerSignal { usage: 0x11, encoded_key: "F14".into(), hypershift: false },
        ];
        Translator::new(signals, Duration::from_millis(500), Duration::from_millis(100))
    }

    #[test]
    fn reports_parse_as_held_usages() {
        assert_eq!(held_usages(&[0x02, 0x10, 0x00, 0, 0], 0x02), Some(vec![0x10]));
        assert_eq!(held_usages(&[0x02, 0xfe, 0x00, 0x11, 0x00, 0, 0], 0x02), Some(vec![0xfe, 0x11]));
        assert_eq!(held_usages(&[0x02, 0x00, 0x00, 0x10, 0x00], 0x02), Some(vec![]));
        assert_eq!(held_usages(&[0x02, 0x3c, 0x02], 0x02), Some(vec![0x023c]));
        assert_eq!(held_usages(&[0x01, 0x10, 0x00], 0x02), None);
        assert_eq!(held_usages(&[], 0x02), None);
    }

    #[test]
    fn press_release_and_unknown_usages() {
        let mut t = translator();
        let now = Instant::now();
        assert_eq!(t.report(&[0x10], now, false), ["F13"]);
        // The same set again (a device that repeats its report) is not a press.
        assert!(t.report(&[0x10], now, false).is_empty());
        assert_eq!(t.report(&[0x10, 0x11, 0x99], now, false), ["F14"]);
        assert_eq!(t.report(&[0x11], now, true), ["HS:UP:F13"]);
        assert_eq!(t.report(&[], now, false), ["UP:F14"]);
        assert!(t.next_deadline().is_none());
    }

    #[test]
    fn hypershift_stamps_the_press() {
        let mut t = translator();
        assert_eq!(t.report(&[0x11], Instant::now(), true), ["HS:F14"]);
    }

    #[test]
    fn naga_v3_reports_translate_all_thumb_presses_and_releases_on_both_layers() {
        let config = crate::mouse_memory::live_overlay::tests::config_with_v3();
        let signals = crate::mouse_memory::live_overlay::overlay(&config, &crate::device_catalog::NAGA_V3_PRO, true, false)
            .unwrap()
            .signals;
        let mut reader = Translator::new(signals.clone(), Duration::from_millis(500), Duration::from_millis(100));
        let now = Instant::now();
        for (index, signal) in signals[..24].iter().enumerate() {
            let [low, high] = signal.usage.to_le_bytes();
            let press = held_usages(&[2, low, high, 0, 0], 2).unwrap();
            let layer = if index % 2 == 0 { "" } else { "HS:" };
            let key = &signal.encoded_key;
            assert_eq!(reader.report(&press, now, false), [format!("{layer}{key}")]);
            assert_eq!(reader.report(&[], now, false), [format!("{layer}UP:{key}")]);
        }
    }

    #[test]
    fn held_buttons_repeat_after_the_delay_then_every_period() {
        let mut t = translator();
        let start = Instant::now();
        t.report(&[0x10], start, false);
        assert!(t.repeats(start + Duration::from_millis(499), false).is_empty());
        assert_eq!(t.repeats(start + Duration::from_millis(500), false), ["REPEAT:F13"]);
        assert!(t.repeats(start + Duration::from_millis(550), false).is_empty());
        assert_eq!(t.repeats(start + Duration::from_millis(600), true), ["HS:REPEAT:F13"]);
        t.report(&[], start + Duration::from_millis(650), false);
        assert!(t.repeats(start + Duration::from_secs(5), false).is_empty());
    }

    /// Only a hold the device has been silent about counts as silent.
    #[test]
    fn a_hold_is_silent_only_without_reports() {
        let mut t = translator();
        let start = Instant::now();
        assert!(!t.silent_hold(start + Duration::from_secs(60), Duration::from_secs(5)), "nothing held");
        t.report(&[0x10], start, false);
        assert!(!t.silent_hold(start + Duration::from_secs(4), Duration::from_secs(5)));
        assert!(t.silent_hold(start + Duration::from_secs(5), Duration::from_secs(5)));
        // A report repeating the held set restarts the silence.
        assert!(t.report(&[0x10], start + Duration::from_secs(5), false).is_empty());
        assert!(!t.silent_hold(start + Duration::from_secs(9), Duration::from_secs(5)));
        assert_eq!(t.report(&[], start + Duration::from_secs(10), false), ["UP:F13"]);
    }

    #[test]
    fn release_all_ends_every_hold() {
        let mut t = translator();
        t.report(&[0x10, 0x11], Instant::now(), false);
        assert_eq!(t.release_all(false), ["UP:F13", "UP:F14"]);
        assert!(t.release_all(false).is_empty());
    }

    #[test]
    fn repeat_timing_follows_the_control_panel_range() {
        assert_eq!(repeat_timing(0, 31).0, Duration::from_millis(250));
        assert_eq!(repeat_timing(3, 0).0, Duration::from_secs(1));
        assert!((repeat_timing(1, 31).1.as_secs_f64() - 1.0 / 30.0).abs() < 1e-9);
        assert!((repeat_timing(1, 0).1.as_secs_f64() - 0.4).abs() < 1e-9);
    }
}
