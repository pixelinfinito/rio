import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureClient, presentToolResult } from '../src/fixture-client.mjs';
import { Sanitizer } from '../src/sanitize.mjs';

test('live capture links are scoped and never retained with stored capture bodies', async () => {
  const sanitizer = new Sanitizer(['persona-password']);
  const links = ['http://app:4173/verify?token=one-time-value', 'https://outside.test/?token=external',
    'http://app:4173/verify?code=persona-password', 'http://user:password@app:4173/', 'file:///etc/passwd'];
  const calls = [];
  const client = new FixtureClient({ endpoint: 'http://app:9224', sanitizer, allowedOrigins: ['http://app:4173'], personas: [{ name: 'shopper' }],
    fixtures: { services: [{ name: 'payments', behaviors: ['approve', 'decline'] }] },
    fetchImpl: async (url, options) => {
      calls.push({ path: url.pathname, value: JSON.parse(options.body), redirect: options.redirect });
      return Response.json({ messages: [{ id: 'message-1', text: 'persona-password ' + links[0], links, password: 'other-value' }] });
    } });
  const result = await client.handlers.read_mail({ persona: 'shopper' });
  assert.ok(!JSON.stringify(result).includes('one-time-value'));
  const presented = presentToolResult(result, value => sanitizer.value(value));
  const message = JSON.parse(presented.content[0].text).messages[0];
  assert.deepEqual(message.links, [links[0]]);
  assert.equal(message.password, '[redacted]'); assert.ok(!message.text.includes('persona-password'));
  assert.ok(!JSON.stringify(client.capturedMessages()).includes('one-time-value'));
  assert.ok(!JSON.stringify(presentToolResult(structuredClone(presented), value => sanitizer.value(value))).includes('one-time-value'), 'serialized data cannot grant live-link privileges');
  await assert.rejects(client.handlers.read_mail({ persona: 'undeclared' }));
  await assert.rejects(client.handlers.set_service_behavior({ service: 'payments', behavior: 'external' }));
  await client.handlers.set_service_behavior({ service: 'payments', behavior: 'decline' });
  assert.equal(calls.length, 2); assert.equal(calls[1].path, '/fixtures/behavior');
  assert.ok(calls.every(call => call.redirect === 'error'));
  client.reset(); assert.deepEqual(client.capturedMessages(), []);
});
