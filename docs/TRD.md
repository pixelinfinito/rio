# Rio — Technical Requirements Document (TRD)

Nov 4, 2026 · @Marcos Lisboa

This document specifies how Rio is built: a Rust CLI, a Cloudflare control plane that interprets YAML review profiles, pluggable runners that execute untrusted code, and an evidence-gated pipeline of deterministic checks, agents and an independent verifier. It implements the requirements in the PRD.

## System overview

&#91;embedded content: system architecture · control plane on Cloudflare, pluggable runner\]

The control plane (Worker API, Workflows, D1, R2) lives in the user’s Cloudflare account and never executes repository code. Execution of untrusted code — checkout, build, indexing, scanners, tests, verifier reproductions — happens in a runner chosen at setup, submitted as a job and resumed through a signed event.

| Component | Technology | Responsibility |
| --- | --- | --- |
| CLI | Rust, single binary | Diff and snapshot, local deterministic checks, submit review, render report, wizard and deploy |
| Worker API | Cloudflare Workers, TypeScript (Hono) | Authentication, review submission, status, report delivery, webhook ingestion, PR publishing |
| Workflow engine | Cloudflare Workflows + Queues | Interprets the resolved profile: durable steps, retries, waits for runner events, agent fan-out |
| Runner | Cloudflare Sandbox, self-hosted Rust binary, GitHub Actions | Executes jobs in isolation; writes results to R2; emits completion events |
| Storage | D1 (SQLite), R2 (objects) | Reviews, findings, feedback, resolved profiles; snapshots, indexes, logs, evidence |
| Model gateway | Worker module | Calls configured providers with per-task models; enforces token budgets; records usage |

The Rust code is shared between the CLI and the self-hosted runner (diffing, snapshotting, Tree-sitter parsing, adapter execution) so the local and remote pipelines behave identically.

## CLI design (Rust)

A Cargo workspace; the CLI and the self-hosted runner are thin binaries over shared crates.

| Crate | Purpose | Key dependencies |
| --- | --- | --- |
| `rio-cli` | Commands, TTY rendering, wizard | `clap`, `ratatui`/`indicatif`, `keyring` |
| `rio-core` | Review model: findings, evidence levels, finding identity, report rendering (terminal, md, json, sarif) | `serde`, `serde_json` |
| `rio-git` | Diff, base resolution, content-addressed snapshots, PR metadata | `gix` (fallback `git2`) |
| `rio-profile` | YAML profile parsing, inheritance resolution, JSON-schema validation, triage rule evaluation | `serde_yaml`, `jsonschema` |
| `rio-adapters` | Language adapter trait and built-ins (TypeScript, Python, Rust); Tree-sitter parsing; running project tools | `tree-sitter`, `tokio`, `which`, `cargo_metadata` |
| `rio-graph` | Lazy impact graph: symbol tables, reference resolution via LSP/Tree-sitter, before/after comparison | `tree-sitter`, `lsp-types` |
| `rio-client` | HTTP client for the Worker API, auth tokens, streaming status | `reqwest`, `tokio` |
| `rio-runner` | Self-hosted runner: job polling, sandboxed execution, R2 upload, event signing | `tokio`, `bollard` (Docker) or `nsjail` wrapper |

**Local pipeline (`rio review`)**

1. Resolve base and head: working tree, staged index, `--base` ref or PR head. Working-tree and staged states are materialized into a **snapshot**: a tarball of changed files plus base commit hash, addressed by its BLAKE3 hash.
2. Detect repo configuration: languages, package managers, test runners, existing lint/format configs, `.rio/` directory.
3. Resolve the profile (`--profile`, `.rio/profiles/default.yaml`, or `rio/base`) and validate it.
4. Run deterministic checks locally when the adapter supports it and `--offline` or no endpoint is configured; otherwise delegate to the runner. Results stream to the terminal as they arrive.
5. Submit `{snapshot_ref, base, head, resolved_profile, intent_input}` to the Worker; subscribe to status events (SSE); render findings progressively.
6. On completion, render the report, exit with a code from the profile’s `fail_on` policy, and cache the result under `.rio/cache/<review-id>`.

`rio review` must produce useful output with no endpoint at all (v0.1): the deterministic layer and the lazy graph are fully local.

## Profile schema and module contract

**Profile schema (version 1)**, published as JSON Schema at `schemas/profile-v1.json`:

