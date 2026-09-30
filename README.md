#  MediaVault • Movies, TV Shows, Book Library & AI Curator

A modern, full-stack media database and tracking application that allows you to:
1. **Track Watched Movies**: Record movies you have watched or plan to watch, complete with release years, genres, posters, 1–5 star ratings, and personal reviews.
2. **Monitor TV Series & Unwatched Released Episodes**: Connect to real-time episode schedules via the TVMaze API (no AI hallucinations). Easily see which episodes have aired ahead of what you have watched, with one-click `+1 Episode` tracking and instant live sync.
3. **Manage Book Library (Separate Ownership vs. Reading Progress)**: Cleanly distinguish between books you physically/digitally own in your collection (`Owned at Home` vs `Not Owned`) and your reading progress (`Read / Completed`, `Currently Reading`, `Unread`, `Wishlist`). Filter for "Owned & Unread" to pick your next physical read from your bookshelf.
4. **Central GenAI Feature (AI Curator)**: Powered by Google Gemini (`gemini-3.6-flash`), the AI analyzes your actual logged entertainment history, ratings, and notes to generate personalized recommendations with detailed contextual explanations.
5. **Robust Local SQLite Persistence**: Stores all records permanently in `data/media_vault.db` using Node.js built-in `node:sqlite`.
6. **AWS Deployment Ready**: Includes a production `Dockerfile`, `docker-compose.yml`, health checks, and a complete AWS deployment guide ([AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md)).
7. **Security First**: Secrets are kept strictly on the server and excluded from version control via `.gitignore`.

---

##  System Architecture

```
+-------------------------------------------------------------------------+
| Browser Client (Vanilla JS + HTML5 + CSS3)                              |
| - Dashboard: Stats counters, unwatched episode alerts, active lists     |
| - Movies & TV: Episode tracker, unwatched badges, +1 episode increment  |
| - Books: Separate ownership (Owned) & reading status (Read / Reading)   |
| - AI Curator: Personalized recommendations with explanations & 1-click add|
+------------------------------------+------------------------------------+
                                     |
                          REST API (/api/...)
                                     |
+------------------------------------v------------------------------------+
| Node.js & Express Web Server (server.js)                                |
| - API keys secured server-side (process.env.GEMINI_API_KEY)             |
| - REST endpoints & external API proxies                                 |
| - Health check route (/api/health) for AWS Load Balancers               |
+------------------+------------------+-------------------+---------------+
                   |                  |                   |
                   v                  v                   v
        +--------------------+ +---------------+ +------------------------+
        | Local SQLite DB    | | Google Gemini | | Real-Time External APIs|
        | (db.js)            | | GenAI API     | | • TVMaze (Episodes)    |
        | data/media_vault.db| | (gemini-3.6)  | | • Open Library (Books) |
        +--------------------+ +---------------+ | • OMDb (Movies)        |
                                                 +------------------------+
```

---

##  Key Features

###  1. TV Series & Episode Monitoring
- Track exact watched progress (`Season X, Episode Y`).
- Visual **Season Overview**: Each series card opens an interactive season-by-season and episode-by-episode breakdown with episode posters, titles, air dates, and individual watch toggles.
- Distinct statuses: **Not Started**, **In Progress**, **Completed** (all aired episodes watched), or **Caught Up** (all currently released episodes watched in an ongoing season).
- Automatically queries the **TVMaze API** for schedule and air date data.
- **Unwatched Released Indicator**: Automatically calculates when new episodes have aired ahead of your watched progress (e.g. `⚡ 3 unwatched released episodes`).
- **Live Sync**: Refresh any series on opening or via the manual refresh button to fetch the latest episode air dates.
- One-click `+1 Episode Watched` button directly on cards.

###  2. Movie Logging
- Track watched movies vs. plan to watch.
- Star ratings (1 to 5 stars) and personal impressions.
- Instant search with official movie posters and release years.

###  3. Book Collection (Separated Statuses)
- **Ownership Status**: `Owned at Home` (1) vs. `Not Owned` (0).
- **Reading Status**: `Read (Completed)`, `Reading Now`, `Unread`, `Wishlist`.
- **"Owned & Unread (TBR)" Filter**: Instantly displays books you physically own at home that you have not read yet.
- Visual reading progress bar with page counter (e.g. `Page 145 of 620, 23%`).

###  4. Central GenAI Curator (Google Gemini 3.6 Flash)
- Analyzes your unique database profile (your 5-star favorites, notes, and genre patterns).
- Generates 4 to 6 tailored recommendations with articulate explanations explaining **why** you will enjoy each title based on what you previously loved.
- One-click **" Add to Library"** button to immediately save recommendations to your plan-to-watch or reading wishlist.

