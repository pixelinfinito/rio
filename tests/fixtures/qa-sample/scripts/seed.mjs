import { readFileSync } from 'node:fs';
import { database, passwordHash } from './db.mjs';
const db = database();
const persona = process.argv[2];
if (persona) {
  if (!['shopper', 'admin'].includes(persona)) throw new Error('Unknown seed persona');
  const prefix = `QA_${persona.toUpperCase()}`;
  const email = process.env[`${prefix}_USERNAME`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!email || !password) throw new Error(`Missing ${prefix} credential environment variables`);
  db.prepare('UPDATE users SET email=?, password_hash=? WHERE persona=?').run(email, passwordHash(password), persona);
} else {
  // Capture this state before credential apply: no credential or session in the seed.
  db.exec(readFileSync(new URL('../.rio/qa/seed/schema.sql', import.meta.url), 'utf8'));
  db.exec('UPDATE users SET password_hash=NULL; DELETE FROM sessions; DELETE FROM cart; DELETE FROM orders; DELETE FROM verifications;');
}
db.close();
