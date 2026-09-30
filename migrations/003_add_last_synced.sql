-- Migration 003: Add last_synced_at to media_items
-- Handled idempotently by migration runner
ALTER TABLE media_items ADD COLUMN last_synced_at TEXT DEFAULT NULL;
