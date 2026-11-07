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
  source: { agent: string };
  guidance?: { path: string; line: number };
  evidence?: string[];
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
};
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
}
export interface Execution {
  protocol: 1;
  review_id: string;
  job_id: string;
  attempt: number;
  version: Version;
  kind: "run" | "checks" | "graph" | "static";
  command: string[];
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
  network: false;
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
  JOBS: Queue<{ review_id: string; job_id: string; attempt: number }>;
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
  MODEL_PRICES?: string;
}
