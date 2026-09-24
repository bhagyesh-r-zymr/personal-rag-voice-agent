import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the shared database at a throwaway file before any app module loads config.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

const { default: express } = await import('express');
const { authRouter } = await import('../src/routes/auth.js');
const { apiRouter } = await import('../src/routes/api.js');
const auth = await import('../src/services/auth.js');
const { canReadDocument, parseAllowedRoles, retrievalFilter } = await import('../src/services/access.js');
const { saveDocument } = await import('../src/services/documentStore.js');
const { closeDb } = await import('../src/db.js');

let server;
let base;
const silent = { log() {}, warn() {} };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', authRouter);
  app.use('/api', apiRouter);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;

  await auth.seedAdmin({ email: 'Admin@Example.com', password: 'admin-pass-1', logger: silent });
  await auth.createUser({ email: 'emp@example.com', password: 'employee-pass', role: 'employee' });
  await auth.createUser({ email: 'mgr@example.com', password: 'manager-pass', role: 'manager' });
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, { body, cookie } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') };
}

async function login(email, password) {
  const res = await call('POST', '/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.setCookie.split(';')[0];
}

test('passwords are hashed with a salt and verified', async () => {
  const a = await auth.hashPassword('secret-123');
  const b = await auth.hashPassword('secret-123');
  assert.notEqual(a, b);
  assert.ok(!a.includes('secret-123'));
  assert.equal(await auth.verifyPassword('secret-123', a), true);
  assert.equal(await auth.verifyPassword('wrong', a), false);
});

test('seedAdmin creates the first admin once from env-style settings', async () => {
  assert.equal(await auth.seedAdmin({ email: 'other@example.com', password: 'whatever-123', logger: silent }), null);
  const admins = auth.listUsers().filter((u) => u.role === 'admin');
  assert.deepEqual(admins.map((u) => u.email), ['admin@example.com']);
});

test('login sets an httpOnly cookie and /auth/me returns the user', async () => {
  const res = await call('POST', '/auth/login', { body: { email: 'ADMIN@example.com', password: 'admin-pass-1' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
  assert.equal(res.body.user.password_hash, undefined);
  assert.match(res.setCookie, /policy_session=.+; .*HttpOnly/i);
  assert.match(res.setCookie, /SameSite=Lax/i);

  const me = await call('GET', '/auth/me', { cookie: res.setCookie.split(';')[0] });
  assert.equal(me.body.user.email, 'admin@example.com');
});

test('wrong password and signed-out requests are rejected', async () => {
  assert.equal((await call('POST', '/auth/login', { body: { email: 'emp@example.com', password: 'nope' } })).status, 401);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'nope' } })).status, 401);
  assert.equal((await call('GET', '/auth/me')).status, 401);
  assert.equal((await call('GET', '/documents')).status, 401);
  assert.equal((await call('POST', '/chat', { body: { sessionId: 'x', message: 'hi' } })).status, 401);
  assert.equal((await call('GET', '/live-config')).status, 401);
  assert.equal((await call('GET', '/auth/me', { cookie: 'policy_session=forged' })).status, 401);
});

test('repeated failed logins are locked out', async () => {
  await auth.createUser({ email: 'target@example.com', password: 'target-pass-1' });
  for (let i = 0; i < 10; i += 1) {
    await call('POST', '/auth/login', { body: { email: 'target@example.com', password: 'bad' } });
  }
  const res = await call('POST', '/auth/login', { body: { email: 'target@example.com', password: 'target-pass-1' } });
  assert.equal(res.status, 429);
});

test('logout ends the session', async () => {
  const cookie = await login('emp@example.com', 'employee-pass');
  assert.equal((await call('POST', '/auth/logout', { cookie })).status, 200);
  assert.equal((await call('GET', '/auth/me', { cookie })).status, 401);
});

test('expired sessions are refused', async () => {
  const user = auth.listUsers().find((u) => u.email === 'emp@example.com');
  const { token } = auth.createSession(user.id, -1);
  assert.equal(auth.getUserForSession(token), null);
});

test('only admins can upload or remove policies and manage users', async () => {
  for (const [email, password] of [
    ['emp@example.com', 'employee-pass'],
    ['mgr@example.com', 'manager-pass']
  ]) {
    const cookie = await login(email, password);
    assert.equal((await call('POST', '/upload-handbook', { cookie })).status, 403);
    assert.equal((await call('DELETE', '/documents/hr', { cookie })).status, 403);
    assert.equal((await call('GET', '/users', { cookie })).status, 403);
  }

  const admin = await login('admin@example.com', 'admin-pass-1');
  assert.equal((await call('POST', '/upload-handbook', { cookie: admin })).status, 400); // no file, but allowed
  const users = await call('GET', '/users', { cookie: admin });
  assert.ok(users.body.users.some((u) => u.email === 'mgr@example.com'));
});

