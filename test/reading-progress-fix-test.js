import http from 'node:http';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_reading_fix_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  addBook,
  getUserActivities
} = await import('../db.js');
const { getPersonalStatistics } = await import('../stats-service.js');
const { calculateGoalProgress } = await import('../goals-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Reading Progress & Goals Fix Test Suite');
console.log('====================================================\n');

let totalChecks = 0;
let passedChecks = 0;

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
}

async function runTests() {
  server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const clientAlice = new TestClient();
  const clientBob = new TestClient();

  const ts = Date.now();
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  const regAlice = await clientAlice.register(`alice_read_${ts}`, 'StrongAlicePassword123!');
  assert.strictEqual(regAlice.status, 201);
  const alice = regAlice.body.user;

  const regBob = await clientBob.register(`bob_read_${ts}`, 'StrongBobPassword123!');
  assert.strictEqual(regBob.status, 201);
  const bob = regBob.body.user;

  console.log('--- 1. Initial Goals Setup (Alice) ---');
  let booksGoal, pagesGoal;

  await asyncCheck('Alice creates books_yearly goal with target 2', async () => {
    const res = await clientAlice.request('POST', '/api/goals', {
      goalType: 'books_yearly',
      target: 2,
      year: currentYear,
      includeRepeats: 1
    });
    assert.strictEqual(res.status, 201);
    booksGoal = res.body;
    assert.strictEqual(booksGoal.currentProgress, 0);
  });

  await asyncCheck('Alice creates pages_monthly goal with target 500', async () => {
    const res = await clientAlice.request('POST', '/api/goals', {
      goalType: 'pages_monthly',
      target: 500,
      year: currentYear,
      month: currentMonth
    });
    assert.strictEqual(res.status, 201);
    pagesGoal = res.body;
    assert.strictEqual(pagesGoal.currentProgress, 0);
  });

  console.log('\n--- 2. Book Reading Progress Tracking (100-page book) ---');
  let book1;
  await asyncCheck('Alice adds a 100-page book with current_page: 20 and owned: 1', async () => {
    const res = await clientAlice.request('POST', '/api/books', {
      title: 'The Martian',
      author: 'Andy Weir',
      page_count: 100,
      current_page: 20,
      owned: 1,
      status: 'reading'
    });
    assert.strictEqual(res.status, 201);
    book1 = res.body;
    assert.strictEqual(book1.current_page, 20);
    assert.strictEqual(book1.owned, 1);
    assert.strictEqual(book1.status, 'reading');
  });

  await asyncCheck('A 100-page book updated from page 20 to 30 adds 10 pages of reading activity', async () => {
    const res = await clientAlice.request('POST', `/api/books/${book1.id}/progress`, {
      current_page: 30
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_page, 30);

    const acts = getUserActivities(alice.id, { activityType: 'reading_progress' });
    assert.strictEqual(acts.length, 1);
    assert.strictEqual(acts[0].pages_read, 10);
    assert.strictEqual(acts[0].is_correction, 0);

    // Monthly pages goal should show 10 pages
    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const pg = goalsRes.body.goals.find(g => g.id === pagesGoal.id);
    assert.strictEqual(pg.currentProgress, 10);

    // Personal statistics should report 30 total pages read
    const stats = await getPersonalStatistics(alice.id, 'all_time');
    assert.strictEqual(stats.summary.totalPagesRead, 30);
    assert.strictEqual(stats.summary.unfinishedPagesRead, 30);
    assert.strictEqual(stats.summary.booksCompleted, 0);
  });

  await asyncCheck('Repeating that save (page 30) does not change totals', async () => {
    const res = await clientAlice.request('POST', `/api/books/${book1.id}/progress`, {
      current_page: 30
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.current_page, 30);

    // Activity log must still have only 1 reading_progress entry (no 0-page spam)
    const acts = getUserActivities(alice.id, { activityType: 'reading_progress' });
    assert.strictEqual(acts.length, 1);

    // Monthly pages goal remains unchanged (10)
    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const pg = goalsRes.body.goals.find(g => g.id === pagesGoal.id);
    assert.strictEqual(pg.currentProgress, 10);
  });

  console.log('\n--- 3. Book Completion & Goal Progression ---');
  await asyncCheck('Completing the book adds remaining 70 pages and one completion', async () => {
    // Current page is 30, total pages is 100 -> remaining pages to read is 70
    const res = await clientAlice.request('POST', `/api/books/${book1.id}/complete`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'completed');
    assert.strictEqual(res.body.current_page, 100);
    // Ownership remains separate and untouched
    assert.strictEqual(res.body.owned, 1);

    // Verify activity logged for completion with exactly 70 pages
    const compActs = getUserActivities(alice.id, { activityType: 'book_completed' });
    assert.strictEqual(compActs.length, 1);
    assert.strictEqual(compActs[0].pages_read, 70);
    assert.strictEqual(compActs[0].is_correction, 0);

    // Monthly pages goal increments by 70: 10 + 70 = 80 pages
    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const pg = goalsRes.body.goals.find(g => g.id === pagesGoal.id);
    assert.strictEqual(pg.currentProgress, 80);

    // Books yearly goal changes from 0/2 to 1/2
    const bg = goalsRes.body.goals.find(g => g.id === booksGoal.id);
    assert.strictEqual(bg.currentProgress, 1);
    assert.strictEqual(bg.percentage, 50);
    assert.strictEqual(bg.progressText, '1 of 2 books completed this year.');

    // Dashboard stats verify Books Read = 1
    const dashRes = await clientAlice.request('GET', '/api/stats');
    assert.strictEqual(dashRes.body.books.completed, 1);
    assert.strictEqual(dashRes.body.books.owned, 1);
    assert.strictEqual(dashRes.body.books.ownedUnread, 0);

    // Personal statistics verify 1 book completed and 100 pages read
    const stats = await getPersonalStatistics(alice.id, 'all_time');
    assert.strictEqual(stats.summary.booksCompleted, 1);
    assert.strictEqual(stats.summary.totalPagesRead, 100);
    assert.strictEqual(stats.summary.unfinishedPagesRead, 0);
  });

  await asyncCheck('Repeating completion does not increase the goal again (idempotent)', async () => {
    const res = await clientAlice.request('POST', `/api/books/${book1.id}/complete`);
    assert.strictEqual(res.status, 200);

    // Goals must remain 1/2 and 80/500
    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const bg = goalsRes.body.goals.find(g => g.id === booksGoal.id);
    assert.strictEqual(bg.currentProgress, 1, 'Book goal remains 1 of 2');

    const pg = goalsRes.body.goals.find(g => g.id === pagesGoal.id);
    assert.strictEqual(pg.currentProgress, 80, 'Pages goal remains 80');

    // No duplicate completion activities
    const compActs = getUserActivities(alice.id, { activityType: 'book_completed' });
    assert.strictEqual(compActs.length, 1);
  });

  console.log('\n--- 4. Progress Corrections & Rereading Rules ---');
  let book2;
  await asyncCheck('Corrections do not create fake reading activity or duplicate completions', async () => {
    const resAdd = await clientAlice.request('POST', '/api/books', {
      title: 'Dune',
      author: 'Frank Herbert',
      page_count: 500,
      current_page: 50,
      owned: 1,
      status: 'reading'
    });
    book2 = resAdd.body;

    // Alice corrects a typo from 50 to 40 with is_correction: 1
    const resCorr = await clientAlice.request('POST', `/api/books/${book2.id}/progress`, {
      current_page: 40,
      is_correction: 1
    });
    assert.strictEqual(resCorr.status, 200);
    assert.strictEqual(resCorr.body.current_page, 40);

    // Monthly pages goal must not change
    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const pg = goalsRes.body.goals.find(g => g.id === pagesGoal.id);
    assert.strictEqual(pg.currentProgress, 80);
  });

  await asyncCheck('Starting a reread preserves Cycle 1 and does not count old cycle again', async () => {
    const resStart = await clientAlice.request('POST', '/api/cycles/start', {
      itemType: 'book',
      itemId: book1.id
    });
    assert.strictEqual(resStart.status, 200);
    assert.strictEqual(resStart.body.cycleNumber, 2);

    // Book in DB resets current_page to 0, status reading
    const b1After = await clientAlice.request('GET', `/api/books/${book1.id}`);
    assert.strictEqual(b1After.body.current_page, 0);
    assert.strictEqual(b1After.body.status, 'reading');

    // Goals progress remains 1 of 2 (Cycle 1 preserved, Cycle 2 in progress)
    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const bg = goalsRes.body.goals.find(g => g.id === booksGoal.id);
    assert.strictEqual(bg.currentProgress, 1);

    // Alice reads 40 pages in Cycle 2
    const resProg = await clientAlice.request('POST', `/api/books/${book1.id}/progress`, {
      current_page: 40
    });
    assert.strictEqual(resProg.status, 200);

    // Pages goal increases by 40: 80 + 40 = 120
    const goalsRes2 = await clientAlice.request('GET', '/api/goals');
    const pg = goalsRes2.body.goals.find(g => g.id === pagesGoal.id);
    assert.strictEqual(pg.currentProgress, 120);

    // Completing Cycle 2 completes the goal (2 of 2 books with includeRepeats = 1)
    const resComp2 = await clientAlice.request('POST', `/api/books/${book1.id}/complete`);
    assert.strictEqual(resComp2.status, 200);

    const goalsRes3 = await clientAlice.request('GET', '/api/goals');
    const bgFinal = goalsRes3.body.goals.find(g => g.id === booksGoal.id);
    assert.strictEqual(bgFinal.currentProgress, 2, 'Goal reaches 2 of 2 after reread completion');
    assert.strictEqual(bgFinal.percentage, 100);
  });

  console.log('\n--- 5. Unknown Page Count & Validation Rules ---');
  let bookUnknown;
  await asyncCheck('Completed book with unknown page count counts as completed book without adding pages', async () => {
    const resAdd = await clientAlice.request('POST', '/api/books', {
      title: 'Unknown Book',
      page_count: 0,
      current_page: 0,
      owned: 0,
      status: 'reading'
    });
    bookUnknown = resAdd.body;

    const resComp = await clientAlice.request('POST', `/api/books/${bookUnknown.id}/complete`);
    assert.strictEqual(resComp.status, 200);
    assert.strictEqual(resComp.body.status, 'completed');

    // Statistics reports 1 book with missing page count metadata
    const stats = await getPersonalStatistics(alice.id, 'all_time');
    assert.strictEqual(stats.missingMetadata.hasMissingPages, true);
    assert.strictEqual(stats.missingMetadata.missingBookPageCounts, 1);
  });

  await asyncCheck('Whole-number page validation rejects invalid values', async () => {
    // Negative page
    const r1 = await clientAlice.request('POST', `/api/books/${book2.id}/progress`, { current_page: -5 });
    assert.strictEqual(r1.status, 400);

    // Decimal page
    const r2 = await clientAlice.request('POST', `/api/books/${book2.id}/progress`, { current_page: 25.5 });
    assert.strictEqual(r2.status, 400);

    // Page exceeding total pages (500)
    const r3 = await clientAlice.request('POST', `/api/books/${book2.id}/progress`, { current_page: 501 });
    assert.strictEqual(r3.status, 400);
    assert.ok(r3.body.error.includes('cannot exceed total pages'));
  });

  console.log('\n--- 6. Account Isolation (Alice vs Bob) ---');
  await asyncCheck('Bob starts with 0 books read and cannot view or edit Alice books', async () => {
    // Bob cannot complete Alice book
    const r1 = await clientBob.request('POST', `/api/books/${book1.id}/complete`);
    assert.strictEqual(r1.status, 404);

    // Bob cannot update Alice book progress
    const r2 = await clientBob.request('POST', `/api/books/${book1.id}/progress`, { current_page: 50 });
    assert.strictEqual(r2.status, 404);

    // Bob dashboard stats are completely zeroed
    const bobStats = await clientBob.request('GET', '/api/stats');
    assert.strictEqual(bobStats.body.books.completed, 0);
    assert.strictEqual(bobStats.body.books.total, 0);

    // Bob personal statistics are completely zeroed
    const bobPStats = await getPersonalStatistics(bob.id, 'all_time');
    assert.strictEqual(bobPStats.summary.booksCompleted, 0);
    assert.strictEqual(bobPStats.summary.totalPagesRead, 0);
  });

  console.log('\n====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL READING PROGRESS & GOALS FIX TESTS PASSED!');
  } else {
    console.error('❌ SOME CHECKS FAILED');
    process.exit(1);
  }
  console.log('====================================================\n');

  // Clean up test DB
  if (server) {
    await new Promise(r => server.close(r));
  }
  try {
    fs.unlinkSync(TEST_DB_PATH);
  } catch (_) {}
  process.exit(0);
}

runTests().catch(err => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
