// Host-only entry point. Configuration (including the keychain value) arrives
// once over an inherited pipe, never through argv, environment or a disk file.
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { ModelProxy } from './model-proxy.mjs';
import { providerTransport } from './provider-transport.mjs';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let proxy;
const stop = async () => { await proxy?.close(); lines.close(); process.stdin.destroy(); };
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
try {
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.length > 1024 * 1024) throw new Error('Invalid relay configuration');
  const config = JSON.parse(first.value);
  if (!config.key || !config.socket || !config.run_id || !config.model || !config.provider_model) throw new Error('Missing relay configuration');
  if (config.authentication != null && !['provider', 'ai_gateway'].includes(config.authentication)) throw new Error('Invalid authentication');
  const headers = config.authentication === 'ai_gateway'
    ? { 'cf-aig-authorization': `Bearer ${config.key}`, 'cf-aig-skip-cache': 'true', 'cf-aig-collect-log': 'false',
      ...(config.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) }
    : config.protocol === 'anthropic' ? { 'x-api-key': config.key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${config.key}` };
  // The endpoint names the provider; a local route's model is a free alias.
  const host = new URL(config.url).hostname, gateway = config.authentication === 'ai_gateway';
  const via = name => host === `api.${name}.com` || gateway && new URL(config.url).pathname.includes(`/${name}/`);
  // Cache counts are trusted only from Anthropic and OpenAI's own API (D10).
  const openai = config.protocol === 'openai' && via('openai');
  const convention = config.protocol === 'anthropic' || openai ? 'verified' : 'unverified';
  // Hints only for configured classes on routes known to honor them (D9, D16).
  // The relay serves one run and sees no cell, so the key is per local run.
  const classes = new Set(Array.isArray(config.prompt_cache) ? config.prompt_cache : []);
  const capability = config.protocol === 'anthropic' ? classes.has('anthropic') && via('anthropic') ? 'breakpoints' : 'none'
    : openai && classes.has('openai') ? 'key'
    : classes.has('openrouter') && (host === 'openrouter.ai' || gateway && new URL(config.url).pathname.includes('/openrouter/')) && /^(anthropic|google)\//.test(config.provider_model) ? 'parts' : 'none';
  const cache = { capability, ...(capability === 'key' ? { key: createHash('sha256').update(`rio-pck\0local\0${config.run_id}\0qa`).digest('hex').slice(0, 32) } : {}) };
  proxy = new ModelProxy({ model: config.model, forward: providerTransport({ url: config.url, headers, model: config.provider_model, protocol: config.protocol, convention, cache }),
    record: async entry => { process.stdout.write(JSON.stringify({ kind: 'usage', ...entry }) + '\n'); } });
  proxy.startCell({ run: config.run_id }, config.tokens);
  await proxy.listen({ socketPath: config.socket });
  // Only this socket is mounted. The host's containing directory stays 0700;
  // capability auth also protects the socket across Docker uid mappings.
  await chmod(config.socket, 0o666);
  process.stdout.write(JSON.stringify({ kind: 'ready', token: proxy.token }) + '\n');
  for await (const line of iterator) { if (line === 'stop') break; }
  await stop();
} catch {
  process.stderr.write('QA host model relay failed\n'); await stop(); process.exitCode = 1;
}
