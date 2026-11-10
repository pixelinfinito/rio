import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { Sanitizer } from '../src/sanitize.mjs';
import { sanitizeTrace } from '../src/trace.mjs';
import { EvidenceWriter, LocalEvidenceSink, HostedEvidenceSink } from '../src/evidence.mjs';

const metadata = { journey: 'checkout', step: 1, cell: { viewport: 'mobile', color_scheme: 'light' } };
const trace = extra => zipSync({ 'trace.trace': strToU8(JSON.stringify({ type: 'context-options', version: 10 }) + '\n' + JSON.stringify({ type: 'before', method: 'fill', params: { value: 'synthetic-one-time-code' } }) + '\n'), 'trace.network': strToU8(JSON.stringify({ type: 'resource-snapshot', snapshot: { request: { url: 'http://app/verify?token=network-secret', headers: [{ name: 'Authorization', value: 'Bearer authorization-secret' }] }, response: { content: { _sha1: 'body', text: 'secret response' } } } })), 'resources/body': strToU8('unretained-response-secret'), ...extra });

test('text and network sanitization covers the shared catalog, named tokens, headers, encoded secrets and truncation boundaries', () => {
  const secret = 'synthetic-credential-long-value', sanitizer = new Sanitizer([secret]);
  const token = 'ghp_' + 'A'.repeat(36);
  const value = sanitizer.network({ headers: { Authorization: 'Bearer abc', Cookie: 'session=abc', 'Set-Cookie': 'abc', 'X-Api-Key': 'abc' },
    request: { url: 'http://app/verify?%74oken=url-secret&view=summary', body: JSON.stringify({ token: 'short', password: 'abc', normal: 'kept' }) },
    response: { body: 'a'.repeat(16380) + secret + token }, encoded: Buffer.from(secret).toString('base64') });
  for (const header of Object.values(value.headers)) assert.equal(header, '[redacted]');
  assert.equal(value.request.url, 'http://app/verify?%74oken=[redacted]&view=summary');
  assert.deepEqual(JSON.parse(value.request.body), { token: '[redacted]', password: '[redacted]', normal: 'kept' });
  assert.equal(Buffer.byteLength(value.response.body), 16384); assert.equal(value.response.body_truncated, true);
  assert.ok(!JSON.stringify(value).includes(secret.slice(0, 4)));
  assert.equal(value.encoded, '[redacted]'); assert.equal(sanitizer.text(token), '[redacted]');
  const entropy = 'api_key = "aBcD1234eFgH5678iJkL9012mNoP3456"';
  assert.ok(!sanitizer.text(entropy).includes('aBcD1234'));
});

test('trace sanitization redacts every text member and drops body resources, failing closed on unknown or malformed members', () => {
  const sanitizer = new Sanitizer(['synthetic-one-time-code']);
  const result = sanitizeTrace(trace(), sanitizer); assert.ok(result.sanitized);
  const members = unzipSync(result.bytes), text = Object.values(members).map(strFromU8).join('\n');
  for (const secret of ['synthetic-one-time-code', 'network-secret', 'authorization-secret', 'unretained-response-secret', 'secret response']) assert.ok(!text.includes(secret), secret);
  assert.ok(!Object.hasOwn(members, 'resources/body'));
  assert.equal(sanitizeTrace(trace({ 'unknown.bin': new Uint8Array([1, 2]) }), sanitizer).dropped, 'evidence_unsanitized');
  assert.equal(sanitizeTrace(trace({ 'trace.stacks': strToU8('not JSON') }), sanitizer).dropped, 'evidence_unsanitized');
  assert.equal(sanitizeTrace(trace({ '../escape': strToU8('escape') }), sanitizer).dropped, 'evidence_unsanitized');
  assert.equal(sanitizeTrace(trace(), sanitizer, { maxExpandedBytes: 1 }).dropped, 'evidence_unsanitized');
});

