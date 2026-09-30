import assert from 'node:assert';
import http from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_goals_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  addMedia,
  addBook,
  logActivity
} = await import('../db.js');

console.log('====================================================');
console.log('🧪 MediaVault Personal Goals Automated Test Suite');
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

  const regAlice = await clientAlice.register(`alice_goals_${ts}`, 'AliceGoalsPassword123!');
  assert.strictEqual(regAlice.status, 201);
  const alice = regAlice.body.user;

  const regBob = await clientBob.register(`bob_goals_${ts}`, 'BobGoalsPassword123!');
  assert.strictEqual(regBob.status, 201);
  const bob = regBob.body.user;

  console.log('--- 1. Target Validation & Constraints ---');
  await asyncCheck('Rejects negative target (400)', async () => {
    const res = await clientAlice.request('POST', '/api/goals', {
      goalType: 'books_yearly',
      target: -5
    });
    assert.strictEqual(res.status, 400);
  });

  await asyncCheck('Rejects target of 0 (400)', async () => {
    const res = await clientAlice.request('POST', '/api/goals', {
      goalType: 'books_yearly',
      target: 0
    });
    assert.strictEqual(res.status, 400);
  });

  await asyncCheck('Rejects non-integer decimal target (400)', async () => {
    const res = await clientAlice.request('POST', '/api/goals', {
      goalType: 'books_yearly',
      target: 5.5
    });
    assert.strictEqual(res.status, 400);
  });

  let bookGoal = null;
  await asyncCheck('Creates valid yearly book goal with target 10', async () => {
    const res = await clientAlice.request('POST', '/api/goals', {
      goalType: 'books_yearly',
      target: 10,
      year: currentYear,
      includeRepeats: 1
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.target, 10);
    assert.strictEqual(res.body.currentProgress, 0);
    assert.strictEqual(res.body.percentage, 0);
    assert.ok(res.body.timeRemainingText.includes('remaining'));
    bookGoal = res.body;
  });

  console.log('\n--- 2. Duplicate Prevention ---');
  await asyncCheck('Attempting to create another books_yearly goal for same year returns 409 Conflict', async () => {
    const res = await clientAlice.request('POST', '/api/goals', {
      goalType: 'books_yearly',
      target: 20,
      year: currentYear
    });
    assert.strictEqual(res.status, 409);
    assert.ok(res.body.error.includes('already exists'));
  });

  console.log('\n--- 3. Progress Tracking & Repeat Rules (Books) ---');
  let b1, b2;

  await asyncCheck('Alice completes 2 books -> Progress updates to 2 of 10 (20%)', async () => {
    b1 = addBook({ title: 'Book One', author: 'Author A', page_count: 200, status: 'completed' }, alice.id);
    b2 = addBook({ title: 'Book Two', author: 'Author B', page_count: 250, status: 'completed' }, alice.id);

    await clientAlice.request('POST', '/api/cycles/complete', { itemType: 'book', itemId: b1.id });
    await clientAlice.request('POST', '/api/cycles/complete', { itemType: 'book', itemId: b2.id });

    const goalsRes = await clientAlice.request('GET', '/api/goals');
    assert.strictEqual(goalsRes.status, 200);
    const g = goalsRes.body.goals.find(x => x.id === bookGoal.id);
    assert.strictEqual(g.currentProgress, 2);
    assert.strictEqual(g.percentage, 20);
    assert.strictEqual(g.progressText, '2 of 10 books completed this year.');
  });

  await asyncCheck('Alice starts and completes reread of Book One (Cycle 2)', async () => {
    await clientAlice.request('POST', '/api/cycles/start', { itemType: 'book', itemId: b1.id });
    await clientAlice.request('POST', '/api/cycles/complete', { itemType: 'book', itemId: b1.id });

    // With includeRepeats = 1: progress should become 3
    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const g = goalsRes.body.goals.find(x => x.id === bookGoal.id);
    assert.strictEqual(g.currentProgress, 3, 'Includes reread when includeRepeats: true');
    assert.strictEqual(g.percentage, 30);
  });

  await asyncCheck('Toggling goal includeRepeats to 0 excludes repeats -> progress drops to 2 unique titles', async () => {
    const putRes = await clientAlice.request('PUT', `/api/goals/${bookGoal.id}`, {
      includeRepeats: 0
    });
    assert.strictEqual(putRes.status, 200);
    assert.strictEqual(putRes.body.includeRepeats, false);
    assert.strictEqual(putRes.body.currentProgress, 2, 'Counts only unique titles');
    assert.strictEqual(putRes.body.percentage, 20);
  });

  console.log('\n--- 4. Monthly Pages Goal & Progress Corrections Rule ---');
  let pageGoal;
  await asyncCheck('Creates monthly pages goal (target 1000 pages)', async () => {
    const res = await clientAlice.request('POST', '/api/goals', {
      goalType: 'pages_monthly',
      target: 1000,
      year: currentYear,
      month: currentMonth
    });
    assert.strictEqual(res.status, 201);
    pageGoal = res.body;
    // Already has 650 pages from books completed in section 3
    assert.strictEqual(pageGoal.currentProgress, 650);
  });

  await asyncCheck('Active reading session of 150 pages increments goal to 800/1000 (80%)', async () => {
    const b3 = addBook({ title: 'Book Three', author: 'Author C', page_count: 400, current_page: 0 }, alice.id);
    await clientAlice.request('POST', `/api/books/${b3.id}/progress`, { current_page: 150 });

    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const g = goalsRes.body.goals.find(x => x.id === pageGoal.id);
    assert.strictEqual(g.currentProgress, 800);
    assert.strictEqual(g.percentage, 80);
  });

  await asyncCheck('Progress correction does NOT create extra pages for the goal', async () => {
    const b3 = (await clientAlice.request('GET', '/api/books')).body.find(b => b.title === 'Book Three');
    // Save progress with is_correction: true
    await clientAlice.request('POST', `/api/books/${b3.id}/progress`, {
      current_page: 180,
      is_correction: true
    });

    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const g = goalsRes.body.goals.find(x => x.id === pageGoal.id);
    assert.strictEqual(g.currentProgress, 800, 'Corrections must not create extra pages');
  });

  console.log('\n--- 5. Monthly Movies Goal ---');
  await asyncCheck('Creates monthly movies goal and tracks rewatches', async () => {
    const mRes = await clientAlice.request('POST', '/api/goals', {
      goalType: 'movies_monthly',
      target: 4,
      year: currentYear,
      month: currentMonth,
      includeRepeats: 1
    });
    assert.strictEqual(mRes.status, 201);
    const mGoal = mRes.body;

    const mov1 = addMedia({ type: 'movie', title: 'Arrival', runtime: 116 }, alice.id);
    await clientAlice.request('POST', '/api/cycles/complete', { itemType: 'movie', itemId: mov1.id });

    let goalsRes = await clientAlice.request('GET', '/api/goals');
    let mg = goalsRes.body.goals.find(x => x.id === mGoal.id);
    assert.strictEqual(mg.currentProgress, 1);

    // Rewatch
    await clientAlice.request('POST', '/api/cycles/start', { itemType: 'movie', itemId: mov1.id });
    await clientAlice.request('POST', '/api/cycles/complete', { itemType: 'movie', itemId: mov1.id });

    goalsRes = await clientAlice.request('GET', '/api/goals');
    mg = goalsRes.body.goals.find(x => x.id === mGoal.id);
    assert.strictEqual(mg.currentProgress, 2, 'Rewatch counts when includeRepeats: true');
  });

  console.log('\n--- 6. Goal Editing & Deletion ---');
  await asyncCheck('Alice edits target and deletes goal', async () => {
    const putRes = await clientAlice.request('PUT', `/api/goals/${pageGoal.id}`, { target: 1600 });
    assert.strictEqual(putRes.status, 200);
    assert.strictEqual(putRes.body.target, 1600);
    assert.strictEqual(putRes.body.percentage, 50); // 800/1600 = 50%

    const delRes = await clientAlice.request('DELETE', `/api/goals/${pageGoal.id}`);
    assert.strictEqual(delRes.status, 200);

    const goalsRes = await clientAlice.request('GET', '/api/goals');
    const found = goalsRes.body.goals.find(x => x.id === pageGoal.id);
    assert.strictEqual(found, undefined, 'Goal must be deleted');
  });

  console.log('\n--- 7. User Isolation (Alice vs Bob) ---');
  await asyncCheck('Bob cannot see, edit or delete Alice goals', async () => {
    const bobGoals = (await clientBob.request('GET', '/api/goals')).body.goals;
    assert.strictEqual(bobGoals.length, 0, 'Bob starts with 0 goals');

    const bobPut = await clientBob.request('PUT', `/api/goals/${bookGoal.id}`, { target: 999 });
    assert.strictEqual(bobPut.status, 404, 'Bob cannot edit Alice goal');

    const bobDel = await clientBob.request('DELETE', `/api/goals/${bookGoal.id}`);
    assert.strictEqual(bobDel.status, 404, 'Bob cannot delete Alice goal');
  });

  console.log('====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL PERSONAL GOALS TESTS PASSED!');
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
