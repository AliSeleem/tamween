use std::fmt;

/// `App` messages are shown to the user as-is (Arabic); `Internal` ones are unexpected failures.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    App(String),
    Internal(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::App(m) => f.write_str(m),
            Error::Internal(m) => write!(f, "حدث خطأ غير متوقع: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Internal(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Internal(e.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Internal(e.to_string())
    }
}

/// Returns early with a user-facing error.
#[macro_export]
macro_rules! bail {
    ($($t:tt)*) => {
        return Err($crate::error::Error::App(format!($($t)*)))
    };
}
