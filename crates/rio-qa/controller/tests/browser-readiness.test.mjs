import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectRemoteBrowser } from '../src/browser.mjs';

test('remote Chromium startup can lag app readiness without consuming a harness retry', async () => {
  let attempts = 0;
  const browser = {};
  const connected = await connectRemoteBrowser('http://browser:9223', { timeoutMs: 1000, connect: async () => {
    if (++attempts < 3) throw new Error('connect ECONNREFUSED browser:9223');
    return browser;
  } });
  assert.equal(connected, browser); assert.equal(attempts, 3);
});
test('remote browser retries are bounded, abortable, and do not hide protocol errors', async () => {
  const abort = new AbortController(); let attempts = 0;
  await assert.rejects(connectRemoteBrowser('http://browser:9223', { signal: abort.signal, connect: async () => {
    attempts++; abort.abort(new Error('cancelled')); throw new Error('ECONNREFUSED');
  } }), /cancelled/);
  assert.equal(attempts, 1);
  await assert.rejects(connectRemoteBrowser('invalid', { connect: async () => { throw new Error('Invalid protocol'); } }), /Invalid protocol/);
  await assert.rejects(connectRemoteBrowser('http://browser:9223', { timeoutMs: 10, connect: async () => { throw new Error('ECONNREFUSED'); } }), /ECONNREFUSED/);
});
