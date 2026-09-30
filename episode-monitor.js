import {
  getAllDistinctFollowedTVShows,
  getAllTVShowsWithExternalId,
  updateMedia,
  updateShowScheduleAcrossUsers,
  getUsersBehindOnShow,
  createNotification,
  isEpisodeWatched,
  hasEverWatchedEpisode
} from './db.js';
import { getSeriesEpisodeInfo } from './episode-service.js';

/**
 * Helper delay function to throttle outgoing requests to TVMaze.
 * @param {number} ms 
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Concurrency control to prevent overlapping checks
let isCheckingEpisodes = false;
let lastSuccessfulCheckTime = null;
let lastCheckError = null;

/**
 * Returns diagnostic monitoring status.
 */
export function getMonitorStatus() {
  return {
    isChecking: isCheckingEpisodes,
    lastSuccessfulCheckTime,
    lastCheckError,
    serverRunningNotice: 'Automatic checks run only while the local MediaVault server is running.'
  };
}

/**
 * Fetches episode and schedule details for a single show from TVMaze API.
 * Rate-limit resilient with exponential backoff on HTTP 429.
 * 
 * @param {string|number} tvmazeId 
 * @returns {Promise<object|null>}
 */
export async function fetchTVMazeDetails(tvmazeId) {
  if (!tvmazeId) return null;
  try {
    const info = await getSeriesEpisodeInfo(tvmazeId);
    if (!info || !info.available) return null;

    return {
      latest_season: info.latestReleased?.season || 1,
      latest_episode: info.latestReleased?.number || 0,
      latest_episode_name: info.latestReleased?.name || '',
      latest_episode_id: info.latestReleased?.id || null,
      latest_air_date: info.latestReleased?.airdate || null,
      next_air_date: info.nextAirDate || null,
      total_episodes: info.allRegularEpisodes ? info.allRegularEpisodes.length : 0,
      series_status: info.showStatus || ''
    };
  } catch (err) {
    console.error(`[TVMaze] Error fetching show ${tvmazeId}:`, err.message);
    return null;
  }
}

/**
 * Runs a complete episode check cycle across all followed TV shows.
 * Groups by distinct external_id so TVMaze is queried only once per show,
 * regardless of how many users follow it.
 * 
 * @param {object} options
 * @param {number} [options.maxCatchupDays=7]
 * @returns {Promise<{ showsChecked: number, notificationsCreated: number, skipped?: boolean }>}
 */
export async function runEpisodeCheckCycle({ maxCatchupDays = 7 } = {}) {
  if (isCheckingEpisodes) {
    console.log('[Episode Monitor] Check cycle already in progress. Skipping overlapping run.');
    return { showsChecked: 0, notificationsCreated: 0, skipped: true };
  }

  isCheckingEpisodes = true;
  const uniqueShows = getAllDistinctFollowedTVShows();
  let notificationsCreated = 0;
  let showsChecked = 0;

  try {
    if (uniqueShows.length === 0) {
      lastSuccessfulCheckTime = new Date().toISOString();
      lastCheckError = null;
      return { showsChecked: 0, notificationsCreated: 0 };
    }

    console.log(`[Episode Monitor] Starting check cycle for ${uniqueShows.length} distinct followed TV shows...`);

    for (const show of uniqueShows) {
      // 500ms delay between TVMaze calls to strictly respect API limits (max 20 req / 10s)
      await delay(500);

      const tvInfo = await fetchTVMazeDetails(show.external_id);
      if (!tvInfo) {
        // Preserve valid cached information when a refresh fails
        continue;
      }
      showsChecked++;

      // Update latest air dates and schedule for this show across all users
      updateShowScheduleAcrossUsers(show.external_id, tvInfo);

      // Bounded catch-up check: limit notifications to recent releases (default 7 days)
      if (tvInfo.latest_air_date) {
        const airDateMs = new Date(tvInfo.latest_air_date).getTime();
        const nowMs = Date.now();
        const daysDiff = (nowMs - airDateMs) / (1000 * 60 * 60 * 24);
        if (daysDiff < 0 || (maxCatchupDays && daysDiff > maxCatchupDays)) {
          continue;
        }
      }

      // Identify users watching this show whose watched progress is behind the latest aired episode
      const usersBehind = getUsersBehindOnShow(show.external_id, tvInfo.latest_season, tvInfo.latest_episode);

      for (const item of usersBehind) {
        // Notification preference per series
        if (item.notify_enabled === 0) {
          continue;
        }

        // Rewatch protection: starting a rewatch must not recreate release notifications for old episodes
        if (hasEverWatchedEpisode(item.id, item.user_id, tvInfo.latest_season, tvInfo.latest_episode)) {
          continue;
        }

        if (isEpisodeWatched(item.id, item.user_id, tvInfo.latest_season, tvInfo.latest_episode)) {
          continue;
        }

        const episodeLabel = tvInfo.latest_episode_name ? ` "${tvInfo.latest_episode_name}"` : '';
        // Neutral message: do not claim specific streaming availability or region without data
        const message = `Season ${tvInfo.latest_season}, Episode ${tvInfo.latest_episode}${episodeLabel} has been released.`;

        // Compound unique index + episode_id prevents duplicates after repeated checks or server restarts
        const inserted = createNotification({
          userId: item.user_id,
          mediaId: item.id,
          episodeId: tvInfo.latest_episode_id || null,
          type: 'episode_release',
          title: `New Episode: ${item.title}`,
          message,
          season: tvInfo.latest_season,
          episode: tvInfo.latest_episode,
          airDate: tvInfo.latest_air_date
        });

        if (inserted) {
          notificationsCreated++;
          console.log(`🔔 [Notification] Created alert for User #${item.user_id}: ${item.title} S${tvInfo.latest_season}E${tvInfo.latest_episode}`);
        }
      }
    }

    lastSuccessfulCheckTime = new Date().toISOString();
    lastCheckError = null;
    console.log(`[Episode Monitor] Cycle finished: ${showsChecked}/${uniqueShows.length} shows verified, ${notificationsCreated} new notifications issued.`);
    return { showsChecked, notificationsCreated };
  } catch (err) {
    lastCheckError = err.message;
    console.error('[Episode Monitor] Check cycle error:', err.message);
    throw err;
  } finally {
    isCheckingEpisodes = false;
  }
}

