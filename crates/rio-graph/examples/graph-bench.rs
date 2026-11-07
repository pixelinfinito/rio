//! Measures impact-graph builds on a real repository.
//!
//! cargo run --release -p rio-graph --example graph-bench -- \
//!     REPO BASE_REF [--threads N] [--compare-threads N] [--timeout SECONDS]
//!
//! The working tree of REPO is the head; BASE_REF selects the merge base, as
//! `rio review --base` does. `--compare-threads N` builds with one thread and
//! with N and fails unless the slices are identical.
use anyhow::{Context, Result, ensure};
use rio_git::{GixRepo, Selection, diff, select};
use rio_graph::{GraphBuilder, GraphOptions, GraphSlices};
use std::time::{Duration, Instant};

struct Args {
    repo: String,
    base: String,
    threads: Option<usize>,
    compare: Option<usize>,
    timeout: Duration,
}
fn args() -> Result<Args> {
    let mut values = std::env::args().skip(1);
    let usage =
        "usage: graph-bench REPO BASE_REF [--threads N] [--compare-threads N] [--timeout SECONDS]";
    let mut args = Args {
        repo: values.next().context(usage)?,
        base: values.next().context(usage)?,
        threads: None,
        compare: None,
        timeout: Duration::from_secs(600),
    };
    while let Some(flag) = values.next() {
        let mut number = || -> Result<u64> { Ok(values.next().context(usage)?.parse()?) };
        match flag.as_str() {
            "--threads" => args.threads = Some(number()? as usize),
            "--compare-threads" => args.compare = Some(number()? as usize),
            "--timeout" => args.timeout = Duration::from_secs(number()?),
            _ => anyhow::bail!(usage),
        }
    }
    Ok(args)
}
fn main() -> Result<()> {
    let args = args()?;
    let repo = GixRepo::discover(&args.repo)?;
    let changes = select(
        &repo,
        Selection::Branch {
            reference: args.base.clone(),
        },
    )?;
    let options = GraphOptions::default();
    let delta = diff(&changes, &options.exclude)?;
    let files = changes.base.len() + changes.head.len();
    let bytes: usize = changes
        .base
        .values()
        .chain(changes.head.values())
        .map(|e| e.content.len())
        .sum();
    eprintln!(
        "{files} paths, {:.1} MiB across base and head, {} changed files",
        bytes as f64 / 1048576.0,
        delta.files.len()
    );
    let run = |threads: Option<usize>| -> Result<GraphSlices> {
        let start = Instant::now();
        let deadline = start + args.timeout;
        let stop = || Instant::now() >= deadline;
        let builder = GraphBuilder {
            threads,
            ..GraphBuilder::default()
        };
        let graph = builder.build_until(&changes, &delta, &options, &stop)?;
        let parsed = builder.syntax.parsed();
        println!(
            "{}",
            serde_json::json!({
                "threads": threads,
                "seconds": start.elapsed().as_secs_f64(),
                "files_parsed": parsed.0,
                "mib_parsed": parsed.1 as f64 / 1048576.0,
                "nodes": [graph.base.nodes.len(), graph.head.nodes.len()],
                "edges": [graph.base.edges.len(), graph.head.edges.len()],
                "truncated": [graph.base.truncated, graph.head.truncated],
                "deadline_reached": stop(),
            })
        );
        Ok(graph)
    };
    match args.compare {
        Some(threads) => {
            let one = serde_json::to_string(&run(Some(1))?)?;
            let many = serde_json::to_string(&run(Some(threads))?)?;
            ensure!(one == many, "slices differ between 1 and {threads} threads");
            eprintln!("identical slices with 1 and {threads} threads");
        }
        None => {
            run(args.threads)?;
        }
    }
    Ok(())
}
