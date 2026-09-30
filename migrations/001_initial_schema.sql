-- Migration 001: Initial MediaVault Schema
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
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  external_id TEXT,
  poster_url TEXT,
  release_year TEXT,
  genre TEXT,
  status TEXT NOT NULL DEFAULT 'watching',
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
  owned INTEGER DEFAULT 1,
  format TEXT DEFAULT 'Hardcover',
  status TEXT DEFAULT 'unread',
  rating INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_media_user ON media_items(user_id);
CREATE INDEX IF NOT EXISTS idx_media_type_status ON media_items(user_id, type, status);
CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_books_owned_status ON books(user_id, owned, status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
