import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path before importing app or db
const TEST_DB_PATH = path.join(rootDir, 'data', `test_assistant_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';
process.env.PORT = '3199';
process.env.GEMINI_API_KEY = 'your_gemini_test_key'; // Keeps external AI fallback active without hang

const { default: app } = await import('../server.js');
const { db, addBook, addMedia } = await import('../db.js');
const { executeServerTool, handleAssistantChat } = await import('../assistant.js');

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
  console.log('🧪 MediaVault AI Assistant Automated Verification Suite');
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
    const noAuthChat = await unauthenticated.request('POST', '/api/ai/assistant/chat', {
      query: 'Which books do I have?'
    });
    assert(noAuthChat.status === 403 || noAuthChat.status === 401, 'Unauthenticated POST without CSRF is rejected (403/401)');

    await unauthenticated.initCsrf();
    const noAuthWithCsrf = await unauthenticated.request('POST', '/api/ai/assistant/chat', {
      query: 'Which books do I have?'
    });
    assert(noAuthWithCsrf.status === 401, 'Unauthenticated request with valid CSRF returns 401 Unauthorized');

    // Register Alice & Bob
    await alice.initCsrf();
    const regAlice = await alice.request('POST', '/api/auth/register', {
      username: 'assistant_alice',
      password: 'aliceSecurePassword123'
    });
    assert(regAlice.status === 201, 'Alice registered successfully');
    const aliceId = regAlice.body.user.id;

    await bob.initCsrf();
    const regBob = await bob.request('POST', '/api/auth/register', {
      username: 'assistant_bob',
      password: 'bobSecurePassword123'
    });
    assert(regBob.status === 201, 'Bob registered successfully');
    const bobId = regBob.body.user.id;

    // Seed library items for Alice and Bob
    addBook({
      title: 'Alice Secret Diary',
      author: 'Alice Author',
      owned: 1,
      status: 'unread',
      page_count: 220,
      format: 'Paperback'
    }, aliceId);

    addBook({
      title: 'Alice Read History',
      author: 'Historian',
      owned: 1,
      status: 'completed',
      page_count: 500,
      format: 'Hardcover'
    }, aliceId);

    addMedia({
      type: 'movie',
      title: 'Alice Favorite Sci-Fi',
      genre: 'Sci-Fi',
      status: 'watching',
      rating: 5
    }, aliceId);

    addBook({
      title: 'Bob Private Journal',
      author: 'Bob Author',
      owned: 0,
      status: 'unread',
      page_count: 350,
      format: 'E-Book'
    }, bobId);

    addMedia({
      type: 'tv',
      title: 'Bob Exclusive Thriller',
      genre: 'Thriller',
      status: 'watching',
      current_season: 2,
      current_episode: 4
    }, bobId);

    // -------------------------------------------------------------
    console.log('\n2️⃣ Testing Controlled Server Tool Isolation (Direct Execution)');
    // -------------------------------------------------------------
    // Alice runs getUserBooks
    const aliceBooksResult = await executeServerTool('getUserBooks', { status: 'all' }, aliceId);
    assert(aliceBooksResult.facts.length === 2, 'Alice has exactly 2 books retrieved');
    assert(aliceBooksResult.facts.every(b => b.title.startsWith('Alice')), 'All books returned belong to Alice');
    assert(!aliceBooksResult.facts.some(b => b.title.includes('Bob')), 'Bob private journal is NEVER present in Alice query');

    // Bob runs getUserBooks
    const bobBooksResult = await executeServerTool('getUserBooks', { status: 'all' }, bobId);
    assert(bobBooksResult.facts.length === 1, 'Bob has exactly 1 book retrieved');
    assert(bobBooksResult.facts[0].title === 'Bob Private Journal', 'Bob book retrieved correctly');
    assert(!bobBooksResult.facts.some(b => b.title.includes('Alice')), 'Alice books are NEVER present in Bob query');

    // Bob runs getUserMedia
    const bobMediaResult = await executeServerTool('getUserMedia', { type: 'all' }, bobId);
    assert(bobMediaResult.facts.length === 1, 'Bob has exactly 1 media item');
    assert(bobMediaResult.facts[0].title === 'Bob Exclusive Thriller', 'Bob thriller returned correctly');
    assert(!bobMediaResult.facts.some(m => m.title.includes('Alice')), 'Alice media is NEVER present in Bob query');

    // Alice runs getLibrarySummary
    const aliceSummary = await executeServerTool('getLibrarySummary', {}, aliceId);
    assert(aliceSummary.result.books.total === 2, 'Alice summary shows 2 books');
    assert(aliceSummary.result.movies.total === 1, 'Alice summary shows 1 movie');
    assert(aliceSummary.result.series.activeWatching === 0, 'Alice has 0 active TV series');

    // -------------------------------------------------------------
    console.log('\n3️⃣ Testing Input Sanitization & SQL Injection Defense in Tools');
    // -------------------------------------------------------------
    // Attempt SQL injection in search filter
    const sqliAttempt = await executeServerTool('getUserBooks', {
      search: "' OR 1=1 --",
      status: 'all'
    }, aliceId);
    assert(sqliAttempt.facts.length === 0, 'SQL injection attempt in search filter returns 0 matches (treated literally)');

    // Attempt SQL injection in status filter
    const sqliStatus = await executeServerTool('getUserBooks', {
      status: "unread' OR '1'='1"
    }, aliceId);
    assert(sqliStatus.facts.length === 0, 'SQL injection attempt in status returns 0 matches');

    // Unauthenticated tool call throws
    let threwWithoutUser = false;
    try {
      await executeServerTool('getUserBooks', {}, null);
    } catch {
      threwWithoutUser = true;
    }
    assert(threwWithoutUser, 'Calling executeServerTool without userId throws authorization error');

    // Unknown tool throws
    let threwUnknown = false;
    try {
      await executeServerTool('dropDatabase', {}, aliceId);
    } catch {
      threwUnknown = true;
    }
    assert(threwUnknown, 'Calling unknown tool name throws error');

    // -------------------------------------------------------------
    console.log('\n4️⃣ Testing Endpoint Input Validation');
    // -------------------------------------------------------------
    const emptyQuery = await alice.request('POST', '/api/ai/assistant/chat', { query: '' });
    assert(emptyQuery.status === 400, 'Empty query returns 400 Bad Request');

    const whitespaceQuery = await alice.request('POST', '/api/ai/assistant/chat', { query: '   ' });
    assert(whitespaceQuery.status === 400, 'Whitespace query returns 400 Bad Request');

    const giantQuery = await alice.request('POST', '/api/ai/assistant/chat', { query: 'x'.repeat(1001) });
    assert(giantQuery.status === 400, 'Query over 1000 characters returns 400 Bad Request');

    // -------------------------------------------------------------
    console.log('\n5️⃣ Testing Live Assistant Chat Endpoint Response Structure');
    // -------------------------------------------------------------
    const chatRes = await alice.request('POST', '/api/ai/assistant/chat', {
      query: 'Which of my unread books would suit a weekend read?'
    });
    assert(chatRes.status === 200, 'Valid assistant query returns 200 OK');
    assert(chatRes.body.success === true, 'Response contains success: true');
    assert(typeof chatRes.body.answer === 'string' && chatRes.body.answer.length > 0, 'Response contains answer text');
    assert(Array.isArray(chatRes.body.facts), 'Response contains facts array');
    assert(Array.isArray(chatRes.body.toolsCalled), 'Response contains toolsCalled array');

    // Verify Bob's data was not leaked in Alice's response facts
    if (chatRes.body.facts.length > 0) {
      assert(chatRes.body.facts.every(f => !f.title.includes('Bob')), 'Returned facts strictly exclude Bob data');
    }

    // -------------------------------------------------------------
    console.log('\n6️⃣ Testing Rate Limiting on Assistant Endpoint');
    // -------------------------------------------------------------
    let gotRateLimited = false;
    for (let i = 0; i < 16; i++) {
      const res = await alice.request('POST', '/api/ai/assistant/chat', {
        query: `Question ${i}`
      });
      if (res.status === 429) {
        gotRateLimited = true;
        assert(Boolean(res.headers['retry-after']), 'Rate limit response includes Retry-After header');
        break;
      }
    }
    assert(gotRateLimited, 'Submitting excessive queries triggers 429 Too Many Requests');

    console.log('\n====================================================');
    console.log(`🎉 ALL AI ASSISTANT TESTS PASSED! (${passed} checks passed, ${failed} failed)`);
    console.log('====================================================\n');
  } finally {
    if (server) {
      server.close();
    }
    // Clean up test database file
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
