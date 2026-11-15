//! Version-matched, embedded documentation. This module intentionally performs
//! no configuration, repository, credential, process, or network operations.
use clap::{Args, ValueEnum};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, Write};

const CORPUS: &str = include_str!("../assets/docs.json");
const USAGE: &str =
    "rio docs <topic> [--section <id>] | rio docs search <query> [--limit 1..10] | --format json";

#[derive(Clone, Copy, Default, PartialEq, Eq, ValueEnum)]
pub enum Format {
    #[default]
    Text,
    Json,
}
#[derive(Args)]
pub struct DocsArgs {
    /// Topic ID, 'list' for the index, or 'search' followed by a query.
    pub topic: Option<String>,
    /// Search text (quote multiple words); only valid after 'search'.
    pub query: Option<String>,
    /// Retrieve one section, retaining prerequisites and effects.
    #[arg(long)]
    pub section: Option<String>,
    /// Maximum search hits, 1–10 (default 5); only valid for search.
    #[arg(long)]
    pub limit: Option<usize>,
    /// Plain text by default; JSON is versioned and machine-readable.
    #[arg(long, value_enum, default_value = "text")]
    pub format: Format,
}
#[derive(Deserialize)]
struct Corpus {
    revision: String,
    topics: Vec<Topic>,
}
#[derive(Deserialize)]
struct Topic {
    index_parent: Option<String>,
    id: String,
    title: String,
    summary: String,
    prerequisites: String,
    keywords: Vec<String>,
    related: Vec<String>,
    sections: Vec<Section>,
}
#[derive(Deserialize)]
struct Section {
    id: String,
    title: String,
    body: String,
}
struct Failure {
    code: &'static str,
    message: &'static str,
    suggestions: Vec<String>,
}
fn failure(code: &'static str, message: &'static str) -> Failure {
    Failure {
        code,
        message,
        suggestions: vec![],
    }
}
fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn envelope(corpus: &Corpus, kind: &str, data: Value) -> Value {
    json!({"schema_version": 1, "rio_version": env!("RIO_VERSION"),
        "rio_commit": env!("RIO_COMMIT"), "docs_revision": corpus.revision,
        "kind": kind, "data": data})
}
fn document(corpus: &Corpus, args: &DocsArgs) -> Result<Value, Failure> {
    let name = args.topic.as_deref().unwrap_or("list");
    if name != "search" && (args.query.is_some() || args.limit.is_some()) {
        return Err(failure(
            "invalid_arguments",
            "Query and --limit require 'rio docs search'.",
        ));
    }
    if matches!(name, "list" | "search") && args.section.is_some() {
        return Err(failure(
            "invalid_arguments",
            "--section requires a topic ID.",
        ));
    }
    if name == "list" {
        return Ok(envelope(
            corpus,
            "index",
            json!({"usage": USAGE, "topics": corpus.topics.iter().filter(|t| t.index_parent.is_none())
            .map(|t| json!({"id":t.id, "summary":t.summary})).collect::<Vec<_>>()}),
        ));
    }
    if name == "search" {
        let query = args.query.as_deref().unwrap_or("");
        let limit = args.limit.unwrap_or(5);
        if query.trim().is_empty() || query.len() > 256 {
            return Err(failure(
                "invalid_query",
                "Search requires a nonempty query of at most 256 UTF-8 bytes.",
            ));
        }
        if !(1..=10).contains(&limit) {
            return Err(failure(
                "invalid_limit",
                "Search --limit must be between 1 and 10.",
            ));
        }
        let words: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
        let matches = |value: &str| {
            let value = value.to_lowercase();
            words.iter().all(|word| value.contains(word))
        };
        let mut hits = Vec::new();
        for topic in &corpus.topics {
            let title_match = matches(&format!("{} {}", topic.id, topic.title));
            let keyword_match = matches(&topic.keywords.join(" "));
            if title_match
                || keyword_match
                || matches(&format!("{} {}", topic.summary, topic.prerequisites))
            {
                let (score, why) = if title_match {
                    (0, "topic title")
                } else if keyword_match {
                    (1, "topic keywords")
                } else {
                    (3, "topic guidance")
                };
                hits.push((score, topic.id.as_str(), "", topic.title.as_str(), why));
            }
            for section in &topic.sections {
                let section_match = matches(&format!("{} {}", section.id, section.title));
                if section_match || matches(&section.body) {
                    hits.push((
                        if section_match { 2 } else { 3 },
                        topic.id.as_str(),
                        section.id.as_str(),
                        section.title.as_str(),
                        if section_match {
                            "section title"
                        } else {
                            "section guidance"
                        },
                    ));
                }
            }
        }
        hits.sort_by_key(|h| (h.0, h.1, h.2));
        let more = hits.len() > limit;
        let results: Vec<_> = hits.into_iter().take(limit).map(|(_, topic, section, title, reason)| json!({"topic":topic,"section":section,"title":title,"match":reason})).collect();
        return Ok(envelope(
            corpus,
            "search",
            json!({"results":results, "more":more}),
        ));
    }
    let topic = corpus
        .topics
        .iter()
        .find(|t| identifier(name) && t.id == name)
        .ok_or_else(|| {
            let mut error = failure(
                "unknown_topic",
                "Unknown topic. Use 'rio docs' or 'rio docs search <query>'.",
            );
            error.suggestions = corpus
                .topics
                .iter()
                .filter(|t| identifier(name) && (t.id.contains(name) || name.contains(&t.id)))
                .take(3)
                .map(|t| t.id.clone())
                .collect();
            error
        })?;
    let sections: Vec<_> = if let Some(id) = &args.section {
        vec![
            topic
                .sections
                .iter()
                .find(|s| identifier(id) && s.id == *id)
                .ok_or_else(|| Failure {
                    code: "unknown_section",
                    message: "Unknown section. Available section IDs are listed below.",
                    suggestions: topic.sections.iter().map(|s| s.id.clone()).collect(),
                })?,
        ]
    } else {
        topic.sections.iter().collect()
    };
    Ok(envelope(
        corpus,
        if args.section.is_some() {
            "section"
        } else {
            "topic"
        },
        json!({
            "id":topic.id, "title":topic.title, "prerequisites":topic.prerequisites,
            "sections":sections.iter().map(|s|json!({"id":s.id,"title":s.title,"body":s.body})).collect::<Vec<_>>(),
            "available_sections":topic.sections.iter().map(|s|&s.id).collect::<Vec<_>>(), "related":topic.related
        }),
    ))
}
fn plain(value: &Value) -> String {
    let data = &value["data"];
    let mut out = format!(
        "Rio {} · docs {}\n",
        value["rio_version"].as_str().unwrap_or(""),
        value["docs_revision"]
            .as_str()
            .unwrap_or("")
            .get(..12)
            .unwrap_or("unknown")
    );
    match value["kind"].as_str().unwrap_or("") {
        "index" => {
            out.push_str(USAGE);
            out.push('\n');
            for entry in data["topics"].as_array().into_iter().flatten() {
                out.push_str(&format!(
                    "{}: {}\n",
                    entry["id"].as_str().unwrap_or(""),
                    entry["summary"].as_str().unwrap_or("")
                ));
            }
        }
        "topic" | "section" => {
            out.push_str(&format!(
                "# {} [{}]\n\n{}\n",
                data["title"].as_str().unwrap_or(""),
                data["id"].as_str().unwrap_or(""),
                data["prerequisites"].as_str().unwrap_or("")
            ));
            for section in data["sections"].as_array().into_iter().flatten() {
                out.push_str(&format!(
                    "\n## {} [{}]\n{}\n",
                    section["title"].as_str().unwrap_or(""),
                    section["id"].as_str().unwrap_or(""),
                    section["body"].as_str().unwrap_or("")
                ));
            }
            for (key, label) in [("available_sections", "Sections"), ("related", "Related")] {
                let ids: Vec<_> = data[key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                out.push_str(&format!("\n{label}: {}\n", ids.join(", ")));
            }
        }
        "search" => {
            let hits = data["results"].as_array().unwrap();
            if hits.is_empty() {
                out.push_str("No matches. Try a command, setting, or error name.\n");
            }
            for hit in hits {
                let section = hit["section"].as_str().unwrap_or("");
                out.push_str(&format!(
                    "{}{}: {} ({})\n",
                    hit["topic"].as_str().unwrap_or(""),
                    if section.is_empty() {
                        String::new()
                    } else {
                        format!(" --section {section}")
                    },
                    hit["title"].as_str().unwrap_or(""),
                    hit["match"].as_str().unwrap_or("")
                ));
            }
            out.push_str(if data["more"] == true {
                "More matches: yes; refine the query or increase --limit.\n"
            } else {
                "More matches: no.\n"
            });
        }
        _ => {}
    }
    out
}
fn emit(output: &mut impl Write, content: &[u8]) -> io::Result<()> {
    output.write_all(content)?;
    output.flush()
}
pub fn run(args: DocsArgs) -> u8 {
    let corpus: Corpus = match serde_json::from_str(CORPUS) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("Embedded documentation is invalid.");
            return 3;
        }
    };
    let (value, code) = match document(&corpus, &args) {
        Ok(value) => (value, 0),
        Err(error) => {
            if args.format == Format::Text {
                eprintln!(
                    "{}{}",
                    error.message,
                    if error.suggestions.is_empty() {
                        String::new()
                    } else {
                        format!("\n{}", error.suggestions.join(", "))
                    }
                );
                return 2;
            }
            (
                envelope(
                    &corpus,
                    "error",
                    json!({"code":error.code,"message":error.message,"suggestions":error.suggestions}),
                ),
                2,
            )
        }
    };
    let output = if args.format == Format::Json {
        format!("{value}\n")
    } else {
        plain(&value)
    };
    let limit = if args.format == Format::Json {
        12 * 1024
    } else if value["kind"] == "topic" {
        8 * 1024
    } else {
        4 * 1024
    };
    if output.len() > limit {
        eprintln!("Embedded documentation exceeds its output budget.");
        return 3;
    }
    match emit(&mut io::stdout().lock(), output.as_bytes()) {
        Ok(()) => code,
        Err(_) => {
            eprintln!("Could not write documentation output.");
            3
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_failure_is_propagated() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert!(emit(&mut Broken, b"docs").is_err());
    }
}
