// Run inside the provisioned QA image, without network access or real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodexHarness, PiHarness } from '../src/harness.mjs';
import { Sanitizer } from '../src/sanitize.mjs';
import { ModelProxy, gatewayTransport } from '../src/model-proxy.mjs';

for (const Driver of [CodexHarness, PiHarness]) test(`${Driver.name} loads restricted QA actions and calls MCP via the provisioned CLI`, { timeout: 60000 }, async () => {
  let calls = 0, requests = 0, offered = [], invalid, attemptedResource = false, deniedResource = false;
  const tools = [{ name: 'step_done', description: 'Finish the QA step.', inputSchema: { type: 'object', properties: { step: { type: 'integer' }, outcome: { type: 'string' } }, required: ['step', 'outcome'], additionalProperties: false } }];
  const server = new Server({ name: 'rio-qa-test', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => { assert.equal(params.name, 'step_done'); assert.equal(params.arguments.step, 1); calls++; return { content: [{ type: 'text', text: 'Recorded' }] }; });
  const model = createServer(async (request, response) => {
    try {
      let data = ''; for await (const chunk of request) data += chunk;
      if (!request.url.endsWith('/responses')) { response.writeHead(404); response.end('{}'); return; }
      const body = JSON.parse(data); requests++;
      const flatten = (tools, namespace) => tools.flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools, tool.name) : [{ name: tool.name || tool.function?.name || tool.type, namespace }]);
      const definitions = flatten(body.tools || []); offered = definitions.map(tool => tool.name);
      if (offered.some(name => /shell|exec|apply_patch|read_file|write_file|view_image|web_search|browser_use|search_tool|spawn_agent/.test(name))) throw new Error(`Unrestricted tools: ${JSON.stringify(offered)}`);
      let tool = definitions.find(tool => tool.name.endsWith('step_done')); if (!tool) throw new Error(`Missing QA tool: ${JSON.stringify(offered)}`);
      if (requests > 4) throw new Error('Harness did not execute the requested MCP tool');
      if (attemptedResource && requests === 2) {
        const outputs = (body.input || []).filter(item => item.type === 'function_call_output').map(item => item.output);
        deniedResource = /not found|not support|failed|error/i.test(JSON.stringify(outputs));
        if (!deniedResource) throw new Error('MCP resource read was not denied');
      }
      let arguments_ = { step: 1, outcome: 'passed' };
      const resource = definitions.find(tool => tool.name === 'read_mcp_resource');
      if (resource && !attemptedResource) { tool = resource; attemptedResource = true; arguments_ = { server: 'rio', uri: 'file:///etc/passwd' }; }
      const id = `resp_${requests}`, item = calls === 0
        ? { type: 'function_call', id: `fc_${requests}`, call_id: `call_${requests}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(arguments_), status: 'completed' }
        : { type: 'message', id: `msg_${requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'QA complete.', annotations: [] }] };
      const result = { id, object: 'response', created_at: 1, status: 'completed', model: body.model, output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } });
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
      if (item.type === 'function_call') {
        send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
        send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
      } else {
        send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'QA complete.' });
        send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'QA complete.' });
        send({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
      }
      send({ type: 'response.output_item.done', output_index: 0, item }); send({ type: 'response.completed', response: result }); response.end();
    } catch (error) { invalid = error.message; response.writeHead(500); response.end('{}'); }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const proxy = await new ModelProxy({ model: 'qa-stub-model', forward: gatewayTransport({ baseUrl: `http://127.0.0.1:${model.address().port}`, token: 'synthetic-local-proxy-token', runId: 'harness-protocol' }) }).listen();
  proxy.startCell({ viewport: 'mobile', color_scheme: 'light' }, 150000);
  const transcript = [];
  try {
    const harness = new Driver({ model: 'qa-stub-model', proxyUrl: proxy.url, proxyToken: proxy.token, sanitizer: new Sanitizer() });
    const outcome = await harness.run({ prompt: 'Call step_done for step 1 with outcome passed, then finish.', bridge: { server, tools }, wallMs: 45000, onEvent: event => transcript.push(event) });
    assert.equal(outcome.status, 'completed', JSON.stringify({ invalid, offered, transcript: transcript.map(event => ({ ...event, text: event.text?.slice(-1000) })) }));
    assert.equal(invalid, undefined); assert.ok(offered.every(name => name.endsWith('step_done') || ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name)), JSON.stringify(offered)); assert.equal(calls, 1); assert.equal(requests, attemptedResource ? 3 : 2);
    if (attemptedResource) assert.ok(deniedResource);
    await Promise.all([...proxy.pending]); assert.equal(proxy.spent, requests * 30);
    assert.ok(proxy.usage.every(record => record.status === 'completed' && !record.estimated));
    assert.ok(!JSON.stringify(transcript).includes('synthetic-local-proxy-token'));
  } catch (error) { throw new Error(`${error.message}: ${JSON.stringify({ invalid, offered, transcript }).slice(-2500)}`); }
  finally { await proxy.close(); await server.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
});

