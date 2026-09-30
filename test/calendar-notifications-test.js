import assert from 'node:assert';
import http from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_calendar_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  addMedia,
  getMediaById,
  setCachedEpisodes,
  markEpisodeWatched
} = await import('../db.js');
const {
  formatEpisodeSchedule,
  getUpcomingCalendar,
  updateShowNotificationPreference
} = await import('../calendar-service.js');
const {
  setMockEpisodeData
} = await import('../episode-service.js');
const {
  runEpisodeCheckCycle
} = await import('../episode-monitor.js');

console.log('====================================================');
console.log('🧪 MediaVault Episode Calendar & Notifications Test Suite');
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
    // UNIT TESTS: Schedule and Relative Time Formatting
    // -------------------------------------------------------------
    await asyncCheck('formatEpisodeSchedule formats relative days and timezone labels', () => {
      const todayStr = new Date().toISOString().split('T')[0];
      const todayRes = formatEpisodeSchedule(todayStr, '21:00', 'UTC');
      assert.strictEqual(todayRes.relativeLabel, 'Today');
      assert.strictEqual(todayRes.formattedTime, '21:00 (UTC)');

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomStr = tomorrow.toISOString().split('T')[0];
      const tomRes = formatEpisodeSchedule(tomStr, '20:30', 'CET');
      assert.strictEqual(tomRes.relativeLabel, 'Tomorrow');
      assert.strictEqual(tomRes.formattedTime, '20:30 (CET)');

      const emptyRes = formatEpisodeSchedule('', '');
      assert.strictEqual(emptyRes.relativeLabel, 'TBA');
    });

    // -------------------------------------------------------------
    // SETUP USERS AND DATA
    // -------------------------------------------------------------
    const clientUser1 = new TestClient();
    const clientUser2 = new TestClient();

    const reg1 = await clientUser1.register('cal_user1', 'CalPassLongSecure123!');
    assert.strictEqual(reg1.status, 201);
    const user1Id = reg1.body.user.id;

    const reg2 = await clientUser2.register('cal_user2', 'CalPassLongSecure123!');
    assert.strictEqual(reg2.status, 201);
    const user2Id = reg2.body.user.id;

    // Dates for upcoming episodes
    const todayStr = new Date().toISOString().split('T')[0];
    const in3Days = new Date();
    in3Days.setDate(in3Days.getDate() + 3);
    const in3DaysStr = in3Days.toISOString().split('T')[0];

    const in15Days = new Date();
    in15Days.setDate(in15Days.getDate() + 15);
    const in15DaysStr = in15Days.toISOString().split('T')[0];

    // Seed TV series in user 1 library with external_id '99001'
    const show1 = addMedia({
      title: 'Galactic Chronicles',
      type: 'tv',
      external_id: '99001',
      status: 'watching',
      notify_enabled: 1
    }, user1Id);

    // Seed TV series in user 2 library (to test user isolation)
    const show2 = addMedia({
      title: 'User 2 Solo Show',
      type: 'tv',
      external_id: '99002',
      status: 'watching',
      notify_enabled: 1
    }, user2Id);

    // Mock episodes for 99001 (Galactic Chronicles)
    setMockEpisodeData('99001', [
      { id: 101, season: 1, number: 1, name: 'Pilot', airdate: todayStr, airtime: '20:00', runtime: 60, summary: 'First ep' },
      { id: 102, season: 1, number: 2, name: 'The Void', airdate: in3DaysStr, airtime: '20:00', runtime: 60, summary: 'Second ep' },
      { id: 103, season: 1, number: 3, name: 'Deep Space', airdate: in15DaysStr, airtime: '20:00', runtime: 60, summary: 'Third ep' }
    ]);

    // Mock episodes for 99002 (User 2 show)
    setMockEpisodeData('99002', [
      { id: 201, season: 1, number: 1, name: 'User 2 Pilot', airdate: todayStr, airtime: '19:00', runtime: 45, summary: 'U2 ep' }
    ]);

    // -------------------------------------------------------------
    // UNIT TESTS: Calendar Agenda & User Isolation
    // -------------------------------------------------------------
    await asyncCheck('getUpcomingCalendar structures agenda into today, thisWeek, and later with strict user isolation', async () => {
      const cal = await getUpcomingCalendar(user1Id, { days: 30, includeWatched: true });

      assert.strictEqual(cal.totalCount, 3);
      assert.strictEqual(cal.agenda.today.length, 1);
      assert.strictEqual(cal.agenda.today[0].episodeTitle, 'Pilot');
      assert.strictEqual(cal.agenda.today[0].relativeLabel, 'Today');

      assert.strictEqual(cal.agenda.thisWeek.length, 1);
      assert.strictEqual(cal.agenda.thisWeek[0].episodeTitle, 'The Void');

      assert.strictEqual(cal.agenda.later.length, 1);
      assert.strictEqual(cal.agenda.later[0].episodeTitle, 'Deep Space');

      // User 1 must NOT see User 2's show
      const hasU2 = cal.episodes.some(e => e.showTitle === 'User 2 Solo Show');
      assert.strictEqual(hasU2, false, 'User 1 cannot see User 2 calendar events');
    });

    await asyncCheck('getUpcomingCalendar excludes watched episodes unless includeWatched=true', async () => {
      // Mark S1E1 as watched for User 1
      markEpisodeWatched(show1.id, user1Id, 1, 1);

      // Without includeWatched
      const calUnwatched = await getUpcomingCalendar(user1Id, { days: 30, includeWatched: false });
      assert.strictEqual(calUnwatched.totalCount, 2, 'Watched episode should be excluded');
      assert.strictEqual(calUnwatched.episodes.some(e => e.episode === 1), false);

      // With includeWatched
      const calWatched = await getUpcomingCalendar(user1Id, { days: 30, includeWatched: true });
      assert.strictEqual(calWatched.totalCount, 3, 'Watched episode should be included when requested');
      const ep1 = calWatched.episodes.find(e => e.episode === 1);
      assert.strictEqual(ep1.isWatched, true);
    });

    // -------------------------------------------------------------
    // UNIT TESTS: Series Notification Preference & Isolation
    // -------------------------------------------------------------
    await asyncCheck('updateShowNotificationPreference toggles preference and enforces ownership', () => {
      // User 1 disables notifications for show1
      const res = updateShowNotificationPreference(show1.id, user1Id, false);
      assert.strictEqual(res.notifyEnabled, false);

      const updated = getMediaById(show1.id, user1Id);
      assert.strictEqual(updated.notify_enabled, 0);

      // User 2 cannot modify User 1's show notification preference
      let user2Rejected = false;
      try {
        updateShowNotificationPreference(show1.id, user2Id, true);
      } catch (err) {
        user2Rejected = true;
        assert.strictEqual(err.status, 404);
      }
      assert.strictEqual(user2Rejected, true);

      // Re-enable for show1
      const res2 = updateShowNotificationPreference(show1.id, user1Id, 1);
      assert.strictEqual(res2.notifyEnabled, true);
    });

    // -------------------------------------------------------------
    // API ENDPOINT TESTS (HTTP)
    // -------------------------------------------------------------
    await asyncCheck('HTTP GET /api/calendar/upcoming requires authentication and returns agenda', async () => {
      const anonClient = new TestClient();
      await anonClient.initCsrf();
      const unauth = await anonClient.request('GET', '/api/calendar/upcoming');
      assert.strictEqual(unauth.status, 401);

      const authRes = await clientUser1.request('GET', '/api/calendar/upcoming?days=30&includeWatched=true');
      assert.strictEqual(authRes.status, 200);
      assert.strictEqual(authRes.body.totalCount, 3);
      assert.ok(authRes.body.agenda);
      assert.ok(Array.isArray(authRes.body.agenda.today));
    });

    await asyncCheck('HTTP PATCH /api/media/:id/notifications updates preference via API', async () => {
      // Missing notify_enabled returns 400
      const badReq = await clientUser1.request('PATCH', `/api/media/${show1.id}/notifications`, {});
      assert.strictEqual(badReq.status, 400);

      // Disable notifications
      const patchRes = await clientUser1.request('PATCH', `/api/media/${show1.id}/notifications`, {
        notify_enabled: 0
      });
      assert.strictEqual(patchRes.status, 200);
      assert.strictEqual(patchRes.body.notifyEnabled, false);

      // Verify in DB
      const item = getMediaById(show1.id, user1Id);
      assert.strictEqual(item.notify_enabled, 0);

      // User 2 cannot patch User 1's show
      const u2Patch = await clientUser2.request('PATCH', `/api/media/${show1.id}/notifications`, {
        notify_enabled: 1
      });
      assert.strictEqual(u2Patch.status, 404);
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
