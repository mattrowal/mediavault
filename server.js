import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  getUserLibraryProfile
} from './db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
// HEALTH CHECK (AWS Deployment Readiness)
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    geminiConfigured: Boolean(aiClient),
    environment: process.env.NODE_ENV || 'production'
  });
});

// ==========================================
// DASHBOARD STATS
// ==========================================
app.get('/api/stats', (req, res) => {
  try {
    const stats = getDashboardStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CENTRAL GENAI FEATURE: PERSONALIZED RECOMMENDATIONS
// ==========================================
app.post('/api/ai/recommendations', async (req, res) => {
  try {
    const { focus } = req.body || {}; // 'all', 'media', or 'books'
    const profile = getUserLibraryProfile();

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
// MEDIA (Movies & TV Series) ENDPOINTS
// ==========================================

// Get media with filtering
app.get('/api/media', (req, res) => {
  try {
    const { type, status, search } = req.query;
    const items = getAllMedia({ type, status, search });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single media
app.get('/api/media/:id', (req, res) => {
  try {
    const item = getMediaById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Media not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new media
app.post('/api/media', async (req, res) => {
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

    const created = addMedia(data);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update media
app.put('/api/media/:id', (req, res) => {
  try {
    const updated = updateMedia(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Media not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single-show episode refresh from TVMaze API (real external data, no AI guesses)
app.post('/api/media/:id/refresh-episodes', async (req, res) => {
  try {
    const item = getMediaById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Media not found' });

    if (item.type !== 'tv' || !item.external_id) {
      return res.json({ message: 'Not a trackable TV show', item });
    }

    const tvInfo = await fetchTVMazeDetails(item.external_id);
    if (!tvInfo) {
      return res.status(502).json({ error: 'Could not reach TVMaze API' });
    }

    const updated = updateMedia(item.id, {
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

// Quick increment: +1 watched episode
app.post('/api/media/:id/increment-episode', (req, res) => {
  try {
    const updated = incrementMediaEpisode(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Media not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete media
app.delete('/api/media/:id', (req, res) => {
  try {
    const success = deleteMedia(req.params.id);
    if (!success) return res.status(404).json({ error: 'Media not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk sync all series against TVMaze
app.post('/api/media/sync-tv', async (req, res) => {
  try {
    const seriesList = getAllTVShowsWithExternalId();
    let updatedCount = 0;

    for (const item of seriesList) {
      const tvInfo = await fetchTVMazeDetails(item.external_id);
      if (tvInfo) {
        updateMedia(item.id, {
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
// BOOKS ENDPOINTS (Separated Ownership & Reading Status)
// ==========================================

// Get books with separate owned & status filters
app.get('/api/books', (req, res) => {
  try {
    const { owned, status, search } = req.query;
    const items = getAllBooks({ owned, status, search });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single book
app.get('/api/books/:id', (req, res) => {
  try {
    const item = getBookById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Book not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add book
app.post('/api/books', (req, res) => {
  try {
    const created = addBook(req.body);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update book
app.put('/api/books/:id', (req, res) => {
  try {
    const updated = updateBook(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Book not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update reading progress
app.post('/api/books/:id/progress', (req, res) => {
  try {
    const { current_page } = req.body;
    const book = getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    const newPage = Math.max(0, Number(current_page) || 0);
    const updates = { current_page: newPage };

    // Auto-mark as completed if reached end of book
    if (book.page_count > 0 && newPage >= book.page_count) {
      updates.status = 'completed';
    } else if (book.status === 'unread' && newPage > 0) {
      updates.status = 'reading';
    }

    const updated = updateBook(req.params.id, updates);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete book
app.delete('/api/books/:id', (req, res) => {
  try {
    const success = deleteBook(req.params.id);
    if (!success) return res.status(404).json({ error: 'Book not found' });
    res.json({ success: true, message: 'Book deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// EXTERNAL SEARCH PROXIES (TV, Movie, Book)
// ==========================================

// TVMaze search for TV series (free, real-time data)
app.get('/api/search/tv', async (req, res) => {
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
app.get('/api/search/movies', async (req, res) => {
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
app.get('/api/search/books', async (req, res) => {
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

// Start Server
app.listen(PORT, () => {
  console.log(`===========================================`);
  console.log(`🎬 MediaVault Server is Running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`🤖 Gemini GenAI: ${aiClient ? 'Active (gemini-3.6-flash)' : 'Not configured'}`);
  console.log(`===========================================`);
});
