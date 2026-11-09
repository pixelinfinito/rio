import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Resolver } from 'node:dns/promises';
import { FixtureServices } from '../src/fixture-services.mjs';
import { AppProcesses } from '../src/app-runtime.mjs';
const root = fileURLToPath(new URL('../../../../tests/fixtures/qa-sample', import.meta.url));
const payments = { name: 'payments', kind: 'http-mock', env: { PAYMENTS_API_BASE: '{{url}}' }, recordings: 'recordings/payments', behaviors: ['approve', 'decline'], default_behavior: 'approve' };
async function setup(t, fixtures, options = {}) {
  const processes = new AppProcesses({ cwd: root, env: { PATH: process.env.PATH } });
  const services = new FixtureServices({ root, fixtures, personas: [{ name: 'shopper', username_env: 'QA_EMAIL' }, { name: 'guest' }], credentials: { QA_EMAIL: 'shopper@example.test' }, appOrigins: ['http://app:4173'], ...options });
  t.after(async () => { await services.stop(); await processes.close(); });
  await services.start({ processes, signal: new AbortController().signal });
  return { services, env: processes.env, processes };
}
const post = (url, value) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('undoubled DNS requests fail closed and record the dependency hostname', async t => {
  const { services } = await setup(t, {}, { dns: true, ports: { dns: 0 } });
  const resolver = new Resolver(); resolver.setServers([`127.0.0.1:${services.dnsServer.address().port}`]);
  await assert.rejects(resolver.resolve4('api.undoubled.example'), { code: 'ENOTFOUND' });
  assert.ok(services.events.some(event => event.kind === 'blocked_egress' && event.host === 'api.undoubled.example'));
  await services.reset({ signal: new AbortController().signal });
  assert.deepEqual(services.events, []);
});

test('payment recordings and behavior switches survive within a chain and reset at its boundary', async t => {
  const { services, env } = await setup(t, { services: [payments] });
  assert.equal((await post(env.PAYMENTS_API_BASE + '/v1/charges', {})).status, 200);
  await services.behavior('payments', 'decline');
  assert.equal((await post(env.PAYMENTS_API_BASE + '/v1/charges', {})).status, 402);
  await assert.rejects(services.behavior('payments', 'live-provider'), /invalid_service_behavior/);
  await services.behavior('payments', 'approve');
  assert.equal((await post(env.PAYMENTS_API_BASE + '/v1/charges', {})).status, 200);
  assert.ok(services.events.some(event => event.kind === 'service_behavior' && event.behavior === 'decline'));
  await services.behavior('payments', 'decline'); await services.reset({ signal: new AbortController().signal });
  assert.equal((await post(env.PAYMENTS_API_BASE + '/v1/charges', {})).status, 200);
  assert.equal((await post(env.PAYMENTS_API_BASE + '/unsupported', {})).status, 501);
});

test('real SMTP, SMS and webhook delivery exposes full verification links only to declared readers', async t => {
  const { services, env } = await setup(t, { capture: { mail: true, sms: true, webhooks: true } });
  const text = await new Promise((resolve, reject) => {
    const socket = createConnection(Number(env.SMTP_PORT), env.SMTP_HOST); let output = '';
    socket.on('error', reject); socket.on('data', chunk => { output += chunk; }); socket.on('end', () => resolve(output));
    socket.on('connect', () => socket.write('EHLO qa\r\nMAIL FROM:<shop@example.test>\r\nRCPT TO:<shopper@example.test>\r\nDATA\r\nSubject: Verify\r\n\r\nhttps://app.example/verify?token=one-time-code\r\n..escaped\r\n.\r\nQUIT\r\n'));
  });
  assert.match(text, /250 Message captured/);
  const mail = services.read('mail', 'shopper'); assert.equal(mail.length, 1); assert.equal(mail[0].links[0], 'https://app.example/verify?token=one-time-code'); assert.match(mail[0].text, /\.escaped/);
  await new Promise((resolve, reject) => {
    const socket = createConnection(Number(env.SMTP_PORT), env.SMTP_HOST);
    socket.on('error', reject); socket.on('data', () => {}); socket.on('end', resolve);
    const encoded = Buffer.from('<a href="https://app.example/verify?token=encoded-value&amp;next=home">Verify</a>').toString('base64');
    socket.on('connect', () => socket.write(`EHLO qa\r\nMAIL FROM:<shop@example.test>\r\nRCPT TO:<shopper@example.test>\r\nDATA\r\nContent-Type: multipart/alternative; boundary="rio-boundary"\r\n\r\n--rio-boundary\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nhttps://app.example/verify?token=3Dwrapped-\r\nvalue\r\n--rio-boundary\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n--rio-boundary--\r\n.\r\nQUIT\r\n`));
  });
  assert.ok(services.read('mail', 'shopper').at(-1).links.includes('https://app.example/verify?token=encoded-value&next=home'));
  assert.throws(() => services.read('mail', 'unknown'), /invalid_persona/);
  assert.equal((await post(env.SMS_API_BASE, { to: 'shopper@example.test', text: 'https://app.example/otp?code=123' })).status, 201);
  assert.equal(services.read('sms', 'shopper')[0].links[0], 'https://app.example/otp?code=123');
  assert.equal((await post(env.WEBHOOK_URL, { event: 'paid' })).status, 202);
  assert.deepEqual(services.read('webhooks', 'capture-webhooks')[0].body, { event: 'paid' });
  await services.reset({ signal: new AbortController().signal });
  assert.deepEqual(services.read('mail', 'shopper'), []); assert.deepEqual(services.read('sms', 'shopper'), []);
});

