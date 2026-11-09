import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSeedBackend, HostedSeedBackend, SeedStore, SEED_PART_BYTES } from '../src/seed-store.mjs';

const fingerprint = letter => ({ version: 2, fingerprint: letter.repeat(64), datastores: { shop: 'sqlite' } });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rio-seed-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'captured'); await mkdir(directory);
  await writeFile(join(directory, 'shop.archive'), 'synthetic database'); await writeFile(join(directory, 'path-0.archive'), 'upload files');
  const backend = await LocalSeedBackend.create(join(root, 'cache'));
  return { root, directory, backend, store: new SeedStore({ backend, ...options }) };
}

test('seed snapshots reuse unchanged parts across fingerprints and restore byte-identical archives', async t => {
  const f = await fixture(t); let uploads = 0;
  const put = f.backend.putPart.bind(f.backend); f.backend.putPart = async (...args) => { uploads++; return put(...args); };
  const original = await f.store.publish(f.directory, { fingerprint: fingerprint('a') }); assert.equal(uploads, 2);
  await writeFile(join(f.directory, 'path-0.archive'), 'new uploads');
  await f.store.publish(f.directory, { fingerprint: fingerprint('b') }); assert.equal(uploads, 3);
  const output = join(f.root, 'restored');
  assert.ok(await f.store.restore(output, { fingerprint: fingerprint('a') }));
  assert.equal(await readFile(join(output, 'path-0.archive'), 'utf8'), 'upload files');
  assert.equal(await readFile(join(output, 'shop.archive'), 'utf8'), 'synthetic database');
  assert.equal(original.archives.find(archive => archive.name === 'shop').bytes, 18);
  assert.deepEqual(await readdir(join(f.backend.root, 'leases')), []);
});

test('size cap names the largest archive and publishes nothing', async t => {
  const f = await fixture(t, { maxSize: 20 });
  await assert.rejects(f.store.publish(f.directory, { fingerprint: fingerprint('a') }), error => error.reason === 'seed_too_large' && error.details.largest_archive === 'shop');
  assert.equal(await f.backend.manifest(fingerprint('a').fingerprint), null);
  assert.deepEqual(await readdir(join(f.backend.root, 'objects')), []);
});

test('a tighter restore quota preserves an otherwise valid committed snapshot', async t => {
  const f = await fixture(t), fp = fingerprint('a');
  await f.store.publish(f.directory, { fingerprint: fp });
  const small = new SeedStore({ backend: f.backend, maxSize: 1 });
  await assert.rejects(small.restore(join(f.root, 'too-small'), { fingerprint: fp }), error => error.reason === 'seed_too_large' && error.details.largest_archive === 'shop');
  assert.ok(await f.backend.manifest(fp.fingerprint));
  assert.ok(await f.store.restore(join(f.root, 'enough-space'), { fingerprint: fp }));
});

test('interrupted multipart upload has no commit point and a retry reuses verified parts', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'shop.archive'), Buffer.alloc(SEED_PART_BYTES + 10, 42));
  const put = f.backend.putPart.bind(f.backend); let calls = 0;
  f.backend.putPart = async (...args) => { calls++; if (calls === 3) throw new Error('interrupted upload'); return put(...args); };
  await assert.rejects(f.store.publish(f.directory, { fingerprint: fingerprint('a') }), /interrupted/);
  assert.equal(await f.backend.manifest(fingerprint('a').fingerprint), null);
  assert.equal(await f.store.restore(join(f.root, 'absent'), { fingerprint: fingerprint('a') }), false);
  let retries = 0; f.backend.putPart = async (...args) => { retries++; return put(...args); };
  await f.store.publish(f.directory, { fingerprint: fingerprint('a') }); assert.equal(retries, 1);
  assert.ok(await f.store.restore(join(f.root, 'roundtrip'), { fingerprint: fingerprint('a') }));
  assert.equal((await readFile(join(f.root, 'roundtrip/shop.archive'))).length, SEED_PART_BYTES + 10);
});

