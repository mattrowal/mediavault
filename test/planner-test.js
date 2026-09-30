import assert from 'node:assert';
import http from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_planner_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  addMedia,
  addBook,
  getMediaById,
  getBookById
} = await import('../db.js');
const {
  parseTimeBudgetMinutes,
  getPlannerCandidates,
  generateWeeklyPlan,
  saveWeeklyPlan,
  getUserSavedPlans,
  deleteSavedPlan
} = await import('../planner-service.js');
const {
  createUserGoal
} = await import('../goals-service.js');

console.log('====================================================');
console.log('🧪 MediaVault AI Weekly Planner Automated Test Suite');
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

  async request(method, reqPath, body = null) {
    const url = new URL(reqPath, baseUrl);
    const headers = {};

    const cookieHeader = this._formatCookieHeader();
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
      if (this.csrfToken) {
        headers['x-csrf-token'] = this.csrfToken;
      }
    }

    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers }, (res) => {
        this._parseSetCookies(res.headers['set-cookie']);
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });

      req.on('error', reject);
      if (body) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
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

async function run() {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    // -------------------------------------------------------------
    // UNIT TESTS: Time Budget Parsing
    // -------------------------------------------------------------
    await asyncCheck('parseTimeBudgetMinutes parses standard and conversational formats', () => {
      assert.strictEqual(parseTimeBudgetMinutes('3 hours'), 180);
      assert.strictEqual(parseTimeBudgetMinutes('2.5 hrs'), 150);
      assert.strictEqual(parseTimeBudgetMinutes('90 minutes'), 90);
      assert.strictEqual(parseTimeBudgetMinutes('45 mins'), 45);
      assert.strictEqual(parseTimeBudgetMinutes('1 hour and 30 mins'), 90);
      assert.strictEqual(parseTimeBudgetMinutes('two hours'), 120);
      assert.strictEqual(parseTimeBudgetMinutes(120), 120);
      assert.strictEqual(parseTimeBudgetMinutes(''), 0);
      assert.strictEqual(parseTimeBudgetMinutes(null), 0);
      assert.strictEqual(parseTimeBudgetMinutes('invalid'), 0);
    });

    // -------------------------------------------------------------
    // SETUP USERS AND DATA
    // -------------------------------------------------------------
    const clientUser1 = new TestClient();
    const clientUser2 = new TestClient();

    // Register User 1
    const reg1 = await clientUser1.register('planner_u1', 'PlannerPassword123!');
    assert.strictEqual(reg1.status, 201);
    const user1Id = reg1.body.user.id;

    // Register User 2
    const reg2 = await clientUser2.register('planner_u2', 'PlannerPassword123!');
    assert.strictEqual(reg2.status, 201);
    const user2Id = reg2.body.user.id;

    // Add items for User 1
    // Movie 1: 120 min runtime
    const movie1 = addMedia({
      title: 'Inception',
      type: 'movie',
      status: 'plan_to_watch',
      runtime: 148,
      genre: 'Sci-Fi'
    }, user1Id);

    // Movie 2: 81 min runtime
    const movie2 = addMedia({
      title: 'Toy Story',
      type: 'movie',
      status: 'plan_to_watch',
      runtime: 81,
      genre: 'Animation'
    }, user1Id);

    // Movie 3: Missing runtime (should be excluded!)
    const movie3 = addMedia({
      title: 'Mystery Movie',
      type: 'movie',
      status: 'plan_to_watch',
      runtime: null,
      genre: 'Mystery'
    }, user1Id);

    // Book 1: 300 pages, currently at 50 pages
    const book1 = addBook({
      title: 'Dune',
      author: 'Frank Herbert',
      page_count: 300,
      current_page: 50,
      status: 'reading'
    }, user1Id);

    // Book 2: Missing total page count (should be excluded!)
    const book2 = addBook({
      title: 'Unknown Length Book',
      author: 'Anonymous',
      page_count: 0,
      current_page: 0,
      status: 'unread'
    }, user1Id);

    // Add item for User 2 (to verify library isolation)
    const u2Movie = addMedia({
      title: 'User 2 Secret Film',
      type: 'movie',
      status: 'plan_to_watch',
      runtime: 100
    }, user2Id);

    // -------------------------------------------------------------
    // UNIT TESTS: Candidate Filtering & Estimation
    // -------------------------------------------------------------
    await asyncCheck('getPlannerCandidates strictly excludes items with missing runtimes/pages and isolates users', async () => {
      const candidates = await getPlannerCandidates(user1Id, { pagesPerHour: 30 });
      
      // Should find movie1, movie2, book1.
      // movie3 (no runtime) and book2 (no page count) must be excluded.
      // u2Movie must NOT appear for user 1.
      const titles = candidates.map(c => c.title);
      assert.ok(titles.includes('Inception'), 'Should include Inception');
      assert.ok(titles.includes('Toy Story'), 'Should include Toy Story');
      assert.ok(titles.includes('Dune'), 'Should include Dune');
      assert.ok(!titles.includes('Mystery Movie'), 'Should exclude movie with missing runtime');
      assert.ok(!titles.includes('Unknown Length Book'), 'Should exclude book with missing page count');
      assert.ok(!titles.includes('User 2 Secret Film'), 'User 1 cannot see User 2 candidates');

      // Verify book chunk calculation: speed 30 pages/hr -> 30 pages planned (~60 mins)
      const duneCandidate = candidates.find(c => c.title === 'Dune');
      assert.strictEqual(duneCandidate.pagesToRead, 30);
      assert.strictEqual(duneCandidate.durationMinutes, 60);
    });

    // -------------------------------------------------------------
    // UNIT TESTS: Plan Generation & Budget Constraints
    // -------------------------------------------------------------
    await asyncCheck('generateWeeklyPlan strictly respects budget limit and fallback logic', async () => {
      // Budget: 100 minutes
      // Toy Story is 81 min. Dune chunk is 60 min. Inception is 148 min.
      // A 100-min budget should select Toy Story (81) OR Dune (60), but NEVER exceed 100 min total!
      const plan = await generateWeeklyPlan(user1Id, {
        timeInput: '100 minutes',
        pagesPerHour: 30
      });

      assert.strictEqual(plan.success, true);
      assert.strictEqual(plan.budgetMinutes, 100);
      assert.ok(plan.totalPlannedMinutes <= 100, `Total ${plan.totalPlannedMinutes} must be <= 100`);
      assert.ok(plan.activities.length > 0, 'Should have at least 1 activity');
      assert.ok(plan.explanation, 'Should have an explanation');
    });

    await asyncCheck('generateWeeklyPlan rejects empty/invalid time budgets', async () => {
      let rejected = false;
      try {
        await generateWeeklyPlan(user1Id, { timeInput: 'invalid string' });
      } catch (err) {
        rejected = true;
        assert.ok(err.message.includes('valid time budget'));
      }
      assert.strictEqual(rejected, true);
    });

    await asyncCheck('generateWeeklyPlan prioritizes candidate types matching user personal goal', async () => {
      // Create a reading goal for user 1
      const goal = createUserGoal(user1Id, {
        goalType: 'pages_monthly',
        target: 200,
        year: 2026,
        month: 9
      });

      // Generate a plan of 120 minutes with goalId specified
      const plan = await generateWeeklyPlan(user1Id, {
        timeInput: '120 minutes',
        pagesPerHour: 30,
        goalId: goal.id
      });

      // The reading candidate should be prioritized first
      assert.ok(plan.activities.length > 0);
      assert.strictEqual(plan.activities[0].itemType, 'book', 'Should prioritize book activity when reading goal is active');
    });

    // -------------------------------------------------------------
    // UNIT TESTS: Plan Persistence & Status Invariant
    // -------------------------------------------------------------
    await asyncCheck('saveWeeklyPlan persists plan WITHOUT altering item watched/read statuses', async () => {
      const planToSave = {
        title: 'Weekend Relaxation Plan',
        budgetMinutes: 180,
        totalPlannedMinutes: 141,
        activities: [
          { candidateId: `movie_${movie2.id}`, title: 'Toy Story', durationMinutes: 81, itemType: 'movie' },
          { candidateId: `book_${book1.id}`, title: 'Dune', durationMinutes: 60, itemType: 'book' }
        ],
        explanation: 'Enjoy Toy Story and a reading session of Dune.'
      };

      const saved = saveWeeklyPlan(user1Id, planToSave);
      assert.ok(saved.id, 'Saved plan has an id');
      assert.strictEqual(saved.title, 'Weekend Relaxation Plan');
      assert.strictEqual(saved.activities.length, 2);

      // CRITICAL INVARIANT: Items must NOT have had their statuses changed!
      const checkMovie = getMediaById(movie2.id, user1Id);
      assert.strictEqual(checkMovie.status, 'plan_to_watch', 'Movie status must remain unchanged');

      const checkBook = getBookById(book1.id, user1Id);
      assert.strictEqual(checkBook.status, 'reading', 'Book status must remain unchanged');
      assert.strictEqual(checkBook.current_page, 50, 'Book current page must remain unchanged');
    });

    await asyncCheck('getUserSavedPlans and deleteSavedPlan enforce user isolation', async () => {
      const u1Plans = getUserSavedPlans(user1Id);
      assert.ok(u1Plans.length >= 1);
      const planId = u1Plans[0].id;

      // User 2 cannot see User 1 plans
      const u2Plans = getUserSavedPlans(user2Id);
      assert.strictEqual(u2Plans.length, 0, 'User 2 should see 0 plans');

      // User 2 cannot delete User 1 plan
      const deleteOther = deleteSavedPlan(planId, user2Id);
      assert.strictEqual(deleteOther, false, 'User 2 cannot delete User 1 plan');

      // User 1 can delete own plan
      const deleteOwn = deleteSavedPlan(planId, user1Id);
      assert.strictEqual(deleteOwn, true, 'User 1 can delete own plan');

      const u1Remaining = getUserSavedPlans(user1Id);
      assert.strictEqual(u1Remaining.length, 0);
    });

    // -------------------------------------------------------------
    // API ENDPOINT TESTS (HTTP)
    // -------------------------------------------------------------
    await asyncCheck('HTTP POST /api/planner/generate requires authentication', async () => {
      const anonClient = new TestClient();
      await anonClient.initCsrf();
      const res = await anonClient.request('POST', '/api/planner/generate', { timeInput: '2 hours' });
      assert.strictEqual(res.status, 401);
    });

    await asyncCheck('HTTP POST /api/planner/generate validates timeInput', async () => {
      const res = await clientUser1.request('POST', '/api/planner/generate', { timeInput: '' });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error);
    });

    await asyncCheck('HTTP POST /api/planner/generate returns valid plan', async () => {
      const res = await clientUser1.request('POST', '/api/planner/generate', {
        timeInput: '3 hours',
        pagesPerHour: 30
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.budgetMinutes, 180);
      assert.ok(res.body.totalPlannedMinutes <= 180);
      assert.ok(Array.isArray(res.body.activities));
    });

    await asyncCheck('HTTP POST /api/planner/save, GET /api/planner/saved, and DELETE /api/planner/saved/:id work over HTTP', async () => {
      // 1. Save
      const saveRes = await clientUser1.request('POST', '/api/planner/save', {
        title: 'HTTP Test Plan',
        budgetMinutes: 120,
        totalPlannedMinutes: 81,
        activities: [
          { candidateId: `movie_${movie2.id}`, title: 'Toy Story', durationMinutes: 81, itemType: 'movie' }
        ],
        explanation: 'Quick movie night'
      });
      assert.strictEqual(saveRes.status, 201);
      const savedPlanId = saveRes.body.id;
      assert.ok(savedPlanId);

      // 2. Get saved plans
      const getRes = await clientUser1.request('GET', '/api/planner/saved');
      assert.strictEqual(getRes.status, 200);
      assert.ok(Array.isArray(getRes.body.plans));
      const found = getRes.body.plans.find(p => p.id === savedPlanId);
      assert.ok(found);
      assert.strictEqual(found.title, 'HTTP Test Plan');
      assert.strictEqual(found.activities.length, 1);

      // 3. User 2 cannot delete User 1 plan over HTTP
      const failDelete = await clientUser2.request('DELETE', `/api/planner/saved/${savedPlanId}`);
      assert.strictEqual(failDelete.status, 404);

      // 4. User 1 deletes own plan
      const delRes = await clientUser1.request('DELETE', `/api/planner/saved/${savedPlanId}`);
      assert.strictEqual(delRes.status, 200);
      assert.strictEqual(delRes.body.success, true);

      // 5. Verify deleted
      const checkRes = await clientUser1.request('GET', '/api/planner/saved');
      assert.strictEqual(checkRes.body.plans.some(p => p.id === savedPlanId), false);
    });

  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    // Clean up test DB files
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
      if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch (_) {}
  }

  console.log('\n----------------------------------------------------');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  console.log('----------------------------------------------------');

  if (passedChecks !== totalChecks) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
