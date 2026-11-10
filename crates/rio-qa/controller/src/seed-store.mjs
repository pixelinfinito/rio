import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, readFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { blake3 } from '@noble/hashes/blake3.js';

export const SEED_PART_BYTES = 8 * 1024 * 1024;
const hash = bytes => Buffer.from(blake3(bytes)).toString('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
const kinds = new Set(['sqlite', 'postgres', 'mysql', 'redis', 'files', 'custom']);
const canonical = value => JSON.stringify(value, function (_key, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item; });
export class SeedStorageFailure extends Error {
  constructor(reason, details = {}) { super(reason); this.reason = reason; this.details = details; }
}
const corrupt = () => { throw new SeedStorageFailure('seed_corrupt'); };
export function validateSeedManifest(manifest, maxSize) {
  if (!manifest || manifest.version !== 1 || !digest(manifest.fingerprint?.fingerprint) || !Number.isSafeInteger(manifest.created_at_ms) || !Array.isArray(manifest.archives) || manifest.archives.length > 1024) corrupt();
  let total = 0; const names = new Set();
  for (const archive of manifest.archives) {
    if (!name(archive.name) || names.has(archive.name) || !kinds.has(archive.kind) || !digest(archive.hash) || !Number.isSafeInteger(archive.bytes) || archive.bytes < 0 || !Array.isArray(archive.parts) || !archive.parts.length) corrupt();
    names.add(archive.name); let size = 0;
    for (const [index, part] of archive.parts.entries()) {
      if (!digest(part.hash) || !Number.isSafeInteger(part.bytes) || part.bytes < 0 || part.bytes > SEED_PART_BYTES || index < archive.parts.length - 1 && part.bytes !== SEED_PART_BYTES) corrupt();
      size += part.bytes;
    }
    total += size;
    if (size !== archive.bytes || !Number.isSafeInteger(total)) corrupt();
  }
  for (const [name, kind] of Object.entries(manifest.fingerprint.datastores || {})) if (!manifest.archives.some(archive => archive.name === name && archive.kind === kind)) corrupt();
  if (total > maxSize) throw new SeedStorageFailure('seed_too_large', { largest_archive: [...manifest.archives].sort((a, b) => b.bytes - a.bytes)[0]?.name, bytes: total, max_bytes: maxSize });
  return manifest;
}

async function directories(path) {
  let at = resolve(sep);
  for (const part of relative(at, resolve(path)).split(sep).filter(Boolean)) {
    at = join(at, part); await mkdir(at, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(at)).isDirectory()) corrupt();
  }
}
async function regular(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > limit) corrupt();
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Private content-addressed cache. A small OS advisory lock coordinates
 * publication, pruning and leases across CLI processes and releases on crash. */
