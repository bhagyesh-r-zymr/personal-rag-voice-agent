import crypto from 'crypto';
import { promisify } from 'util';
import { getDb } from '../db.js';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt);

// employee: ask questions. manager: ask questions, sees manager-only policies.
// admin: everything, plus managing policy documents and users.
export const ROLES = ['admin', 'manager', 'employee'];
export const MIN_PASSWORD_LENGTH = 8;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

let initialized = false;

function db() {
  const database = getDb();
  if (!initialized) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
    `);
    initialized = true;
  }
  return database;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function toPublicUser(row) {
  return row ? { id: row.id, email: row.email, name: row.name, role: row.role, createdAt: row.created_at } : null;
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) throw httpError(400, 'A valid email is required.');
  return value;
}

function checkRole(role) {
  if (!ROLES.includes(role)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}.`);
  return role;
}

function checkPassword(password) {
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return String(password);
}

export async function createUser({ email, name = '', password, role = 'employee' }) {
  const normalized = normalizeEmail(email);
  checkRole(role);
  const hash = await hashPassword(checkPassword(password));
  if (db().prepare('SELECT 1 FROM users WHERE email = ?').get(normalized)) {
    throw httpError(409, 'A user with that email already exists.');
  }
  const { lastInsertRowid } = db()
    .prepare('INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(normalized, String(name).trim(), role, hash, new Date().toISOString());
  return getUser(Number(lastInsertRowid));
}

export function getUser(id) {
  return toPublicUser(db().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function listUsers() {
  return db().prepare('SELECT * FROM users ORDER BY email').all().map(toPublicUser);
}

function adminCount() {
  return db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

export async function updateUser(id, { name, role, password }) {
  const user = getUser(id);
  if (!user) throw httpError(404, 'User not found.');

  if (role !== undefined && role !== user.role) {
    checkRole(role);
    if (user.role === 'admin' && adminCount() <= 1) throw httpError(400, 'The last admin cannot be demoted.');
    db().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  if (name !== undefined) db().prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), id);
  if (password !== undefined) {
    const hash = await hashPassword(checkPassword(password));
    db().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    // A password reset signs the user out everywhere.
    db().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
  }
  return getUser(id);
}

export function deleteUser(id) {
  const user = getUser(id);
  if (!user) throw httpError(404, 'User not found.');
  if (user.role === 'admin' && adminCount() <= 1) throw httpError(400, 'The last admin cannot be removed.');
  db().prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

// Returns the user for a correct email and password, else null.
export async function authenticate(email, password) {
  const row = db().prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  // Hash anyway for unknown emails so response time doesn't reveal which emails exist.
  const ok = await verifyPassword(password, row?.password_hash || (await dummyHash()));
  return row && ok ? toPublicUser(row) : null;
}

let cachedDummyHash = null;
async function dummyHash() {
  cachedDummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
  return cachedDummyHash;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Only the token's hash is stored, so a leaked database can't be used to sign in.
export function createSession(userId, ttlHours = config.sessionTtlHours) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  db()
    .prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, expiresAt.toISOString());
  return { token, expiresAt };
}

export function getUserForSession(token) {
  if (!token) return null;
  const row = db()
    .prepare(
      `SELECT u.*, s.expires_at FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
    )
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    deleteSession(token);
    return null;
  }
  return toPublicUser(row);
}

export function deleteSession(token) {
  if (token) db().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
}

export function deleteExpiredSessions() {
  db().prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

// Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when no admin exists yet.
export async function seedAdmin({ email = config.adminEmail, password = config.adminPassword, logger = console } = {}) {
  if (adminCount() > 0) return null;
  if (!email || !password) {
    logger.warn('No admin user exists. Set ADMIN_EMAIL and ADMIN_PASSWORD to create one on startup.');
    return null;
  }
  const existing = db().prepare('SELECT id FROM users WHERE email = ?').get(normalizeEmail(email));
  if (existing) return updateUser(existing.id, { role: 'admin' });
  const user = await createUser({ email, name: 'Admin', password, role: 'admin' });
  logger.log(`Created admin user ${user.email}.`);
  return user;
}
