import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelProxy, gatewayTransport, dropStaleImages } from '../src/model-proxy.mjs';

const cell = { chain: ['cart', 'checkout'], viewport: 'mobile', color_scheme: 'light' };
const body = { model: 'qa-model', input: 'observe', max_output_tokens: 100 };
const json = usage => Response.json({ output: [], ...(usage === undefined ? {} : { usage }) });
const response = () => json({ input_tokens: 20, output_tokens: 30 });
const settle = proxy => Promise.all([...proxy.pending]);
async function proxy(t, options = {}, tokens = 1000) {
  const p = await new ModelProxy({ forward: async () => response(), model: body.model, ...options }).listen();
  p.startCell(cell, tokens); t.after(() => p.close());
  p.send = (value = body, { token = p.token, path = '/responses', ...options } = {}) => fetch(p.url + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value), ...options,
  });
  return p;
}

test('proxy settles actual usage, caps output, rotates capability, and records no prompt or credentials', async t => {
  const calls = [], records = [];
  const p = await proxy(t, { forward: async request => { calls.push(request); return response(); }, record: async entry => records.push(entry) });
  const old = p.token;
  assert.equal((await p.send({ ...body, max_output_tokens: 10000, input: 'SENSITIVE PROMPT' })).status, 200);
  await settle(p);
  assert.equal(p.spent, 50); assert.equal(p.reserved, 0);
  assert.equal(records[0].remaining_tokens, 950);
  assert.ok(calls[0].body.max_output_tokens < 1000); assert.equal(calls[0].body.store, false);
  assert.doesNotMatch(JSON.stringify(records), /SENSITIVE|Bearer|authorization/);
  p.startCell({ ...cell, viewport: 'desktop' }, 500);
  assert.equal(p.spent, 0); assert.notEqual(p.token, old);
  assert.equal((await p.send(body, { token: old })).status, 401);
});

test('concurrent requests reserve synchronously and cannot overspend the cell', async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  let calls = 0, exhausted = 0;
  const p = await proxy(t, { onExhausted: () => { exhausted++; }, forward: async () => { calls++; entered(); return new Promise(resolve => { release = resolve; }); } }, 500);
  const first = p.send(); await started;
  assert.throws(() => p.startCell(cell, 1000), /in flight/);
  assert.equal((await p.send()).status, 429);
  assert.equal(calls, 1); assert.equal(exhausted, 1);
  release(response()); assert.equal((await first).status, 200); await settle(p);
  assert.equal(p.spent, 50); assert.equal(p.reserved, 0);
  assert.equal((await p.send()).status, 429);
});

test('failed transports and missing or malformed usage consume reservations', async t => {
  for (const forward of [async () => { throw new Error('Bearer provider-secret'); }, async () => json(), async () => json({ input_tokens: -1, output_tokens: '20' }), async () => new Response('provider-secret', { status: 500 })]) {
    const p = await proxy(t, { forward }, 500);
    const result = await p.send({ ...body, max_output_tokens: 10000 });
    assert.doesNotMatch(await result.text(), /provider-secret/); await settle(p);
    assert.equal(p.spent, 500); assert.equal(p.reserved, 0); assert.equal(p.usage[0].estimated, true);
    assert.equal((await p.send()).status, 429);
  }
});

test('both SSE protocols record terminal usage across split chunks', async t => {
  for (const path of ['/responses', '/chat/completions']) {
    const event = path === '/responses' ? { type: 'response.completed', response: { usage: { input_tokens: 21, output_tokens: 34 } } } : { usage: { prompt_tokens: 21, completion_tokens: 34 } };
    let sent;
    const p = await proxy(t, { forward: async ({ body }) => {
      sent = body;
      const text = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
      return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < text.length; i += 7) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 7))); controller.close(); } }));
    } });
    const result = await p.send({ ...body, stream: true }, { path });
    assert.match(await result.text(), /data: \[DONE\]/); await settle(p);
    assert.equal(p.spent, 55); assert.equal(p.usage[0].status, 'completed');
    if (path.includes('/chat')) assert.equal(sent.stream_options.include_usage, true);
  }
});

test('closing cancels active streams and awaits conservative accounting and record persistence', async t => {
  let entered, persisted = false; const started = new Promise(resolve => { entered = resolve; });
  const p = await proxy(t, { forward: async ({ signal }) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
    signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); entered();
  } })), record: async () => { await new Promise(resolve => setTimeout(resolve, 20)); persisted = true; } });
  const result = p.send({ ...body, stream: true }); await started;
  // Consume headers before close to avoid an unhandled fetch rejection.
  const read = (await result).text().catch(() => {});
  await p.close(); await read;
  assert.equal(p.active.size, 0); assert.equal(p.reserved, 0); assert.ok(persisted);
  assert.equal(p.usage[0].charged_tokens, p.usage[0].reserved_tokens);
  assert.equal(p.usage[0].status, 'cancelled'); assert.equal(p.token, undefined);
  assert.throws(() => p.startCell(cell, 1000), /closed/);
});

