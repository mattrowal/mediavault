import http from 'node:http';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_prog_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  createUser,
  addMedia,
  getMediaById,
  updateMedia,
  createSession
} = await import('../db.js');
const {
  setMockEpisodeData,
  clearMockEpisodeData,
  filterRegularEpisodes,
  isEpisodeReleased,
  sortEpisodesChronologically,
  processEpisodesList,
  validateEpisodeProgress,
  calculateNextEpisode
} = await import('../episode-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Episode Progression & Validation Suite');
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
// TEST FIXTURES: Friends TVMaze Episode Fixtures (Simulated Real Data)
// -----------------------------------------------------------
// Season 1: 24 episodes (1 to 24)
// Season 2: 24 episodes (1 to 24)
// Specials: Outtakes / documentary with type 'special' or 'insignificant_special'
// Unreleased: Simulated future episode
function createFriendsFixture() {
  const episodes = [];
  const pastAirstamp = '2000-01-01T00:00:00+00:00';

  // S1: 24 regular episodes
  for (let ep = 1; ep <= 24; ep++) {
    episodes.push({
      id: 100 + ep,
      season: 1,
      number: ep,
      name: `S1 Episode ${ep}`,
      type: 'regular',
      airstamp: pastAirstamp,
      airdate: '1994-09-22'
    });
  }

  // Interspersed specials (must be completely excluded from normal progression)
  episodes.push({
    id: 9991,
    season: 1,
    number: null,
    name: "Friends Special Behind The Scenes",
    type: 'insignificant_special',
    airstamp: pastAirstamp,
    airdate: '1995-05-01'
  });
  episodes.push({
    id: 9992,
    season: 2,
    number: 99,
    name: "Special Reunion",
    type: 'special',
    airstamp: pastAirstamp,
    airdate: '1995-09-01'
  });

  // S2: 24 regular episodes
  for (let ep = 1; ep <= 24; ep++) {
    episodes.push({
      id: 200 + ep,
      season: 2,
      number: ep,
      name: `S2 Episode ${ep}`,
      type: 'regular',
      airstamp: pastAirstamp,
      airdate: '1995-09-21'
    });
  }

  return episodes;
}

// Ongoing show fixture with released and unreleased episodes
function createOngoingShowFixture() {
  const pastAirstamp = '2023-01-01T00:00:00+00:00';
  const futureAirstamp = '2099-01-01T00:00:00+00:00';

  return [
    { id: 1, season: 1, number: 1, name: 'Pilot', type: 'regular', airstamp: pastAirstamp, airdate: '2023-01-01' },
    { id: 2, season: 1, number: 2, name: 'Second', type: 'regular', airstamp: pastAirstamp, airdate: '2023-01-08' },
    { id: 3, season: 1, number: 3, name: 'Finale', type: 'regular', airstamp: pastAirstamp, airdate: '2023-01-15' },
    // S2E1 is not released yet (future airstamp)
    { id: 4, season: 2, number: 1, name: 'Future Season Premiere', type: 'regular', airstamp: futureAirstamp, airdate: '2099-01-01' }
  ];
}

