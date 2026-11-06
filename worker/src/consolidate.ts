import type {
  Evidence,
  FailOn,
  Finding,
  Hypothesis,
  Profile,
  Verification,
} from "./types";
import { matches } from "./triage";
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
}
export function policyMatches(f: Finding, policy: FailOn): boolean {
  return (
    (policy.rules ?? []).some((rule) => matches(rule, f.rule_id)) ||
    (evidence[f.evidence_level] >=
      evidence[policy.evidence ?? "static_proven"] &&
      (policy.categories ?? ["defect"]).includes(f.category) &&
      (policy.states ?? ["new", "worsened"]).includes(f.state))
  );
}
export function consolidate(verified: Verified[], p: Profile) {
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
    const { guidance, ...publicHypothesis } = h;
    const f: Finding = {
      ...publicHypothesis,
      category,
      evidence_level: v.evidence_level,
      verification: v.verification,
      evidence: v.evidence ?? [],
      locations: [h.location],
    };
    if (
      p.suppress.some((s) =>
        "finding" in s
          ? s.finding === f.id
          : "path" in s
            ? matches(s.path, f.location.path)
            : matches(s.rule, f.rule_id),
      )
    ) {
      audit.suppressed++;
      continue;
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
        v.evidence_level === "plausible"
          ? posture !== "critical-only"
          : evidence[v.evidence_level] >= evidence[min] &&
            severity[f.severity] >= severity[floor]
      )
        pools.security.push(f);
      continue;
    }
    if (category === "risk" || v.evidence_level === "plausible") {
      if (
        v.evidence_level === "plausible"
          ? posture !== "critical-only"
          : evidence[v.evidence_level] >= evidence[min]
      )
        pools.risks.push({ ...f, category: "risk" });
      continue;
    }
    if (
      evidence[v.evidence_level] >= evidence[min] &&
      severity[f.severity] >=
        severity[p.posture_policy?.defect_severity_floor ?? floor]
    )
      pools.defects.push(f);
  }
  const order = (a: Finding, b: Finding) =>
    severity[b.severity] * evidence[b.evidence_level] -
      severity[a.severity] * evidence[a.evidence_level] ||
    a.location.path.localeCompare(b.location.path) ||
    a.location.line_start - b.location.line_start ||
    a.id.localeCompare(b.id);
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