```yaml
version: 1
name: string
extends: <module ref>              # optional; single inheritance, deep-merge with list override
budget:
  fast: { wall_time: duration, tokens: int, agents_max: int }
  deep: { wall_time: duration, tokens: int, agents_max: int }
models:
  <alias>: <provider>/<model>      # 'verifier' alias must differ from 'default' in v0.1; v0.2 relaxes this when verify.voters > 1
posture: critical-only | balanced | thorough   # precision/recall dial, default balanced (see "Posture")
max_defects: int                   # default 10; posture sets it, an explicit value wins
always_human: [glob]               # changed paths that force risk_tier: high and require_human()
rounds:
  cap: int                         # default 3; rounds posted per PR head lineage before Rio stops posting
  diff_only_after: int             # default 1; later rounds re-review only the diff since the last round
verify:                            # v0.2 (rio-v0-2-verifier)
  voters: int                      # default 3
  quorum: int                      # default 2; agreeing voters needed to promote a hypothesis
  model: alias                     # default 'verifier' if set, else 'default'
council:                           # v0.3 (rio-v0-3-council); see "Council"
  members: [ { provider, model, prompt, context_pack, role, weight } ]
  max_experiments: int             # default 2
  max_rounds: int                  # default 2
  min_members: int                 # default 3
  vendors_allowed: [string]
steps:
  - id: string
    uses: <module ref>             # rio/<name> or <org>/<name>@<semver|git-sha>
    needs: [step ids]              # DAG; cycles rejected at validation
    parallel: bool
    with: { ... }                  # module-specific, validated by the module's own schema
    rules: [ { when: <expr>, then: <action> } ]   # triage only
    agents: [ { <name>: { model: alias, ... } } ]  # agents step only
suppress: [ { path: glob } | { rule: pattern } | { finding: id } ]
publish: never | ask | auto
fail_on: { evidence, categories, states, rules, incomplete, required_checks }
min_evidence: reproduced | static_proven | plausible   # never below plausible
max_lines: int
```

`posture`, `max_defects`, `always_human` and `rounds` are part of profile schema v1 (added by the v0.1 change as contracts that v0.2 consumes). `verify` and `council` are v0.2 and v0.3 extensions; a v1 profile without them stays valid.

**Posture.** A single dial that trades recall for precision, after the rule in "A Practical Approach to Verifying Code at Scale" (OpenAI Codex team, Dec 2025): a comment is worth posting only when its expected benefit exceeds the cost of verifying it plus the damage of a false alarm. Posture sets the derived values jointly; an explicit `min_evidence` or `max_defects` in the same profile overrides the derived one, and `min_evidence` never resolves below `plausible`.

| Posture | `min_evidence` | `max_defects` | Severity floor for defects | `plausible` risks rendered |
| --- | --- | --- | --- | --- |
| `critical-only` | `reproduced` | 3 | `error` | no |
| `balanced` (default) | `static_proven` | 10 | `warning` | yes, capped at `max_defects` |
| `thorough` | `plausible` | 15 | `info` | yes, uncapped |

Presets map onto posture plus budget: Quick = `critical-only` + `budget.fast`, Standard = `balanced` + `budget.fast`, Deep (`--deep`) = `thorough` + `budget.deep`. Deterministic findings are never capped by `max_defects`; the cap applies to agent-originated defects after verification, in impact × evidence order, and the footer states how many were held back.

Rule expressions are a small, non-Turing-complete language evaluated by `rio-profile`: predicates `touches(glob)`, `adds_dependency()`, `lines_changed > n`, `risk >= level`, `language == x`; actions `enable(agent)`, `disable(agent)`, `budget(fast|deep)`, `require_human()`.

**Module contract.** A module is a directory with a `module.yaml` manifest and, depending on kind, prompts or a binary:

| Kind | Manifest declares | Executes where |
| --- | --- | --- |
| `adapter` | Languages, capabilities (parse, typecheck, lint, test, coverage, index, scan), commands, network domains needed | Runner |
| `agent` | Prompt template, allowed tools, output schema, default model alias, budget hints | Workflow step calling the model gateway |
| `runner` | Job protocol version, resource limits, supported features | Outside the control plane |
| `step` | Input/output schema for a pipeline step (`rio/prepare`, `rio/triage`, …) | Workflow step |
| `member` (v0.3) | Council member: `provider`, `model`, `prompt`, `context_pack` (`diff-only`, `graph-heavy`, `execution`), `role` (`skeptic`, `exploit-author`, `code-owner`, `maintainer`, `tester`), `weight`, output schema `council-assessment-v1` | Workflow step calling the model gateway, or the self-hosted runner for open-weights members |

Module refs resolve from the built-in set (`rio/*`), a git registry (`registry.rio.dev` mirrorable), or a local path. Third-party modules are pinned by version or SHA and their resolved manifest is stored with the review. v0.x modules are declarative (YAML + prompts); whether adapters may ship WebAssembly logic is an open question (PRD).

## Workflow engine on Cloudflare

One Cloudflare Workflow instance per review (`ReviewWorkflow`), parameterized by the review id. The Workflow does not contain review logic; it walks the resolved profile’s step DAG.

**Execution model**

1. Load the resolved profile and module manifests from D1/R2.
2. Topologically sort `steps` by `needs`; steps marked `parallel` with no mutual dependency run as concurrent `step.do` calls, or are fanned out through a Queue when more than the configured concurrency.
3. Each step is one of three shapes:
   - **Inline step** (prepare, triage, report): runs in the Worker, reads inputs from R2 by reference, writes outputs to R2, records a row in D1.
   - **Runner job** (checks, graph, reproductions): writes a job record, enqueues it for the runner, then `step.waitForEvent("job:<id>")` with a timeout from the budget. The runner’s signed completion event resumes the step with result references.
   - **Model step** (agents, verifier): calls the model gateway with the prompt, tools and budget; tool calls that need code execution become nested runner jobs.
