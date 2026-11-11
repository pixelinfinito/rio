import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { responseRequest, anthropicRequest, responseResult, providerTransport } from '../src/provider-transport.mjs';
import { localTransport, ModelProxy } from '../src/model-proxy.mjs';

const body = { model: 'custom/model', instructions: 'Follow owner guidance', max_output_tokens: 1000, stream: true,
  tools: [{ type: 'namespace', name: 'mcp__rio', tools: [{ type: 'function', name: 'step_done', parameters: { type: 'object', properties: { step: { type: 'number' } } } }] }],
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect checkout' }, { type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] },
    { type: 'function_call', call_id: 'call1', namespace: 'mcp__rio', name: 'step_done', arguments: '{"step":1}' },
    { type: 'function_call_output', call_id: 'call1', output: 'recorded' }] };

test('Responses translates namespaced tools, tool history and image evidence into both provider protocols', () => {
  const { chat, names } = responseRequest(body);
  assert.equal(chat.messages[0].content, body.instructions);
  assert.equal(chat.tools[0].function.name, 'rio_tool_0');
  assert.equal(chat.messages[2].tool_calls[0].function.name, 'rio_tool_0');
  const anthropic = anthropicRequest(chat);
  assert.equal(anthropic.messages[0].content[1].source.media_type, 'image/png');
  assert.equal(anthropic.messages[1].content[0].type, 'tool_use');
  assert.equal(anthropic.messages[2].content[0].type, 'tool_result');
  for (const protocol of ['openai', 'anthropic']) {
    const result = responseResult(protocol === 'openai' ? { choices: [{ message: { tool_calls: [{ id: 'call2', function: { name: 'rio_tool_0', arguments: '{"step":2}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 15 } }
      : { content: [{ type: 'tool_use', id: 'call2', name: 'rio_tool_0', input: { step: 2 } }], usage: { input_tokens: 10, output_tokens: 15 } }, names, body.model, protocol);
    assert.equal(result.output[0].namespace, 'mcp__rio'); assert.equal(result.output[0].name, 'step_done'); assert.equal(result.usage.total_tokens, 25);
  }
  assert.throws(() => responseResult({ choices: [{ message: { tool_calls: [{ function: { name: 'shell', arguments: '{}' } }] } }] }, names, body.model, 'openai'), /unknown QA tool/);
});

test('tool result screenshots follow the consecutive tool messages as one user turn', () => {
  const image = { type: 'input_image', image_url: 'data:image/jpeg;base64,YQ==' };
  const { chat } = responseRequest({ ...body, input: [
    { role: 'user', content: 'Inspect checkout' },
    { type: 'function_call', call_id: 'a', namespace: 'mcp__rio', name: 'step_done', arguments: '{"step":1}' },
    { type: 'function_call', call_id: 'b', namespace: 'mcp__rio', name: 'step_done', arguments: '{"step":2}' },
    { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'recorded' }, image] },
    { type: 'function_call_output', call_id: 'b', output: [image] },
    { role: 'user', content: 'Continue' }] });
  assert.deepEqual(chat.messages.slice(3).map(message => message.role), ['tool', 'tool', 'user', 'user']);
  assert.deepEqual(chat.messages[3].content, [{ type: 'text', text: 'recorded' }]);
  assert.equal(chat.messages[4].content, 'Screenshot follows.');
  assert.equal(chat.messages[5].content.filter(part => part.type === 'image_url').length, 2);
  const anthropic = anthropicRequest(chat);
  assert.equal(anthropic.messages.at(-1).content.filter(part => part.type === 'image').length, 2);
});

test('provider adapter refuses remote inputs and executable hosted tools', () => {
  for (const change of [{ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://outside.example/secret' }] }] }, { input: [{ type: 'item_reference', id: 'stored-input' }] }, { tools: [{ type: 'web_search' }] }, { previous_response_id: 'stored' }]) assert.throws(() => responseRequest({ ...body, ...change }), /Unsupported/);
});

test('provider transport pins model, strips unapproved fields, forbids redirects and yields Responses SSE with usage', async () => {
  const calls = [];
  const transport = providerTransport({ url: 'https://provider.example/chat/completions', model: 'pinned-model', headers: { authorization: 'Bearer host-secret' }, fetch: async (url, request) => {
    calls.push({ url, request }); return Response.json({ choices: [{ message: { content: 'Observed repeated entry' } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
  } });
  const response = await transport({ path: '/v1/responses', body: { ...body, metadata: { url: 'https://evil.example' } } });
  const text = await response.text(); assert.match(text, /response.completed/); assert.match(text, /"input_tokens":30/); assert.doesNotMatch(text, /host-secret/);
  const sent = JSON.parse(calls[0].request.body); assert.equal(sent.model, 'pinned-model'); assert.equal(sent.metadata, undefined); assert.equal(sent.stream, false); assert.equal(calls[0].request.redirect, 'manual');
});

for (const authentication of ['provider', 'ai_gateway']) test(`host relay ${authentication} authentication stays on the host while the controller has only a run capability`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rio-relay-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let headers, sent;
  const server = createServer(async (request, response) => {
    headers = request.headers; let text = ''; for await (const chunk of request) text += chunk; sent = JSON.parse(text);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: 'Saved' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/host-relay.mjs', import.meta.url))], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const iterator = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const socket = join(directory, 'model.sock');
  child.stdin.write(JSON.stringify({ authentication, key: 'synthetic-provider-key', url: `http://127.0.0.1:${server.address().port}/chat/completions`, protocol: 'openai', model: body.model, provider_model: 'upstream-model', socket, tokens: 50000, run_id: 'local-1' }) + '\n');
  const ready = JSON.parse((await iterator.next()).value);
  assert.equal(ready.kind, 'ready'); assert.doesNotMatch(JSON.stringify(ready), /synthetic-provider-key/);
  const proxy = await new ModelProxy({ model: body.model, forward: localTransport({ socketPath: socket, token: ready.token }) }).listen(); t.after(() => proxy.close());
  proxy.startCell({ viewport: 'mobile', color_scheme: 'light' }, 5000);
  const result = await fetch(proxy.url + '/responses', { method: 'POST', headers: { authorization: `Bearer ${proxy.token}` }, body: JSON.stringify(body) });
  assert.match(await result.text(), /Saved/); await Promise.all([...proxy.pending]);
  assert.equal(proxy.spent, 30); assert.equal(sent.model, 'upstream-model');
  if (authentication === 'ai_gateway') {
    assert.equal(headers['cf-aig-authorization'], 'Bearer synthetic-provider-key');
    assert.equal(headers.authorization, undefined); assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers['cf-aig-skip-cache'], 'true'); assert.equal(headers['cf-aig-collect-log'], 'false');
  } else assert.equal(headers.authorization, 'Bearer synthetic-provider-key');
  assert.deepEqual(await readdir(directory), ['model.sock']);
  const usage = JSON.parse((await iterator.next()).value); assert.equal(usage.charged_tokens, 30);
  assert.doesNotMatch(JSON.stringify(proxy.usage) + JSON.stringify(usage) + stderr, /synthetic-provider-key/);
  const exited = once(child, 'close'); child.stdin.end('stop\n'); assert.equal((await exited)[0], 0);
});


test('real HTTP redirects never receive provider credentials at their destination', async t => {
  let destinationCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === '/destination') destinationCalls++;
    response.writeHead(302, { location: '/destination' }); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const transport = providerTransport({ url: `http://127.0.0.1:${server.address().port}/source`, model: 'pinned-model', headers: { authorization: 'Bearer synthetic-provider-key' } });
  const response = await transport({ path: '/v1/responses', body });
  assert.equal(response.status, 302);
  assert.equal(response.ok, false);
  assert.equal(response.headers.get('location'), null);
  assert.equal(destinationCalls, 0);
});

// Local hints follow the route's configured classes and its endpoint (D16).
for (const [classes, path, hinted] of [[['openai'], '/v1/a/g/openai/chat/completions', true], [[], '/v1/a/g/openai/chat/completions', false], [['openai'], '/v1/a/g/compat/chat/completions', false]])
  test(`host relay sends Rio's key only for configured classes on OpenAI's endpoint (${classes.join(',') || 'none'} ${path})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'rio-relay-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const sent = [];
    const server = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk; sent.push(JSON.parse(text));
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: 'Saved' } }], usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 16 } } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/host-relay.mjs', import.meta.url))], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const iterator = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const socket = join(directory, 'model.sock');
    child.stdin.write(JSON.stringify({ authentication: 'ai_gateway', key: 'synthetic-provider-key', url: `http://127.0.0.1:${server.address().port}${path}`, protocol: 'openai', model: body.model, provider_model: 'gpt', socket, tokens: 50000, run_id: 'local-1', prompt_cache: classes }) + '\n');
    const ready = JSON.parse((await iterator.next()).value);
    const proxy = await new ModelProxy({ model: body.model, forward: localTransport({ socketPath: socket, token: ready.token }) }).listen(); t.after(() => proxy.close());
    proxy.startCell({ viewport: 'mobile', color_scheme: 'light' }, 5000);
    const result = await fetch(proxy.url + '/responses', { method: 'POST', headers: { authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ ...body, prompt_cache_key: 'harness' }) });
    const reply = await result.text(); await Promise.all([...proxy.pending]);
    assert.equal(typeof sent[0].prompt_cache_key === 'string' && /^[0-9a-f]{32}$/.test(sent[0].prompt_cache_key), hinted);
    assert.doesNotMatch(JSON.stringify(sent), /"harness"/);
    // The harness sees the provider's cached count, not 0.
    assert.match(reply, /"cached_tokens":16/);
    const exited = once(child, 'close'); child.stdin.end('stop\n'); await exited;
  });
