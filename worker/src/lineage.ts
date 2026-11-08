import type {
  AuthorResponse,
  ChangedFile,
  Env,
  File,
  Finding,
  Graph,
  Hypothesis,
  LifecycleStatus,
  LineageRef,
  Location,
  Profile,
} from "./types";
import type { Verified } from "./consolidate";
import { hash } from "./validation";

// Review lineages (openspec rio-v0-2-review-convergence). The endpoint is the
// single authority: lineage identity is tenant + repository + kind + ref and never
// depends on commit ancestry, so force-pushes keep the lineage.

export const NOT_REASSESSED = "not re-assessed";
export const DID_NOT_REPRODUCE = "did not reproduce";

export function lineageId(tenant: string, ref: LineageRef): string {
  return hash(`${tenant}\0${ref.repository}\0${ref.kind}\0${ref.ref}`);
}

/** Statements that attach a submitted review to its lineage (and apply a reset). */
export function attachStatements(
  env: Env,
  tenant: string,
  ref: LineageRef,
  review: string,
  snapshot: string,
  now = Date.now(),
): D1PreparedStatement[] {
  const id = lineageId(tenant, ref);
  const statements = [
    env.DB.prepare(
      "INSERT INTO lineages(id,tenant,repository,kind,ref,generation,round,posted_json,updated_at) VALUES(?,?,?,?,?,1,0,'{}',?) ON CONFLICT(id) DO NOTHING",
    ).bind(id, tenant, ref.repository, ref.kind, ref.ref, now),
  ];
  if (ref.reset)
    // A reset of a generation that has no review yet is a no-op: it is already round 1.
    statements.push(
      env.DB.prepare(
        "UPDATE lineages SET generation=generation+1,round=0,previous_head=NULL,previous_review=NULL,posted_json='{}',rounds_to_pass=NULL,intent=NULL,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM lineage_reviews r WHERE r.lineage_id=lineages.id AND r.generation=lineages.generation)",
      ).bind(now, id),
    );
  statements.push(
    env.DB.prepare(
      "INSERT INTO lineage_reviews(review_id,tenant,lineage_id,generation,snapshot_id,created_at) SELECT ?,?,id,generation,?,? FROM lineages WHERE id=?",
    ).bind(review, tenant, snapshot, now, id),
  );
  return statements;
}

export interface PriorFinding {
  id: string;
  status: LifecycleStatus;
  source_kind: "agent" | "tool";
  category: string;
  snapshot_id: string;
  snapshot_key: string | null;
  round: number;
  first_posted_in: string | null;
  author_response: AuthorResponse | null;
  resolution: { fixed_in?: string; note?: string } | null;
  finding: Finding;
  check: { kind: string; root: string } | null;
}
export interface LineageContext {
  id: string;
  tenant: string;
  repository: string;
  kind: "pr" | "branch";
  ref: string;
  generation: number;
  round: number;
  cap: number;
  diff_only_after: number;
  diff_only: boolean;
  snapshot_id: string;
  previous_head: string | null;
  previous_head_key: string | null;
  previous_review: string | null;
  posted: Record<string, { first_posted_in: string; round: number }>;
  rounds_to_pass: number | null;
  intent: string | null;
  author_response_ratio: number | null;
  prior: PriorFinding[];
}

