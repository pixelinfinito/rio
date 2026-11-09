import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('bootstrap rejects host-file injection and reserved controller routes', () => {
  const source = fileURLToPath(new URL('../../../../worker/qa/entrypoint.py', import.meta.url));
  const code = `import importlib.util,sys\ns=importlib.util.spec_from_file_location('entry',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\nassert m.claims({'claims':['payments.example.test']}) == ['payments.example.test']\nfor value in ['bad\\n127.0.0.1 controller','controller','host.docker.internal','-invalid','host:8443']:\n try: m.claims({'claims':[value]})\n except ValueError: continue\n raise AssertionError('accepted invalid claim')\n`;
  const result = spawnSync('python3', ['-c', code, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
