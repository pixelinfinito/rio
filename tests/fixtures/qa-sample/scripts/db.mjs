import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
export function database() {
  const path = process.env.DATABASE_URL || 'data/shop.sqlite';
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
export function checkPassword(password, hash) {
  if (!hash) return false;
  const [salt, expected] = hash.split(':');
  const actual = scryptSync(password, salt, 32);
  const bytes = Buffer.from(expected, 'hex');
  return bytes.length === actual.length && timingSafeEqual(bytes, actual);
}
