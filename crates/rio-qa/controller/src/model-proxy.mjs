import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const allowedPaths = new Set(['/v1/responses', '/v1/chat/completions']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const usageOf = object => {
  const usage = object?.usage || object?.response?.usage;
  if (!usage) return null;
  const input = usage.input_tokens ?? usage.prompt_tokens, output = usage.output_tokens ?? usage.completion_tokens;
  if (!count(input) || !count(output) || !count(input + output)) return null;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
};

/** Fixed, trusted gateway route. Repository data never selects the URL, headers
 * or token. Redirects are forbidden so a credential cannot cross destinations. */
export function gatewayTransport({ sandboxGateway = false, baseUrl, token, runId, fetch: request = globalThis.fetch }) {
  const base = new URL(baseUrl);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && (['127.0.0.1', '[::1]'].includes(base.hostname) || (sandboxGateway && base.origin === 'http://198.18.0.1')))) || base.username || base.password || base.search || base.hash) throw new Error('Invalid QA model gateway');
  if (!token || !runId) throw new Error('Missing run-scoped gateway authorization');
  return async ({ path, body, signal, cell }) => {
    if (!allowedPaths.has(path)) throw new Error('Unsupported model route');
    return request(base.href.replace(/\/$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-rio-run-id': runId, ...(cell?.id ? { 'x-rio-cell-id': cell.id } : {}) },
      body: JSON.stringify(body), redirect: 'error', signal });
  };
}

async function drain(response, signal) {
  signal.throwIfAborted();
  if (response.destroyed) throw new Error('Disconnected model client');
  await new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', ready); response.off('close', closed); response.off('error', closed); signal.removeEventListener('abort', closed); };
    const ready = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Disconnected model client')); };
    response.once('drain', ready); response.once('close', closed); response.once('error', closed); signal.addEventListener('abort', closed, { once: true });
  });
}

/** One ledger and capability per chain × cell. Reservations are synchronous,
 * so concurrent harness requests cannot spend the same remaining allowance.
 * Only trusted host configuration may supply the forward function and model. */
// Harnesses replay the whole conversation on every call. A step screenshot is
// useful only until the next one; replace earlier ones so neither the provider
// nor the cell's byte-based input bound pays for them again.
export function dropStaleImages(body) {
  const images = [];
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (value.type === 'input_image' || value.type === 'image_url') images.push(value);
      else Object.values(value).forEach(visit);
    }
  };
  visit(body.input); visit(body.messages);
  for (const image of images.slice(0, -1)) {
    for (const key of Object.keys(image)) delete image[key];
    Object.assign(image, { type: body.messages ? 'text' : 'input_text', text: '[earlier screenshot omitted]' });
  }
  return images.length > 1;
}

