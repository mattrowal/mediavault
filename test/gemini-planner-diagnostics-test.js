import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load environment variables if available
const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const k = trimmed.substring(0, idx).trim();
      const v = trimmed.substring(idx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// Serverless isolated test database
const TEST_DB_PATH = path.join(rootDir, 'data', `test_gemini_diag_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const {
  db,
  createUser,
  addMedia,
  getMediaById,
  addBook,
  getBookById
} = await import('../db.js');

const {
  diagnoseGeminiError,
  parseAiJsonPlan,
  generateWeeklyPlan,
  saveWeeklyPlan,
  getUserSavedPlans
} = await import('../planner-service.js');

const {
  setMockEpisodeData,
  clearMockEpisodeData
} = await import('../episode-service.js');

console.log('====================================================');
console.log('🧪 Gemini Weekly Planner Diagnostics & Fallback Suite');
console.log('   (Serverless: No HTTP server launched)');
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

try {
  // Setup test user and library data
  const testUser = createUser('diag_user', 'hash1234567890', 'salt1234567890');

  const movieA = addMedia({
    title: 'Dune: Part Two',
    type: 'movie',
    status: 'plan_to_watch',
    runtime: 166,
    notes: 'Super secret private user notes'
  }, testUser.id);

  const tvShowA = addMedia({
    title: 'Breaking Bad',
    type: 'tv',
    status: 'watching',
    external_id: 'tv_bb_mock'
  }, testUser.id);

  setMockEpisodeData('tv_bb_mock', [
    { id: 201, season: 1, number: 1, name: 'Pilot', runtime: 58, airdate: '2008-01-20' },
    { id: 202, season: 1, number: 2, name: 'Cat\'s in the Bag...', runtime: 48, airdate: '2008-01-27' }
  ]);

  const bookA = addBook({
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    page_count: 496,
    current_page: 50,
    status: 'reading'
  }, testUser.id);

  // ----------------------------------------------------
  // SECTION 1: Error Diagnosis Unit Tests (diagnoseGeminiError)
  // ----------------------------------------------------
  console.log('--- Suite 1: Safe Error Classification (diagnoseGeminiError) ---');

  check('Diagnoses 401/403/API_KEY_INVALID as auth_error without leaking keys', () => {
    const fakeKey = 'AIzaSyD-secret-api-key-value-12345';
    const err = new Error(`API_KEY_INVALID: API key ${fakeKey} is not valid.`);
    err.status = 400;

    const diag = diagnoseGeminiError(err, 'gemini-3.5-flash-lite');
    assert.strictEqual(diag.aiStatus, 'auth_error');
    assert.ok(diag.aiError.includes('GEMINI_API_KEY in .env'));
    assert.strictEqual(diag.aiError.includes(fakeKey), false, 'Must not leak API key in aiError');
    assert.strictEqual(diag.safeLog.includes(fakeKey), false, 'Must not leak API key in safeLog');
  });

  check('Diagnoses 429 quota exhaustion and extracts retry duration', () => {
    const err = new Error('Resource has been exhausted (e.g. check quota). Please retry after 27 seconds.');
    err.status = 429;

    const diag = diagnoseGeminiError(err, 'gemini-3.5-flash-lite');
    assert.strictEqual(diag.aiStatus, 'rate_limited');
    assert.ok(diag.aiError.includes('retry after 27s'));
    assert.ok(diag.safeLog.includes('HTTP 429'));
  });

  check('Diagnoses 503 temporary high demand', () => {
    const err = new Error('503 UNAVAILABLE: This model is currently experiencing high demand. Spikes in demand are usually temporary.');
    err.status = 503;

    const diag = diagnoseGeminiError(err, 'gemini-3.6-flash');
    assert.strictEqual(diag.aiStatus, 'high_demand');
    assert.ok(diag.aiError.includes('temporary high demand'));
    assert.ok(diag.safeLog.includes('HTTP 503'));
  });

  check('Diagnoses 404 model not found / deprecated', () => {
    const err = new Error('404 NOT_FOUND: models/gemini-2.0-flash is no longer available');
    err.status = 404;

    const diag = diagnoseGeminiError(err, 'gemini-2.0-flash');
    assert.strictEqual(diag.aiStatus, 'model_unavailable');
    assert.ok(diag.aiError.includes('no longer available or supported'));
    assert.ok(diag.safeLog.includes('HTTP 404'));
  });

  check('Diagnoses network timeouts and connection aborts', () => {
    const err = new Error('fetch failed: connect ETIMEDOUT 142.250.74.202:443');
    err.code = 'ETIMEDOUT';

    const diag = diagnoseGeminiError(err, 'gemini-3.5-flash-lite');
    assert.strictEqual(diag.aiStatus, 'network_error');
    assert.ok(diag.aiError.includes('timed out or failed'));
  });

  check('Diagnoses malformed AI output syntax error', () => {
    const err = new SyntaxError('Unexpected token < in JSON at position 0');
    const diag = diagnoseGeminiError(err, 'gemini-3.5-flash-lite');
    assert.strictEqual(diag.aiStatus, 'invalid_output');
    assert.ok(diag.aiError.includes('unexpected response format'));
  });

  // ----------------------------------------------------
  // SECTION 2: AI JSON Response Parser (parseAiJsonPlan)
  // ----------------------------------------------------
  console.log('\n--- Suite 2: AI JSON Parsing Robustness (parseAiJsonPlan) ---');

  check('Parses raw JSON successfully', () => {
    const parsed = parseAiJsonPlan('{"selectedIds": ["item1"], "explanation": "Looks great"}');
    assert.deepStrictEqual(parsed.selectedIds, ['item1']);
    assert.strictEqual(parsed.explanation, 'Looks great');
  });

  check('Strips markdown code blocks ```json ... ``` cleanly', () => {
    const markdown = '```json\n{"selectedIds": ["item2"], "explanation": "Markdown wrapped"}\n```';
    const parsed = parseAiJsonPlan(markdown);
    assert.deepStrictEqual(parsed.selectedIds, ['item2']);
    assert.strictEqual(parsed.explanation, 'Markdown wrapped');
  });

  // ----------------------------------------------------
  // SECTION 3: Mocked Provider Integration Tests
  // ----------------------------------------------------
  console.log('\n--- Suite 3: Mocked Provider Scenarios & Server-Side Fallback ---');

  await asyncCheck('Mocked Gemini Success: returns AI-generated plan within budget', async () => {
    const mockAiClient = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            selectedIds: [`tv_${tvShowA.id}_1_1`],
            explanation: 'Start your Breaking Bad journey with the 58-minute Pilot.'
          })
        })
      }
    };

    const plan = await generateWeeklyPlan(testUser.id, {
      timeInput: '90 minutes',
      types: ['tv']
    }, mockAiClient);

    assert.strictEqual(plan.isAiGenerated, true, 'Plan must be marked isAiGenerated: true');
    assert.strictEqual(plan.aiStatus, 'success', 'aiStatus must be success');
    assert.strictEqual(plan.aiError, null, 'aiError must be null');
    assert.strictEqual(plan.activities.length, 1);
    assert.strictEqual(plan.activities[0].title, 'Breaking Bad');
    assert.strictEqual(plan.activities[0].durationMinutes, 58);
    assert.ok(plan.totalPlannedMinutes <= 90);
    assert.ok(plan.explanation.includes('Start your Breaking Bad journey with the 58-minute Pilot.'));
  });

  await asyncCheck('Mocked Quota Limit (429): triggers local fallback and sets rate_limited with retry info', async () => {
    const mockRateLimitClient = {
      models: {
        generateContent: async () => {
          const err = new Error('Resource has been exhausted (quota exceeded). Please retry after 15 seconds.');
          err.status = 429;
          throw err;
        }
      }
    };

    const plan = await generateWeeklyPlan(testUser.id, {
      timeInput: '90 minutes',
      types: ['tv']
    }, mockRateLimitClient);

    assert.strictEqual(plan.isAiGenerated, false, 'Must be marked as local fallback');
    assert.strictEqual(plan.aiStatus, 'rate_limited');
    assert.ok(plan.aiError.includes('retry after 15s'), 'Must preserve retry duration in aiError');
    assert.strictEqual(plan.activities.length, 1, 'Local fallback should still generate activities');
    assert.strictEqual(plan.activities[0].title, 'Breaking Bad');
  });

  await asyncCheck('Mocked Auth Error (401/403): triggers local fallback and advises checking .env', async () => {
    const mockAuthClient = {
      models: {
        generateContent: async () => {
          const err = new Error('API key not valid. Please pass a valid API key.');
          err.status = 401;
          throw err;
        }
      }
    };

    const plan = await generateWeeklyPlan(testUser.id, {
      timeInput: '90 minutes',
      types: ['tv']
    }, mockAuthClient);

    assert.strictEqual(plan.isAiGenerated, false);
    assert.strictEqual(plan.aiStatus, 'auth_error');
    assert.ok(plan.aiError.includes('GEMINI_API_KEY in .env'));
    assert.ok(plan.activities.length > 0);
  });

  await asyncCheck('Mocked Timeout / Network Failure: triggers local fallback with network_error status', async () => {
    const mockTimeoutClient = {
      models: {
        generateContent: async () => {
          const err = new Error('Connection timed out');
          err.code = 'ETIMEDOUT';
          throw err;
        }
      }
    };

    const plan = await generateWeeklyPlan(testUser.id, {
      timeInput: '90 minutes',
      types: ['tv']
    }, mockTimeoutClient);

    assert.strictEqual(plan.isAiGenerated, false);
    assert.strictEqual(plan.aiStatus, 'network_error');
    assert.ok(plan.aiError.includes('timed out'));
    assert.ok(plan.activities.length > 0);
  });

  await asyncCheck('Mocked Invalid Output / Malformed JSON: triggers local fallback with invalid_output status', async () => {
    const mockMalformedClient = {
      models: {
        generateContent: async () => ({
          text: 'Here is your plan: { this is not valid json'
        })
      }
    };

    const plan = await generateWeeklyPlan(testUser.id, {
      timeInput: '90 minutes',
      types: ['tv']
    }, mockMalformedClient);

    assert.strictEqual(plan.isAiGenerated, false);
    assert.strictEqual(plan.aiStatus, 'invalid_output');
    assert.ok(plan.activities.length > 0);
  });

  await asyncCheck('Server-Side Candidate Validation: AI cannot inject items exceeding time budget or foreign IDs', async () => {
    const mockSneakyClient = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            selectedIds: [`movie_${movieA.id}`, 'foreign_unauthorized_id', `tv_${tvShowA.id}_1_1`],
            explanation: 'Enjoy everything!'
          })
        })
      }
    };

    // Budget: 60 minutes. Dune is 166m (exceeds budget), foreign_id is non-existent.
    // Only Breaking Bad S1E1 (58m) fits within 60m budget.
    const plan = await generateWeeklyPlan(testUser.id, {
      timeInput: '60 minutes',
      types: ['movie', 'tv']
    }, mockSneakyClient);

    assert.strictEqual(plan.isAiGenerated, true);
    assert.strictEqual(plan.activities.length, 1);
    assert.strictEqual(plan.activities[0].title, 'Breaking Bad');
    assert.strictEqual(plan.activities[0].durationMinutes, 58);
    assert.ok(plan.totalPlannedMinutes <= 60);
  });

  await asyncCheck('Zero watched/read progress side-effects during plan generation', async () => {
    const bookBefore = getBookById(bookA.id, testUser.id);
    const movieBefore = getMediaById(movieA.id, testUser.id);

    assert.strictEqual(bookBefore.current_page, 50);
    assert.strictEqual(movieBefore.status, 'plan_to_watch');
  });

  // ----------------------------------------------------
  // SECTION 4: Saved Plans Provenance & History
  // ----------------------------------------------------
  console.log('\n--- Suite 4: Provenance Preservation in Saved Plans History ---');

  check('Persists and restores isAiGenerated: true for Gemini plans', () => {
    const aiPlan = {
      title: 'Gemini Plan Week 1',
      budgetMinutes: 120,
      totalPlannedMinutes: 58,
      isAiGenerated: true,
      aiStatus: 'success',
      aiError: null,
      explanation: 'AI reasoned plan',
      activities: [{ candidateId: 'tv_1', itemType: 'tv', itemId: tvShowA.id, season: 1, episode: 1, durationMinutes: 58, title: 'Breaking Bad' }]
    };

    const saved = saveWeeklyPlan(testUser.id, aiPlan);
    assert.strictEqual(saved.isAiGenerated, true);
    assert.strictEqual(saved.aiStatus, 'success');

    const loaded = getUserSavedPlans(testUser.id);
    const found = loaded.find(p => p.id === saved.id);
    assert.ok(found, 'Saved plan must be retrieved');
    assert.strictEqual(found.isAiGenerated, true);
    assert.strictEqual(found.aiStatus, 'success');
    assert.strictEqual(found.aiError, null);
  });

  check('Persists and restores isAiGenerated: false and aiError for fallback plans', () => {
    const fallbackPlan = {
      title: 'Fallback Plan Week 2',
      budgetMinutes: 60,
      totalPlannedMinutes: 58,
      isAiGenerated: false,
      aiStatus: 'rate_limited',
      aiError: 'Gemini API quota or rate limit reached (retry after 20s). Local smart schedule generated instead.',
      explanation: 'Local schedule',
      activities: [{ candidateId: 'tv_1', itemType: 'tv', itemId: tvShowA.id, season: 1, episode: 1, durationMinutes: 58, title: 'Breaking Bad' }]
    };

    const saved = saveWeeklyPlan(testUser.id, fallbackPlan);
    assert.strictEqual(saved.isAiGenerated, false);
    assert.strictEqual(saved.aiStatus, 'rate_limited');

    const loaded = getUserSavedPlans(testUser.id);
    const found = loaded.find(p => p.id === saved.id);
    assert.ok(found, 'Saved fallback plan must be retrieved');
    assert.strictEqual(found.isAiGenerated, false);
    assert.strictEqual(found.aiStatus, 'rate_limited');
    assert.ok(found.aiError.includes('retry after 20s'));
  });

  // ----------------------------------------------------
  // SECTION 5: Live Gemini Provider Verification
  // ----------------------------------------------------
  console.log('\n--- Suite 5: Live Provider Verification (Separate Report) ---');

  if (process.env.GEMINI_API_KEY) {
    const { GoogleGenAI } = await import('@google/genai');
    const liveClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const modelToUse = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

    await asyncCheck(`Live Google GenAI call with model "${modelToUse}"`, async () => {
      const livePlan = await generateWeeklyPlan(testUser.id, {
        timeInput: '90 minutes',
        types: ['tv']
      }, liveClient);

      console.log(`     [Live Result] isAiGenerated: ${livePlan.isAiGenerated}, aiStatus: ${livePlan.aiStatus}`);
      if (livePlan.isAiGenerated) {
        console.log(`     [Live Result] Explanation: ${livePlan.explanation}`);
        assert.strictEqual(livePlan.isAiGenerated, true);
        assert.strictEqual(livePlan.aiStatus, 'success');
      } else {
        console.log(`     [Live Fallback Note] ${livePlan.aiError}`);
        // If live quota or demand blocked it, fallback must be intact
        assert.strictEqual(livePlan.isAiGenerated, false);
        assert.ok(livePlan.activities.length > 0);
      }
    });
  } else {
    console.log('  ⚠️ GEMINI_API_KEY not configured in .env; skipping live provider check.');
  }

} finally {
  clearMockEpisodeData();
  // Clean up test database
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  } catch (_) {}
}

console.log('\n====================================================');
console.log(`Diagnostics Test Results: ${passedChecks} / ${totalChecks} checks passed`);
console.log('====================================================\n');
if (passedChecks !== totalChecks) {
  process.exit(1);
}
