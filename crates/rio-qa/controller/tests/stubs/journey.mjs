#!/usr/bin/env node
// Scripted CLI acceptance driver; makes no model requests or quality judgments.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const author = !prompt.split('\n').some(line => line.startsWith('{"journey":'));
const input = JSON.parse(prompt.split('\n').find(line => line.startsWith(author ? '{"context":' : '{"journey":')));
const origins = JSON.parse(prompt.split('Application origins: ').at(-1));
if (!author && !input.owner_guidance.some(row => row.path === 'REVIEW.md' && row.lines.some(line => line.includes('Keep entered data')))) throw new Error('Owner guidance missing');
const endpoint = JSON.parse(process.argv.find(arg => arg.startsWith('mcp_servers.rio.url=')).slice('mcp_servers.rio.url='.length));
const client = new Client({ name: 'scripted-journey', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { authorization: `Bearer ${process.env.RIO_QA_MCP_TOKEN}` } } }));
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result));
  return result;
};
try {
  await call('browser_navigate', { url: origins[0] + '/' });
  await call('browser_click', { target: '#save' });
  const snapshot = await call('browser_snapshot');
  if (!snapshot.content.some(row => row.text?.includes('Saved'))) throw new Error('Save confirmation missing');
  const boundary = JSON.parse((await call('step_done', { step: 1, outcome: 'passed' })).content[0].text);
  if (author) {
    for (const { journey } of input.context.journeys) await call('write_journey', { journey, changes_data: false });
  } else await call('assess', { rule_id: 'ux/task-efficiency', status: 'assessed', evidence: boundary.evidence });
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
} finally { await client.close(); }
