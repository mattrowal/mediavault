import dotenv from 'dotenv';
dotenv.config();

// In-memory mock data structures for deterministic testing
const mockMovieSearchMap = new Map();
const mockMovieDetailsMap = new Map();
let mockMovieError = null;

/**
 * Configure mock movie search results for testing.
 * @param {string} query 
 * @param {object} response - { results: [...], total_pages: 1, total_results: 1 }
 */
export function setMockMovieSearch(query, response) {
  mockMovieSearchMap.set(query.toLowerCase().trim(), response);
}

/**
 * Configure mock movie details for testing.
 * @param {number|string} tmdbId 
 * @param {object} details - { id, title, runtime, release_year, poster_url, genre }
 */
export function setMockMovieDetails(tmdbId, details) {
  mockMovieDetailsMap.set(String(tmdbId), details);
}

/**
 * Configure a simulated provider error for testing.
 * @param {string|null} err 
 */
export function setMockMovieError(err) {
  mockMovieError = err;
}

/**
 * Clear all mock movie test data.
 */
export function clearMockMovieData() {
  mockMovieSearchMap.clear();
  mockMovieDetailsMap.clear();
  mockMovieError = null;
}

/**
 * Check if TMDB integration is configured with an API key or mock data.
 * @returns {boolean}
 */
export function isMovieConfigured() {
  if (mockMovieError) return true;
  if (mockMovieSearchMap.size > 0 || mockMovieDetailsMap.size > 0) return true;
  const key = process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN;
  return Boolean(key && key.trim().length > 0);
}

/**
 * Helper to execute an authenticated TMDB request.
 * Credentials remain strictly on the server.
 * @param {string} endpoint 
 * @param {object} params 
 * @returns {Promise<any>}
 */
async function fetchTmdbMovieApi(endpoint, params = {}) {
  const apiKey = (process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN || '').trim();
  if (!apiKey) {
    throw new Error('TMDB_API_KEY is not configured on the server.');
  }

  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  const isBearer = apiKey.length > 50 && !apiKey.includes('&');

  if (!isBearer) {
    url.searchParams.set('api_key', apiKey);
  }

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  }

  const headers = { 'Accept': 'application/json' };
  if (isBearer) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    if (res.status === 404) {
      return null;
    }
    const errText = await res.text().catch(() => '');
    throw new Error(`TMDB request failed (${res.status} ${res.statusText}): ${errText}`);
  }
  return res.json();
}

/**
 * Normalize TMDB search item into consistent MediaVault movie model.
 * @param {object} m 
 * @returns {object}
 */
function normalizeMovieSearchItem(m) {
  const releaseYear = m.release_date ? m.release_date.split('-')[0] : (m.year ? String(m.year) : '');
  const posterUrl = m.poster_path
    ? `https://image.tmdb.org/t/p/w342${m.poster_path}`
    : (m.poster_url || m.poster || null);

  return {
    id: m.id,
    tmdb_id: m.id,
    title: m.title || 'Untitled Movie',
    year: releaseYear,
    release_year: releaseYear,
    release_date: m.release_date || null,
    poster: posterUrl,
    poster_url: posterUrl,
    summary: m.overview || '',
    overview: m.overview || '',
    vote_average: typeof m.vote_average === 'number' ? Number(m.vote_average.toFixed(1)) : 0,
    vote_count: m.vote_count || 0
  };
}

/**
 * Generates sensible query fallback candidates for titles like "Spider-Man", "Spider Man", "Spiderman".
 * @param {string} query 
 * @returns {string[]}
 */
function generateFallbackQueries(query) {
  const q = query.trim();
  const fallbacks = [];

  // 1. If query has hyphens, replace with spaces or remove hyphens
  if (q.includes('-')) {
    fallbacks.push(q.replace(/-/g, ' '));
    fallbacks.push(q.replace(/-/g, ''));
  }

  // 2. If query has spaces, try hyphenating or concatenating
  if (q.includes(' ')) {
    fallbacks.push(q.replace(/\s+/g, '-'));
    fallbacks.push(q.replace(/\s+/g, ''));
  }

  // 3. Known compound prefix patterns (e.g. spiderman -> spider-man, spider man)
  const compoundMatch = q.match(/^(spider|iron|ant|bat|super|x)(man|men)(.*)$/i);
  if (compoundMatch) {
    const prefix = compoundMatch[1];
    const suffix = compoundMatch[2];
    const rest = compoundMatch[3] || '';
    const hyphenated = `${prefix}-${suffix}${rest}`;
    const spaced = `${prefix} ${suffix}${rest}`;
    if (!fallbacks.includes(hyphenated)) fallbacks.push(hyphenated);
    if (!fallbacks.includes(spaced)) fallbacks.push(spaced);
  }

  // 4. CamelCase split (e.g. SpiderMan -> Spider Man)
  const camelSplit = q.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (camelSplit !== q && !fallbacks.includes(camelSplit)) {
    fallbacks.push(camelSplit);
  }

  // Remove exact duplicates and original query
  return fallbacks.filter(f => f.toLowerCase() !== q.toLowerCase());
}

/**
 * Searches TMDB for movies matching the query with automatic fallback query support.
 * @param {string} query 
 * @param {number} [page=1] 
 * @returns {Promise<{ results: Array<object>, page: number, total_pages: number, total_results: number, fallback_query?: string }>}
 */
