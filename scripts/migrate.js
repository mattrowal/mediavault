import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(rootDir, 'data', 'media_vault.db');
const MIGRATIONS_DIR = path.join(rootDir, 'migrations');

/**
 * Runs pending versioned schema migrations against the SQLite database.
 * 
 * @param {string} [targetDbPath] 
 * @returns {{ appliedCount: number, totalMigrations: number }}
 */
export function runMigrations(targetDbPath = DEFAULT_DB_PATH) {
  const dbDir = path.dirname(targetDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new DatabaseSync(targetDbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
  } catch {}

  // 1. Ensure migrations tracker table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // 2. Read already applied versions
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
  const appliedSet = new Set(appliedRows.map(r => r.version));

  // 3. Scan migrations directory
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn(`[Migrate] Migrations directory not found at ${MIGRATIONS_DIR}.`);
    db.close();
    return { appliedCount: 0, totalMigrations: 0 };
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let appliedCount = 0;

  for (const file of files) {
    const match = file.match(/^(\d+)_(.*)\.sql$/);
    if (!match) continue;

    const version = parseInt(match[1], 10);
    const name = match[2];

    if (appliedSet.has(version)) {
      continue; // Already applied
    }

    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`[Migrate] Applying migration ${file}...`);

    db.exec('BEGIN TRANSACTION');
    try {
      // Execute the migration SQL
      db.exec(sql);

      // Record in tracker
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, file);
      db.exec('COMMIT');

      appliedCount++;
      console.log(`✅ [Migrate] Successfully applied ${file}`);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}

      // Handle idempotent column addition if already present
      if (err.message.includes('duplicate column name')) {
        console.warn(`⚠️ [Migrate] Column already exists, marking ${file} as recorded.`);
        try {
          db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(version, file);
          appliedCount++;
        } catch {}
      } else {
        db.close();
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  }

  db.close();
  console.log(`🎉 [Migrate] Migrations complete. Applied ${appliedCount} new migration(s).`);
  return { appliedCount, totalMigrations: files.length };
}

// CLI execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const customPath = process.argv[2] || DEFAULT_DB_PATH;
  runMigrations(customPath);
}
