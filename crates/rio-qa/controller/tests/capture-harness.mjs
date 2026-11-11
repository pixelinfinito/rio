// Records the Responses bodies Codex and pi send through Rio's controller proxy
// (prompt-caching task 10.2). Runs inside the provisioned QA image without
// network access or keys; a recording stub stands in for the provider.
//   docker run --rm --network none --user 1000:1000 --entrypoint node \
//     -v "$PWD/crates/rio-qa/controller/src:/opt/rio-qa/src:ro" \
//     -v "$PWD/crates/rio-qa/controller/tests:/opt/rio-qa/tests:ro" \
//     -v "$OUT:/out" rio-qa:0.1.0 /opt/rio-qa/tests/capture-harness.mjs /out
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodexHarness, PiHarness } from '../src/harness.mjs';
import { Sanitizer } from '../src/sanitize.mjs';
import { ModelProxy, gatewayTransport } from '../src/model-proxy.mjs';
import { JourneySession } from '../src/session.mjs';

const out = process.argv[2] || '/out';
const journeys = [
  { name: 'checkout', persona: 'shopper', steps: [{ action: 'Open the cart', expect: 'The cart lists the item' }], success: 'An order is placed', ux_criteria: [] },
  { name: 'signup', persona: 'visitor', steps: [{ action: 'Open sign up', expect: 'A form asks for an email' }], success: 'An account exists', ux_criteria: [] },
];
const cells = [{ viewport: 'mobile', color_scheme: 'light' }, { viewport: 'desktop', color_scheme: 'dark' }];
const criteria = new Map([['ui/no-feedback', { id: 'ui/no-feedback', kind: 'judged', description: 'Actions give feedback.' }]]);
const origins = ['http://127.0.0.1:3000'];
// The journey prompt exactly as `cell.mjs` passes it to the harness.
const promptFor = (journey, cell) => JourneySession.prototype.prompt.call({ writer: { sanitizer: new Sanitizer() }, journey, cell, guidance: [], criteria }, origins);

const tools = [{ name: 'step_done', description: 'Finish the QA step.', inputSchema: { type: 'object', properties: { step: { type: 'integer' }, outcome: { type: 'string' } }, required: ['step', 'outcome'], additionalProperties: false } }];
const captures = {};
for (const Driver of [CodexHarness, PiHarness]) for (const [c, cell] of cells.entries()) for (const journey of journeys) {
  const bodies = [];
  let calls = 0;
  const server = new Server({ name: 'rio-qa-capture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async () => { calls++; return { content: [{ type: 'text', text: 'Recorded' }] }; });
  const model = createServer(async (request, response) => {
    let data = ''; for await (const chunk of request) data += chunk;
    if (!request.url.endsWith('/responses')) { response.writeHead(404); response.end('{}'); return; }
    const body = JSON.parse(data); bodies.push(body);
    const flatten = (list, namespace) => list.flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools, tool.name) : [{ name: tool.name, namespace }]);
    const tool = flatten(body.tools || []).find(t => t.name?.endsWith('step_done'));
    const n = bodies.length;
    const item = calls === 0 && tool
      ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: '{"step":1,"outcome":"passed"}', status: 'completed' }
      : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'QA complete.', annotations: [] }] };
    const result = { id: `resp_${n}`, object: 'response', created_at: 1, status: 'completed', model: body.model, output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
    if (item.type === 'function_call') send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
    else send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'QA complete.' });
    send({ type: 'response.output_item.done', output_index: 0, item }); send({ type: 'response.completed', response: result }); response.end();
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const proxy = await new ModelProxy({ model: 'qa-stub-model', forward: gatewayTransport({ baseUrl: `http://127.0.0.1:${model.address().port}`, token: 'synthetic-local-proxy-token', runId: 'capture' }) }).listen();
  proxy.startCell(cell, 150000);
  try {
    const harness = new Driver({ model: 'qa-stub-model', proxyUrl: proxy.url, proxyToken: proxy.token, sanitizer: new Sanitizer() });
    const outcome = await harness.run({ prompt: promptFor(journey, cell), bridge: { server, tools }, wallMs: 45000 });
    captures[`${Driver.name}/cell${c}/${journey.name}`] = { status: outcome.status, prompt: promptFor(journey, cell), bodies };
  } finally { await proxy.close(); await server.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
}
writeFileSync(`${out}/harness-captures.json`, JSON.stringify(captures, null, 2) + '\n');
console.log(Object.entries(captures).map(([k, v]) => `${k}: ${v.status}, ${v.bodies.length} requests`).join('\n'));
