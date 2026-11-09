import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HostedSeeds, SEED_PART_BYTES, seedManifest } from "../src/qa-seeds";
import { app } from "../src/index";
import { hash as tokenHash } from "../src/validation";
import type { Env } from "../src/types";
import { allMigrations } from "./fixtures";
import { HostedSeedTransport } from "../../crates/rio-qa/controller/src/hosted-seed-transport.mjs";

const runtime = env as Env;
const bytes = (value: string) => new TextEncoder().encode(value);
const digest = (value: Uint8Array) => bytesToHex(blake3(value));
const fp = (letter = "a") => ({
  version: 2,
  fingerprint: letter.repeat(64),
  datastores: { shop: "sqlite" },
});
const data = (db = "synthetic database", files = "synthetic files") => ({
  shop: bytes(db),
  "path-0": bytes(files),
});
function manifest(fingerprint = fp(), values = data()) {
  return {
    version: 1,
    fingerprint,
    created_at_ms: Date.now(),
    archives: Object.entries(values).map(([name, value]) => ({
      name,
      kind: name === "shop" ? "sqlite" : "files",
      hash: digest(value),
      bytes: value.length,
      parts: [{ hash: digest(value), bytes: value.length }],
    })),
  };
}
async function upload(
  store: HostedSeeds,
  fingerprint = fp(),
  values = data(),
  max_size?: number,
) {
  const lease = await store.acquire({
    fingerprint: fingerprint.fingerprint,
    max_size,
  });
  for (const value of Object.values(values)) {
    await store.renew(lease.id, { part: digest(value) });
    if (!(await store.hasPart(digest(value), value.length)))
      await store.putPart(digest(value), value, lease.id);
  }
  const document = manifest(fingerprint, values);
  await store.publish(document, lease.id);
  return { lease, document };
}
async function objects() {
  return (
    await runtime.ARTIFACTS.list({ prefix: "seeds/", limit: 1000 })
  ).objects.map((object) => object.key);
}
const owner = "test-owner-token-at-least-32-characters",
  other = "other-qa-tenant-token-at-least-32-chars";
