/** This transport receives only sanitized bytes from EvidenceWriter. Destination
 * and capability come from the trusted runner, never from a journey or browser. */
export class HostedEvidenceTransport {
  constructor({ sandboxGateway = false, endpoint, tenant, reviewId, runId, capability, fetchImpl = fetch, timeoutMs = 120000 }) {
    const url = new URL(endpoint);
    if ((url.protocol !== 'https:' && !(sandboxGateway && url.origin === 'http://198.18.0.1')) || url.username || url.password || url.search || url.hash || ![tenant, reviewId, runId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) || typeof capability !== 'string' || !capability || /[\r\n]/.test(capability)) throw new Error('Invalid QA evidence transport');
    Object.assign(this, { endpoint: endpoint.replace(/\/$/, '') + `/v1/qa/runs/${runId}/evidence`, prefix: `qa/${tenant}/${reviewId}/${runId}/`, capability, fetchImpl, timeoutMs });
  }
  async upload(key, bytes, descriptor) {
    if (!key.startsWith(this.prefix) || key.slice(this.prefix.length).split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid QA evidence scope');
    const manifest = key === this.prefix + 'manifest.json';
    if (!manifest && (!descriptor?.sanitized || !/^[a-f0-9]{64}$/.test(descriptor.id) || descriptor.bytes !== bytes.length)) throw new Error('Invalid QA evidence descriptor');
    let response;
    try {
      response = await this.fetchImpl(this.endpoint + (manifest ? '' : `/${descriptor.id}`), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${this.capability}`, 'content-type': manifest ? 'application/json' : 'application/octet-stream', ...(manifest ? {} : { 'rio-evidence-metadata': JSON.stringify(descriptor) }) }, body: bytes });
    } catch { throw new Error('QA evidence upload failed'); }
    let text = '', length = 0; const decoder = new TextDecoder();
    for await (const chunk of response.body || []) { length += chunk.byteLength; if (length > 65536) throw new Error('Invalid QA evidence response'); text += decoder.decode(chunk, { stream: true }); }
    text += decoder.decode();
    let value; try { value = JSON.parse(text); } catch { throw new Error('Invalid QA evidence response'); }
    if (!response.ok) {
      const error = new Error('QA evidence upload failed');
      if (response.status === 429 && value.error === 'evidence_quota_reached') error.code = 'evidence_quota_reached';
      throw error;
    }
    if (manifest) { if (value.stored !== true) throw new Error('Invalid QA evidence response'); return; }
    if (value.id !== descriptor.id || value.content_hash !== descriptor.content_hash || value.bytes !== bytes.length || value.key !== key || value.storage !== 'hosted') throw new Error('Invalid QA evidence receipt');
    return value;
  }
}
