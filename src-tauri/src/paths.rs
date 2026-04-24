//! Path resolution for portable vs roaming modes.
//!
//! When a `sidearm.portable` marker file exists next to the executable, the
//! app stores its configuration, logs, and snapshots in `./data/` alongside
//! the exe. Otherwise it uses the standard OS config/log directories that
//! match Tauri's `app_config_dir()` and `app_log_dir()` defaults.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const PORTABLE_MARKER: &str = "sidearm.portable";
const DATA_DIR_NAME: &str = "data";
const LOG_DIR_NAME: &str = "logs";
const SNAPSHOTS_DIR_NAME: &str = "snapshots";
const WRITE_PROBE_NAME: &str = ".write-probe";
pub const MIGRATION_DECLINED_MARKER: &str = ".migration-declined";
const APP_IDENTIFIER: &str = "com.sidearm.desktop";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathMode {
    Portable,
    Roaming,
    PortableFallback,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub mode: PathMode,
    pub config_dir: PathBuf,
    pub log_dir: PathBuf,
    pub snapshots_dir: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe_dir: Option<PathBuf>,
    pub portable_marker_present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

impl AppPaths {
    /// Resolve paths at startup. Never panics — always returns usable paths.
    pub fn resolve() -> Self {
        let exe_dir = current_exe_dir();
        let marker_present = exe_dir
            .as_ref()
            .map(|dir| dir.join(PORTABLE_MARKER).is_file())
            .unwrap_or(false);

        if marker_present {
            if let Some(exe) = exe_dir.as_ref() {
                let data_dir = exe.join(DATA_DIR_NAME);
                match ensure_writable(&data_dir) {
                    Ok(()) => {
                        return Self {
                            mode: PathMode::Portable,
                            config_dir: data_dir.clone(),
                            log_dir: data_dir.join(LOG_DIR_NAME),
                            snapshots_dir: data_dir.join(SNAPSHOTS_DIR_NAME),
                            exe_dir: Some(exe.clone()),
                            portable_marker_present: true,
                            fallback_reason: None,
                        };
                    }
                    Err(err) => {
                        let (config_dir, log_dir, snapshots_dir) = roaming_paths();
                        return Self {
                            mode: PathMode::PortableFallback,
                            config_dir,
                            log_dir,
                            snapshots_dir,
                            exe_dir: Some(exe.clone()),
                            portable_marker_present: true,
                            fallback_reason: Some(format!(
                                "Portable data directory is not writable: {err}"
                            )),
                        };
                    }
                }
            }
        }

        let (config_dir, log_dir, snapshots_dir) = roaming_paths();
        Self {
            mode: PathMode::Roaming,
            config_dir,
            log_dir,
            snapshots_dir,
            exe_dir,
            portable_marker_present: false,
            fallback_reason: None,
        }
    }

    /// Returns the roaming config file path regardless of current mode.
    /// Useful for the portable migration prompt.
    pub fn roaming_config_file() -> PathBuf {
        let (cfg, _, _) = roaming_paths();
        cfg.join("config.json")
    }

    /// True if a migration prompt should be shown on first portable launch.
    /// Conditions: Portable mode, no portable config yet, roaming config exists,
    /// user hasn't previously declined.
    pub fn needs_portable_migration_prompt(&self) -> bool {
        if self.mode != PathMode::Portable {
            return false;
        }
        let portable_config = self.config_dir.join("config.json");
        if portable_config.exists() {
            return false;
        }
        if self.config_dir.join(MIGRATION_DECLINED_MARKER).exists() {
            return false;
        }
        Self::roaming_config_file().exists()
    }

    /// Write a marker so the migration prompt is not shown again.
    pub fn mark_migration_declined(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.config_dir)?;
        fs::write(
            self.config_dir.join(MIGRATION_DECLINED_MARKER),
            b"user declined portable migration\n",
        )
    }
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
}

