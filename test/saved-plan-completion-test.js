import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path (runs strictly serverless / offline)
const TEST_DB_PATH = path.join(rootDir, 'data', `test_saved_plan_completion_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  initDatabase,
  createUser,
  addBook,
  getBookById,
  addMedia,
  getMediaById,
  getUserActivities
} = await import('../db.js');

const {
  saveWeeklyPlan,
  getUserSavedPlans,
  deleteSavedPlan,
  completePlannerActivity
} = await import('../planner-service.js');

const {
  createUserGoal,
  getUserGoalsWithProgress
} = await import('../goals-service.js');

const {
  getPersonalStatistics
} = await import('../stats-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Saved Plan Activity Completion Test Suite');
console.log('   (Serverless: No HTTP server launched)');
console.log('====================================================\n');

initDatabase();

let totalChecks = 0;
let passedChecks = 0;

function check(desc, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  ✅ PASS: ${desc}`);
    passedChecks++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     ${err.message}`);
  }
}

async function asyncCheck(desc, fn) {
  totalChecks++;
  try {
    await fn();
    console.log(`  ✅ PASS: ${desc}`);
    passedChecks++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     ${err.message}`);
  }
}

// Extract the actual server.js route handler for /api/planner/complete-activity
const routeLayer = app._router.stack.find(r => r.route && r.route.path === '/api/planner/complete-activity');
if (!routeLayer) {
  throw new Error('Could not find /api/planner/complete-activity in server.js');
}
const serverRouteHandler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

async function callServerCompleteActivity(user, body = {}) {
  const req = {
    user: typeof user === 'object' ? user : { id: user },
    body
  };
  let resStatus = 200;
  let resBody = null;
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      resStatus = code;
      return this;
    },
    json(data) {
      this.data = data;
      resBody = data;
      return this;
    }
  };

  try {
    await serverRouteHandler(req, res);
  } catch (err) {
    const status = err.statusCode || 500;
    return { status, body: { error: err.message } };
  }
  return { status: resStatus, body: resBody };
}

