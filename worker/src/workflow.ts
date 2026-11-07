import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import type {
  Env,
  ExecutionResult,
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
import { ProviderGateway, converse } from "./gateway";
import {
  Tools,
  dataBlock,
  filteredLines,
  guidanceBlock,
  runAllowed,
} from "./tools";
import { hash, invariant, validateHypotheses } from "./validation";
import { triage, type Plan } from "./triage";
import { verifyHypothesis } from "./verifier";
import { consolidate, type Verified } from "./consolidate";
import { createJob } from "./jobs";
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
  StoredSnapshot,
  compareUtf8,
  materialize,
  type Entry,
  type SnapshotReader,
  type TreeReader,
} from "./snapshot";
export interface WorkflowParams {
  review_id: string;
  snapshot_key: string;
}
async function changedCode(
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
      const entry = (await materialize(snapshot[version], [path]))[path];
      if (!entry) preview[version] = null;
      else if (entry.encoding === "base64") preview[version] = { binary: true };
      else {
        const content = entry.content
          .split("\n")
          .slice(0, 80)
          .join("\n")
          .slice(0, 4000);
        preview[version] = {
          line_start: 1,
          content,
          truncated: content !== entry.content,
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
export class ReviewWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const id = event.payload.review_id,
      store = new Store(this.env);
    const load = await step.do("load", async () => {
      const row = await this.env.DB.prepare(
        "SELECT submission_key,deadline FROM reviews WHERE id=?",
      )
        .bind(id)
        .first<{ submission_key: string; deadline: number }>();
      invariant(row, "review not found");
      await this.env.DB.prepare(
        "UPDATE reviews SET status='running' WHERE id=? AND cancelled=0",
      )
        .bind(id)
        .run();
      return row;
    });
    const submission = await store.get<Submission>(load.submission_key),
      snapshot = await StoredSnapshot.open(
        this.env,
        event.payload.snapshot_key,
      );
    // Steps read files on demand; triage needs only the changed files.
    const changedFiles: Snapshot = {
      base: await materialize(
        snapshot.base,
        submission.changed.flatMap((f) => [f.path, f.old_path ?? f.path]),
      ),
      head: await materialize(
        snapshot.head,
        submission.changed.map((f) => f.path),
      ),
    };
    let plan: Plan;
    const report = structuredClone(submission.report);
    const executions: Record<string, ExecutionResult> = {},
      hypotheses: Hypothesis[] = [],
      verified: Verified[] = [];
    const ledger = new D1Ledger(this.env, id),
      gateway = new ProviderGateway(this.env);
    let graphs = submission.graphs;
    // Lineage state is read once, durably, so replays see the same round and history.
    let lineage: LineageContext | null = null;
    const trees = new Map<string, Tree>();
    // Head files at the prior findings' locations, for relocation.
    let head: Record<string, File> = {};
    let previousHead: SnapshotReader | undefined;
    let incremental: Submission["changed"] = [];
    let agentsVerified = false;
    let diffOnlyAudit: Record<string, string[]> | undefined;
    const call = async (name: string, action: () => Promise<ModelResponse>) => {
      const key = await step.do(
        `model-${name}`,
        { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
        async () => {
          const result = await action();
          const key = `reviews/${id}/models/${name}.json`;
          await store.put(key, result);
          return key;
        },
      );
      return store.get<ModelResponse>(key);
    };
    const execute = async (
      name: string,
      kind: "run" | "checks" | "graph" | "static",
      command: string[],
      version: Version,
    ) => {
      invariant(
        !submission.fork || kind === "static",
        "fork reviews are static-only",
      );
      const job = hash(`${id}-${name}`).slice(0, 32),
        attempt = 1;
      await step.do(`dispatch-${job}`, async () => {
        await createJob(
          this.env,
          id,
          job,
          kind,
          command,
          version,
          submission.snapshot_id,
          attempt,
          kind === "run" ? undefined : { profile: submission.profile },
        );
        return job;
      });
      // The unique attempt is part of the event type and result path.
      const remaining = await step.do(`remaining-${job}`, async () => {
        const ms = await store.remainingMs(id);
        invariant(ms > 0, "review wall budget exhausted");
        return Math.max(1, Math.ceil(ms / 1000));
      });
      const completed = await step.waitForEvent<{ key: string }>(
        `wait-${job}`,
        {
          type: `job-${job}-${attempt}`,
          timeout: `${Math.min(240, remaining)} seconds`,
        },
      );
      const result = await store.get<ExecutionResult>(completed.payload.key);
      invariant(
        result.job_id === job &&
          result.attempt === attempt &&
          result.version === version,
        "wrong runner completion",
      );
      executions[job] = result;
      return result;
    };
    const done = new Set<string>();
    const perform = async (s: Submission["profile"]["steps"][number]) => {
      if (await store.cancelled(id)) throw new Error("cancelled");
      await step.do(`started-${s.id}`, () =>
        store.event(id, "step:started", { step: s.id }),
      );
      const module = s.uses.split("@")[0];
      if (module === "rio/triage") {
        plan = triage({ ...submission, report, graphs }, changedFiles);
        await step.do(`budget-${s.id}`, () =>
          store.selectBudget(id, submission.profile, plan.mode),
        );
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
          if (result.timed_out || result.exit_code !== 0 || !result.artifact)
            throw new Error(`${s.id}: runner analysis failed`);
          if (module === "rio/checks") {
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
          if (result.artifact.graphs) graphs = result.artifact.graphs;
        }
      } else if (module === "rio/agents" || module === "rio/security") {
        const security = module === "rio/security";
        const selected = security
          ? s.with.enabled === true || plan.agents.includes("security")
            ? ["security"]
            : []
          : plan.agents.filter((a) => a !== "security");
        if (security && selected.length) {
          report.status = "partial";
          report.footer.notes.push(
            "Security agent/catalog is unavailable until v0.3; security review was not performed.",
          );
        } else {
          const active =
            plan.mode === "deep"
              ? (submission.profile.budget.deep ??
                submission.profile.budget.fast)
              : submission.profile.budget.fast;
          const agentTokens = Math.floor(
            (active.tokens ?? 100000) / (active.agents_max ?? 3),
          );
          // A diff-only round on an unchanged head has nothing new to review:
          // agents are not re-run and earlier findings carry forward.
          const unchanged =
            lineage?.diff_only && previousHead && incremental.length === 0;
          if (unchanged && selected.length)
            report.footer.notes.push(
              "No change since the previously reviewed head; agents were not re-run and earlier findings carry forward.",
            );
          for (const agent of unchanged
            ? []
            : selected.slice(0, active.agents_max ?? 3)) {
            const declaration = (s.agents ?? []).find((a) =>
              Object.hasOwn(a, agent),
            );
            const config = declaration?.[agent] ?? {};
            const model =
              submission.profile.models[config.model ?? agent] ??
              submission.profile.models.default;
            invariant(model, "no default model configured");
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
            const prompt = `Review the change independently for ${agent}. Inspect actual base and head code before making a claim; symbol names and graph hashes are not source code. Use read_file for omitted or truncated code. Suggested focus is only a hint; tools can read/search either entire repository snapshot. Classify concrete correctness regressions as defect, uncertain hazards as risk, style and repeated tool diagnostics accurately. Omit guidance unless citing a real owner-guidance document supplied below; source-code lines are not owner guidance. Check guidance/contradiction and guidance/stale risks against existing guidance lines: emit category risk, cite guidance:{path,line} and the changed code behavior. Return {result:hypotheses[]}.${roundContext}\n${dataBlock("intent", filteredLines(intent.split("\n")))}\n${dataBlock("suggested_focus", reviewed.focus)}\n${dataBlock("graph", graphs)}\n${dataBlock("changed code excerpts", await changedCode(reviewed.changed, reviewed.snapshot))}\n${dataBlock("deterministic checks", report.checks)}\n${guidanceBlock(submission.owner_guidance, reviewed.focus)}`;
            const result = validateHypotheses(
              await converse({
                gateway,
                ledger,
                actor: `${s.id}-${agent}`,
                phase: "generation",
                model,
                allowance: { remaining: agentTokens },
                messages: [{ role: "user", content: prompt }],
                dispatch: tools.dispatch.bind(tools),
                call,
                cancelled: () => store.cancelled(id),
              }),
            );
            for (const h of result) {
              h.source = { agent };
              if (!hypotheses.some((x) => x.id === h.id)) hypotheses.push(h);
            }
          }
        }
      } else if (module === "rio/verify") {
        const active =
          plan.mode === "deep"
            ? (submission.profile.budget.deep ?? submission.profile.budget.fast)
            : submission.profile.budget.fast;
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
          diffOnlyAudit = {
            reverified: reverify.verify.map((h) => h.id),
            carried: reverify.carried.map((v) => v.hypothesis.id),
            not_reverified: reverify.skipped,
          };
        }
        for (const h of candidates) {
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
              executions,
              guidance: submission.owner_guidance,
            },
            gateway,
            ledger,
            agentTokens: Math.floor(
              (active.tokens ?? 100000) / (active.agents_max ?? 3),
            ),
            verifyTokens: active.verify_tokens,
            call,
            cancelled: () => store.cancelled(id),
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
          await step.do(`verified-${h.id}`, () =>
            store.event(id, "finding:verified", {
              id: h.id,
              ...result.verified.verification,
              evidence_level: result.verified.evidence_level,
            }),
          );
        }
      }
      await step.do(`finished-${s.id}`, () =>
        store.event(id, "step:finished", { step: s.id }),
      );
    };
    try {
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
        for (const [snapshotId, w] of wanted)
          trees.set(
            snapshotId,
            await materialize(
              (await StoredSnapshot.open(this.env, w.key)).head,
              w.paths,
            ),
          );
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
      plan = triage(submission, changedFiles);
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
      const findings = consolidate(verified, submission.profile, {
        classThreshold: submission.profile.steps.find((s) =>
          s.uses.startsWith("rio/report@"),
        )?.with?.class_threshold,
      });
      report.findings.push(...findings.defects);
      report.risks.push(...findings.risks);
      if (findings.security.length) report.security = findings.security;
      report.agent_audit = {
        ...findings.audit,
        require_human: plan.require_human,
        board_deferred: true,
      };
      report.risk_tier = plan.risk;
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
        "SELECT phase,status,input_tokens,output_tokens,cost_usd FROM usage WHERE review_id=?",
      )
        .bind(id)
        .all<any>();
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
      report.deferred = [];
      report.review.rio_version = this.env.RIO_VERSION;
      if (await store.cancelled(id)) report.status = "partial";
      if (diffOnlyAudit) report.agent_audit.diff_only = diffOnlyAudit;
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
            changed: submission.changed,
            max_lines: submission.profile.max_lines,
          })
        : null;
      const key = await store.put(`reviews/${id}/report.json`, report);
      await step.do("finish", async () => {
        await this.env.DB.prepare(
          "UPDATE reviews SET status=?,report_key=? WHERE id=?",
        )
          .bind(report.status === "partial" ? "partial" : "complete", key, id)
          .run();
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
          report.status === "partial" ? "review:partial" : "review:done",
          { report },
        );
      });
      return { report_key: key };
    } catch (error) {
      report.status = "partial";
      report.footer.notes.push(
        error instanceof Error ? error.message : "review failed",
      );
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
      const key = await store.put(`reviews/${id}/report.json`, report);
      await step.do("failed", async () => {
        await this.env.DB.prepare(
          "UPDATE reviews SET status='partial',report_key=?,error=? WHERE id=?",
        )
          .bind(key, "runtime did not complete", id)
          .run();
        await store.event(id, "review:partial", { report });
      });
      return { report_key: key };
    }
  }
}
