const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
// Only trusted capture handlers can grant this exception. It cannot be forged
// by an MCP argument, a page, or a serialized response from the app container.
const liveReplies = new WeakMap();

export function presentToolResult(result, sanitize) {
  const live = liveReplies.get(result);
  return live ? structuredClone(live) : sanitize(result);
}

function usableLink(value, origins, sanitizer) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !origins.has(url.origin) || url.username || url.password) return false;
    // Verification tokens may remain live, but never declared credentials, even
    // when a captured message tries to disguise them as a link parameter.
    const decoded = decodeURIComponent(value);
    return ![...sanitizer.secrets].some(secret => value.includes(secret) || decoded.includes(secret));
  } catch { return false; }
}

/** Controller-only API client. The app receives no model capability. */
export class FixtureClient {
  constructor({ endpoint, sanitizer, allowedOrigins, personas = [], fixtures = {}, fetchImpl = fetch, signal }) {
    this.endpoint = new URL(endpoint); this.sanitizer = sanitizer;
    this.origins = new Set(allowedOrigins); this.personas = new Set(personas.map(persona => persona.name));
    this.services = new Map((fixtures.services || []).map(service => [service.name, service]));
    if (fixtures.capture?.webhooks && !(fixtures.services || []).some(service => service.kind === 'webhook-sink')) this.services.set('capture-webhooks', { kind: 'webhook-sink' });
    this.fetch = fetchImpl; this.signal = signal; this.messages = new Map(); this.messageBytes = 0; this.seenEvents = new Set();
    this.captureKinds = ['mail', 'sms'].filter(kind => fixtures.capture?.[kind] || (fixtures.services || []).some(service => service.kind === (kind === 'mail' ? 'smtp-capture' : 'sms-capture')));
    this.handlers = {
      read_mail: ({ persona }) => this.read('mail', persona),
      read_sms: ({ persona }) => this.read('sms', persona),
      read_webhooks: ({ service }) => this.read('webhooks', service),
      set_service_behavior: ({ service, behavior }) => this.behavior(service, behavior),
    };
  }
  async request(path, value) {
    const response = await this.fetch(new URL(path, this.endpoint), {
      method: value === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), redirect: 'error',
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Fixture operation failed'); }
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 24 * 1024 ** 2) throw new Error('Fixture response exceeds limit');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel(); }
  }
  async read(kind, name) {
    if (kind === 'webhooks' ? !this.services.has(name) : !this.personas.has(name)) throw new Error('Undeclared fixture capture');
    const value = await this.request('/fixtures/read', { kind, name });
    if (!Array.isArray(value.messages) || value.messages.length > 20) throw new Error('Invalid fixture capture');
    const clean = this.sanitizer.value(value.messages);
    const live = structuredClone(clean);
    for (const [index, message] of value.messages.entries()) {
      if (!message || typeof message.id !== 'string' || message.id.length > 256 || typeof message.text !== 'string' || !Array.isArray(message.links)) throw new Error('Invalid fixture capture');
      if (this.messages.has(message.id)) this.messageBytes -= Buffer.byteLength(JSON.stringify(this.messages.get(message.id)));
      this.messages.set(message.id, clean[index]);
      this.messageBytes += Buffer.byteLength(JSON.stringify(clean[index]));
      if (kind !== 'webhooks') live[index].links = message.links.filter(link => typeof link === 'string' && usableLink(link, this.origins, this.sanitizer));
    }
    while (this.messages.size > 1000 || this.messageBytes > 24 * 1024 ** 2) {
      const key = this.messages.keys().next().value;
      this.messageBytes -= Buffer.byteLength(JSON.stringify(this.messages.get(key))); this.messages.delete(key);
    }
    const result = reply({ messages: clean });
    liveReplies.set(result, reply({ messages: live }));
    return result;
  }
  async behavior(service, behavior) {
    if (!this.services.get(service)?.behaviors?.includes(behavior)) throw new Error('Undeclared fixture behavior');
    await this.request('/fixtures/behavior', { service, behavior });
    return reply({ service, behavior });
  }
  capturedMessages() { return [...this.messages.values()]; }
  async dependencyFailures(browser) {
    const { events } = await this.request('/fixtures/events');
    if (!Array.isArray(events) || events.length > 1000) throw new Error('Invalid fixture events');
    const failures = new Map();
    for (const event of events) if (['blocked_egress', 'tls_pinned'].includes(event.kind) && typeof event.host === 'string') {
      const key = `${event.kind}:${event.host}`;
      const failure = this.sanitizer.value({ kind: event.kind, host: event.host });
      failures.set(key, failure);
      if (!this.seenEvents.has(key)) { browser.networkEvents.push(failure); this.seenEvents.add(key); }
    }
    return [...failures.values()];
  }
  async collect(browser) {
    for (const kind of this.captureKinds) for (const persona of this.personas) await this.read(kind, persona);
    for (const [name, service] of this.services) if (service.kind === 'webhook-sink') await this.read('webhooks', name);
    await this.dependencyFailures(browser);
    return this.capturedMessages();
  }
  reset() { this.messages.clear(); this.messageBytes = 0; this.seenEvents.clear(); }
}
