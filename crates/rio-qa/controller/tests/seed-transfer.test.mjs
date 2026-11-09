import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppSeedTransfer, SeedTransferClient } from '../src/seed-transfer.mjs';
import { LocalSeedBackend, SeedStore } from '../src/seed-store.mjs';
import { SeedRuntime, seedSizeBytes } from '../src/seed-runtime.mjs';
import { AppProcesses } from '../src/app-runtime.mjs';

const fingerprint = { version: 2, fingerprint: 'a'.repeat(64), datastores: { accounts: 'custom' } };
async function fixture(t, { maxSize = 1024 * 1024, fallbackRebuild = false, storeMaxSize = maxSize, persistent = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rio-transfer-test-'));
  const events = [];
  const processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH }, record: async event => events.push(event) });
  await writeFile(join(root, 'accounts'), '');
  const backend = await LocalSeedBackend.create(join(root, 'cache'));
  const store = new SeedStore({ backend, maxSize: storeMaxSize });
  const transfer = new AppSeedTransfer({ names: ['accounts'], maxSize, timeoutMs: 5000 });
  const server = createServer(async (request, response) => {
    if (!await transfer.handle(request, response)) { response.writeHead(404); response.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = await new SeedTransferClient({ baseURL: `http://127.0.0.1:${server.address().port}`, store, fingerprint, names: ['accounts'], timeoutMs: 5000 }).start();
  const runtime = () => new SeedRuntime({ fingerprint, store: persistent ? transfer : undefined, maxSize, fallbackRebuild, manifest: {
    datastores: [{ name: 'accounts', kind: 'custom', capture: 'cat accounts', restore: 'cat > accounts' }],
    steps: [{ command: "printf 'seed-row\n' >> accounts; printf x >> build-count", applies_to: ['accounts'] }], paths: [], users: [],
  } });
  const seeds = [];
  const start = async () => { const seed = runtime(); seeds.push(seed); await seed.prepare({ processes, root }); await seed.start({ timeoutMs: 1000 }); await seed.restoreOrBuild({}); return seed; };
  t.after(async () => {
    await client.close(); await new Promise(resolve => server.close(resolve));
    for (const seed of seeds) await seed.stop(); await processes.close(); await rm(root, { recursive: true, force: true });
  });
  return { root, events, backend, store, transfer, client, server, start };
}

test('passive transfer persists pre-credential seeds and restores across runs with a job lease', async t => {
  const f = await fixture(t);
  const first = await f.start();
  await writeFile(join(f.root, 'accounts'), 'credentialed user and order');
  await first.restoreOrBuild({});
  assert.equal(await readFile(join(f.root, 'accounts'), 'utf8'), 'seed-row\n');
  await writeFile(join(f.root, 'accounts'), 'rotated credentials');
  await first.stop();
  await f.start();
  assert.equal(await readFile(join(f.root, 'accounts'), 'utf8'), 'seed-row\n');
  assert.equal(await readFile(join(f.root, 'build-count'), 'utf8'), 'x', 'second run must not execute seed steps');
  assert.deepEqual(await f.backend.prune(0), [], 'job-duration lease must protect the seed between operations');
  await f.client.close();
  assert.deepEqual(await f.backend.prune(0), [fingerprint.fingerprint]);
  assert.deepEqual(await readdir(join(f.backend.root, 'leases')), []);
});

test('quota is enforced even without a persistent store and names the largest archive', async t => {
  const f = await fixture(t, { maxSize: 3, persistent: false });
  await assert.rejects(f.start(), error => error.reason === 'seed_too_large' && error.details.largest_archive === 'accounts');
  assert.equal(await f.backend.manifest(fingerprint.fingerprint), null);
  assert.ok(!f.events.some(event => event.action === 'fallback_rebuild'));
});

test('opted-in fallback rebuilds from pristine stores and never retains a previous chain record', async t => {
  const f = await fixture(t, { maxSize: 3, fallbackRebuild: true });
  const seed = await f.start();
  for (let chain = 0; chain < 3; chain++) {
    await writeFile(join(f.root, 'accounts'), 'registered-account\norder\n');
    await seed.restoreOrBuild({});
    assert.equal(await readFile(join(f.root, 'accounts'), 'utf8'), 'seed-row\n');
  }
  assert.equal(await readFile(join(f.root, 'build-count'), 'utf8'), 'xxxx');
  assert.equal(await f.backend.manifest(fingerprint.fingerprint), null);
  assert.equal(f.events.filter(event => event.action === 'fallback_rebuild').length, 1);
  assert.equal(f.events.filter(event => event.action === 'built' && event.fallback_rebuild).length, 4);
});

test('controller quota rejection reaches app and selects the explicit fallback policy', async t => {
  const f = await fixture(t, { maxSize: 100, storeMaxSize: 3, fallbackRebuild: true });
  const seed = await f.start();
  assert.equal(seed.rebuilding, true);
  assert.equal(f.events.find(event => event.action === 'fallback_rebuild').largest_archive, 'accounts');
  assert.equal(await f.backend.manifest(fingerprint.fingerprint), null);
});

test('corrupted persistent part invalidates and rebuilds through the transfer channel', async t => {
  const f = await fixture(t);
  const first = await f.start(); await first.stop();
  const manifest = await f.backend.manifest(fingerprint.fingerprint);
  await writeFile(f.backend.objectPath(manifest.archives[0].parts[0].hash), 'broken');
  await writeFile(join(f.root, 'accounts'), '');
  await f.start();
  assert.equal(await readFile(join(f.root, 'build-count'), 'utf8'), 'xx');
  assert.ok(f.events.some(event => event.action === 'invalidated' && event.reason === 'seed_corrupt'));
  const output = join(f.root, 'verified'); await mkdir(output);
  assert.ok(await f.store.restore(output, { fingerprint }));
  assert.equal(await readFile(join(output, 'accounts.archive'), 'utf8'), 'seed-row\n');
});

test('interrupted transfer cannot publish a manifest and abort releases the pending startup', async t => {
  const f = await fixture(t);
  await f.client.close();
  const controller = new AbortController();
  const directory = join(f.root, 'aborted'); await mkdir(directory);
  const operation = f.transfer.restore(directory, { signal: controller.signal });
  controller.abort(new Error('run cancelled'));
  await assert.rejects(operation, /run cancelled/);
  assert.equal(f.transfer.pending, undefined);
  assert.equal(await f.backend.manifest(fingerprint.fingerprint), null);
});

test('archive transfer rejects undeclared names and incomplete restore without exposing a finished seed', async t => {
  const f = await fixture(t); await f.client.close();
  const directory = join(f.root, 'incomplete'); await mkdir(directory);
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const invalid = f.transfer.restore(directory, {});
  const invalidRejected = assert.rejects(invalid, error => error.reason === 'seed_transfer_failed');
  const denied = await fetch(`${base}/seed/${f.transfer.pending.id}/archives/undeclared`, { method: 'PUT', body: 'untrusted' });
  assert.equal(denied.status, 400); await denied.body.cancel(); await invalidRejected;
  const pending = f.transfer.restore(directory, {});
  const rejected = assert.rejects(pending, error => error.reason === 'seed_corrupt');
  const id = f.transfer.pending.id;
  const response = await fetch(`${base}/seed/${id}/complete`, { method: 'POST', body: JSON.stringify({ restored: true }) });
  assert.equal(response.status, 400); await response.body.cancel(); await rejected;
  assert.deepEqual(await readdir(directory), []);
});

test('seed quota parser matches the contract units', () => {
  assert.equal(seedSizeBytes('9 B'), 9); assert.equal(seedSizeBytes('1KiB'), 1024);
  assert.equal(seedSizeBytes(), 2 * 1024 ** 3);
  assert.throws(() => seedSizeBytes('9007199254740992 GiB'));
  assert.throws(() => seedSizeBytes('0 B'));
});

test('a valid part hash cannot make a malformed files archive mutate a preceding datastore', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rio-seed-validation-'));
  const processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH } });
  const backend = await LocalSeedBackend.create(join(root, 'cache'));
  const store = new SeedStore({ backend });
  const fp = { version: 2, fingerprint: 'b'.repeat(64), datastores: { accounts: 'custom' } };
  const captured = join(root, 'captured'); await mkdir(captured);
  await writeFile(join(captured, 'accounts.archive'), 'must never be applied');
  await writeFile(join(captured, 'path-0.archive'), 'valid hash, invalid archive');
  const invalid = await store.publish(captured, { fingerprint: fp });
  await writeFile(join(root, 'accounts'), '');
  const seed = new SeedRuntime({ store, fingerprint: fp, manifest: {
    datastores: [{ name: 'accounts', kind: 'custom', capture: 'cat accounts', restore: 'cat > accounts' }],
    paths: ['uploads'], users: [], steps: [{ command: "test ! -s accounts && printf rebuilt > accounts && printf fixture > uploads/file", applies_to: ['accounts'] }],
  } });
  t.after(async () => { await seed.stop(); await processes.close(); await rm(root, { recursive: true, force: true }); });
  await seed.prepare({ root, processes }); await seed.start({ timeoutMs: 1000 }); await seed.restoreOrBuild({});
  assert.equal(await readFile(join(root, 'accounts'), 'utf8'), 'rebuilt');
  assert.equal(await readFile(join(root, 'uploads/file'), 'utf8'), 'fixture');
  assert.notEqual((await backend.manifest(fp.fingerprint)).archives.find(archive => archive.name === 'path-0').hash, invalid.archives.find(archive => archive.name === 'path-0').hash);
});

