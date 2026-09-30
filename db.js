import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allow configurable DB_PATH for AWS persistent mounts (EBS/EFS/Docker volume)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'media_vault.db');
const dbDir = path.dirname(DB_PATH);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);

// Enable SQLite Foreign Key constraints
try {
  db.exec('PRAGMA foreign_keys = ON;');
} catch (err) {
  console.warn('⚠️ Could not enable foreign keys:', err.message);
}

// Helper: Check if a column exists on a table
function hasColumn(tableName, columnName) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return cols.some(col => col.name === columnName);
  } catch {
    return false;
  }
}

// Initialize tables and performance indexes (Idempotent migration)
export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- 'tv' or 'movie'
      title TEXT NOT NULL,
      external_id TEXT,   -- TVMaze ID or IMDb ID
      poster_url TEXT,
      release_year TEXT,
      genre TEXT,
      status TEXT NOT NULL DEFAULT 'watching', -- 'watching', 'completed', 'plan_to_watch', 'dropped'
      current_season INTEGER DEFAULT 1,
      current_episode INTEGER DEFAULT 0,
      latest_season INTEGER DEFAULT 1,
      latest_episode INTEGER DEFAULT 0,
      latest_episode_name TEXT,
      latest_air_date TEXT,
      next_air_date TEXT,
      total_episodes INTEGER DEFAULT 0,
      rating INTEGER DEFAULT 0,
      notes TEXT DEFAULT '',
      runtime INTEGER DEFAULT NULL,
      is_runtime_manual INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      author TEXT,
      cover_url TEXT,
      isbn TEXT,
      page_count INTEGER DEFAULT 0,
      current_page INTEGER DEFAULT 0,
      owned INTEGER DEFAULT 1, -- 1 = Owned physically/digitally at home, 0 = Not owned
      format TEXT DEFAULT 'Hardcover', -- 'Hardcover', 'Paperback', 'E-Book', 'Audiobook'
      status TEXT DEFAULT 'unread',    -- 'unread', 'reading', 'completed', 'wishlist'
      rating INTEGER DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_id INTEGER REFERENCES media_items(id) ON DELETE CASCADE,
      episode_id INTEGER DEFAULT NULL,
      type TEXT NOT NULL DEFAULT 'episode_release',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      air_date TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS tv_episodes_cache (
      external_id TEXT PRIMARY KEY,
      episodes_json TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS watched_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      episode_id INTEGER,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      cycle_number INTEGER NOT NULL DEFAULT 1,
      watched_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      season INTEGER DEFAULT NULL,
      episode INTEGER DEFAULT NULL,
      pages_read INTEGER DEFAULT 0,
      minutes_viewed INTEGER DEFAULT 0,
      is_correction INTEGER NOT NULL DEFAULT 0,
      cycle_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS consumption_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN ('movie', 'tv', 'book')),
      item_id INTEGER NOT NULL,
      cycle_number INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'abandoned')),
      progress_value INTEGER DEFAULT 0,
      started_at TEXT DEFAULT (datetime('now', 'localtime')),
      completed_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS personal_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_type TEXT NOT NULL CHECK(goal_type IN ('books_yearly', 'pages_monthly', 'movies_monthly')),
      target INTEGER NOT NULL CHECK(target > 0),
      year INTEGER NOT NULL,
      month INTEGER DEFAULT NULL,
      include_repeats INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS saved_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      time_budget_minutes INTEGER NOT NULL,
      total_planned_minutes INTEGER NOT NULL,
      items_json TEXT NOT NULL,
      explanation TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'archived')),
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Column migrations if tables already exist
  if (!hasColumn('media_items', 'user_id')) {
    db.exec('ALTER TABLE media_items ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;');
  }
  if (!hasColumn('books', 'user_id')) {
    db.exec('ALTER TABLE books ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;');
  }
  if (!hasColumn('media_items', 'last_synced_at')) {
    db.exec('ALTER TABLE media_items ADD COLUMN last_synced_at TEXT DEFAULT NULL;');
  }
  if (!hasColumn('media_items', 'runtime')) {
    db.exec('ALTER TABLE media_items ADD COLUMN runtime INTEGER DEFAULT NULL;');
  }
  if (!hasColumn('media_items', 'is_runtime_manual')) {
    db.exec('ALTER TABLE media_items ADD COLUMN is_runtime_manual INTEGER NOT NULL DEFAULT 0;');
  }
  if (!hasColumn('media_items', 'current_cycle')) {
    db.exec('ALTER TABLE media_items ADD COLUMN current_cycle INTEGER NOT NULL DEFAULT 1;');
  }
  if (!hasColumn('media_items', 'notify_enabled')) {
    db.exec('ALTER TABLE media_items ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 1;');
  }
  if (!hasColumn('books', 'current_cycle')) {
    db.exec('ALTER TABLE books ADD COLUMN current_cycle INTEGER NOT NULL DEFAULT 1;');
  }
  if (!hasColumn('watched_episodes', 'cycle_number')) {
    db.exec('ALTER TABLE watched_episodes ADD COLUMN cycle_number INTEGER NOT NULL DEFAULT 1;');
  }
  if (!hasColumn('activity_log', 'cycle_number')) {
    db.exec('ALTER TABLE activity_log ADD COLUMN cycle_number INTEGER NOT NULL DEFAULT 1;');
  }
  if (!hasColumn('notifications', 'episode_id')) {
    db.exec('ALTER TABLE notifications ADD COLUMN episode_id INTEGER DEFAULT NULL;');
  }

  // Performance and isolation indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_user ON media_items(user_id);
    CREATE INDEX IF NOT EXISTS idx_media_type_status ON media_items(user_id, type, status);
    CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
    CREATE INDEX IF NOT EXISTS idx_books_owned_status ON books(user_id, owned, status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(user_id, media_id, season, episode);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_episode ON notifications(user_id, episode_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_episodes_user_media_cycle_season_ep ON watched_episodes(user_id, media_id, cycle_number, season, episode);
    CREATE INDEX IF NOT EXISTS idx_watched_episodes_user_media ON watched_episodes(user_id, media_id);
    CREATE INDEX IF NOT EXISTS idx_activity_user_date ON activity_log(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_user_type ON activity_log(user_id, activity_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cycles_user_item_cycle ON consumption_cycles(user_id, item_type, item_id, cycle_number);
    CREATE INDEX IF NOT EXISTS idx_cycles_user_item_status ON consumption_cycles(user_id, item_type, item_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_goals_unique ON personal_goals(user_id, goal_type, year, ifnull(month, 0));
    CREATE INDEX IF NOT EXISTS idx_saved_plans_user ON saved_plans(user_id, created_at DESC);
  `);
}

// Auto-run schema initialization
initDatabase();

// ==========================================
// USER MANAGEMENT
// ==========================================

export function createUser(username, passwordHash, salt) {
  const stmt = db.prepare(`
    INSERT INTO users (username, password_hash, salt)
    VALUES (?, ?, ?)
  `);
  const res = stmt.run(username.trim(), passwordHash, salt);
  return getUserById(res.lastInsertRowid);
}

export function getUserByUsername(username) {
  if (!username) return null;
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
}

export function getUserById(id) {
  if (!id) return null;
  return db.prepare('SELECT id, username, created_at, updated_at FROM users WHERE id = ?').get(id);
}

export function getUserWithCredentials(id) {
  if (!id) return null;
  return db.prepare('SELECT id, username, password_hash, salt FROM users WHERE id = ?').get(id);
}

/**
 * Updates user password hash and salt, and revokes all active sessions for the user
 * within a single atomic SQLite transaction. Both operations succeed or both fail.
 */
export function updateUserPasswordAndRevokeSessions(userId, passwordHash, salt) {
  if (!userId || !passwordHash || !salt) {
    throw new Error('User ID, password hash, and salt are required');
  }

  db.exec('BEGIN TRANSACTION');
  try {
    const updateStmt = db.prepare(`
      UPDATE users
      SET password_hash = ?, salt = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `);
    const updateRes = updateStmt.run(passwordHash, salt, userId);
    if (updateRes.changes === 0) {
      throw new Error(`User with ID ${userId} not found`);
    }

    const deleteStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
    deleteStmt.run(userId);

    db.exec('COMMIT');
    return true;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}


// ==========================================
// SERVER-SIDE SESSIONS
// ==========================================

export function insertSession(id, userId, csrfToken, expiresAt) {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(id, userId, csrfToken, expiresAt);
}

export function findSession(id) {
  if (!id) return null;
  return db.prepare(`
    SELECT s.id, s.user_id, s.csrf_token, s.expires_at, u.username
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(id);
}

export function removeSession(id) {
  if (!id) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function removeUserSessions(userId) {
  if (!userId) return;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}

// ==========================================
// MEDIA (Movies & TV Shows) - Strictly Scoped to userId
// ==========================================

export function getAllMedia(userId, filters = {}) {
  if (!userId) return [];

  let query = 'SELECT * FROM media_items WHERE user_id = ?';
  const params = [userId];

  if (filters.type && filters.type !== 'all') {
    query += ' AND type = ?';
    params.push(filters.type);
  }

  if (filters.status === 'new_episodes') {
    query += " AND type = 'tv' AND status = 'watching' AND (latest_season > current_season OR (latest_season = current_season AND latest_episode > current_episode))";
  } else if (filters.status && filters.status !== 'all') {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  if (filters.search && filters.search.trim()) {
    query += ' AND (title LIKE ? OR genre LIKE ?)';
    const term = `%${filters.search.trim()}%`;
    params.push(term, term);
  }

  query += ' ORDER BY updated_at DESC, id DESC';
  return db.prepare(query).all(...params);
}

export function getMediaById(id, userId) {
  if (!id || !userId) return null;
  return db.prepare('SELECT * FROM media_items WHERE id = ? AND user_id = ?').get(id, userId);
}

export function addMedia(item, userId) {
  if (!userId) throw new Error('User ID is required to add media');

  const stmt = db.prepare(`
    INSERT INTO media_items (
      user_id, type, title, external_id, poster_url, release_year, genre,
      status, current_season, current_episode, latest_season,
      latest_episode, latest_episode_name, latest_air_date, next_air_date,
      total_episodes, rating, notes, runtime, is_runtime_manual
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = stmt.run(
    userId,
    item.type || 'tv',
    item.title || 'Untitled',
    item.external_id || null,
    item.poster_url || null,
    item.release_year || null,
    item.genre || null,
    item.status || 'watching',
    Number(item.current_season) || 1,
    Number(item.current_episode) || 0,
    Number(item.latest_season) || 1,
    Number(item.latest_episode) || 0,
    item.latest_episode_name || null,
    item.latest_air_date || null,
    item.next_air_date || null,
    Number(item.total_episodes) || 0,
    Number(item.rating) || 0,
    item.notes || '',
    item.runtime !== undefined && item.runtime !== null ? Number(item.runtime) : null,
    item.is_runtime_manual ? 1 : 0
  );

  return getMediaById(res.lastInsertRowid, userId);
}

export function updateMedia(id, userId, fields) {
  if (!id || !userId) return null;

  // First confirm ownership
  const existing = getMediaById(id, userId);
  if (!existing) return null;

  const allowed = [
    'title', 'poster_url', 'release_year', 'genre', 'status',
    'current_season', 'current_episode', 'latest_season', 'latest_episode',
    'latest_episode_name', 'latest_air_date', 'next_air_date',
    'total_episodes', 'rating', 'notes', 'external_id', 'runtime', 'is_runtime_manual', 'notify_enabled',
    'last_synced_at'
  ];

  const setClauses = [];
  const params = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      setClauses.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }

  if (setClauses.length === 0) return existing;

  setClauses.push("updated_at = datetime('now', 'localtime')");
  params.push(id, userId);

  const query = `UPDATE media_items SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`;
  db.prepare(query).run(...params);

  return getMediaById(id, userId);
}

export function incrementMediaEpisode(id, userId) {
  const item = getMediaById(id, userId);
  if (!item) return null;

  const nextEp = (item.current_episode || 0) + 1;
  return updateMedia(id, userId, { current_episode: nextEp });
}

export function deleteMedia(id, userId) {
  if (!id || !userId) return false;
  const stmt = db.prepare('DELETE FROM media_items WHERE id = ? AND user_id = ?');
  const res = stmt.run(id, userId);
  return res.changes > 0;
}

export function getAllTVShowsWithExternalId(userId) {
  if (!userId) return [];
  return db.prepare("SELECT * FROM media_items WHERE type = 'tv' AND external_id IS NOT NULL AND user_id = ?").all(userId);
}

export function getMovieByExternalId(userId, externalId, excludeId = null) {
  if (!userId || !externalId) return null;
  if (excludeId) {
    return db.prepare(`
      SELECT * FROM media_items
      WHERE user_id = ? AND type = 'movie' AND external_id = ? AND id != ?
    `).get(userId, String(externalId), excludeId);
  }
  return db.prepare(`
    SELECT * FROM media_items
    WHERE user_id = ? AND type = 'movie' AND external_id = ?
  `).get(userId, String(externalId));
}

// ==========================================
// BOOKS - Strictly Scoped to userId
// ==========================================

export function getAllBooks(userId, filters = {}) {
  if (!userId) return [];

  let query = 'SELECT * FROM books WHERE user_id = ?';
  const params = [userId];

  // Filter by ownership: 1 (owned), 0 (not owned)
  if (filters.owned !== undefined && filters.owned !== 'all') {
    query += ' AND owned = ?';
    params.push(Number(filters.owned));
  }

  // Filter by read status: 'completed' (read), 'reading', 'unread', 'wishlist', or 'not_completed'
  if (filters.status === 'not_completed') {
    query += " AND status != 'completed'";
  } else if (filters.status && filters.status !== 'all') {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  if (filters.search && filters.search.trim()) {
    query += ' AND (title LIKE ? OR author LIKE ?)';
    const term = `%${filters.search.trim()}%`;
    params.push(term, term);
  }

  query += ' ORDER BY updated_at DESC, id DESC';
  return db.prepare(query).all(...params);
}

export function getBookById(id, userId) {
  if (!id || !userId) return null;
  return db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(id, userId);
}

export function addBook(item, userId) {
  if (!userId) throw new Error('User ID is required to add a book');

  const stmt = db.prepare(`
    INSERT INTO books (
      user_id, title, author, cover_url, isbn, page_count, current_page,
      owned, format, status, rating, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = stmt.run(
    userId,
    item.title || 'Untitled Book',
    item.author || '',
    item.cover_url || null,
    item.isbn || null,
    Number(item.page_count) || 0,
    Number(item.current_page) || 0,
    item.owned !== undefined ? Number(item.owned) : 1,
    item.format || 'Hardcover',
    item.status || 'unread',
    Number(item.rating) || 0,
    item.notes || ''
  );

  return getBookById(res.lastInsertRowid, userId);
}

export function updateBook(id, userId, fields) {
  if (!id || !userId) return null;

  const existing = getBookById(id, userId);
  if (!existing) return null;

  const allowed = [
    'title', 'author', 'cover_url', 'isbn', 'page_count',
    'current_page', 'owned', 'format', 'status', 'rating', 'notes'
  ];

  const setClauses = [];
  const params = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      setClauses.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }

  if (setClauses.length === 0) return existing;

  setClauses.push("updated_at = datetime('now', 'localtime')");
  params.push(id, userId);

  const query = `UPDATE books SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`;
  db.prepare(query).run(...params);

  return getBookById(id, userId);
}

export function updateBookReadingProgress(userId, bookId, { currentPage, isCorrection = false }) {
  if (!userId || !bookId) throw new Error('User ID and Book ID required');

  const book = getBookById(bookId, userId);
  if (!book) return null;

  const cp = Number(currentPage);
  if (isNaN(cp) || !Number.isInteger(cp) || cp < 0) {
    const err = new Error('Current page must be a non-negative whole integer');
    err.status = 400;
    throw err;
  }

  if (book.page_count > 0 && cp > book.page_count) {
    const err = new Error(`Current page cannot exceed total pages (${book.page_count})`);
    err.status = 400;
    throw err;
  }

  // If reached or exceeded total pages and total pages is known
  if (book.page_count > 0 && cp >= book.page_count) {
    if (!isCorrection) {
      completeItemCycle(userId, 'book', book.id);
    } else {
      const curCycle = book.current_cycle || 1;
      db.prepare(`UPDATE books SET status = 'completed', current_page = ?, updated_at = datetime('now', 'localtime') WHERE id = ? AND user_id = ?`)
        .run(book.page_count, book.id, userId);
      const existingCycle = db.prepare(`SELECT id FROM consumption_cycles WHERE user_id = ? AND item_type = 'book' AND item_id = ? AND cycle_number = ?`)
        .get(userId, book.id, curCycle);
      if (existingCycle) {
        db.prepare(`UPDATE consumption_cycles SET status = 'completed', progress_value = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
          .run(book.page_count, existingCycle.id);
      }
    }
    return getBookById(bookId, userId);
  }

  // In-progress reading update
  const delta = cp - (book.current_page || 0);
  if (!isCorrection && delta > 0) {
    logActivity({
      userId,
      activityType: 'reading_progress',
      itemType: 'book',
      itemId: book.id,
      pagesRead: delta,
      isCorrection: 0,
      cycleNumber: book.current_cycle || 1
    });
  }

  const newStatus = (book.status === 'unread' && cp > 0) ? 'reading' : book.status;
  updateBook(book.id, userId, { current_page: cp, status: newStatus });

  // Update or insert consumption cycle progress
  const curCycle = book.current_cycle || 1;
  const cycle = db.prepare(`SELECT id FROM consumption_cycles WHERE user_id = ? AND item_type = 'book' AND item_id = ? AND cycle_number = ?`)
    .get(userId, book.id, curCycle);
  if (cycle) {
    db.prepare(`UPDATE consumption_cycles SET progress_value = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
      .run(cp, cycle.id);
  } else {
    db.prepare(`
      INSERT INTO consumption_cycles (
        user_id, item_type, item_id, cycle_number, status, progress_value, started_at, created_at, updated_at
      ) VALUES (?, 'book', ?, ?, 'in_progress', ?, datetime('now', 'localtime'), datetime('now', 'localtime'), datetime('now', 'localtime'))
    `).run(userId, book.id, curCycle, cp);
  }

  return getBookById(bookId, userId);
}

export function deleteBook(id, userId) {
  if (!id || !userId) return false;
  const stmt = db.prepare('DELETE FROM books WHERE id = ? AND user_id = ?');
  const res = stmt.run(id, userId);
  return res.changes > 0;
}

// ==========================================
// DASHBOARD STATS (Per User)
// ==========================================

export function getDashboardStats(userId) {
  if (!userId) {
    return {
      movies: { total: 0, completed: 0 },
      series: { activeWatching: 0, withNewEpisodesCount: 0, withNewEpisodes: [] },
      books: { total: 0, owned: 0, completed: 0, reading: 0, ownedUnread: 0 },
      currentlyWatching: [],
      currentlyReading: []
    };
  }

  const totalMovies = db.prepare("SELECT COUNT(*) as c FROM media_items WHERE user_id = ? AND type = 'movie'").get(userId).c;
  const completedMovies = db.prepare("SELECT COUNT(*) as c FROM media_items WHERE user_id = ? AND type = 'movie' AND status = 'completed'").get(userId).c;
  const activeSeries = db.prepare("SELECT COUNT(*) as c FROM media_items WHERE user_id = ? AND type = 'tv' AND status = 'watching'").get(userId).c;

  // TV shows that have released episodes ahead of what this user has watched
  const seriesWithNewEpisodes = db.prepare(`
    SELECT * FROM media_items
    WHERE user_id = ?
      AND type = 'tv'
      AND status = 'watching'
      AND (
        latest_season > current_season
        OR (latest_season = current_season AND latest_episode > current_episode)
      )
    ORDER BY updated_at DESC
  `).all(userId);

  const currentlyWatching = db.prepare(`
    SELECT * FROM media_items
    WHERE user_id = ? AND status = 'watching'
    ORDER BY updated_at DESC
    LIMIT 6
  `).all(userId);

  // Book statistics for this user
  const totalBooks = db.prepare('SELECT COUNT(*) as c FROM books WHERE user_id = ?').get(userId).c;
  const ownedBooks = db.prepare('SELECT COUNT(*) as c FROM books WHERE user_id = ? AND owned = 1').get(userId).c;
  const completedBooks = db.prepare("SELECT COUNT(*) as c FROM books WHERE user_id = ? AND status = 'completed'").get(userId).c;
  const readingBooks = db.prepare("SELECT COUNT(*) as c FROM books WHERE user_id = ? AND status = 'reading'").get(userId).c;
  const ownedUnreadBooks = db.prepare("SELECT COUNT(*) as c FROM books WHERE user_id = ? AND owned = 1 AND status != 'completed'").get(userId).c;

  const currentlyReading = db.prepare(`
    SELECT * FROM books
    WHERE user_id = ? AND status = 'reading'
    ORDER BY updated_at DESC
    LIMIT 6
  `).all(userId);

  return {
    movies: {
      total: totalMovies,
      completed: completedMovies
    },
    series: {
      activeWatching: activeSeries,
      withNewEpisodesCount: seriesWithNewEpisodes.length,
      withNewEpisodes: seriesWithNewEpisodes
    },
    books: {
      total: totalBooks,
      owned: ownedBooks,
      completed: completedBooks,
      reading: readingBooks,
      ownedUnread: ownedUnreadBooks
    },
    currentlyWatching,
    currentlyReading
  };
}

// ==========================================
// USER LIBRARY PROFILE FOR GENAI RECOMMENDATIONS (Per User)
// ==========================================

export function getUserLibraryProfile(userId) {
  if (!userId) {
    return { movies: [], shows: [], books: [] };
  }

  const movies = db.prepare("SELECT title, release_year, genre, status, rating, notes FROM media_items WHERE user_id = ? AND type = 'movie'").all(userId);
  const shows = db.prepare("SELECT title, genre, status, current_season, current_episode, rating, notes FROM media_items WHERE user_id = ? AND type = 'tv'").all(userId);
  const books = db.prepare("SELECT title, author, format, owned, status, rating, notes FROM books WHERE user_id = ?").all(userId);

  return {
    movies,
    shows,
    books
  };
}

// ==========================================
// ADMINISTRATIVE / LEGACY DATA MANAGEMENT
// ==========================================

/**
 * Returns counts of unassigned legacy records where user_id IS NULL.
 * These records cannot be accessed through any regular web endpoint.
 */
export function getUnassignedCounts() {
  const mediaCount = db.prepare('SELECT COUNT(*) as c FROM media_items WHERE user_id IS NULL').get().c;
  const booksCount = db.prepare('SELECT COUNT(*) as c FROM books WHERE user_id IS NULL').get().c;
  return { mediaCount, booksCount, total: mediaCount + booksCount };
}

/**
 * Assigns all unassigned legacy records to an explicitly designated user.
 * Must only be invoked via administrative CLI.
 */
export function assignUnassignedToUser(userId) {
  if (!userId) throw new Error('Valid target userId is required');

  const updateMediaStmt = db.prepare('UPDATE media_items SET user_id = ? WHERE user_id IS NULL');
  const mediaRes = updateMediaStmt.run(userId);

  const updateBooksStmt = db.prepare('UPDATE books SET user_id = ? WHERE user_id IS NULL');
  const booksRes = updateBooksStmt.run(userId);

  return {
    mediaAssigned: mediaRes.changes,
    booksAssigned: booksRes.changes,
    totalAssigned: mediaRes.changes + booksRes.changes
  };
}

// ==========================================
// IN-APP NOTIFICATIONS & EPISODE MONITORING
// ==========================================

/**
 * Creates a notification with stable episode IDs and compound coordinate deduplication.
 * Returns true if inserted, false if ignored.
 */
export function createNotification({ userId, mediaId, episodeId = null, type = 'episode_release', title, message, season, episode, airDate }) {
  if (!userId || !title) return false;

  const s = season !== undefined && season !== null ? Number(season) : 0;
  const ep = episode !== undefined && episode !== null ? Number(episode) : 0;
  const epId = episodeId !== null && episodeId !== undefined ? Number(episodeId) : null;

  // Stable episode ID check: prevent duplicate notifications even if titles or air dates fluctuate
  if (epId !== null) {
    const existingByEpId = db.prepare(`
      SELECT id FROM notifications
      WHERE user_id = ? AND episode_id = ?
      LIMIT 1
    `).get(userId, epId);
    if (existingByEpId) return false;
  }

  // Compound coordinate check: (user_id, media_id, season, episode)
  if (mediaId) {
    const existingByCoord = db.prepare(`
      SELECT id FROM notifications
      WHERE user_id = ? AND media_id = ? AND season = ? AND episode = ?
      LIMIT 1
    `).get(userId, mediaId, s, ep);
    if (existingByCoord) return false;
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO notifications (
      user_id, media_id, episode_id, type, title, message, season, episode, air_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = stmt.run(
    userId,
    mediaId || null,
    epId,
    type,
    title,
    message || '',
    s,
    ep,
    airDate || null
  );

  return res.changes > 0;
}

/**
 * Retrieves notifications for a specific user, ordered newest first.
 */
export function getUserNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  if (!userId) return [];

  let query = 'SELECT * FROM notifications WHERE user_id = ?';
  const params = [userId];

  if (unreadOnly) {
    query += ' AND is_read = 0';
  }

  query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(Math.min(100, Math.max(1, Number(limit) || 50)));

  return db.prepare(query).all(...params);
}

/**
 * Returns count of unread notifications for a user.
 */
export function getUnreadNotificationCount(userId) {
  if (!userId) return 0;
  const row = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(userId);
  return row?.c || 0;
}

/**
 * Marks a single notification as read, ensuring it belongs to userId.
 */
export function markNotificationAsRead(id, userId) {
  if (!id || !userId) return false;
  const stmt = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?');
  const res = stmt.run(id, userId);
  return res.changes > 0;
}

/**
 * Marks all notifications as read for a specific user.
 */
export function markAllNotificationsAsRead(userId) {
  if (!userId) return 0;
  const stmt = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0');
  const res = stmt.run(userId);
  return res.changes;
}

/**
 * Deletes a notification, ensuring it belongs to userId.
 */
export function deleteNotification(id, userId) {
  if (!id || !userId) return false;
  const stmt = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?');
  const res = stmt.run(id, userId);
  return res.changes > 0;
}

/**
 * Returns all distinct TV shows followed by active users that have an external_id.
 * Used by the background scheduler to deduplicate TVMaze API calls across all users.
 */
export function getAllDistinctFollowedTVShows() {
  return db.prepare(`
    SELECT DISTINCT external_id, title
    FROM media_items
    WHERE type = 'tv'
      AND external_id IS NOT NULL
      AND status != 'dropped'
  `).all();
}

/**
 * Updates all instances of a TV show matching external_id with newly fetched TVMaze data,
 * and records last_synced_at timestamp.
 */
export function updateShowScheduleAcrossUsers(externalId, syncData) {
  if (!externalId || !syncData) return 0;

  const stmt = db.prepare(`
    UPDATE media_items
    SET latest_season = ?,
        latest_episode = ?,
        latest_episode_name = ?,
        latest_air_date = ?,
        next_air_date = ?,
        total_episodes = ?,
        last_synced_at = datetime('now', 'localtime'),
        updated_at = datetime('now', 'localtime')
    WHERE type = 'tv' AND external_id = ?
  `);

  const res = stmt.run(
    Number(syncData.latest_season) || 1,
    Number(syncData.latest_episode) || 0,
    syncData.latest_episode_name || '',
    syncData.latest_air_date || null,
    syncData.next_air_date || null,
    Number(syncData.total_episodes) || 0,
    String(externalId)
  );

  return res.changes;
}

/**
 * Returns all users actively watching a show with external_id where new episodes have aired
 * ahead of the user's current progress.
 */
export function getUsersBehindOnShow(externalId, latestSeason, latestEpisode) {
  if (!externalId) return [];

  return db.prepare(`
    SELECT id, user_id, title, current_season, current_episode, latest_season, latest_episode, notify_enabled
    FROM media_items
    WHERE type = 'tv'
      AND external_id = ?
      AND status != 'dropped'
      AND (notify_enabled IS NULL OR notify_enabled = 1)
      AND (
        ? > current_season
        OR (? = current_season AND ? > current_episode)
      )
  `).all(externalId, latestSeason, latestSeason, latestEpisode);
}

/**
 * TV Episodes Cache Helpers
 */
export function getCachedEpisodes(externalId) {
  if (!externalId) return null;
  try {
    const row = db.prepare('SELECT episodes_json FROM tv_episodes_cache WHERE external_id = ?').get(String(externalId));
    if (!row) return null;
    return JSON.parse(row.episodes_json);
  } catch (err) {
    return null;
  }
}

export function setCachedEpisodes(externalId, episodes) {
  if (!externalId || !episodes) return;
  try {
    const json = typeof episodes === 'string' ? episodes : JSON.stringify(episodes);
    const stmt = db.prepare(`
      INSERT INTO tv_episodes_cache (external_id, episodes_json, updated_at)
      VALUES (?, ?, datetime('now', 'localtime'))
      ON CONFLICT(external_id) DO UPDATE SET
        episodes_json = excluded.episodes_json,
        updated_at = datetime('now', 'localtime')
    `);
    stmt.run(String(externalId), json);
  } catch (err) {
    console.error('Failed to set tv_episodes_cache:', err.message);
  }
}

export function deleteCachedEpisodes(externalId) {
  if (!externalId) return;
  try {
    db.prepare('DELETE FROM tv_episodes_cache WHERE external_id = ?').run(String(externalId));
  } catch (err) {
    console.error('Failed to delete tv_episodes_cache:', err.message);
  }
}

// ==========================================
// WATCHED EPISODES - Scoped to userId & mediaId
// ==========================================
// WATCHED EPISODES & CONSUMPTION CYCLES
// ==========================================

export function getCurrentItemCycle(userId, itemType, itemId) {
  if (!userId || !itemType || !itemId) return 1;
  if (itemType === 'movie' || itemType === 'tv') {
    const row = db.prepare('SELECT current_cycle FROM media_items WHERE id = ? AND user_id = ?').get(itemId, userId);
    return row?.current_cycle || 1;
  } else if (itemType === 'book') {
    const row = db.prepare('SELECT current_cycle FROM books WHERE id = ? AND user_id = ?').get(itemId, userId);
    return row?.current_cycle || 1;
  }
  return 1;
}

export function getItemCycles(userId, itemType, itemId) {
  if (!userId || !itemType || !itemId) return [];
  return db.prepare(`
    SELECT * FROM consumption_cycles
    WHERE user_id = ? AND item_type = ? AND item_id = ?
    ORDER BY cycle_number ASC
  `).all(userId, itemType, itemId);
}

export function startItemCycle(userId, itemType, itemId) {
  if (!userId || !itemType || !itemId) throw new Error('Invalid cycle parameters');

  let item;
  if (itemType === 'movie' || itemType === 'tv') {
    item = db.prepare('SELECT * FROM media_items WHERE id = ? AND user_id = ?').get(itemId, userId);
  } else if (itemType === 'book') {
    item = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(itemId, userId);
  }
  if (!item) {
    const err = new Error('Item not found');
    err.status = 404;
    throw err;
  }

  // Prevent accidental duplicates: check if in_progress cycle already exists
  const existingActive = db.prepare(`
    SELECT * FROM consumption_cycles
    WHERE user_id = ? AND item_type = ? AND item_id = ? AND status = 'in_progress'
    ORDER BY cycle_number DESC LIMIT 1
  `).get(userId, itemType, itemId);

  if (existingActive) {
    return {
      alreadyActive: true,
      cycle: existingActive,
      cycleNumber: existingActive.cycle_number
    };
  }

  const latest = db.prepare(`
    SELECT cycle_number FROM consumption_cycles
    WHERE user_id = ? AND item_type = ? AND item_id = ?
    ORDER BY cycle_number DESC LIMIT 1
  `).get(userId, itemType, itemId);

  const nextCycleNumber = Math.max(latest?.cycle_number || 0, item.current_cycle || 1) + 1;

  db.exec('BEGIN TRANSACTION');
  try {
    // If the previous cycle was completed, ensure a completed row exists in consumption_cycles
    // so previous completions, dates, and progress are permanently preserved
    const prevCycleNum = item.current_cycle || 1;
    if (item.status === 'completed') {
      const existingPrev = db.prepare(`
        SELECT id FROM consumption_cycles
        WHERE user_id = ? AND item_type = ? AND item_id = ? AND cycle_number = ?
      `).get(userId, itemType, itemId, prevCycleNum);

      if (!existingPrev) {
        const finishDate = item.updated_at || item.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19);
        let progressVal = 1;
        if (itemType === 'book') {
          progressVal = Number(item.page_count) || Number(item.current_page) || 1;
        } else if (itemType === 'tv') {
          progressVal = Number(item.current_episode) || 1;
        }
        db.prepare(`
          INSERT INTO consumption_cycles (
            user_id, item_type, item_id, cycle_number, status, progress_value,
            started_at, completed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
        `).run(userId, itemType, itemId, prevCycleNum, progressVal, item.created_at || finishDate, finishDate, item.created_at || finishDate, finishDate);
      }
    }

    const insertStmt = db.prepare(`
      INSERT INTO consumption_cycles (
        user_id, item_type, item_id, cycle_number, status, progress_value,
        started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'in_progress', 0, datetime('now', 'localtime'), datetime('now', 'localtime'), datetime('now', 'localtime'))
    `);
    const res = insertStmt.run(userId, itemType, itemId, nextCycleNumber);

    if (itemType === 'movie') {
      db.prepare(`UPDATE media_items SET current_cycle = ?, status = 'watching', updated_at = datetime('now', 'localtime') WHERE id = ? AND user_id = ?`)
        .run(nextCycleNumber, itemId, userId);
    } else if (itemType === 'tv') {
      db.prepare(`UPDATE media_items SET current_cycle = ?, current_season = 1, current_episode = 0, status = 'watching', updated_at = datetime('now', 'localtime') WHERE id = ? AND user_id = ?`)
        .run(nextCycleNumber, itemId, userId);
    } else if (itemType === 'book') {
      db.prepare(`UPDATE books SET current_cycle = ?, current_page = 0, status = 'reading', updated_at = datetime('now', 'localtime') WHERE id = ? AND user_id = ?`)
        .run(nextCycleNumber, itemId, userId);
    }

    db.exec('COMMIT');

    const createdCycle = db.prepare('SELECT * FROM consumption_cycles WHERE id = ?').get(res.lastInsertRowid);
    return {
      alreadyActive: false,
      cycle: createdCycle,
      cycleNumber: nextCycleNumber
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function completeItemCycle(userId, itemType, itemId, completedAt = null) {
  if (!userId || !itemType || !itemId) throw new Error('Invalid cycle parameters');

  let item;
  if (itemType === 'movie' || itemType === 'tv') {
    item = db.prepare('SELECT * FROM media_items WHERE id = ? AND user_id = ?').get(itemId, userId);
  } else if (itemType === 'book') {
    item = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(itemId, userId);
  }
  if (!item) {
    const err = new Error('Item not found');
    err.status = 404;
    throw err;
  }

  const currentCycleNum = item.current_cycle || 1;
  const finishDate = completedAt || new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.exec('BEGIN TRANSACTION');
  try {
    const existing = db.prepare(`
      SELECT * FROM consumption_cycles
      WHERE user_id = ? AND item_type = ? AND item_id = ? AND cycle_number = ?
    `).get(userId, itemType, itemId, currentCycleNum);

    if (item.status === 'completed' && existing && existing.status === 'completed') {
      db.exec('ROLLBACK');
      return { success: true, cycleNumber: currentCycleNum, completedAt: existing.completed_at || finishDate, alreadyCompleted: true };
    }

    if (itemType === 'movie') {
      if (existing) {
        db.prepare(`
          UPDATE consumption_cycles
          SET status = 'completed', completed_at = ?, progress_value = 1, updated_at = datetime('now', 'localtime')
          WHERE id = ?
        `).run(finishDate, existing.id);
      } else {
        db.prepare(`
          INSERT INTO consumption_cycles (
            user_id, item_type, item_id, cycle_number, status, progress_value,
            started_at, completed_at, created_at, updated_at
          ) VALUES (?, 'movie', ?, ?, 'completed', 1, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(userId, itemId, currentCycleNum, item.created_at || finishDate, finishDate);
      }

      db.prepare(`UPDATE media_items SET status = 'completed', updated_at = ? WHERE id = ? AND user_id = ?`)
        .run(finishDate, itemId, userId);
      logActivity({
        userId,
        activityType: 'movie_watched',
        itemType: 'movie',
        itemId,
        minutesViewed: item.runtime || 0,
        cycleNumber: currentCycleNum,
        isCorrection: 0,
        createdAt: finishDate
      });
    } else if (itemType === 'tv') {
      if (existing) {
        db.prepare(`
          UPDATE consumption_cycles
          SET status = 'completed', completed_at = ?, updated_at = datetime('now', 'localtime')
          WHERE id = ?
        `).run(finishDate, existing.id);
      } else {
        db.prepare(`
          INSERT INTO consumption_cycles (
            user_id, item_type, item_id, cycle_number, status, progress_value,
            started_at, completed_at, created_at, updated_at
          ) VALUES (?, 'tv', ?, ?, 'completed', ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(userId, itemId, currentCycleNum, item.current_episode || 0, item.created_at || finishDate, finishDate);
      }

      db.prepare(`UPDATE media_items SET status = 'completed', updated_at = ? WHERE id = ? AND user_id = ?`)
        .run(finishDate, itemId, userId);
    } else if (itemType === 'book') {
      const totalP = Number(item.page_count) || 0;
      const curP = Number(item.current_page) || 0;
      const finalPage = totalP > 0 ? totalP : curP;
      const remainingPages = totalP > 0 ? Math.max(0, totalP - curP) : 0;

      if (existing) {
        db.prepare(`
          UPDATE consumption_cycles
          SET status = 'completed', completed_at = ?, progress_value = ?, updated_at = datetime('now', 'localtime')
          WHERE id = ?
        `).run(finishDate, finalPage, existing.id);
      } else {
        db.prepare(`
          INSERT INTO consumption_cycles (
            user_id, item_type, item_id, cycle_number, status, progress_value,
            started_at, completed_at, created_at, updated_at
          ) VALUES (?, 'book', ?, ?, 'completed', ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(userId, itemId, currentCycleNum, finalPage, item.created_at || finishDate, finishDate);
      }

      db.prepare(`UPDATE books SET status = 'completed', current_page = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
        .run(finalPage, finishDate, itemId, userId);

      logActivity({
        userId,
        activityType: 'book_completed',
        itemType: 'book',
        itemId,
        pagesRead: remainingPages,
        isCorrection: 0,
        cycleNumber: currentCycleNum,
        createdAt: finishDate
      });
    }

    db.exec('COMMIT');
    return { success: true, cycleNumber: currentCycleNum, completedAt: finishDate };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function getWatchedEpisodes(mediaId, userId, cycleNumber = null) {
  if (!mediaId || !userId) return [];
  if (cycleNumber !== null && cycleNumber !== undefined) {
    return db.prepare(`
      SELECT * FROM watched_episodes
      WHERE media_id = ? AND user_id = ? AND cycle_number = ?
      ORDER BY season ASC, episode ASC
    `).all(mediaId, userId, cycleNumber);
  }
  return db.prepare(`
    SELECT * FROM watched_episodes
    WHERE media_id = ? AND user_id = ? AND cycle_number = (
      SELECT COALESCE(current_cycle, 1) FROM media_items WHERE id = ? AND user_id = ?
    )
    ORDER BY season ASC, episode ASC
  `).all(mediaId, userId, mediaId, userId);
}

export function getAllWatchedEpisodes(userId) {
  if (!userId) return [];
  return db.prepare(`
    SELECT * FROM watched_episodes
    WHERE user_id = ?
    ORDER BY watched_at DESC, id DESC
  `).all(userId);
}

export function getWatchedEpisodesSet(mediaId, userId, cycleNumber = null) {
  if (!mediaId || !userId) return new Set();
  let rows;
  if (cycleNumber !== null && cycleNumber !== undefined) {
    rows = db.prepare(`
      SELECT season, episode FROM watched_episodes
      WHERE media_id = ? AND user_id = ? AND cycle_number = ?
    `).all(mediaId, userId, cycleNumber);
  } else {
    rows = db.prepare(`
      SELECT season, episode FROM watched_episodes
      WHERE media_id = ? AND user_id = ? AND cycle_number = (
        SELECT COALESCE(current_cycle, 1) FROM media_items WHERE id = ? AND user_id = ?
      )
    `).all(mediaId, userId, mediaId, userId);
  }
  const set = new Set();
  for (const r of rows) {
    set.add(`${r.season}-${r.episode}`);
  }
  return set;
}

export function isEpisodeWatched(mediaId, userId, season, episode, cycleNumber = null) {
  if (!mediaId || !userId) return false;
  const cycle = cycleNumber || getCurrentItemCycle(userId, 'tv', mediaId);
  const row = db.prepare(`
    SELECT 1 FROM watched_episodes
    WHERE media_id = ? AND user_id = ? AND season = ? AND episode = ? AND cycle_number = ?
  `).get(mediaId, userId, season, episode, cycle);
  return Boolean(row);
}

export function markEpisodeWatched(mediaId, userId, season, episode, episodeId = null, cycleNumber = null) {
  if (!mediaId || !userId) return false;
  const cycle = cycleNumber || getCurrentItemCycle(userId, 'tv', mediaId);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO watched_episodes (user_id, media_id, season, episode, episode_id, cycle_number)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const res = stmt.run(userId, mediaId, season, episode, episodeId, cycle);
  return res.changes > 0;
}

export function unmarkEpisodeWatched(mediaId, userId, season, episode, cycleNumber = null) {
  if (!mediaId || !userId) return false;
  const cycle = cycleNumber || getCurrentItemCycle(userId, 'tv', mediaId);
  const stmt = db.prepare(`
    DELETE FROM watched_episodes
    WHERE media_id = ? AND user_id = ? AND season = ? AND episode = ? AND cycle_number = ?
  `);
  const res = stmt.run(mediaId, userId, season, episode, cycle);
  return res.changes > 0;
}

/**
 * Checks whether an episode has ever been watched by a user across ANY consumption cycle,
 * or if the show was previously completed in an earlier cycle.
 * This ensures starting a rewatch never recreates release notifications for old episodes.
 */
export function hasEverWatchedEpisode(mediaId, userId, season, episode) {
  if (!mediaId || !userId) return false;
  const s = Number(season);
  const ep = Number(episode);

  // 1. Check watched_episodes across ALL cycles
  const row = db.prepare(`
    SELECT 1 FROM watched_episodes
    WHERE media_id = ? AND user_id = ? AND season = ? AND episode = ?
    LIMIT 1
  `).get(mediaId, userId, s, ep);
  if (row) return true;

  // 2. Check consumption_cycles: if any earlier cycle was completed for this show
  const currentCycle = getCurrentItemCycle(userId, 'tv', mediaId);
  const completedCycle = db.prepare(`
    SELECT 1 FROM consumption_cycles
    WHERE user_id = ? AND item_type = 'tv' AND item_id = ? AND status = 'completed' AND cycle_number < ?
    LIMIT 1
  `).get(userId, mediaId, currentCycle);
  if (completedCycle) {
    return true;
  }

  return false;
}

export function markEpisodesBatch(mediaId, userId, episodesList, cycleNumber = null) {
  if (!mediaId || !userId || !Array.isArray(episodesList) || episodesList.length === 0) return 0;
  const cycle = cycleNumber || getCurrentItemCycle(userId, 'tv', mediaId);
  db.exec('BEGIN TRANSACTION');
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO watched_episodes (user_id, media_id, season, episode, episode_id, cycle_number)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let count = 0;
    for (const ep of episodesList) {
      const res = stmt.run(userId, mediaId, ep.season, ep.episode, ep.episodeId || null, cycle);
      if (res.changes > 0) count++;
    }
    db.exec('COMMIT');
    return count;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function unmarkEpisodesBatch(mediaId, userId, episodesList, cycleNumber = null) {
  if (!mediaId || !userId || !Array.isArray(episodesList) || episodesList.length === 0) return 0;
  const cycle = cycleNumber || getCurrentItemCycle(userId, 'tv', mediaId);
  db.exec('BEGIN TRANSACTION');
  try {
    const stmt = db.prepare(`
      DELETE FROM watched_episodes
      WHERE media_id = ? AND user_id = ? AND season = ? AND episode = ? AND cycle_number = ?
    `);
    let count = 0;
    for (const ep of episodesList) {
      const res = stmt.run(mediaId, userId, ep.season, ep.episode, cycle);
      if (res.changes > 0) count++;
    }
    db.exec('COMMIT');
    return count;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function markEpisodeWatchedWithCatchUp(mediaId, userId, targetEpisode, earlierEpisodes = [], leaveDateUnknown = true, cycleNumber = null) {
  if (!mediaId || !userId || !targetEpisode) return { success: false, targetNewlyMarked: false, earlierMarkedCount: 0 };
  const cycle = cycleNumber || getCurrentItemCycle(userId, 'tv', mediaId);

  db.exec('BEGIN TRANSACTION');
  try {
    const isTargetAlreadyWatched = isEpisodeWatched(mediaId, userId, targetEpisode.season, targetEpisode.number, cycle);
    let targetNewlyMarked = false;
    if (!isTargetAlreadyWatched) {
      const stmtTarget = db.prepare(`
        INSERT OR IGNORE INTO watched_episodes (user_id, media_id, season, episode, episode_id, cycle_number, watched_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      `);
      const res = stmtTarget.run(userId, mediaId, targetEpisode.season, targetEpisode.number, targetEpisode.id || null, cycle);
      if (res.changes > 0) {
        targetNewlyMarked = true;
        logActivity({
          userId,
          activityType: 'episode_watched',
          itemType: 'tv',
          itemId: mediaId,
          season: targetEpisode.season,
          episode: targetEpisode.number,
          minutesViewed: targetEpisode.runtime || 0,
          isCorrection: 0,
          cycleNumber: cycle
        });
      }
    }

    let earlierMarkedCount = 0;
    const earlierWatchedAt = leaveDateUnknown ? null : db.prepare("SELECT datetime('now', 'localtime') as now").get().now;

    const stmtEarlier = db.prepare(`
      INSERT OR IGNORE INTO watched_episodes (user_id, media_id, season, episode, episode_id, cycle_number, watched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const ep of earlierEpisodes) {
      const alreadyWatched = isEpisodeWatched(mediaId, userId, ep.season, ep.number, cycle);
      if (!alreadyWatched) {
        const res = stmtEarlier.run(userId, mediaId, ep.season, ep.number, ep.id || null, cycle, earlierWatchedAt);
        if (res.changes > 0) {
          earlierMarkedCount++;
          if (!leaveDateUnknown) {
            logActivity({
              userId,
              activityType: 'episode_watched',
              itemType: 'tv',
              itemId: mediaId,
              season: ep.season,
              episode: ep.number,
              minutesViewed: ep.runtime || 0,
              isCorrection: 0,
              cycleNumber: cycle
            });
          }
        }
      }
    }

    db.exec('COMMIT');
    return {
      success: true,
      targetNewlyMarked,
      earlierMarkedCount
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function getWatchedCountsBySeason(mediaId, userId, cycleNumber = null) {
  if (!mediaId || !userId) return new Map();
  let rows;
  if (cycleNumber !== null && cycleNumber !== undefined) {
    rows = db.prepare(`
      SELECT season, COUNT(*) as count
      FROM watched_episodes
      WHERE media_id = ? AND user_id = ? AND cycle_number = ?
      GROUP BY season
    `).all(mediaId, userId, cycleNumber);
  } else {
    rows = db.prepare(`
      SELECT season, COUNT(*) as count
      FROM watched_episodes
      WHERE media_id = ? AND user_id = ? AND cycle_number = (
        SELECT COALESCE(current_cycle, 1) FROM media_items WHERE id = ? AND user_id = ?
      )
      GROUP BY season
    `).all(mediaId, userId, mediaId, userId);
  }
  const map = new Map();
  for (const r of rows) {
    map.set(r.season, r.count);
  }
  return map;
}

// ==========================================
// ACTIVITY LOGGING (Personal Statistics & History)
// ==========================================

export function logActivity({
  userId,
  activityType,
  itemType,
  itemId,
  season = null,
  episode = null,
  pagesRead = 0,
  minutesViewed = 0,
  isCorrection = 0,
  cycleNumber = 1,
  createdAt = null
}) {
  if (!userId || !activityType || !itemType || !itemId) return null;
  const stmt = db.prepare(`
    INSERT INTO activity_log (
      user_id, activity_type, item_type, item_id, season, episode,
      pages_read, minutes_viewed, is_correction, cycle_number, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now', 'localtime')))
  `);
  const res = stmt.run(
    userId, activityType, itemType, itemId, season, episode,
    Number(pagesRead) || 0, Number(minutesViewed) || 0, isCorrection ? 1 : 0, Number(cycleNumber) || 1, createdAt
  );
  return res.lastInsertRowid;
}

export function getUserActivities(userId, filters = {}) {
  if (!userId) return [];
  let query = `
    SELECT a.*,
      CASE 
        WHEN a.item_type IN ('movie', 'tv') THEN m.title
        WHEN a.item_type = 'book' THEN b.title
        ELSE 'Unknown Title'
      END as title,
      CASE
        WHEN a.item_type IN ('movie', 'tv') THEN m.poster_url
        WHEN a.item_type = 'book' THEN b.cover_url
        ELSE NULL
      END as cover_url
    FROM activity_log a
    LEFT JOIN media_items m ON a.item_type IN ('movie', 'tv') AND a.item_id = m.id AND m.user_id = a.user_id
    LEFT JOIN books b ON a.item_type = 'book' AND a.item_id = b.id AND b.user_id = a.user_id
    WHERE a.user_id = ?
  `;
  const params = [userId];

  if (filters.startDate) {
    query += ' AND a.created_at >= ?';
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    query += ' AND a.created_at <= ?';
    params.push(filters.endDate);
  }
  if (filters.activityType) {
    query += ' AND a.activity_type = ?';
    params.push(filters.activityType);
  }
  if (filters.excludeCorrections) {
    query += ' AND a.is_correction = 0';
  }

  query += ' ORDER BY a.created_at DESC, a.id DESC';
  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(Number(filters.limit));
  }
  return db.prepare(query).all(...params);
}

export function getActivityById(id, userId) {
  if (!id || !userId) return null;
  return db.prepare('SELECT * FROM activity_log WHERE id = ? AND user_id = ?').get(id, userId);
}

export function updateActivityEntry(id, userId, { pagesRead, minutesViewed, isCorrection = 1 }) {
  if (!id || !userId) return false;
  const stmt = db.prepare(`
    UPDATE activity_log
    SET pages_read = COALESCE(?, pages_read),
        minutes_viewed = COALESCE(?, minutes_viewed),
        is_correction = ?
    WHERE id = ? AND user_id = ?
  `);
  const res = stmt.run(
    pagesRead !== undefined ? Number(pagesRead) : null,
    minutesViewed !== undefined ? Number(minutesViewed) : null,
    isCorrection ? 1 : 0,
    id,
    userId
  );
  return res.changes > 0;
}

export function deleteActivityEntry(id, userId) {
  if (!id || !userId) return false;
  const res = db.prepare('DELETE FROM activity_log WHERE id = ? AND user_id = ?').run(id, userId);
  return res.changes > 0;
}

export function removeActivityLog(userId, { itemType, itemId, season = null, episode = null, cycleNumber = null }) {
  if (!userId || !itemType || !itemId) return 0;
  const cycle = cycleNumber || getCurrentItemCycle(userId, itemType, itemId);
  let query = 'DELETE FROM activity_log WHERE user_id = ? AND item_type = ? AND item_id = ?';
  const params = [userId, itemType, itemId];
  if (cycle !== null && cycle !== undefined) {
    query += ' AND cycle_number = ?';
    params.push(cycle);
  }
  if (season !== null && season !== undefined) {
    query += ' AND season = ?';
    params.push(season);
  }
  if (episode !== null && episode !== undefined) {
    query += ' AND episode = ?';
    params.push(episode);
  }
  const res = db.prepare(query).run(...params);
  return res.changes;
}

export function updateMovieActivityMinutes(userId, mediaId, minutes) {
  if (!userId || !mediaId || !minutes) return 0;
  const mins = Number(minutes);
  if (isNaN(mins) || mins <= 0) return 0;
  const res = db.prepare(`
    UPDATE activity_log
    SET minutes_viewed = ?
    WHERE user_id = ? AND item_type = 'movie' AND item_id = ? AND (minutes_viewed IS NULL OR minutes_viewed = 0)
  `).run(mins, userId, mediaId);
  return res.changes;
}



