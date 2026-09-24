import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../src/config.js';
import { closeDb } from '../src/db.js';
import {
  addMessage,
  deleteSession,
  ensureSession,
  getSession,
  listSessions
} from '../src/services/sessionStore.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-'));
config.dbPath = path.join(dir, 'app.db');

test.after(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chat history survives closing and reopening the database', () => {
  ensureSession('s-restart');
  addMessage('s-restart', 'user', 'How many days of leave do I get?');
  const answer = addMessage('s-restart', 'assistant', 'You get 20 days [1].', [{ id: 1, source: 'HR.pdf', page: 4 }]);
  assert.equal(typeof answer.id, 'number');

  closeDb();

  const session = getSession('s-restart');
  assert.equal(session.title, 'How many days of leave do I get?');
  assert.deepEqual(
    session.messages.map((m) => [m.role, m.text]),
    [
      ['user', 'How many days of leave do I get?'],
      ['assistant', 'You get 20 days [1].']
    ]
  );
  assert.deepEqual(session.messages[1].citations, [{ id: 1, source: 'HR.pdf', page: 4 }]);
  assert.equal(session.messages[1].id, answer.id);
});

test('the first question titles the chat and later ones do not', () => {
  ensureSession('s-title');
  addMessage('s-title', 'user', `  What is the\nwork from home policy? ${'x'.repeat(100)}`);
  addMessage('s-title', 'user', 'And for contractors?');

  const { title } = getSession('s-title');
  assert.ok(title.startsWith('What is the work from home policy?'));
  assert.equal(title.length, 80);
  assert.ok(title.endsWith('…'));
});

test('listSessions shows used chats newest first and skips empty ones', () => {
  ensureSession('s-empty');
  ensureSession('s-newest');
  addMessage('s-newest', 'user', 'Newest question');

  const ids = listSessions().map((s) => s.id);
  assert.equal(ids[0], 's-newest');
  assert.ok(!ids.includes('s-empty'));
  assert.equal(listSessions().find((s) => s.id === 's-newest').messageCount, 1);
});

test('a user only sees and opens their own chats', () => {
  ensureSession('s-alice', { userId: 1 });
  addMessage('s-alice', 'user', 'Alice question');
  ensureSession('s-bob', { userId: 2 });
  addMessage('s-bob', 'user', 'Bob question');

  assert.deepEqual(listSessions({ userId: 1 }).map((s) => s.id), ['s-alice']);
  assert.ok(!listSessions().some((s) => s.id === 's-alice'), 'anonymous list excludes owned chats');
  assert.equal(getSession('s-alice', { userId: 2 }), null);
  assert.equal(getSession('s-alice'), null);
  assert.equal(ensureSession('s-alice', { userId: 2 }), null);
  assert.equal(deleteSession('s-alice', { userId: 2 }), false);
  assert.equal(getSession('s-alice', { userId: 1 }).messages.length, 1);
});

test('deleteSession removes the chat and its messages', () => {
  ensureSession('s-delete');
  addMessage('s-delete', 'user', 'Delete me');

  assert.equal(deleteSession('s-delete'), true);
  assert.equal(getSession('s-delete'), null);
  assert.equal(deleteSession('s-delete'), false);
  // Re-creating the id starts from an empty chat, so no orphaned messages remain.
  assert.deepEqual(ensureSession('s-delete').messages, []);
});
