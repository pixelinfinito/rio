import { invariant } from "./validation";
import type { Profile } from "./types";

/** Review token defaults; profile resolution records the same values. */
export const DEFAULT_TOKENS = 2_400_000;
export const DEFAULT_VERIFY_TOKENS = 320_000;

export function parseWall(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  invariant(match, "invalid wall budget");
  const duration =
    Number(match[1]) *
    { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]!;
  invariant(
    duration > 0 && duration <= 3600000,
    "review wall budget must be within one hour",
  );
  return duration;
}

/** QA has its own wall allocation; ordinary review budgets retain their cap. */
export function reviewWall(profile: Profile, mode: "fast" | "deep"): number {
  const active =
    mode === "deep"
      ? (profile.budget.deep ?? profile.budget.fast)
      : profile.budget.fast;
  const wall = parseWall(active.wall_time);
  const qa = profile.steps.some(
    (step) =>
      step.uses.split("@")[0] === "rio/qa" && step.with.enabled === true,
  );
  if (!qa) return wall;
  const value = active.qa?.wall ?? (mode === "deep" ? "90m" : "30m");
  const match = /^([1-9][0-9]*)(ms|s|m|h)$/.exec(value);
  invariant(match, "invalid QA wall budget");
  const qaWall =
    Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]!;
  const total = wall + qaWall + 5 * 60_000;
  invariant(Number.isSafeInteger(total), "QA review deadline is out of range");
  return total;
}
