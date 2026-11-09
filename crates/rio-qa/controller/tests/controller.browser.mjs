import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serveHarnessMcp } from '../src/harness.mjs';
import { runQa } from '../src/controller.mjs';
import { runReplay } from '../src/replay-backend.mjs';
import { browserFiles } from '../src/browser-files.mjs';
import { EvidenceWriter } from '../src/evidence.mjs';
import { HarnessCrash } from '../src/execution.mjs';

async function fixture(t) {
  let cart = 0, resets = 0, broken = false, defect = true;
  const username = 'synthetic-shopper@example.test', password = 'synthetic-private-password';
  const json = (response, value) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    if (request.url === '/status') return json(response, { ready: true, missing_personas: ['absent'] });
    if (request.url === '/reset') { cart = 0; resets++; return json(response, { ready: true, missing_personas: ['absent'] }); }
    if (request.url === '/fixtures/status') return json(response, { services: [] });
    if (request.url === '/fixtures/events') return json(response, { events: [{ kind: 'blocked_egress', host: 'api.undoubled.example', detail: password }] });
    if (request.url === '/fixtures/files/contacts') { const file = 'id,name\n1,Synthetic person\n'; response.writeHead(200, { 'content-length': Buffer.byteLength(file) }); response.end(file); return; }
    if (request.url === '/api/cart') { if (!broken) cart++; return json(response, { cart }); }
    if (request.url === '/checkout') { response.setHeader('content-type', 'text/html'); response.end(`<h1>Checkout</h1><p>Cart: ${cart}</p><button ${defect ? 'disabled' : ''}>Pay</button>`); return; }
    if (request.url === '/cart') { response.setHeader('content-type', 'text/html'); response.end(`<h1>Cart</h1><p>Cart: ${cart}</p>`); return; }
    if (request.url === '/login' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get('email') !== username || form.get('password') !== password) { response.writeHead(401); response.end('Wrong credentials'); return; }
      response.writeHead(302, { location: '/shop', 'set-cookie': 'session=synthetic-session; HttpOnly; SameSite=Lax' }); response.end(); return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<meta name="viewport" content="width=device-width,initial-scale=1">' + (request.url === '/shop'
      ? '<h1>Shop</h1><button id="add" onclick="fetch(\'/api/cart\').then(()=>document.querySelector(\'output\').textContent=\'Added\')">Add</button><label>Contacts<input type="file" onchange="document.querySelector(\'output\').textContent=this.files[0].name"></label><output>Ready</output>'
      : '<h1>Sign in</h1><form method="post" action="/login"><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><button>Sign in</button></form>'));
  }).listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, staging = await browserFiles({ host: '127.0.0.1', port: 0 });
  const objects = new Map(), checkpoints = [], writer = new EvidenceWriter({ sink: { put: async (key, data) => { objects.set(key, data); return { storage: 'local', link: key }; }, manifest: async () => {} } });
  const journeys = {
    'add-to-cart': { name: 'add-to-cart', persona: 'shopper', resets: true, steps: [{ do: 'Log in and add', expect: 'Added' }], success: ['Added'] },
    checkout: { name: 'checkout', persona: 'shopper', after: ['add-to-cart'], steps: [{ do: 'Attach contacts', expect: 'Attached' }], success: ['Attached'] },
  };
  const options = { contract: { app: { url: origin }, personas: [{ name: 'shopper', username_env: 'QA_USER', password_env: 'QA_PASSWORD' }, { name: 'absent', username_env: 'ABSENT' }] },
    fixtures: { files: [{ name: 'contacts', generate: { kind: 'csv', rows: 1 } }] }, viewports: { mobile: { name: 'mobile', width: 390, height: 844, mobile: true, touch: true } },
    appControl: origin, browserFiles: staging.url, writer, journeys, model: 'qa-test', credentialEnv: { QA_USER: username, QA_PASSWORD: password },
    plan: { chains: [{ journeys: ['add-to-cart', 'checkout'] }], cells: ['light', 'dark'].map(color_scheme => ({ viewport: 'mobile', color_scheme })) },
    budget: { wall_ms: 60000, cell_wall_ms: 25000, tokens: 10000 },
    forward: async () => Response.json({ id: 'qa-response', output: [], usage: { input_tokens: 10, output_tokens: 10 } }),
    checkpoint: async value => checkpoints.push(structuredClone(value)),
    guidance: { checkout: [{ path: 'REVIEW.md', content_hash: 'a'.repeat(64), lines: ['Keep successful checkout efficient; avoid duplicate entry.'] }] },
  };
  t.after(async () => { await staging.close(); await new Promise(resolve => server.close(resolve)); });
  return { options, origin, username, password, objects, checkpoints, cart: () => cart, resets: () => resets,
    breakCart: () => { broken = true; }, fixDefect: () => { defect = false; } };
}

async function tools(bridge, run) {
  const endpoint = await serveHarnessMcp(bridge), client = new Client({ name: 'controller-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } } }));
    await run(async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result; });
  } finally { await client.close(); await endpoint.close(); }
}