try {
  // Setup users
  const user1 = createUser('alice_planner', 'alice@test.com', 'password123');
  const user2 = createUser('bob_planner', 'bob@test.com', 'password123');

  // Setup Emma: 100 pages, currently 0 pages, status unread
  const emmaBook = addBook({
    title: 'Emma',
    author: 'Jane Austen',
    page_count: 100,
    current_page: 0,
    status: 'unread'
  }, user1.id);

  // --- Suite 1: Saving a plan alone must not change reading progress ---
  console.log('--- Suite 1: Saving a Plan Alone ---');
  let savedPlan1 = null;

  check('Saving a plan alone does not alter book reading progress or log activity', () => {
    savedPlan1 = saveWeeklyPlan(user1.id, {
      title: 'Emma Reading Plan',
      budgetMinutes: 60,
      totalPlannedMinutes: 60,
      activities: [
        {
          candidateId: `book_${emmaBook.id}`,
          itemType: 'book',
          itemId: emmaBook.id,
          title: 'Emma',
          startPage: 1,
          endPage: 30,
          totalPages: 100,
          pagesToRead: 30,
          durationMinutes: 60,
          details: 'Read 30 pages (pg. 1–30 of 100)'
        }
      ]
    });

    assert.ok(savedPlan1 && savedPlan1.id, 'Plan should be saved');

    // Verify book is unchanged
    const b = getBookById(emmaBook.id, user1.id);
    assert.strictEqual(b.current_page, 0, 'Current page must remain 0 after saving plan');
    assert.strictEqual(b.status, 'unread', 'Status must remain unread after saving plan');

    // Verify 0 activities logged
    const acts = getUserActivities(user1.id);
    assert.strictEqual(acts.length, 0, 'No activities should be logged merely by saving a plan');
  });

  // --- Suite 2: Completing Emma session (pages 1–30) from saved history ---
  console.log('\n--- Suite 2: Activity Completion from Saved History ---');

  await asyncCheck('Completing Emma (pages 1-30) advances progress from 0 to 30 and sets status to reading', async () => {
    const res = await callServerCompleteActivity(user1, {
      planId: savedPlan1.id,
      activityIndex: 0,
      candidateId: `book_${emmaBook.id}`,
      itemType: 'book',
      itemId: emmaBook.id,
      endPage: 30
    });

    assert.strictEqual(res.status, 200, 'Endpoint should return 200 OK');
    assert.strictEqual(res.body.success, true, 'Result should be successful');
    assert.strictEqual(res.body.newlyCompleted, true, 'Should be flagged newlyCompleted');

    // Verify book progress advanced to 30
    const b = getBookById(emmaBook.id, user1.id);
    assert.strictEqual(b.current_page, 30, 'Current page must advance to 30');
    assert.strictEqual(b.status, 'reading', 'Status must be reading ("Reading Now")');

    // Verify activity_log recorded 30 pages
    const acts = getUserActivities(user1.id);
    const bookActs = acts.filter(a => a.item_type === 'book' && a.item_id === emmaBook.id);
    assert.strictEqual(bookActs.length, 1, 'Should record exactly 1 reading activity');
    assert.strictEqual(bookActs[0].pages_read, 30, 'Should record 30 newly read pages');
  });

  // --- Suite 3: Persistence across page refresh ---
  console.log('\n--- Suite 3: Persistence Across Page Refresh ---');

  check('Activity completed state persists and displays completed upon refresh', () => {
    // Simulate page refresh by fetching saved plans from database
    const plans = getUserSavedPlans(user1.id);
    assert.strictEqual(plans.length, 1);
    const act = plans[0].activities[0];
    assert.strictEqual(act.completed, true, 'Saved activity must have completed: true');
    assert.ok(act.completedAt, 'Saved activity must have completedAt timestamp');
  });

  // --- Suite 4: Repeated clicks and requests must not count twice ---
  console.log('\n--- Suite 4: Idempotency & Duplicate Request Prevention ---');

  await asyncCheck('Repeated requests do not count the same activity twice or add extra pages', async () => {
    const res = await callServerCompleteActivity(user1, {
      planId: savedPlan1.id,
      activityIndex: 0,
      candidateId: `book_${emmaBook.id}`,
      itemType: 'book',
      itemId: emmaBook.id,
      endPage: 30
    });

    assert.strictEqual(res.status, 200, 'Should return 200 OK');
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.alreadyCompleted, true, 'Should indicate alreadyCompleted');

    // Verify book is still at 30
    const b = getBookById(emmaBook.id, user1.id);
    assert.strictEqual(b.current_page, 30, 'Current page must remain 30');

    // Verify activity_log still has only 1 entry with 30 pages (zero extra pages)
    const acts = getUserActivities(user1.id);
    const bookActs = acts.filter(a => a.item_type === 'book' && a.item_id === emmaBook.id);
    assert.strictEqual(bookActs.length, 1, 'Still only 1 reading activity entry');
    assert.strictEqual(bookActs[0].pages_read, 30, 'Total logged pages remained 30');
  });

  // --- Suite 5: Overlapping reading progress handling ---
  console.log('\n--- Suite 5: Overlapping Progress Protection ---');

  await asyncCheck('Never moves reading progress backwards if reading already advanced', async () => {
    // Pride and Prejudice: 200 pages. User already read up to page 45.
    const pnpBook = addBook({
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      page_count: 200,
      current_page: 45,
      status: 'reading'
    }, user1.id);

    // Create a plan with session pages 1–30
    const planPnP = saveWeeklyPlan(user1.id, {
      title: 'P&P Plan',
      budgetMinutes: 60,
      totalPlannedMinutes: 60,
      activities: [
        {
          candidateId: `book_${pnpBook.id}`,
          itemType: 'book',
          itemId: pnpBook.id,
          title: 'Pride and Prejudice',
          startPage: 1,
          endPage: 30,
          totalPages: 200,
          durationMinutes: 60
        }
      ]
    });

    const res = await callServerCompleteActivity(user1, {
      planId: planPnP.id,
      activityIndex: 0,
      itemType: 'book',
      itemId: pnpBook.id,
      endPage: 30
    });

    assert.strictEqual(res.body.alreadyCompleted, true, 'Should detect progress already covered');

    // Verify reading progress was NOT moved backwards to 30!
    const b = getBookById(pnpBook.id, user1.id);
    assert.strictEqual(b.current_page, 45, 'Progress must remain 45, never moving backwards');

    // Verify 0 pages were logged for this session
    const pnpActs = getUserActivities(user1.id).filter(a => a.item_id === pnpBook.id);
    assert.strictEqual(pnpActs.length, 0, 'No pages should be logged for already surpassed session');

    // Verify activity in saved plan is marked completed
    const reloaded = getUserSavedPlans(user1.id).find(p => p.id === planPnP.id);
    assert.strictEqual(reloaded.activities[0].completed, true, 'Plan activity should be marked completed');
  });

  await asyncCheck('Partially overlapping progress logs only new unread delta pages', async () => {
    // Sense and Sensibility: 200 pages. User currently on page 10.
    const ssBook = addBook({
      title: 'Sense and Sensibility',
      author: 'Jane Austen',
      page_count: 200,
      current_page: 10,
      status: 'reading'
    }, user1.id);

    // Plan session covering pages 1–30
    const planSS = saveWeeklyPlan(user1.id, {
      title: 'S&S Plan',
      budgetMinutes: 60,
      totalPlannedMinutes: 60,
      activities: [
        {
          candidateId: `book_${ssBook.id}`,
          itemType: 'book',
          itemId: ssBook.id,
          title: 'Sense and Sensibility',
          startPage: 1,
          endPage: 30,
          totalPages: 200,
          durationMinutes: 60
        }
      ]
    });

    const res = await callServerCompleteActivity(user1, {
      planId: planSS.id,
      activityIndex: 0,
      itemType: 'book',
      itemId: ssBook.id,
      endPage: 30
    });

    assert.strictEqual(res.body.newlyCompleted, true);

    const b = getBookById(ssBook.id, user1.id);
    assert.strictEqual(b.current_page, 30, 'Progress must advance to 30');

    // Should only log 20 pages (30 - 10), never counting overlapping pages 1–10 again!
    const ssActs = getUserActivities(user1.id).filter(a => a.item_id === ssBook.id);
    assert.strictEqual(ssActs.length, 1);
    assert.strictEqual(ssActs[0].pages_read, 20, 'Must record only delta pages (20 pages), not 30');
  });

  // --- Suite 6: Account isolation ---
  console.log('\n--- Suite 6: Account Isolation ---');

  await asyncCheck('User 2 cannot complete or alter User 1 saved plan activities', async () => {
    const res = await callServerCompleteActivity(user2, {
      planId: savedPlan1.id,
      activityIndex: 0,
      itemType: 'book',
      itemId: emmaBook.id,
      endPage: 30
    });

    assert.strictEqual(res.status, 404, 'Must return 404 for unauthorized plan');
    assert.ok(res.body.error.includes('unauthorized') || res.body.error.includes('not found'));
  });

  // --- Suite 7: Goals and Statistics update ---
  console.log('\n--- Suite 7: Statistics and Goals Update ---');

  await asyncCheck('Personal statistics and monthly pages goals reflect newly read pages', async () => {
    // Current year and month
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;

    // Create a 100-pages monthly goal for User 1
    createUserGoal(user1.id, {
      goalType: 'pages_monthly',
      target: 100,
      year: curYear,
      month: curMonth
    });

    const userGoals = getUserGoalsWithProgress(user1.id);
    const pagesGoal = userGoals.find(g => g.goalType === 'pages_monthly' || g.goal_type === 'pages_monthly');
    assert.ok(pagesGoal, 'Goal should exist');
    // Total pages logged so far for User 1: Emma (30) + S&S (20) = 50 pages
    assert.strictEqual(pagesGoal.currentProgress, 50, 'Goal progress should reflect logged pages (50 pages)');

    // Check personal statistics (30 Emma + 45 P&P + 30 S&S = 105 pages)
    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.summary.totalPagesRead, 105, 'Statistics summary totalPagesRead should be 105');
  });

  // --- Suite 8: Full plan status update to completed ---
  console.log('\n--- Suite 8: Full Plan Completion ---');

  await asyncCheck('Completing all activities updates saved_plans status to completed', async () => {
    const movie = addMedia({
      title: 'Inception',
      type: 'movie',
      runtime: 148,
      status: 'plan_to_watch'
    }, user1.id);

    const fullPlan = saveWeeklyPlan(user1.id, {
      title: 'Weekend Movie & Book',
      budgetMinutes: 200,
      totalPlannedMinutes: 148,
      activities: [
        {
          candidateId: `movie_${movie.id}`,
          itemType: 'movie',
          itemId: movie.id,
          title: 'Inception',
          durationMinutes: 148
        }
      ]
    });

    assert.strictEqual(fullPlan.activities[0].completed, undefined);

    const res = await callServerCompleteActivity(user1, {
      planId: fullPlan.id,
      activityIndex: 0,
      itemType: 'movie',
      itemId: movie.id
    });

    assert.strictEqual(res.body.newlyCompleted, true);

    const plans = getUserSavedPlans(user1.id);
    const completedPlan = plans.find(p => p.id === fullPlan.id);
    assert.strictEqual(completedPlan.status, 'completed', 'Plan status must be completed when all activities done');
  });

} finally {
  // Clean up isolated test database
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
    if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch (_) {}
}

console.log('\n====================================================');
console.log(`Results: ${passedChecks} / ${totalChecks} checks passed`);
console.log('====================================================\n');

if (passedChecks === totalChecks) {
  process.exit(0);
} else {
  process.exit(1);
}