4. Budgets are enforced at two levels: a per-step timeout and a review-level token and wall-time ledger kept in D1; exceeding the ledger cancels remaining optional steps and marks the review `partial`.
5. On completion the report step consolidates findings and emits `review:done`; the CLI’s SSE subscription and PR publisher react to it.

**Idempotency and retries.** Every step and job carries `review_id + step_id + attempt`; outputs are written to R2 under that key, so a retried step overwrites rather than duplicates. PR comments carry a hidden marker with the finding identity and are edited in place. Before publishing, the Worker checks that the PR head SHA still matches the reviewed head.

**Limits to respect** (verify current values before implementation): Workflow step result size, event payload size, maximum concurrent instances per account, Queue message size. Anything beyond a few kilobytes is stored in R2 and passed by key.

## Runner interface and implementations

A runner is anything that can execute a job description and report back. The protocol is deliberately simple so that new backends are a few hundred lines.

**Job** (JSON, written to D1 and delivered via Queue or polling):

```json
{
  "job_id": "...", "review_id": "...", "attempt": 1,
  "snapshot": { "r2_key": "snapshots/<hash>.tar.zst", "base_sha": "...", "head_sha": "..." },
  "kind": "checks" | "graph" | "reproduce" | "index",
  "adapter": "rio/adapter-typescript@1.2.0",
  "commands": [ { "id": "typecheck", "argv": ["npx","tsc","--noEmit"], "cwd": "." } ],
  "limits": { "cpu_seconds": 600, "memory_mb": 4096, "wall_seconds": 900 },
  "network": { "allow": ["registry.npmjs.org"] },
  "upload_token": "<short-lived R2 token scoped to results/<job_id>/>"
}
```

**Completion event** (POSTed to the Worker, signed with the runner’s registration key): `{ job_id, attempt, status: ok|failed|timeout, results: { <command id>: { exit_code, r2_key } }, metrics }`.

| Implementation | How it runs jobs | Fit |
| --- | --- | --- |
| Cloudflare Sandbox | Workflow spawns a sandbox, streams the snapshot in, runs commands, uploads results | Small and mid-size repos; zero setup; bounded by Sandbox CPU/memory/duration limits |
| Self-hosted (`rio runner serve`) | Rust binary polls the Worker for jobs; executes each in a fresh container (Docker) or namespace jail; uploads to R2 | Large builds, monorepos, private registries, GPU-free heavy toolchains |
| GitHub Actions (v0.4) | Workflow dispatches a repository workflow with the job id; the action runs the same Rust runner in `--one-shot` mode | Teams that already pay for Actions minutes; fork PRs under GitHub’s permission model |

All runners share the same executor crate, so a job produces identical results regardless of backend. A runner advertises its capabilities on registration (max limits, network policy, toolchains preinstalled); triage will not schedule a job a runner cannot honor.

## Review pipeline internals

**Prepare (`rio/prepare`).** Inputs: diff, base and head snapshots, PR metadata, `.rio/` config. Detects languages and frameworks from manifests and adapter probes; marks excluded paths (vendored, generated, lockfiles handled separately). Reads **owner guidance**: every `REVIEW.md`, `CLAUDE.md` and `AGENTS.md` from the repository root down to each changed file's directory, in path order, into an `owner_guidance` artifact `[{path, scope_dir, content_hash, lines[]}]`. Guidance is data, never policy: it is injected into agent, verifier and council prompts inside delimited blocks, it cannot enable tools, change budgets or publish, and the reviewer uses it in two ways only: a change that contradicts a line is flagged (`guidance/contradiction`, citing the file and line), and a change that makes a line stale is flagged (`guidance/stale`). v0.1 produces the artifact and stores it with the run; nothing consumes it until the agents ship. Runs the **intent agent** on the cheap model: output is a JSON list of `{behavior, evidence_lines, confidence_kind: declared|inferred}`. In CLI mode the list is shown for confirmation; confirmed behaviors become the `intent` artifact every later step receives. A diff above `max_lines` (profile) is partitioned by directory and dependency cluster into logical parts reviewed separately.

**Checks (`rio/checks`).** One runner job per adapter. Each command maps to a deterministic finding type with a stable rule id. Diff coverage: run the project’s test command with coverage enabled, then intersect coverage data with added/modified line ranges → `untested_change` findings per function. Dependency audit: diff of manifest/lockfile resolved versions → OSV API query (batched) → `vulnerable_dependency` findings; new dependencies with install scripts or very recent first publish are flagged for the supply-chain agent. Tool unavailable → `check_skipped` entry in the report footer, never silence.

**Built-in adapters.** Each language ships as a `rio/adapter-*` module whose manifest declares capabilities, invocations and the per-tool exit-code contract (any undeclared code is `failed/tool_crashed`; a "diagnostics" code with zero parsed findings is `failed/unparseable_output`).

