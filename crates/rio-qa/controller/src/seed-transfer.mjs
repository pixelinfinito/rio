import { constants, createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const validName = name => typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name);
const fail = (reason = 'seed_transfer_failed', details = {}) => Object.assign(new Error(reason), { reason, details });
const reply = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
const reasons = new Set(['seed_corrupt', 'seed_too_large', 'seed_store_unavailable', 'seed_transfer_failed']);
function detailsOf(value, names) {
  const details = {};
  if (names.includes(value?.largest_archive)) details.largest_archive = value.largest_archive;
  for (const key of ['bytes', 'max_bytes']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) details[key] = value[key];
  return details;
}
async function json(stream, limit = 65536) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > limit) throw fail(); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function receive(stream, path, maxSize, signal) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let size = 0;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted(); size += chunk.length;
      if (size > maxSize) throw fail('seed_too_large', { bytes: size, max_bytes: maxSize });
      await handle.writeFile(chunk);
    }
    await handle.sync(); return size;
  } catch (error) { await rm(path, { force: true }); throw error; }
  finally { await handle.close(); }
}

/** Passive mailbox in app. It never connects to controller or a storage host.
 * A trusted controller pulls pre-credential archives or pushes verified cache
 * archives; repository code never receives a storage capability or cache mount.
 */
export class AppSeedTransfer {
  constructor({ names, maxSize, timeoutMs = 120000 }) {
    if (!Array.isArray(names) || names.some(name => !validName(name)) || new Set(names).size !== names.length || !Number.isSafeInteger(maxSize) || maxSize < 1) throw fail();
    Object.assign(this, { names, maxSize, timeoutMs });
  }
  restore(directory, options) { return this.operation('restore', directory, options); }
  publish(directory, options) { return this.operation('publish', directory, options); }
  invalidate(options) { return this.operation('invalidate', undefined, options); }
  async operation(kind, directory, { signal } = {}) {
    if (this.pending) throw fail();
    const archives = [];
    if (kind === 'publish') for (const name of this.names) {
      const info = await lstat(join(directory, `${name}.archive`));
      if (!info.isFile()) throw fail('seed_corrupt');
      archives.push({ name, bytes: info.size });
    }
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const operation = { id: randomUUID(), kind, directory, archives, received: new Set(), bytes: 0, resolve, reject, busy: false };
    const combined = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    operation.signal = combined;
    const abort = () => reject(signal?.aborted ? signal.reason : fail());
    this.pending = operation;
    combined.addEventListener('abort', abort, { once: true });
    if (combined.aborted) abort();
    try { return await result; }
    finally { combined.removeEventListener('abort', abort); if (this.pending === operation) this.pending = undefined; }
  }
  async handle(request, response) {
    const url = new URL(request.url, 'http://app');
    if (url.pathname !== '/seed' && !url.pathname.startsWith('/seed/')) return false;
    const operation = this.pending;
    if (request.method === 'GET' && url.pathname === '/seed') {
      reply(response, 200, operation ? { id: operation.id, kind: operation.kind, archives: operation.archives } : null); return true;
    }
    const path = url.pathname.split('/');
    if (!operation || path[2] !== operation.id || operation.signal.aborted) { reply(response, 409, { reason: 'seed_transfer_failed' }); return true; }
    if (operation.busy) { reply(response, 409, { reason: 'seed_transfer_failed' }); return true; }
    operation.busy = true;
    try {
      if (path.length === 4 && path[3] === 'complete' && request.method === 'POST') {
        const result = await json(request);
        if (result.error) {
          const reason = reasons.has(result.error) ? result.error : 'seed_transfer_failed';
          operation.reject(fail(reason, detailsOf(result.details, this.names)));
        } else {
          if (operation.kind === 'restore' && (typeof result.restored !== 'boolean' || (result.restored ? operation.received.size !== this.names.length : operation.received.size !== 0))) throw fail('seed_corrupt');
          operation.resolve(result.restored);
        }
        reply(response, 200, { completed: true });
      } else if (path.length === 5 && path[3] === 'archives' && this.names.includes(path[4])) {
        const name = path[4], file = join(operation.directory, `${name}.archive`);
        if (request.method === 'GET' && operation.kind === 'publish') {
          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > this.maxSize) throw fail('seed_corrupt');
            response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size });
            await pipeline(handle.createReadStream({ autoClose: false }), response, { signal: operation.signal });
          } finally { await handle.close(); }
        } else if (request.method === 'PUT' && operation.kind === 'restore' && !operation.received.has(name)) {
          const temporary = file + '.' + operation.id;
          const size = await receive(request, temporary, this.maxSize - operation.bytes, operation.signal);
          await rename(temporary, file); operation.received.add(name); operation.bytes += size;
          reply(response, 200, { stored: true });
        } else throw fail();
      } else throw fail();
    } catch (error) {
      operation.reject(error);
      if (!response.headersSent) reply(response, 400, { reason: reasons.has(error.reason) ? error.reason : 'seed_transfer_failed' });
      else response.destroy();
    } finally { operation.busy = false; }
    return true;
  }
}

/** Controller-side pump, usable with either local or hosted SeedStore. All
 * identities, allowed archive names and quotas come from the trusted run plan,
 * never the app response. A run lease lasts until the caller closes the pump.
 */
