import http from 'node:http';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_discover_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

// Ensure TMDB_API_KEY is not set initially to test unconfigured state
delete process.env.TMDB_API_KEY;
delete process.env.TMDB_READ_TOKEN;

const { default: app } = await import('../server.js');
const {
  getAllMedia
} = await import('../db.js');
const {
  isTmdbConfigured,
  setMockDiscoverData,
  setMockDiscoverError,
  clearMockDiscoverData,
  getDiscoverTvShows,
  addDiscoverShowToLibrary
} = await import('../discover-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Discover Page & TMDB Integration Test Suite');
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
  console.log(`Server running on port ${port} for Discover tests.\n`);

  const clientAlice = new TestClient();
  const clientBob = new TestClient();

  const ts = Date.now();
  const regAlice = await clientAlice.register(`alice_discover_${ts}`, 'AlicePass123456789!');
  assert.strictEqual(regAlice.status, 201);
  const alice = regAlice.body.user;

  const regBob = await clientBob.register(`bob_discover_${ts}`, 'BobDiscoverPass12345!');
  assert.strictEqual(regBob.status, 201);
  const bob = regBob.body.user;

  console.log('--- 1. Unconfigured State (No Fake Sample Data as Live) ---');
  await asyncCheck('Returns configured: false when TMDB_API_KEY is not set', async () => {
    delete process.env.TMDB_API_KEY;
    delete process.env.TMDB_READ_TOKEN;
    clearMockDiscoverData();
    const res = await clientAlice.request('GET', '/api/discover/tv');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.configured, false);
    assert.ok(res.body.message.includes('TMDB_API_KEY'));
    assert.strictEqual(res.body.categories.popular.length, 0, 'Must not present sample data as live when unconfigured');
  });

  console.log('\n--- 2. Configured Categories & Poster Rows ---');
  process.env.TMDB_API_KEY = 'mock_tmdb_key_for_test';
  // Inject mock discovery data for all 4 required categories
  const mockPopular = [
    { id: 101, name: 'Severance', first_air_date: '2022-02-18', vote_average: 8.4, vote_count: 1420, poster_path: '/severance.jpg', overview: 'Mark leads a team of office workers.' },
    { id: 102, name: 'The Last of Us', first_air_date: '2023-01-15', vote_average: 8.6, vote_count: 4200, poster_path: '/tlou.jpg', overview: 'Joel and Ellie journey through post-pandemic US.' }
  ];
  const mockTrending = [
    { id: 201, name: 'House of the Dragon', first_air_date: '2022-08-21', vote_average: 8.4, vote_count: 3800, poster_path: '/hotd.jpg', overview: 'The Targaryen civil war.' },
    { id: 101, name: 'Severance', first_air_date: '2022-02-18', vote_average: 8.4, vote_count: 1420, poster_path: '/severance.jpg', overview: 'Mark leads a team of office workers.' }
  ];
  const mockAiring = [
    { id: 301, name: 'Slow Horses', first_air_date: '2022-04-01', vote_average: 8.1, vote_count: 980, poster_path: '/slowhorses.jpg', overview: 'A dysfunctional team of MI5 agents.' }
  ];
  const mockUpcoming = [
    { id: 401, name: 'Neuromancer', first_air_date: '2026-11-01', vote_average: null, vote_count: 0, poster_path: null, overview: 'Upcoming cyberpunk adaptation.' }
  ];

  setMockDiscoverData('popular', mockPopular);
  setMockDiscoverData('trending', mockTrending);
  setMockDiscoverData('airing', mockAiring);
  setMockDiscoverData('upcoming', mockUpcoming);

  let firstFetchTimestamp = null;

  await asyncCheck('Loads all 4 categories with poster, rating, and metadata', async () => {
    const res = await clientAlice.request('GET', '/api/discover/tv');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.configured, true);
    assert.ok(res.body.lastUpdated);
    firstFetchTimestamp = res.body.lastUpdated;

    const cats = res.body.categories;
    assert.strictEqual(cats.popular.length, 2);
    assert.strictEqual(cats.trending.length, 2);
    assert.strictEqual(cats.airing.length, 1);
    assert.strictEqual(cats.upcoming.length, 1);

    // Check normalization on Popular item
    const sev = cats.popular.find(s => s.id === 101);
    assert.ok(sev);
    assert.strictEqual(sev.title, 'Severance');
    assert.strictEqual(sev.release_year, 2022);
    assert.strictEqual(sev.rating, 8.4);
    assert.strictEqual(sev.poster_url, 'https://image.tmdb.org/t/p/w342/severance.jpg');
    assert.strictEqual(sev.inLibrary, false, 'Should initially not be in user library');

    // Check poster fallback for show without poster
    const neuro = cats.upcoming.find(s => s.id === 401);
    assert.ok(neuro);
    assert.strictEqual(neuro.poster_url, null);

    // Check TMDB Attribution
    assert.ok(res.body.attribution);
    assert.ok(res.body.attribution.notice.includes('TMDB'));
  });

  console.log('\n--- 3. Server-side Caching ---');
  await asyncCheck('Subsequent calls hit cache and preserve lastUpdated timestamp', async () => {
    const res = await clientAlice.request('GET', '/api/discover/tv');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.lastUpdated, firstFetchTimestamp, 'Cache timestamp must be preserved');
    assert.strictEqual(res.body.isOutdated, false);
  });

  console.log('\n--- 4. Provider Refresh Failure & Stale Cache Retention ---');
  await asyncCheck('If refresh fails, existing cache is retained and marked as potentially outdated', async () => {
    // Simulate upstream provider failure on refresh
    setMockDiscoverError('503 Service Unavailable: TMDB outage');

    // Request with refresh=1 (forced refresh)
    const res = await clientAlice.request('GET', '/api/discover/tv?refresh=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.configured, true);
    assert.strictEqual(res.body.isOutdated, true, 'Cached data must be marked as potentially outdated upon refresh failure');
    assert.strictEqual(res.body.categories.popular.length, 2, 'Existing cached items must be retained');

    // Reset error
    setMockDiscoverError(null);
  });

  console.log('\n--- 5. Add to Library & Duplicate Prevention ---');
  // Re-inject mock data
  setMockDiscoverData('popular', mockPopular);
  setMockDiscoverData('trending', mockTrending);
  setMockDiscoverData('airing', mockAiring);
  setMockDiscoverData('upcoming', mockUpcoming);

  let addedShowRecord = null;

  await asyncCheck('Alice adds Severance from Discover into library', async () => {
    const res = await clientAlice.request('POST', '/api/discover/add-to-library', {
      show: {
        id: 101,
        title: 'Severance',
        poster_url: 'https://image.tmdb.org/t/p/w342/severance.jpg',
        release_year: 2022,
        rating: 8.4,
        overview: 'Mark leads a team of office workers.'
      }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.alreadyInLibrary, false);
    assert.strictEqual(res.body.inLibrary, true);
    assert.ok(res.body.item);
    assert.strictEqual(res.body.item.title, 'Severance');
    assert.strictEqual(res.body.item.status, 'plan_to_watch');
    addedShowRecord = res.body.item;
  });

  await asyncCheck('Alice discovery list now displays inLibrary: true for Severance across rows', async () => {
    const res = await clientAlice.request('GET', '/api/discover/tv');
    assert.strictEqual(res.status, 200);

    const popularSev = res.body.categories.popular.find(s => s.id === 101);
    assert.strictEqual(popularSev.inLibrary, true, 'Must indicate in library on Popular row');

    const trendingSev = res.body.categories.trending.find(s => s.id === 101);
    assert.strictEqual(trendingSev.inLibrary, true, 'Must indicate in library on Trending row');

    const tlou = res.body.categories.popular.find(s => s.id === 102);
    assert.strictEqual(tlou.inLibrary, false, 'Unadded show must remain inLibrary: false');
  });

  await asyncCheck('Attempting to add Severance again returns duplicate status without creating double record', async () => {
    const beforeCount = getAllMedia(alice.id).filter(m => m.title === 'Severance').length;
    assert.strictEqual(beforeCount, 1);

    const res = await clientAlice.request('POST', '/api/discover/add-to-library', {
      show: {
        id: 101,
        title: 'Severance'
      }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.alreadyInLibrary, true);
    assert.strictEqual(res.body.inLibrary, true);

    const afterCount = getAllMedia(alice.id).filter(m => m.title === 'Severance').length;
    assert.strictEqual(afterCount, 1, 'Must not duplicate record in database');
  });

  console.log('\n--- 6. User Isolation (Alice vs Bob) ---');
  await asyncCheck("Severance is in Alice's library, but NOT in Bob's library", async () => {
    const res = await clientBob.request('GET', '/api/discover/tv');
    assert.strictEqual(res.status, 200);

    const bobPopularSev = res.body.categories.popular.find(s => s.id === 101);
    assert.strictEqual(bobPopularSev.inLibrary, false, "Bob must see inLibrary: false for shows Alice added");
  });

  await asyncCheck("Bob can add Severance independently to his own library", async () => {
    const res = await clientBob.request('POST', '/api/discover/add-to-library', {
      show: {
        id: 101,
        title: 'Severance'
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.alreadyInLibrary, false);
    assert.strictEqual(res.body.inLibrary, true);

    // Verify Bob has his own copy
    const bobShows = getAllMedia(bob.id).filter(m => m.title === 'Severance');
    assert.strictEqual(bobShows.length, 1);
    assert.notStrictEqual(bobShows[0].id, addedShowRecord.id, 'IDs must be distinct per user');
  });

  console.log('\n--- 7. Authentication & Input Validation ---');
  await asyncCheck('Unauthenticated GET /api/discover/tv returns 401', async () => {
    const unauthClient = new TestClient();
    const res = await unauthClient.request('GET', '/api/discover/tv');
    assert.strictEqual(res.status, 401);
  });

  await asyncCheck('Unauthenticated POST /api/discover/add-to-library returns 401', async () => {
    const unauthClient = new TestClient();
    await unauthClient.initCsrf();
    const res = await unauthClient.request('POST', '/api/discover/add-to-library', {
      show: { title: 'Test' }
    });
    assert.strictEqual(res.status, 401);
  });

  await asyncCheck('POST /api/discover/add-to-library requires show title (400)', async () => {
    const res = await clientAlice.request('POST', '/api/discover/add-to-library', {
      show: {}
    });
    assert.strictEqual(res.status, 400);
  });

  // Cleanup
  clearMockDiscoverData();
  server.close();

  console.log('\n====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL DISCOVER & TMDB TESTS PASSED!');
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
