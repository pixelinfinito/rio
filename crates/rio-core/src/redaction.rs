use regex::Regex;
use serde::Deserialize;
use std::{collections::BTreeMap, sync::LazyLock};

#[derive(Deserialize)]
struct Pattern {
    id: String,
    regex: String,
}
#[derive(Deserialize)]
struct Entropy {
    threshold: f64,
    min_length: usize,
    names: String,
}
#[derive(Deserialize)]
struct Catalog {
    entropy: Entropy,
    patterns: Vec<Pattern>,
}
struct Scanner {
    catalog: Catalog,
    patterns: Vec<Regex>,
    names: Regex,
    assignment: Regex,
}

static SCANNER: LazyLock<Scanner> = LazyLock::new(|| {
    let catalog: Catalog = toml::from_str(include_str!(
        "../../../modules/adapters/common/secrets.toml"
    ))
    .expect("embedded secret catalog is valid");
    let patterns = catalog
        .patterns
        .iter()
        .map(|pattern| Regex::new(&pattern.regex).expect("embedded credential expression is valid"))
        .collect();
    let names = Regex::new(&catalog.entropy.names).expect("embedded entropy expression is valid");
    let assignment = Regex::new(
        r#"(?m)(?P<name>[A-Za-z_][A-Za-z0-9_-]*)["']?[^\S\r\n]*[:=][^\S\r\n]*(?:"(?P<double>(?:[^"\\\r\n]|\\[^\r\n])*)"|'(?P<single>(?:[^'\\\r\n]|\\[^\r\n])*)'|(?P<bare>[A-Za-z0-9/+_=.-]+))"#,
    )
    .unwrap();
    Scanner {
        catalog,
        patterns,
        names,
        assignment,
    }
});

pub struct SecretMatch<'a> {
    pub pattern: &'a str,
    pub start: usize,
    pub end: usize,
}

pub fn shannon_entropy(value: &str) -> f64 {
    let mut counts = BTreeMap::<u8, usize>::new();
    for byte in value.bytes() {
        *counts.entry(byte).or_default() += 1;
    }
    let length = value.len() as f64;
    counts
        .values()
        .map(|&count| {
            let probability = count as f64 / length;
            -probability * probability.log2()
        })
        .sum()
}

/// Exact dummy values only: substrings such as `password-actual-credential`
/// must not hide credentials. Provider-specific tokens bypass this allow-list.
fn placeholder_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "user"
            | "username"
            | "password"
            | "pass"
            | "pwd"
            | "secret"
            | "test"
            | "example"
            | "changeme"
            | "dummy"
            | "placeholder"
    ) || value.len() >= 3 && lower.bytes().all(|byte| byte == b'x')
        || value.len() >= 3 && value.bytes().all(|byte| byte == b'*')
        || [("<", ">"), ("${", "}"), ("{{", "}}")]
            .iter()
            .any(|(start, end)| {
                value
                    .strip_prefix(start)
                    .and_then(|inner| inner.strip_suffix(end))
                    .is_some_and(|inner| {
                        !inner.is_empty() && !inner.contains(['<', '>', '{', '}', '\r', '\n'])
                    })
            })
}

fn placeholder_connection(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    if !matches!(
        scheme.to_ascii_lowercase().as_str(),
        "postgres" | "postgresql" | "mysql" | "mongodb" | "mongodb+srv" | "redis"
    ) {
        return false;
    }
    let Some((credentials, address)) = rest.rsplit_once('@') else {
        return false;
    };
    let Some((username, password)) = credentials.split_once(':') else {
        return false;
    };
    let authority = address.split(['/', '?', '#']).next().unwrap_or_default();
    let (host, port) = if let Some(rest) = authority.strip_prefix("[::1]") {
        ("[::1]", rest)
    } else {
        authority
            .find(':')
            .map_or((authority, ""), |index| authority.split_at(index))
    };
    if !port.is_empty()
        && !port
            .strip_prefix(':')
            .is_some_and(|port| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    placeholder_value(username)
        && placeholder_value(password)
        && matches!(
            host.to_ascii_lowercase().as_str(),
            "localhost"
                | "127.0.0.1"
                | "[::1]"
                | "example.com"
                | "example.org"
                | "example.net"
                | "db"
                | "postgres"
                | "mysql"
                | "mongodb"
                | "redis"
        )
}

pub fn secret_matches(content: &str) -> Vec<SecretMatch<'_>> {
    secret_matches_for_path(content, "")
}

