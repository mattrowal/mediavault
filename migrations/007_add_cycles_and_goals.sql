-- ==========================================================
-- Migration 007: Add Consumption Cycles, Goals, Plans & Notifications Preferences
-- ==========================================================

-- 1. Create consumption_cycles table for rewatch / reread tracking
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_cycles_user_item_cycle 
  ON consumption_cycles(user_id, item_type, item_id, cycle_number);

CREATE INDEX IF NOT EXISTS idx_cycles_user_item_status 
  ON consumption_cycles(user_id, item_type, item_id, status);

-- 2. Add current_cycle and notify_enabled to media_items
ALTER TABLE media_items ADD COLUMN current_cycle INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media_items ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 1;

-- 3. Add current_cycle to books
ALTER TABLE books ADD COLUMN current_cycle INTEGER NOT NULL DEFAULT 1;

-- 4. Update watched_episodes with cycle_number
ALTER TABLE watched_episodes ADD COLUMN cycle_number INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS idx_watched_episodes_user_media_season_ep;
CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_episodes_user_media_cycle_season_ep
  ON watched_episodes(user_id, media_id, cycle_number, season, episode);

-- 5. Add cycle_number to activity_log
ALTER TABLE activity_log ADD COLUMN cycle_number INTEGER NOT NULL DEFAULT 1;

-- 6. Create personal_goals table for yearly/monthly goals
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_goals_unique 
  ON personal_goals(user_id, goal_type, year, ifnull(month, 0));

-- 7. Create saved_plans table for AI weekly planner
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

CREATE INDEX IF NOT EXISTS idx_saved_plans_user 
  ON saved_plans(user_id, created_at DESC);

-- 8. Safe, idempotent migration of existing progress to Cycle 1
-- Movies
INSERT INTO consumption_cycles (user_id, item_type, item_id, cycle_number, status, progress_value, started_at, completed_at, created_at, updated_at)
SELECT user_id, 'movie', id, 1, 
       CASE WHEN status = 'completed' THEN 'completed' ELSE 'in_progress' END,
       CASE WHEN status = 'completed' THEN 1 ELSE 0 END,
       created_at, NULL, created_at, created_at
FROM media_items
WHERE type = 'movie' AND user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM consumption_cycles c 
    WHERE c.user_id = media_items.user_id AND c.item_type = 'movie' AND c.item_id = media_items.id AND c.cycle_number = 1
  );

-- TV Shows
INSERT INTO consumption_cycles (user_id, item_type, item_id, cycle_number, status, progress_value, started_at, completed_at, created_at, updated_at)
SELECT user_id, 'tv', id, 1,
       CASE WHEN status = 'completed' THEN 'completed' ELSE 'in_progress' END,
       COALESCE(current_episode, 0),
       created_at, NULL, created_at, created_at
FROM media_items
WHERE type = 'tv' AND user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM consumption_cycles c 
    WHERE c.user_id = media_items.user_id AND c.item_type = 'tv' AND c.item_id = media_items.id AND c.cycle_number = 1
  );

-- Books
INSERT INTO consumption_cycles (user_id, item_type, item_id, cycle_number, status, progress_value, started_at, completed_at, created_at, updated_at)
SELECT user_id, 'book', id, 1,
       CASE WHEN status = 'read' THEN 'completed' ELSE 'in_progress' END,
       COALESCE(current_page, 0),
       created_at, NULL, created_at, created_at
FROM books
WHERE user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM consumption_cycles c 
    WHERE c.user_id = books.user_id AND c.item_type = 'book' AND c.item_id = books.id AND c.cycle_number = 1
  );
