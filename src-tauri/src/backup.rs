//! Rotating backups and daily snapshots for the config file.
//!
//! On every successful save we rotate `config.bak.1` → `.bak.2` → `.bak.3`
//! and copy the pre-write `config.json` to `.bak.1`. A daily snapshot is
//! written to `snapshots/YYYY-MM-DD.json` (first save of the day) and old
//! snapshots are pruned to keep the 14 newest.
//!
//! The `config.last-known-good.json` marker is updated only after a
//! successful *load*, guaranteeing it's a config that loaded cleanly at
//! least once — distinct from the most recent save.

use std::{
    fs,
    io,
    path::{Path, PathBuf},
};

pub const CONFIG_FILE_NAME: &str = "config.json";
pub const LAST_KNOWN_GOOD_FILE: &str = "config.last-known-good.json";
pub const BACKUP_PREFIX: &str = "config.bak.";
pub const SNAPSHOTS_DIR_NAME: &str = "snapshots";
pub const MAX_ROLLING_BACKUPS: usize = 3;
pub const MAX_SNAPSHOTS: usize = 14;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum BackupKind {
    Rolling(usize),
    Snapshot(String),
    LastKnownGood,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: PathBuf,
    pub kind: BackupKind,
    pub bytes: u64,
    pub modified_ms: u128,
}

/// Rotate numbered backups before a save.
/// `config.bak.N` is deleted; `.bak.N-1` → `.bak.N`, … `.bak.1` → `.bak.2`;
/// the current `config.json` is copied to `.bak.1`.
///
/// Resumable: rotation walks top-down, so a crash mid-rotation leaves a
/// strictly-smaller (but valid) backup set.
/// Idempotent on empty state: no-op if `config.json` does not exist.
pub fn rotate_rolling_backups(config_dir: &Path) -> io::Result<Option<PathBuf>> {
    let config_path = config_dir.join(CONFIG_FILE_NAME);
    if !config_path.is_file() {
        return Ok(None);
    }

    let oldest = config_dir.join(format!("{BACKUP_PREFIX}{MAX_ROLLING_BACKUPS}"));
    if oldest.exists() {
        let _ = fs::remove_file(&oldest);
    }

    for slot in (1..MAX_ROLLING_BACKUPS).rev() {
        let src = config_dir.join(format!("{BACKUP_PREFIX}{slot}"));
        let dst = config_dir.join(format!("{BACKUP_PREFIX}{}", slot + 1));
        if src.exists() {
            let _ = fs::rename(&src, &dst);
        }
    }

    let bak1 = config_dir.join(format!("{BACKUP_PREFIX}1"));
    fs::copy(&config_path, &bak1)?;
    Ok(Some(bak1))
}

/// Copy the on-disk `config.json` to `config.last-known-good.json`.
/// Call this *after* a successful load+validate so the marker always
/// points at a config that parsed cleanly.
pub fn mark_last_known_good(config_dir: &Path) -> io::Result<()> {
    let config_path = config_dir.join(CONFIG_FILE_NAME);
    if !config_path.is_file() {
        return Ok(());
    }
    let lkg = config_dir.join(LAST_KNOWN_GOOD_FILE);
    fs::copy(&config_path, &lkg)?;
    Ok(())
}

/// Write today's snapshot if not present, then prune the snapshots dir to
/// keep the 14 newest by date. Best-effort: IO errors bubble up but the
/// caller typically logs and moves on.
pub fn write_daily_snapshot_and_prune(config_dir: &Path) -> io::Result<()> {
    let config_path = config_dir.join(CONFIG_FILE_NAME);
    if !config_path.is_file() {
        return Ok(());
    }

    let snapshots_dir = config_dir.join(SNAPSHOTS_DIR_NAME);
    fs::create_dir_all(&snapshots_dir)?;

    let today = today_date_string();
    let today_snapshot = snapshots_dir.join(format!("{today}.json"));
    if !today_snapshot.exists() {
        fs::copy(&config_path, &today_snapshot)?;
    }

    prune_snapshots(&snapshots_dir, MAX_SNAPSHOTS)?;
    Ok(())
}

