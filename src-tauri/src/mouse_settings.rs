//! Independent live readings and privacy-safe read-only diagnostic formatting.
use serde::{Deserialize, Serialize};

use crate::ui_text::UiText;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadingStatus {
    Complete,
    Partial,
    Unavailable,
    Disconnected,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadingField {
    Device,
    BatteryPercent,
    Dpi,
    PollRateHz,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingWarning {
    pub field: ReadingField,
    pub message: UiText,
    pub details: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseSettings {
    pub battery_percent: Option<u8>,
    pub dpi: Option<u16>,
    pub poll_rate_hz: Option<u16>,
    pub status: ReadingStatus,
    pub warnings: Vec<ReadingWarning>,
}

/// Open errors can contain a HID path with the device serial. Never export it.
pub fn public_read_error(error: &str) -> String {
    error
        .split(": CreateFileW(")
        .next()
        .unwrap_or(error)
        .to_owned()
}

fn reading<T>(
    result: Result<T, String>,
    field: ReadingField,
    warnings: &mut Vec<ReadingWarning>,
) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(error) => {
            let message = match field {
                ReadingField::BatteryPercent => crate::ui_text!(
                    "mouseRead.batteryFailed",
                    "Battery charge could not be read."
                ),
                ReadingField::Dpi => {
                    crate::ui_text!("mouseRead.dpiFailed", "Current DPI could not be read.")
                }
                ReadingField::PollRateHz => {
                    crate::ui_text!("mouseRead.pollFailed", "Polling rate could not be read.")
                }
                ReadingField::Device => {
                    crate::ui_text!("mouseRead.accessFailed", "Could not access the mouse.")
                }
            };
            warnings.push(ReadingWarning {
                field,
                message,
                details: public_read_error(&error),
            });
            None
        }
    }
}

impl MouseSettings {
    /// All requests are evaluated by the caller; no failed field short-circuits another.
    pub fn from_reads(
        battery: Result<u8, String>,
        dpi: Result<u16, String>,
        poll: Result<u16, String>,
    ) -> Self {
        let mut warnings = Vec::new();
        let battery_percent = reading(battery, ReadingField::BatteryPercent, &mut warnings);
        let dpi = reading(dpi, ReadingField::Dpi, &mut warnings);
        let poll_rate_hz = reading(poll, ReadingField::PollRateHz, &mut warnings);
        let count = usize::from(battery_percent.is_some())
            + usize::from(dpi.is_some())
            + usize::from(poll_rate_hz.is_some());
        let status = match count {
            3 => ReadingStatus::Complete,
            0 => ReadingStatus::Unavailable,
            _ => ReadingStatus::Partial,
        };
        Self {
            battery_percent,
            dpi,
            poll_rate_hz,
            status,
            warnings,
        }
    }

    pub fn inaccessible(error: &str, disconnected: bool) -> Self {
        let message = if disconnected {
            crate::ui_text!("mouseRead.disconnected", "No supported mouse is connected.")
        } else {
            crate::ui_text!("mouseRead.accessFailed", "Could not access the mouse.")
        };
        Self {
            battery_percent: None,
            dpi: None,
            poll_rate_hz: None,
            status: if disconnected {
                ReadingStatus::Disconnected
            } else {
                ReadingStatus::Unavailable
            },
            warnings: vec![ReadingWarning {
                field: ReadingField::Device,
                message,
                details: public_read_error(error),
            }],
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportDetail {
    Summary,
    #[default]
    Full,
}

/// The summary path must never invoke the expensive button scan.
pub fn format_report(
    mut header: Vec<String>,
    detail: ReportDetail,
    buttons: impl FnOnce() -> Vec<String>,
) -> String {
    if matches!(detail, ReportDetail::Full) {
        header.extend(buttons());
    }
    header.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_read_failure_combination_preserves_the_other_fields() {
        for mask in 0..8 {
            let result = |bit, value| {
                if mask & bit != 0 {
                    Ok(value)
                } else {
                    Err("query refused".into())
                }
            };
            let settings = MouseSettings::from_reads(
                result(1, 62).map(|v| v as u8),
                result(2, 1100),
                result(4, 500),
            );
            assert_eq!(settings.battery_percent.is_some(), mask & 1 != 0);
            assert_eq!(settings.dpi.is_some(), mask & 2 != 0);
            assert_eq!(settings.poll_rate_hz.is_some(), mask & 4 != 0);
            assert_eq!(
                settings.warnings.len(),
                3 - (mask as u32).count_ones() as usize
            );
            assert_eq!(
                settings.status,
                match mask {
                    0 => ReadingStatus::Unavailable,
                    7 => ReadingStatus::Complete,
                    _ => ReadingStatus::Partial,
                }
            );
            let json = serde_json::to_value(&settings).unwrap();
            assert_eq!(json["dpi"].is_null(), mask & 2 == 0);
        }
    }

    #[test]
    fn sleep_or_access_failure_is_not_a_disconnection() {
        assert_eq!(
            MouseSettings::inaccessible("Access denied", false).status,
            ReadingStatus::Unavailable
        );
        assert_eq!(
            MouseSettings::inaccessible("no mouse", true).status,
            ReadingStatus::Disconnected
        );
        assert_eq!(
            MouseSettings::from_reads(
                Err("asleep".into()),
                Err("asleep".into()),
                Err("asleep".into())
            )
            .status,
            ReadingStatus::Unavailable
        );
    }

    #[test]
    fn summary_does_not_scan_and_full_keeps_button_records() {
        assert_eq!(
            format_report(vec!["header".into()], ReportDetail::Summary, || panic!(
                "must not scan"
            )),
            "header"
        );
        assert_eq!(
            format_report(vec!["header".into()], ReportDetail::default(), || vec![
                "records".into()
            ]),
            "header\nrecords"
        );
        assert!(serde_json::from_str::<ReportDetail>("\"invalid\"").is_err());
    }

    #[test]
    fn diagnostic_errors_omit_device_paths_and_serial_numbers() {
        let text = "Access denied: CreateFileW(\\\\?\\hid#vid_1532#private-serial)";
        let settings = MouseSettings::inaccessible(text, false);
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("private-serial"));
        assert!(!json.contains("CreateFileW"));
        assert!(json.contains("Access denied"));
    }
}
