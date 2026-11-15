# CLI Documentation

## Purpose

Let agents and users discover accurate documentation bundled with the installed Rio binary and retrieve only the information needed for a task, without external access or a large context payload.

## ADDED Requirements

### Requirement: Embedded independent documentation
`rio docs` SHALL read documentation embedded in the binary without network access, subprocesses, repository discovery, machine/profile configuration, keychain access, or cache writes. It SHALL work outside a repository with only the binary installed. Normal source builds SHALL NOT require documentation generation tools or downloads.

#### Scenario: Standalone binary with broken configuration
- **WHEN** an installed binary runs `rio docs review` in an empty directory with no helper tools on PATH, unavailable network, and malformed Rio configuration
- **THEN** documentation retrieval succeeds without accessing that configuration or creating files

#### Scenario: Source checkout is absent
- **WHEN** the binary is copied away from its source tree and documentation files
- **THEN** index, topic, section, and search commands continue to work

### Requirement: Compact default discovery
`rio docs` and `rio docs list` SHALL return the same compact index with stable topic IDs, short descriptions, and retrieval syntax. They SHALL NOT return full topic bodies. Top-level CLI help SHALL advertise the documentation command.

#### Scenario: Agent discovers documentation
- **WHEN** an agent invokes `rio docs`
- **THEN** it receives a bounded index showing how to retrieve or search topics, without loading the complete manual

### Requirement: Targeted topic and section retrieval
`rio docs <topic>` SHALL return one topic. `--section <id>` SHALL return only that section plus topic identity and necessary prerequisites/side-effect constraints. Responses SHALL expose available section IDs and relevant related topic IDs. Topic/section arguments SHALL resolve only embedded identifiers, never filesystem paths or URLs.

#### Scenario: Retrieve inheritance guidance
- **WHEN** an agent runs `rio docs profiles --section inheritance`
- **THEN** it receives inheritance semantics, relevant prerequisites and validation guidance, and related IDs without unrelated profile sections

#### Scenario: Reject a path-like topic
- **WHEN** a caller supplies an absolute path, `../config.toml`, or a URL as a topic
- **THEN** the command reports an invalid or unknown topic without reading files or fetching content

### Requirement: Complete actionable agent content
Embedded English topics SHALL cover every public command/subcommand and consequential configuration concept with purpose, prerequisites, commands/options, effects, output and exit interpretation, and recovery advice. They SHALL distinguish local/hosted/offline modes and provide sufficient content for documented CLI tasks without consulting a website. Images and long tutorial narratives SHALL be excluded.

#### Scenario: Agent chooses a review mode
- **WHEN** an agent reads the review topic
- **THEN** it can distinguish working-tree, staged, branch and hosted PR selection, choose machine-readable output, and interpret incomplete results and exit codes

#### Scenario: Mutation is explicit
- **WHEN** an agent reads suppression application, deployment, or PR publication guidance
- **THEN** the content states the affected files or remote resources, required credentials or endpoint, and actual confirmation behavior

### Requirement: Local bounded search
`rio docs search <query>` SHALL search embedded topic/section identifiers and content deterministically, returning IDs, titles, and brief match explanations instead of topic bodies. The default limit SHALL be 5, and `--limit` SHALL accept 1–10. Results SHALL state whether more matches exist; equal-ranked matches SHALL sort by topic then section ID.

#### Scenario: Find dependency recovery guidance
- **WHEN** an agent searches for `dependency mismatch`
- **THEN** it receives at most five relevant topic/section references with short match explanations and can retrieve the identified guidance separately

#### Scenario: Search has no matches
- **WHEN** a valid nonempty query matches nothing
- **THEN** the command exits 0 with an empty result and a concise no-matches indication

#### Scenario: Search inputs are invalid
- **WHEN** the query is whitespace-only or exceeds 256 UTF-8 bytes, or the limit is outside 1–10
- **THEN** the command exits 2 with a bounded usage error

