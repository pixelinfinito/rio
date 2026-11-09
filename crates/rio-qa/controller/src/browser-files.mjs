import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Browser-side file staging. Only controller can reach this listener through
 * the pod firewall. Its API has no path argument and never reads arbitrary files. */
export async function browserFiles({ port = 9226, host = '0.0.0.0', maxBytes = 2 * 1024 ** 3 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid fixture staging quota');
  const directory = await mkdtemp(join(tmpdir(), 'rio-browser-fixtures-'));
  let bytes = 0, reserved = 0, busy = 0, clearing = false, closing;
  const server = createServer(async (request, response) => {
    const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url === '/fixtures' && request.method === 'DELETE') {
      if (busy || clearing) return reply(409, { error: 'fixture_upload_in_progress' });
      clearing = true;
      try {
        for (const file of await readdir(directory)) await rm(join(directory, file), { recursive: true, force: true });
        bytes = 0; return reply(200, { cleared: true });
      } catch { return reply(500, { error: 'fixture_cleanup_failed' }); }
      finally { clearing = false; }
    }
    const match = /^\/fixtures\/([a-z][a-z0-9-]*)$/.exec(request.url);
    const size = Number(request.headers['content-length']);
    if (clearing) return reply(409, { error: 'fixture_cleanup_in_progress' });
    if (request.method !== 'PUT' || !match || !Number.isSafeInteger(size) || size < 0) return reply(400, { error: 'invalid_fixture_upload' });
    if (bytes + reserved + size > maxBytes) return reply(413, { error: 'fixture_quota_exceeded' });
    let filename; try { if (typeof request.headers['rio-fixture-filename'] === 'string') filename = decodeURIComponent(request.headers['rio-fixture-filename']); } catch {}
    if (!filename || filename === '.' || filename === '..' || /[/\\\0\r\n]/.test(filename) || Buffer.byteLength(filename) > 255) return reply(400, { error: 'invalid_fixture_upload' });
    const folder = join(directory, randomUUID()), path = join(folder, filename);
    reserved += size; busy++;
    let handle, length = 0;
    request.setTimeout(120000, () => request.destroy());
    try {
      await mkdir(folder, { mode: 0o700 });
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      for await (const chunk of request) { length += chunk.length; if (length > size) throw new Error('Invalid upload size'); await handle.writeFile(chunk); }
      if (length !== size) throw new Error('Incomplete upload');
      await handle.sync(); bytes += size;
      reply(200, { name: match[1], bytes: size, path });
    } catch {
      await rm(folder, { recursive: true, force: true });
      if (!response.headersSent && !response.destroyed) reply(400, { error: 'invalid_fixture_upload' });
    } finally { await handle?.close(); reserved -= size; busy--; }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
  return { url: `http://${host}:${server.address().port}`, directory, close() { return closing ||= (async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); })(); } };
}
