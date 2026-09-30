import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('====================================================');
console.log('🧪 MediaVault Redesign Comprehensive Verification');
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

const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(rootDir, 'public', 'app.js'), 'utf8');

console.log('--- 1. Responsive Sidebar Navigation Checks ---');
check('Sidebar is present as left <aside class="app-sidebar">', () => {
  assert(indexHtml.includes('<aside id="nav-collapse-menu" class="app-sidebar nav-collapse-menu"'), 'app-sidebar element missing');
});

check('Navigation labels are text-only with no emoji prefixes', () => {
  const navTabsMatch = indexHtml.match(/<nav class="nav-tabs"[^>]*>([\s\S]*?)<\/nav>/);
  assert(navTabsMatch, 'nav-tabs element missing');
  const navContent = navTabsMatch[1];
  
  // Required labels
  const requiredLabels = [
    'Dashboard', 'Movies', 'TV Series', 'Books',
    'Goals &amp; Planning', 'Calendar', 'Statistics',
    'Discover', 'AI Curator'
  ];
  for (const label of requiredLabels) {
    assert(navContent.includes(label), `Missing label: ${label}`);
  }
  // Ensure no emoji prefixes in tab button texts
  assert(!navContent.includes('🎬 Movies'), 'Movies tab should be text-only');
  assert(!navContent.includes('📺 TV Series'), 'TV Series tab should be text-only');
  assert(!navContent.includes('📖 Books'), 'Books tab should be text-only');
  assert(!navContent.includes('🎯 Goals'), 'Goals tab should be text-only');
  assert(!navContent.includes('🗓️ Calendar'), 'Calendar tab should be text-only');
  assert(!navContent.includes('📊 Statistics'), 'Statistics tab should be text-only');
  assert(!navContent.includes('✨ AI'), 'AI Curator tab should be text-only');
});

check('Brand logo and subtitle preserved in sidebar header', () => {
  assert(indexHtml.includes('class="brand-icon"'), 'Missing brand-icon');
  assert(indexHtml.includes('Media<span>Vault</span>'), 'Missing MediaVault logo text');
  assert(indexHtml.includes('class="brand-sub"'), 'Missing brand subtitle');
});

check('Combined account/username control is placed in sidebar footer with Logout', () => {
  const footerMatch = indexHtml.match(/<div class="sidebar-footer">([\s\S]*?)<\/aside>/);
  assert(footerMatch, 'Missing sidebar-footer in sidebar');
  const footerContent = footerMatch[1];
  assert(footerContent.includes('id="user-auth-controls"'), 'Missing user-auth-controls');
  assert(footerContent.includes('id="btn-user-account"'), 'Missing btn-user-account');
  assert(footerContent.includes('id="user-display-name"'), 'Missing user-display-name');
  assert(footerContent.includes('id="btn-logout"'), 'Missing btn-logout');
});

check('Compact top toolbar contains Sync, Add Item, and notification bell', () => {
  assert(indexHtml.includes('<header class="top-toolbar">'), 'Missing top-toolbar');
  assert(indexHtml.includes('id="btn-sync-tv"'), 'Missing btn-sync-tv');
  assert(indexHtml.includes('id="btn-open-add-modal"'), 'Missing btn-open-add-modal');
  assert(indexHtml.includes('id="nav-notification-wrapper"'), 'Missing notification wrapper');
  assert(indexHtml.includes('id="btn-toggle-notifications"'), 'Missing notification bell button');
});

check('Hamburger toggle button has centered 3-line markup', () => {
  assert(indexHtml.includes('id="btn-nav-toggle"'), 'Missing btn-nav-toggle');
  assert(indexHtml.includes('class="hamburger-box"'), 'Missing hamburger-box');
  const linesCount = (indexHtml.match(/class="hamburger-line"/g) || []).length;
  assert.strictEqual(linesCount, 3, 'Must have exactly 3 hamburger-line spans');
});

console.log('\n--- 2. Priority of Activities & Dashboard Reordering ---');
check('Continue Watching & Continue Reading are placed near top of dashboard', () => {
  const continueIndex = indexHtml.indexOf('id="dash-continue-section"');
  const unwatchedIndex = indexHtml.indexOf('id="dash-new-episodes-section"');
  const statsGridIndex = indexHtml.indexOf('class="stats-grid"');

  assert(continueIndex > 0, 'Missing dash-continue-section');
  assert(unwatchedIndex > 0, 'Missing dash-new-episodes-section');
  assert(statsGridIndex > 0, 'Missing stats-grid');

  assert(continueIndex < unwatchedIndex, 'Continue section must come before unwatched episodes section');
  assert(continueIndex < statsGridIndex, 'Continue section must come before stats grid');
  assert(unwatchedIndex < statsGridIndex, 'Unwatched episodes section must come before stats grid');
});