export class ModelProxy {
  constructor({ forward, model, record = async () => {}, onExhausted = () => {}, requestBytes = 16 * 1024 * 1024,
    responseBytes = 32 * 1024 * 1024, requestTimeoutMs = 120000 }) {
    if (typeof forward !== 'function' || typeof model !== 'string' || !model || ![requestBytes, responseBytes, requestTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid model proxy configuration');
    Object.assign(this, { forward, model, record, onExhausted, requestBytes, responseBytes, requestTimeoutMs });
    this.active = new Set(); this.pending = new Set(); this.sequence = 0; this.usage = [];
  }
  startCell(cell, tokens) {
    if (this.closing) throw new Error('Model proxy is closed');
    if (this.active.size) throw new Error('Cannot replace a cell with model requests in flight');
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error('Invalid cell token budget');
    this.budget = new AbortController();
    this.cell = structuredClone(cell); this.limit = tokens; this.spent = 0; this.reserved = 0; this.exhausted = false;
    this.token = randomBytes(32).toString('hex'); return this.token;
  }
  exhaust() {
    if (!this.exhausted) {
      this.exhausted = true; this.budget.abort('budget');
      // A reporting callback must never prevent accounting or cleanup.
      try { Promise.resolve(this.onExhausted(structuredClone(this.cell))).catch(() => {}); } catch {}
    }
  }
  async listen({ socketPath } = {}) {
    if (this.server || this.closing) throw new Error('Model proxy already started or closed');
    this.server = createServer((request, response) => {
      const pending = this.handle(request, response).catch(() => response.destroy());
      this.pending.add(pending); void pending.finally(() => this.pending.delete(pending));
    });
    if (socketPath) this.server.listen(socketPath); else this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = socketPath ? undefined : `http://127.0.0.1:${this.server.address().port}/v1`; return this;
  }
  async handle(request, response) {
    const error = (status, code) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) return response.destroy();
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: { code, message: code } }));
    };
    const supplied = Buffer.from(request.headers.authorization || ''), expected = Buffer.from(`Bearer ${this.token || ''}`);
    if (this.closing || !this.token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return error(401, 'invalid_cell_authorization');
    if (request.method !== 'POST' || !allowedPaths.has(request.url)) return error(404, 'unknown_model_route');
    if (this.exhausted) return error(429, 'qa_token_budget_exhausted');
    const abort = new AbortController(); this.active.add(abort);
    const timer = setTimeout(() => abort.abort(), this.requestTimeoutMs); timer.unref();
    const disconnected = () => { if (!response.writableEnded) abort.abort(); }; response.on('close', disconnected);
    const stopReading = () => { if (!request.complete) request.destroy(); };
    abort.signal.addEventListener('abort', stopReading, { once: true });
    let reservation = 0, usage, attempted = false, status = 'failed', completed = false, upstream;
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > this.requestBytes) return error(413, 'model_request_too_large'); chunks.push(chunk); }
      abort.signal.throwIfAborted();
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return error(400, 'invalid_model_request'); }
      if (dropStaleImages(body)) bytes = Buffer.byteLength(JSON.stringify(body));
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== this.model || body.background || body.store === true || body.previous_response_id || body.conversation) return error(400, 'invalid_model_request');
      // Provider-side tools would bypass the controller's MCP permissions.
      const functionTool = tool => tool && (tool.type === 'function' || tool.type === 'namespace' && Array.isArray(tool.tools) && tool.tools.every(child => child?.type === 'function'));
      if (body.tools && (!Array.isArray(body.tools) || !body.tools.every(functionTool))) return error(400, 'invalid_model_tools');
      // As in the hosted conversation ledger, UTF-8 bytes bound text
      // tokenization, with framing reserve. Include tool schemas and inline
      // images; reject provider-side history to keep every input accounted for.
      const inputBound = bytes + 256;
      const outputKey = request.url.endsWith('/responses') ? 'max_output_tokens' : 'max_completion_tokens';
      const wanted = body[outputKey] ?? body.max_tokens ?? 16384;
      if (!Number.isSafeInteger(wanted) || wanted < 1) return error(400, 'invalid_output_limit');
      const outputBound = Math.min(wanted, this.limit - this.spent - this.reserved - inputBound);
      if (outputBound < 1) { this.exhaust(); return error(429, 'qa_token_budget_exhausted'); }
      body[outputKey] = outputBound; delete body.max_tokens; body.store = false;
      if (request.url.endsWith('/chat/completions') && body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
      reservation = inputBound + outputBound; this.reserved += reservation;
      attempted = true; // A transport failure may occur after the provider received the request.
      upstream = await this.forward({ path: request.url, body, signal: abort.signal, cell: structuredClone(this.cell) });
      abort.signal.throwIfAborted();
      if (!upstream.ok) { status = 'upstream_error'; return error(upstream.status === 429 ? 429 : 502, 'qa_model_upstream_error'); }
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const decoder = new TextDecoder(); let pending = '', received = 0;
        const line = text => {
          if (!text.startsWith('data:')) return;
          let event; try { event = JSON.parse(text.slice(5).trim()); } catch { return; }
          // Ignore preliminary usage estimates; only terminal events settle a call.
          if (!request.url.endsWith('/responses') || ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) usage = usageOf(event) || usage;
          if (usage && usage.total_tokens > reservation) { this.exhaust(); throw new Error('Upstream exceeded reserved tokens'); }
        };
        for await (const chunk of upstream.body) {
          abort.signal.throwIfAborted(); received += chunk.byteLength;
          if (received > this.responseBytes) throw new Error('Model response exceeds bound');
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split('\n'); pending = lines.pop();
          for (const text of lines) line(text);
          if (!response.write(chunk)) await drain(response, abort.signal);
        }
        pending += decoder.decode(); if (pending) line(pending);
        abort.signal.throwIfAborted(); completed = true; response.end();
      } else {
        const chunks = []; let size = 0;
        for await (const chunk of upstream.body) {
          abort.signal.throwIfAborted(); size += chunk.byteLength;
          if (size > this.responseBytes) throw new Error('Model response exceeds bound');
          chunks.push(chunk);
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); usage = usageOf(result);
        if (usage && usage.total_tokens > reservation) { this.exhaust(); throw new Error('Upstream exceeded reserved tokens'); }
        abort.signal.throwIfAborted(); completed = true;
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result));
      }
      status = usage ? 'completed' : 'usage_missing';
    } catch {
      status = abort.signal.aborted ? 'cancelled' : 'failed';
      error(502, 'qa_model_request_failed');
    } finally {
      abort.abort(); clearTimeout(timer);
      try { if (upstream?.body && !upstream.body.locked) await upstream.body.cancel(); } catch {}
      if (reservation) {
        this.reserved -= reservation;
        // Partial/missing usage cannot release unmetered spend. A cancelled
        // stream consumes its full reservation even if it reported usage early.
        const billed = completed && usage ? usage.total_tokens : attempted ? Math.max(reservation, usage?.total_tokens || 0) : 0;
        this.spent += billed;
        const entry = { sequence: this.sequence++, cell: structuredClone(this.cell), model: this.model, status,
          reserved_tokens: reservation, charged_tokens: billed, ...(completed && usage || {}), estimated: !(completed && usage), remaining_tokens: Math.max(0, this.limit - this.spent - this.reserved) };
        this.usage.push(entry);
        try { await this.record(structuredClone(entry)); } catch { this.exhaust(); }
        if (this.spent >= this.limit) this.exhaust();
      }
      this.active.delete(abort); response.off('close', disconnected); abort.signal.removeEventListener('abort', stopReading);
    }
  }
  close() {
    return this.closing ||= (async () => {
      for (const abort of this.active) abort.abort();
      this.server?.closeAllConnections();
      if (this.server) await new Promise(resolve => this.server.close(resolve));
      await Promise.allSettled([...this.pending]);
      this.token = undefined;
    })();
  }
}

/** Controller access to the local host relay uses one mounted socket, not a
 * host network route or a provider key. The mount is absent from app/browser. */
export function localTransport({ socketPath, token }) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || !token) throw new Error('Invalid local QA relay');
  return ({ path, body, signal }) => new Promise((resolve, reject) => {
    if (!allowedPaths.has(path)) { reject(new Error('Unsupported model route')); return; }
    const content = JSON.stringify(body);
    const request = httpRequest({ socketPath, path, method: 'POST', signal, headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(content),
    } }, response => resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: { 'content-type': response.headers['content-type'] || 'application/octet-stream' } })));
    request.on('error', () => reject(new Error('Local QA model relay failed')));
    request.end(content);
  });
}
