import type { ValidateFunction } from "ajv";
import * as validators from "./validators.generated.js";
import { invariant } from "./validation";

/**
 * Council members' structured assessments (`council-assessment-v1`). Only
 * `impact` is free text; nothing here parses it.
 */
export type Role =
  "skeptic" | "exploit-author" | "code-owner" | "maintainer" | "tester";
export const ROLES: Role[] = [
  "skeptic",
  "exploit-author",
  "code-owner",
  "maintainer",
  "tester",
];
export type Answer = "yes" | "no" | "unknown";
export type Basis =
  "reproduction" | "static_path" | "protection_found" | "contract" | "none";
export interface Position {
  real?: Answer;
  introduced_by_change?: Answer;
}
export type ReasonCode =
  | "new_artifact"
  | "missing_protection"
  | "wrong_path"
  | "wrong_version"
  | "contract_misread";
export interface Citation {
  kind: "artifact" | "assessment";
  ref: string;
  reason_code: ReasonCode;
}
export interface ExperimentRequest {
  command: string[];
  version: "base" | "head" | "both";
  expect: "fails" | "passes" | "output_contains";
  contains?: string;
}
export interface Assessment {
  member: Role;
  round: 1 | 2;
  real: Answer;
  introduced_by_change: Answer;
  impact: string;
  basis: Basis;
  evidence_refs: string[];
  experiment_request?: ExperimentRequest;
  changed_from?: Position;
  changed_to?: Position;
  cites?: Citation;
}
export type AbstentionCause =
  "invalid" | "no_evidence_refs" | "timeout" | "vendor_error" | "budget";
export type Validated =
  | {
      assessment: Assessment;
      /** Why an experiment request was dropped, when one was. */
      dropped_request?: "round_2" | "invalid";
    }
  | { abstained: AbstentionCause; detail?: string };

const assessmentValidator = (
  validators as Record<string, ValidateFunction<Assessment>>
).assessment;
const requestValidator = (
  validators as Record<string, ValidateFunction<ExperimentRequest>>
).experimentRequest;

/**
 * Validate one member answer for `round`. A malformed or round-2 experiment
 * request drops only the request; any other failure is an abstention.
 */
