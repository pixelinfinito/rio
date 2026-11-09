import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { unzipSync, strFromU8 } from 'fflate';
import { openBrowser } from '../src/browser.mjs';
import { EvidenceCollector, EvidenceWriter } from '../src/evidence.mjs';
import { Sanitizer } from '../src/sanitize.mjs';

test('trace sanitizes browser CSS snapshot overrides after dynamic stylesheet changes', async () => {
  const secret = 'synthetic-css-secret-12345';
  const server = createServer((request, response) => {
    response.setHeader('content-type', request.url === '/style.css' ? 'text/css' : 'text/html');
    response.end(request.url === '/style.css' ? 'button { color: black; }' : '<link rel="stylesheet" href="/style.css"><button>Pay</button>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await openBrowser({ viewport: { width: 390, height: 844, mobile: true, touch: true }, allowedOrigins: [origin] });
  const stored = new Map();
  const writer = new EvidenceWriter({ sanitizer: new Sanitizer([secret]), sink: { put: async (key, bytes) => { stored.set(key, bytes); return { storage: 'local', link: key }; }, manifest: async () => {} } });
  const collector = new EvidenceCollector(browser, writer);
  try {
    await browser.page.goto(origin);
    await browser.page.evaluate(value => document.styleSheets[0].insertRule(`button { --private-value: "${value}"; }`), secret);
    await browser.page.getByRole('button').click();
    const manifest = await collector.finish({ journey: 'checkout', cell: { viewport: 'mobile', color_scheme: 'light' } });
    const trace = manifest.artifacts.find(row => row.kind === 'trace');
    assert.ok(trace, JSON.stringify(manifest.notes));
    const members = unzipSync(stored.get(trace.link));
    const css = Object.entries(members).filter(([name]) => name.endsWith('.css'));
    assert.ok(css.length);
    assert.ok(css.every(([, bytes]) => !strFromU8(bytes).includes(secret)));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
