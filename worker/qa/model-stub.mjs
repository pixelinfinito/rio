// Trusted integration-test model, served through a Unix socket. No provider
// credential or external request is used; real installed harness CLIs run.
import { createServer } from 'node:http';
import { chmod, appendFile } from 'node:fs/promises';
const [socket, log] = process.argv.slice(2);
let requests = 0;
const actions = [
  ['browser_navigate', { url: 'http://127.0.0.1:4173/' }],
  ['login', { persona: 'shopper' }],
  ['upload_fixture', { name: 'contacts' }],
  ['step_done', { step: 1, outcome: 'passed' }],
];
const flatten = (tools, namespace) => tools.flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools, tool.name) : [{ name: tool.name || tool.function?.name || tool.type, namespace }]);
const server = createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== 'Bearer synthetic-model-relay' || request.url !== '/v1/responses') { response.writeHead(403); response.end('{}'); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    await appendFile(log, text + '\n');
    const body = JSON.parse(text), definitions = flatten(body.tools || []), action = actions[requests++];
    if (process.env.RIO_QA_TEST_PAUSE_FINAL === '1' && requests === actions.length + 1) return;
    if (requests > actions.length + 1) throw new Error('Harness did not finish');
    const tool = action && definitions.find(tool => tool.name.endsWith(action[0]));
    if (action && !tool) throw new Error('Missing QA tool');
    const item = action ? { type: 'function_call', id: `fc_${requests}`, call_id: `call_${requests}`, name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(action[1]), status: 'completed' }
      : { type: 'message', id: `msg_${requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'QA complete.', annotations: [] }] };
    const result = { id: `resp_${requests}`, object: 'response', created_at: 1, status: 'completed', model: body.model, output: [item],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(action ? { arguments: '' } : { content: [] }) } });
    if (action) {
      send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
      send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
    } else {
      send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'QA complete.' });
      send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'QA complete.' });
      send({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    }
    send({ type: 'response.output_item.done', output_index: 0, item }); send({ type: 'response.completed', response: result }); response.end();
  } catch { if (!response.headersSent) response.writeHead(500); response.end('{}'); }
});
await new Promise(resolve => server.listen(socket, resolve)); await chmod(socket, 0o666); process.stdout.write('ready\n');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.closeAllConnections(); server.close(); });

process.on('SIGHUP', () => { requests = 0; });
