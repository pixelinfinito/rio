import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('./secrets-catalog.json', import.meta.url), 'utf8'));
const expression = (source, flags = '') => new RegExp(source.replace(/^\(\?i\)/, ''), flags + (source.startsWith('(?i)') ? 'i' : ''));
const patterns = catalog.patterns.map(pattern => expression(pattern.regex, 'g'));
const secretName = expression(catalog.entropy.names);
const headers = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
const secretKey = /(?:^|[_-])(?:password|passwd|secret|api[_-]?key|private[_-]?key|(?:access[_-]?|refresh[_-]?|id[_-]?|auth[_-]?)?token|one[_-]?time[_-]?code)$/i;
const marker = '[redacted]';
const entropy = value => {
  const bytes = Buffer.from(value), counts = new Map();
  for (const byte of bytes) counts.set(byte, (counts.get(byte) || 0) + 1);
  return [...counts.values()].reduce((sum, count) => { const p = count / bytes.length; return sum - p * Math.log2(p); }, 0);
};

/** Shared by evidence, MCP transcript and trace retention. Always sanitize
 * complete values before byte truncation, including encoded known secrets. */
export class Sanitizer {
  constructor(secrets = []) { this.secrets = new Set(); this.add(secrets); }
  add(values) {
    for (const value of values) if (typeof value === 'string' && value) {
      this.secrets.add(value); this.secrets.add(encodeURIComponent(value));
      this.secrets.add(JSON.stringify(value).slice(1, -1));
      if (value.length >= 8) this.secrets.add(Buffer.from(value).toString('base64'));
    }
  }
  text(value) {
    let text = String(value);
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join(marker);
    for (const pattern of patterns) text = text.replace(pattern, marker);
    text = text.replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1' + marker)
      .replace(/(\bhttps?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1' + marker + '@')
      .replace(/\b((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*)[^\r\n]+/gi, '$1' + marker)
      .replace(/([?&#])([^\s=&#"'<>]+)=([^\s&#"'<>]*)/g, (whole, prefix, key, value) => {
        let name; try { name = decodeURIComponent(key.replaceAll('+', ' ')); } catch { return prefix + key + '=' + marker; }
        return /token|secret|password|passwd|api[_-]?key|^code$/i.test(name) ? prefix + key + '=' + marker : whole;
      });
    // Mirror the report catalog's entropy check for literal assignments. QA
    // additionally masks explicitly named JSON secrets regardless of entropy.
    return text.replace(/([A-Za-z_][A-Za-z0-9_-]*["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z0-9/+_=.-]+))/g,
      (whole, prefix, double, single, bare) => {
        const value = double ?? single ?? bare, name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(prefix)[0];
        if (!secretName.test(name) || value.length < catalog.entropy.min_length || entropy(value) < catalog.entropy.threshold) return whole;
        const quote = double !== undefined ? '"' : single !== undefined ? "'" : '';
        return prefix + quote + marker + quote;
      });
  }
  value(value, depth = 0) {
    if (depth > 64) return '[redacted: depth limit]';
    if (typeof value === 'string') {
      // Response bodies and tool text often embed JSON. Parse first so even a
      // low-entropy session token in a named field is masked before storage.
      if (/^\s*[\[{]/.test(value)) {
        try { return JSON.stringify(this.value(JSON.parse(value), depth + 1)); } catch {}
      }
      return this.text(value);
    }
    if (Array.isArray(value)) return value.map(entry => this.value(entry, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const namedSecret = typeof value.name === 'string' && (headers.test(value.name) || secretKey.test(value.name) || value.name.toLowerCase() === 'code');
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key),
      headers.test(key) || secretKey.test(key) || namedSecret && key === 'value' ? marker : key.toLowerCase() === 'cookies' && Array.isArray(child)
        ? child.map(cookie => ({ ...this.value(cookie, depth + 1), value: marker })) : this.value(child, depth + 1)]));
  }
  network(value) {
    const sanitized = this.value(value);
    const truncate = object => {
      if (!object || typeof object !== 'object') return;
      for (const [key, value] of Object.entries(object)) {
        if (['body', 'postData', 'response_body', 'request_body'].includes(key) && typeof value === 'string') {
          const bytes = Buffer.from(value);
          if (bytes.length > 16384) { object[key] = new TextDecoder().decode(bytes.subarray(0, 16384), { stream: true }); object[key + '_truncated'] = true; }
        } else truncate(value);
      }
    };
    truncate(sanitized); return sanitized;
  }
}
