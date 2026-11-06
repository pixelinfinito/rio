import { invariant } from "./validation";
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
