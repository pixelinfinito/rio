import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serveHarnessMcp } from '../src/harness.mjs';
import { runAuthor } from '../src/author.mjs';
import { EvidenceWriter } from '../src/evidence.mjs';

async function fixture(t, { events = [], failure } = {}) {
  let started = false, reset = false;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/status') { assert.ok(started); response.statusCode = failure ? 503 : 200; response.end(JSON.stringify({ ready: !failure, failure, seed: { status: 'built' } })); }
    else if (request.url === '/reset') { reset = true; response.end('{"ready":true}'); }
    else if (request.url === '/fixtures/status') response.end('{"services":[]}');
    else if (request.url === '/fixtures/events') response.end(JSON.stringify({ events }));
    else { response.setHeader('content-type', 'text/html'); response.end('<h1>Checkout</h1><label>Address<input value=""></label><p>Payment declined; address cleared.</p>'); }
  }).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = { path: 'REVIEW.md', scope_dir: '', content_hash: 'a'.repeat(64), lines: ['Keep checkout understandable.'] };
  const checkout = { path: 'checkout/REVIEW.md', scope_dir: 'checkout', content_hash: 'b'.repeat(64), lines: ['Preserve the entered address after a declined payment.'] };
  const admin = { path: 'admin/REVIEW.md', scope_dir: 'admin', content_hash: 'c'.repeat(64), lines: ['Unrelated admin requirement.'] };
  const writer = new EvidenceWriter({ sink: { put: async key => ({ storage: 'local', link: key }), manifest: async () => {} } });
  const options = { writer, appControl: origin, contract: { app: { url: origin }, personas: [{ name: 'shopper' }] }, fixtures: {},
    seedTransfer: { async start() { started = true; }, async close() {} },
    plan: { chains: [{ journeys: ['authoring'] }], cells: [{ viewport: 'mobile', color_scheme: 'light' }] },
    viewports: { mobile: { name: 'mobile', width: 390, height: 844, mobile: true, touch: true } },
    budget: { wall_ms: 30000, cell_wall_ms: 30000, tokens: 10000 }, model: 'scripted-author',
    forward: async () => { throw new Error('Scripted harness makes no model requests'); },
    author: { context: { mode: 'init', owner_guidance: [root], journeys: [] }, route_guidance: [{ route: '/checkout', documents: [root, checkout] }, { route: '/admin', documents: [root, admin] }] },
  };
  return { origin, options, reset: () => reset, checkout };
}
async function tools(bridge, fn) {
  const endpoint = await serveHarnessMcp(bridge), client = new Client({ name: 'scripted-author', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } } }));
    return await fn((name, args = {}) => client.callTool({ name, arguments: args }));
  } finally { await client.close(); await endpoint.close(); }
}
const proposal = guidance => ({ changes_data: true, journey: { version: 1, name: 'payment-recovery', title: 'Recover payment', persona: 'shopper', tags: ['smoke'],
  covers: { routes: ['/checkout'], paths: [] }, preconditions: [], steps: [{ do: 'Retry after the payment is declined', expect: 'The entered address is preserved' }],
  success: ['Complete checkout without duplicate entry'], goal: 'Recover from declined payment without re-entering the address',
  guidance_refs: [{ path: guidance.path, hash: guidance.content_hash, start_line: 1, end_line: 1 }], ux_criteria: ['ux/error-recovery', 'ux/task-efficiency'] } });

test('author starts after seeding, scopes guidance by visited route and stages a recovery expectation despite the observed defect', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const result = await runAuthor({ ...f.options, harnessFactory: () => ({ async run({ prompt, bridge }) {
    assert.ok(f.reset()); assert.match(prompt, /observed defects|current app does it/);
    assert.ok(!prompt.includes('Unrelated admin requirement'));
    assert.ok(!bridge.tools.some(tool => /shell|evaluate|write_file|run_code/.test(tool.name)));
    await tools(bridge, async call => {
      assert.ok(!(await call('browser_navigate', { url: f.origin + '/checkout' })).isError);
      const scoped = await call('read_owner_guidance');
      assert.match(scoped.content[0].text, /Preserve the entered address/);
      assert.ok(!scoped.content[0].text.includes('Unrelated admin requirement'));
      assert.ok(!(await call('step_done', { step: 1, outcome: 'failed', reason: 'Address was cleared' })).isError);
      const staged = await call('write_journey', proposal(f.checkout)); assert.ok(!staged.isError, JSON.stringify(staged));
      assert.ok((await call('shell', { command: 'touch source.js' })).isError);
    });
    return { status: 'completed' };
  } }) });
  assert.equal(result.outcome, 'complete', JSON.stringify(result));
  assert.equal(result.proposals[0].journey.resets, true);
  assert.equal(result.proposals[0].journey.steps[0].expect, 'The entered address is preserved');
  assert.ok(result.evidence.artifacts.some(row => row.kind === 'screenshot'));
  assert.ok(result.evidence.artifacts.some(row => row.kind === 'trace'));
});

test('sync rejects unrelated writes and cannot finish without all selected journeys', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  f.options.author.context = { ...f.options.author.context, mode: 'sync', journeys: [{ journey: { name: 'checkout' } }] };
  const result = await runAuthor({ ...f.options, harnessFactory: () => ({ async run({ bridge }) {
    await tools(bridge, async call => {
      await call('browser_navigate', { url: f.origin + '/unknown' });
      const scoped = await call('read_owner_guidance');
      assert.ok(!scoped.content[0].text.includes('Preserve the entered address'));
      assert.ok((await call('write_journey', proposal(f.checkout))).isError);
    }); return { status: 'completed' };
  } }) });
  assert.equal(result.outcome, 'partial'); assert.equal(result.reason, 'incomplete_authoring');
  assert.deepEqual(result.proposals, []);
});

for (const failed of [false, true]) test(`init discovers blocked hosts before any browser/model author turn, startup failed=${failed}`, async t => {
  const f = await fixture(t, { events: [{ kind: 'blocked_egress', host: 'API.Example.test' }, { kind: 'blocked_egress', host: 'api.example.test' }, { kind: 'tls_pinned', host: 'pinned.example.test' }],
    failure: failed ? { outcome: 'failed', reason: 'app_not_ready' } : undefined });
  f.options.author.discover_dependencies = true;
  const result = await runAuthor({ ...f.options, browserFactory: () => { throw new Error('Discovery must precede browser startup'); },
    harnessFactory: () => { throw new Error('Discovery must precede model access'); } });
  assert.equal(result.outcome, 'partial'); assert.equal(result.reason, 'setup_required');
  assert.deepEqual(result.blocked_dependencies, ['api.example.test']);
  assert.deepEqual(result.proposals, []); assert.equal(result.tokens, 0); assert.equal(f.reset(), false);
  assert.ok(result.undoubled_dependencies.includes('pinned.example.test'));
});

test('source-detected SDK and URL-variable dependencies trigger setup even without blocked startup traffic', async t => {
  const f = await fixture(t);
  f.options.author.discover_dependencies = true;
  f.options.author.detected_dependencies = ['sdk:nodemailer', 'env:CATALOG_API_BASE'];
  const result = await runAuthor({ ...f.options, browserFactory: () => { throw new Error('No browser before fixture augmentation'); } });
  assert.equal(result.reason, 'setup_required');
  assert.deepEqual(result.blocked_dependencies, []);
  assert.deepEqual(result.missing_dependencies, ['env:CATALOG_API_BASE', 'sdk:nodemailer']);
  assert.equal(result.tokens, 0);
});
