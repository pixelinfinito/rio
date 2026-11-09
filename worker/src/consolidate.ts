import type {
  Evidence,
  FailOn,
  Finding,
  Hypothesis,
  Location,
  Profile,
  Verification,
} from "./types";
import { matches } from "./triage";
import { hash, normalizeTrigger } from "./validation";
const evidence: Record<Evidence, number> = {
  refuted: 0,
  plausible: 1,
  static_proven: 2,
  reproduced: 3,
};
const severity: Record<string, number> = { info: 1, warning: 2, error: 3 };
export interface Verified {
  hypothesis: Hypothesis;
  evidence_level: Evidence;
  verification: Verification;
  category?: Hypothesis["category"];
  reclassification_reason?: string;
  evidence?: string[];
  // Carried-forward class findings keep every instance location.
  locations?: Location[];
}
export function policyMatches(f: Finding, policy: FailOn): boolean {
  if (
    f.category === "ux" &&
    (f.severity === "info" || f.evidence_level === "refuted")
  )
    return false;
  return (
    (policy.rules ?? []).some((rule) => matches(rule, f.rule_id)) ||
    (evidence[f.evidence_level] >=
      evidence[policy.evidence ?? "static_proven"] &&
      (policy.categories ?? ["defect"]).includes(f.category) &&
      (policy.states ?? ["new", "worsened"]).includes(f.state))
  );
}
export interface ConsolidateOptions {
  // Instances above this count merge into one class finding (default 3).
  classThreshold?: number;
}
export function triggerHash(trigger: string): string {
  return hash(normalizeTrigger(trigger));
}
export function classId(rule_id: string, trigger_hash: string): string {
  return hash(`${rule_id}|class|${trigger_hash}`);
}
const order = (a: Finding, b: Finding) =>
  severity[b.severity] * evidence[b.evidence_level] -
    severity[a.severity] * evidence[a.evidence_level] ||
  a.location.path.localeCompare(b.location.path) ||
  a.location.line_start - b.location.line_start ||
  a.id.localeCompare(b.id);
/**
 * Merge agent findings that share rule_id and trigger hash across different
 * symbols into one class-level finding when the group exceeds the threshold.
 * Members keep their own ids in the returned group (and the consolidation audit).
 */