// Both CLIs speak Responses, while hosted routes can use Chat Completions or
// Anthropic. Exercise real tool-call round trips through the protocol adapter.
for (const Driver of [CodexHarness, PiHarness]) for (const protocol of ['openai', 'anthropic']) test(`${Driver.name} completes through the ${protocol} provider adapter`, { timeout: 60000 }, async () => {
  const { providerTransport } = await import('../src/provider-transport.mjs');
  let calls = 0, requests = 0;
  const tools = [{ name: 'step_done', description: 'Finish the QA step.', inputSchema: { type: 'object', properties: { step: { type: 'integer' }, outcome: { type: 'string' } }, required: ['step', 'outcome'], additionalProperties: false } }];
  const server = new Server({ name: 'rio-qa-test', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => { assert.equal(params.name, 'step_done'); assert.equal(params.arguments.step, 1); calls++; return { content: [{ type: 'text', text: 'Recorded' }] }; });
  const proxy = await new ModelProxy({ model: 'qa-stub-model', forward: providerTransport({ url: 'https://provider.invalid/model', model: 'upstream', protocol, headers: { authorization: 'Bearer provider-secret' }, fetch: async (_url, request) => {
    const body = JSON.parse(request.body); requests++; assert.ok(requests <= 3); assert.equal(body.model, 'upstream');
    const definitions = (body.tools || []).map(tool => tool.function || tool);
    const tool = definitions.find(tool => tool.description.includes('Finish the QA step.')); assert.ok(tool);
    const args = { step: 1, outcome: 'passed' };
    if (protocol === 'anthropic') return Response.json({ content: calls ? [{ type: 'text', text: 'QA complete.' }] : [{ type: 'tool_use', id: 'tool_call_1', name: tool.name, input: args }], usage: { input_tokens: 20, output_tokens: 10 } });
    return Response.json({ choices: [{ message: calls ? { content: 'QA complete.' } : { tool_calls: [{ id: 'tool_call_1', type: 'function', function: { name: tool.name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  } }) }).listen();
  proxy.startCell({ viewport: 'mobile', color_scheme: 'light' }, 150000);
  try {
    const harness = new Driver({ model: 'qa-stub-model', proxyUrl: proxy.url, proxyToken: proxy.token, sanitizer: new Sanitizer() });
    const result = await harness.run({ prompt: 'Call step_done for step 1 with outcome passed, then finish.', bridge: { server, tools }, wallMs: 45000 });
    assert.equal(result.status, 'completed'); assert.equal(calls, 1); assert.equal(requests, 2);
    await Promise.all([...proxy.pending]); assert.equal(proxy.spent, 60);
    assert.doesNotMatch(JSON.stringify(result.transcript), /provider-secret/);
  } finally { await proxy.close(); await server.close(); }
});
