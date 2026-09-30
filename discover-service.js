import { getAllMedia, addMedia } from './db.js';

// Server-side cache for TMDB discovery categories
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache interval appropriate for TMDB limits

let discoverCache = null;
let lastCacheTimestamp = null;
let isCacheOutdated = false;

// Mock data map and error state for deterministic offline testing
const mockDiscoverDataMap = new Map();
let mockProviderError = null;

/**
 * Injects mock discovery data for tests.
 * @param {string} category - 'popular' | 'trending' | 'airing' | 'upcoming'
 * @param {Array<object>} items
 */
export function setMockDiscoverData(category, items) {
  mockDiscoverDataMap.set(category, items);
}

/**
 * Simulates a provider error on next refresh.
 * @param {string|null} errorMessage
 */
export function setMockDiscoverError(errorMessage) {
  mockProviderError = errorMessage;
}

/**
 * Clears mock discovery data and server cache.
 */
export function clearMockDiscoverData() {
  mockDiscoverDataMap.clear();
  mockProviderError = null;
  discoverCache = null;
  lastCacheTimestamp = null;
  isCacheOutdated = false;
}

/**
 * Checks whether TMDB integration is configured with an API key or mock data.
 * @returns {boolean}
 */
export function isTmdbConfigured() {
  if (mockProviderError) return true;
  if (mockDiscoverDataMap.size > 0) return true;
  const key = process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN;
  return Boolean(key && key.trim().length > 0);
}

/**
 * Formats a raw TMDB show object into MediaVault's discovery card model.
 * @param {object} s 
 * @returns {object}
 */
function normalizeTmdbShow(s) {
  const releaseYear = s.first_air_date ? new Date(s.first_air_date).getFullYear() : null;
  const posterUrl = s.poster_path ? `https://image.tmdb.org/t/p/w342${s.poster_path}` : (s.poster_url || null);
  const rating = typeof s.vote_average === 'number' ? Number(s.vote_average.toFixed(1)) : (s.rating || null);

  return {
    id: s.id,
    tmdb_id: s.id,
    title: s.name || s.title || 'Untitled Show',
    release_year: releaseYear,
    first_air_date: s.first_air_date || null,
    rating,
    vote_count: s.vote_count || 0,
    poster_url: posterUrl,
    overview: s.overview || 'No synopsis available for this show.',
    genres: s.genres || (s.genre_ids ? [] : [])
  };
}

/**
 * Helper to fetch JSON from TMDB API with server-side authentication.
 * @param {string} endpoint 
 * @param {object} params 
 * @returns {Promise<any>}
 */
