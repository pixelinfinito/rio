import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StartupFailure } from './app-runtime.mjs';
import { datastoreAdapters } from './datastores.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function seedSizeBytes(value = '2 GiB') {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const match = /^([1-9][0-9]*) ?(B|KiB|MiB|GiB)$/.exec(value);
  const bytes = match && Number(match[1]) * ({ B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]]);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new StartupFailure('invalid_contract', 'seed.max_size');
  return bytes;
}

/** Seed lifecycle inside app. Snapshot capture precedes persona credential apply.
 * Datastore adapters own archive formats; the external seed store owns hashing,
 * chunking and persistence. */
export class SeedRuntime {
  constructor({ manifest, manifestPath = '.rio/qa/seed/seed.yaml', adapters = {}, store, fingerprint, maxSize, fallbackRebuild = false, fixtureFiles }) {
    this.manifest = manifest; this.manifestPath = manifestPath; this.adapters = { ...datastoreAdapters, ...adapters }; this.store = store;
    this.users = manifest.users || []; this.servers = []; this.datastores = new Map();
    this.fingerprint = fingerprint;
    this.maxSize = seedSizeBytes(maxSize); this.fallbackRebuild = fallbackRebuild;
    this.fixtureFiles = fixtureFiles;
  }
  async prepare({ processes, root }) {
    this.processes = processes; this.root = root;
    this.directory = await mkdtemp(join(tmpdir(), 'rio-qa-seed-'));
    if (this.manifest.paths?.length && !this.adapters.files) throw new StartupFailure('seed_failed', 'paths', { hint: 'A files adapter is required for path snapshots.' });
    for (const declaration of this.manifest.datastores) {
      const factory = this.adapters[declaration.kind] || (declaration.kind === 'sqlite' ? sqliteAdapter : declaration.kind === 'custom' ? customAdapter : undefined);
      if (!factory) throw new StartupFailure('missing_tool', declaration.name, { kind: declaration.kind });
      const adapter = await factory({ declaration, processes, root, directory: this.directory, maxSize: this.maxSize });
      this.datastores.set(declaration.name, adapter);
    }
    for (const [index, path] of (this.manifest.paths || []).entries()) {
      this.datastores.set(`path-${index}`, await this.adapters.files({ declaration: { name: `path-${index}`, path }, processes, root, directory: this.directory, maxSize: this.maxSize }));
    }
  }
  async start({ signal, timeoutMs }) {
    for (const declaration of this.manifest.datastores) {
      const adapter = this.datastores.get(declaration.name);
      await adapter.prepare?.({ signal });
      const command = declaration.start || adapter.start;
      const server = command ? this.processes.start(command, { stage: `datastore:${declaration.name}`, env: adapter.env }) : undefined;
      if (server) this.servers.push(server);
      const ready = declaration.ready || adapter.ready;
      if (!ready) continue;
      const deadline = Date.now() + timeoutMs;
      let success = false;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (server?.settled && server.exitCode !== 0) break;
        try {
          await this.processes.run(ready, { stage: `datastore:${declaration.name}:ready`, reason: 'datastore_not_ready', signal, env: adapter.env, timeoutMs: Math.min(1000, Math.max(1, deadline - Date.now())) });
          success = true; break;
        } catch (error) { if (signal?.aborted) throw error; }
        await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
      if (!success) throw new StartupFailure('datastore_not_ready', declaration.name);
      await adapter.initialize?.({ signal });
    }
  }
  async restoreOrBuild({ signal }) {
    const started = performance.now();
    // Recovery and fallback must start from initialized, unseeded stores. Merely
    // rerunning SQL over a previous journey would retain its accounts and orders.
    // These private transient archives are never uploaded or credentialed.
    if (this.fallbackRebuild && !this.pristine) {
      this.pristine = join(this.directory, 'pristine'); await mkdir(this.pristine);
      for (const [name, adapter] of this.datastores) await adapter.capture(join(this.pristine, `${name}.archive`), { signal, maxSize: Number.MAX_SAFE_INTEGER });
    }
    const pristine = async () => { for (const [name, adapter] of this.datastores) await adapter.restore(join(this.pristine, `${name}.archive`), { signal, maxSize: Number.MAX_SAFE_INTEGER }); };
    if (this.rebuilding) await pristine();
    if (!this.captured && !this.rebuilding && this.store) {
      try { this.captured = await this.store.restore(this.directory, { signal, fingerprint: this.fingerprint }); }
      catch (error) {
        if (error.reason === 'seed_too_large' && this.fallbackRebuild) {
          await this.processes.record({ kind: 'seed', action: 'cache_over_quota', reason: 'seed_too_large', ...error.details, fingerprint: this.fingerprint?.fingerprint });
        } else if (error.reason === 'seed_corrupt') {
          await this.processes.record({ kind: 'seed', action: 'invalidated', reason: 'seed_corrupt', fingerprint: this.fingerprint?.fingerprint });
        } else throw new StartupFailure(error.reason || 'seed_failed', 'seed:restore', error.details);
      }
    }
    if (this.captured) {
      let applying = false;
      try {
        // Validate every structured archive before mutating any datastore. An
        // invalid files archive must not leave preceding databases restored.
        for (const [name, adapter] of this.datastores) await adapter.validate?.(this.archive(name), { signal });
        applying = true;
        for (const [name, adapter] of this.datastores) await adapter.restore(this.archive(name), { signal });
        await this.processes.record({ kind: 'seed', action: 'restored', fingerprint: this.fingerprint?.fingerprint, duration_ms: Math.round(performance.now() - started) });
        return;
      } catch (error) {
        if (error.reason !== 'seed_corrupt' || signal?.aborted) throw error;
        await this.store?.invalidate?.({ fingerprint: this.fingerprint, signal });
        await this.processes.record({ kind: 'seed', action: 'invalidated', reason: 'seed_corrupt', fingerprint: this.fingerprint?.fingerprint });
        if (applying && !this.pristine) throw error;
        if (this.pristine) await pristine(); this.captured = false;
      }
    }
    for (const step of this.manifest.steps) {
      signal?.throwIfAborted();
      if (step.command) await this.processes.run(step.command, { stage: 'seed:build', reason: 'seed_failed', signal });
      else {
        const path = resolve(this.root, dirname(this.manifestPath), step.file);
        const content = await readFile(path);
        for (const target of step.applies_to) {
          const adapter = this.datastores.get(target);
          if (!adapter?.load) throw new StartupFailure('seed_failed', target, { hint: 'Use a command step for this datastore.' });
          await adapter.load(content, { signal });
        }
      }
    }
    await this.fixtureFiles?.generate({ signal });
    if (!this.rebuilding) {
      try {
        const sizes = [];
        for (const [name, adapter] of this.datastores) {
          await adapter.capture(this.archive(name), { signal });
          const info = await lstat(this.archive(name));
          if (!info.isFile()) throw new StartupFailure('seed_corrupt', name);
          sizes.push({ name, bytes: info.size });
        }
        const bytes = sizes.reduce((sum, archive) => sum + archive.bytes, 0);
        if (bytes > this.maxSize) throw new StartupFailure('seed_too_large', 'seed:capture', { largest_archive: sizes.sort((a, b) => b.bytes - a.bytes)[0]?.name, bytes, max_bytes: this.maxSize });
        await this.store?.publish(this.directory, { signal, fingerprint: this.fingerprint });
        this.captured = true;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error.reason !== 'seed_too_large' || !this.fallbackRebuild) throw new StartupFailure(error.reason || 'seed_failed', 'seed:capture', error.details);
        this.rebuilding = true;
        await this.processes.record({ kind: 'seed', action: 'fallback_rebuild', reason: 'seed_too_large', ...error.details, fingerprint: this.fingerprint?.fingerprint });
        for (const name of this.datastores.keys()) await rm(this.archive(name), { force: true });
      }
    }
    await this.processes.record({ kind: 'seed', action: 'built', ...(this.rebuilding ? { fallback_rebuild: true } : {}), fingerprint: this.fingerprint?.fingerprint, duration_ms: Math.round(performance.now() - started) });
  }
  archive(name) { return join(this.directory, `${name}.archive`); }
  async stop() {
    for (const server of this.servers.reverse()) await this.processes.stop(server);
    this.servers = [];
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

export async function sqliteAdapter({ declaration, processes }) {
  const binary = quote(await processes.executable('sqlite3'));
  const connection = processes.env[declaration.connection_env];
  if (!connection) throw new StartupFailure('seed_failed', declaration.name, { hint: 'Set the declared connection environment variable.' });
  const path = resolve(processes.cwd, connection.replace(/^sqlite:\/\//, ''));
  await mkdir(dirname(path), { recursive: true });
  const run = (command, options) => processes.run(command, { stage: `seed:${declaration.name}`, reason: 'seed_failed', ...options });
  return {
    ready: `${binary} ${quote(path)} 'SELECT 1;'`,
    load: (content, options) => run(`${binary} -bail ${quote(path)}`, { ...options, input: content }),
    capture: (archive, options) => run(`${binary} ${quote(path)} ${quote(`.backup '${archive}'`)}`, options),
    async restore(archive, { signal }) {
      signal?.throwIfAborted();
      // ApplicationRuntime has already stopped every application connection.
      const temporary = path + '.rio-restore';
      await copyFile(archive, temporary);
      await rm(path + '-wal', { force: true }); await rm(path + '-shm', { force: true });
      await rename(temporary, path);
    },
  };
}

export async function customAdapter({ declaration, processes }) {
  const run = (command, options) => processes.run(command, { stage: `seed:${declaration.name}`, reason: 'seed_failed', ...options });
  return {
    async capture(archive, options) {
      await run(`( ${declaration.capture}\n) > ${quote(archive)}`, options);
      if (!(await stat(archive)).isFile()) throw new StartupFailure('seed_failed', declaration.name);
    },
    restore: (archive, options) => run(`( ${declaration.restore}\n) < ${quote(archive)}`, options),
  };
}
