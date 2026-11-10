import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { ApplicationRuntime, StartupFailure } from './app-runtime.mjs';
import { SeedRuntime, seedSizeBytes } from './seed-runtime.mjs';
import { AppSeedTransfer } from './seed-transfer.mjs';
import { FixtureServices } from './fixture-services.mjs';
import { FixtureFiles, fixtureSeedManifest } from './fixture-files.mjs';
import { pipeline } from 'node:stream/promises';
import { tcpRelay } from './tcp-relay.mjs';

// This file is injected by Rio into app and is never run by the host runner.
if (process.env.RIO_QA_CONTAINER !== 'app') throw new Error('QA app entry point requires the app container');
const document = JSON.parse(await readFile('/opt/rio-qa-app/runtime.json', 'utf8'));
const failureDetails = error => ({
  ...(typeof error.details?.largest_archive === 'string' && /^[a-z][a-z0-9-]*$/.test(error.details.largest_archive) ? { largest_archive: error.details.largest_archive } : {}),
  ...Object.fromEntries(['bytes', 'max_bytes'].filter(key => Number.isSafeInteger(error.details?.[key]) && error.details[key] >= 0).map(key => [key, error.details[key]])),
});
let credentials = {};
try { credentials = JSON.parse(await readFile('/opt/rio-qa-app/credentials.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const stop = new AbortController();
let busy = false, ready = false, closing = false, runtime, api, applicationRelay;
let recordBytes = 0, seedOutcome, startupFailure;
const record = async event => {
  if (event.kind === 'seed' && ['built', 'restored'].includes(event.action)) seedOutcome = { status: event.action, fingerprint: event.fingerprint, duration_ms: event.duration_ms };
  const line = JSON.stringify(event) + '\n';
  if (recordBytes + Buffer.byteLength(line) <= 1024 * 1024) {
    recordBytes += Buffer.byteLength(line);
    await appendFile('/tmp/rio-qa-stages.jsonl', line, { mode: 0o600 });
  }
};
const fixtureTls = document.fixture_tls ? { key: await readFile('/opt/rio-qa-app/tls-key.pem'), cert: await readFile('/opt/rio-qa-app/tls-cert.pem') } : undefined;
const services = new FixtureServices({ root: '/work/repo', fixtures: document.fixtures, credentials, personas: document.contract.personas,
  appOrigins: [new URL(document.contract.app.url).origin], host: '0.0.0.0', advertisedHost: 'app.test', ports: document.service_ports || {}, tls: fixtureTls, dns: true, record, timeoutMs: document.stage_timeout_ms || 120000 });
const shutdown = async () => {
  if (closing) return; closing = true;
  stop.abort(new StartupFailure('interrupted', 'app'));
  api?.close(); await applicationRelay?.close(); await runtime?.stop();
};
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void shutdown(); });
try {
  if (document.app_forward_port) applicationRelay = await tcpRelay({ host: '0.0.0.0', port: document.app_forward_port, targetHost: '127.0.0.1', targetPort: Number(new URL(document.contract.app.url).port || 80) });
  const manifest = fixtureSeedManifest(document.seed || { datastores: [], steps: [], users: [], paths: [] }, document.fixtures);
  const maxSize = seedSizeBytes(document.contract.seed?.max_size);
  const fixtureFiles = new FixtureFiles({ root: '/work/repo', files: document.fixtures?.files, maxSize });
  const transfer = document.seed_transfer ? new AppSeedTransfer({
    names: [...manifest.datastores.map(store => store.name), ...(manifest.paths || []).map((_, index) => `path-${index}`)],
    maxSize, timeoutMs: document.stage_timeout_ms || 120000,
  }) : undefined;
  runtime = new ApplicationRuntime({ root: '/work/repo', contract: document.contract,
    seed: new SeedRuntime({ manifest, manifestPath: document.contract.seed?.manifest, fingerprint: document.seed_fingerprint,
      store: transfer, maxSize, fixtureFiles, fallbackRebuild: document.contract.seed?.fallback_rebuild === true }),
    services, credentials, record, context: document.fixtures?.defaults || {}, commandTimeoutMs: document.stage_timeout_ms || 120000 });
  api = createServer(async (request, response) => {
    const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (transfer && await transfer.handle(request, response)) return;
    if (request.method === 'GET' && request.url === '/status') return reply(ready ? 200 : 503, { ready, failure: startupFailure, missing_personas: runtime.missingPersonas, seed: seedOutcome });
    if (request.method === 'GET' && request.url === '/fixtures/status') return reply(ready ? 200 : 503, { services: services.status() });
    if (request.method === 'GET' && request.url === '/fixtures/events') return reply(200, { events: services.events });
    if (request.method === 'GET' && /^\/fixtures\/files\/[a-z][a-z0-9-]*$/.test(request.url)) {
      if (!ready || busy) return reply(409, { error: 'busy' });
      let file;
      try {
        file = await fixtureFiles.open(request.url.split('/').at(-1));
        response.writeHead(200, { 'content-type': file.mimeType, 'content-length': file.bytes, 'x-rio-fixture-filename': encodeURIComponent(file.filename) });
        await pipeline(file.handle.createReadStream({ autoClose: false }), response);
      } catch { if (!response.headersSent) reply(400, { error: 'invalid_fixture_file' }); else response.destroy(); }
      finally { await file?.handle.close(); }
      return;
    }
    if (request.method === 'POST' && ['/fixtures/read', '/fixtures/behavior'].includes(request.url)) {
      if (!ready || busy) return reply(409, { error: 'busy' });
      try {
        let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 16384) throw new Error('oversized request'); }
        const value = JSON.parse(body);
        if (request.url === '/fixtures/behavior') {
          if (Object.keys(value).some(key => !['service', 'behavior'].includes(key))) throw new Error('invalid behavior');
          return reply(200, await services.behavior(value.service, value.behavior));
        }
        if (Object.keys(value).some(key => !['kind', 'name'].includes(key)) || !['mail', 'sms', 'webhooks'].includes(value.kind)) throw new Error('invalid capture');
        return reply(200, { messages: services.read(value.kind, value.name) });
      } catch (error) { return reply(400, { error: error.reason || 'invalid_fixture_operation' }); }
    }
    if (request.method !== 'POST' || request.url !== '/reset') return reply(404, { error: 'unknown_operation' });
    if (busy || !ready) return reply(409, { error: 'busy' });
    busy = true; ready = false;
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 16384) throw new StartupFailure('invalid_context', 'reset'); }
      const options = body ? JSON.parse(body) : {};
      if (Object.keys(options).some(key => key !== 'context')) throw new StartupFailure('invalid_context', 'reset');
      await runtime.reset({ signal: stop.signal, context: options.context }); ready = true; reply(200, { ready, missing_personas: runtime.missingPersonas, seed: seedOutcome });
    }
    catch (error) { reply(500, { reason: error.reason || 'seed_failed', stage: error.stage || 'reset', ...failureDetails(error) }); }
    finally { busy = false; }
  });
  api.on('error', async () => {
    ready = false;
    await writeFile('/tmp/rio-qa-startup.json', JSON.stringify({ outcome: 'failed', reason: 'app_not_ready', stage: 'controller-hooks' }), { mode: 0o600 });
    await shutdown(); process.exitCode = 1;
  });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(Number(process.env.RIO_QA_CONTROL_PORT || 9224), '0.0.0.0', () => { api.removeListener('error', reject); resolve(); });
  });
  const result = await runtime.start({ signal: stop.signal }); ready = true;
  await writeFile('/tmp/rio-qa-startup.json', JSON.stringify(result), { mode: 0o600 });
} catch (error) {
  startupFailure = { outcome: 'failed', reason: error.reason || 'app_not_ready', stage: error.stage || 'startup', image: document.image, ...failureDetails(error) };
  await writeFile('/tmp/rio-qa-startup.json', JSON.stringify(startupFailure), { mode: 0o600 });
  // Stop repository processes but retain the controller-only diagnostic API.
  // Init needs blocked hosts even when they prevented application readiness.
  await runtime?.stop();
  if (!api?.listening) { await shutdown(); process.exitCode = 1; }
}
