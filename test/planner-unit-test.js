import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path (runs strictly serverless / offline)
const TEST_DB_PATH = path.join(rootDir, 'data', `test_planner_unit_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const {
  db,
  createUser,
  addMedia,
  getMediaById,
  addBook,
  getBookById,
  getUserActivities
} = await import('../db.js');

const {
  parseTimeBudgetMinutes,
  getPlannerCandidates,
  generateWeeklyPlan,
  saveWeeklyPlan,
  getUserSavedPlans,
  deleteSavedPlan,
  completePlannerActivity
} = await import('../planner-service.js');

const {
  setMockEpisodeData,
  clearMockEpisodeData
} = await import('../episode-service.js');

console.log('====================================================');
console.log('🧪 MediaVault AI Weekly Planner Unit Test Suite');
console.log('   (Serverless: No HTTP server launched)');
console.log('====================================================\n');

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

try {
  // 1. Time Budget Parsing Tests
  console.log('--- 1. Time Budget Parsing & Validation ---');
  check('parseTimeBudgetMinutes handles various time formats', () => {
    assert.strictEqual(parseTimeBudgetMinutes('3 hours'), 180);
    assert.strictEqual(parseTimeBudgetMinutes('90 minutes'), 90);
    assert.strictEqual(parseTimeBudgetMinutes('90 mins'), 90);
    assert.strictEqual(parseTimeBudgetMinutes('2.5 hours'), 150);
    assert.strictEqual(parseTimeBudgetMinutes('1 hour 30 mins'), 90);
    assert.strictEqual(parseTimeBudgetMinutes('two hours'), 120);
    assert.strictEqual(parseTimeBudgetMinutes('three hours'), 180);
    assert.strictEqual(parseTimeBudgetMinutes(60), 60);
    assert.strictEqual(parseTimeBudgetMinutes('45'), 45);
    assert.strictEqual(parseTimeBudgetMinutes('0'), 0);
    assert.strictEqual(parseTimeBudgetMinutes(''), 0);
    assert.strictEqual(parseTimeBudgetMinutes('invalid'), 0);
  });

  // Setup test users
  const user1 = createUser('planner_alice', 'dummyhash1234567890', 'dummysalt1234567890');
  const user2 = createUser('planner_bob', 'dummyhash1234567890', 'dummysalt1234567890');

  // Add items to Alice's library
  // Movie 1: 90 mins
  const movie1 = addMedia({
    title: 'Interstellar Voyage',
    type: 'movie',
    status: 'plan_to_watch',
    runtime: 90
  }, user1.id);

  // Movie 2 (missing runtime metadata - should be excluded)
  const movieMissingRuntime = addMedia({
    title: 'Mystery Movie (No Runtime)',
    type: 'movie',
    status: 'plan_to_watch',
    runtime: null
  }, user1.id);

  // TV Show 1: Friends with mock episodes (20 mins each)
  const tvShow1 = addMedia({
    title: 'Friends',
    type: 'tv',
    status: 'watching',
    external_id: 'tv_friends_mock'
  }, user1.id);

  setMockEpisodeData('tv_friends_mock', [
    { id: 101, season: 1, number: 1, name: 'The One Where Monica Gets a Roommate', runtime: 22, airdate: '1994-09-22' },
    { id: 102, season: 1, number: 2, name: 'The One with the Sonogram at the End', runtime: 22, airdate: '1994-09-29' },
    { id: 103, season: 1, number: 3, name: 'Future Unreleased Episode', runtime: 22, airdate: '2099-01-01' }
  ]);

  // Book 1: 300 pages, on page 0
  const book1 = addBook({
    title: 'Atomic Habits',
    author: 'James Clear',
    page_count: 300,
    current_page: 0,
    status: 'reading'
  }, user1.id);

  // Book 2 (missing total page count - should be excluded)
  const bookMissingPages = addBook({
    title: 'Mystery Novel (No Pages)',
    author: 'Unknown',
    page_count: 0,
    current_page: 0,
    status: 'reading'
  }, user1.id);

  // Book 3: 100 pages, already on page 85
  const bookNearEnd = addBook({
    title: 'Short Stories',
    author: 'O. Henry',
    page_count: 100,
    current_page: 85,
    status: 'reading'
  }, user1.id);

  console.log('\n--- 2. Category Isolation & Selection ---');
  await asyncCheck('Books-only selection NEVER produces TV episodes or movies', async () => {
    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '120 mins',
      types: ['book'],
      pagesPerHour: 30
    });

    assert.ok(plan.activities.length > 0, 'Should have planned book activities');
    for (const act of plan.activities) {
      assert.strictEqual(act.itemType, 'book', `Activity must be book, was ${act.itemType}`);
      assert.ok(!act.title.includes('Friends'), 'Must not contain Friends TV episode');
      assert.ok(!act.title.includes('Interstellar'), 'Must not contain movie');
    }
  });

  await asyncCheck('Movies-only selection produces ONLY movies', async () => {
    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '120 mins',
      types: ['movie']
    });

    assert.ok(plan.activities.length > 0, 'Should have planned movie activities');
    for (const act of plan.activities) {
      assert.strictEqual(act.itemType, 'movie');
      assert.strictEqual(act.itemId, movie1.id);
    }
  });

  await asyncCheck('TV-only selection produces ONLY TV episodes in order', async () => {
    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '60 mins',
      types: ['tv']
    });

    assert.ok(plan.activities.length > 0, 'Should have planned TV episode');
    const firstAct = plan.activities[0];
    assert.strictEqual(firstAct.itemType, 'tv');
    assert.strictEqual(firstAct.season, 1);
    assert.strictEqual(firstAct.episode, 1);
  });

  console.log('\n--- 3. Time Calculations & Constraints ---');
  await asyncCheck('Generated plan total strictly fits within 60-minute budget', async () => {
    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '60 mins',
      types: ['movie', 'tv', 'book'],
      pagesPerHour: 30
    });

    assert.ok(plan.totalPlannedMinutes <= 60, `Total minutes ${plan.totalPlannedMinutes} exceeded budget 60`);
    // Movie 1 is 90 mins so it cannot fit in 60 mins.
    const hasMovie1 = plan.activities.some(a => a.itemId === movie1.id);
    assert.strictEqual(hasMovie1, false, '90-minute movie must not be selected for 60-minute budget');
  });

  await asyncCheck('Unused time is correctly calculated and explained', async () => {
    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '60 mins',
      types: ['tv']
    });

    // TV episode 1 is 22 mins
    assert.strictEqual(plan.totalPlannedMinutes, 22);
    assert.strictEqual(plan.unusedMinutes, 38);
    assert.ok(plan.unusedMinutesExplanation.includes('38 minutes remaining'), 'Should have explanation for unused time');
  });

  console.log('\n--- 4. Metadata Validation & Bounds Checks ---');
  await asyncCheck('Items with missing runtimes or missing page counts are excluded', async () => {
    const candidates = await getPlannerCandidates(user1.id, { types: ['movie', 'tv', 'book'] });
    const missingMovieCand = candidates.find(c => c.itemId === movieMissingRuntime.id);
    const missingBookCand = candidates.find(c => c.itemId === bookMissingPages.id);

    assert.strictEqual(missingMovieCand, undefined, 'Movie without runtime must be excluded');
    assert.strictEqual(missingBookCand, undefined, 'Book without page count must be excluded');
  });

  await asyncCheck('Reading session never proposes pages beyond the end of the book', async () => {
    // bookNearEnd has 100 total pages, current page 85. Remaining: 15 pages. Speed: 30 pgs/hr.
    const candidates = await getPlannerCandidates(user1.id, { types: ['book'], pagesPerHour: 30 });
    const bookCand = candidates.find(c => c.itemId === bookNearEnd.id);

    assert.ok(bookCand, 'bookNearEnd candidate should exist');
    assert.strictEqual(bookCand.startPage, 86);
    assert.strictEqual(bookCand.endPage, 100);
    assert.strictEqual(bookCand.pagesToRead, 15);
    assert.ok(bookCand.endPage <= 100, 'endPage must not exceed 100');
  });

  await asyncCheck('Empty or invalid categories and non-positive budget reject with 400', async () => {
    try {
      await generateWeeklyPlan(user1.id, { timeInput: '0 mins', types: ['movie'] });
      assert.fail('Should have rejected zero budget');
    } catch (err) {
      assert.strictEqual(err.statusCode, 400);
    }

    try {
      await generateWeeklyPlan(user1.id, { timeInput: '60 mins', types: [] });
      assert.fail('Should have rejected empty types');
    } catch (err) {
      assert.strictEqual(err.statusCode, 400);
    }
  });

  console.log('\n--- 5. AI Service Reporting & Server-side Validation ---');
  await asyncCheck('When AI is not configured or unavailable, clearly reports local smart schedule', async () => {
    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '60 mins',
      types: ['tv']
    }, null); // aiClient = null

    assert.strictEqual(plan.isAiGenerated, false, 'isAiGenerated must be false when AI is not configured');
    assert.strictEqual(plan.aiStatus, 'not_configured');
    assert.ok(plan.explanation.includes('Local smart schedule'), 'Must indicate local schedule');
  });

  await asyncCheck('When AI service fails with an error, gracefully falls back without claiming to be AI', async () => {
    const failingAiClient = {
      models: {
        generateContent: async () => {
          throw new Error('429 Resource has been exhausted (rate limit)');
        }
      }
    };

    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '60 mins',
      types: ['tv']
    }, failingAiClient);

    assert.strictEqual(plan.isAiGenerated, false, 'Must not claim to be AI-generated after error');
    assert.strictEqual(plan.aiStatus, 'rate_limited');
    assert.ok(plan.aiError.includes('quota or rate limit reached'), 'Must indicate rate limit reached');
    assert.ok(plan.activities.length > 0, 'Local knapsack schedule should still provide activities');
  });

  await asyncCheck('Server validates mock AI output: rejects unselected categories and oversized durations', async () => {
    // Mock AI returning invalid selection (e.g. movie when only tv selected, plus non-existent id)
    const mockAiClient = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            selectedIds: [`movie_${movie1.id}`, 'non_existent_id', `tv_${tvShow1.id}_1_1`],
            explanation: 'Curated mix for your week.'
          })
        })
      }
    };

    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '60 mins',
      types: ['tv'] // Only TV allowed!
    }, mockAiClient);

    assert.strictEqual(plan.isAiGenerated, true);
    // movie1 must be rejected by server validation because type is movie, not tv
    for (const act of plan.activities) {
      assert.strictEqual(act.itemType, 'tv', 'Server must strip out non-tv items returned by AI');
    }
    assert.strictEqual(plan.activities.length, 1);
  });

  console.log('\n--- 6. Saving Plans & Data Integrity ---');
  let savedPlanId;
  await asyncCheck('Saving a plan persists accurately without marking items watched or read', async () => {
    const plan = await generateWeeklyPlan(user1.id, {
      timeInput: '60 mins',
      types: ['tv']
    });

    const saved = saveWeeklyPlan(user1.id, {
      title: 'Alice Test Plan',
      budgetMinutes: plan.budgetMinutes,
      totalPlannedMinutes: plan.totalPlannedMinutes,
      activities: plan.activities,
      settings: plan.settings,
      explanation: plan.explanation
    });

    assert.ok(saved.id, 'Saved plan must have an ID');
    savedPlanId = saved.id;

    // Check media status has NOT changed
    const show = getMediaById(tvShow1.id, user1.id);
    assert.strictEqual(show.status, 'watching');
    assert.strictEqual(show.current_episode || 0, 0, 'Saving plan must not mark episode watched');

    const book = getBookById(book1.id, user1.id);
    assert.strictEqual(book.current_page, 0, 'Saving plan must not advance book reading page');
  });

  console.log('\n--- 7. User Privacy & Account Isolation ---');
  await asyncCheck('User 2 cannot view or delete User 1 saved plans', async () => {
    const bobPlans = getUserSavedPlans(user2.id);
    assert.strictEqual(bobPlans.length, 0, 'Bob must have 0 saved plans');

    const bobDelete = deleteSavedPlan(savedPlanId, user2.id);
    assert.strictEqual(bobDelete, false, 'Bob must not be able to delete Alice plan');

    const alicePlans = getUserSavedPlans(user1.id);
    assert.strictEqual(alicePlans.length, 1, 'Alice plan must still exist');
  });

  console.log('\n--- 8. Activity Completion & Duplicate Prevention ---');
  await asyncCheck('completePlannerActivity is idempotent and prevents duplicate completions', async () => {
    // 1. Complete TV Episode
    const firstComplete = await completePlannerActivity(user1.id, {
      itemType: 'tv',
      itemId: tvShow1.id,
      season: 1,
      episode: 1
    });

    assert.strictEqual(firstComplete.success, true);
    assert.strictEqual(firstComplete.newlyCompleted, true);

    const secondComplete = await completePlannerActivity(user1.id, {
      itemType: 'tv',
      itemId: tvShow1.id,
      season: 1,
      episode: 1
    });

    assert.strictEqual(secondComplete.success, true);
    assert.strictEqual(secondComplete.alreadyCompleted, true);

    // Verify activity log has only 1 entry for this episode
    const activities = getUserActivities(user1.id);
    const epActivities = activities.filter(a => a.activity_type === 'episode_watched' && a.item_id === tvShow1.id && a.episode === 1);
    assert.strictEqual(epActivities.length, 1, 'Should only have 1 activity log entry for this episode');
  });

  await asyncCheck('completePlannerActivity advances book reading without exceeding bounds', async () => {
    const firstBookComplete = await completePlannerActivity(user1.id, {
      itemType: 'book',
      itemId: book1.id,
      endPage: 30
    });

    assert.strictEqual(firstBookComplete.success, true);
    assert.strictEqual(firstBookComplete.newlyCompleted, true);

    const updatedBook = getBookById(book1.id, user1.id);
    assert.strictEqual(updatedBook.current_page, 30);

    // Calling again with same or earlier page
    const duplicateBookComplete = await completePlannerActivity(user1.id, {
      itemType: 'book',
      itemId: book1.id,
      endPage: 30
    });

    assert.strictEqual(duplicateBookComplete.alreadyCompleted, true);
  });

} finally {
  clearMockEpisodeData();
  // Clean up test database
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
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
