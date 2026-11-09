#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const kind = process.argv.includes('exec') ? 'codex' : 'pi';
let endpoint;
if (kind === 'codex') endpoint = JSON.parse(process.argv.find(arg => arg.startsWith('mcp_servers.rio.url=')).split('=').slice(1).join('='));
else endpoint = JSON.parse(await readFile(process.env.RIO_QA_HARNESS_CONFIG, 'utf8')).endpoint;
const client = new Client({ name: 'stub-harness', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${process.env.RIO_QA_MCP_TOKEN}` } } }));
const tools = (await client.listTools()).tools;
if (tools.some(tool => /shell|evaluate|run_code|file_upload/.test(tool.name))) throw new Error('Unexpected tool');
if (process.env.OPENAI_API_KEY || process.env.QA_SHOPPER_PASSWORD) throw new Error('Unexpected inherited credential');
const origin = /http:\/\/127\.0\.0\.1:\d+\//.exec(prompt)?.[0];
for (const [name, args] of [['browser_navigate', { url: origin }], ['browser_click', { target: '#save' }], ['step_done', { step: 1, outcome: 'passed' }]]) {
 const result = await client.callTool({ name, arguments: args });
 if (result.isError) throw new Error(JSON.stringify(result));
 process.stdout.write(JSON.stringify({ type: 'tool_call', tool: name, arguments: args, result }) + '\n');
}
process.stdout.write(JSON.stringify({ type: kind === 'codex' ? 'turn.completed' : 'agent_end', text: 'Synthetic credential SYNTHETIC_SECRET_SHOULD_NOT_REMAIN' }) + '\n');
await client.close();
