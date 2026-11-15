import type { Content } from "./prompt";
export type Version = "base" | "head";
export type Evidence = "refuted" | "plausible" | "static_proven" | "reproduced";
export type Category =
  "defect" | "risk" | "security" | "ux" | "style" | "diagnostic";
export type BlindMatch = "same" | "related" | "none";
export interface File {
  content: string;
  mode: number;
  encoding?: "base64";
}
export interface Snapshot {
  base: Record<string, File>;
  head: Record<string, File>;
}
export interface ChangedFile {
  path: string;
  old_path?: string;
  lines_changed?: number;
}
export interface Location {
  path: string;
  line_start: number;
  line_end: number;
  symbol_path: string;
  occurrence_state: string;
  // Instance identity inside a class-level finding.
  id?: string;
  cell?: { viewport: string; color_scheme: "light" | "dark" };
  evidence?: string[];
}
export interface Fix {
  line_start: number;
  line_end: number;
  replacement: string;
}
export interface Hypothesis {
  id: string;
  rule_id: string;
  category: Category;
  severity: "error" | "warning" | "info";
  location: Location;
  message: string;
  trigger: string;
  impact?: string;
  suggested_fix?: string;
  // Inclusive 1-based range on the primary location's file in head.
  fix?: Fix;
  state: "new" | "worsened" | "pre-existing" | "fixed" | "unclassified";
  source: { agent: string; cached?: boolean };
  guidance?: { path: string; line: number };
  evidence?: string[];
  // Agent-specific keys, folded into the finding by consolidation.
  locations?: Location[];
  catalog_item?: string;
  trace_change?: "introduced" | "removed" | "weakened";
  limitations?: string[];
}
export interface GraphNode {
  id: string;
  path: string;
  symbol_path: string;
  line_start: number;
  line_end: number;
  // Slice metadata from the Rust graph builder; absent in older submissions.
  kind?: string;
  seed?: boolean;
  hop?: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind?: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated?: boolean;
}
export interface Guidance {
  path: string;
  scope_dir: string;
  content_hash: string;
  lines: string[];
}
export interface ArtifactRef {
  kind: "execution" | "code";
  version: Version;
  job_id?: string;
  path?: string;
  node_ids?: string[];
  demonstrates: "regression" | "protection";
}
export interface VoteAnswer {
  evidence_level: Evidence;
  evidence: ArtifactRef[];
  category?: Category;
  reclassification_reason?: string;
}
export interface Vote {
  voter: number;
  status: "completed" | "failed" | "cancelled" | "exhausted" | "malformed";
  blind: Hypothesis[];
  blind_match: BlindMatch;
  answer?: VoteAnswer;
  validated_level?: Evidence;
  validation_note?: string;
  error?: string;
}
export interface Verification {
  voters: number;
  agreeing: number;
  blind_match: BlindMatch[];
  split: boolean;
}
export type ResponseReason =
  "fixed" | "wrong" | "intentional" | "irrelevant" | "style";
