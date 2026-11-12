import { env } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  REQUEST_LIMIT,
  Requests,
  counted,
  metered,
  requestLimit,
  requestsOf,
} from "../src/requests";
import { Store } from "../src/storage";
import type { Env } from "../src/types";

const runtime = env as Env;
// Durable step results, as a workflow keeps them across runs of its code.
const durable = (records = new Map<string, unknown>()) =>
  ({
    records,
    step: {
      do: async (name: string, _: unknown, action: () => Promise<unknown>) => {
        if (!records.has(name))
          records.set(name, structuredClone(await action()));
        return records.get(name);
      },
    } as unknown as WorkflowStep,
  }) as const;

describe("a review's request budget", () => {
  it("takes the limit a deployment declares, or the platform's default", () => {
    expect(REQUEST_LIMIT).toBe(10000);
    expect(requestLimit({})).toBe(10000);
    expect(requestLimit({ SUBREQUEST_LIMIT: "50000" })).toBe(50000);
    for (const bad of ["", "0", "-5", "1.5", "many", "Infinity"])
      expect(requestLimit({ SUBREQUEST_LIMIT: bad }), bad).toBe(10000);
  });

  it("stops searches before model turns, and both before the platform's limit", () => {
    const requests = new Requests(1000);
    expect([requests.searchable, requests.exhausted]).toEqual([true, false]);
    requests.count(599);
    expect([requests.searchable, requests.exhausted]).toEqual([true, false]);
    requests.count();
    expect([requests.searchable, requests.exhausted]).toEqual([false, false]);
    requests.count(199);
    expect(requests.exhausted).toBe(false);
    requests.count();
    expect(requests.exhausted).toBe(true);
    // A fifth of the limit is left for the report and what is not counted.
    expect(requests.used).toBe(800);
  });

  it("counts every query, batch and object operation of a metered environment", async () => {
    const requests = new Requests();
    const counting = metered(runtime, requests);
    expect(requestsOf(counting)).toBe(requests);
    expect(requestsOf(runtime)).toBeUndefined();
    // The other bindings are the environment's own.
    expect(counting.RIO_VERSION).toBe(runtime.RIO_VERSION);
    expect(counting.REVIEWS).toBe(runtime.REVIEWS);

    const one = counting.DB.prepare("SELECT ? AS n");
    expect(requests.used).toBe(0);
    expect(await one.bind(7).first<{ n: number }>()).toEqual({ n: 7 });
    expect((await one.bind(8).all<{ n: number }>()).results).toEqual([
      { n: 8 },
    ]);
    expect(await one.bind(9).raw()).toEqual([[9]]);
    await one.bind(1).run();
    expect(requests.used).toBe(4);
    // A batch is one request, whatever it holds.
    const batch = await counting.DB.batch<{ n: number }>([
      one.bind(1),
      one.bind(2),
      one.bind(3),
    ]);
    expect(batch.map((b) => b.results[0].n)).toEqual([1, 2, 3]);
    expect(requests.used).toBe(5);

    await counting.ARTIFACTS.put("requests/object", "content");
    expect(
      await (await counting.ARTIFACTS.get("requests/object"))!.text(),
    ).toBe("content");
    expect((await counting.ARTIFACTS.head("requests/object"))!.size).toBe(7);
    await counting.ARTIFACTS.delete("requests/object");
    expect(requests.used).toBe(9);

    // The code a review runs on it is counted without knowing.
    const store = new Store(counting);
    const key = await store.put("requests/stored.json", { a: 1 });
    expect(await store.get(key)).toEqual({ a: 1 });
    expect(requests.used).toBe(11);
  });

  it("continues from the counts its finished steps recorded", async () => {
    const workflow = durable();
    const first = new Requests(1000);
    const result = await counted(
      workflow.step,
      first,
      "model-a",
      {},
      async () => {
        first.count(40);
        first.count(1, "scans");
        first.count(3, "searches");
        return "key-a";
      },
    );
    expect(result).toBe("key-a");
    await counted(workflow.step, first, "tools-b", {}, async () => {
      first.count(500);
      first.count(2, "refused");
      return "done-b";
    });
    expect(first.counts).toEqual({
      used: 540,
      scans: 1,
      searches: 3,
      remembered: 0,
      refused: 2,
      stopped: 0,
    });

    // The workflow's code runs again from its start in a new isolate: the
    // steps are answered from their records and nothing is done twice.
    const again = new Requests(1000);
    const ran: string[] = [];
    expect(
      await counted(workflow.step, again, "model-a", {}, async () => {
        ran.push("model-a");
        return "other";
      }),
    ).toBe("key-a");
    expect(again.used).toBe(40);
    expect(again.searchable).toBe(true);
    expect(
      await counted(workflow.step, again, "tools-b", {}, async () => {
        ran.push("tools-b");
        return "other";
      }),
    ).toBe("done-b");
    expect(ran).toEqual([]);
    expect(again.counts).toEqual(first.counts);
    // What this run does itself is added to what it took over.
    again.count(70);
    expect(again.used).toBe(610);
    expect(again.searchable).toBe(false);
    await counted(workflow.step, again, "model-c", {}, async () => "key-c");
    expect((workflow.records.get("model-c") as any).requests.used).toBe(610);
  });

  it("takes the highest recorded count when steps finish out of order", async () => {
    // Agents run side by side: a step that began early can finish after one
    // that counted more.
    const requests = new Requests(1000);
    requests.resume({ used: 300, scans: 2 });
    requests.resume({ used: 120, scans: 1, refused: 1 });
    expect(requests.counts).toMatchObject({ used: 300, scans: 2, refused: 1 });
  });

  it("answers the step of an instance begun before counts were recorded", async () => {
    const workflow = durable(new Map<string, unknown>([["model-old", "key"]]));
    const requests = new Requests(1000);
    expect(
      await counted(
        workflow.step,
        requests,
        "model-old",
        {},
        async () => "new",
      ),
    ).toBe("key");
    expect(requests.used).toBe(0);
  });
});
