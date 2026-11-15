import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  REQUESTS_EXHAUSTED,
  Requests,
  metered,
  recording,
  requestLimit,
} from "./requests";
import type {
  Env,
  ExecutionResult,
  SecurityCoverage,
  UnassessedReason,
  Graph,
  Hypothesis,
  ModelResponse,
  File,
  Snapshot,
  Submission,
  Version,
  Vote,
} from "./types";
import { Store, D1Ledger } from "./storage";
import { DEFAULT_TOKENS } from "./budget";
import { Progress } from "./progress";
import { ProviderGateway, converse, settledUsage } from "./gateway";
import { promptCacheReport, selfHostedCache } from "./usage";
import { generationPrompt, redactPartitions } from "./prompt";
/** The provider identity of self-hosted council members' partition. */
const SELF_HOSTED = "self-hosted/runner";
import {
  Partitions,
  configureReview,
  enabled,
  partitionSecret,
  promptCacheKey,
  type PromptSettings,
} from "./prompt-config";
import {
  Tools,
  dataBlock,
  promptGraph,
  filteredLines,
  guidanceBlock,
  runAllowed,
} from "./tools";
import { redact } from "./redaction";
import {
  hash,
  invariant,
  clampAgentOutput,
  screenHypotheses,
  validateHypotheses,
  type Rejection,
  validateHypothesesLenient,
} from "./validation";
import agentPrompts from "./agent-prompts.json";
import { agents } from "./manifests";
import {
  changedContents,
  frameworks,
  inventory,
  manifestPaths,
  touchedKinds,
  type ContractEntry,
} from "./contracts";
import { applicability, catalog, changeContext, traceInputs } from "./catalogs";
import { triage, type Plan } from "./triage";
import { verifyHypothesis } from "./verifier";
import {
  classId,
  consolidate,
  findingOf,
  suppressedBy,
  triggerHash,
  type Verified,
} from "./consolidate";
import {
  authorFamily,
  compose,
  councilVendors,
  routeOf,
  type CouncilSettings,
  type Member,
  type VendorEntry,
} from "./council";
import {
  runCouncil,
  type AuditEntry,
  type CallOutcome,
  type CouncilOutcome,
} from "./council-step";
import {
  expireCouncil,
  recordCouncil,
  runnerModelEndpoint,
} from "./council-audit";
import memberWeights from "./member-weights.json";
import { pullOf } from "./pulls";
import {
  createJob,
  createModelJob,
  stopRunners,
  withdrawIdle,
} from "./jobs";
import { needs, transferMs } from "./archive";
import { createQaJob } from "./qa-jobs";
import { qaReport, qaRecords, compareQaResults, qaUsage } from "./qa-results";
import { applyQaPolicy, suppressQaFindings } from "./qa-policy";
import { verifyQaReview } from "./qa-review";
import { dispatchQaReplay } from "./qa-replay";
import {
  loadRecommendationHistory,
  rememberRecommendations,
  recommendationContinuity,
} from "./qa-recommendation-history";
import { readQaEvidence } from "./qa-evidence";
import { selectRecommendations } from "./qa-recommendations";
import {
  applyHistory,
  findingHash,
  loadRecords,
  origin,
  registryStatements,
  type RegistryRecord,
} from "./history";
import { updateProposals } from "./proposals";
import { CANCELLED_UNPUBLISHED, publishReview } from "./publish";
import { announceReview, settleAnnouncement } from "./announce";
import {
  changeHunks,
  ContextMemo,
  context as cacheContext,
  expire,
  hunkHash,
  lookup,
  PACK_ENTRIES,
  slice,
  storeEntries,
  type CacheEntry,
  type Hunk,
  type Keyed,
} from "./cache";
import {
  applyLineage,
  incrementalChanges,
  loadContext,
  persistStatements,
  planReverification,
  type LineageContext,
  type Tree,
} from "./lineage";
import {
  LARGE,
  SYMLINK,
  StoredSnapshot,
  compareUtf8,
  decodeText,
  changeTexts,
  fileOf,
  holding,
  materialize,
  prefetched,
  type ChangeTexts,
  type Entry,
  textOf,
  type SnapshotReader,
  type TreeReader,
} from "./snapshot";
export interface WorkflowParams {
  review_id: string;
  snapshot_key: string;
}
/**
 * The first lines of each changed file, in both versions, for an agent's
 * prompt. A file too large to hold is named with its size and not read: the
 * excerpt is 80 lines, and the agent runs beside others in one isolate.
 */
export async function changedCode(
  changed: Submission["changed"],
  snapshot: SnapshotReader,
) {
  const previews: any[] = [];
  let remaining = 16000;
  for (const file of changed) {
    const preview: any = { path: file.path };
    for (const version of ["base", "head"] as const) {
      const path =
        version === "base" ? (file.old_path ?? file.path) : file.path;
      const entry = await snapshot[version].stat(path);
      if (!entry) {
        preview[version] = null;
        continue;
      }
      if (entry.size > LARGE) {
        preview[version] = { omitted: true, bytes: entry.size };
        continue;
      }
      const held = fileOf(entry, await snapshot[version].read(entry));
      if (held.encoding === "base64") preview[version] = { binary: true };
      else {
        const content = held.content
          .split("\n")
          .slice(0, 80)
          .join("\n")
          .slice(0, 4000);
        preview[version] = {
          line_start: 1,
          content,
          truncated: content !== held.content,
        };
      }
    }
    const size = JSON.stringify(preview).length;
    if (size > remaining) break;
    previews.push(preview);
    remaining -= size;
  }
  return previews;
}
/** Paths whose content or mode differ between two trees, by manifest hash. */
async function differing(before: TreeReader, after: TreeReader) {
  const paths: string[] = [];
  const a = before.list()[Symbol.asyncIterator](),
    b = after.list()[Symbol.asyncIterator]();
  let x = await a.next(),
    y = await b.next();
  while (!x.done || !y.done) {
    const order = x.done
      ? 1
      : y.done
        ? -1
        : compareUtf8((x.value as Entry).path, (y.value as Entry).path);
    if (order < 0) {
      paths.push(x.value.path);
      x = await a.next();
    } else if (order > 0) {
      paths.push(y.value.path);
      y = await b.next();
    } else {
      if (x.value.hash !== y.value.hash || x.value.mode !== y.value.mode)
        paths.push(x.value.path);
      x = await a.next();
      y = await b.next();
    }
  }
  return paths;
}
/** Every text file of a tree once, in path order, for textual consumers. */
async function* textFiles(tree: TreeReader): AsyncGenerator<[string, string]> {
  for await (const batch of tree.batches(
    (e) =>
      e.mode !== SYMLINK && /\.(?:[cm]?[jt]sx?|py|rs|sql|sh)$/.test(e.path),
  ))
    for (const [entry, bytes] of batch) {
      const text = bytes ? decodeText(bytes) : null;
      if (text !== null) yield [entry.path, text];
    }
}
const REASONS: UnassessedReason[] = [
  "budget",
  "no_evidence",
  "tools_unavailable",
];
/**
 * Applicable catalog items end assessed or unassessed. An item the agent did
 * not report on is unassessed with `no_evidence`; an item a hypothesis cites
 * is assessed.
 */
export function securityCoverage(
  coverage: SecurityCoverage,
  applicable: { id: string; title: string }[],
  hypotheses: Hypothesis[],
  assessed: unknown,
  unassessed: unknown,
): SecurityCoverage {
  const ids = new Set(applicable.map((i) => i.id));
  const reasons = new Map<string, UnassessedReason>();
  for (const u of Array.isArray(unassessed) ? unassessed : [])
    if (
      u &&
      typeof u === "object" &&
      ids.has(u.item) &&
      REASONS.includes(u.reason) &&
      !reasons.has(u.item)
    )
      reasons.set(u.item, u.reason);
  const done = new Set(
    (Array.isArray(assessed) ? assessed : []).filter(
      (x): x is string =>
        typeof x === "string" && ids.has(x) && !reasons.has(x),
    ),
  );
  for (const h of hypotheses)
    if (h.catalog_item && ids.has(h.catalog_item)) {
      done.add(h.catalog_item);
      reasons.delete(h.catalog_item);
    }
  for (const id of ids)
    if (!done.has(id) && !reasons.has(id)) reasons.set(id, "no_evidence");
  return {
    ...coverage,
    assessed: applicable
      .filter((i) => done.has(i.id))
      .map((i) => ({ item: i.id, title: i.title, findings: [] })),
    unassessed: applicable
      .filter((i) => reasons.has(i.id))
      .map((i) => ({ item: i.id, title: i.title, reason: reasons.get(i.id)! })),
  };
}
const SECURITY_RESULT =
  "security result must be an object with hypotheses, assessed and unassessed";
/** Whether a security agent's result carries its hypotheses and both assessment lists. */
const securityResult = (value: any): boolean =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Array.isArray(value.hypotheses) &&
  Array.isArray(value.assessed) &&
  Array.isArray(value.unassessed);
/** Dispatches of one runner job when the backend itself fails. */
const RUNNER_ATTEMPTS = 2;
/** Hunks keyed per cache lookup step. */
const CACHE_CHUNK = 250;
/**
 * The reviews a workflow may end: one still open, or the one this workflow
 * ended already (a retried step; only the workflow writes this report key).
 */