export function classify(
  findings: Finding[],
  threshold: number,
): { finding: Finding; members: Finding[] }[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.category}\0${f.rule_id}\0${triggerHash(f.trigger)}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const result: { finding: Finding; members: Finding[] }[] = [];
  for (const members of groups.values()) {
    const symbols = new Set(
      members.map((m) => `${m.location.path}\0${m.location.symbol_path}`),
    );
    if (members.length <= threshold || symbols.size < 2) {
      for (const m of members) result.push({ finding: m, members: [m] });
      continue;
    }
    const strongest = [...members].sort(order)[0];
    // Instances keep their own identity inside the class finding.
    const locations = members
      .flatMap((m) => m.locations.map((l) => ({ ...l, id: m.id })))
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          a.line_start - b.line_start ||
          a.symbol_path.localeCompare(b.symbol_path),
      );
    const first = locations[0];
    result.push({
      members,
      finding: {
        ...strongest,
        id: classId(strongest.rule_id, triggerHash(strongest.trigger)),
        location: (({ id: _, ...location }) => location)(first),
        locations,
        message: `${members.length} occurrences of ${strongest.message.replace(/[.\s]+$/, "")}; fix the pattern, for example at ${first.path}:${first.line_start}`,
        evidence: [...new Set(members.flatMap((m) => m.evidence))].sort(),
      },
    });
  }
  return result;
}
export function consolidate(
  verified: Verified[],
  p: Profile,
  options: ConsolidateOptions = {},
) {
  const security =
    p.steps.find((s) => s.uses.startsWith("rio/security@"))?.with ?? {};
  const audit = {
    held_back: {
      defects: [] as string[],
      risks: [] as string[],
      security: [] as string[],
    },
    category_drops: {} as Record<string, number>,
    suppressed: 0,
    refuted: 0,
    classes: {} as Record<string, string[]>,
    policy_failed: false,
    policy_matches: [] as string[],
  };
  const pools: { defects: Finding[]; risks: Finding[]; security: Finding[] } = {
    defects: [],
    risks: [],
    security: [],
  };
  const securityPolicy: FailOn = {
    evidence: "plausible",
    categories: ["security"],
    states: ["new", "worsened"],
    ...security.fail_on,
  };
  const suppressed = (f: Finding) =>
    p.suppress.some((s) =>
      "finding" in s
        ? s.finding === f.id
        : "path" in s
          ? f.locations.every((l) => matches(s.path, l.path))
          : matches(s.rule, f.rule_id),
    );
  const candidates: Finding[] = [];
  for (const v of verified) {
    const category = v.category ?? v.hypothesis.category;
    if (category === "style" || category === "diagnostic") {
      audit.category_drops[category] =
        (audit.category_drops[category] ?? 0) + 1;
      continue;
    }
    if (v.evidence_level === "refuted") {
      audit.refuted++;
      continue;
    }
    const h = v.hypothesis;
    const {
      guidance,
      catalog_item,
      trace_change,
      limitations,
      locations,
      ...publicHypothesis
    } = h;
    // finding-v1 has no slot for agent-only keys; their statements join the impact.
    const impact = [
      h.impact,
      catalog_item &&
        `Catalog item ${catalog_item}: the change ${trace_change ?? "affects"} a step of its trace.`,
      limitations?.length && `Limitations: ${limitations.join("; ")}.`,
    ]
      .filter(Boolean)
      .join(" ");
    const f: Finding = {
      ...publicHypothesis,
      ...(impact ? { impact } : {}),
      category,
      evidence_level: v.evidence_level,
      verification: v.verification,
      evidence: v.evidence ?? [],
      locations: v.locations ?? locations ?? [h.location],
    };
    if (suppressed(f)) {
      audit.suppressed++;
      continue;
    }
    candidates.push(f);
  }
  const classes = classify(candidates, options.classThreshold ?? 3);
  for (const { finding: f, members } of classes) {
    const category = f.category;
    if (members.length > 1) {
      audit.classes[f.id] = members.map((m) => m.id);
      // A suppression of the class applies to every instance.
      if (suppressed(f)) {
        audit.suppressed += members.length;
        continue;
      }
    }
    // Fail policies inspect every unsuppressed verified security entry before presentation floors/caps.
    if (
      category === "security" &&
      (policyMatches(f, p.fail_on) || policyMatches(f, securityPolicy))
    ) {
      audit.policy_failed = true;
      audit.policy_matches.push(f.id);
    }
    const posture =
      category === "security" ? (security.posture ?? "thorough") : p.posture;
    const min: Evidence =
      category === "security"
        ? (
            {
              "critical-only": "reproduced",
              balanced: "static_proven",
              thorough: "plausible",
            } as const
          )[posture as Profile["posture"]]
        : p.min_evidence;
    const floor =
      posture === "critical-only"
        ? "error"
        : posture === "balanced"
          ? "warning"
          : "info";
    if (category === "security") {
      if (
        f.evidence_level === "plausible"
          ? posture !== "critical-only"
          : evidence[f.evidence_level] >= evidence[min] &&
            severity[f.severity] >= severity[floor]
      )
        pools.security.push(f);
      continue;
    }
    if (category === "risk" || f.evidence_level === "plausible") {
      if (
        f.evidence_level === "plausible"
          ? posture !== "critical-only"
          : evidence[f.evidence_level] >= evidence[min]
      )
        pools.risks.push({ ...f, category: "risk" });
      continue;
    }
    if (
      evidence[f.evidence_level] >= evidence[min] &&
      severity[f.severity] >=
        severity[p.posture_policy?.defect_severity_floor ?? floor]
    )
      pools.defects.push(f);
  }
  const limits = {
    defects: p.max_defects,
    risks: p.posture === "thorough" ? Infinity : p.max_defects,
    security:
      security.max_defects ??
      (security.posture === "critical-only"
        ? 3
        : security.posture === "balanced"
          ? 5
          : 15),
  };
  for (const pool of ["defects", "risks", "security"] as const) {
    pools[pool].sort(order);
    audit.held_back[pool] = pools[pool]
      .slice(limits[pool])
      .map((f) => f.message);
    pools[pool] = pools[pool].slice(0, limits[pool]);
  }
  return { ...pools, audit };
}
