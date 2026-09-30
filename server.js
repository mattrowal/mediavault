import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import {
  getAllMedia,
  getMediaById,
  addMedia,
  updateMedia,
  incrementMediaEpisode,
  deleteMedia,
  getAllTVShowsWithExternalId,
  getAllBooks,
  getBookById,
  addBook,
  updateBook,
  updateBookReadingProgress,
  deleteBook,
  getDashboardStats,
  getUserLibraryProfile,
  createUser,
  getUserByUsername,
  getUserById,
  getUserWithCredentials,
  updateUserPasswordAndRevokeSessions,
  purgeExpiredSessions,
  getUserNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  createNotification,
  logActivity,
  findSession,
  startItemCycle,
  completeItemCycle,
  getItemCycles,
  getUserActivities,
  getActivityById,
  updateActivityEntry,
  deleteActivityEntry,
  getMovieByExternalId,
  updateMovieActivityMinutes
} from './db.js';
import { getPersonalStatistics } from './stats-service.js';
import { searchMovies, getMovieDetails, isMovieConfigured } from './movie-service.js';
import { getDiscoverTvShows, addDiscoverShowToLibrary } from './discover-service.js';
import {
  getUserGoalsWithProgress,
  createUserGoal,
  updateUserGoal,
  deleteUserGoal
} from './goals-service.js';
import {
  generateWeeklyPlan,
  saveWeeklyPlan,
  getUserSavedPlans,
  deleteSavedPlan,
  completePlannerActivity
} from './planner-service.js';
import {
  getUpcomingCalendar,
  updateShowNotificationPreference
} from './calendar-service.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  cookieParserMiddleware,
  setSessionCookies,
  clearSessionCookies,
  requireAuth,
  csrfProtection,
  authLimiter,
  aiLimiter,
  passwordChangeLimiter,
  assistantLimiter
} from './auth.js';
import { handleAssistantChat } from './assistant.js';
import { fetchTVMazeDetails, startEpisodeMonitoring, syncSeriesForUser } from './episode-monitor.js';
import {
  enrichMediaItemWithProgression,
  incrementShowEpisode,
  getSeriesEpisodeInfo,
  validateEpisodeProgress,
  getShowSeasonsAndEpisodes,
  toggleEpisodeWatched,
  getEarlierUnwatchedEpisodes,
  markEpisodeWatchedWithEarlier,
  getEarlierUnwatchedSeasonsInfo,
  markSeasonWatched,
  unmarkEpisodesBatchService,
  markWatchedThrough,
  refreshSeriesEpisodeDetails,
  setEpisodeManualRuntime
} from './episode-service.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configure specific reverse proxy trust (e.g., 1 for single reverse proxy like AWS App Runner or Nginx)
// Avoid setting to unrestricted 'true', which allows IP header spoofing
const trustProxySetting = process.env.TRUST_PROXY || (process.env.NODE_ENV === 'production' ? 1 : 'loopback');
app.set('trust proxy', trustProxySetting === '1' ? 1 : trustProxySetting);

// Body and Cookie Parsers
app.use(express.json());
app.use(cookieParserMiddleware);

// Ensure a CSRF token cookie exists on GET requests so frontend can read it
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.cookies?.mediavault_csrf) {
    const isProduction = process.env.NODE_ENV === 'production';
    const csrfToken = crypto.randomBytes(24).toString('hex');
    res.cookie('mediavault_csrf', csrfToken, {
      httpOnly: false,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });
    if (!req.cookies) req.cookies = {};
    req.cookies.mediavault_csrf = csrfToken;
  }
  next();
});

// Enforce CSRF protection for all state-changing methods (POST, PUT, DELETE, PATCH)
app.use('/api', csrfProtection);

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Periodic cleanup of expired sessions
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

// Initialize Google Gemini AI client if API key is provided
let aiClient = null;
if (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('your_gemini')) {
  try {
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  } catch (err) {
    console.warn('⚠️ Could not initialize GoogleGenAI client:', err.message);
  }
}

// ==========================================
// HEALTH CHECK (AWS Deployment Readiness - Public)
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    geminiConfigured: Boolean(aiClient),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ==========================================
// AUTHENTICATION & SESSION ENDPOINTS
// ==========================================

// Register a new user
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long.' });
    }

    if (username.trim().length > 30) {
      return res.status(400).json({ error: 'Username cannot exceed 30 characters.' });
    }

    // Alphanumeric with underscores only
    if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores.' });
    }

    if (!password || typeof password !== 'string' || password.length < 15 || password.length > 256) {
      return res.status(400).json({ error: 'Password must be between 15 and 256 characters long.' });
    }

    // Check if username is already taken
    const existing = getUserByUsername(username.trim());
    if (existing) {
      return res.status(409).json({ error: 'Username is already taken. Please choose another.' });
    }

    // Hash password asynchronously with unique salt
    const { hash, salt } = await hashPassword(password);
    const newUser = createUser(username.trim(), hash, salt);

    // Session renewal: invalidate old session if one was present
    if (req.cookies?.mediavault_sid) {
      destroySession(req.cookies.mediavault_sid);
    }

    // Create session and set cookies
    const session = createSession(newUser.id);
    setSessionCookies(res, session.sessionId, session.csrfToken);

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      user: { id: newUser.id, username: newUser.username },
      csrfToken: session.csrfToken
    });
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Failed to register account: ' + err.message });
  }
});

