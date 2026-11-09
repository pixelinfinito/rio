import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createServer as smtpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { StartupFailure, redactStageOutput } from './app-runtime.mjs';
import { OAuthDouble, S3Double } from './fixture-providers.mjs';

const fail = (service, reason = 'service_not_ready') => { throw new StartupFailure(reason, service); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const links = text => [...new Set((String(text).match(/https?:\/\/[^\s<>"']+/g) || []).map(value => value.replaceAll('&amp;', '&').replaceAll('&#38;', '&')))];
function mailText(message, depth = 0) {
  if (depth > 8) return '';
  const split = message.indexOf('\n\n'); if (split < 0) return message;
  const headers = Object.fromEntries(message.slice(0, split).replace(/\n[ \t]+/g, ' ').split('\n').flatMap(line => {
    const at = line.indexOf(':'); return at < 0 ? [] : [[line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]];
  }));
  const type = headers['content-type'] || 'text/plain', content = message.slice(split + 2);
  if (/^attachment/i.test(headers['content-disposition'] || '')) return '';
  if (/^multipart\//i.test(type)) {
    const boundary = /boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(type);
    if (!boundary) return '';
    const marker = '--' + (boundary[1] || boundary[2]); let part = [], parts = [], active = false;
    for (const line of content.split('\n')) {
      if (line === marker || line === marker + '--') {
        if (active) parts.push(mailText(part.join('\n'), depth + 1));
        part = []; active = line === marker;
      } else if (active) part.push(line);
    }
    return parts.join('\n');
  }
  if (!/^text\/(?:plain|html)(?:;|$)/i.test(type)) return '';
  let bytes;
  if (/^base64$/i.test(headers['content-transfer-encoding'] || '')) bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
  else if (/^quoted-printable$/i.test(headers['content-transfer-encoding'] || '')) {
    const source = content.replace(/=\n/g, ''), chunks = []; let start = 0;
    for (const match of source.matchAll(/=([a-f0-9]{2})/gi)) { chunks.push(Buffer.from(source.slice(start, match.index)), Buffer.from([parseInt(match[1], 16)])); start = match.index + 3; }
    chunks.push(Buffer.from(source.slice(start))); bytes = Buffer.concat(chunks);
  } else bytes = Buffer.from(content);
  const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1] || 'utf-8';
  let text; try { text = new TextDecoder(charset).decode(bytes); } catch { text = bytes.toString('utf8'); }
  return (headers.subject ? `Subject: ${headers.subject}\n\n` : '') + text;
}
const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
async function body(request, limit = 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw new Error('Fixture request exceeds size limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function contained(root, path) {
  const base = await realpath(root), target = await realpath(resolve(base, path)), rel = relative(base, target);
  if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) fail('recordings', 'invalid_contract');
  return target;
}
async function recordings(root, directory, service) {
  const path = await contained(root, directory), result = [];
  for (const file of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.name.endsWith('.json')) continue;
    if (!file.isFile()) fail(service.name, 'invalid_contract');
    const data = await readFile(await contained(root, resolve(path, file.name)));
    if (data.length > 1024 * 1024) fail(service.name, 'invalid_contract');
    const entries = JSON.parse(data);
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (!object(entry) || !object(entry.request) || !object(entry.response) || typeof entry.request.path !== 'string' || !entry.request.path.startsWith('/') || !/^[A-Z]+$/.test(entry.request.method) || !Number.isInteger(entry.response.status) || entry.response.status < 200 || entry.response.status > 599 || entry.behavior && !service.behaviors.includes(entry.behavior)) fail(service.name, 'invalid_contract');
      if (entry.request.headers && !object(entry.request.headers) || entry.request.query && !object(entry.request.query) || entry.response.headers && !object(entry.response.headers)) fail(service.name, 'invalid_contract');
      result.push(entry);
    }
  }
  if (!result.length) fail(service.name, 'invalid_contract');
  return result;
}
const matches = (expected, actual) => {
  if (expected === undefined) return true;
  if (object(expected)) return object(actual) && Object.entries(expected).every(([key, value]) => matches(value, actual[key]));
  return JSON.stringify(expected) === JSON.stringify(actual);
};
async function listen(server, port, host) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
  return server.address().port;
}
async function close(server) {
  if (!server) return;
  server.closeAllConnections?.();
  for (const socket of server.rioSockets || []) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
function ownSockets(server) {
  const sockets = server.rioSockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return server;
}

/** Runs only in app. Captured bodies remain private in memory until the
 * controller requests them; durable evidence is sanitized by EvidenceWriter. */
export class FixtureServices {
  constructor({ root, fixtures = {}, credentials = {}, personas = [], appOrigins = [], host = '127.0.0.1', advertisedHost = '127.0.0.1', ports = {}, tls, dns = false, record = async () => {}, timeoutMs = 120000 }) {
    Object.assign(this, { root, fixtures, credentials, personas, appOrigins, host, advertisedHost, ports, tls, dns, record, timeoutMs });
    this.declarations = [...fixtures.services || []];
    for (const [capture, kind, name, env] of [
      ['mail', 'smtp-capture', 'capture-mail', { SMTP_HOST: '{{host}}', SMTP_PORT: '{{port}}' }],
      ['sms', 'sms-capture', 'capture-sms', { SMS_API_BASE: '{{url}}' }],
      ['webhooks', 'webhook-sink', 'capture-webhooks', { WEBHOOK_URL: '{{url}}' }],
    ]) if (fixtures.capture?.[capture] && !this.declarations.some(service => service.kind === kind)) this.declarations.push({ name, kind, env });
    if (new Set(this.declarations.map(service => service.name)).size !== this.declarations.length) fail('fixtures', 'invalid_contract');
    this.claims = new Map();
    for (const service of this.declarations) for (const claim of service.claims || []) {
      const match = /^([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::(80|443))?$/.exec(claim);
      if (!match || ['localhost', 'app', 'browser', 'controller', 'host.docker.internal', 'gateway.docker.internal'].includes(match[1].toLowerCase()) || service.kind === 'smtp-capture' || service.kind === 'custom') fail(service.name, 'invalid_host_claim');
      for (const port of match[2] ? [Number(match[2])] : [80, 443]) {
        const key = `${match[1].toLowerCase()}:${port}`; if (this.claims.has(key)) fail(service.name, 'invalid_host_claim');
        this.claims.set(key, service.name);
      }
    }
    this.services = new Map(); this.events = []; this.environment = {}; this.messages = []; this.messageBytes = 0;
  }
  async event(event) {
    const clean = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === 'string' ? redactStageOutput(value, Object.values(this.credentials)) : value]));
    this.events.push(clean); if (this.events.length > 1000) this.events.shift();
    await this.record(clean);
  }
  capture(kind, service, message) {
    const text = typeof message.text === 'string' ? message.text : JSON.stringify(message.text || message.body || {});
    const value = { id: randomUUID(), kind, service, ...message, to: (message.to || []).map(String), text, links: links(text) };
    this.messages.push(value); this.messageBytes += Buffer.byteLength(JSON.stringify(value));
    while (this.messages.length > 1000 || this.messageBytes > 24 * 1024 ** 2) this.messageBytes -= Buffer.byteLength(JSON.stringify(this.messages.shift()));
    return value.id;
  }
  async start({ processes, signal }) {
    if (this.services.size) fail('fixtures', 'invalid_state');
    this.processes = processes; this.messages = []; this.messageBytes = 0; this.events = []; this.environment = {};
    if ([...this.claims.keys()].some(key => key.endsWith(':443')) && (!this.tls?.key || !this.tls?.cert)) fail('host_claims', 'service_not_ready');
    try {
      if (this.dns) await this.startDns();
      for (const declaration of this.declarations) {
        signal?.throwIfAborted();
        const service = { declaration, behavior: declaration.default_behavior ?? declaration.behaviors?.[0], sockets: new Set() };
        this.services.set(declaration.name, service);
        if (declaration.kind === 'custom') {
          service.child = processes.start(declaration.start, { stage: `service:${declaration.name}` });
          const deadline = Date.now() + this.timeoutMs; let ready = false;
          while (Date.now() < deadline) {
            signal?.throwIfAborted(); if (service.child.settled) break;
            try { await processes.run(declaration.ready, { stage: `service:${declaration.name}:ready`, reason: 'service_not_ready', signal, timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) }); ready = true; break; }
            catch (error) { if (signal?.aborted) throw error; }
            await delay(50, undefined, { signal });
          }
          if (!ready) fail(declaration.name);
          Object.assign(this.environment, declaration.env || {}); continue;
        }
        if (declaration.kind === 'http-mock') service.recordings = await recordings(this.root, `.rio/qa/fixtures/${declaration.recordings}`, declaration);
        if (declaration.kind === 'oauth-provider') service.provider = new OAuthDouble({ appOrigins: this.appOrigins });
        if (declaration.kind === 's3') service.provider = new S3Double();
        if (declaration.kind === 'smtp-capture') service.server = this.smtp(service);
        else service.server = ownSockets(httpServer((request, response) => { void this.handle(service, request, response).catch(() => { if (!response.headersSent) json(response, 400, { error: 'invalid_fixture_request' }); else response.destroy(); }); }));
        const port = await listen(service.server, this.ports[declaration.name] ?? 0, this.host);
        service.url = `${declaration.kind === 'smtp-capture' ? 'smtp' : 'http'}://${this.advertisedHost}:${port}`;
        service.port = port;
        const claim = [...this.claims].find(([key, name]) => name === declaration.name && key.endsWith(':443')) || [...this.claims].find(([, name]) => name === declaration.name);
        if (claim) service.url = `${claim[0].endsWith(':443') ? 'https' : 'http'}://${claim[0].replace(/:(80|443)$/, '')}`;
        service.provider?.setUrl(service.url);
        for (const key of ['client_secret', 'secret_key', 'access_key']) if (service.provider?.variables[key]) processes.secrets?.push(service.provider.variables[key]);
        const substitutions = { url: service.url, host: new URL(service.url).hostname, port: new URL(service.url).port || (service.url.startsWith('https:') ? '443' : '80'), ...(service.provider?.variables || {}) };
        for (const [key, value] of Object.entries(declaration.env || {})) this.environment[key] = value.replace(/\{\{([a-z_]+)\}\}/g, (_, name) => { if (!Object.hasOwn(substitutions, name)) fail(declaration.name, 'invalid_contract'); return substitutions[name]; });
        await this.event({ kind: 'service_ready', service: declaration.name, service_kind: declaration.kind, port });
      }
      for (const port of [80, 443]) if ([...this.claims.keys()].some(key => key.endsWith(`:${port}`))) {
        const handler = (request, response) => {
          const name = this.claims.get(`${(request.headers.host || '').split(':')[0].toLowerCase()}:${port}`), service = this.services.get(name);
          if (!service) return json(response, 421, { error: 'unclaimed_fixture_host' });
          void this.handle(service, request, response).catch(() => { if (!response.headersSent) json(response, 400, { error: 'invalid_fixture_request' }); else response.destroy(); });
        };
        const server = ownSockets(port === 443 ? httpsServer(this.tls, handler) : httpServer(handler));
        if (port === 443) server.on('tlsClientError', (error, socket) => {
          if (/alert.*(?:certificate|unknown ca)|certificate.*alert/i.test(error.message)) {
            const host = socket.servername;
            if (host && this.claims.has(`${host}:443`)) void this.event({ kind: 'tls_pinned', host, reason: 'client_rejected_run_certificate' }).catch(() => {});
          }
        });
        this.claimServers ||= []; this.claimServers.push(server);
        await listen(server, this.ports[port === 443 ? 'claims_https' : 'claims_http'] ?? port, this.host);
      }
      Object.assign(processes.env, this.environment);
    } catch (error) { await this.stop(); throw error; }
  }
  async startDns() {
    const server = this.dnsServer = createSocket('udp4');
    server.on('message', (packet, remote) => {
      // No forwarding: unknown dependencies fail closed and retain the queried
      // hostname. Claims resolve through the runner-owned hosts file instead.
      if (packet.length < 17 || packet.length > 512 || packet.readUInt16BE(4) !== 1 || packet[2] & 0x80) return;
      let at = 12; const labels = [];
      while (at < packet.length && packet[at]) {
        const size = packet[at++];
        if (size > 63 || at + size > packet.length) return;
        const label = packet.subarray(at, at + size).toString('ascii');
        if (!/^[a-zA-Z0-9_-]+$/.test(label)) return;
        labels.push(label); at += size;
      }
      if (!labels.length || at + 5 > packet.length) return;
      const host = labels.join('.').toLowerCase(); if (host.length > 253) return;
      const answer = Buffer.from(packet.subarray(0, at + 5));
      answer.writeUInt16BE(0x8183, 2); answer.fill(0, 6, 12);
      server.send(answer, remote.port, remote.address, () => {});
      if (!this.events.some(event => event.kind === 'blocked_egress' && event.host === host)) void this.event({ kind: 'blocked_egress', host }).catch(() => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.bind(this.ports.dns ?? 53, this.host, () => { server.removeListener('error', reject); server.on('error', () => {}); resolve(); }); });
  }
  smtp(service) {
    return ownSockets(smtpServer(socket => {
      socket.setEncoding('utf8'); socket.setTimeout(30000, () => socket.destroy());
      socket.write('220 rio.qa ESMTP synthetic capture\r\n');
      let pending = '', data = false, lines = [], size = 0, from = '', to = [], auth = 0;
      socket.on('error', () => {});
      socket.on('data', chunk => {
        pending += chunk; if (Buffer.byteLength(pending) + size > 1024 * 1024) { socket.end('552 Message exceeds fixture limit\r\n'); return; }
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
          if (data) {
            if (line === '.') {
              const text = mailText(lines.join('\n')); this.capture('mail', service.declaration.name, { from, to: [...to], text });
              data = false; lines = []; size = 0; from = ''; to = []; socket.write('250 Message captured\r\n');
            } else { const value = line.startsWith('..') ? line.slice(1) : line; lines.push(value); size += Buffer.byteLength(value) + 1; }
            continue;
          }
          if (auth) { auth--; socket.write(auth ? '334 UGFzc3dvcmQ6\r\n' : '235 Synthetic authentication accepted\r\n'); continue; }
          const [verb] = line.toUpperCase().split(' ');
          if (verb === 'EHLO') socket.write('250-rio.qa\r\n250-SIZE 1048576\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (verb === 'HELO') socket.write('250 rio.qa\r\n');
          else if (verb === 'AUTH') { auth = /^AUTH LOGIN(?:\s|$)/i.test(line) ? line.trim().split(/\s+/).length > 2 ? 1 : 2 : /^AUTH PLAIN\s+\S+/i.test(line) ? 0 : 1; socket.write(auth ? '334 VXNlcm5hbWU6\r\n' : '235 Synthetic authentication accepted\r\n'); }
          else if (verb === 'MAIL') { from = /FROM:\s*<?([^>\s]*)/i.exec(line)?.[1] || ''; to = []; socket.write('250 OK\r\n'); }
          else if (verb === 'RCPT') { const recipient = /TO:\s*<?([^>\s]*)/i.exec(line)?.[1]; if (recipient) { to.push(recipient); socket.write('250 OK\r\n'); } else socket.write('501 Invalid recipient\r\n'); }
          else if (verb === 'DATA') { if (!to.length) socket.write('503 Recipient required\r\n'); else { data = true; socket.write('354 End with a dot\r\n'); } }
          else if (verb === 'RSET') { from = ''; to = []; lines = []; size = 0; socket.write('250 OK\r\n'); }
          else if (verb === 'NOOP') socket.write('250 OK\r\n');
          else if (verb === 'QUIT') socket.end('221 Bye\r\n');
          else socket.write('502 Command not supported by fixture\r\n');
        }
      });
    }));
  }
  async handle(service, request, response) {
    const declaration = service.declaration, url = new URL(request.url, service.url || 'http://fixture');
    const content = await body(request, declaration.kind === 's3' ? 64 * 1024 ** 2 : 1024 * 1024);
    await this.event({ kind: 'service_request', service: declaration.name, method: request.method, path: url.pathname + url.search, behavior: service.behavior });
    if (service.provider) return service.provider.handle(request, response, url, content);
    if (declaration.kind === 'http-mock') {
      let parsed; try { parsed = JSON.parse(content.toString()); } catch { parsed = content.toString(); }
      const entry = service.recordings.find(entry => (!entry.behavior || entry.behavior === service.behavior) && entry.request.method === request.method && entry.request.path === url.pathname && matches(entry.request.body, parsed)
        && Object.entries(entry.request.headers || {}).every(([name, value]) => matches(value, request.headers[name.toLowerCase()])) && matches(entry.request.query, Object.fromEntries(url.searchParams)));
      if (!entry) return json(response, 501, { error: 'fixture_request_unmatched', service: declaration.name, behavior: service.behavior });
      const value = typeof entry.response.body === 'string' ? entry.response.body : JSON.stringify(entry.response.body ?? null);
      response.writeHead(entry.response.status, entry.response.headers || { 'content-type': 'application/json' }); response.end(value); return;
    }
    if (['sms-capture', 'webhook-sink'].includes(declaration.kind)) {
      if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' });
      let value; try { value = JSON.parse(content.toString()); } catch { value = Object.fromEntries(new URLSearchParams(content.toString())); }
      const id = this.capture(declaration.kind === 'sms-capture' ? 'sms' : 'webhooks', declaration.name, { to: [value.to ?? value.To ?? ''], text: value.text ?? value.body ?? value.Body ?? content.toString(), body: value });
      return json(response, declaration.kind === 'sms-capture' ? 201 : 202, { id, sid: id, status: 'captured' });
    }
    return json(response, 501, { error: 'fixture_operation_unsupported' });
  }
  async behavior(name, behavior) {
    const service = this.services.get(name);
    if (!service || !service.declaration.behaviors?.includes(behavior)) fail(name, 'invalid_service_behavior');
    service.behavior = behavior;
    await this.event({ kind: 'service_behavior', service: name, behavior });
    return { service: name, behavior };
  }
  read(kind, name) {
    let recipient;
    if (kind === 'webhooks') { if (!this.services.has(name)) fail(name, 'invalid_service'); }
    else {
      const persona = this.personas.find(persona => persona.name === name);
      if (!persona) fail(name, 'invalid_persona');
      recipient = this.credentials[persona.username_env];
    }
    return this.messages.filter(message => message.kind === kind && (kind === 'webhooks' ? message.service === name : !recipient || message.to.some(value => value.toLowerCase() === recipient.toLowerCase()))).slice(-20);
  }
  async reset({ signal }) { await this.stop(); await this.start({ processes: this.processes, signal }); }
  async stop() {
    if (this.dnsServer) { const server = this.dnsServer; this.dnsServer = undefined; await new Promise(resolve => { try { server.close(resolve); } catch { resolve(); } }); }
    for (const server of this.claimServers || []) await close(server); this.claimServers = [];
    for (const service of [...this.services.values()].reverse()) { await close(service.server); if (service.child) await this.processes.stop(service.child); }
    this.services.clear();
  }
  status() { return [...this.services].map(([name, service]) => ({ name, kind: service.declaration.kind, url: service.url, behavior: service.behavior })); }
}
