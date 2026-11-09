// Run explicitly inside the deliberately provisioned fixture image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppProcesses } from '../src/app-runtime.mjs';
import { SeedRuntime } from '../src/seed-runtime.mjs';

for (const kind of ['sqlite', 'postgres', 'mysql', 'redis']) test(`${kind} captures synthetic state and restores the database after mutations`, { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rio-database-'));
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const url = kind === 'sqlite' ? 'shop.sqlite' : `${kind}://127.0.0.1:${port}/${kind === 'redis' ? '0' : 'shop'}`;
  const records = [], processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH, HOME: root, DB: url }, record: async entry => records.push(entry) });
  const seed = new SeedRuntime({ manifest: { datastores: [{ name: 'shop', kind, connection_env: 'DB' }], steps: [], users: [], paths: [] } });
  try {
    await seed.prepare({ processes, root }); await seed.start({ timeoutMs: 30000 });
    const adapter = seed.datastores.get('shop');
    const redis = text => Buffer.from(text.split(' ').map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join(''));
    const redisCommand = text => Buffer.concat([Buffer.from(`*${text.split(' ').length}\r\n`), redis(text)]);
    await adapter.load(kind === 'redis' ? redisCommand('SET retained original') : Buffer.from('CREATE TABLE retained (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO retained VALUES (1, \'original\');'), {});
    await seed.restoreOrBuild({});
    await adapter.load(kind === 'redis' ? Buffer.concat([redisCommand('SET retained changed'), redisCommand('SET extra mutation')]) : Buffer.from("UPDATE retained SET label='changed'; CREATE TABLE extra (id INTEGER);"), {});
    await seed.restoreOrBuild({});
    if (kind === 'sqlite') {
      const result = await processes.run(['sqlite3', 'shop.sqlite', 'SELECT label FROM retained; SELECT count(*) FROM sqlite_master WHERE name=\'extra\';'], { stage: 'assert', reason: 'test' });
      assert.equal(result.stdout.toString().trim(), 'original\n0');
    } else if (kind === 'postgres') {
      const result = await processes.run(['psql', '--no-psqlrc', '-tA', '-c', "SELECT label FROM retained; SELECT count(*) FROM pg_tables WHERE tablename='extra';"], { stage: 'assert', reason: 'test', env: adapter.env });
      assert.equal(result.stdout.toString().trim(), 'original\n0');
    } else if (kind === 'mysql') {
      const result = await processes.run(['mariadb', '--protocol=TCP', '-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-N', 'shop', '-e', "SELECT label FROM retained; SELECT count(*) FROM information_schema.tables WHERE table_schema='shop' AND table_name='extra';"], { stage: 'assert', reason: 'test', env: adapter.env });
      assert.equal(result.stdout.toString().trim(), 'original\n0');
    } else {
      const result = await processes.run(['redis-cli', '-p', String(port), '--raw', 'MGET', 'retained', 'extra'], { stage: 'assert', reason: 'test', env: adapter.env });
      assert.equal(result.stdout.toString(), 'original\n\n');
    }
    assert.ok(records.some(entry => entry.action === 'built')); assert.ok(records.some(entry => entry.action === 'restored'));
    assert.ok((await readFile(seed.archive('shop'))).byteLength > 0);
  } catch (error) { throw new Error(`${kind}: ${error.message}\n${JSON.stringify(records.slice(-6))}`); }
  finally { await seed.stop(); await processes.close(); await rm(root, { recursive: true, force: true }); }
});
