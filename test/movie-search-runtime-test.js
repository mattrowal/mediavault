import http from 'node:http';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_movie_runtime_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  addMedia,
  updateMedia,
  getMediaById,
  getAllMedia,
  getUserActivities
} = await import('../db.js');

const {
  searchMovies,
  getMovieDetails,
  setMockMovieSearch,
  setMockMovieDetails,
  setMockMovieError,
  clearMockMovieData,
  isMovieConfigured
} = await import('../movie-service.js');

const { getPersonalStatistics } = await import('../stats-service.js');

// Delete TMDB keys after import (since movie-service runs dotenv.config())
const LIVE_TMDB_KEY = process.env.TMDB_API_KEY;
delete process.env.TMDB_API_KEY;
delete process.env.TMDB_READ_TOKEN;

console.log('====================================================');
console.log('🧪 MediaVault Movie Search & Automatic Runtime Test Suite');
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
  console.log(`Server running on port ${port} for Movie Runtime tests.\n`);

  const clientAlice = new TestClient();
  const clientBob = new TestClient();

  const ts = Date.now();
  const regAlice = await clientAlice.register(`alice_movies_${ts}`, 'AliceSecurePassword123!');
  assert.strictEqual(regAlice.status, 201);
  const alice = regAlice.body.user;

  const regBob = await clientBob.register(`bob_movies_${ts}`, 'BobSecurePassword123!');
  assert.strictEqual(regBob.status, 201);
  const bob = regBob.body.user;

  console.log('--- PART 1: MOCKED INTEGRATION & LOGIC TESTS ---');

  // 1. Mock search queries with variations and fallbacks
  await asyncCheck('Movie search supports "Spider-Man", "Spider Man" and "Spiderman" with distinguishable results', async () => {
    clearMockMovieData();

    // Setup mock movie data with distinguishable years and posters
    const spiderManMovies = [
      {
        id: 557,
        title: 'Spider-Man',
        release_date: '2002-05-01',
        poster_path: '/spider2002.jpg',
        overview: 'Peter Parker bitten by spider.',
        vote_average: 7.3
      },
      {
        id: 315635,
        title: 'Spider-Man: Homecoming',
        release_date: '2017-07-05',
        poster_path: '/spider2017.jpg',
        overview: 'Peter Parker balancing high school and heroics.',
        vote_average: 7.4
      }
    ];

    setMockMovieSearch('spider-man', {
      results: spiderManMovies,
      page: 1,
      total_pages: 1,
      total_results: 2
    });

    // Test API route with authenticated user
    const res = await clientAlice.request('GET', '/api/search/movies?q=Spider-Man');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 2);
    assert.strictEqual(res.body.results[0].title, 'Spider-Man');
    assert.strictEqual(res.body.results[0].release_year, '2002');
    assert.ok(res.body.results[0].poster.includes('/spider2002.jpg'));
    assert.strictEqual(res.body.results[1].title, 'Spider-Man: Homecoming');
    assert.strictEqual(res.body.results[1].release_year, '2017');
  });

  await asyncCheck('Fallback search handles queries like "Spiderman" when primary has no results', async () => {
    clearMockMovieData();

    // "spiderman" has 0 results directly, but fallback "spider-man" has results
    setMockMovieSearch('spider-man', {
      results: [{ id: 557, title: 'Spider-Man', release_date: '2002-05-01', poster_path: '/spider2002.jpg' }],
      page: 1,
      total_pages: 1,
      total_results: 1
    });

    const searchRes = await clientAlice.request('GET', '/api/search/movies?q=Spiderman');
    assert.strictEqual(searchRes.status, 200);
    assert.strictEqual(searchRes.body.results.length, 1);
    assert.strictEqual(searchRes.body.results[0].title, 'Spider-Man');
    assert.strictEqual(searchRes.body.results[0].release_year, '2002');
  });

  await asyncCheck('Search handles pagination, empty results, and missing query gracefully', async () => {
    clearMockMovieData();
    setMockMovieSearch('marvel', {
      results: [{ id: 101, title: 'Marvel Film 1' }],
      page: 2,
      total_pages: 5,
      total_results: 10
    });

    const resPage2 = await clientAlice.request('GET', '/api/search/movies?q=marvel&page=2');
    assert.strictEqual(resPage2.status, 200);
    assert.strictEqual(resPage2.body.page, 2);
    assert.strictEqual(resPage2.body.total_pages, 5);
    assert.strictEqual(resPage2.body.total_results, 10);

    const resEmpty = await clientAlice.request('GET', '/api/search/movies?q=   ');
    assert.strictEqual(resEmpty.status, 200);
    assert.strictEqual(resEmpty.body.results.length, 0);
  });

  // 2. Adding a movie and automatic runtime retrieval
  await asyncCheck('Adding a movie via TMDB ID retrieves official details and runtime in minutes', async () => {
    clearMockMovieData();
    setMockMovieDetails(557, {
      id: 557,
      title: 'Spider-Man',
      runtime: 121,
      release_date: '2002-05-01',
      poster_path: '/spidey_poster.jpg',
      genre: 'Action, Sci-Fi'
    });

    const res = await clientAlice.request('POST', '/api/media', {
      type: 'movie',
      title: 'Spider-Man',
      external_id: '557',
      status: 'completed'
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.external_id, '557');
    assert.strictEqual(res.body.runtime, 121);
    assert.strictEqual(res.body.release_year, '2002');
    assert.strictEqual(res.body.genre, 'Action, Sci-Fi');
  });

  await asyncCheck('Missing or zero runtime is treated as unknown (null), never inventing a duration', async () => {
    clearMockMovieData();
    setMockMovieDetails(888, {
      id: 888,
      title: 'Upcoming Film Without Runtime',
      runtime: 0,
      release_date: '2027-01-01'
    });

    const res = await clientAlice.request('POST', '/api/media', {
      type: 'movie',
      title: 'Upcoming Film Without Runtime',
      external_id: '888',
      status: 'plan_to_watch'
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.runtime, null);
  });

  // 3. Duplicate Prevention & User Isolation
  await asyncCheck('Duplicate addition of same TMDB movie to same user library returns 409 Conflict', async () => {
    // Alice already added 557 above
    const res = await clientAlice.request('POST', '/api/media', {
      type: 'movie',
      title: 'Spider-Man (Duplicate Attempt)',
      external_id: '557',
      status: 'completed'
    });

    assert.strictEqual(res.status, 409);
    assert.ok(res.body.error.includes('already in your library'));
  });

  await asyncCheck('Different user (Bob) CAN add same TMDB movie without collision', async () => {
    setMockMovieDetails(557, {
      id: 557,
      title: 'Spider-Man',
      runtime: 121,
      release_date: '2002-05-01'
    });

    const res = await clientBob.request('POST', '/api/media', {
      type: 'movie',
      title: 'Spider-Man',
      external_id: '557',
      status: 'completed'
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.user_id, bob.id);
    assert.strictEqual(res.body.external_id, '557');
  });

  // 4. Refreshing existing movies & linking unlinked movies
  let unlinkedWatchedMovie;
  await asyncCheck('Add existing watched movie without TMDB ID and missing runtime', async () => {
    unlinkedWatchedMovie = addMedia({
      type: 'movie',
      title: 'Iron Man',
      status: 'completed',
      runtime: null,
      notes: 'Great movie from 2008'
    }, alice.id);

    // Initial statistics check: missing movie runtime must be counted
    const statsBefore = await getPersonalStatistics(alice.id, 'all_time');
    assert.strictEqual(statsBefore.missingMetadata.missingMovieRuntimes, 1);
    const initialMovieMinutes = statsBefore.viewingTime.movies.minutes;

    // Log the initial activity timestamp count
    const actsBefore = getUserActivities(alice.id);
    const actCountBefore = actsBefore.length;

    // Link this unlinked movie to TMDB ID 1726 (Iron Man)
    setMockMovieDetails(1726, {
      id: 1726,
      title: 'Iron Man',
      runtime: 126,
      release_date: '2008-04-30',
      genre: 'Action, Adventure, Sci-Fi'
    });

    const linkRes = await clientAlice.request('POST', `/api/media/${unlinkedWatchedMovie.id}/refresh-movie`, {
      tmdb_id: '1726'
    });

    assert.strictEqual(linkRes.status, 200);
    assert.strictEqual(linkRes.body.movie.external_id, '1726');
    assert.strictEqual(linkRes.body.movie.runtime, 126);
    assert.strictEqual(linkRes.body.movie.status, 'completed');
    assert.strictEqual(linkRes.body.movie.notes, 'Great movie from 2008');

    // Linking existing watched movie updates viewing time without adding a viewing event
    const actsAfter = getUserActivities(alice.id);
    assert.strictEqual(actsAfter.length, actCountBefore, 'Linking metadata MUST NOT create a new activity log entry');

    // Statistics recalculation
    const statsAfter = await getPersonalStatistics(alice.id, 'all_time');
    assert.strictEqual(statsAfter.missingMetadata.missingMovieRuntimes, 0, 'Missing runtime count must be 0 after linking');
    assert.strictEqual(statsAfter.viewingTime.movies.minutes, initialMovieMinutes + 126, 'Viewing time must include the 126m');
  });

  await asyncCheck('Repeated refreshes do not duplicate records or viewing time', async () => {
    const statsBefore = await getPersonalStatistics(alice.id, 'all_time');
    const actsBefore = getUserActivities(alice.id).length;

    const refreshRes = await clientAlice.request('POST', `/api/media/${unlinkedWatchedMovie.id}/refresh-movie`, {});

    assert.strictEqual(refreshRes.status, 200);

    const statsAfter = await getPersonalStatistics(alice.id, 'all_time');
    const actsAfter = getUserActivities(alice.id).length;

    assert.strictEqual(actsAfter, actsBefore, 'Activity log count must not change on refresh');
    assert.strictEqual(statsAfter.viewingTime.movies.minutes, statsBefore.viewingTime.movies.minutes, 'Viewing time must not duplicate');
    assert.strictEqual(statsAfter.summary.totalMovieCompletions, statsBefore.summary.totalMovieCompletions, 'Completions count must not duplicate');
  });

  // 5. Manual correction preservation
  await asyncCheck('Manual runtime correction survives future metadata refreshes', async () => {
    // Alice manually corrects the runtime of Iron Man to 135 minutes (extended edition)
    const editRes = await clientAlice.request('PUT', `/api/media/${unlinkedWatchedMovie.id}`, {
      runtime: 135
    });

    assert.strictEqual(editRes.status, 200);
    assert.strictEqual(editRes.body.runtime, 135);
    assert.strictEqual(editRes.body.is_runtime_manual, 1);

    // Refresh movie details from TMDB (where TMDB reports 126)
    const refreshRes = await clientAlice.request('POST', `/api/media/${unlinkedWatchedMovie.id}/refresh-movie`, {});

    assert.strictEqual(refreshRes.status, 200);
    assert.strictEqual(refreshRes.body.manual_runtime_preserved, true);
    assert.strictEqual(refreshRes.body.movie.runtime, 135, 'Manual correction of 135 mins must be preserved');
  });

  // 6. User Isolation on Refresh
  await asyncCheck('Bob cannot refresh or edit Alice movies (returns 404)', async () => {
    const res = await clientBob.request('POST', `/api/media/${unlinkedWatchedMovie.id}/refresh-movie`, {});
    assert.strictEqual(res.status, 404);
  });

  // 7. Error Handling & Messaging
  await asyncCheck('API failures and missing metadata return useful error messages', async () => {
    clearMockMovieData();
    setMockMovieError('TMDB service is temporarily unavailable');

    const errRes = await clientAlice.request('GET', '/api/search/movies?q=Avatar');
    assert.strictEqual(errRes.status, 500);
    assert.ok(errRes.body.error.includes('TMDB service is temporarily unavailable'));

    clearMockMovieData();
  });

  console.log('\n--- PART 2: LIVE TMDB API CHECKS ---');
  if (LIVE_TMDB_KEY) {
    process.env.TMDB_API_KEY = LIVE_TMDB_KEY;
    clearMockMovieData();

    await asyncCheck('LIVE API: "Spider-Man" searches return real distinguishable results with years', async () => {
      const res = await clientAlice.request('GET', '/api/search/movies?q=Spider-Man');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.results.length > 0, 'Should find live Spider-Man results');
      const years = res.body.results.map(r => r.release_year);
      assert.ok(years.includes('2002') || years.includes('2017') || years.includes('2021'), 'Should distinguish different movie years');
      assert.ok(res.body.results[0].poster.startsWith('https://image.tmdb.org/'), 'Should have valid poster URL');
    });

    await asyncCheck('LIVE API: "Spiderman" query returns live results via TMDB normalization', async () => {
      const res = await clientAlice.request('GET', '/api/search/movies?q=Spiderman');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.results.length > 0, 'Spiderman query must return movies');
    });

    await asyncCheck('LIVE API: Fetch details for Spider-Man (ID 557) retrieves 121m runtime', async () => {
      const details = await getMovieDetails(557);
      assert.strictEqual(details.title, 'Spider-Man');
      assert.strictEqual(details.runtime, 121);
      assert.strictEqual(details.release_year, '2002');
    });
  } else {
    console.log('  ⚠️ Skipping live TMDB API checks: TMDB_API_KEY is not configured in environment.');
  }

  server.close();

  console.log('\n====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL MOVIE SEARCH & RUNTIME METADATA TESTS PASSED!');
  } else {
    console.error('❌ SOME CHECKS FAILED!');
    process.exit(1);
  }
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('Unhandled test suite failure:', err);
  if (server) server.close();
  process.exit(1);
});