### Requirement: Predictable output size
Complete text stdout SHALL be at most 4 KiB for index, search, or section retrieval and 8 KiB for a whole topic. Complete JSON stdout SHALL be at most 12 KiB. Authored entries exceeding budgets SHALL fail validation instead of being silently truncated. The command SHALL NOT offer an automatic full-corpus dump.

#### Scenario: Topic grows beyond the cap
- **WHEN** an authored topic renders beyond its output budget
- **THEN** documentation validation fails and requires shortening or splitting the topic before shipping

#### Scenario: Maximum search result set
- **WHEN** a search returns ten hits in either supported format
- **THEN** the complete response respects the format's cap without clipping commands or omitting required metadata

### Requirement: Measured token efficiency
Documentation checks SHALL measure complete output with a recorded, pinned reference tokenizer. Under `o200k_base`, text index/search/section output SHALL not exceed 800 tokens, whole topics 1,800 tokens, and JSON output 3,000 tokens. Documentation SHALL state these are reference measurements rather than guarantees for every model. The embedded content payload SHALL not exceed 512 KiB.

#### Scenario: Bytes pass but tokens exceed the budget
- **WHEN** a topic satisfies its byte limit but exceeds 1,800 reference tokens
- **THEN** the documentation check fails and records the topic and measured count

#### Scenario: Runtime has no tokenizer
- **WHEN** an installed binary runs a docs command without any tokenizer library or external runtime
- **THEN** it serves the previously validated content successfully

### Requirement: Deterministic plain and JSON output
All docs forms SHALL accept `--format text|json`, defaulting to text. They SHALL emit no ANSI codes, pager, TUI, progress text, or locale-dependent content. JSON SHALL be one compact `docs-v1` envelope with schema version, Rio version/commit, docs revision, operation kind, and operation data. Identical binary and arguments SHALL produce identical output.

#### Scenario: Redirect JSON to a consumer
- **WHEN** `rio docs review --format json` is invoked with or without a terminal
- **THEN** stdout contains exactly one schema-valid JSON document with the same topic data and metadata, followed by one newline, and no unrelated messages

#### Scenario: Environment does not change documentation
- **WHEN** identical docs arguments run under different locales, color variables, CI settings, or current directories
- **THEN** the same binary produces byte-identical successful stdout

### Requirement: Documentation version fidelity
Embedded content SHALL describe the binary's source version and identify its documentation revision. It SHALL NOT silently substitute a newer remote manual. Wiki availability SHALL NOT affect retrieval or accuracy of the embedded documentation.

#### Scenario: Installed release predates a new feature
- **WHEN** a user invokes docs on an older installed release after a newer Wiki revision is published
- **THEN** the command retains the older release's documentation and version identifiers

### Requirement: Explicit errors and exit codes
Docs SHALL exit 0 on success, 2 on usage/lookup errors, and 3 on output/internal failure. Text errors SHALL use stderr with empty stdout. After argument parsing, JSON semantic errors SHALL produce one bounded `kind: error` envelope with a stable code. Parser errors SHALL follow normal CLI stderr behavior; output failure SHALL NOT promise a complete document.

#### Scenario: Unknown topic in JSON mode
- **WHEN** `rio docs nonexistent --format json` parses successfully
- **THEN** it exits 2 with one JSON error containing `unknown_topic` and at most a short list of suggested IDs

#### Scenario: Unknown section
- **WHEN** a valid topic is requested with a section it does not contain
- **THEN** the command exits 2 with `unknown_section` in JSON mode or a concise stderr message in text mode, lists valid section IDs within budget, and does not return the whole topic

#### Scenario: Section supplied to index
- **WHEN** `--section` is supplied without a topic or with list/search
- **THEN** the command exits 2 and identifies the invalid option combination

#### Scenario: Unsupported format fails before dispatch
- **WHEN** `rio docs --format xml` is supplied
- **THEN** argument parsing exits 2 with a stderr usage error and no JSON output guarantee