async function runAllTests() {
  // Start ephemeral HTTP server on random free port
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  BASE_URL = `http://127.0.0.1:${port}`;

  const clientAlice = new TestClient();
  const clientBob = new TestClient();

  const timestamp = Date.now();
  const regAlice = await clientAlice.register(`alice_${timestamp}`, 'AliceSecurePassword123!');
  const aliceId = regAlice.body.user.id;
  const regBob = await clientBob.register(`bob_${timestamp}`, 'BobSecurePassword123!');
  const bobId = regBob.body.user.id;

  // =========================================================================
  // 1️⃣ UNIT TESTS: Specials Exclusion & Canonical Sorting
  // =========================================================================
  console.log('1️⃣ Unit Tests: Data Sanitization, Specials & Sorting');

  check('filterRegularEpisodes excludes specials with non-regular types', () => {
    const raw = [
      { season: 1, number: 1, type: 'regular' },
      { season: 1, number: null, type: 'insignificant_special' },
      { season: 1, number: 99, type: 'special' },
      { season: 1, number: 2, type: 'REGULAR' }
    ];
    const filtered = filterRegularEpisodes(raw);
    assert.strictEqual(filtered.length, 2);
    assert.strictEqual(filtered[0].number, 1);
    assert.strictEqual(filtered[1].number, 2);
  });

  check('sortEpisodesChronologically correctly orders seasons and numbers', () => {
    const unordered = [
      { season: 2, number: 1 },
      { season: 1, number: 24 },
      { season: 1, number: 1 },
      { season: 1, number: 10 }
    ];
    const sorted = sortEpisodesChronologically(unordered);
    assert.strictEqual(sorted[0].season, 1);
    assert.strictEqual(sorted[0].number, 1);
    assert.strictEqual(sorted[1].number, 10);
    assert.strictEqual(sorted[2].number, 24);
    assert.strictEqual(sorted[3].season, 2);
    assert.strictEqual(sorted[3].number, 1);
  });

  // =========================================================================
  // 2️⃣ SCENARIO 1: Normal Episode Progression (S1E23 -> S1E24)
  // =========================================================================
  console.log('\n2️⃣ Scenario 1: Normal Episode Progression');

  setMockEpisodeData('mock_friends_431', createFriendsFixture(), { status: 'Ended' });

  // Alice adds Friends currently at S1E23
  const addRes = await clientAlice.request('POST', '/api/media', {
    title: 'Friends',
    type: 'tv',
    external_id: 'mock_friends_431',
    status: 'watching',
    current_season: 1,
    current_episode: 23
  });
  assert.strictEqual(addRes.status, 201);
  const friendsShowId = addRes.body.id;

  await asyncCheck('Initial state for Friends: currently at S1E23', async () => {
    const res = await clientAlice.request('GET', `/api/media/${friendsShowId}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 1);
    assert.strictEqual(res.body.current_episode, 23);
    assert.strictEqual(res.body.next_episode.season, 1);
    assert.strictEqual(res.body.next_episode.episode, 24);
    assert.strictEqual(res.body.is_caught_up, false);
    assert.strictEqual(res.body.is_progress_invalid, false);
  });

  await asyncCheck('Clicking +1 Episode Watched at S1E23 marks S1E24 as watched', async () => {
    const res = await clientAlice.request('POST', `/api/media/${friendsShowId}/increment-episode`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 1);
    assert.strictEqual(res.body.current_episode, 24);
  });

  await asyncCheck('Progress reflects S1E24 without automatically marking S2E1', async () => {
    const res = await clientAlice.request('GET', `/api/media/${friendsShowId}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 1, 'Displayed season is 1');
    assert.strictEqual(res.body.current_episode, 24, 'Displayed episode is 24');
    // Button label targets S2E1 as the next released episode
    assert.strictEqual(res.body.next_episode.season, 2);
    assert.strictEqual(res.body.next_episode.episode, 1);
    assert.strictEqual(res.body.is_caught_up, false);
  });

  // =========================================================================
  // 3️⃣ SCENARIO 2: Moving from Season Finale to Next Season (S1E24 -> S2E1)
  // =========================================================================
  console.log('\n3️⃣ Scenario 2: Moving from Season Finale to Next Season');

  await asyncCheck('Next click marks S2E1 as watched', async () => {
    const res = await clientAlice.request('POST', `/api/media/${friendsShowId}/increment-episode`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 2);
    assert.strictEqual(res.body.current_episode, 1);
    assert.strictEqual(res.body.next_episode.season, 2);
    assert.strictEqual(res.body.next_episode.episode, 2);
  });

  // =========================================================================
  // 4️⃣ SCENARIO 3: Reaching the Latest Released Episode & Unreleased Future
  // =========================================================================
  console.log('\n4️⃣ Scenario 3: Reaching the Latest Released Episode');

  setMockEpisodeData('mock_ongoing_99', createOngoingShowFixture(), { status: 'Running' });

  const ongoingRes = await clientAlice.request('POST', '/api/media', {
    title: 'Ongoing Sci-Fi',
    type: 'tv',
    external_id: 'mock_ongoing_99',
    status: 'watching',
    current_season: 1,
    current_episode: 2
  });
  assert.strictEqual(ongoingRes.status, 201);
  const ongoingShowId = ongoingRes.body.id;

  await asyncCheck('Advancing from S1E2 to S1E3 (Season 1 finale)', async () => {
    const res = await clientAlice.request('POST', `/api/media/${ongoingShowId}/increment-episode`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 1);
    assert.strictEqual(res.body.current_episode, 3);
  });

  await asyncCheck('At S1E3, S2E1 is unreleased -> marked as caught up', async () => {
    const res = await clientAlice.request('GET', `/api/media/${ongoingShowId}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.is_caught_up, true);
    assert.strictEqual(res.body.next_episode, null);
  });

  await asyncCheck('Attempting to increment when caught up returns 400 error', async () => {
    const res = await clientAlice.request('POST', `/api/media/${ongoingShowId}/increment-episode`);

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('caught up'), 'Returns caught up error message');
  });

  // =========================================================================
  // 5️⃣ SCENARIO 4: Missing Episode Data
  // =========================================================================
  console.log('\n5️⃣ Scenario 4: Missing Episode Data');

  const customRes = await clientAlice.request('POST', '/api/media', {
    title: 'Custom Local Show Without External ID',
    type: 'tv',
    external_id: null,
    status: 'watching',
    current_season: 1,
    current_episode: 5
  });
  assert.strictEqual(customRes.status, 201);
  const customShowId = customRes.body.id;

  await asyncCheck('Show with missing external_id reports episode_data_unavailable', async () => {
    const res = await clientAlice.request('GET', `/api/media/${customShowId}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.episode_data_unavailable, true);
    assert.strictEqual(res.body.next_episode, null);
  });

  await asyncCheck('Incrementing show with missing episode data returns 400 without guessing', async () => {
    const res = await clientAlice.request('POST', `/api/media/${customShowId}/increment-episode`);

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('unavailable'), 'Refuses to guess without real episode list');
  });

  // =========================================================================
  // 6️⃣ SCENARIO 5: Existing Invalid Progress & Invalid Manual Edits
  // =========================================================================
  console.log('\n6️⃣ Scenario 5: Existing Invalid Progress & Manual Edits');

  // Insert show directly with existing corrupted/invalid progress S1E44 (simulating legacy data)
  const legacyInvalidShow = addMedia({
    title: 'Friends (Invalid Legacy S1E44)',
    type: 'tv',
    external_id: 'mock_friends_431',
    status: 'watching',
    current_season: 1,
    current_episode: 44
  }, aliceId);

  await asyncCheck('Existing S1E44 is detected as is_progress_invalid without silent reset or deletion', async () => {
    const res = await clientAlice.request('GET', `/api/media/${legacyInvalidShow.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 1);
    assert.strictEqual(res.body.current_episode, 44, 'Preserved existing S1E44 without silent conversion');
    assert.strictEqual(res.body.is_progress_invalid, true);
    assert.ok(res.body.invalid_progress_reason.includes('Season 1 has 24 episodes. Enter an episode between 0 and 24.'));
  });

  await asyncCheck('Attempting +1 on existing invalid progress returns 400 asking user to Edit', async () => {
    const res = await clientAlice.request('POST', `/api/media/${legacyInvalidShow.id}/increment-episode`);

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('invalid for this series'));
    assert.ok(res.body.error.includes('via Edit'));
  });

  await asyncCheck('Manual Edit rejecting invalid S1E44 with 400 Bad Request', async () => {
    const res = await clientAlice.request('PUT', `/api/media/${friendsShowId}`, {
      title: 'Friends',
      current_season: 1,
      current_episode: 44
    });

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Season 1 has 24 episodes. Enter an episode between 0 and 24.'));
  });

  await asyncCheck('Manual Edit rejecting unreleased future episode with 400 Bad Request', async () => {
    const res = await clientAlice.request('PUT', `/api/media/${ongoingShowId}`, {
      title: 'Ongoing Sci-Fi',
      current_season: 2,
      current_episode: 1
    });

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('has not been released yet'));
  });

  await asyncCheck('Manual Edit accepting valid released episode S1E24', async () => {
    const res = await clientAlice.request('PUT', `/api/media/${legacyInvalidShow.id}`, {
      title: 'Friends (Fixed)',
      current_season: 1,
      current_episode: 24
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_season, 1);
    assert.strictEqual(res.body.current_episode, 24);
    assert.strictEqual(res.body.is_progress_invalid, false);
    assert.strictEqual(res.body.next_episode.season, 2);
    assert.strictEqual(res.body.next_episode.episode, 1);
  });

  // =========================================================================
  // 7️⃣ USER ISOLATION & DASHBOARD ENRICHMENT
  // =========================================================================
  console.log('\n7️⃣ User Isolation & Dashboard Stats Enrichment');

  await asyncCheck('Bob cannot increment or modify Alice show (404 Not Found)', async () => {
    const res = await clientBob.request('POST', `/api/media/${friendsShowId}/increment-episode`);
    assert.strictEqual(res.status, 404);
  });

  await asyncCheck('GET /api/stats enriches dashboard series with progression metadata', async () => {
    const res = await clientAlice.request('GET', '/api/stats');

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.series.withNewEpisodes));
    const show = res.body.series.withNewEpisodes.find(s => s.id === friendsShowId);
    if (show) {
      assert.ok('next_episode' in show);
      assert.ok('is_caught_up' in show);
      assert.ok('is_progress_invalid' in show);
    }
  });
  // =========================================================================
  // 8️⃣ REAL/CACHED TVMAZE DATA: Friends (Show ID 431)
  // =========================================================================
  console.log('\n8️⃣ Real/Cached TVMaze Data: Friends (Show ID 431)');

  await asyncCheck('Real TVMaze data for Friends matches exact progression rules', async () => {
    const { getSeriesEpisodeInfo: getInfo } = await import('../episode-service.js');
    const friendsInfo = await getInfo('431');
    assert.strictEqual(friendsInfo.available, true, 'Friends 431 episode info is available');
    assert.strictEqual(friendsInfo.seasonEpisodeNumbers.get(1)?.size, 24, 'Season 1 has 24 episodes');
    assert.strictEqual(friendsInfo.seasonEpisodeNumbers.get(2)?.size, 24, 'Season 2 has 24 episodes');

    const nextFrom23 = calculateNextEpisode(friendsInfo, 1, 23);
    assert.strictEqual(nextFrom23.next?.season, 1);
    assert.strictEqual(nextFrom23.next?.episode, 24);

    const nextFrom24 = calculateNextEpisode(friendsInfo, 1, 24);
    assert.strictEqual(nextFrom24.next?.season, 2);
    assert.strictEqual(nextFrom24.next?.episode, 1);

    const invalidCheck = calculateNextEpisode(friendsInfo, 1, 44);
    assert.strictEqual(invalidCheck.isInvalid, true);
    assert.ok(invalidCheck.reason.includes('Season 1 has 24 episodes. Enter an episode between 0 and 24.'));
  });

  // Clean up mock data and close server
  clearMockEpisodeData();
  server.close();

  console.log('\n====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL EPISODE PROGRESSION TESTS PASSED!');
  } else {
    console.error('❌ SOME CHECKS FAILED!');
    process.exit(1);
  }
  console.log('====================================================\n');
}

runAllTests().catch(err => {
  console.error('Fatal test error:', err);
  if (server) server.close();
  process.exit(1);
});
