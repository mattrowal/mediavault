-- Migration 009: Add is_runtime_manual column to media_items
-- Preserves user-corrected runtime across future TMDB metadata refreshes

ALTER TABLE media_items ADD COLUMN is_runtime_manual INTEGER NOT NULL DEFAULT 0;
