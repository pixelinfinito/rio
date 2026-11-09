import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openBrowser } from './browser.mjs';
import { JourneySession } from './session.mjs';
import { EvidenceWriter } from './evidence.mjs';
import { builtinProbeRules } from './probes.mjs';

// Trusted bundled HTML only. No repository, credentials or model route needed.
const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rio QA self-test</title><button onclick="document.querySelector(\'output\').textContent=\'Step passed\'">Run step</button><output role="status">Ready</output>';
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(html); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, bridge, client;
try {
  browser = await openBrowser({ viewport: { width: 390, height: 844, mobile: true, touch: true, device_scale_factor: 3 }, allowedOrigins: [origin] });
  const writer = new EvidenceWriter({ sink: { put: async key => ({ storage: 'local', link: key }), manifest: async () => {} } });
  const journey = new JourneySession({ browser, writer, journey: { name: 'self-test', persona: 'anonymous', goal: 'Run a step', steps: [{ do: 'Run step', expect: 'Step passed' }], success: ['Step passed'] }, cell: { viewport: 'mobile', color_scheme: 'light' }, criteria: await builtinProbeRules() });
  bridge = await journey.bridge({ allowedOrigins: [origin] });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(right);
  client = new Client({ name: 'rio-self-test', version: '0.1.0' });
  await client.connect(left);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(`QA self-test ${name} failed: ${JSON.stringify(response)}`);
    return response.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  };
  await call('browser_navigate', { url: origin });
  const snapshot = await call('browser_snapshot', {});
  const ref = /button "Run step" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];
  if (!ref) throw new Error('QA self-test button absent');
  await call('browser_click', { target: ref });
  const result = await call('browser_snapshot', {});
  if (!result.includes('Step passed')) throw new Error('QA self-test step failed');
  const page = browser.context.pages().find(page => page.url().startsWith(origin));
  await call('step_done', { step: 1, outcome: 'passed' });
  const outcome = await journey.finish();
  if (outcome.outcome !== 'passed' || outcome.evidence.length !== 6 || !outcome.ux_assessment.length || !browser.replayEvents.some(event => event.action === 'click')) throw new Error('QA self-test coordinator incomplete');
  const screenshot = await page.screenshot();
  if (screenshot.byteLength < 100) throw new Error('QA self-test screenshot absent');
  const tools = (await client.listTools()).tools;
  if (tools.some(tool => /shell|evaluate|run_code|install|file_upload/.test(tool.name))) throw new Error('QA self-test unrestricted tool');
  process.stdout.write(JSON.stringify({ status: 'passed', steps: 1, viewport: 'mobile', tools: tools.length, screenshot_bytes: screenshot.byteLength, uid: process.getuid?.() }) + '\n');
} finally {
  await client?.close(); await bridge?.close(); await browser?.close();
  server.close();
}
