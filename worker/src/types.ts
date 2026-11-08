export type Version = "base" | "head";
export type Evidence = "refuted" | "plausible" | "static_proven" | "reproduced";
export type Category = "defect" | "risk" | "security" | "style" | "diagnostic";
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
  category: "defect" | "risk" | "security";
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
};
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
  rules?: { when: string; then: string }[];
}
export interface Budget {
  tokens?: number;
  agents_max?: number;
  wall_time: string;
  verify_tokens?: number;
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
  kind: "run" | "checks" | "graph" | "static" | "prepare";
  command: string[];
  // Prepare jobs of the self-hosted runner: what to clone (no snapshot yet).
  prepare?: PrepareSpec;
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
  network: false | "clone";
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
}
export interface Usage {
  phase: string;
  actor: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  model: string;
}
export interface ModelRequest {
  model: string;
  messages: { role: "user" | "assistant"; content: string }[];
  system: string;
  max_tokens: number;
  signal?: AbortSignal;
}
export interface ModelResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
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
  PUBLIC_URL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  // JSON: custom AI Gateway providers by slug, { "SLUG": { "protocol": "openai" | "anthropic" } }.
  AI_GATEWAY_PROVIDERS?: string;
  MODEL_PRICES?: string;
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
