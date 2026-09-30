import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path before importing app or db
const TEST_DB_PATH = path.join(rootDir, 'data', `test_notif_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';
process.env.PORT = '3299';
process.env.GEMINI_API_KEY = 'your_gemini_test_key';

const { default: app } = await import('../server.js');
const {
  db,
  addMedia,
  createNotification,
  getUserNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getAllDistinctFollowedTVShows,
  updateShowScheduleAcrossUsers,
  getUsersBehindOnShow
} = await import('../db.js');

let server;
let PORT = 0;
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
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 MediaVault Episode Notifications & Monitoring Test Suite');
  console.log('====================================================\n');

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      PORT = server.address().port;
      BASE_URL = `http://127.0.0.1:${PORT}`;
      resolve();
    });
  });

  try {
    const unauthenticated = new TestClient();
    const alice = new TestClient();
    const bob = new TestClient();

    // -------------------------------------------------------------
    console.log('1️⃣ Testing Unauthenticated Access & CSRF Defense');
    // -------------------------------------------------------------
    const noAuthGet = await unauthenticated.request('GET', '/api/notifications');
    assert(noAuthGet.status === 401, 'Unauthenticated GET /api/notifications returns 401 Unauthorized');

    const noAuthPatch = await unauthenticated.request('PATCH', '/api/notifications/1/read');
    assert(noAuthPatch.status === 403 || noAuthPatch.status === 401, 'Unauthenticated PATCH /api/notifications/1/read is rejected with 401 or 403');

    // Register Alice and Bob
    await alice.initCsrf();
    const regAlice = await alice.request('POST', '/api/auth/register', {
      username: 'notif_alice',
      password: 'aliceSecurePassword123'
    });
    assert(regAlice.status === 201, 'Alice registered successfully');
    const aliceId = regAlice.body.user.id;

    await bob.initCsrf();
    const regBob = await bob.request('POST', '/api/auth/register', {
      username: 'notif_bob',
      password: 'bobSecurePassword123'
    });
    assert(regBob.status === 201, 'Bob registered successfully');
    const bobId = regBob.body.user.id;

    // Seed TV Shows
    const aliceShow = addMedia({
      type: 'tv',
      title: 'Severance',
      external_id: '42177',
      status: 'watching',
      current_season: 1,
      current_episode: 5,
      latest_season: 1,
      latest_episode: 9
    }, aliceId);

    const bobShow = addMedia({
      type: 'tv',
      title: 'Ted Lasso',
      external_id: '44458',
      status: 'watching',
      current_season: 2,
      current_episode: 1,
      latest_season: 2,
      latest_episode: 10
    }, bobId);

    // -------------------------------------------------------------
    console.log('\n2️⃣ Testing Notification Deduplication (Compound Unique Constraint)');
    // -------------------------------------------------------------
    const firstInsert = createNotification({
      userId: aliceId,
      mediaId: aliceShow.id,
      title: 'New Episode: Severance',
      message: 'Season 2 Episode 1 has aired!',
      season: 2,
      episode: 1,
      airDate: '2026-01-17'
    });
    assert(firstInsert === true, 'First notification creation succeeds');

    // Attempt to insert duplicate notification for same user, show, season, and episode
    const duplicateInsert = createNotification({
      userId: aliceId,
      mediaId: aliceShow.id,
      title: 'New Episode: Severance',
      message: 'Season 2 Episode 1 has aired!',
      season: 2,
      episode: 1,
      airDate: '2026-01-17'
    });
    assert(duplicateInsert === false, 'Duplicate notification is ignored by SQLite unique index (Zero Duplicates)');

    // Verify unread count is exactly 1
    const aliceUnreadCount = getUnreadNotificationCount(aliceId);
    assert(aliceUnreadCount === 1, 'Alice unread count is exactly 1');

    // -------------------------------------------------------------
    console.log('\n3️⃣ Testing User Isolation & IDOR Protection');
    // -------------------------------------------------------------
    // Alice checks notifications
    const aliceNotifsRes = await alice.request('GET', '/api/notifications');
    assert(aliceNotifsRes.status === 200, 'Alice GET /api/notifications returns 200 OK');
    assert(aliceNotifsRes.body.unreadCount === 1, 'Alice unreadCount payload is 1');
    assert(aliceNotifsRes.body.notifications.length === 1, 'Alice has 1 notification');
    const aliceNotifId = aliceNotifsRes.body.notifications[0].id;
    assert(aliceNotifsRes.body.notifications[0].title === 'New Episode: Severance', 'Notification title matches Alice show');

    // Bob checks notifications
    const bobNotifsRes = await bob.request('GET', '/api/notifications');
    assert(bobNotifsRes.status === 200, 'Bob GET /api/notifications returns 200 OK');
    assert(bobNotifsRes.body.unreadCount === 0, 'Bob unreadCount is 0');
    assert(bobNotifsRes.body.notifications.length === 0, 'Bob has 0 notifications (No Cross-Account Leak)');

    // Bob attempts to mark Alice's notification as read (IDOR attack)
    const bobTamperRes = await bob.request('PATCH', `/api/notifications/${aliceNotifId}/read`);
    assert(bobTamperRes.status === 404, 'Bob cannot mark Alice notification as read (404 Not Found)');

    // Alice notification remains unread
    assert(getUnreadNotificationCount(aliceId) === 1, 'Alice notification remains unread after unauthorized attempt');

    // -------------------------------------------------------------
    console.log('\n4️⃣ Testing Mark Single Notification as Read');
    // -------------------------------------------------------------
    const aliceReadRes = await alice.request('PATCH', `/api/notifications/${aliceNotifId}/read`);
    assert(aliceReadRes.status === 200, 'Alice marks notification as read successfully');
    assert(aliceReadRes.body.unreadCount === 0, 'Alice unread count decrements to 0');

    const aliceUpdatedNotifs = getUserNotifications(aliceId);
    assert(aliceUpdatedNotifs[0].is_read === 1, 'Notification row is_read is now 1 in database');

    // -------------------------------------------------------------
    console.log('\n5️⃣ Testing Mark All as Read');
    // -------------------------------------------------------------
    // Create 2 notifications for Bob
    createNotification({
      userId: bobId,
      mediaId: bobShow.id,
      title: 'New Episode: Ted Lasso',
      message: 'Season 3 Episode 1 has aired!',
      season: 3,
      episode: 1,
      airDate: '2026-03-15'
    });
    createNotification({
      userId: bobId,
      mediaId: bobShow.id,
      title: 'New Episode: Ted Lasso',
      message: 'Season 3 Episode 2 has aired!',
      season: 3,
      episode: 2,
      airDate: '2026-03-22'
    });

    assert(getUnreadNotificationCount(bobId) === 2, 'Bob has 2 unread notifications');

    const markAllRes = await bob.request('POST', '/api/notifications/read-all');
    assert(markAllRes.status === 200, 'POST /api/notifications/read-all returns 200 OK');
    assert(markAllRes.body.markedRead === 2, 'Payload confirms 2 notifications marked as read');
    assert(getUnreadNotificationCount(bobId) === 0, 'Bob unread count is now 0');

    // -------------------------------------------------------------
    console.log('\n6️⃣ Testing Notification Dismissal / Deletion');
    // -------------------------------------------------------------
    const deleteRes = await alice.request('DELETE', `/api/notifications/${aliceNotifId}`);
    assert(deleteRes.status === 200, 'Alice deletes notification returns 200 OK');
    assert(getUserNotifications(aliceId).length === 0, 'Alice notification list is now empty');

    // -------------------------------------------------------------
    console.log('\n7️⃣ Testing Background Deduplicating Query Helpers');
    // -------------------------------------------------------------
    const distinctShows = getAllDistinctFollowedTVShows();
    assert(distinctShows.length >= 2, 'Distinct followed shows returned correctly for background worker');
    assert(distinctShows.some(s => s.external_id === '42177'), 'Severance is in unique shows list');
    assert(distinctShows.some(s => s.external_id === '44458'), 'Ted Lasso is in unique shows list');

    // Update show schedule across users
    const updatedRows = updateShowScheduleAcrossUsers('42177', {
      latest_season: 2,
      latest_episode: 5,
      latest_episode_name: 'The Work',
      latest_air_date: '2026-02-14',
      next_air_date: '2026-02-21',
      total_episodes: 15
    });
    assert(updatedRows >= 1, 'Schedule updated across all users following Severance');

    // Verify last_synced_at was recorded
    const showRow = db.prepare('SELECT last_synced_at, latest_season, latest_episode FROM media_items WHERE external_id = ?').get('42177');
    assert(Boolean(showRow.last_synced_at), 'last_synced_at timestamp was saved to media_items');
    assert(showRow.latest_season === 2 && showRow.latest_episode === 5, 'Latest season and episode updated in database');

    // Verify users behind calculation
    const usersBehind = getUsersBehindOnShow('42177', 2, 5);
    assert(usersBehind.length === 1 && usersBehind[0].user_id === aliceId, 'Alice accurately identified as behind on Severance');

    console.log('\n====================================================');
    console.log(`🎉 ALL EPISODE NOTIFICATION TESTS PASSED! (${passed} checks passed, ${failed} failed)`);
    console.log('====================================================\n');
  } finally {
    if (server) {
      server.close();
    }
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
      if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch {}
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
