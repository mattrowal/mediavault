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
  `);

  // Migrate existing media_items table if user_id column is missing
  if (!hasColumn('media_items', 'user_id')) {
    db.exec('ALTER TABLE media_items ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;');
  }

  // Migrate existing books table if user_id column is missing
  if (!hasColumn('books', 'user_id')) {
    db.exec('ALTER TABLE books ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;');
  }

  // Performance and isolation indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_user ON media_items(user_id);
    CREATE INDEX IF NOT EXISTS idx_media_type_status ON media_items(user_id, type, status);
    CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
    CREATE INDEX IF NOT EXISTS idx_books_owned_status ON books(user_id, owned, status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
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

  if (filters.status && filters.status !== 'all') {
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
      total_episodes, rating, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    item.notes || ''
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
    'total_episodes', 'rating', 'notes', 'external_id'
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

  // Filter by read status: 'completed' (read), 'reading', 'unread', 'wishlist'
  if (filters.status && filters.status !== 'all') {
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
