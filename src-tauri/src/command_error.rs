use serde::Serialize;

use crate::config::ConfigStoreError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Vec<String>>,
}

impl CommandError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Vec<String>>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal_error".into(),
            message: message.into(),
            details: None,
        }
    }
}

impl From<ConfigStoreError> for CommandError {
    fn from(value: ConfigStoreError) -> Self {
        match value {
            ConfigStoreError::ConfigDirectoryUnavailable(message) => Self {
                code: "config_directory_unavailable".into(),
                message,
                details: None,
            },
            ConfigStoreError::Io { path, message } => Self {
                code: "io_error".into(),
                message,
                details: path.map(|path| vec![path]),
            },
            ConfigStoreError::Parse { path, message } => Self {
                code: "parse_error".into(),
                message,
                details: Some(vec![path]),
            },
            ConfigStoreError::SchemaEngine(message) => Self {
                code: "schema_engine_error".into(),
                message,
                details: None,
            },
            ConfigStoreError::SchemaViolation { errors } => Self {
                code: "schema_violation".into(),
                message: "Config schema validation failed.".into(),
                details: Some(errors),
            },
            ConfigStoreError::Serialize(message) => Self {
                code: "serialize_error".into(),
                message,
                details: None,
            },
            ConfigStoreError::InvalidConfig { errors } => Self {
                code: "invalid_config".into(),
                message: "Config validation failed.".into(),
                details: Some(errors),
            },
        }
    }
}