| Language | Capability | Tool and invocation | Parse | Exit codes (clean / diagnostics / other) |
| --- | --- | --- | --- | --- |
| TypeScript | typecheck | `tsc --noEmit --pretty false -p <root>` | line regex | 0 / 1, 2 |
| TypeScript | lint | `eslint -f json <changed files>` (only with a project config) | JSON | 0 / 1 / 2 → `tool_config_error` |
| TypeScript | coverage | `vitest run --coverage` or `jest --coverage`, LCOV into the cache | LCOV | 0 / 1 → `tests_failed`, coverage kept |
| Python | typecheck | `pyright --outputjson` or `mypy --output json` | JSON | 0 / 1 / 2 → `tool_crashed` (pyright 3, 4 → `tool_config_error`) |
| Python | lint | `ruff check --output-format json <changed files>` (only with a Ruff config) | JSON | 0 / 1 / 2 → `tool_config_error` |
| Python | coverage | `coverage run -m pytest -q` then `coverage json` | coverage.py JSON | 0 / 1 → `tests_failed`; 5 → `skipped/no_tests`; 2–4 → `tool_crashed` |
| Rust | typecheck | `cargo check --message-format=json`; `--workspace` when the root is a workspace, else `-p <member>` for each changed member and its reverse dependencies | cargo JSON `compiler-message` | 0 / 101 with parsed diagnostics / 101 without diagnostics → `tool_crashed` |
| Rust | lint | `cargo clippy --message-format=json` (only when a `clippy.toml`/`.clippy.toml` or a `[lints]` table exists) | cargo JSON `compiler-message` | 0 / 101 with parsed diagnostics / 101 without diagnostics → `tool_crashed` |
| Rust | lint (formatting group) | `cargo fmt --check` (only when `rustfmt.toml` or `.rustfmt.toml` exists); one `lint/rustfmt/format` finding per file, severity `warning` | rustfmt `Diff in <file> at line N` | 0 / 1 / other → `tool_crashed` |
| Rust | coverage | `cargo llvm-cov --lcov --output-path <cache>/lcov.info` when `cargo-llvm-cov` is installed, else `skipped/tool_missing` | LCOV | 0 / 101 with parsed test failures → `tests_failed`, coverage kept; 101 without → `tool_crashed` |

**Rust specifics.** Diagnostics are cargo's `compiler-message` records: `level` maps to severity (`error` → `error`, `warning` → `warning`, `note`/`help` attach to the parent), the primary span (`spans[].is_primary`) gives path, line and column, `code.code` gives the rule id (`typecheck/rustc/E0308`, `lint/clippy/needless_return`), and `rendered` is kept as the message body. Diagnostics that cargo reports for a dependency outside the repository are dropped with a footer count. The dependency audit parses `Cargo.lock` v3 and v4 into the dependency graph with `crates.io` as the OSV ecosystem; git and path dependencies cannot be audited and are listed in the footer as unauditable; optional dependencies pulled in by `[features]` carry the `optional` flag. Rust has no installed-tree concept, so dependency compatibility is defined as: `Cargo.lock` unchanged between base and head for the affected members, and the toolchain named in `rust-toolchain.toml` (or the default toolchain when absent) installed; otherwise the state is `unverified`, and `trust_installed_dependencies` applies as for other languages. The `target/` directory is linked from the work tree into the disposable tool tree the way `node_modules` is, so incremental builds are reused; a dirty or missing `target/` makes the first baseline build slow, and Rio never runs `cargo build` for the user. `target/` joins the vendored exclusion defaults.

**Graph (`rio/graph`, lazy mode).** Seed set = symbols enclosing every changed hunk in both versions. Expand outward `hops` times: definitions via Tree-sitter symbol tables, references via LSP `textDocument/references` where a language server is available, else via indexed identifier search filtered by Tree-sitter scope. Nodes: file, function, class, endpoint, table, event, config, test. Edges carry `{kind, source: lsp|tree-sitter|text|framework|contract, confidence: resolved|probable|unresolved, version: base|head}`. Removed symbols from base are kept so agents can see what disappeared. For Rust, symbols and references come from Tree-sitter Rust with the adapter's `queries/symbols.scm`, `queries/references.scm` and `queries/executable.scm` (macro invocations count as executable); module resolution follows `mod` declarations, `use` paths and workspace member manifests; items under `#[cfg(test)]` produce `tests` edges. Output: two graph slices (base, head) plus a delta, stored in R2 as JSON.

**Triage (`rio/triage`).** Evaluates profile rules against the prepare, checks and graph outputs to produce the execution plan: which agents run, with which budget and which context slice. Risk is computed from signals, not guessed: touched sensitive paths, public contract changes, missing coverage on changed logic, dependency changes, graph fan-out. Triage outputs `risk_tier: low | medium | high` with its reasons, carried in report-v1 as `risk_tier: { tier, reasons[], source }`. The profile's `always_human: [globs]` (CI workflow files, installers, auth, billing by convention) forces `high` with the matching glob as reason and the `require_human()` action; in v0.1, where triage is deferred, `always_human` matches are the only source of a tier. Rio never approves a change; the tier is exposed in JSON and SARIF so branch protection can act on it. The plan is stored and shown in the report (“why these agents ran”).

**Full graph (v0.4).** Background Workflow per repository builds per-file symbol tables keyed by file content hash; a commit’s graph is the union of its files’ tables plus a cross-file edge index. Changed files only recompute their own table; dependency or config changes invalidate the affected component.

