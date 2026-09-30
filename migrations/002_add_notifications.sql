-- Migration 002: Add Notifications Table and Indexes
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER REFERENCES media_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'episode_release',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  air_date TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup 
  ON notifications(user_id, media_id, season, episode);

CREATE INDEX IF NOT EXISTS idx_notifications_user_read 
  ON notifications(user_id, is_read, created_at DESC);
