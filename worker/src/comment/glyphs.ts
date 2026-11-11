import type { Finding } from "../types";
import { plain } from "./text";

// GFM has no text color: color comes only from emoji, so each emoji means
// exactly one thing everywhere rio writes on a pull request
// (pr-comment-format "One glyph, one meaning").
export const GLYPH = {
  error: "🔴",
  warning: "🟠",
  info: "🔵",
  reproduced: "🧪",
  proven: "📐",
  plausible: "❔",
  // Fixed or passed; never on an open finding.
  done: "✅",
  // A failed QA cell or trace step.
  failed: "❌",
  dismissed: "💤",
  regression: "↩️",
  advice: "💡",
  qa: "🧭",
  rio: "🌊",
} as const;

export const SEVERITY_WORD: Record<string, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};
export const CATEGORY_WORD: Record<string, string> = {
  defect: "defect",
  risk: "risk",
  security: "security",
  ux: "QA",
};

export function severityGlyph(severity: string): string {
  return (GLYPH as Record<string, string>)[severity] ?? GLYPH.info;
}

/** What proves the finding: the named tool or probe, never a bare checkmark. */
export function prover(f: Finding): string {
  const source = f.source as { tool?: string; agent?: string };
  if (f.qa) return f.rule_id;
  if (source.tool) return source.tool;
  if (f.verification?.voters)
    return `blind verification, ${f.verification.agreeing} of ${f.verification.voters}`;
  return source.agent ? `the ${source.agent} agent` : "the review";
}

/** The proof phrase of the metadata line (pr-comment-format "Proof wording"). */
export function proof(f: Finding): string {
  switch (f.evidence_level) {
    case "reproduced":
      return f.qa
        ? `${GLYPH.reproduced} reproduced in the browser`
        : `${GLYPH.reproduced} reproduced by experiment`;
    case "static_proven":
      return `${GLYPH.proven} proven by \`${plain(prover(f), 120)}\``;
    default:
      return `${GLYPH.plausible} plausible`;
  }
}

/** The short proof of a summary row. */
export function shortProof(f: Finding): string {
  switch (f.evidence_level) {
    case "reproduced":
      return `${GLYPH.reproduced} reproduced`;
    case "static_proven":
      return `${GLYPH.proven} ${plain(f.qa ? "QA probe" : prover(f), 60)}`;
    default:
      return `${GLYPH.plausible} plausible`;
  }
}