export interface AuthorResponse {
  reason: ResponseReason;
  actor: string;
  at: string;
  note?: string;
}
export type LifecycleStatus = "open" | "fixed" | "dismissed";
export type Finding = Hypothesis & {
  qa?: {
    journey: string;
    step: number;
    route: string;
    kind: string;
    attribution: string;
    element_paths: string[];
  };
  category: "defect" | "risk" | "security" | "ux";
  evidence_level: Evidence;
  evidence: string[];
  locations: Location[];
  verification?: Verification;
  // Lineage-only keys; absent outside lineages.
  round?: number;
  first_posted_in?: string;
  status?: LifecycleStatus;
  resolution?: { fixed_in?: string; note?: string };
  author_response?: AuthorResponse;
  // Present only when the repository registry has an earlier record.
  history?: FindingHistory;
  // Present only when the council reviewed the finding.
  council?: CouncilReview;
  trace?: SecurityTrace;
};
/** One member's answer in one round, or why it abstained. */
export interface CouncilRound {
  round: 1 | 2;
  real?: "yes" | "no" | "unknown";
  cause?: string;
  changed?: boolean;
}
/** A security finding's cited path from source to sink. */
export interface SecurityTrace {
  catalog_item: string;
  change: "introduced" | "removed" | "weakened";
  steps: {
    role: "source" | "step" | "sink";
    path: string;
    line_start: number;
    missing?: boolean;
  }[];
}
/** finding-v1 `council`: decisions and references, never a numeric confidence. */
export interface CouncilReview {
  decision?: "reproduced" | "refuted" | "plausible";
  tier?: "experiment" | "protection" | "judgment";
  members: {
    role: string;
    abstained: boolean;
    cause?: string;
    family?: string;
    rounds?: CouncilRound[];
  }[];
  experiments: {
    command: string[];
    version: "base" | "head" | "both";
    expect: "fails" | "passes" | "output_contains";
    run: boolean;
    reason?: "fork" | "cap" | "runner_unavailable";
    outcome?: { base?: "passed" | "failed"; head?: "passed" | "failed" };
    artifact?: string;
  }[];
  note?: string;
  protection?: string;
  partial: boolean;
  skipped?: boolean;
  answered: number;
  total: number;
  static_only?: boolean;
  weight_category?: "defect" | "risk" | "security";
  author_family?: {
    status: "applied" | "not_applicable";
    family?: string;
    substituted?: { role: string; vendor: string; family: string }[];
    dropped?: string[];
  };
  excluded?: { role: string; vendor: string; denied_by: string }[];
}
export interface FindingHistory {
  first_seen: string;
  last_seen: string;
  seen_count: number;
  previous_status: LifecycleStatus;
  previous_response?: AuthorResponse;
  dismissed_in?: string;
  fixed_in?: string;
}
export type UnassessedReason = "budget" | "no_evidence" | "tools_unavailable";
export interface SecurityCoverage {
  catalog: "owasp-top10-2025" | "asvs-5.0";
  assessed: { item: string; title: string; findings: string[] }[];
  unassessed: { item: string; title: string; reason: UnassessedReason }[];
  not_applicable: { item: string; title: string }[];
}
export interface LineageRef {
  repository: string;
  kind: "pr" | "branch";
  ref: string;
  reset?: boolean;
}
export interface Step {
  id: string;
  uses: string;
  needs: string[];
  parallel?: boolean;
  with: Record<string, any>;
  agents?: Record<string, any>[];
  rules?: { when: string; then?: string }[];
}
export interface Budget {
  tokens?: number;
  agents_max?: number;
  wall_time: string;
  verify_tokens?: number;
  qa?: {
    wall?: string;
    cell_wall?: string;
    tokens?: number;
    evidence_bytes?: number;
    replay_wall?: string;
  };
}
export interface FailOn {
  evidence?: Evidence;
  categories?: Category[];
  states?: string[];
  rules?: string[];
  incomplete?: boolean;
}
export interface Profile {
  version: number;
  name: string;
  models: Record<string, string>;
  steps: Step[];
  budget: { fast: Budget; deep?: Budget };
  verify: { voters: number; quorum: number; model?: string };
  posture: "critical-only" | "balanced" | "thorough";
  min_evidence: Evidence;
  max_defects: number;
  suppress: ({ path: string } | { rule: string } | { finding: string })[];
  always_human: string[];
  fail_on: FailOn;
  posture_policy: {
    defect_severity_floor: string;
    render_plausible_risks: boolean;
    plausible_risk_limit: number | null;
  };
  [key: string]: any;
}
export interface Submission {
  protocol: 1;
  snapshot_id: string;
  profile: Profile;
  report: any;
  changed: ChangedFile[];
  graphs: { base: Graph; head: Graph };
  owner_guidance: Guidance[];
  intent: string;
  fork: boolean;
  mode: "fast" | "deep";
  /** Started by the nightly evaluation job; the `nightly` rule predicate. */
  nightly?: boolean;
  lineage?: LineageRef;
  // Repository key for the finding registry; a lineage's repository wins.
  repository?: string;
}
export interface Execution {
  protocol: 1;
  review_id: string;
  job_id: string;
  attempt: number;
  version: Version;
  kind: "run" | "checks" | "graph" | "static" | "prepare" | "qa" | "model";
  command: string[];
  // Model jobs: a self-hosted council member's request, served by a runner
  // that advertises a model endpoint, so the pack stays in the account.
  model?: {
    model: string;
    system: string;
    content: string;
    max_tokens: number;
  };
  // Prepare jobs of the self-hosted runner: what to clone (no snapshot yet).
  prepare?: PrepareSpec;
  qa?: QaExecution;
  // The trees arrive as a streamed archive; jobs never embed file contents.
  snapshot_id: string;
  needs: Version[];
  context?: { profile: Profile };
  limits: {
    wall_ms: number;
    memory_mb: number;
    cpu: number;
    output_bytes: number;
    // Analysis jobs only: bound on the trusted runner's artifact, kept out of stdout.
    artifact_bytes?: number;
  };
  // "clone": a self-hosted prepare job whose clone phase alone has network.
  network: false | "clone" | "qa";
}
/** Public QA job data. Credentials are attached to a claim, never persisted in
 * the payload or streamed with repository contents into the app container. */
