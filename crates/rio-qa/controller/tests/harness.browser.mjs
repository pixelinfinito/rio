import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../src/browser.mjs';
import { JourneySession } from '../src/session.mjs';
import { EvidenceWriter } from '../src/evidence.mjs';
import { Sanitizer } from '../src/sanitize.mjs';
import { CodexHarness, PiHarness, harnessLaunch } from '../src/harness.mjs';
import { builtinProbeRules } from '../src/probes.mjs';

test('codex and pi stub processes use the same restricted MCP, step evidence and sanitized transcript without source or provider credentials', { timeout: 60000 }, async () => {
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><button id="save" onclick="document.querySelector(\'output\').textContent=\'Saved\'">Save</button><output>Ready</output>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  const evidence = [];
  try { for (const Driver of [CodexHarness, PiHarness]) {
    const browser = await openBrowser({ viewport: { name: 'mobile', width: 390, height: 844, mobile: true, touch: true }, allowedOrigins: [origin] });
    const sanitizer = new Sanitizer(['SYNTHETIC_SECRET_SHOULD_NOT_REMAIN']);
    const writer = new EvidenceWriter({ sanitizer, sink: { put: async key => ({ storage: 'local', link: key }), manifest: async () => {} } });
    const session = new JourneySession({ browser, writer, journey: { name: 'save', persona: 'shopper', goal: 'Save settings', steps: [{ do: 'Save', expect: 'Saved' }], success: ['Saved'] }, cell: { viewport: 'mobile', color_scheme: 'light' }, criteria: await builtinProbeRules() });
    const bridge = await session.bridge({ allowedOrigins: [origin] });
    try {
      const harness = new Driver({ model: 'test-model', proxyUrl: 'http://127.0.0.1:9999/v1', proxyToken: 'private-proxy-capability', sanitizer, executable: fileURLToPath(new URL('./stubs/harness.mjs', import.meta.url)) });
      const run = await harness.run({ prompt: `${session.prompt()}\nApp: ${origin}/`, bridge, wallMs: 15000 });
      assert.equal(run.status, 'completed'); assert.equal((await session.finish()).outcome, 'passed');
      assert.ok(!JSON.stringify(run.transcript).includes('SYNTHETIC_SECRET_SHOULD_NOT_REMAIN'));
      assert.ok(JSON.stringify(run.transcript).includes('[redacted]'));
      evidence.push(writer.artifacts.map(row => [row.kind, row.step, row.cell]));
      const launch = harnessLaunch({ kind: harness.kind, directory: '/private-harness', endpoint: 'http://127.0.0.1:1234/mcp', tools: bridge.tools.map(tool => tool.name), model: 'test-model', proxyUrl: 'http://127.0.0.1:9999/v1' });
      assert.ok(!JSON.stringify(launch).includes('private-proxy-capability'));
    } finally { await bridge.close(); await browser.close(); }
  } } finally { await new Promise(resolve => server.close(resolve)); }
  assert.deepEqual(evidence[0], evidence[1]);
  assert.equal(evidence[0].filter(([, step]) => step === 1).length, 6);
  assert.deepEqual(evidence[0].filter(([, step]) => step === undefined), [['screenshot', undefined, { viewport: 'mobile', color_scheme: 'light' }]]);
});
