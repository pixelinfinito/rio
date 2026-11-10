import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedEvidenceTransport } from '../src/hosted-evidence-transport.mjs';
import { EvidenceWriter, HostedEvidenceSink } from '../src/evidence.mjs';

const options = { endpoint: 'https://worker.example', tenant: 'owner', reviewId: 'review', runId: 'run', capability: 'run-scoped-secret' };
const metadata = { journey: 'checkout', step: 1, cell: { viewport: 'mobile', color_scheme: 'light' } };

test('writer hands only sanitized artifacts to the pinned upload transport and retains signed receipts', async () => {
  const calls = [];
  const transport = new HostedEvidenceTransport({ ...options, fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, 'Bearer run-scoped-secret');
    assert.ok(url.startsWith('https://worker.example/v1/qa/runs/run/evidence'));
    calls.push({ url, bytes: Buffer.from(init.body) });
    const descriptor = init.headers['rio-evidence-metadata'] && JSON.parse(init.headers['rio-evidence-metadata']);
    if (!descriptor) return Response.json({ stored: true });
    const step = descriptor.step === undefined ? 'cell' : `step-${String(descriptor.step).padStart(4, '0')}`;
    return Response.json({ ...descriptor, storage: 'hosted', key: `qa/owner/review/run/checkout/mobile-light/${step}-${descriptor.kind}-${descriptor.content_hash.slice(0,16)}.jsonl`, link: 'https://worker.example/signed-one-object' });
  } });
  const writer = new EvidenceWriter({ sink: new HostedEvidenceSink({ ...options, upload: transport.upload.bind(transport) }) });
  const artifact = await writer.write('console', [{ headers: { authorization: 'Bearer sensitive-token' } }], metadata);
  assert.equal(artifact.link, 'https://worker.example/signed-one-object');
  assert.equal(calls.length, 2); assert.ok(calls.every(call => !call.bytes.toString().includes('sensitive-token')));
  assert.deepEqual(JSON.parse(calls[1].bytes).artifacts.map(row => row.id), [artifact.id]);
});

test('transport rejects other namespaces and unsupported endpoints, and hides error bodies', async () => {
  for (const endpoint of ['http://worker.example', 'https://user:secret@worker.example', 'https://worker.example?token=x']) assert.throws(() => new HostedEvidenceTransport({ ...options, endpoint }));
  let calls = 0;
  const transport = new HostedEvidenceTransport({ ...options, fetchImpl: async () => { calls++; return Response.json({ error: 'secret provider data' }, { status: 503 }); } });
  await assert.rejects(transport.upload('qa/other/review/run/manifest.json', Buffer.from('{}')), /scope/); assert.equal(calls, 0);
  await assert.rejects(transport.upload('qa/owner/review/run/manifest.json', Buffer.from('{}')), error => !String(error).includes('secret provider data'));
});

test('a hosted quota race drops optional video and records the reason, without dropping subsequent DOM evidence', async () => {
  const stored = [];
  const sink = new HostedEvidenceSink({ ...options, upload: async (key, bytes, descriptor) => {
    if (descriptor?.kind === 'video') { const error = new Error('quota'); error.code = 'evidence_quota_reached'; throw error; }
    stored.push({ key, bytes });
  } });
  const writer = new EvidenceWriter({ sink, maxBytes: 10000 });
  assert.equal(await writer.write('video', Buffer.from('masked video'), { ...metadata, masked: true }), null);
  assert.ok(await writer.write('dom', {}, metadata));
  assert.equal(writer.notes[0].reason, 'evidence_quota_reached');
  assert.ok(stored.some(row => row.key.includes('-dom-')));
});