// Log in an existing user
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = getUserByUsername(username.trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Verify password hash asynchronously
    const isMatch = await verifyPassword(password, user.salt, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Session renewal: invalidate any previous session to avoid session fixation
    if (req.cookies?.mediavault_sid) {
      destroySession(req.cookies.mediavault_sid);
    }

    // Create a new session
    const session = createSession(user.id);
    setSessionCookies(res, session.sessionId, session.csrfToken);

    res.json({
      success: true,
      message: 'Logged in successfully',
      user: { id: user.id, username: user.username },
      csrfToken: session.csrfToken
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// Log out user
app.post('/api/auth/logout', (req, res) => {
  try {
    const sessionId = req.cookies?.mediavault_sid;
    if (sessionId) {
      destroySession(sessionId);
    }
    clearSessionCookies(res);
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password for logged-in user (requires authentication, rate limited, revokes all sessions atomically)
app.post('/api/auth/change-password', requireAuth, passwordChangeLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Current password, new password, and password confirmation are required.' });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 15 || newPassword.length > 256) {
      return res.status(400).json({ error: 'New password must be between 15 and 256 characters long.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match.' });
    }

    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password cannot be the same as the current password.' });
    }

    const userRecord = getUserWithCredentials(req.user.id);
    if (!userRecord) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const isCurrentValid = await verifyPassword(currentPassword, userRecord.salt, userRecord.password_hash);
    if (!isCurrentValid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const { hash, salt } = await hashPassword(newPassword);

    updateUserPasswordAndRevokeSessions(req.user.id, hash, salt);

    clearSessionCookies(res);

    res.json({
      success: true,
      message: 'Password changed successfully. All active sessions have been revoked. Please sign in with your new password.'
    });
  } catch (err) {
    console.error('Password change error:', err.message);
    res.status(500).json({ error: 'Failed to update password: ' + err.message });
  }
});


// Get current session state & user info
app.get('/api/auth/me', (req, res) => {
  const sessionId = req.cookies?.mediavault_sid;
  if (!sessionId) {
    return res.json({ loggedIn: false, csrfToken: req.cookies?.mediavault_csrf || null });
  }

  const session = findSession(sessionId);
  if (!session || session.expires_at < Date.now()) {
    clearSessionCookies(res);
    return res.json({ loggedIn: false, csrfToken: req.cookies?.mediavault_csrf || null });
  }

  res.json({
    loggedIn: true,
    user: { id: session.user_id, username: session.username },
    csrfToken: session.csrf_token
  });
});

// Provide/refresh CSRF token
app.get('/api/auth/csrf', (req, res) => {
  res.json({ csrfToken: req.cookies?.mediavault_csrf || null });
});

// ==========================================
// DASHBOARD STATS (Scoped to Logged-in User)
// ==========================================
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const stats = getDashboardStats(req.user.id);

    if (stats.series && Array.isArray(stats.series.withNewEpisodes)) {
      stats.series.withNewEpisodes = await Promise.all(
        stats.series.withNewEpisodes.map(item => enrichMediaItemWithProgression(item))
      );
    }

    if (Array.isArray(stats.currentlyWatching)) {
      stats.currentlyWatching = await Promise.all(
        stats.currentlyWatching.map(item => item.type === 'tv' ? enrichMediaItemWithProgression(item) : item)
      );
    }

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PERSONAL STATISTICS (Scoped to Logged-in User)
// ==========================================
app.get('/api/stats/personal', requireAuth, async (req, res) => {
  try {
    const period = req.query.period || 'all_time';
    const stats = await getPersonalStatistics(req.user.id, period);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CONSUMPTION CYCLES (Rewatch & Reread Tracking)
// ==========================================

// Get cycles for an item
app.get('/api/cycles/:itemType/:itemId', requireAuth, (req, res) => {
  try {
    const { itemType, itemId } = req.params;
    if (!['movie', 'tv', 'book'].includes(itemType)) {
      return res.status(400).json({ error: 'itemType must be movie, tv, or book' });
    }
    const cycles = getItemCycles(req.user.id, itemType, itemId);
    res.json({ cycles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a new cycle (explicit user action, rejects duplicates if already active)
app.post('/api/cycles/start', requireAuth, (req, res) => {
  try {
    const { itemType, itemId } = req.body || {};
    if (!itemType || !itemId) {
      return res.status(400).json({ error: 'itemType and itemId are required.' });
    }
    if (!['movie', 'tv', 'book'].includes(itemType)) {
      return res.status(400).json({ error: 'itemType must be movie, tv, or book' });
    }

    const result = startItemCycle(req.user.id, itemType, itemId);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// Complete active cycle
app.post('/api/cycles/complete', requireAuth, (req, res) => {
  try {
    const { itemType, itemId, completedAt } = req.body || {};
    if (!itemType || !itemId) {
      return res.status(400).json({ error: 'itemType and itemId are required.' });
    }
    if (!['movie', 'tv', 'book'].includes(itemType)) {
      return res.status(400).json({ error: 'itemType must be movie, tv, or book' });
    }

    const result = completeItemCycle(req.user.id, itemType, itemId, completedAt);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ACTIVITY HISTORY (Logged Viewing & Reading Sessions)
// ==========================================

// Get user activity history
app.get('/api/activity', requireAuth, (req, res) => {
  try {
    const { limit, startDate, endDate, activityType, excludeCorrections } = req.query;
    const activities = getUserActivities(req.user.id, {
      limit: limit || 100,
      startDate,
      endDate,
      activityType,
      excludeCorrections: excludeCorrections === 'true' || excludeCorrections === '1'
    });
    res.json({ activities });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Correct an activity entry (flags is_correction = 1)
app.put('/api/activity/:id', requireAuth, (req, res) => {
  try {
    const entry = getActivityById(req.params.id, req.user.id);
    if (!entry) {
      return res.status(404).json({ error: 'Activity entry not found or unauthorized' });
    }

    const { pagesRead, minutesViewed } = req.body || {};
    if (pagesRead !== undefined && (isNaN(Number(pagesRead)) || Number(pagesRead) < 0 || !Number.isInteger(Number(pagesRead)))) {
      return res.status(400).json({ error: 'pagesRead must be a non-negative whole integer.' });
    }
    if (minutesViewed !== undefined && (isNaN(Number(minutesViewed)) || Number(minutesViewed) < 0 || !Number.isInteger(Number(minutesViewed)))) {
      return res.status(400).json({ error: 'minutesViewed must be a non-negative whole integer.' });
    }

    const success = updateActivityEntry(req.params.id, req.user.id, {
      pagesRead,
      minutesViewed,
      isCorrection: 1
    });

    const updated = getActivityById(req.params.id, req.user.id);
    res.json({ success: true, activity: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete an activity entry
app.delete('/api/activity/:id', requireAuth, (req, res) => {
  try {
    const entry = getActivityById(req.params.id, req.user.id);
    if (!entry) {
      return res.status(404).json({ error: 'Activity entry not found or unauthorized' });
    }

    deleteActivityEntry(req.params.id, req.user.id);
    res.json({ success: true, message: 'Activity entry deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PERSONAL GOALS (Yearly Books, Monthly Pages & Movies)
// ==========================================

// Get all user goals with live calculated progress
app.get('/api/goals', requireAuth, (req, res) => {
  try {
    const goals = getUserGoalsWithProgress(req.user.id);
    res.json({ goals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new personal goal
app.post('/api/goals', requireAuth, (req, res) => {
  try {
    const { goalType, target, year, month, includeRepeats } = req.body || {};
    if (!goalType || target === undefined) {
      return res.status(400).json({ error: 'goalType and target are required.' });
    }

    const created = createUserGoal(req.user.id, {
      goalType,
      target,
      year,
      month,
      includeRepeats
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    if (err.message && err.message.includes('must be')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// Update goal target or repeat setting
app.put('/api/goals/:id', requireAuth, (req, res) => {
  try {
    const { target, includeRepeats } = req.body || {};
    const updated = updateUserGoal(req.params.id, req.user.id, {
      target,
      includeRepeats
    });
    res.json(updated);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message && err.message.includes('must be')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// Delete goal
app.delete('/api/goals/:id', requireAuth, (req, res) => {
  try {
    const success = deleteUserGoal(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ error: 'Goal not found or unauthorized.' });
    }
    res.json({ success: true, message: 'Goal deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// AI WEEKLY PLANNER (Entertainment & Reading Budget)
// ==========================================

// Generate weekly plan tailored to time budget and optional goal
app.post('/api/planner/generate', requireAuth, aiLimiter, async (req, res) => {
  try {
    const { timeInput, types, pagesPerHour, goalId } = req.body || {};
    if (!timeInput) {
      return res.status(400).json({ error: 'Available time budget is required (e.g. "3 hours", "90 minutes", or 180).' });
    }

    const plan = await generateWeeklyPlan(req.user.id, {
      timeInput,
      types,
      pagesPerHour,
      goalId
    }, aiClient);

    res.json(plan);
  } catch (err) {
    const status = err.statusCode || (err.message && (err.message.includes('valid') || err.message.includes('category')) ? 400 : 500);
    if (status >= 500) {
      console.error('Planner generation error:', err);
    }
    res.status(status).json({ error: err.message });
  }
});

// Save a generated plan (does not modify watched/read status of any item)
app.post('/api/planner/save', requireAuth, (req, res) => {
  try {
    const saved = saveWeeklyPlan(req.user.id, req.body);
    res.status(201).json(saved);
  } catch (err) {
    if (err.message && (err.message.includes('required') || err.message.includes('activities'))) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Save plan error:', err);
    res.status(500).json({ error: 'Failed to save plan.' });
  }
});

// Get user saved plans
app.get('/api/planner/saved', requireAuth, (req, res) => {
  try {
    const plans = getUserSavedPlans(req.user.id);
    res.json({ plans });
  } catch (err) {
    console.error('Get saved plans error:', err);
    res.status(500).json({ error: 'Failed to load saved plans history.' });
  }
});

// Delete a saved plan
app.delete('/api/planner/saved/:id', requireAuth, (req, res) => {
  try {
    const success = deleteSavedPlan(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ error: 'Saved plan not found or unauthorized.' });
    }
    res.json({ success: true, message: 'Saved plan deleted successfully.' });
  } catch (err) {
    console.error('Delete saved plan error:', err);
    res.status(500).json({ error: 'Failed to delete saved plan.' });
  }
});

// Complete a planned activity directly from planner, rechecking progress to prevent duplicates
app.post('/api/planner/complete-activity', requireAuth, async (req, res) => {
  try {
    const result = await completePlannerActivity(req.user.id, req.body);
    res.json(result);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not found') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// ==========================================
// EPISODE CALENDAR & NOTIFICATION PREFERENCES
// ==========================================

// Get upcoming episodes calendar for followed series
app.get('/api/calendar/upcoming', requireAuth, async (req, res) => {
  try {
    const { days, includeWatched, timeZone } = req.query;
    const calendar = await getUpcomingCalendar(req.user.id, {
      days: days ? parseInt(days, 10) : 30,
      includeWatched: includeWatched === 'true' || includeWatched === '1',
      timeZone: timeZone || 'UTC'
    });
    res.json(calendar);
  } catch (err) {
    console.error('Calendar error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update series notification preferences
app.patch('/api/media/:id/notifications', requireAuth, (req, res) => {
  try {
    const { notify_enabled, notifyEnabled } = req.body || {};
    const val = notify_enabled !== undefined ? notify_enabled : notifyEnabled;
    if (val === undefined) {
      return res.status(400).json({ error: 'notify_enabled (boolean or 1/0) is required.' });
    }
    const result = updateShowNotificationPreference(req.params.id, req.user.id, val);
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// DISCOVER TV SHOWS (Protected, TMDB Caching & Discovery)
// ==========================================
app.get('/api/discover/tv', requireAuth, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await getDiscoverTvShows(req.user.id, forceRefresh);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/discover/add-to-library', requireAuth, (req, res) => {
  try {
    const { show } = req.body || {};
    if (!show || !show.title) {
      return res.status(400).json({ error: 'Show details with title are required.' });
    }
    const result = addDiscoverShowToLibrary(req.user.id, show);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GENAI RECOMMENDATIONS (Protected, Rate-Limited, Scoped to req.user.id)
// ==========================================
app.post('/api/ai/recommendations', requireAuth, aiLimiter, async (req, res) => {
  try {
    const { focus } = req.body || {}; // 'all', 'media', or 'books'
    const profile = getUserLibraryProfile(req.user.id);

    const hasLibraryData = (profile.movies.length > 0 || profile.shows.length > 0 || profile.books.length > 0);

    if (!aiClient) {
      return res.status(503).json({
        error: 'Gemini API key is not configured on the server. Please add GEMINI_API_KEY to your .env file.'
      });
    }

    const librarySummary = `
User's Watched & Logged Movies:
${profile.movies.map(m => `- "${m.title}" (${m.release_year || 'Year unknown'}) [${m.genre || 'Film'}], Status: ${m.status}, Rating: ${m.rating}/5 stars, User Notes: "${m.notes || 'None'}"`).join('\n') || 'None recorded yet.'}

User's Tracked TV Series:
${profile.shows.map(s => `- "${s.title}" [${s.genre || 'Series'}], Currently on S${s.current_season}E${s.current_episode}, Rating: ${s.rating}/5 stars, User Notes: "${s.notes || 'None'}"`).join('\n') || 'None recorded yet.'}

User's Books (Separated into Owned and Reading Status):
${profile.books.map(b => `- "${b.title}" by ${b.author || 'Unknown'} [${b.format}], Owned at home: ${b.owned ? 'Yes' : 'No'}, Reading Status: ${b.status}, Rating: ${b.rating}/5 stars, User Notes: "${b.notes || 'None'}"`).join('\n') || 'None recorded yet.'}
`;

    const focusInstruction = focus === 'media'
      ? 'Focus solely on recommending movies and TV series.'
      : focus === 'books'
      ? 'Focus solely on recommending books.'
      : 'Provide a balanced mix of movies, TV series, and books.';

    const systemPrompt = `You are an elite cultural librarian, film critic, and literary advisor.
Your job is to generate 4 to 6 deeply personalized recommendations based on the user's logged entertainment and reading history.

${focusInstruction}

CRITICAL RULES:
1. Do NOT suggest any title that is already listed in the user's library.
2. Form meaningful connections: if they liked a specific sci-fi movie and a specific fantasy book, explain how your recommendation intersects those exact tastes.
3. Every recommendation must have a vivid, articulate "explanation" referencing specific elements they enjoyed in their logged titles.
4. Output valid JSON ONLY. Do not include introductory text, conversational greetings, or markdown fences outside the JSON.

Expected JSON schema:
[
  {
    "title": "Title of work",
    "type": "movie" | "tv" | "book",
    "creator": "Director / Showrunner / Author name",
    "year": "Release year",
    "genre": "Main genres",
    "explanation": "Detailed 2-3 sentence explanation linking this to what they watched/read and why it matches their preferences.",
    "whyMatched": "Short tag e.g. 'Matches your 5-star rating of Inception & Dune'"
  }
]

User's Current Library:
${librarySummary}
`;

    const aiResponse = await aiClient.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      contents: systemPrompt
    });

    let rawText = aiResponse.text || '';
    rawText = rawText.trim();
    if (rawText.startsWith('```json')) {
      rawText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    } else if (rawText.startsWith('```')) {
      rawText = rawText.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    }

    let recommendations = [];
    try {
      recommendations = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('Failed to parse Gemini recommendations JSON:', parseErr.message, 'Raw was:', rawText);
      return res.status(500).json({ error: 'Could not parse AI recommendations response' });
    }

    res.json({
      recommendations,
      hasLibraryData,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('GenAI Recommendations error:', err.message);
    res.status(500).json({ error: 'Failed to generate recommendations: ' + err.message });
  }
});

// ==========================================
// AI ASSISTANT CHAT (Tool-Calling, Rate-Limited, Scoped to req.user.id)
// ==========================================
app.post('/api/ai/assistant/chat', requireAuth, assistantLimiter, async (req, res) => {
  try {
    const { query, history } = req.body || {};

    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Question or query is required.' });
    }

    if (query.trim().length > 1000) {
      return res.status(400).json({ error: 'Query exceeds maximum length of 1000 characters.' });
    }

    const response = await handleAssistantChat(query.trim(), history || [], req.user.id, aiClient);

    res.json({
      success: true,
      answer: response.answer,
      facts: response.facts,
      toolsCalled: response.toolsCalled,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('AI Assistant Endpoint Error:', err.message);
    res.status(500).json({ error: 'Failed to process assistant query: ' + err.message });
  }
});

// ==========================================
// MEDIA (Movies & TV Series) ENDPOINTS - Scoped to req.user.id
// ==========================================

// Get media with filtering
app.get('/api/media', requireAuth, async (req, res) => {
  try {
    const { type, status, search } = req.query;
    const items = getAllMedia(req.user.id, { type, status, search });
    const enriched = await Promise.all(items.map(item => item.type === 'tv' ? enrichMediaItemWithProgression(item) : item));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single media (ownership checked)
app.get('/api/media/:id', requireAuth, async (req, res) => {
  try {
    const item = getMediaById(req.params.id, req.user.id);
    if (!item) return res.status(404).json({ error: 'Media not found' });
    const enriched = item.type === 'tv' ? await enrichMediaItemWithProgression(item) : item;
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new media
app.post('/api/media', requireAuth, async (req, res) => {
  try {
    const data = { ...req.body };

    // Duplicate prevention and automatic TMDB metadata retrieval for movies
    if (data.type === 'movie' && data.external_id) {
      const existingMovie = getMovieByExternalId(req.user.id, data.external_id);
      if (existingMovie) {
        return res.status(409).json({ error: `"${existingMovie.title}" is already in your library.` });
      }

      try {
        const details = await getMovieDetails(data.external_id);
        if (details) {
          if (data.runtime === undefined || data.runtime === null) {
            data.runtime = details.runtime;
          } else {
            data.is_runtime_manual = 1;
          }
          if (!data.release_year && details.release_year) {
            data.release_year = details.release_year;
          }
          if (!data.poster_url && details.poster_url) {
            data.poster_url = details.poster_url;
          }
          if (!data.genre && details.genre) {
            data.genre = details.genre;
          }
        }
      } catch (err) {
        console.warn(`[Movie] Could not fetch TMDB details for id ${data.external_id}:`, err.message);
      }
    }

    if (data.type === 'movie' && data.runtime !== undefined && data.runtime !== null) {
      const numRt = Number(data.runtime);
      data.runtime = (numRt && numRt > 0) ? Math.round(numRt) : null;
    }

    // If TV show with external TVMaze ID, fetch real episode data
    if (data.type === 'tv' && data.external_id) {
      const tvInfo = await fetchTVMazeDetails(data.external_id);
      if (tvInfo) {
        data.latest_season = tvInfo.latest_season;
        data.latest_episode = tvInfo.latest_episode;
        data.latest_episode_name = tvInfo.latest_episode_name;
        data.latest_air_date = tvInfo.latest_air_date;
        data.next_air_date = tvInfo.next_air_date;
        data.total_episodes = tvInfo.total_episodes;
      }

      // Validate initial progress if provided
      if (data.current_season !== undefined || data.current_episode !== undefined) {
        const episodeInfo = await getSeriesEpisodeInfo(data.external_id);
        if (episodeInfo && episodeInfo.available) {
          const s = data.current_season !== undefined ? Number(data.current_season) : 1;
          const e = data.current_episode !== undefined ? Number(data.current_episode) : 0;
          const validation = validateEpisodeProgress(episodeInfo, s, e);
          if (!validation.valid) {
            return res.status(400).json({ error: `Invalid progress: ${validation.error} Please select a valid released season and episode.` });
          }
        }
      }
    }

    const created = addMedia(data, req.user.id);
    if (created.type === 'movie' && created.status === 'completed') {
      logActivity({
        userId: req.user.id,
        activityType: 'movie_watched',
        itemType: 'movie',
        itemId: created.id,
        minutesViewed: created.runtime || 0,
        isCorrection: 0
      });
    }
    const enriched = created.type === 'tv' ? await enrichMediaItemWithProgression(created) : created;
    res.status(201).json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update media (ownership checked)
app.put('/api/media/:id', requireAuth, async (req, res) => {
  try {
    const existing = getMediaById(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Media not found or not authorized' });

    // Validate duplicate TMDB movie if external_id is changed
    if (existing.type === 'movie' && req.body.external_id && req.body.external_id !== existing.external_id) {
      const dup = getMovieByExternalId(req.user.id, req.body.external_id, existing.id);
      if (dup) {
        return res.status(409).json({ error: `This movie is already in your library as "${dup.title}".` });
      }
    }

    // Normalize and preserve manual runtime for movies
    if (existing.type === 'movie' && req.body.runtime !== undefined) {
      const numRt = req.body.runtime !== null ? Number(req.body.runtime) : null;
      req.body.runtime = (numRt && numRt > 0) ? Math.round(numRt) : null;
      if (req.body.is_runtime_manual === undefined) {
        req.body.is_runtime_manual = 1;
      }
    }

    // Validate TV progress edits against actual released episode list
    if (existing.type === 'tv' && (req.body.current_season !== undefined || req.body.current_episode !== undefined)) {
      const newSeason = req.body.current_season !== undefined ? Number(req.body.current_season) : existing.current_season;
      const newEpisode = req.body.current_episode !== undefined ? Number(req.body.current_episode) : existing.current_episode;

      if (existing.external_id) {
        const episodeInfo = await getSeriesEpisodeInfo(existing.external_id);
        if (episodeInfo && episodeInfo.available) {
          const validation = validateEpisodeProgress(episodeInfo, newSeason, newEpisode);
          if (!validation.valid) {
            return res.status(400).json({ error: `Invalid progress: ${validation.error} Please select a valid released season and episode.` });
          }
          await markWatchedThrough(req.params.id, req.user.id, newSeason, newEpisode);
        } else {
          if (newSeason < 0 || newEpisode < 0) {
            return res.status(400).json({ error: 'Season and episode must be non-negative numbers.' });
          }
        }
      } else {
        if (newSeason < 0 || newEpisode < 0) {
          return res.status(400).json({ error: 'Season and episode must be non-negative numbers.' });
        }
      }
    }

    if (req.body.status === 'completed' && existing.status !== 'completed') {
      completeItemCycle(req.user.id, existing.type, existing.id);
    }

    const updated = updateMedia(req.params.id, req.user.id, req.body);
    const enriched = existing.type === 'tv' ? await enrichMediaItemWithProgression(updated, req.user.id) : updated;
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seasons & Episodes overview for a TV series
app.get('/api/media/:id/seasons', requireAuth, async (req, res) => {
  try {
    const data = await getShowSeasonsAndEpisodes(req.params.id, req.user.id);
    res.json(data);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 500);
    res.status(status).json({ error: err.message });
  }
});

// Validate season and episode progress live for Edit form
app.get('/api/media/:id/validate-progress', requireAuth, async (req, res) => {
  try {
    const item = getMediaById(req.params.id, req.user.id);
    if (!item) return res.status(404).json({ error: 'Media not found or not authorized' });
    if (item.type !== 'tv') return res.json({ valid: true });

    if (!item.external_id) {
      return res.json({ valid: false, unavailable: true, error: 'Episode data unavailable for this series.' });
    }

    const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
    if (!episodeInfo || !episodeInfo.available) {
      return res.json({ valid: false, unavailable: true, error: 'Episode data is unavailable. Please retry TVMaze sync.' });
    }

    const season = req.query.season !== undefined ? Number(req.query.season) : item.current_season;
    const episode = req.query.episode !== undefined ? Number(req.query.episode) : item.current_episode;

    const result = validateEpisodeProgress(episodeInfo, season, episode);

    const allSeasons = new Set(episodeInfo.allRegularEpisodes.map(ep => ep.season));
    const seasonEps = episodeInfo.allRegularEpisodes.filter(ep => ep.season === season);

    res.json({
      valid: result.valid,
      error: result.error || null,
      unavailable: result.unavailable || false,
      maxSeason: allSeasons.size > 0 ? Math.max(...allSeasons) : 0,
      seasonEpisodeCount: seasonEps.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check for earlier unwatched released episodes before (season, episode)
app.get('/api/media/:id/episodes/earlier-unwatched', requireAuth, async (req, res) => {
  try {
    const { season, episode } = req.query;
    if (season === undefined || episode === undefined) {
      return res.status(400).json({ error: 'Season and episode query parameters are required.' });
    }
    const result = await getEarlierUnwatchedEpisodes(req.params.id, req.user.id, season, episode);
    res.json(result);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Toggle individual episode watched status, supporting optional catch-up of earlier episodes
app.post('/api/media/:id/episodes/toggle', requireAuth, async (req, res) => {
  try {
    const { season, episode, markEarlier, leaveDateUnknown } = req.body;
    if (season === undefined || episode === undefined) {
      return res.status(400).json({ error: 'Season and episode are required.' });
    }
    const result = await toggleEpisodeWatched(req.params.id, req.user.id, season, episode, {
      markEarlier: Boolean(markEarlier),
      leaveDateUnknown: leaveDateUnknown !== undefined ? Boolean(leaveDateUnknown) : true
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Mark episode watched with explicit option to mark earlier episodes too
app.post('/api/media/:id/episodes/mark-watched', requireAuth, async (req, res) => {
  try {
    const { season, episode, markEarlier, leaveDateUnknown } = req.body;
    if (season === undefined || episode === undefined) {
      return res.status(400).json({ error: 'Season and episode are required.' });
    }
    const result = await markEpisodeWatchedWithEarlier(req.params.id, req.user.id, season, episode, {
      markEarlier: Boolean(markEarlier),
      leaveDateUnknown: leaveDateUnknown !== undefined ? Boolean(leaveDateUnknown) : true
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Get earlier unwatched seasons summary before a specific season
app.get('/api/media/:id/seasons/:season/earlier-summary', requireAuth, async (req, res) => {
  try {
    const summary = await getEarlierUnwatchedSeasonsInfo(req.params.id, req.user.id, req.params.season);
    res.json(summary);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Bulk mark all released episodes of a season as watched (supports optional includeEarlier)
app.post('/api/media/:id/seasons/:season/mark-watched', requireAuth, async (req, res) => {
  try {
    const includeEarlier = req.body?.includeEarlier === true || req.body?.includeEarlier === 'true' || req.query?.includeEarlier === 'true';
    const result = await markSeasonWatched(req.params.id, req.user.id, req.params.season, { includeEarlier });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Bulk unmark episodes (used for Undo)
app.post('/api/media/:id/episodes/batch-unmark', requireAuth, async (req, res) => {
  try {
    const { episodes } = req.body;
    if (!Array.isArray(episodes)) {
      return res.status(400).json({ error: 'Episodes array is required.' });
    }
    const result = await unmarkEpisodesBatchService(req.params.id, req.user.id, episodes);
    res.json(result);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Refresh episode details from TVMaze API (safe merge, preserves valid runtimes and manual corrections)
app.post('/api/media/:id/refresh-episodes', requireAuth, async (req, res) => {
  try {
    const result = await refreshSeriesEpisodeDetails(req.params.id, req.user.id);
    res.json(result);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 500);
    res.status(status).json({ error: err.message });
  }
});

// Set manual runtime correction for a specific episode (ownership checked)
app.post('/api/media/:id/episodes/manual-runtime', requireAuth, async (req, res) => {
  try {
    const { season, episode, runtime } = req.body || {};
    const result = await setEpisodeManualRuntime(req.params.id, req.user.id, season, episode, runtime);
    res.json(result);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Refresh movie details from TMDB or link unlinked movie (ownership checked)
app.post('/api/media/:id/refresh-movie', requireAuth, async (req, res) => {
  try {
    const existing = getMediaById(req.params.id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Movie not found or not authorized' });
    }
    if (existing.type !== 'movie') {
      return res.status(400).json({ error: 'Only movies can have details refreshed' });
    }

    const tmdbId = req.body.tmdb_id || existing.external_id;
    if (!tmdbId) {
      return res.status(400).json({
        error: 'Movie is not linked to TMDB. Please search and select the correct movie to link.'
      });
    }

    // Duplicate check: ensure this user doesn't already have another movie with this TMDB ID
    const dup = getMovieByExternalId(req.user.id, tmdbId, existing.id);
    if (dup) {
      return res.status(409).json({
        error: `This movie is already in your library as "${dup.title}".`
      });
    }

    let details;
    try {
      details = await getMovieDetails(tmdbId);
    } catch (apiErr) {
      console.error('TMDB API error:', apiErr.message);
      return res.status(502).json({
        error: `Could not reach TMDB API: ${apiErr.message}. Existing saved metadata preserved.`
      });
    }

    if (!details) {
      return res.status(502).json({
        error: 'Could not fetch movie details from TMDB. Please check your query or try again later.'
      });
    }

    const updateFields = {
      external_id: String(details.tmdb_id || tmdbId)
    };

    if (details.release_year) {
      updateFields.release_year = details.release_year;
    }
    if (details.poster_url) {
      updateFields.poster_url = details.poster_url;
    }
    if (details.genre) {
      updateFields.genre = details.genre;
    }
    if (!existing.external_id && details.title) {
      updateFields.title = details.title;
    }

    // Preserve manual runtime correction
    // "Allow a manual correction and preserve it during later metadata refreshes."
    const isManual = existing.is_runtime_manual === 1;
    if (isManual && req.body.force_runtime !== true) {
      // Keep existing manual runtime
    } else {
      updateFields.runtime = details.runtime; // null if 0 or missing
      if (req.body.force_runtime) {
        updateFields.is_runtime_manual = 0;
      }
    }

    // Updating media preserves watched status, ratings, notes, activity history, and repeat cycles.
    // Does NOT create any new viewing event!
    const updated = updateMedia(existing.id, req.user.id, updateFields);

    if (updateFields.runtime && Number(updateFields.runtime) > 0) {
      updateMovieActivityMinutes(req.user.id, existing.id, updateFields.runtime);
    }

    res.json({
      message: 'Movie details refreshed successfully',
      movie: updated,
      manual_runtime_preserved: isManual && req.body.force_runtime !== true
    });
  } catch (err) {
    console.error('Refresh movie error:', err.message);
    res.status(500).json({ error: `Could not refresh movie details: ${err.message}` });
  }
});

// Quick increment: +1 watched episode (ownership checked & validated against real TVMaze episodes)
app.post('/api/media/:id/increment-episode', requireAuth, async (req, res) => {
  try {
    const updated = await incrementShowEpisode(req.params.id, req.user.id);
    res.json(updated);
  } catch (err) {
    const status = err.statusCode || (err.message && err.message.includes('not authorized') ? 404 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Delete media (ownership checked)
app.delete('/api/media/:id', requireAuth, (req, res) => {
  try {
    const success = deleteMedia(req.params.id, req.user.id);
    if (!success) return res.status(404).json({ error: 'Media not found or not authorized' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk sync all series belonging to logged-in user against TVMaze
app.post('/api/media/sync-tv', requireAuth, async (req, res) => {
  try {
    const result = await syncSeriesForUser(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// NOTIFICATIONS ENDPOINTS - Scoped to req.user.id
// ==========================================

// Get user notifications and unread badge count
app.get('/api/notifications', requireAuth, (req, res) => {
  try {
    const unreadOnly = req.query.unread === 'true';
    const limit = Number(req.query.limit) || 50;
    const notifications = getUserNotifications(req.user.id, { unreadOnly, limit });
    const unreadCount = getUnreadNotificationCount(req.user.id);
    res.json({ notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark single notification as read (ownership checked)
app.patch('/api/notifications/:id/read', requireAuth, (req, res) => {
  try {
    const success = markNotificationAsRead(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ error: 'Notification not found or unauthorized' });
    }
    const unreadCount = getUnreadNotificationCount(req.user.id);
    res.json({ success: true, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark all notifications for current user as read
app.post('/api/notifications/read-all', requireAuth, (req, res) => {
  try {
    const count = markAllNotificationsAsRead(req.user.id);
    res.json({ success: true, markedRead: count, unreadCount: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss/delete single notification (ownership checked)
app.delete('/api/notifications/:id', requireAuth, (req, res) => {
  try {
    const success = deleteNotification(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ error: 'Notification not found or unauthorized' });
    }
    const unreadCount = getUnreadNotificationCount(req.user.id);
    res.json({ success: true, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// BOOKS ENDPOINTS - Scoped to req.user.id
// ==========================================

// Get books with separate owned & status filters
app.get('/api/books', requireAuth, (req, res) => {
  try {
    const { owned, status, search } = req.query;
    const items = getAllBooks(req.user.id, { owned, status, search });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single book (ownership checked)
app.get('/api/books/:id', requireAuth, (req, res) => {
  try {
    const item = getBookById(req.params.id, req.user.id);
    if (!item) return res.status(404).json({ error: 'Book not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add book
app.post('/api/books', requireAuth, (req, res) => {
  try {
    const data = { ...req.body };

    if (data.page_count !== undefined && data.page_count !== null && data.page_count !== '') {
      const pc = Number(data.page_count);
      if (isNaN(pc) || !Number.isInteger(pc) || pc < 0) {
        return res.status(400).json({ error: 'Page count must be a non-negative whole integer.' });
      }
    }

    if (data.current_page !== undefined && data.current_page !== null && data.current_page !== '') {
      const cp = Number(data.current_page);
      if (isNaN(cp) || !Number.isInteger(cp) || cp < 0) {
        return res.status(400).json({ error: 'Current page must be a non-negative whole integer.' });
      }
      const totalPages = Number(data.page_count) || 0;
      if (totalPages > 0 && cp > totalPages) {
        return res.status(400).json({ error: `Current page cannot exceed total pages (${totalPages}).` });
      }
    }

    const created = addBook(data, req.user.id);
    if (created.status === 'completed') {
      logActivity({
        userId: req.user.id,
        activityType: 'book_completed',
        itemType: 'book',
        itemId: created.id,
        pagesRead: created.page_count || created.current_page || 0,
        isCorrection: 0
      });
    }
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update book (ownership checked)
app.put('/api/books/:id', requireAuth, (req, res) => {
  try {
    const existing = getBookById(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Book not found or not authorized' });

    const targetPC = req.body.page_count !== undefined && req.body.page_count !== null && req.body.page_count !== ''
      ? Number(req.body.page_count)
      : (existing.page_count || 0);

    if (req.body.page_count !== undefined && req.body.page_count !== null && req.body.page_count !== '') {
      const pc = Number(req.body.page_count);
      if (isNaN(pc) || !Number.isInteger(pc) || pc < 0) {
        return res.status(400).json({ error: 'Page count must be a non-negative whole integer.' });
      }
    }

    if (req.body.current_page !== undefined && req.body.current_page !== null && req.body.current_page !== '') {
      const cp = Number(req.body.current_page);
      if (isNaN(cp) || !Number.isInteger(cp) || cp < 0) {
        return res.status(400).json({ error: 'Current page must be a non-negative whole integer.' });
      }
      if (targetPC > 0 && cp > targetPC) {
        return res.status(400).json({ error: `Current page cannot exceed total pages (${targetPC}).` });
      }
    }

    if (req.body.status === 'completed' && existing.status !== 'completed') {
      completeItemCycle(req.user.id, 'book', existing.id);
    } else if (req.body.current_page !== undefined && req.body.current_page !== null && req.body.current_page !== '') {
      const cp = Number(req.body.current_page);
      const delta = cp - (existing.current_page || 0);
      if (!req.body.is_correction && delta > 0) {
        logActivity({
          userId: req.user.id,
          activityType: 'reading_progress',
          itemType: 'book',
          itemId: existing.id,
          pagesRead: delta,
          isCorrection: 0,
          cycleNumber: existing.current_cycle || 1
        });
      }
    }

    const updated = updateBook(req.params.id, req.user.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark book completed (ownership checked)
app.post('/api/books/:id/complete', requireAuth, (req, res) => {
  try {
    const book = getBookById(req.params.id, req.user.id);
    if (!book) return res.status(404).json({ error: 'Book not found or not authorized' });

    completeItemCycle(req.user.id, 'book', book.id);
    const updated = getBookById(req.params.id, req.user.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update reading progress (ownership checked)
app.post('/api/books/:id/progress', requireAuth, (req, res) => {
  try {
    const { current_page, is_correction } = req.body;
    if (current_page === undefined || current_page === null || current_page === '') {
      return res.status(400).json({ error: 'Current page is required.' });
    }

    const updated = updateBookReadingProgress(req.user.id, req.params.id, {
      currentPage: current_page,
      isCorrection: Boolean(is_correction)
    });
    if (!updated) return res.status(404).json({ error: 'Book not found or not authorized' });

    res.json(updated);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Delete book (ownership checked)
app.delete('/api/books/:id', requireAuth, (req, res) => {
  try {
    const success = deleteBook(req.params.id, req.user.id);
    if (!success) return res.status(404).json({ error: 'Book not found or not authorized' });
    res.json({ success: true, message: 'Book deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// EXTERNAL SEARCH PROXIES (Protected with requireAuth)
// ==========================================

// TVMaze search for TV series
app.get('/api/search/tv', requireAuth, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || !q.trim()) return res.json([]);

    const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
    if (!response.ok) return res.json([]);

    const data = await response.json();
    const results = data.map(item => {
      const show = item.show;
      return {
        id: String(show.id),
        title: show.name,
        year: show.premiered ? show.premiered.substring(0, 4) : '',
        genre: show.genres ? show.genres.join(', ') : '',
        poster: show.image?.medium || show.image?.original || null,
        summary: show.summary ? show.summary.replace(/<[^>]*>?/gm, '').trim() : '',
        status: show.status
      };
    });

    res.json(results);
  } catch (err) {
    console.error('TV search error:', err.message);
    res.status(500).json({ error: 'Could not search TV shows' });
  }
});

// TMDB movie search
app.get('/api/search/movies', requireAuth, async (req, res) => {
  try {
    const q = req.query.q;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (!q || !q.trim()) {
      return res.json({ results: [], page: 1, total_pages: 0, total_results: 0 });
    }

    const data = await searchMovies(q, page);
    res.json(data);
  } catch (err) {
    console.error('Movie search error:', err.message);
    res.status(500).json({ error: `Could not search movies: ${err.message}` });
  }
});

// Open Library book search
app.get('/api/search/books', requireAuth, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || !q.trim()) return res.json([]);

    const response = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=10`, {
      headers: {
        'User-Agent': 'MediaVault/1.1 (library-app)'
      }
    });

    if (!response.ok) return res.json([]);

    const data = await response.json();
    const results = (data.docs || []).slice(0, 10).map(b => {
      const coverId = b.cover_i;
      return {
        title: b.title,
        author: b.author_name ? b.author_name.join(', ') : 'Unknown Author',
        year: b.first_publish_year ? String(b.first_publish_year) : '',
        pages: b.number_of_pages_median || 0,
        isbn: b.isbn ? b.isbn[0] : '',
        cover: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null
      };
    });

    res.json(results);
  } catch (err) {
    console.error('Book search error:', err.message);
    res.status(500).json({ error: 'Could not search books' });
  }
});

// Start Server (only when run directly)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`🎬 MediaVault Multi-User Server is Running!`);
    console.log(`🌐 Local URL: http://localhost:${PORT}`);
    console.log(`🤖 Gemini GenAI: ${aiClient ? `Active (${process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'})` : 'Not configured'}`);
    console.log(`🔒 Authentication: Server-Side Sessions + CSRF Protected`);
    console.log(`⏱️ Episode Monitoring: Automatic Background Scheduler Active`);
    console.log(`===========================================`);
    startEpisodeMonitoring();
  });
}

export default app;
