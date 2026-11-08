use anyhow::{Context, Result, bail, ensure};
use rio_engine::CacheOptions;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Serialize)]
pub struct MachineConfig {
    pub config_dir: PathBuf,
    pub endpoint_url: Option<String>,
    /// The registered GitHub App's identifiers (`[github_app]`), if any.
    pub github_app: Option<crate::github_app::AppRecord>,
    pub cache: CacheOptions,
    pub parallelism: usize,
    pub output_limit: usize,
    pub sources: BTreeMap<String, String>,
    pub notices: Vec<String>,
}
pub fn config_directory() -> Result<PathBuf> {
    if let Some(path) = env::var_os("RIO_CONFIG_DIR") {
        return Ok(path.into());
    }
    if let Some(path) = env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(path).join("rio"));
    }
    #[cfg(windows)]
    if let Some(path) = env::var_os("APPDATA") {
        return Ok(PathBuf::from(path).join("rio"));
    }
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|path| PathBuf::from(path).join(".config/rio"))
        .context("cannot determine configuration directory; set RIO_CONFIG_DIR")
}
fn size(value: &str) -> Result<u64> {
    for (suffix, factor) in [
        ("GiB", 1024u64.pow(3)),
        ("MiB", 1024u64.pow(2)),
        ("KiB", 1024),
        ("GB", 1000u64.pow(3)),
        ("MB", 1000u64.pow(2)),
        ("KB", 1000),
        ("B", 1),
        ("", 1),
    ] {
        if let Some(number) = value.strip_suffix(suffix)
            && let Ok(number) = number.trim().parse::<u64>()
        {
            return number.checked_mul(factor).context("size is too large");
        }
    }
    bail!("expected a byte count or a size such as 256MiB")
}
fn age(value: &str) -> Result<Duration> {
    if let Some(days) = value.strip_suffix('d') {
        return Ok(Duration::from_secs(
            days.parse::<u64>()?
                .checked_mul(86400)
                .context("age is too large")?,
        ));
    }
    rio_profile::parse_duration(value).map_err(anyhow::Error::msg)
}
impl MachineConfig {
    pub fn load(root: &Path) -> Result<Self> {
        let config_dir = config_directory()?;
        let file = config_dir.join("config.toml");
        let mut values = BTreeMap::<String, (toml::Value, String)>::new();
        let mut github_app = None;
        let known = [
            "endpoint.url",
            "cache.dir",
            "cache.max_age",
            "cache.max_size",
            "cache.retain_raw_output",
            "run.parallelism",
            "run.output_limit",
        ];
        fn flatten(
            prefix: &str,
            value: toml::Value,
            values: &mut BTreeMap<String, (toml::Value, String)>,
            source: &str,
            known: &[&str],
        ) -> Result<()> {
            if let toml::Value::Table(table) = value {
                ensure!(
                    prefix.is_empty() || matches!(prefix, "endpoint" | "cache" | "run"),
                    "unknown configuration key {prefix} in {source}"
                );
                for (key, value) in table {
                    let key = if prefix.is_empty() {
                        key
                    } else {
                        format!("{prefix}.{key}")
                    };
                    flatten(&key, value, values, source, known)?;
                }
            } else {
                ensure!(
                    known.contains(&prefix),
                    "unknown configuration key {prefix} in {source}"
                );
                values.insert(prefix.into(), (value, source.into()));
            }
            Ok(())
        }
        match fs::read_to_string(&file) {
            Ok(contents) => {
                let mut document: toml::Value =
                    toml::from_str(&contents).with_context(|| file.display().to_string())?;
                if let Some(table) = document.as_table_mut()
                    && let Some(deployment) = table.remove("deployment")
                {
                    let deployment: crate::deployment::Deployment = deployment.try_into()?;
                    deployment.validate()?;
                }
                if let Some(table) = document.as_table_mut()
                    && let Some(app) = table.remove("github_app")
                {
                    github_app = Some(
                        app.try_into()
                            .with_context(|| format!("github_app in {}", file.display()))?,
                    );
                }
                flatten(
                    "",
                    document,
                    &mut values,
                    &file.display().to_string(),
                    &known,
                )?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("reading {}", file.display())),
        }
        // Validate file values even when an environment override is present.
        for (key, (value, source)) in &values {
            validate(key, value).with_context(|| format!("{key} in {source}"))?;
        }
        for (key, variable) in [
            ("endpoint.url", "RIO_ENDPOINT_URL"),
            ("cache.dir", "RIO_CACHE_DIR"),
            ("cache.max_age", "RIO_CACHE_MAX_AGE"),
            ("cache.max_size", "RIO_CACHE_MAX_SIZE"),
            ("cache.retain_raw_output", "RIO_CACHE_RETAIN_RAW_OUTPUT"),
            ("run.parallelism", "RIO_PARALLELISM"),
            ("run.output_limit", "RIO_OUTPUT_LIMIT"),
        ] {
            if let Some(value) = env::var_os(variable) {
                let value = value
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("{key} in {variable} is not UTF-8"))?;
                let parsed = match key {
                    "cache.retain_raw_output" => {
                        toml::Value::Boolean(value.parse().with_context(|| {
                            format!("{key} in {variable}: expected true or false")
                        })?)
                    }
                    "run.parallelism" => {
                        toml::Value::Integer(value.parse().with_context(|| {
                            format!("{key} in {variable}: expected a positive integer")
                        })?)
                    }
                    _ => toml::Value::String(value),
                };
                validate(key, &parsed).with_context(|| format!("{key} in {variable}"))?;
                values.insert(key.into(), (parsed, variable.into()));
            }
        }
        let mut config = Self {
            config_dir,
            endpoint_url: None,
            github_app,
            cache: CacheOptions::for_repository(root),
            parallelism: sysinfo::System::physical_core_count()
                .unwrap_or(1)
                .clamp(1, 4),
            output_limit: 256 * 1024 * 1024,
            sources: known
                .iter()
                .map(|key| (key.to_string(), "default".into()))
                .collect(),
            notices: Vec::new(),
        };
        for (key, (value, source)) in values {
            config.sources.insert(key.clone(), source);
            match key.as_str() {
                "endpoint.url" => config.endpoint_url = Some(value.as_str().unwrap().into()),
                "cache.dir" => config.cache.dir = PathBuf::from(value.as_str().unwrap()),
                "cache.max_age" => config.cache.max_age = age(value.as_str().unwrap())?,
                "cache.max_size" => config.cache.max_size = value_size(&value)?,
                "cache.retain_raw_output" => {
                    config.cache.retain_raw_output = value.as_bool().unwrap()
                }
                "run.parallelism" => config.parallelism = value.as_integer().unwrap() as usize,
                "run.output_limit" => {
                    config.output_limit = usize::try_from(value_size(&value)?)
                        .context("run.output_limit exceeds platform limit")?
                }
                _ => unreachable!(),
            }
        }
        Ok(config)
    }
}
fn value_size(value: &toml::Value) -> Result<u64> {
    if let Some(number) = value.as_integer() {
        Ok(u64::try_from(number)?)
    } else {
        size(
            value
                .as_str()
                .context("expected a byte count or size string")?,
        )
    }
}
fn validate(key: &str, value: &toml::Value) -> Result<()> {
    match key {
        "endpoint.url" | "cache.dir" => ensure!(
            value.as_str().is_some_and(|s| !s.is_empty()),
            "expected a nonempty string"
        ),
        "cache.max_age" => ensure!(
            !age(value.as_str().context("expected a duration string")?)?.is_zero(),
            "must be positive"
        ),
        "cache.max_size" | "run.output_limit" => {
            ensure!(value_size(value)? > 0, "must be positive")
        }
        "cache.retain_raw_output" => ensure!(value.is_bool(), "expected a boolean"),
        "run.parallelism" => ensure!(
            value
                .as_integer()
                .is_some_and(|v| v > 0 && usize::try_from(v).is_ok()),
            "expected a positive integer"
        ),
        _ => bail!("unknown key"),
    }
    Ok(())
}
