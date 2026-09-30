import http from 'node:http';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_season_view_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  createUser,
  addMedia,
  getMediaById,
  updateMedia,
  getWatchedEpisodes,
  getWatchedEpisodesSet
} = await import('../db.js');
const {
  setMockEpisodeData,
  clearMockEpisodeData
} = await import('../episode-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Season & Episode Visual View Test Suite');
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
    return this.request('POST', '/api/auth/login', { username, password });
  }

  async register(username, password) {
    await this.initCsrf();
    return this.request('POST', '/api/auth/register', { username, password });
  }
}

// -----------------------------------------------------------
// TEST FIXTURES
// -----------------------------------------------------------
function createFriendsFixture() {
  const episodes = [];
  const pastAirstamp = '2000-01-01T00:00:00+00:00';

  // Season 1: 24 episodes
  for (let ep = 1; ep <= 24; ep++) {
    episodes.push({
      id: 1000 + ep,
      season: 1,
      number: ep,
      name: `S1 Episode ${ep}`,
      type: 'regular',
      airstamp: pastAirstamp,
      airdate: '1994-09-22',
      image: { medium: `https://static.tvmaze.com/friends_s1e${ep}.jpg` }
    });
  }

  // Season 2: 24 episodes
  for (let ep = 1; ep <= 24; ep++) {
    episodes.push({
      id: 2000 + ep,
      season: 2,
      number: ep,
      name: `S2 Episode ${ep}`,
      type: 'regular',
      airstamp: pastAirstamp,
      airdate: '1995-09-21',
      image: { medium: `https://static.tvmaze.com/friends_s2e${ep}.jpg` }
    });
  }

  // Interspersed specials
  episodes.push({
    id: 9991,
    season: 1,
    number: null,
    name: 'Friends Special Outtakes',
    type: 'special',
    airstamp: pastAirstamp,
    airdate: '1995-05-01'
  });

  return episodes;
}

function createOngoingShowFixture() {
  const pastAirstamp = '2023-01-01T00:00:00+00:00';
  const futureAirstamp = '2099-01-01T00:00:00+00:00';

  const episodes = [];
  // Season 1: 10 released episodes
  for (let ep = 1; ep <= 10; ep++) {
    episodes.push({
      id: 3000 + ep,
      season: 1,
      number: ep,
      name: `Ongoing S1E${ep}`,
      type: 'regular',
      airstamp: pastAirstamp,
      airdate: '2023-01-15'
    });
  }

  // Season 2: 2 released episodes, 8 upcoming
  for (let ep = 1; ep <= 2; ep++) {
    episodes.push({
      id: 4000 + ep,
      season: 2,
      number: ep,
      name: `Ongoing S2E${ep}`,
      type: 'regular',
      airstamp: pastAirstamp,
      airdate: '2024-02-01'
    });
  }
  for (let ep = 3; ep <= 10; ep++) {
    episodes.push({
      id: 4000 + ep,
      season: 2,
      number: ep,
      name: `Upcoming S2E${ep}`,
      type: 'regular',
      airstamp: futureAirstamp,
      airdate: '2099-05-01'
    });
  }

  return episodes;
}

