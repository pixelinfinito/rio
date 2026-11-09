import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { browserFiles } from '../src/browser-files.mjs';

test('browser staging preserves filenames, enforces quota and admits no host paths or reads', async t => {
  const files = await browserFiles({ host: '127.0.0.1', port: 0, maxBytes: 12 }); t.after(() => files.close());
  const put = (name, filename, body) => fetch(files.url + '/fixtures/' + name, { method: 'PUT', headers: { 'rio-fixture-filename': encodeURIComponent(filename) }, body });
  const result = await (await put('contacts', 'my contacts.csv', 'hello')).json();
  assert.equal(result.name, 'contacts'); assert.equal(result.bytes, 5); assert.ok(result.path.endsWith('/my contacts.csv'));
  assert.equal(await readFile(result.path, 'utf8'), 'hello');
  assert.equal((await fetch(files.url + '/fixtures/contacts')).status, 400);
  assert.equal((await put('contacts', '../escape', 'x')).status, 400);
  assert.equal((await put('contacts', '/etc/passwd', 'x')).status, 400);
  assert.equal((await put('contacts', 'big.csv', '123456789')).status, 413);
  assert.equal((await fetch(files.url + '/fixtures', { method: 'DELETE' })).status, 200);
  await assert.rejects(access(result.path));
  assert.equal((await put('contacts', 'big.csv', '123456789')).status, 200);
});
