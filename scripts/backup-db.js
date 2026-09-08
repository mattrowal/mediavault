import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DB_PATH = process.env.DB_PATH || path.join(rootDir, 'data', 'media_vault.db');
const backupsDir = path.join(rootDir, 'data', 'backups');

export function backupDatabase(customLabel = '') {
  if (!fs.existsSync(DB_PATH)) {
    console.warn(`[Backup] Source database file not found at ${DB_PATH}. Skipping backup.`);
    return null;
  }

  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = customLabel ? `_${customLabel}` : '';
  const backupFileName = `media_vault_backup_${timestamp}${label}.db`;
  const backupFilePath = path.join(backupsDir, backupFileName);

  try {
    const tempDb = new DatabaseSync(DB_PATH);

    // If WAL mode was ever activated, flush WAL pages into main DB file
    try {
      tempDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Ignored if not in WAL mode
    }

    // SQLite VACUUM INTO creates a clean, consistent snapshot even during active reads
    const safeSqlPath = backupFilePath.replace(/'/g, "''");
    tempDb.exec(`VACUUM INTO '${safeSqlPath}'`);
    tempDb.close();

    console.log(`✅ [Backup] Consistent database snapshot created: ${backupFilePath}`);
    return backupFilePath;
  } catch (err) {
    console.warn(`⚠️ [Backup] VACUUM INTO failed (${err.message}). Falling back to file copy.`);
    fs.copyFileSync(DB_PATH, backupFilePath);

    // Also copy WAL and SHM if present
    if (fs.existsSync(`${DB_PATH}-wal`)) {
      fs.copyFileSync(`${DB_PATH}-wal`, `${backupFilePath}-wal`);
    }
    if (fs.existsSync(`${DB_PATH}-shm`)) {
      fs.copyFileSync(`${DB_PATH}-shm`, `${backupFilePath}-shm`);
    }

    console.log(`✅ [Backup] File copy backup created: ${backupFilePath}`);
    return backupFilePath;
  }
}

// Run directly from CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const label = process.argv[2] || 'manual';
  backupDatabase(label);
}
