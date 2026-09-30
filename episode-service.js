import {
  db,
  getMediaById,
  updateMedia,
  getCachedEpisodes,
  setCachedEpisodes,
  getWatchedEpisodes,
  getWatchedEpisodesSet,
  isEpisodeWatched,
  markEpisodeWatched,
  unmarkEpisodeWatched,
  markEpisodesBatch,
  unmarkEpisodesBatch,
  markEpisodeWatchedWithCatchUp,
  getWatchedCountsBySeason,
  logActivity,
  removeActivityLog,
  completeItemCycle
} from './db.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// In-memory cache for fast synchronous access
const memoryEpisodeCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Mock episode data for tests / offline mode
const mockEpisodeDataMap = new Map();

/**
 * Injects mock episode data for testing.
 * @param {string|number} externalId 
 * @param {Array} rawEpisodes 
 * @param {object} [showMeta] 
 */
export function setMockEpisodeData(externalId, rawEpisodes, showMeta = {}) {
  const idStr = String(externalId);
  mockEpisodeDataMap.set(idStr, { rawEpisodes, showMeta });
  // Also invalidate memory cache so mock data takes immediate effect
  memoryEpisodeCache.delete(idStr);
}

/**
 * Clears mock episode data.
 */
export function clearMockEpisodeData() {
  mockEpisodeDataMap.clear();
  memoryEpisodeCache.clear();
}

/**
 * Filters regular episodes and excludes specials from normal progression.
 * A regular episode has type === 'regular' (or omitted) and positive integer season and number.
 * 
 * @param {Array} episodes 
 * @returns {Array}
 */
export function filterRegularEpisodes(episodes) {
  if (!Array.isArray(episodes)) return [];
  return episodes.filter(e => {
    if (!e) return false;
    const type = (e.type || 'regular').toLowerCase();
    if (type !== 'regular') return false;
    const s = Number(e.season);
    const n = Number(e.number);
    return Number.isInteger(s) && s > 0 && Number.isInteger(n) && n > 0;
  });
}

/**
 * Determines whether an episode has officially been released (aired).
 * 
 * @param {object} e 
 * @param {Date} [now] 
 * @returns {boolean}
 */
export function isEpisodeReleased(e, now = new Date()) {
  if (!e) return false;
  if (e.airstamp) {
    return new Date(e.airstamp) <= now;
  }
  if (e.airdate) {
    return new Date(e.airdate) <= now;
  }
  return false;
}

/**
 * Sorts episodes chronologically: season ASC, then number ASC.
 * 
 * @param {Array} episodes 
 * @returns {Array}
 */
export function sortEpisodesChronologically(episodes) {
  return [...episodes].sort((a, b) => {
    if (a.season !== b.season) return a.season - b.season;
    return a.number - b.number;
  });
}

/**
 * Processes raw episode lists into structured, indexed progression data.
 * 
 * @param {Array} rawEpisodes 
 * @param {object} [showMeta] 
 * @returns {object}
 */
export function processEpisodesList(rawEpisodes, showMeta = {}) {
  const regularEpisodes = filterRegularEpisodes(rawEpisodes);
  const now = new Date();

  // All regular episodes sorted
  const sortedRegular = sortEpisodesChronologically(regularEpisodes);

  // Released regular episodes sorted
  const releasedEpisodes = sortedRegular.filter(e => isEpisodeReleased(e, now));

  // Future unreleased regular episodes
  const futureEpisodes = sortedRegular.filter(e => !isEpisodeReleased(e, now));

  // Map of season -> Set of valid released episode numbers
  const seasonEpisodeNumbers = new Map();
  for (const ep of releasedEpisodes) {
    if (!seasonEpisodeNumbers.has(ep.season)) {
      seasonEpisodeNumbers.set(ep.season, new Set());
    }
    seasonEpisodeNumbers.get(ep.season).add(ep.number);
  }

  // Next upcoming air date if any
  const nextUpcoming = futureEpisodes.length > 0 ? futureEpisodes[0] : null;
  const latestReleased = releasedEpisodes.length > 0 ? releasedEpisodes[releasedEpisodes.length - 1] : null;

  return {
    available: true,
    allRegularEpisodes: sortedRegular,
    releasedEpisodes,
    seasonEpisodeNumbers,
    latestReleased,
    nextAirDate: nextUpcoming?.airdate || null,
    showStatus: showMeta.status || ''
  };
}

/**
 * Fetches show details and embedded episodes from the TVMaze API.
 * Rate-limit resilient with exponential backoff on HTTP 429.
 * 
 * @param {string|number} tvmazeId 
 * @returns {Promise<object|null>}
 */
