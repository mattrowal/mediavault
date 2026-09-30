-- Migration 004: Add TV episodes cache table
CREATE TABLE IF NOT EXISTS tv_episodes_cache (
  external_id TEXT PRIMARY KEY,
  episodes_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
