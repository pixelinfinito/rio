//! Development-only export: no public command or production write path.
use clap::CommandFactory;
use serde_json::{Value, json};

fn inventory(mut command: clap::Command, path: String, rows: &mut Vec<Value>) {
    command.build();
    let args: Vec<_> = command.get_arguments().filter(|a| !a.is_hide_set()).map(|a| {
        json!({"id":a.get_id().as_str(), "long":a.get_long(), "short":a.get_short(),
            "help":a.get_help().map(ToString::to_string).unwrap_or_default(),
            "required":a.is_required_set(), "defaults":a.get_default_values().iter().map(|v|v.to_string_lossy()).collect::<Vec<_>>(),
            "values":a.get_possible_values().iter().filter(|v|!v.is_hide_set()).map(|v|v.get_name()).collect::<Vec<_>>()})
    }).collect();
    rows.push(json!({"command":path,"about":command.get_about().map(ToString::to_string).unwrap_or_default(),"arguments":args,"help":command.render_long_help().to_string()}));
    for child in command
        .get_subcommands()
        .filter(|s| !s.is_hide_set() && s.get_name() != "help")
    {
        inventory(child.clone(), format!("{path} {}", child.get_name()), rows);
    }
}
#[test]
#[ignore = "writes development inventory only when explicitly requested"]
fn export_documentation_inventory() {
    let destination = std::env::var("RIO_DOCS_INVENTORY")
        .expect("set RIO_DOCS_INVENTORY to the output JSON file");
    let mut rows = Vec::new();
    inventory(crate::Cli::command(), "rio".into(), &mut rows);
    std::fs::write(
        destination,
        format!("{}\n", serde_json::to_string_pretty(&rows).unwrap()),
    )
    .unwrap();
}

#[test]
fn guide_examples_parse_without_running_handlers() {
    use clap::Parser;
    for example in [
        "rio review --no-tui",
        "rio review --staged --offline --format json",
        "rio review --base origin/main --format sarif",
        "rio review --profile rio/openrouter --preset standard",
        "rio init --endpoint https://example.invalid --token-stdin",
        "rio init --runner self-hosted --account ACCOUNT_ID",
        "rio init --no-tui --credential-store file",
        "rio deploy --dry-run",
        "rio init --github-app --github-org ORG",
        "rio review --pr 123",
        "rio review --pr 123 --publish",
        "rio qa validate",
        "rio qa seed build",
        "rio qa seed export --help",
        "rio qa init --accept-contract",
        "rio qa sync --check",
        "rio qa --full --format json",
        "rio qa --baseline --cell mobile/dark",
        "rio qa show visit-home",
        "rio profile show rio/base",
        "rio profile validate example.yaml",
        "rio docs profiles --section inheritance",
    ] {
        let parsed = crate::Cli::try_parse_from(example.split_whitespace());
        assert!(
            parsed.is_ok()
                || parsed
                    .as_ref()
                    .is_err_and(|e| e.kind() == clap::error::ErrorKind::DisplayHelp),
            "{example}: {}",
            parsed.err().unwrap()
        );
    }
}
