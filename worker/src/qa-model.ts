import { Hono } from "hono";
import { authenticateQaRun, type QaRun } from "./qa-jobs";
import { route } from "./gateway";
import type { Env } from "./types";
import {
  boundedJson,
  providerTransport,
  responseRequest,
  responseStream,
} from "../../crates/rio-qa/controller/src/provider-transport.mjs";

class ModelError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 413 | 429 | 502 | 503,
  ) {
    super(code);
  }
}
const count = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0;
const usageOf = (value: any) => {
  const input = value?.usage?.input_tokens,
    output = value?.usage?.output_tokens;
  return count(input) && count(output) && count(input + output)
    ? { input, output }
    : null;
};

/** Atomic durable reservations survive controller crashes and runner reclaim.
 * No provider call starts until its entire upper bound has been reserved. */
async function reserve(
  env: Env,
  run: QaRun,
  cell: string,
  input: number,
  wanted: number,
) {
  const ledger = await env.DB.prepare(
    "SELECT tokens_used,tokens_reserved,exhausted FROM qa_cells WHERE run_id=? AND id=?",
  )
    .bind(run.id, cell)
    .first<{
      tokens_used: number;
      tokens_reserved: number;
      exhausted: number;
    }>();
  if (!ledger) throw new ModelError("invalid_qa_cell", 400);
  const output = Math.min(
    wanted,
    run.cell_tokens - ledger.tokens_used - ledger.tokens_reserved - input,
  );
  if (ledger.exhausted || output < 1)
    throw new ModelError("qa_token_budget_exhausted", 429);
  const id = crypto.randomUUID(),
    amount = input + output,
    now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO qa_model_usage(id,run_id,cell_id,generation,reserved,state,model,created_at)
      SELECT ?,q.id,c.id,q.generation,?,'reserved',q.model,? FROM qa_runs q
      JOIN qa_cells c ON c.run_id=q.id JOIN reviews r ON r.id=q.review_id JOIN jobs j ON j.id=q.job_id AND j.attempt=q.attempt
      WHERE q.id=? AND c.id=? AND q.generation=? AND q.token_hash=? AND q.state='running' AND q.deadline>?
      AND r.cancelled=0 AND r.deadline>? AND j.status='leased' AND j.lease_until>?
      AND c.exhausted=0 AND c.tokens_used+c.tokens_reserved+?<=q.cell_tokens RETURNING id`,
    ).bind(
      id,
      amount,
      now,
      run.id,
      cell,
      run.generation,
      run.token_hash,
      now,
      now,
      now,
      amount,
    ),
    env.DB.prepare(
      "UPDATE qa_cells SET tokens_reserved=tokens_reserved+? WHERE run_id=? AND id=? AND EXISTS(SELECT 1 FROM qa_model_usage WHERE id=? AND state='reserved')",
    ).bind(amount, run.id, cell, id),
  ]);
  if (!result[0].results.length)
    throw new ModelError("qa_token_budget_exhausted", 429);
  return { id, amount, output };
}
async function settle(
  env: Env,
  id: string,
  run: QaRun,
  cell: string,
  amount: number,
  usage: ReturnType<typeof usageOf>,
  completed: boolean,
) {
  const billed =
    completed && usage
      ? usage.input + usage.output
      : Math.max(amount, usage ? usage.input + usage.output : 0);
  const prices = JSON.parse(env.MODEL_PRICES ?? "{}")[run.model];
  const cost =
    completed &&
    usage &&
    prices &&
    Number.isFinite(prices.input) &&
    prices.input >= 0 &&
    Number.isFinite(prices.output) &&
    prices.output >= 0
      ? (usage.input * prices.input + usage.output * prices.output) / 1000000
      : null;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE qa_cells SET tokens_reserved=tokens_reserved-?,tokens_used=tokens_used+?,
      exhausted=CASE WHEN tokens_used+?>=? THEN 1 ELSE exhausted END
      WHERE run_id=? AND id=? AND EXISTS(SELECT 1 FROM qa_model_usage WHERE id=? AND state='reserved')`,
    ).bind(amount, billed, billed, run.cell_tokens, run.id, cell, id),
    env.DB.prepare(
      "UPDATE qa_model_usage SET state=?,input_tokens=?,output_tokens=?,charged_tokens=?,estimated=?,cost_usd=?,completed_at=? WHERE id=? AND state='reserved'",
    ).bind(
      completed && usage ? "completed" : "failed",
      completed && usage ? usage.input : null,
      completed && usage ? usage.output : null,
      billed,
      completed && usage ? 0 : 1,
      cost,
      Date.now(),
      id,
    ),
  ]);
}

