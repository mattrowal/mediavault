import http from 'node:http';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_earlier_episodes_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  createUser,
  addMedia,
  getMediaById,
  getWatchedEpisodes,
  getWatchedEpisodesSet,
  startItemCycle,
  getUserActivities,
  getDashboardStats
} = await import('../db.js');
const {
  setMockEpisodeData,
  clearMockEpisodeData,
  getEarlierUnwatchedEpisodes,
  markEpisodeWatchedWithEarlier,
  toggleEpisodeWatched
} = await import('../episode-service.js');
const { getPersonalStatistics } = await import('../stats-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Earlier Episodes Catch-Up Test Suite');
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

let server;
let BASE_URL = '';

class TestClient {
  constructor() {
    this.cookies = {};
    this.csrfToken = null;
  }

  _parseSetCookies(setCookieHeader) {
    if (!setCookieHeader) return;
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const header of headers) {
      const parts = header.split(';')[0].split('=');
      const name = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      this.cookies[name] = val;
      if (name === 'mediavault_csrf') {
        this.csrfToken = val;
      }
    }
  }

  _formatCookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request(method, pathname, body = null, customHeaders = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, BASE_URL);
      const headers = { ...customHeaders };

      const cookieStr = this._formatCookieHeader();
      if (cookieStr) {
        headers['Cookie'] = cookieStr;
      }

      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
        if (this.csrfToken && !headers['x-csrf-token'] && customHeaders['x-csrf-token'] === undefined) {
          headers['x-csrf-token'] = this.csrfToken;
        }
      }

      let payload = null;
      if (body !== null && typeof body === 'object') {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(url, { method, headers }, (res) => {
        this._parseSetCookies(res.headers['set-cookie']);

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      });

      req.on('error', reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  async initCsrf() {
    await this.request('GET', '/api/auth/csrf');
  }

  async login(username, password) {
    await this.initCsrf();
    const res = await this.request('POST', '/api/auth/login', { username, password });
    return res;
  }

  async register(username, password) {
    await this.initCsrf();
    return this.request('POST', '/api/auth/register', { username, password });
  }
}

try {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      BASE_URL = `http://127.0.0.1:${port}`;
      console.log(`Test server running on ${BASE_URL}`);
      resolve();
    });
  });

  // Setup Users: Alice & Bob
  const clientAlice = new TestClient();
  const regAlice = await clientAlice.register('alice_catchup', 'StrongPassw0rd_12345');
  assert.strictEqual(regAlice.status, 201, 'Alice registers successfully');
  const alice = regAlice.body.user;

  const clientBob = new TestClient();
  const regBob = await clientBob.register('bob_catchup', 'StrongPassw0rd_12345');
  assert.strictEqual(regBob.status, 201, 'Bob registers successfully');
  const bob = regBob.body.user;

  // Show 1: Single season show with 5 episodes
  // S1: E1, E2, E3, E4, E5 (all released, 45 min runtime)
  const singleSeasonShow = addMedia({
    type: 'tv',
    title: 'Single Season Drama',
    external_id: 'mock-tv-single-season',
    status: 'watching',
    current_season: 1,
    current_episode: 0
  }, alice.id);

  setMockEpisodeData('mock-tv-single-season', [
    { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2023-01-01', runtime: 45, type: 'regular' },
    { id: 102, season: 1, number: 2, name: 'Chapter 2', airdate: '2023-01-08', runtime: 45, type: 'regular' },
    { id: 103, season: 1, number: 3, name: 'Chapter 3', airdate: '2023-01-15', runtime: 45, type: 'regular' },
    { id: 104, season: 1, number: 4, name: 'Chapter 4', airdate: '2023-01-22', runtime: 45, type: 'regular' },
    { id: 105, season: 1, number: 5, name: 'Finale', airdate: '2023-01-29', runtime: 45, type: 'regular' }
  ]);

  // Show 2: Multi-season show with specials and unreleased episodes
  // Season 0 (special): E1 (type: special)
  // Season 1: E1, E2, E3 (regular, released, 50 min)
  // Season 1: Special recap (number: 99, type: 'special')
  // Season 2: E1, E2, E3 (regular, released, 50 min)
  // Season 2: E4 (regular, UNRELEASED - year 2099)
  const multiSeasonShow = addMedia({
    type: 'tv',
    title: 'Multi-Season Epic',
    external_id: 'mock-tv-multi-season',
    status: 'watching',
    current_season: 1,
    current_episode: 0
  }, alice.id);

  setMockEpisodeData('mock-tv-multi-season', [
    { id: 901, season: 0, number: 1, name: 'Behind the Scenes Special', airdate: '2020-01-01', runtime: 60, type: 'special' },
    { id: 201, season: 1, number: 1, name: 'S1 Premiere', airdate: '2022-01-01', runtime: 50, type: 'regular' },
    { id: 202, season: 1, number: 2, name: 'S1 Episode 2', airdate: '2022-01-08', runtime: 50, type: 'regular' },
    { id: 203, season: 1, number: 3, name: 'S1 Finale', airdate: '2022-01-15', runtime: 50, type: 'regular' },
    { id: 902, season: 1, number: 99, name: 'Season 1 Recap Special', airdate: '2022-02-01', runtime: 30, type: 'special' },
    { id: 204, season: 2, number: 1, name: 'S2 Premiere', airdate: '2023-01-01', runtime: 50, type: 'regular' },
    { id: 205, season: 2, number: 2, name: 'S2 Episode 2', airdate: '2023-01-08', runtime: 50, type: 'regular' },
    { id: 206, season: 2, number: 3, name: 'S2 Episode 3', airdate: '2023-01-15', runtime: 50, type: 'regular' },
    { id: 207, season: 2, number: 4, name: 'S2 Future Finale', airdate: '2099-12-31', runtime: 50, type: 'regular' }
  ]);

  console.log('\n--- 1. Earlier Unwatched Episodes in Same Season ---');
  await asyncCheck('Check endpoint reports earlier unwatched episodes in same season correctly', async () => {
    const res = await clientAlice.request('GET', `/api/media/${singleSeasonShow.id}/episodes/earlier-unwatched?season=1&episode=4`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasEarlierUnwatched, true);
    assert.strictEqual(res.body.count, 3); // E1, E2, E3
    assert.strictEqual(res.body.earlierSeasonsIncluded, false);
    assert.strictEqual(res.body.seasonsBreakdown.length, 1);
    assert.strictEqual(res.body.seasonsBreakdown[0].season, 1);
    assert.strictEqual(res.body.seasonsBreakdown[0].count, 3);
  });

  await asyncCheck('Marking S1E1 reduces earlier unwatched count to 2 (E2, E3)', async () => {
    // Mark S1E1 directly
    await clientAlice.request('POST', `/api/media/${singleSeasonShow.id}/episodes/toggle`, { season: 1, episode: 1 });

    const res = await clientAlice.request('GET', `/api/media/${singleSeasonShow.id}/episodes/earlier-unwatched?season=1&episode=4`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.count, 2); // E2, E3
    assert.deepStrictEqual(res.body.episodes.map(e => e.episode), [2, 3]);
  });

  console.log('\n--- 2. Earlier Unwatched Episodes Across Seasons ---');
  await asyncCheck('Check endpoint detects unwatched episodes spanning multiple seasons', async () => {
    // Alice has watched nothing on multiSeasonShow
    // Check earlier before S2E2
    const res = await clientAlice.request('GET', `/api/media/${multiSeasonShow.id}/episodes/earlier-unwatched?season=2&episode=2`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasEarlierUnwatched, true);
    // Regular released episodes before S2E2: S1E1, S1E2, S1E3, S2E1 = 4 episodes!
    assert.strictEqual(res.body.count, 4);
    assert.strictEqual(res.body.earlierSeasonsIncluded, true);
    assert.strictEqual(res.body.seasonsBreakdown.length, 2);
    assert.strictEqual(res.body.seasonsBreakdown[0].season, 1);
    assert.strictEqual(res.body.seasonsBreakdown[0].count, 3);
    assert.strictEqual(res.body.seasonsBreakdown[1].season, 2);
    assert.strictEqual(res.body.seasonsBreakdown[1].count, 1);
  });

  console.log('\n--- 3. Specials and Unreleased Episodes Exclusion ---');
  await asyncCheck('Specials (season 0, type special) and unreleased episodes are strictly excluded', async () => {
    const res = await clientAlice.request('GET', `/api/media/${multiSeasonShow.id}/episodes/earlier-unwatched?season=2&episode=3`);
    assert.strictEqual(res.status, 200);
    // Should NOT contain special ID 901 (season 0) or 902 (season 1 special)
    const epIds = res.body.episodes.map(e => e.id);
    assert.ok(!epIds.includes(901), 'Special 901 must not be included');
    assert.ok(!epIds.includes(902), 'Special 902 must not be included');
    assert.ok(!epIds.includes(207), 'Future unreleased episode 207 must not be included');
  });

  console.log('\n--- 4. All Three Dialog Choices ---');
  await asyncCheck('Choice 1: Cancel does NOT mark anything (state unchanged)', async () => {
    const beforeWatched = getWatchedEpisodesSet(singleSeasonShow.id, alice.id);
    // Cancel in UI means no save call is made, or dialog dismissed
    const afterWatched = getWatchedEpisodesSet(singleSeasonShow.id, alice.id);
    assert.strictEqual(beforeWatched.size, afterWatched.size);
    assert.ok(!afterWatched.has('1-4'), 'S1E4 remains unwatched');
  });

  await asyncCheck('Choice 2: "Only this episode" marks ONLY the selected episode', async () => {
    // Currently on singleSeasonShow, S1E1 is watched. S1E2, S1E3, S1E4, S1E5 unwatched.
    // User marks S1E4 with markEarlier = false
    const res = await clientAlice.request('POST', `/api/media/${singleSeasonShow.id}/episodes/toggle`, {
      season: 1,
      episode: 4,
      markEarlier: false
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isWatched, true);

    const watchedSet = getWatchedEpisodesSet(singleSeasonShow.id, alice.id);
    assert.ok(watchedSet.has('1-4'), 'S1E4 is watched');
    assert.ok(!watchedSet.has('1-2'), 'S1E2 remains UNWATCHED');
    assert.ok(!watchedSet.has('1-3'), 'S1E3 remains UNWATCHED');
  });

  await asyncCheck('Choice 3: "Mark earlier episodes too" marks target AND all earlier unwatched episodes', async () => {
    // On multiSeasonShow, Alice marks S2E2 with markEarlier = true
    const res = await clientAlice.request('POST', `/api/media/${multiSeasonShow.id}/episodes/mark-watched`, {
      season: 2,
      episode: 2,
      markEarlier: true,
      leaveDateUnknown: true
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.markedEarlier, true);
    assert.strictEqual(res.body.earlierCount, 4); // S1E1, S1E2, S1E3, S2E1

    const watchedSet = getWatchedEpisodesSet(multiSeasonShow.id, alice.id);
    assert.ok(watchedSet.has('1-1'), 'S1E1 is marked watched');
    assert.ok(watchedSet.has('1-2'), 'S1E2 is marked watched');
    assert.ok(watchedSet.has('1-3'), 'S1E3 is marked watched');
    assert.ok(watchedSet.has('2-1'), 'S2E1 is marked watched');
    assert.ok(watchedSet.has('2-2'), 'S2E2 is marked watched');
    assert.ok(!watchedSet.has('2-3'), 'S2E3 remains unwatched');
  });

  console.log('\n--- 5. No Earlier Unwatched Episodes ---');
  await asyncCheck('When all earlier episodes are watched, earlier-unwatched reports count 0', async () => {
    // S2E2 is watched. Now checking S2E3:
    // S1E1, S1E2, S1E3, S2E1, S2E2 are all watched.
    const res = await clientAlice.request('GET', `/api/media/${multiSeasonShow.id}/episodes/earlier-unwatched?season=2&episode=3`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasEarlierUnwatched, false);
    assert.strictEqual(res.body.count, 0);

    // Normal toggle marks S2E3 without needing catch-up
    const toggleRes = await clientAlice.request('POST', `/api/media/${multiSeasonShow.id}/episodes/toggle`, {
      season: 2,
      episode: 3
    });
    assert.strictEqual(toggleRes.status, 200);
    assert.strictEqual(toggleRes.body.isWatched, true);
  });

  console.log('\n--- 6. Unmarking an Episode (No Dialog / Single Action) ---');
  await asyncCheck('Unmarking S2E3 unmarks only that episode, leaving earlier episodes watched', async () => {
    const res = await clientAlice.request('POST', `/api/media/${multiSeasonShow.id}/episodes/toggle`, {
      season: 2,
      episode: 3
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isWatched, false);

    const watchedSet = getWatchedEpisodesSet(multiSeasonShow.id, alice.id);
    assert.ok(!watchedSet.has('2-3'), 'S2E3 is now unwatched');
    assert.ok(watchedSet.has('2-2'), 'S2E2 remains watched');
    assert.ok(watchedSet.has('1-1'), 'S1E1 remains watched');
  });

  console.log('\n--- 7. Repeated Requests & Idempotency (No Double Counting) ---');
  await asyncCheck('Retrying or repeating mark-watched does not insert duplicate rows or duplicate activity', async () => {
    const beforeRows = db.prepare('SELECT COUNT(*) as c FROM watched_episodes WHERE media_id = ? AND user_id = ?').get(multiSeasonShow.id, alice.id).c;
    const beforeActs = db.prepare('SELECT COUNT(*) as c FROM activity_log WHERE item_id = ? AND user_id = ?').get(multiSeasonShow.id, alice.id).c;

    // Call mark-watched again on already watched S2E2 with markEarlier = true
    const retryRes = await clientAlice.request('POST', `/api/media/${multiSeasonShow.id}/episodes/mark-watched`, {
      season: 2,
      episode: 2,
      markEarlier: true,
      leaveDateUnknown: true
    });
    assert.strictEqual(retryRes.status, 200);
    assert.strictEqual(retryRes.body.earlierCount, 0, 'No new earlier episodes marked');

    const afterRows = db.prepare('SELECT COUNT(*) as c FROM watched_episodes WHERE media_id = ? AND user_id = ?').get(multiSeasonShow.id, alice.id).c;
    const afterActs = db.prepare('SELECT COUNT(*) as c FROM activity_log WHERE item_id = ? AND user_id = ?').get(multiSeasonShow.id, alice.id).c;

    assert.strictEqual(afterRows, beforeRows, 'Watched episodes rows must NOT increase on duplicate/retried requests');
    assert.strictEqual(afterActs, beforeActs, 'Activity log entries must NOT duplicate on duplicate/retried requests');
  });

  console.log('\n--- 8. Rewatch Cycles & Account Isolation ---');
  await asyncCheck('Bob cannot access, query or mark Alice TV shows (404)', async () => {
    const getRes = await clientBob.request('GET', `/api/media/${multiSeasonShow.id}/episodes/earlier-unwatched?season=2&episode=2`);
    assert.strictEqual(getRes.status, 404);

    const postRes = await clientBob.request('POST', `/api/media/${multiSeasonShow.id}/episodes/mark-watched`, {
      season: 2,
      episode: 2,
      markEarlier: true
    });
    assert.strictEqual(postRes.status, 404);
  });

  await asyncCheck('Rewatch Cycle 2 only checks episodes in Cycle 2, preserving Cycle 1', async () => {
    // Show 3: Rewatch test
    const rewatchShow = addMedia({
      type: 'tv',
      title: 'Rewatchable Sitcom',
      external_id: 'mock-tv-rewatch',
      status: 'completed',
      current_season: 1,
      current_episode: 3,
      current_cycle: 1
    }, alice.id);

    setMockEpisodeData('mock-tv-rewatch', [
      { id: 301, season: 1, number: 1, name: 'S1E1', airdate: '2020-01-01', runtime: 30, type: 'regular' },
      { id: 302, season: 1, number: 2, name: 'S1E2', airdate: '2020-01-08', runtime: 30, type: 'regular' },
      { id: 303, season: 1, number: 3, name: 'S1E3', airdate: '2020-01-15', runtime: 30, type: 'regular' }
    ]);

    // Mark all 3 watched in cycle 1
    await clientAlice.request('POST', `/api/media/${rewatchShow.id}/episodes/mark-watched`, {
      season: 1,
      episode: 3,
      markEarlier: true
    });

    // Start Cycle 2 (Rewatch)
    startItemCycle(alice.id, 'tv', rewatchShow.id);

    // In Cycle 2, S1E1, S1E2, S1E3 are unwatched!
    const cycle2Check = await clientAlice.request('GET', `/api/media/${rewatchShow.id}/episodes/earlier-unwatched?season=1&episode=3`);
    assert.strictEqual(cycle2Check.status, 200);
    assert.strictEqual(cycle2Check.body.count, 2, 'In Cycle 2, S1E1 and S1E2 are earlier unwatched episodes in this cycle');

    // Cycle 1 records still exist in DB
    const cycle1Records = db.prepare('SELECT COUNT(*) as c FROM watched_episodes WHERE media_id = ? AND user_id = ? AND cycle_number = 1').get(rewatchShow.id, alice.id).c;
    assert.strictEqual(cycle1Records, 3, 'Cycle 1 records are fully preserved');
  });

  console.log('\n--- 9. Statistics & Historical Catch-Up Handling ---');
  await asyncCheck('Historical catch-up (leaveDateUnknown=true) is counted in All Time but NOT in This Month', async () => {
    // Show 4: Dedicated stats test show
    const statsShow = addMedia({
      type: 'tv',
      title: 'Stats Tracking Show',
      external_id: 'mock-tv-stats',
      status: 'watching',
      current_season: 1,
      current_episode: 0
    }, alice.id);

    setMockEpisodeData('mock-tv-stats', [
      { id: 401, season: 1, number: 1, name: 'Ep 1', airdate: '2021-01-01', runtime: 60, type: 'regular' },
      { id: 402, season: 1, number: 2, name: 'Ep 2', airdate: '2021-01-08', runtime: 60, type: 'regular' },
      { id: 403, season: 1, number: 3, name: 'Ep 3', airdate: '2021-01-15', runtime: 60, type: 'regular' }
    ]);

    // Mark Ep 3 with catch-up of earlier episodes (Ep 1 & Ep 2) with leaveDateUnknown = true
    await clientAlice.request('POST', `/api/media/${statsShow.id}/episodes/mark-watched`, {
      season: 1,
      episode: 3,
      markEarlier: true,
      leaveDateUnknown: true
    });

    // Check all-time statistics
    const allTimeStats = await getPersonalStatistics(alice.id, 'all_time');
    // Ep 1, 2, 3 on statsShow all count towards total episodes watched in all-time
    assert.ok(allTimeStats.summary.episodesWatched >= 3, 'All-time includes all 3 watched episodes');
    assert.ok(allTimeStats.notes.historicalData.includes('historical episode(s) without recorded dates'));

    // Check this_month statistics
    const monthStats = await getPersonalStatistics(alice.id, 'this_month');
    // Ep 1 and Ep 2 (historical without date) MUST NOT be counted in This Month!
    // Only Ep 3 (marked today) is counted in This Month for statsShow!
    const statsShowWatchedInMonth = db.prepare(`
      SELECT COUNT(*) as c FROM watched_episodes
      WHERE media_id = ? AND user_id = ? AND watched_at >= datetime('now', 'start of month')
    `).get(statsShow.id, alice.id).c;

    assert.strictEqual(statsShowWatchedInMonth, 1, 'Only 1 episode (Ep 3) was recorded as watched this month');

    const ep1Row = db.prepare('SELECT watched_at FROM watched_episodes WHERE media_id = ? AND user_id = ? AND season = 1 AND episode = 1').get(statsShow.id, alice.id);
    const ep2Row = db.prepare('SELECT watched_at FROM watched_episodes WHERE media_id = ? AND user_id = ? AND season = 1 AND episode = 2').get(statsShow.id, alice.id);
    const ep3Row = db.prepare('SELECT watched_at FROM watched_episodes WHERE media_id = ? AND user_id = ? AND season = 1 AND episode = 3').get(statsShow.id, alice.id);

    assert.strictEqual(ep1Row.watched_at, null, 'Earlier episode Ep 1 has watched_at = null');
    assert.strictEqual(ep2Row.watched_at, null, 'Earlier episode Ep 2 has watched_at = null');
    assert.ok(ep3Row.watched_at !== null, 'Target episode Ep 3 has active timestamp');
  });

  console.log('\n--- 10. Non-Consecutive Episode Numbers & Actual Data Ordering ---');
  await asyncCheck('Check earlier episodes with gaps/non-consecutive episode numbers uses actual data', async () => {
    // Show 5: Non-consecutive episode show (e.g., E1, E5, E14)
    const gapShow = addMedia({
      type: 'tv',
      title: 'Gap Episodes Anthology',
      external_id: 'mock-tv-gap',
      status: 'watching',
      current_season: 1,
      current_episode: 0
    }, alice.id);

    setMockEpisodeData('mock-tv-gap', [
      { id: 501, season: 1, number: 1, name: 'First Act', airdate: '2023-01-01', runtime: 45, type: 'regular' },
      { id: 502, season: 1, number: 5, name: 'Middle Act', airdate: '2023-01-10', runtime: 45, type: 'regular' },
      { id: 503, season: 1, number: 14, name: 'Final Act', airdate: '2023-01-20', runtime: 45, type: 'regular' }
    ]);

    // Marking S1E14 should detect exactly 2 earlier unwatched episodes (E1 and E5), NOT 13 consecutive assumptions
    const res = await clientAlice.request('GET', `/api/media/${gapShow.id}/episodes/earlier-unwatched?season=1&episode=14`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasEarlierUnwatched, true);
    assert.strictEqual(res.body.count, 2);
    assert.deepStrictEqual(res.body.episodes.map(e => e.episode), [1, 5]);

    // Mark earlier episodes too
    const markRes = await clientAlice.request('POST', `/api/media/${gapShow.id}/episodes/mark-watched`, {
      season: 1,
      episode: 14,
      markEarlier: true
    });
    assert.strictEqual(markRes.status, 200);
    assert.strictEqual(markRes.body.earlierCount, 2);

    const watchedSet = getWatchedEpisodesSet(gapShow.id, alice.id);
    assert.ok(watchedSet.has('1-1'));
    assert.ok(watchedSet.has('1-5'));
    assert.ok(watchedSet.has('1-14'));
    assert.strictEqual(watchedSet.size, 3);
  });

  console.log('\n--- 11. Season Progress, Dashboard Counts & Persistence ---');
  await asyncCheck('Season progress and dashboard counts update after catch-up and persist in database', async () => {
    const dashboard = getDashboardStats(alice.id);
    assert.ok(dashboard.series.activeWatching >= 1, 'Active watching series tracked');

    // Fetch show data via season progress view
    const showDetail = await clientAlice.request('GET', `/api/media/${multiSeasonShow.id}/seasons`);
    assert.strictEqual(showDetail.status, 200);
    const s1 = showDetail.body.seasons.find(s => s.seasonNumber === 1);
    assert.strictEqual(s1.status, 'Completed', 'Season 1 is Completed after catch-up');
    assert.strictEqual(s1.watchedCount, 3, 'All 3 episodes in Season 1 are marked watched');
  });

  console.log('\n--- 12. Modal Accessibility & Markup Verification ---');
  check('Modal HTML contains accessible structure, question text, and 3 option buttons', () => {
    const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
    assert.ok(html.includes('id="modal-confirm-earlier-episodes"'), 'Modal element exists');
    assert.ok(html.includes('role="dialog"'), 'Dialog role defined');
    assert.ok(html.includes('aria-modal="true"'), 'Aria-modal defined');
    assert.ok(html.includes('aria-labelledby="modal-earlier-title"'), 'Aria-labelledby defined');
    assert.ok(html.includes('Have you also watched the earlier episodes?'), 'Exact question text present');
    assert.ok(html.includes('id="btn-mark-earlier-too"'), 'Choice 1 button exists');
    assert.ok(html.includes('Mark earlier episodes too'), 'Choice 1 text exact');
    assert.ok(html.includes('id="btn-only-this-episode"'), 'Choice 2 button exists');
    assert.ok(html.includes('Only this episode'), 'Choice 2 text exact');
    assert.ok(html.includes('id="btn-cancel-earlier-dialog"'), 'Choice 3 button exists');
    assert.ok(html.includes('Cancel'), 'Choice 3 text exact');
    assert.ok(html.includes('id="earlier-unknown-date-checkbox"'), 'Historical catch-up date checkbox exists');
  });

  check('CSS defines visible focus outlines for dialog controls', () => {
    const css = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');
    assert.ok(css.includes('.earlier-episodes-actions button:focus-visible'), 'Button focus-visible defined');
    assert.ok(css.includes('#btn-close-earlier-modal:focus-visible'), 'Close button focus-visible defined');
    assert.ok(css.includes('#earlier-unknown-date-checkbox:focus-visible'), 'Checkbox focus-visible defined');
  });

  console.log('\n====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL EARLIER EPISODES CATCH-UP TESTS PASSED!');
  } else {
    console.error('❌ SOME TESTS FAILED.');
    process.exitCode = 1;
  }
  console.log('====================================================\n');
} catch (err) {
  console.error('Fatal test error:', err);
  process.exitCode = 1;
} finally {
  clearMockEpisodeData();
  if (server) {
    server.close();
  }
}
