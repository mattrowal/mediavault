import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path (runs strictly serverless / offline)
const TEST_DB_PATH = path.join(rootDir, 'data', `test_movie_refresh_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  db,
  initDatabase,
  createUser,
  addMedia,
  getMediaById,
  updateMedia,
  getUserActivities,
  logActivity
} = await import('../db.js');

const {
  searchMovies,
  getMovieDetails,
  setMockMovieSearch,
  setMockMovieDetails,
  setMockMovieError,
  clearMockMovieData
} = await import('../movie-service.js');

const { getPersonalStatistics } = await import('../stats-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Refresh Movie & TMDB Linking Regression Suite');
console.log('   (Serverless: Invoking actual server.js route handler)');
console.log('====================================================\n');

initDatabase();

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

// Extract actual route handler from server.js Express stack
const routeLayer = app._router.stack.find(r => r.route && r.route.path === '/api/media/:id/refresh-movie');
if (!routeLayer) {
  throw new Error('Could not find /api/media/:id/refresh-movie route in server.js');
}
const serverRouteHandler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

// Helper to invoke the real server.js handler directly
async function callServerRefreshMovie(mediaId, userId, body = {}) {
  const req = {
    params: { id: String(mediaId) },
    user: { id: userId },
    body
  };
  let resStatus = 200;
  let resBody = null;
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      resStatus = code;
      return this;
    },
    json(data) {
      this.data = data;
      resBody = data;
      return this;
    }
  };

  await serverRouteHandler(req, res);
  return { status: resStatus, body: resBody };
}

try {
  // Setup users
  const user1 = createUser('movie_tester_1', 'hash123', 'salt123');
  const user2 = createUser('movie_tester_2', 'hash123', 'salt123');

  // Configure mock TMDB movie data
  // 1. Twilight (8966) - runtime 122
  setMockMovieSearch('twilight', {
    results: [
      { id: 8966, title: 'Twilight', release_date: '2008-11-20', overview: 'Vampire romance', poster_path: '/twilight.jpg' }
    ]
  });
  setMockMovieDetails(8966, {
    tmdb_id: 8966,
    title: 'Twilight',
    runtime: 122,
    release_year: '2008',
    poster_url: 'https://image.tmdb.org/t/p/w342/twilight.jpg',
    genre: 'Fantasy, Romance'
  });

  // 2. The Avengers (24428) - runtime 143
  setMockMovieSearch('the avengers', {
    results: [
      { id: 24428, title: 'The Avengers', release_date: '2012-04-25', overview: 'Earth mightiest heroes', poster_path: '/avengers.jpg' }
    ]
  });
  setMockMovieDetails(24428, {
    tmdb_id: 24428,
    title: 'The Avengers',
    runtime: 143,
    release_year: '2012',
    poster_url: 'https://image.tmdb.org/t/p/w342/avengers.jpg',
    genre: 'Action, Sci-Fi'
  });

  // 3. Short Indie Film (99991) - no runtime metadata (null)
  setMockMovieSearch('obscure indie', {
    results: [
      { id: 99991, title: 'Obscure Indie', release_date: '2025-01-01', overview: 'No runtime film' }
    ]
  });
  setMockMovieDetails(99991, {
    tmdb_id: 99991,
    title: 'Obscure Indie',
    runtime: null,
    release_year: '2025'
  });

  // Setup initial library:
  // Movie 1: Twilight (unlinked, completed, runtime null, rating 4, notes "Loved it")
  const movie1 = addMedia({
    title: 'Twilight',
    type: 'movie',
    status: 'completed',
    external_id: null,
    runtime: null,
    rating: 4,
    notes: 'Loved it'
  }, user1.id);

  // Existing viewing activity with minutes_viewed = 0
  logActivity({
    userId: user1.id,
    activityType: 'movie_watched',
    itemType: 'movie',
    itemId: movie1.id,
    minutesViewed: 0,
    createdAt: '2026-02-01 20:00:00'
  });

  console.log('--- Suite 1: Regression Test for "db is not defined" & Real Route Execution ---');

  await asyncCheck('Calling server.js refresh-movie route succeeds without "db is not defined" error', async () => {
    const res = await callServerRefreshMovie(movie1.id, user1.id, { tmdb_id: 8966 });

    // Assert that the response is NOT an error (specifically not "db is not defined")
    assert.strictEqual(res.status, 200, `Expected 200 OK but received ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.movie, 'Response should contain updated movie');
    assert.strictEqual(res.body.movie.external_id, '8966');
    assert.strictEqual(res.body.movie.runtime, 122);
    assert.strictEqual(res.body.movie.rating, 4, 'Rating preserved');
    assert.strictEqual(res.body.movie.notes, 'Loved it', 'Notes preserved');
    assert.strictEqual(res.body.movie.status, 'completed', 'Status preserved');
  });

  await asyncCheck('Linking updates activity_log minutes_viewed without creating duplicate viewing events', async () => {
    const acts = getUserActivities(user1.id);
    const movieActs = acts.filter(a => a.item_id === movie1.id);
    assert.strictEqual(movieActs.length, 1, 'Must have exactly 1 activity log entry (no duplicate created)');
    assert.strictEqual(movieActs[0].minutes_viewed, 122, 'Existing activity minutes updated to 122');
    assert.strictEqual(movieActs[0].created_at, '2026-02-01 20:00:00', 'Original timestamp preserved');
  });

  await asyncCheck('Viewing statistics reflect the newly linked movie runtime', async () => {
    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.summary.moviesWatched, 1);
    assert.strictEqual(stats.viewingTime.movies.minutes, 122);
    assert.strictEqual(stats.missingMetadata.missingMovieRuntimes, 0);
  });

  console.log('\n--- Suite 2: Idempotency & Repeated Refreshes ---');

  await asyncCheck('Repeating refresh on already-linked movie is idempotent and does not duplicate records or time', async () => {
    const res = await callServerRefreshMovie(movie1.id, user1.id, {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.movie.runtime, 122);

    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.viewingTime.movies.minutes, 122);
    assert.strictEqual(stats.summary.moviesWatched, 1);

    const acts = getUserActivities(user1.id);
    assert.strictEqual(acts.filter(a => a.item_id === movie1.id).length, 1, 'No duplicate activity log');
  });

  console.log('\n--- Suite 3: Manual Runtime Override Preservation ---');

  await asyncCheck('Manual runtime override is preserved across future TMDB refreshes', async () => {
    // User sets manual override: 130 mins
    updateMedia(movie1.id, user1.id, { runtime: 130, is_runtime_manual: 1 });

    const overrideStats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(overrideStats.viewingTime.movies.minutes, 130);

    // Refresh from TMDB
    const res = await callServerRefreshMovie(movie1.id, user1.id, {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.manual_runtime_preserved, true);
    assert.strictEqual(res.body.movie.runtime, 130, 'Manual runtime 130m must be preserved');

    const afterRefreshStats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(afterRefreshStats.viewingTime.movies.minutes, 130);
  });

  console.log('\n--- Suite 4: TMDB Movie Without Runtime Metadata ---');

  await asyncCheck('Linking to TMDB entry without runtime saves ID but keeps runtime unknown in statistics', async () => {
    const obscureMovie = addMedia({
      title: 'Obscure Indie',
      type: 'movie',
      status: 'completed',
      external_id: null,
      runtime: null
    }, user1.id);

    const res = await callServerRefreshMovie(obscureMovie.id, user1.id, { tmdb_id: 99991 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.movie.external_id, '99991');
    assert.strictEqual(res.body.movie.runtime, null, 'Runtime is null when TMDB lacks runtime');

    const stats = await getPersonalStatistics(user1.id, 'all_time');
    assert.strictEqual(stats.missingMetadata.missingMovieRuntimes, 1, 'Clearly identified as missing runtime');
  });

  console.log('\n--- Suite 5: Error Handling Without Corrupting Data ---');

  await asyncCheck('TMDB API failure returns 502 and leaves existing saved metadata intact', async () => {
    setMockMovieError('500 Internal Server Error from TMDB');

    const res = await callServerRefreshMovie(movie1.id, user1.id, {});
    assert.strictEqual(res.status, 502);
    assert.ok(res.body.error.includes('Could not reach TMDB API'));

    // Verify existing movie data preserved
    const current = getMediaById(movie1.id, user1.id);
    assert.strictEqual(current.runtime, 130);
    assert.strictEqual(current.external_id, '8966');

    clearMockMovieData();
  });

  console.log('\n--- Suite 6: Account Isolation & Duplicate Prevention ---');

  await asyncCheck('User 2 cannot refresh or link User 1 movie (404/unauthorized)', async () => {
    const res = await callServerRefreshMovie(movie1.id, user2.id, { tmdb_id: 8966 });
    assert.strictEqual(res.status, 404);
  });

  await asyncCheck('Duplicate prevention rejects linking if user already has movie with same TMDB ID (409)', async () => {
    // Add second movie for user 1
    const movie2 = addMedia({
      title: 'Another Movie',
      type: 'movie',
      status: 'plan_to_watch',
      external_id: null
    }, user1.id);

    // Try linking movie2 to 8966 (which movie1 already has)
    const res = await callServerRefreshMovie(movie2.id, user1.id, { tmdb_id: 8966 });
    assert.strictEqual(res.status, 409);
    assert.ok(res.body.error.includes('already in your library'));
  });

} finally {
  clearMockMovieData();
  try {
    db.close();
  } catch {}
  if (fs.existsSync(TEST_DB_PATH)) {
    try {
      fs.unlinkSync(TEST_DB_PATH);
    } catch {}
  }
}

console.log('\n====================================================');
console.log(`Test Results: ${passedChecks} / ${totalChecks} passed`);
console.log('====================================================\n');

if (passedChecks < totalChecks) {
  process.exit(1);
}