###  5. Personal Statistics & Activity History
- Scoped strictly to the logged-in user.
- **Viewing Totals**: Sums exact runtimes of watched movies and individual watched episodes (labelled *"Estimated viewing time"*, displayed in total hours and breakdown of days + hours).
- **Reading Totals**: Completed books and total pages read across all sessions (including progress in unfinished books).
- **Time Filters**: Filter statistics by **All time**, **This year**, and **This month**.
- **Interactive Activity History**: Review, edit, and delete logged viewing and reading sessions. Supports correcting timestamps or page deltas without corrupting underlying library counts.

###  6. Discover Page (TV Series Discovery)
- Powered by TMDB API with four curated categories: *Trending This Week*, *Critically Acclaimed*, *Popular Sci-Fi & Fantasy*, and *Binge-Worthy Dramas*.
- Clear indicator of service configuration status (`Live TMDB` vs unconfigured message).
- In-memory caching with graceful stale-data retention if TMDB experiences downtime.
- In-library indicators with one-click *"Add to Library"* button that prevents duplicate additions.

###  7. Repeat Viewing & Rereading (Consumption Cycles)
- **Discrete Cycles (`consumption_cycles`)**: Track rewatches of movies, series, or rereads of books without losing historical records.
- Each cycle maintains its own `started_at`, `completed_at`, and status (`in_progress` or `completed`).
- **Episode Tracking Per Cycle**: Series episode completions are linked to the active cycle number (`cycle_number` in `watched_episodes`), allowing clean tracking of multiple full or partial series rewatches.
- **Explicit Action Required**: Starting a new cycle requires clicking the explicit "Rewatch" or "Reread" button. Repeated clicks or saving the same progress are idempotent and will never create duplicate cycles.
- **Statistics Counting**: Separates **Unique Titles** (e.g. 5 unique movies watched) from **Total Completions** (e.g. 7 completions including 2 rewatches).

###  8. Personal Goals
- Create tailored reading and viewing targets:
  - **Yearly Books Completed** (e.g. 24 books in 2026)
  - **Monthly Pages Read** (e.g. 1,000 pages in September)
  - **Monthly Movies Watched** (e.g. 8 movies in September)
- **Timezone Awareness**: Strict calendar date boundaries (`start_date` and `end_date`) computed using the user's local timezone.
- **Repeat Inclusion Control**: Users can toggle `include_repeats` per goal to decide whether reread books or rewatched movies contribute to the goal target.
- **Real-Time Progress**: Automatically calculated from the user's discrete activity logs and completed cycles.
- **Duplicate Prevention**: Enforces at most one active goal per metric per timeframe.

