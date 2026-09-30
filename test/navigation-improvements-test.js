import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dedicated unique test database path
const TEST_DB_PATH = path.join(rootDir, 'data', `test_nav_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const { default: app } = await import('../server.js');
const {
  createUser,
  addMedia,
  updateMedia,
  addBook,
  getAllMedia,
  getAllBooks,
  getDashboardStats
} = await import('../db.js');

console.log('====================================================');
console.log('🧪 MediaVault Navigation Improvements Test Suite');
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

async function runTests() {
  console.log('--- 1. Navigation Markup & Structure Checks ---');
  const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

  check('Navbar has separated Movies and TV Series tabs', () => {
    assert(indexHtml.includes('id="tab-movies"'), 'Missing #tab-movies');
    assert(indexHtml.includes('data-view="movies"'), 'Missing data-view="movies"');
    assert(indexHtml.includes('id="tab-series"'), 'Missing #tab-series');
    assert(indexHtml.includes('data-view="series"'), 'Missing data-view="series"');
    assert(!indexHtml.includes('id="tab-media"'), 'Old #tab-media should be replaced');
  });

  check('Navbar has combined Goals & Planning top-level tab', () => {
    assert(indexHtml.includes('id="tab-goals-planning"'), 'Missing #tab-goals-planning');
    assert(indexHtml.includes('data-view="goals-planning"'), 'Missing data-view="goals-planning"');
    // Ensure old separate top-level tabs in main nav are replaced
    const navTabsMatch = indexHtml.match(/<nav class="nav-tabs"[^>]*>([\s\S]*?)<\/nav>/);
    assert(navTabsMatch, 'Could not find nav-tabs in index.html');
    const navTabsContent = navTabsMatch[1];
    assert(!navTabsContent.includes('id="tab-goals"'), 'Top nav should not contain separate tab-goals');
    assert(!navTabsContent.includes('id="tab-planner"'), 'Top nav should not contain separate tab-planner');
  });

  check('Goals & Planning view contains subnav tabs and panes', () => {
    assert(indexHtml.includes('id="view-goals-planning"'), 'Missing #view-goals-planning');
    assert(indexHtml.includes('id="subtab-goals"'), 'Missing #subtab-goals');
    assert(indexHtml.includes('id="subtab-planner"'), 'Missing #subtab-planner');
    assert(indexHtml.includes('id="pane-goals"'), 'Missing #pane-goals');
    assert(indexHtml.includes('id="pane-planner"'), 'Missing #pane-planner');
    // Preserve data containers
    assert(indexHtml.includes('id="goals-cards-grid"'), 'Preserved goals cards grid');
    assert(indexHtml.includes('id="saved-plans-list"'), 'Preserved saved plans list');
  });

  check('Separate view sections exist for Movies and TV Series', () => {
    assert(indexHtml.includes('id="view-movies"'), 'Missing #view-movies');
    assert(indexHtml.includes('id="movies-cards-container"'), 'Missing #movies-cards-container');
    assert(indexHtml.includes('id="filter-movies-status"'), 'Missing #filter-movies-status');
    assert(indexHtml.includes('id="search-movies-input"'), 'Missing #search-movies-input');

    assert(indexHtml.includes('id="view-series"'), 'Missing #view-series');
    assert(indexHtml.includes('id="series-cards-container"'), 'Missing #series-cards-container');
    assert(indexHtml.includes('id="filter-series-status"'), 'Missing #filter-series-status');
    assert(indexHtml.includes('id="search-series-input"'), 'Missing #search-series-input');
  });

  check('Dashboard summary cards are accessible buttons with keyboard support', () => {
    const cardIds = [
      'stat-card-episodes',
      'stat-card-active-series',
      'stat-card-watched-movies',
      'stat-card-books-owned',
      'stat-card-unread-owned',
      'stat-card-books-read'
    ];

    for (const id of cardIds) {
      assert(indexHtml.includes(`id="${id}"`), `Missing card with id="${id}"`);
      const regex = new RegExp(`<button[^>]*id="${id}"[^>]*>`, 'i');
      assert(regex.test(indexHtml), `Card #${id} is not an accessible button`);
    }
  });

  console.log('\n--- 2. Database Filter & Count Destination Matching ---');
  const userAlice = createUser('alice_nav_test_' + Date.now(), 'dummy_password_hash_123', 'dummy_salt_456');

  // Seed sample data for Alice
  // 1. Movie watched
  addMedia({
    type: 'movie',
    title: 'Inception',
    status: 'completed',
    rating: 5
  }, userAlice.id);

  // 2. Movie plan_to_watch
  addMedia({
    type: 'movie',
    title: 'Interstellar',
    status: 'plan_to_watch',
    rating: 0
  }, userAlice.id);

  // 3. TV Series active with new episodes
  addMedia({
    type: 'tv',
    title: 'Severance',
    status: 'watching',
    current_season: 1,
    current_episode: 3,
    latest_season: 1,
    latest_episode: 9
  }, userAlice.id);

  // 4. TV Series active but caught up (no new episodes)
  addMedia({
    type: 'tv',
    title: 'Succession',
    status: 'watching',
    current_season: 4,
    current_episode: 10,
    latest_season: 4,
    latest_episode: 10
  }, userAlice.id);

  // 5. TV Series completed
  addMedia({
    type: 'tv',
    title: 'Breaking Bad',
    status: 'completed',
    current_season: 5,
    current_episode: 16,
    latest_season: 5,
    latest_episode: 16
  }, userAlice.id);

  // 6. Book owned at home and unread
  addBook({
    title: 'Dune',
    author: 'Frank Herbert',
    owned: 1,
    status: 'unread',
    page_count: 500,
    current_page: 0
  }, userAlice.id);

  // 7. Book owned at home and reading (not completed)
  addBook({
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    owned: 1,
    status: 'reading',
    page_count: 480,
    current_page: 120
  }, userAlice.id);

  // 8. Book owned at home and completed
  addBook({
    title: 'Neuromancer',
    author: 'William Gibson',
    owned: 1,
    status: 'completed',
    page_count: 320,
    current_page: 320
  }, userAlice.id);

  // 9. Book not owned and unread
  addBook({
    title: 'Foundation',
    author: 'Isaac Asimov',
    owned: 0,
    status: 'unread',
    page_count: 250,
    current_page: 0
  }, userAlice.id);

  const stats = getDashboardStats(userAlice.id);

  check('Dashboard card 1 (Series with New Episodes) matches destination query count', () => {
    const cardCount = stats.series.withNewEpisodesCount;
    const destList = getAllMedia(userAlice.id, { type: 'tv', status: 'new_episodes' });
    assert.strictEqual(cardCount, 1, 'Expected 1 series with new episodes');
    assert.strictEqual(destList.length, cardCount, 'Destination list count must match card count');
    assert.strictEqual(destList[0].title, 'Severance');
  });

  check('Dashboard card 2 (Active Series) matches destination query count', () => {
    const cardCount = stats.series.activeWatching;
    const destList = getAllMedia(userAlice.id, { type: 'tv', status: 'watching' });
    assert.strictEqual(cardCount, 2, 'Expected 2 active series (Severance + Succession)');
    assert.strictEqual(destList.length, cardCount, 'Destination list count must match card count');
  });

  check('Dashboard card 3 (Watched Movies) matches destination query count', () => {
    const cardCount = stats.movies.completed;
    const destList = getAllMedia(userAlice.id, { type: 'movie', status: 'completed' });
    assert.strictEqual(cardCount, 1, 'Expected 1 watched movie (Inception)');
    assert.strictEqual(destList.length, cardCount, 'Destination list count must match card count');
    assert.strictEqual(destList[0].title, 'Inception');
  });

  check('Dashboard card 4 (Books Owned at Home) matches destination query count', () => {
    const cardCount = stats.books.owned;
    const destList = getAllBooks(userAlice.id, { owned: 1, status: 'all' });
    assert.strictEqual(cardCount, 3, 'Expected 3 owned books');
    assert.strictEqual(destList.length, cardCount, 'Destination list count must match card count');
  });

  check('Dashboard card 5 (Owned & Unread TBR) matches destination query count using status != completed rule', () => {
    const cardCount = stats.books.ownedUnread;
    const destList = getAllBooks(userAlice.id, { owned: 1, status: 'not_completed' });
    assert.strictEqual(cardCount, 2, 'Expected 2 owned unread books (Dune unread + Project Hail Mary reading)');
    assert.strictEqual(destList.length, cardCount, 'Destination list count must match card count');
    assert(destList.some(b => b.title === 'Dune'));
    assert(destList.some(b => b.title === 'Project Hail Mary'));
  });

  check('Dashboard card 6 (Books Read) matches destination query count', () => {
    const cardCount = stats.books.completed;
    const destList = getAllBooks(userAlice.id, { owned: 'all', status: 'completed' });
    assert.strictEqual(cardCount, 1, 'Expected 1 completed book (Neuromancer)');
    assert.strictEqual(destList.length, cardCount, 'Destination list count must match card count');
    assert.strictEqual(destList[0].title, 'Neuromancer');
  });

  console.log('\n--- 3. Styles & CSS Overflow Checks ---');
  const stylesCss = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');

  check('CSS defines button.stat-card reset and focus-visible outlines', () => {
    assert(stylesCss.includes('button.stat-card'), 'Missing button.stat-card rule');
    assert(stylesCss.includes('.stat-card:focus-visible'), 'Missing .stat-card:focus-visible');
    assert(stylesCss.includes('.card-chevron'), 'Missing .card-chevron');
  });

  check('CSS defines Goals & Planning subnav styles', () => {
    assert(stylesCss.includes('.subnav-tabs'), 'Missing .subnav-tabs');
    assert(stylesCss.includes('.subnav-btn'), 'Missing .subnav-btn');
    assert(stylesCss.includes('.subnav-pane'), 'Missing .subnav-pane');
  });

  check('CSS defines responsive navigation rules to prevent horizontal overflow', () => {
    assert(stylesCss.includes('white-space: nowrap'), 'tab-btn has white-space nowrap');
    assert(stylesCss.includes('overflow-x: auto'), 'nav-tabs has overflow-x auto for mobile');
  });

  console.log('\n====================================================');
  console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
  if (passedChecks === totalChecks) {
    console.log('🎉 ALL NAVIGATION IMPROVEMENTS TESTS PASSED!');
  } else {
    console.error('❌ SOME CHECKS FAILED');
    process.exit(1);
  }
  console.log('====================================================\n');

  // Clean up test DB
  try {
    fs.unlinkSync(TEST_DB_PATH);
  } catch (_) {}
}

runTests().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
