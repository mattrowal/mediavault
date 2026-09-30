import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Dedicated unique test database for isolated, offline testing
const TEST_DB_PATH = path.join(rootDir, 'data', `test_rewatch_reread_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const {
  db,
  initDatabase,
  createUser,
  addBook,
  getBookById,
  updateBook,
  updateBookReadingProgress,
  addMedia,
  getMediaById,
  updateMedia,
  getItemCycles,
  startItemCycle,
  completeItemCycle,
  getWatchedEpisodes,
  getWatchedEpisodesSet,
  markEpisodeWatched,
  unmarkEpisodeWatched,
  getUserActivities,
  createGoal,
  getGoalsByUser
} = await import('../db.js');

const {
  getPersonalStatistics
} = await import('../stats-service.js');

const {
  calculateGoalProgress,
  createUserGoal,
  updateUserGoal
} = await import('../goals-service.js');

const {
  setMockEpisodeData,
  clearMockEpisodeData,
  getShowSeasonsAndEpisodes,
  markEpisodeWatchedWithEarlier,
  toggleEpisodeWatched,
  markSeasonWatched,
  syncMediaWatchedProgress,
  enrichMediaItemWithProgression
} = await import('../episode-service.js');

const {
  getPlannerCandidates,
  generateWeeklyPlan,
  saveWeeklyPlan,
  completePlannerActivity
} = await import('../planner-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Rewatch & Reread Cycles Test Suite');
console.log('   (Offline Serverless Isolation Test)');
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

try {
  // Setup test user
  const user = createUser('cycle_tester', 'hash123', 'salt123');
  assert(user && user.id, 'User created');

  console.log('\n--- 1. BOOK REREAD LIFECYCLE ---');

  // Step 1: Add a 100-page book and complete it in Cycle 1
  const book = addBook({
    title: 'The Great Gatsby',
    author: 'F. Scott Fitzgerald',
    page_count: 100,
    current_page: 0,
    status: 'reading'
  }, user.id);
  assert(book && book.id, 'Book created');

  // Read through to completion
  updateBookReadingProgress(user.id, book.id, { currentPage: 100 });
  const completedBookC1 = getBookById(book.id, user.id);
  check('Book is completed in Cycle 1', () => {
    assert.strictEqual(completedBookC1.status, 'completed');
    assert.strictEqual(completedBookC1.current_page, 100);
  });

  // Verify Cycle 1 row in consumption_cycles
  const cyclesAfterC1 = getItemCycles(user.id, 'book', book.id);
  check('Cycle 1 is recorded as completed in consumption_cycles', () => {
    assert.strictEqual(cyclesAfterC1.length, 1);
    assert.strictEqual(cyclesAfterC1[0].cycle_number, 1);
    assert.strictEqual(cyclesAfterC1[0].status, 'completed');
    assert.strictEqual(cyclesAfterC1[0].progress_value, 100);
  });

  // Check stats after Cycle 1
  let statsC1 = await getPersonalStatistics(user.id, 'all_time');
  check('Stats after Cycle 1: 1 unique book, 1 total completion, 100 pages', () => {
    assert.strictEqual(statsC1.summary.uniqueBooksCompleted, 1);
    assert.strictEqual(statsC1.summary.totalBookCompletions, 1);
    assert.strictEqual(statsC1.summary.totalPagesRead, 100);
    assert.strictEqual(statsC1.summary.unfinishedPagesRead, 0);
  });

  // Step 2: Start a reread (Cycle 2)
  const startRereadRes = startItemCycle(user.id, 'book', book.id);
  check('Start reread returns cycleNumber 2 and not alreadyActive', () => {
    assert.strictEqual(startRereadRes.cycleNumber, 2);
    assert.strictEqual(startRereadRes.alreadyActive, false);
  });

  const bookAfterRereadStart = getBookById(book.id, user.id);
  check('Starting reread sets current_cycle=2, current_page=0, status=reading', () => {
    assert.strictEqual(bookAfterRereadStart.current_cycle, 2);
    assert.strictEqual(bookAfterRereadStart.current_page, 0);
    assert.strictEqual(bookAfterRereadStart.status, 'reading');
  });

  // Step 3: Confirm previous completion remains and no immediate pages added
  const cyclesAfterStart = getItemCycles(user.id, 'book', book.id);
  check('Previous completion remains in consumption_cycles alongside in_progress Cycle 2', () => {
    assert.strictEqual(cyclesAfterStart.length, 2);
    const c1 = cyclesAfterStart.find(c => c.cycle_number === 1);
    const c2 = cyclesAfterStart.find(c => c.cycle_number === 2);
    assert(c1, 'Cycle 1 exists');
    assert.strictEqual(c1.status, 'completed');
    assert.strictEqual(c1.progress_value, 100);
    assert(c2, 'Cycle 2 exists');
    assert.strictEqual(c2.status, 'in_progress');
    assert.strictEqual(c2.progress_value, 0);
  });

  let statsAfterRereadStart = await getPersonalStatistics(user.id, 'all_time');
  check('Starting a reread does NOT immediately add pages or another completion', () => {
    assert.strictEqual(statsAfterRereadStart.summary.uniqueBooksCompleted, 1);
    assert.strictEqual(statsAfterRereadStart.summary.totalBookCompletions, 1);
    assert.strictEqual(statsAfterRereadStart.summary.totalPagesRead, 100);
    assert.strictEqual(statsAfterRereadStart.summary.unfinishedPagesRead, 0);
  });

  // Step 4: Read 40 pages in Cycle 2
  updateBookReadingProgress(user.id, book.id, { currentPage: 40 });
  const bookAt40 = getBookById(book.id, user.id);
  check('Book progress advances to 40 in Cycle 2', () => {
    assert.strictEqual(bookAt40.current_page, 40);
    assert.strictEqual(bookAt40.current_cycle, 2);
  });

  let statsAt40 = await getPersonalStatistics(user.id, 'all_time');
  check('Stats with Cycle 2 at 40 pages: 140 total pages, 1 completion, 40 unfinished pages', () => {
    assert.strictEqual(statsAt40.summary.uniqueBooksCompleted, 1);
    assert.strictEqual(statsAt40.summary.totalBookCompletions, 1);
    assert.strictEqual(statsAt40.summary.totalPagesRead, 140);
    assert.strictEqual(statsAt40.summary.unfinishedPagesRead, 40);
  });

  // Step 5: Complete the reread
  completeItemCycle(user.id, 'book', book.id);
  const bookCompletedC2 = getBookById(book.id, user.id);
  check('Reread completion marks status=completed and current_page=100', () => {
    assert.strictEqual(bookCompletedC2.status, 'completed');
    assert.strictEqual(bookCompletedC2.current_page, 100);
  });

  let statsC2Comp = await getPersonalStatistics(user.id, 'all_time');
  check('Stats after completing reread: 1 unique title, 2 total completions, 200 pages', () => {
    assert.strictEqual(statsC2Comp.summary.uniqueBooksCompleted, 1);
    assert.strictEqual(statsC2Comp.summary.totalBookCompletions, 2);
    assert.strictEqual(statsC2Comp.summary.totalPagesRead, 200);
    assert.strictEqual(statsC2Comp.summary.unfinishedPagesRead, 0);
  });

  console.log('\n--- 2. GOALS WITH REPEAT COMPLETIONS ---');

  const currentYear = new Date().getFullYear();
  // Create yearly book goal with include_repeats = false
  const testGoal = createUserGoal(user.id, {
    goalType: 'books_yearly',
    target: 5,
    year: currentYear,
    includeRepeats: 0
  });

  const progNoRepeats = calculateGoalProgress(user.id, testGoal);
  check('Goal with include_repeats=false counts only 1 unique book', () => {
    assert.strictEqual(progNoRepeats.currentProgress, 1);
  });

  // Now update goal to include_repeats = true
  const updatedGoalWithRepeats = updateUserGoal(testGoal.id, user.id, { includeRepeats: 1 });
  const progWithRepeats = calculateGoalProgress(user.id, updatedGoalWithRepeats);
  check('Goal with include_repeats=true counts 2 completions (including reread)', () => {
    assert.strictEqual(progWithRepeats.currentProgress, 2);
  });

  console.log('\n--- 3. TV SERIES REWATCH & EPISODE ISOLATION ---');

  // Set up mock TV series with 3 episodes in Season 1
  const tvShow = addMedia({
    title: 'Chernobyl Mini',
    type: 'tv',
    external_id: 'tv_test_show_99',
    status: 'watching'
  }, user.id);
  assert(tvShow && tvShow.id, 'TV show created');

  const mockEpisodes = [
    { id: 101, season: 1, number: 1, name: '1:23:45', airdate: '2020-01-01', runtime: 60 },
    { id: 102, season: 1, number: 2, name: 'Please Remain Calm', airdate: '2020-01-08', runtime: 65 },
    { id: 103, season: 1, number: 3, name: 'Open Wide, O Earth', airdate: '2020-01-15', runtime: 60 }
  ];
  setMockEpisodeData('tv_test_show_99', mockEpisodes, { name: 'Chernobyl Mini' });

  // Complete Season 1 in Cycle 1
  await markSeasonWatched(tvShow.id, user.id, 1);
  const showAfterC1 = getMediaById(tvShow.id, user.id);
  check('TV show completed in Cycle 1 after watching all episodes', () => {
    assert.strictEqual(showAfterC1.status, 'completed');
    assert.strictEqual(showAfterC1.current_season, 1);
    assert.strictEqual(showAfterC1.current_episode, 3);
  });

  const c1WatchedEps = getWatchedEpisodes(tvShow.id, user.id, 1);
  check('Cycle 1 has 3 watched episodes recorded', () => {
    assert.strictEqual(c1WatchedEps.length, 3);
  });

  // Start TV Rewatch (Cycle 2)
  const tvRewatchStart = startItemCycle(user.id, 'tv', tvShow.id);
  check('Start TV rewatch returns cycleNumber 2', () => {
    assert.strictEqual(tvRewatchStart.cycleNumber, 2);
    assert.strictEqual(tvRewatchStart.alreadyActive, false);
  });

  const showInC2 = getMediaById(tvShow.id, user.id);
  check('TV show reset to season 1 episode 0, status=watching in Cycle 2', () => {
    assert.strictEqual(showInC2.current_cycle, 2);
    assert.strictEqual(showInC2.current_season, 1);
    assert.strictEqual(showInC2.current_episode, 0);
    assert.strictEqual(showInC2.status, 'watching');
  });

  // Check that Cycle 2 watched episodes is empty
  const c2WatchedInitial = getWatchedEpisodes(tvShow.id, user.id);
  check('Cycle 2 begins with 0 watched episodes', () => {
    assert.strictEqual(c2WatchedInitial.length, 0);
  });

  // Season progress and next episode reflection
  const showSeasonsC2 = await getShowSeasonsAndEpisodes(tvShow.id, user.id);
  check('Season progress in Cycle 2 is 0/3 (0%) and next episode is S1E1', () => {
    const s1 = showSeasonsC2.seasons.find(s => s.seasonNumber === 1);
    assert(s1, 'Season 1 exists');
    assert.strictEqual(s1.watchedCount, 0);
    assert.strictEqual(s1.progressPercent, 0);
    assert.strictEqual(s1.status, 'Not started');
    assert.strictEqual(showSeasonsC2.nextEpisode.season, 1);
    assert.strictEqual(showSeasonsC2.nextEpisode.episode, 1);
  });

  // Mark S1E2 with markEarlier: true in Cycle 2
  await markEpisodeWatchedWithEarlier(tvShow.id, user.id, 1, 2, { markEarlier: true, leaveDateUnknown: true });
  const c2WatchedAfterEp2 = getWatchedEpisodes(tvShow.id, user.id);
  check('Marking S1E2 with markEarlier marks only S1E1 and S1E2 in Cycle 2', () => {
    assert.strictEqual(c2WatchedAfterEp2.length, 2);
    assert(c2WatchedAfterEp2.some(e => e.season === 1 && e.episode === 1 && e.cycle_number === 2));
    assert(c2WatchedAfterEp2.some(e => e.season === 1 && e.episode === 2 && e.cycle_number === 2));
  });

  // Confirm Cycle 1 watched episodes and activity log are intact
  const c1WatchedStill = getWatchedEpisodes(tvShow.id, user.id, 1);
  check('Cycle 1 watched episodes remain completely intact (3 episodes)', () => {
    assert.strictEqual(c1WatchedStill.length, 3);
  });

  // Unmark S1E2 in Cycle 2
  await toggleEpisodeWatched(tvShow.id, user.id, 1, 2);
  const c2WatchedAfterUnmark = getWatchedEpisodes(tvShow.id, user.id);
  check('Unmarking S1E2 in Cycle 2 leaves only S1E1 in Cycle 2', () => {
    assert.strictEqual(c2WatchedAfterUnmark.length, 1);
    assert.strictEqual(c2WatchedAfterUnmark[0].episode, 1);
  });

  const c1WatchedAfterC2Unmark = getWatchedEpisodes(tvShow.id, user.id, 1);
  check('Unmarking in Cycle 2 does NOT delete S1E2 from Cycle 1', () => {
    assert.strictEqual(c1WatchedAfterC2Unmark.length, 3);
  });

  // Complete Season 1 in Cycle 2
  await markSeasonWatched(tvShow.id, user.id, 1);
  const showCompletedC2 = getMediaById(tvShow.id, user.id);
  check('Watching remaining episodes completes TV show in Cycle 2', () => {
    assert.strictEqual(showCompletedC2.status, 'completed');
  });

  const tvCycles = getItemCycles(user.id, 'tv', tvShow.id);
  check('Both TV Cycle 1 and Cycle 2 are marked completed in consumption_cycles', () => {
    assert.strictEqual(tvCycles.length, 2);
    assert(tvCycles.every(c => c.status === 'completed'));
  });

  console.log('\n--- 4. IDEMPOTENCY & DUPLICATE PREVENTION ---');

  // Start rewatch on movie
  const movie = addMedia({
    title: 'Inception',
    type: 'movie',
    runtime: 148,
    status: 'completed'
  }, user.id);
  completeItemCycle(user.id, 'movie', movie.id);

  const startMovieC2 = startItemCycle(user.id, 'movie', movie.id);
  check('Movie cycle 2 started', () => {
    assert.strictEqual(startMovieC2.cycleNumber, 2);
    assert.strictEqual(startMovieC2.alreadyActive, false);
  });

  // Call startItemCycle AGAIN while Cycle 2 is still in_progress
  const retryMovieC2 = startItemCycle(user.id, 'movie', movie.id);
  check('Retrying startItemCycle on unfinished cycle returns alreadyActive: true without duplicate', () => {
    assert.strictEqual(retryMovieC2.alreadyActive, true);
    assert.strictEqual(retryMovieC2.cycleNumber, 2);
  });

  const movieCycles = getItemCycles(user.id, 'movie', movie.id);
  check('Movie has exactly 2 cycles (no duplicate cycle created)', () => {
    assert.strictEqual(movieCycles.length, 2);
  });

  console.log('\n--- 5. PLANNER SAVED ACTIVITY CYCLE ISOLATION ---');

  // Create book for planner test
  const plannerBook = addBook({
    title: 'Emma',
    author: 'Jane Austen',
    page_count: 100,
    current_page: 0,
    status: 'reading'
  }, user.id);

  // Generate and save plan while in Cycle 1
  const candidates = await getPlannerCandidates(user.id);
  const emmaCandidate = candidates.find(c => c.itemType === 'book' && c.itemId === plannerBook.id);
  assert(emmaCandidate, 'Emma found in candidates');
  assert.strictEqual(emmaCandidate.cycleNumber, 1, 'Candidate stamped with cycleNumber 1');

  const plan = await generateWeeklyPlan(user.id, { timeInput: '2 hours' });
  // Add an explicit activity for Emma in Cycle 1: pages 0 to 30
  const emmaActId = `act_emma_c1_${Date.now()}`;
  plan.activities.push({
    id: emmaActId,
    itemType: 'book',
    itemId: plannerBook.id,
    title: 'Emma',
    startPage: 0,
    endPage: 30,
    pages: 30,
    cycleNumber: 1,
    completed: false
  });

  const savedPlan = saveWeeklyPlan(user.id, plan);
  assert(savedPlan && savedPlan.id, 'Plan saved');

  // Now complete the book in Cycle 1 and start Cycle 2 (reread)
  completeItemCycle(user.id, 'book', plannerBook.id);
  startItemCycle(user.id, 'book', plannerBook.id);

  const emmaInC2 = getBookById(plannerBook.id, user.id);
  assert.strictEqual(emmaInC2.current_cycle, 2, 'Emma is now on Cycle 2');
  assert.strictEqual(emmaInC2.current_page, 0, 'Emma page is reset to 0 in Cycle 2');

  // Now attempt to complete the saved plan activity from Cycle 1!
  const emmaAct = savedPlan.activities.find(a => a.id === emmaActId);
  assert(emmaAct, 'Found Emma activity in saved plan');

  const compPlanRes = await completePlannerActivity(user.id, { planId: savedPlan.id, ...emmaAct });
  check('Completing old Cycle 1 plan activity is flagged as previous cycle', () => {
    assert.strictEqual(compPlanRes.fromPreviousCycle, true);
  });

  const emmaAfterOldPlanComp = getBookById(plannerBook.id, user.id);
  check('Old Cycle 1 plan did NOT advance Emma page in Cycle 2 (remains 0)', () => {
    assert.strictEqual(emmaAfterOldPlanComp.current_page, 0);
  });

  clearMockEpisodeData();

  console.log('\n====================================================');
  console.log(`📊 TEST RESULTS: ${passedChecks}/${totalChecks} PASSED`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL CYCLE & REPEAT TESTS PASSED PERFECTLY!');
  } else {
    console.error(`⚠️ ${totalChecks - passedChecks} TESTS FAILED.`);
    process.exit(1);
  }
  console.log('====================================================\n');
} finally {
  try {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  } catch {}
}
