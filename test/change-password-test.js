import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path before importing app or db
const TEST_DB_PATH = path.join(rootDir, 'data', `test_change_pwd_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';
process.env.PORT = '3098';
process.env.GEMINI_API_KEY = 'your_gemini_test_key';

// Import app and db after DB_PATH environment variable is configured
const { default: app } = await import('../server.js');
const {
  db,
  getUserById,
  getUserWithCredentials,
  updateUserPasswordAndRevokeSessions
} = await import('../db.js');
const { hashPassword, verifyPassword } = await import('../auth.js');

let server;
let PORT = 0;
let BASE_URL = '';

// Helper: HTTP Request Client with cookie tracking
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
      if (val === '' || header.toLowerCase().includes('expires=thu, 01 jan 1970')) {
        delete this.cookies[name];
        if (name === 'mediavault_csrf') this.csrfToken = null;
      } else {
        this.cookies[name] = val;
        if (name === 'mediavault_csrf') {
          this.csrfToken = val;
        }
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
  console.log('🧪 MediaVault Change Password Verification Suite');
  console.log('====================================================\n');

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      PORT = server.address().port;
      BASE_URL = `http://127.0.0.1:${PORT}`;
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------
    console.log('1️⃣ Testing Middleware Order: CSRF before Authentication');
    // -------------------------------------------------------------
    const clientNoCsrf = new TestClient();

    // Calling POST /api/auth/change-password without any CSRF token must return 403 (CSRF runs first)
    const resNoCsrf = await clientNoCsrf.request('POST', '/api/auth/change-password', {
      currentPassword: 'anyPassword12345',
      newPassword: 'newPassword12345',
      confirmPassword: 'newPassword12345'
    }, { 'x-csrf-token': '' });
    assert(resNoCsrf.status === 403, 'POST /api/auth/change-password without CSRF returns 403 Forbidden (CSRF checked first)');

    // Calling with an invalid CSRF header token must also return 403
    const resInvalidCsrf = await clientNoCsrf.request('POST', '/api/auth/change-password', {
      currentPassword: 'anyPassword12345',
      newPassword: 'newPassword12345',
      confirmPassword: 'newPassword12345'
    }, { 'x-csrf-token': 'bad_csrf_token_123' });
    assert(resInvalidCsrf.status === 403, 'POST /api/auth/change-password with invalid CSRF returns 403 Forbidden');

    // Calling with valid CSRF token but unauthenticated (no session cookie) must return 401 (requireAuth runs second)
    const clientUnauth = new TestClient();
    await clientUnauth.initCsrf();
    const resUnauth = await clientUnauth.request('POST', '/api/auth/change-password', {
      currentPassword: 'anyPassword12345',
      newPassword: 'newPassword12345',
      confirmPassword: 'newPassword12345'
    });
    assert(resUnauth.status === 401, 'POST /api/auth/change-password with valid CSRF but unauthenticated returns 401 Unauthorized');

    // -------------------------------------------------------------
    console.log('\n2️⃣ Testing Registration Password Policy & Existing User Compatibility');
    // -------------------------------------------------------------
    const clientReg = new TestClient();
    await clientReg.initCsrf();

    // Rejection of registration passwords shorter than 15 characters
    const resShortReg = await clientReg.request('POST', '/api/auth/register', {
      username: 'short_user',
      password: 'shortPass1234' // 13 chars
    });
    assert(resShortReg.status === 400, 'Registration with password < 15 characters is rejected with 400');

    // Directly seed an existing legacy user with an 8-character password in the database
    const scryptAsync = promisify(crypto.scrypt);
    const legacySalt = crypto.randomBytes(16).toString('hex');
    const legacyKey = await scryptAsync('legacy8!', legacySalt, 64);
    const legacyHash = legacyKey.toString('hex');

    db.prepare(`
      INSERT INTO users (username, password_hash, salt)
      VALUES ('legacy_user', ?, ?)
    `).run(legacyHash, legacySalt);

    // Verify existing user with short password can still log in (not locked out)
    const legacyClient = new TestClient();
    await legacyClient.initCsrf();
    const legacyLogin = await legacyClient.request('POST', '/api/auth/login', {
      username: 'legacy_user',
      password: 'legacy8!'
    });
    assert(legacyLogin.status === 200, 'Existing user with short password logs in successfully without lockout');

    // Register a user for input validation tests
    const valClient = new TestClient();
    await valClient.initCsrf();
    const valPassword = 'valUserSecurePassword123!';
    const regVal = await valClient.request('POST', '/api/auth/register', {
      username: 'val_user',
      password: valPassword
    });
    assert(regVal.status === 201, 'Validation test user registered successfully');

    // Register Clara with 15+ characters password for subsequent change-password tests
    const userClient = new TestClient();
    await userClient.initCsrf();
    const userInitialPassword = 'originalSecurePassword123!';
    const regUser = await userClient.request('POST', '/api/auth/register', {
      username: 'clara',
      password: userInitialPassword
    });
    assert(regUser.status === 201, 'User clara registered successfully with 15+ char password');
    const claraId = regUser.body.user.id;

    // -------------------------------------------------------------
    console.log('\n3️⃣ Testing Change Password Input Validations');
    // -------------------------------------------------------------
    // Missing fields
    const resMissing = await valClient.request('POST', '/api/auth/change-password', {
      currentPassword: valPassword
    });
    assert(resMissing.status === 400, 'Missing newPassword/confirmPassword returns 400');

    // Confirmation mismatch
    const resMismatch = await valClient.request('POST', '/api/auth/change-password', {
      currentPassword: valPassword,
      newPassword: 'BrandNewPassword123!',
      confirmPassword: 'DifferentPassword123!'
    });
    assert(resMismatch.status === 400, 'Mismatched new password and confirmation returns 400');
    assert(resMismatch.body.error.includes('do not match'), 'Error indicates passwords do not match');

    // New password under 15 characters
    const resTooShort = await valClient.request('POST', '/api/auth/change-password', {
      currentPassword: valPassword,
      newPassword: 'ShortPass1234',
      confirmPassword: 'ShortPass1234'
    });
    assert(resTooShort.status === 400, 'New password under 15 characters returns 400');

    // New password matches current password
    const resSamePassword = await valClient.request('POST', '/api/auth/change-password', {
      currentPassword: valPassword,
      newPassword: valPassword,
      confirmPassword: valPassword
    });
    assert(resSamePassword.status === 400, 'New password matching current password returns 400');
    assert(resSamePassword.body.error.includes('cannot be the same'), 'Error explains new password cannot be current password');

    // Wrong current password
    const resWrongCur = await valClient.request('POST', '/api/auth/change-password', {
      currentPassword: 'wrongCurrentPassword123!',
      newPassword: 'brandNewSecurePassword2026!',
      confirmPassword: 'brandNewSecurePassword2026!'
    });
    assert(resWrongCur.status === 401, 'Wrong current password returns 401 Unauthorized');
    assert(resWrongCur.body.error.includes('Current password is incorrect'), 'Error indicates current password is incorrect');

    // -------------------------------------------------------------
    console.log('\n4️⃣ Testing Successful Password Change (64+ Chars with Spaces)');
    // -------------------------------------------------------------
    // Create a 2nd active session for Clara (e.g. tablet or second browser)
    const secondDevice = new TestClient();
    await secondDevice.initCsrf();
    const loginSecond = await secondDevice.request('POST', '/api/auth/login', {
      username: 'clara',
      password: userInitialPassword
    });
    assert(loginSecond.status === 200, 'Second device logged in successfully');

    const sessionsBefore = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(claraId).c;
    assert(sessionsBefore >= 2, `Clara has multiple active sessions (${sessionsBefore}) before password change`);

    // New password with spaces, punctuation, and >= 64 characters
    const longNewPassword = 'correct horse battery staple - 64+ characters passphrase with spaces for mediavault security!';
    assert(longNewPassword.length >= 64, 'Passphrase length is at least 64 characters');

    const resChangeSuccess = await userClient.request('POST', '/api/auth/change-password', {
      currentPassword: userInitialPassword,
      newPassword: longNewPassword,
      confirmPassword: longNewPassword
    });
    assert(resChangeSuccess.status === 200, 'Password change with 64+ char passphrase returns 200 OK');
    assert(resChangeSuccess.body.success === true, 'Response payload contains success: true');

    // -------------------------------------------------------------
    console.log('\n5️⃣ Testing Atomic Session Revocation & Database Integrity');
    // -------------------------------------------------------------
    // Verify in SQLite: all sessions for Clara are deleted
    const sessionsAfter = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(claraId).c;
    assert(sessionsAfter === 0, 'All sessions for Clara are revoked in SQLite');

    // First client cannot access protected route with old session cookie
    const protectedClient1 = await userClient.request('GET', '/api/media');
    assert(protectedClient1.status === 401, 'First device session cookie is invalidated (401 Unauthorized)');

    // Second device cannot access protected route with previous session cookie
    const protectedClient2 = await secondDevice.request('GET', '/api/media');
    assert(protectedClient2.status === 401, 'Second device session cookie is also invalidated (401 Unauthorized)');

    // Verify user password hash and salt were updated in DB
    const updatedUser = getUserWithCredentials(claraId);
    assert(Boolean(updatedUser.password_hash), 'User has updated password hash in DB');
    const isNewValid = await verifyPassword(longNewPassword, updatedUser.salt, updatedUser.password_hash);
    assert(isNewValid === true, 'Stored hash and salt match the new 64+ character passphrase');
    const isOldValid = await verifyPassword(userInitialPassword, updatedUser.salt, updatedUser.password_hash);
    assert(isOldValid === false, 'Stored hash and salt no longer match the old password');

    // -------------------------------------------------------------
    console.log('\n6️⃣ Testing Login with Old vs New Password');
    // -------------------------------------------------------------
    const loginAttemptOld = await userClient.request('POST', '/api/auth/login', {
      username: 'clara',
      password: userInitialPassword
    });
    assert(loginAttemptOld.status === 401, 'Login with old password is rejected with 401 Unauthorized');

    const loginAttemptNew = await userClient.request('POST', '/api/auth/login', {
      username: 'clara',
      password: longNewPassword
    });
    assert(loginAttemptNew.status === 200, 'Login with new 64+ character passphrase succeeds with 200 OK');

    // Add a media item to prove user account and private records are fully intact
    const addMediaRes = await userClient.request('POST', '/api/media', {
      type: 'movie',
      title: 'Clara Password Test Movie',
      status: 'completed',
      rating: 5
    });
    assert(addMediaRes.status === 201, 'User can add and manage private media after password change');

    // -------------------------------------------------------------
    console.log('\n7️⃣ Testing Rate Limiting on Password Change');
    // -------------------------------------------------------------
    // Max 5 attempts per 5 minutes.
    // 1 successful change was made earlier. Let's make 4 more requests:
    for (let i = 0; i < 4; i++) {
      await userClient.request('POST', '/api/auth/change-password', {
        currentPassword: 'dummyCurrentPassword123!',
        newPassword: 'dummyNewPassword123!',
        confirmPassword: 'dummyNewPassword123!'
      });
    }

    // 6th attempt should hit rate limiter (429)
    const rateLimitedRes = await userClient.request('POST', '/api/auth/change-password', {
      currentPassword: 'dummyCurrentPassword123!',
      newPassword: 'dummyNewPassword123!',
      confirmPassword: 'dummyNewPassword123!'
    });
    assert(rateLimitedRes.status === 429, 'Excessive password change attempts trigger 429 Too Many Requests');
    assert(Boolean(rateLimitedRes.headers['retry-after']), 'Rate limit response includes Retry-After header');

    // -------------------------------------------------------------
    console.log('\n8️⃣ Testing SQLite Transaction Rollback on Failure');
    // -------------------------------------------------------------
    // If updateUserPasswordAndRevokeSessions fails (e.g. non-existent user), it must roll back
    try {
      updateUserPasswordAndRevokeSessions(99999, 'fake_hash', 'fake_salt');
      assert(false, 'Should have thrown error on non-existent user');
    } catch (err) {
      assert(err.message.includes('not found'), 'Transaction threw error and rolled back when user not found');
    }

    console.log('\n====================================================');
    console.log(`🎉 ALL PASSWORD CHANGE TESTS PASSED! (${passed} checks passed, 0 failed)`);
    console.log('====================================================\n');
    process.exit(0);
  } finally {
    if (server) {
      server.close();
    }
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    }
  }
}

runTests().catch(err => {
  console.error('\n❌ Test execution failed with error:', err);
  process.exit(1);
});
