import { mkdir, lstat, realpath, open, rename, rm, mkdtemp, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { Sanitizer } from './sanitize.mjs';
import { sanitizeTrace } from './trace.mjs';

const exec = promisify(execFile);
const hash = bytes => Buffer.from(blake3(bytes)).toString('hex');
const component = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid evidence path component'); return value; };
const formats = { screenshot: 'png', dom: 'json', accessibility: 'json', console: 'jsonl', network: 'jsonl', capture: 'jsonl', trace: 'zip', replay: 'jsonl', transcript: 'jsonl', video: 'webm', probe: 'json' };
const optional = new Set(['trace', 'video']);
const relativeKey = key => {
  if (typeof key !== 'string' || !key || key.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error('Invalid evidence key');
  return key;
};

async function privateDirectories(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) throw new Error('Evidence path escape');
  let directory = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Evidence directories must not be symlinks');
  }
}

/** The runner supplies this trusted cache root while holding its run/prune
 * lease. No repository or harness value can select an arbitrary output path. */
export class LocalEvidenceSink {
  static async create({ cacheRoot, reviewId, runId, repositoryRoot }) {
    const root = resolve(cacheRoot);
    if (repositoryRoot) {
      const rel = relative(resolve(repositoryRoot), root);
      if (!rel || rel === '.git' || rel.startsWith('.git' + sep)) throw new Error('Evidence cannot replace repository metadata');
      if (!rel.startsWith('..' + sep) && rel !== '..') {
        const { stdout } = await exec('git', ['ls-files', '-z', '--', rel], { cwd: repositoryRoot });
        if (stdout) throw new Error('Evidence cache contains tracked paths');
      }
    }
    // Check every component, including ancestors of a custom cache directory.
    await privateDirectories(resolve(sep), root);
    const sink = new LocalEvidenceSink(await realpath(root), component(reviewId), component(runId));
    await sink.atomic('.gitignore', Buffer.from('*\n'));
    await privateDirectories(sink.root, sink.directory);
    return sink;
  }
  constructor(root, reviewId, runId) { this.root = root; this.directory = join(root, reviewId, 'runs', runId, 'qa'); }
  async atomic(path, bytes) {
    const target = resolve(this.root, path);
    await privateDirectories(this.root, dirname(target));
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Evidence target must not be a symlink'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = target + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    return target;
  }
  async put(key, bytes) { return { storage: 'local', link: await this.atomic(relative(this.root, join(this.directory, relativeKey(key))), bytes) }; }
  async manifest(value) { await this.put('manifest.json', Buffer.from(JSON.stringify(value, null, 2))); }
}

/** Upload callbacks are minted by the runner for one run's namespace. They are
 * never supplied by repository configuration or evaluated from browser data. */
export class HostedEvidenceSink {
  constructor({ tenant, reviewId, runId, upload }) { this.prefix = `qa/${component(tenant)}/${component(reviewId)}/${component(runId)}/`; this.upload = upload; }
  async put(key, bytes, metadata) { const object = this.prefix + relativeKey(key); const result = await this.upload(object, bytes, metadata); return { storage: 'hosted', key: object, ...result }; }
  async manifest(value) { await this.put('manifest.json', Buffer.from(JSON.stringify(value))); }
}

export class EvidenceWriter {
  constructor({ sink, sanitizer = new Sanitizer(), maxBytes = 512 * 1024 * 1024 }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid evidence quota');
    this.sink = sink; this.sanitizer = sanitizer; this.maxBytes = maxBytes; this.bytes = 0; this.artifacts = []; this.notes = []; this.queue = Promise.resolve();
  }
  get manifest() { return { version: 1, hash_algorithm: 'blake3', bytes: this.bytes, quota_bytes: this.maxBytes, quota_reached: this.bytes >= this.maxBytes || this.notes.some(note => note.reason === 'evidence_quota_reached'), artifacts: this.artifacts, notes: this.notes }; }
  async note(reason, metadata) { this.notes.push({ reason, ...metadata }); await this.sink.manifest(this.manifest); }
  write(kind, value, metadata) {
    const operation = this.queue.then(() => this.put(kind, value, metadata));
    this.queue = operation.catch(() => {}); return operation;
  }
  async put(kind, value, { journey, step, cell, masked = false }) {
    const extension = formats[kind]; if (!extension) throw new Error('Unknown QA evidence kind');
    component(journey); component(cell.viewport); if (!['light', 'dark'].includes(cell.color_scheme)) throw new Error('Invalid evidence color scheme');
    if (step !== undefined && (!Number.isSafeInteger(step) || step < 1)) throw new Error('Invalid evidence step');
    let bytes;
    if (kind === 'trace') {
      const sanitized = sanitizeTrace(value, this.sanitizer);
      if (sanitized.dropped) { await this.note(sanitized.dropped, { journey, cell, stage: 'trace_sanitization', failure: sanitized.failure }); return null; }
      bytes = sanitized.bytes;
    } else if (kind === 'screenshot' || kind === 'video') {
      if (!masked) throw new Error('Unmasked visual evidence refused');
      bytes = Buffer.from(value);
    } else {
      const rows = Array.isArray(value) ? value : [value];
      bytes = Buffer.from(extension === 'jsonl' ? rows.map(row => JSON.stringify(kind === 'network' ? this.sanitizer.network(row) : this.sanitizer.value(row))).join('\n') + '\n' : JSON.stringify(this.sanitizer.value(value)));
    }
    const content_hash = hash(bytes), name = `${step === undefined ? 'cell' : `step-${String(step).padStart(4, '0')}`}-${kind}-${content_hash.slice(0, 16)}.${extension}`;
    const key = `${journey}/${cell.viewport}-${cell.color_scheme}/${name}`;
    const id = hash(Buffer.from(JSON.stringify([key, content_hash])));
    const existing = this.artifacts.find(artifact => artifact.id === id);
    if (existing) { await this.sink.manifest(this.manifest); return existing; }
    if (optional.has(kind) && this.bytes + bytes.length > this.maxBytes) { await this.note('evidence_quota_reached', { journey, cell, dropped: kind }); return null; }
    const descriptor = { id, content_hash, bytes: bytes.length, kind, journey, ...(step === undefined ? {} : { step }), cell: { viewport: cell.viewport, color_scheme: cell.color_scheme }, sanitized: true };
    let stored;
    try { stored = await this.sink.put(key, bytes, descriptor); }
    catch (error) {
      if (optional.has(kind) && error.code === 'evidence_quota_reached') { await this.note('evidence_quota_reached', { journey, cell, dropped: kind }); return null; }
      throw error;
    }
    const artifact = { ...descriptor, ...stored };
    this.bytes += bytes.length; this.artifacts.push(artifact);
    // Mandatory step evidence survives quota exhaustion, as specified. The
    // footer reports actual retained bytes; future traces/videos are omitted.
    await this.sink.manifest(this.manifest); return artifact;
  }
}

