import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedSeedTransport } from '../src/hosted-seed-transport.mjs';

const options = { endpoint: 'https://worker.example.test', tenant: 'owner', capability: 'scoped-synthetic-capability' };

test('seed transport pins its destination, blocks redirects and does not disclose provider error bodies', async () => {
  const calls = [];
  const transport = new HostedSeedTransport({ ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ error: 'provider response includes a private token', details: { secret: 'private-value' } }), { status: 503 });
  } });
  await assert.rejects(transport.lease('seeds/owner/', 'a'.repeat(64)), error => error.reason === 'seed_store_unavailable' && !JSON.stringify(error).includes('private'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, options.endpoint + '/v1/qa/seeds/leases');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ' + options.capability);
  await assert.rejects(transport.manifest('seeds/other/' + 'a'.repeat(64) + '/manifest.json'));
  assert.equal(calls.length, 1);
  for (const endpoint of ['http://worker.example.test', 'https://user:pass@worker.example.test', 'https://worker.example.test?target=other', 'https://worker.example.test#fragment']) assert.throws(() => new HostedSeedTransport({ ...options, endpoint }));
});

test('failed lease retention stops publication and lease cleanup remains available', async () => {
  let released = false;
  const transport = new HostedSeedTransport({ ...options, fetchImpl: async (url, init) => {
    if (init.method === 'POST') return Response.json({ id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12) });
    if (init.method === 'DELETE') { released = true; return Response.json({ released: true }); }
    return Response.json({ error: 'seed_lease_expired' }, { status: 400 });
  } });
  const lease = await transport.lease('seeds/owner/', 'a'.repeat(64));
  await assert.rejects(lease.retain('b'.repeat(64)), error => error.reason === 'seed_lease_expired');
  await assert.rejects(lease.check(), error => error.reason === 'seed_lease_expired');
  await assert.rejects(transport.putPart('seeds/owner/objects/' + 'b'.repeat(64), { hash: 'b'.repeat(64), bytes: 1 }, Buffer.from('a')));
  await lease.close(); assert.equal(released, true); assert.equal(transport.leases.size, 0);
});

test('seed responses are bounded before parsing and known quota details are retained', async () => {
  const transport = new HostedSeedTransport({ ...options, fetchImpl: async () => new Response('x'.repeat(100)) });
  await assert.rejects(transport.request('/leases', { limit: 10 }), error => error.reason === 'seed_store_unavailable');
  transport.fetchImpl = async () => Response.json({ error: 'seed_too_large', details: { largest_archive: 'shop', bytes: 100, max_bytes: 10, token: 'must-not-escape' } }, { status: 400 });
  await assert.rejects(transport.request('/leases'), error => error.reason === 'seed_too_large' && error.details.largest_archive === 'shop' && !JSON.stringify(error).includes('must-not-escape'));
});
