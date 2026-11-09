import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, symlink, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationRuntime, AppProcesses, StartupFailure } from '../src/app-runtime.mjs';
import { SeedRuntime } from '../src/seed-runtime.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rio-startup-'));
  const portServer = createServer().listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  await writeFile(join(root, 'app.cjs'), `const fs=require('node:fs'); if(!fs.existsSync('credential-applied') || !fs.existsSync('services-ready'))process.exit(3); fs.writeFileSync('app-clock',process.env.QA_FAKE_TIME||'unset'); require('node:http').createServer((q,s)=>s.end('ready')).listen(${port},'127.0.0.1');`);
  await writeFile(join(root, 'apply.cjs'), "const fs=require('node:fs'); fs.writeFileSync('credential-applied',process.env.QA_PASSWORD); console.log(process.env.QA_PASSWORD); if(process.env.OPENAI_API_KEY)process.exit(8);");
  const events = [], order = [];
  const contract = { app: { packaging: 'vendored', start: `${process.execPath} app.cjs`, url: `http://app:${port}`, ready: { path: '/', status: 200, timeout: '3s' }, seed: "echo hook > hook-ran" }, personas: [{ name: 'shopper', password_env: 'QA_PASSWORD' }] };
  const seed = {
    users: [{ persona: 'shopper', apply: `${process.execPath} apply.cjs` }],
    async start() { order.push('datastores'); },
    async restoreOrBuild() { order.push('seed'); }, async stop() {},
  };
  const services = {
    async start() { order.push('services'); assert.equal(await readFile(join(root, 'credential-applied'), 'utf8'), 'synthetic-one'); await writeFile(join(root, 'services-ready'), 'yes'); },
    async reset() { order.push('reset-services'); }, async stop() {},
  };
  const runtime = new ApplicationRuntime({ root, contract, seed, services, credentials: { QA_PASSWORD: 'synthetic-one' }, record: async event => events.push(event) });
  return { root, runtime, order, events, async close() { await runtime.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('startup order applies credentials before services and runs hook after app readiness', async () => {
  const f = await fixture();
  try {
    f.runtime.context = { time: '2026-12-31T23:59:00Z' };
    await f.runtime.start();
    assert.equal(await readFile(join(f.root, 'app-clock'), 'utf8'), '2026-12-31T23:59:00.000Z');
    assert.deepEqual(f.order, ['datastores', 'seed', 'services']);
    assert.deepEqual(f.events.filter(event => event.kind === 'stage' && event.state === 'ready').map(event => event.stage), ['datastores', 'seed', 'credentials', 'services', 'app', 'app.seed']);
    assert.equal((await readFile(join(f.root, 'hook-ran'), 'utf8')).trim(), 'hook');
    assert.ok(!JSON.stringify(f.events).includes('synthetic-one'));
    f.runtime.credentials.QA_PASSWORD = 'synthetic-two';
    await f.runtime.reset();
    assert.equal(await readFile(join(f.root, 'credential-applied'), 'utf8'), 'synthetic-two');
    assert.ok(!JSON.stringify(f.events).includes('synthetic-two'));
    assert.deepEqual(f.order, ['datastores', 'seed', 'services', 'seed', 'reset-services']);
  } finally { await f.close(); }
});
test('early app exit names app_not_ready and preserves sanitized output', async () => {
  const f = await fixture();
  f.runtime.contract.app.start = "echo 'Bearer synthetic-token' >&2; exit 9";
  try {
    await assert.rejects(f.runtime.start(), error => error.reason === 'app_not_ready');
    const output = f.events.find(event => event.kind === 'stage_output' && event.stage === 'app');
    assert.match(output.stderr, /\[redacted\]/);
    assert.equal(output.exit_code, 9);
    assert.equal(f.runtime.processes.children.size, 0);
  } finally { await f.close(); }
});
test('a cached seed restores across runtimes before the rotated credential is applied', async () => {
  const f = await fixture();
  const cache = await mkdtemp(join(tmpdir(), 'rio-seed-cache-'));
  const events = []; let publications = 0, builds = 0;
  const fingerprint = { fingerprint: 'a'.repeat(64), cache_version: 'v1' };
  const store = {
    async restore(directory, options) {
      assert.deepEqual(options.fingerprint, fingerprint);
      if (!publications) return false;
      for (const name of await readdir(cache)) await copyFile(join(cache, name), join(directory, name));
      return true;
    },
    async publish(directory, options) {
      assert.deepEqual(options.fingerprint, fingerprint);
      assert.equal(await readFile(join(directory, 'accounts.archive'), 'utf8'), 'uncredentialed seed');
      for (const name of await readdir(directory)) await copyFile(join(directory, name), join(cache, name));
      publications++;
    },
  };
  const seed = () => new SeedRuntime({ fingerprint, store, manifest: {
    datastores: [{ name: 'accounts', kind: 'custom', capture: 'cat credential-applied', restore: 'cat > credential-applied' }],
    steps: [{ command: "printf 'uncredentialed seed' > credential-applied", applies_to: ['accounts'] }],
    users: [{ persona: 'shopper', apply: `${process.execPath} apply.cjs` }], paths: [],
  } });
  try {
    f.runtime.seed = seed();
    f.runtime.record = async event => { events.push(event); if (event.kind === 'seed' && event.action === 'built') builds++; };
    await f.runtime.start();
    assert.equal(await readFile(join(f.root, 'credential-applied'), 'utf8'), 'synthetic-one');
    await f.runtime.stop();
    f.runtime.seed = seed();
    f.runtime.credentials.QA_PASSWORD = 'synthetic-two';
    f.runtime.services.start = async () => { assert.equal(await readFile(join(f.root, 'credential-applied'), 'utf8'), 'synthetic-two'); };
    await f.runtime.start();
    assert.equal(await readFile(join(f.root, 'credential-applied'), 'utf8'), 'synthetic-two');
    assert.equal(builds, 1); assert.equal(publications, 1);
    const restores = events.filter(event => event.kind === 'seed' && event.action === 'restored');
    assert.equal(restores.length, 1); assert.equal(restores[0].fingerprint, fingerprint.fingerprint);
    assert.ok(restores[0].duration_ms >= 0);
    assert.ok(!JSON.stringify(events).includes('synthetic-two'));
    assert.equal(await readFile(join(cache, 'accounts.archive'), 'utf8'), 'uncredentialed seed');
  } finally { await f.close(); await rm(cache, { recursive: true, force: true }); }
});
test('static app starts from its declared directory and refuses symlink escape', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'rio-static-outside-'));
  f.runtime.contract.app.packaging = 'static'; f.runtime.contract.app.directory = '.'; delete f.runtime.contract.app.start;
  try {
    await writeFile(join(f.root, 'index.html'), '<h1>Static QA</h1>');
    await writeFile(join(outside, 'outside.txt'), 'outside-root');
    await symlink(join(outside, 'outside.txt'), join(f.root, 'escape.txt'));
    await f.runtime.start();
    const base = f.runtime.contract.app.url.replace('://app:', '://127.0.0.1:');
    assert.match(await (await fetch(base)).text(), /Static QA/);
    assert.equal((await fetch(base + '/escape.txt')).status, 404);
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});
test('readiness timeout is bounded and Compose is rejected before spawning', async () => {
  const f = await fixture();
  f.runtime.contract.app.start = `${process.execPath} -e 'setInterval(()=>{},1000)'`;
  f.runtime.contract.app.ready.timeout = 100;
  try {
    await assert.rejects(f.runtime.start(), error => error.reason === 'app_not_ready' && error.details.timeout);
    f.runtime.contract.app.dockerfile = 'compose.yaml';
    await assert.rejects(f.runtime.start(), error => error.reason === 'unsupported_topology');
    assert.equal(f.runtime.processes.children.size, 0);
  } finally { await f.close(); }
});
test('datastore readiness failure names datastore and prevents seed and app startup', async () => {
  const f = await fixture();
  f.runtime.commandTimeoutMs = 100;
  f.runtime.seed = new SeedRuntime({ manifest: { datastores: [{ name: 'db', kind: 'custom', start: `${process.execPath} -e 'setInterval(()=>{},1000)'`, ready: 'exit 1', capture: 'true', restore: 'true' }], steps: [], users: [], paths: [] } });
  try {
    await assert.rejects(f.runtime.start(), error => error.reason === 'datastore_not_ready' && error.stage === 'db');
    assert.ok(!f.events.some(event => event.kind === 'stage' && event.stage === 'seed'));
    assert.equal(f.runtime.processes.children.size, 0);
  } finally { await f.close(); }
});
test('app process output is bounded and interruption kills its process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rio-process-')); const events = [];
  const processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH }, outputLimit: 1024, record: async event => events.push(event) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new StartupFailure('interrupted', 'test')), 200);
  try {
    await assert.rejects(processes.run(`${process.execPath} -e 'console.log("x".repeat(10000));setInterval(()=>{},1000)'`, { stage: 'test', reason: 'seed_failed', signal: controller.signal }));
    assert.equal(events[0].stdout.length, 1024); assert.ok(events[0].truncated);
    assert.equal(processes.children.size, 0);
  } finally { clearTimeout(timer); await processes.close(); await rm(root, { recursive: true, force: true }); }
});