/** Browser-independent step capture shared by both harness drivers. */
export class EvidenceCollector {
  constructor(browser, writer) { this.browser = browser; this.writer = writer; this.consoleOffset = 0; this.networkOffset = 0; this.steps = new Set(); }
  async step({ journey, step, cell, page = this.browser.page, messages = [] }) {
    const key = JSON.stringify([journey, step, cell]); if (this.steps.has(key)) throw new Error('Evidence step already captured');
    await this.browser.controls.ready(); await this.browser.flushNetwork?.();
    // Masked values also disappear from textual accessibility and trace
    // artifacts; opacity alone only protects the visual recording.
    for (const frame of page.frames()) this.writer.sanitizer.add(await frame.evaluate(() => {
      const values = [], visit = root => {
        for (const element of root.querySelectorAll('*')) {
          if (element.matches('input[type=password],[data-rio-mask]')) values.push(element.value || '', element.textContent || '', element.getAttribute('aria-label') || '');
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(document); return values;
    }));
    const metadata = { journey, step, cell }, evidence = [];
    const save = async (kind, value, extra = {}) => { const artifact = await this.writer.write(kind, value, { ...metadata, ...extra }); if (artifact) evidence.push(artifact); return artifact; };
    await save('screenshot', await page.screenshot({ animations: 'disabled' }), { masked: this.browser.visualMasking === true });
    const frames = [];
    for (const frame of page.frames()) frames.push(await frame.evaluate(() => {
      const node = (element, masked = false) => {
        if (element.nodeType === Node.TEXT_NODE) return masked ? '[redacted]' : element.textContent;
        if (element.nodeType !== Node.ELEMENT_NODE) return null;
        masked ||= element.matches('input[type=password],[data-rio-mask]');
        return { tag: element.localName, attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, masked && /value|label|title|alt/i.test(attribute.name) ? '[redacted]' : attribute.value])),
          ...(element.matches('input,textarea,select') ? { value: masked ? '[redacted]' : element.value } : {}),
          children: [...element.childNodes].map(child => node(child, masked)).filter(child => child !== null),
          ...(element.shadowRoot ? { shadow: [...element.shadowRoot.childNodes].map(child => node(child, masked)).filter(child => child !== null) } : {}) };
      };
      return { url: location.href, document: node(document.documentElement) };
    }));
    await save('dom', { frames });
    await save('accessibility', { tree: await page.locator('body').ariaSnapshot() });
    const consoleRows = this.browser.consoleEvents.slice(this.consoleOffset), networkRows = this.browser.networkEvents.slice(this.networkOffset);
    await save('console', consoleRows); await save('network', networkRows); await save('capture', messages);
    this.consoleOffset += consoleRows.length; this.networkOffset += networkRows.length; this.steps.add(key);
    return { evidence: evidence.map(artifact => artifact.id), screenshot: evidence.find(artifact => artifact.kind === 'screenshot').id, dom: evidence.find(artifact => artifact.kind === 'dom').id };
  }
  async finish({ journey, journeys = [journey], cell, transcript = [] }) {
    let closed = false;
    try {
      const directory = await mkdtemp(join(tmpdir(), 'rio-private-trace-'));
      let trace;
      try {
        const path = join(directory, 'raw.zip');
        try { await this.browser.context.tracing.stop({ path }); trace = await readFile(path); }
        catch { for (const name of journeys) await this.writer.note('evidence_unsanitized', { journey: name, cell, stage: 'trace_capture' }); }
      } finally { await rm(directory, { recursive: true, force: true }); }
      const videos = this.browser.context.pages().map(page => page.video()).filter(Boolean);
      for (const name of journeys) {
        const metadata = { journey: name, cell };
        if (trace) await this.writer.write('trace', trace, metadata);
        // Dependents need prerequisite events for deterministic replay.
        await this.writer.write('replay', this.browser.replayEvents, metadata);
        await this.writer.write('transcript', transcript, metadata);
      }
      await this.browser.close({ retainVideo: true }); closed = true;
      for (const name of journeys) for (const video of videos) await this.writer.write('video', await readFile(await video.path()), { journey: name, cell, masked: this.browser.visualMasking === true });
      return this.writer.manifest;
    } finally {
      try { if (!closed) await this.browser.close(); }
      finally { await this.browser.disposeVideo(); }
    }
  }
}