function request(
  path: string,
  method = "GET",
  value?: any,
  token = owner,
  lease?: string,
  binary = false,
) {
  return app.request(
    `https://rio.test/v1/qa/seeds${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(lease ? { "rio-seed-lease": lease } : {}),
      },
      body:
        value === undefined
          ? undefined
          : binary
            ? value
            : JSON.stringify(value),
    },
    runtime,
  );
}
beforeAll(async () => {
  await applyD1Migrations(runtime.DB, allMigrations);
  await runtime.DB.prepare(
    "INSERT INTO api_tokens(hash,tenant,scope,expires_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(tokenHash(other), "other", "qa:seeds", Date.now() + 3600000)
    .run();
});
beforeEach(async () => {
  await runtime.DB.batch(
    [
      "qa_seed_heads",
      "qa_seed_versions",
      "qa_seed_leases",
      "qa_seed_parts",
      "qa_seed_garbage",
    ].map((table) => runtime.DB.prepare(`DELETE FROM ${table}`)),
  );
  const keys = await objects();
  if (keys.length) await runtime.ARTIFACTS.delete(keys);
});

describe("hosted seed protocol", () => {
  it("verifies an archive spanning an 8 MiB part boundary before committing it", async () => {
    const store = new HostedSeeds(runtime, "owner");
    const content = new Uint8Array(SEED_PART_BYTES + 19).fill(7);
    const chunks = [
      content.subarray(0, SEED_PART_BYTES),
      content.subarray(SEED_PART_BYTES),
    ];
    const document = {
      version: 1,
      fingerprint: fp(),
      created_at_ms: Date.now(),
      archives: [
        {
          name: "shop",
          kind: "sqlite",
          bytes: content.length,
          hash: digest(content),
          parts: chunks.map((chunk) => ({
            hash: digest(chunk),
            bytes: chunk.length,
          })),
        },
      ],
    };
    const [firstPart, finalPart] = document.archives[0].parts;
    const lease = await store.acquire({ fingerprint: fp().fingerprint });
    await store.renew(lease.id, { part: firstPart.hash });
    await store.putPart(firstPart.hash, chunks[0], lease.id);
    await expect(store.publish(document, lease.id)).rejects.toMatchObject({
      reason: "seed_corrupt",
    });
    expect(await store.manifest(fp().fingerprint, lease.id)).toBeNull();
    await store.renew(lease.id, { part: finalPart.hash });
    await store.putPart(finalPart.hash, chunks[1], lease.id);
    await store.publish(document, lease.id);
    expect(await store.manifest(fp().fingerprint, lease.id)).toEqual(document);
    expect((await store.getPart(firstPart.hash, lease.id)).length).toBe(
      SEED_PART_BYTES,
    );
    expect(await store.getPart(finalPart.hash, lease.id)).toEqual(chunks[1]);
  }, 60000);

  it("round trips the actual controller transport through authenticated Worker routes and R2", async () => {
    const transport = new HostedSeedTransport({
      endpoint: "https://rio.test",
      tenant: "owner",
      capability: owner,
      fetchImpl: (url: string, init: RequestInit) => {
        expect(init.redirect).toBe("error");
        // workerd's Request constructor lacks Node fetch's redirect:error.
        // Dispatch directly to the router; it never follows a redirect.
        return app.request(url, { ...init, redirect: "manual" }, runtime);
      },
    });
    const prefix = "seeds/owner/",
      lease = await transport.lease(prefix, fp().fingerprint);
    try {
      for (const value of Object.values(data())) {
        const part = { hash: digest(value), bytes: value.length },
          key = prefix + "objects/" + part.hash;
        await lease.retain(part.hash);
        expect(await transport.hasPart(key, part)).toBe(false);
        await transport.putPart(key, part, value);
        expect(await transport.hasPart(key, part)).toBe(true);
      }
      const document = manifest();
      await transport.publish(prefix, document, 2 * 1024 ** 3);
      expect(
        await transport.manifest(prefix + fp().fingerprint + "/manifest.json"),
      ).toEqual(document);
      expect(
        new Uint8Array(
          await transport.getPart(prefix + "objects/" + digest(data().shop)),
        ),
      ).toEqual(data().shop);
      expect(await transport.prune(prefix, 0)).toEqual([]);
      await expect(
        transport.manifest(
          "seeds/other/" + fp().fingerprint + "/manifest.json",
        ),
      ).rejects.toThrow("seed_store_unavailable");
    } finally {
      await lease.close();
    }
    expect(await transport.prune(prefix, 0)).toEqual([fp().fingerprint]);
    expect(await objects()).toEqual([]);
  });

  it("a lower per-run quota does not invalidate a seed still usable by other runs", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      first = await upload(store);
    const small = await store.acquire({
      fingerprint: fp().fingerprint,
      max_size: 1,
    });
    await expect(
      store.manifest(fp().fingerprint, small.id),
    ).rejects.toMatchObject({ reason: "seed_too_large" });
    expect(await store.manifest(fp().fingerprint, first.lease.id)).toEqual(
      first.document,
    );
  });

  it("authenticates every endpoint and keeps parts, manifests and leases tenant scoped", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      uploaded = await upload(store);
    expect(
      (
        await request(
          "/leases",
          "POST",
          { fingerprint: fp().fingerprint },
          "unauthorized",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          `/manifests/${fp().fingerprint}`,
          "GET",
          undefined,
          other,
          uploaded.lease.id,
        )
      ).status,
    ).toBe(400);
    const secondLease = await (
      await request("/leases", "POST", { fingerprint: fp().fingerprint }, other)
    ).json<any>();
    expect(
      (
        await request(
          `/manifests/${fp().fingerprint}`,
          "GET",
          undefined,
          other,
          secondLease.id,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/parts/${digest(data().shop)}`,
          "GET",
          undefined,
          other,
          secondLease.id,
        )
      ).status,
    ).toBe(400);
    expect(
      await (
        await request(
          `/parts/${digest(data().shop)}/status?bytes=${data().shop.length}`,
          "GET",
          undefined,
          other,
        )
      ).json(),
    ).toEqual({ present: false });
    expect(
      (
        await request(
          `/manifests/${fp().fingerprint}`,
          "GET",
          undefined,
          owner,
          uploaded.lease.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (await objects()).every((key) => key.startsWith("seeds/owner/")),
    ).toBe(true);
  });

  it("publishes only after all part sizes, hashes and complete archive hashes verify", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      lease = await store.acquire({ fingerprint: fp().fingerprint });
    const document = manifest();
    await expect(store.publish(document, lease.id)).rejects.toMatchObject({
      reason: "seed_corrupt",
    });
    expect(await store.manifest(fp().fingerprint, lease.id)).toBeNull();
    const value = data().shop;
    await store.renew(lease.id, { part: digest(value) });
    await expect(
      store.putPart(digest(value), bytes("corrupt"), lease.id),
    ).rejects.toMatchObject({ reason: "seed_corrupt" });
    expect(await objects()).toEqual([]);
    for (const value of Object.values(data())) {
      await store.renew(lease.id, { part: digest(value) });
      await store.putPart(digest(value), value, lease.id);
    }
    const wrongArchive = structuredClone(document);
    wrongArchive.archives[0].hash = "f".repeat(64);
    await expect(store.publish(wrongArchive, lease.id)).rejects.toMatchObject({
      reason: "seed_corrupt",
    });
    expect(await store.manifest(fp().fingerprint, lease.id)).toBeNull();
    await store.publish(document, lease.id);
    expect(await store.manifest(fp().fingerprint, lease.id)).toEqual(document);
  });

  it("reuses unchanged archives across fingerprints and enforces the independent seed quota", async () => {
    const store = new HostedSeeds(runtime, "owner");
    const first = await upload(store);
    await store.release(first.lease.id);
    const second = await upload(
      store,
      fp("b"),
      data("synthetic database", "new files"),
    );
    expect(
      (await objects()).filter((key) => key.includes("/objects/")),
    ).toHaveLength(3);
    expect(await store.getPart(digest(data().shop), second.lease.id)).toEqual(
      data().shop,
    );
    const small = await store.acquire({
      fingerprint: fp("c").fingerprint,
      max_size: 10,
    });
    await expect(
      store.publish(manifest(fp("c")), small.id),
    ).rejects.toMatchObject({
      reason: "seed_too_large",
      details: { largest_archive: "shop", max_bytes: 10 },
    });
    expect(await store.manifest(fp("c").fingerprint, small.id)).toBeNull();
    const oversized = manifest();
    oversized.archives[0].parts[0].bytes = SEED_PART_BYTES + 1;
    expect(() => seedManifest(oversized, 2 ** 31)).toThrow("seed_corrupt");
  });

  it("an interrupted upload stays invisible, and its parts are kept only while leased", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      lease = await store.acquire({ fingerprint: fp().fingerprint });
    const value = data().shop;
    await store.renew(lease.id, { part: digest(value) });
    await store.putPart(digest(value), value, lease.id);
    expect(await store.manifest(fp().fingerprint, lease.id)).toBeNull();
    await store.prune(0);
    expect(await store.hasPart(digest(value), value.length)).toBe(true);
    await runtime.DB.prepare("UPDATE qa_seed_leases SET expires_at=0").run();
    await store.prune(0);
    expect(await objects()).toEqual([]);
    await expect(store.renew(lease.id)).rejects.toMatchObject({
      reason: "seed_lease_expired",
    });
  });

  it("keeps the newest snapshots, shared archives, active jobs and pending reused parts", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      first = await upload(store);
    const second = await upload(
      store,
      fp("b"),
      data("synthetic database", "new files"),
    );
    await store.release(second.lease.id);
    await runtime.DB.prepare(
      "UPDATE qa_seed_heads SET created_at=1 WHERE fingerprint=?",
    )
      .bind(fp().fingerprint)
      .run();
    expect(await store.prune(1)).toEqual([]);
    const pending = await store.acquire({ fingerprint: fp("c").fingerprint });
    await store.renew(pending.id, { part: digest(data()["path-0"]) });
    await store.release(first.lease.id);
    expect(await store.prune(1)).toEqual([fp().fingerprint]);
    expect(
      await store.hasPart(digest(data()["path-0"]), data()["path-0"].length),
    ).toBe(true);
    await store.release(pending.id);
    await store.prune(1);
    expect(
      await store.hasPart(digest(data()["path-0"]), data()["path-0"].length),
    ).toBe(false);
    expect(await store.hasPart(digest(data().shop), data().shop.length)).toBe(
      true,
    );
    expect(
      (await objects()).filter((key) => key.endsWith("manifest.json")),
    ).toHaveLength(1);
  });

  it("detects corruption, replaces the physical object and invalidates unsafe manifests", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      first = await upload(store);
    const row = await runtime.DB.prepare(
      "SELECT object_key FROM qa_seed_parts WHERE hash=?",
    )
      .bind(digest(data().shop))
      .first<{ object_key: string }>();
    await runtime.ARTIFACTS.put(row!.object_key, bytes("corrupt"));
    await expect(
      store.getPart(digest(data().shop), first.lease.id),
    ).rejects.toMatchObject({ reason: "seed_corrupt" });
    expect(await store.hasPart(digest(data().shop), data().shop.length)).toBe(
      false,
    );
    await store.invalidate(fp().fingerprint, first.lease.id);
    expect(await store.manifest(fp().fingerprint, first.lease.id)).toBeNull();
    await store.putPart(digest(data().shop), data().shop, first.lease.id);
    await store.publish(first.document, first.lease.id);
    expect(await store.getPart(digest(data().shop), first.lease.id)).toEqual(
      data().shop,
    );
    await store.release(first.lease.id);
    await store.prune(1);
    expect(await runtime.ARTIFACTS.head(row!.object_key)).toBeNull();
    expect(
      (await objects()).filter((key) => key.includes("/objects/")),
    ).toHaveLength(2);
  });

  it("a pruning delete cannot remove a concurrent upload of the same content", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      first = await upload(store);
    await store.release(first.lease.id);
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const bucket = new Proxy(runtime.ARTIFACTS, {
      get(target, property) {
        if (property === "delete")
          return async (keys: string[]) => {
            entered();
            await gate;
            return target.delete(keys);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const gc = new HostedSeeds(
      { ...runtime, ARTIFACTS: bucket },
      "owner",
    ).prune(0);
    await started;
    const fresh = await upload(store);
    unblock();
    await gc;
    expect(await store.manifest(fp().fingerprint, fresh.lease.id)).toEqual(
      fresh.document,
    );
    expect(await store.getPart(digest(data().shop), fresh.lease.id)).toEqual(
      data().shop,
    );
  });

  it("retains a deletion ledger when R2 deletion fails and retries it on the next prune", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      first = await upload(store);
    await store.release(first.lease.id);
    const bucket = new Proxy(runtime.ARTIFACTS, {
      get(target, property) {
        if (property === "delete")
          return async () => {
            throw new Error("temporary storage failure");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      new HostedSeeds({ ...runtime, ARTIFACTS: bucket }, "owner").prune(0),
    ).rejects.toThrow("temporary storage failure");
    expect((await objects()).length).toBeGreaterThan(0);
    await store.prune(0);
    expect(await objects()).toEqual([]);
  });

  it("fences a delayed commit after lease expiry and leaves no published manifest", async () => {
    const store = new HostedSeeds(runtime, "owner"),
      lease = await store.acquire({ fingerprint: fp().fingerprint });
    for (const value of Object.values(data())) {
      await store.renew(lease.id, { part: digest(value) });
      await store.putPart(digest(value), value, lease.id);
    }
    const bucket = new Proxy(runtime.ARTIFACTS, {
      get(target, property) {
        if (property === "put")
          return async (key: string, ...rest: any[]) => {
            const result = await (target.put as any)(key, ...rest);
            if (key.endsWith("manifest.json"))
              await runtime.DB.prepare(
                "UPDATE qa_seed_leases SET expires_at=0",
              ).run();
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      new HostedSeeds({ ...runtime, ARTIFACTS: bucket }, "owner").publish(
        manifest(),
        lease.id,
      ),
    ).rejects.toMatchObject({ reason: "seed_lease_expired" });
    const read = await store.acquire({ fingerprint: fp().fingerprint });
    expect(await store.manifest(fp().fingerprint, read.id)).toBeNull();
    await store.release(read.id);
    await store.prune(0);
    expect(await objects()).toEqual([]);
  });
});
