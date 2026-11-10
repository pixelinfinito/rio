import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppProcesses } from '../src/app-runtime.mjs';
import { SeedRuntime } from '../src/seed-runtime.mjs';
import { postgresAdapter, mysqlAdapter, redisAdapter, filesAdapter } from '../src/datastores.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rio-seed-adapter-'));
  const processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH, HOME: root }, record: async () => {} });
  t.after(async () => { await processes.close(); await rm(root, { recursive: true, force: true }); });
  return { root, directory: root, processes };
}

test('files adapter restores regular files and empty directories and removes state from the previous chain', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'uploads/empty'), { recursive: true });
  await writeFile(join(f.root, 'uploads/input.csv'), 'id,name\n1,Example\n');
  const adapter = await filesAdapter({ ...f, declaration: { name: 'uploads', path: 'uploads' } });
  const archive = join(f.root, 'files.archive');
  await adapter.capture(archive, {});
  const captured = await readFile(archive);
  await adapter.capture(archive, {}); assert.deepEqual(await readFile(archive), captured, 'archives are stable for content-addressed reuse');
  await writeFile(join(f.root, 'uploads/input.csv'), 'changed'); await writeFile(join(f.root, 'uploads/created.txt'), 'mutated');
  await adapter.restore(archive, {});
  assert.equal(await readFile(join(f.root, 'uploads/input.csv'), 'utf8'), 'id,name\n1,Example\n');
  assert.deepEqual((await readdir(join(f.root, 'uploads'))).sort(), ['empty', 'input.csv']);
  await symlink('/etc', join(f.root, 'uploads/link'));
  await assert.rejects(adapter.capture(archive, {}), error => error.reason === 'seed_failed');
});

test('path snapshots and custom archives participate in the default seed restore lifecycle', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'uploads'));
  const seed = new SeedRuntime({ manifest: { datastores: [{ name: 'custom', kind: 'custom', capture: 'cat custom-state', restore: 'cat > custom-state' }],
    paths: ['uploads'], users: [], steps: [{ command: "printf original > custom-state; printf upload > uploads/input.txt", applies_to: ['custom'] }] } });
  t.after(() => seed.stop());
  await seed.prepare({ root: f.root, processes: f.processes }); await seed.start({ timeoutMs: 1000 });
  await seed.restoreOrBuild({}); await writeFile(join(f.root, 'custom-state'), 'mutated'); await writeFile(join(f.root, 'uploads/input.txt'), 'mutated');
  await seed.restoreOrBuild({});
  assert.equal(await readFile(join(f.root, 'custom-state'), 'utf8'), 'original');
  assert.equal(await readFile(join(f.root, 'uploads/input.txt'), 'utf8'), 'upload');
});

test('files snapshots reject escaped paths and symlinked destinations before mutation', async t => {
  const f = await fixture(t);
  await symlink(tmpdir(), join(f.root, 'outside'));
  for (const path of ['../escape', '/', '.', 'outside/escape']) await assert.rejects(filesAdapter({ ...f, declaration: { name: 'bad', path } }));
});

test('missing datastore binaries fail by name before starting app or seed commands', async () => {
  for (const [factory, kind, url] of [[mysqlAdapter, 'mysql', 'mysql://root@127.0.0.1/shop'], [redisAdapter, 'redis', 'redis://127.0.0.1']]) {
    await assert.rejects(factory({ declaration: { name: 'database', kind, connection_env: 'DB' }, processes: { env: { DB: url }, secrets: [], executable: async name => { throw Object.assign(new Error('missing'), { reason: 'missing_tool', stage: name }); } }, directory: '/tmp' }), error => error.reason === 'missing_tool');
  }
  // Remote datastore addresses never turn local startup into a production connection.
  await assert.rejects(postgresAdapter({ declaration: { name: 'pg', connection_env: 'DB' }, processes: { env: { DB: 'postgres://production.example/shop' }, secrets: [] } }), error => error.reason === 'seed_failed');
});