## Agents, hypothesis board and verifier

The practices in this section draw on two published accounts of review at scale: "A Practical Approach to Verifying Code at Scale" (OpenAI Codex team, Dec 2025) and "How the Claude Code team does code review" (Anthropic, Oct 2026). Both run reviewers independently with repository-wide access and let verification, not generation, decide what is shown.

**Agent runtime.** An agent is a model step with a bounded tool set and a structured output. Tools: `read_file(path, version)`, `graph_query(path, symbol, hops)`, `search(pattern, scope)`, `run(command)` (becomes a runner job), `board_read()`, `board_write(hypothesis)`. `read_file` and `search` are repository-wide for both versions; the triage context slice is a hint about where to start, not a boundary. `run` is allowed by default for the correctness agent and the verifier and off by default for the others; a manifest may change either default, and fork PRs disable it everywhere. Each agent receives: the intent artifact, deterministic findings, owner guidance, its context slice from triage, and its budget. Output schema: a list of **hypotheses** `{id, location, trigger, observed, expected, impact, relation_to_change, graph_path, evidence[], suggested_fix, limitations}`.

**Hypothesis board (optional, deferred).** A D1 table scoped to the review. Before investigating a location an agent reads the board; if another agent holds a hypothesis on the same symbol it either attaches evidence to it or skips. The board is no longer on the critical path: both published teams run reviewers independently and deduplicate afterwards by voting, which is what the verifier quorum does here. `board_read` and `board_write` stay in the tool set as no-ops until a measured need for hand-off (contracts finds a consumer; correctness checks that consumer’s assumption) justifies enabling them.

**Built-in agents** (each a `rio/agent-*` module): intent, correctness, contracts, security (OWASP Top 10:2025 categories, ASVS 5.0 requirements as checklists; traces input → validation → authorization → transformation → sensitive operation), data-concurrency, supply-chain, performance, tests.

**Security step (`rio/security`, v0.3).** Security runs as its own step rather than as one agent among the others: it has its own `posture` and `fail_on` (defaults `thorough` and `evidence: plausible`, because a plausible injection path is worth a human look even when the general posture is `critical-only`), its own triage rules, and its findings go through the same verifier quorum. Its hypotheses are tagged `security` so the category floor and `max_defects` apply separately.

**Verifier (`rio/verify`).** Independent by construction:

- Receives the hypothesis and the code, not the generating agent’s reasoning.
- **Blind re-derivation first.** Before seeing the hypothesis, each voter answers "what, if anything, is wrong in this function?" from the location alone, then compares its answer with the hypothesis. A hypothesis that no blind pass rediscovers is not rejected, but the comparison is recorded as evidence and weighs in the quorum.
- **Quorum, not a stronger model.** `verify: { voters, quorum, model }` runs `voters` (default 3) independent verifier passes of the same model class at a small per-hypothesis budget and promotes a hypothesis when `quorum` (default 2) voters reach the same evidence level or better. The OpenAI post reports that verification recovers most known high-severity issues at a fraction of the generation budget, which is what makes several cheap voters a better buy than one expensive judge. A different `verify.model` alias remains an option, and `models.verifier` is honored when set; v0.2 relaxes the v0.1 rule that `verifier` must differ from `default` whenever `voters > 1`.
- Has tools the generators lack: run tests or scripts on **both** versions, query the base graph, diff behavior. `run` is on by default.

For each hypothesis it establishes: introduced or worsened by the change; path reachable; no protection elsewhere; consistent with real contracts; enough evidence for a fix. When feasible it writes a minimal reproduction or regression test and runs it against base and head; the test must assert legitimate behavior, not restate the hypothesis. Result: an **evidence level** — `reproduced`, `static_proven`, `plausible`, `refuted` — with the artifacts that justify it. Voters that disagree across the `refuted` boundary mark the hypothesis `verify.split`, which is a council trigger. Only hypotheses at or above the profile’s `min_evidence` (never below `plausible`) become findings; `plausible` ones are rendered as risks for human judgment, never as defects. The evidence floor is complemented by a **category floor**: hypotheses whose category is `style` or `diagnostic` (a restated tool output, a formatting or naming preference not backed by a project rule) are dropped from defects regardless of evidence level and at most listed in the footer. Agreement between agents is not evidence.

**Council (`rio/council`, v0.3).** An optional step after `verify` for findings that the verifier alone cannot settle. Trigger rules live in the profile (`evidence == plausible && severity >= high`, `verify.split`, `risk_tier == high`, `mode == deep`, `nightly`); the step is off in `rio/base` and on in the `security` and `critical` profiles, and is expected to run on 5–10 % of findings. Cost per finding is members × rounds × experiments, shown in the footer.

