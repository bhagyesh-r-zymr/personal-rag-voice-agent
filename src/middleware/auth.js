import { config } from '../config.js';
import { getUserForSession } from '../services/auth.js';

export const SESSION_COOKIE = 'policy_session';

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function sessionTokenFrom(req) {
  return readCookie(req.headers?.cookie, SESSION_COOKIE);
}

// Resolves the signed-in user from the session cookie (used by HTTP routes and the voice WebSocket).
export function userFromRequest(req) {
  return getUserForSession(sessionTokenFrom(req));
}

export function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/',
    expires: expiresAt
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' });
}

export function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  req.user = user;
  return next();
}

export function requireRole(...roles) {
  return (req, res, next) =>
    requireAuth(req, res, () => {
      if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this.' });
      return next();
    });
}
