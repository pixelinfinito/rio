import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import { openBrowser } from '../src/browser.mjs';
import { resolveContext, contextEnvironment } from '../src/context.mjs';

test('fixed time, locale, location, network and orientation are replayable without losing chain state', async () => {
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button>Retry save</button>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mobile = { name: 'mobile', width: 390, height: 844, device_scale_factor: 3, mobile: true, touch: true, orientation: 'portrait' };
  const landscape = { ...mobile, name: 'mobile-landscape', width: 844, height: 390, orientation: 'landscape' };
  const fixed = '2026-12-31T23:59:00Z';
  const context = resolveContext({ time: '2026-01-01T00:00:00Z', locale: 'fr-FR', timezone: 'America/New_York' }, { time: fixed, geolocation: { latitude: 38.72, longitude: -9.14 }, network: 'online' });
  const browser = await openBrowser({ viewport: mobile, viewports: { mobile, 'mobile-landscape': landscape }, context, journey: 'checkout', allowedOrigins: [origin] });
  try {
    await browser.page.goto(origin);
    const state = await browser.page.evaluate(async () => ({ time: Date.now(), locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      location: await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(position => resolve([position.coords.latitude, position.coords.longitude]), reject)) }));
    assert.equal(state.time, Date.parse(fixed)); assert.equal(state.locale, 'fr-FR'); assert.equal(state.timezone, 'America/New_York');
    assert.deepEqual(state.location, [38.72, -9.14]);
    assert.equal(contextEnvironment(context).QA_FAKE_TIME, new Date(fixed).toISOString());
    await browser.context.addCookies([{ name: 'cart', value: 'synthetic-cart', url: origin }]);
    browser.setReplayStep(2);
    await browser.handlers.set_network({ network: 'offline' });
    assert.equal(await browser.page.evaluate(async () => { try { await fetch('/save'); return 'unexpected'; } catch { return 'offline'; } }), 'offline');
    assert.ok(browser.networkEvents.some(event => event.kind === 'requestfailed'));
    await browser.handlers.set_network({ network: 'slow-3g' });
    await browser.handlers.set_network({ network: 'online' });
    assert.equal(await browser.page.evaluate(async () => (await fetch('/save')).status), 200);
    await browser.handlers.set_geolocation({ latitude: 51.5, longitude: -0.1 });
    await browser.handlers.set_viewport({ viewport: 'mobile-landscape' });
    await browser.handlers.set_color_scheme({ color_scheme: 'dark' });
    const orientation = await browser.page.evaluate(() => ({ width: innerWidth, height: innerHeight, angle: screen.orientation.angle, scale: devicePixelRatio, touch: navigator.maxTouchPoints, dark: matchMedia('(prefers-color-scheme: dark)').matches, time: Date.now() }));
    assert.deepEqual({ ...orientation, touch: orientation.touch > 0 }, { width: 844, height: 390, angle: 90, scale: 3, touch: true, dark: true, time: Date.parse(fixed) });
    assert.equal((await browser.context.cookies()).find(cookie => cookie.name === 'cart').value, 'synthetic-cart');
    assert.equal(browser.replayEvents[0].arguments.context.network, 'online');
    assert.equal(browser.replayEvents[1].step, 2);
    assert.deepEqual(browser.replayEvents.map(event => event.action), ['set_context', 'set_network', 'set_network', 'set_network', 'set_geolocation', 'set_viewport', 'set_color_scheme']);
    const schema = JSON.parse(await readFile(new URL('../../../../schemas/qa-replay-v1.json', import.meta.url), 'utf8'));
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
    for (const event of browser.replayEvents) assert.ok(validate(event), JSON.stringify(validate.errors));
    await assert.rejects(browser.handlers.set_viewport({ viewport: 'undeclared' }), /Undeclared viewport/);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('dependent context changes keep the fixed clock and cookies and reject a new instant atomically', async () => {
  const browser = await openBrowser({ viewport: { name: 'mobile', width: 390, height: 844, mobile: true, touch: true }, context: { time: '2026-12-31T23:59:00Z' } });
  try {
    await browser.context.addCookies([{ name: 'cart', value: 'existing-cart', url: 'http://app:4173' }]);
    await browser.controls.context({ time: '2027-01-01T00:59:00+01:00', timezone: 'Europe/Lisbon', locale: 'pt-PT', network: 'offline', geolocation: { latitude: 38.7, longitude: -9.1 } });
    const state = await browser.page.evaluate(() => ({ time: Date.now(), locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, online: navigator.onLine }));
    assert.deepEqual(state, { time: Date.parse('2026-12-31T23:59:00Z'), locale: 'pt-PT', timezone: 'Europe/Lisbon', online: false });
    assert.equal((await browser.context.cookies())[0].value, 'existing-cart');
    const before = browser.controls.state, count = browser.replayEvents.length;
    await assert.rejects(browser.controls.context({ time: '2027-01-02T00:00:00Z', network: 'online' }), /Incompatible chain times/);
    assert.deepEqual(browser.controls.state, before);
    assert.equal(browser.replayEvents.length, count);
    assert.equal(browser.replayEvents.at(-1).action, 'set_context');
    assert.equal(browser.replayEvents.at(-1).arguments.context.locale, 'pt-PT');
  } finally { await browser.close(); }
});