export interface QaExecution {
  replay?: {
    hypothesis: string;
    source_run: string;
    seed_fingerprint?: string;
    until: { journey: string; step: number };
    events: Record<string, any>[];
    artifacts: import("./qa-verifier").BrowserArtifact[];
  };
  run_id: string;
  step_id: string;
  harness: "codex" | "pi";
  harness_auth: "gateway";
  model: string;
  options: Record<string, any>;
  mode: "fast" | "deep";
  changed: ChangedFile[];
  graphs: { base: Graph; head: Graph };
  owner_guidance: Guidance[];
  // The review's layout features and, on hosted runs, the partition value of
  // the run's provider for the journey prompt (design D16).
  prompt?: { layout: string[]; partition?: string };
  budget: {
    wall_ms: number;
    cell_wall_ms: number;
    tokens: number;
    evidence_bytes: number;
    replay_wall_ms: number;
  };
  policy: {
    egress: "host_firewall_pinned" | "provider_pinned (sandbox)";
    app_isolation: "container" | "none";
  };
}
export interface ExecutionResult {
  outcome?: "exited" | "spawn_failed" | "runner_failed";
  command?: string[];
  kind?: Execution["kind"];
  job_id: string;
  attempt: number;
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  version: Version;
  artifact?: any;
  /** Where a timed-out job was: its archive on the way in, or its command. */
  phase?: "transfer" | "command";
  /**
   * Where the job's time went: the archive reaching the container (and how
   * much of that was reading storage), the executor extracting it, the command.
   */
  timing?: {
    transfer_ms?: number;
    archive_bytes?: number;
    storage_ms?: number;
    extract_ms?: number;
    command_ms?: number;
  };
}
/**
 * Whether a route's cache counts are trusted: `verified` where documentation and
 * fixtures agree that they lie inside the reported input, `unverified` elsewhere,
 * `invalid` when an unverified route reported a malformed cache field.
 */
