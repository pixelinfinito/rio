import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * Cloudflare's default limit on the requests one Workflow instance makes to
 * storage and the network. A deployment that declares another
 * (`limits.subrequests`) names it in `SUBREQUEST_LIMIT`. Measured on a scratch
 * Workflow: the count runs across steps and across a sleep, the instance ends
 * with "Too many API requests by single Worker invocation" at the limit, and a
 * declared limit is the one enforced.
 */
export const REQUEST_LIMIT = 10000;
// Tree searches, the one cost the models decide, stop first; then model turns,
// so what was found is still consolidated and reported. The rest is the
// reserve for that, and for the requests this count does not see.
const SEARCH_SHARE = 0.6;
const TURN_SHARE = 0.8;
/** The error of a model turn that was not started for the request budget. */
export const REQUESTS_EXHAUSTED = "review request budget exhausted";
/** The answer to a search that was not run for the request budget. */
export const SEARCH_REFUSED =
  "search was not run: this review has used its storage request budget for searching the tree. Read known paths with read_file, use graph_query, or answer from what you have";

/** The limit a deployment declares, or the platform's default. */
export function requestLimit(env: { SUBREQUEST_LIMIT?: string }): number {
  const declared = Number(env.SUBREQUEST_LIMIT);
  return Number.isInteger(declared) && declared > 0 ? declared : REQUEST_LIMIT;
}

export interface Counts {
  /** Storage requests and model calls. */
  used: number;
  /** Passes over a tree, and the searches they answered. */
  scans: number;
  searches: number;
  /** Searches answered from memory, and searches not run for the budget. */
  remembered: number;
  refused: number;
  /** Model turns not started for the budget. */
  stopped: number;
}
const KEYS = [
  "used",
  "scans",
  "searches",
  "remembered",
  "refused",
  "stopped",
] as const;
const counts = (): Counts => ({
  used: 0,
  scans: 0,
  searches: 0,
  remembered: 0,
  refused: 0,
  stopped: 0,
});
/**
 * The storage requests of one review's workflow. Passing the platform's limit
 * ends the instance where it stands, with no report, so the review counts its
 * own requests and gives up optional work first.
 */
export class Requests {
  // Counts of this run of the workflow code, and of the runs before it.
  private own = counts();
  private carried = counts();
  constructor(readonly limit = REQUEST_LIMIT) {}
  count(n = 1, what: keyof Counts = "used") {
    this.own[what] += n;
  }
  get counts(): Counts {
    const sum = counts();
    for (const key of KEYS) sum[key] = this.carried[key] + this.own[key];
    return sum;
  }
  get used(): number {
    return this.carried.used + this.own.used;
  }
  /**
   * Continues from the counts a finished step recorded. A workflow's code runs
   * again from its start after an interruption, in a new isolate; its finished
   * steps are answered from their records, and the platform's count went on.
   */
  resume(recorded: Partial<Counts>) {
    for (const key of KEYS)
      this.carried[key] = Math.max(this.carried[key], recorded[key] ?? 0);
  }
  /** Whether a search may still read the tree. */
  get searchable(): boolean {
    return this.used < SEARCH_SHARE * this.limit;
  }
  /** Whether no further model turn may start. */
  get exhausted(): boolean {
    return this.used >= TURN_SHARE * this.limit;
  }
}

/**
 * A step that records the request counts with its result, so that a run of
 * the workflow code after an interruption continues from them. An instance
 * begun before the counts were recorded has the bare result.
 */
export async function counted<T extends string>(
  step: WorkflowStep,
  requests: Requests,
  name: string,
  options: WorkflowStepConfig,
  action: () => Promise<T>,
): Promise<T> {
  let ran = false;
  const done: T | { result: T; requests: Counts } = await step.do(
    name,
    options,
    async () => {
      ran = true;
      return { result: await action(), requests: requests.counts };
    },
  );
  if (typeof done === "string") return done;
  if (!ran) requests.resume(done.requests);
  return done.result;
}

const budgets = new WeakMap<object, Requests>();
const RAW = Symbol("statement");
// The statement methods that send a query.
const QUERIES = new Set(["first", "run", "all", "raw"]);
function statement(
  inner: D1PreparedStatement,
  requests: Requests,
): D1PreparedStatement {
  return new Proxy(inner, {
    get(target, key) {
      if (key === RAW) return target;
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key === "bind")
        return (...values: unknown[]) =>
          statement(target.bind(...values), requests);
      return (...args: unknown[]) => {
        if (QUERIES.has(key as string)) requests.count();
        return value.apply(target, args);
      };
    },
  });
}
function database(inner: D1Database, requests: Requests): D1Database {
  return new Proxy(inner, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key === "prepare")
        return (sql: string) => statement(target.prepare(sql), requests);
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          requests.count();
          return target.batch(
            statements.map((s) => ((s as any)[RAW] as typeof s) ?? s),
          );
        };
      return (...args: unknown[]) => {
        requests.count();
        return value.apply(target, args);
      };
    },
  });
}
function bucket(inner: R2Bucket, requests: Requests): R2Bucket {
  return new Proxy(inner, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        requests.count();
        return value.apply(target, args);
      };
    },
  });
}
/**
 * The environment with its database and bucket counted against `requests`:
 * every query, batch and object operation made through it is one request. The
 * other bindings are passed through; their few requests (a job's queue
 * message, a runner's stop) are left to the reserve.
 */
export function metered(env: Env, requests: Requests): Env {
  const overrides: Partial<Env> = {
    DB: database(env.DB, requests),
    ARTIFACTS: bucket(env.ARTIFACTS, requests),
  };
  const proxy = new Proxy(env, {
    get: (target, key) =>
      Object.hasOwn(overrides, key)
        ? overrides[key as keyof Env]
        : Reflect.get(target, key, target),
  });
  budgets.set(proxy, requests);
  return proxy;
}
/** The budget of a metered environment. */
export function requestsOf(env: Env): Requests | undefined {
  return budgets.get(env);
}