test('exploration visits only uncovered routes per cell with the matching immutable guidance', { timeout: 90000 }, async t => {
  const f = await fixture(t); let turns = 0;
  const root = { path: 'REVIEW.md', scope_dir: '', content_hash: 'a'.repeat(64), lines: ['Keep inputs on retry.'] };
  const shop = { path: 'shop/REVIEW.md', scope_dir: 'shop', content_hash: 'b'.repeat(64), lines: ['Shop-only guidance'] };
  const newPage = { path: 'uncovered/REVIEW.md', scope_dir: 'uncovered', content_hash: 'c'.repeat(64), lines: ['Explain the next action.'] };
  const journeys = {
    smoke: { name: 'smoke', persona: 'shopper', steps: [{ do: 'Visit shop' }], success: ['Visited'] },
    exploratory: { name: 'exploratory', persona: 'shopper', resets: true, covers: { routes: ['/shop', '/uncovered'] },
      steps: [{ do: 'Inspect shop', at: '/shop' }, { do: 'Inspect changed screen', at: '/uncovered' }], success: ['Assess changed screens'] },
  };
  const result = await runQa({ ...f.options, journeys,
    plan: { chains: [{ journeys: ['smoke'] }, { journeys: ['exploratory'] }], cells: f.options.plan.cells, exploration_routes: ['/shop', '/uncovered'] },
    guidance: { exploratory: [root, shop, newPage], 'exploratory@/shop': [root, shop], 'exploratory@/uncovered': [root, newPage] },
    harnessFactory: () => ({ async run({ prompt, bridge }) {
      const exploratory = turns++ >= 2;
      if (exploratory) {
        assert.match(prompt, /Explain the next action/);
        assert.doesNotMatch(prompt, /Shop-only guidance/);
        assert.match(prompt, /"routes":\["\/uncovered"\]/);
      }
      await tools(bridge, async call => {
        await call('browser_navigate', { url: f.origin + (exploratory ? '/uncovered' : '/shop') });
        await call('step_done', { step: 1, outcome: 'passed' });
      });
      return { status: 'completed' };
    } }),
  });
  assert.equal(result.outcome, 'complete'); assert.equal(turns, 4);
  const exploration = result.journey_outcomes.filter(row => row.journey === 'exploratory');
  assert.equal(exploration.length, 2);
  for (const row of exploration) {
    assert.deepEqual(row.visited_routes, ['/uncovered']);
    assert.ok(row.evidence.length > 0);
  }
  assert.equal(result.network_events[0].host, 'api.undoubled.example');
  assert.ok(!JSON.stringify(result.network_events).includes(f.password));
});

test('composed controller logs in without exposing credentials, uploads named files and preserves a chain across cells', { timeout: 90000 }, async t => {
  const f = await fixture(t); let turn = 0;
  f.options.contract.rules = { disable: ['ux/task-*'], add: [{ id: 'project/brand-voice', category: 'ux', severity: 'warning', description: 'Keep checkout copy clear and consistent.' }] };
  const result = await runQa({ ...f.options, harnessFactory: () => ({ async run({ prompt, bridge }) {
    assert.ok(prompt.includes('project/brand-voice'));
    assert.ok(!prompt.includes('ux/task-clarity'));
    assert.ok(!prompt.includes('ux/task-efficiency'));
    await tools(bridge, async call => {
      if (turn++ % 2 === 0) {
        assert.equal(f.cart(), 0); await call('browser_navigate', { url: f.origin });
        const login = await call('login', { persona: 'shopper' }); assert.ok(!JSON.stringify(login).includes(f.password));
        await call('browser_wait_for', { text: 'Shop' }); await call('browser_click', { target: '#add' }); await call('browser_wait_for', { text: 'Added' });
      } else {
        assert.equal(f.cart(), 1); assert.match(prompt, /avoid duplicate entry/);
        assert.match((await call('browser_snapshot')).content[0].text, /Added/);
        await call('upload_fixture', { name: 'contacts' }); await call('browser_wait_for', { text: 'contacts.csv' });
      }
      await call('step_done', { step: 1, outcome: 'passed' });
    }); return { status: 'completed' };
  } }) });
  assert.equal(result.outcome, 'complete'); assert.equal(f.resets(), 2); assert.equal(result.journey_outcomes.length, 4);
  assert.equal(result.cell_metrics.length, 2, 'A shared chain is measured once per viewport/scheme');
  assert.ok(result.cell_metrics.every(row => row.chain.length === 2 && row.wall_time_ms > 0 && row.tokens === 0 && row.usd === null));
  assert.equal(new Set(result.cell_metrics.map(row => row.id)).size, 2);
  assert.ok(f.checkpoints.slice(0, -1).some(row => row.cell_metrics.length === 1), 'Cell metrics persist before run completion');
  assert.ok(result.journey_outcomes.every(row => row.outcome === 'passed'));
  assert.ok(result.ux_assessment.length > 0); assert.ok(f.checkpoints.length >= 4);
  const retained = JSON.stringify(result) + [...f.objects.values()].filter(data => data[0] === 123 || data[0] === 91).map(data => data.toString()).join();
  assert.ok(!retained.includes(f.password)); assert.ok(!retained.includes(f.username));
});

