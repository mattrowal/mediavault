import { db } from './db.js';

/**
 * Validates whole positive integer targets.
 * @param {any} val 
 * @returns {boolean}
 */
export function isValidTarget(val) {
  const n = Number(val);
  return !isNaN(n) && Number.isInteger(n) && n > 0;
}

/**
 * Calculates start and end timestamp boundaries for a given goal.
 * @param {number} year 
 * @param {number|null} month 
 * @returns {{ startDate: string, endDate: string, daysRemaining: number, periodLabel: string }}
 */
export function getGoalTimeframe(year, month = null) {
  const now = new Date();
  const targetYear = Number(year) || now.getFullYear();
  let startDate, endDate, daysRemaining, periodLabel;

  if (month !== null && month !== undefined) {
    const m = Number(month);
    const mStr = String(m).padStart(2, '0');
    const lastDay = new Date(targetYear, m, 0).getDate();
    startDate = `${targetYear}-${mStr}-01 00:00:00`;
    endDate = `${targetYear}-${mStr}-${String(lastDay).padStart(2, '0')} 23:59:59`;

    const endOfTargetMonth = new Date(targetYear, m - 1, lastDay, 23, 59, 59);
    const diffMs = endOfTargetMonth.getTime() - now.getTime();
    daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    periodLabel = `${monthNames[m - 1]} ${targetYear}`;
  } else {
    startDate = `${targetYear}-01-01 00:00:00`;
    endDate = `${targetYear}-12-31 23:59:59`;

    const endOfTargetYear = new Date(targetYear, 11, 31, 23, 59, 59);
    const diffMs = endOfTargetYear.getTime() - now.getTime();
    daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    periodLabel = `${targetYear}`;
  }

  return { startDate, endDate, daysRemaining, periodLabel };
}

/**
 * Calculates current progress for a specific goal from recorded activities & cycles.
 * Excludes undated historical records.
 * 
 * @param {number|string} userId 
 * @param {object} goal 
 * @returns {{ currentProgress: number, percentage: number, explanation: string, timeRemainingText: string }}
 */
export function calculateGoalProgress(userId, goal) {
  const { startDate, endDate, daysRemaining, periodLabel } = getGoalTimeframe(goal.year, goal.month);
  let currentProgress = 0;
  let unit = '';
  let ruleExplanation = '';

  const goalType = goal.goal_type || goal.goalType;
  const includeRepeats = goal.include_repeats !== undefined ? Boolean(goal.include_repeats) : Boolean(goal.includeRepeats);

  if (goalType === 'books_yearly') {
    unit = 'books';
    const cycles = db.prepare(`
      SELECT c.item_id, c.cycle_number, c.completed_at
      FROM consumption_cycles c
      JOIN books b ON c.item_id = b.id AND c.user_id = b.user_id
      WHERE c.user_id = ? AND c.item_type = 'book' AND c.status = 'completed'
        AND c.completed_at IS NOT NULL
        AND c.completed_at >= ? AND c.completed_at <= ?
    `).all(userId, startDate, endDate);

    const countedBookIds = new Set(cycles.map(c => c.item_id));
    const fallbackBooks = db.prepare(`
      SELECT id, updated_at
      FROM books
      WHERE user_id = ? AND status = 'completed'
        AND updated_at IS NOT NULL
        AND updated_at >= ? AND updated_at <= ?
    `).all(userId, startDate, endDate);

    for (const fb of fallbackBooks) {
      if (!countedBookIds.has(fb.id)) {
        cycles.push({ item_id: fb.id, cycle_number: 1, completed_at: fb.updated_at });
        countedBookIds.add(fb.id);
      }
    }

    if (includeRepeats) {
      currentProgress = cycles.length;
      ruleExplanation = 'Counts all book completions during the year, including rereads.';
    } else {
      currentProgress = new Set(cycles.map(c => c.item_id)).size;
      ruleExplanation = 'Counts only unique book titles completed during the year (repeats excluded).';
    }
  } else if (goalType === 'movies_monthly') {
    unit = 'movies';
    const cycles = db.prepare(`
      SELECT c.item_id, c.cycle_number, c.completed_at
      FROM consumption_cycles c
      JOIN media_items m ON c.item_id = m.id AND c.user_id = m.user_id
      WHERE c.user_id = ? AND c.item_type = 'movie' AND c.status = 'completed'
        AND c.completed_at IS NOT NULL
        AND c.completed_at >= ? AND c.completed_at <= ?
    `).all(userId, startDate, endDate);

    const countedMovieIds = new Set(cycles.map(c => c.item_id));
    const fallbackMovies = db.prepare(`
      SELECT id, updated_at
      FROM media_items
      WHERE user_id = ? AND type = 'movie' AND status = 'completed'
        AND updated_at IS NOT NULL
        AND updated_at >= ? AND updated_at <= ?
    `).all(userId, startDate, endDate);

    for (const fm of fallbackMovies) {
      if (!countedMovieIds.has(fm.id)) {
        cycles.push({ item_id: fm.id, cycle_number: 1, completed_at: fm.updated_at });
        countedMovieIds.add(fm.id);
      }
    }

    if (includeRepeats) {
      currentProgress = cycles.length;
      ruleExplanation = 'Counts all movie completions during the month, including rewatches.';
    } else {
      currentProgress = new Set(cycles.map(c => c.item_id)).size;
      ruleExplanation = 'Counts only unique movie titles watched during the month (repeats excluded).';
    }
  } else if (goalType === 'pages_monthly') {
    unit = 'pages';
    // Pages read during a reread count as new reading activity, but progress corrections must not create extra pages
    const row = db.prepare(`
      SELECT COALESCE(SUM(pages_read), 0) as total_pages
      FROM activity_log
      WHERE user_id = ? AND item_type = 'book' AND is_correction = 0
        AND created_at >= ? AND created_at <= ?
    `).get(userId, startDate, endDate);

    currentProgress = Number(row?.total_pages) || 0;
    ruleExplanation = 'Counts pages read from active reading sessions. Metadata corrections are excluded.';
  }

  const percentage = Math.min(100, Math.round((currentProgress / goal.target) * 100));
  const timeRemainingText = daysRemaining > 0 
    ? `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining in ${periodLabel}`
    : `Time expired for ${periodLabel}`;

  const progressText = `${currentProgress} of ${goal.target} ${unit} completed ${goal.goal_type === 'books_yearly' ? 'this year' : 'this month'}.`;

  return {
    currentProgress,
    percentage,
    unit,
    progressText,
    ruleExplanation,
    timeRemainingText,
    daysRemaining,
    periodLabel
  };
}

