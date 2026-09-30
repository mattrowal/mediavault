import http from 'node:http';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_stats_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  createUser,
  addMedia,
  updateMedia,
  addBook,
  updateBook,
  getWatchedEpisodes,
  logActivity,
  getUserActivities
} = await import('../db.js');
const {
  formatMinutesToHours,
  formatMinutesToDaysAndHours,
  getPersonalStatistics
} = await import('../stats-service.js');
const {
  setMockEpisodeData,
  clearMockEpisodeData
} = await import('../episode-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Personal Statistics Test Suite');
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
let baseUrl = '';

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
      const url = new URL(pathname, baseUrl);
      const headers = { ...customHeaders, 'Accept': 'application/json' };

      const cookieStr = this._formatCookieHeader();
      if (cookieStr) headers['Cookie'] = cookieStr;

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
      if (payload) req.write(payload);
      req.end();
    });
  }

  async initCsrf() {
    await this.request('GET', '/api/auth/csrf');
  }

  async register(username, password) {
    await this.initCsrf();
    return this.request('POST', '/api/auth/register', { username, password });
  }

  async login(username, password) {
    await this.initCsrf();
    return this.request('POST', '/api/auth/login', { username, password });
  }
}

async function runTests() {
  server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Server started on port ${port} for test execution.\n`);

  // Setup test mock episode data for TV shows
  // Show 101: 2 seasons, season 1 = 10 eps (45m each), season 2 = 10 eps (45m each)
  const show101Episodes = [
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 1000 + i + 1,
      name: `Episode S1E${i + 1}`,
      season: 1,
      number: i + 1,
      runtime: 45,
      type: 'regular',
      airstamp: '2026-01-10T20:00:00Z'
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 2000 + i + 1,
      name: `Episode S2E${i + 1}`,
      season: 2,
      number: i + 1,
      runtime: 45,
      type: 'regular',
      airstamp: '2026-05-10T20:00:00Z'
    }))
  ];
  setMockEpisodeData('101', show101Episodes, { name: 'Sci-Fi Odyssey', status: 'Running' });

  // Show 102: show with missing episode runtime on some episodes (3 episodes total)
  const show102Episodes = [
    { id: 3001, name: 'Part 1', season: 1, number: 1, runtime: 60, type: 'regular', airstamp: '2026-02-01T20:00:00Z' },
    { id: 3002, name: 'Part 2', season: 1, number: 2, runtime: null, type: 'regular', airstamp: '2026-02-08T20:00:00Z' },
    { id: 3003, name: 'Part 3', season: 1, number: 3, runtime: 60, type: 'regular', airstamp: '2026-02-15T20:00:00Z' }
  ];
  setMockEpisodeData('102', show102Episodes, { name: 'Indie Miniseries', status: 'Ended' });

  // Create Users via register
  const clientAlice = new TestClient();
  const clientBob = new TestClient();

  const regAlice = await clientAlice.register('alice_stats', 'AliceStatsPassword123!');
  assert.strictEqual(regAlice.status, 201, 'Alice registration must succeed');
  const alice = regAlice.body.user;

  const regBob = await clientBob.register('bob_stats', 'BobStatsPassword123!');
  assert.strictEqual(regBob.status, 201, 'Bob registration must succeed');
  const bob = regBob.body.user;

  console.log('--- 1. Time Formatting Helpers ---');
  check('formatMinutesToHours formats 0 correctly', () => {
    assert.strictEqual(formatMinutesToHours(0), '0 hrs');
  });
  check('formatMinutesToHours formats round hours correctly', () => {
    assert.strictEqual(formatMinutesToHours(120), '2 hrs');
  });
  check('formatMinutesToHours formats hours and minutes correctly', () => {
    assert.strictEqual(formatMinutesToHours(145), '2 hrs 25 mins');
  });
  check('formatMinutesToDaysAndHours formats days and hours', () => {
    // 2 days = 2880 mins + 3 hrs = 180 mins -> 3060 mins
    assert.strictEqual(formatMinutesToDaysAndHours(3060), '2 days, 3 hrs');
  });
  check('formatMinutesToDaysAndHours formats single day correctly', () => {
    assert.strictEqual(formatMinutesToDaysAndHours(1440), '1 day, 0 hrs');
  });

  console.log('\n--- 2. Book Page Validation Endpoints ---');
  let testBookId = null;

  await asyncCheck('Rejects negative total pages on book creation (400)', async () => {
    const res = await clientAlice.request('POST', '/api/books', {
      title: 'Bad Book',
      page_count: -10,
      current_page: 0
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('non-negative'));
  });

  await asyncCheck('Rejects decimal current_page on book creation (400)', async () => {
    const res = await clientAlice.request('POST', '/api/books', {
      title: 'Bad Book',
      page_count: 200,
      current_page: 45.5
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('whole integer'));
  });

  await asyncCheck('Rejects current_page exceeding page_count on book creation (400)', async () => {
    const res = await clientAlice.request('POST', '/api/books', {
      title: 'Exceeding Book',
      page_count: 200,
      current_page: 250
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('cannot exceed'));
  });

  await asyncCheck('Creates valid in-progress book with pages', async () => {
    const res = await clientAlice.request('POST', '/api/books', {
      title: 'Dune',
      author: 'Frank Herbert',
      page_count: 500,
      current_page: 150,
      format: 'Paperback',
      owned: 1,
      status: 'reading'
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.current_page, 150);
    assert.strictEqual(res.body.page_count, 500);
    testBookId = res.body.id;
  });

  await asyncCheck('Progress endpoint rejects negative page', async () => {
    const res = await clientAlice.request('POST', `/api/books/${testBookId}/progress`, {
      current_page: -20
    });
    assert.strictEqual(res.status, 400);
  });

  await asyncCheck('Progress endpoint rejects decimal page', async () => {
    const res = await clientAlice.request('POST', `/api/books/${testBookId}/progress`, {
      current_page: 155.8
    });
    assert.strictEqual(res.status, 400);
  });

  await asyncCheck('Progress endpoint rejects page exceeding total pages', async () => {
    const res = await clientAlice.request('POST', `/api/books/${testBookId}/progress`, {
      current_page: 550
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('cannot exceed total pages'));
  });

  await asyncCheck('Progress endpoint successfully updates valid page and logs reading delta', async () => {
    // Current is 150, update to 200 -> delta of 50 pages read
    const res = await clientAlice.request('POST', `/api/books/${testBookId}/progress`, {
      current_page: 200
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_page, 200);

    const acts = getUserActivities(alice.id, { activityType: 'reading_progress' });
    assert.ok(acts.length >= 1);
    assert.strictEqual(acts[0].pages_read, 50);
    assert.strictEqual(acts[0].is_correction, 0);
  });

  await asyncCheck('Progress correction does not log active reading session delta', async () => {
    const beforeCount = getUserActivities(alice.id, { activityType: 'reading_progress', excludeCorrections: true }).length;
    // User corrects a typo from 200 to 195 (marked as is_correction: 1)
    const res = await clientAlice.request('POST', `/api/books/${testBookId}/progress`, {
      current_page: 195,
      is_correction: 1
    });
    assert.strictEqual(res.status, 200);
    const afterCount = getUserActivities(alice.id, { activityType: 'reading_progress', excludeCorrections: true }).length;
    assert.strictEqual(afterCount, beforeCount, 'Corrections must not create false reading sessions in active charts');
  });

  console.log('\n--- 3. Personal Statistics Calculations ---');
  // Add Alice items:
  // Movie 1: Watched, runtime = 150 mins
  const movie1 = addMedia({
    type: 'movie',
    title: 'Inception',
    status: 'completed',
    runtime: 150
  }, alice.id);

  // Movie 2: Watched, runtime = NULL (missing runtime)
  const movie2 = addMedia({
    type: 'movie',
    title: 'Mystery Old Film',
    status: 'completed',
    runtime: null
  }, alice.id);

  // Movie 3: Plan to watch (not completed) -> runtime 120 mins (should NOT be counted)
  const movie3 = addMedia({
    type: 'movie',
    title: 'Upcoming Film',
    status: 'plan_to_watch',
    runtime: 120
  }, alice.id);

  // Book 2: Completed, 350 pages
  const book2 = addBook({
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    page_count: 350,
    current_page: 350,
    status: 'completed',
    owned: 1
  }, alice.id);

  // Book 3: Completed, page_count = 0 (unknown page count)
  const book3 = addBook({
    title: 'Rare Ancient Manuscript',
    author: 'Unknown',
    page_count: 0,
    current_page: 0,
    status: 'completed',
    owned: 0
  }, alice.id);

  // TV Show 1: Sci-Fi Odyssey (Show 101)
  // Alice watches 5 episodes out of Season 1 (45m each -> 225m)
  const tvShow1 = addMedia({
    type: 'tv',
    title: 'Sci-Fi Odyssey',
    external_id: '101',
    status: 'watching'
  }, alice.id);

  // Mark 5 episodes of Season 1 watched
  for (let ep = 1; ep <= 5; ep++) {
    await clientAlice.request('POST', `/api/media/${tvShow1.id}/episodes/toggle`, { season: 1, episode: ep });
  }

  // TV Show 2: Indie Miniseries (Show 102)
  // Alice watches Episode 1 (60 mins) and Episode 2 (null runtime -> missing runtime)
  const tvShow2 = addMedia({
    type: 'tv',
    title: 'Indie Miniseries',
    external_id: '102',
    status: 'watching'
  }, alice.id);
  await clientAlice.request('POST', `/api/media/${tvShow2.id}/episodes/toggle`, { season: 1, episode: 1 });
  await clientAlice.request('POST', `/api/media/${tvShow2.id}/episodes/toggle`, { season: 1, episode: 2 });

  await asyncCheck('Alice statistics via GET /api/stats/personal', async () => {
    const res = await clientAlice.request('GET', '/api/stats/personal?period=all_time');
    assert.strictEqual(res.status, 200);
    const data = res.body;

    // Check Movies:
    // Completed movies = 2 (Inception, Mystery Old Film). Plan to watch is excluded.
    assert.strictEqual(data.summary.moviesWatched, 2, 'Must count exactly completed movies');

    // Check Episodes:
    // 5 eps from Show 1 + 2 eps from Show 2 = 7 watched episodes
    assert.strictEqual(data.summary.episodesWatched, 7, 'Must count individual watched episodes');

    // Check Seasons Completed:
    // Show 1 has 5/10 watched in S1 -> season NOT completed.
    // S2 is 0/10 -> not completed.
    assert.strictEqual(data.summary.seasonsCompleted, 0, 'Partially watched season must not be counted as completed');

    // Check Books Completed:
    // Book 2 (Project Hail Mary) and Book 3 (Rare Manuscript) = 2 books completed.
    // Book 1 (Dune) is reading -> unfinished.
    assert.strictEqual(data.summary.booksCompleted, 2);
    assert.strictEqual(data.summary.unfinishedBooksInProgress, 1);

    // Check Pages Read:
    // Completed Book 2: 350 pages.
    // Completed Book 3: page_count 0 -> excluded from total pages!
    // Unfinished Book 1 (Dune): current_page 195 pages.
    // Total pages = 350 + 195 = 545 pages.
    assert.strictEqual(data.summary.totalPagesRead, 545, 'Total pages must combine finished books and current progress of unfinished books');
    assert.strictEqual(data.summary.unfinishedPagesRead, 195);

    // Check Missing Metadata:
    // Missing movie runtime = 1 (Mystery Old Film)
    assert.strictEqual(data.missingMetadata.missingMovieRuntimes, 1);
    // Missing episode runtime = 1 (Indie Miniseries Ep 2)
    assert.strictEqual(data.missingMetadata.missingEpisodeRuntimes, 1);
    assert.strictEqual(data.missingMetadata.missingTotalRuntimes, 2);
    // Missing book page count = 1 (Rare Ancient Manuscript)
    assert.strictEqual(data.missingMetadata.missingBookPageCounts, 1);
    assert.strictEqual(data.missingMetadata.hasMissingRuntimes, true);
    assert.strictEqual(data.missingMetadata.hasMissingPages, true);

    // Check Viewing Time:
    // Movie minutes = 150 mins (Inception only, since Mystery Old Film has null runtime).
    // TV minutes = (5 * 45) + (1 * 60) = 225 + 60 = 285 mins (Ep 2 has null runtime).
    // Total minutes = 150 + 285 = 435 mins = 7 hrs 15 mins.
    assert.strictEqual(data.viewingTime.movies.minutes, 150);
    assert.strictEqual(data.viewingTime.tv.minutes, 285);
    assert.strictEqual(data.viewingTime.totalMinutes, 435);
    assert.strictEqual(data.viewingTime.formattedHours, '7 hrs 15 mins');
    assert.strictEqual(data.viewingTime.formattedDaysAndHours, '0 days, 7 hrs');
    assert.strictEqual(data.viewingTime.label, 'Estimated viewing time');

    // Never count entire series just because some episodes were watched!
    assert.notStrictEqual(data.viewingTime.tv.minutes, (20 * 45) + 60);

    // Note disclaimers
    assert.ok(data.notes.repeatTracking.includes('Repeat viewing and rereading are not tracked yet'));
  });

  console.log('\n--- 4. Season Completion Calculation ---');
  await asyncCheck('Completing all episodes in a season marks 1 season completed', async () => {
    // Complete the remaining 5 episodes of Season 1 in Show 101 (eps 6 to 10)
    for (let ep = 6; ep <= 10; ep++) {
      await clientAlice.request('POST', `/api/media/${tvShow1.id}/episodes/toggle`, { season: 1, episode: ep });
    }

    const res = await clientAlice.request('GET', '/api/stats/personal?period=all_time');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.summary.seasonsCompleted, 1, 'Season 1 should now be completed');
    // Episodes watched = 10 from Show 1 + 2 from Show 2 = 12
    assert.strictEqual(res.body.summary.episodesWatched, 12);
    // TV minutes = (10 * 45) + 60 = 510 mins
    assert.strictEqual(res.body.viewingTime.tv.minutes, 510);
  });

  console.log('\n--- 5. Duplicate Actions and Idempotency ---');
  await asyncCheck('Toggling an already watched episode off and on keeps totals consistent', async () => {
    const beforeStats = (await clientAlice.request('GET', '/api/stats/personal?period=all_time')).body;

    // Toggle episode 10 off
    await clientAlice.request('POST', `/api/media/${tvShow1.id}/episodes/toggle`, { season: 1, episode: 10 });
    const offStats = (await clientAlice.request('GET', '/api/stats/personal?period=all_time')).body;
    assert.strictEqual(offStats.summary.episodesWatched, beforeStats.summary.episodesWatched - 1);
    assert.strictEqual(offStats.summary.seasonsCompleted, 0); // Not completed anymore!

    // Toggle episode 10 back on
    await clientAlice.request('POST', `/api/media/${tvShow1.id}/episodes/toggle`, { season: 1, episode: 10 });
    const onStats = (await clientAlice.request('GET', '/api/stats/personal?period=all_time')).body;
    assert.strictEqual(onStats.summary.episodesWatched, beforeStats.summary.episodesWatched);
    assert.strictEqual(onStats.summary.seasonsCompleted, 1);
  });

  console.log('\n--- 6. Historical Records Without Dates ---');
  await asyncCheck('Historical episodes without timestamp are preserved in all-time but noted for monthly charts', async () => {
    // Insert an episode record with watched_at = NULL (simulating old imported record)
    db.prepare(`
      INSERT INTO watched_episodes (media_id, user_id, season, episode, watched_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(tvShow1.id, alice.id, 2, 1);

    const res = await clientAlice.request('GET', '/api/stats/personal?period=all_time');
    assert.strictEqual(res.status, 200);
    // Now has 13 episodes watched
    assert.strictEqual(res.body.summary.episodesWatched, 13);
    assert.ok(res.body.notes.historicalData.includes('historical episode(s) without recorded dates'));
    assert.ok(res.body.notes.historicalData.includes('All-Time totals'));

    // Test period filter "this_month"
    const monthRes = await clientAlice.request('GET', '/api/stats/personal?period=this_month');
    assert.strictEqual(monthRes.status, 200);
    assert.ok(monthRes.body.notes.historicalData.includes('cannot be included in This Month'));
  });

  console.log('\n--- 7. Account Isolation (Alice vs Bob) ---');
  await asyncCheck('Bob starts with completely empty statistics', async () => {
    const res = await clientBob.request('GET', '/api/stats/personal?period=all_time');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.summary.moviesWatched, 0);
    assert.strictEqual(res.body.summary.episodesWatched, 0);
    assert.strictEqual(res.body.summary.seasonsCompleted, 0);
    assert.strictEqual(res.body.summary.booksCompleted, 0);
    assert.strictEqual(res.body.summary.totalPagesRead, 0);
    assert.strictEqual(res.body.viewingTime.totalMinutes, 0);
  });

  await asyncCheck('Bob adding a movie does not affect Alice stats', async () => {
    addMedia({
      type: 'movie',
      title: 'Interstellar',
      status: 'completed',
      runtime: 169
    }, bob.id);

    const bobStats = (await clientBob.request('GET', '/api/stats/personal?period=all_time')).body;
    assert.strictEqual(bobStats.summary.moviesWatched, 1);
    assert.strictEqual(bobStats.viewingTime.movies.minutes, 169);

    const aliceStats = (await clientAlice.request('GET', '/api/stats/personal?period=all_time')).body;
    assert.strictEqual(aliceStats.summary.moviesWatched, 2, "Alice's movie count must remain unchanged");
    assert.strictEqual(aliceStats.viewingTime.movies.minutes, 150, "Alice's viewing time must remain unchanged");
  });

  await asyncCheck('Bob cannot update Alice book progress (404 Not Found)', async () => {
    const res = await clientBob.request('POST', `/api/books/${testBookId}/progress`, {
      current_page: 300
    });
    assert.strictEqual(res.status, 404);
  });

  await asyncCheck('Unauthenticated request to /api/stats/personal returns 401', async () => {
    const anonClient = new TestClient();
    const res = await anonClient.request('GET', '/api/stats/personal');
    assert.strictEqual(res.status, 401);
  });

  // Cleanup
  clearMockEpisodeData();
  server.close();

  console.log('\n====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL PERSONAL STATISTICS TESTS PASSED!');
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
