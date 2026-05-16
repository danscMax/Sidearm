//! Hybrid retention cleanup for the rotated log files written by
//! `tauri-plugin-log`.
//!
//! The plugin itself supports only `KeepAll` or `KeepOne` rotation strategies,
//! neither of which fits our needs: `KeepAll` filled the disk (seen at 128 GB),
//! and `KeepOne` keeps almost no history for diagnostics.  We run this sweep
//! once at startup, before the plugin opens any file, so the deletes never
//! race with the writer.
//!
//! Retention rules (applied in order):
//! 1. Delete any log older than `max_age_days`.
//! 2. If more than `max_files` remain, delete the oldest until at most
//!    `max_files` are left.
//!
//! Orphan sweeps: when running in portable mode, the previous runs of Sidearm
//! that happened in roaming mode left logs accumulating in `%LOCALAPPDATA%\
//! com.sidearm.desktop\logs\`.  `sweep_orphan_log_dir` handles that case by
//! running the same retention against an unrelated directory.

use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

const LOG_EXTENSION: &str = "log";

/// Sweep the log directory.  Returns `(deleted_count, kept_count)` for logging.
/// Errors on individual files are swallowed — this is best-effort cleanup and
/// must never block app startup.
pub fn sweep(log_dir: &Path, max_age_days: u64, max_files: usize) -> (usize, usize) {
    let entries = match fs::read_dir(log_dir) {
        Ok(it) => it,
        Err(_) => return (0, 0),
    };

    let mut logs: Vec<(std::path::PathBuf, SystemTime)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some(LOG_EXTENSION) {
                return None;
            }
            let mtime = entry.metadata().and_then(|m| m.modified()).ok()?;
            Some((path, mtime))
        })
        .collect();

    let max_age = Duration::from_secs(max_age_days * 24 * 60 * 60);
    let cutoff = SystemTime::now().checked_sub(max_age);
    let mut deleted = 0usize;

    logs.retain(|(path, mtime)| {
        let too_old = cutoff.map(|c| *mtime < c).unwrap_or(false);
        if too_old {
            if fs::remove_file(path).is_ok() {
                deleted += 1;
            }
            false
        } else {
            true
        }
    });

    if logs.len() > max_files {
        logs.sort_by_key(|(_, mtime)| *mtime);
        let excess = logs.len() - max_files;
        for (path, _) in logs.drain(..excess) {
            if fs::remove_file(&path).is_ok() {
                deleted += 1;
            }
        }
    }

    (deleted, logs.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, io::Write, thread::sleep};

    fn touch(dir: &Path, name: &str, age: Duration) -> std::path::PathBuf {
        let path = dir.join(name);
        let mut f = File::create(&path).expect("create");
        f.write_all(b"x").expect("write");
        let mtime = SystemTime::now() - age;
        f.set_modified(mtime).expect("mtime");
        path
    }

    #[test]
    fn removes_files_older_than_cutoff() {
        let temp = tempfile::tempdir().expect("tempdir");
        let old = touch(temp.path(), "Sidearm_old.log", Duration::from_secs(8 * 86400));
        let fresh = touch(temp.path(), "Sidearm_new.log", Duration::from_secs(60));

        let (deleted, kept) = sweep(temp.path(), 7, 100);
        assert_eq!(deleted, 1);
        assert_eq!(kept, 1);
        assert!(!old.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn enforces_max_files_after_age_cutoff() {
        let temp = tempfile::tempdir().expect("tempdir");
        for i in 0..10 {
            touch(
                temp.path(),
                &format!("Sidearm_{i}.log"),
                Duration::from_secs(i * 60),
            );
            // ensure distinct mtimes on filesystems with second-resolution.
            sleep(Duration::from_millis(5));
        }

        let (deleted, kept) = sweep(temp.path(), 30, 3);
        assert_eq!(deleted, 7);
        assert_eq!(kept, 3);
    }

    #[test]
    fn ignores_non_log_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let other = temp.path().join("config.json");
        File::create(&other).expect("create").write_all(b"{}").unwrap();
        touch(temp.path(), "Sidearm_old.log", Duration::from_secs(30 * 86400));

        let (deleted, _) = sweep(temp.path(), 7, 100);
        assert_eq!(deleted, 1);
        assert!(other.exists());
    }

    #[test]
    fn missing_dir_is_a_no_op() {
        let (deleted, kept) = sweep(Path::new("nonexistent-dir-xyz-12345"), 7, 50);
        assert_eq!(deleted, 0);
        assert_eq!(kept, 0);
    }
}