test('hash mismatch invalidates the manifest before any archive reaches the restore destination', async t => {
  const f = await fixture(t), fp = fingerprint('a');
  const manifest = await f.store.publish(f.directory, { fingerprint: fp });
  await writeFile(f.backend.objectPath(manifest.archives.at(-1).parts[0].hash), 'corrupt');
  const output = join(f.root, 'restore'); await mkdir(output); await writeFile(join(output, 'retained'), 'untouched');
  await assert.rejects(f.store.restore(output, { fingerprint: fp }), error => error.reason === 'seed_corrupt');
  assert.deepEqual(await readdir(output), ['retained']);
  assert.equal(await f.backend.manifest(fp.fingerprint), null);
});

test('pruning keeps active snapshots and pending upload parts until their leases close', async t => {
  const f = await fixture(t);
  const first = await f.store.publish(f.directory, { fingerprint: fingerprint('a') });
  await writeFile(join(f.directory, 'path-0.archive'), 'later');
  await f.store.publish(f.directory, { fingerprint: fingerprint('b') });
  const active = await f.backend.lease(fingerprint('a').fingerprint);
  assert.deepEqual(await f.backend.prune(1), []);
  await active.close();
  const pending = await f.backend.lease(fingerprint('c').fingerprint);
  const reused = first.archives.find(archive => archive.name === 'path-0').parts[0];
  await pending.retain(reused.hash);
  assert.deepEqual(await f.backend.prune(1), [fingerprint('a').fingerprint]);
  assert.ok(await f.backend.hasPart(reused), 'pending uploads protect reused parts even without a published manifest');
  await pending.close(); await f.backend.prune(1);
  assert.equal(await f.backend.hasPart(reused), false);
  assert.equal(await f.backend.manifest(fingerprint('a').fingerprint), null);
  assert.ok(await f.backend.hasPart(first.archives.find(archive => archive.name === 'shop').parts[0]), 'shared database parts survive pruning');
  assert.ok(await f.store.restore(join(f.root, 'kept'), { fingerprint: fingerprint('b') }));
});

test('hosted transport always addresses the fixed tenant namespace and validates downloaded hashes', async t => {
  const f = await fixture(t); const objects = new Map(), manifests = new Map(), keys = [];
  const backend = new HostedSeedBackend({ tenant: 'tenant-one', transport: {
    async lease(prefix, id) { keys.push(prefix); assert.match(id, /^[a-f0-9]{64}$/); return { async retain() {}, async check() {}, async close() {} }; },
    async hasPart(key) { keys.push(key); return objects.has(key); },
    async putPart(key, _part, bytes) { keys.push(key); objects.set(key, bytes); },
    async getPart(key) { keys.push(key); return objects.get(key); },
    async manifest(key) { keys.push(key); return manifests.get(key) || null; },
    async publish(prefix, manifest) { keys.push(prefix); for (const archive of manifest.archives) for (const part of archive.parts) assert.ok(objects.has(prefix + 'objects/' + part.hash)); manifests.set(prefix + manifest.fingerprint.fingerprint + '/manifest.json', manifest); },
    async invalidate(key) { manifests.delete(key); },
  } });
  const store = new SeedStore({ backend });
  await store.publish(f.directory, { fingerprint: fingerprint('a') });
  assert.ok(await store.restore(join(f.root, 'hosted'), { fingerprint: fingerprint('a') }));
  assert.ok(keys.every(key => key.startsWith('seeds/tenant-one/')));
  assert.throws(() => new HostedSeedBackend({ tenant: '../tenant-two' }));
  objects.set([...objects.keys()][0], Buffer.from('changed'));
  await assert.rejects(store.restore(join(f.root, 'bad'), { fingerprint: fingerprint('a') }), error => error.reason === 'seed_corrupt');
});


test('independent cache clients serialize publication and retain both committed snapshots', async t => {
  const f = await fixture(t), second = new SeedStore({ backend: await LocalSeedBackend.create(f.backend.root) });
  await Promise.all([f.store.publish(f.directory, { fingerprint: fingerprint('a') }), second.publish(f.directory, { fingerprint: fingerprint('b') })]);
  assert.ok(await f.store.restore(join(f.root, 'one'), { fingerprint: fingerprint('a') }));
  assert.ok(await second.restore(join(f.root, 'two'), { fingerprint: fingerprint('b') }));
  assert.equal((await readdir(join(f.backend.root, 'objects'))).length, 2);
});
