import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openBrowser } from '../src/browser.mjs';
import { restrictedMcp, RIO_TOOLS } from '../src/mcp.mjs';
import { FixtureClient } from '../src/fixture-client.mjs';
import { Sanitizer } from '../src/sanitize.mjs';
import { createServer } from 'node:http';

test('MCP follows a live verification link while transcripts and capture evidence redact its token', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/verify?token=one-time-value' ? '<h1>Verified account</h1>' : '<h1>Invalid link</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, sanitizer = new Sanitizer(['persona-password']), events = [];
  let browser, bridge, client;
  try {
    const captures = new FixtureClient({ endpoint: origin, allowedOrigins: [origin], sanitizer, personas: [{ name: 'shopper' }],
      fetchImpl: async () => Response.json({ messages: [{ id: 'verification', text: 'Password: persona-password', links: [origin + '/verify?token=one-time-value'] }] }) });
    browser = await openBrowser({ viewport: { width: 390, height: 844, mobile: true, touch: true }, allowedOrigins: [origin] });
    bridge = await restrictedMcp(browser, { handlers: captures.handlers, allowedOrigins: [origin], sanitize: value => sanitizer.value(value), record: async event => events.push(event) });
    const [left, right] = InMemoryTransport.createLinkedPair(); await bridge.server.connect(right);
    client = new Client({ name: 'capture-harness', version: '1' }); await client.connect(left);
    const mail = await client.callTool({ name: 'read_mail', arguments: { persona: 'shopper' } });
    const url = JSON.parse(mail.content[0].text).messages[0].links[0];
    assert.equal(url, origin + '/verify?token=one-time-value');
    const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url } });
    assert.ok(!navigation.isError, JSON.stringify(navigation));
    assert.match(JSON.stringify(navigation.content), /Verified account/);
    assert.doesNotMatch(JSON.stringify(navigation.content), /\[Snapshot\]\(/);
    assert.match((await client.callTool({ name: 'browser_snapshot', arguments: {} })).content[0].text, /Verified account/);
    assert.ok(!JSON.stringify([events, captures.capturedMessages(), navigation]).includes('one-time-value'));
    assert.ok(!JSON.stringify(mail).includes('persona-password'));
  } finally { await client?.close(); await bridge?.close(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});

test('MCP exposes only restricted actions and Rio tools against the fixture', async () => {
  const fixture = new URL('../../../../tests/fixtures/qa-sample/', import.meta.url);
  const child = spawn(process.execPath, ['scripts/test-server.mjs'], { cwd: fixture, stdio: 'pipe' });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  let browser, bridge, client;
  try {
    let ready = false;
    // Vite builds the fixture before listening; loaded CI hosts can exceed 10s.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(errors);
      try { ready = (await fetch('http://127.0.0.1:4173/api/health', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, errors);
    browser = await openBrowser({ viewport: { width: 390, height: 844, mobile: true, touch: true, device_scale_factor: 3 }, allowedOrigins: ['http://127.0.0.1:4173'] });
    const events = [];
    bridge = await restrictedMcp(browser, { record: async event => events.push(event), allowedOrigins: ['http://127.0.0.1:4173'] });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await bridge.server.connect(right);
    client = new Client({ name: 'test-harness', version: '1' }); await client.connect(left);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const tool of RIO_TOOLS) assert.ok(names.includes(tool.name), tool.name);
    for (const name of ['shell', 'browser_run_code', 'browser_evaluate', 'browser_file_upload', 'browser_install']) assert.ok(!names.includes(name), name);
    assert.ok((await client.callTool({ name: 'shell', arguments: { command: 'id' } })).isError);
    assert.ok((await client.callTool({ name: 'browser_snapshot', arguments: { filename: '/tmp/rio-forbidden-snapshot.yml' } })).isError);
    assert.ok((await client.callTool({ name: 'browser_navigate', arguments: { url: 'file:///etc/passwd' } })).isError);
    const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:4173/' } });
    assert.ok(!navigation.isError, JSON.stringify(navigation));
    const readyPage = await client.callTool({ name: 'browser_wait_for', arguments: { text: 'Everyday essentials' } });
    assert.ok(!readyPage.isError, JSON.stringify(readyPage));
    assert.match((await client.callTool({ name: 'browser_snapshot', arguments: {} })).content[0].text, /Everyday essentials/);
    assert.ok(events.some(event => event.tool === 'shell' && event.rejected));
    assert.ok(events.some(event => event.tool === 'browser_snapshot' && event.rejected));
    const page = browser.context.pages().find(page => page.url().startsWith('http:'));
    assert.equal(await page.evaluate(() => window.devicePixelRatio), 3);
    assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0));
    assert.equal(await page.evaluate(() => innerWidth), 390);
  } finally {
    await client?.close(); await bridge?.close(); await browser?.close();
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  }
});
