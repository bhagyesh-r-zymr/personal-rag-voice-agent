import { getDb } from '../db.js';

// Thumbs up/down on chat answers, with an optional comment.
// Each vote stores a snapshot of the question, answer and cited documents,
// so the weak-spots view still works after documents or sessions change.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  comment TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (answer_id, voter)
);
CREATE INDEX IF NOT EXISTS feedback_rating_updated ON feedback (rating, updated_at);
`;

const MAX_COMMENT = 1000;
const MAX_REMEMBERED = 2000;

const ready = new WeakSet();

function db(database) {
  const handle = database || getDb();
  if (!ready.has(handle)) {
    handle.exec(SCHEMA);
    ready.add(handle);
  }
  return handle;
}

// Answers are remembered in memory between being shown and being rated,
// so a vote can only be cast on an answer the server actually gave.
const answers = new Map();

export function rememberAnswer({ answerId, sessionId, question, text, citations = [] }) {
  const docs = new Map();
  citations.forEach((c) => {
    const key = c.docId || c.source;
    if (key && !docs.has(key)) docs.set(key, { docId: c.docId || null, source: c.source || null });
  });

  answers.set(answerId, { sessionId, question, text, sources: [...docs.values()] });
  if (answers.size > MAX_REMEMBERED) answers.delete(answers.keys().next().value);
}

export function forgetAnswers() {
  answers.clear();
}

export class FeedbackError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function parseRating(value) {
  if (value === 'up' || value === 1 || value === '1') return 1;
  if (value === 'down' || value === -1 || value === '-1') return -1;
  if (value === 'none' || value === 0 || value === '0' || value === null) return 0;
  return undefined;
}

// Records, changes or clears (rating 0) one voter's rating of an answer.
// The voter is the signed-in user when there is one, else the chat session.
export function recordFeedback({ answerId, sessionId, userId = null, rating, comment }, database) {
  const value = parseRating(rating);
  if (!answerId || value === undefined) {
    throw new FeedbackError(400, 'answerId and a rating of "up", "down" or "none" are required.');
  }

  const answer = answers.get(answerId);
  if (!answer || (!userId && answer.sessionId !== sessionId)) {
    throw new FeedbackError(404, 'That answer can no longer be rated. Ask the question again to rate it.');
  }

  const handle = db(database);
  const voter = userId ? `user:${userId}` : `session:${sessionId}`;

  if (value === 0) {
    handle.prepare('DELETE FROM feedback WHERE answer_id = ? AND voter = ?').run(answerId, voter);
    return { answerId, rating: 0 };
  }

  const note = String(comment ?? '').trim().slice(0, MAX_COMMENT) || null;
  const now = new Date().toISOString();
  handle
    .prepare(
      `INSERT INTO feedback (answer_id, voter, user_id, session_id, rating, comment, question, answer, sources, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (answer_id, voter) DO UPDATE SET
         rating = excluded.rating,
         comment = CASE WHEN excluded.rating = feedback.rating THEN COALESCE(excluded.comment, feedback.comment) ELSE excluded.comment END,
         updated_at = excluded.updated_at`
    )
    .run(
      answerId,
      voter,
      userId,
      sessionId || null,
      value,
      note,
      answer.question,
      answer.text,
      JSON.stringify(answer.sources),
      now,
      now
    );

  return { answerId, rating: value };
}

// What the weak-spots view shows: totals, per-document ratings (worst first),
// and the most recent thumbs-down answers with their comments.
export function feedbackSummary({ limit = 50 } = {}, database) {
  const handle = db(database);

  const totals = handle
    .prepare(
      `SELECT COALESCE(SUM(rating = 1), 0) AS up, COALESCE(SUM(rating = -1), 0) AS down, COUNT(*) AS total FROM feedback`
    )
    .get();

  const documents = handle
    .prepare(
      `SELECT json_extract(s.value, '$.docId') AS docId,
              json_extract(s.value, '$.source') AS source,
              SUM(f.rating = 1) AS up,
              SUM(f.rating = -1) AS down
       FROM feedback f, json_each(f.sources) s
       GROUP BY COALESCE(json_extract(s.value, '$.docId'), json_extract(s.value, '$.source'))
       ORDER BY down DESC, up ASC, source ASC`
    )
    .all()
    .map((row) => ({ ...row }));

  // Answers that cited nothing are questions the policies did not cover.
  const uncovered = handle
    .prepare(
      `SELECT COALESCE(SUM(rating = 1), 0) AS up, COALESCE(SUM(rating = -1), 0) AS down
       FROM feedback WHERE json_array_length(sources) = 0`
    )
    .get();

  const lowRated = handle
    .prepare(
      `SELECT answer_id AS answerId, question, answer, comment, sources, user_id AS userId, updated_at AS ratedAt
       FROM feedback WHERE rating = -1 ORDER BY updated_at DESC LIMIT ?`
    )
    .all(Math.max(0, Math.min(Number(limit) || 50, 500)))
    .map((row) => ({ ...row, sources: JSON.parse(row.sources) }));

  return {
    totals: { ...totals },
    documents,
    uncovered: { ...uncovered },
    lowRated
  };
}
