import { open, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, sep, basename } from 'node:path';
import { createDeflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { StartupFailure } from './app-runtime.mjs';

export const generatedFixturePath = '.rio/qa/generated';
const extensions = { image: 'png', pdf: 'pdf', csv: 'csv', json: 'json', text: 'txt', binary: 'bin' };
const media = { png: 'image/png', pdf: 'application/pdf', csv: 'text/csv', json: 'application/json', txt: 'text/plain' };
const failure = (name, reason = 'invalid_fixture_file', details) => new StartupFailure(reason, name, details);
const generatedName = file => `${file.name}.${extensions[file.generate.kind]}`;

export function fixtureSeedManifest(manifest, fixtures = {}) {
  return { ...manifest, paths: [...manifest.paths || [], ...(fixtures.files?.some(file => file.generate) ? [generatedFixturePath] : [])] };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function pngChunk(kind, data) {
  const body = Buffer.concat([Buffer.from(kind), data]), chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); body.copy(chunk, 4);
  let crc = 0xffffffff; for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4); return chunk;
}
async function* png(generate, maxSize, signal) {
  const width = generate.width || 256, height = generate.height || 256;
  // Bound both dimensions and work using the same seed quota. Compression must
  // not turn a tiny requested archive into unbounded generator work or memory.
  if (!Number.isSafeInteger(width * height * 3) || width * height * 3 > maxSize) throw failure('image', 'seed_too_large', { bytes: width * height * 3, max_bytes: maxSize });
  yield Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  yield pngChunk('IHDR', header);
  const rows = async function* () {
    const row = Buffer.alloc(width * 3 + 1, 180); row[0] = 0;
    for (let index = 0; index < height; index++) { signal?.throwIfAborted(); yield row; }
  };
  const source = Readable.from(rows()), compressed = source.pipe(createDeflate());
  source.on('error', error => compressed.destroy(error));
  try { for await (const chunk of compressed) yield pngChunk('IDAT', chunk); }
  finally { source.destroy(); compressed.destroy(); }
}
function pdf() {
  const content = 'BT /F1 18 Tf 50 750 Td (Rio synthetic upload fixture) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let text = '%PDF-1.4\n', offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n`;
  return Buffer.from(text);
}
async function* contents(generate, maxSize, signal) {
  if (generate.kind === 'image') { yield* png(generate, maxSize, signal); return; }
  if (generate.kind === 'pdf') { yield pdf(); return; }
  if (['csv', 'json'].includes(generate.kind)) {
    const rows = generate.rows || 20;
    if (rows > maxSize) throw failure('rows', 'seed_too_large', { bytes: rows, max_bytes: maxSize });
    yield Buffer.from(generate.kind === 'csv' ? 'id,name,email\n' : '[');
    for (let start = 0; start < rows; start += 1000) {
      signal?.throwIfAborted(); let text = '';
      for (let index = start; index < Math.min(start + 1000, rows); index++) text += generate.kind === 'csv'
        ? `${index + 1},Person ${index + 1},person${index + 1}@example.test\n`
        : `${index ? ',' : ''}${JSON.stringify({ id: index + 1, name: `Person ${index + 1}` })}`;
      yield Buffer.from(text);
    }
    if (generate.kind === 'json') yield Buffer.from(']\n');
  }
}

/** App-only generator. Writes are bounded and streamed; no model or host path
 * participates. SeedRuntime captures this directory with the files adapter. */
export class FixtureFiles {
  constructor({ root, files = [], maxSize = 2 * 1024 ** 3 }) { this.root = root; this.files = new Map(files.map(file => [file.name, file])); this.maxSize = maxSize; }
  async path(file, mustExist = true) {
    const root = await realpath(this.root), target = resolve(root, file.generate ? `${generatedFixturePath}/${generatedName(file)}` : file.path);
    const safe = path => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith(sep); };
    if (!safe(target)) throw failure(file.name);
    if (mustExist && !safe(await realpath(target))) throw failure(file.name);
    return target;
  }
  async generate({ signal } = {}) {
    let total = 0;
    for (const file of this.files.values()) if (file.generate) {
      const generate = file.generate;
      signal?.throwIfAborted();
      if (!/^[a-z][a-z0-9-]*$/.test(file.name) || !extensions[generate.kind]) throw failure(file.name);
      if (generate.size && generate.size > this.maxSize - total) throw failure(file.name, 'seed_too_large', { bytes: total + generate.size, max_bytes: this.maxSize });
      const path = await this.path(file, false);
      // The files adapter has already checked and created this directory.
      const directory = await realpath(resolve(this.root, generatedFixturePath));
      if (resolve(directory, basename(path)) !== path) throw failure(file.name);
      await rm(path, { force: true });
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let bytes = 0;
      const write = async data => {
        signal?.throwIfAborted(); bytes += data.length; total += data.length;
        if (total > this.maxSize) throw failure(file.name, 'seed_too_large', { bytes: total, max_bytes: this.maxSize });
        await handle.writeFile(data);
      };
      try {
        for await (const chunk of contents(generate, this.maxSize - total, signal)) await write(chunk);
        const end = generate.kind === 'image' ? pngChunk('IEND', Buffer.alloc(0)) : generate.kind === 'pdf' ? Buffer.from('%%EOF\n') : Buffer.alloc(0);
        const size = generate.size || (['text', 'binary'].includes(generate.kind) ? 1024 : 0);
        while (bytes + end.length < size) {
          const padding = Buffer.alloc(Math.min(65536, size - bytes - end.length), generate.kind === 'binary' ? 0 : 32);
          await write(generate.kind === 'image' ? pngChunk('tEXt', Buffer.concat([Buffer.from('Rio\0'), padding])) : padding);
        }
        await write(end); await handle.sync();
      } finally { await handle.close(); }
    }
  }
  async open(name) {
    const file = this.files.get(name); if (!file) throw failure(name);
    const path = await this.path(file), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > (file.generate ? this.maxSize : 1024 ** 2)) throw failure(name);
      const filename = file.generate ? generatedName(file) : basename(path);
      return { handle, bytes: info.size, filename, mimeType: media[filename.split('.').at(-1)] || 'application/octet-stream' };
    } catch (error) { await handle.close(); throw error; }
  }
}
