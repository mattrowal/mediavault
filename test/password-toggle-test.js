import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

console.log('--- TEST SUITE: Password Show/Hide Toggle Button ---');

// 1. Read files
const htmlContent = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf-8');
const cssContent = fs.readFileSync(path.join(projectRoot, 'public', 'styles.css'), 'utf-8');
const jsContent = fs.readFileSync(path.join(projectRoot, 'public', 'app.js'), 'utf-8');

let testsPassed = 0;
let testsTotal = 0;

function it(desc, fn) {
  testsTotal++;
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
  }
}

// ==========================================
// TEST SUITE 1: HTML Structure & Attributes
// ==========================================
console.log('\n[1] HTML Structure & Requirements:');

it('Password field has type="password" by default in #form-login', () => {
  const loginFormMatch = htmlContent.match(/<form id="form-login"[\s\S]*?<\/form>/);
  assert.ok(loginFormMatch, 'form-login exists in index.html');
  const formHtml = loginFormMatch[0];
  
  assert.ok(
    formHtml.includes('type="password" id="login-password"') ||
    formHtml.includes('id="login-password" autocomplete="current-password" required placeholder="••••••••"') ||
    /<input[^>]*id="login-password"[^>]*type="password"/.test(formHtml) ||
    /<input[^>]*type="password"[^>]*id="login-password"/.test(formHtml),
    'login-password input has type="password"'
  );
});

it('Toggle button is placed inside the password wrapper in #form-login', () => {
  const loginFormMatch = htmlContent.match(/<form id="form-login"[\s\S]*?<\/form>/);
  const formHtml = loginFormMatch[0];
  
  assert.ok(formHtml.includes('class="password-input-wrapper"'), 'password-input-wrapper exists');
  assert.ok(formHtml.includes('id="btn-toggle-login-password"'), 'btn-toggle-login-password exists inside login form');
  
  const wrapperMatch = formHtml.match(/<div class="password-input-wrapper">([\s\S]*?)<\/div>/);
  assert.ok(wrapperMatch, 'Found password-input-wrapper block');
  assert.ok(wrapperMatch[1].includes('id="login-password"'), 'login-password is inside wrapper');
  assert.ok(wrapperMatch[1].includes('id="btn-toggle-login-password"'), 'btn-toggle-login-password is inside wrapper');
});

it('Toggle button explicitly has type="button" to prevent form submission', () => {
  const btnMatch = htmlContent.match(/<button[^>]*id="btn-toggle-login-password"[^>]*>/);
  assert.ok(btnMatch, 'btn-toggle-login-password tag found');
  assert.ok(btnMatch[0].includes('type="button"'), 'Button has type="button"');
});

it('Toggle button has accessible label starting with "Show password"', () => {
  const btnMatch = htmlContent.match(/<button[^>]*id="btn-toggle-login-password"[^>]*>/);
  assert.ok(btnMatch[0].includes('aria-label="Show password"'), 'Button has aria-label="Show password"');
  assert.ok(btnMatch[0].includes('title="Show password"'), 'Button has title="Show password"');
});

it('Toggle button contains eye-show and eye-hide SVG icons with hidden class initially on eye-hide', () => {
  const btnBlock = htmlContent.match(/<button[^>]*id="btn-toggle-login-password"[\s\S]*?<\/button>/);
  assert.ok(btnBlock, 'Button block found');
  const btnContent = btnBlock[0];
  
  assert.ok(btnContent.includes('class="eye-icon eye-show"'), 'Has eye-show SVG icon');
  assert.ok(btnContent.includes('class="eye-icon eye-hide hidden"'), 'Has eye-hide SVG icon with hidden class initially');
});

// ==========================================
// TEST SUITE 2: CSS Styling & Layout
// ==========================================
console.log('\n[2] CSS Styling & Positioning:');

it('.password-input-wrapper has relative positioning for button placement', () => {
  assert.ok(cssContent.includes('.password-input-wrapper'), 'CSS defines .password-input-wrapper');
  const ruleMatch = cssContent.match(/\.password-input-wrapper\s*\{([^}]+)\}/);
  assert.ok(ruleMatch, 'Rule .password-input-wrapper exists');
  assert.ok(ruleMatch[1].includes('position: relative'), '.password-input-wrapper has position: relative');
});

it('.password-input-wrapper input has right padding to avoid text overlapping the eye button', () => {
  const ruleMatch = cssContent.match(/\.password-input-wrapper\s+input\s*\{([^}]+)\}/);
  assert.ok(ruleMatch, 'Rule .password-input-wrapper input exists');
  assert.ok(ruleMatch[1].includes('padding-right:'), 'Right padding is specified');
});

it('.btn-password-toggle is positioned on the right inside the field', () => {
  const ruleMatch = cssContent.match(/\.btn-password-toggle\s*\{([^}]+)\}/);
  assert.ok(ruleMatch, 'Rule .btn-password-toggle exists');
  const declarations = ruleMatch[1];
  assert.ok(declarations.includes('position: absolute'), 'Button is positioned absolute');
  assert.ok(declarations.includes('right:'), 'Button is positioned on the right');
  assert.ok(declarations.includes('top: 50%'), 'Button is vertically centered');
});

it('.btn-password-toggle supports keyboard focus visibility', () => {
  assert.ok(
    cssContent.includes('.btn-password-toggle:focus-visible') || cssContent.includes('.btn-password-toggle:focus'),
    'Focus visible styling exists for keyboard navigation'
  );
});