export async function loadContext(
  env: Env,
  review: string,
  profile: Profile,
): Promise<LineageContext | null> {
  const row = await env.DB.prepare(
    "SELECT r.seq,r.tenant,r.lineage_id,r.generation AS review_generation,r.snapshot_id,l.repository,l.kind,l.ref,l.generation,l.posted_json,l.rounds_to_pass,l.intent FROM lineage_reviews r JOIN lineages l ON l.id=r.lineage_id WHERE r.review_id=?",
  )
    .bind(review)
    .first<any>();
  if (!row) return null;
  const generation: number = row.review_generation,
    current = generation === row.generation;
  const earlier = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM lineage_reviews WHERE lineage_id=? AND generation=? AND seq<? AND posted=1",
  )
    .bind(row.lineage_id, generation, row.seq)
    .first<{ count: number }>();
  const previous = await env.DB.prepare(
    "SELECT r.review_id,r.snapshot_id,s.object_key FROM lineage_reviews r LEFT JOIN snapshots s ON s.id=r.snapshot_id AND s.tenant=r.tenant WHERE r.lineage_id=? AND r.generation=? AND r.seq<? AND r.reviewed=1 ORDER BY r.seq DESC LIMIT 1",
  )
    .bind(row.lineage_id, generation, row.seq)
    .first<any>();
  const prior = await env.DB.prepare(
    "SELECT f.*,s.object_key AS snapshot_key FROM findings f LEFT JOIN snapshots s ON s.id=f.snapshot_id AND s.tenant=f.tenant WHERE f.tenant=? AND f.lineage_id=? AND f.generation=? ORDER BY f.identity",
  )
    .bind(row.tenant, row.lineage_id, generation)
    .all<any>();
  const responses = await env.DB.prepare(
    "SELECT author_response_json FROM findings WHERE tenant=? AND repository=? AND author_response_json IS NOT NULL",
  )
    .bind(row.tenant, row.repository)
    .all<{ author_response_json: string }>();
  const reasons = responses.results.map(
    (r) => (JSON.parse(r.author_response_json) as AuthorResponse).reason,
  );
  const round = 1 + (earlier?.count ?? 0),
    cap = profile.rounds?.cap ?? 3,
    diff_only_after = profile.rounds?.diff_only_after ?? 1;
  return {
    id: row.lineage_id,
    tenant: row.tenant,
    repository: row.repository,
    kind: row.kind,
    ref: row.ref,
    generation,
    round,
    cap,
    diff_only_after,
    diff_only: round > diff_only_after && !!previous?.object_key,
    snapshot_id: row.snapshot_id,
    previous_head: previous?.snapshot_id ?? null,
    previous_head_key: previous?.object_key ?? null,
    previous_review: previous?.review_id ?? null,
    posted: current ? JSON.parse(row.posted_json) : {},
    rounds_to_pass: current ? row.rounds_to_pass : null,
    intent: current ? row.intent : null,
    author_response_ratio: reasons.length
      ? reasons.filter((r) => r === "fixed").length / reasons.length
      : null,
    prior: prior.results.map((r) => {
      const stored = JSON.parse(r.finding_json);
      return {
        id: r.identity,
        status: r.status,
        source_kind: r.source_kind,
        category: r.category,
        snapshot_id: r.snapshot_id,
        snapshot_key: r.snapshot_key ?? null,
        round: r.round,
        first_posted_in: r.first_posted_in,
        author_response: r.author_response_json
          ? JSON.parse(r.author_response_json)
          : null,
        resolution: r.resolution_json ? JSON.parse(r.resolution_json) : null,
        finding: stored.finding,
        check: stored.check ?? null,
      };
    }),
  };
}

export type Tree = Record<string, File>;
export interface Relocation {
  status: "unchanged" | "moved" | "changed" | "removed" | "unknown";
  location: Location;
}
/**
 * Locate a finding's code from the head it was last produced on in a new head.
 * The exact line block is searched (nearest match wins); otherwise the enclosing
 * symbol from the new head graph marks it changed, and a vanished symbol marks it removed.
 */
