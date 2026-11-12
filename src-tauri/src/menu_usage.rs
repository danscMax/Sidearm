//! How often each menu item was picked: `menu-usage.json` next to the config
//! (`{ action id: count }`), so the menu editor can show which items are used.
//! Kept out of the config itself: a pick must not rewrite (and sync) the config.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE: &str = "menu-usage.json";
static LOCK: Mutex<()> = Mutex::new(());

fn file() -> PathBuf {
    crate::paths::AppPaths::resolve().config_dir.join(FILE)
}

fn read(path: &Path) -> BTreeMap<String, u64> {
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// Count one pick of `action_id`. Best effort: a failed write is only logged.
pub(crate) fn count(action_id: &str) {
    if crate::fake_mode() {
        return;
    }
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = file();
    let mut counts = read(&path);
    *counts.entry(action_id.to_owned()).or_default() += 1;
    let temp = path.with_extension("json.tmp");
    let written = serde_json::to_vec(&counts)
        .map_err(|error| error.to_string())
        .and_then(|bytes| std::fs::write(&temp, bytes).map_err(|error| error.to_string()))
        .and_then(|()| std::fs::rename(&temp, &path).map_err(|error| error.to_string()));
    if let Err(error) = written {
        log::warn!("[menu] could not record the pick: {error}");
    }
}

/// Every action's pick count so far.
pub(crate) fn counts() -> BTreeMap<String, u64> {
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    read(&file())
}