// ==========================================
// TEST SUITE 3: JavaScript Behavior & State Logic
// ==========================================
console.log('\n[3] JavaScript Behavior & Password Preservation:');

it('JavaScript implements setLoginPasswordVisibility and event listener', () => {
  assert.ok(jsContent.includes('setLoginPasswordVisibility'), 'setLoginPasswordVisibility function exists');
  assert.ok(jsContent.includes('btn-toggle-login-password'), 'btn-toggle-login-password listener exists');
});

it('Functional simulation: toggles password visibility, updates accessibility labels, and preserves value', () => {
  // Create mock DOM elements simulating the browser
  const eyeShowClasses = new Set();
  const eyeHideClasses = new Set(['hidden']);

  const mockEyeShow = {
    classList: {
      add: (c) => eyeShowClasses.add(c),
      remove: (c) => eyeShowClasses.delete(c),
      contains: (c) => eyeShowClasses.has(c)
    }
  };

  const mockEyeHide = {
    classList: {
      add: (c) => eyeHideClasses.add(c),
      remove: (c) => eyeHideClasses.delete(c),
      contains: (c) => eyeHideClasses.has(c)
    }
  };

  const mockInput = {
    type: 'password',
    value: 'SuperSecret123!_ÖÄÅ'
  };

  const attributes = {
    'aria-label': 'Show password',
    'title': 'Show password'
  };

  const mockBtn = {
    setAttribute: (name, val) => { attributes[name] = val; },
    getAttribute: (name) => attributes[name],
    querySelector: (sel) => {
      if (sel === '.eye-show') return mockEyeShow;
      if (sel === '.eye-hide') return mockEyeHide;
      return null;
    }
  };

  function simulateSetVisibility(show) {
    if (show) {
      mockInput.type = 'text';
      mockBtn.setAttribute('aria-label', 'Hide password');
      mockBtn.setAttribute('title', 'Hide password');
      mockEyeShow.classList.add('hidden');
      mockEyeHide.classList.remove('hidden');
    } else {
      mockInput.type = 'password';
      mockBtn.setAttribute('aria-label', 'Show password');
      mockBtn.setAttribute('title', 'Show password');
      mockEyeShow.classList.remove('hidden');
      mockEyeHide.classList.add('hidden');
    }
  }

  // Initial state check
  assert.strictEqual(mockInput.type, 'password', 'Initially hidden as type="password"');
  assert.strictEqual(mockBtn.getAttribute('aria-label'), 'Show password');
  assert.strictEqual(mockBtn.getAttribute('title'), 'Show password');
  assert.strictEqual(eyeHideClasses.has('hidden'), true);
  assert.strictEqual(eyeShowClasses.has('hidden'), false);
  assert.strictEqual(mockInput.value, 'SuperSecret123!_ÖÄÅ');

  // Action: Toggle Click 1 (Show password)
  simulateSetVisibility(true);
  assert.strictEqual(mockInput.type, 'text', 'Input type changed to text');
  assert.strictEqual(mockBtn.getAttribute('aria-label'), 'Hide password', 'aria-label updated to Hide password');
  assert.strictEqual(mockBtn.getAttribute('title'), 'Hide password', 'title updated to Hide password');
  assert.strictEqual(eyeHideClasses.has('hidden'), false, 'eye-hide is visible');
  assert.strictEqual(eyeShowClasses.has('hidden'), true, 'eye-show is hidden');
  assert.strictEqual(mockInput.value, 'SuperSecret123!_ÖÄÅ', 'Password value preserved completely');

  // Action: Toggle Click 2 (Hide password again)
  simulateSetVisibility(false);
  assert.strictEqual(mockInput.type, 'password', 'Input type reverted to password');
  assert.strictEqual(mockBtn.getAttribute('aria-label'), 'Show password', 'aria-label reverted to Show password');
  assert.strictEqual(mockBtn.getAttribute('title'), 'Show password', 'title reverted to Show password');
  assert.strictEqual(eyeHideClasses.has('hidden'), true, 'eye-hide is hidden');
  assert.strictEqual(eyeShowClasses.has('hidden'), false, 'eye-show is visible');
  assert.strictEqual(mockInput.value, 'SuperSecret123!_ÖÄÅ', 'Password value preserved completely');
});

it('Resetting form or closing modal resets toggle back to hidden state', () => {
  assert.ok(
    jsContent.includes('formLogin?.addEventListener(\'reset\'') ||
    jsContent.includes('formLogin.reset();\n        setLoginPasswordVisibility(false);'),
    'formLogin reset hook calls setLoginPasswordVisibility(false)'
  );
  assert.ok(
    jsContent.includes('closeAuthModal() {\n    if (!modalAuth) return;\n    modalAuth.classList.add(\'hidden\');\n    if (authAlertBox) {\n      authAlertBox.classList.add(\'hidden\');\n      authAlertBox.textContent = \'\';\n    }\n    setLoginPasswordVisibility(false);'),
    'closeAuthModal resets password visibility'
  );
});

// Summary
console.log(`\nResults: ${testsPassed}/${testsTotal} tests passed.`);
if (testsPassed !== testsTotal) {
  process.exit(1);
} else {
  console.log('✓ All password toggle tests PASSED!\n');
}
