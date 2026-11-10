import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { browserFiles } from './browser-files.mjs';
import { tcpRelay } from './tcp-relay.mjs';

const env = globalThis.process.env;
const files = await browserFiles({ port: Number(env.RIO_QA_BROWSER_FILES_PORT || 9226), maxBytes: Number(env.RIO_QA_FIXTURE_MAX_BYTES || 2 * 1024 ** 3) });
const debugPort = Number(env.RIO_QA_DEBUG_PORT || 9222), cdpPort = Number(env.RIO_QA_CDP_PORT || 9223);
const application = env.RIO_QA_APP_FORWARD_FROM ? await tcpRelay({ port: Number(env.RIO_QA_APP_FORWARD_FROM), targetHost: 'app', targetPort: Number(env.RIO_QA_APP_FORWARD_TO) }) : undefined;

// Chromium's debug listener stays on loopback. A trusted TCP relay exposes CDP
// only inside the pod; the host firewall admits controller -> browser:9223.
const spki = globalThis.process.env.RIO_QA_FIXTURE_SPKI;
if (spki && !/^[A-Za-z0-9+/]{43}=$/.test(spki)) throw new Error('Invalid fixture certificate pin');
const process = spawn(chromium.executablePath(), [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--disable-background-networking', '--disable-component-update',
  ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
  `--remote-debugging-port=${debugPort}`, '--user-data-dir=/tmp/rio-chromium', 'about:blank',
], { stdio: 'ignore' });
const server = await tcpRelay({ host: '0.0.0.0', port: cdpPort, targetHost: '127.0.0.1', targetPort: debugPort });
const close = async () => { await server.close(); await files.close(); await application?.close(); };
process.on('error', () => { void close(); globalThis.process.exitCode = 1; });
process.on('exit', code => { void close(); globalThis.process.exitCode = code || 0; });
for (const signal of ['SIGTERM', 'SIGINT']) globalThis.process.on(signal, () => { void close(); process.kill('SIGTERM'); });