export class SeedTransferClient {
  constructor({ baseURL, store, fingerprint, names, timeoutMs = 120000, fetchImpl = fetch, requireExisting = false, forceRebuild = false }) {
    const url = new URL(baseURL);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail();
    if (!Array.isArray(names) || names.some(name => !validName(name)) || new Set(names).size !== names.length) throw fail();
    Object.assign(this, { baseURL: url.origin, store, fingerprint, names, timeoutMs, fetchImpl, requireExisting, forceRebuild });
  }
  async request(path, options = {}) {
    const response = await this.fetchImpl(this.baseURL + path, { ...options, redirect: 'error', signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(this.timeoutMs)]) });
    if (!response.ok) { await response.body?.cancel(); throw fail(); }
    return response;
  }
  async start({ signal } = {}) {
    if (this.stop) throw fail();
    this.stop = new AbortController();
    this.abort = () => this.stop.abort(signal.reason); this.parentSignal = signal;
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
    try {
      this.lease = await this.store.backend.lease(this.fingerprint.fingerprint);
      if (this.requireExisting && !await this.store.backend.manifest(this.fingerprint.fingerprint)) throw fail('seed_transfer_failed');
      this.directory = await mkdtemp(join(tmpdir(), 'rio-seed-transfer-'));
    } catch (error) { await this.close(); throw error; }
    this.done = this.run().catch(error => { if (!this.stop.signal.aborted) { this.failure = error; throw error; } });
    // A consumer can await done at teardown; attach a handler immediately so a
    // storage failure during a journey cannot become an unhandled rejection.
    this.done.catch(() => {});
    return this;
  }
  async run() {
    let connected = false;
    const deadline = Date.now() + this.timeoutMs;
    while (!this.stop.signal.aborted) {
      let response;
      try { response = await this.request('/seed'); }
      catch (error) {
        if (this.stop.signal.aborted) return;
        if (connected || Date.now() >= deadline) throw error;
        await delay(100, undefined, { signal: this.stop.signal }); continue;
      }
      connected = true;
      const operation = await json(Readable.fromWeb(response.body));
      await this.lease.check();
      if (operation) await this.transfer(operation);
      else await delay(50, undefined, { signal: this.stop.signal });
    }
  }
  async transfer(operation) {
    if (!/^[0-9a-f-]{36}$/.test(operation.id) || !['restore', 'publish', 'invalidate'].includes(operation.kind)) throw fail();
    const path = `/seed/${operation.id}`;
    const directory = await mkdtemp(join(this.directory, 'operation-'));
    const finish = async value => { const response = await this.request(path + '/complete', { method: 'POST', body: JSON.stringify(value) }); await response.body?.cancel(); };
    try {
      const options = { fingerprint: this.fingerprint, signal: this.stop.signal };
      if (this.requireExisting && operation.kind !== 'restore') throw fail('seed_transfer_failed');
      if (operation.kind === 'restore') {
        const restored = this.forceRebuild ? false : await this.store.restore(directory, options);
        if (this.requireExisting && !restored) throw fail('seed_transfer_failed');
        if (restored) for (const name of this.names) {
          const file = join(directory, `${name}.archive`), info = await lstat(file);
          if (!info.isFile()) throw fail('seed_corrupt');
          const response = await this.request(path + `/archives/${name}`, { method: 'PUT', body: createReadStream(file), duplex: 'half', headers: { 'content-length': String(info.size) } });
          await response.body?.cancel();
        }
        await finish({ restored });
      } else if (operation.kind === 'invalidate') {
        await this.store.invalidate(options); await finish({ invalidated: true });
      } else {
        const archives = operation.archives;
        if (!Array.isArray(archives) || archives.length !== this.names.length || new Set(archives.map(archive => archive.name)).size !== this.names.length || archives.some(archive => !this.names.includes(archive.name) || !Number.isSafeInteger(archive.bytes) || archive.bytes < 0)) throw fail('seed_corrupt');
        const total = archives.reduce((sum, archive) => sum + archive.bytes, 0);
        if (!Number.isSafeInteger(total) || total > this.store.maxSize) throw fail('seed_too_large', { largest_archive: [...archives].sort((a, b) => b.bytes - a.bytes)[0]?.name, bytes: total, max_bytes: this.store.maxSize });
        for (const archive of archives) {
          const response = await this.request(path + `/archives/${archive.name}`);
          const size = await receive(Readable.fromWeb(response.body), join(directory, `${archive.name}.archive`), archive.bytes, this.stop.signal);
          if (size !== archive.bytes) throw fail('seed_corrupt');
        }
        await this.store.publish(directory, options); await finish({ published: true });
      }
    } catch (error) {
      if (this.stop.signal.aborted) throw error;
      await finish({ error: reasons.has(error.reason) ? error.reason : 'seed_transfer_failed', details: detailsOf(error.details, this.names) });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async close() {
    this.stop?.abort(); this.parentSignal?.removeEventListener('abort', this.abort);
    try { await this.done; if (this.failure) throw this.failure; }
    finally { await this.lease?.close(); if (this.directory) await rm(this.directory, { recursive: true, force: true }); }
  }
}