export function validateAssessment(value: unknown, round: 1 | 2): Validated {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { abstained: "invalid", detail: "not an object" };
  const candidate: Record<string, unknown> = { ...value };
  if (candidate.round !== round)
    return { abstained: "invalid", detail: `round must be ${round}` };
  if (
    Array.isArray(candidate.evidence_refs) &&
    candidate.evidence_refs.length === 0
  )
    return { abstained: "no_evidence_refs" };
  let dropped: "round_2" | "invalid" | undefined;
  if ("experiment_request" in candidate) {
    if (round === 2) dropped = "round_2";
    else if (!requestValidator(candidate.experiment_request))
      dropped = "invalid";
    if (dropped) delete candidate.experiment_request;
  }
  if (!assessmentValidator(candidate))
    return {
      abstained: "invalid",
      detail: (assessmentValidator.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join(", ")
        .slice(0, 500),
    };
  return dropped
    ? {
        assessment: candidate as unknown as Assessment,
        dropped_request: dropped,
      }
    : { assessment: candidate as unknown as Assessment };
}

/** A council member as the CLI resolved it (`council_members` in the resolved profile). */
export interface Member {
  name: string;
  version: string;
  role: Role;
  context_pack: "diff-only" | "graph-heavy" | "execution";
  provider: string;
  model: string;
  vendor: string;
  family: string;
  weight: number;
  self_hosted: boolean;
  /** The gateway route when an allowlist entry filled the member; else `provider/model`. */
  route?: string;
}
export interface CouncilSettings {
  members: { uses: string }[];
  max_findings: number;
  max_experiments: number;
  max_rounds: number;
  min_members: number;
  timeout: string;
  vendors_allowed: string[];
}
/** One entry of a repository's council allowlist (`COUNCIL_VENDORS`). */
export interface VendorEntry {
  vendor: string;
  family: string;
  /** The gateway route, `provider/model`. */
  model: string;
}
export const PLACEHOLDER = "placeholder";
const SLUG = /^[a-z][a-z0-9-]*$/;

/**
 * The repository's council allowlist: a JSON list for every repository, or an
 * object keyed by repository with `"*"` as the fallback. Absent means empty.
 */
export function councilVendors(
  value: string | undefined,
  repository: string | null,
): VendorEntry[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("COUNCIL_VENDORS is not valid JSON");
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((repository === null
          ? undefined
          : (parsed as Record<string, unknown>)[repository]) ??
        (parsed as Record<string, unknown>)["*"] ??
        [])
      : null;
  invariant(
    Array.isArray(list),
    "COUNCIL_VENDORS must be a list or an object of lists",
  );
  for (const entry of list)
    invariant(
      entry &&
        SLUG.test(entry.vendor) &&
        SLUG.test(entry.family) &&
        typeof entry.model === "string" &&
        /^[^/\s]+\/\S+$/.test(entry.model),
      "COUNCIL_VENDORS entries need vendor, family and a provider/model route",
    );
  return list as VendorEntry[];
}

/** The gateway route of a member. */
export function routeOf(member: Member): string {
  return member.route ?? `${member.provider}/${member.model}`;
}

const fill = (m: Member, entry: VendorEntry): Member => ({
  ...m,
  provider: entry.vendor,
  vendor: entry.vendor,
  family: entry.family,
  model: entry.model,
  route: entry.model,
  self_hosted: false,
});

const configured = (m: Member) =>
  ![m.provider, m.model, m.family].includes(PLACEHOLDER);

/**
 * Fill placeholder members from the allowlist, taking entries in turn across
 * families so the members spread over as many families as the list offers.
 */
export function fillPlaceholders(
  members: Member[],
  entries: VendorEntry[],
): Member[] {
  const families = [...new Set(entries.map((e) => e.family))];
  if (!families.length) return members;
  const used = new Map<string, number>();
  let next = 0;
  return members.map((m) => {
    if (configured(m)) return m;
    const family = families[next++ % families.length];
    const pool = entries.filter((e) => e.family === family);
    const n = used.get(family) ?? 0;
    used.set(family, n + 1);
    return fill(m, pool[n % pool.length]);
  });
}

/** The model family of an agent named in PR metadata; null when unknown. */
export function authorFamily(
  agent: { name: string } | undefined,
): string | null {
  const name = agent?.name.toLowerCase() ?? "";
  if (/claude/.test(name)) return "claude";
  if (/codex|openai|chatgpt/.test(name)) return "gpt";
  if (/gemini|jules/.test(name)) return "gemini";
  return null;
}

export interface Exclusion {
  role: Role;
  vendor: string;
  denied_by: "profile" | "repository" | "runner";
}
export interface AuthorFamilyRecord {
  status: "applied" | "not_applicable";
  family?: string;
  substituted?: { role: Role; vendor: string; family: string }[];
  dropped?: Role[];
}
export interface Composition {
  participants: Member[];
  excluded: Exclusion[];
  /** Placeholder members no allowlist entry could fill. */
  unconfigured: Role[];
  author_family: AuthorFamilyRecord;
}

/**
 * Who takes part: placeholders filled from the repository allowlist, members
 * excluded by either vendor allowlist (or, when self-hosted, by a missing
 * runner model endpoint) before any pack is built, then the author-family rule.
 */
export function compose(
  members: Member[],
  settings: Pick<CouncilSettings, "vendors_allowed">,
  entries: VendorEntry[],
  author: string | null,
  runnerModels: boolean,
): Composition {
  const profileAllows = (vendor: string) =>
    settings.vendors_allowed.includes(vendor);
  const excluded: Exclusion[] = [],
    unconfigured: Role[] = [];
  const admitted: Member[] = [];
  // The submitted profile is not trusted for routing: without a route the
  // vendor is the provider the call goes to, and every external member's
  // route must be exactly an allowlist entry of its vendor, so neither a label
  // nor a nested route (`openai/custom-x/model`) can send a pack elsewhere.
  const routed = members.map((m) =>
    m.route === undefined ? { ...m, vendor: m.provider } : m,
  );
  for (const m of fillPlaceholders(routed, entries)) {
    if (!configured(m)) unconfigured.push(m.role);
    else if (m.self_hosted) {
      if (runnerModels) admitted.push(m);
      else
        excluded.push({ role: m.role, vendor: m.vendor, denied_by: "runner" });
    } else if (!profileAllows(m.vendor))
      excluded.push({ role: m.role, vendor: m.vendor, denied_by: "profile" });
    else if (
      !entries.some((e) => e.vendor === m.vendor && e.model === routeOf(m))
    )
      excluded.push({
        role: m.role,
        vendor: m.vendor,
        denied_by: "repository",
      });
    else admitted.push(m);
  }
  if (!author)
    return {
      participants: admitted,
      excluded,
      unconfigured,
      author_family: { status: "not_applicable" },
    };
  const record: Required<Omit<AuthorFamilyRecord, "family">> & {
    family: string;
  } = { status: "applied", family: author, substituted: [], dropped: [] };
  const participants: Member[] = [];
  let seen = false;
  for (const m of admitted) {
    if (m.family !== author) {
      participants.push(m);
      continue;
    }
    if (!seen) {
      seen = true;
      participants.push(m);
      continue;
    }
    // Prefer a family not yet in the council, then any other family.
    const present = new Set(
      [...participants, ...admitted].map((p) => p.family),
    );
    const candidates = entries.filter(
      (e) => e.family !== author && profileAllows(e.vendor),
    );
    const entry =
      candidates.find((e) => !present.has(e.family)) ?? candidates[0];
    if (!entry) {
      record.dropped.push(m.role);
      continue;
    }
    participants.push(fill(m, entry));
    record.substituted.push({
      role: m.role,
      vendor: entry.vendor,
      family: entry.family,
    });
  }
  return {
    participants,
    excluded,
    unconfigured,
    author_family: {
      status: "applied",
      family: author,
      ...(record.substituted.length ? { substituted: record.substituted } : {}),
      ...(record.dropped.length ? { dropped: record.dropped } : {}),
    },
  };
}
