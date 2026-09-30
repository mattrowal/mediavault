-- ==========================================================
-- Migration 006: Add Statistics & Activity Tracking
-- ==========================================================

-- 1. Add runtime column to media_items (minutes for movies/series)
ALTER TABLE media_items ADD COLUMN runtime INTEGER DEFAULT NULL;

-- 2. Create activity_log table for tracking dated reading and viewing sessions
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL, -- 'movie_watched', 'episode_watched', 'reading_progress', 'book_completed'
  item_type TEXT NOT NULL,     -- 'movie', 'tv', 'book'
  item_id INTEGER NOT NULL,
  season INTEGER DEFAULT NULL,
  episode INTEGER DEFAULT NULL,
  pages_read INTEGER DEFAULT 0,
  minutes_viewed INTEGER DEFAULT 0,
  is_correction INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- Performance and user isolation indexes
CREATE INDEX IF NOT EXISTS idx_activity_user_date ON activity_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user_type ON activity_log(user_id, activity_type);
