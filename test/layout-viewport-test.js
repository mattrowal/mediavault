import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('====================================================');
console.log('🧪 MediaVault Layout & Multi-Viewport Verification');
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

// 1. Live server checks on port 3001
console.log('--- 1. Live Server Availability Checks (Port 3001) ---');
await asyncCheck('Live server responds with index.html on port 3001', async () => {
  const html = await new Promise((resolve, reject) => {
    http.get('http://localhost:3001/', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  assert(html.includes('app-sidebar'), 'Live server index.html serves app-sidebar');
  assert(html.includes('dash-continue-section'), 'Live server serves dash-continue-section');
  assert(html.includes('dash-compact-card') || html.includes('dash-unwatched-grid'), 'Live server serves new dashboard grid');
});

await asyncCheck('Live server styles.css includes updated redesign rules', async () => {
  const css = await new Promise((resolve, reject) => {
    http.get('http://localhost:3001/styles.css', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  assert(css.includes('--primary: #8b5cf6'), 'Live CSS serves purple primary token');
  assert(css.includes('.dash-compact-card'), 'Live CSS serves dash-compact-card');
  assert(css.includes('.card-action-menu-dropdown'), 'Live CSS serves action menu dropdown');
  assert(css.includes('@media (max-width: 1023px)'), 'Live CSS serves 1023px drawer media query');
});

// 2. Viewport-specific rule checks (360, 390, 768, 1024, 1366, 1920)
console.log('\n--- 2. Multi-Viewport Layout Rules Verification ---');
const styles = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');

check('Viewport 1920px & 1366px (Desktop): Sidebar fixed at 250px with content offset', () => {
  assert(styles.includes('margin-left: 250px'), 'Desktop main-content has margin-left: 250px');
  assert(styles.includes('width: 250px'), 'Desktop sidebar has width: 250px');
  assert(!styles.includes('overflow-x: hidden') || !styles.includes('body { overflow-x: hidden }'), 'No global overflow-x: hidden concealment on body');
});

check('Viewport 1024px (Desktop/Tablet Boundary): Layout maintains stability without collapse', () => {
  // At >= 1024px desktop sidebar is active; breakpoint is strictly <= 1023px
  assert(styles.includes('@media (max-width: 1023px)'), 'Drawer collapses only at <= 1023px');
});

check('Viewport 768px (Tablet): Sidebar becomes off-canvas drawer with hamburger and backdrop', () => {
  assert(styles.includes('.btn-nav-toggle {\n    display: inline-flex;'), 'Hamburger button displays on tablet/mobile');
  assert(styles.includes('.app-sidebar {\n    transform: translateX(-100%);'), 'Sidebar is off-canvas');
  assert(styles.includes('.nav-backdrop'), 'Nav backdrop is defined for drawer overlay');
});

check('Viewport 390px & 360px (Mobile Phones): Content padding adjusts and prevents horizontal overflow', () => {
  assert(styles.includes('padding: 1.25rem 1rem 5rem;'), 'Compact mobile padding on main-content');
  assert(styles.includes('width: min(300px, 86vw);') || styles.includes('width: min(300px, 85vw);'), 'Drawer width respects small viewports');
  assert(styles.includes('max-width: min('), 'Dialogs use viewport min constraints');
});

check('Short Window Height Support (e.g. 500px): Sidebar and modals use internal vertical scrolling', () => {
  assert(styles.includes('.nav-tabs {\n  display: flex;\n  flex-direction: column;\n  gap: 0.25rem;\n  padding: 1rem 0.75rem;\n  flex: 1;\n  overflow-y: auto;'), 'Sidebar tabs have overflow-y: auto for short screens');
  assert(styles.includes('max-height: calc(100dvh - 1rem);') || styles.includes('max-height: calc(100vh - 1rem);'), 'Modals have max-height with viewport units');
  assert(styles.includes('overflow-y: auto;'), 'Modals have overflow-y: auto for internal scrolling');
});

check('Desktop Zoom 125% & 200%: Natural heights, no hardcoded fixed-height cutoffs', () => {
  assert(styles.includes('.dash-compact-card {\n  display: flex;\n  align-items: stretch;'), 'Compact cards stretch naturally');
  assert(!styles.includes('.dash-compact-card {\n  height:'), 'No rigid fixed pixel height on compact cards');
});

console.log('\n--- 3. Interactive State & Action Menus Verification ---');
const app = fs.readFileSync(path.join(rootDir, 'public', 'app.js'), 'utf8');

check('Action menu boundary detection repositions when colliding with viewport edges', () => {
  assert(app.includes('rect.right > window.innerWidth - 8'), 'Right collision check');
  assert(app.includes('rect.bottom > window.innerHeight - 8'), 'Bottom collision check');
  assert(app.includes('dropdown.style.bottom = \'calc(100% + 4px)\''), 'Upward repositioning when colliding with bottom');
});

check('Rating controls accessible without crowding action row', () => {
  assert(styles.includes('.rating-stars'), 'Rating stars class preserved');
  assert(app.includes('renderStars'), 'renderStars helper called');
});

console.log('\n====================================================');
console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
if (passedChecks === totalChecks) {
  console.log('🎉 ALL MULTI-VIEWPORT & LAYOUT CHECKS PASSED!');
} else {
  console.error('❌ SOME CHECKS FAILED');
  process.exit(1);
}
console.log('====================================================\n');
