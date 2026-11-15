import type { Hypothesis, SecurityCoverage } from "./types";

/** One review of an agent: the alias a profile gave a model, and the model. */
export interface ReviewModel {
  alias: string;
  model: string;
}
/**
 * The models an agent reviews under. A declaration's `models` lists aliases:
 * the agent reviews the same code once under each alias the profile defines,
 * and what the reviews raise is combined before verification. An alias the
 * profile does not define is skipped, and so is one that names a model already
 * listed, so a profile can name a second model that only some of its children
 * define. Without `models`, or with none of them defined, the agent reviews
 * once: under its `model` alias or, undeclared, the alias of its own name,
 * and under `default` when the profile does not define that alias.
 */
export function reviewModels(
  agent: string,
  config: { model?: string; models?: unknown },
  models: Record<string, string>,
): ReviewModel[] {
  const runs: ReviewModel[] = [];
  for (const alias of Array.isArray(config.models) ? config.models : [])
    if (
      typeof alias === "string" &&
      models[alias] &&
      !runs.some((r) => r.model === models[alias])
    )
      runs.push({ alias, model: models[alias] });
  if (runs.length) return runs;
  const alias = models[config.model ?? agent]
    ? (config.model ?? agent)
    : "default";
  return models[alias] ? [{ alias, model: models[alias] }] : [];
}
const WORD = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const words = (h: Hypothesis) =>
  new Set(
    (`${h.message} ${h.trigger}`.match(WORD) ?? []).map((w) => w.toLowerCase()),
  );
/** The share of the shorter statement's words the two statements must share. */
const SHARED_WORDS = 0.3;
/**
 * Whether two hypotheses that two models raised on the same code state one
 * issue: the same file, overlapping lines, the same catalog item, and three
 * in ten of the words of the shorter statement found in the other. Two issues
 * on the same lines usually share fewer words, and one issue stated twice
 * usually names the same identifiers.
 *
 * Measured on the comments of three reviews each of 40 pull requests, where a
 * benchmark's judge had matched comments to reference comments: of 171 pairs
 * of comments on one file that matched the same reference the rule joins 155,
 * and it joins 4 pairs that matched different references.
 */
export function sameIssue(a: Hypothesis, b: Hypothesis): boolean {
  if (
    a.location.path !== b.location.path ||
    a.location.line_start > b.location.line_end ||
    b.location.line_start > a.location.line_end ||
    (a.catalog_item ?? "") !== (b.catalog_item ?? "")
  )
    return false;
  const x = words(a),
    y = words(b);
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  const shorter = Math.min(x.size, y.size);
  return shorter > 0 && shared >= SHARED_WORDS * shorter;
}
/** What one model's review of an agent raised. */
export interface Raised {
  alias: string;
  hypotheses: Hypothesis[];
}
/**
 * Combines what an agent's reviews raised, in the order of its models, into
 * `into`. A hypothesis another model already raised (the same id, or the same
 * issue by `sameIssue`) is not added: the earlier statement stands, and
 * `under` names every model that raised it. Two hypotheses of one model are
 * never joined. Returns the hypotheses added.
 */
export function combineRaised(
  into: Hypothesis[],
  reviews: Raised[],
  under?: Map<string, string[]>,
): Hypothesis[] {
  const added: { alias: string; hypothesis: Hypothesis }[] = [];
  for (const { alias, hypotheses } of reviews)
    for (const h of hypotheses) {
      const twin =
        into.find((x) => x.id === h.id) ??
        added.find((x) => x.alias !== alias && sameIssue(x.hypothesis, h))
          ?.hypothesis;
      if (!twin) {
        into.push(h);
        added.push({ alias, hypothesis: h });
      }
      const id = (twin ?? h).id;
      const aliases = under?.get(id) ?? [];
      if (under && !aliases.includes(alias)) under.set(id, [...aliases, alias]);
    }
  return added.map((x) => x.hypothesis);
}
/**
 * The coverage of several security reviews of one change: an item is assessed
 * when any review assessed it, and unassessed, for the first review's reason,
 * when none did.
 */
export function combineCoverage(
  applicable: { id: string; title: string }[],
  reviews: SecurityCoverage[],
): SecurityCoverage {
  if (reviews.length === 1) return reviews[0];
  const done = new Set(reviews.flatMap((c) => c.assessed.map((a) => a.item)));
  const unassessed = reviews.flatMap((c) => c.unassessed);
  return {
    ...reviews[0],
    assessed: applicable
      .filter((i) => done.has(i.id))
      .map((i) => ({ item: i.id, title: i.title, findings: [] })),
    unassessed: applicable
      .filter((i) => !done.has(i.id))
      .map((i) => ({
        item: i.id,
        title: i.title,
        reason:
          unassessed.find((u) => u.item === i.id)?.reason ?? "no_evidence",
      })),
  };
}
