use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;
use std::io;

/// An error as the app sees it: the same `name`, `message` and extra fields (such as an
/// `ENOENT` code) a JavaScript error would carry, so callers keep their existing checks.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CoreError {
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Map<String, Value>>,
}

impl CoreError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            name: "Error".into(),
            message: message.into(),
            data: None,
        }
    }

    pub fn named(name: &str, message: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
            data: None,
        }
    }

    /// A file system error, with the Node-style `code` the TypeScript side used to see.
    pub fn io(error: &io::Error, path: &std::path::Path) -> Self {
        let code = match error.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::AlreadyExists => "EEXIST",
            io::ErrorKind::IsADirectory => "EISDIR",
            io::ErrorKind::NotADirectory => "ENOTDIR",
            _ => "EIO",
        };
        let mut data = Map::new();
        data.insert("code".into(), Value::String(code.into()));
        data.insert("path".into(), Value::String(path.display().to_string()));
        Self {
            name: "Error".into(),
            message: format!("{code}: {error}, {}", path.display()),
            data: Some(data),
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.name, self.message)
    }
}

impl std::error::Error for CoreError {}

pub type CoreResult<T> = Result<T, CoreError>;
