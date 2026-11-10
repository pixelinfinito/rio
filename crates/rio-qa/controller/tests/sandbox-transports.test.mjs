import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedEvidenceTransport } from '../src/hosted-evidence-transport.mjs';
import { HostedSeedTransport } from '../src/hosted-seed-transport.mjs';
import { gatewayTransport } from '../src/model-proxy.mjs';

test('Sandbox HTTP exception is explicit and limited to the platform-intercepted gateway IP', async () => {
  const options = { tenant: 'owner', reviewId: 'review', runId: 'run', capability: 'run-capability' };
  for (const Factory of [HostedSeedTransport, HostedEvidenceTransport]) {
    assert.throws(() => new Factory({ ...options, endpoint: 'http://198.18.0.1' }));
    new Factory({ ...options, endpoint: 'http://198.18.0.1', sandboxGateway: true });
    for (const endpoint of ['http://external.test', 'http://198.18.0.1:8080', 'http://user:pass@198.18.0.1', 'http://198.18.0.1?token=x'])
      assert.throws(() => new Factory({ ...options, endpoint, sandboxGateway: true }));
  }
  assert.throws(() => gatewayTransport({ baseUrl: 'http://198.18.0.1/v1/qa/model', token: 'run-capability', runId: 'run' }));
  let call;
  const forward = gatewayTransport({ sandboxGateway: true, baseUrl: 'http://198.18.0.1/v1/qa/model', token: 'run-capability', runId: 'run',
    fetch: async (url, options) => { call = { url, options }; return new Response('{}'); } });
  await forward({ path: '/v1/responses', body: { model: 'pinned' }, cell: { id: 'cell-id' } });
  assert.equal(call.url, 'http://198.18.0.1/v1/qa/model/v1/responses');
  assert.equal(call.options.headers['x-rio-run-id'], 'run');
  assert.equal(call.options.headers['x-rio-cell-id'], 'cell-id');
  assert.equal(call.options.redirect, 'error');
});
