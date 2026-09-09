import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path before importing app or db
const TEST_DB_PATH = path.join(rootDir, 'data', `test_multiuser_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';
process.env.PORT = '3099';
process.env.GEMINI_API_KEY = 'your_gemini_test_key'; // Prevents slow external AI calls in test

// Import app and db after DB_PATH environment variable is configured
const { default: app } = await import('../server.js');
const { db, getUnassignedCounts, assignUnassignedToUser } = await import('../db.js');

// Seed unassigned legacy records into test DB
db.exec(`
  INSERT INTO media_items (type, title, status, rating, user_id)
  VALUES ('movie', 'Legacy Inception', 'completed', 5, NULL),
         ('tv', 'Legacy Breaking Bad', 'watching', 5, NULL);

  INSERT INTO books (title, author, owned, status, rating, user_id)
  VALUES ('Legacy Dune', 'Frank Herbert', 1, 'completed', 5, NULL),
         ('Legacy 1984', 'George Orwell', 1, 'reading', 4, NULL);
`);

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
    // Perform initial GET to obtain mediavault_csrf cookie
    await this.request('GET', '/api/auth/csrf');
  }
}

// Test Runner Helper
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
  console.log('🧪 MediaVault Multi-User Automated Verification Suite');
  console.log('====================================================\n');

  // Start temporary server on dynamic port
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
    const noAuthMedia = await unauthenticated.request('GET', '/api/media');
    assert(noAuthMedia.status === 401, 'Unauthenticated GET /api/media returns 401 Unauthorized');

    const noAuthBooks = await unauthenticated.request('GET', '/api/books');
    assert(noAuthBooks.status === 401, 'Unauthenticated GET /api/books returns 401 Unauthorized');

    const noAuthStats = await unauthenticated.request('GET', '/api/stats');
    assert(noAuthStats.status === 401, 'Unauthenticated GET /api/stats returns 401 Unauthorized');

    // State-changing POST without CSRF token must return 403
    const noCsrfPost = await unauthenticated.request('POST', '/api/auth/register', {
      username: 'attacker',
      password: 'password123'
    }, { 'x-csrf-token': '' }); // omit token
    assert(noCsrfPost.status === 403, 'State-changing POST without CSRF token returns 403 Forbidden');

    // -------------------------------------------------------------
    console.log('\n2️⃣ Testing Registration & Secure Password Hashing');
    // -------------------------------------------------------------
    await alice.initCsrf();
    const regAlice = await alice.request('POST', '/api/auth/register', {
      username: 'alice',
      password: 'alicePassword123'
    });
    assert(regAlice.status === 201, 'Registration of Alice returns 201 Created');
    assert(regAlice.body.user.username === 'alice', 'User object returned with username alice');
    assert(Boolean(alice.cookies['mediavault_sid']), 'Alice receives HttpOnly session cookie');
    const aliceId = regAlice.body.user.id;

    // Verify password is not plaintext in DB
    const aliceDbRecord = db.prepare('SELECT password_hash, salt FROM users WHERE id = ?').get(aliceId);
    assert(aliceDbRecord.password_hash !== 'alicePassword123', 'Password is cryptographically hashed, not plaintext');
    assert(Boolean(aliceDbRecord.salt), 'User has dedicated cryptographic salt');

    // Register Bob
    await bob.initCsrf();
    const regBob = await bob.request('POST', '/api/auth/register', {
      username: 'bob',
      password: 'bobPassword12345'
    });
    assert(regBob.status === 201, 'Registration of Bob returns 201 Created');
    const bobId = regBob.body.user.id;
    assert(bobId !== aliceId, 'Alice and Bob have distinct user IDs');

    // Reject duplicate username
    const regDup = await bob.request('POST', '/api/auth/register', {
      username: 'ALICE', // case-insensitive check
      password: 'somePassword123'
    });
    assert(regDup.status === 409, 'Duplicate username registration returns 409 Conflict');

    // -------------------------------------------------------------
    console.log('\n3️⃣ Testing Session Renewal on Login');
    // -------------------------------------------------------------
    const oldAliceSid = alice.cookies['mediavault_sid'];
    const loginAlice = await alice.request('POST', '/api/auth/login', {
      username: 'alice',
      password: 'alicePassword123'
    });
    assert(loginAlice.status === 200, 'Alice logs in successfully');
    const newAliceSid = alice.cookies['mediavault_sid'];
    assert(newAliceSid !== oldAliceSid, 'New session ID generated upon login (Session Renewal)');
    const oldSessionLookup = db.prepare('SELECT * FROM sessions WHERE id = ?').get(oldAliceSid);
    assert(!oldSessionLookup, 'Previous session ID was invalidated in database');

    // -------------------------------------------------------------
    console.log('\n4️⃣ Testing Legacy Unassigned Record Protection');
    // -------------------------------------------------------------
    // Database has 2 unassigned movies and 2 unassigned books
    const initialUnassigned = getUnassignedCounts();
    assert(initialUnassigned.mediaCount === 2 && initialUnassigned.booksCount === 2, 'Unassigned legacy records exist');

    // Alice queries media: must be empty (0 items), not leaking unassigned records
    const aliceInitialMedia = await alice.request('GET', '/api/media');
    assert(aliceInitialMedia.status === 200 && aliceInitialMedia.body.length === 0, 'Alice cannot see unassigned legacy media');

    const bobInitialBooks = await bob.request('GET', '/api/books');
    assert(bobInitialBooks.status === 200 && bobInitialBooks.body.length === 0, 'Bob cannot see unassigned legacy books');

    // Direct access to legacy record 1 should return 404 for both
    const aliceDirectLegacy = await alice.request('GET', '/api/media/1');
    assert(aliceDirectLegacy.status === 404, 'Direct GET /api/media/1 for unassigned record returns 404');

    const bobModifyLegacy = await bob.request('PUT', '/api/media/1', { title: 'Hijacked' });
    assert(bobModifyLegacy.status === 404, 'Direct PUT /api/media/1 for unassigned record returns 404');

    // -------------------------------------------------------------
    console.log('\n5️⃣ Testing Two-Account Private Library Isolation');
    // -------------------------------------------------------------
    // Alice adds a movie and a book
    const aliceMovieRes = await alice.request('POST', '/api/media', {
      type: 'movie',
      title: 'Alice Private Movie',
      status: 'watching',
      rating: 5
    });
    assert(aliceMovieRes.status === 201, 'Alice adds media item');
    const aliceMovieId = aliceMovieRes.body.id;

    const aliceBookRes = await alice.request('POST', '/api/books', {
      title: 'Alice Private Book',
      author: 'Alice Author',
      owned: 1,
      status: 'reading',
      rating: 4
    });
    assert(aliceBookRes.status === 201, 'Alice adds book');
    const aliceBookId = aliceBookRes.body.id;

    // Bob adds a movie and a book
    const bobMovieRes = await bob.request('POST', '/api/media', {
      type: 'movie',
      title: 'Bob Secret Movie',
      status: 'completed',
      rating: 3
    });
    assert(bobMovieRes.status === 201, 'Bob adds media item');
    const bobMovieId = bobMovieRes.body.id;

    const bobBookRes = await bob.request('POST', '/api/books', {
      title: 'Bob Secret Book',
      author: 'Bob Author',
      owned: 1,
      status: 'completed',
      rating: 5
    });
    assert(bobBookRes.status === 201, 'Bob adds book');
    const bobBookId = bobBookRes.body.id;

    // Alice queries media: must ONLY have Alice Private Movie
    const aliceMediaList = await alice.request('GET', '/api/media');
    assert(aliceMediaList.body.length === 1 && aliceMediaList.body[0].title === 'Alice Private Movie', 'Alice only sees Alice items in media list');

    // Bob queries media: must ONLY have Bob Secret Movie
    const bobMediaList = await bob.request('GET', '/api/media');
    assert(bobMediaList.body.length === 1 && bobMediaList.body[0].title === 'Bob Secret Movie', 'Bob only sees Bob items in media list');

    // Alice queries books: must ONLY have Alice Private Book
    const aliceBooksList = await alice.request('GET', '/api/books');
    assert(aliceBooksList.body.length === 1 && aliceBooksList.body[0].title === 'Alice Private Book', 'Alice only sees Alice items in books list');

    // Bob queries books: must ONLY have Bob Secret Book
    const bobBooksList = await bob.request('GET', '/api/books');
    assert(bobBooksList.body.length === 1 && bobBooksList.body[0].title === 'Bob Secret Book', 'Bob only sees Bob items in books list');

    // -------------------------------------------------------------
    console.log('\n6️⃣ Testing IDOR Prevention (Cross-Account Tampering)');
    // -------------------------------------------------------------
    // Bob attempts to view Alice's movie
    const bobReadAliceMovie = await bob.request('GET', `/api/media/${aliceMovieId}`);
    assert(bobReadAliceMovie.status === 404, 'Bob cannot read Alice movie (404 Not Found)');

    // Bob attempts to edit Alice's movie
    const bobEditAliceMovie = await bob.request('PUT', `/api/media/${aliceMovieId}`, {
      title: 'Tampered by Bob',
      rating: 1
    });
    assert(bobEditAliceMovie.status === 404, 'Bob cannot edit Alice movie (404 Not Found)');

    // Verify Alice's movie is untampered
    const aliceVerifyMovie = await alice.request('GET', `/api/media/${aliceMovieId}`);
    assert(aliceVerifyMovie.body.title === 'Alice Private Movie' && aliceVerifyMovie.body.rating === 5, 'Alice movie remains completely unmodified');

    // Bob attempts to delete Alice's movie
    const bobDeleteAliceMovie = await bob.request('DELETE', `/api/media/${aliceMovieId}`);
    assert(bobDeleteAliceMovie.status === 404, 'Bob cannot delete Alice movie (404 Not Found)');

    // Bob attempts to update reading progress on Alice's book
    const bobProgressAliceBook = await bob.request('POST', `/api/books/${aliceBookId}/progress`, {
      current_page: 999
    });
    assert(bobProgressAliceBook.status === 404, 'Bob cannot update progress on Alice book (404 Not Found)');

    // Bob attempts to delete Alice's book
    const bobDeleteAliceBook = await bob.request('DELETE', `/api/books/${aliceBookId}`);
    assert(bobDeleteAliceBook.status === 404, 'Bob cannot delete Alice book (404 Not Found)');

    // -------------------------------------------------------------
    console.log('\n7️⃣ Testing AI Isolation & Rate Limiting');
    // -------------------------------------------------------------
    // Check getUserLibraryProfile directly to confirm profile separation
    const { getUserLibraryProfile } = await import('../db.js');
    const aliceProfile = getUserLibraryProfile(aliceId);
    const bobProfile = getUserLibraryProfile(bobId);

    assert(aliceProfile.movies.length === 1 && aliceProfile.movies[0].title === 'Alice Private Movie', 'Alice AI profile contains only Alice movie');
    assert(bobProfile.movies.length === 1 && bobProfile.movies[0].title === 'Bob Secret Movie', 'Bob AI profile contains only Bob movie');

    // Test AI endpoint rate limit (configured to 5 requests per window)
    // Make 5 requests (which fail with 503 if GEMINI_API_KEY is not configured or succeed if configured)
    for (let i = 1; i <= 5; i++) {
      await alice.request('POST', '/api/ai/recommendations', { focus: 'all' });
    }
    // 6th request must trigger 429 Too Many Requests
    const rateLimitedRes = await alice.request('POST', '/api/ai/recommendations', { focus: 'all' });
    assert(rateLimitedRes.status === 429, '6th AI request triggers 429 Too Many Requests (Rate Limit Enforced)');
    assert(Boolean(rateLimitedRes.headers['retry-after']), 'Rate limit response includes Retry-After header');

    // -------------------------------------------------------------
    console.log('\n8️⃣ Testing Logout & Invalidation');
    // -------------------------------------------------------------
    const logoutAlice = await alice.request('POST', '/api/auth/logout');
    assert(logoutAlice.status === 200, 'Alice logs out successfully');

    // Subsequent access with old cookie returns 401
    const alicePostLogout = await alice.request('GET', '/api/media');
    assert(alicePostLogout.status === 401, 'Logged-out Alice receives 401 Unauthorized');

    // -------------------------------------------------------------
    console.log('\n9️⃣ Testing Administrative CLI Legacy Claim');
    // -------------------------------------------------------------
    // Assign unassigned legacy records specifically to Bob
    const claimResult = assignUnassignedToUser(bobId);
    assert(claimResult.totalAssigned === 4, 'Legacy claim assigned 4 unassigned records to Bob');

    // Check unassigned counts now: must be 0
    const finalUnassigned = getUnassignedCounts();
    assert(finalUnassigned.total === 0, 'No unassigned records remain after claim');

    // Bob now sees his original 1 movie + 2 claimed legacy movies = 3 movies
    const bobUpdatedMedia = await bob.request('GET', '/api/media');
    assert(bobUpdatedMedia.body.length === 3, 'Bob now sees his original item + 2 claimed legacy items');

    // Re-login Alice and verify Alice STILL has only her 1 movie, none of the claimed legacy items
    await alice.request('POST', '/api/auth/login', {
      username: 'alice',
      password: 'alicePassword123'
    });
    const aliceFinalMedia = await alice.request('GET', '/api/media');
    assert(aliceFinalMedia.body.length === 1, 'Alice does NOT see any of the legacy items claimed by Bob');

    // Re-running claim yields 0 items (idempotent)
    const secondClaim = assignUnassignedToUser(bobId);
    assert(secondClaim.totalAssigned === 0, 'Re-running claim safely assigns 0 items (idempotent)');

    // -------------------------------------------------------------
    console.log('\n🔟 Testing Authentication Rate Limiting');
    // -------------------------------------------------------------
    const bruteClient = new TestClient();
    await bruteClient.initCsrf();
    for (let i = 0; i < 9; i++) {
      await bruteClient.request('POST', '/api/auth/login', {
        username: 'nonexistent_user',
        password: 'wrongPassword123'
      });
    }
    const rateLimitedLogin = await bruteClient.request('POST', '/api/auth/login', {
      username: 'nonexistent_user',
      password: 'wrongPassword123'
    });
    assert(rateLimitedLogin.status === 429, 'Brute-force login attempts trigger 429 Too Many Requests');

    console.log('\n====================================================');
    console.log(`🎉 ALL TESTS PASSED! (${passed} checks passed, 0 failed)`);
    console.log('====================================================\n');
    process.exit(0);
  } finally {
    if (server) {
      server.close();
    }
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    }
  }
}

runTests().catch(err => {
  console.error('\n❌ Test execution failed with error:', err);
  process.exit(1);
});
