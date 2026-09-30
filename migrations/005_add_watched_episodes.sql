-- Migration 005: Add watched_episodes table for individual episode tracking
CREATE TABLE IF NOT EXISTS watched_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  episode_id INTEGER,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  watched_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_episodes_user_media_season_ep
  ON watched_episodes(user_id, media_id, season, episode);

CREATE INDEX IF NOT EXISTS idx_watched_episodes_user_media
  ON watched_episodes(user_id, media_id);