- **Members** are `member` modules with `provider`, `model`, `prompt`, `context_pack` (`diff-only`, `graph-heavy`, `execution`), `role` (`skeptic`, `exploit-author`, `code-owner`, `maintainer`, `tester`) and `weight`. Five members from different model families and vendors; when the PR author is an agent (family read from PR metadata when available), at most one member may share the author's model family.
- **Evidence pack**, identical for all members: the hypothesis, the graph slice, base and head of the affected files, and the verifier's artifacts. Members get no live tools. A member may request one experiment in structured form (`{command, version: base|head|both, expect}`); Rio runs at most `council.max_experiments` (default 2) as runner jobs and shares the results in round 2.
- **Assessment schema** `schemas/council-assessment-v1.json`: `real` (yes/no), `introduced_by_change` (yes/no), `impact`, `basis`, `evidence_refs[]`, optional `experiment_request`. An assessment without evidence refs, or one that fails validation, counts as an abstention.
- **Round 2** (`council.max_rounds: 2`): members see the other assessments anonymized and may change position only by citing an artifact or a concrete flaw in another assessment (`{changed_to, cites: artifact|assessment, ref, reason_code}`); no free prose.
- **Aggregator** is deterministic code, never a model. Per-member weights are learned from the eval set (precision and recall per member and category, re-estimated from feedback). The decision follows a weighted evidence tier: an experiment that fails on head and passes on base → `reproduced`; a found protection (assessments citing guarding code on the path, from members holding at least half of the weight) → `refuted`; otherwise the finding stays `plausible` with a council note for human judgment. Agreement count is never evidence.
- **Degradation.** The step runs with whoever answers within the timeout, minimum `council.min_members` (default 3 of 5), and reports `council: partial (n/5)`; a vendor outage never blocks a review.
- **Data governance.** A per-repo allowlist of council vendors (`council.vendors_allowed`), self-hosted open-weights members through the self-hosted runner, and an audit record of which content went to which vendor (`reviews/<id>/council/audit.json`). `rio init` gains an opt-in council step after the primary provider.
- **Keep-or-remove rule.** `eval/` reports council disagreement rate (members agreeing more than 95 % of the time means the step adds nothing and is removed), promotion and refutation accuracy on the `plausible` bucket, and cost per finding; the step stays only while it beats the verifier-only baseline A/B.

**Consolidation (`rio/report`).** Groups findings by root cause (same symbol path and trigger), assigns stable identity `blake3(rule_id | normalized_location | trigger_hash)`, diffs against the previous review of the same PR to set state transitions, applies suppressions and the posture (`max_defects`, severity floor), orders by impact × evidence, renders. Repeated instances of one pattern across the diff are reported as one class-level finding ("flag the class, not the instance") with every location listed, never as one finding per instance.

**Review convergence (v0.2, PR threads in v0.3).** A review has a **lineage**: the sequence of heads pushed to the same PR (or the same local branch under `--since-last`). Per lineage, `rounds.cap` (default 3) bounds how many rounds Rio posts; at the cap Rio stops posting findings and instead asks the author to reconsider the approach, summarizing what has not converged. After round `rounds.diff_only_after` (default 1) Rio re-reviews only the diff since the last round, with the previous findings as context. A finding identity that has been posted in a lineage is never posted again; a later head that removes the code auto-resolves it. In PR mode every thread ends in one of two ways: fixed, or dismissed with a reason from `fixed | wrong | intentional | irrelevant | style`, and those reasons are the feedback signal. finding-v1 carries `round` (the round that produced it), `first_posted_in` (the head SHA or snapshot key of the round in which it was first posted) and `author_response: { reason, actor, at, note }`. The metric `rounds_to_pass` is the round count until a lineage has no open defect.

## Data model

**D1 tables** (SQLite; migrations shipped with the Worker and applied by `rio init` / `rio deploy`):

| Table | Key columns | Notes |
| --- | --- | --- |
| `repos` | id, host, owner, name, default\_profile, settings\_json | One row per repository seen |
| `reviews` | id, repo\_id, base\_sha, head\_sha, snapshot\_key, profile\_resolved\_key, budget\_mode, status, cost\_tokens, cost\_runner\_s, created\_at, finished\_at | `status`: queued, running, partial, done, failed |
| `steps` | review\_id, step\_id, attempt, status, input\_key, output\_key, started\_at, ended\_at | Workflow bookkeeping |
| `jobs` | id, review\_id, step\_id, attempt, runner\_id, kind, status, result\_key, metrics\_json | Runner protocol |
| `hypotheses` | id, review\_id, agent, symbol, status, payload\_key | The hypothesis board (optional, deferred) |
| `findings` | id (stable identity), review\_id, rule\_id, evidence\_level, state, location\_json, payload\_key, first\_seen\_review, last\_seen\_review, round, first\_posted\_in, author\_response\_json | `state`: open, fixed, accepted, false\_positive |
| `feedback` | finding\_id, actor, verdict, reason, note, created\_at | Reasons: fixed, wrong, intentional, irrelevant, style |
| `lineages` | id, repo\_id, pr\_number or branch, heads\_json, rounds\_posted, passed\_at\_round | Review convergence per PR head lineage |
| `council_assessments` | review\_id, finding\_id, member, round, assessment\_key, abstained, vendor | One row per member and round; audit of which vendor saw which finding |
| `suppressions` | repo\_id, kind, pattern, origin (manual, proposed), approved\_by | Proposed suppressions need approval |
| `runners` | id, kind, capabilities\_json, public\_key, last\_seen | Registration and event verification |
| `tokens` | id, scope, hash, created\_at, revoked\_at | CLI and webhook auth |
| `usage` | review\_id, model, prompt\_tokens, completion\_tokens, cost\_estimate | Per-model ledger |

