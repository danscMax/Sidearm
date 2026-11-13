//! Daily press counters: `press-log-<computer>.json` next to the config (one
//! file per computer, added up when read: `machine_files`), for the weekly
//! report, the heat map per layer and the hints. Per day: how often each place
//! fired (`"profile|layer|control|gesture"`) and each action ran (a menu pick
//! counts its item's action). Kept out of the config (a press must not rewrite
//! or sync it), the last [`KEEP_DAYS`] days.
//!
//! Counts gather in memory and are written at most every [`FLUSH_EVERY`] and
//! at exit ([`flush`]): a crash loses at most that long.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub(crate) const STEM: &str = "press-log";
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

fn dir() -> PathBuf {
    crate::paths::AppPaths::resolve().config_dir
}

/// The log on disk: empty when there is none yet; an error when it cannot be
/// read (a lock) — then nothing is written over it. A file that does not parse
/// counts as empty; before a write over it (`set_aside`) it is kept as
/// `press-log-<computer>.corrupt-<unix seconds>.json`.
fn read(path: &Path, set_aside: bool) -> Result<Log, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_else(|error| {
            if set_aside {
                let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                log::warn!("[press-log] unreadable log set aside: {error}");
                let _ = std::fs::rename(path, path.with_extension(format!("corrupt-{stamp}.json")));
            }
            Log::new()
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Log::new()),
        Err(error) => Err(error.to_string()),
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

/// Count one action run, and the place it was pressed on (`None`: a menu
/// pick, whose press was counted when the menu opened). Fake mode counts nothing.
pub(crate) fn count(slot: Option<&str>, action_id: &str) {
    if crate::fake_mode() {
        return;
    }
    let mut pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let day = pending.log.entry(crate::backup::local_date_string()).or_default();
    if let Some(slot) = slot {
        *day.slots.entry(slot.to_owned()).or_default() += 1;
    }
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
    let path = crate::machine_files::own(&dir(), STEM);
    let mut log = match read(&path, true) {
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

/// Every computer's log plus what has not been written yet.
pub(crate) fn snapshot() -> Log {
    let pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut log = Log::new();
    for file in crate::machine_files::all(&dir(), STEM) {
        merge(&mut log, &read(&file, false).unwrap_or_default());
    }
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
