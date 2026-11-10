import { SeedStorageFailure, SEED_PART_BYTES, validateSeedManifest } from './seed-store.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw new SeedStorageFailure('seed_store_unavailable'); };
const known = new Set(['seed_corrupt', 'seed_too_large', 'seed_store_unavailable', 'seed_lease_expired', 'seed_part_not_retained']);

/** Fixed-endpoint controller transport. The caller supplies a trusted scoped
 * credential; no URL, tenant, lease or object key is accepted from the harness.
 */
export class HostedSeedTransport {
  constructor({ sandboxGateway = false, endpoint, tenant, capability, maxSize = 2 * 1024 ** 3, fetchImpl = fetch, timeoutMs = 120000 }) {
    const url = new URL(endpoint);
    if ((url.protocol !== 'https:' && !(sandboxGateway && url.origin === 'http://198.18.0.1')) || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tenant) || typeof capability !== 'string' || !capability || /[\r\n]/.test(capability) || !Number.isSafeInteger(maxSize) || maxSize < 1) fail();
    Object.assign(this, { endpoint: endpoint.replace(/\/$/, '') + '/v1/qa/seeds', prefix: `seeds/${tenant}/`, capability, maxSize, fetchImpl, timeoutMs });
    this.leases = new Map();
  }
  async request(path, { method = 'GET', lease, body, missing = false, binary = false, limit = 16 * 1024 * 1024 } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.endpoint + path, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${this.capability}`, 'rio-protocol': '1', ...(lease ? { 'rio-seed-lease': lease.id } : {}) },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
      });
    } catch { fail(); }
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    const chunks = []; let length = 0;
    for await (const chunk of response.body || []) {
      length += chunk.length;
      if (length > limit) { await response.body?.cancel().catch(() => {}); fail(); }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (!response.ok) {
      let error; try { error = JSON.parse(data.toString()); } catch {}
      const reason = known.has(error?.error) ? error.error : 'seed_store_unavailable';
      const details = {};
      if (typeof error?.details?.largest_archive === 'string' && /^[a-z][a-z0-9-]*$/.test(error.details.largest_archive)) details.largest_archive = error.details.largest_archive;
      for (const key of ['bytes', 'max_bytes']) if (Number.isSafeInteger(error?.details?.[key]) && error.details[key] >= 0) details[key] = error.details[key];
      throw new SeedStorageFailure(reason, details);
    }
    if (method === 'HEAD') return true;
    if (binary && method === 'GET') return data;
    try { return JSON.parse(data.toString()); } catch { fail(); }
  }
  namespace(prefix) { if (prefix !== this.prefix) fail(); }
  partKey(key) {
    if (!key.startsWith(this.prefix + 'objects/')) fail();
    const hash = key.slice((this.prefix + 'objects/').length); if (!digest(hash)) fail(); return hash;
  }
  manifestKey(key) {
    if (!key.startsWith(this.prefix) || !key.endsWith('/manifest.json')) fail();
    const fingerprint = key.slice(this.prefix.length, -'/manifest.json'.length); if (!digest(fingerprint)) fail(); return fingerprint;
  }
  choose(predicate) {
    const lease = [...this.leases.values()].findLast(value => !value.closed && !value.failure && predicate(value));
    if (!lease) fail(); return lease;
  }
  async lease(prefix, fingerprint) {
    this.namespace(prefix); if (!digest(fingerprint)) fail();
    const response = await this.request('/leases', { method: 'POST', body: { fingerprint, max_size: this.maxSize } });
    if (!/^[a-f0-9-]{36}$/.test(response.id)) fail();
    const lease = { id: response.id, fingerprint, parts: new Set(), pending: Promise.resolve() };
    this.leases.set(lease.id, lease);
    const update = part => lease.pending = lease.pending.then(async () => {
      if (lease.failure) throw lease.failure;
      await this.request(`/leases/${lease.id}`, { method: 'PATCH', body: part ? { part } : {} });
      if (part) lease.parts.add(part);
    }).catch(error => { lease.failure = error; });
    const timer = setInterval(() => { void update(); }, 60000); timer.unref?.();
    return {
      id: lease.id,
      async retain(part) { if (!digest(part)) fail(); await update(part); if (lease.failure) throw lease.failure; },
      async check() { await lease.pending; if (lease.failure) throw lease.failure; },
      close: async () => {
        if (lease.closed) return; lease.closed = true; clearInterval(timer); await lease.pending;
        try { await this.request(`/leases/${lease.id}`, { method: 'DELETE' }); }
        finally { this.leases.delete(lease.id); }
      },
    };
  }
  async hasPart(key, part) {
    const hash = this.partKey(key);
    if (part.hash !== hash || !Number.isSafeInteger(part.bytes) || part.bytes < 0 || part.bytes > SEED_PART_BYTES) fail();
    return (await this.request(`/parts/${hash}/status?bytes=${part.bytes}`, { limit: 65536 })).present === true;
  }
  async putPart(key, part, bytes) {
    const hash = this.partKey(key); if (part.hash !== hash || bytes.length !== part.bytes || bytes.length > SEED_PART_BYTES) fail();
    const lease = this.choose(lease => lease.parts.has(hash));
    return this.request(`/parts/${hash}`, { method: 'PUT', lease, body: bytes, binary: true });
  }
  async getPart(key) {
    const hash = this.partKey(key), lease = this.choose(lease => lease.parts.has(hash));
    return this.request(`/parts/${hash}`, { lease, binary: true, limit: SEED_PART_BYTES });
  }
  async manifest(key) {
    const fingerprint = this.manifestKey(key), lease = this.choose(lease => lease.fingerprint === fingerprint);
    const value = await this.request(`/manifests/${fingerprint}`, { lease, missing: true });
    if (value) {
      validateSeedManifest(value, this.maxSize);
      if (value.fingerprint.fingerprint !== fingerprint) throw new SeedStorageFailure('seed_corrupt');
      for (const archive of value.archives) for (const part of archive.parts) lease.parts.add(part.hash);
    }
    return value;
  }
  async publish(prefix, manifest, maxSize) {
    this.namespace(prefix); if (maxSize > this.maxSize) fail();
    validateSeedManifest(manifest, maxSize);
    const fingerprint = manifest.fingerprint.fingerprint, parts = manifest.archives.flatMap(archive => archive.parts.map(part => part.hash));
    const lease = this.choose(lease => lease.fingerprint === fingerprint && parts.every(hash => lease.parts.has(hash)));
    return this.request(`/manifests/${fingerprint}`, { method: 'PUT', lease, body: manifest });
  }
  async invalidate(key) {
    const fingerprint = this.manifestKey(key), lease = this.choose(lease => lease.fingerprint === fingerprint);
    return this.request(`/manifests/${fingerprint}`, { method: 'DELETE', lease });
  }
  async prune(prefix, keep) { this.namespace(prefix); return (await this.request('/prune', { method: 'POST', body: { keep } })).removed; }
}