/** Only the controller capability can use this route. The model, destination,
 * provider headers and quota come from the Worker, never from the request. */
export async function qaModel(
  request: Request,
  env: Env,
  transport: typeof fetch = fetch,
) {
  const run = await authenticateQaRun(request, env);
  const cell = request.headers.get("x-rio-cell-id") ?? "";
  if (!/^[a-f0-9]{64}$/.test(cell) || !run.configuration)
    throw new ModelError("invalid_qa_cell", 400);
  let value: any;
  try {
    value = await boundedJson(new Response(request.body), 16 * 1024 * 1024);
  } catch {
    throw new ModelError("invalid_model_request", 400);
  }
  if (value?.model !== run.model)
    throw new ModelError("invalid_model_request", 400);
  try {
    responseRequest(value);
  } catch {
    throw new ModelError("invalid_model_request", 400);
  }
  const wanted = value.max_output_tokens ?? 16384;
  if (!Number.isSafeInteger(wanted) || wanted < 1)
    throw new ModelError("invalid_output_limit", 400);
  const bound = new TextEncoder().encode(JSON.stringify(value)).length + 256;
  const provider = route(env, run.model);
  const forward = providerTransport({ ...provider, fetch: transport });
  const reservation = await reserve(env, run, cell, bound, wanted);
  const abort = new AbortController();
  const disconnected = () => abort.abort();
  request.signal.addEventListener("abort", disconnected, { once: true });
  const timeout = setTimeout(
    () => abort.abort(),
    Math.max(1, Math.min(120000, run.deadline - Date.now())),
  );
  // Cancel in-flight provider calls when the review stops, the lease expires,
  // or another runner claims the job. The final check also fences fast replies.
  let checking = false;
  const poll = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await authenticateQaRun(request, env);
    } catch {
      abort.abort();
    } finally {
      checking = false;
    }
  }, 1000);
  let usage: ReturnType<typeof usageOf> = null,
    completed = false;
  try {
    if (request.signal.aborted) abort.abort();
    abort.signal.throwIfAborted();
    const response = await forward({
      path: "/v1/responses",
      body: {
        ...value,
        max_output_tokens: reservation.output,
        stream: false,
        store: false,
      },
      signal: abort.signal,
    });
    if (!response.ok)
      throw new ModelError(
        "qa_model_upstream_error",
        response.status === 429 ? 429 : 502,
      );
    const result = await boundedJson(response);
    usage = usageOf(result);
    abort.signal.throwIfAborted();
    await authenticateQaRun(request, env);
    if (usage && usage.input + usage.output > reservation.amount)
      throw new ModelError("qa_token_budget_exhausted", 429);
    completed = true;
    return value.stream
      ? new Response(responseStream(result), {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          },
        })
      : Response.json(result, { headers: { "cache-control": "no-store" } });
  } finally {
    abort.abort();
    clearTimeout(timeout);
    clearInterval(poll);
    request.signal.removeEventListener("abort", disconnected);
    await settle(
      env,
      reservation.id,
      run,
      cell,
      reservation.amount,
      usage,
      completed,
    );
  }
}
export const qaModelRoutes = new Hono<{ Bindings: Env }>();
qaModelRoutes.onError((error, c) => {
  const unauthorized = /unauthorized/.test(error.message);
  return c.json(
    {
      error: {
        code:
          error instanceof ModelError
            ? error.code
            : unauthorized
              ? "unauthorized"
              : "qa_model_request_failed",
      },
    },
    error instanceof ModelError ? error.status : unauthorized ? 401 : 502,
  );
});
qaModelRoutes.post("/v1/responses", (c) => qaModel(c.req.raw, c.env));
