import { getDb } from '../db.js';

// Chat history lives in the shared SQLite database so conversations survive
// restarts. A session belongs to a user once login exists (user_id); until
// then user_id is NULL and the session is reachable by its unguessable id.
const TITLE_LENGTH = 80;
const initialized = new WeakSet();

function db() {
  const conn = getDb();
  if (!initialized.has(conn)) {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_sessions_user_updated ON chat_sessions (user_id, updated_at);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        citations TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages (session_id, id);
    `);
    initialized.add(conn);
  }
  return conn;
}

function toSession(row) {
  return {
    id: row.id,
    userId: row.user_id ?? null,
    title: row.title || 'New chat',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessage(row) {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    citations: JSON.parse(row.citations || '[]'),
    ts: row.created_at
  };
}

function titleFrom(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > TITLE_LENGTH ? `${clean.slice(0, TITLE_LENGTH - 1)}…` : clean;
}

// A signed-in user sees only their own sessions; an anonymous caller sees only
// sessions that no user owns.
function canAccess(row, userId) {
  return (row.user_id ?? null) === (userId ?? null);
}

function findRow(sessionId, userId) {
  const row = db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
  return row && canAccess(row, userId) ? row : null;
}

function listMessages(sessionId) {
  return db()
    .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id')
    .all(sessionId)
    .map(toMessage);
}

// Returns the session with its messages, creating it if the id is new.
// Returns null when the id exists but belongs to someone else.
export function ensureSession(sessionId, { userId = null } = {}) {
  const existing = db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
  if (existing) {
    return canAccess(existing, userId) ? { ...toSession(existing), messages: listMessages(sessionId) } : null;
  }

  const now = new Date().toISOString();
  db()
    .prepare('INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)')
    .run(sessionId, userId, now, now);
  return { ...toSession({ id: sessionId, user_id: userId, created_at: now, updated_at: now }), messages: [] };
}

export function addMessage(sessionId, role, text, citations = []) {
  const now = new Date().toISOString();
  const conn = db();
  const { lastInsertRowid } = conn
    .prepare('INSERT INTO chat_messages (session_id, role, text, citations, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, role, text, JSON.stringify(citations || []), now);

  // The first question becomes the chat's title in the history list.
  if (role === 'user') {
    conn
      .prepare('UPDATE chat_sessions SET title = COALESCE(title, ?), updated_at = ? WHERE id = ?')
      .run(titleFrom(text), now, sessionId);
  } else {
    conn.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  }

  return { id: Number(lastInsertRowid), role, text, citations, ts: now };
}

export function getSession(sessionId, { userId = null } = {}) {
  const row = findRow(sessionId, userId);
  return row ? { ...toSession(row), messages: listMessages(sessionId) } : null;
}

// Most recent first; empty chats (opened but never used) are left out.
export function listSessions({ userId = null, limit = 50 } = {}) {
  return db()
    .prepare(
      `SELECT s.*, COUNT(m.id) AS message_count
         FROM chat_sessions s
         JOIN chat_messages m ON m.session_id = s.id
        WHERE s.user_id IS ?
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ?`
    )
    .all(userId, limit)
    .map((row) => ({ ...toSession(row), messageCount: row.message_count }));
}

export function deleteSession(sessionId, { userId = null } = {}) {
  if (!findRow(sessionId, userId)) return false;
  db().prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
  return true;
}