export class LocalSeedBackend {
  static async create(root) {
    await directories(root);
    const backend = new LocalSeedBackend(resolve(root));
    await Promise.all(['objects', 'leases'].map(name => directories(join(backend.root, name))));
    return backend;
  }
  constructor(root) { this.root = root; }
  async lock(operation) {
    const script = 'import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)\nfcntl.flock(f,fcntl.LOCK_EX)\nsys.stdout.write("ready\\n");sys.stdout.flush()\nsys.stdin.read()\n';
    const child = spawn('python3', ['-c', script, join(this.root, '.lock')], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    const ended = once(child, 'close');
    try {
      await Promise.race([once(child.stdout, 'data'), ended.then(() => { throw new SeedStorageFailure('seed_store_unavailable'); })]);
      return await operation();
    } finally { child.stdin.end(); await ended; }
  }
  async atomic(path, bytes) {
    await directories(dirname(path));
    const temporary = path + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  objectPath(value) { if (!digest(value)) corrupt(); return join(this.root, 'objects', value); }
  manifestPath(value) { if (!digest(value)) corrupt(); return join(this.root, value, 'manifest.json'); }
  async lease(fingerprint, ttlMs = 180000) {
    if (!digest(fingerprint) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000) corrupt();
    const id = randomUUID(), path = join(this.root, 'leases', id + '.json');
    let entry = { fingerprint, parts: [], expires_at_ms: Date.now() + ttlMs };
    await this.lock(() => this.atomic(path, Buffer.from(JSON.stringify(entry))));
    let pending = Promise.resolve(), failure;
    const update = operation => pending = pending.then(() => this.lock(async () => { operation(); entry.expires_at_ms = Date.now() + ttlMs; await this.atomic(path, Buffer.from(JSON.stringify(entry))); })).catch(error => { failure = error; });
    const timer = setInterval(() => { void update(() => {}); }, Math.min(60000, Math.floor(ttlMs / 3))); timer.unref();
    return {
      id,
      async retain(part) { if (!digest(part)) corrupt(); await update(() => { if (!entry.parts.includes(part)) entry.parts.push(part); }); if (failure) throw failure; },
      async check() { await pending; if (failure) throw failure; },
      async close() { clearInterval(timer); await pending; await rm(path, { force: true }); },
    };
  }
  async hasPart(part) {
    try { const bytes = await regular(this.objectPath(part.hash), SEED_PART_BYTES); return bytes.length === part.bytes && hash(bytes) === part.hash; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async putPart(part, bytes) {
    if (bytes.length !== part.bytes || bytes.length > SEED_PART_BYTES || hash(bytes) !== part.hash) corrupt();
    await this.lock(() => this.atomic(this.objectPath(part.hash), bytes));
  }
  async getPart(part) {
    const bytes = await regular(this.objectPath(part.hash), SEED_PART_BYTES);
    if (bytes.length !== part.bytes || hash(bytes) !== part.hash) corrupt(); return bytes;
  }
  async manifest(fingerprint) {
    try { const manifest = JSON.parse((await regular(this.manifestPath(fingerprint), 16 * 1024 * 1024)).toString('utf8')); if (manifest.fingerprint?.fingerprint !== fingerprint) corrupt(); return manifest; }
    catch (error) { if (error.code === 'ENOENT') return null; throw new SeedStorageFailure('seed_corrupt'); }
  }
  async publish(manifest, maxSize) {
    validateSeedManifest(manifest, maxSize);
    await this.lock(async () => {
      // Publication is the only commit point; verify every referenced part.
      for (const archive of manifest.archives) { const full = blake3.create(); for (const part of archive.parts) full.update(await this.getPart(part)); if (Buffer.from(full.digest()).toString('hex') !== archive.hash) corrupt(); }
      await this.atomic(this.manifestPath(manifest.fingerprint.fingerprint), Buffer.from(JSON.stringify(manifest)));
    });
  }
  async invalidate(fingerprint) { await this.lock(() => rm(this.manifestPath(fingerprint), { force: true })); }
  async prune(keep = 3) {
    if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('Invalid seed retention');
    return this.lock(async () => {
      const leased = new Set(), retainedParts = new Set();
      for (const file of await readdir(join(this.root, 'leases'))) {
        if (!/^[0-9a-f-]+\.json$/.test(file)) continue;
        const path = join(this.root, 'leases', file);
        let lease; try { lease = JSON.parse((await regular(path, 16 * 1024 * 1024)).toString()); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (lease.expires_at_ms > Date.now()) { leased.add(lease.fingerprint); for (const part of lease.parts) retainedParts.add(part); }
        else await rm(path, { force: true });
      }
      const manifests = [];
      for (const file of await readdir(this.root)) {
        if (!digest(file) || !(await lstat(join(this.root, file))).isDirectory()) continue;
        const manifest = await this.manifest(file); if (manifest) manifests.push(validateSeedManifest(manifest, Number.MAX_SAFE_INTEGER));
      }
      manifests.sort((a, b) => b.created_at_ms - a.created_at_ms || a.fingerprint.fingerprint.localeCompare(b.fingerprint.fingerprint));
      const removed = [];
      for (const [index, manifest] of manifests.entries()) {
        const id = manifest.fingerprint.fingerprint;
        if (index < keep || leased.has(id)) { for (const archive of manifest.archives) for (const part of archive.parts) retainedParts.add(part.hash); }
        else { await rm(this.manifestPath(id)); await rm(join(this.root, id), { recursive: true }); removed.push(id); }
      }
      for (const part of await readdir(join(this.root, 'objects'))) if (digest(part) && !retainedParts.has(part)) await rm(this.objectPath(part));
      return removed;
    });
  }
}

/** Storage transport for tenant-scoped hosted stores. The authenticated Worker
 * implements the same atomic commit and lease checks; callbacks are supplied
 * by the runner, never by a repository manifest or a harness tool. */
export class HostedSeedBackend {
  constructor({ tenant, transport }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tenant)) throw new Error('Invalid seed tenant');
    this.prefix = `seeds/${tenant}/`; this.transport = transport;
  }
  lease(fingerprint, ttl) { if (!digest(fingerprint)) corrupt(); return this.transport.lease(this.prefix, fingerprint, ttl); }
  hasPart(part) { if (!digest(part.hash)) corrupt(); return this.transport.hasPart(this.prefix + 'objects/' + part.hash, part); }
  async putPart(part, bytes) { if (!digest(part.hash) || bytes.length > SEED_PART_BYTES || bytes.length !== part.bytes || hash(bytes) !== part.hash) corrupt(); await this.transport.putPart(this.prefix + 'objects/' + part.hash, part, bytes); }
  async getPart(part) { if (!digest(part.hash)) corrupt(); const bytes = Buffer.from(await this.transport.getPart(this.prefix + 'objects/' + part.hash)); if (bytes.length !== part.bytes || hash(bytes) !== part.hash) corrupt(); return bytes; }
  manifest(fingerprint) { if (!digest(fingerprint)) corrupt(); return this.transport.manifest(this.prefix + fingerprint + '/manifest.json'); }
  publish(manifest, maxSize) { validateSeedManifest(manifest, maxSize); return this.transport.publish(this.prefix, manifest, maxSize); }
  invalidate(fingerprint) { if (!digest(fingerprint)) corrupt(); return this.transport.invalidate(this.prefix + fingerprint + '/manifest.json'); }
  prune(keep = 3) { return this.transport.prune(this.prefix, keep); }
}

export class SeedStore {
  constructor({ backend, maxSize = 2 * 1024 * 1024 * 1024, kinds = {} }) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) throw new Error('Invalid seed quota');
    Object.assign(this, { backend, maxSize, kinds });
  }
  async invalidate({ fingerprint, signal } = {}) {
    signal?.throwIfAborted();
    if (!digest(fingerprint?.fingerprint)) corrupt();
    await this.backend.invalidate(fingerprint.fingerprint);
  }
  async publish(directory, { fingerprint, signal } = {}) {
    if (!digest(fingerprint?.fingerprint)) corrupt();
    const lease = await this.backend.lease(fingerprint.fingerprint);
    try {
      const manifest = { version: 1, fingerprint, created_at_ms: Date.now(), archives: [] };
      const inputs = []; let total = 0;
      for (const file of (await readdir(directory)).sort()) {
        if (!file.endsWith('.archive')) continue;
        const key = file.slice(0, -8); if (!name(key)) corrupt();
        const kind = this.kinds[key] || fingerprint.datastores?.[key] || (key.startsWith('path-') ? 'files' : undefined);
        if (!kinds.has(kind)) corrupt();
        const metadata = await lstat(join(directory, file)); if (!metadata.isFile()) corrupt();
        total += metadata.size; inputs.push({ name: key, kind, bytes: metadata.size, file });
      }
      if (total > this.maxSize) throw new SeedStorageFailure('seed_too_large', { largest_archive: [...inputs].sort((a, b) => b.bytes - a.bytes)[0]?.name, bytes: total, max_bytes: this.maxSize });
      for (const input of inputs) {
        const handle = await open(join(directory, input.file), constants.O_RDONLY | constants.O_NOFOLLOW);
        const descriptor = { name: input.name, kind: input.kind, bytes: input.bytes, hash: '', parts: [] }, full = blake3.create();
        try {
          let offset = 0;
          do {
            signal?.throwIfAborted();
            const bytes = Buffer.alloc(Math.min(SEED_PART_BYTES, input.bytes - offset)); let filled = 0;
            while (filled < bytes.length) { const result = await handle.read(bytes, filled, bytes.length - filled, offset + filled); if (!result.bytesRead) corrupt(); filled += result.bytesRead; }
            offset += filled; full.update(bytes);
            const part = { hash: hash(bytes), bytes: bytes.length }; descriptor.parts.push(part);
            await lease.retain(part.hash);
            if (!await this.backend.hasPart(part)) await this.backend.putPart(part, bytes);
          } while (offset < input.bytes);
          if ((await handle.stat()).size !== input.bytes) corrupt();
        } finally { await handle.close(); }
        descriptor.hash = Buffer.from(full.digest()).toString('hex'); manifest.archives.push(descriptor);
      }
      await lease.check(); signal?.throwIfAborted(); await this.backend.publish(manifest, this.maxSize); return manifest;
    } finally { await lease.close(); }
  }
  async restore(directory, { fingerprint, signal } = {}) {
    if (!digest(fingerprint?.fingerprint)) corrupt();
    const lease = await this.backend.lease(fingerprint.fingerprint);
    let staging;
    try {
      const raw = await this.backend.manifest(fingerprint.fingerprint); if (!raw) return false;
      const manifest = validateSeedManifest(raw, this.maxSize);
      if (canonical(manifest.fingerprint) !== canonical(fingerprint)) corrupt();
      await directories(directory); staging = await mkdtemp(join(directory, '.restore-'));
      for (const archive of manifest.archives) {
        const handle = await open(join(staging, archive.name + '.archive'), 'wx', 0o600), full = blake3.create();
        try {
          for (const part of archive.parts) { signal?.throwIfAborted(); const bytes = await this.backend.getPart(part); full.update(bytes); await handle.writeFile(bytes); }
          if (Buffer.from(full.digest()).toString('hex') !== archive.hash) corrupt();
          await handle.sync();
        } finally { await handle.close(); }
      }
      await lease.check(); signal?.throwIfAborted();
      for (const archive of manifest.archives) await rename(join(staging, archive.name + '.archive'), join(directory, archive.name + '.archive'));
      return true;
    } catch (error) {
      if (error.reason === 'seed_corrupt' || error.code === 'ENOENT') { await this.backend.invalidate(fingerprint.fingerprint); throw new SeedStorageFailure('seed_corrupt'); }
      throw error;
    } finally { if (staging) await rm(staging, { recursive: true, force: true }); await lease.close(); }
  }
}
