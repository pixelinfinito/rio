import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { FixtureFiles, fixtureSeedManifest, generatedFixturePath } from '../src/fixture-files.mjs';
import { AppProcesses } from '../src/app-runtime.mjs';
import { SeedRuntime } from '../src/seed-runtime.mjs';
import { SeedStore, LocalSeedBackend } from '../src/seed-store.mjs';

test('generated formats are valid, large CSV streams, and chain resets restore the files archive', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rio-generated-fixtures-'));
  const processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH } });
  const files = [
    { name: 'contacts', generate: { kind: 'csv', rows: 200000 } },
    { name: 'picture', generate: { kind: 'image', width: 17, height: 23, size: 2048 } },
    { name: 'document', generate: { kind: 'pdf', size: 2048 } },
    { name: 'objects', generate: { kind: 'json', rows: 7, size: 2048 } },
    { name: 'notes', generate: { kind: 'text', size: 4096 } },
    { name: 'bytes', generate: { kind: 'binary', size: 8192 } },
  ];
  const fixtures = new FixtureFiles({ root, files, maxSize: 32 * 1024 ** 2 });
  let generated = 0; const generate = fixtures.generate.bind(fixtures); fixtures.generate = options => { generated++; return generate(options); };
  const fingerprint = { fingerprint: 'f'.repeat(64), datastores: {} };
  const backend = await LocalSeedBackend.create(join(root, 'cache')), store = new SeedStore({ backend });
  const options = { manifest: fixtureSeedManifest({ datastores: [], steps: [], users: [], paths: [] }, { files }), fixtureFiles: fixtures, maxSize: 32 * 1024 ** 2, fingerprint, store };
  const seed = new SeedRuntime(options), nextRun = new SeedRuntime(options);
  t.after(async () => { await seed.stop(); await nextRun.stop(); await processes.close(); await rm(root, { recursive: true, force: true }); });
  await seed.prepare({ processes, root }); await seed.start({ timeoutMs: 1000 }); await seed.restoreOrBuild({});
  const csv = await readFile(join(root, generatedFixturePath, 'contacts.csv'), 'utf8');
  assert.equal(csv.trimEnd().split('\n').length, 200001); assert.match(csv, /person200000@example.test/);
  const image = await readFile(join(root, generatedFixturePath, 'picture.png'));
  assert.equal(image.readUInt32BE(16), 17); assert.equal(image.readUInt32BE(20), 23); assert.ok(image.length >= 2048);
  const compressed = []; for (let at = 8; at < image.length;) { const size = image.readUInt32BE(at); if (image.toString('ascii', at + 4, at + 8) === 'IDAT') compressed.push(image.subarray(at + 8, at + 8 + size)); at += size + 12; }
  assert.equal(inflateSync(Buffer.concat(compressed)).length, (17 * 3 + 1) * 23);
  const pdf = await readFile(join(root, generatedFixturePath, 'document.pdf'), 'utf8'); assert.ok(pdf.startsWith('%PDF-1.4')); assert.ok(pdf.endsWith('%%EOF\n')); assert.equal(pdf.length, 2048);
  assert.equal(JSON.parse(await readFile(join(root, generatedFixturePath, 'objects.json'), 'utf8')).length, 7);
  const file = await fixtures.open('bytes'); assert.equal(file.bytes, 8192); assert.equal(file.filename, 'bytes.bin'); await file.handle.close();
  await writeFile(join(root, generatedFixturePath, 'contacts.csv'), 'mutated by app');
  await seed.restoreOrBuild({});
  assert.equal(generated, 1); assert.equal(await readFile(join(root, generatedFixturePath, 'contacts.csv'), 'utf8'), csv);
  assert.equal((await backend.manifest(fingerprint.fingerprint)).archives[0].kind, 'files');
  await rm(join(root, generatedFixturePath), { recursive: true });
  await nextRun.prepare({ processes, root }); await nextRun.restoreOrBuild({});
  assert.equal(generated, 1, 'a later run must restore the generated files from persistent storage');
  assert.equal(await readFile(join(root, generatedFixturePath, 'contacts.csv'), 'utf8'), csv);
  await assert.rejects(fixtures.open('../outside'));
  await rm(join(root, generatedFixturePath, 'notes.txt')); await symlink('/etc/passwd', join(root, generatedFixturePath, 'notes.txt'));
  await assert.rejects(fixtures.open('notes'));
});

test('generation observes seed byte quota and cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rio-generated-limits-'));
  const processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH } });
  const files = [{ name: 'large', generate: { kind: 'binary', size: 100000 } }];
  const fixtures = new FixtureFiles({ root, files, maxSize: 20000 });
  const seed = new SeedRuntime({ manifest: fixtureSeedManifest({ datastores: [], paths: [] }, { files }) });
  t.after(async () => { await seed.stop(); await processes.close(); await rm(root, { recursive: true, force: true }); });
  await seed.prepare({ processes, root });
  await assert.rejects(fixtures.generate(), { reason: 'seed_too_large' });
  await assert.rejects(fixtures.generate({ signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});
