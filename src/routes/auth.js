import express from 'express';
import {
  authenticate,
  createSession,
  createUser,
  deleteSession,
  deleteUser,
  listUsers,
  updateUser,
  verifyPassword
} from '../services/auth.js';
import { getDb } from '../db.js';
import {
  clearSessionCookie,
  requireAuth,
  requireRole,
  sessionTokenFrom,
  setSessionCookie
} from '../middleware/auth.js';

export const authRouter = express.Router();

// Simple in-memory brute-force guard: too many failed logins for one email+IP locks it out briefly.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

function failureKey(req, email) {
  return `${req.ip}|${String(email || '').trim().toLowerCase()}`;
}

function isLockedOut(key) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
}

async function handle(res, next, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return next(error);
  }
}

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const key = failureKey(req, email);
    if (isLockedOut(key)) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in a few minutes.' });
    }

    const user = await authenticate(email, password);
    if (!user) {
      recordFailure(key);
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    failures.delete(key);
    const { token, expiresAt } = createSession(user.id);
    setSessionCookie(res, token, expiresAt);
    return res.json({ user });
  } catch (error) {
    return next(error);
  }
});

authRouter.post('/auth/logout', (req, res) => {
  deleteSession(sessionTokenFrom(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post('/auth/password', requireAuth, (req, res, next) =>
  handle(res, next, async () => {
    const { currentPassword, newPassword } = req.body || {};
    const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(currentPassword, row?.password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    await updateUser(req.user.id, { password: newPassword });
    // Changing the password signs out every session, so start a fresh one here.
    const { token, expiresAt } = createSession(req.user.id);
    setSessionCookie(res, token, expiresAt);
    return res.json({ ok: true });
  })
);

// Admin-only user management.
const adminOnly = requireRole('admin');

function userId(req) {
  return Number.parseInt(req.params.userId, 10);
}

authRouter.get('/users', adminOnly, (req, res) => {
  res.json({ users: listUsers() });
});

authRouter.post('/users', adminOnly, (req, res, next) =>
  handle(res, next, async () => {
    const { email, name, password, role } = req.body || {};
    const user = await createUser({ email, name, password, role });
    return res.status(201).json({ user });
  })
);

authRouter.patch('/users/:userId', adminOnly, (req, res, next) =>
  handle(res, next, async () => {
    const { name, role, password } = req.body || {};
    const user = await updateUser(userId(req), { name, role, password });
    return res.json({ user });
  })
);

authRouter.delete('/users/:userId', adminOnly, (req, res, next) =>
  handle(res, next, async () => {
    if (userId(req) === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account.' });
    deleteUser(userId(req));
    return res.json({ ok: true });
  })
);
