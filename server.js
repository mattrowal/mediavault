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
  deleteBook,
  getDashboardStats,
  getUserLibraryProfile,
  createUser,
  getUserByUsername,
  getUserById,
  purgeExpiredSessions
} from './db.js';
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
  aiLimiter
} from './auth.js';

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

// Helper: Fetch real-time TV show episode data from TVMaze API (no AI guesses)
async function fetchTVMazeDetails(tvmazeId) {
  try {
    const res = await fetch(`https://api.tvmaze.com/shows/${tvmazeId}?embed=episodes`);
    if (!res.ok) return null;
    const data = await res.json();
    const eps = data._embedded?.episodes || [];
    const now = new Date();

    const aired = eps.filter(e => e.airstamp && new Date(e.airstamp) <= now);
    const future = eps.filter(e => e.airstamp && new Date(e.airstamp) > now);

    const latestAired = aired.length > 0 ? aired[aired.length - 1] : null;
    const nextAired = future.length > 0 ? future[0] : null;

    return {
      latest_season: latestAired?.season || 1,
      latest_episode: latestAired?.number || 0,
      latest_episode_name: latestAired?.name || '',
      latest_air_date: latestAired?.airdate || null,
      next_air_date: nextAired?.airdate || null,
      total_episodes: eps.length,
      series_status: data.status || ''
    };
  } catch (err) {
    console.error('TVMaze API fetch error:', err.message);
    return null;
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

    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
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
app.get('/api/stats', requireAuth, (req, res) => {
  try {
    const stats = getDashboardStats(req.user.id);
    res.json(stats);
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
      model: 'gemini-3.6-flash',
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
// MEDIA (Movies & TV Series) ENDPOINTS - Scoped to req.user.id
// ==========================================

// Get media with filtering
app.get('/api/media', requireAuth, (req, res) => {
  try {
    const { type, status, search } = req.query;
    const items = getAllMedia(req.user.id, { type, status, search });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single media (ownership checked)
app.get('/api/media/:id', requireAuth, (req, res) => {
  try {
    const item = getMediaById(req.params.id, req.user.id);
    if (!item) return res.status(404).json({ error: 'Media not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new media
app.post('/api/media', requireAuth, async (req, res) => {
  try {
    const data = { ...req.body };

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
    }

    const created = addMedia(data, req.user.id);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update media (ownership checked)
app.put('/api/media/:id', requireAuth, (req, res) => {
  try {
    const updated = updateMedia(req.params.id, req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Media not found or not authorized' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single-show episode refresh from TVMaze API (ownership checked)
app.post('/api/media/:id/refresh-episodes', requireAuth, async (req, res) => {
  try {
    const item = getMediaById(req.params.id, req.user.id);
    if (!item) return res.status(404).json({ error: 'Media not found or not authorized' });

    if (item.type !== 'tv' || !item.external_id) {
      return res.json({ message: 'Not a trackable TV show', item });
    }

    const tvInfo = await fetchTVMazeDetails(item.external_id);
    if (!tvInfo) {
      return res.status(502).json({ error: 'Could not reach TVMaze API' });
    }

    const updated = updateMedia(item.id, req.user.id, {
      latest_season: tvInfo.latest_season,
      latest_episode: tvInfo.latest_episode,
      latest_episode_name: tvInfo.latest_episode_name,
      latest_air_date: tvInfo.latest_air_date,
      next_air_date: tvInfo.next_air_date,
      total_episodes: tvInfo.total_episodes
    });

    res.json({ success: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick increment: +1 watched episode (ownership checked)
app.post('/api/media/:id/increment-episode', requireAuth, (req, res) => {
  try {
    const updated = incrementMediaEpisode(req.params.id, req.user.id);
    if (!updated) return res.status(404).json({ error: 'Media not found or not authorized' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const seriesList = getAllTVShowsWithExternalId(req.user.id);
    let updatedCount = 0;

    for (const item of seriesList) {
      const tvInfo = await fetchTVMazeDetails(item.external_id);
      if (tvInfo) {
        updateMedia(item.id, req.user.id, {
          latest_season: tvInfo.latest_season,
          latest_episode: tvInfo.latest_episode,
          latest_episode_name: tvInfo.latest_episode_name,
          latest_air_date: tvInfo.latest_air_date,
          next_air_date: tvInfo.next_air_date,
          total_episodes: tvInfo.total_episodes
        });
        updatedCount++;
      }
    }

    res.json({ success: true, updatedCount, totalSeries: seriesList.length });
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
    const created = addBook(req.body, req.user.id);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update book (ownership checked)
app.put('/api/books/:id', requireAuth, (req, res) => {
  try {
    const updated = updateBook(req.params.id, req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Book not found or not authorized' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update reading progress (ownership checked)
app.post('/api/books/:id/progress', requireAuth, (req, res) => {
  try {
    const { current_page } = req.body;
    const book = getBookById(req.params.id, req.user.id);
    if (!book) return res.status(404).json({ error: 'Book not found or not authorized' });

    const newPage = Math.max(0, Number(current_page) || 0);
    const updates = { current_page: newPage };

    // Auto-mark as completed if reached end of book
    if (book.page_count > 0 && newPage >= book.page_count) {
      updates.status = 'completed';
    } else if (book.status === 'unread' && newPage > 0) {
      updates.status = 'reading';
    }

    const updated = updateBook(req.params.id, req.user.id, updates);
    res.json(updated);
  } catch (err) {
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

// OMDb movie search
app.get('/api/search/movies', requireAuth, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || !q.trim()) return res.json([]);

    const apiKey = process.env.OMDB_API_KEY || 'trilogy';
    const response = await fetch(`https://www.omdbapi.com/?s=${encodeURIComponent(q)}&type=movie&apikey=${apiKey}`);
    if (!response.ok) return res.json([]);

    const data = await response.json();
    if (data.Response === 'False' || !data.Search) {
      return res.json([]);
    }

    const results = data.Search.map(m => ({
      id: m.imdbID,
      title: m.Title,
      year: m.Year,
      genre: 'Movie',
      poster: m.Poster && m.Poster !== 'N/A' ? m.Poster : null,
      summary: ''
    }));

    res.json(results);
  } catch (err) {
    console.error('Movie search error:', err.message);
    res.status(500).json({ error: 'Could not search movies' });
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
    console.log(`🤖 Gemini GenAI: ${aiClient ? 'Active (gemini-3.6-flash)' : 'Not configured'}`);
    console.log(`🔒 Authentication: Server-Side Sessions + CSRF Protected`);
    console.log(`===========================================`);
  });
}

export default app;