export type UsageConvention = "verified" | "unverified" | "invalid";
export type CostSource = "provider" | "estimate" | "self-hosted" | "unknown";
export interface Usage {
  phase: string;
  actor: string;
  // Total input, cache reads and writes included.
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  model: string;
  // Null (or absent) when the provider reported no usable value.
  cache_read_input_tokens?: number | null;
  cache_write_input_tokens?: number | null;
  usage_convention?: UsageConvention | null;
  cost_source?: CostSource | null;
}
export interface ModelRequest {
  model: string;
  // Plain strings, or prompt parts whose cache breakpoints a capable route renders.
  messages: {
    role: "user" | "assistant";
    content: Content;
    images?: { data: string; media_type: "image/png"; token_bound: number }[];
  }[];
  system: Content;
  max_tokens: number;
  signal?: AbortSignal;
  // Prompt-cache hints (design D9): enabled hint classes, the OpenAI cache key,
  // and whether the last message is a conversation tail worth marking.
  // `first`: the first message is the conversation's reusable context.
  cache?: { classes: string[]; key?: string; tail?: boolean; first?: boolean };
  // The review's partition values, replaced in the reply before it is returned.
  redact?: string[];
}
export interface ModelResponse {
  content: string;
  // Total input, cache reads and writes included.
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  cache_read_input_tokens?: number | null;
  cache_write_input_tokens?: number | null;
  usage_convention?: UsageConvention | null;
  cost_source?: CostSource | null;
  // Set by `converse` for the model-call record: layer hashes and sizes of the
  // request (never its text), and a compaction checkpoint made before it.
  layers?: { layer: string; sha256: string; bytes: number }[];
  compaction?: { turn: number; elided: number };
}
export interface Gateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  REVIEWS: Workflow;
  JOBS: Queue<QueueMessage>;
  SANDBOX: DurableObjectNamespace;
  RIO_API_TOKEN: string;
  RUNNER_SECRET: string;
  RIO_VERSION: string;
  RUNNER_BACKEND: "sandbox" | "self-hosted";
  // The deployment's `limits.subrequests`, when it declares one.
  SUBREQUEST_LIMIT?: string;
  PUBLIC_URL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  // JSON: custom AI Gateway providers by slug, { "SLUG": { "protocol": "openai" | "anthropic" } }.
  AI_GATEWAY_PROVIDERS?: string;
  /** Operator-provisioned synthetic persona values; never provider credentials. */
  QA_PERSONA_CREDENTIALS?: string;
  // JSON: the council vendor allowlist written by `rio init`, a list of
  // { vendor, family, model } or an object of such lists by repository ("*" fallback).
  COUNCIL_VENDORS?: string;
  MODEL_PRICES?: string;
  // Prompt-cache hint classes and layout features (design D15).
  PROMPT_CACHE?: string;
  PROMPT_LAYOUT?: string;
  // GitHub App (PR mode); without them the webhook route returns 404.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  // Accepted beside GITHUB_WEBHOOK_SECRET while `rio doctor --rotate` runs.
  GITHUB_WEBHOOK_SECRET_NEXT?: string;
  // API root override for GitHub Enterprise and recorded tests.
  GITHUB_API_URL?: string;
}
export interface JobMessage {
  type?: "job";
  review_id: string;
  job_id: string;
  attempt: number;
}
export type Trigger = "webhook" | "cli" | "command";
/** A pull request to review, queued by the webhook, the CLI or `/rio review`. */
export interface ReviewRequestMessage {
  type: "review-request";
  tenant: string;
  installation_id: number;
  repository: string;
  number: number;
  trigger: Trigger;
  // Present when the review row already exists (CLI requests).
  review_id?: string;
  // `/rio review` from a maintainer: reset the lineage, escalate a fork.
  comment_id?: number;
}
/** A `/rio` comment; the body is data, parsed only for the two commands. */
export interface CommandMessage {
  type: "command";
  tenant: string;
  installation_id: number;
  repository: string;
  number: number;
  comment_id: number;
  body: string;
  actor: string;
}
export interface PublishMessage {
  type: "publish";
  review_id: string;
}
export type QueueMessage =
  JobMessage | ReviewRequestMessage | CommandMessage | PublishMessage;
export interface PullRequestMeta {
  repository: string;
  number: number;
  base_sha: string;
  head_sha: string;
  author: { login: string; type: "user" | "bot" };
  fork: boolean;
  agent?: { name: string; source: "bot_author" | "commit_trailer" };
  trigger: Trigger;
}
/** The hosted preparation of a PR head; the token is added at dispatch only. */
export interface PrepareSpec {
  repository: string;
  clone_url: string;
  number: number;
  base_sha: string;
  head_sha: string;
  installation_id: number;
}
