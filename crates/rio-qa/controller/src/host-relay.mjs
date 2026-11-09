// Host-only entry point. Configuration (including the keychain value) arrives
// once over an inherited pipe, never through argv, environment or a disk file.
import { createInterface } from 'node:readline';
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
  proxy = new ModelProxy({ model: config.model, forward: providerTransport({ url: config.url, headers, model: config.provider_model, protocol: config.protocol }),
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