check('Empty states provide helpful links to library sections', () => {
  assert(appJs.includes("window.switchView('series')"), 'Continue watching empty state links to series');
  assert(appJs.includes("window.switchView('books')"), 'Continue reading empty state links to books');
});

console.log('\n--- 3. Compact Cards & Actions Simplification ---');
check('Dashboard cards use compact horizontal layout with cover beside info', () => {
  assert(stylesCss.includes('.dash-compact-card'), 'Missing .dash-compact-card in CSS');
  assert(stylesCss.includes('.dash-compact-thumb-wrap'), 'Missing .dash-compact-thumb-wrap in CSS');
  assert(stylesCss.includes('.dash-compact-body'), 'Missing .dash-compact-body in CSS');
  assert(stylesCss.includes('.dash-unwatched-grid'), 'Missing .dash-unwatched-grid in CSS');
});

check('Dashboard cards provide clear primary action and three-dot secondary action menu', () => {
  assert(appJs.includes('btn-primary-action'), 'Missing btn-primary-action in app.js');
  assert(appJs.includes('card-action-menu-wrap'), 'Missing card-action-menu-wrap in app.js');
  assert(appJs.includes('btn-card-menu-toggle'), 'Missing btn-card-menu-toggle in app.js');
  assert(appJs.includes('card-action-menu-dropdown'), 'Missing card-action-menu-dropdown in app.js');
  assert(appJs.includes('toggleCardActionMenu'), 'Missing toggleCardActionMenu in app.js');
});

console.log('\n--- 4. Visual Calmness & Styling Restraint ---');
check('Strong orange card glows removed and replaced with subtle borders', () => {
  assert(!stylesCss.includes('box-shadow: 0 0 20px var(--amber-glow);'), 'Strong amber glow on media-card should be removed');
  assert(!stylesCss.includes('box-shadow: 0 0 15px var(--amber-glow);'), 'Amber glow on stat icon should be removed');
  assert(!stylesCss.includes('animation: pulseAmber'), 'Pulsing amber animation should be removed');
});

check('Theme uses dark navy surfaces and restrained purple primary accents', () => {
  assert(stylesCss.includes('--primary: #8b5cf6') || stylesCss.includes('--primary: #7c3aed') || stylesCss.includes('--primary: #6366f1'), 'Purple primary token defined');
  assert(stylesCss.includes('--bg-base: #0b0f19') || stylesCss.includes('#0b0f19'), 'Dark navy background defined');
});

console.log('\n--- 5. Distinguishing Recent Releases from Backlog (7-Day Rule) ---');
check('7-day window rule implemented in app.js without inferring from season diff', () => {
  assert(appJs.includes('isRecentRelease'), 'isRecentRelease function implemented');
  assert(appJs.includes('1000 * 60 * 60 * 24'), 'Day difference calculation implemented');
  assert(appJs.includes('daysDiff <= 7') || appJs.includes('daysDiff < 7'), '7-day window threshold checked');
  assert(!appJs.includes('New Season ${latS} released!'), 'Should not unconditionally call old seasons "New"');
});

check('Unwatched backlog uses neutral wording and matching counts', () => {
  assert(appJs.includes('unwatched'), 'Uses unwatched wording for backlog');
  assert(indexHtml.includes('Series with Unwatched Episodes'), 'Stat card has Series with Unwatched Episodes');
});

console.log('\n--- 6. Responsive Rules & Viewport Adaptability ---');
check('Desktop sidebar fixed at left 250px with content offset', () => {
  assert(stylesCss.includes('.main-content {\n  margin-left: 250px;'), 'Desktop content offset by 250px');
  assert(stylesCss.includes('.app-sidebar {\n  position: fixed;'), 'Sidebar fixed on desktop');
});

check('Mobile drawer collapses off-canvas at <= 1023px with slide-in animation', () => {
  assert(stylesCss.includes('@media (max-width: 1023px)'), 'Mobile breakpoint 1023px defined');
  assert(stylesCss.includes('transform: translateX(-100%);'), 'Off-canvas drawer hides off-screen');
  assert(stylesCss.includes('.app-sidebar.is-open {\n    transform: translateX(0);'), 'Drawer slides in when open');
});

check('Resize handler in app.js uses 1024px breakpoint and restores state', () => {
  assert(appJs.includes('window.innerWidth >= 1024'), 'Resize handler uses 1024 breakpoint');
  assert(appJs.includes('navCollapseMenu?.setAttribute(\'aria-hidden\', \'false\')'), 'Restores aria-hidden on desktop');
});

console.log('\n====================================================');
console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
if (passedChecks === totalChecks) {
  console.log('🎉 ALL REDESIGN VERIFICATION CHECKS PASSED!');
} else {
  console.error('❌ SOME CHECKS FAILED');
  process.exit(1);
}
console.log('====================================================\n');
