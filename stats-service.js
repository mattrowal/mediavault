import { db, getAllMedia, getAllBooks, getWatchedEpisodes, getUserActivities } from './db.js';
import { getShowSeasonsAndEpisodes, getSeriesEpisodeInfo } from './episode-service.js';

/**
 * Formats minutes into human-readable hours string (e.g. "142.5 hrs" or "142 hrs 30 mins").
 * @param {number} minutes 
 * @returns {string}
 */
export function formatMinutesToHours(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const hrs = Math.floor(m / 60);
  const remMin = m % 60;
  if (hrs === 0 && remMin === 0) return '0 hrs';
  if (remMin === 0) return `${hrs} hrs`;
  return `${hrs} hrs ${remMin} mins`;
}

/**
 * Formats minutes into days and hours string (e.g. "2 days, 14 hrs").
 * @param {number} minutes 
 * @returns {string}
 */
export function formatMinutesToDaysAndHours(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const days = Math.floor(m / 1440);
  const hrs = Math.floor((m % 1440) / 60);

  const parts = [];
  parts.push(`${days} day${days === 1 ? '' : 's'}`);
  parts.push(`${hrs} hr${hrs === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Calculates comprehensive personal statistics for a user, supporting 'all_time',
 * 'this_year', and 'this_month' date filtering.
 * 
 * @param {number|string} userId 
 * @param {string} [period='all_time'] - 'all_time', 'this_year', 'this_month'
 * @returns {Promise<object>}
 */
export async function getPersonalStatistics(userId, period = 'all_time') {
  if (!userId) {
    throw new Error('User ID is required for personal statistics');
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
  const thisYearStart = `${currentYear}-01-01 00:00:00`;
  const thisMonthStart = `${currentYear}-${currentMonth}-01 00:00:00`;

  let dateFilter = null;
  if (period === 'this_year') {
    dateFilter = thisYearStart;
  } else if (period === 'this_month') {
    dateFilter = thisMonthStart;
  }

  // 1. Fetch User's Library Data (ownership enforced)
  const mediaItems = getAllMedia(userId);
  const books = getAllBooks(userId);

  // Separate movies and TV series
  const movies = mediaItems.filter(m => m.type === 'movie');
  const tvSeries = mediaItems.filter(m => m.type === 'tv');

  // 2. Movies Calculations (Unique Titles + Repeat Cycles)
  const movieCycles = db.prepare(`
    SELECT c.*, m.runtime, m.title
    FROM consumption_cycles c
    JOIN media_items m ON c.item_id = m.id AND c.user_id = m.user_id
    WHERE c.user_id = ? AND c.item_type = 'movie' AND c.status = 'completed'
  `).all(userId);

  const completedMovieIds = new Set();
  let totalMovieCompletions = 0;
  let movieMinutes = 0;
  let missingMovieRuntimes = 0;

  for (const c of movieCycles) {
    if (dateFilter) {
      const cDate = c.completed_at || c.updated_at;
      if (!cDate || cDate < dateFilter) continue;
    }
    completedMovieIds.add(c.item_id);
    totalMovieCompletions++;
    const rt = Number(c.runtime);
    if (rt && rt > 0) {
      movieMinutes += rt;
    } else {
      missingMovieRuntimes++;
    }
  }

  // Fallback for completed movies without explicit cycle row
  for (const movie of movies) {
    if (movie.status === 'completed' && !completedMovieIds.has(movie.id)) {
      if (dateFilter) {
        const act = db.prepare(`
          SELECT created_at FROM activity_log
          WHERE user_id = ? AND item_type = 'movie' AND item_id = ? AND activity_type = 'movie_watched'
          ORDER BY id DESC LIMIT 1
        `).get(userId, movie.id);
        const completionDate = act?.created_at || movie.created_at;
        if (!completionDate || completionDate < dateFilter) continue;
      }
      completedMovieIds.add(movie.id);
      totalMovieCompletions++;
      const runtime = Number(movie.runtime);
      if (runtime && runtime > 0) {
        movieMinutes += runtime;
      } else {
        missingMovieRuntimes++;
      }
    }
  }
  const moviesWatchedCount = completedMovieIds.size;

  // 3. TV Series & Episodes Calculations (All cycles)
  let episodesWatchedCount = 0;
  let tvMinutes = 0;
  let missingEpisodeRuntimes = 0;
  let seasonsCompletedCount = 0;
  let historicalEpisodesWithoutDate = 0;
  const allShowEpisodeMaps = new Map();

  for (const show of tvSeries) {
    // Retrieve all watched episodes across all cycles for accurate viewing totals
    const watchedEps = db.prepare(`
      SELECT * FROM watched_episodes
      WHERE media_id = ? AND user_id = ?
      ORDER BY season ASC, episode ASC
    `).all(show.id, userId);

    let episodeMap = new Map();

    if (show.external_id) {
      try {
        const epInfo = await getSeriesEpisodeInfo(show.external_id);
        if (epInfo && epInfo.allRegularEpisodes) {
          for (const ep of epInfo.allRegularEpisodes) {
            episodeMap.set(`${ep.season}-${ep.number}`, ep);
          }
        }
      } catch (err) {
        console.warn(`[Stats] Could not get episode info for show ${show.id}:`, err.message);
      }
    }
    allShowEpisodeMaps.set(show.id, episodeMap);

    for (const we of watchedEps) {
      if (!we.watched_at) {
        historicalEpisodesWithoutDate++;
      }

      // Date filtering
      if (dateFilter) {
        if (!we.watched_at || we.watched_at < dateFilter) {
          continue;
        }
      }

      episodesWatchedCount++;

      const epData = episodeMap.get(`${we.season}-${we.episode}`);
      if (epData && epData.runtime && epData.runtime > 0) {
        tvMinutes += Number(epData.runtime);
      } else {
        missingEpisodeRuntimes++;
      }
    }

    // Check completed seasons for show (in current cycle)
    try {
      const showData = await getShowSeasonsAndEpisodes(show.id, userId);
      if (showData && showData.seasons) {
        for (const s of showData.seasons) {
          if (s.status === 'Completed') {
            seasonsCompletedCount++;
          }
        }
      }
    } catch {}
  }

  // 4. Books & Reading Progress Calculations (Unique Titles + Repeat Cycles)
  const bookCycles = db.prepare(`
    SELECT c.*, b.page_count, b.title
    FROM consumption_cycles c
    JOIN books b ON c.item_id = b.id AND c.user_id = b.user_id
    WHERE c.user_id = ? AND c.item_type = 'book' AND c.status = 'completed'
  `).all(userId);

  const completedBookIds = new Set();
  let totalBookCompletions = 0;
  let totalPagesRead = 0;
  let unfinishedPagesRead = 0;
  let missingBookPageCounts = 0;
  let unfinishedBooksInProgress = 0;

  for (const c of bookCycles) {
    if (dateFilter) {
      const cDate = c.completed_at || c.updated_at;
      if (!cDate || cDate < dateFilter) continue;
    }
    completedBookIds.add(c.item_id);
    totalBookCompletions++;
    const pages = Number(c.page_count) || 0;
    if (pages > 0) {
      totalPagesRead += pages;
    } else {
      missingBookPageCounts++;
    }
  }

  // Fallback for completed books without explicit cycle row, plus active in-progress progress
  for (const book of books) {
    if (book.status === 'completed' && !completedBookIds.has(book.id)) {
      if (dateFilter) {
        const completionDate = book.updated_at || book.created_at;
        if (!completionDate || completionDate < dateFilter) continue;
      }
      completedBookIds.add(book.id);
      totalBookCompletions++;
      const totalPages = Number(book.page_count) || 0;
      if (totalPages > 0) {
        totalPagesRead += totalPages;
      } else {
        missingBookPageCounts++;
      }
    } else if (book.status !== 'completed') {
      const curPage = Number(book.current_page) || 0;
      if (curPage > 0) {
        if (dateFilter) {
          const updateDate = book.updated_at || book.created_at;
          if (!updateDate || updateDate < dateFilter) continue;
        }
        unfinishedBooksInProgress++;
        unfinishedPagesRead += curPage;
        totalPagesRead += curPage;
      }
    }
  }
  const booksCompletedCount = completedBookIds.size;

  // 5. Total Viewing Time
  const totalViewingMinutes = movieMinutes + tvMinutes;
  const missingTotalRuntimes = missingMovieRuntimes + missingEpisodeRuntimes;

  // 6. Monthly Activity for Charts (Current Year)
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthlyViewingMinutes = new Array(12).fill(0);
  const monthlyPagesRead = new Array(12).fill(0);

  // Query activity log for dated sessions in the current year
  const activities = getUserActivities(userId, {
    startDate: `${currentYear}-01-01 00:00:00`,
    endDate: `${currentYear}-12-31 23:59:59`,
    excludeCorrections: true
  });

  for (const act of activities) {
    if (!act.created_at) continue;
    const actMonth = new Date(act.created_at).getMonth();
    if (actMonth >= 0 && actMonth < 12) {
      if (act.minutes_viewed > 0) {
        monthlyViewingMinutes[actMonth] += act.minutes_viewed;
      }
      if (act.pages_read > 0) {
        monthlyPagesRead[actMonth] += act.pages_read;
      }
    }
  }

  // Also factor in watched_episodes with timestamps into monthly chart if not logged in activity_log
  const allWatchedEps = db.prepare(`
    SELECT media_id, season, episode, watched_at FROM watched_episodes
    WHERE user_id = ? AND watched_at >= ? AND watched_at <= ?
  `).all(userId, `${currentYear}-01-01 00:00:00`, `${currentYear}-12-31 23:59:59`);

  // If activity log has 0 viewing entries but watched_episodes has timestamps, look up actual runtimes from episode maps
  const totalActViewing = monthlyViewingMinutes.reduce((a, b) => a + b, 0);
  if (totalActViewing === 0 && allWatchedEps.length > 0) {
    for (const we of allWatchedEps) {
      if (!we.watched_at) continue;
      const m = new Date(we.watched_at).getMonth();
      if (m >= 0 && m < 12) {
        const epMap = allShowEpisodeMaps.get(we.media_id);
        const epData = epMap ? epMap.get(`${we.season}-${we.episode}`) : null;
        if (epData && epData.runtime && epData.runtime > 0) {
          monthlyViewingMinutes[m] += Number(epData.runtime);
        }
      }
    }
  }

  const viewingChartData = monthLabels.map((month, idx) => ({
    month,
    hours: Number((monthlyViewingMinutes[idx] / 60).toFixed(1)),
    minutes: monthlyViewingMinutes[idx]
  }));

  const readingChartData = monthLabels.map((month, idx) => ({
    month,
    pages: monthlyPagesRead[idx]
  }));

  return {
    period,
    year: currentYear,
    summary: {
      moviesWatched: moviesWatchedCount,
      uniqueMoviesCompleted: moviesWatchedCount,
      totalMovieCompletions,
      episodesWatched: episodesWatchedCount,
      seasonsCompleted: seasonsCompletedCount,
      booksCompleted: booksCompletedCount,
      uniqueBooksCompleted: booksCompletedCount,
      totalBookCompletions,
      totalPagesRead,
      unfinishedPagesRead,
      unfinishedBooksInProgress
    },
    viewingTime: {
      totalMinutes: totalViewingMinutes,
      totalHours: Number((totalViewingMinutes / 60).toFixed(1)),
      formattedHours: formatMinutesToHours(totalViewingMinutes),
      formattedDaysAndHours: formatMinutesToDaysAndHours(totalViewingMinutes),
      movies: {
        minutes: movieMinutes,
        hours: Number((movieMinutes / 60).toFixed(1)),
        formattedHours: formatMinutesToHours(movieMinutes),
        formattedDaysAndHours: formatMinutesToDaysAndHours(movieMinutes)
      },
      tv: {
        minutes: tvMinutes,
        hours: Number((tvMinutes / 60).toFixed(1)),
        formattedHours: formatMinutesToHours(tvMinutes),
        formattedDaysAndHours: formatMinutesToDaysAndHours(tvMinutes)
      },
      label: 'Estimated viewing time',
      disclaimer: 'Estimated viewing time. Runtime does not measure actual time spent watching.'
    },
    readingProgress: {
      totalPagesRead,
      unfinishedPagesRead,
      booksCompleted: booksCompletedCount,
      uniqueBooksCompleted: booksCompletedCount,
      totalBookCompletions,
      unfinishedBooksCount: unfinishedBooksInProgress,
      note: 'Page counts include finished books and current progress in unfinished books.'
    },
    missingMetadata: {
      missingMovieRuntimes,
      missingEpisodeRuntimes,
      missingTotalRuntimes,
      missingBookPageCounts,
      hasMissingRuntimes: missingTotalRuntimes > 0,
      hasMissingPages: missingBookPageCounts > 0
    },
    charts: {
      viewing: viewingChartData,
      reading: readingChartData
    },
    notes: {
      repeatTracking: (totalMovieCompletions > moviesWatchedCount || totalBookCompletions > booksCompletedCount)
        ? `Repeat viewing and rereading active. Unique completions: ${moviesWatchedCount} movies, ${booksCompletedCount} books; total completions: ${totalMovieCompletions} movies, ${totalBookCompletions} books.`
        : 'Unique titles count each completed item once. Repeat viewing and rereading are not tracked yet until an explicit new cycle is started.',
      historicalData: historicalEpisodesWithoutDate > 0
        ? (period === 'all_time'
            ? `${historicalEpisodesWithoutDate} historical episode(s) without recorded dates are included in All-Time totals, but cannot be included in monthly charts.`
            : `${historicalEpisodesWithoutDate} historical episode(s) without recorded dates cannot be included in ${period === 'this_year' ? 'This Year' : 'This Month'} or monthly charts, but are counted in All-Time totals.`)
        : null
    }
  };
}
