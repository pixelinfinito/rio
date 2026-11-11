import { constants } from 'node:fs';
import { open, writeFile, rename } from 'node:fs/promises';
import { runQa } from './controller.mjs';
import { runReplay } from './replay-backend.mjs';
import { runAuthor } from './author.mjs';
import { runSetupAuthor } from './setup-author.mjs';
import { Sanitizer } from './sanitize.mjs';
import { EvidenceWriter, LocalEvidenceSink, HostedEvidenceSink } from './evidence.mjs';
import { LocalSeedBackend, HostedSeedBackend, SeedStore } from './seed-store.mjs';
import { HostedSeedTransport } from './hosted-seed-transport.mjs';
import { HostedEvidenceTransport } from './hosted-evidence-transport.mjs';
import { SeedTransferClient } from './seed-transfer.mjs';
import { fixtureSeedManifest } from './fixture-files.mjs';
import { seedSizeBytes } from './seed-runtime.mjs';
import { gatewayTransport, localTransport } from './model-proxy.mjs';

if (process.env.RIO_QA_CONTAINER !== 'controller') throw new Error('QA controller requires its dedicated container');
const read = async name => {
  const handle = await open(`/home/node/${name}.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 16 * 1024 ** 2) throw new Error('Invalid controller input'); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
};
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => abort.abort('interrupted'));
let last, sanitizer = new Sanitizer();
const checkpoint = async value => {
  last = sanitizer.value(value);
  await writeFile('/home/node/qa-result.pending', JSON.stringify(last), { mode: 0o600 });
  await rename('/home/node/qa-result.pending', '/home/node/qa-result.json');
};
try {
  const [run, contract, journeys, fixtures, guidance, plan, credentialEnv] = await Promise.all(['run', 'contract', 'journeys', 'fixtures', 'owner-guidance', 'plan', 'credentials'].map(read));
  if (run.version !== 1 || !['local', 'hosted'].includes(run.storage?.kind) || !['codex', 'pi'].includes(run.harness) || !['gateway', 'subscription'].includes(run.auth)
    || Object.values(run.budget || {}).some(value => !Number.isSafeInteger(value) || value < 1)
    || !['wall_ms', 'cell_wall_ms', 'tokens', 'evidence_bytes'].every(key => Number.isSafeInteger(run.budget?.[key]) && run.budget[key] > 0)) throw new Error('Invalid controller configuration');
  if (run.auth === 'subscription' && (run.storage.kind !== 'local' || run.harness !== 'codex' || !process.env.RIO_QA_SUBSCRIPTION_FILE)) throw new Error('Invalid subscription configuration');
  // The review's layout features and, on hosted runs only, the partition value.
  const prompt = run.prompt ?? {};
  if (typeof prompt !== 'object' || Array.isArray(prompt) || Object.keys(prompt).some(key => !['layout', 'partition'].includes(key))
    || (prompt.layout !== undefined && (!Array.isArray(prompt.layout) || prompt.layout.some(value => typeof value !== 'string')))
    || (prompt.partition !== undefined && (run.storage.kind !== 'hosted' || !/^[0-9a-f]{32}$/.test(prompt.partition)))) throw new Error('Invalid controller configuration');
  sanitizer = new Sanitizer([run.storage.capability, run.gateway?.capability, run.relay_token, prompt.partition]);
  const maxSize = seedSizeBytes(contract.seed?.max_size);
  const manifest = fixtureSeedManifest(run.seed || { datastores: [], steps: [], users: [], paths: [] }, fixtures);
  let sink, seedBackend, forward;
  if (run.storage.kind === 'hosted') {
    const common = { sandboxGateway: run.sandbox_gateway === true, endpoint: run.storage.endpoint, tenant: run.storage.tenant, capability: run.storage.capability };
    const evidence = new HostedEvidenceTransport({ ...common, reviewId: run.review_id, runId: run.run_id });
    sink = new HostedEvidenceSink({ tenant: run.storage.tenant, reviewId: run.review_id, runId: run.run_id, upload: (...args) => evidence.upload(...args) });
    seedBackend = new HostedSeedBackend({ tenant: run.storage.tenant, transport: new HostedSeedTransport({ ...common, maxSize }) });
  } else {
    sink = await LocalEvidenceSink.create({ cacheRoot: '/home/node/qa-evidence', reviewId: run.review_id, runId: run.run_id });
    seedBackend = await LocalSeedBackend.create('/home/node/qa-seeds');
  }
  if (run.auth === 'gateway' && !run.replay && !run.seed_build) forward = process.env.RIO_QA_MODEL_SOCKET
    ? localTransport({ socketPath: process.env.RIO_QA_MODEL_SOCKET, token: run.relay_token })
    : gatewayTransport({ sandboxGateway: run.sandbox_gateway === true, baseUrl: run.gateway.url, token: run.gateway.capability, runId: run.run_id });
  const writer = new EvidenceWriter({ sink, sanitizer, maxBytes: run.budget.evidence_bytes });
  const store = new SeedStore({ backend: seedBackend, maxSize, kinds: Object.fromEntries(manifest.datastores.map(store => [store.name, store.kind])) });
  const seedTransfer = new SeedTransferClient({ baseURL: process.env.RIO_QA_APP_CONTROL, store, fingerprint: run.seed_fingerprint,
    requireExisting: !!run.replay, forceRebuild: run.seed_build === true && run.seed_force === true,
    names: [...manifest.datastores.map(store => store.name), ...manifest.paths.map((_, index) => `path-${index}`)] });
  if (run.seed_build && (run.replay || run.author || run.setup || plan.chains.length || run.storage.kind !== 'local')) throw new Error('Invalid seed-only run');
  if (run.setup && (run.replay || run.author || plan.chains.length || run.storage.kind !== 'local')) throw new Error('Invalid setup run');
  const execute = run.setup ? runSetupAuthor : run.replay ? runReplay : run.author ? runAuthor : runQa;
  const result = await execute({ setup: run.setup, request: run.replay, author: run.author, plan, journeys, contract, fixtures, guidance, viewports: run.viewports, writer, seedTransfer,
    appControl: process.env.RIO_QA_APP_CONTROL, browserEndpoint: process.env.RIO_QA_BROWSER, browserFiles: process.env.RIO_QA_BROWSER_FILES,
    version: run.snapshot_version || 'head', budget: run.budget, model: run.model, harness: run.harness, auth: run.auth, authFile: process.env.RIO_QA_SUBSCRIPTION_FILE,
    forward, credentialEnv, maxFileBytes: maxSize, checkpoint, prompt, signal: abort.signal });
  process.stdout.write(JSON.stringify({ outcome: result.outcome, journeys: result.journey_outcomes.length }) + '\n');
} catch {
  await checkpoint({ ...(last || { journey_outcomes: [] }), outcome: 'partial', controller_error: abort.signal.aborted ? 'interrupted' : 'controller_failed' }).catch(() => {});
  process.stderr.write('QA controller failed; retained checkpoints contain sanitized partial results.\n'); process.exitCode = 1;
}
