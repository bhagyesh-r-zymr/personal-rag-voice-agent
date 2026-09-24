import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// One shared SQLite database for app data (chat history, users, feedback).
// Each service creates its own tables with CREATE TABLE IF NOT EXISTS.
let db = null;

export function getDb() {
  if (!db) {
    if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = new DatabaseSync(config.dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}
