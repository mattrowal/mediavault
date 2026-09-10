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

---

### 5. Multi-User Authentication & Account Management
- **Secure Password Hashing:** Implements asynchronous `crypto.scrypt` with a unique 16-byte random salt per user and timing-safe comparison (`timingSafeEqual`) to prevent timing side-channel attacks. Passwords are never logged or stored in plaintext.
- **Strong Password Policy:** Enforces a minimum of 15 characters for registration and password changes, supporting password-manager-generated strings, arbitrary unicode, spaces, and passphrases of 64+ characters (up to 256 characters), while preserving login compatibility for existing accounts.
- **Account View & Password Change:** Logged-in users can update their password from the Account section. Requires current password verification, confirmation match, and rejection of identical new passwords.
- **Atomic Session Invalidation:** Upon a successful password change, the new hash is stored and all active sessions for that user are revoked in a single SQLite transaction, ensuring neither change succeeds without the other.
- **CSRF & Rate Limiting:** All state-changing endpoints enforce custom `x-csrf-token` header validation and sliding-window rate limiters (max 5 password change attempts per 5 minutes).

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
# Run all automated tests (multi-user isolation & change-password suites)
npm test

# Or run specific test suites individually
npm run test:multiuser
npm run test:password
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

