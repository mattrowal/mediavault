-- Migration 008: Repair book consumption cycles and activity records
-- Fixes books marked completed in books table whose cycle was left in_progress
-- Sets accurate completed_at from activity_log or book updated_at, without inventing dates for undated records

UPDATE consumption_cycles
SET status = 'completed',
    progress_value = COALESCE(
      (SELECT CASE WHEN page_count > 0 THEN page_count ELSE current_page END FROM books b WHERE b.id = consumption_cycles.item_id AND b.user_id = consumption_cycles.user_id),
      progress_value
    ),
    completed_at = COALESCE(
      (SELECT a.created_at FROM activity_log a WHERE a.user_id = consumption_cycles.user_id AND a.item_type = 'book' AND a.item_id = consumption_cycles.item_id AND a.activity_type = 'book_completed' ORDER BY a.id DESC LIMIT 1),
      (SELECT b.updated_at FROM books b WHERE b.id = consumption_cycles.item_id AND b.user_id = consumption_cycles.user_id)
    )
WHERE item_type = 'book'
  AND cycle_number = 1
  AND status = 'in_progress'
  AND item_id IN (SELECT id FROM books WHERE status = 'completed');

-- Repair book_completed activity records that were erroneously tagged as corrections
UPDATE activity_log
SET is_correction = 0
WHERE item_type = 'book'
  AND activity_type = 'book_completed'
  AND is_correction = 1
  AND pages_read > 0;