export function relocate(
  before: Tree | undefined,
  after: Tree,
  location: Location,
  graph: Graph,
): Relocation {
  const old = before?.[location.path];
  if (!old || old.encoding) return { status: "unknown", location };
  const now = after[location.path];
  if (!now) return { status: "removed", location };
  if (now.encoding) return { status: "changed", location };
  const block = old.content
      .split("\n")
      .slice(location.line_start - 1, location.line_end),
    lines = now.content.split("\n");
  if (!block.length) return { status: "unknown", location };
  const want = location.line_start - 1;
  let best = -1;
  for (let k = 0; k + block.length <= lines.length; k++)
    if (
      block.every((line, i) => lines[k + i] === line) &&
      (best < 0 || Math.abs(k - want) < Math.abs(best - want))
    )
      best = k;
  if (best >= 0)
    return {
      status: best === want ? "unchanged" : "moved",
      location: {
        ...location,
        line_start: best + 1,
        line_end: best + block.length,
      },
    };
  const nodes = graph.nodes.filter((n) => n.path === location.path);
  const node = nodes.find((n) => n.symbol_path === location.symbol_path);
  if (node)
    return {
      status: "changed",
      location: {
        ...location,
        line_start: node.line_start,
        line_end: node.line_end,
      },
    };
  if (nodes.length) return { status: "removed", location };
  const end = Math.max(1, lines.length);
  return {
    status: "changed",
    location: {
      ...location,
      line_start: Math.min(location.line_start, end),
      line_end: Math.min(location.line_end, end),
    },
  };
}

