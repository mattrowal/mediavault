import { db, getAllMedia, getMediaById, updateMedia, getWatchedEpisodesSet } from './db.js';
import { getSeriesEpisodeInfo } from './episode-service.js';

/**
 * Helper to get YYYY-MM-DD in a specific timezone.
 */
function getTzYMD(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(date);
  } catch (_) {
    return date.toISOString().split('T')[0];
  }
}

/**
 * Formats a release date and optional airtime into a user-friendly timezone string.
 * Converts known release timestamps (airstamp) to the user's timezone.
 * If only a date is known, displays the date without inventing a release time.
 * 
 * @param {string|object} airDate (YYYY-MM-DD) or options object
 * @param {string} [airTime] (HH:mm)
 * @param {string} [timeZone] (e.g. 'America/New_York', 'UTC', 'Europe/Stockholm')
 * @param {string} [airstamp] (ISO 8601 string)
 * @returns {object}
 */
export function formatEpisodeSchedule(airDate, airTime = '', timeZone = 'UTC', airstamp = null) {
  if (typeof airDate === 'object' && airDate !== null) {
    airstamp = airDate.airstamp || null;
    timeZone = airDate.timeZone || 'UTC';
    airTime = airDate.airTime || airDate.airtime || '';
    airDate = airDate.airDate || airDate.airdate || '';
  }

  if (!airDate && !airstamp) {
    return {
      formattedDate: 'Date TBA',
      formattedTime: '',
      relativeLabel: 'TBA',
      diffDays: null
    };
  }

  // Calculate local date strings in target timezone
  let targetYMD = airDate;
  if (airstamp) {
    try {
      const d = new Date(airstamp);
      if (!isNaN(d.getTime())) {
        targetYMD = getTzYMD(d, timeZone);
      }
    } catch (_) {}
  }

  const todayYMD = getTzYMD(new Date(), timeZone);
  const targetMidnight = new Date(targetYMD + 'T00:00:00Z');
  const todayMidnight = new Date(todayYMD + 'T00:00:00Z');
  const diffDays = Math.round((targetMidnight.getTime() - todayMidnight.getTime()) / (1000 * 60 * 60 * 24));

  // Format localized date
  let formattedDate = targetYMD;
  if (airstamp) {
    try {
      const d = new Date(airstamp);
      if (!isNaN(d.getTime())) {
        formattedDate = d.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: timeZone || 'UTC'
        });
      }
    } catch (_) {}
  } else if (airDate) {
    try {
      const d = new Date(airDate + 'T12:00:00Z');
      formattedDate = d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: timeZone || 'UTC'
      });
    } catch (_) {}
  }

  // Format localized time: if only date is known, DO NOT invent release time
  let formattedTime = '';
  if (airstamp) {
    try {
      const d = new Date(airstamp);
      if (!isNaN(d.getTime())) {
        const timeFmt = new Intl.DateTimeFormat('en-GB', {
          timeZone: timeZone || 'UTC',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        formattedTime = `${timeFmt.format(d)} (${timeZone || 'UTC'})`;
      }
    } catch (_) {}
  } else if (airTime && String(airTime).trim()) {
    formattedTime = `${String(airTime).trim()} (${timeZone || 'UTC'})`;
  } else {
    // If only a date is known, display the date without inventing a release time
    formattedTime = '';
  }

  // Calculate relative label
  let relativeLabel = '';
  if (diffDays === 0) relativeLabel = 'Today';
  else if (diffDays === 1) relativeLabel = 'Tomorrow';
  else if (diffDays === -1) relativeLabel = 'Yesterday';
  else if (diffDays > 1 && diffDays <= 7) relativeLabel = `In ${diffDays} days`;
  else if (diffDays < -1 && diffDays >= -7) relativeLabel = `${Math.abs(diffDays)} days ago`;
  else relativeLabel = formattedDate;

  return {
    formattedDate,
    formattedTime,
    relativeLabel,
    diffDays
  };
}

/**
 * Retrieves upcoming episodes for followed series in the user's library within a date window.
 * @param {number|string} userId 
 * @param {object} options 
 * @returns {Promise<object>}
 */
export async function getUpcomingCalendar(userId, options = {}) {
  const {
    days = 30,
    includeWatched = false,
    timeZone = 'UTC'
  } = options;

  if (!userId) throw new Error('User ID is required');

  const maxDays = Math.min(90, Math.max(1, Number(days) || 30));

  // Determine date bounds in the requested timezone
  const todayYMD = getTzYMD(new Date(), timeZone);
  const futureLimit = new Date();
  futureLimit.setDate(futureLimit.getDate() + maxDays);
  const futureLimitStr = getTzYMD(futureLimit, timeZone);

  // Past limit: yesterday in timezone to catch today's prime time
  const pastLimit = new Date();
  pastLimit.setDate(pastLimit.getDate() - 1);
  const pastLimitStr = getTzYMD(pastLimit, timeZone);

  // Get all followed TV series for this user (excluding dropped)
  const allMedia = getAllMedia(userId);
  const tvShows = allMedia.filter(m => m.type === 'tv' && m.external_id && m.status !== 'dropped');

  const upcomingEpisodes = [];

  for (const show of tvShows) {
    try {
      const epInfo = await getSeriesEpisodeInfo(show.external_id);
      if (!epInfo || !epInfo.allRegularEpisodes) continue;

      const watchedSet = getWatchedEpisodesSet(show.id, userId);
      const isNotifyEnabled = show.notify_enabled !== 0;

      for (const ep of epInfo.allRegularEpisodes) {
        if (!ep.airdate && !ep.airstamp) continue;

        const schedule = formatEpisodeSchedule(ep.airdate, ep.airtime, timeZone, ep.airstamp);

        // Check if within window
        const epDateStr = ep.airdate || (ep.airstamp ? ep.airstamp.slice(0, 10) : '');
        if (epDateStr >= pastLimitStr && epDateStr <= futureLimitStr) {
          const isWatched = watchedSet.has(`${ep.season}-${ep.number}`);
          if (isWatched && !includeWatched) continue;

          // Stable unique identifier per episode for this series
          const stableId = `cal_${show.id}_ep${ep.id || `s${ep.season}e${ep.number}`}`;

          upcomingEpisodes.push({
            id: stableId,
            episodeId: ep.id || null,
            showId: show.id,
            showTitle: show.title,
            posterUrl: show.poster_url || null,
            externalId: show.external_id,
            season: ep.season,
            episode: ep.number,
            episodeTitle: ep.name || `Episode ${ep.number}`,
            airDate: ep.airdate || epDateStr,
            airTime: ep.airtime || '',
            airstamp: ep.airstamp || null,
            runtime: ep.runtime || 0,
            summary: ep.summary ? ep.summary.replace(/<[^>]*>?/gm, '').trim() : '',
            isWatched,
            notifyEnabled: isNotifyEnabled,
            formattedDate: schedule.formattedDate,
            formattedTime: schedule.formattedTime,
            relativeLabel: schedule.relativeLabel,
            diffDays: schedule.diffDays
          });
        }
      }
    } catch (err) {
      console.warn(`[Calendar] Failed to load schedule for show ${show.id}:`, err.message);
    }
  }

  // Sort chronologically: airdate ASC, airtime ASC, showTitle ASC, season ASC, episode ASC
  upcomingEpisodes.sort((a, b) => {
    if (a.airDate !== b.airDate) return a.airDate.localeCompare(b.airDate);
    if (a.airTime !== b.airTime) return (a.airTime || '').localeCompare(b.airTime || '');
    if (a.showTitle !== b.showTitle) return a.showTitle.localeCompare(b.showTitle);
    return a.season - b.season || a.episode - b.episode;
  });

  // Group into Agenda sections: Today, This Week (next 7 days), Later (up to maxDays)
  const today = [];
  const thisWeek = [];
  const later = [];

  for (const item of upcomingEpisodes) {
    if (item.diffDays !== null && item.diffDays <= 0) {
      today.push(item);
    } else if (item.diffDays !== null && item.diffDays <= 7) {
      thisWeek.push(item);
    } else {
      later.push(item);
    }
  }

  // Calculate last successful check and staleness info
  let latestSyncTimestamp = 0;
  let latestSyncStr = null;
  for (const s of tvShows) {
    if (s.last_synced_at) {
      const ms = new Date(s.last_synced_at).getTime();
      if (!isNaN(ms) && ms > latestSyncTimestamp) {
        latestSyncTimestamp = ms;
        latestSyncStr = s.last_synced_at;
      }
    }
  }

  const isStale = tvShows.length > 0 && (!latestSyncTimestamp || (Date.now() - latestSyncTimestamp > 24 * 60 * 60 * 1000));

  return {
    timeZone,
    windowDays: maxDays,
    totalCount: upcomingEpisodes.length,
    followedSeriesCount: tvShows.length,
    lastSyncedAt: latestSyncStr,
    isStale,
    hasUpcomingEpisodes: upcomingEpisodes.length > 0,
    serverRunningNotice: 'Automatic episode checks run in the background only while the MediaVault server is running.',
    agenda: {
      today,
      thisWeek,
      later
    },
    episodes: upcomingEpisodes
  };
}

/**
 * Updates notification preference for a specific TV series owned by user.
 * @param {number|string} mediaId 
 * @param {number|string} userId 
 * @param {boolean|number} notifyEnabled 
 * @returns {object}
 */
export function updateShowNotificationPreference(mediaId, userId, notifyEnabled) {
  const item = getMediaById(mediaId, userId);
  if (!item) {
    const err = new Error('TV series not found or unauthorized');
    err.status = 404;
    throw err;
  }
  if (item.type !== 'tv') {
    const err = new Error('Notification preferences can only be set for TV series');
    err.status = 400;
    throw err;
  }

  const enabledVal = (notifyEnabled === true || notifyEnabled === 1 || notifyEnabled === '1' || notifyEnabled === 'true') ? 1 : 0;
  updateMedia(mediaId, userId, { notify_enabled: enabledVal });

  return {
    success: true,
    mediaId: Number(mediaId),
    notifyEnabled: enabledVal === 1
  };
}