/**
 * Manually synchronizes all followed TV series for a single user.
 * Reuses the exact same rate-limiting, rewatch protection, and deduplication logic.
 * 
 * @param {number|string} userId 
 * @param {object} [options]
 * @param {number} [options.maxCatchupDays=7]
 * @returns {Promise<{ success: boolean, updatedCount: number, totalSeries: number, newNotifications: number }>}
 */
export async function syncSeriesForUser(userId, { maxCatchupDays = 7 } = {}) {
  if (!userId) throw new Error('User ID is required');

  const seriesList = getAllTVShowsWithExternalId(userId);
  let updatedCount = 0;
  let newNotifications = 0;

  for (const item of seriesList) {
    await delay(100);

    const tvInfo = await fetchTVMazeDetails(item.external_id);
    if (!tvInfo) {
      // Preserve valid cached information when a refresh fails
      continue;
    }

    updateMedia(item.id, userId, {
      latest_season: tvInfo.latest_season,
      latest_episode: tvInfo.latest_episode,
      latest_episode_name: tvInfo.latest_episode_name,
      latest_air_date: tvInfo.latest_air_date,
      next_air_date: tvInfo.next_air_date,
      total_episodes: tvInfo.total_episodes,
      last_synced_at: new Date().toISOString()
    });
    updatedCount++;

    // Notification preference per series
    if (item.notify_enabled === 0) continue;

    // Check if user is behind
    const isBehind = (
      tvInfo.latest_season > (item.current_season || 0) ||
      (tvInfo.latest_season === item.current_season && tvInfo.latest_episode > (item.current_episode || 0))
    );
    if (!isBehind) continue;

    // Rewatch protection: starting a rewatch must not recreate release notifications for old episodes
    if (hasEverWatchedEpisode(item.id, userId, tvInfo.latest_season, tvInfo.latest_episode)) {
      continue;
    }

    // Bounded catch-up check: only notify for recent releases (default 7 days)
    if (tvInfo.latest_air_date) {
      const airDateMs = new Date(tvInfo.latest_air_date).getTime();
      const nowMs = Date.now();
      const daysDiff = (nowMs - airDateMs) / (1000 * 60 * 60 * 24);
      if (daysDiff < 0 || (maxCatchupDays && daysDiff > maxCatchupDays)) {
        continue;
      }
    }

    const epName = tvInfo.latest_episode_name ? ` "${tvInfo.latest_episode_name}"` : '';
    const inserted = createNotification({
      userId,
      mediaId: item.id,
      episodeId: tvInfo.latest_episode_id || null,
      type: 'episode_release',
      title: `New Episode: ${item.title}`,
      message: `Season ${tvInfo.latest_season}, Episode ${tvInfo.latest_episode}${epName} has been released.`,
      season: tvInfo.latest_season,
      episode: tvInfo.latest_episode,
      airDate: tvInfo.latest_air_date
    });

    if (inserted) {
      newNotifications++;
    }
  }

  return { success: true, updatedCount, totalSeries: seriesList.length, newNotifications };
}

/**
 * Initializes the recurring background timer for episode checks.
 * Uses .unref() so the timer does not prevent clean process shutdown.
 * 
 * @param {number} [intervalHours] 
 * @returns {NodeJS.Timeout}
 */
export function startEpisodeMonitoring(intervalHours) {
  const envHours = Number(process.env.EPISODE_CHECK_INTERVAL_HOURS);
  const hours = !isNaN(envHours) && envHours > 0 ? envHours : (Number(intervalHours) || 6);
  const intervalMs = hours * 60 * 60 * 1000;

  console.log(`⏱️ [Episode Monitor] Background scheduler active (Checking every ${hours} hours)`);

  // Run initial bounded catch-up check after a short 10-second startup delay
  setTimeout(() => {
    runEpisodeCheckCycle({ maxCatchupDays: 7 }).catch(err => {
      console.error('[Episode Monitor] Initial catch-up check cycle error:', err.message);
    });
  }, 10 * 1000).unref();

  // Recurring timer
  const timer = setInterval(() => {
    runEpisodeCheckCycle({ maxCatchupDays: 7 }).catch(err => {
      console.error('[Episode Monitor] Recurring check cycle error:', err.message);
    });
  }, intervalMs);

  timer.unref();
  return timer;
}