test('only referenced CSS snapshot resources are sanitized; malformed or unknown resources fail closed', () => {
  const name = 'resources/' + 'a'.repeat(40) + '.css';
  const snapshot = reference => strToU8(JSON.stringify({ type: 'context-options', version: 10 }) + '\n' + JSON.stringify({ type: 'frame-snapshot', snapshot: { html: ['HTML', {}], resourceOverrides: [{ url: 'http://app/style.css', file: reference }] } }) + '\n');
  const make = (reference, bytes) => trace({ 'trace.trace': snapshot(reference), [name]: bytes });
  const sanitizer = new Sanitizer(['css-secret']);
  const result = sanitizeTrace(make(name, strToU8('a { content: "css-secret"; background: url("https://app/image?token=private"); }')), sanitizer);
  assert.ok(result.sanitized);
  const css = strFromU8(unzipSync(result.bytes)[name]);
  assert.ok(!css.includes('css-secret')); assert.ok(!css.includes('private'));
  assert.equal(sanitizeTrace(make(name, new Uint8Array([255, 254])), sanitizer).dropped, 'evidence_unsanitized');
  assert.equal(sanitizeTrace(make('../escape.css', strToU8('a {}')), sanitizer).dropped, 'evidence_unsanitized');
  assert.equal(sanitizeTrace(make(name.replace('.css', '.js'), strToU8('a {}')), sanitizer).dropped, 'evidence_unsanitized');
  assert.equal(sanitizeTrace(trace({ 'trace.trace': snapshot(name) }), sanitizer).failure, 'missing_style');
  assert.equal(sanitizeTrace(trace({ [name]: strToU8('a {}') }), sanitizer).dropped, 'evidence_unsanitized');
});

test('local manifests survive each write, keep mandatory artifacts after quota and reject path escapes and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rio-evidence-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const sink = await LocalEvidenceSink.create({ cacheRoot: join(root, '.rio/cache'), reviewId: 'review', runId: 'run', repositoryRoot: root });
    const writer = new EvidenceWriter({ sink, maxBytes: 1 });
    const screenshot = await writer.write('screenshot', Buffer.from('synthetic-image'), { ...metadata, masked: true });
    const dom = await writer.write('dom', { content: 'retained' }, metadata);
    assert.ok(screenshot && dom);
    assert.equal(await writer.write('video', Buffer.from('synthetic-video'), { ...metadata, masked: true }), null);
    assert.equal(await writer.write('trace', trace({ 'unknown.bin': strToU8('bad') }), metadata), null);
    const manifest = JSON.parse(await readFile(join(sink.directory, 'manifest.json')));
    assert.equal(manifest.artifacts.length, 2); assert.ok(manifest.quota_reached);
    assert.ok(manifest.notes.some(note => note.reason === 'evidence_quota_reached'));
    assert.ok(manifest.notes.some(note => note.reason === 'evidence_unsanitized'));
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString(), '');
    await assert.rejects(writer.write('dom', {}, { ...metadata, journey: '../escape' }), /path component/);
    await assert.rejects(writer.write('screenshot', Buffer.alloc(0), metadata), /Unmasked/);
    await symlink(root, join(sink.directory, 'redirect'));
    await assert.rejects(sink.put('redirect/file.json', Buffer.from('bad')), /symlinks/);
    assert.ok((await readdir(root)).every(name => name !== 'file.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hosted evidence uploads each sanitized artifact before its manifest, retaining completed writes after interruption', async () => {
  const objects = new Map(); let unavailable = false;
  const sink = new HostedEvidenceSink({ tenant: 'tenant', reviewId: 'review', runId: 'run', upload: async (key, bytes) => { if (unavailable) throw new Error('interrupted'); objects.set(key, Buffer.from(bytes)); } });
  const writer = new EvidenceWriter({ sink, sanitizer: new Sanitizer(['synthetic-secret']) });
  const artifact = await writer.write('console', [{ text: 'synthetic-secret' }], metadata);
  assert.ok(artifact.key.startsWith('qa/tenant/review/run/checkout/mobile-light/'));
  assert.ok(!objects.get(artifact.key).toString().includes('synthetic-secret'));
  unavailable = true;
  await assert.rejects(writer.write('dom', {}, { ...metadata, step: 2 }), /interrupted/);
  const manifest = JSON.parse(objects.get('qa/tenant/review/run/manifest.json'));
  assert.deepEqual(manifest.artifacts.map(row => row.id), [artifact.id]);
});

test('retry after manifest upload failure republishes the manifest without duplicating bytes', async () => {
  const objects = new Map(); let failManifest = true, artifacts = 0;
  const sink = new HostedEvidenceSink({ tenant: 'tenant', reviewId: 'review', runId: 'run', upload: async (key, bytes) => {
    if (key.endsWith('/manifest.json') && failManifest) throw new Error('temporary manifest failure');
    if (!key.endsWith('/manifest.json')) artifacts++;
    objects.set(key, Buffer.from(bytes));
  } });
  const writer = new EvidenceWriter({ sink });
  await assert.rejects(writer.write('dom', { page: 'checkout' }, metadata), /manifest failure/);
  const retained = writer.bytes; failManifest = false;
  const retry = await writer.write('dom', { page: 'checkout' }, metadata);
  assert.equal(writer.bytes, retained); assert.equal(artifacts, 1);
  assert.equal(JSON.parse(objects.get('qa/tenant/review/run/manifest.json')).artifacts[0].id, retry.id);
});
