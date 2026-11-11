import type { Verified } from "./consolidate";
import type { Store } from "./storage";
import type { Hypothesis } from "./types";

/** A hypothesis whose verification ran to its end, with its votes that did not complete. */
export interface Settled {
  verified: Verified;
  incomplete: number;
}
/**
 * What a review's agents raised and its verifier settled, stored as it happens.
 * A review that stops early reports from here as well as from memory: a run
 * replayed after the deadline stops at its first step, with none of it in memory.
 */
export class Progress {
  constructor(
    private readonly store: Store,
    private readonly review: string,
  ) {}
  private prefix(kind: "raised" | "settled") {
    return `reviews/${this.review}/progress/${kind}/`;
  }
  /** One list per source (step and agent); a replay rewrites the same list. */
  async raised(source: string, hypotheses: Hypothesis[]) {
    if (hypotheses.length)
      await this.store.put(
        `${this.prefix("raised")}${source}.json`,
        hypotheses,
      );
  }
  async settled(entry: Settled) {
    await this.store.put(
      `${this.prefix("settled")}${entry.verified.hypothesis.id}.json`,
      entry,
    );
  }
  async load(): Promise<{ raised: Hypothesis[]; settled: Settled[] }> {
    const read = async <T>(kind: "raised" | "settled") => {
      const values: T[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.store.env.ARTIFACTS.list({
          prefix: this.prefix(kind),
          cursor,
        });
        for (const object of page.objects)
          values.push(await this.store.get<T>(object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return values;
    };
    return {
      raised: (await read<Hypothesis[]>("raised")).flat(),
      settled: await read<Settled>("settled"),
    };
  }
}
