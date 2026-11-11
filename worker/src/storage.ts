import type { Env, Usage, Profile } from "./types";
import type { Ledger } from "./gateway";
import { scrub } from "./redaction";
import { invariant } from "./validation";
import { DEFAULT_TOKENS, reviewWall } from "./budget";
// R2 PUT is atomic. D1 pointers are published only after the object exists.
export class Store {
  constructor(readonly env: Env) {}
  async put(key: string, value: unknown) {
    await this.env.ARTIFACTS.put(
      key,
      JSON.stringify(
        key.startsWith("snapshots/") ||
          key.endsWith("/submission.json") ||
          key.endsWith("/payload.json")
          ? value
          : scrub(value),
      ),
      { httpMetadata: { contentType: "application/json" } },
    );
    return key;
  }
  async get<T>(key: string): Promise<T> {
    const value = await this.env.ARTIFACTS.get(key);
    invariant(value, "artifact not found");
    return value.json<T>();
  }
  async event(id: string, event: string, data: unknown) {
    await this.env.DB.prepare(
      "INSERT INTO events(review_id,event,data,created_at) VALUES(?,?,?,?)",
    )
      .bind(id, event, JSON.stringify(scrub(data)), Date.now())
      .run();
  }
  async cancelled(id: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      "SELECT cancelled,deadline FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<any>();
    return !row || !!row.cancelled || Date.now() > row.deadline;
  }
  async remainingMs(id: string): Promise<number> {
    const row = await this.env.DB.prepare(
      "SELECT cancelled,deadline FROM reviews WHERE id=?",
    )
      .bind(id)
      .first<{ cancelled: number; deadline: number }>();
    return !row || row.cancelled ? 0 : Math.max(0, row.deadline - Date.now());
  }
  async selectBudget(id: string, profile: Profile, mode: "fast" | "deep") {
    const active =
      mode === "deep"
        ? (profile.budget.deep ?? profile.budget.fast)
        : profile.budget.fast;
    await this.env.DB.prepare(
      "UPDATE reviews SET token_limit=?,deadline=created_at+? WHERE id=? AND cancelled=0",
    )
      .bind(active.tokens ?? DEFAULT_TOKENS, reviewWall(profile, mode), id)
      .run();
  }
}
export class D1Ledger implements Ledger {
  constructor(
    readonly env: Env,
    readonly review: string,
  ) {}
  async remainingMs() {
    return new Store(this.env).remainingMs(this.review);
  }
  async remaining(): Promise<number> {
    const row = await this.env.DB.prepare(
      "SELECT token_limit-tokens_used-tokens_reserved AS remaining FROM reviews WHERE id=? AND cancelled=0 AND deadline>?",
    )
      .bind(this.review, Date.now())
      .first<{ remaining: number }>();
    return Math.max(0, row?.remaining ?? 0);
  }
  async reserve(actor: string, phase: string, tokens: number): Promise<string> {
    const id = crypto.randomUUID();
    // Atomic conditional reservation prevents fan-out from overspending the review.
    const update = await this.env.DB.prepare(
      "UPDATE reviews SET tokens_reserved=tokens_reserved+? WHERE id=? AND cancelled=0 AND deadline>? AND tokens_used+tokens_reserved+?<=token_limit",
    )
      .bind(tokens, this.review, Date.now(), tokens)
      .run();
    invariant(update.meta.changes === 1, "review token budget exhausted");
    await this.env.DB.prepare(
      "INSERT INTO usage(id,review_id,actor,phase,reserved,status) VALUES(?,?,?,?,?,?)",
    )
      .bind(id, this.review, actor, phase, tokens, "reserved")
      .run();
    return id;
  }
  async settle(id: string, usage: Usage): Promise<void> {
    // A completed reservation is immutable. The batch updates both accounting records atomically.
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE reviews SET tokens_reserved=tokens_reserved-(SELECT reserved FROM usage WHERE id=?),tokens_used=tokens_used+? WHERE id=? AND EXISTS(SELECT 1 FROM usage WHERE id=? AND status='reserved')",
      ).bind(id, usage.input_tokens + usage.output_tokens, this.review, id),
      this.env.DB.prepare(
        "UPDATE usage SET status='completed',input_tokens=?,output_tokens=?,cost_usd=?,model=?,cache_read_tokens=?,cache_write_tokens=?,usage_convention=?,cost_source=? WHERE id=? AND review_id=? AND status='reserved'",
      ).bind(
        usage.input_tokens,
        usage.output_tokens,
        usage.cost_usd,
        usage.model,
        usage.cache_read_input_tokens ?? null,
        usage.cache_write_input_tokens ?? null,
        usage.usage_convention ?? null,
        usage.cost_source ?? null,
        id,
        this.review,
      ),
    ]);
  }
}
