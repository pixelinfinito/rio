import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { openBrowser } from '../src/browser.mjs';
import { EvidenceCollector, EvidenceWriter, LocalEvidenceSink } from '../src/evidence.mjs';
import { Sanitizer } from '../src/sanitize.mjs';

const exec = promisify(execFile), secret = 'SECRET98765432', password = 'SYNTHETIC_PASSWORD_923857';
const viewport = { name: 'mobile', width: 390, height: 844, mobile: true, touch: true, device_scale_factor: 1 };
const cell = { viewport: 'mobile', color_scheme: 'light' };

// This acceptance test must run with provisioned ffmpeg and tesseract. Skipping
// the video scan would not establish the evidence privacy contract.
test('full browser bundle is sanitized, with masked screenshots and video frames sampled each second', { timeout: 60000 }, async () => {
  await exec('ffmpeg', ['-version']); await exec('tesseract', ['--version']);
  const root = await mkdtemp(join(tmpdir(), 'rio-bundle-test-'));
  const server = createServer((request, response) => {
    if (request.url.startsWith('/api')) {
      response.setHeader('content-type', 'application/json'); response.setHeader('set-cookie', `token=${secret}; Path=/`);
      response.end(JSON.stringify({ token: secret, echoed: password, text: 'x'.repeat(20000) })); return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:12px;background:white;color:black;font:26px Arial}input{display:block;width:340px;font:26px Arial;margin:20px 0}</style><h1>Checkout</h1><div data-rio-mask>${secret}</div><input id="password" type="password"><input id="otp" data-rio-mask><div id="shadow"></div>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, control;
  try {
    control = await openBrowser({ viewport });
    await control.page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><div style="font:32px Arial;color:black;background:white">${secret}</div>`);
    const positive = join(root, 'positive.png'); await control.page.screenshot({ path: positive });
    const readPositive = (await exec('tesseract', [positive, 'stdout', '--psm', '6'])).stdout;
    assert.ok(readPositive.includes(secret), `OCR positive control failed: ${readPositive}`);
    await control.close(); control = undefined;
    browser = await openBrowser({ viewport, video: true, allowedOrigins: [origin] });
    const sink = await LocalEvidenceSink.create({ cacheRoot: join(root, 'cache'), reviewId: 'review', runId: 'run' });
    const sanitizer = new Sanitizer([secret, password]), writer = new EvidenceWriter({ sink, sanitizer });
    const capture = new EvidenceCollector(browser, writer);
    await browser.page.goto(origin);
    await browser.page.locator('#password').fill(password);
    await browser.page.locator('#otp').fill(secret);
    await browser.page.locator('#shadow').evaluate((host, value) => {
      const shadow = host.attachShadow({ mode: 'open' });
      const element = document.createElement('div'); element.setAttribute('data-rio-mask', ''); element.textContent = value; shadow.append(element);
    }, secret);
    await browser.page.evaluate(async ({ secret, password }) => {
      console.error('synthetic diagnostic: ' + secret);
      await fetch('/api?token=' + secret, { method: 'POST', headers: { authorization: 'Bearer ' + password, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    }, { secret, password });
    browser.replayEvents.push({ version: 1, sequence: browser.replayEvents.length, journey: 'checkout', step: 1, cell, action: 'type', arguments: { selector: '#otp', value: secret } });
    await browser.page.waitForTimeout(2200);
    const step = await capture.step({ journey: 'checkout', step: 1, cell, messages: [{ text: 'Verify at ' + origin + '/verify?token=' + secret }] });
    assert.equal(step.evidence.length, 6);
    const manifest = await capture.finish({ journey: 'checkout', cell, transcript: [{ text: 'entered ' + password }] });
    browser = undefined;
    for (const kind of ['screenshot', 'dom', 'accessibility', 'console', 'network', 'capture', 'trace', 'replay', 'transcript', 'video']) assert.ok(manifest.artifacts.some(artifact => artifact.kind === kind), `${kind}: ${JSON.stringify(manifest.notes)}`);
    const imageFiles = [], decoded = join(root, 'decoded'); await mkdir(decoded);
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(artifact.link);
      for (const value of [secret, password]) assert.ok(!bytes.includes(Buffer.from(value)), `${artifact.kind} leaked a literal secret`);
      if (artifact.kind === 'screenshot') imageFiles.push(artifact.link);
      if (artifact.kind === 'trace') {
        const members = unzipSync(bytes);
        for (const [name, member] of Object.entries(members)) {
          for (const value of [secret, password]) assert.ok(!Buffer.from(member).includes(Buffer.from(value)), `${name} leaked a secret`);
          if (/\.(png|jpe?g)$/.test(name)) { const path = join(decoded, 'trace-' + imageFiles.length + '.jpg'); await writeFile(path, member); imageFiles.push(path); }
        }
      }
      if (artifact.kind === 'video') {
        await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', artifact.link, '-vf', 'fps=1', join(decoded, 'frame-%03d.png')]);
        const frames = (await readdir(decoded)).filter(name => name.startsWith('frame-'));
        assert.ok(frames.length >= 2, 'video must cover multiple one-second samples');
        imageFiles.push(...frames.map(name => join(decoded, name)));
      }
    }
    for (const path of imageFiles) {
      const text = (await exec('tesseract', [path, 'stdout', '--psm', '6'])).stdout;
      for (const value of [secret, password]) assert.ok(!text.includes(value), `${path} visually leaked ${value}`);
    }
    const network = manifest.artifacts.find(artifact => artifact.kind === 'network');
    const entries = (await readFile(network.link, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(entries.some(entry => entry.kind === 'response' && entry.body_truncated));
    assert.ok(entries.some(entry => entry.kind === 'request' && entry.headers.authorization === '[redacted]'));
  } finally {
    await control?.close(); await browser?.close();
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
});
