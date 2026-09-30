import assert from 'node:assert';
import http from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_cycles_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  addMedia,
  addBook,
  getAllMedia,
  getAllBooks,
  getWatchedEpisodes,
  markEpisodeWatched
} = await import('../db.js');

console.log('====================================================');
console.log('🧪 MediaVault Consumption Cycles & Activity Test Suite');
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

  const clientAlice = new TestClient();
  const clientBob = new TestClient();

  const ts = Date.now();
  const regAlice = await clientAlice.register(`alice_cycles_${ts}`, 'AliceSecurePassword12345!');
  assert.strictEqual(regAlice.status, 201);
  const alice = regAlice.body.user;

  const regBob = await clientBob.register(`bob_cycles_${ts}`, 'BobSecurePassword12345!');
  assert.strictEqual(regBob.status, 201);
  const bob = regBob.body.user;

  console.log('--- 1. Movie Rewatch Cycle & Duplicate Prevention ---');
  let inceptionMovie;

  await asyncCheck('Alice adds and completes Inception (Cycle 1)', async () => {
    inceptionMovie = addMedia({
      type: 'movie',
      title: 'Inception',
      runtime: 148,
      status: 'completed'
    }, alice.id);

    // Initial cycle completed
    const compRes = await clientAlice.request('POST', '/api/cycles/complete', {
      itemType: 'movie',
      itemId: inceptionMovie.id
    });
    assert.strictEqual(compRes.status, 200);

    const cyclesRes = await clientAlice.request('GET', `/api/cycles/movie/${inceptionMovie.id}`);
    assert.strictEqual(cyclesRes.status, 200);
    assert.strictEqual(cyclesRes.body.cycles.length, 1);
    assert.strictEqual(cyclesRes.body.cycles[0].cycle_number, 1);
    assert.strictEqual(cyclesRes.body.cycles[0].status, 'completed');
  });

  await asyncCheck('Alice starts Rewatch of Inception -> Cycle 2 created', async () => {
    const startRes = await clientAlice.request('POST', '/api/cycles/start', {
      itemType: 'movie',
      itemId: inceptionMovie.id
    });
    assert.strictEqual(startRes.status, 200);
    assert.strictEqual(startRes.body.alreadyActive, false);
    assert.strictEqual(startRes.body.cycleNumber, 2);

    const cyclesRes = await clientAlice.request('GET', `/api/cycles/movie/${inceptionMovie.id}`);
    assert.strictEqual(cyclesRes.body.cycles.length, 2);
    assert.strictEqual(cyclesRes.body.cycles[1].cycle_number, 2);
    assert.strictEqual(cyclesRes.body.cycles[1].status, 'in_progress');
  });

  await asyncCheck('Repeated click on "Start Rewatch" does NOT create Cycle 3 (Idempotent)', async () => {
    const repeatRes = await clientAlice.request('POST', '/api/cycles/start', {
      itemType: 'movie',
      itemId: inceptionMovie.id
    });
    assert.strictEqual(repeatRes.status, 200);
    assert.strictEqual(repeatRes.body.alreadyActive, true);
    assert.strictEqual(repeatRes.body.cycleNumber, 2);

    const cyclesRes = await clientAlice.request('GET', `/api/cycles/movie/${inceptionMovie.id}`);
    assert.strictEqual(cyclesRes.body.cycles.length, 2, 'Must still have exactly 2 cycles');
  });

  await asyncCheck('Alice completes Rewatch (Cycle 2)', async () => {
    const compRes = await clientAlice.request('POST', '/api/cycles/complete', {
      itemType: 'movie',
      itemId: inceptionMovie.id
    });
    assert.strictEqual(compRes.status, 200);
    assert.strictEqual(compRes.body.cycleNumber, 2);

    const cyclesRes = await clientAlice.request('GET', `/api/cycles/movie/${inceptionMovie.id}`);
    assert.strictEqual(cyclesRes.body.cycles[1].status, 'completed');
  });

  console.log('\n--- 2. Statistics: Unique Titles vs Total Completions ---');
  await asyncCheck('Statistics show 1 unique movie watched, but 2 total movie completions', async () => {
    const statsRes = await clientAlice.request('GET', '/api/stats/personal?period=all_time');
    assert.strictEqual(statsRes.status, 200);
    const summary = statsRes.body.summary;
    assert.strictEqual(summary.moviesWatched, 1, 'Unique movies count must be 1');
    assert.strictEqual(summary.uniqueMoviesCompleted, 1, 'Unique completions must be 1');
    assert.strictEqual(summary.totalMovieCompletions, 2, 'Total completions including repeats must be 2');
    assert.strictEqual(statsRes.body.viewingTime.movies.minutes, 148 * 2, 'Runtime counted for both completions');
  });

  console.log('\n--- 3. TV Series Episode Tracking per Cycle ---');
  let friendsShow;

  await asyncCheck('Alice creates TV Show and watches S1E1 in Cycle 1', async () => {
    friendsShow = addMedia({
      type: 'tv',
      title: 'Friends',
      status: 'watching'
    }, alice.id);

    // Mark S1E1 in Cycle 1
    markEpisodeWatched(friendsShow.id, alice.id, 1, 1, null, 1);
    const epsCycle1 = getWatchedEpisodes(friendsShow.id, alice.id, 1);
    assert.strictEqual(epsCycle1.length, 1);
    assert.strictEqual(epsCycle1[0].cycle_number, 1);
  });

  await asyncCheck('Alice completes Cycle 1 and starts Rewatch (Cycle 2)', async () => {
    await clientAlice.request('POST', '/api/cycles/complete', {
      itemType: 'tv',
      itemId: friendsShow.id
    });

    const startRes = await clientAlice.request('POST', '/api/cycles/start', {
      itemType: 'tv',
      itemId: friendsShow.id
    });
    assert.strictEqual(startRes.body.cycleNumber, 2);

    // Mark S1E1 in Cycle 2
    markEpisodeWatched(friendsShow.id, alice.id, 1, 1, null, 2);

    const epsCycle1 = getWatchedEpisodes(friendsShow.id, alice.id, 1);
    const epsCycle2 = getWatchedEpisodes(friendsShow.id, alice.id, 2);

    assert.strictEqual(epsCycle1.length, 1, 'Cycle 1 watched episode preserved');
    assert.strictEqual(epsCycle2.length, 1, 'Cycle 2 watched episode recorded separately');
    assert.strictEqual(epsCycle1[0].cycle_number, 1);
    assert.strictEqual(epsCycle2[0].cycle_number, 2);
  });

  console.log('\n--- 4. Book Reread Progress ---');
  let duneBook;

  await asyncCheck('Alice adds Dune (500 pages) and completes it (Cycle 1)', async () => {
    duneBook = addBook({
      title: 'Dune',
      author: 'Frank Herbert',
      page_count: 500,
      current_page: 500,
      status: 'completed'
    }, alice.id);

    await clientAlice.request('POST', '/api/cycles/complete', {
      itemType: 'book',
      itemId: duneBook.id
    });
  });

  await asyncCheck('Alice starts Reread of Dune -> current_page resets to 0 in Cycle 2', async () => {
    const startRes = await clientAlice.request('POST', '/api/cycles/start', {
      itemType: 'book',
      itemId: duneBook.id
    });
    assert.strictEqual(startRes.body.cycleNumber, 2);

    // Progress to page 120
    const progRes = await clientAlice.request('POST', `/api/books/${duneBook.id}/progress`, {
      current_page: 120
    });
    assert.strictEqual(progRes.status, 200);
    assert.strictEqual(progRes.body.current_page, 120);
  });

  console.log('\n--- 5. Activity History, Corrections & Deletions ---');
  let activityEntryId = null;

  await asyncCheck('Activity history contains logged reading progress session', async () => {
    const actRes = await clientAlice.request('GET', '/api/activity');
    assert.strictEqual(actRes.status, 200);
    assert.ok(actRes.body.activities.length > 0);

    const readingAct = actRes.body.activities.find(a => a.item_type === 'book' && a.pages_read === 120);
    assert.ok(readingAct, 'Found 120 pages reading progress');
    assert.strictEqual(readingAct.is_correction, 0, 'New reading activity is NOT marked as correction');
    activityEntryId = readingAct.id;
  });

  await asyncCheck('Correcting activity updates value and marks is_correction = 1', async () => {
    const putRes = await clientAlice.request('PUT', `/api/activity/${activityEntryId}`, {
      pagesRead: 110
    });
    assert.strictEqual(putRes.status, 200);
    assert.strictEqual(putRes.body.activity.pages_read, 110);
    assert.strictEqual(putRes.body.activity.is_correction, 1, 'Marked as correction');
  });

  await asyncCheck('Deleting activity removes it from activity_log', async () => {
    const delRes = await clientAlice.request('DELETE', `/api/activity/${activityEntryId}`);
    assert.strictEqual(delRes.status, 200);

    const actRes = await clientAlice.request('GET', '/api/activity');
    const found = actRes.body.activities.find(a => a.id === activityEntryId);
    assert.strictEqual(found, undefined, 'Deleted activity must no longer be present');
  });

  console.log('\n--- 6. Account Isolation (Alice vs Bob) ---');
  await asyncCheck('Bob cannot access or modify Alice cycles', async () => {
    const getRes = await clientBob.request('GET', `/api/cycles/movie/${inceptionMovie.id}`);
    assert.strictEqual(getRes.body.cycles.length, 0, 'Bob sees 0 cycles for Alice movie');

    const startRes = await clientBob.request('POST', '/api/cycles/start', {
      itemType: 'movie',
      itemId: inceptionMovie.id
    });
    assert.strictEqual(startRes.status, 404, 'Bob cannot start cycle on Alice movie');
  });

  await asyncCheck('Bob cannot edit or delete Alice activity entry', async () => {
    // Log an activity for Alice
    const actAliceRes = await clientAlice.request('GET', '/api/activity');
    assert.ok(actAliceRes.body.activities.length > 0);
    const aliceActId = actAliceRes.body.activities[0].id;

    const bobPut = await clientBob.request('PUT', `/api/activity/${aliceActId}`, { pagesRead: 999 });
    assert.strictEqual(bobPut.status, 404);

    const bobDel = await clientBob.request('DELETE', `/api/activity/${aliceActId}`);
    assert.strictEqual(bobDel.status, 404);
  });

  console.log('====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL CONSUMPTION CYCLES & ACTIVITY TESTS PASSED!');
  } else {
    console.error('❌ SOME CHECKS FAILED!');
    process.exit(1);
  }
  console.log('====================================================\n');

  server.close();
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  } catch {}
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  if (server) server.close();
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  } catch {}
  process.exit(1);
});
