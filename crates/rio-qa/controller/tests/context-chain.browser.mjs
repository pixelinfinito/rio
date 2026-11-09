import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { ApplicationRuntime } from '../src/app-runtime.mjs';
import { openBrowser } from '../src/browser.mjs';
import { executePlan } from '../src/execution.mjs';

test('chain uses one app/browser fixed instant and preserves server and browser cart state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rio-context-chain-'));
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`, time = '2026-12-31T23:59:00Z';
  // Trusted test server only; actual repository applications run in the pod.
  await writeFile(join(root, 'app.cjs'), `let cart=0;require('node:http').createServer((q,s)=>{if(q.url==='/add'){cart++;s.setHeader('set-cookie','cart=present; Path=/');}if(q.url==='/state'){s.setHeader('content-type','application/json');s.end(JSON.stringify({time:process.env.QA_FAKE_TIME,cart,cookie:q.headers.cookie}));}else{s.setHeader('content-type','text/html');s.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Cart</h1>');}}).listen(${port},'127.0.0.1');`);
  const runtime = new ApplicationRuntime({ root, contract: { app: { packaging: 'vendored', start: [process.execPath, 'app.cjs'], url: origin, ready: { path: '/', status: 200, timeout: '3s' } }, personas: [] }, seed: { async start() {}, async restoreOrBuild() {} }, services: { async start() {} } });
  let browser, restores = 0;
  const viewport = { name: 'mobile', width: 390, height: 844, mobile: true, touch: true };
  try {
    const backend = {
      async restoreSeed({ context, signal }) { restores++; runtime.context = context; await runtime.start({ signal }); },
      async applyCredentials() {}, async resetServiceBehaviors() {},
      async openCell({ context }) { browser = await openBrowser({ viewport, context, allowedOrigins: [origin] }); return browser; },
      async runJourney({ journey }) {
        if (journey.name === 'cart') await browser.page.goto(origin + '/add');
        else {
          const state = await browser.page.evaluate(async () => ({ ...(await (await fetch('/state')).json()), browserTime: new Date().toISOString(), cookie: document.cookie }));
          assert.deepEqual(state, { time: new Date(time).toISOString(), browserTime: new Date(time).toISOString(), cart: 1, cookie: 'cart=present' });
        }
        return { outcome: 'passed', evidence: [] };
      },
      async closeCell() { await browser?.close(); browser = undefined; await runtime.stop(); },
    };
    const result = await executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }], cells: [{ viewport: 'mobile', color_scheme: 'light' }] },
      journeys: { cart: { name: 'cart' }, checkout: { name: 'checkout', after: ['cart'], context: { time: '2027-01-01T00:59:00+01:00', locale: 'pt-PT' } } },
      defaults: { time }, backend, runWallMs: 10000, cellWallMs: 8000 });
    assert.equal(result.outcome, 'complete', JSON.stringify(result));
    assert.ok(result.journey_outcomes.every(row => row.outcome === 'passed'));
    assert.equal(restores, 1);
  } finally { await browser?.close(); await runtime.stop(); await rm(root, { recursive: true, force: true }); }
});