test('a harness crash retries the cell with its remaining token allowance and retains checkpoints', { timeout: 60000 }, async t => {
  const f = await fixture(t); let attempts = 0;
  const result = await runQa({ ...f.options, plan: { chains: [{ journeys: ['add-to-cart'] }], cells: [f.options.plan.cells[0]] }, harnessFactory: () => ({ async run({ bridge }) {
    const response = await fetch(this.proxyUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${this.proxyToken}` }, body: JSON.stringify({ model: 'qa-test', input: 'run', max_output_tokens: 10 }) });
    assert.equal(response.status, 200); await response.body.cancel();
    if (++attempts === 1) throw new HarnessCrash('synthetic crash');
    await tools(bridge, async call => { await call('browser_navigate', { url: f.origin }); await call('step_done', { step: 1, outcome: 'passed' }); });
    return { status: 'completed' };
  } }) });
  assert.equal(attempts, 2); assert.equal(f.resets(), 2); assert.equal(result.journey_outcomes[0].outcome, 'passed');
  assert.equal(result.tokens, 40); assert.equal(result.usage[1].remaining_tokens, 9960);
  assert.equal(result.cell_metrics.length, 1);
  assert.equal(result.cell_metrics[0].tokens, 40, 'Both attempts charge the same cell');
  assert.equal(result.cell_metrics[0].usage_estimated, false);
  assert.equal(result.cell_metrics[0].id, result.usage[0].cell.id);
  assert.ok(f.checkpoints.slice(0, -1).some(row => row.cell_metrics?.[0]?.tokens === 40), 'Retry costs persist in partial checkpoints');
});

test('missing persona credentials skip the journey and expose unassessed UX coverage', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const journey = { ...f.options.journeys['add-to-cart'], persona: 'absent' };
  const result = await runQa({ ...f.options, journeys: { 'add-to-cart': journey }, plan: { chains: [{ journeys: ['add-to-cart'] }], cells: [f.options.plan.cells[0]] }, harnessFactory: () => ({ run() { throw new Error('must not start harness'); } }) });
  assert.equal(result.journey_outcomes[0].outcome, 'skipped'); assert.equal(result.journey_outcomes[0].reason, 'missing_credentials');
  assert.ok(result.ux_assessment.every(row => row.status === 'not_assessed' && row.reason === 'missing_credentials'));
});

test('fresh replay retains checkout chain state, captures recurrence and rejects a broken prerequisite without a harness', { timeout: 120000 }, async t => {
  const f = await fixture(t), cell = f.options.plan.cells[0];
  let turns = 0;
  const plan = { ...f.options.plan, cells: [cell] };
  const original = await runQa({ ...f.options, plan, harnessFactory: () => ({ async run({ bridge }) {
    await tools(bridge, async call => {
      if (turns++ === 0) {
        await call('browser_navigate', { url: f.origin }); await call('login', { persona: 'shopper' });
        await call('browser_wait_for', { text: 'Shop' }); await call('browser_click', { target: '#add' });
        await call('browser_wait_for', { text: 'Added' });
        // The prerequisite boundary captures the server-owned cart count too.
        await call('browser_navigate', { url: f.origin + '/cart' });
      } else await call('browser_navigate', { url: f.origin + '/checkout' });
      await call('step_done', { step: 1, outcome: turns === 1 ? 'passed' : 'failed' });
    }); return { status: 'completed' };
  } }) });
  assert.equal(turns, 2); assert.equal(f.cart(), 1);
  const log = original.evidence.artifacts.find(row => row.kind === 'replay' && row.journey === 'checkout');
  const events = f.objects.get(log.link).toString().trim().split('\n').map(line => JSON.parse(line));
  const request = { events, artifacts: original.evidence.artifacts, until: { journey: 'checkout', step: 1 } };
  const replay = async () => {
    const writer = new EvidenceWriter({ sink: { put: async key => ({ storage: 'local', link: key }), manifest: async () => {} } });
    return runReplay({ ...f.options, plan, request, writer, harnessFactory: () => { throw new Error('Replay must not start a harness'); },
      forward: () => { throw new Error('Replay must not call a model'); } });
  };
  let result = await replay();
  assert.equal(result.outcome, 'recurred', JSON.stringify(result)); assert.equal(f.resets(), 2); assert.equal(f.cart(), 1);
  assert.ok(result.evidence.artifacts.some(row => row.kind === 'trace'));
  assert.equal(result.tokens, 0);
  f.fixDefect(); result = await replay();
  assert.equal(result.outcome, 'not_recurred');
  f.breakCart(); result = await replay();
  assert.equal(result.outcome, 'prerequisites_failed'); assert.equal(result.reason, 'expectation_not_met');
  assert.equal(result.at.journey, 'add-to-cart');
});
