import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serveHarnessMcp } from '../src/harness.mjs';
import { CellController } from '../src/cell.mjs';
import { EvidenceWriter } from '../src/evidence.mjs';
import { openBrowser } from '../src/browser.mjs';
import { builtinProbeRules } from '../src/probes.mjs';
import { executePlan } from '../src/execution.mjs';

test('chain coordinator connects successive harnesses without losing cart, scopes logs and retains chain replay and trace per journey', { timeout: 60000 }, async () => {
  let cart = 0, resets = 0, chain;
  const objects = new Map();
  const server = createServer((request, response) => {
    if (request.url === '/add') { cart++; response.end('added'); return; }
    response.setHeader('content-type', 'text/html'); response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><button id="add" onclick="fetch(\'/add\').then(()=>{document.cookie=\'cart=1\';document.querySelector(\'output\').textContent=\'Added\'})">Add</button><output>Ready</output>');
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  const cell = { viewport: 'mobile', color_scheme: 'light' }, viewport = { name: 'mobile', width: 390, height: 844, mobile: true, touch: true };
  const journeys = Object.fromEntries(['add-to-cart', 'checkout'].map(name => [name, { name, persona: 'shopper', goal: 'Buy', steps: [{ do: name, expect: 'Complete' }], success: ['Complete'], ...(name === 'checkout' ? { after: ['add-to-cart'] } : { resets: true }) }]));
  const writer = new EvidenceWriter({ sink: { put: async (key, bytes) => { objects.set(key, bytes); return { storage: 'local', link: key }; }, manifest: async () => {} } });
  const harness = { async run({ prompt, bridge }) {
    const endpoint = await serveHarnessMcp(bridge), client = new Client({ name: 'scripted', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } }));
      const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result; };
      const session = chain.sessions.at(-1);
      if (session.journey.name === 'add-to-cart') {
        await call('browser_navigate', { url: origin }); await call('browser_click', { target: '#add' }); await call('browser_wait_for', { text: 'Added' });
        await chain.browser.page.evaluate(() => console.log('first-journey-only'));
      } else {
        assert.equal(cart, 1); assert.equal((await chain.browser.context.cookies()).find(cookie => cookie.name === 'cart').value, '1');
        assert.equal(await chain.browser.page.locator('output').textContent(), 'Added'); assert.ok(prompt.includes('checkout'));
        await chain.browser.page.evaluate(() => console.log('second-journey-only'));
      }
      await call('step_done', { step: 1, outcome: 'passed' });
      return { status: 'completed', transcript: [] };
    } finally { await client.close(); await endpoint.close(); }
  } };
  try {
    const result = await executePlan({ plan: { chains: [{ journeys: ['add-to-cart', 'checkout'] }], cells: [cell] }, journeys, runWallMs: 30000, cellWallMs: 25000,
      backend: {
        async restoreSeed() { resets++; cart = 0; }, async applyCredentials() {}, async resetServiceBehaviors() {},
        async openCell() { const browser = await openBrowser({ viewport, journey: 'add-to-cart', allowedOrigins: [origin] }); chain = new CellController({ browser, writer, cell, criteria: await builtinProbeRules(), harness, allowedOrigins: [origin], cellWallMs: 25000 }); return chain; },
        runJourney: args => chain.runJourney(args), closeCell: () => chain.close(),
      } });
    assert.equal(resets, 1); assert.equal(result.outcome, 'complete'); assert.ok(result.journey_outcomes.every(row => row.outcome === 'passed'));
    assert.ok(result.journey_outcomes.every(outcome => outcome.evidence.some(id => writer.artifacts.find(row => row.id === id).kind === 'trace')));
    const retained = await chain.close();
    for (const outcome of retained) {
      assert.ok(outcome.evidence.some(id => writer.artifacts.find(row => row.id === id).kind === 'trace'));
      const replay = writer.artifacts.find(row => row.journey === outcome.journey && row.kind === 'replay');
      const events = objects.get(replay.link).toString().trim().split('\n').map(JSON.parse);
      assert.ok(events.some(event => event.journey === 'add-to-cart' && event.action === 'click'));
      assert.ok(events.some(event => event.journey === 'checkout' && event.action === 'step_done'));
    }
    const logs = writer.artifacts.filter(row => row.kind === 'console').map(row => objects.get(row.link).toString());
    assert.ok(logs[0].includes('first-journey-only')); assert.ok(!logs[1].includes('first-journey-only')); assert.ok(logs[1].includes('second-journey-only'));
  } finally { await chain?.close(); await new Promise(resolve => server.close(resolve)); }
});

test('model budget interrupts the active harness and retains incomplete UX coverage without retry', { timeout: 30000 }, async () => {
  const { ModelProxy } = await import('../src/model-proxy.mjs');
  const cell = { viewport: 'mobile', color_scheme: 'light' };
  const proxy = await new ModelProxy({ model: 'qa-test', forward: async () => { throw new Error('exhausted requests must never forward'); } }).listen();
  proxy.startCell(cell, 1);
  const browser = await openBrowser({ viewport: { name: 'mobile', width: 390, height: 844, mobile: true, touch: true } });
  const writer = new EvidenceWriter({ sink: { put: async key => ({ storage: 'local', link: key }), manifest: async () => {} } });
  const harness = { async run({ signal }) {
    await fetch(this.proxyUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${this.proxyToken}` }, body: JSON.stringify({ model: 'qa-test', input: 'inspect' }) });
    assert.ok(signal.aborted); assert.equal(signal.reason, 'budget');
    return { status: 'cancelled', reason: 'budget', transcript: [] };
  } };
  const chain = new CellController({ browser, writer, cell, criteria: await builtinProbeRules(), harness, modelProxy: proxy, allowedOrigins: [], cellWallMs: 15000 });
  try {
    const result = await chain.runJourney({ journey: { name: 'checkout', persona: 'shopper', goal: 'Buy', steps: [{ do: 'Pay' }], success: ['Order confirmed'] } });
    assert.equal(result.outcome, 'cancelled'); assert.equal(result.reason, 'budget');
    assert.ok(result.ux_assessment.some(row => row.status === 'not_assessed' && row.reason.includes('budget')));
    await chain.close(); assert.ok(writer.artifacts.length > 0);
  } finally { await chain.close(); await proxy.close(); }
});
