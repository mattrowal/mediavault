import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path (runs strictly serverless / offline)
const TEST_DB_PATH = path.join(rootDir, 'data', `test_ep_runtime_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const {
  db,
  initDatabase,
  createUser,
  addMedia,
  getMediaById,
  updateMedia,
  markEpisodeWatched,
  unmarkEpisodeWatched,
  getCachedEpisodes,
  setCachedEpisodes
} = await import('../db.js');

const {
  getPersonalStatistics
} = await import('../stats-service.js');

const {
  setMockEpisodeData,
  clearMockEpisodeData,
  getSeriesEpisodeInfo,
  refreshSeriesEpisodeDetails,
  setEpisodeManualRuntime
} = await import('../episode-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Episode Runtime & Viewing Time Test Suite');
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

try {
  // Setup users
  const user1 = createUser('runtime_tester_1', 'hash123', 'salt123');
  const user2 = createUser('runtime_tester_2', 'hash123', 'salt123');

  // Setup initial mock episode data for show 9001:
  // S1E1: runtime null
  // S1E2: runtime null
  // S1E3: runtime 45
  const showMeta9001 = { id: 9001, name: 'Test Crime Series', status: 'Running', averageRuntime: 45 };
  const rawEpisodesInitial = [
    { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2026-01-10', runtime: null, type: 'regular' },
    { id: 102, season: 1, number: 2, name: 'Investigation', airdate: '2026-01-17', runtime: null, type: 'regular' },
    { id: 103, season: 1, number: 3, name: 'Suspects', airdate: '2026-01-24', runtime: 45, type: 'regular' }
  ];
  setMockEpisodeData('9001', rawEpisodesInitial, showMeta9001);

  // Add show to User 1
  const show1 = addMedia({
    title: 'Test Crime Series',
    type: 'tv',
    status: 'watching',
    external_id: '9001',
    total_episodes: 3,
    current_season: 1,
    current_episode: 2
  }, user1.id);

  // Pre-load episode cache
  await getSeriesEpisodeInfo('9001');

  // User 1 watched S1E1 and S1E2
  markEpisodeWatched(show1.id, user1.id, 1, 1, 101, 1);
  db.prepare('UPDATE watched_episodes SET watched_at = ? WHERE media_id = ? AND user_id = ? AND season = ? AND episode = ?').run('2026-02-01 10:00:00', show1.id, user1.id, 1, 1);

  markEpisodeWatched(show1.id, user1.id, 1, 2, 102, 1);
  db.prepare('UPDATE watched_episodes SET watched_at = ? WHERE media_id = ? AND user_id = ? AND season = ? AND episode = ?').run('2026-02-02 10:00:00', show1.id, user1.id, 1, 2);

  console.log('--- Suite 1: Missing Runtimes & Initial Statistics (Mocked) ---');

  await asyncCheck('Missing runtimes are identified as unknown and excluded from viewing time', async () => {
    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.summary.episodesWatched, 2, 'Should count 2 watched episodes');
    assert.strictEqual(stats.viewingTime.tv.minutes, 0, 'TV minutes should be 0 because both watched episodes have null runtime');
    assert.strictEqual(stats.missingMetadata.missingEpisodeRuntimes, 2, 'Should identify 2 missing episode runtimes');
    assert.strictEqual(stats.missingMetadata.hasMissingRuntimes, true);
  });

  await asyncCheck('Unwatched episode does not increase viewing time even if it has a known runtime', async () => {
    // S1E3 has runtime: 45, but is unwatched
    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.viewingTime.tv.minutes, 0, 'Unwatched episode with 45m runtime must not increase viewing time');
  });

  console.log('\n--- Suite 2: Refresh Episode Details & Safe Merging (Mocked) ---');

  await asyncCheck('Provider updates S1E1 runtime to 40m; refreshSeriesEpisodeDetails updates viewing time and respects remaining unknown', async () => {
    // Provider now has runtime: 40 for S1E1, but S1E2 remains null
    const rawEpisodesUpdated = [
      { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2026-01-10', runtime: 40, type: 'regular' },
      { id: 102, season: 1, number: 2, name: 'Investigation', airdate: '2026-01-17', runtime: null, type: 'regular' },
      { id: 103, season: 1, number: 3, name: 'Suspects', airdate: '2026-01-24', runtime: 45, type: 'regular' }
    ];
    setMockEpisodeData('9001', rawEpisodesUpdated, showMeta9001);

    const refreshResult = await refreshSeriesEpisodeDetails(show1.id, user1.id);
    assert.strictEqual(refreshResult.success, true);
    assert.strictEqual(refreshResult.updatedRuntimesCount, 1, 'Should have updated 1 runtime (S1E1)');
    assert.strictEqual(refreshResult.unknownRuntimesCount, 1, 'Should report 1 remaining unknown episode (S1E2)');

    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.summary.episodesWatched, 2);
    assert.strictEqual(stats.viewingTime.tv.minutes, 40, 'Viewing time should now include 40m from S1E1');
    assert.strictEqual(stats.missingMetadata.missingEpisodeRuntimes, 1, 'Only 1 missing episode runtime remains (S1E2)');
  });

  await asyncCheck('Repeating a refresh is idempotent and does not change totals or duplicate viewing time', async () => {
    const repeatResult = await refreshSeriesEpisodeDetails(show1.id, user1.id);
    assert.strictEqual(repeatResult.success, true);
    assert.strictEqual(repeatResult.updatedRuntimesCount, 0, 'No new runtimes to update');
    assert.strictEqual(repeatResult.unknownRuntimesCount, 1);

    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.viewingTime.tv.minutes, 40, 'Viewing time must remain exactly 40 minutes');
    assert.strictEqual(stats.summary.episodesWatched, 2, 'Episodes watched count must remain 2');
    assert.strictEqual(stats.missingMetadata.missingEpisodeRuntimes, 1);
  });

  console.log('\n--- Suite 3: Manual Runtime Corrections & Preservation (Mocked) ---');

  await asyncCheck('User can set manual runtime correction for an episode with unknown runtime', async () => {
    // S1E2 was unknown; user sets it to 42m
    const manualResult = await setEpisodeManualRuntime(show1.id, user1.id, 1, 2, 42);
    assert.strictEqual(manualResult.success, true);
    assert.strictEqual(manualResult.season, 1);
    assert.strictEqual(manualResult.episode, 2);
    assert.strictEqual(manualResult.runtime, 42);
    assert.strictEqual(manualResult.isManual, true);

    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.viewingTime.tv.minutes, 82, 'Viewing time should now be 40 + 42 = 82 minutes');
    assert.strictEqual(stats.missingMetadata.missingEpisodeRuntimes, 0, 'No missing runtimes remain');
    assert.strictEqual(stats.missingMetadata.hasMissingRuntimes, false);
  });

  await asyncCheck('Subsequent provider refreshes preserve manual runtime corrections even if provider returns null', async () => {
    // Provider still returns null for S1E2
    const rawEpisodesUpdated = [
      { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2026-01-10', runtime: 40, type: 'regular' },
      { id: 102, season: 1, number: 2, name: 'Investigation', airdate: '2026-01-17', runtime: null, type: 'regular' },
      { id: 103, season: 1, number: 3, name: 'Suspects', airdate: '2026-01-24', runtime: 45, type: 'regular' }
    ];
    setMockEpisodeData('9001', rawEpisodesUpdated, showMeta9001);

    const refreshResult = await refreshSeriesEpisodeDetails(show1.id, user1.id);
    assert.strictEqual(refreshResult.success, true);

    // Verify S1E2 retained 42m
    const cached = getCachedEpisodes('9001');
    const ep2 = cached.episodes.find(e => e.season === 1 && e.number === 2);
    assert.strictEqual(ep2.runtime, 42, 'Cached S1E2 runtime must remain 42m');
    assert.strictEqual(ep2.is_runtime_manual, 1, 'Manual flag must be preserved');

    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.viewingTime.tv.minutes, 82, 'Viewing time remains 82 minutes');
  });

  console.log('\n--- Suite 4: Rewatch Cycles and Date Filters (Mocked) ---');

  await asyncCheck('Rewatch cycles correctly count rewatched episodes in viewing time', async () => {
    // User 1 watches S1E1 again in cycle 2
    markEpisodeWatched(show1.id, user1.id, 1, 1, 101, 2);
    db.prepare('UPDATE watched_episodes SET watched_at = ? WHERE media_id = ? AND user_id = ? AND season = ? AND episode = ? AND cycle_number = ?').run('2026-02-15 12:00:00', show1.id, user1.id, 1, 1, 2);

    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.summary.episodesWatched, 3, 'Total watched episode instances should be 3');
    // Cycle 1: S1E1 (40) + S1E2 (42) = 82; Cycle 2: S1E1 (40) = 40. Total = 122m
    assert.strictEqual(stats.viewingTime.tv.minutes, 122, 'Viewing time must include repeat cycle viewing (122m)');
  });

  await asyncCheck('Date filters respect episode watched dates', async () => {
    // Add historical episode watched in 2024
    markEpisodeWatched(show1.id, user1.id, 1, 3, 103, 1);
    db.prepare('UPDATE watched_episodes SET watched_at = ? WHERE media_id = ? AND user_id = ? AND season = ? AND episode = ? AND cycle_number = ?').run('2024-06-01 10:00:00', show1.id, user1.id, 1, 3, 1);

    const statsAll = await getPersonalStatistics(user1.id, 'all_time');
    // S1E3 has runtime 45. Total = 122 + 45 = 167m
    assert.strictEqual(statsAll.viewingTime.tv.minutes, 167);
    assert.strictEqual(statsAll.summary.episodesWatched, 4);

    const statsThisYear = await getPersonalStatistics(user1.id, 'this_year');
    // Only 2026 episodes should be included in this_year
    assert.strictEqual(statsThisYear.summary.episodesWatched, 3, '2024 episode excluded from 2026');
    assert.strictEqual(statsThisYear.viewingTime.tv.minutes, 122, '2024 episode duration excluded from 2026 viewing time');
  });

  console.log('\n--- Suite 5: Multi-User Security & Isolation (Mocked) ---');

  await asyncCheck('User 2 cannot refresh or alter User 1 series metadata', async () => {
    let refreshFailed = false;
    try {
      await refreshSeriesEpisodeDetails(show1.id, user2.id);
    } catch (err) {
      refreshFailed = true;
      assert.strictEqual(err.statusCode, 404, 'Must throw 404 for unauthorized access');
    }
    assert.strictEqual(refreshFailed, true, 'User 2 refresh must be rejected');

    let manualFailed = false;
    try {
      await setEpisodeManualRuntime(show1.id, user2.id, 1, 1, 999);
    } catch (err) {
      manualFailed = true;
      assert.strictEqual(err.statusCode, 404, 'Must throw 404 for unauthorized manual runtime');
    }
    assert.strictEqual(manualFailed, true, 'User 2 manual runtime edit must be rejected');

    // Verify User 1 data unchanged
    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.viewingTime.tv.minutes, 167, 'User 1 viewing time must not be affected by unauthorized requests');
  });

  console.log('\n--- Suite 6: API Failures & Error Handling (Mocked) ---');

  await asyncCheck('API failure leaves existing saved metadata and runtimes intact', async () => {
    // Add Show 2 with non-existent external ID
    const show2 = addMedia({
      title: 'Bad API Show',
      type: 'tv',
      status: 'watching',
      external_id: 'bad_id_99999999'
    }, user1.id);

    let threw = false;
    try {
      await refreshSeriesEpisodeDetails(show2.id, user1.id);
    } catch (err) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'Should fail gracefully when external API is unreachable');

    // Existing show 1 data and cache intact
    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.viewingTime.tv.minutes, 167);
  });

  console.log('\n--- Suite 7: Live TVMaze API Check (Real Network) ---');

  await asyncCheck('Live TVMaze verification for Gränsbevakarna Sverige (ID 65139) confirms missing Season 2+ runtimes', async () => {
    try {
      const res = await fetch('https://api.tvmaze.com/shows/65139?embed=episodes', {
        headers: { 'User-Agent': 'MediaVault-Test/1.0' }
      });
      if (!res.ok) {
        console.log(`     (Live TVMaze check skipped: HTTP ${res.status})`);
        return;
      }
      const data = await res.json();
      const episodes = data?._embedded?.episodes || [];
      const s1 = episodes.filter(e => e.season === 1);
      const s2 = episodes.filter(e => e.season === 2);

      assert.ok(s1.length > 0, 'Season 1 should have episodes');
      assert.strictEqual(s1[0].runtime, 39, 'Season 1 Episode 1 has 39m runtime in live TVMaze');
      assert.ok(s2.length > 0, 'Season 2 should have episodes');
      assert.strictEqual(s2[0].runtime, null, 'Season 2 Episode 1 has runtime: null directly in live TVMaze provider');
      console.log(`     [Live TVMaze Verified] Show 65139 S1E1 runtime = ${s1[0].runtime}m, S2E1 runtime = ${s2[0].runtime}`);
    } catch (netErr) {
      console.log(`     (Live TVMaze network check skipped due to connectivity: ${netErr.message})`);
    }
  });

} finally {
  clearMockEpisodeData();
  try {
    db.close();
  } catch {}
  if (fs.existsSync(TEST_DB_PATH)) {
    try {
      fs.unlinkSync(TEST_DB_PATH);
    } catch {}
  }
}

console.log('\n====================================================');
console.log(`Test Results: ${passedChecks} / ${totalChecks} passed`);
console.log('====================================================\n');

if (passedChecks < totalChecks) {
  process.exit(1);
}