test('OIDC discovery, signed identity, state and PKCE work without an external identity provider', async t => {
  const { services, env } = await setup(t, { services: [{ name: 'identity', kind: 'oauth-provider', env: { ISSUER: '{{issuer}}', CLIENT_ID: '{{client_id}}', CLIENT_SECRET: '{{client_secret}}' } }] });
  const discovery = await (await fetch(env.ISSUER + '/.well-known/openid-configuration')).json();
  const verifier = 'a'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(discovery.authorization_endpoint); url.search = new URLSearchParams({ client_id: env.CLIENT_ID, redirect_uri: 'http://app:4173/callback', response_type: 'code', state: 'state-value', nonce: 'nonce-value', code_challenge: challenge, code_challenge_method: 'S256' });
  const redirect = await fetch(url, { redirect: 'manual' }); assert.equal(redirect.status, 302);
  const callback = new URL(redirect.headers.get('location')); assert.equal(callback.searchParams.get('state'), 'state-value');
  const form = { client_id: env.CLIENT_ID, grant_type: 'authorization_code', redirect_uri: 'http://app:4173/callback', code: callback.searchParams.get('code'), code_verifier: verifier };
  const exchange = value => fetch(discovery.token_endpoint, { method: 'POST', body: new URLSearchParams(value) });
  assert.equal((await exchange({ ...form, code_verifier: 'wrong' })).status, 400);
  const result = await (await exchange(form)).json(); assert.ok(result.access_token);
  assert.equal((await exchange(form)).status, 400);
  const [header, claims, signature] = result.id_token.split('.'), jwks = await (await fetch(discovery.jwks_uri)).json();
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).nonce, 'nonce-value');
  assert.ok(verify('sha256', Buffer.from(header + '.' + claims), { key: createPublicKey({ key: jwks.keys[0], format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.equal((await fetch(discovery.userinfo_endpoint, { headers: { authorization: 'Bearer ' + result.access_token } })).status, 200);
  url.searchParams.set('redirect_uri', 'https://external.example/callback'); assert.equal((await fetch(url, { redirect: 'manual' })).status, 400);
  await services.reset({ signal: new AbortController().signal });
  assert.equal((await fetch(env.ISSUER + '/userinfo', { headers: { authorization: 'Bearer ' + result.access_token } })).status, 401);
});

test('S3 objects, range reads, lists and multipart uploads are isolated to the current chain', async t => {
  const { services, env } = await setup(t, { services: [{ name: 'objects', kind: 's3', env: { S3_ENDPOINT: '{{url}}', S3_BUCKET: '{{bucket}}', AWS_ACCESS_KEY_ID: '{{access_key}}', AWS_SECRET_ACCESS_KEY: '{{secret_key}}' } }] });
  const base = () => env.S3_ENDPOINT + '/' + env.S3_BUCKET;
  assert.equal((await fetch(base() + '/a.txt', { method: 'PUT', body: 'hello world' })).status, 200);
  assert.equal(await (await fetch(base() + '/a.txt', { headers: { range: 'bytes=0-4' } })).text(), 'hello');
  assert.match(await (await fetch(base() + '?list-type=2')).text(), /<Key>a.txt<\/Key>/);
  const initiated = await (await fetch(base() + '/b.txt?uploads', { method: 'POST' })).text(); const id = /<UploadId>([^<]+)<\/UploadId>/.exec(initiated)[1];
  const first = await fetch(base() + `/b.txt?uploadId=${id}&partNumber=1`, { method: 'PUT', body: 'first-' });
  const second = await fetch(base() + `/b.txt?uploadId=${id}&partNumber=2`, { method: 'PUT', body: 'second' });
  const completed = await fetch(base() + `/b.txt?uploadId=${id}`, { method: 'POST', body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${first.headers.get('etag')}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${second.headers.get('etag')}</ETag></Part></CompleteMultipartUpload>` });
  assert.equal(completed.status, 200); assert.equal(await (await fetch(base() + '/b.txt')).text(), 'first-second');
  await services.reset({ signal: new AbortController().signal });
  assert.equal((await fetch(base() + '/a.txt')).status, 404);
});

test('custom doubles retain their declared readiness contract and stop before a restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rio-custom-double-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const portFile = join(directory, 'port');
  const command = `node --input-type=module -e 'import {createServer} from "node:http";import{writeFileSync}from"node:fs";const s=createServer((q,r)=>r.end("ok"));s.listen(0,"127.0.0.1",()=>writeFileSync(${JSON.stringify(portFile)},String(s.address().port)))'`;
  const { services } = await setup(t, { services: [{ name: 'custom', kind: 'custom', start: command, ready: `test -s ${JSON.stringify(portFile)}`, env: {} }] });
  const port = (await readFile(portFile)).toString(); assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'ok');
  await services.stop(); await assert.rejects(fetch('http://127.0.0.1:' + port));
});

test('claimed HTTPS hosts route through the supplied run certificate and unknown hosts are refused', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rio-fixture-tls-')); t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key'), '-out', join(directory, 'cert'), '-days', '1', '-subj', '/CN=payments.example.test', '-addext', 'subjectAltName=DNS:payments.example.test'], { stdio: 'ignore' });
  const tls = { key: await readFile(join(directory, 'key')), cert: await readFile(join(directory, 'cert')) };
  const { services, env } = await setup(t, { services: [{ ...payments, claims: ['payments.example.test'] }] }, { tls, ports: { claims_http: 0, claims_https: 0 } });
  assert.equal(env.PAYMENTS_API_BASE, 'https://payments.example.test');
  const port = services.claimServers[1].address().port;
  const call = host => new Promise((resolve, reject) => {
    const request = httpsRequest({ host: '127.0.0.1', port, servername: 'payments.example.test', ca: tls.cert, path: '/v1/charges', method: 'POST', headers: { host } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject); request.end('{}');
  });
  assert.equal(await call('payments.example.test'), 200); assert.equal(await call('unclaimed.example.test'), 421);
  assert.throws(() => new FixtureServices({ root, fixtures: { services: [{ ...payments, claims: ['controller'] }] } }), /invalid_host_claim/);
});


test('a client refusing the run CA records the claimed host as tls_pinned', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rio-fixture-pinned-')); t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key'), '-out', join(directory, 'cert'), '-days', '1', '-subj', '/CN=payments.example.test', '-addext', 'subjectAltName=DNS:payments.example.test'], { stdio: 'ignore' });
  const tls = { key: await readFile(join(directory, 'key')), cert: await readFile(join(directory, 'cert')) };
  const { services } = await setup(t, { services: [{ ...payments, claims: ['payments.example.test'] }] }, { tls, ports: { claims_http: 0, claims_https: 0 } });
  const port = services.claimServers[1].address().port;
  const code = `import socket,ssl
context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
try:
 with socket.create_connection(('127.0.0.1',${port})) as sock:
  with context.wrap_socket(sock,server_hostname='payments.example.test'):
   raise RuntimeError('Untrusted run CA accepted')
except ssl.SSLCertVerificationError:
 print('rejected')
`;
  const result = await promisify(execFile)('python3', ['-c', code]);
  assert.equal(result.stdout.trim(), 'rejected');
  for (let tries = 0; tries < 20 && !services.events.some(event => event.kind === 'tls_pinned'); tries++) await delay(10);
  assert.ok(services.events.some(event => event.kind === 'tls_pinned' && event.host === 'payments.example.test'));
});
