use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Diagnostic {
    pub source: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileErrors {
    pub diagnostics: Vec<Diagnostic>,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.source, self.path, self.message)
    }
}

impl ProfileErrors {
    pub fn one(
        source: impl Into<String>,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            diagnostics: vec![Diagnostic {
                source: source.into(),
                path: path.into(),
                message: message.into(),
            }],
        }
    }
}

impl fmt::Display for ProfileErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, error) in self.diagnostics.iter().enumerate() {
            if index > 0 {
                writeln!(f)?;
            }
            write!(f, "{}:{}: {}", error.source, error.path, error.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for ProfileErrors {}

pub fn yaml_path(pointer: &str) -> String {
    let mut path = String::from("$");
    for part in pointer.split('/').skip(1) {
        let part = part.replace("~1", "/").replace("~0", "~");
        if part.parse::<usize>().is_ok() {
            path.push_str(&format!("[{part}]"));
        } else if part.chars().all(|c| c.is_alphanumeric() || c == '_') {
            path.push('.');
            path.push_str(&part);
        } else {
            path.push_str(&format!("[{part:?}]"));
        }
    }
    path
}