test('files capture quota keeps its named failure and fallback restores clean directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rio-seed-files-fallback-'));
  const processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH } });
  const seed = new SeedRuntime({ maxSize: 10, fallbackRebuild: true, manifest: {
    datastores: [], users: [], paths: ['uploads'],
    steps: [{ command: "printf synthetic-long-fixture > uploads/file", applies_to: [] }],
  } });
  t.after(async () => { await seed.stop(); await processes.close(); await rm(root, { recursive: true, force: true }); });
  await seed.prepare({ root, processes }); await seed.start({ timeoutMs: 1000 }); await seed.restoreOrBuild({});
  assert.equal(seed.rebuilding, true);
  await writeFile(join(root, 'uploads/journey-record'), 'must not survive');
  await seed.restoreOrBuild({});
  assert.deepEqual(await readdir(join(root, 'uploads')), ['file']);
});

test('replay refuses a missing retained seed before starting the transfer or rebuilding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rio-replay-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = await LocalSeedBackend.create(root), store = new SeedStore({ backend, maxSize: 1024 });
  let requests = 0;
  const client = new SeedTransferClient({ baseURL: 'http://127.0.0.1:1', store, fingerprint, names: ['accounts'], requireExisting: true,
    fetchImpl: () => { requests++; throw new Error('Must not start app seed protocol'); } });
  await assert.rejects(client.start(), /seed_transfer_failed/);
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(join(root, 'leases')), []);
  assert.equal(await backend.manifest(fingerprint.fingerprint), null);
});


test('forced build bypasses a valid cached snapshot and publishes a new seed', async t => {
  const f = await fixture(t);
  const first = await f.start(); await first.stop();
  f.client.forceRebuild = true;
  await writeFile(join(f.root, 'accounts'), '');
  await f.start();
  assert.equal(await readFile(join(f.root, 'build-count'), 'utf8'), 'xx');
  assert.equal(await readFile(join(f.root, 'accounts'), 'utf8'), 'seed-row\n');
  assert.equal(f.events.filter(event => event.action === 'built').length, 2);
  assert.ok(await f.backend.manifest(fingerprint.fingerprint));
});
