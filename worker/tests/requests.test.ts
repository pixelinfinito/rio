import { env } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  REQUEST_LIMIT,
  Requests,
  metered,
  recording,
  requestLimit,
  requestsOf,
} from "../src/requests";
import { Store } from "../src/storage";
import type { Env, ModelResponse } from "../src/types";
import { modelStep } from "../src/workflow";

const runtime = env as Env;
// Durable step results, as a workflow keeps them across runs of its code.
const durable = (records = new Map<string, unknown>()) =>
  ({
    records,
    step: {
      // With or without options, as the platform takes a step.
      do: async (name: string, ...rest: unknown[]) => {
        const action = rest.find((part) => typeof part === "function") as (
          context: unknown,
        ) => Promise<unknown>;
        if (!records.has(name))
          records.set(name, structuredClone(await action({ attempt: 1 })));
        return records.get(name);
      },
      sleep: async (name: string) => void records.set(name, "slept"),
      waitForEvent: async (name: string, options: { type: string }) => {
        records.set(name, options.type);
        return { type: options.type, payload: { key: name } };
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
    const result = await recording(workflow.step, first).do(
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
    await recording(workflow.step, first).do("tools-b", {}, async () => {
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
    const step = recording(workflow.step, again);
    expect(
      await step.do("model-a", {}, async () => {
        ran.push("model-a");
        return "other";
      }),
    ).toBe("key-a");
    expect(again.used).toBe(40);
    expect(again.searchable).toBe(true);
    expect(
      await step.do("tools-b", {}, async () => {
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
    await step.do("model-c", {}, async () => "key-c");
    expect((workflow.records.get("model-c") as any).requests.used).toBe(610);
  });

  it("records the counts of every step, whatever it returns", async () => {
    // The steps between model turns ask storage too: a wait for a runner
    // reads its job, the report writes its rows. A run after an interruption
    // that knew only the model steps' counts would search and call models
    // past the budget.
    const workflow = durable();
    const first = new Requests(1000);
    const step = recording(workflow.step, first);
    expect(
      await step.do("model-a", {}, async () => {
        first.count(100);
        return "key-a";
      }),
    ).toBe("key-a");
    // Without options, with the step's context, and with every kind of result.
    expect(
      await step.do("load", async (context) => {
        first.count(450);
        return { deadline: 7, attempt: context.attempt };
      }),
    ).toEqual({ deadline: 7, attempt: 1 });
    expect(
      await step.do("spare", async () => {
        first.count(50);
        return 12;
      }),
    ).toBe(12);
    expect(
      await step.do("rows", async () => {
        first.count(20);
        return [{ requests: 1 }];
      }),
    ).toEqual([{ requests: 1 }]);
    expect(
      await step.do("written", async () => {
        first.count(180);
      }),
    ).toBeUndefined();
    expect(await step.do("nothing", async () => null)).toBeNull();
    expect(first.used).toBe(800);
    // The waits are the platform's own.
    await step.sleep("pause", "1 second");
    expect(
      (await step.waitForEvent("wait", { type: "job-1" })).payload,
    ).toEqual({ key: "wait" });
    expect([workflow.records.get("pause"), workflow.records.get("wait")]).toEqual(
      ["slept", "job-1"],
    );

    const again = new Requests(1000);
    const replayed = recording(workflow.step, again);
    const never = async (): Promise<never> => {
      throw new Error("a finished step ran again");
    };
    expect(await replayed.do("model-a", {}, never)).toBe("key-a");
    expect(again.used).toBe(100);
    expect(await replayed.do("load", never)).toEqual({ deadline: 7, attempt: 1 });
    // The plain step's requests are known again: searches stop here, as
    // they had in the first run.
    expect(again.used).toBe(550);
    expect(again.searchable).toBe(true);
    expect(await replayed.do("spare", never)).toBe(12);
    expect(again.searchable).toBe(false);
    expect(await replayed.do("rows", never)).toEqual([{ requests: 1 }]);
    expect(await replayed.do("written", never)).toBeUndefined();
    expect(await replayed.do("nothing", never)).toBeNull();
    expect(again.counts).toEqual(first.counts);
    expect(again.exhausted).toBe(true);
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
    // Bare results, one of them an object with a field of the record's name.
    const old = { requests: { used: 3 }, deadline: 9 };
    const workflow = durable(
      new Map<string, unknown>([
        ["model-old", "key"],
        ["load", old],
        ["rows", [1, 2]],
        ["written", undefined],
      ]),
    );
    const requests = new Requests(1000);
    const step = recording(workflow.step, requests);
    expect(await step.do("model-old", {}, async () => "new")).toBe("key");
    expect(await step.do("load", async () => ({}))).toEqual(old);
    expect(await step.do("rows", async () => [])).toEqual([1, 2]);
    expect(await step.do("written", async () => {})).toBeUndefined();
    expect(requests.used).toBe(0);
  });
});

describe("a model call's step", () => {
  const reply = (text: string) => ({ text }) as unknown as ModelResponse;
  const store = new Store(runtime);

  it("stores the reply, and answers a later attempt with it", async () => {
    const key = `reviews/${crypto.randomUUID()}/models/agent.json`;
    const requests = new Requests(1000);
    let asked = 0;
    const action = modelStep(store, requests, key, async () => {
      asked++;
      return reply(`answer ${asked}`);
    });
    expect(await action({ attempt: 1 })).toBe(key);
    expect(await store.get(key)).toEqual({ text: "answer 1" });
    // The platform failed the attempt after the reply was stored: the model
    // is not asked again, and no request of a turn is counted.
    expect(await action({ attempt: 2 })).toBe(key);
    // An engine that passes no attempt number is answered the same way.
    expect(await action()).toBe(key);
    expect([asked, requests.used]).toEqual([1, 1]);
    expect(await store.get(key)).toEqual({ text: "answer 1" });
  });

  it("asks the model on a later attempt that finds no reply", async () => {
    const key = `reviews/${crypto.randomUUID()}/models/agent.json`;
    const requests = new Requests(1000);
    const action = modelStep(store, requests, key, async () => reply("late"));
    expect(await store.has(key)).toBe(false);
    expect(await action({ attempt: 2 })).toBe(key);
    expect(await store.get(key)).toEqual({ text: "late" });
    expect(requests.used).toBe(1);
  });

  it("ends the step on the call's own failure", async () => {
    const key = `reviews/${crypto.randomUUID()}/models/agent.json`;
    const requests = new Requests(1000);
    const action = modelStep(store, requests, key, async () => {
      throw new Error("provider failed (400)");
    });
    const error = await action({ attempt: 1 }).catch((error) => error);
    // The platform retries no step that ends with this error.
    expect(error.name).toBe("NonRetryableError");
    expect(error.message).toBe("provider failed (400)");
    expect(await store.has(key)).toBe(false);
  });

  it("answers a budget's refusal as the step's result", async () => {
    // Nothing was sent or charged: the step did not fail, and the platform
    // records no failed attempt for a review that only ran out of budget.
    for (const message of [
      "token budget exhausted",
      "review token budget exhausted",
      "review wall budget exhausted",
    ]) {
      const key = `reviews/${crypto.randomUUID()}/models/agent.json`;
      const action = modelStep(store, new Requests(1000), key, async () => {
        throw new Error(message);
      });
      expect(await action({ attempt: 1 }), message).toEqual({
        refused: message,
      });
      expect(await store.has(key)).toBe(false);
    }
    // Any other message that names a budget is the call's failure.
    const other = modelStep(store, new Requests(1000), "k", async () => {
      throw new Error("provider failed (400): token budget exhausted for key");
    });
    await expect(other({ attempt: 1 })).rejects.toThrow("provider failed");
  });

  it("refuses a turn once the review's requests are spent", async () => {
    const key = `reviews/${crypto.randomUUID()}/models/agent.json`;
    const requests = new Requests(10);
    requests.count(8);
    const never = async () => {
      throw new Error("the model was asked");
    };
    expect(await modelStep(store, requests, key, never)({ attempt: 1 })).toBe(
      "",
    );
    expect(requests.counts).toMatchObject({ used: 8, stopped: 1 });
  });
});