// -----------------------------------------------------------
// TEST EXECUTION
// -----------------------------------------------------------
async function runTests() {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      BASE_URL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const clientAlice = new TestClient();
  const clientBob = new TestClient();

  const regAlice = await clientAlice.register('alice_seasons', 'super_secret_password_12345');
  assert.strictEqual(regAlice.status, 201, 'Alice registers');
  const aliceId = regAlice.body.user.id;

  const regBob = await clientBob.register('bob_seasons', 'super_secret_password_67890');
  assert.strictEqual(regBob.status, 201, 'Bob registers');
  const bobId = regBob.body.user.id;

  setMockEpisodeData('mock_friends_view', createFriendsFixture(), { status: 'Ended' });
  setMockEpisodeData('mock_ongoing_view', createOngoingShowFixture(), { status: 'Running' });

  // Add Friends for Alice
  const friendsRes = await clientAlice.request('POST', '/api/media', {
    title: 'Friends',
    type: 'tv',
    external_id: 'mock_friends_view',
    status: 'watching',
    current_season: 1,
    current_episode: 0
  });
  assert.strictEqual(friendsRes.status, 201);
  const friendsId = friendsRes.body.id;

  // =========================================================================
  // 1️⃣ SCENARIO 1: Completed Season & Partially Watched Next Season
  // =========================================================================
  console.log('\n1️⃣ Scenario 1: Completed Season & Partially Watched Next Season');

  await asyncCheck('Bulk mark Season 1 as watched (24/24 episodes)', async () => {
    const markS1Res = await clientAlice.request('POST', `/api/media/${friendsId}/seasons/1/mark-watched`);
    assert.strictEqual(markS1Res.status, 200);
    assert.strictEqual(markS1Res.body.markedCount, 24);
  });

  await asyncCheck('Mark 12 of 24 episodes in Season 2 as watched', async () => {
    for (let ep = 1; ep <= 12; ep++) {
      const toggleRes = await clientAlice.request('POST', `/api/media/${friendsId}/episodes/toggle`, {
        season: 2,
        episode: ep
      });
      assert.strictEqual(toggleRes.status, 200);
      assert.strictEqual(toggleRes.body.isWatched, true);
    }
  });

  await asyncCheck('GET /api/media/:id/seasons returns accurate progress and statuses', async () => {
    const res = await clientAlice.request('GET', `/api/media/${friendsId}/seasons`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.available, true);
    assert.strictEqual(res.body.seasons.length, 2);

    const s1 = res.body.seasons[0];
    assert.strictEqual(s1.seasonNumber, 1);
    assert.strictEqual(s1.watchedCount, 24);
    assert.strictEqual(s1.releasedEpisodes, 24);
    assert.strictEqual(s1.progressPercent, 100);
    assert.strictEqual(s1.status, 'Completed', 'Season 1 status is Completed');

    const s2 = res.body.seasons[1];
    assert.strictEqual(s2.seasonNumber, 2);
    assert.strictEqual(s2.watchedCount, 12);
    assert.strictEqual(s2.releasedEpisodes, 24);
    assert.strictEqual(s2.progressPercent, 50);
    assert.strictEqual(s2.status, 'In progress', 'Season 2 status is In progress (50%)');

    assert.strictEqual(res.body.totalWatchedCount, 36);
    assert.strictEqual(res.body.totalReleasedCount, 48);
    assert.strictEqual(res.body.nextEpisode.season, 2);
    assert.strictEqual(res.body.nextEpisode.episode, 13);
  });

  // =========================================================================
  // 2️⃣ SCENARIO 2: Marking and Unmarking Individual Episodes + Bulk Undo
  // =========================================================================
  console.log('\n2️⃣ Scenario 2: Marking and Unmarking Individual Episodes');

  await asyncCheck('Toggle S2E13: marks as watched', async () => {
    const res = await clientAlice.request('POST', `/api/media/${friendsId}/episodes/toggle`, {
      season: 2,
      episode: 13
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isWatched, true);
    assert.strictEqual(res.body.showData.seasons[1].watchedCount, 13);
  });

  await asyncCheck('Toggle S2E13 again: unmarks as watched', async () => {
    const res = await clientAlice.request('POST', `/api/media/${friendsId}/episodes/toggle`, {
      season: 2,
      episode: 13
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isWatched, false);
    assert.strictEqual(res.body.showData.seasons[1].watchedCount, 12);
  });

  await asyncCheck('Bulk mark remaining Season 2 episodes and Undo changes', async () => {
    const bulkRes = await clientAlice.request('POST', `/api/media/${friendsId}/seasons/2/mark-watched`);
    assert.strictEqual(bulkRes.status, 200);
    assert.strictEqual(bulkRes.body.markedCount, 12);
    assert.strictEqual(bulkRes.body.showData.seasons[1].watchedCount, 24);
    assert.strictEqual(bulkRes.body.showData.seasons[1].status, 'Completed');

    // Undo bulk mark using batch-unmark
    const undoRes = await clientAlice.request('POST', `/api/media/${friendsId}/episodes/batch-unmark`, {
      episodes: bulkRes.body.markedEpisodes
    });
    assert.strictEqual(undoRes.status, 200);
    assert.strictEqual(undoRes.body.unmarkedCount, 12);
    assert.strictEqual(undoRes.body.showData.seasons[1].watchedCount, 12);
    assert.strictEqual(undoRes.body.showData.seasons[1].status, 'In progress');
  });

  // =========================================================================
  // 3️⃣ SCENARIO 3: Out-of-Order Viewing
  // =========================================================================
  console.log('\n3️⃣ Scenario 3: Out-of-Order Viewing');

  await asyncCheck('Mark S2E20 as watched out of order (while E13-E19 are unwatched)', async () => {
    const res = await clientAlice.request('POST', `/api/media/${friendsId}/episodes/toggle`, {
      season: 2,
      episode: 20
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.isWatched, true);
    // Watched count is now 12 + 1 = 13
    assert.strictEqual(res.body.showData.seasons[1].watchedCount, 13);
  });

  await asyncCheck('Next episode calculation targets the earliest unwatched released episode (S2E13)', async () => {
    const res = await clientAlice.request('GET', `/api/media/${friendsId}/seasons`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.nextEpisode.season, 2);
    assert.strictEqual(res.body.nextEpisode.episode, 13, 'Next episode is S2E13, not S2E21');
  });

  // =========================================================================
  // 4️⃣ SCENARIO 4: Moving from a Season Finale to the Next Season
  // =========================================================================
  console.log('\n4️⃣ Scenario 4: Moving from Season Finale to Next Season');

  // Add a fresh show at Season 1 finale
  const finaleShowRes = await clientAlice.request('POST', '/api/media', {
    title: 'Friends Finale Test',
    type: 'tv',
    external_id: 'mock_friends_view',
    status: 'watching',
    current_season: 1,
    current_episode: 23
  });
  const finaleShowId = finaleShowRes.body.id;

  await asyncCheck('Increment from S1E23 to S1E24 (Season finale)', async () => {
    const res = await clientAlice.request('POST', `/api/media/${finaleShowId}/increment-episode`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 1);
    assert.strictEqual(res.body.current_episode, 24);
    assert.strictEqual(res.body.next_episode.season, 2);
    assert.strictEqual(res.body.next_episode.episode, 1);
  });

  await asyncCheck('Next click marks S2E1 without automatically completing S2E2', async () => {
    const res = await clientAlice.request('POST', `/api/media/${finaleShowId}/increment-episode`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 2);
    assert.strictEqual(res.body.current_episode, 1);
    assert.strictEqual(res.body.next_episode.season, 2);
    assert.strictEqual(res.body.next_episode.episode, 2);
  });

  // =========================================================================
  // 5️⃣ SCENARIO 5: Upcoming Episodes & Caught-Up Status
  // =========================================================================
  console.log('\n5️⃣ Scenario 5: Upcoming Episodes and Caught-Up Status');

  const ongoingRes = await clientAlice.request('POST', '/api/media', {
    title: 'Ongoing SciFi',
    type: 'tv',
    external_id: 'mock_ongoing_view',
    status: 'watching',
    current_season: 1,
    current_episode: 0
  });
  const ongoingId = ongoingRes.body.id;

  await asyncCheck('Mark all 10 released episodes of Season 1 as watched', async () => {
    const res = await clientAlice.request('POST', `/api/media/${ongoingId}/seasons/1/mark-watched`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.markedCount, 10);
    assert.strictEqual(res.body.showData.seasons[0].status, 'Completed');
  });

  await asyncCheck('Attempting to mark upcoming unreleased episode (S2E3) is rejected with 400', async () => {
    const res = await clientAlice.request('POST', `/api/media/${ongoingId}/episodes/toggle`, {
      season: 2,
      episode: 3
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('unreleased'), 'Rejects unreleased episode');
  });

  await asyncCheck('Mark only released episodes in Season 2 (E1 and E2)', async () => {
    await clientAlice.request('POST', `/api/media/${ongoingId}/episodes/toggle`, { season: 2, episode: 1 });
    await clientAlice.request('POST', `/api/media/${ongoingId}/episodes/toggle`, { season: 2, episode: 2 });

    const viewRes = await clientAlice.request('GET', `/api/media/${ongoingId}/seasons`);
    assert.strictEqual(viewRes.status, 200);

    const s1 = viewRes.body.seasons[0];
    const s2 = viewRes.body.seasons[1];

    assert.strictEqual(s1.status, 'Completed', 'Season 1 is Completed (10/10, 0 upcoming)');
    assert.strictEqual(s2.status, 'Caught up', 'Season 2 is Caught up (2/2 released watched, 8 upcoming)');
    assert.strictEqual(s2.upcomingEpisodes, 8, '8 upcoming episodes recorded');
    assert.strictEqual(viewRes.body.isCaughtUp, true, 'Show is caught up with released episodes');
  });

  await asyncCheck('Attempting +1 Episode Watched when caught up returns 400', async () => {
    const res = await clientAlice.request('POST', `/api/media/${ongoingId}/increment-episode`);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('caught up'));
  });

  // =========================================================================
  // 6️⃣ SCENARIO 6: Invalid Manual Entries & Corrected Inputs
  // =========================================================================
  console.log('\n6️⃣ Scenario 6: Invalid Manual Entries and Corrected Inputs');

  await asyncCheck('Validate S1E55: rejected with exact error format', async () => {
    const res = await clientAlice.request('GET', `/api/media/${friendsId}/validate-progress?season=1&episode=55`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.valid, false);
    assert.strictEqual(res.body.error, 'Season 1 has 24 episodes. Enter an episode between 0 and 24.');
  });

  await asyncCheck('Saving S1E55 via PUT /api/media/:id returns 400 Bad Request', async () => {
    const res = await clientAlice.request('PUT', `/api/media/${friendsId}`, {
      title: 'Friends',
      current_season: 1,
      current_episode: 55
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Season 1 has 24 episodes. Enter an episode between 0 and 24.'));
  });

  await asyncCheck('Nonexistent season (Season 9) returns 400 with season count', async () => {
    const res = await clientAlice.request('GET', `/api/media/${friendsId}/validate-progress?season=9&episode=1`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.valid, false);
    assert.ok(res.body.error.includes('Season 9 does not exist. This series has 2 seasons.'));
  });

  await asyncCheck('Negative numbers return 400', async () => {
    const res = await clientAlice.request('PUT', `/api/media/${friendsId}`, {
      title: 'Friends',
      current_season: -1,
      current_episode: 5
    });
    assert.strictEqual(res.status, 400);
  });

  await asyncCheck('Episode 0 is valid (means 0 episodes watched in selected season)', async () => {
    const res = await clientAlice.request('GET', `/api/media/${friendsId}/validate-progress?season=2&episode=0`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.valid, true);
  });

  await asyncCheck('Saving corrected valid progress (S1E24) succeeds without corrupting out-of-order progress', async () => {
    const res = await clientAlice.request('PUT', `/api/media/${friendsId}`, {
      title: 'Friends',
      current_season: 1,
      current_episode: 24
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 1);
    assert.strictEqual(res.body.current_episode, 24);

    // Verify S2E20 out-of-order progress was preserved!
    const seasonsRes = await clientAlice.request('GET', `/api/media/${friendsId}/seasons`);
    const s2Ep20 = seasonsRes.body.seasons[1].episodes.find(e => e.number === 20);
    assert.strictEqual(s2Ep20.isWatched, true, 'S2E20 out-of-order progress is preserved');
  });

  // =========================================================================
  // 7️⃣ SCENARIO 7: Missing Episode Data & Failed Saves
  // =========================================================================
  console.log('\n7️⃣ Scenario 7: Missing Episode Data and Failed Saves');

  const missingShowRes = await clientAlice.request('POST', '/api/media', {
    title: 'Offline Show',
    type: 'tv',
    external_id: null,
    status: 'watching',
    current_season: 1,
    current_episode: 5
  });
  const missingShowId = missingShowRes.body.id;

  await asyncCheck('GET /api/media/:id/seasons reports data unavailable gracefully', async () => {
    const res = await clientAlice.request('GET', `/api/media/${missingShowId}/seasons`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.available, false);
    assert.ok(res.body.error.includes('unavailable'));
  });

  await asyncCheck('Attempting +1 Episode Watched on unavailable show returns 400', async () => {
    const res = await clientAlice.request('POST', `/api/media/${missingShowId}/increment-episode`);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('unavailable'));
  });

  // =========================================================================
  // 8️⃣ SCENARIO 8: Safe Migration of Valid and Invalid Old Progress
  // =========================================================================
  console.log('\n8️⃣ Scenario 8: Safe Migration of Valid and Invalid Old Progress');

  // Case A: Valid legacy progress (S1E10) with empty watched_episodes
  const legacyValidRes = await clientAlice.request('POST', '/api/media', {
    title: 'Friends Legacy Valid',
    type: 'tv',
    external_id: 'mock_friends_view',
    status: 'watching',
    current_season: 1,
    current_episode: 10
  });
  const legacyValidId = legacyValidRes.body.id;

  await asyncCheck('Valid legacy progress is migrated sequentially to watched_episodes', async () => {
    const viewRes = await clientAlice.request('GET', `/api/media/${legacyValidId}/seasons`);
    assert.strictEqual(viewRes.status, 200);
    assert.strictEqual(viewRes.body.totalWatchedCount, 10);
    assert.strictEqual(viewRes.body.seasons[0].watchedCount, 10);
    assert.strictEqual(viewRes.body.nextEpisode.season, 1);
    assert.strictEqual(viewRes.body.nextEpisode.episode, 11);
  });

  await asyncCheck('Re-fetching seasons is idempotent and preserves exact values', async () => {
    const viewRes2 = await clientAlice.request('GET', `/api/media/${legacyValidId}/seasons`);
    assert.strictEqual(viewRes2.status, 200);
    assert.strictEqual(viewRes2.body.totalWatchedCount, 10);
  });

  // Case B: Invalid legacy progress (S1E44) directly inserted into DB (simulating legacy data)
  const legacyInvalidShow = addMedia({
    title: 'Friends Legacy Invalid S1E44',
    type: 'tv',
    external_id: 'mock_friends_view',
    status: 'watching',
    current_season: 1,
    current_episode: 44
  }, aliceId);
  const legacyInvalidId = legacyInvalidShow.id;

  await asyncCheck('Invalid legacy progress (S1E44) is preserved without silent reset or deletion', async () => {
    const viewRes = await clientAlice.request('GET', `/api/media/${legacyInvalidId}/seasons`);
    assert.strictEqual(viewRes.status, 200);
    assert.strictEqual(viewRes.body.isProgressInvalid, true);
    assert.ok(viewRes.body.invalidProgressReason.includes('Season 1 has 24 episodes. Enter an episode between 0 and 24.'));
    // Ensure media_items still holds the original value for recovery
    assert.strictEqual(viewRes.body.show.current_season, 1);
    assert.strictEqual(viewRes.body.show.current_episode, 44);
  });

  // =========================================================================
  // 9️⃣ SCENARIO 9: Persistence After Refresh & Isolation Between Two Accounts
  // =========================================================================
  console.log('\n9️⃣ Scenario 9: Persistence After Refresh and Two-Account Isolation');

  await asyncCheck('Alice watched episodes persist across repeated reads (simulating refresh)', async () => {
    const res1 = await clientAlice.request('GET', `/api/media/${friendsId}/seasons`);
    const res2 = await clientAlice.request('GET', `/api/media/${friendsId}/seasons`);
    assert.strictEqual(res1.body.totalWatchedCount, res2.body.totalWatchedCount);
    assert.strictEqual(res1.body.seasons[0].watchedCount, res2.body.seasons[0].watchedCount);
  });

  // Bob adds the same show
  const bobShowRes = await clientBob.request('POST', '/api/media', {
    title: 'Friends',
    type: 'tv',
    external_id: 'mock_friends_view',
    status: 'watching',
    current_season: 1,
    current_episode: 0
  });
  const bobShowId = bobShowRes.body.id;

  await asyncCheck('Bob view of Friends has 0 watched episodes (No leakage from Alice)', async () => {
    const res = await clientBob.request('GET', `/api/media/${bobShowId}/seasons`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.totalWatchedCount, 0);
    assert.strictEqual(res.body.seasons[0].status, 'Not started');
    assert.strictEqual(res.body.seasons[1].status, 'Not started');
  });

  await asyncCheck('Bob cannot toggle Alice episode (404 Not Found)', async () => {
    const res = await clientBob.request('POST', `/api/media/${friendsId}/episodes/toggle`, {
      season: 1,
      episode: 5
    });
    assert.strictEqual(res.status, 404);
  });

  await asyncCheck('Bob cannot bulk-mark Alice season (404 Not Found)', async () => {
    const res = await clientBob.request('POST', `/api/media/${friendsId}/seasons/1/mark-watched`);
    assert.strictEqual(res.status, 404);
  });

  await asyncCheck('Bob cannot batch-unmark Alice episodes (404 Not Found)', async () => {
    const res = await clientBob.request('POST', `/api/media/${friendsId}/episodes/batch-unmark`, {
      episodes: [{ season: 1, episode: 1 }]
    });
    assert.strictEqual(res.status, 404);
  });

  await asyncCheck('Alice watched data remains completely unchanged after Bob attempts', async () => {
    const res = await clientAlice.request('GET', `/api/media/${friendsId}/seasons`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.seasons[0].watchedCount, 24);
  });

  // Clean up server
  server.close();

  console.log('\n====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL SEASON & EPISODE VIEW TESTS PASSED!');
  } else {
    console.error('❌ SOME CHECKS FAILED!');
    process.exit(1);
  }
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  if (server) server.close();
  process.exit(1);
});
