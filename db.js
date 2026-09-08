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

// Initialize tables and performance indexes
export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

    CREATE INDEX IF NOT EXISTS idx_media_type_status ON media_items(type, status);
    CREATE INDEX IF NOT EXISTS idx_books_owned_status ON books(owned, status);
  `);
}

// Auto-run schema initialization
initDatabase();

// ==========================================
// MEDIA (Movies & TV Shows)
// ==========================================

export function getAllMedia(filters = {}) {
  let query = 'SELECT * FROM media_items WHERE 1=1';
  const params = [];

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

export function getMediaById(id) {
  return db.prepare('SELECT * FROM media_items WHERE id = ?').get(id);
}

export function addMedia(item) {
  const stmt = db.prepare(`
    INSERT INTO media_items (
      type, title, external_id, poster_url, release_year, genre,
      status, current_season, current_episode, latest_season,
      latest_episode, latest_episode_name, latest_air_date, next_air_date,
      total_episodes, rating, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = stmt.run(
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

  return getMediaById(res.lastInsertRowid);
}

export function updateMedia(id, fields) {
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

  if (setClauses.length === 0) return getMediaById(id);

  setClauses.push("updated_at = datetime('now', 'localtime')");
  params.push(id);

  const query = `UPDATE media_items SET ${setClauses.join(', ')} WHERE id = ?`;
  db.prepare(query).run(...params);

  return getMediaById(id);
}

export function incrementMediaEpisode(id) {
  const item = getMediaById(id);
  if (!item) return null;

  const nextEp = (item.current_episode || 0) + 1;
  return updateMedia(id, { current_episode: nextEp });
}

export function deleteMedia(id) {
  const stmt = db.prepare('DELETE FROM media_items WHERE id = ?');
  const res = stmt.run(id);
  return res.changes > 0;
}

export function getAllTVShowsWithExternalId() {
  return db.prepare("SELECT * FROM media_items WHERE type = 'tv' AND external_id IS NOT NULL").all();
}

// ==========================================
// BOOKS (Separate Ownership & Reading Status)
// ==========================================

export function getAllBooks(filters = {}) {
  let query = 'SELECT * FROM books WHERE 1=1';
  const params = [];

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

export function getBookById(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

export function addBook(item) {
  const stmt = db.prepare(`
    INSERT INTO books (
      title, author, cover_url, isbn, page_count, current_page,
      owned, format, status, rating, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = stmt.run(
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

  return getBookById(res.lastInsertRowid);
}

export function updateBook(id, fields) {
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

  if (setClauses.length === 0) return getBookById(id);

  setClauses.push("updated_at = datetime('now', 'localtime')");
  params.push(id);

  const query = `UPDATE books SET ${setClauses.join(', ')} WHERE id = ?`;
  db.prepare(query).run(...params);

  return getBookById(id);
}

export function deleteBook(id) {
  const stmt = db.prepare('DELETE FROM books WHERE id = ?');
  const res = stmt.run(id);
  return res.changes > 0;
}

// ==========================================
// DASHBOARD STATS
// ==========================================

export function getDashboardStats() {
  const totalMovies = db.prepare("SELECT COUNT(*) as c FROM media_items WHERE type = 'movie'").get().c;
  const completedMovies = db.prepare("SELECT COUNT(*) as c FROM media_items WHERE type = 'movie' AND status = 'completed'").get().c;
  const activeSeries = db.prepare("SELECT COUNT(*) as c FROM media_items WHERE type = 'tv' AND status = 'watching'").get().c;

  // TV shows that have released episodes ahead of what the user has watched
  const seriesWithNewEpisodes = db.prepare(`
    SELECT * FROM media_items
    WHERE type = 'tv'
      AND status = 'watching'
      AND (
        latest_season > current_season
        OR (latest_season = current_season AND latest_episode > current_episode)
      )
    ORDER BY updated_at DESC
  `).all();

  const currentlyWatching = db.prepare(`
    SELECT * FROM media_items
    WHERE status = 'watching'
    ORDER BY updated_at DESC
    LIMIT 6
  `).all();

  // Book statistics: clear separation between ownership and reading status
  const totalBooks = db.prepare('SELECT COUNT(*) as c FROM books').get().c;
  const ownedBooks = db.prepare('SELECT COUNT(*) as c FROM books WHERE owned = 1').get().c;
  const completedBooks = db.prepare("SELECT COUNT(*) as c FROM books WHERE status = 'completed'").get().c;
  const readingBooks = db.prepare("SELECT COUNT(*) as c FROM books WHERE status = 'reading'").get().c;
  // Books owned at home that are unread (Physical TBR)
  const ownedUnreadBooks = db.prepare("SELECT COUNT(*) as c FROM books WHERE owned = 1 AND status != 'completed'").get().c;

  const currentlyReading = db.prepare(`
    SELECT * FROM books
    WHERE status = 'reading'
    ORDER BY updated_at DESC
    LIMIT 6
  `).all();

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
// USER LIBRARY PROFILE FOR GENAI RECOMMENDATIONS
// ==========================================

export function getUserLibraryProfile() {
  const movies = db.prepare("SELECT title, release_year, genre, status, rating, notes FROM media_items WHERE type = 'movie'").all();
  const shows = db.prepare("SELECT title, genre, status, current_season, current_episode, rating, notes FROM media_items WHERE type = 'tv'").all();
  const books = db.prepare("SELECT title, author, format, owned, status, rating, notes FROM books").all();

  return {
    movies,
    shows,
    books
  };
}