test('admins can add users, change roles and reset passwords', async () => {
  const admin = await login('admin@example.com', 'admin-pass-1');
  const created = await call('POST', '/users', {
    cookie: admin,
    body: { email: 'new@example.com', name: 'New', password: 'new-pass-123', role: 'employee' }
  });
  assert.equal(created.status, 201);
  const id = created.body.user.id;

  assert.equal((await call('POST', '/users', { cookie: admin, body: { email: 'new@example.com', password: 'x'.repeat(8) } })).status, 409);
  assert.equal((await call('POST', '/users', { cookie: admin, body: { email: 'bad@example.com', password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/users', { cookie: admin, body: { email: 'r@example.com', password: 'x'.repeat(8), role: 'boss' } })).status, 400);

  const userCookie = await login('new@example.com', 'new-pass-123');
  const promoted = await call('PATCH', `/users/${id}`, { cookie: admin, body: { role: 'manager', password: 'reset-pass-1' } });
  assert.equal(promoted.body.user.role, 'manager');
  // A password reset signs the user out.
  assert.equal((await call('GET', '/auth/me', { cookie: userCookie })).status, 401);
  await login('new@example.com', 'reset-pass-1');

  assert.equal((await call('DELETE', `/users/${id}`, { cookie: admin })).status, 200);
});

test('the last admin cannot be demoted or removed', async () => {
  const admin = await login('admin@example.com', 'admin-pass-1');
  const me = (await call('GET', '/auth/me', { cookie: admin })).body.user;
  assert.equal((await call('PATCH', `/users/${me.id}`, { cookie: admin, body: { role: 'employee' } })).status, 400);
  assert.equal((await call('DELETE', `/users/${me.id}`, { cookie: admin })).status, 400);
});

test('users can change their own password', async () => {
  await auth.createUser({ email: 'self@example.com', password: 'self-pass-1' });
  const cookie = await login('self@example.com', 'self-pass-1');
  const wrong = await call('POST', '/auth/password', { cookie, body: { currentPassword: 'nope', newPassword: 'self-pass-2' } });
  assert.equal(wrong.status, 400);
  const ok = await call('POST', '/auth/password', { cookie, body: { currentPassword: 'self-pass-1', newPassword: 'self-pass-2' } });
  assert.equal(ok.status, 200);
  await login('self@example.com', 'self-pass-2');
});

test('allowed roles always include admin and default to everyone', () => {
  assert.deepEqual(parseAllowedRoles(), ['admin', 'manager', 'employee']);
  assert.deepEqual(parseAllowedRoles('manager'), ['admin', 'manager']);
  assert.deepEqual(parseAllowedRoles(['Employee', ' manager ']), ['admin', 'manager', 'employee']);
  assert.throws(() => parseAllowedRoles('contractor'), /Unknown role/);
});

test('retrieval is filtered by role and admins see everything', () => {
  assert.equal(retrievalFilter('admin'), null);
  assert.deepEqual(retrievalFilter('employee'), { allowedRoles: { $in: ['employee'] } });
  assert.equal(canReadDocument({ allowedRoles: ['admin', 'manager'] }, 'employee'), false);
  assert.equal(canReadDocument({ allowedRoles: ['admin', 'manager'] }, 'manager'), true);
  assert.equal(canReadDocument({}, 'employee'), false);
  assert.equal(canReadDocument({}, 'admin'), true);
});

test('the document list only shows policies the role may read', async () => {
  const at = new Date().toISOString();
  await saveDocument({ docId: 'handbook', name: 'Handbook.pdf', indexedAt: at, allowedRoles: ['admin', 'manager', 'employee'] });
  await saveDocument({ docId: 'comp', name: 'Manager Comp.pdf', indexedAt: at, allowedRoles: ['admin', 'manager'] });

  const names = async (email, password) =>
    (await call('GET', '/documents', { cookie: await login(email, password) })).body.documents.map((d) => d.docId).sort();
  assert.deepEqual(await names('emp@example.com', 'employee-pass'), ['handbook']);
  assert.deepEqual(await names('mgr@example.com', 'manager-pass'), ['comp', 'handbook']);
  assert.deepEqual(await names('admin@example.com', 'admin-pass-1'), ['comp', 'handbook']);
});
