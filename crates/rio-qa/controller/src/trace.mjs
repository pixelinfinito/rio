import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

const types = new Set(['context-options', 'before', 'input', 'after', 'log', 'event', 'frame-snapshot', 'screencast-frame', 'console', 'stdout', 'stderr', 'error', 'resource-snapshot']);
const safeName = name => name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').some(part => !part || part === '..' || part === '.') && !/^[A-Za-z]:/.test(name);
const fail = code => { const error = new Error('evidence_unsanitized'); error.traceFailure = code; throw error; };
function maskDom(value, masked = false) {
  if (!Array.isArray(value)) return value;
  if (typeof value[0] === 'string' && value[1] && typeof value[1] === 'object' && !Array.isArray(value[1])) {
    const attrs = value[1];
    masked ||= Object.hasOwn(attrs, 'data-rio-mask') || String(attrs.type).toLowerCase() === 'password';
    if (masked) for (const key of Object.keys(attrs)) if (/value|label|title|alt/i.test(key)) attrs[key] = '[redacted]';
    return [value[0], attrs, ...value.slice(2).map(child => typeof child === 'string' && masked ? '[redacted]' : maskDom(child, masked))];
  }
  return value.map(child => maskDom(child, masked));
}

/** Only recognized Playwright trace members are retained. Raw archives never
 * reach an evidence sink, and any parse/format/size error drops the whole trace. */
export function sanitizeTrace(bytes, sanitizer, { maxExpandedBytes = 512 * 1024 * 1024 } = {}) {
  try {
    let expanded = 0, rejected = false;
    const members = unzipSync(bytes, { filter: file => {
      expanded += file.originalSize;
      if (!safeName(file.name) || expanded > maxExpandedBytes || file.originalSize > maxExpandedBytes) { rejected = true; return false; }
      return true;
    } });
    if (rejected || !Object.keys(members).some(name => name.endsWith('.trace'))) fail('invalid_archive');
    const parsed = new Map(), images = new Set(), bodies = new Set(), styles = new Set();
    let versionSeen = false;
    for (const [name, bytes] of Object.entries(members)) {
      if (name.endsWith('.trace') || name.endsWith('.network')) {
        const rows = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        for (const row of rows) {
          if (!row || !types.has(row.type)) fail('unsupported_event');
          if (row.type === 'context-options') { if (row.version !== 10) fail('unsupported_version'); versionSeen = true; }
          if (row.type === 'screencast-frame') {
            const reference = row.file || (row.sha1 && `resources/${row.sha1}`);
            if (!safeName(reference)) fail('invalid_reference'); images.add(reference);
          }
          if (row.type === 'resource-snapshot') {
            for (const content of [row.snapshot?.response?.content, row.snapshot?.request?.postData]) {
              if (content?._sha1) { bodies.add(`resources/${content._sha1}`); delete content._sha1; }
              if (content?._file) { if (!safeName(content._file)) fail('invalid_reference'); bodies.add(content._file); delete content._file; }
              if (content) { delete content.text; delete content.body; }
            }
          }
          if (row.type === 'frame-snapshot') {
            if (row.snapshot?.html) row.snapshot.html = maskDom(row.snapshot.html);
            // Playwright v10 snapshots modified external CSSOM stylesheets as
            // explicit CSS overrides, independently of network response bodies.
            for (const override of row.snapshot?.resourceOverrides || []) {
              const reference = override.file || (override.sha1 && `resources/${override.sha1}`);
              if (reference) {
                if (!/^resources\/[a-f0-9]{40}\.css$/.test(reference)) fail('invalid_style_reference');
                styles.add(reference);
              } else if (!Number.isInteger(override.ref) || override.ref < 0) fail('invalid_style_reference');
            }
          }
        }
        parsed.set(name, rows);
      } else if (name.endsWith('.stacks')) {
        const row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!row || !Array.isArray(row.files) || !Array.isArray(row.stacks)) fail('invalid_stacks');
        parsed.set(name, row);
      }
    }
    if (!versionSeen) fail('missing_version');
    const output = {};
    for (const [name, bytes] of Object.entries(members)) {
      if (bodies.has(name) && !styles.has(name)) continue;
      if (parsed.has(name)) {
        const content = parsed.get(name);
        output[name] = strToU8(name.endsWith('.stacks') ? JSON.stringify(sanitizer.value(content)) : content.map(row => JSON.stringify(sanitizer.network(row))).join('\n') + '\n');
      } else if (styles.has(name)) {
        const css = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        output[name] = strToU8(sanitizer.text(css));
      } else if (images.has(name)) {
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
        const png = bytes[0] === 137 && strFromU8(bytes.subarray(1, 4)) === 'PNG';
        if (!jpeg && !png) fail('invalid_image');
        for (const secret of sanitizer.secrets) if (Buffer.from(bytes).includes(Buffer.from(secret))) fail('image_contains_secret');
        output[name] = bytes;
      } else fail('unknown_member');
    }
    if ([...images].some(name => !output[name])) fail('missing_image');
    if ([...styles].some(name => !output[name])) fail('missing_style');
    return { bytes: Buffer.from(zipSync(output, { level: 6 })), sanitized: true };
  } catch (error) { return { dropped: 'evidence_unsanitized', failure: error.traceFailure || 'parse_or_sanitize_failed' }; }
}
