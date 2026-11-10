import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { services } from './test-services.mjs';
const directory = mkdtempSync(join(tmpdir(), 'rio-qa-fixture-'));
const env = { ...process.env, DATABASE_URL: join(directory, 'shop.sqlite'),
  QA_SHOPPER_USERNAME: 'shopper@example.test', QA_SHOPPER_PASSWORD: 'synthetic-shopper-123',
  QA_ADMIN_USERNAME: 'admin@example.test', QA_ADMIN_PASSWORD: 'synthetic-admin-123',
  PAYMENTS_API_BASE: 'http://127.0.0.1:4180', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525' };
for (const args of [[], ['shopper'], ['admin']]) {
  const result = spawnSync(process.execPath, ['scripts/seed.mjs', ...args], { env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const doubles = await services();
const app = spawn(process.execPath, ['server.mjs'], { env, stdio: 'inherit' });
const stop = () => app.kill('SIGTERM');
process.on('SIGTERM', stop); process.on('SIGINT', stop);
app.on('exit', code => { doubles.close(); rmSync(directory, { recursive: true, force: true }); process.exit(code || 0); });
