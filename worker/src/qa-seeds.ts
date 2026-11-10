import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Env } from "./types";
import { invariant } from "./validation";

export const SEED_PART_BYTES = 8 * 1024 * 1024;
export const SEED_MANIFEST_BYTES = 16 * 1024 * 1024;
export const SEED_LEASE_MS = 180000;
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const hash = (bytes: Uint8Array) => bytesToHex(blake3(bytes));
const kinds = new Set([
  "sqlite",
  "postgres",
  "mysql",
  "redis",
  "files",
  "custom",
]);
export class SeedError extends Error {
  constructor(
    public reason: string,
    public details: Record<string, unknown> = {},
  ) {
    super(reason);
  }
}
function check(value: unknown, reason = "seed_corrupt"): asserts value {
  if (!value) throw new SeedError(reason);
}
export interface SeedPart {
  hash: string;
  bytes: number;
}
export interface SeedManifest {
  version: 1;
  fingerprint: {
    fingerprint: string;
    datastores: Record<string, string>;
    [key: string]: unknown;
  };
  created_at_ms: number;
  archives: {
    name: string;
    kind: string;
    hash: string;
    bytes: number;
    parts: SeedPart[];
  }[];
}
interface Lease {
  id: string;
  fingerprint: string;
  max_size: number;
  expires_at: number;
  run_id: string | null;
  generation: string | null;
}
export interface SeedRunScope {
  run_id: string;
  generation: string;
  fingerprints: string[];
  max_size: number;
}
interface PartRow {
  hash: string;
  bytes: number;
  object_key: string;
}

export function seedManifest(value: any, maxSize: number): SeedManifest {
  check(
    value?.version === 1 &&
      hex(value.fingerprint?.fingerprint) &&
      Number.isSafeInteger(value.created_at_ms) &&
      value.created_at_ms >= 0 &&
      Array.isArray(value.archives) &&
      value.archives.length <= 1024,
  );
  check(
    value.fingerprint.datastores &&
      typeof value.fingerprint.datastores === "object" &&
      !Array.isArray(value.fingerprint.datastores),
  );
  let total = 0;
  const names = new Set<string>();
  for (const archive of value.archives) {
    check(
      archive &&
        typeof archive.name === "string" &&
        /^[a-z][a-z0-9-]*$/.test(archive.name) &&
        !names.has(archive.name) &&
        kinds.has(archive.kind) &&
        hex(archive.hash) &&
        Number.isSafeInteger(archive.bytes) &&
        archive.bytes >= 0 &&
        Array.isArray(archive.parts) &&
        archive.parts.length > 0,
    );
    names.add(archive.name);
    let bytes = 0;
    for (const [index, part] of archive.parts.entries()) {
      check(
        part &&
          hex(part.hash) &&
          Number.isSafeInteger(part.bytes) &&
          part.bytes >= 0 &&
          part.bytes <= SEED_PART_BYTES &&
          (index === archive.parts.length - 1 ||
            part.bytes === SEED_PART_BYTES),
      );
      bytes += part.bytes;
    }
    check(Number.isSafeInteger(bytes) && bytes === archive.bytes);
    total += bytes;
  }
  check(Number.isSafeInteger(total));
  if (total > maxSize)
    throw new SeedError("seed_too_large", {
      largest_archive: [...value.archives].sort((a, b) => b.bytes - a.bytes)[0]
        ?.name,
      bytes: total,
      max_bytes: maxSize,
    });
  for (const [name, kind] of Object.entries(value.fingerprint.datastores))
    check(
      value.archives.some(
        (archive: any) => archive.name === name && archive.kind === kind,
      ),
    );
  return value;
}

/** D1 owns publication and reachability; R2 holds immutable versioned bytes.
 * All namespace input comes from authenticated tenant identity, never a key in
 * a request body. Expired uploads have no visible head and are prunable.
 */
