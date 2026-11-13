//! Counter files next to the config that each computer writes alone and every
//! computer reads: `<stem>-<computer>.json`. The data folder may be synced
//! (Syncthing): one shared file rewritten by two computers every few seconds
//! would conflict and lose counts; one file per computer never does, and the
//! readers add them up. A `<stem>.json` from before is read too, never written.

use std::path::{Path, PathBuf};

/// This computer's name as a file-name part (letters, digits, `-`, `_`).
fn machine() -> String {
    let name = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let clean: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if clean.is_empty() { "this-computer".to_owned() } else { clean.to_lowercase() }
}

/// The file this computer writes.
pub(crate) fn own(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!("{stem}-{}.json", machine()))
}

/// Whether a file name is one of `stem`'s counter files (any computer's, or the old shared one).
pub(crate) fn is_counter_file(name: &str, stem: &str) -> bool {
    name == format!("{stem}.json")
        || name
            .strip_prefix(&format!("{stem}-"))
            .and_then(|rest| rest.strip_suffix(".json"))
            .is_some_and(|machine| !machine.is_empty() && !machine.contains('.') && !machine.starts_with("corrupt"))
}

/// Every computer's file of `stem` in `dir` (and the old shared one).
pub(crate) fn all(dir: &Path, stem: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| is_counter_file(n, stem)))
        .collect();
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_files_are_one_per_computer_plus_the_old_shared_one() {
        assert!(is_counter_file("press-log.json", "press-log"));
        assert!(is_counter_file("press-log-main.json", "press-log"));
        assert!(!is_counter_file("press-log-main.json.tmp", "press-log"));
        assert!(!is_counter_file("press-log-corrupt-17.json", "press-log"));
        assert!(!is_counter_file("menu-usage-main.json", "press-log"));
        let dir = tempfile::tempdir().expect("temp dir");
        for name in ["press-log.json", "press-log-main.json", "press-log-notebook.json", "config.json"] {
            std::fs::write(dir.path().join(name), "{}").expect("write");
        }
        assert_eq!(all(dir.path(), "press-log").len(), 3);
        assert!(own(dir.path(), "press-log").file_name().unwrap().to_string_lossy().starts_with("press-log-"));
    }
}