/** Files whose content or mode differs between two heads, for diff-only rounds. */
export function incrementalChanges(before: Tree, after: Tree): ChangedFile[] {
  const changed: ChangedFile[] = [];
  for (const path of [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort()) {
    const a = before[path],
      b = after[path];
    if (a?.content === b?.content && a?.mode === b?.mode) continue;
    const old = a?.content.split("\n") ?? [],
      now = b?.content.split("\n") ?? [];
    const kept = new Set(old);
    changed.push({
      path,
      lines_changed:
        now.filter((l) => !kept.has(l)).length +
        old.filter((l) => !now.includes(l)).length,
    });
  }
  return changed;
}

function hypothesisOf(f: Finding, location: Location): Hypothesis {
  return {
    id: f.id,
    rule_id: f.rule_id,
    category: f.category,
    severity: f.severity,
    location,
    message: f.message,
    trigger: f.trigger,
    ...(f.impact === undefined ? {} : { impact: f.impact }),
    ...(f.suggested_fix === undefined
      ? {}
      : { suggested_fix: f.suggested_fix }),
    state: f.state,
    source: { agent: (f.source as any).agent ?? "correctness" },
  };
}

export interface Reverification {
  verify: Hypothesis[];
  carried: Verified[];
  skipped: string[];
}
/**
 * Diff-only rounds re-verify only hypotheses on changed code and previously open
 * agent findings whose location moved or whose code changed. An open finding on
 * unchanged code keeps its earlier verification without voter dispatch.
 */
export function planReverification(
  hypotheses: Hypothesis[],
  context: LineageContext,
  trees: Map<string, Tree>,
  head: Tree,
  graph: Graph,
  changedPaths: Set<string>,
): Reverification {
  const open = new Map(
    context.prior
      .filter((p) => p.source_kind === "agent" && p.status === "open")
      .map((p) => [p.id, p]),
  );
  const plan: Reverification = { verify: [], carried: [], skipped: [] };
  const carry = (p: PriorFinding, location: Location) =>
    plan.carried.push({
      hypothesis: hypothesisOf(p.finding, location),
      evidence_level: p.finding.evidence_level,
      verification: p.finding.verification ?? {
        voters: 1,
        agreeing: 1,
        blind_match: ["none"],
        split: false,
      },
      category: p.finding.category,
      evidence: p.finding.evidence,
      locations:
        p.finding.locations.length > 1 ? p.finding.locations : undefined,
    });
  const seen = new Set<string>();
  for (const h of hypotheses) {
    seen.add(h.id);
    const p = open.get(h.id);
    if (p) {
      const moved = relocate(
        trees.get(p.snapshot_id),
        head,
        p.finding.location,
        graph,
      );
      const same =
        h.location.path === p.finding.location.path &&
        h.location.line_start === p.finding.location.line_start &&
        h.location.line_end === p.finding.location.line_end;
      if (moved.status === "unchanged" && same) carry(p, p.finding.location);
      else plan.verify.push(h);
    } else if (changedPaths.has(h.location.path)) plan.verify.push(h);
    else plan.skipped.push(h.id);
  }
  for (const p of open.values()) {
    if (seen.has(p.id)) continue;
    const moved = relocate(
      trees.get(p.snapshot_id),
      head,
      p.finding.location,
      graph,
    );
    if (moved.status === "unchanged" || moved.status === "unknown")
      carry(p, p.finding.location);
    else if (moved.status !== "removed")
      plan.verify.push(hypothesisOf(p.finding, moved.location));
  }
  return plan;
}

const severity: Record<string, number> = { error: 3, warning: 2, info: 1 };
const evidence: Record<string, number> = {
  reproduced: 3,
  static_proven: 2,
  plausible: 1,
  refuted: 0,
};
/** Logical parts for a split proposal: deepest check root, else top-level directory. */
export function logicalParts(changed: ChangedFile[], checks: any[]): string[] {
  const roots = [
    ...new Set(
      (checks ?? [])
        .map((c) => c.root)
        .filter((r: any) => typeof r === "string" && r !== "." && r !== ""),
    ),
  ] as string[];
  const group = (part: (path: string) => string) => {
    const parts = new Map<string, { files: number; lines: number }>();
    for (const f of changed) {
      const key = part(f.path),
        entry = parts.get(key) ?? { files: 0, lines: 0 };
      entry.files++;
      entry.lines += f.lines_changed ?? 0;
      parts.set(key, entry);
    }
    return [...parts]
      .sort((a, b) => b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
      .map(
        ([name, v]) =>
          `${name} (${v.files} file${v.files === 1 ? "" : "s"}, ${v.lines} line${v.lines === 1 ? "" : "s"})`,
      );
  };
  const byRoot = group((path) => {
    const root = roots
      .filter((r) => path === r || path.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)[0];
    return root ?? (path.includes("/") ? path.split("/")[0] : ".");
  });
  if (byRoot.length > 1) return byRoot;
  const byDirectory = group((path) =>
    path.includes("/") ? path.split("/").slice(0, -1).join("/") : ".",
  );
  return byDirectory.length > 1 ? byDirectory : group((path) => path);
}

export interface LineageOutcome {
  posted: boolean;
  rows: { finding: Finding; source_kind: "agent" | "tool"; check: any }[];
  updates: { id: string; status: LifecycleStatus; resolution: any }[];
  posted_map: LineageContext["posted"];
  rounds_to_pass: number | null;
}
export interface ApplyOptions {
  head: Tree;
  trees: Map<string, Tree>;
  graph: Graph;
  // Agent verification ran to completion for this review (no incomplete votes).
  agents_reassessed: boolean;
  changed: ChangedFile[];
  max_lines?: number;
}
function checkOf(report: any, id: string) {
  const check = (report.checks ?? []).find((c: any) =>
    (c.findings ?? []).some((f: any) => f.id === id),
  );
  return check ? { kind: check.kind, root: check.root } : null;
}
function covered(
  origin: { kind: string; root: string } | null,
  checks: any[],
  path: string,
): boolean {
  const covering = (checks ?? []).filter(
    (c) =>
      c.version !== "base" &&
      (origin
        ? c.kind === origin.kind && c.root === origin.root
        : c.root === "." ||
          c.root === "" ||
          path === c.root ||
          path.startsWith(`${c.root}/`)),
  );
  return (
    covering.length > 0 &&
    covering.every((c) => c.outcome === "passed" || c.outcome === "findings")
  );
}
/**
 * Stamp lineage keys on a finished review's report and decide finding lifecycle
 * transitions. Pure: the caller persists the returned outcome.
 */
export function applyLineage(
  report: any,
  context: LineageContext,
  options: ApplyOptions,
): LineageOutcome {
  const capped = context.round > context.cap;
  const prior = new Map(context.prior.map((p) => [p.id, p]));
  const lists: Finding[][] = [
    report.findings,
    report.risks,
    report.security ?? [],
  ];
  const produced = new Map<string, Finding>();
  for (const list of lists)
    for (const f of list) if (!produced.has(f.id)) produced.set(f.id, f);
  const posted = { ...context.posted },
    held: string[] = [],
    stamps = new Map<string, Partial<Finding>>(),
    rows: LineageOutcome["rows"] = [];
  for (const f of produced.values()) {
    const deterministic = "tool" in (f.source as any),
      p = prior.get(f.id),
      stamp: Partial<Finding> = { round: context.round };
    if (posted[f.id]) {
      held.push(f.id);
      stamp.first_posted_in = posted[f.id].first_posted_in;
    } else if (!capped || deterministic) {
      posted[f.id] = {
        first_posted_in: context.snapshot_id,
        round: context.round,
      };
      stamp.first_posted_in = context.snapshot_id;
    }
    if (stamp.first_posted_in) {
      if (p?.author_response) {
        stamp.status = "dismissed";
        stamp.author_response = p.author_response;
      } else stamp.status = "open";
    }
    stamps.set(f.id, stamp);
    rows.push({
      finding: { ...f, ...stamp },
      source_kind: deterministic ? "tool" : "agent",
      check: checkOf(report, f.id) ?? p?.check ?? null,
    });
  }
  const stampAll = (list: any[] | undefined) =>
    list?.forEach((f, i) => {
      const stamp = stamps.get(f.id);
      if (stamp) list[i] = { ...f, ...stamp };
    });
  for (const list of lists) stampAll(list);
  for (const check of report.checks ?? []) stampAll(check.findings);
  const complete = report.status === "complete";
  const updates: LineageOutcome["updates"] = [];
  // A remembered dismissal reproduced the identity; it is neither fixed nor
  // unreassessed.
  const remembered = new Set(
    (report.remembered ?? []).map((f: Finding) => f.id),
  );
  for (const p of context.prior) {
    if (produced.has(p.id) || remembered.has(p.id) || p.status !== "open")
      continue;
    const reassessed =
      complete &&
      (p.source_kind === "tool"
        ? covered(p.check, report.checks, p.finding.location.path)
        : options.agents_reassessed);
    const code = relocate(
      options.trees.get(p.snapshot_id),
      options.head,
      p.finding.location,
      options.graph,
    ).status;
    if (!reassessed || code === "unknown")
      updates.push({
        id: p.id,
        status: "open",
        resolution: { note: NOT_REASSESSED },
      });
    else if (code === "changed" || code === "removed")
      updates.push({
        id: p.id,
        status: "fixed",
        resolution: { fixed_in: context.snapshot_id },
      });
    else
      updates.push({
        id: p.id,
        status: "open",
        resolution: { note: DID_NOT_REPRODUCE },
      });
  }
  const isOpen = (f: Finding) =>
    (stamps.get(f.id)?.status ?? "open") !== "dismissed";
  const openDefects =
    report.findings.filter((f: Finding) => f.category === "defect" && isOpen(f))
      .length +
    updates.filter(
      (u) => u.status === "open" && prior.get(u.id)?.category === "defect",
    ).length;
  const rounds_to_pass =
    context.rounds_to_pass ??
    (complete && openDefects === 0 ? context.round : null);
  const lineage: any = {
    repository: context.repository,
    kind: context.kind,
    ref: context.ref,
    generation: context.generation,
    round: context.round,
    cap: context.cap,
    capped,
    diff_only: context.diff_only,
    previous_head: context.previous_head,
    held_back: held.length,
    rounds_to_pass,
    author_response_ratio: context.author_response_ratio,
  };
  if (capped) {
    const unresolved = [...produced.values()].filter(
      (f) => !("tool" in (f.source as any)) && isOpen(f),
    );
    const top = [...unresolved]
      .sort(
        (a, b) =>
          severity[b.severity] - severity[a.severity] ||
          evidence[b.evidence_level] - evidence[a.evidence_level] ||
          a.location.path.localeCompare(b.location.path) ||
          a.location.line_start - b.location.line_start ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 3)
      .map((f) => ({
        id: f.id,
        title: f.message.split("\n")[0].slice(0, 200) || f.rule_id,
        path: f.location.path,
        line_start: f.location.line_start,
      }));
    const lines = options.changed.reduce(
      (n, f) => n + (f.lines_changed ?? 0),
      0,
    );
    const exceeded =
      (typeof options.max_lines === "number" && lines > options.max_lines) ||
      (report.footer?.notes ?? []).some((n: string) =>
        /exceeding max_lines/.test(n),
      );
    lineage.reconsider = {
      unresolved: unresolved.length,
      top,
      ...(exceeded
        ? { split: logicalParts(options.changed, report.checks) }
        : {}),
    };
  }
  report.lineage = lineage;
  // Renderers mark these as already posted; agent_audit exists for every
  // completed endpoint review (it is never created here without its policy keys).
  if (report.agent_audit) {
    report.agent_audit.already_posted = held.sort();
    report.agent_audit.lineage_updates = updates;
  }
  return {
    posted: produced.size > 0,
    rows,
    updates,
    posted_map: posted,
    rounds_to_pass,
  };
}

/** Durable writes for a finished lineage review, executed in one D1 batch. */
export function persistStatements(
  env: Env,
  context: LineageContext,
  outcome: LineageOutcome,
  review: string,
  intent: string,
  now = Date.now(),
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const row of outcome.rows) {
    const f = row.finding;
    statements.push(
      env.DB.prepare(
        "INSERT INTO findings(tenant,lineage_id,generation,identity,review_id,snapshot_id,repository,rule_id,category,source_kind,state,status,round,first_posted_in,author_response_json,resolution_json,location_json,finding_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?) ON CONFLICT(tenant,lineage_id,generation,identity) DO UPDATE SET review_id=excluded.review_id,snapshot_id=excluded.snapshot_id,rule_id=excluded.rule_id,category=excluded.category,source_kind=excluded.source_kind,state=excluded.state,status=CASE WHEN findings.author_response_json IS NOT NULL THEN 'dismissed' ELSE excluded.status END,round=excluded.round,first_posted_in=COALESCE(findings.first_posted_in,excluded.first_posted_in),resolution_json=NULL,location_json=excluded.location_json,finding_json=excluded.finding_json,updated_at=excluded.updated_at",
      ).bind(
        context.tenant,
        context.id,
        context.generation,
        f.id,
        review,
        context.snapshot_id,
        context.repository,
        f.rule_id,
        f.category,
        row.source_kind,
        f.state,
        f.status ?? "open",
        context.round,
        f.first_posted_in ?? null,
        JSON.stringify({ location: f.location, locations: f.locations }),
        JSON.stringify({ finding: f, check: row.check }),
        now,
        now,
      ),
    );
  }
  for (const u of outcome.updates)
    statements.push(
      env.DB.prepare(
        "UPDATE findings SET status=?,resolution_json=?,updated_at=? WHERE tenant=? AND lineage_id=? AND generation=? AND identity=? AND status='open'",
      ).bind(
        u.status,
        JSON.stringify(u.resolution),
        now,
        context.tenant,
        context.id,
        context.generation,
        u.id,
      ),
    );
  statements.push(
    env.DB.prepare(
      "UPDATE lineage_reviews SET round=?,reviewed=1,posted=? WHERE review_id=?",
    ).bind(context.round, outcome.posted ? 1 : 0, review),
    env.DB.prepare(
      "UPDATE lineages SET round=?,previous_head=?,previous_review=?,posted_json=?,rounds_to_pass=COALESCE(rounds_to_pass,?),intent=COALESCE(intent,?),updated_at=? WHERE id=? AND generation=?",
    ).bind(
      context.round,
      context.snapshot_id,
      review,
      JSON.stringify(outcome.posted_map),
      outcome.rounds_to_pass,
      intent,
      now,
      context.id,
      context.generation,
    ),
  );
  return statements;
}