export class HostedSeeds {
  constructor(
    private env: Env,
    private tenant: string,
    private scope?: SeedRunScope,
  ) {
    invariant(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tenant),
      "invalid seed tenant",
    );
  }
  private key(path: string) {
    return `seeds/${this.tenant}/${path}`;
  }
  private async lease(id: string): Promise<Lease> {
    check(uuid(id), "seed_lease_expired");
    const row = await this.env.DB.prepare(
      "SELECT id,fingerprint,max_size,expires_at,run_id,generation FROM qa_active_seed_leases WHERE tenant=? AND id=? AND expires_at>?",
    )
      .bind(this.tenant, id, Date.now())
      .first<Lease>();
    check(row, "seed_lease_expired");
    if (this.scope)
      invariant(
        row.run_id === this.scope.run_id &&
          row.generation === this.scope.generation &&
          this.scope.fingerprints.includes(row.fingerprint),
        "unauthorized seed lease scope",
      );
    return row;
  }
  async acquire(value: any) {
    check(hex(value?.fingerprint));
    const maxSize = value.max_size ?? 2 * 1024 ** 3;
    check(Number.isSafeInteger(maxSize) && maxSize > 0);
    if (this.scope)
      invariant(
        this.scope.fingerprints.includes(value.fingerprint) &&
          maxSize <= this.scope.max_size,
        "unauthorized seed fingerprint or quota",
      );
    const id = crypto.randomUUID(),
      expires = Date.now() + SEED_LEASE_MS;
    const inserted = await this.env.DB.prepare(
      "INSERT INTO qa_seed_leases(tenant,id,fingerprint,max_size,expires_at,run_id,generation) SELECT ?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM qa_runs q JOIN reviews r ON r.id=q.review_id JOIN jobs j ON j.id=q.job_id AND j.attempt=q.attempt WHERE q.id=? AND q.generation=? AND r.tenant=? AND q.state='running' AND q.deadline>? AND r.cancelled=0 AND r.deadline>? AND j.status='leased' AND j.lease_until>?) RETURNING id",
    )
      .bind(
        this.tenant,
        id,
        value.fingerprint,
        maxSize,
        expires,
        this.scope?.run_id ?? null,
        this.scope?.generation ?? null,
        this.scope?.run_id ?? null,
        this.scope?.run_id ?? null,
        this.scope?.generation ?? null,
        this.tenant,
        Date.now(),
        Date.now(),
        Date.now(),
      )
      .all();
    check(inserted.results.length, "seed_lease_expired");
    return { id, expires_at_ms: expires, renew_after_ms: 60000 };
  }
  async renew(id: string, value: any = {}) {
    check(uuid(id), "seed_lease_expired");
    if (this.scope) await this.lease(id);
    if (value.part !== undefined) check(hex(value.part));
    const now = Date.now(),
      expires = now + SEED_LEASE_MS;
    const statements = [
      this.env.DB.prepare(
        "UPDATE qa_seed_leases SET expires_at=? WHERE (tenant,id) IN (SELECT tenant,id FROM qa_active_seed_leases WHERE tenant=? AND id=? AND expires_at>?) RETURNING id",
      ).bind(expires, this.tenant, id, now),
    ];
    if (value.part !== undefined)
      statements.push(
        this.env.DB.prepare(
          "INSERT INTO qa_seed_lease_parts(tenant,lease_id,hash) SELECT tenant,id,? FROM qa_active_seed_leases WHERE tenant=? AND id=? AND expires_at>? ON CONFLICT DO NOTHING",
        ).bind(value.part, this.tenant, id, now),
      );
    const result = await this.env.DB.batch(statements);
    check(result[0].results.length, "seed_lease_expired");
    return { expires_at_ms: expires };
  }
  async release(id: string) {
    check(uuid(id), "seed_lease_expired");
    if (this.scope) {
      const row = await this.env.DB.prepare(
        "SELECT run_id,generation FROM qa_seed_leases WHERE tenant=? AND id=?",
      )
        .bind(this.tenant, id)
        .first<{ run_id: string; generation: string }>();
      invariant(
        !row ||
          (row.run_id === this.scope.run_id &&
            row.generation === this.scope.generation),
        "unauthorized seed lease scope",
      );
    }
    await this.env.DB.prepare(
      "DELETE FROM qa_seed_leases WHERE tenant=? AND id=?",
    )
      .bind(this.tenant, id)
      .run();
  }
  private async row(digest: string) {
    check(hex(digest));
    return this.env.DB.prepare(
      "SELECT hash,bytes,object_key FROM qa_seed_parts WHERE tenant=? AND hash=?",
    )
      .bind(this.tenant, digest)
      .first<PartRow>();
  }
  private async verified(row: PartRow): Promise<Uint8Array> {
    const object = await this.env.ARTIFACTS.get(row.object_key);
    check(
      object && object.size === row.bytes && object.size <= SEED_PART_BYTES,
    );
    const bytes = new Uint8Array(await object.arrayBuffer());
    check(bytes.length === row.bytes && hash(bytes) === row.hash);
    return bytes;
  }
  async hasPart(digest: string, bytes: number) {
    check(
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= SEED_PART_BYTES,
    );
    const row = await this.row(digest);
    if (!row || row.bytes !== bytes) return false;
    try {
      await this.verified(row);
      return true;
    } catch (error) {
      if (!(error instanceof SeedError)) throw error;
      // A later verified upload gets a fresh physical key. No deletion here:
      // a committed older version may still reference this corrupt object.
      await this.env.DB.batch([
        this.env.DB.prepare(
          "INSERT INTO qa_seed_garbage(tenant,object_key) VALUES(?,?) ON CONFLICT DO NOTHING",
        ).bind(this.tenant, row.object_key),
        this.env.DB.prepare(
          "DELETE FROM qa_seed_parts WHERE tenant=? AND hash=? AND object_key=?",
        ).bind(this.tenant, digest, row.object_key),
      ]);
      return false;
    }
  }
  async getPart(digest: string, leaseId: string) {
    const lease = await this.lease(leaseId),
      row = await this.row(digest);
    check(row);
    // A lease may read only its retained uploads or versions of its fingerprint.
    const allowed = await this.env.DB.prepare(
      "SELECT 1 FROM qa_seed_lease_parts WHERE tenant=? AND lease_id=? AND hash=? UNION ALL SELECT 1 FROM qa_seed_version_parts p JOIN qa_seed_versions v ON v.tenant=p.tenant AND v.id=p.version_id WHERE p.tenant=? AND p.hash=? AND v.fingerprint=? LIMIT 1",
    )
      .bind(
        this.tenant,
        leaseId,
        digest,
        this.tenant,
        digest,
        lease.fingerprint,
      )
      .first();
    check(allowed);
    return this.verified(row);
  }
  async putPart(digest: string, body: Uint8Array, leaseId: string) {
    check(
      hex(digest) && body.length <= SEED_PART_BYTES && hash(body) === digest,
    );
    const lease = await this.lease(leaseId);
    check(
      await this.env.DB.prepare(
        "SELECT 1 FROM qa_seed_lease_parts WHERE tenant=? AND lease_id=? AND hash=?",
      )
        .bind(this.tenant, leaseId, digest)
        .first(),
      "seed_part_not_retained",
    );
    if (await this.hasPart(digest, body.length)) return { reused: true };
    const key = this.key(`objects/${digest}/${crypto.randomUUID()}`);
    await this.env.ARTIFACTS.put(key, body);
    try {
      // Publication of a part is conditional on the still-live lease. A GC of
      // an earlier object can never delete this new physical version.
      const result = await this.env.DB.prepare(
        "INSERT INTO qa_seed_parts(tenant,hash,object_key,bytes,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM qa_active_seed_leases WHERE tenant=? AND id=? AND expires_at>?) AND ? + (SELECT COALESCE(SUM(p.bytes),0) FROM qa_seed_lease_parts l JOIN qa_seed_parts p ON p.tenant=l.tenant AND p.hash=l.hash WHERE l.tenant=? AND l.lease_id=?) <= ? ON CONFLICT DO NOTHING RETURNING object_key",
      )
        .bind(
          this.tenant,
          digest,
          key,
          body.length,
          Date.now(),
          this.tenant,
          leaseId,
          Date.now(),
          body.length,
          this.tenant,
          leaseId,
          lease.max_size,
        )
        .all();
      if (!result.results.length) {
        await this.env.ARTIFACTS.delete(key);
        await this.lease(leaseId);
        if (await this.hasPart(digest, body.length)) return { reused: true };
        throw new SeedError("seed_too_large", { max_bytes: lease.max_size });
      }
      return { reused: false };
    } catch (error) {
      await this.env.ARTIFACTS.delete(key);
      throw error;
    }
  }
  async manifest(fingerprint: string, leaseId: string) {
    check(hex(fingerprint));
    const lease = await this.lease(leaseId);
    check(lease.fingerprint === fingerprint);
    const head = await this.env.DB.prepare(
      "SELECT v.object_key FROM qa_seed_heads h JOIN qa_seed_versions v ON v.tenant=h.tenant AND v.id=h.version_id WHERE h.tenant=? AND h.fingerprint=? AND h.valid=1",
    )
      .bind(this.tenant, fingerprint)
      .first<{ object_key: string }>();
    if (!head) return null;
    const object = await this.env.ARTIFACTS.get(head.object_key);
    try {
      check(object && object.size <= SEED_MANIFEST_BYTES);
      const manifest = seedManifest(await object.json(), lease.max_size);
      check(manifest.fingerprint.fingerprint === fingerprint);
      return manifest;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof SeedError && error.reason === "seed_corrupt")
      ) {
        await this.invalidate(fingerprint, leaseId);
        throw new SeedError("seed_corrupt");
      }
      throw error;
    }
  }
  async publish(value: unknown, leaseId: string) {
    const lease = await this.lease(leaseId),
      manifest = seedManifest(value, lease.max_size);
    check(manifest.fingerprint.fingerprint === lease.fingerprint);
    const rows = new Map<string, PartRow>();
    const hashes = [
      ...new Set(
        manifest.archives.flatMap((archive) =>
          archive.parts.map((part) => part.hash),
        ),
      ),
    ];
    for (let start = 0; start < hashes.length; start += 1000) {
      const found = await this.env.DB.prepare(
        "SELECT p.hash,p.bytes,p.object_key,EXISTS(SELECT 1 FROM qa_seed_lease_parts l WHERE l.tenant=p.tenant AND l.lease_id=? AND l.hash=p.hash) AS retained FROM qa_seed_parts p WHERE p.tenant=? AND p.hash IN (SELECT value FROM json_each(?))",
      )
        .bind(
          leaseId,
          this.tenant,
          JSON.stringify(hashes.slice(start, start + 1000)),
        )
        .all<PartRow & { retained: number }>();
      for (const row of found.results) {
        check(row.retained, "seed_part_not_retained");
        rows.set(row.hash, row);
      }
    }
    for (const archive of manifest.archives) {
      const full = blake3.create();
      for (const part of archive.parts) {
        const row = rows.get(part.hash);
        check(row && row.bytes === part.bytes);
        full.update(await this.verified(row));
      }
      check(bytesToHex(full.digest()) === archive.hash);
    }
    const id = crypto.randomUUID(),
      key = this.key(`${lease.fingerprint}/${id}/manifest.json`),
      now = Date.now();
    const serialized = JSON.stringify(manifest);
    check(new TextEncoder().encode(serialized).length <= SEED_MANIFEST_BYTES);
    const added = await this.env.DB.prepare(
      "INSERT INTO qa_seed_versions(tenant,id,fingerprint,object_key,lease_id,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM qa_active_seed_leases WHERE tenant=? AND id=? AND expires_at>?) RETURNING id",
    )
      .bind(
        this.tenant,
        id,
        lease.fingerprint,
        key,
        leaseId,
        now,
        this.tenant,
        leaseId,
        now,
      )
      .all();
    check(added.results.length, "seed_lease_expired");
    // Pending versions keep references while upload/commit is in progress.
    const parts = [...rows.values()];
    for (let start = 0; start < parts.length; start += 1000)
      await this.env.DB.prepare(
        "INSERT INTO qa_seed_version_parts(tenant,version_id,hash,object_key) SELECT ?,?,json_extract(value,'$.hash'),json_extract(value,'$.object_key') FROM json_each(?)",
      )
        .bind(this.tenant, id, JSON.stringify(parts.slice(start, start + 1000)))
        .run();
    await this.env.ARTIFACTS.put(key, serialized, {
      httpMetadata: { contentType: "application/json" },
    });
    // The single head update is the commit point. Lease and object-version
    // comparisons fence a delayed publisher against expiry, repair and GC.
    const committed = await this.env.DB.prepare(
      "INSERT INTO qa_seed_heads(tenant,fingerprint,version_id,created_at,valid) SELECT ?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM qa_active_seed_leases WHERE tenant=? AND id=? AND expires_at>?) AND EXISTS(SELECT 1 FROM qa_seed_versions WHERE tenant=? AND id=?) AND NOT EXISTS(SELECT 1 FROM qa_seed_version_parts v LEFT JOIN qa_seed_parts p ON p.tenant=v.tenant AND p.hash=v.hash AND p.object_key=v.object_key WHERE v.tenant=? AND v.version_id=? AND p.hash IS NULL) ON CONFLICT(tenant,fingerprint) DO UPDATE SET version_id=excluded.version_id,created_at=excluded.created_at,valid=1 RETURNING fingerprint",
    )
      .bind(
        this.tenant,
        lease.fingerprint,
        id,
        now,
        this.tenant,
        leaseId,
        Date.now(),
        this.tenant,
        id,
        this.tenant,
        id,
      )
      .all();
    check(committed.results.length, "seed_lease_expired");
    return { published: true };
  }
  async invalidate(fingerprint: string, leaseId: string) {
    check(hex(fingerprint));
    const lease = await this.lease(leaseId);
    check(lease.fingerprint === fingerprint);
    await this.env.DB.prepare(
      "UPDATE qa_seed_heads SET valid=0 WHERE tenant=? AND fingerprint=? AND EXISTS(SELECT 1 FROM qa_active_seed_leases WHERE tenant=? AND id=? AND expires_at>?)",
    )
      .bind(this.tenant, fingerprint, this.tenant, leaseId, Date.now())
      .run();
  }
  async prune(keep = 3) {
    invariant(!this.scope, "unauthorized seed pruning capability");
    check(Number.isSafeInteger(keep) && keep >= 0);
    const now = Date.now();
    const oldVersion =
      "v.tenant=? AND NOT EXISTS(SELECT 1 FROM qa_seed_heads h WHERE h.tenant=v.tenant AND h.version_id=v.id) AND NOT EXISTS(SELECT 1 FROM qa_seed_leases l WHERE l.tenant=v.tenant AND (l.fingerprint=v.fingerprint OR l.id=v.lease_id) AND l.expires_at>?)";
    const oldPart =
      "p.tenant=? AND NOT EXISTS(SELECT 1 FROM qa_seed_version_parts v WHERE v.tenant=p.tenant AND v.hash=p.hash) AND NOT EXISTS(SELECT 1 FROM qa_seed_lease_parts r JOIN qa_seed_leases l ON l.tenant=r.tenant AND l.id=r.lease_id WHERE r.tenant=p.tenant AND r.hash=p.hash AND l.expires_at>?)";
    const results = await this.env.DB.batch<{ fingerprint: string }>([
      this.env.DB.prepare(
        "DELETE FROM qa_seed_heads WHERE tenant=? AND (valid=0 OR fingerprint NOT IN (SELECT fingerprint FROM qa_seed_heads WHERE tenant=? AND valid=1 ORDER BY created_at DESC,fingerprint LIMIT ?)) AND NOT EXISTS(SELECT 1 FROM qa_seed_leases l WHERE l.tenant=qa_seed_heads.tenant AND l.fingerprint=qa_seed_heads.fingerprint AND l.expires_at>?) RETURNING fingerprint",
      ).bind(this.tenant, this.tenant, keep, now),
      this.env.DB.prepare(
        `INSERT INTO qa_seed_garbage(tenant,object_key) SELECT v.tenant,v.object_key FROM qa_seed_versions v WHERE ${oldVersion} ON CONFLICT DO NOTHING`,
      ).bind(this.tenant, now),
      this.env.DB.prepare(
        `INSERT INTO qa_seed_garbage(tenant,object_key) SELECT p.tenant,p.object_key FROM qa_seed_version_parts p JOIN qa_seed_versions v ON v.tenant=p.tenant AND v.id=p.version_id WHERE ${oldVersion} ON CONFLICT DO NOTHING`,
      ).bind(this.tenant, now),
      this.env.DB.prepare(
        `DELETE FROM qa_seed_versions WHERE tenant=? AND id IN (SELECT v.id FROM qa_seed_versions v WHERE ${oldVersion})`,
      ).bind(this.tenant, this.tenant, now),
      this.env.DB.prepare(
        `INSERT INTO qa_seed_garbage(tenant,object_key) SELECT p.tenant,p.object_key FROM qa_seed_parts p WHERE ${oldPart} ON CONFLICT DO NOTHING`,
      ).bind(this.tenant, now),
      this.env.DB.prepare(
        `DELETE FROM qa_seed_parts WHERE tenant=? AND hash IN (SELECT p.hash FROM qa_seed_parts p WHERE ${oldPart})`,
      ).bind(this.tenant, this.tenant, now),
      this.env.DB.prepare(
        "DELETE FROM qa_seed_leases WHERE tenant=? AND expires_at<=?",
      ).bind(this.tenant, now),
    ]);
    // Deletion failures retain their ledger entries for the next prune. A
    // repaired physical object can also remain pinned by an older live reader.
    while (true) {
      const garbage = await this.env.DB.prepare(
        "SELECT g.object_key FROM qa_seed_garbage g WHERE g.tenant=? AND NOT EXISTS(SELECT 1 FROM qa_seed_version_parts p WHERE p.tenant=g.tenant AND p.object_key=g.object_key) AND NOT EXISTS(SELECT 1 FROM qa_seed_parts p WHERE p.tenant=g.tenant AND p.object_key=g.object_key) LIMIT 1000",
      )
        .bind(this.tenant)
        .all<{ object_key: string }>();
      const keys = garbage.results.map((row) => row.object_key);
      if (!keys.length) break;
      await this.env.ARTIFACTS.delete(keys);
      await this.env.DB.prepare(
        "DELETE FROM qa_seed_garbage WHERE tenant=? AND object_key IN (SELECT value FROM json_each(?))",
      )
        .bind(this.tenant, JSON.stringify(keys))
        .run();
    }
    return results[0].results.map((row) => String(row.fingerprint));
  }
}
