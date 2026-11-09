import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixedTimeKey, chainContexts, resolveContext, contextEnvironment } from '../src/context.mjs';

test('fixed instants normalize offsets and preserve fractional distinctions', () => {
  assert.equal(fixedTimeKey('2026-12-31T23:59:00Z'), fixedTimeKey('2027-01-01T00:59:00.000000000+01:00'));
  assert.notEqual(fixedTimeKey('2026-12-31T23:59:00.000000001Z'), fixedTimeKey('2026-12-31T23:59:00Z'));
  for (const time of ['tomorrow', '2026-02-30T00:00:00Z', '2026-01-01T00:00:00', '2026-01-01T00:00:60Z']) assert.throws(() => fixedTimeKey(time), /Invalid fixed time/);
  const resolved = chainContexts({ journeys: ['cart', 'checkout'] }, { cart: { context: { time: null, network: null } }, checkout: {} }, { time: '2026-01-01T00:00:00Z', network: 'online' });
  assert.equal(resolved.cart.time, resolved.checkout.time);
  assert.equal(resolved.cart.network, 'online');
});


test('optional geolocation accuracy from Rust does not override browser defaults', () => {
  const context = resolveContext({}, { geolocation: { latitude: 40, longitude: -70, accuracy: null }, time: null });
  assert.deepEqual(context, { geolocation: { latitude: 40, longitude: -70 } });
  assert.deepEqual(contextEnvironment(context), {});
});