async function fetchTVMazeDetailsFromAPI(tvmazeId) {
  if (!tvmazeId) return null;

  try {
    const res = await fetch(`https://api.tvmaze.com/shows/${tvmazeId}?embed=episodes`);

    if (res.status === 429) {
      console.warn(`[TVMaze] Rate limit hit (429) for show ${tvmazeId}. Backing off...`);
      await delay(2000);
      const retryRes = await fetch(`https://api.tvmaze.com/shows/${tvmazeId}?embed=episodes`);
      if (!retryRes.ok) return null;
      return await retryRes.json();
    }

    if (!res.ok) {
      console.warn(`[TVMaze] Request failed with status ${res.status} for show ${tvmazeId}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error(`[TVMaze] Network error fetching show ${tvmazeId}:`, err.message);
    return null;
  }
}

/**
 * Retrieves episode information for a series using in-memory, SQLite cache, or TVMaze API.
 * 
 * @param {string|number} externalId 
 * @param {boolean} [forceRefresh] 
 * @returns {Promise<object>}
 */
export async function getSeriesEpisodeInfo(externalId, forceRefresh = false) {
  if (!externalId) {
    return { available: false, error: 'No external ID provided' };
  }

  const idStr = String(externalId);

  let rawEpisodes;
  let showMeta;

  // 1. Check Mock Data
  if (mockEpisodeDataMap.has(idStr)) {
    const mock = mockEpisodeDataMap.get(idStr);
    rawEpisodes = mock.rawEpisodes;
    showMeta = mock.showMeta;
  } else {
    // 2. Check Memory Cache
    if (!forceRefresh) {
      const cachedMem = memoryEpisodeCache.get(idStr);
      if (cachedMem && (Date.now() - cachedMem.timestamp < CACHE_TTL_MS)) {
        return cachedMem.info;
      }
    }

    // 3. Check SQLite DB Cache
    if (!forceRefresh) {
      const cachedDb = getCachedEpisodes(idStr);
      if (cachedDb && cachedDb.episodes && Array.isArray(cachedDb.episodes)) {
        const info = processEpisodesList(cachedDb.episodes, cachedDb.showMeta || {});
        memoryEpisodeCache.set(idStr, { info, timestamp: Date.now() });
        return info;
      }
    }

    // 4. Fetch from TVMaze API
    const apiData = await fetchTVMazeDetailsFromAPI(idStr);
    if (!apiData || !apiData._embedded?.episodes) {
      // If API failed but we have stale SQLite cache, fallback to it
      const staleDb = getCachedEpisodes(idStr);
      if (staleDb && staleDb.episodes && Array.isArray(staleDb.episodes)) {
        const info = processEpisodesList(staleDb.episodes, staleDb.showMeta || {});
        return info;
      }
      return { available: false, error: 'Episode data unavailable from TVMaze' };
    }

    rawEpisodes = apiData._embedded.episodes;
    showMeta = { status: apiData.status, name: apiData.name };
  }

  // Safely merge with existing cached episodes to preserve valid runtimes and manual corrections
  const staleDb = getCachedEpisodes(idStr);
  const existingEpisodes = staleDb?.episodes || [];
  const existingMap = new Map();
  for (const ep of existingEpisodes) {
    if (ep.id) existingMap.set(String(ep.id), ep);
    existingMap.set(`${ep.season}-${ep.number}`, ep);
  }

  const mergedEpisodes = rawEpisodes.map(ep => {
    const existing = existingMap.get(String(ep.id)) || existingMap.get(`${ep.season}-${ep.number}`);
    if (existing) {
      // 1. Preserve manual runtime correction
      if (existing.is_runtime_manual && Number(existing.runtime) > 0) {
        return {
          ...ep,
          runtime: Number(existing.runtime),
          is_runtime_manual: 1
        };
      }
      // 2. Preserve existing valid runtime if newly fetched is null/0/invalid
      if ((ep.runtime === null || ep.runtime === undefined || Number(ep.runtime) <= 0) &&
          existing.runtime && Number(existing.runtime) > 0) {
        return {
          ...ep,
          runtime: Number(existing.runtime),
          is_runtime_manual: existing.is_runtime_manual ? 1 : 0
        };
      }
      // 3. New valid runtime from provider
      if (typeof ep.runtime === 'number' && ep.runtime > 0) {
        return {
          ...ep,
          runtime: Math.round(ep.runtime),
          is_runtime_manual: 0
        };
      }
    } else if (typeof ep.runtime === 'number' && ep.runtime > 0) {
      return {
        ...ep,
        runtime: Math.round(ep.runtime),
        is_runtime_manual: 0
      };
    }
    return {
      ...ep,
      runtime: (typeof ep.runtime === 'number' && ep.runtime > 0) ? Math.round(ep.runtime) : null,
      is_runtime_manual: 0
    };
  });

  // Save to SQLite cache for persistence
  setCachedEpisodes(idStr, { episodes: mergedEpisodes, showMeta });

  // Process and save to memory cache
  const info = processEpisodesList(mergedEpisodes, showMeta);
  memoryEpisodeCache.set(idStr, { info, timestamp: Date.now() });

  return info;
}

/**
 * Validates whether a given (season, episode) is a valid released progression state.
 * Exact error format: "Season 1 has 24 episodes. Enter an episode between 0 and 24."
 * 
 * @param {object} episodeInfo 
 * @param {number} season 
 * @param {number} episode 
 * @returns {{ valid: boolean, error?: string, notStarted?: boolean, unavailable?: boolean }}
 */
export function validateEpisodeProgress(episodeInfo, season, episode) {
  const s = Number(season);
  const e = Number(episode);

  if (isNaN(s) || isNaN(e)) {
    return { valid: false, error: 'Season and episode must be numbers.' };
  }

  if (!Number.isInteger(s) || !Number.isInteger(e)) {
    return { valid: false, error: 'Season and episode numbers must be whole integers.' };
  }

  if (s < 0 || e < 0) {
    return { valid: false, error: 'Season and episode numbers cannot be negative.' };
  }

  if (!episodeInfo || !episodeInfo.available) {
    return { valid: false, unavailable: true, error: 'Episode data is unavailable. Please retry TVMaze sync.' };
  }

  // Progress at S0E0 or S1E0 represents unstarted series (0 episodes watched)
  if ((s === 0 && e === 0) || (s === 1 && e === 0)) {
    return { valid: true, notStarted: true };
  }

  // Check if season exists in regular episodes
  const allSeasons = new Set(episodeInfo.allRegularEpisodes.map(ep => ep.season));
  if (!allSeasons.has(s)) {
    const maxSeason = allSeasons.size > 0 ? Math.max(...allSeasons) : 0;
    return {
      valid: false,
      error: `Season ${s} does not exist. This series has ${maxSeason} season${maxSeason === 1 ? '' : 's'}.`
    };
  }

  // Episode 0 in an existing season is allowed (means 0 episodes watched in that season)
  if (e === 0) {
    return { valid: true };
  }

  // Count regular episodes in this season
  const seasonEps = episodeInfo.allRegularEpisodes.filter(ep => ep.season === s);
  const totalInSeason = seasonEps.length;
  const epExists = seasonEps.some(ep => ep.number === e);

  if (!epExists || e > totalInSeason) {
    return {
      valid: false,
      error: `Season ${s} has ${totalInSeason} episodes. Enter an episode between 0 and ${totalInSeason}.`
    };
  }

  // Check if it has released
  const isReleased = episodeInfo.releasedEpisodes.some(ep => ep.season === s && ep.number === e);
  if (!isReleased) {
    return {
      valid: false,
      error: `Season ${s} Episode ${e} has not been released yet.`
    };
  }

  return { valid: true };
}

/**
 * Calculates the next released episode to watch, or determines if the user is caught up / invalid.
 * If watchedSet is provided, uses watched_episodes as the single source of truth.
 * 
 * @param {object} episodeInfo 
 * @param {number} currentSeason 
 * @param {number} currentEpisode 
 * @param {Set<string>} [watchedSet] 
 * @returns {{ next: object|null, isCaughtUp: boolean, isInvalid: boolean, reason?: string, unavailable: boolean }}
 */
export function calculateNextEpisode(episodeInfo, currentSeason, currentEpisode, watchedSet = null) {
  if (!episodeInfo || !episodeInfo.available) {
    return {
      next: null,
      isCaughtUp: false,
      isInvalid: false,
      unavailable: true,
      reason: 'Episode data unavailable for this series'
    };
  }

  const released = episodeInfo.releasedEpisodes;
  if (!released || released.length === 0) {
    return {
      next: null,
      isCaughtUp: true,
      isInvalid: false,
      unavailable: false
    };
  }

  // If watchedSet is provided, determine first unwatched released episode
  if (watchedSet instanceof Set) {
    const nextEp = released.find(ep => !watchedSet.has(`${ep.season}-${ep.number}`));
    if (!nextEp) {
      return {
        next: null,
        isCaughtUp: true,
        isInvalid: false,
        unavailable: false
      };
    }
    return {
      next: { season: nextEp.season, episode: nextEp.number, name: nextEp.name },
      isCaughtUp: false,
      isInvalid: false,
      unavailable: false
    };
  }

  // Sequential evaluation based on currentSeason and currentEpisode
  const s = Number(currentSeason) || 1;
  const e = Number(currentEpisode) || 0;

  // Validate current progress
  const validation = validateEpisodeProgress(episodeInfo, s, e);
  if (!validation.valid) {
    return {
      next: null,
      isCaughtUp: false,
      isInvalid: true,
      reason: validation.error,
      unavailable: false
    };
  }

  // Unstarted: next is the first released episode (e.g. S1E1)
  if (e === 0) {
    const first = released[0];
    return {
      next: { season: first.season, episode: first.number, name: first.name },
      isCaughtUp: false,
      isInvalid: false,
      unavailable: false
    };
  }

  // Find index of current episode in released list
  const idx = released.findIndex(ep => ep.season === s && ep.number === e);
  if (idx === -1) {
    return {
      next: null,
      isCaughtUp: false,
      isInvalid: true,
      reason: `Episode S${s} E${e} not found in released episodes list.`,
      unavailable: false
    };
  }

  // Reached the end of released episodes
  if (idx === released.length - 1) {
    return {
      next: null,
      isCaughtUp: true,
      isInvalid: false,
      unavailable: false
    };
  }

  // Next released episode
  const nextEp = released[idx + 1];
  return {
    next: { season: nextEp.season, episode: nextEp.number, name: nextEp.name },
    isCaughtUp: false,
    isInvalid: false,
    unavailable: false
  };
}

/**
 * Returns full seasons overview and episode breakdown for a show.
 * Enforces ownership, includes watched states, and migrates legacy progress if needed.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @returns {Promise<object>}
 */
export async function getShowSeasonsAndEpisodes(mediaId, userId) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }

  if (item.type !== 'tv') {
    const err = new Error('Item is not a TV series.');
    err.statusCode = 400;
    throw err;
  }

  if (!item.external_id) {
    return {
      available: false,
      show: item,
      seasons: [],
      error: 'Episode data unavailable for this series (missing TVMaze ID).'
    };
  }

  const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
  if (!episodeInfo || !episodeInfo.available) {
    return {
      available: false,
      show: item,
      seasons: [],
      error: 'Episode data unavailable from TVMaze.'
    };
  }

  // Check user's watched episodes
  let watchedEpisodes = getWatchedEpisodes(mediaId, userId);

  let isProgressInvalid = false;
  let invalidReason = null;

  const curS = Number(item.current_season) || 1;
  const curE = Number(item.current_episode) || 0;

  // Safe migration of older valid progress:
  // If watched_episodes is empty but current_episode > 0, validate progress (Cycle 1 legacy migration only)
  if (watchedEpisodes.length === 0 && curE > 0 && (!item.current_cycle || item.current_cycle === 1)) {
    const validation = validateEpisodeProgress(episodeInfo, curS, curE);
    if (validation.valid) {
      // Under the migration assumption: sequential viewing through that episode
      const toMark = episodeInfo.releasedEpisodes.filter(ep => 
        ep.season < curS || (ep.season === curS && ep.number <= curE)
      );
      if (toMark.length > 0) {
        markEpisodesBatch(mediaId, userId, toMark.map(e => ({
          season: e.season,
          episode: e.number,
          episodeId: e.id
        })));
        watchedEpisodes = getWatchedEpisodes(mediaId, userId);
      }
    } else {
      // Invalid progress (e.g. S1E44): do not guess or silently convert.
      isProgressInvalid = true;
      invalidReason = validation.error;
    }
  } else if (watchedEpisodes.length > 0) {
    // If watched_episodes already populated, check if media_items holds an uncorrected invalid progress
    const validation = validateEpisodeProgress(episodeInfo, curS, curE);
    if (!validation.valid && curE > 0) {
      isProgressInvalid = true;
      invalidReason = validation.error;
    }
  }

  const watchedSet = new Set(watchedEpisodes.map(we => `${we.season}-${we.episode}`));

  // Group regular episodes by season
  const seasonsMap = new Map();
  for (const ep of episodeInfo.allRegularEpisodes) {
    if (!seasonsMap.has(ep.season)) {
      seasonsMap.set(ep.season, []);
    }
    seasonsMap.get(ep.season).push(ep);
  }

  const seasons = [];
  const sortedSeasonNums = [...seasonsMap.keys()].sort((a, b) => a - b);

  let totalReleasedCount = 0;
  let totalWatchedCount = 0;

  for (const sNum of sortedSeasonNums) {
    const rawEps = seasonsMap.get(sNum);
    const sortedEps = [...rawEps].sort((a, b) => a.number - b.number);

    let releasedCount = 0;
    let upcomingCount = 0;
    let watchedCount = 0;

    const episodes = sortedEps.map(ep => {
      const isRel = isEpisodeReleased(ep);
      if (isRel) {
        releasedCount++;
        totalReleasedCount++;
      } else {
        upcomingCount++;
      }

      const isWatched = isRel && watchedSet.has(`${ep.season}-${ep.number}`);
      if (isWatched) {
        watchedCount++;
        totalWatchedCount++;
      }

      return {
        id: ep.id,
        season: ep.season,
        number: ep.number,
        name: ep.name || `Episode ${ep.number}`,
        airdate: ep.airdate || null,
        airstamp: ep.airstamp || null,
        runtime: ep.runtime || null,
        rating: ep.rating?.average || null,
        summary: ep.summary || '',
        image: ep.image?.medium || ep.image?.original || null,
        isReleased: isRel,
        isWatched,
        canWatch: isRel
      };
    });

    let status = 'Not started';
    if (releasedCount > 0 && watchedCount === releasedCount && upcomingCount === 0) {
      status = 'Completed';
    } else if (releasedCount > 0 && watchedCount === releasedCount && upcomingCount > 0) {
      status = 'Caught up';
    } else if (watchedCount > 0) {
      status = 'In progress';
    }

    const progressPercent = releasedCount > 0 ? Math.round((watchedCount / releasedCount) * 100) : 0;
    const firstEpWithImage = episodes.find(e => e.image);
    const seasonPoster = firstEpWithImage?.image || item.poster_url || null;
    const premiereDate = episodes[0]?.airdate || null;

    seasons.push({
      seasonNumber: sNum,
      name: `Season ${sNum}`,
      poster: seasonPoster,
      premiereDate,
      totalEpisodes: episodes.length,
      releasedEpisodes: releasedCount,
      upcomingEpisodes: upcomingCount,
      watchedCount,
      progressPercent,
      status,
      episodes
    });
  }

  // Calculate next episode from watchedSet
  const prog = calculateNextEpisode(episodeInfo, curS, curE, (watchedSet.size > 0 ? watchedSet : null));

  return {
    available: true,
    show: item,
    seasons,
    nextEpisode: prog.next,
    isCaughtUp: prog.isCaughtUp,
    totalWatchedCount,
    totalReleasedCount,
    isProgressInvalid,
    invalidProgressReason: invalidReason
  };
}

/**
 * Retrieves earlier unwatched regular released episodes before a specified episode.
 * Excludes specials and unreleased episodes. Uses actual chronological ordering.
 * Scoped to current user and current viewing cycle.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {number} season 
 * @param {number} episode 
 * @returns {Promise<object>}
 */
export async function getEarlierUnwatchedEpisodes(mediaId, userId, season, episode) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }

  if (item.type !== 'tv') {
    const err = new Error('Item is not a TV series.');
    err.statusCode = 400;
    throw err;
  }

  const s = Number(season);
  const e = Number(episode);

  if (!item.external_id) {
    return {
      hasEarlierUnwatched: false,
      count: 0,
      earlierSeasonsIncluded: false,
      seasonsBreakdown: [],
      episodes: []
    };
  }

  const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
  if (!episodeInfo || !episodeInfo.available) {
    return {
      hasEarlierUnwatched: false,
      count: 0,
      earlierSeasonsIncluded: false,
      seasonsBreakdown: [],
      episodes: []
    };
  }

  const targetEp = episodeInfo.allRegularEpisodes.find(ep => ep.season === s && ep.number === e);
  if (!targetEp) {
    const err = new Error(`Episode S${s} E${e} not found.`);
    err.statusCode = 404;
    throw err;
  }

  if (!isEpisodeReleased(targetEp)) {
    const err = new Error('Cannot mark upcoming, unreleased episode as watched.');
    err.statusCode = 400;
    throw err;
  }

  // Get current user's watched set for current cycle
  const watchedSet = getWatchedEpisodesSet(mediaId, userId);

  // Filter regular released episodes chronologically before (s, e)
  const earlierReleased = episodeInfo.releasedEpisodes.filter(ep =>
    ep.season < s || (ep.season === s && ep.number < e)
  );

  const earlierUnwatched = earlierReleased.filter(ep => !watchedSet.has(`${ep.season}-${ep.number}`));
  const earlierSeasonsIncluded = earlierUnwatched.some(ep => ep.season < s);

  const seasonCounts = new Map();
  for (const ep of earlierUnwatched) {
    seasonCounts.set(ep.season, (seasonCounts.get(ep.season) || 0) + 1);
  }
  const seasonsBreakdown = [...seasonCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNum, count]) => ({ season: seasonNum, count }));

  return {
    hasEarlierUnwatched: earlierUnwatched.length > 0,
    count: earlierUnwatched.length,
    earlierSeasonsIncluded,
    seasonsBreakdown,
    episodes: earlierUnwatched.map(ep => ({
      id: ep.id,
      season: ep.season,
      episode: ep.number,
      name: ep.name || `Episode ${ep.number}`,
      airdate: ep.airdate || null,
      runtime: ep.runtime || 0
    }))
  };
}

/**
 * Marks a specified episode as watched, optionally marking earlier unwatched episodes too.
 * Atomically executed, validates ownership, episode existence, and release status.
 * Scoped to current user and current viewing cycle.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {number} season 
 * @param {number} episode 
 * @param {object} [options]
 * @param {boolean} [options.markEarlier=false]
 * @param {boolean} [options.leaveDateUnknown=true]
 * @returns {Promise<object>}
 */
export async function markEpisodeWatchedWithEarlier(mediaId, userId, season, episode, { markEarlier = false, leaveDateUnknown = true } = {}) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }

  if (item.type !== 'tv') {
    const err = new Error('Item is not a TV series.');
    err.statusCode = 400;
    throw err;
  }

  const s = Number(season);
  const e = Number(episode);

  const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
  if (!episodeInfo || !episodeInfo.available) {
    const err = new Error('Episode data is unavailable.');
    err.statusCode = 400;
    throw err;
  }

  const ep = episodeInfo.allRegularEpisodes.find(ep => ep.season === s && ep.number === e);
  if (!ep) {
    const err = new Error(`Episode S${s} E${e} not found.`);
    err.statusCode = 404;
    throw err;
  }

  if (!isEpisodeReleased(ep)) {
    const err = new Error('Cannot mark upcoming, unreleased episode as watched.');
    err.statusCode = 400;
    throw err;
  }

  let markedEarlierCount = 0;
  if (markEarlier) {
    const earlierInfo = await getEarlierUnwatchedEpisodes(mediaId, userId, s, e);
    const earlierEpsToMark = episodeInfo.releasedEpisodes.filter(rep =>
      earlierInfo.episodes.some(ue => ue.season === rep.season && ue.episode === rep.number)
    );

    const result = markEpisodeWatchedWithCatchUp(mediaId, userId, ep, earlierEpsToMark, leaveDateUnknown);
    markedEarlierCount = result.earlierMarkedCount;
  } else {
    // Only mark target episode
    const currentlyWatched = isEpisodeWatched(mediaId, userId, s, e);
    if (!currentlyWatched) {
      markEpisodeWatched(mediaId, userId, s, e, ep.id);
      logActivity({
        userId,
        activityType: 'episode_watched',
        itemType: 'tv',
        itemId: mediaId,
        season: s,
        episode: e,
        minutesViewed: ep.runtime || 0,
        cycleNumber: item.current_cycle || 1,
        isCorrection: 0
      });
    }
  }

  await syncMediaWatchedProgress(mediaId, userId, episodeInfo);
  const data = await getShowSeasonsAndEpisodes(mediaId, userId);

  return {
    success: true,
    season: s,
    episode: e,
    isWatched: true,
    markedEarlier: Boolean(markEarlier),
    earlierCount: markedEarlierCount,
    showData: data
  };
}

/**
 * Toggles watched status of an individual episode.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {number} season 
 * @param {number} episode 
 * @param {object} [options]
 * @param {boolean} [options.markEarlier=false]
 * @param {boolean} [options.leaveDateUnknown=true]
 * @returns {Promise<object>}
 */
export async function toggleEpisodeWatched(mediaId, userId, season, episode, options = {}) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }

  const s = Number(season);
  const e = Number(episode);

  const currentlyWatched = isEpisodeWatched(mediaId, userId, s, e);

  // If unmarking, always unmark without earlier episodes
  if (currentlyWatched) {
    unmarkEpisodeWatched(mediaId, userId, s, e);
    removeActivityLog(userId, { itemType: 'tv', itemId: mediaId, season: s, episode: e, cycleNumber: item.current_cycle || 1 });

    const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
    if (episodeInfo && episodeInfo.available) {
      await syncMediaWatchedProgress(mediaId, userId, episodeInfo);
    }
    const data = await getShowSeasonsAndEpisodes(mediaId, userId);

    return {
      success: true,
      season: s,
      episode: e,
      isWatched: false,
      showData: data
    };
  }

  // If marking and markEarlier is requested, delegate to markEpisodeWatchedWithEarlier
  if (options.markEarlier) {
    return await markEpisodeWatchedWithEarlier(mediaId, userId, s, e, options);
  }

  // Normal mark of single episode
  const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
  if (!episodeInfo || !episodeInfo.available) {
    const err = new Error('Episode data is unavailable.');
    err.statusCode = 400;
    throw err;
  }

  const ep = episodeInfo.allRegularEpisodes.find(ep => ep.season === s && ep.number === e);
  if (!ep) {
    const err = new Error(`Episode S${s} E${e} not found.`);
    err.statusCode = 404;
    throw err;
  }

  if (!isEpisodeReleased(ep)) {
    const err = new Error('Cannot mark upcoming, unreleased episode as watched.');
    err.statusCode = 400;
    throw err;
  }

  markEpisodeWatched(mediaId, userId, s, e, ep.id);
  logActivity({
    userId,
    activityType: 'episode_watched',
    itemType: 'tv',
    itemId: mediaId,
    season: s,
    episode: e,
    minutesViewed: ep.runtime || 0,
    cycleNumber: item.current_cycle || 1,
    isCorrection: 0
  });

  await syncMediaWatchedProgress(mediaId, userId, episodeInfo);
  const data = await getShowSeasonsAndEpisodes(mediaId, userId);

  return {
    success: true,
    season: s,
    episode: e,
    isWatched: true,
    showData: data
  };
}

/**
 * Marks all released episodes of a season as watched.
 * Returns the list of marked episodes to support client-side Undo.
/**
 * Retrieves earlier seasons breakdown of unwatched released episodes before a given season.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {number} seasonNumber 
 * @returns {Promise<object>}
 */
export async function getEarlierUnwatchedSeasonsInfo(mediaId, userId, seasonNumber) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }
  const s = Number(seasonNumber);
  const data = await getShowSeasonsAndEpisodes(mediaId, userId);
  if (!data || !data.seasons) {
    return {
      currentSeason: { seasonNumber: s, unwatchedCount: 0, releasedEpisodes: 0, watchedCount: 0 },
      earlierSeasons: [],
      totalEarlierUnwatched: 0,
      hasEarlierUnwatched: false
    };
  }

  const curSeasonObj = data.seasons.find(season => season.seasonNumber === s);
  const currentUnwatched = curSeasonObj ? Math.max(0, curSeasonObj.releasedEpisodes - curSeasonObj.watchedCount) : 0;

  const earlierSeasons = [];
  let totalEarlierUnwatched = 0;

  for (const season of data.seasons) {
    if (season.seasonNumber < s) {
      const unwatched = Math.max(0, season.releasedEpisodes - season.watchedCount);
      if (unwatched > 0) {
        earlierSeasons.push({
          seasonNumber: season.seasonNumber,
          unwatchedCount: unwatched,
          releasedEpisodes: season.releasedEpisodes,
          watchedCount: season.watchedCount
        });
        totalEarlierUnwatched += unwatched;
      }
    }
  }

  return {
    currentSeason: {
      seasonNumber: s,
      unwatchedCount: currentUnwatched,
      releasedEpisodes: curSeasonObj?.releasedEpisodes || 0,
      watchedCount: curSeasonObj?.watchedCount || 0
    },
    earlierSeasons,
    totalEarlierUnwatched,
    hasEarlierUnwatched: totalEarlierUnwatched > 0
  };
}

/**
 * Bulk marks all released regular episodes of a season as watched,
 * optionally including unwatched released episodes from earlier seasons.
 * Excludes upcoming episodes and specials. Preserves already-watched episodes.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {number} seasonNumber 
 * @param {object} [options]
 * @param {boolean} [options.includeEarlier=false]
 * @returns {Promise<object>}
 */
export async function markSeasonWatched(mediaId, userId, seasonNumber, { includeEarlier = false } = {}) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }

  const s = Number(seasonNumber);
  const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
  if (!episodeInfo || !episodeInfo.available) {
    const err = new Error('Episode data is unavailable.');
    err.statusCode = 400;
    throw err;
  }

  // Filter regular released episodes according to option
  const targetEpisodes = episodeInfo.releasedEpisodes.filter(ep => {
    if (includeEarlier) {
      return ep.season <= s;
    }
    return ep.season === s;
  });

  if (targetEpisodes.length === 0) {
    const err = new Error(includeEarlier ? `No released episodes found up to Season ${s}.` : `No released episodes found for Season ${s}.`);
    err.statusCode = 400;
    throw err;
  }

  const watchedSet = getWatchedEpisodesSet(mediaId, userId);
  const toMark = targetEpisodes.filter(ep => !watchedSet.has(`${ep.season}-${ep.number}`));

  const currentCycle = item.current_cycle || 1;

  if (toMark.length > 0) {
    markEpisodesBatch(mediaId, userId, toMark.map(e => ({
      season: e.season,
      episode: e.number,
      episodeId: e.id
    })), currentCycle);

    for (const ep of toMark) {
      logActivity({
        userId,
        activityType: 'episode_watched',
        itemType: 'tv',
        itemId: mediaId,
        season: ep.season,
        episode: ep.number,
        minutesViewed: ep.runtime || 0,
        cycleNumber: currentCycle,
        isCorrection: 0
      });
    }
  }

  await syncMediaWatchedProgress(mediaId, userId, episodeInfo);
  const data = await getShowSeasonsAndEpisodes(mediaId, userId);

  const markedBySeason = {};
  for (const ep of toMark) {
    if (!markedBySeason[ep.season]) markedBySeason[ep.season] = 0;
    markedBySeason[ep.season]++;
  }

  return {
    success: true,
    season: s,
    includeEarlier: Boolean(includeEarlier),
    markedCount: toMark.length,
    markedBySeason,
    markedEpisodes: toMark.map(e => ({ season: e.season, episode: e.number, episodeId: e.id })),
    showData: data
  };
}

/**
 * Batch unmarks episodes (used for Undo).
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {Array<{season: number, episode: number}>} episodesList 
 * @returns {Promise<object>}
 */
export async function unmarkEpisodesBatchService(mediaId, userId, episodesList) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }

  const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
  const count = unmarkEpisodesBatch(mediaId, userId, episodesList);

  for (const ep of episodesList) {
    removeActivityLog(userId, { itemType: 'tv', itemId: mediaId, season: ep.season, episode: ep.episode, cycleNumber: item.current_cycle || 1 });
  }

  if (episodeInfo && episodeInfo.available) {
    await syncMediaWatchedProgress(mediaId, userId, episodeInfo);
  }

  const data = await getShowSeasonsAndEpisodes(mediaId, userId);
  return {
    success: true,
    unmarkedCount: count,
    showData: data
  };
}

/**
 * Shortcut from Edit Modal: "Mark watched through this episode"
 * Preserves any existing out-of-order episodes beyond (season, episode).
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {number} season 
 * @param {number} episode 
 */
export async function markWatchedThrough(mediaId, userId, season, episode) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }

  const s = Number(season);
  const e = Number(episode);

  const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
  if (episodeInfo && episodeInfo.available) {
    const validation = validateEpisodeProgress(episodeInfo, s, e);
    if (!validation.valid) {
      const err = new Error(validation.error);
      err.statusCode = 400;
      throw err;
    }

    if (e > 0) {
      const toMark = episodeInfo.releasedEpisodes.filter(ep => 
        ep.season < s || (ep.season === s && ep.number <= e)
      );
      if (toMark.length > 0) {
        markEpisodesBatch(mediaId, userId, toMark.map(ep => ({
          season: ep.season,
          episode: ep.number,
          episodeId: ep.id
        })));
        for (const ep of toMark) {
          logActivity({
            userId,
            activityType: 'episode_watched',
            itemType: 'tv',
            itemId: mediaId,
            season: ep.season,
            episode: ep.number,
            minutesViewed: ep.runtime || 0,
            isCorrection: 1
          });
        }
      }
    }
  }

  updateMedia(mediaId, userId, { current_season: s, current_episode: e });
}

/**
 * Synchronizes media_items progress with watched_episodes table.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {object} episodeInfo 
 */
export async function syncMediaWatchedProgress(mediaId, userId, episodeInfo) {
  const watchedEpisodes = getWatchedEpisodes(mediaId, userId);
  if (watchedEpisodes.length === 0) {
    updateMedia(mediaId, userId, { current_season: 1, current_episode: 0 });
    return;
  }

  // Find the highest watched episode
  let maxSeason = 1;
  let maxEpisode = 0;

  for (const we of watchedEpisodes) {
    if (we.season > maxSeason || (we.season === maxSeason && we.episode > maxEpisode)) {
      maxSeason = we.season;
      maxEpisode = we.episode;
    }
  }

  const fields = {
    current_season: maxSeason,
    current_episode: maxEpisode
  };

  // Check if all released episodes are watched
  if (episodeInfo && episodeInfo.releasedEpisodes && episodeInfo.releasedEpisodes.length > 0) {
    const watchedSet = new Set(watchedEpisodes.map(we => `${we.season}-${we.episode}`));
    const allReleasedWatched = episodeInfo.releasedEpisodes.every(ep => watchedSet.has(`${ep.season}-${ep.number}`));
    if (allReleasedWatched) {
      fields.status = 'completed';
      completeItemCycle(userId, 'tv', mediaId);
    }
  }

  updateMedia(mediaId, userId, fields);
}

/**
 * Enriches a media item with episode progression metadata for the frontend.
 * 
 * @param {object} item 
 * @param {number|string} [userId] 
 * @returns {Promise<object>}
 */
export async function enrichMediaItemWithProgression(item, userId = null) {
  if (!item || item.type !== 'tv') return item;

  if (!item.external_id) {
    return {
      ...item,
      next_episode: null,
      is_caught_up: false,
      is_progress_invalid: false,
      invalid_progress_reason: null,
      episode_data_unavailable: true
    };
  }

  try {
    const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
    let watchedSet = null;
    const effectiveUserId = userId || item.user_id;

    if (effectiveUserId) {
      watchedSet = getWatchedEpisodesSet(item.id, effectiveUserId);
      if (watchedSet.size === 0 && item.current_episode > 0 && (!item.current_cycle || item.current_cycle === 1)) {
        const val = validateEpisodeProgress(episodeInfo, item.current_season, item.current_episode);
        if (val.valid) {
          const toMark = episodeInfo.releasedEpisodes.filter(ep => 
            ep.season < item.current_season || (ep.season === item.current_season && ep.number <= item.current_episode)
          );
          if (toMark.length > 0) {
            markEpisodesBatch(item.id, effectiveUserId, toMark.map(e => ({
              season: e.season,
              episode: e.number,
              episodeId: e.id
            })));
            watchedSet = getWatchedEpisodesSet(item.id, effectiveUserId);
          }
        }
      }
    }

    const prog = calculateNextEpisode(
      episodeInfo,
      item.current_season,
      item.current_episode,
      (watchedSet && watchedSet.size > 0 ? watchedSet : null)
    );

    return {
      ...item,
      next_episode: prog.next,
      is_caught_up: prog.isCaughtUp,
      is_progress_invalid: prog.isInvalid,
      invalid_progress_reason: prog.reason || null,
      episode_data_unavailable: prog.unavailable || false
    };
  } catch (err) {
    return {
      ...item,
      next_episode: null,
      is_caught_up: false,
      is_progress_invalid: false,
      invalid_progress_reason: null,
      episode_data_unavailable: true
    };
  }
}

/**
 * Increments episode progress to the next real, released, unwatched episode.
 * Enforces ownership, valid progression, and prevents skipping or invalid updates.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @returns {Promise<object>}
 */
export async function incrementShowEpisode(mediaId, userId) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }

  if (item.type !== 'tv') {
    const err = new Error('Only TV series support episode progress increment.');
    err.statusCode = 400;
    throw err;
  }

  if (!item.external_id) {
    const err = new Error('Episode data is unavailable for this series. Please update progress via Edit.');
    err.statusCode = 400;
    throw err;
  }

  const episodeInfo = await getSeriesEpisodeInfo(item.external_id);
  if (!episodeInfo || !episodeInfo.available) {
    const err = new Error('Episode data is unavailable for this series. Please update progress via Edit.');
    err.statusCode = 400;
    throw err;
  }

  const seasonsData = await getShowSeasonsAndEpisodes(mediaId, userId);

  if (seasonsData.isProgressInvalid) {
    const err = new Error(`Current progress (Season ${item.current_season} Episode ${item.current_episode}) is invalid for this series. ${seasonsData.invalidProgressReason || ''} Please select a valid season and episode via Edit.`);
    err.statusCode = 400;
    throw err;
  }

  if (seasonsData.isCaughtUp || !seasonsData.nextEpisode) {
    const err = new Error('You are already caught up with all released episodes.');
    err.statusCode = 400;
    throw err;
  }

  const next = seasonsData.nextEpisode;

  // Mark the next episode as watched in watched_episodes
  const epObj = episodeInfo.releasedEpisodes.find(e => e.season === next.season && e.number === next.episode);
  markEpisodeWatched(mediaId, userId, next.season, next.episode, epObj?.id || null);
  logActivity({
    userId,
    activityType: 'episode_watched',
    itemType: 'tv',
    itemId: mediaId,
    season: next.season,
    episode: next.episode,
    minutesViewed: epObj?.runtime || 0,
    cycleNumber: item.current_cycle || 1,
    isCorrection: 0
  });

  await syncMediaWatchedProgress(mediaId, userId, episodeInfo);

  const updatedItem = getMediaById(mediaId, userId);
  return await enrichMediaItemWithProgression(updatedItem, userId);
}

/**
 * Refreshes episode details from TVMaze for an existing series, updating missing runtimes
 * without wiping existing valid runtimes or manual corrections.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @returns {Promise<object>}
 */
export async function refreshSeriesEpisodeDetails(mediaId, userId) {
  const show = getMediaById(mediaId, userId);
  if (!show) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }
  if (show.type !== 'tv') {
    const err = new Error('Only TV series can have episode details refreshed');
    err.statusCode = 400;
    throw err;
  }
  if (!show.external_id) {
    const err = new Error('Series is not linked to TVMaze');
    err.statusCode = 400;
    throw err;
  }

  const idStr = String(show.external_id);

  // Count runtimes in cache before refresh
  const beforeDb = getCachedEpisodes(idStr);
  const beforeEpisodes = beforeDb?.episodes || [];
  const beforeKnownCount = beforeEpisodes.filter(e => e.runtime && Number(e.runtime) > 0).length;

  // Force refresh from TVMaze API (bypassing cache)
  let freshInfo;
  try {
    freshInfo = await getSeriesEpisodeInfo(idStr, true);
  } catch (err) {
    console.error(`[TVMaze] Refresh failed for show ${mediaId}:`, err.message);
    const error = new Error(`Could not reach TVMaze API: ${err.message}. Existing saved metadata preserved.`);
    error.statusCode = 502;
    throw error;
  }

  if (!freshInfo || !freshInfo.available) {
    const error = new Error(freshInfo?.error || 'Could not reach TVMaze API. Existing saved metadata preserved.');
    error.statusCode = 502;
    throw error;
  }

  // Count runtimes in cache after refresh
  const afterDb = getCachedEpisodes(idStr);
  const afterEpisodes = afterDb?.episodes || [];
  const afterKnownCount = afterEpisodes.filter(e => e.runtime && Number(e.runtime) > 0).length;
  const unknownRuntimesCount = afterEpisodes.filter(e => !e.runtime || Number(e.runtime) <= 0).length;
  const updatedRuntimesCount = Math.max(0, afterKnownCount - beforeKnownCount);

  // Update activity_log minutes_viewed if runtime was newly retrieved for watched episodes
  if (afterKnownCount > 0) {
    const epMap = new Map();
    for (const ep of afterEpisodes) {
      if (ep.runtime && Number(ep.runtime) > 0) {
        epMap.set(`${ep.season}-${ep.number}`, Number(ep.runtime));
      }
    }
    const unloggedActs = db.prepare(`
      SELECT id, season, episode FROM activity_log
      WHERE user_id = ? AND item_type = 'tv' AND item_id = ? AND (minutes_viewed IS NULL OR minutes_viewed = 0)
    `).all(userId, mediaId);

    const updateActStmt = db.prepare(`
      UPDATE activity_log SET minutes_viewed = ? WHERE id = ?
    `);
    for (const act of unloggedActs) {
      const rt = epMap.get(`${act.season}-${act.episode}`);
      if (rt && rt > 0) {
        updateActStmt.run(rt, act.id);
      }
    }
  }

  // Sync latest show air dates / progress
  await syncMediaWatchedProgress(mediaId, userId, freshInfo);
  const enriched = await enrichMediaItemWithProgression(getMediaById(mediaId, userId), userId);

  return {
    success: true,
    show: { id: show.id, title: show.title },
    updatedRuntimesCount,
    unknownRuntimesCount,
    totalEpisodes: afterEpisodes.length,
    item: enriched,
    message: updatedRuntimesCount > 0
      ? `Refreshed "${show.title}": updated ${updatedRuntimesCount} episode runtime(s). ${unknownRuntimesCount} episode(s) remain unknown.`
      : `Refreshed "${show.title}": metadata is up to date. ${unknownRuntimesCount} episode(s) have unknown runtime from provider.`
  };
}

/**
 * Sets a manual runtime correction for a specific TV episode.
 * 
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {number} season 
 * @param {number} episode 
 * @param {number} runtime 
 * @returns {Promise<object>}
 */
export async function setEpisodeManualRuntime(mediaId, userId, season, episode, runtime) {
  const show = getMediaById(mediaId, userId);
  if (!show) {
    const err = new Error('Media not found or not authorized');
    err.statusCode = 404;
    throw err;
  }
  if (show.type !== 'tv') {
    const err = new Error('Only TV series have episode runtimes');
    err.statusCode = 400;
    throw err;
  }

  const s = Number(season);
  const e = Number(episode);
  const rt = Math.round(Number(runtime));

  if (isNaN(s) || isNaN(e) || s <= 0 || e <= 0) {
    const err = new Error('Valid season and episode numbers are required');
    err.statusCode = 400;
    throw err;
  }

  if (isNaN(rt) || rt <= 0) {
    const err = new Error('Runtime must be a positive number of minutes (e.g. 45)');
    err.statusCode = 400;
    throw err;
  }

  if (!show.external_id) {
    const err = new Error('Series is not linked to TVMaze');
    err.statusCode = 400;
    throw err;
  }

  const idStr = String(show.external_id);
  let cached = getCachedEpisodes(idStr);
  if (!cached || !Array.isArray(cached.episodes)) {
    await getSeriesEpisodeInfo(idStr);
    cached = getCachedEpisodes(idStr);
  }

  if (!cached || !Array.isArray(cached.episodes)) {
    const err = new Error('Could not load episode details for this series');
    err.statusCode = 502;
    throw err;
  }

  const epObj = cached.episodes.find(ep => Number(ep.season) === s && Number(ep.number) === e);
  if (!epObj) {
    const err = new Error(`Season ${s} Episode ${e} not found in series episodes`);
    err.statusCode = 404;
    throw err;
  }

  epObj.runtime = rt;
  epObj.is_runtime_manual = 1;

  setCachedEpisodes(idStr, cached);
  memoryEpisodeCache.delete(idStr);

  // Update activity_log minutes_viewed if this episode was logged
  db.prepare(`
    UPDATE activity_log
    SET minutes_viewed = ?
    WHERE user_id = ? AND item_type = 'tv' AND item_id = ? AND season = ? AND episode = ?
  `).run(rt, userId, mediaId, s, e);

  return {
    success: true,
    season: s,
    episode: e,
    runtime: rt,
    isManual: true,
    message: `Runtime for Season ${s} Episode ${e} updated to ${rt} minutes.`
  };
}