test('request timeout charges the attempted request and releases reservations', async t => {
  const p = await proxy(t, { requestTimeoutMs: 20, forward: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
  assert.equal((await p.send()).status, 502); await settle(p);
  assert.equal(p.usage[0].status, 'cancelled'); assert.equal(p.spent, p.usage[0].reserved_tokens); assert.equal(p.reserved, 0);
});

test('oversized responses and usage beyond reservations fail closed', async t => {
  for (const stream of [false, true]) {
    const p = await proxy(t, { forward: async () => stream
      ? new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":2000,"output_tokens":2000}}}\n\n')
      : json({ input_tokens: 2000, output_tokens: 2000 }) });
    const result = await p.send({ ...body, stream }).then(r => r.text()).catch(() => 'disconnected'); await settle(p);
    assert.doesNotMatch(result, /input_tokens/); assert.equal(p.spent, 4000); assert.ok(p.exhausted);
  }
  const p = await proxy(t, { responseBytes: 10, forward: async () => response() });
  assert.equal((await p.send()).status, 502); await settle(p);
  assert.equal(p.spent, p.usage[0].reserved_tokens);
});

test('model, path, persistent history and provider-side tools cannot escape QA permissions', async t => {
  let calls = 0; const p = await proxy(t, { forward: async () => { calls++; return response(); } });
  for (const change of [{ model: 'other' }, { previous_response_id: 'outside-run' }, { store: true }, { background: true }, { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'namespace', tools: [{ type: 'computer_use' }] }] }]) assert.equal((await p.send({ ...body, ...change })).status, 400);
  for (const path of ['/models', '/responses?redirect=evil', '/../files']) assert.equal((await p.send(body, { path })).status, 404);
  assert.equal(calls, 0); assert.equal(p.spent, 0);
  assert.equal((await p.send({ ...body, tools: [{ type: 'namespace', name: 'mcp__rio', tools: [{ type: 'function', name: 'step_done' }] }] })).status, 200);
});

test('usage persistence failure stops subsequent model calls', async t => {
  const p = await proxy(t, { record: async () => { throw new Error('sink unavailable'); } });
  await p.send(); await settle(p); assert.equal(p.spent, 50);
  assert.equal((await p.send()).status, 429);
});

test('trusted gateway transport pins route and authorization and refuses redirects', async t => {
  const calls = [];
  const forward = gatewayTransport({ baseUrl: 'https://gateway.example/run', token: 'run-token', runId: 'run-1', fetch: async (...args) => { calls.push(args); return response(); } });
  await forward({ path: '/v1/responses', body, signal: new AbortController().signal, cell: { id: 'cell-1' } });
  assert.equal(calls[0][0], 'https://gateway.example/run/v1/responses');
  assert.equal(calls[0][1].headers.authorization, 'Bearer run-token');
  assert.equal(calls[0][1].headers['x-rio-cell-id'], 'cell-1');
  assert.equal(calls[0][1].headers['x-rio-run-id'], 'run-1'); assert.equal(calls[0][1].redirect, 'error');
  await assert.rejects(forward({ path: '/admin', body }), /Unsupported/);
  for (const baseUrl of ['http://gateway.example', 'https://user:pass@gateway.example', 'https://gateway.example?token=x']) assert.throws(() => gatewayTransport({ baseUrl, token: 'x', runId: 'y' }));
  const server = createServer((_, res) => { res.writeHead(307, { location: 'http://127.0.0.1:1/leak' }); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await assert.rejects(gatewayTransport({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'secret', runId: 'run' })({ path: '/v1/responses', body }));
});

test('only the latest screenshot is replayed to the provider', () => {
  const image = n => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${n}` });
  const body = { input: [{ role: 'user', content: [image('MQ==')] },
    { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'step 1' }, image('Mg==')] },
    { type: 'function_call_output', call_id: 'b', output: [image('Mw==')] }] };
  assert.equal(dropStaleImages(body), true);
  assert.deepEqual(body.input[0].content[0], { type: 'input_text', text: '[earlier screenshot omitted]' });
  assert.deepEqual(body.input[1].output[1], { type: 'input_text', text: '[earlier screenshot omitted]' });
  assert.equal(body.input[2].output[0].image_url, 'data:image/jpeg;base64,Mw==');
  assert.equal(dropStaleImages({ input: [{ role: 'user', content: [image('MQ==')] }] }), false);
});