export async function searchMovies(query, page = 1) {
  if (mockMovieError) {
    throw new Error(mockMovieError);
  }

  const cleanQuery = (query || '').trim();
  if (!cleanQuery) {
    return { results: [], page: 1, total_pages: 0, total_results: 0 };
  }

  const queryKey = cleanQuery.toLowerCase();

  // Check mock search data for tests
  if (mockMovieSearchMap.has(queryKey)) {
    const mock = mockMovieSearchMap.get(queryKey);
    return {
      results: (mock.results || []).map(normalizeMovieSearchItem),
      page: mock.page || 1,
      total_pages: mock.total_pages || 1,
      total_results: mock.total_results || (mock.results ? mock.results.length : 0)
    };
  }

  // If mock data is configured in tests, check if a fallback query candidate matches mock
  if (mockMovieSearchMap.size > 0 && page === 1) {
    const candidates = generateFallbackQueries(cleanQuery);
    for (const candidate of candidates) {
      if (mockMovieSearchMap.has(candidate.toLowerCase())) {
        const mock = mockMovieSearchMap.get(candidate.toLowerCase());
        return {
          results: (mock.results || []).map(normalizeMovieSearchItem),
          page: 1,
          total_pages: mock.total_pages || 1,
          total_results: mock.total_results || (mock.results ? mock.results.length : 0),
          fallback_query: candidate
        };
      }
    }
  }

  // Try live TMDB primary query
  let tmdbData = await fetchTmdbMovieApi('/search/movie', {
    query: cleanQuery,
    page,
    include_adult: false,
    language: 'en-US'
  });

  // If primary search returned 0 results on page 1, attempt sensible fallback searches
  let usedFallback = null;
  if ((!tmdbData || !tmdbData.results || tmdbData.results.length === 0) && page === 1) {
    const candidates = generateFallbackQueries(cleanQuery);
    for (const candidate of candidates) {
      if (mockMovieSearchMap.has(candidate.toLowerCase())) {
        const mock = mockMovieSearchMap.get(candidate.toLowerCase());
        return {
          results: (mock.results || []).map(normalizeMovieSearchItem),
          page: 1,
          total_pages: mock.total_pages || 1,
          total_results: mock.total_results || mock.results.length,
          fallback_query: candidate
        };
      }

      try {
        const fallbackData = await fetchTmdbMovieApi('/search/movie', {
          query: candidate,
          page: 1,
          include_adult: false,
          language: 'en-US'
        });
        if (fallbackData && fallbackData.results && fallbackData.results.length > 0) {
          tmdbData = fallbackData;
          usedFallback = candidate;
          break;
        }
      } catch {
        // Continue to next fallback candidate
      }
    }
  }

  if (!tmdbData || !tmdbData.results) {
    return { results: [], page, total_pages: 0, total_results: 0 };
  }

  const results = tmdbData.results.map(normalizeMovieSearchItem);
  return {
    results,
    page: tmdbData.page || page,
    total_pages: tmdbData.total_pages || 1,
    total_results: tmdbData.total_results || results.length,
    ...(usedFallback ? { fallback_query: usedFallback } : {})
  };
}

/**
 * Retrieves official movie details from TMDB, extracting runtime in minutes.
 * Missing or 0 runtime is returned as null.
 * 
 * @param {number|string} tmdbId 
 * @returns {Promise<object|null>}
 */
export async function getMovieDetails(tmdbId) {
  if (mockMovieError) {
    throw new Error(mockMovieError);
  }

  const idStr = String(tmdbId).trim();
  if (!idStr) return null;

  // Check mock details
  if (mockMovieDetailsMap.has(idStr)) {
    const mock = mockMovieDetailsMap.get(idStr);
    const rawRt = Number(mock.runtime);
    const rt = (rawRt && rawRt > 0) ? Math.round(rawRt) : null;
    return {
      id: mock.id || Number(idStr),
      tmdb_id: mock.id || Number(idStr),
      title: mock.title || 'Untitled Movie',
      runtime: rt,
      release_year: mock.release_year || (mock.release_date ? mock.release_date.split('-')[0] : null),
      release_date: mock.release_date || null,
      poster_url: mock.poster_url || mock.poster || null,
      genre: mock.genre || '',
      overview: mock.overview || ''
    };
  }

  const data = await fetchTmdbMovieApi(`/movie/${idStr}`, { language: 'en-US' });
  if (!data) return null;

  const rawRuntime = Number(data.runtime);
  // Treat missing or 0 runtime as unknown (null), never invent a duration
  const runtime = (rawRuntime && rawRuntime > 0) ? Math.round(rawRuntime) : null;

  const releaseYear = data.release_date ? data.release_date.split('-')[0] : null;
  const posterUrl = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null;
  const genres = Array.isArray(data.genres) ? data.genres.map(g => g.name).join(', ') : '';

  return {
    id: data.id,
    tmdb_id: data.id,
    title: data.title || '',
    runtime,
    release_year: releaseYear,
    release_date: data.release_date || null,
    poster_url: posterUrl,
    genre: genres,
    overview: data.overview || '',
    vote_average: typeof data.vote_average === 'number' ? Number(data.vote_average.toFixed(1)) : null
  };
}