###  9. AI Weekly Planner (Powered by Gemini 3.6 Flash)
- Generates a customized weekly media schedule fitting the user's available time budget (e.g. `"5 hours"`, `"90 mins"`, `"10h 30m"`).
- **Strict Candidate Rules**: Selects **ONLY** items already existing in the user's private library:
  - Unwatched released TV episodes (verified against TVMaze schedule).
  - Unread or currently reading books (using user's reading speed, e.g. 30 pages/hour).
  - Unwatched movies in the user's library.
- **No Hallucinated Runtimes**: Items missing verified runtimes or page counts are strictly excluded from planning candidates.
- **Goal-Informed Prioritization**: Automatically prioritizes media types matching active personal goals.
- **Deterministic Knapsack Fallback**: Seamlessly generates optimized plans even if the Gemini API is offline, experiencing high demand, or not configured.
- **Safe Persistence**: Saving a plan records it in `saved_plans` for reference and **never** alters the watched/read status of items in the library.

###  10. Episode Calendar & Notifications
- **Agenda View**: Upcoming episodes for all followed TV series organized into **Today**, **This Week**, and **Later**.
- Formatted relative air dates (e.g. `"Tomorrow at 20:00"`, `"In 3 days"`) with local timezone display.
- **Per-Series Notification Toggle**: Enable or disable notifications per series (`notify_enabled`).
- **Bounded Catch-Up Monitor**: Background episode monitor features a strict 7-day lookback limit upon server restart, preventing notification floods for historical episodes.
- **Deduplication**: Composite unique constraints prevent duplicate notifications for the same episode.

---

###  11. Multi-User Authentication & Account Management
- **Secure Password Hashing:** Implements asynchronous `crypto.scrypt` with a unique 16-byte random salt per user and timing-safe comparison (`timingSafeEqual`) to prevent timing side-channel attacks. Passwords are never logged or stored in plaintext.
- **Strong Password Policy:** Enforces a minimum of 15 characters for registration and password changes, supporting password-manager-generated strings, arbitrary unicode, spaces, and passphrases of 64+ characters (up to 256 characters), while preserving login compatibility for existing accounts.
- **Account View & Password Change:** Logged-in users can update their password from the Account section. Requires current password verification, confirmation match, and rejection of identical new passwords.
- **Atomic Session Invalidation:** Upon a successful password change, the new hash is stored and all active sessions for that user are revoked in a single SQLite transaction, ensuring neither change succeeds without the other.
- **CSRF & Rate Limiting:** All state-changing endpoints enforce custom `x-csrf-token` header validation and sliding-window rate limiters (max 5 password change attempts per 5 minutes).

---

##  Counting Rules & Calculation Logic

1. **Viewing Time Calculations**:
   - Total estimated viewing time sums runtimes of verified watched movies and individual watched episodes.
   - Partially watched series only count the runtimes of the episodes actually marked watched, never the entire series.
   - Items with missing runtimes are counted in episode/movie counts but add 0 to viewing time (no runtimes are invented).
2. **Unique vs. Total Completions**:
   - **Unique Items Completed**: Counts distinct item IDs that have at least one completed cycle or are marked completed in the library.
   - **Total Completions**: Sums all completed cycles across all items (e.g., watching a movie twice equals 1 unique title and 2 total completions).
3. **Reading Progress & Corrections**:
   - Reading progress updates log an activity delta (`new_page - old_page`).
   - Editing an activity entry updates the recorded reading delta and notes `is_correction = 1`.
   - Correcting an activity does not fabricate extra reading sessions or corrupt historical goal boundaries.
4. **Goal Boundary & Repeat Inclusions**:
   - Yearly goals evaluate activities timestamped between `YYYY-01-01T00:00:00` and `YYYY-12-31T23:59:59` in the user's timezone.
   - Monthly goals evaluate activities within `YYYY-MM-01T00:00:00` and `YYYY-MM-LastDayT23:59:59`.
   - When `include_repeats = 0`, only completions belonging to Cycle 1 are credited toward the goal target.
5. **Episode Calendar & Catch-Up Lookback**:
   - Upon server startup, the episode monitor scans followed series for missed episodes within a maximum window of **7 days** (`maxCatchupDays = 7`).
   - Any episodes aired more than 7 days ago while the server was offline are not converted into catch-up notifications, eliminating notification spam.

---

##  Manual Testing Checklist

Follow this checklist to verify all features in a local browser session:

### 1. Repeat Viewing & Rereading
- [ ] Add a movie, mark it as watched (Cycle 1 completes). Notice the badge `Cycle 1 • Completed`.
- [ ] Click the **"🔄 Rewatch"** button. Confirm a new badge appears: `Cycle 2 • In Progress`.
- [ ] Repeatedly click "Rewatch" and confirm no additional cycles are created.
- [ ] Mark the movie as watched again. Notice `Cycle 2 • Completed` and total completions in Statistics show `2` while unique shows `1`.
- [ ] Add a book with 400 pages, mark it completed. Click **"🔄 Reread"**. Verify current page resets to `0` for Cycle 2 while preserving Cycle 1 in history.

### 2. Personal Goals
- [ ] Navigate to the **Goals** tab. Click **"+ New Goal"**.
- [ ] Select **"Yearly Books"** with a target of `10`. Confirm the goal card displays `0 / 10 books (0%)`.
- [ ] Select **"Monthly Pages"** with a target of `500`. Log reading progress on a book and verify the progress bar updates immediately.
- [ ] Attempt to create a second "Yearly Books" goal for the same year and confirm duplicate prevention rejects it with a clear warning.
- [ ] Edit the goal target or toggle "Include repeats" and verify progress recalculates accordingly.

### 3. AI Weekly Planner
- [ ] Navigate to the **Planner** tab.
- [ ] Enter a time budget (e.g. `"6 hours"` or `"4h 30m"`).
- [ ] Click **"✨ Generate Weekly Plan"**.
- [ ] Verify that candidates are drawn **strictly from your library** (unwatched episodes, unread books, unwatched movies).
- [ ] Verify that total planned time does not exceed your specified budget.
- [ ] Click **"💾 Save Plan"**. Verify the plan appears under **Saved Plans**.
- [ ] Inspect your library and confirm that saving the plan did **not** mark any items as watched or read.

### 4. Episode Calendar & Notifications
- [ ] Add a TV series with upcoming episodes to your library.
- [ ] Navigate to the **Calendar** tab.
- [ ] Verify upcoming episodes appear under **Today**, **This Week**, or **Later** with relative countdowns and air times.
- [ ] Open the series details modal and toggle the **"Notify when new episodes air"** switch off.
- [ ] Confirm in the calendar and series modal that notification preference persists.

### 5. Activity Log & Corrections
- [ ] Navigate to the **Statistics** tab and scroll to **Recent Activity**.
- [ ] Click the **"Edit"** button on an activity entry. Modify the date or pages.
- [ ] Verify the entry saves and displays the updated value with a correction indicator.
- [ ] Click **"Delete"** on an activity entry and confirm it is cleanly removed from the log.

---
##  Local Setup Guide

### 1. Prerequisites
- **Node.js**: v22.5.0+ or v24.x (uses built-in `node:sqlite` — no C++ compilers or extra sqlite drivers needed).
- **npm**: Included with Node.js.

### 2. Clone the Repository
```bash
git clone https://github.com/YOUR_USERNAME/mediavault.git
cd mediavault
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Required API Configuration
Copy the template environment file:
```bash
cp .env.example .env
```
Open `.env` in your text editor:
```ini
# Required: Google Gemini API Key from Google AI Studio (https://aistudio.google.com/)
# Used by the Central GenAI Curator feature for personalized recommendations
GEMINI_API_KEY=your_real_gemini_api_key_here

# Port for the web server (default: 3000)
PORT=3000

# Optional: Custom database path (defaults to ./data/media_vault.db)
# DB_PATH=/custom/path/to/media_vault.db

# Optional: OMDb API Key for movie lookups (defaults to free tier)
# OMDB_API_KEY=your_omdb_key_here
```
> **Security Note:** Never commit your `.env` file to version control. It is already listed in `.gitignore`.

### 5. Database Initialization
MediaVault uses a local, zero-configuration **SQLite** database via Node.js's built-in `node:sqlite`:
- **Automatic Setup:** When you start the application, `db.js` automatically creates the `data/` directory and initializes `data/media_vault.db` with all tables (`users`, `sessions`, `media_items`, `books`) and performance indexes if they do not exist.
- **No manual SQL migrations or database server setup are required.**
- **Persistence:** All personal data is saved locally in `data/media_vault.db` and persists across app and server restarts.
- **Privacy:** The `data/` folder and `*.db` files are included in `.gitignore` to prevent personal libraries from ever being committed to GitHub.

### 6. Start the Application
For production mode:
```bash
npm start
```
For development mode with auto-reload:
```bash
npm run dev
```

Open your browser and navigate to:
 **[http://localhost:3000](http://localhost:3000)** (or the port set in your `.env`).

### 7. Run Automated Tests
Execute the complete test suite locally:
```bash
# Run all 14 automated test suites (300+ checks across all features)
npm test

# Or run specific test suites individually
npm run test:cycles       # Repeat viewing, rereading cycles, and activity history
npm run test:goals        # Personal goals validation, progress, and repeats
npm run test:planner      # AI weekly planner candidate selection and budget enforcement
npm run test:calendar     # Episode calendar agenda and notification preferences
npm run test:stats        # Personal statistics calculations and activity logging
npm run test:discover     # Discover page, TMDB integration, and caching
npm run test:seasons      # TV season overview and episode tracking
npm run test:progression  # Episode progression and live TVMaze sync
npm run test:multiuser    # User library isolation & security
npm run test:password     # Password validation and session revocation
```

---

##  Deploying to AWS

MediaVault is production-ready for deployment on AWS (AWS App Runner, Lightsail Containers, or EC2). See the full step-by-step guide in [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md).

Quick Docker run:
```bash
docker compose up -d
```
The Docker configuration mounts a persistent volume for `/app/data` to ensure your database remains permanent across container restarts.

---

##  Security & Secrets Management
- **Password Security:** Salted asynchronous `scrypt` hashing, 15+ character minimum, and single-transaction session revocation upon change.
- **Server-Side Sessions & CSRF Protection:** Cryptographically random session tokens (32 bytes) stored in SQLite with `HttpOnly` cookies; state-changing requests guarded by CSRF tokens.
- **All API keys remain strictly on the backend** (`server.js`). The frontend client never touches or exposes the Google Gemini key.
- `.gitignore` strictly prevents `.env`, `data/`, and `*.db` files from being committed to GitHub.
- Built-in health check endpoint at `GET /api/health` for monitoring and AWS Load Balancers.

