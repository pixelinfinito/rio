import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { contextEnvironment } from './context.mjs';

export class StartupFailure extends Error {
  constructor(reason, stage, details = {}) { super(`${reason}: ${stage}`); this.reason = reason; this.stage = stage; this.details = details; }
}
export function durationMs(value, fallback = 120000) {
  if (value === undefined || value === null) return fallback;
  if (Number.isSafeInteger(value) && value > 0) return value;
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  const result = match && Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]);
  if (!Number.isSafeInteger(result) || result <= 0) throw new StartupFailure('invalid_contract', 'timeout');
  return result;
}
export function redactStageOutput(value, secrets = []) {
  let text = String(value);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b((?:authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/([?&](?:[^=&\s]*(?:token|secret|password|api_key|code))=)[^&\s"']+/gi, '$1[redacted]');
}

/** A bounded process group owned by the app container. Repository commands must
 * only reach this class through the app entry point, never the runner host. */
export class AppProcesses {
  constructor({ cwd, env = {}, secrets = [], record = async () => {}, outputLimit = 16384 }) {
    this.cwd = cwd; this.env = env; this.secrets = secrets; this.record = record; this.outputLimit = outputLimit;
    this.children = new Set();
  }
  async executable(name) {
    for (const path of (this.env.PATH || '').split(delimiter)) {
      if (!path) continue;
      try { const file = join(path, name); await access(file, constants.X_OK); return file; } catch {}
    }
    throw new StartupFailure('missing_tool', name);
  }
  start(command, { stage, env = {}, input } = {}) {
    const argv = Array.isArray(command) ? command : ['/bin/sh', '-c', command];
    const child = spawn(argv[0], argv.slice(1), { cwd: this.cwd, env: { ...this.env, ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const process = { child, stage, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, settled: false, exitCode: null };
    this.children.add(process);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      const available = this.outputLimit + Math.max(0, ...this.secrets.map(secret => Buffer.byteLength(secret))) - process[stream].length;
      process[stream] = Buffer.concat([process[stream], chunk.subarray(0, Math.max(0, available))]);
      process.truncated ||= chunk.length > available;
    });
    process.done = new Promise(resolve => {
      child.on('error', () => { process.settled = true; process.exitCode = 127; resolve(127); });
      child.on('exit', code => { process.settled = true; process.exitCode = code; });
      child.on('close', code => resolve(code));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    return process;
  }
  async evidence(process) {
    await this.record({ kind: 'stage_output', stage: process.stage, exit_code: process.exitCode,
      stdout: redactStageOutput(process.stdout.toString('utf8'), this.secrets).slice(0, this.outputLimit),
      stderr: redactStageOutput(process.stderr.toString('utf8'), this.secrets).slice(0, this.outputLimit), truncated: process.truncated });
  }
  async stop(process) {
    if (!process || !this.children.has(process)) return;
    const signal = name => { try { globalThis.process.kill(-process.child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    if (process.child.pid) {
      signal('SIGTERM');
      // A shell may already have exited while descendants still own its group.
      await Promise.race([process.done, delay(250)]);
      signal('SIGKILL');
    }
    await process.done;
    await this.evidence(process);
    this.children.delete(process);
  }
  async run(command, { stage, reason, timeoutMs = 120000, signal, env, input } = {}) {
    signal?.throwIfAborted();
    const process = this.start(command, { stage, env, input });
    let timer, abort;
    try {
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new StartupFailure(reason, stage, { timeout: true })), timeoutMs);
        abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
      });
      const code = await Promise.race([process.done, expired]);
      if (code !== 0) throw new StartupFailure(reason, stage, { exit_code: code });
      return { stdout: process.stdout, stderr: process.stderr, truncated: process.truncated };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await this.stop(process);
    }
  }
  async close() { for (const process of [...this.children].reverse()) await this.stop(process); }
}

async function contained(root, path) {
  const base = await realpath(root), resolved = await realpath(resolve(root, path));
  const rel = relative(base, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new StartupFailure('invalid_contract', 'app.workdir');
  return resolved;
}

/** The seed and service implementations are supplied by the in-app adapters.
 * The controller cannot send shell commands through this interface. */
export class ApplicationRuntime {
  constructor({ root, contract, seed, services, credentials = {}, context = {}, record = async () => {}, commandTimeoutMs = 120000 }) {
    this.root = root; this.contract = contract; this.seed = seed; this.services = services;
    this.credentials = credentials; this.record = record; this.commandTimeoutMs = commandTimeoutMs;
    this.started = false; this.app = undefined;
    this.context = context;
  }
  async prepare() {
    const app = this.contract.app;
    if (app.packaging === 'compose' || /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/i.test(app.dockerfile || '')) {
      throw new StartupFailure('unsupported_topology', 'app', { hint: 'Provision dependencies in Dockerfile.qa.' });
    }
    const cwd = await contained(this.root, app.workdir || '.');
    // Provider credentials and host process environment are never inherited by
    // app commands. Persona values are injected only into their apply commands.
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { CI: 'true', CARGO_NET_OFFLINE: 'true', PIP_NO_INDEX: 'true', npm_config_offline: 'true' }, app.env || {});
    Object.assign(env, contextEnvironment(this.context));
    this.processes = new AppProcesses({ cwd, env, secrets: Object.values(this.credentials), record: this.record });
    await this.seed.prepare?.({ processes: this.processes, root: this.root });
  }
  async stage(name, reason, operation) {
    await this.record({ kind: 'stage', stage: name, state: 'started' });
    try {
      const result = await operation();
      await this.record({ kind: 'stage', stage: name, state: 'ready' });
      return result;
    } catch (error) {
      await this.record({ kind: 'stage', stage: name, state: 'failed', reason: error instanceof StartupFailure ? error.reason : reason });
      if (error instanceof StartupFailure || this.signal?.aborted) throw error;
      throw new StartupFailure(reason, name);
    }
  }
  async applyCredentials() {
    this.processes.secrets = [...new Set([...this.processes.secrets, ...Object.values(this.credentials)])];
    this.missingPersonas = this.contract.personas.filter(persona => [persona.username_env, persona.password_env].filter(Boolean).some(name => !this.credentials[name])).map(persona => persona.name);
    for (const user of this.seed.users || []) {
      const persona = this.contract.personas.find(persona => persona.name === user.persona);
      if (!persona) throw new StartupFailure('seed_failed', 'credentials', { persona: user.persona });
      const names = [persona.username_env, persona.password_env].filter(Boolean);
      if (this.missingPersonas.includes(persona.name)) continue;
      await this.processes.run(user.apply, { stage: `credentials:${persona.name}`, reason: 'seed_failed',
        timeoutMs: this.commandTimeoutMs, signal: this.signal, env: Object.fromEntries(names.map(name => [name, this.credentials[name]])) });
    }
  }
  async startApp() {
    const app = this.contract.app;
    let command = app.start;
    if (app.packaging === 'static') {
      let directory;
      try { directory = await contained(this.root, app.directory); }
      catch (error) {
        if (error.code === 'ENOENT') throw new StartupFailure('dependencies_unavailable', 'app.directory', { hint: 'Supply built static files, vendor dependencies, or use Dockerfile.qa with the Docker runner.' });
        throw error;
      }
      const url = new URL(app.url);
      command = [process.execPath, fileURLToPath(new URL('./static-server.mjs', import.meta.url)), directory, url.port || '80'];
    }
    if (!command) throw new StartupFailure('app_not_ready', 'app.start', { hint: 'The image entry point must resolve an application start command.' });
    this.app = this.processes.start(command, { stage: 'app' });
    const deadline = Date.now() + durationMs(app.ready.timeout);
    const base = new URL(app.url);
    // Readiness runs inside app, not against a similarly named host service.
    base.hostname = '127.0.0.1'; base.pathname = app.ready.path; base.search = ''; base.hash = '';
    while (Date.now() < deadline) {
      this.signal?.throwIfAborted();
      if (this.app.settled) {
        await this.app.done;
        const diagnostics = this.app.stderr.toString('utf8');
        const reason = this.app.exitCode === 127 ? 'missing_tool'
          : app.packaging === 'vendored' && /(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ModuleNotFoundError|ImportError: No module named)/.test(diagnostics)
            ? 'dependencies_unavailable' : 'app_not_ready';
        throw new StartupFailure(reason, 'app', { exited: true,
          ...(reason === 'dependencies_unavailable' ? { hint: 'Supply built static files, vendor dependencies, or use Dockerfile.qa with the Docker runner.' } : {}) });
      }
      try {
        const signals = [AbortSignal.timeout(Math.max(1, Math.min(500, deadline - Date.now())))];
        if (this.signal) signals.push(this.signal);
        const response = await fetch(base, { signal: AbortSignal.any(signals), redirect: 'manual' });
        await response.body?.cancel();
        if (response.status === app.ready.status) return;
      } catch {}
      await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal: this.signal });
    }
    throw new StartupFailure('app_not_ready', 'app', { timeout: true });
  }
  async start({ signal } = {}) {
    if (this.started) throw new StartupFailure('invalid_state', 'startup');
    this.signal = signal;
    try {
      await this.prepare();
      await this.stage('datastores', 'datastore_not_ready', () => this.seed.start({ signal, timeoutMs: this.commandTimeoutMs }));
      await this.stage('seed', 'seed_failed', () => this.seed.restoreOrBuild({ signal }));
      await this.stage('credentials', 'seed_failed', () => this.applyCredentials());
      await this.stage('services', 'service_not_ready', () => this.services.start({ processes: this.processes, signal }));
      await this.stage('app', 'app_not_ready', () => this.startApp());
      if (this.contract.app.seed) await this.stage('app.seed', 'seed_failed', () => this.processes.run(this.contract.app.seed, { stage: 'app.seed', reason: 'seed_failed', timeoutMs: this.commandTimeoutMs, signal }));
      this.started = true;
      return { outcome: 'ready', missing_personas: this.missingPersonas };
    } catch (error) { await this.stop(); throw error; }
  }
  async reset({ signal, context = this.context } = {}) {
    if (!this.started) throw new StartupFailure('invalid_state', 'reset');
    const contextEnv = contextEnvironment(context);
    this.signal = signal;
    try {
      await this.processes.stop(this.app); this.app = undefined;
      this.context = context;
      delete this.processes.env.QA_FAKE_TIME;
      Object.assign(this.processes.env, contextEnv);
      await this.stage('seed', 'seed_failed', () => this.seed.restoreOrBuild({ signal }));
      await this.stage('credentials', 'seed_failed', () => this.applyCredentials());
      await this.services.reset({ signal });
      await this.stage('app', 'app_not_ready', () => this.startApp());
      if (this.contract.app.seed) await this.processes.run(this.contract.app.seed, { stage: 'app.seed', reason: 'seed_failed', timeoutMs: this.commandTimeoutMs, signal });
      return { outcome: 'ready', missing_personas: this.missingPersonas };
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    try { await this.services.stop?.(); }
    finally { try { await this.seed.stop?.(); } finally { await this.processes?.close(); this.started = false; } }
  }
}
