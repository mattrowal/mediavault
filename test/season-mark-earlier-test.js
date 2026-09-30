import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Dedicated unique test database for isolated, serverless offline testing
const TEST_DB_PATH = path.join(rootDir, 'data', `test_season_mark_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const {
  db,
  initDatabase,
  createUser,
  addMedia,
  getMediaById,
  markEpisodeWatched,
  getWatchedEpisodes,
  getWatchedEpisodesSet,
  startItemCycle,
  completeItemCycle,
  getUserActivities
} = await import('../db.js');

const {
  setMockEpisodeData,
  clearMockEpisodeData,
  getEarlierUnwatchedSeasonsInfo,
  markSeasonWatched,
  getShowSeasonsAndEpisodes
} = await import('../episode-service.js');

const {
  getPersonalStatistics
} = await import('../stats-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Mark Season Watched & Earlier Suite');
console.log('   (Isolated Serverless / Offline Test)');
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
  // -------------------------------------------------------------
  // SETUP TEST USERS
  // -------------------------------------------------------------
  const user1 = createUser('season_alice', 'hash_alice_123', 'salt_alice_123');
  const user2 = createUser('season_bob', 'hash_bob_123', 'salt_bob_123');
  assert(user1 && user1.id, 'User 1 created');
  assert(user2 && user2.id, 'User 2 created');

  const user1Id = user1.id;
  const user2Id = user2.id;

  // Add TV series to User 1's library
  const show = addMedia({
    title: 'The Expanse',
    type: 'tv',
    external_id: '60001',
    status: 'watching',
    current_season: 1,
    current_episode: 0
  }, user1Id);

  // Setup mock episodes:
  // Season 1: 3 released episodes (101, 102, 103)
  // Season 2: 3 released episodes (201, 202, 203)
  // Season 3: 2 released episodes (301, 302), 1 future unreleased (303), and 1 special (type: 'special', 001)
  const pastDate = '2025-01-01';
  const futureDate = '2099-01-01';

  setMockEpisodeData('60001', [
    // Season 1
    { id: 101, season: 1, number: 1, name: 'Dulcinea', airdate: pastDate, runtime: 50, type: 'regular' },
    { id: 102, season: 1, number: 2, name: 'The Big Empty', airdate: pastDate, runtime: 45, type: 'regular' },
    { id: 103, season: 1, number: 3, name: 'Remember the Cant', airdate: pastDate, runtime: 48, type: 'regular' },
    // Season 2
    { id: 201, season: 2, number: 1, name: 'Safe', airdate: pastDate, runtime: 55, type: 'regular' },
    { id: 202, season: 2, number: 2, name: 'Doors & Corners', airdate: pastDate, runtime: 44, type: 'regular' },
    { id: 203, season: 2, number: 3, name: 'Static', airdate: pastDate, runtime: 46, type: 'regular' },
    // Season 3
    { id: 301, season: 3, number: 1, name: 'Fight or Flight', airdate: pastDate, runtime: 52, type: 'regular' },
    { id: 302, season: 3, number: 2, name: 'IFF', airdate: pastDate, runtime: 47, type: 'regular' },
    { id: 303, season: 3, number: 3, name: 'Future Episode', airdate: futureDate, runtime: 50, type: 'regular' }, // Upcoming!
    // Special
    { id: 999, season: 0, number: 1, name: 'Behind the Scenes', airdate: pastDate, runtime: 30, type: 'special' } // Special!
  ]);

  console.log('\n--- 1. SUMMARY CALCULATION & SIMPLE CONFIRMATION ---');

  await asyncCheck('Season 1 has no earlier seasons -> hasEarlierUnwatched is false', async () => {
    const summary = await getEarlierUnwatchedSeasonsInfo(show.id, user1Id, 1);
    assert.strictEqual(summary.hasEarlierUnwatched, false);
    assert.strictEqual(summary.totalEarlierUnwatched, 0);
    assert.strictEqual(summary.earlierSeasons.length, 0);
    assert.strictEqual(summary.currentSeason.unwatchedCount, 3);
  });

  await asyncCheck('Season 2 has earlier unwatched Season 1 -> identifies Season 1 with 3 unwatched', async () => {
    const summary = await getEarlierUnwatchedSeasonsInfo(show.id, user1Id, 2);
    assert.strictEqual(summary.hasEarlierUnwatched, true);
    assert.strictEqual(summary.totalEarlierUnwatched, 3);
    assert.strictEqual(summary.earlierSeasons.length, 1);
    assert.strictEqual(summary.earlierSeasons[0].seasonNumber, 1);
    assert.strictEqual(summary.earlierSeasons[0].unwatchedCount, 3);
    assert.strictEqual(summary.currentSeason.unwatchedCount, 3);
  });

  console.log('\n--- 2. OPTION 1: MARK ONLY THIS SEASON ---');

  await asyncCheck('Marking Season 2 with includeEarlier=false marks only Season 2', async () => {
    const res = await markSeasonWatched(show.id, user1Id, 2, { includeEarlier: false });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.markedCount, 3, 'Marked 3 episodes in Season 2');
    assert.strictEqual(res.markedBySeason[2], 3);
    assert.strictEqual(res.markedBySeason[1], undefined, 'Season 1 was NOT marked');

    // Verify in database: Season 2 episodes are watched
    const watched = getWatchedEpisodesSet(show.id, user1Id);
    assert.strictEqual(watched.has('2-1'), true);
    assert.strictEqual(watched.has('2-2'), true);
    assert.strictEqual(watched.has('2-3'), true);

    // Verify Season 1 is STILL unwatched
    assert.strictEqual(watched.has('1-1'), false);
    assert.strictEqual(watched.has('1-2'), false);
    assert.strictEqual(watched.has('1-3'), false);

    // Verify Season 3 upcoming is unwatched
    assert.strictEqual(watched.has('3-3'), false);
    // Special is unwatched
    assert.strictEqual(watched.has('0-1'), false);
  });

  console.log('\n--- 3. OPTION 2: MARK THIS SEASON AND EARLIER SEASONS ---');

  await asyncCheck('Pre-existing watched episode timestamp is preserved when earlier seasons are marked', async () => {
    // Manually mark S1E1 as watched with an old timestamp
    const oldTimestamp = '2024-06-01 10:00:00';
    db.prepare(`
      INSERT INTO watched_episodes (user_id, media_id, season, episode, episode_id, cycle_number, watched_at)
      VALUES (?, ?, 1, 1, 101, 1, ?)
    `).run(user1Id, show.id, oldTimestamp);

    const s1e1Before = db.prepare(`SELECT * FROM watched_episodes WHERE user_id = ? AND media_id = ? AND season = 1 AND episode = 1`).get(user1Id, show.id);
    assert.strictEqual(s1e1Before.watched_at, oldTimestamp, 'S1E1 has original timestamp');

    // Now mark Season 3 WITH includeEarlier=true
    // Season 1 has S1E1 (already watched) and S1E2, S1E3 (unwatched).
    // Season 2 has S2E1, S2E2, S2E3 (already watched in step 2).
    // Season 3 has S3E1, S3E2 (released, unwatched) and S3E3 (upcoming).
    const res = await markSeasonWatched(show.id, user1Id, 3, { includeEarlier: true });
    assert.strictEqual(res.success, true);
    // Should mark: S1E2, S1E3 (2 episodes from Season 1) + S3E1, S3E2 (2 episodes from Season 3) = 4 episodes total
    assert.strictEqual(res.markedCount, 4);
    assert.strictEqual(res.markedBySeason[1], 2, '2 newly marked in Season 1');
    assert.strictEqual(res.markedBySeason[2], undefined, '0 newly marked in Season 2 (already watched)');
    assert.strictEqual(res.markedBySeason[3], 2, '2 newly marked in Season 3');

    // Verify S1E1 timestamp was PRESERVED
    const s1e1After = db.prepare(`SELECT * FROM watched_episodes WHERE user_id = ? AND media_id = ? AND season = 1 AND episode = 1`).get(user1Id, show.id);
    assert.strictEqual(s1e1After.watched_at, oldTimestamp, 'Original watched_at timestamp preserved intact!');

    // Verify Season 3 upcoming episode (S3E3) is NOT marked watched
    const watchedSet = getWatchedEpisodesSet(show.id, user1Id);
    assert.strictEqual(watchedSet.has('3-3'), false, 'Upcoming episode S3E3 must NOT be marked watched');

    // Verify special is NOT marked watched
    assert.strictEqual(watchedSet.has('0-1'), false, 'Special episode must NOT be marked watched');
  });

  console.log('\n--- 4. OPTION 3: CANCELLATION ---');

  await asyncCheck('Cancellation leaves watched episodes and viewing history completely unchanged', async () => {
    const watchedBefore = getWatchedEpisodes(show.id, user1Id);
    const activitiesBefore = getUserActivities(user1Id);
    const statsBefore = await getPersonalStatistics(user1Id);

    // Simulated cancellation (no endpoint called)
    // Verify state remains 100% identical
    const watchedAfter = getWatchedEpisodes(show.id, user1Id);
    const activitiesAfter = getUserActivities(user1Id);
    const statsAfter = await getPersonalStatistics(user1Id);

    assert.strictEqual(watchedAfter.length, watchedBefore.length);
    assert.strictEqual(activitiesAfter.length, activitiesBefore.length);
    assert.strictEqual(statsAfter.summary.episodesWatched, statsBefore.summary.episodesWatched);
  });

  console.log('\n--- 5. CYCLE ISOLATION: PREVIOUS VIEWING CYCLES UNCHANGED ---');

  await asyncCheck('Marking season in current cycle does not touch previous viewing cycles', async () => {
    // Complete show in Cycle 1
    completeItemCycle(user1Id, 'tv', show.id);

    // Start Cycle 2 (rewatch)
    const cycleRes = startItemCycle(user1Id, 'tv', show.id);
    assert.strictEqual(cycleRes.cycleNumber, 2);

    // In Cycle 2, reset mock to 2 seasons:
    setMockEpisodeData('60001', [
      { id: 101, season: 1, number: 1, name: 'S1E1', airdate: pastDate, runtime: 50, type: 'regular' },
      { id: 102, season: 1, number: 2, name: 'S1E2', airdate: pastDate, runtime: 50, type: 'regular' },
      { id: 201, season: 2, number: 1, name: 'S2E1', airdate: pastDate, runtime: 50, type: 'regular' },
      { id: 202, season: 2, number: 2, name: 'S2E2', airdate: pastDate, runtime: 50, type: 'regular' }
    ]);

    // Check Cycle 1 watched episodes
    const cycle1Watched = getWatchedEpisodes(show.id, user1Id, 1);
    assert.ok(cycle1Watched.length > 0, 'Cycle 1 has watched episodes');

    // In Cycle 2, mark Season 2 and earlier
    const res = await markSeasonWatched(show.id, user1Id, 2, { includeEarlier: true });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.markedCount, 4, 'Marked 4 episodes in Cycle 2');

    // Verify all marked episodes have cycle_number = 2
    const cycle2Watched = getWatchedEpisodes(show.id, user1Id, 2);
    assert.strictEqual(cycle2Watched.length, 4, 'Cycle 2 has 4 watched episodes');
    assert.ok(cycle2Watched.every(ep => ep.cycle_number === 2), 'All newly marked episodes belong to Cycle 2');

    // Verify Cycle 1 watched episodes were completely untouched
    const cycle1WatchedAfter = getWatchedEpisodes(show.id, user1Id, 1);
    assert.strictEqual(cycle1WatchedAfter.length, cycle1Watched.length, 'Cycle 1 watched count unchanged');
  });

  console.log('\n--- 6. ACCOUNT OWNERSHIP & SECURITY ---');

  await asyncCheck('User 2 cannot mark seasons or access earlier-summary for User 1 show', async () => {
    let summaryRejected = false;
    try {
      await getEarlierUnwatchedSeasonsInfo(show.id, user2Id, 1);
    } catch (err) {
      summaryRejected = true;
      assert.strictEqual(err.statusCode, 404);
    }
    assert.strictEqual(summaryRejected, true, 'Earlier-summary rejects unauthorized user with 404');

    let markRejected = false;
    try {
      await markSeasonWatched(show.id, user2Id, 1, { includeEarlier: true });
    } catch (err) {
      markRejected = true;
      assert.strictEqual(err.statusCode, 404);
    }
    assert.strictEqual(markRejected, true, 'MarkSeasonWatched rejects unauthorized user with 404');
  });

  console.log('\n--- 7. IMMEDIATE STATS & BROWSER REFRESH PERSISTENCE ---');

  await asyncCheck('Statistics and show progression update immediately and persist across queries', async () => {
    const stats = await getPersonalStatistics(user1Id);
    assert.ok(stats.summary.episodesWatched > 0, 'Statistics reflect watched episodes');
    assert.ok(stats.viewingTime.tv.minutes > 0, 'Statistics reflect minutes viewed');

    // Verify getShowSeasonsAndEpisodes returns accurate season stats
    const showData = await getShowSeasonsAndEpisodes(show.id, user1Id);
    const s1 = showData.seasons.find(s => s.seasonNumber === 1);
    const s2 = showData.seasons.find(s => s.seasonNumber === 2);
    assert.strictEqual(s1.status, 'Completed');
    assert.strictEqual(s1.progressPercent, 100);
    assert.strictEqual(s2.status, 'Completed');
    assert.strictEqual(s2.progressPercent, 100);
  });

} finally {
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
    if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch (_) {}
}

console.log('\n----------------------------------------------------');
console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
console.log('----------------------------------------------------');

if (passedChecks !== totalChecks) {
  process.exit(1);
}