**R2 layout**

```text
snapshots/<blake3>.tar.zst              content-addressed source snapshots
reviews/<id>/profile.resolved.yaml       exact profile and module manifests used
reviews/<id>/steps/<step>/<attempt>/     step inputs and outputs (JSON)
reviews/<id>/graph/{base,head,delta}.json
reviews/<id>/evidence/<finding>/         reproductions, test output, traces
reviews/<id>/owner_guidance.json         REVIEW.md, CLAUDE.md, AGENTS.md as read by prepare
reviews/<id>/council/<finding>/          evidence pack, assessments per member and round, experiments, decision
reviews/<id>/council/audit.json          which content was sent to which vendor
reviews/<id>/progress/{raised,settled}/  hypotheses raised and verified so far; a stopped review reports from them
results/<job_id>/<command>/              runner uploads (stdout, reports, coverage)
indexes/<repo>/files/<content_hash>.json per-file symbol tables (full graph, v0.4)
cache/<hunk_hash>/<context_hash>.json    agent result cache
```

Retention is configurable per repo (default 90 days for evidence, indefinite for findings and feedback). Snapshots are deleted when no review references them.

## APIs

All endpoints are served by the Worker; JSON over HTTPS; bearer tokens with scopes.

**CLI → Worker**

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/snapshots` | Presigned R2 upload for a snapshot (`blake3` as key; returns 200 if already present) |
| POST | `/v1/reviews` | Submit `{repo, base_sha, head_sha, snapshot_key, profile, budget, intent_input}` → `{review_id}` |
| GET | `/v1/reviews/{id}` | Status, plan, costs, finding summary |
| GET | `/v1/reviews/{id}/events` | Server-sent events: step started/finished, finding verified, done |
| GET | `/v1/reviews/{id}/report?format=` | `terminal`, `md`, `json`, `sarif` |
| POST | `/v1/reviews/{id}/intent` | Author confirms or edits inferred behaviors (CLI mode) |
| POST | `/v1/reviews/{id}/publish` | Publish or update PR comments |
| POST | `/v1/findings/{id}/feedback` | `{verdict, reason, note}`; `reason` is one of `fixed`, `wrong`, `intentional`, `irrelevant`, `style` and is written to the finding's `author_response` |
| GET/PUT | `/v1/profiles/{name}` | Team profiles stored on the endpoint (optional; repo files take precedence) |
| GET | `/v1/version` | Endpoint version and supported CLI range |

**Git host → Worker (webhooks).** `POST /v1/hooks/github` and `/v1/hooks/gitlab`, signature-verified. Events handled: PR opened, synchronized (new commits), reopened, comment with `/rio review` or `/rio dismiss <id> <reason>`. Fork PRs are flagged and follow the restricted policy in Security.

**Runner ↔ Worker.** `POST /v1/runners/register` (one-time token → runner id + key pair), `GET /v1/runners/{id}/jobs` (long-poll, self-hosted only), `POST /v1/jobs/{id}/events` (signed completion event). Sandbox runners are driven directly by the Workflow and do not use these.

**Model gateway (internal).** One interface `complete(alias, messages, tools, budget)` with provider adapters for Anthropic, OpenAI-compatible and OpenRouter; records usage per review; enforces the review token ledger; strips repository content from logs.

Errors follow RFC 9457 problem details. Version negotiation: the CLI sends `Rio-CLI-Version`; the Worker returns `426 Upgrade Required` with the `rio deploy` or CLI upgrade instruction when outside the supported range.

## Security model

Rio executes code it does not control and generates code (reproductions) it then executes. The following are enforced by the engine and the runner protocol and cannot be relaxed by a profile.

| Threat | Control |
| --- | --- |
| Malicious code in the reviewed change escapes the runner | Fresh container or sandbox per job; no network by default; adapter-declared domains only, approved in the profile; CPU, memory and wall-time limits; results only via a short-lived R2 token scoped to `results/<job_id>/` |
| Secrets leak to the runner | Runner receives the snapshot and the upload token only; never repository secrets, model keys or Worker secrets |
| Fork PRs exfiltrate or abuse resources | Fork PRs run static-only (no test execution, no network, no agents with `run`), never publish automatically, and require a maintainer `/rio review` to escalate |
| Prompt injection via repository content | All repository text, PR descriptions, tool output and logs are passed to models as data in delimited blocks; policy comes only from the resolved profile; agents have no write tools; publishing is a separate step gated by `--publish` or `publish:` policy |
| Verifier reproductions do damage | Generated code runs under the same job isolation with no network; its output is evidence, never an instruction to other steps |
| Spoofed runner events | Runners register with a one-time token and sign events with their key; the Worker checks signature, job ownership and attempt number |
| Token theft | CLI tokens stored in the OS keychain; scoped (review, admin); revocable; webhook secrets rotated by `rio doctor --rotate` |
| Supply-chain attack through modules | Third-party modules pinned by version or SHA; manifests stored with the review; registry is a git repository with signed tags |
| Data exposure | Source code stays in the user’s account except for model calls to the configured provider; evidence and snapshots have retention limits; logs never contain repository content |
| Council sends code to several vendors | Council vendors come from a per-repo allowlist; members may run as self-hosted open-weights models through the self-hosted runner; every evidence pack sent is recorded in the council audit with vendor, member and content hashes; the step is opt-in at `rio init` |
| Owner guidance files steer the reviewer | `REVIEW.md`, `CLAUDE.md` and `AGENTS.md` are injected as data in delimited blocks; they cannot enable tools, change budgets, suppress findings or publish |

Every review stores the resolved profile, module versions, model identifiers and executed commands, so any result can be audited and reproduced.

## Observability, evaluation and testing

**Observability.** Structured logs per review and step (Workers Logs), with repository content redacted. Metrics in D1 `usage` and `jobs.metrics_json`: wall time per step, tokens per model, runner seconds, cache hit rate. `rio status` and the report footer expose cost and timing to the user. Optional, opt-in telemetry sends anonymous aggregate counters to the project; no code, no findings.

**Evaluation harness** (`eval/` in the repository):

- A reference set of historical PRs with labeled known bugs, stored as patch + expected findings; private repos can run the harness locally without contributing data.
- **Synthetic bug injection**: a mutation tool (`rio eval mutate`) applies typed mutations (off-by-one, inverted condition, dropped null check, removed authorization call, swapped transaction boundary) to clean commits and records whether the pipeline finds them. This gives repeatable recall per agent.
- **Incidents are the eval**: `rio eval import-incident <pr> <fix-pr>` turns a revert or fix-forward PR into a labeled case (the original PR as input, the fix as the expected finding location and trigger). The full set (incidents, historical PRs, mutations) is rerun on every prompt, tool or model change, and a change that lowers the score is dropped.
- **Noise measurement**: a nightly run over known-clean PRs (merged, no later revert or fix) counts findings that would lead to a harmful change; the target is zero. Per repository, the author-response ratio (share of `fixed` among responses) is computed from `author_response` and shown in the report footer.
- Metrics computed per run: precision, recall, false positives per agent and evidence level, verifier calibration (plausible → real vs. refuted), `rounds_to_pass` per lineage, author-response ratio, harmful-change rate on clean PRs, p50/p95 wall time, cost. The evaluation record carries, per finding, whether CI or a human reviewer would have caught it anyway (`counterfactual_catch: ci | human | none`).
- Council metrics (v0.3): disagreement rate between members, promotion and refutation accuracy on the `plausible` bucket versus the verifier-only baseline (A/B on the same cases), cost per council finding, and the learned per-member weights with their sample sizes.
- Regression gate in CI: a profile, prompt, tool or model change that drops precision or recall below the last release fails the build.

**Testing strategy**

| Layer | Tests |
| --- | --- |
| Rust crates | Unit tests; snapshot tests for diff/graph outputs; property tests for finding identity stability |
| Profile engine | Schema fixtures (valid and invalid); DAG and rule evaluation tests |
| Worker | Miniflare integration tests for API, webhooks, workflow stepping with mocked runners and models |
| Runner protocol | Contract tests run against every implementation (sandbox, self-hosted, Actions) |
| End-to-end | Sample repositories (TypeScript, Python, Rust) with seeded bugs, run nightly through a real deployed endpoint |

## Deployment, versioning and repository layout

**Repository layout** (monorepo, single license):

```text
rio/
  crates/           rio-cli, rio-core, rio-git, rio-profile, rio-adapters, rio-graph, rio-client, rio-runner
  worker/           Worker API, Workflows, model gateway (TypeScript, wrangler)
  modules/          built-in rio/* modules: adapters, agents, steps, base profile
  schemas/          profile-v1.json, module-v1.json, job-v1.json, finding-v1.json, report-v1.json, council-assessment-v1.json (v0.3)
  eval/             reference set tooling, mutation tool, harness
  docs/
```

**`rio init` implementation.** The wizard is in `rio-cli`; it embeds the built Worker bundle for its own version, so deploying needs no Node toolchain on the user’s machine. Steps call the Cloudflare API directly (account lookup, D1/R2/Queue creation, Worker upload with bindings, secrets). The resulting state is written to `~/.config/rio/config.toml`; secrets go to the keychain. `rio init --from config.toml` and `rio deploy` are non-interactive for CI.

**Versioning.** Semantic versions for CLI and Worker released together; the Worker exposes the supported CLI range. Profile schema versions are independent (`version: 1`) and the engine supports the previous major for one release cycle. Module versions follow semver; `rio/base` pins the module versions it was tested with.

**Upgrade path.** `rio upgrade` fetches the new CLI, then `rio deploy` applies the paired Worker and D1 migrations; migrations are forward-only and run in a Workflow with a lock in D1 so concurrent deploys cannot interleave.

**Distribution.** GitHub Releases with signed binaries (Linux, macOS, Windows), Homebrew tap, `cargo install rio-cli`; container image for the self-hosted runner.