fn ensure_writable(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let probe = dir.join(WRITE_PROBE_NAME);
    {
        let mut f = fs::File::create(&probe)?;
        f.write_all(b"probe")?;
        f.sync_all()?;
    }
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// Platform-specific roaming dirs mirroring Tauri v2's defaults for
/// `app_config_dir` and `app_log_dir`.
fn roaming_paths() -> (PathBuf, PathBuf, PathBuf) {
    let config_dir = roaming_config_dir();
    let log_dir = roaming_log_dir();
    let snapshots_dir = config_dir.join(SNAPSHOTS_DIR_NAME);
    (config_dir, log_dir, snapshots_dir)
}

fn roaming_config_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join(APP_IDENTIFIER);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            return PathBuf::from(xdg).join(APP_IDENTIFIER);
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".config").join(APP_IDENTIFIER);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_IDENTIFIER);
        }
    }
    PathBuf::from(".").join(DATA_DIR_NAME)
}

fn roaming_log_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local)
                .join(APP_IDENTIFIER)
                .join(LOG_DIR_NAME);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(xdg).join(APP_IDENTIFIER).join(LOG_DIR_NAME);
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(APP_IDENTIFIER)
                .join(LOG_DIR_NAME);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Logs")
                .join(APP_IDENTIFIER);
        }
    }
    roaming_config_dir().join(LOG_DIR_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_returns_non_empty_paths() {
        let paths = AppPaths::resolve();
        assert!(!paths.config_dir.as_os_str().is_empty());
        assert!(!paths.log_dir.as_os_str().is_empty());
        assert!(!paths.snapshots_dir.as_os_str().is_empty());
    }

    #[test]
    fn ensure_writable_creates_nested_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dir = temp.path().join("nested").join("data");
        assert!(!dir.exists());
        ensure_writable(&dir).expect("ensure_writable");
        assert!(dir.is_dir());
        assert!(!dir.join(WRITE_PROBE_NAME).exists(), "probe should be removed");
    }

    #[test]
    fn ensure_writable_handles_cyrillic_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dir = temp.path().join("Скрипты").join("data");
        ensure_writable(&dir).expect("cyrillic path");
        assert!(dir.is_dir());
    }

    #[test]
    fn marker_file_is_detected_as_file_only() {
        let temp = tempfile::tempdir().expect("tempdir");
        // Directory with marker NAME should NOT count as marker.
        let marker_as_dir = temp.path().join(PORTABLE_MARKER);
        fs::create_dir(&marker_as_dir).expect("mkdir");
        assert!(!marker_as_dir.is_file());
    }

    #[test]
    fn migration_prompt_skipped_when_portable_config_exists() {
        let temp = tempfile::tempdir().expect("tempdir");
        let config_dir = temp.path().join("data");
        fs::create_dir_all(&config_dir).expect("mkdir");
        fs::write(config_dir.join("config.json"), b"{}").expect("write");

        let paths = AppPaths {
            mode: PathMode::Portable,
            config_dir: config_dir.clone(),
            log_dir: config_dir.join(LOG_DIR_NAME),
            snapshots_dir: config_dir.join(SNAPSHOTS_DIR_NAME),
            exe_dir: Some(temp.path().to_path_buf()),
            portable_marker_present: true,
            fallback_reason: None,
        };

        assert!(!paths.needs_portable_migration_prompt());
    }

    #[test]
    fn migration_prompt_skipped_when_declined() {
        let temp = tempfile::tempdir().expect("tempdir");
        let config_dir = temp.path().join("data");
        fs::create_dir_all(&config_dir).expect("mkdir");

        let paths = AppPaths {
            mode: PathMode::Portable,
            config_dir: config_dir.clone(),
            log_dir: config_dir.join(LOG_DIR_NAME),
            snapshots_dir: config_dir.join(SNAPSHOTS_DIR_NAME),
            exe_dir: Some(temp.path().to_path_buf()),
            portable_marker_present: true,
            fallback_reason: None,
        };
        paths.mark_migration_declined().expect("mark");

        assert!(!paths.needs_portable_migration_prompt());
    }

    #[test]
    fn migration_prompt_skipped_in_roaming_mode() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = AppPaths {
            mode: PathMode::Roaming,
            config_dir: temp.path().to_path_buf(),
            log_dir: temp.path().join(LOG_DIR_NAME),
            snapshots_dir: temp.path().join(SNAPSHOTS_DIR_NAME),
            exe_dir: None,
            portable_marker_present: false,
            fallback_reason: None,
        };
        assert!(!paths.needs_portable_migration_prompt());
    }
}