/// Only configuration files have unquoted string values. Source expressions
/// must never be interpreted as credentials by the assignment entropy rule.
pub fn secret_matches_for_path<'a>(content: &'a str, path: &str) -> Vec<SecretMatch<'a>> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let bare_values = name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name.rsplit('.').next(),
            Some("env" | "ini" | "cfg" | "conf" | "yaml" | "yml" | "properties")
        );
    let mut result = Vec::new();
    for (pattern, expression) in SCANNER.catalog.patterns.iter().zip(&SCANNER.patterns) {
        for found in expression.find_iter(content) {
            if pattern.id == "connection-string" && placeholder_connection(found.as_str()) {
                continue;
            }
            result.push(SecretMatch {
                pattern: &pattern.id,
                start: found.start(),
                end: found.end(),
            });
        }
    }
    for assignment in SCANNER.assignment.captures_iter(content) {
        if !SCANNER.names.is_match(&assignment["name"]) {
            continue;
        }
        let value = assignment
            .name("double")
            .or_else(|| assignment.name("single"))
            .or_else(|| assignment.name("bare"))
            .unwrap();
        let matched = assignment.get(0).unwrap();
        let suffix = &content[matched.end()..];
        let rest = suffix.lines().next().unwrap_or_default().trim_start();
        if assignment.name("bare").is_some() {
            let prefix = content[..matched.start()].rsplit('\n').next().unwrap();
            if !bare_values
                || !matches!(prefix.trim(), "" | "export" | "-")
                || !(rest.is_empty() || rest.starts_with(['#', ';']))
            {
                continue;
            }
        } else if !(rest.is_empty()
            || rest.starts_with([',', ')', ']', '}', ';', '#'])
            || rest.starts_with("//"))
        {
            // A quoted prefix of a concatenation, call or attribute expression
            // is not a complete literal value either.
            continue;
        }
        if !placeholder_value(value.as_str())
            && !placeholder_connection(value.as_str())
            && value.len() >= SCANNER.catalog.entropy.min_length
            && shannon_entropy(value.as_str()) >= SCANNER.catalog.entropy.threshold
            && !result
                .iter()
                .any(|found| found.start < value.end() && found.end > value.start())
        {
            result.push(SecretMatch {
                pattern: "high-entropy",
                start: value.start(),
                end: value.end(),
            });
        }
    }
    result.sort_by_key(|found| (found.start, found.end));
    result
}

pub fn redact_value(value: &str) -> String {
    format!("{}[REDACTED]", value.chars().take(4).collect::<String>())
}

/// Redact before rendering, persisting or truncating. Applying this to a full
/// captured stream also handles multiline keys and tokens across read chunks.
pub fn redact(content: &str) -> String {
    let found = secret_matches(content);
    let mut ranges = Vec::<(usize, usize)>::new();
    for found in found {
        if let Some(previous) = ranges.last_mut()
            && found.start < previous.1
        {
            previous.1 = previous.1.max(found.end);
        } else {
            ranges.push((found.start, found.end));
        }
    }
    let mut output = String::new();
    let mut cursor = 0;
    for (start, end) in ranges {
        output.push_str(&content[cursor..start]);
        output.push_str(&redact_value(&content[start..end]));
        cursor = end;
    }
    output.push_str(&content[cursor..]);
    output
}

/// Raw retention is capped per stream, preserving equal-sized head and tail
/// portions of already-redacted output. The marker counts toward the cap.
pub fn retained_raw(bytes: &[u8], limit: usize) -> Vec<u8> {
    // A stream stopped at its output limit may end inside a credential. Scrub
    // recognizable unfinished tokens and keys before the complete patterns.
    static PRIVATE_BEGIN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----").unwrap()
    });
    static PARTIAL_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\b(?:(?:AKIA|ASIA)[A-Z0-9]+|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|sk_live_[A-Za-z0-9]+)\z").unwrap()
    });
    let mut captured = String::from_utf8_lossy(bytes).into_owned();
    if let Some(begin) = PRIVATE_BEGIN.find_iter(&captured).last()
        && !captured[begin.end()..].contains("PRIVATE KEY-----")
    {
        let start = begin.start();
        captured.replace_range(start.., &redact_value(&captured[start..]));
    }
    if let Some(found) = PARTIAL_TOKEN.find(&captured) {
        let start = found.start();
        captured.replace_range(start.., &redact_value(&captured[start..]));
    }
    let text = redact(&captured);
    if text.len() <= limit {
        return text.into_bytes();
    }
    let marker = b"\n[... output truncated ...]\n";
    if limit <= marker.len() {
        return marker[..limit].to_vec();
    }
    let available = limit - marker.len();
    let mut start = available.div_ceil(2);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = text.len() - available / 2;
    while !text.is_char_boundary(end) {
        end += 1;
    }
    [&text.as_bytes()[..start], marker, &text.as_bytes()[end..]].concat()
}