/**
 * Retrieves all goals for a user, enriched with live calculated progress.
 * @param {number|string} userId 
 * @returns {Array<object>}
 */
export function getUserGoalsWithProgress(userId) {
  if (!userId) return [];
  const goals = db.prepare(`
    SELECT * FROM personal_goals
    WHERE user_id = ?
    ORDER BY year DESC, ifnull(month, 0) DESC, id DESC
  `).all(userId);

  return goals.map(goal => {
    const calc = calculateGoalProgress(userId, goal);
    return {
      id: goal.id,
      goalType: goal.goal_type,
      target: goal.target,
      year: goal.year,
      month: goal.month,
      includeRepeats: Boolean(goal.include_repeats),
      ...calc,
      createdAt: goal.created_at
    };
  });
}

/**
 * Creates a personal goal.
 * @param {number|string} userId 
 * @param {object} param1 
 * @returns {object}
 */
export function createUserGoal(userId, { goalType, target, year = null, month = null, includeRepeats = 1 }) {
  if (!userId) throw new Error('User ID is required');
  if (!['books_yearly', 'pages_monthly', 'movies_monthly'].includes(goalType)) {
    throw new Error('Invalid goal type. Supported types: books_yearly, pages_monthly, movies_monthly.');
  }

  if (!isValidTarget(target)) {
    throw new Error('Target must be a positive whole integer greater than zero.');
  }

  const now = new Date();
  const gYear = Number(year) || now.getFullYear();
  let gMonth = null;

  if (goalType.includes('monthly')) {
    gMonth = month !== null && month !== undefined ? Number(month) : (now.getMonth() + 1);
    if (isNaN(gMonth) || gMonth < 1 || gMonth > 12) {
      throw new Error('Month must be between 1 and 12.');
    }
  }

  // Prevent accidental duplicates
  const existing = db.prepare(`
    SELECT id FROM personal_goals
    WHERE user_id = ? AND goal_type = ? AND year = ? AND ifnull(month, 0) = ?
  `).get(userId, goalType, gYear, gMonth || 0);

  if (existing) {
    const err = new Error(`An active goal of this type already exists for ${gMonth ? `month ${gMonth}/` : ''}${gYear}. Edit the existing goal instead.`);
    err.status = 409;
    throw err;
  }

  const stmt = db.prepare(`
    INSERT INTO personal_goals (user_id, goal_type, target, year, month, include_repeats)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const res = stmt.run(userId, goalType, Number(target), gYear, gMonth, includeRepeats ? 1 : 0);
  const created = db.prepare('SELECT * FROM personal_goals WHERE id = ?').get(res.lastInsertRowid);
  const progressInfo = calculateGoalProgress(userId, created);

  return {
    id: created.id,
    goalType: created.goal_type,
    target: created.target,
    year: created.year,
    month: created.month,
    includeRepeats: Boolean(created.include_repeats),
    ...progressInfo,
    createdAt: created.created_at
  };
}

/**
 * Updates an existing goal.
 * @param {number|string} id 
 * @param {number|string} userId 
 * @param {object} param2 
 * @returns {object}
 */
export function updateUserGoal(id, userId, { target, includeRepeats }) {
  const goal = db.prepare('SELECT * FROM personal_goals WHERE id = ? AND user_id = ?').get(id, userId);
  if (!goal) {
    const err = new Error('Goal not found or unauthorized');
    err.status = 404;
    throw err;
  }

  let newTarget = goal.target;
  if (target !== undefined) {
    if (!isValidTarget(target)) {
      throw new Error('Target must be a positive whole integer greater than zero.');
    }
    newTarget = Number(target);
  }

  const newIncludeRepeats = includeRepeats !== undefined ? (includeRepeats ? 1 : 0) : goal.include_repeats;

  db.prepare(`
    UPDATE personal_goals
    SET target = ?, include_repeats = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ? AND user_id = ?
  `).run(newTarget, newIncludeRepeats, id, userId);

  const updated = db.prepare('SELECT * FROM personal_goals WHERE id = ?').get(id);
  const progressInfo = calculateGoalProgress(userId, updated);

  return {
    id: updated.id,
    goalType: updated.goal_type,
    target: updated.target,
    year: updated.year,
    month: updated.month,
    includeRepeats: Boolean(updated.include_repeats),
    ...progressInfo,
    updatedAt: updated.updated_at
  };
}

/**
 * Deletes a goal.
 * @param {number|string} id 
 * @param {number|string} userId 
 * @returns {boolean}
 */
export function deleteUserGoal(id, userId) {
  const res = db.prepare('DELETE FROM personal_goals WHERE id = ? AND user_id = ?').run(id, userId);
  return res.changes > 0;
}
