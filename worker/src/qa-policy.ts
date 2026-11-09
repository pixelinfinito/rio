import type { FailOn, Finding, Profile } from "./types";
import { policyMatches } from "./consolidate";
import { matches } from "./triage";

export function qaFailOn(options: Record<string, any>): FailOn {
  return {
    evidence: "plausible",
    categories: ["ux"],
    states: ["new", "worsened"],
    rules: [],
    incomplete: true,
    ...options.fail_on,
  };
}

/** Apply profile suppressions before consulting persistent finding history. */
export function suppressQaFindings(
  report: any,
  suppressions: Profile["suppress"],
) {
  const counts = new Map<number, number>();
  report.findings = report.findings.filter((finding: Finding) => {
    if (finding.category !== "ux") return true;
    const entry = suppressions.findIndex((suppression) =>
      "finding" in suppression
        ? suppression.finding === finding.id
        : "path" in suppression
          ? finding.locations.every((location) =>
              matches(suppression.path, location.path),
            )
          : matches(suppression.rule, finding.rule_id),
    );
    if (entry < 0) return true;
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
    return false;
  });
  for (const [entry, count] of counts) {
    report.summary.suppressed += count;
    report.footer.suppressions ??= [];
    const prior = report.footer.suppressions.find(
      (row: any) => row.entry === entry,
    );
    if (prior) prior.count += count;
    else report.footer.suppressions.push({ entry, count });
  }
}

/** QA candidates remain separate from general agent posture/caps. Recommendations
 * never enter this function's pool, irrespective of their priority or verdict. */
export function applyQaPolicy(
  report: any,
  options: Record<string, any>,
  runtimeIncomplete = false,
) {
  if (!report.qa && !runtimeIncomplete) return;
  const policy = qaFailOn(options);
  const severity: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const evidence: Record<string, number> = {
    refuted: 0,
    plausible: 1,
    static_proven: 2,
    reproduced: 3,
  };
  const pool: Finding[] = report.findings.filter(
    (finding: Finding) =>
      finding.category === "ux" && finding.evidence_level !== "refuted",
  );
  pool.sort(
    (a, b) =>
      severity[a.severity] - severity[b.severity] ||
      evidence[b.evidence_level] - evidence[a.evidence_level] ||
      a.location.path.localeCompare(b.location.path) ||
      a.location.line_start - b.location.line_start ||
      a.id.localeCompare(b.id),
  );
  const policyMatchesQa = pool
    .filter(
      (finding) =>
        finding.severity !== "info" && policyMatches(finding, policy),
    )
    .map((finding) => finding.id);
  const cap = options.max_defects ?? 15;
  const heldBack = pool
    .slice(cap)
    .map((finding) => ({ id: finding.id, title: finding.message }));
  const incomplete =
    !!policy.incomplete &&
    (runtimeIncomplete ||
      report.qa?.isolation === "none" ||
      (report.qa?.evidence?.storage !== "local" &&
        !!report.qa?.observations_unverified?.length) ||
      (report.qa?.journeys ?? []).some((journey: any) =>
        ["cancelled", "not_run"].includes(journey.outcome),
      ));
  const audit = (report.agent_audit ??= {
    policy_failed: false,
    policy_matches: [],
  });
  const previous = new Set(audit.qa?.policy_matches ?? []);
  const all = [
    ...new Set<string>([
      ...(audit.policy_matches ?? []).filter((id: string) => !previous.has(id)),
      ...policyMatchesQa,
    ]),
  ].sort();
  audit.policy_matches = all;
  audit.policy_failed = all.length > 0;
  audit.qa_incomplete = incomplete;
  audit.qa = {
    fail_on: {
      ...policy,
      required_checks: options.fail_on?.required_checks ?? [],
    },
    max_defects: cap,
    policy_failed: policyMatchesQa.length > 0,
    policy_matches: policyMatchesQa,
    held_back: heldBack,
    incomplete,
    eligible: pool.length,
  };
  if (heldBack.length)
    report.footer.notes.push(
      `QA held back ${heldBack.length} findings at max_defects=${cap}: ${heldBack.map((row) => row.title).join("; ")}. Raise the QA step's max_defects to display them.`,
    );
  report.findings = [
    ...report.findings.filter((finding: Finding) => finding.category !== "ux"),
    ...pool.slice(0, cap),
  ];
}
