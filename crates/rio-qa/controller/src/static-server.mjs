import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const root = await realpath(process.argv[2]);
const port = Number(process.argv[3]);
if (!(await stat(root)).isDirectory() || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid static application configuration');
const inside = path => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  try {
    let file = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://app').pathname));
    if (!inside(file)) throw new Error('Outside static root');
    try { if (!(await stat(file)).isFile()) file = resolve(root, 'index.html'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; file = resolve(root, 'index.html'); }
    file = await realpath(file);
    if (!inside(file)) throw new Error('Outside static root');
    response.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(port, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