fn prune_snapshots(snapshots_dir: &Path, keep: usize) -> io::Result<()> {
    let mut entries: Vec<PathBuf> = fs::read_dir(snapshots_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();

    entries.sort();

    if entries.len() > keep {
        let to_drop = entries.len() - keep;
        for path in entries.iter().take(to_drop) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

/// Enumerate existing backups (rolling, snapshots, last-known-good),
/// sorted newest-first by modification time.
pub fn list_backups(config_dir: &Path) -> io::Result<Vec<BackupEntry>> {
    let mut entries: Vec<BackupEntry> = Vec::new();

    for slot in 1..=MAX_ROLLING_BACKUPS {
        let path = config_dir.join(format!("{BACKUP_PREFIX}{slot}"));
        if let Some((bytes, modified_ms)) = entry_meta(&path) {
            entries.push(BackupEntry {
                path,
                kind: BackupKind::Rolling(slot),
                bytes,
                modified_ms,
            });
        }
    }

    let lkg = config_dir.join(LAST_KNOWN_GOOD_FILE);
    if let Some((bytes, modified_ms)) = entry_meta(&lkg) {
        entries.push(BackupEntry {
            path: lkg,
            kind: BackupKind::LastKnownGood,
            bytes,
            modified_ms,
        });
    }

    let snapshots_dir = config_dir.join(SNAPSHOTS_DIR_NAME);
    if snapshots_dir.is_dir() {
        if let Ok(read) = fs::read_dir(&snapshots_dir) {
            for e in read.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext == "json") {
                    let date_stem = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    if let Some((bytes, modified_ms)) = entry_meta(&path) {
                        entries.push(BackupEntry {
                            path,
                            kind: BackupKind::Snapshot(date_stem),
                            bytes,
                            modified_ms,
                        });
                    }
                }
            }
        }
    }

    entries.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(entries)
}

/// Reject paths pointing outside the configured backup dirs. Prevents
/// path-traversal when the frontend asks to restore an arbitrary backup.
pub fn is_valid_backup_location(config_dir: &Path, candidate: &Path) -> bool {
    let Ok(candidate_abs) = candidate.canonicalize() else {
        return false;
    };
    let Ok(config_abs) = config_dir.canonicalize() else {
        return false;
    };
    candidate_abs.starts_with(&config_abs)
}

fn entry_meta(path: &Path) -> Option<(u64, u128)> {
    let meta = fs::metadata(path).ok()?;
    let bytes = meta.len();
    let ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some((bytes, ms))
}

fn today_date_string() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = ymd_from_unix_secs(secs);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's civil_from_days — Unix seconds → (year, month, day).
/// Reliable for all dates after 1970-01-01.
fn ymd_from_unix_secs(secs: i64) -> (i32, u32, u32) {
    let z = secs.div_euclid(86_400) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_config(dir: &Path, contents: &str) {
        let mut f = fs::File::create(dir.join(CONFIG_FILE_NAME)).expect("create config");
        f.write_all(contents.as_bytes()).expect("write");
    }

    #[test]
    fn rotate_noop_when_config_missing() {
        let temp = tempfile::tempdir().expect("tempdir");
        let result = rotate_rolling_backups(temp.path()).expect("rotate");
        assert!(result.is_none());
    }

    #[test]
    fn rotate_creates_bak1_on_first_rotation() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_config(temp.path(), "v1");
        let bak1 = rotate_rolling_backups(temp.path()).expect("rotate").expect("some");
        assert_eq!(bak1, temp.path().join("config.bak.1"));
        assert!(bak1.is_file());
    }

    #[test]
    fn rotate_shifts_through_all_slots() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_config(temp.path(), "v1");

        rotate_rolling_backups(temp.path()).expect("rot1");
        write_config(temp.path(), "v2");
        rotate_rolling_backups(temp.path()).expect("rot2");
        write_config(temp.path(), "v3");
        rotate_rolling_backups(temp.path()).expect("rot3");
        write_config(temp.path(), "v4");
        rotate_rolling_backups(temp.path()).expect("rot4");

        let bak1 = fs::read_to_string(temp.path().join("config.bak.1")).unwrap();
        let bak2 = fs::read_to_string(temp.path().join("config.bak.2")).unwrap();
        let bak3 = fs::read_to_string(temp.path().join("config.bak.3")).unwrap();

        assert_eq!(bak1, "v4", "most recent backup");
        assert_eq!(bak2, "v3");
        assert_eq!(bak3, "v2");
        assert!(
            !temp.path().join("config.bak.4").exists(),
            "never creates slot beyond MAX_ROLLING_BACKUPS"
        );
    }

    #[test]
    fn mark_last_known_good_copies_config() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_config(temp.path(), "good");
        mark_last_known_good(temp.path()).expect("mark");
        let lkg = fs::read_to_string(temp.path().join(LAST_KNOWN_GOOD_FILE)).unwrap();
        assert_eq!(lkg, "good");
    }

    #[test]
    fn daily_snapshot_is_idempotent_within_day() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_config(temp.path(), "day-a");
        write_daily_snapshot_and_prune(temp.path()).expect("snap1");
        write_config(temp.path(), "day-b");
        write_daily_snapshot_and_prune(temp.path()).expect("snap2");

        let snapshots_dir = temp.path().join(SNAPSHOTS_DIR_NAME);
        let entries: Vec<_> = fs::read_dir(&snapshots_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1, "one snapshot per day");
        let contents = fs::read_to_string(&entries[0].path()).unwrap();
        assert_eq!(contents, "day-a", "snapshot uses first save of day");
    }

    #[test]
    fn list_backups_sorts_newest_first() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_config(temp.path(), "v1");
        rotate_rolling_backups(temp.path()).expect("rot");
        write_config(temp.path(), "v2");
        mark_last_known_good(temp.path()).expect("lkg");
        write_daily_snapshot_and_prune(temp.path()).expect("snap");

        let entries = list_backups(temp.path()).expect("list");
        assert!(entries.len() >= 2, "at least rolling + lkg");
        for w in entries.windows(2) {
            assert!(
                w[0].modified_ms >= w[1].modified_ms,
                "descending by modified time"
            );
        }
    }

    #[test]
    fn prune_snapshots_keeps_newest_n() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dir = temp.path().to_path_buf();
        for day in 1..=20 {
            fs::File::create(dir.join(format!("2020-01-{day:02}.json")))
                .expect("create snap");
        }
        prune_snapshots(&dir, 5).expect("prune");
        let remaining: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(remaining.len(), 5, "keeps 5 newest");
        // Names sort lexicographically → the 5 highest stay
        let mut names: Vec<String> = remaining
            .iter()
            .map(|n| n.to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names[0], "2020-01-16.json");
        assert_eq!(names[4], "2020-01-20.json");
    }

    #[test]
    fn ymd_conversion_sanity() {
        // Unix epoch
        assert_eq!(ymd_from_unix_secs(0), (1970, 1, 1));
        // 2024-01-01 00:00:00 UTC
        assert_eq!(ymd_from_unix_secs(1_704_067_200), (2024, 1, 1));
        // 2026-04-24 00:00:00 UTC
        assert_eq!(ymd_from_unix_secs(1_776_988_800), (2026, 4, 24));
        // 2020-02-29 (leap day) 00:00:00 UTC
        assert_eq!(ymd_from_unix_secs(1_582_934_400), (2020, 2, 29));
    }

    #[test]
    fn is_valid_backup_location_rejects_traversal() {
        let temp = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::NamedTempFile::new().expect("outside");
        assert!(!is_valid_backup_location(
            temp.path(),
            outside.path()
        ));
    }

    #[test]
    fn is_valid_backup_location_accepts_child() {
        let temp = tempfile::tempdir().expect("tempdir");
        let child = temp.path().join("config.bak.1");
        fs::File::create(&child).expect("create");
        assert!(is_valid_backup_location(temp.path(), &child));
    }
}
