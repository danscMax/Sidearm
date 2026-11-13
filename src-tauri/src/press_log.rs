//! Daily press counters: `press-log.json` next to the config, for the weekly
//! report, the heat map per layer and the hints. Per day: how often each place
//! fired (`"profile|layer|control|gesture"`) and each action ran (a menu pick
//! counts its item's action). Kept out of the config (a press must not rewrite
//! or sync it), on this computer only, the last [`KEEP_DAYS`] days.
//!
//! Counts gather in memory and are written at most every [`FLUSH_EVERY`] and
//! at exit ([`flush`]): a crash loses at most that long.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub(crate) const FILE_NAME: &str = "press-log.json";
const KEEP_DAYS: usize = 90;
const FLUSH_EVERY: Duration = Duration::from_secs(15);

/// One day's counts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Day {
    #[serde(default)]
    pub slots: BTreeMap<String, u64>,
    #[serde(default)]
    pub actions: BTreeMap<String, u64>,
}

/// Date (YYYY-MM-DD) → counts.
pub(crate) type Log = BTreeMap<String, Day>;

struct Pending {
    log: Log,
    last_flush: Option<Instant>,
}

static PENDING: Mutex<Pending> = Mutex::new(Pending { log: BTreeMap::new(), last_flush: None });

fn file() -> PathBuf {
    crate::paths::AppPaths::resolve().config_dir.join(FILE_NAME)
}

/// The log on disk: empty when there is none yet; an error when it cannot be
/// read (a lock) — then nothing is written over it. A file that does not parse
/// is set aside as `press-log.corrupt.json` and the log starts again.
fn read(path: &Path) -> Result<Log, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_else(|error| {
            log::warn!("[press-log] unreadable log set aside: {error}");
            let _ = std::fs::rename(path, path.with_extension("corrupt.json"));
            Log::new()
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Log::new()),
        Err(error) => Err(error.to_string()),
    }
}

/// Today in local time (YYYY-MM-DD): a day is the user's day, as the UI counts it.
fn today() -> String {
    #[cfg(target_os = "windows")]
    {
        let mut time = windows_sys::Win32::Foundation::SYSTEMTIME::default();
        unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut time) };
        format!("{:04}-{:02}-{:02}", time.wYear, time.wMonth, time.wDay)
    }
    #[cfg(not(target_os = "windows"))]
    {
        crate::backup::today_date_string()
    }
}

/// Adds `more` into `log` and keeps only the newest [`KEEP_DAYS`] days.
fn merge(log: &mut Log, more: &Log) {
    for (date, day) in more {
        let into = log.entry(date.clone()).or_default();
        for (key, n) in &day.slots {
            *into.slots.entry(key.clone()).or_default() += n;
        }
        for (key, n) in &day.actions {
            *into.actions.entry(key.clone()).or_default() += n;
        }
    }
    while log.len() > KEEP_DAYS {
        let oldest = log.keys().next().cloned();
        if let Some(oldest) = oldest {
            log.remove(&oldest);
        }
    }
}

/// The place key of a press: profile, layer, control, press pattern.
pub(crate) fn slot_key(profile: &str, layer: &str, control: &str, gesture: &str) -> String {
    format!("{profile}|{layer}|{control}|{gesture}")
}

/// Count one action run on one place. Fake mode counts nothing.
pub(crate) fn count(slot: &str, action_id: &str) {
    if crate::fake_mode() {
        return;
    }
    let mut pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let day = pending.log.entry(today()).or_default();
    *day.slots.entry(slot.to_owned()).or_default() += 1;
    *day.actions.entry(action_id.to_owned()).or_default() += 1;
    if pending.last_flush.is_none_or(|at| at.elapsed() >= FLUSH_EVERY) {
        write_out(&mut pending);
    }
}

/// Write what gathered (at exit).
pub(crate) fn flush() {
    let mut pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !pending.log.is_empty() {
        write_out(&mut pending);
    }
}

fn write_out(pending: &mut Pending) {
    pending.last_flush = Some(Instant::now());
    let path = file();
    let mut log = match read(&path) {
        Ok(log) => log,
        Err(error) => {
            log::warn!("[press-log] could not read the log, kept in memory: {error}");
            return;
        }
    };
    merge(&mut log, &pending.log);
    let temp = path.with_extension("json.tmp");
    let written = serde_json::to_vec(&log)
        .map_err(|error| error.to_string())
        .and_then(|bytes| std::fs::write(&temp, bytes).map_err(|error| error.to_string()))
        .and_then(|()| std::fs::rename(&temp, &path).map_err(|error| error.to_string()));
    match written {
        Ok(()) => pending.log.clear(),
        Err(error) => log::warn!("[press-log] could not write: {error}"),
    }
}

/// The log on disk plus what has not been written yet.
pub(crate) fn snapshot() -> Log {
    let pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut log = read(&file()).unwrap_or_default();
    merge(&mut log, &pending.log);
    log
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_adds_counts_and_keeps_the_newest_days() {
        let day = |slot: u64| Day { slots: BTreeMap::from([("p|standard|thumb_01|press".into(), slot)]), actions: BTreeMap::new() };
        let mut log: Log = (0..KEEP_DAYS).map(|n| (format!("2026-01-{n:03}"), day(1))).collect();
        let more: Log = BTreeMap::from([("2026-01-000".into(), day(2)), ("2027-01-01".into(), day(5))]);
        merge(&mut log, &more);
        assert_eq!(log.len(), KEEP_DAYS);
        assert!(!log.contains_key("2026-01-000"), "the oldest day goes");
        assert_eq!(log["2027-01-01"].slots["p|standard|thumb_01|press"], 5);
        assert_eq!(slot_key("p", "hypershift", "v3_thumb_08", "longPress"), "p|hypershift|v3_thumb_08|longPress");
    }
}
