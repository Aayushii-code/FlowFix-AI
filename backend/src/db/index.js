/**
 * SQLite data access.
 *
 * Uses Node's built-in `node:sqlite` driver (file-backed, zero native build,
 * no server process) so local development needs nothing but Node 22.5+.
 * All SQL lives here and in the repository modules under `src/db/repos/`;
 * no business module talks to the database directly.
 *
 *   data/flowfix.db   (override with DATABASE_PATH, or ':memory:' in tests)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

/**
 * Apply every migration that has not been recorded yet. Each migration runs
 * inside its own transaction, so a failure rolls back cleanly and the process
 * can report which migration broke.
 */
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id),
  );
  const history = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.id, migration.name, new Date().toISOString());
      db.exec('COMMIT');
      history.push(migration.name);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `Migration ${migration.id} (${migration.name}) failed: ${err.message}`,
        { cause: err },
      );
    }
  }

  return history;
}

/**
 * Open (creating if needed) the SQLite database and bring the schema up to
 * date.
 *
 * @param {{ path?: string }} options DATABASE_PATH, ':memory:' for tests
 * @returns {{ db: import('node:sqlite').DatabaseSync, path: string, migrations: string[], close: () => void }}
 */
export function openDatabase({ path: dbPath = 'data/flowfix.db' } = {}) {
  const inMemory = dbPath === ':memory:';
  if (!inMemory) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const applied = runMigrations(db);

  return {
    db,
    path: dbPath,
    migrations: applied,
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
