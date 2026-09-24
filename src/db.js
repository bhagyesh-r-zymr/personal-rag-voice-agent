import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// One shared SQLite database for app data (chat history, feedback, users).
// Each feature creates its own tables with CREATE TABLE IF NOT EXISTS in its
// own service, so there is no central migration list to coordinate.
let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = config.dbPath;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// Closes the cached connection; the next getDb() call opens config.dbPath again.
export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}