const OPEN = "(status IN ('queued','running','cancelled') OR report_key=?)";
/** The note of a review its workflow ended early because it was cancelled. */
export const CANCELLED_NOTE = "Review cancelled before it finished.";
/** Cache entries written per store step: four packs. */
const CACHE_STORE_CHUNK = 4 * PACK_ENTRIES;
export class ReviewWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  // What this run asks of the database and the bucket is counted: `this.env`
  // is the metered environment.
  private readonly requests: Requests;
  constructor(ctx: ExecutionContext, env: Env) {
    const requests = new Requests(requestLimit(env));
    super(ctx, metered(env, requests));
    this.requests = requests;
  }
  async run(event: WorkflowEvent<WorkflowParams>, durable: WorkflowStep) {
    const id = event.payload.review_id,
      store = new Store(this.env),
      requests = this.requests,
      // Every step below records the request counts with its result.
      step = recording(durable, requests);
    const load = await step.do("load", async () => {
      const row = await this.env.DB.prepare(
        "SELECT submission_key,deadline,tenant,created_at FROM reviews WHERE id=?",
      )
        .bind(id)
        .first<{
          submission_key: string;
          deadline: number;
          tenant: string;
          created_at: number;
        }>();
      invariant(row, "review not found");
      await this.env.DB.prepare(
        "UPDATE reviews SET status='running' WHERE id=? AND cancelled=0 AND status IN ('queued','running')",
      )
        .bind(id)
        .run();
      return row;
    });
    const submission = await store.get<Submission>(load.submission_key);
    // PR mode: the resolved policy is recorded, so the next push of this
    // repository is announced at once, and this review announces itself.
    if (submission.report?.review?.pull_request)
      await step.do("announce", async () => {
        await this.env.DB.prepare(
          "UPDATE pull_requests SET publish_policy=? WHERE review_id=?",
        )
          .bind(submission.profile.publish ?? "never", id)
          .run();
        await announceReview(this.env, id, submission.profile.publish);
        return true;
      });
    const snapshot = await StoredSnapshot.open(
      this.env,
      event.payload.snapshot_key,
    );
    const report = structuredClone(submission.report);
    // A change whose text exceeds the budget is analysed without its largest
    // files, and the report says so, once per consumer.
    const unread = (what: string, omitted: ChangeTexts["omitted"]) => {
      if (!omitted.files) return;
      const note = `Change text exceeds the host budget: ${what} did not read ${omitted.files} of ${submission.changed.length} changed files (${Math.ceil(omitted.bytes / 1048576)} MiB, the largest); signals in them are missing from this review.`;
      if (!report.footer.notes.includes(note)) report.footer.notes.push(note);
    };
    // Steps read files on demand. Triage reads the changed text files inside a
    // step, so a replay keeps its plan and never holds the files themselves.
    const changedText = async () => {
      const texts = await changeTexts(snapshot, submission.changed);
      const files = (contents: Record<string, string | null>) => {
        const files: Record<string, File> = {};
        for (const [path, content] of Object.entries(contents))
          if (content !== null) files[path] = { mode: 0o100644, content };
        return files;
      };
      return {
        files: { base: files(texts.base), head: files(texts.head) },
        omitted: texts.omitted,
      };
    };
    const planned = async (
      name: string,
      compute: (files: Snapshot) => Plan,
    ): Promise<Plan> => {
      // Reading may fail for a moment and is tried again. Triage itself is
      // deterministic: its error (an invalid rule) repeats on a retry.
      const done = await step.do(
        name,
        { retries: { limit: 2, delay: "5 seconds" }, timeout: "10 minutes" },
        () =>
          holding(async () => {
            const { files, omitted } = await changedText();
            let plan: Plan;
            try {
              plan = compute(files);
            } catch (error) {
              throw new NonRetryableError(
                error instanceof Error ? error.message : String(error),
              );
            }
            return {
              key: await store.put(`reviews/${id}/plans/${name}.json`, plan),
              omitted,
            };
          }),
      );
      unread("triage", done.omitted);
      return store.get<Plan>(done.key);
    };
    let plan: Plan;
    const executions: Record<string, ExecutionResult> = {},
      hypotheses: Hypothesis[] = [],
      verified: Verified[] = [];
    // Hypotheses whose verification ran to its end, with their votes that did
    // not complete, and whether the report already holds the consolidated
    // findings; the stopped path reads both.
    const settled = new Map<string, number>();
    let consolidated = false;
    const progress = new Progress(store, id);
    const ledger = new D1Ledger(this.env, id),
      gateway = new ProviderGateway(this.env);
    let graphs = submission.graphs;
    // Lineage state is read once, durably, so replays see the same round and history.
    let lineage: LineageContext | null = null;
    const trees = new Map<string, Tree>();
    const qaChanges = new Map<string, Set<string>>();
    // Head files at the prior findings' locations, for relocation.
    let head: Record<string, File> = {};
    let previousHead: SnapshotReader | undefined;
    let incremental: Submission["changed"] = [];
    let agentsVerified = false;
    let qaRuntimeIncomplete = false;
    let qaRecommendations: import("./qa-recommendations").Recommendation[] = [];
    let qaVerification:
      | {
          result: any;
          run: string;
          baseRun?: string;
          step: string;
          options: Record<string, any>;
        }
      | undefined;
    // Agent audit: why agents ran or were skipped, and screened-out hypotheses.
    const skippedAgents: Record<string, string> = {};
    const rejected: Rejection[] = [];
    const catalogOf = new Map<string, string>();
    let coverage: SecurityCoverage | undefined;
    // Agent result cache use; reported when the agents step ran.
    let cacheStats:
      | { lookups: number; hits: number; tokens_saved_estimate: number }
      | undefined;
    const triageOptions =
      submission.profile.steps.find((x) => x.uses.startsWith("rio/triage@"))
        ?.with ?? {};
    const graphHops =
      submission.profile.steps.find((x) => x.uses.startsWith("rio/graph@"))
        ?.with?.hops ?? 2;
    let diffOnlyAudit: Record<string, string[]> | undefined;
    let council: CouncilOutcome | undefined;
    // The review's prompt configuration (design D14, D15), fixed at its start.
    let promptConfig: PromptSettings = { cache: [], layout: [] };
    let partitions!: Partitions;
    const call = async (name: string, action: () => Promise<ModelResponse>) => {
      const key = await step.do(
        `model-${name}`,
        // Longer than the call itself (`MODEL_CALL_MS`) and its bookkeeping.
        { retries: { limit: 0, delay: "1 second" }, timeout: "4 minutes" },
        async () => {
          // Refused while the review can still report what it has. The
          // refusal is the step's result, so it is counted once and a later
          // run of this code meets it again.
          if (requests.exhausted) {
            requests.count(1, "stopped");
            return "";
          }
          requests.count();
          const result = await action();
          const key = `reviews/${id}/models/${name}.json`;
          await store.put(key, result);
          return key;
        },
      );
      invariant(key, REQUESTS_EXHAUSTED);
      return store.get<ModelResponse>(key);
    };
    // The snapshot tool calls of one model turn (see `converse`). The action
    // answers tool errors itself, so a failed attempt is the platform's.
    const record = (name: string, action: () => Promise<string>) =>
      step.do(
        `tools-${name}`,
        { retries: { limit: 1, delay: "2 seconds" }, timeout: "5 minutes" },
        action,
      );
    // What the request budget cost the review, for its report.
    const account = () => {
      const counts = requests.counts;
      if (report.agent_audit)
        report.agent_audit.requests = { limit: requests.limit, ...counts };
      const allowed = `its share of the ${requests.limit} requests the platform allows one review`;
      const notes: string[] = [];
      if (counts.refused)
        notes.push(
          `Request budget: ${counts.refused} tree search${counts.refused === 1 ? " was" : "es were"} not run, because the review had used ${allowed} on searching; what a search would have found is missing from this review.`,
        );
      if (counts.stopped)
        notes.push(
          `Request budget: ${counts.stopped} model turn${counts.stopped === 1 ? " was" : "s were"} not started, because the review had used ${allowed}; the agents, verifier votes and council answers they belonged to did not complete.`,
        );
      if (!notes.length) return;
      if (report.status !== "partial") report.status = "incomplete";
      report.footer.notes.push(...notes);
    };
    // A verifier conversation's prompt settings: the partition of its model,
    // its cache key root, and the layout features it follows.
    const verifierPrompt = (hypothesis: string) => {
      const alias =
        submission.profile.verify.model ??
        (submission.profile.models.verifier ? "verifier" : "default");
      const partition = partitions.for(submission.profile.models[alias]);
      return {
        partition,
        single: enabled(promptConfig, "verifier-system"),
        compaction: enabled(promptConfig, "compaction"),
        cache: {
          classes: promptConfig.cache,
          key: promptCacheKey(load.tenant, id, `verify:${hypothesis}`),
        },
      };
    };
    const execute = async (
      name: string,
      kind: "run" | "checks" | "graph" | "static",
      command: string[],
      version: Version,
      // Seconds the caller can spare; council experiments keep a reserve.
      spare?: () => Promise<number>,
    ) => {
      invariant(
        !submission.fork || kind === "static",
        "fork reviews are static-only",
      );
      // A job the backend could not run at all (container lost, sandbox failed)
      // is dispatched once more under its own job id; the command's own failures
      // are never retried. The first attempt keeps its historical id and step names.
      for (let attempt = 1; ; attempt++) {
        const job = hash(
          attempt === 1 ? `${id}-${name}` : `${id}-${name}-${attempt}`,
        ).slice(0, 32);
        // A caller with its own budget dispatches only while it has time, and
        // the job's runner limit stays within that time.
        const cap = spare
          ? await step.do(`spare-${job}`, async () => await spare())
          : undefined;
        if (cap !== undefined && cap <= 0)
          throw new Error("no wall time left for the job");
        const wall = await step.do(`dispatch-${job}`, async () =>
          createJob(
            this.env,
            id,
            job,
            kind,
            command,
            version,
            submission.snapshot_id,
            attempt,
            kind === "run" ? undefined : { profile: submission.profile },
            cap,
          ),
        );
        // The unique attempt is part of the event type and result path.
        const remaining = await step.do(`remaining-${job}`, async () => {
          const ms = spare ? await spare() : await store.remainingMs(id);
          invariant(ms > 0, "review wall budget exhausted");
          return Math.max(1, Math.ceil(ms / 1000));
        });
        // The job's own deadlines (archive transfer, command wall and the
        // extraction grace) plus queue and container start, within the
        // review's time.
        const due = Math.ceil(
          (transferMs(snapshot.index.trees, needs(kind, version)) +
            wall +
            120000) /
            1000,
        );
        let key: string | undefined;
        try {
          const completed = await step.waitForEvent<{ key?: string }>(
            `wait-${job}`,
            {
              type: `job-${job}-${attempt}`,
              timeout: `${Math.min(due, remaining)} seconds`,
            },
          );
          key = completed.payload.key;
        } catch {
          // Withdrawn so a late completion is ignored; the caller decides
          // what a missing result costs (analysis degrades, a run times out).
          await step.do(`withdraw-${job}`, async () => {
            await this.env.DB.prepare(
              "UPDATE jobs SET status='failed' WHERE id=? AND attempt=? AND status IN ('pending','leased')",
            )
              .bind(job, attempt)
              .run();
            return true;
          });
          const result: ExecutionResult = {
            outcome: "exited",
            job_id: job,
            attempt,
            version,
            exit_code: 124,
            stdout: "",
            stderr: `no runner result within ${Math.min(due, remaining)} s`,
            timed_out: true,
            truncated: false,
          };
          executions[job] = result;
          return result;
        }
        // A cancellation ends the wait with no result (see the cancel route).
        invariant(key, "cancelled");
        const result = await store.get<ExecutionResult>(key);
        invariant(
          result.job_id === job &&
            result.attempt === attempt &&
            result.version === version,
          "wrong runner completion",
        );
        if (result.outcome === "runner_failed" && attempt < RUNNER_ATTEMPTS) {
          report.footer.notes.push(
            `${name}: runner attempt ${attempt} failed (${redact(result.stderr).slice(0, 120)}); retried`,
          );
          executions[job] = result;
          continue;
        }
        executions[job] = result;
        return result;
      }
    };
    // Where a timed-out job was and how long each part took, as far as its
    // runner reported: a slow archive and a slow command need different fixes.
    const spent = (result: ExecutionResult) => {
      const t = result.timing ?? {};
      const parts = (
        [
          ["transfer", t.transfer_ms],
          ["extraction", t.extract_ms],
          ["command", t.command_ms],
        ] as const
      )
        .filter(([, ms]) => ms !== undefined)
        .map(([name, ms]) => `${name} ${Math.round(ms! / 1000)} s`);
      return (
        (result.phase
          ? ` during ${result.phase}`
          : result.timing
            ? ""
            : `: ${redact(result.stderr).slice(0, 80)}`) +
        (parts.length ? ` (${parts.join(", ")})` : "")
      );
    };
    /** Output tokens offered to a council member per call. */
    const COUNCIL_OUTPUT_TOKENS = 8192;
    // A council call reserves an upper bound: no tokenizer yields more tokens
    // than UTF-8 bytes, and the output is capped.
    const councilTokens = (request: { system: string; content: string }) =>
      new TextEncoder().encode(request.system + request.content).length +
      COUNCIL_OUTPUT_TOKENS;
    // Runner jobs of the council, deleted with its packs at retention.
    const councilJobs: string[] = [];
    const jobsOf = (name: string) =>
      Array.from({ length: RUNNER_ATTEMPTS }, (_, i) =>
        hash(i === 0 ? `${id}-${name}` : `${id}-${name}-${i + 1}`).slice(0, 32),
      );
    /**
     * A call's durable record. Model output goes to R2, never into a step
     * result, so Workflow step logs carry no repository-derived text.
     */
    type Recorded =
      | { key: string; at: number; usage: Usage; seconds?: number }
      | {
          error: "timeout" | "vendor_error" | "budget";
          at: number;
          usage?: Usage;
          seconds?: number;
        };
    type Usage = { input_tokens: number; output_tokens: number };
    const replay = async (recorded: Recorded): Promise<CallOutcome> =>
      "key" in recorded
        ? {
            response: await store.get<ModelResponse>(recorded.key),
            at: recorded.at,
            ...(recorded.seconds ? { seconds: recorded.seconds } : {}),
          }
        : recorded;
    // A self-hosted member's request runs on a runner with a model endpoint;
    // it never reaches the model gateway, so the pack stays in the account.
    const selfHosted = async (
      member: Member,
      name: string,
      request: { system: string; content: string },
      deadline: number,
    ): Promise<CallOutcome> => {
      const job = hash(`${id}-${name}`).slice(0, 32);
      councilJobs.push(job);
      // Self-hosted calls cost no vendor but still spend the review's tokens.
      const admitted = await step.do(`${name}-admit`, async () => {
        // The request budget stops a member's turn as it stops an agent's.
        if (requests.exhausted) {
          requests.count(1, "stopped");
          return { reservation: "", at: Date.now() };
        }
        try {
          return {
            reservation: await ledger.reserve(
              `council-${member.role}`,
              "council",
              councilTokens(request),
            ),
            at: Date.now(),
          };
        } catch {
          // A refusal answers at once; it does not use up the round's time.
          return { reservation: "", at: Date.now() };
        }
      });
      const { reservation } = admitted;
      if (!reservation) return { error: "budget", at: admitted.at };
      // The deadline is checked when the job is dispatched, so a replay after
      // it never dispatches; the wait is bounded by what was left then.
      const remaining = await step.do(`dispatch-${job}`, async () => {
        const left = deadline - Date.now();
        if (left <= 0) {
          await ledger.settle(reservation, {
            phase: "council",
            actor: `council-${member.role}`,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            cache_read_input_tokens: null,
            cache_write_input_tokens: null,
            usage_convention: null,
            cost_source: "self-hosted",
            model: member.model,
          });
          return 0;
        }
        await createModelJob(
          this.env,
          id,
          job,
          {
            model: member.model,
            system: request.system,
            content: request.content,
            max_tokens: COUNCIL_OUTPUT_TOKENS,
          },
          left,
        );
        return left;
      });
      if (remaining <= 0) return { error: "timeout", at: deadline };
      let key: string | undefined;
      try {
        const done = await step.waitForEvent<{ key?: string }>(`wait-${job}`, {
          type: `job-${job}-1`,
          timeout: `${Math.max(1, Math.ceil(remaining / 1000))} seconds`,
        });
        key = done.payload.key;
      } catch {
        // A timed-out call is withdrawn so no runner serves it later; the
        // runner time it may have spent is the whole wait.
        await step.do(`${name}-withdraw`, async () => {
          await this.env.DB.prepare(
            "UPDATE jobs SET status='failed' WHERE id=? AND attempt=1 AND status IN ('pending','leased')",
          )
            .bind(job)
            .run();
          return true;
        });
        return { error: "timeout", at: deadline, seconds: remaining / 1000 };
      }
      invariant(key, "cancelled");
      const recorded = await step.do(
        `${name}-result`,
        async (): Promise<Recorded> => {
          const result = await store.get<ExecutionResult>(key);
          // Lateness is the runner's completion time, not when the Workflow resumed.
          const row = await this.env.DB.prepare(
            "SELECT created_at,completed_at FROM jobs WHERE id=? AND attempt=1",
          )
            .bind(job)
            .first<{ created_at: number; completed_at: number | null }>();
          const at = row?.completed_at ?? Date.now();
          const seconds = row ? Math.max(0, at - row.created_at) / 1000 : 0;
          if (result.outcome !== "exited" || !result.artifact)
            return { error: "vendor_error", at, seconds };
          const { input_tokens, output_tokens } = result.artifact;
          const known =
            Number.isInteger(input_tokens) && Number.isInteger(output_tokens);
          // Unknown usage keeps the whole reservation, as for failed calls.
          if (known)
            await ledger.settle(reservation, {
              phase: "council",
              actor: `council-${member.role}`,
              input_tokens,
              output_tokens,
              cost_usd: 0,
              cost_source: "self-hosted",
              ...selfHostedCache(input_tokens, result.artifact.cached_input_tokens),
              model: member.model,
            });
          const usage = known
            ? { input_tokens, output_tokens }
            : { input_tokens: 0, output_tokens: 0 };
          if (at > deadline) return { error: "timeout", at, usage, seconds };
          return {
            key: await store.put(
              `reviews/${id}/council/responses/${name}.json`,
              {
                content: redactPartitions(
                  String(result.artifact.content),
                  [partitions.for(SELF_HOSTED)],
                ),
                ...usage,
                cost_usd: 0,
              },
            ),
            at,
            usage,
            seconds,
          };
        },
      );
      return replay(recorded);
    };
    /** Wall time kept for the steps after the council (report, registry, publication). */
    const COUNCIL_RESERVE_MS = 60_000;
    const spareMs = async () =>
      Math.max(0, (await store.remainingMs(id)) - COUNCIL_RESERVE_MS);
    // The council (rio-v0-3-council): never fails or blocks the review on a member.
    const councilStep = async (
      s: Submission["profile"]["steps"][number],
    ): Promise<CouncilOutcome | undefined> => {
      const settings = submission.profile.council as
        CouncilSettings | undefined;
      const members = (submission.profile.council_members ?? []) as Member[];
      if (!settings || !members.length) {
        report.footer.notes.push(
          "Council skipped: the resolved profile names no council members.",
        );
        return undefined;
      }
      const repository = lineage?.repository ?? submission.repository ?? null;
      const context = await step.do(`council-context-${s.id}`, async () => {
        let entries: VendorEntry[] = [],
          error: string | null = null;
        try {
          entries = councilVendors(this.env.COUNCIL_VENDORS, repository);
        } catch (e) {
          error = e instanceof Error ? e.message : "invalid COUNCIL_VENDORS";
        }
        const pull = await pullOf(this.env, id);
        const agent = pull?.agent_json
          ? JSON.parse(pull.agent_json)
          : undefined;
        return {
          entries,
          error,
          author: authorFamily(agent),
          runner: await runnerModelEndpoint(this.env),
        };
      });
      if (context.error)
        report.footer.notes.push(
          `Council allowlist ignored: ${context.error}.`,
        );
      const composition = compose(
        members,
        settings,
        context.entries,
        context.author,
        context.runner,
      );
      // The Worker fills placeholders itself, so it checks family diversity as
      // profile validation does: fewer than three families skip the council.
      const families = new Set(composition.participants.map((m) => m.family));
      if (composition.participants.length && families.size < 3) {
        report.footer.notes.push(
          `Council skipped: its members span ${families.size} model ${families.size === 1 ? "family" : "families"} (${[...families].sort().join(", ")}); at least three are required.`,
        );
        composition.participants = [];
      }
      const audit: AuditEntry[] = [];
      const renames = Object.fromEntries(
        submission.changed
          .filter((f) => f.old_path && f.old_path !== f.path)
          .map((f) => [f.path, f.old_path!]),
      );
      // Suppressed findings are never shown, so they are never councilled.
      const suppressed = suppressedBy(submission.profile);
      const eligible = verified.filter((v) => {
        const f = findingOf(v);
        return (
          !suppressed(f) &&
          !suppressed({ ...f, id: classId(f.rule_id, triggerHash(f.trigger)) })
        );
      });
      const votes = async (hypothesis: string) => {
        const rows = await this.env.DB.prepare(
          "SELECT object_key FROM votes WHERE review_id=? AND hypothesis_id=? ORDER BY voter",
        )
          .bind(id, hypothesis)
          .all<{ object_key: string }>();
        return Promise.all(
          rows.results.map((r) => store.get<Vote>(r.object_key)),
        );
      };
      const record = () =>
        step.do(`council-audit-${s.id}`, () =>
          recordCouncil(this.env, store, id, load.tenant, audit, councilJobs),
        );
      let outcome: CouncilOutcome;
      try {
        outcome = await runCouncil(
          {
            review: id,
            verified: eligible,
            votes,
            executions,
            graphs,
            hops: graphHops,
            // A renamed file's base is read at its old path.
            files: async (paths) => {
              const files: Record<
                string,
                { base: string | null; head: string | null }
              > = {};
              const read = prefetched(snapshot, {
                base: paths.map((path) => renames[path] ?? path),
                head: paths,
              });
              for (const path of paths)
                files[path] = {
                  base: await read("base", renames[path] ?? path),
                  head: await read("head", path),
                };
              return files;
            },
            renames,
            intent: submission.intent,
            guidance: submission.owner_guidance,
            plan,
            changed: submission.changed.map((f) => f.path),
            nightly: submission.nightly === true,
            fork: submission.fork,
            rules: (s.rules ?? []).map((r) => ({ when: r.when })),
            settings,
            members,
            composition,
            weights: memberWeights,
            audit,
            prompt: {
              partition: (member) =>
                partitions.for(
                  member.self_hosted ? SELF_HOSTED : routeOf(member),
                ),
              order: enabled(promptConfig, "council-order"),
              key: (finding, role) =>
                promptCacheKey(load.tenant, id, `council:${finding}:${role}`),
            },
          },
          {
            // Never past the review's wall budget less the reserve the
            // remaining steps need, so the verifier's results always land.
            deadline: (name, ms) =>
              step.do(`${name}-deadline`, async () =>
                Math.min(Date.now() + ms, Date.now() + (await spareMs())),
              ),
            complete: (member, name, request, deadline) =>
              member.self_hosted
                ? selfHosted(member, name, request, deadline)
                : step
                    .do(
                      `model-${name}`,
                      {
                        retries: { limit: 0, delay: "1 second" },
                        // Longer than the call itself may run.
                        timeout: `${Math.max(60, Math.ceil((deadline - Date.now()) / 1000) + 60)} seconds`,
                      },
                      async (): Promise<Recorded> => {
                        const remaining = deadline - Date.now();
                        if (remaining <= 0)
                          return { error: "timeout", at: Date.now() };
                        // A member's call is a model turn like an agent's:
                        // refused once the request budget is spent, counted
                        // when it starts.
                        if (requests.exhausted) {
                          requests.count(1, "stopped");
                          return { error: "budget", at: Date.now() };
                        }
                        requests.count();
                        let reservation: string;
                        try {
                          reservation = await ledger.reserve(
                            `council-${member.role}`,
                            "council",
                            councilTokens(request),
                          );
                        } catch {
                          return { error: "budget", at: Date.now() };
                        }
                        try {
                          const response = await gateway.complete({
                            model: routeOf(member),
                            system: request.parts?.system ?? request.system,
                            messages: [
                              {
                                role: "user",
                                content: request.parts?.content ?? request.content,
                              },
                            ],
                            max_tokens: COUNCIL_OUTPUT_TOKENS,
                            signal: AbortSignal.timeout(remaining),
                            cache: { classes: promptConfig.cache, key: request.key },
                            redact: [partitions.for(routeOf(member))],
                          });
                          await ledger.settle(reservation, {
                            phase: "council",
                            actor: `council-${member.role}`,
                            ...settledUsage(response),
                            model: routeOf(member),
                          });
                          const at = Date.now();
                          const usage = {
                            input_tokens: response.input_tokens,
                            output_tokens: response.output_tokens,
                          };
                          // A late answer is spent: its tokens count, its content does not.
                          if (at > deadline)
                            return { error: "timeout", at, usage };
                          return {
                            key: await store.put(
                              `reviews/${id}/council/responses/${name}.json`,
                              response,
                            ),
                            at,
                            usage,
                          };
                        } catch (error) {
                          // A failed call keeps its reservation: its usage is unknown.
                          // Vendor errors are logged by class, never with content.
                          console.warn(
                            `council ${member.role} ${member.vendor}: ${error instanceof Error ? error.name : "error"}`,
                          );
                          return {
                            error:
                              error instanceof Error &&
                              /abort|timeout/i.test(error.name + error.message)
                                ? "timeout"
                                : "vendor_error",
                            at: Date.now(),
                          };
                        }
                      },
                    )
                    // A step that fails outright is that member's timeout,
                    // never the council's failure.
                    .then(replay, (): CallOutcome => ({
                      error: "timeout",
                      at: deadline,
                    })),
            run: async (name, command, version) => {
              councilJobs.push(...jobsOf(name));
              const started = await step.do(`${name}-started`, async () =>
                Date.now(),
              );
              let result: ExecutionResult;
              try {
                result = await execute(name, "run", command, version, spareMs);
              } catch {
                // Out of time or lost: withdraw what was dispatched and report
                // the time spent as a runner failure.
                const ended = await step.do(`${name}-withdrawn`, async () => {
                  for (const job of jobsOf(name))
                    await this.env.DB.prepare(
                      "UPDATE jobs SET status='failed' WHERE id=? AND status IN ('pending','leased')",
                    )
                      .bind(job)
                      .run();
                  return Date.now();
                });
                return {
                  outcome: "runner_failed",
                  job_id: jobsOf(name)[0],
                  attempt: 1,
                  exit_code: 125,
                  stdout: "",
                  stderr: "experiment did not complete",
                  timed_out: true,
                  truncated: false,
                  version,
                  seconds: (ended - started) / 1000,
                };
              }
              const ended = await step.do(`${name}-ended`, async () =>
                Date.now(),
              );
              return { ...result, seconds: (ended - started) / 1000 };
            },
            put: (key, value) => store.put(key, value),
          },
        );
      } catch (error) {
        // Calls made before the failure are still audited and expire.
        await record();
        throw error;
      }
      await record();
      // Selected findings take the council's evidence level and block.
      const decided = new Map(
        outcome.verified.map((v) => [v.hypothesis.id, v]),
      );
      for (const [i, v] of verified.entries()) {
        const next = decided.get(v.hypothesis.id);
        if (next) verified[i] = next;
      }
      return outcome;
    };
    const done = new Set<string>();
    const perform = async (s: Submission["profile"]["steps"][number]) => {
      if (await store.cancelled(id)) throw new Error("cancelled");
      if (
        submission.profile.qa_standalone &&
        ![
          "rio/prepare",
          "rio/graph",
          "rio/qa",
          "rio/verify",
          "rio/report",
        ].includes(s.uses.split("@")[0])
      ) {
        report.footer.notes.push(`${s.id} skipped: standalone`);
        await step.do(`skipped-${s.id}`, () =>
          store.event(id, "step:skipped", { step: s.id, reason: "standalone" }),
        );
        return;
      }
      await step.do(`started-${s.id}`, () =>
        store.event(id, "step:started", { step: s.id }),
      );
      const module = s.uses.split("@")[0];
      if (module === "rio/triage") {
        plan = await planned(`plan-${s.id}`, (files) =>
          triage({ ...submission, report, graphs }, files),
        );
        await step.do(`budget-${s.id}`, () =>
          store.selectBudget(id, submission.profile, plan.mode),
        );
      } else if (module === "rio/qa") {
        if (s.with.enabled === true) {
          const job = hash(`${id}-${s.id}-qa-head`).slice(0, 32);
          // QA hints, the journey layout and the partition of the run's provider.
          const qaPrompt = {
            cache: promptConfig.cache,
            layout: promptConfig.layout,
            partition: partitions.for(submission.profile.models.default),
          };
          const dispatched = await step.do(`dispatch-${job}`, () =>
            createQaJob(this.env, {
              review: id,
              job,
              step: s.id,
              submission: { ...submission, graphs },
              options: s.with,
              prompt: qaPrompt,
            }),
          );
          if ("deferred" in dispatched) {
            if (dispatched.deferred === "fork")
              report.footer.notes.push("QA skipped: fork");
            else {
              report.deferred.push({ step: s.id, reason: "no_runtime" });
              report.footer.notes.push(
                "QA needs the Docker runner or explicit Sandbox opt-in.",
              );
            }
          } else {
            const completed = await step.waitForEvent<{ key?: string }>(
              `wait-${job}`,
              {
                type: `job-${job}-1`,
                timeout: `${Math.ceil(dispatched.job.limits.wall_ms / 1000) + 120} seconds`,
              },
            );
            // A cancellation ends the wait with no result.
            invariant(completed.payload.key, "cancelled");
            const result = await store.get<ExecutionResult>(
              completed.payload.key,
            );
            invariant(
              result.job_id === job &&
                result.attempt === 1 &&
                result.version === "head",
              "wrong QA runner completion",
            );
            executions[job] = result;
            invariant(
              result.exit_code === 0 && result.artifact,
              "QA runner failed; retained job output contains the failure",
            );
            let artifact = result.artifact;
            let baseRun: string | undefined;
            if (s.with.baseline && artifact.deferred !== "no_runtime") {
              const baseJob = hash(`${id}-${s.id}-qa-base`).slice(0, 32);
              let base: any;
              try {
                const dispatched = await step.do(`dispatch-${baseJob}`, () =>
                  createQaJob(this.env, {
                    review: id,
                    job: baseJob,
                    step: s.id,
                    version: "base",
                    submission: { ...submission, graphs },
                    options: s.with,
                    prompt: qaPrompt,
                  }),
                );
                invariant(
                  "job" in dispatched,
                  "QA baseline runtime unavailable",
                );
                const completed = await step.waitForEvent<{ key?: string }>(
                  `wait-${baseJob}`,
                  {
                    type: `job-${baseJob}-1`,
                    timeout: `${Math.ceil(dispatched.job.limits.wall_ms / 1000) + 120} seconds`,
                  },
                );
                invariant(completed.payload.key, "cancelled");
                const result = await store.get<ExecutionResult>(
                  completed.payload.key,
                );
                invariant(
                  result.job_id === baseJob &&
                    result.attempt === 1 &&
                    result.version === "base",
                  "wrong QA baseline completion",
                );
                executions[baseJob] = result;
                invariant(
                  result.exit_code === 0 && result.artifact,
                  "QA baseline failed",
                );
                base = result.artifact;
                baseRun = dispatched.job.qa!.run_id;
              } catch {
                // Retain head evidence, but absence on an unfinished baseline
                // is never evidence of a regression or a fix.
                base = {
                  outcome: "partial",
                  reason: "baseline_unavailable",
                  findings: [],
                  journey_outcomes: [],
                };
              }
              artifact = compareQaResults(artifact, base);
            }
            qaVerification = {
              step: s.id,
              result: artifact,
              run: dispatched.job.qa!.run_id,
              baseRun,
              options: s.with,
            };
            if (artifact.deferred === "no_runtime") {
              report.deferred.push({ step: s.id, reason: "no_runtime" });
              report.footer.notes.push(
                "QA unsupported_packaging: Sandbox supports provisioned static/vendored apps; use the Docker runner for packaging: image.",
              );
            }
            report.qa = qaReport(artifact, s.with);
            // The runner reports cells when the run ends; each becomes one event.
            await step.do(`qa-cells-${job}`, async () => {
              for (const journey of report.qa.journeys ?? [])
                for (const cell of journey.cells ?? [])
                  await store.event(id, "qa:cell", {
                    journey: journey.name,
                    viewport: cell.viewport,
                    color_scheme: cell.color_scheme,
                    step: cell.step_reached ?? 0,
                    outcome: cell.outcome,
                  });
              return true;
            });
            qaRecommendations = artifact.qa_recommendations ?? [];
            report.findings.push(...(artifact.findings ?? []));
            await step.do(`record-${job}`, async () => {
              for (const [name, value] of Object.entries(qaRecords(artifact)))
                await store.put(`reviews/${id}/qa/${name}`, value);
              return true;
            });
            if (
              artifact.outcome !== "complete" ||
              artifact.policy?.app_isolation === "none"
            ) {
              qaRuntimeIncomplete = true;
              report.status = "partial";
            }
          }
        }
      } else if (module === "rio/checks" || module === "rio/graph") {
        {
          const result = await execute(
            s.id,
            submission.fork
              ? "static"
              : module === "rio/checks"
                ? "checks"
                : "graph",
            ["rio-internal", module],
            "head",
          );
          if (result.timed_out || result.exit_code !== 0 || !result.artifact) {
            // The runner is trusted; its first stderr line names the failure.
            const reason = result.timed_out
              ? `timed out${spent(result)}`
              : (result.stderr
                  .split("\n")
                  .map((line) => line.trim())
                  .find((line) => line) ??
                (result.artifact
                  ? `exit code ${result.exit_code}`
                  : "no artifact"));
            // A missing analysis costs only that analysis: the checks are
            // reported as not run and the agents keep the CLI's graph.
            report.footer.notes.push(
              module === "rio/checks"
                ? `${s.id}: runner analysis failed (${redact(reason).slice(0, 160)}); deterministic checks did not run`
                : `${s.id}: runner analysis failed (${redact(reason).slice(0, 160)}); the review uses the submitted graph`,
            );
            if (module === "rio/checks")
              for (const kind of [
                "typecheck",
                "lint",
                "secrets",
                "coverage",
                "dependencies",
              ] as const)
                if (s.with[kind] !== false)
                  report.incomplete.push({
                    kind,
                    language: "common",
                    root: ".",
                    version: "head",
                    scheduled_as: "changed",
                    ...(result.timed_out
                      ? { outcome: "cancelled", reason: "timeout" }
                      : { outcome: "failed", reason: "tool_crashed" }),
                    wall_time_ms: 0,
                    findings: [],
                  });
            if (report.status !== "partial") report.status = "incomplete";
          } else if (module === "rio/checks") {
            const r = result.artifact.report;
            invariant(r?.schema === "rio-report-v1", "invalid runner report");
            report.checks = r.checks;
            report.findings = r.findings;
            report.risks = r.risks;
            report.incomplete = r.incomplete;
            report.impact = r.impact;
            if (r.status === "incomplete" && report.status !== "partial")
              report.status = "incomplete";
          }
          if (result.artifact?.graphs) graphs = result.artifact.graphs;
        }
      } else if (module === "rio/agents" || module === "rio/security") {
        const security = module === "rio/security";
        const selected = security
          ? s.with.enabled === true || plan.agents.includes("security")
            ? ["security"]
            : []
          : plan.agents.filter((a) => a !== "security");
        const active =
          plan.mode === "deep"
            ? (submission.profile.budget.deep ?? submission.profile.budget.fast)
            : submission.profile.budget.fast;
        const agentTokens = Math.floor(
          (active.tokens ?? DEFAULT_TOKENS) / (active.agents_max ?? 3),
        );
        // A diff-only round on an unchanged head has nothing new to review:
        // agents are not re-run and earlier findings carry forward.
        const unchanged =
          lineage?.diff_only && previousHead && incremental.length === 0;
        if (unchanged && selected.length)
          report.footer.notes.push(
            "No change since the previously reviewed head; agents were not re-run and earlier findings carry forward.",
          );
        const diffOnly = lineage?.diff_only && previousHead;
        const reviewed = diffOnly
          ? {
              changed: incremental,
              snapshot: { base: previousHead!.head, head: snapshot.head },
              focus: incremental.map((f) => f.path),
            }
          : {
              changed: submission.changed,
              snapshot,
              focus: plan.suggested_focus,
            };
        // The contract inventory and the change context are deterministic; they
        // are computed once per step and replayed from the step result.
        const analysis =
          selected.length && !unchanged
            ? await step.do(`analysis-${s.id}`, () =>
                holding(async () => {
                const contents = await changedContents(
                  reviewed.changed,
                  reviewed.snapshot,
                );
                const entries = await inventory({
                  changed: reviewed.changed,
                  contents,
                  graphs,
                  hops: graphHops,
                  read: (version, path) =>
                    textOf(reviewed.snapshot[version], path),
                  scan: (version) => textFiles(reviewed.snapshot[version]),
                });
                const manifests: [string, string][] = [];
                for (const path of manifestPaths(reviewed.changed))
                  for (const version of ["head", "base"] as const) {
                    const text = await textOf(reviewed.snapshot[version], path);
                    if (text !== null) {
                      manifests.push([path, text]);
                      break;
                    }
                  }
                const context = changeContext({
                  changed: reviewed.changed,
                  contents,
                  frameworks: frameworks(manifests, reviewed.changed),
                  node_kinds: touchedKinds(entries, reviewed.changed, contents),
                  sensitive_paths: triageOptions.sensitive_paths ?? [],
                });
                const catalogName = security
                  ? (s.with.catalog ?? "owasp-top10-2025")
                  : null;
                const items = catalogName
                  ? applicability(catalogName, context).applicable
                  : [];
                return {
                  inventory: entries,
                  context,
                  trace: catalogName
                    ? traceInputs(items, reviewed.changed, contents, graphs)
                    : null,
                  omitted: contents.omitted,
                };
              }))
            : null;
        if (analysis)
          unread(
            security ? "the security analysis" : "the contract inventory",
            analysis.omitted,
          );
        // The plan says why a contracts-capable agent did not run.
        if (!security && !unchanged)
          for (const [name, manifest] of Object.entries(agents))
            if (manifest.contracts && !selected.includes(name))
              skippedAgents[name] =
                "not selected: triage's public_contracts signal did not fire (no exported declaration, route, table, event, CLI flag or configuration key changed)";
        for (const agent of unchanged
          ? []
          : selected.slice(0, active.agents_max ?? 3)) {
          const declaration = (s.agents ?? []).find((a) =>
            Object.hasOwn(a, agent),
          );
          if (
            agent === "contracts" &&
            !analysis!.inventory.length &&
            !declaration &&
            !plan.agent_reasons[agent]?.startsWith("rule:")
          ) {
            skippedAgents[agent] =
              "contract inventory is empty: no exported symbol, route, table, event or configuration key changed";
            report.footer.notes.push(
              "Contracts agent did not run: the change touches no exported symbol, route, table, event or configuration key.",
            );
            continue;
          }
          const config = declaration?.[agent] ?? {};
          const model =
            submission.profile.models[config.model ?? agent] ??
            submission.profile.models.default;
          invariant(model, "no default model configured");
          // The agent result cache: per hunk, never for fork reviews, the
          // security step (its output is catalog coverage) or `cache: false`.
          const caching =
            module === "rio/agents" &&
            !submission.fork &&
            s.with.cache !== false;
          let keyed: Keyed[] = [],
            misses: number[] = [];
          let scope = reviewed;
          // The cache only saves model calls: a lookup that cannot finish
          // (a CPU limit repeats on every retry) runs the agent uncached.
          let found:
            { keys: Keyed[]; hits: Record<number, CacheEntry> } | undefined;
          // A cache step is retried once: an error that repeats (a platform
          // limit does) must not hold the review.
          const bounded = {
            retries: { limit: 1, delay: "5 seconds" as const },
            timeout: "5 minutes" as const,
          };
          if (caching) {
            // The files of the hunks in the order they are read, fetched a
            // window at a time; the symbols around a hunk that lie in other
            // files are read when asked for.
            const reading = (files: { path: string; old_path?: string }[]) => {
              const sorted = [...files].sort((a, b) =>
                a.path.localeCompare(b.path),
              );
              return prefetched(reviewed.snapshot, {
                base: sorted.map((f) => f.old_path ?? f.path),
                head: sorted.map((f) => f.path),
              });
            };
            try {
              // The change's hunks, then their keys and hits in chunks: each
              // chunk is its own step, so its CPU limit bounds one chunk.
              const hunksKey = await step.do(
                `cache-hunks-${s.id}-${agent}`,
                bounded,
                async () =>
                  store.put(
                    `reviews/${id}/cache/${s.id}-${agent}-hunks.json`,
                    await changeHunks(
                      reviewed.changed,
                      reading(reviewed.changed),
                    ),
                  ),
              );
              const hunks = await store.get<Hunk[]>(hunksKey);
              const all: typeof found = { keys: [], hits: {} };
              for (let start = 0; start < hunks.length; start += CACHE_CHUNK) {
                const chunk = start / CACHE_CHUNK;
                const chunkKey = await step.do(
                  `cache-lookup-${s.id}-${agent}-${chunk}`,
                  bounded,
                  async () => {
                    const keys: Keyed[] = [];
                    const memo = new ContextMemo();
                    const part = hunks.slice(start, start + CACHE_CHUNK);
                    const read = reading(part);
                    for (const hunk of part)
                      keys.push({
                        hunk,
                        hunk_hash: hunkHash(hunk),
                        ...(await cacheContext(hunk, {
                          agent,
                          layout: promptConfig.layout,
                          manifest_version: agents[agent]?.version ?? 0,
                          prompt:
                            (agentPrompts as Record<string, string>)[agent] ??
                            "",
                          model,
                          options: config,
                          engine: this.env.RIO_VERSION,
                          graphs,
                          guidance: submission.owner_guidance,
                          read,
                          base_graph: !diffOnly,
                          memo,
                        })),
                      });
                    const hits = await lookup(this.env, load.tenant, keys);
                    return store.put(
                      `reviews/${id}/cache/${s.id}-${agent}-${chunk}.json`,
                      {
                        keys: keys.map((k) => ({
                          ...k,
                          hunk: { ...k.hunk, text: "" },
                        })),
                        hits,
                      },
                    );
                  },
                );
                const part =
                  await store.get<NonNullable<typeof found>>(chunkKey);
                for (const [i, entry] of Object.entries(part.hits))
                  all.hits[start + Number(i)] = entry;
                all.keys.push(...part.keys);
              }
              found = all;
            } catch (error) {
              report.footer.notes.push(
                `Agent result cache skipped for ${agent}: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
              );
            }
          }
          if (found) {
            keyed = found.keys;
            cacheStats ??= { lookups: 0, hits: 0, tokens_saved_estimate: 0 };
            cacheStats.lookups += keyed.length;
            for (const entry of Object.values(found.hits)) {
              cacheStats.hits++;
              cacheStats.tokens_saved_estimate += entry.tokens;
              for (const h of entry.hypotheses) {
                if (hypotheses.some((x) => x.id === h.id)) continue;
                hypotheses.push({ ...h, source: { agent, cached: true } });
                if (h.catalog_item) catalogOf.set(h.id, h.catalog_item);
              }
            }
            await progress.raised(
              `${s.id}-${agent}-cached`,
              hypotheses.filter(
                (h) => h.source?.agent === agent && h.source.cached,
              ),
            );
            misses = keyed.flatMap((_, i) => (i in found.hits ? [] : [i]));
            // Every hunk was a hit: no model call for this agent.
            if (keyed.length && !misses.length) continue;
            if (misses.length < keyed.length) {
              const paths = new Set(misses.map((i) => keyed[i].hunk.path));
              scope = {
                ...reviewed,
                changed: reviewed.changed.filter((f) => paths.has(f.path)),
                focus: [...paths],
              };
            }
          }
          let serial = 0;
          const tools = new Tools(
            snapshot,
            graphs,
            runAllowed(
              agent,
              submission.fork,
              config.run ??
                (Array.isArray(config.tools)
                  ? config.tools.includes("run")
                  : undefined),
            )
              ? (cmd, v) =>
                  execute(`${s.id}-${agent}-${serial++}`, "run", cmd, v)
              : undefined,
            2,
            2000,
            Array.isArray(config.tools) ? config.tools : undefined,
          );
          const roundContext = diffOnly
            ? `\nThis is round ${lineage!.round} of a review lineage. Review ONLY the incremental change between the previously reviewed head and the new head shown below (base is the previously reviewed head); do not re-derive earlier findings, which are listed with their current states for context.\n${dataBlock(
                "previous round findings",
                lineage!.prior
                  .filter((p) => p.status !== "fixed")
                  .map((p) => ({
                    id: p.id,
                    rule_id: p.finding.rule_id,
                    category: p.finding.category,
                    message: p.finding.message,
                    location: p.finding.location,
                    status: p.status,
                    ...(p.author_response
                      ? { author_response: p.author_response.reason }
                      : {}),
                  })),
              )}`
            : "";
          const intent = diffOnly
            ? (lineage!.intent ?? submission.intent)
            : submission.intent;
          // Agent instructions are Rio's own; repository data stays in data blocks.
          let instructions =
            (agentPrompts as Record<string, string>)[agent] ?? "";
          let agentData = "";
          let catalogName: string | null = null;
          let applicable: { id: string; title: string }[] = [];
          if (agent === "contracts")
            agentData = `\n${dataBlock("contract inventory", analysis!.inventory)}`;
          if (agent === "security") {
            catalogName = s.with.catalog ?? "owasp-top10-2025";
            const split = applicability(catalogName!, analysis!.context);
            applicable = split.applicable;
            coverage = {
              catalog: catalogName as any,
              assessed: [],
              unassessed: [],
              not_applicable: split.not_applicable.map((i) => ({
                item: i.id,
                title: i.title,
              })),
            };
            if (!applicable.length) continue;
            agentData = `\n${dataBlock("catalog", {
              name: catalogName,
              attribution: catalog(catalogName!).attribution.notice,
              change: analysis!.context,
              items: split.applicable.map(({ id, title, summary, trace }) => ({
                id,
                title,
                summary,
                trace,
              })),
            })}\n${dataBlock("taint map", analysis!.trace)}`;
          }
          const partition = partitions.for(model);
          const prompt = generationPrompt({
            agent,
            instructions,
            round: roundContext,
            intent: dataBlock("intent", filteredLines(intent.split("\n"))),
            focus: dataBlock("suggested_focus", scope.focus),
            graph: dataBlock("graph excerpt", promptGraph(graphs)),
            changed: dataBlock(
              "changed code excerpts",
              await changedCode(scope.changed, reviewed.snapshot),
            ),
            checks: dataBlock("deterministic checks", report.checks),
            data: agentData,
            guidance: guidanceBlock(submission.owner_guidance, reviewed.focus),
            partition,
            order: enabled(promptConfig, "agent-order"),
          });
          await step.do(`agent-started-${s.id}-${agent}`, () =>
            store.event(id, "agent:started", { agent }),
          );
          const finished = (count: number) =>
            step.do(`agent-finished-${s.id}-${agent}`, () =>
              store.event(id, "agent:finished", { agent, hypotheses: count }),
            );
          let output: any;
          try {
            output = await converse({
              gateway,
              ledger,
              actor: `${s.id}-${agent}`,
              phase: "generation",
              model,
              allowance: { remaining: agentTokens },
              messages: [{ role: "user", content: prompt }],
              dispatch: tools.dispatch.bind(tools),
              call,
              record,
              cancelled: () => store.cancelled(id),
              cache: {
                classes: promptConfig.cache,
                key: promptCacheKey(load.tenant, id, "generation"),
              },
              redact: [partition],
              compaction: enabled(promptConfig, "compaction"),
              // A security result without its lists is asked for again, within
              // the conversation's repair limits, before the agent fails.
              ...(agent === "security"
                ? {
                    validateResult: (value: any) => {
                      invariant(securityResult(value), SECURITY_RESULT);
                      return value;
                    },
                    resultShape:
                      'The result is {"hypotheses":[...],"assessed":[...],"unassessed":[...]}: all three lists are required, and a list with no entries is [].',
                  }
                : {}),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (/cancel/.test(message)) throw error;
            const budget = /budget exhausted|turn limit exhausted/.test(
              message,
            );
            if (agent === "security") {
              // An exhausted budget or a failed conversation leaves the items
              // unassessed, never passed.
              output = {
                hypotheses: [],
                assessed: [],
                unassessed: applicable.map((i) => ({
                  item: i.id,
                  reason: budget ? "budget" : "tools_unavailable",
                })),
              };
            }
            // The request budget is the platform's, not the profile's: its
            // end is told as a failure for the security agent too.
            if (
              agent !== "security" ||
              !budget ||
              message.includes(REQUESTS_EXHAUSTED)
            ) {
              // One agent's failure ends only that agent; the others' work and
              // the deterministic results stay in a partial report.
              report.status = "partial";
              report.footer.notes.push(
                `${agent} agent failed: ${redact(message).slice(0, 200)}; its findings are missing from this review.`,
              );
              if (agent !== "security") {
                await finished(0);
                continue;
              }
            }
          }
          // Generation agents sometimes wrap their array the way the security
          // agent must ({"hypotheses": [...]}); the wrapper is accepted.
          if (
            agent !== "security" &&
            output &&
            typeof output === "object" &&
            !Array.isArray(output) &&
            Array.isArray(output.hypotheses)
          )
            output = output.hypotheses;
          // A result of the wrong shape fails this agent only, like a failed
          // conversation: the review stays partial with a note and the other
          // agents' hypotheses still reach the verifier.
          const shaped =
            agent === "security"
              ? securityResult(output)
              : Array.isArray(output);
          if (!shaped) {
            report.status = "partial";
            report.footer.notes.push(
              `${agent} agent failed: ${agent === "security" ? SECURITY_RESULT : "expected hypothesis array"}; its findings are missing from this review.`,
            );
            if (agent !== "security") {
              await finished(0);
              continue;
            }
            output = {
              hypotheses: [],
              assessed: [],
              unassessed: applicable.map((i) => ({
                item: i.id,
                reason: "tools_unavailable",
              })),
            };
          }
          let assessedByAgent: unknown = [],
            unassessedByAgent: unknown = [];
          if (agent === "security") {
            assessedByAgent = output.assessed;
            unassessedByAgent = output.unassessed;
            output = output.hypotheses;
          }
          const checked = validateHypothesesLenient(
            agent,
            clampAgentOutput(output),
          );
          rejected.push(...checked.rejected);
          const screened = screenHypotheses(agent, checked.accepted, {
            catalogItems: new Set(applicable.map((i) => i.id)),
          });
          rejected.push(...screened.rejected);
          for (const h of screened.accepted) {
            h.source = { agent };
            if (!hypotheses.some((x) => x.id === h.id)) hypotheses.push(h);
            if (h.catalog_item) catalogOf.set(h.id, h.catalog_item);
          }
          await progress.raised(`${s.id}-${agent}`, screened.accepted);
          await finished(screened.accepted.length);
          // Only a run that completed within budget populates the cache. The
          // entries are written a chunk per step, each a few packs, so no step
          // nears the platform's request limit however large the change; the
          // cache only saves later model calls, so a store that fails leaves
          // the review as it is and says so.
          if (caching && misses.length) {
            const entries = [...slice(keyed, misses, screened.accepted)];
            try {
              const tokens = await step.do(
                `cache-tokens-${s.id}-${agent}`,
                bounded,
                async () =>
                  (
                    await this.env.DB.prepare(
                      "SELECT COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens FROM usage WHERE review_id=? AND actor=?",
                    )
                      .bind(id, `${s.id}-${agent}`)
                      .first<{ tokens: number }>()
                  )?.tokens ?? 0,
              );
              const share = Math.floor(tokens / misses.length);
              for (
                let start = 0;
                start < entries.length;
                start += CACHE_STORE_CHUNK
              )
                await step.do(
                  `cache-store-${s.id}-${agent}-${start / CACHE_STORE_CHUNK}`,
                  bounded,
                  () =>
                    storeEntries(
                      this.env,
                      load.tenant,
                      agent,
                      keyed,
                      entries.slice(start, start + CACHE_STORE_CHUNK),
                      share,
                    ),
                );
            } catch (error) {
              report.footer.notes.push(
                `Agent result cache not updated for ${agent}: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
              );
            }
          }
          if (agent === "security")
            coverage = securityCoverage(
              coverage!,
              applicable,
              screened.accepted,
              assessedByAgent,
              unassessedByAgent,
            );
          if (agent === "contracts") {
            const unresolved = analysis!.inventory.filter(
              (e: ContractEntry) => e.unresolved.length,
            ).length;
            if (unresolved)
              report.footer.notes.push(
                `${unresolved} contract(s) have consumers the graph could not resolve; the contracts agent lists them as limitations.`,
              );
          }
        }
        if (module === "rio/agents")
          cacheStats ??= { lookups: 0, hits: 0, tokens_saved_estimate: 0 };
      } else if (module === "rio/verify") {
        const active =
          plan.mode === "deep"
            ? (submission.profile.budget.deep ?? submission.profile.budget.fast)
            : submission.profile.budget.fast;
        if (qaVerification) {
          const qa = qaVerification;
          const result = await verifyQaReview({
            result: qa.result,
            prompt: {
              partition: verifierPrompt("qa").partition,
              cache: {
                classes: promptConfig.cache,
                key: promptCacheKey(load.tenant, id, "verify:qa"),
              },
            },
            profile: submission.profile,
            gateway,
            ledger,
            call,
            cancelled: () => store.cancelled(id),
            snapshot,
            verifyTokens: active.verify_tokens,
            context: {
              snapshot: { head: {} },
              head: graphs.head,
              base: graphs.base,
              executions,
              guidance: submission.owner_guidance,
            },
            tools: () => new Tools(snapshot, graphs, undefined),
            replay: async (candidate, version) => {
              const sourceRun = version === "base" ? qa.baseRun : qa.run;
              invariant(
                sourceRun &&
                  !(await store.cancelled(id)) &&
                  (await ledger.remaining()) > 0,
                "QA replay budget unavailable",
              );
              const replay = await dispatchQaReplay({
                env: this.env,
                step,
                review: id,
                tenant: load.tenant,
                qaStep: qa.step,
                submission: { ...submission, graphs },
                options: qa.options,
                candidate,
                version,
                sourceRun,
                original: version === "base" ? qa.result.baseline : qa.result,
              });
              const artifacts = report.qa.evidence.artifacts;
              if (
                Number.isSafeInteger(replay.bytes) &&
                Number(replay.bytes) > 0
              )
                report.qa.evidence.bytes += Number(replay.bytes);
              if (
                Number.isSafeInteger(replay.wall_time_ms) &&
                Number(replay.wall_time_ms) > 0
              )
                report.qa.cost.wall_time_ms += Number(replay.wall_time_ms);
              for (const artifact of replay.artifacts ?? [])
                if (!artifacts.some((row: any) => row.id === artifact.id))
                  artifacts.push({ id: artifact.id, kind: artifact.kind });
              return replay;
            },
            load: (artifact, version = "head") => {
              const run = version === "base" ? qa.baseRun : qa.run;
              return run
                ? readQaEvidence(this.env, load.tenant, id, run, artifact)
                : Promise.resolve(null);
            },
            save: (key, value) => store.put(`reviews/${id}/qa/${key}`, value),
          });
          report.findings.push(...result.findings);
          qaRecommendations = result.recommendations;
          report.qa.observations_unverified = result.observations.map(
            (row: any) => {
              const {
                rule_id,
                kind,
                journey,
                step,
                cell,
                route,
                expected,
                observed,
                evidence,
                suggested_fix,
              } = row;
              return {
                rule_id,
                kind,
                journey,
                step,
                cell,
                route,
                expected,
                observed,
                evidence,
                ...(suggested_fix ? { suggested_fix } : {}),
              };
            },
          );
          const selected = selectRecommendations(result.recommendations, {
            max: qa.options.max_recommendations ?? 5,
          });
          report.qa.recommendations = selected.recommendations;
          report.qa.recommendations_held_back = selected.held_back;
          qaRuntimeIncomplete ||= result.incomplete;
          if (result.incomplete) {
            report.status = "partial";
            report.footer.notes.push(
              "Some QA observations could not be independently verified; inspect qa/verification.json. Missing votes do not reduce quorum.",
            );
          }
          qaVerification = undefined;
        }
        let candidates = hypotheses;
        if (lineage?.diff_only) {
          const reverify = planReverification(
            hypotheses,
            lineage,
            trees,
            head,
            graphs.head,
            new Set(incremental.map((f) => f.path)),
          );
          candidates = reverify.verify;
          verified.push(...reverify.carried);
          for (const v of reverify.carried) {
            settled.set(v.hypothesis.id, 0);
            await progress.settled({ verified: v, incomplete: 0 });
          }
          diffOnlyAudit = {
            reverified: reverify.verify.map((h) => h.id),
            carried: reverify.carried.map((v) => v.hypothesis.id),
            not_reverified: reverify.skipped,
          };
        }
        for (const [index, h] of candidates.entries()) {
          const key = `reviews/${id}/hypotheses/${h.id}.json`;
          await store.put(key, h);
          await this.env.DB.prepare(
            "INSERT INTO hypotheses(review_id,id,object_key) VALUES(?,?,?) ON CONFLICT DO NOTHING",
          )
            .bind(id, h.id, key)
            .run();
          const counters = new Map<number, number>();
          const result = await verifyHypothesis({
            profile: submission.profile,
            hypothesis: h,
            intent: submission.intent,
            guidance: submission.owner_guidance,
            snapshot,
            context: {
              snapshot: { head: {} },
              head: graphs.head,
              base: graphs.base,
              executions,
              guidance: submission.owner_guidance,
            },
            gateway,
            ledger,
            verifyTokens: active.verify_tokens,
            call,
            record,
            cancelled: () => store.cancelled(id),
            prompt: verifierPrompt(h.id),
            tools: (voter) =>
              new Tools(
                snapshot,
                graphs,
                runAllowed("verifier", submission.fork, s.with.run)
                  ? (cmd, v) => {
                      const n = counters.get(voter) ?? 0;
                      counters.set(voter, n + 1);
                      return execute(
                        `verify-${h.id}-${voter}-${n}`,
                        "run",
                        cmd,
                        v,
                      );
                    }
                  : undefined,
              ),
            save: async (vote: Vote) => {
              const key = `reviews/${id}/votes/${h.id}/${vote.voter}.json`;
              await store.put(key, vote);
              await this.env.DB.prepare(
                "INSERT INTO votes(review_id,hypothesis_id,voter,object_key,status) VALUES(?,?,?,?,?) ON CONFLICT(review_id,hypothesis_id,voter) DO UPDATE SET status=excluded.status",
              )
                .bind(id, h.id, vote.voter, key, vote.status)
                .run();
            },
          });
          verified.push(result.verified);
          // Votes missing once the review has stopped were cut short by the stop.
          const missing = result.votes.filter(
            (v) => v.status !== "completed",
          ).length;
          if (!missing || !(await store.cancelled(id))) {
            settled.set(h.id, missing);
            await progress.settled({
              verified: result.verified,
              incomplete: missing,
            });
          }
          await step.do(`verified-${h.id}`, () =>
            store.event(id, "finding:verified", {
              id: h.id,
              ...result.verified.verification,
              evidence_level: result.verified.evidence_level,
            }),
          );
          await step.do(`verify-progress-${s.id}-${h.id}`, () =>
            store.event(id, "verify:progress", {
              done: index + 1,
              total: candidates.length,
            }),
          );
        }
      }
      if (module === "rio/council" && s.with.enabled === true)
        try {
          council = await councilStep(s);
        } catch (error) {
          // The council never fails a review: verified findings stand.
          report.footer.notes.push(
            `Council did not complete (${redact(error instanceof Error ? error.message : "error").slice(0, 160)}); verifier results stand.`,
          );
        }
      await step.do(`finished-${s.id}`, () =>
        store.event(id, "step:finished", { step: s.id }),
      );
    };
    // Consolidates verified hypotheses into a report: the findings lists, the
    // agent audit and the security coverage. A stop never turns a hypothesis
    // into a finding: one whose verification was cut short, or never began, is
    // listed in the audit as raised but unverified.
    const present = (target: typeof report, stopped = false) => {
      const list = verified.filter((v) => settled.has(v.hypothesis.id));
      const findings = consolidate(list, submission.profile, {
        classThreshold: submission.profile.steps.find((s) =>
          s.uses.startsWith("rio/report@"),
        )?.with?.class_threshold,
      });
      target.findings.push(...findings.defects);
      target.risks.push(...findings.risks);
      if (council) {
        target.council = {
          ...council.metrics,
          ...(findings.council_held.length
            ? { held: findings.council_held }
            : {}),
          ...(council.refuted.length
            ? {
                refuted: list
                  .filter((v) => council!.refuted.includes(v.hypothesis.id))
                  .map((v) => findingOf(v)),
              }
            : {}),
        };
      }
      if (findings.security.length) target.security = findings.security;
      target.agent_audit = {
        ...findings.audit,
        ...(council
          ? {
              council: {
                selected: council.selection,
                not_councilled: council.metrics.not_councilled,
              },
            }
          : {}),
        require_human: plan.require_human,
        board_deferred: true,
        agents: plan.agent_reasons,
        ...(Object.keys(skippedAgents).length
          ? { agents_skipped: skippedAgents }
          : {}),
        ...(rejected.length ? { rejected } : {}),
      };
      if (coverage) {
        // Assessed items name the reported findings that cite them.
        for (const f of target.security ?? []) {
          const members = findings.audit.classes[f.id] ?? [f.id];
          for (const member of members) {
            const item = catalogOf.get(member);
            const entry = coverage.assessed.find((a) => a.item === item);
            if (entry && !entry.findings.includes(f.id))
              entry.findings.push(f.id);
          }
        }
        target.security_coverage = coverage;
      }
      target.risk_tier = plan.risk;
      if (stopped || list.length < verified.length) {
        const skipped = new Set(diffOnlyAudit?.not_reverified ?? []);
        const unverified = hypotheses.filter(
          (h) => !settled.has(h.id) && !skipped.has(h.id),
        );
        if (unverified.length)
          target.agent_audit.unverified = unverified.map((h) => ({
            id: h.id,
            agent: h.source?.agent,
            rule_id: h.rule_id,
            category: h.category,
            severity: h.severity,
            location: h.location,
            message: h.message,
          }));
        target.footer.notes.push(
          `The review stopped before it finished: ${settled.size} of ${settled.size + unverified.length} raised hypotheses had completed verification and are consolidated here; ${unverified.length} had not and are listed in agent_audit.unverified, not as findings.`,
        );
      }
      return findings;
    };
    try {
      // Memoized, so a replay after a restart or a variable change rebuilds the
      // same requests. An unknown value fails here, before any reservation.
      promptConfig = await step.do(
        "prompt-config",
        { retries: { limit: 0, delay: "1 second" } },
        () => configureReview(this.env, load.tenant),
      );
      partitions = new Partitions(
        this.env,
        await partitionSecret(this.env, load.tenant),
      );
      const lineageKey = await step.do("lineage", async () => {
        const context = await loadContext(this.env, id, submission.profile);
        return context
          ? store.put(`reviews/${id}/lineage-context.json`, context)
          : null;
      });
      if (lineageKey) {
        lineage = await store.get<LineageContext>(lineageKey);
        // Only the files at prior finding locations are read from earlier heads.
        const wanted = new Map<string, { key: string; paths: Set<string> }>();
        for (const p of lineage.prior)
          if (p.snapshot_key) {
            const w = wanted.get(p.snapshot_id) ?? {
              key: p.snapshot_key,
              paths: new Set<string>(),
            };
            w.paths.add(p.finding.location.path);
            wanted.set(p.snapshot_id, w);
          }
        for (const [snapshotId, w] of wanted) {
          const priorSnapshot = await StoredSnapshot.open(this.env, w.key);
          trees.set(snapshotId, await materialize(priorSnapshot.head, w.paths));
          if (
            lineage.prior.some(
              (p) =>
                p.snapshot_id === snapshotId &&
                p.finding.qa?.attribution === "journey",
            )
          )
            qaChanges.set(
              snapshotId,
              new Set(await differing(priorSnapshot.head, snapshot.head)),
            );
        }
        head = await materialize(
          snapshot.head,
          lineage.prior.map((p) => p.finding.location.path),
        );
        if (
          lineage.diff_only &&
          lineage.previous_head &&
          lineage.previous_head_key
        ) {
          previousHead = await StoredSnapshot.open(
            this.env,
            lineage.previous_head_key,
          );
          const paths = await differing(previousHead.head, snapshot.head);
          incremental = incrementalChanges(
            await materialize(previousHead.head, paths),
            await materialize(snapshot.head, paths),
          );
        }
      }
      plan = await planned("plan-initial", (files) =>
        triage(submission, files),
      );
      await step.do("budget-initial", () =>
        store.selectBudget(id, submission.profile, plan.mode),
      );
      const pending = new Map(submission.profile.steps.map((s) => [s.id, s]));
      while (pending.size) {
        const ready = [...pending.values()]
          .filter((s) => s.needs.every((n) => done.has(n)))
          .slice(0, 4);
        invariant(ready.length, "invalid profile DAG");
        // Parallelize only steps explicitly marked parallel, preserving profile order otherwise.
        const batch = ready[0].parallel
          ? ready.filter((s) => s.parallel)
          : [ready[0]];
        await Promise.all(batch.map(perform));
        for (const s of batch) {
          done.add(s.id);
          pending.delete(s.id);
        }
      }
      const findings = present(report);
      consolidated = true;
      report.footer.notes = report.footer.notes.filter(
        (n: string) =>
          !n.includes("no_endpoint") && !n.startsWith("posture, max_defects"),
      );
      report.summary.suppressed += findings.audit.suppressed;
      report.footer.notes.push(
        "Hypothesis board coordination is deferred; agents and verifier voters run independently.",
      );
      if (submission.fork)
        report.footer.notes.push(
          "Fork PR: static-only; all agent and verifier execution tools are disabled.",
        );
      const usages = await this.env.DB.prepare(
        "SELECT phase,status,input_tokens,output_tokens,cost_usd,cache_read_tokens,cache_write_tokens,usage_convention,cost_source FROM usage WHERE review_id=?",
      )
        .bind(id)
        .all<any>();
      if (report.qa) Object.assign(report.qa.cost, await qaUsage(this.env, id));
      report.agent_audit.prompt_cache = promptCacheReport(usages.results, {
        hint_classes: promptConfig.cache,
        layout_features: promptConfig.layout,
      });
      report.agent_audit.verification_usage = {
        input_tokens: usages.results
          .filter((u) => u.phase.startsWith("verify"))
          .reduce((n, u) => n + (u.input_tokens ?? 0), 0),
        output_tokens: usages.results
          .filter((u) => u.phase.startsWith("verify"))
          .reduce((n, u) => n + (u.output_tokens ?? 0), 0),
        cost_usd: usages.results.some(
          (u) => u.phase.startsWith("verify") && u.cost_usd === null,
        )
          ? null
          : usages.results
              .filter((u) => u.phase.startsWith("verify"))
              .reduce((n, u) => n + (u.cost_usd ?? 0), 0),
      };
      const failed = await this.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM votes WHERE review_id=? AND status!='completed'",
      )
        .bind(id)
        .first<{ count: number }>();
      if (failed?.count) {
        report.agent_audit.incomplete_votes = failed.count;
        report.status = "incomplete";
        report.footer.notes.push(
          `${failed.count} verifier votes did not complete; inspect the vote audit. Missing votes do not reduce quorum.`,
        );
      }
      report.deferred = report.deferred.filter(
        (entry: any) => entry.reason === "no_runtime",
      );
      report.review.rio_version = this.env.RIO_VERSION;
      account();
      if (await store.cancelled(id)) report.status = "partial";
      if (diffOnlyAudit) report.agent_audit.diff_only = diffOnlyAudit;
      if (cacheStats)
        report.cache = {
          ...cacheStats,
          hit_rate: cacheStats.lookups
            ? cacheStats.hits / cacheStats.lookups
            : null,
        };
      // The repository registry: remembered dismissals after the profile's
      // suppressions, history on recurrences, and suppression proposals.
      suppressQaFindings(report, submission.profile.suppress);
      const repository = lineage?.repository ?? submission.repository ?? null;
      let records: RegistryRecord[] = [];
      let hashes: Record<string, string | null> = {};
      if (repository) {
        const historyKey = await step.do("history", async () => {
          const produced: any[] = [
            ...report.findings,
            ...report.risks,
            ...(report.security ?? []),
          ];
          const files = await materialize(
            snapshot.head,
            produced.flatMap((f) => [
              f.location.path,
              ...f.locations.map((l: any) => l.path),
            ]),
          );
          const text = (path: string) =>
            files[path] && !files[path].encoding ? files[path].content : null;
          return store.put(`reviews/${id}/history.json`, {
            records: await loadRecords(
              this.env,
              load.tenant,
              repository,
              produced.map((f) => f.id),
            ),
            hashes: Object.fromEntries(
              produced.map((f) => [f.id, findingHash(f, graphs.head, text)]),
            ),
          });
        });
        ({ records, hashes } = await store.get<{
          records: RegistryRecord[];
          hashes: Record<string, string | null>;
        }>(historyKey));
        applyHistory(
          report,
          records,
          new Map(Object.entries(hashes)),
          new Set(
            (lineage?.prior ?? [])
              .filter((p) => p.author_response)
              .map((p) => p.id),
          ),
        );
        const threshold =
          submission.profile.steps.find((s) => s.uses.startsWith("rio/report@"))
            ?.with?.proposal_threshold ?? 3;
        const proposals = await step.do("proposals", () =>
          updateProposals(this.env, load.tenant, repository, threshold),
        );
        if (proposals.length) report.suppression_proposals = proposals;
      } else
        report.footer.notes.push(
          "Finding history was not consulted: the submission names no repository.",
        );
      const qaOptions = submission.profile.steps.find(
        (s) => s.uses.startsWith("rio/qa@") && s.with.enabled === true,
      )?.with;
      if (report.qa && qaOptions) {
        const continuityKey = await step.do(
          "qa-recommendation-history",
          async () => {
            // Store the entire pool before capping it. Dismissal may arrive while
            // voting runs, and must be honored on this and subsequent reviews.
            const history = repository
              ? await loadRecommendationHistory(
                  this.env,
                  load.tenant,
                  repository,
                )
              : [];
            if (repository)
              await rememberRecommendations(
                this.env,
                load.tenant,
                repository,
                id,
                load.created_at,
                qaRecommendations,
              );
            return store.put(
              `reviews/${id}/qa/recommendation-history.json`,
              recommendationContinuity(qaRecommendations, history),
            );
          },
        );
        const continuity =
          await store.get<ReturnType<typeof recommendationContinuity>>(
            continuityKey,
          );
        const selected = selectRecommendations(continuity.candidates, {
          max: qaOptions.max_recommendations ?? 5,
        });
        report.qa.recommendations = selected.recommendations;
        report.qa.recommendations_held_back = selected.held_back;
      }
      if (qaOptions) {
        applyQaPolicy(report, qaOptions, qaRuntimeIncomplete);
        if (report.agent_audit?.qa)
          await step.do("qa-policy-record", () =>
            store.put(`reviews/${id}/qa/policy.json`, report.agent_audit.qa),
          );
      }
      agentsVerified =
        !failed?.count &&
        submission.profile.steps.some(
          (s) => s.uses.startsWith("rio/verify@") && done.has(s.id),
        );
      const outcome = lineage
        ? applyLineage(report, lineage, {
            head,
            trees,
            graph: graphs.head,
            agents_reassessed: agentsVerified,
            qa_changes: qaChanges,
            qa_journeys: Object.fromEntries(
              (qaVerification?.result.journey_outcomes ?? [])
                .filter((row: any) => row.verification_context?.journey)
                .map((row: any) => [
                  row.journey,
                  row.verification_context.journey,
                ]),
            ),
            changed: submission.changed,
            max_lines: submission.profile.max_lines,
          })
        : null;
      // A PR review is run under the profile at its merge base, which the CLI
      // does not have; it reads the fail policy for its exit code from here.
      if (report.review?.pull_request)
        report.agent_audit.fail_on = submission.profile.fail_on;
      // PR mode: publication under the resolved profile's policy (pr-publishing).
      const publication = await step.do("publish", () =>
        publishReview(this.env, {
          review: id,
          report,
          policy: submission.profile.publish,
          fail_on: submission.profile.fail_on,
          lineage: lineage
            ? { id: lineage.id, snapshot_id: lineage.snapshot_id }
            : null,
          updates: outcome?.updates ?? [],
          prior: (lineage?.prior ?? []).map((p) => ({
            id: p.id,
            finding: p.finding,
          })),
        }),
      );
      if (publication) report.publication = publication;
      const key = await store.put(`reviews/${id}/report.json`, report);
      // The registry is written in its own durable step, so a later failure
      // never replays it; its statements are idempotent per review anyway.
      await step.do("registry", async () => {
        if (repository) {
          const groups = registryStatements(
            this.env,
            load.tenant,
            repository,
            id,
            load.created_at,
            origin(lineage, id),
            [
              ...report.findings,
              ...report.risks,
              ...(report.security ?? []),
              ...(report.remembered ?? []),
            ].map((finding: any) => ({
              finding,
              code_hash: hashes[finding.id] ?? null,
            })),
            records,
            (outcome?.updates ?? [])
              .filter((u) => u.status === "fixed")
              .map((u) => u.id),
          );
          // An identity's statements always share one batch.
          for (let i = 0; i < groups.length; i += 25)
            await this.env.DB.batch(groups.slice(i, i + 25).flat());
        }
        await expire(this.env, load.tenant);
        await expireCouncil(this.env, load.tenant);
        return true;
      });
      await step.do("finish", async () => {
        // A review the endpoint already ended (overdue, or cancelled and not
        // stopped in time) keeps that end: a late result never replaces it,
        // and a cancelled review never reads complete.
        const ended = await this.env.DB.prepare(
          `UPDATE reviews SET status=CASE WHEN cancelled=1 THEN 'partial' ELSE ? END,report_key=? WHERE id=? AND ${OPEN} RETURNING status`,
        )
          .bind(
            report.status === "partial" ? "partial" : "complete",
            key,
            id,
            key,
          )
          .first<{ status: string }>();
        if (!ended) return;
        // Cancelled after the report was written: the report says what the
        // review's status does.
        if (ended.status === "partial" && report.status !== "partial") {
          // Stored before the report held here says so: an attempt of this
          // step that follows a failed write must find it still to write.
          const notes = [...report.footer.notes, CANCELLED_NOTE];
          await store.put(key, {
            ...report,
            status: "partial",
            footer: { ...report.footer, notes },
          });
          report.status = "partial";
          report.footer.notes = notes;
        }
        await stopRunners(this.env, id);
        await withdrawIdle(this.env, id);
        if (lineage && outcome)
          await this.env.DB.batch(
            persistStatements(
              this.env,
              lineage,
              outcome,
              id,
              submission.intent,
            ),
          );
        await store.event(
          id,
          ended.status === "partial" ? "review:partial" : "review:done",
          { report },
        );
      });
      return { report_key: key };
    } catch (error) {
      report.status = "partial";
      // A non-retryable step error carries its class name in the message.
      const reason =
        error instanceof Error
          ? error.message.replace(/^NonRetryableError: /, "")
          : "review failed";
      report.footer.notes.push(
        reason === "cancelled" ? CANCELLED_NOTE : reason,
      );
      // Work finished before the stop is still reported, consolidated as on the
      // complete path. A replayed run has it in storage only.
      if (!consolidated)
        try {
          const stored = await progress.load();
          for (const h of stored.raised)
            if (!hypotheses.some((x) => x.id === h.id)) hypotheses.push(h);
          for (const entry of stored.settled) {
            const at = verified.findIndex(
              (v) => v.hypothesis.id === entry.verified.hypothesis.id,
            );
            if (at !== -1 && settled.has(entry.verified.hypothesis.id)) continue;
            if (at === -1) verified.push(entry.verified);
            else verified[at] = entry.verified;
            settled.set(entry.verified.hypothesis.id, entry.incomplete);
          }
        } catch {
          // Report from memory alone.
        }
      if (!consolidated && hypotheses.length + verified.length)
        try {
          const draft = structuredClone(report);
          const findings = present(draft, true);
          draft.summary.suppressed += findings.audit.suppressed;
          if (diffOnlyAudit) draft.agent_audit.diff_only = diffOnlyAudit;
          const incomplete = [...settled.values()].reduce((n, v) => n + v, 0);
          if (incomplete) {
            draft.agent_audit.incomplete_votes = incomplete;
            draft.footer.notes.push(
              `${incomplete} verifier votes did not complete; inspect the vote audit. Missing votes do not reduce quorum.`,
            );
          }
          Object.assign(report, draft);
        } catch {
          // Keep the partial report without the agents' results.
        }
      // A failed review is stamped for display but does not advance lineage state.
      if (lineage)
        try {
          applyLineage(report, lineage, {
            head,
            trees,
            graph: graphs.head,
            agents_reassessed: false,
            changed: submission.changed,
            max_lines: submission.profile.max_lines,
          });
        } catch {
          // Keep the partial report without lineage keys.
        }
      account();
      const key = await store.put(`reviews/${id}/report.json`, report);
      await step.do("failed", async () => {
        const ended = await this.env.DB.prepare(
          `UPDATE reviews SET status='partial',report_key=?,error=? WHERE id=? AND ${OPEN} RETURNING id`,
        )
          .bind(
            key,
            reason === "cancelled" ? "cancelled" : "runtime did not complete",
            id,
            key,
          )
          .first();
        if (!ended) return;
        await stopRunners(this.env, id);
        await withdrawIdle(this.env, id);
        await store.event(id, "review:partial", { report });
        await settleAnnouncement(
          this.env,
          id,
          "Review did not complete",
          reason === "cancelled"
            ? CANCELLED_UNPUBLISHED
            : "Rio's runtime stopped before the review finished, so nothing was published for this head. Push again or comment `/rio review` to retry.",
        );
      });
      return { report_key: key };
    }
  }
}