async function fetchTmdb(endpoint, params = {}) {
  const apiKey = (process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN || '').trim();
  if (!apiKey) {
    throw new Error('TMDB_API_KEY is not configured on the server.');
  }

  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  // If api key is a JWT bearer token, use header; otherwise use api_key query param
  const isBearer = apiKey.length > 50 && !apiKey.includes('&');

  if (!isBearer) {
    url.searchParams.set('api_key', apiKey);
  }

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const headers = { 'Accept': 'application/json' };
  if (isBearer) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`TMDB request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Fetches all four discovery categories from TMDB or mock data.
 * @returns {Promise<object>}
 */
async function fetchAllCategoriesFromProvider() {
  if (mockProviderError) {
    throw new Error(mockProviderError);
  }

  const today = new Date().toISOString().split('T')[0];

  // 1. Popular TV Shows
  let popular = [];
  if (mockDiscoverDataMap.has('popular')) {
    popular = mockDiscoverDataMap.get('popular').map(normalizeTmdbShow);
  } else {
    const data = await fetchTmdb('/tv/popular', { page: 1 });
    popular = (data.results || []).map(normalizeTmdbShow);
  }

  // 2. Trending TV Shows (day)
  let trending = [];
  if (mockDiscoverDataMap.has('trending')) {
    trending = mockDiscoverDataMap.get('trending').map(normalizeTmdbShow);
  } else {
    const data = await fetchTmdb('/trending/tv/day', { page: 1 });
    trending = (data.results || []).map(normalizeTmdbShow);
  }

  // 3. Currently Airing TV Shows
  let airing = [];
  if (mockDiscoverDataMap.has('airing')) {
    airing = mockDiscoverDataMap.get('airing').map(normalizeTmdbShow);
  } else {
    const data = await fetchTmdb('/tv/on_the_air', { page: 1 });
    airing = (data.results || []).map(normalizeTmdbShow);
  }

  // 4. Upcoming TV Shows (premieres in future)
  let upcoming = [];
  if (mockDiscoverDataMap.has('upcoming')) {
    upcoming = mockDiscoverDataMap.get('upcoming').map(normalizeTmdbShow);
  } else {
    const data = await fetchTmdb('/discover/tv', {
      'first_air_date.gte': today,
      'sort_by': 'first_air_date.asc',
      page: 1
    });
    upcoming = (data.results || []).map(normalizeTmdbShow);
  }

  return { popular, trending, airing, upcoming };
}

/**
 * Retrieves discover TV categories for the authenticated user, refreshing and caching
 * on the server, and annotating library presence to prevent duplicate additions.
 * 
 * @param {number|string} userId
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<object>}
 */
export async function getDiscoverTvShows(userId, forceRefresh = false) {
  if (!isTmdbConfigured()) {
    return {
      configured: false,
      message: 'TMDB API key is not configured. Set TMDB_API_KEY in your local .env to enable live discovery lists.',
      categories: {
        popular: [],
        trending: [],
        airing: [],
        upcoming: []
      },
      lastUpdated: null,
      isOutdated: false
    };
  }

  const now = Date.now();
  const isCacheExpired = !discoverCache || !lastCacheTimestamp || (now - lastCacheTimestamp > CACHE_TTL_MS);

  if (isCacheExpired || forceRefresh) {
    try {
      const freshData = await fetchAllCategoriesFromProvider();
      discoverCache = freshData;
      lastCacheTimestamp = now;
      isCacheOutdated = false;
    } catch (err) {
      console.error('[Discover] Refresh failed:', err.message);
      if (discoverCache) {
        // Retain existing cached results and mark as potentially outdated
        isCacheOutdated = true;
      } else {
        throw new Error(`Failed to load discovery lists: ${err.message}`);
      }
    }
  }

  // Fetch user's existing TV series to annotate "In your library"
  const userMedia = getAllMedia(userId);
  const userShows = userMedia.filter(m => m.type === 'tv');

  const existingTitles = new Map();
  for (const s of userShows) {
    if (s.title) {
      existingTitles.set(s.title.trim().toLowerCase(), s.id);
    }
  }

  function annotateCategory(list) {
    return list.map(item => {
      const cleanTitle = (item.title || '').trim().toLowerCase();
      const inLibrary = existingTitles.has(cleanTitle);
      return {
        ...item,
        inLibrary,
        libraryItemId: inLibrary ? existingTitles.get(cleanTitle) : null
      };
    });
  }

  return {
    configured: true,
    lastUpdated: lastCacheTimestamp ? new Date(lastCacheTimestamp).toISOString() : new Date().toISOString(),
    isOutdated: isCacheOutdated,
    categories: {
      popular: annotateCategory(discoverCache.popular || []),
      trending: annotateCategory(discoverCache.trending || []),
      airing: annotateCategory(discoverCache.airing || []),
      upcoming: annotateCategory(discoverCache.upcoming || [])
    },
    attribution: {
      source: 'The Movie Database (TMDB)',
      notice: 'This product uses the TMDB API but is not endorsed or certified by TMDB.'
    }
  };
}

/**
 * Adds a show from the Discover page into the user's private library,
 * preventing duplicate additions.
 * 
 * @param {number|string} userId 
 * @param {object} show 
 * @returns {object}
 */
export function addDiscoverShowToLibrary(userId, show) {
  if (!userId) throw new Error('User ID is required');
  if (!show || !show.title) throw new Error('Show title is required');

  const cleanTitle = show.title.trim().toLowerCase();
  const existingShows = getAllMedia(userId).filter(m => m.type === 'tv');
  const existing = existingShows.find(s => (s.title || '').trim().toLowerCase() === cleanTitle);

  if (existing) {
    return {
      alreadyInLibrary: true,
      inLibrary: true,
      message: `"${show.title}" is already in your library.`,
      item: existing
    };
  }

  const newItem = addMedia({
    type: 'tv',
    title: show.title.trim(),
    poster_url: show.poster_url || null,
    release_year: show.release_year || null,
    rating: show.rating ? Math.round(show.rating / 2) : 0, // convert 10-star to 5-star
    status: 'plan_to_watch',
    notes: show.overview ? `Added from Discover: ${show.overview.slice(0, 400)}` : 'Added from Discover'
  }, userId);

  return {
    alreadyInLibrary: false,
    inLibrary: true,
    message: `"${show.title}" has been added to your library!`,
    item: newItem
  };
}
