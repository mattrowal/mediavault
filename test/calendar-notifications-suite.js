import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Dedicated unique test database for isolated, serverless offline testing
const TEST_DB_PATH = path.join(rootDir, 'data', `test_cal_notif_suite_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.NODE_ENV = 'development';

const {
  db,
  initDatabase,
  createUser,
  addMedia,
  getMediaById,
  updateMedia,
  markEpisodeWatched,
  getWatchedEpisodes,
  getWatchedEpisodesSet,
  hasEverWatchedEpisode,
  getUserNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  startItemCycle,
  completeItemCycle,
  getUserActivities
} = await import('../db.js');

const {
  formatEpisodeSchedule,
  getUpcomingCalendar,
  updateShowNotificationPreference
} = await import('../calendar-service.js');

const {
  setMockEpisodeData,
  clearMockEpisodeData,
  getSeriesEpisodeInfo
} = await import('../episode-service.js');

const {
  runEpisodeCheckCycle,
  syncSeriesForUser,
  fetchTVMazeDetails,
  getMonitorStatus
} = await import('../episode-monitor.js');

const {
  getPersonalStatistics
} = await import('../stats-service.js');

console.log('====================================================');
console.log('🧪 MediaVault Episode Calendar & Notifications Suite');
console.log('   (Isolated Serverless / Offline Test)');
console.log('====================================================\n');

initDatabase();

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
  // -------------------------------------------------------------
  // SETUP TEST USERS
  // -------------------------------------------------------------
  const user1 = createUser('suite_alice', 'hash_alice_123', 'salt_alice_123');
  const user2 = createUser('suite_bob', 'hash_bob_123', 'salt_bob_123');
  assert(user1 && user1.id, 'User 1 (Alice) created');
  assert(user2 && user2.id, 'User 2 (Bob) created');

  const user1Id = user1.id;
  const user2Id = user2.id;

  console.log('\n--- 1. TIMEZONE BOUNDARIES & UNKNOWN RELEASE TIMES ---');

  check('formatEpisodeSchedule: If only date is known, display date without inventing a release time', () => {
    // Air date only, no airTime, no airstamp
    const res = formatEpisodeSchedule('2026-10-15', '');
    assert.strictEqual(res.formattedTime, '', 'formattedTime must be empty string when no release time is known');
    assert.ok(res.formattedDate.includes('Oct 15, 2026') || res.formattedDate === '2026-10-15', 'formattedDate contains correct date');
  });

  check('formatEpisodeSchedule: Convert known airstamp to user timezone (EDT vs CEST)', () => {
    // 2026-10-05T01:00:00Z -> In New York (EDT, UTC-4) it is 2026-10-04 21:00
    const nyRes = formatEpisodeSchedule('2026-10-04', '21:00', 'America/New_York', '2026-10-05T01:00:00Z');
    assert.ok(nyRes.formattedDate.includes('Oct 4, 2026'), `NY date should be Oct 4, got: ${nyRes.formattedDate}`);
    assert.ok(nyRes.formattedTime.includes('21:00'), `NY time should be 21:00, got: ${nyRes.formattedTime}`);

    // In Stockholm (CEST, UTC+2) it is 2026-10-05 03:00
    const sthlmRes = formatEpisodeSchedule('2026-10-05', '03:00', 'Europe/Stockholm', '2026-10-05T01:00:00Z');
    assert.ok(sthlmRes.formattedDate.includes('Oct 5, 2026'), `Stockholm date should be Oct 5, got: ${sthlmRes.formattedDate}`);
    assert.ok(sthlmRes.formattedTime.includes('03:00'), `Stockholm time should be 03:00, got: ${sthlmRes.formattedTime}`);
  });

  check('formatEpisodeSchedule: Empty or missing dates return TBA', () => {
    const emptyRes = formatEpisodeSchedule('', '');
    assert.strictEqual(emptyRes.relativeLabel, 'TBA');
    assert.strictEqual(emptyRes.formattedTime, '');
    assert.strictEqual(emptyRes.diffDays, null);
  });

  console.log('\n--- 2. UPCOMING EPISODES & CALENDAR AGENDA ---');

  // Dates
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const in3DaysStr = in3Days.toISOString().split('T')[0];
  const in15Days = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
  const in15DaysStr = in15Days.toISOString().split('T')[0];

  // User 1 follows Show A
  const showA = addMedia({
    title: 'Severance',
    type: 'tv',
    external_id: '50001',
    status: 'watching',
    current_season: 1,
    current_episode: 0,
    notify_enabled: 1
  }, user1Id);

  // User 2 follows Show B
  const showB = addMedia({
    title: 'Slow Horses',
    type: 'tv',
    external_id: '50002',
    status: 'watching',
    current_season: 1,
    current_episode: 0,
    notify_enabled: 1
  }, user2Id);

  // Mock episode data for Show A (Severance)
  setMockEpisodeData('50001', [
    { id: 901, season: 1, number: 1, name: 'Good News About Hell', airdate: yesterdayStr, airtime: '20:00', runtime: 57, summary: 'Pilot ep' },
    { id: 902, season: 1, number: 2, name: 'Half Loop', airdate: in3DaysStr, airtime: '20:00', runtime: 53, summary: 'Second ep' },
    { id: 903, season: 1, number: 3, name: 'In Perpetuity', airdate: in15DaysStr, airtime: '20:00', runtime: 54, summary: 'Third ep' }
  ]);

  // Mock episode data for Show B (Slow Horses)
  setMockEpisodeData('50002', [
    { id: 911, season: 1, number: 1, name: 'Failure\'s Contagious', airdate: in3DaysStr, airtime: '21:00', runtime: 50, summary: 'Slow horses S1E1' }
  ]);

  await asyncCheck('getUpcomingCalendar returns agenda for user1 followed series only', async () => {
    const cal = await getUpcomingCalendar(user1Id, { days: 30, includeWatched: true });
    assert.strictEqual(cal.totalCount, 3);
    assert.strictEqual(cal.followedSeriesCount, 1);
    assert.ok(cal.episodes.every(e => e.showTitle === 'Severance'), 'All calendar events belong to Severance');
    assert.strictEqual(cal.episodes.some(e => e.showTitle === 'Slow Horses'), false, 'Slow Horses must NOT appear in User 1 calendar');
    assert.ok(cal.serverRunningNotice.includes('running only while the local MediaVault server is running') || cal.serverRunningNotice.includes('running'));
  });

  await asyncCheck('getUpcomingCalendar: Empty state when user follows zero series', async () => {
    // Temp user with no shows
    const emptyUser = createUser('suite_charlie', 'hash_charlie', 'salt_charlie');
    const cal = await getUpcomingCalendar(emptyUser.id, { days: 30 });
    assert.strictEqual(cal.totalCount, 0);
    assert.strictEqual(cal.followedSeriesCount, 0);
  });

  console.log('\n--- 3. CHANGED RELEASE DATES & NO DUPLICATE ENTRIES ---');

  await asyncCheck('Rescheduling an episode updates calendar date without creating duplicates', async () => {
    const in20Days = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const in20DaysStr = in20Days.toISOString().split('T')[0];

    // Reschedule episode 3 from in15Days to in20Days
    setMockEpisodeData('50001', [
      { id: 901, season: 1, number: 1, name: 'Good News About Hell', airdate: yesterdayStr, airtime: '20:00', runtime: 57 },
      { id: 902, season: 1, number: 2, name: 'Half Loop', airdate: in3DaysStr, airtime: '20:00', runtime: 53 },
      { id: 903, season: 1, number: 3, name: 'In Perpetuity (Rescheduled)', airdate: in20DaysStr, airtime: '20:00', runtime: 54 }
    ]);

    const calAfterReschedule = await getUpcomingCalendar(user1Id, { days: 30, includeWatched: true });
    assert.strictEqual(calAfterReschedule.totalCount, 3, 'Total count remains 3 (no duplicate created)');
    const ep3 = calAfterReschedule.episodes.find(e => e.episode === 3);
    assert.strictEqual(ep3.airDate, in20DaysStr, 'Episode 3 air date was successfully updated to in20DaysStr');
    assert.strictEqual(ep3.episodeTitle, 'In Perpetuity (Rescheduled)');
  });

  console.log('\n--- 4. NOTIFICATIONS: REPEATED SYNC & STABLE EPISODE IDS ---');

  await asyncCheck('syncSeriesForUser notifies on newly released episode and records stable episode_id', async () => {
    const res1 = await syncSeriesForUser(user1Id, { maxCatchupDays: 7 });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.newNotifications, 1, 'Episode 1 aired yesterday -> 1 notification created');

    const notifs = getUserNotifications(user1Id);
    assert.strictEqual(notifs.length, 1);
    assert.strictEqual(notifs[0].season, 1);
    assert.strictEqual(notifs[0].episode, 1);
    assert.strictEqual(notifs[0].episode_id, 901, 'Stable TVMaze episode_id 901 stored in DB');
    assert.strictEqual(notifs[0].is_read, 0, 'Notification starts unread');
    assert.ok(!notifs[0].message.includes('Netflix') && !notifs[0].message.includes('HBO'), 'Neutral message: no streaming service claims');
  });

  await asyncCheck('Repeated sync does NOT create duplicate notifications', async () => {
    const res2 = await syncSeriesForUser(user1Id, { maxCatchupDays: 7 });
    assert.strictEqual(res2.newNotifications, 0, 'Second sync creates 0 duplicate notifications');

    const res3 = await syncSeriesForUser(user1Id, { maxCatchupDays: 7 });
    assert.strictEqual(res3.newNotifications, 0, 'Third sync creates 0 duplicate notifications');

    const notifs = getUserNotifications(user1Id);
    assert.strictEqual(notifs.length, 1, 'Total notifications in DB remains 1');
  });

  console.log('\n--- 5. READ STATUS PRESERVATION AFTER REFRESH ---');

  await asyncCheck('Marking notification as read is preserved after metadata refresh', async () => {
    const notifsBefore = getUserNotifications(user1Id);
    const notifId = notifsBefore[0].id;

    // Mark as read
    const markSuccess = markNotificationAsRead(notifId, user1Id);
    assert.strictEqual(markSuccess, true);
    assert.strictEqual(getUnreadNotificationCount(user1Id), 0);

    // Run metadata sync again
    await syncSeriesForUser(user1Id, { maxCatchupDays: 7 });

    // Verify it is STILL read
    const notifsAfter = getUserNotifications(user1Id);
    assert.strictEqual(notifsAfter.length, 1);
    assert.strictEqual(notifsAfter[0].is_read, 1, 'Read status preserved across sync!');
    assert.strictEqual(getUnreadNotificationCount(user1Id), 0);
  });

  console.log('\n--- 6. PER-SERIES NOTIFICATION PREFERENCES ---');

  await asyncCheck('Disabled notifications prevent release notifications for that series', async () => {
    // Disable notifications for Show A
    const prefRes = updateShowNotificationPreference(showA.id, user1Id, false);
    assert.strictEqual(prefRes.notifyEnabled, false);
    const updatedShowA = getMediaById(showA.id, user1Id);
    assert.strictEqual(updatedShowA.notify_enabled, 0);

    // Mock a newly released episode 2
    setMockEpisodeData('50001', [
      { id: 901, season: 1, number: 1, name: 'Ep 1', airdate: yesterdayStr, airtime: '20:00', runtime: 50 },
      { id: 902, season: 1, number: 2, name: 'Ep 2 Newly Released', airdate: yesterdayStr, airtime: '20:00', runtime: 50 }
    ]);

    // Sync
    const syncRes = await syncSeriesForUser(user1Id, { maxCatchupDays: 7 });
    assert.strictEqual(syncRes.newNotifications, 0, 'No notification issued because notify_enabled is 0');

    // Re-enable notifications
    updateShowNotificationPreference(showA.id, user1Id, true);
    const syncRes2 = await syncSeriesForUser(user1Id, { maxCatchupDays: 7 });
    assert.strictEqual(syncRes2.newNotifications, 1, 'Notification issued once notify_enabled is re-enabled');
  });

  console.log('\n--- 7. BOUNDED CATCH-UP & OLD SERIES FLOOD PROTECTION ---');

  await asyncCheck('Following an older series does NOT flood notifications for its entire history', async () => {
    // Add an older show that finished 2 years ago (2024)
    const oldShow = addMedia({
      title: 'Succession',
      type: 'tv',
      external_id: '50003',
      status: 'watching',
      current_season: 1,
      current_episode: 0,
      notify_enabled: 1
    }, user1Id);

    // 4 seasons of episodes aired in 2018-2023
    setMockEpisodeData('50003', [
      { id: 801, season: 1, number: 1, name: 'Celebration', airdate: '2018-06-03', airtime: '21:00', runtime: 60 },
      { id: 839, season: 4, number: 10, name: 'With Open Eyes', airdate: '2023-05-28', airtime: '21:00', runtime: 90 }
    ]);

    const notifsBefore = getUserNotifications(user1Id).length;

    // Run sync with bounded catch-up (7 days)
    const syncOld = await syncSeriesForUser(user1Id, { maxCatchupDays: 7 });
    assert.strictEqual(syncOld.newNotifications, 0, 'Bounded catchup issued 0 notifications for historical episodes');

    const notifsAfter = getUserNotifications(user1Id).length;
    assert.strictEqual(notifsAfter, notifsBefore, 'No historical notifications added to database');
  });

  console.log('\n--- 8. REWATCH PROTECTION ---');

  await asyncCheck('Starting a rewatch must not recreate release notifications for old episodes', async () => {
    // Alice completes Severance (Show A) in Cycle 1
    markEpisodeWatched(showA.id, user1Id, 1, 1);
    markEpisodeWatched(showA.id, user1Id, 1, 2);
    completeItemCycle(user1Id, 'tv', showA.id);

    check('Show A is recorded as completed in Cycle 1', () => {
      const item = getMediaById(showA.id, user1Id);
      assert.strictEqual(item.status, 'completed');
    });

    // Alice starts a rewatch (Cycle 2)
    const startCycleRes = startItemCycle(user1Id, 'tv', showA.id);
    assert.strictEqual(startCycleRes.cycleNumber, 2);

    const rewatchItem = getMediaById(showA.id, user1Id);
    assert.strictEqual(rewatchItem.current_cycle, 2);
    assert.strictEqual(rewatchItem.current_season, 1);
    assert.strictEqual(rewatchItem.current_episode, 0);

    // Verify hasEverWatchedEpisode correctly identifies old episodes
    assert.strictEqual(hasEverWatchedEpisode(showA.id, user1Id, 1, 1), true, 'hasEverWatchedEpisode S1E1 is true');
    assert.strictEqual(hasEverWatchedEpisode(showA.id, user1Id, 1, 2), true, 'hasEverWatchedEpisode S1E2 is true');

    const notifsBefore = getUserNotifications(user1Id).length;

    // Run sync while in Cycle 2 rewatch
    const rewatchSync = await syncSeriesForUser(user1Id, { maxCatchupDays: 7 });
    assert.strictEqual(rewatchSync.newNotifications, 0, 'Zero notifications recreated for previously watched episodes during rewatch!');

    const notifsAfter = getUserNotifications(user1Id).length;
    assert.strictEqual(notifsAfter, notifsBefore, 'No duplicate notifications created');
  });

  console.log('\n--- 9. API FAILURES & CACHE PRESERVATION ---');

  await asyncCheck('Preserves valid cached information when external API refresh fails', async () => {
    // Show B (Slow Horses) currently has cached data
    const infoBefore = await getSeriesEpisodeInfo('50002');
    assert.strictEqual(infoBefore.available, true);

    // Clear mock data to simulate complete TVMaze API downtime
    clearMockEpisodeData();

    // fetchTVMazeDetails with no network and no mock should fail gracefully
    // and preserve existing media metadata in SQLite
    const slowHorsesBefore = getMediaById(showB.id, user2Id);
    const result = await syncSeriesForUser(user2Id, { maxCatchupDays: 7 });

    const slowHorsesAfter = getMediaById(showB.id, user2Id);
    assert.strictEqual(slowHorsesAfter.title, slowHorsesBefore.title);
    assert.strictEqual(slowHorsesAfter.current_season, slowHorsesBefore.current_season);
    assert.strictEqual(slowHorsesAfter.current_episode, slowHorsesBefore.current_episode);
  });

  console.log('\n--- 10. CONCURRENCY LOCK: PREVENT OVERLAPPING CHECKS ---');

  await asyncCheck('runEpisodeCheckCycle prevents overlapping runs using concurrency lock', async () => {
    // Reset mock data for show A
    setMockEpisodeData('50001', [
      { id: 901, season: 1, number: 1, name: 'Ep 1', airdate: yesterdayStr, airtime: '20:00' }
    ]);

    // Launch two cycles concurrently
    const p1 = runEpisodeCheckCycle();
    const p2 = runEpisodeCheckCycle();

    const [res1, res2] = await Promise.all([p1, p2]);
    const oneWasSkipped = res1.skipped === true || res2.skipped === true;
    assert.strictEqual(oneWasSkipped, true, 'One of the overlapping runs was safely skipped by the lock');
  });

  console.log('\n--- 11. USER ISOLATION & ACCOUNT OWNERSHIP ---');

  await asyncCheck('Strict isolation between User 1 and User 2 on notifications and preferences', () => {
    // User 1 has notifications
    const u1Notifs = getUserNotifications(user1Id);
    assert.ok(u1Notifs.length > 0);

    // User 2 has 0 notifications
    const u2Notifs = getUserNotifications(user2Id);
    assert.strictEqual(u2Notifs.length, 0, 'User 2 sees 0 of User 1 notifications');

    // User 2 cannot mark User 1 notification as read
    const u1NotifId = u1Notifs[0].id;
    const hackRead = markNotificationAsRead(u1NotifId, user2Id);
    assert.strictEqual(hackRead, false, 'User 2 cannot mark User 1 notification as read');

    // User 2 cannot delete User 1 notification
    const hackDel = deleteNotification(u1NotifId, user2Id);
    assert.strictEqual(hackDel, false, 'User 2 cannot delete User 1 notification');

    // User 2 cannot modify User 1 show preferences
    let prefHacked = false;
    try {
      updateShowNotificationPreference(showA.id, user2Id, false);
      prefHacked = true;
    } catch (err) {
      assert.strictEqual(err.status, 404, 'Unauthorized preference edit rejected with 404');
    }
    assert.strictEqual(prefHacked, false);
  });

  console.log('\n--- 12. IMMUTABILITY OF WATCHED PROGRESS & STATISTICS ---');

  await asyncCheck('Calendar updates and episode sync do NOT alter watched progress or statistics', async () => {
    // Re-seed Show A mock
    setMockEpisodeData('50001', [
      { id: 901, season: 1, number: 1, name: 'Ep 1', airdate: yesterdayStr, airtime: '20:00' },
      { id: 902, season: 1, number: 2, name: 'Ep 2', airdate: in3DaysStr, airtime: '20:00' }
    ]);

    const showBefore = getMediaById(showA.id, user1Id);
    const watchedBefore = getWatchedEpisodes(showA.id, user1Id);
    const activitiesBefore = getUserActivities(user1Id);
    const statsBefore = getPersonalStatistics(user1Id);

    // Run upcoming calendar fetch and sync
    await getUpcomingCalendar(user1Id, { days: 30, includeWatched: true });
    await syncSeriesForUser(user1Id);

    const showAfter = getMediaById(showA.id, user1Id);
    const watchedAfter = getWatchedEpisodes(showA.id, user1Id);
    const activitiesAfter = getUserActivities(user1Id);
    const statsAfter = getPersonalStatistics(user1Id);

    assert.strictEqual(showAfter.current_season, showBefore.current_season, 'current_season unchanged');
    assert.strictEqual(showAfter.current_episode, showBefore.current_episode, 'current_episode unchanged');
    assert.strictEqual(watchedAfter.length, watchedBefore.length, 'Watched episodes count unchanged');
    assert.strictEqual(activitiesAfter.length, activitiesBefore.length, 'Activity log count unchanged');
    assert.strictEqual(statsAfter.tv_episodes_watched, statsBefore.tv_episodes_watched, 'Statistics unchanged');
  });

} finally {
  // Clean up test DB files
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
    if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch (_) {}
}

console.log('\n----------------------------------------------------');
console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
console.log('----------------------------------------------------');

if (passedChecks !== totalChecks) {
  process.exit(1);
}
