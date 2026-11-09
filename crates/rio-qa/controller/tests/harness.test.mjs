import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CodexHarness, harnessLaunch, serveHarnessMcp } from '../src/harness.mjs';
import { Sanitizer } from '../src/sanitize.mjs';

const bridge = () => ({ server: new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } }), tools: [] });
test('private MCP rejects missing or incorrect capabilities', async () => {
  const server = bridge(), endpoint = await serveHarnessMcp(server);
  try {
    assert.equal((await fetch(endpoint.url)).status, 403);
    assert.equal((await fetch(endpoint.url, { headers: { authorization: 'Bearer invalid' } })).status, 403);
    assert.equal((await fetch(endpoint.url + '/other', { headers: { authorization: `Bearer ${endpoint.token}` } })).status, 403);
  } finally { await endpoint.close(); await server.server.close(); }
});

test('harness budget kills an uncooperative process and deletes its private configuration', async () => {
  const server = bridge();
  const driver = new CodexHarness({ model: 'stub', proxyUrl: 'http://127.0.0.1:9999/v1', proxyToken: 'private', sanitizer: new Sanitizer(), executable: fileURLToPath(new URL('./stubs/harness-block.mjs', import.meta.url)) });
  try {
    const result = await driver.run({ prompt: 'test', bridge: server, wallMs: 300 });
    assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'budget');
    const started = result.transcript.find(row => row.event?.type === 'started').event;
    assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
    await assert.rejects(stat(started.directory), { code: 'ENOENT' });
  } finally { await server.server.close(); }
});

test('harness launch rejects direct external model routes and forbids subscription auth on pi', () => {
  const configuration = { kind: 'codex', directory: '/private', endpoint: 'http://127.0.0.1:1000/mcp', model: 'test', tools: [], proxyUrl: 'https://provider.example/v1' };
  assert.throws(() => harnessLaunch(configuration), /loopback/);
  assert.throws(() => harnessLaunch({ ...configuration, kind: 'pi', auth: 'subscription' }), /requires gateway/);
});
