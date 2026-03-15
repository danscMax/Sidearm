use serde::Serialize;
use std::{
    collections::VecDeque,
    time::{SystemTime, UNIX_EPOCH},
};

pub const EVENT_RUNTIME_STARTED: &str = "runtime_started";
pub const EVENT_RUNTIME_STOPPED: &str = "runtime_stopped";
pub const EVENT_CONFIG_RELOADED: &str = "config_reloaded";
pub const EVENT_ENCODED_KEY_RECEIVED: &str = "encoded_key_received";
pub const EVENT_PROFILE_RESOLVED: &str = "profile_resolved";
pub const EVENT_CONTROL_RESOLVED: &str = "control_resolved";
pub const EVENT_ACTION_EXECUTED: &str = "action_executed";
pub const EVENT_RUNTIME_ERROR: &str = "runtime_error";

const DEBUG_LOG_LIMIT: usize = 1000;
const CAPTURE_BACKEND: &str = crate::capture_backend::CAPTURE_BACKEND_NAME;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Idle,
    Running,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStateSummary {
    pub status: RuntimeStatus,
    pub started_at: Option<u64>,
    pub last_reload_at: Option<u64>,
    pub capture_backend: String,
    pub active_config_version: Option<i32>,
    pub warning_count: usize,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum DebugLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugLogEntry {
    pub id: u64,
    pub level: DebugLogLevel,
    pub category: String,
    pub message: String,
    pub created_at: u64,
}

#[derive(Debug)]
pub struct RuntimeStore {
    status: RuntimeStatus,
    started_at: Option<u64>,
    last_reload_at: Option<u64>,
    active_config_version: Option<i32>,
    warning_count: usize,
    last_notified_profile_id: Option<String>,
    logs: VecDeque<DebugLogEntry>,
    next_log_id: u64,
}

impl Default for RuntimeStore {
    fn default() -> Self {
        Self {
            status: RuntimeStatus::Idle,
            started_at: None,
            last_reload_at: None,
            active_config_version: None,
            warning_count: 0,
            last_notified_profile_id: None,
            logs: VecDeque::new(),
            next_log_id: 1,
        }
    }
}

impl RuntimeStore {
    pub fn summary(&self) -> RuntimeStateSummary {
        RuntimeStateSummary {
            status: self.status,
            started_at: self.started_at,
            last_reload_at: self.last_reload_at,
            capture_backend: CAPTURE_BACKEND.into(),
            active_config_version: self.active_config_version,
            warning_count: self.warning_count,
        }
    }

    pub fn is_running(&self) -> bool {
        self.status == RuntimeStatus::Running
    }

    pub fn start(&mut self, config_version: i32, warning_count: usize) -> RuntimeStateSummary {
        let now = timestamp_millis();
        if self.started_at.is_none() || self.status == RuntimeStatus::Idle {
            self.started_at = Some(now);
        }
        self.status = RuntimeStatus::Running;
        self.last_reload_at = Some(now);
        self.active_config_version = Some(config_version);
        self.warning_count = warning_count;

        log::info!("[рантайм] Перехват запущен, версия конфигурации {config_version}.");
        self.push_log(
            DebugLogLevel::Info,
            "рантайм",
            format!("Перехват запущен, версия конфигурации {config_version}."),
        );
        if warning_count > 0 {
            log::warn!("[рантайм] При запуске обнаружено предупреждений: {warning_count}.");
            self.push_log(
                DebugLogLevel::Warn,
                "рантайм",
                format!("При запуске обнаружено предупреждений: {warning_count}."),
            );
        }

        self.summary()
    }

    pub fn stop(&mut self) -> RuntimeStateSummary {
        self.status = RuntimeStatus::Idle;
        self.last_notified_profile_id = None;
        log::info!("[рантайм] Перехват остановлен.");
        self.push_log(DebugLogLevel::Info, "рантайм", "Перехват остановлен.");
        self.summary()
    }

    /// Returns true if the profile changed (caller should send notification).
    pub fn notify_profile_change(&mut self, profile_id: Option<&str>) -> bool {
        let changed = profile_id.is_some()
            && self.last_notified_profile_id.as_deref() != profile_id;
        if changed {
            self.last_notified_profile_id = profile_id.map(|s| s.to_owned());
        }
        changed
    }

    pub fn reload(&mut self, config_version: i32, warning_count: usize) -> RuntimeStateSummary {
        let now = timestamp_millis();
        if self.started_at.is_none() {
            self.started_at = Some(now);
        }
        self.status = RuntimeStatus::Running;
        self.last_reload_at = Some(now);
        self.active_config_version = Some(config_version);
        self.warning_count = warning_count;

        log::info!("[рантайм] Конфигурация перезагружена, версия {config_version}.");
        self.push_log(
            DebugLogLevel::Info,
            "рантайм",
            format!("Конфигурация перезагружена, версия {config_version}."),
        );
        if warning_count > 0 {
            log::warn!("[рантайм] После перезагрузки обнаружено предупреждений: {warning_count}.");
            self.push_log(
                DebugLogLevel::Warn,
                "рантайм",
                format!("После перезагрузки обнаружено предупреждений: {warning_count}."),
            );
        }

        self.summary()
    }

    pub fn logs(&self) -> Vec<DebugLogEntry> {
        self.logs.iter().cloned().collect()
    }

    pub fn record_info(&mut self, category: impl Into<String>, message: impl Into<String>) {
        self.push_log(DebugLogLevel::Info, category, message);
    }

    pub fn record_warn(&mut self, category: impl Into<String>, message: impl Into<String>) {
        self.push_log(DebugLogLevel::Warn, category, message);
    }

    #[allow(dead_code)]
    pub fn record_error(&mut self, category: impl Into<String>, message: impl Into<String>) {
        self.push_log(DebugLogLevel::Error, category, message);
    }

    #[allow(dead_code)]
    pub fn record_debug(&mut self, category: impl Into<String>, message: impl Into<String>) {
        self.push_log(DebugLogLevel::Debug, category, message);
    }

    fn push_log(
        &mut self,
        level: DebugLogLevel,
        category: impl Into<String>,
        message: impl Into<String>,
    ) {
        let category = category.into();
        let message = message.into();

        // NOTE: We intentionally do NOT call log::info!() etc. here.
        // This method runs on the Windows LL keyboard hook thread (small stack),
        // and fern + 3 targets would overflow it. The capture_backend already
        // emits log::*() calls directly — this ring buffer is only for the UI.

        if self.logs.len() >= DEBUG_LOG_LIMIT {
            self.logs.pop_front();
        }

        self.logs.push_back(DebugLogEntry {
            id: self.next_log_id,
            level,
            category,
            message,
            created_at: timestamp_millis(),
        });
        self.next_log_id += 1;
    }
}

pub(crate) fn timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_store_transitions_between_states() {
        let mut store = RuntimeStore::default();

        let started = store.start(2, 1);
        assert_eq!(started.status, RuntimeStatus::Running);
        assert_eq!(started.active_config_version, Some(2));
        assert_eq!(started.warning_count, 1);
        assert!(started.started_at.is_some());
        assert!(started.last_reload_at.is_some());

        let reloaded = store.reload(2, 0);
        assert_eq!(reloaded.status, RuntimeStatus::Running);
        assert_eq!(reloaded.warning_count, 0);

        let stopped = store.stop();
        assert_eq!(stopped.status, RuntimeStatus::Idle);
        assert_eq!(stopped.active_config_version, Some(2));
    }

    #[test]
    fn notify_profile_change_detects_transitions() {
        let mut store = RuntimeStore::default();
        // First profile — should notify
        assert!(store.notify_profile_change(Some("p1")));
        // Same profile — should not notify
        assert!(!store.notify_profile_change(Some("p1")));
        // Different profile — should notify
        assert!(store.notify_profile_change(Some("p2")));
        // None — should not notify
        assert!(!store.notify_profile_change(None));
        // After stop, should notify again for any profile
        store.stop();
        assert!(store.notify_profile_change(Some("p1")));
    }

    #[test]
    fn runtime_store_caps_log_history() {
        let mut store = RuntimeStore::default();

        for index in 0..1100 {
            store.push_log(DebugLogLevel::Info, "test", format!("message-{index}"));
        }

        let logs = store.logs();
        assert_eq!(logs.len(), DEBUG_LOG_LIMIT);
        assert_eq!(logs.first().map(|entry| entry.id), Some(101));
        assert_eq!(logs.last().map(|entry| entry.id), Some(1100));
    }

    #[test]
    fn runtime_store_supports_error_level() {
        let mut store = RuntimeStore::default();
        store.record_error("capture", "Hook registration failed");
        let logs = store.logs();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].level, DebugLogLevel::Error);
        assert_eq!(logs[0].category, "capture");
    }

    #[test]
    fn runtime_store_supports_debug_level() {
        let mut store = RuntimeStore::default();
        store.record_debug("capture", "Key event received");
        let logs = store.logs();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].level, DebugLogLevel::Debug);
    }
}
