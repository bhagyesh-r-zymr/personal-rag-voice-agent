import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  FeedbackError,
  feedbackSummary,
  forgetAnswers,
  recordFeedback,
  rememberAnswer
} from '../src/services/feedback.js';

function setup() {
  forgetAnswers();
  const db = new DatabaseSync(':memory:');
  rememberAnswer({
    answerId: 'a1',
    sessionId: 's1',
    question: 'How much leave do I get?',
    text: 'You get 20 days [1][2].',
    citations: [
      { id: 1, docId: 'hr', source: 'HR.pdf', page: 4 },
      { id: 2, docId: 'hr', source: 'HR.pdf', page: 5 }
    ]
  });
  rememberAnswer({
    answerId: 'a2',
    sessionId: 's1',
    question: 'Can I expense a taxi?',
    text: 'Yes, with a receipt [1].',
    citations: [{ id: 1, docId: 'travel', source: 'Travel.pdf', page: 2 }]
  });
  rememberAnswer({
    answerId: 'a3',
    sessionId: 's2',
    question: 'What is the parking policy?',
    text: "I couldn't find that in the company policies.",
    citations: []
  });
  return db;
}

test('recordFeedback stores a vote with a snapshot of the answer', () => {
  const db = setup();
  const saved = recordFeedback({ answerId: 'a2', sessionId: 's1', rating: 'down', comment: '  Missing the limit  ' }, db);
  assert.deepEqual(saved, { answerId: 'a2', rating: -1 });

  const summary = feedbackSummary({}, db);
  assert.deepEqual(summary.totals, { up: 0, down: 1, total: 1 });
  assert.equal(summary.lowRated[0].question, 'Can I expense a taxi?');
  assert.equal(summary.lowRated[0].comment, 'Missing the limit');
  assert.deepEqual(summary.lowRated[0].sources, [{ docId: 'travel', source: 'Travel.pdf' }]);
});

test('voting again replaces the earlier vote, and "none" clears it', () => {
  const db = setup();
  recordFeedback({ answerId: 'a1', sessionId: 's1', rating: 'down', comment: 'Wrong number' }, db);
  recordFeedback({ answerId: 'a1', sessionId: 's1', rating: 'down' }, db);
  assert.equal(feedbackSummary({}, db).lowRated[0].comment, 'Wrong number', 'comment kept when only re-voting');

  recordFeedback({ answerId: 'a1', sessionId: 's1', rating: 'up' }, db);
  assert.deepEqual(feedbackSummary({}, db).totals, { up: 1, down: 0, total: 1 });

  recordFeedback({ answerId: 'a1', sessionId: 's1', rating: 'none' }, db);
  assert.deepEqual(feedbackSummary({}, db).totals, { up: 0, down: 0, total: 0 });
});

test('signed-in users vote as themselves, separately from the session', () => {
  const db = setup();
  recordFeedback({ answerId: 'a1', sessionId: 's1', rating: 'up' }, db);
  recordFeedback({ answerId: 'a1', sessionId: 'other', userId: 'u7', rating: 'down' }, db);
  const summary = feedbackSummary({}, db);
  assert.deepEqual(summary.totals, { up: 1, down: 1, total: 2 });
  assert.equal(summary.lowRated[0].userId, 'u7');
});

test('recordFeedback rejects unknown answers, other sessions and bad ratings', () => {
  const db = setup();
  assert.throws(() => recordFeedback({ answerId: 'nope', sessionId: 's1', rating: 'up' }, db), { statusCode: 404 });
  assert.throws(() => recordFeedback({ answerId: 'a1', sessionId: 's2', rating: 'up' }, db), { statusCode: 404 });
  assert.throws(() => recordFeedback({ answerId: 'a1', sessionId: 's1', rating: 'meh' }, db), (e) => {
    assert.ok(e instanceof FeedbackError);
    return e.statusCode === 400;
  });
});

test('feedbackSummary ranks documents by thumbs-down and counts uncovered questions', () => {
  const db = setup();
  recordFeedback({ answerId: 'a1', sessionId: 's1', rating: 'up' }, db);
  recordFeedback({ answerId: 'a2', sessionId: 's1', rating: 'down' }, db);
  recordFeedback({ answerId: 'a2', sessionId: 'x', userId: 'u1', rating: 'down' }, db);
  recordFeedback({ answerId: 'a3', sessionId: 's2', rating: 'down', comment: 'We do have a parking policy' }, db);

  const summary = feedbackSummary({}, db);
  assert.deepEqual(summary.documents, [
    { docId: 'travel', source: 'Travel.pdf', up: 0, down: 2 },
    { docId: 'hr', source: 'HR.pdf', up: 1, down: 0 }
  ]);
  assert.deepEqual(summary.uncovered, { up: 0, down: 1 });
  assert.equal(summary.lowRated.length, 3);
  assert.equal(feedbackSummary({ limit: 1 }, db).lowRated.length, 1);
});
