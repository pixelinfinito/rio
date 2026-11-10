// Trusted bundled extension. No repository extensions or context files load.
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export default async function rioQaExtension(pi) {
  const config = JSON.parse(await readFile(process.env.RIO_QA_HARNESS_CONFIG, 'utf8'));
  const client = new Client({ name: 'rio-qa-pi', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.endpoint), { requestInit: { headers: { Authorization: `Bearer ${process.env.RIO_QA_MCP_TOKEN}` } } }));
  const available = (await client.listTools()).tools;
  if (available.length !== config.tools.length || available.some(tool => !config.tools.includes(tool.name))) { await client.close(); throw new Error('QA tool contract changed'); }
  for (const tool of available) pi.registerTool({ name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    async execute(_id, args, signal) {
      const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal });
      if (result.isError) throw new Error(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
      return { content: result.content, details: {} };
    } });
  pi.registerProvider('rio-qa', { name: 'Rio QA model proxy', baseUrl: config.proxy_url, apiKey: 'RIO_QA_MODEL_TOKEN', api: 'openai-responses',
    models: [{ id: config.model, name: config.model, reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] });
  pi.on('session_start', () => { pi.setActiveTools(config.tools); });
  pi.on('tool_call', event => config.tools.includes(event.toolName) ? undefined : { block: true, reason: 'Tool is outside the QA contract.' });
  pi.on('session_shutdown', async () => { await client.close(); });
}
