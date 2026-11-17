import { parse } from "yaml";
import { GitHubError, type InstallationToken } from "./github";

/** Preparation time when the repository's profile sets no `budget.prepare`. */
export const PREPARE_MS = 15 * 60 * 1000;
/** The range `budget.prepare` may take (the profile schema enforces the same). */
export const MIN_PREPARE_MS = 60 * 1000;
export const MAX_PREPARE_MS = 60 * 60 * 1000;
/** The default profile a pull request review runs under, at its merge base. */
const DEFAULT_PROFILE = ".rio/profiles/default.yaml";
/** Profiles read at most while following `extends`. */
const MAX_READS = 8;

/** Milliseconds of a `budget.prepare` value (`90s`, `30m`), or null when invalid. */
export function prepareMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([1-9][0-9]*)(s|m)$/.exec(value);
  if (!match) return null;
  const ms = Number(match[1]) * (match[2] === "s" ? 1000 : 60000);
  return ms >= MIN_PREPARE_MS && ms <= MAX_PREPARE_MS ? ms : null;
}

/** A repository path, normalized; null when it leaves the repository. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/**
 * Where a profile's `extends` may point inside the repository, in the order
 * the profile loader tries them. Only `.rio/` reaches the loader of a pull
 * request review, and built-in `rio/*` profiles set no preparation time.
 */
function parents(declaring: string, reference: string): string[] {
  const directory = declaring.split("/").slice(0, -1).join("/");
  const candidates = [normalize(`${directory}/${reference}`)];
  const explicit =
    reference.startsWith(".") ||
    reference.startsWith("/") ||
    /\.ya?ml$/.test(reference);
  if (!explicit) {
    candidates.push(normalize(reference));
    if (!reference.startsWith("rio/"))
      candidates.push(normalize(`.rio/profiles/${reference}.yaml`));
  }
  return [
    ...new Set(
      candidates.filter((c): c is string => !!c && c.startsWith(".rio/")),
    ),
  ];
}

/** A file's text at a commit, or null when it does not exist. */
async function read(
  token: InstallationToken,
  repository: string,
  commit: string,
  path: string,
): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    const file = await token.request(
      "GET",
      `/repos/${repository}/contents/${encoded}?ref=${commit}`,
    );
    if (file?.type !== "file" || typeof file.content !== "string") return null;
    const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), (c) =>
      c.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

/** What a repository's default profile at the merge base says about preparation. */
export interface Preparation {
  /** How long the review may spend being prepared. */
  time: number;
  /** `rio/prepare`'s `omit` globs: paths kept out of the snapshot. */
  omit: string[];
}

/** The `omit` globs of a profile's own `rio/prepare` step; null when it declares no steps. */
function omitted(profile: any): string[] | null {
  if (!Array.isArray(profile.steps)) return null;
  const step = profile.steps.find(
    (s: any) =>
      s && typeof s === "object" && /^rio\/prepare(@|$)/.test(String(s.uses)),
  );
  const omit = step?.with?.omit;
  return Array.isArray(omit)
    ? omit.filter((g: unknown): g is string => typeof g === "string")
    : [];
}

/**
 * What the repository's default profile at the merge base says about
 * preparing a pull request review: `budget.prepare` (how long it may take)
 * and `rio/prepare`'s `omit` (what stays out of the snapshot), each from the
 * nearest profile of the `extends` chain that sets it. A child's `steps`
 * replace its parent's, so the first profile that declares steps decides
 * `omit`. The review runs under the same profile, which the runner
 * validates; anything this cannot read or understand keeps the defaults, so
 * a broken profile fails the review there, not here.
 */
export async function preparation(
  token: InstallationToken,
  repository: string,
  commit: string,
): Promise<Preparation> {
  let path = DEFAULT_PROFILE;
  const seen = new Set<string>([path]);
  let reads = 1;
  let time: number | null = null;
  let omit: string[] | null = null;
  try {
    let text = await read(token, repository, commit, path);
    while (text !== null && (time === null || omit === null)) {
      const profile = parse(text, { maxAliasCount: 100 });
      if (!profile || typeof profile !== "object") break;
      const budget = (profile as any).budget;
      if (
        time === null &&
        budget &&
        typeof budget === "object" &&
        "prepare" in budget
      )
        time = prepareMs(budget.prepare) ?? PREPARE_MS;
      omit ??= omitted(profile);
      const reference = (profile as any).extends;
      if (typeof reference !== "string") break;
      text = null;
      for (const candidate of parents(path, reference)) {
        if (seen.has(candidate) || reads >= MAX_READS) break;
        seen.add(candidate);
        reads++;
        text = await read(token, repository, commit, candidate);
        if (text !== null) {
          path = candidate;
          break;
        }
      }
    }
  } catch {
    // GitHub unavailable or a profile that does not parse: the defaults apply.
  }
  return { time: time ?? PREPARE_MS, omit: omit ?? [] };
}

/** How long a pull request review may spend being prepared (see `preparation`). */
export async function preparationTime(
  token: InstallationToken,
  repository: string,
  commit: string,
): Promise<number> {
  return (await preparation(token, repository, commit)).time;
}
