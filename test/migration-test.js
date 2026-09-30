import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const TEST_DB_PATH = path.join(rootDir, 'data', `test_migration_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;

const { runMigrations } = await import('../scripts/migrate.js');
const { backupDatabase } = await import('../scripts/backup-db.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 MediaVault Migration & Recovery Automated Suite');
  console.log('====================================================\n');

  try {
    // -------------------------------------------------------------
    console.log('1️⃣ Testing Fresh Database Migration Execution');
    // -------------------------------------------------------------
    assert(!fs.existsSync(TEST_DB_PATH), 'Test DB file does not exist before migrations');

    const totalMigrationFiles = fs.readdirSync(path.join(rootDir, 'migrations')).filter(f => f.endsWith('.sql')).length;
    const result = runMigrations(TEST_DB_PATH);
    assert(result.appliedCount === totalMigrationFiles, `Applied all ${totalMigrationFiles} initial migrations on fresh database`);
    assert(fs.existsSync(TEST_DB_PATH), 'Database file created by migration runner');

    const db = new DatabaseSync(TEST_DB_PATH);

    // Verify tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    assert(tables.includes('users'), 'Table users exists');
    assert(tables.includes('sessions'), 'Table sessions exists');
    assert(tables.includes('media_items'), 'Table media_items exists');
    assert(tables.includes('books'), 'Table books exists');
    assert(tables.includes('notifications'), 'Table notifications exists');
    assert(tables.includes('tv_episodes_cache'), 'Table tv_episodes_cache exists');
    assert(tables.includes('watched_episodes'), 'Table watched_episodes exists');
    assert(tables.includes('schema_migrations'), 'Table schema_migrations exists');

    // Verify last_synced_at column on media_items
    const cols = db.prepare("PRAGMA table_info(media_items)").all().map(c => c.name);
    assert(cols.includes('last_synced_at'), 'Column last_synced_at exists on media_items');

    // Verify migration records in schema_migrations
    const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all();
    assert(applied.length === totalMigrationFiles, `All ${totalMigrationFiles} versions recorded in schema_migrations`);
    assert(applied.every((row, idx) => row.version === idx + 1), 'All migration versions recorded in sequence');

    db.close();

    // -------------------------------------------------------------
    console.log('\n2️⃣ Testing Idempotent Re-Run');
    // -------------------------------------------------------------
    const secondRun = runMigrations(TEST_DB_PATH);
    assert(secondRun.appliedCount === 0, 'Re-running migrations applies 0 new migrations (Idempotent)');

    // -------------------------------------------------------------
    console.log('\n3️⃣ Testing Database Snapshot Backup & Restoration');
    // -------------------------------------------------------------
    const snapshotPath = backupDatabase('recovery_test');
    assert(Boolean(snapshotPath) && fs.existsSync(snapshotPath), 'Snapshot backup file created successfully');

    // Mutate the original database (add a test user)
    const testDb = new DatabaseSync(TEST_DB_PATH);
    testDb.prepare("INSERT INTO users (username, password_hash, salt) VALUES ('test_rollback_user', 'hash', 'salt')").run();
    const countBefore = testDb.prepare("SELECT COUNT(*) as c FROM users").get().c;
    assert(countBefore === 1, 'Dummy user added to active database');
    testDb.close();

    // Simulate recovery: Restore from snapshot
    fs.copyFileSync(snapshotPath, TEST_DB_PATH);

    // Verify restored state (dummy user should no longer exist)
    const restoredDb = new DatabaseSync(TEST_DB_PATH);
    const countAfter = restoredDb.prepare("SELECT COUNT(*) as c FROM users").get().c;
    assert(countAfter === 0, 'Database restored to exact pre-modification state from snapshot');
    restoredDb.close();

    // Clean up snapshot file
    try {
      if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
    } catch {}

    console.log('\n====================================================');
    console.log(`🎉 ALL MIGRATION & RECOVERY TESTS PASSED! (${passed} checks passed, ${failed} failed)`);
    console.log('====================================================\n');
  } finally {
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
      if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch {}
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
