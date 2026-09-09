// ===================================================
// MediaVault Frontend Application Logic
// ===================================================

document.addEventListener('DOMContentLoaded', () => {
  // Auth State
  let currentUser = null;
  let csrfToken = null;

  function getCsrfToken() {
    if (csrfToken) return csrfToken;
    const match = document.cookie.match(/(?:^|;\s*)mediavault_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  // Intercept window.fetch to automatically include CSRF token & handle auth/rate limits
  const originalFetch = window.fetch;
  window.fetch = async function(input, init = {}) {
    const opts = { ...init };
    opts.headers = { ...opts.headers };

    const method = (opts.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      const token = getCsrfToken();
      if (token && !opts.headers['x-csrf-token']) {
        opts.headers['x-csrf-token'] = token;
      }
    }

    const res = await originalFetch(input, opts);
    const urlStr = typeof input === 'string' ? input : input.url || '';

    if (res.status === 401 && !urlStr.includes('/api/auth/me') && !urlStr.includes('/api/auth/change-password')) {
      if (currentUser) {
        showToast('Your session has expired. Please sign in.', 'warning');
      }
      currentUser = null;
      updateAuthUI();
      openAuthModal('login');
    } else if (res.status === 429) {
      try {
        const clone = await res.clone().json();
        showToast(clone.error || 'Rate limit exceeded.', 'error');
      } catch {}
    }

    return res;
  };

  // Application State
  let currentView = 'dashboard';
  let mediaFilterType = 'all';
  let mediaFilterStatus = 'all';
  let mediaSearchQuery = '';

  let booksFilterOwned = 'all';
  let booksFilterStatus = 'all';
  let booksSearchQuery = '';

  // Auth DOM Elements
  const modalAuth = document.getElementById('modal-auth');
  const btnOpenAuthModal = document.getElementById('btn-open-auth-modal');
  const btnCloseAuthModal = document.getElementById('btn-close-auth-modal');
  const userLoggedInBadge = document.getElementById('user-logged-in-badge');
  const userDisplayName = document.getElementById('user-display-name');
  const btnLogout = document.getElementById('btn-logout');
  const authCalloutBanner = document.getElementById('auth-callout-banner');
  const btnCalloutLogin = document.getElementById('btn-callout-login');
  const authTabLogin = document.getElementById('auth-tab-login');
  const authTabRegister = document.getElementById('auth-tab-register');
  const authAlertBox = document.getElementById('auth-alert-box');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');

  // DOM Elements
  const tabs = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.view-section');

  const badgeNewEpisodes = document.getElementById('badge-new-episodes');
  const badgeOwnedBooks = document.getElementById('badge-owned-books');

  // Dashboard Elements
  const statNewEpisodes = document.getElementById('stat-new-episodes-count');
  const statSeriesWatching = document.getElementById('stat-series-watching');
  const statMoviesCompleted = document.getElementById('stat-movies-completed');
  const statBooksOwned = document.getElementById('stat-books-owned');
  const statBooksOwnedUnread = document.getElementById('stat-books-owned-unread');
  const statBooksCompleted = document.getElementById('stat-books-completed');

  const dashNewEpisodesSection = document.getElementById('dash-new-episodes-section');
  const dashNewEpisodesList = document.getElementById('dash-new-episodes-list');
  const dashWatchingList = document.getElementById('dash-watching-list');
  const dashReadingList = document.getElementById('dash-reading-list');

  // Containers
  const mediaContainer = document.getElementById('media-cards-container');
  const booksContainer = document.getElementById('books-cards-container');
  const aiRecommendationsContainer = document.getElementById('ai-recommendations-container');
  const aiTimestamp = document.getElementById('ai-timestamp');

  // Modals & Navigation
  const modalAdd = document.getElementById('modal-add');
  const modalEdit = document.getElementById('modal-edit');
  const btnOpenAddModal = document.getElementById('btn-open-add-modal');
  const btnCloseAddModal = document.getElementById('btn-close-add-modal');
  const btnCloseEditModal = document.getElementById('btn-close-edit-modal');
  const btnSyncTv = document.getElementById('btn-sync-tv');
  const btnSyncDash = document.getElementById('btn-sync-dash');
  const btnGenerateAi = document.getElementById('btn-generate-ai');
  const aiFocusSelect = document.getElementById('ai-focus-select');

  // Initialize
  setupEventListeners();
  setupAuthEventListeners();
  checkAuthStatus();

  // ===================================================
  // NAVIGATION & TAB SWITCHING
  // ===================================================
  function switchView(viewName) {
    currentView = viewName;
    tabs.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    views.forEach(section => {
      section.classList.toggle('active', section.id === `view-${viewName}`);
    });

    if (viewName === 'dashboard') loadDashboard();
    if (viewName === 'media') loadMedia();
    if (viewName === 'books') loadBooks();
    if (viewName === 'account') loadAccount();
  }

  function setupEventListeners() {
    // Tab switching
    tabs.forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    userDisplayName?.addEventListener('click', () => switchView('account'));

    // Quick add buttons on dashboard
    document.getElementById('dash-quick-add-serie')?.addEventListener('click', () => openAddModal('search-tv'));
    document.getElementById('dash-quick-add-movie')?.addEventListener('click', () => openAddModal('search-movie'));
    document.getElementById('dash-quick-add-book')?.addEventListener('click', () => openAddModal('search-book'));
    document.getElementById('dash-quick-goto-ai')?.addEventListener('click', () => switchView('ai'));

    document.getElementById('btn-goto-media')?.addEventListener('click', () => switchView('media'));
    document.getElementById('btn-goto-books')?.addEventListener('click', () => switchView('books'));

    // Media Filters
    document.querySelectorAll('#filter-media-type .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#filter-media-type .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        mediaFilterType = btn.dataset.val;
        loadMedia();
      });
    });

    document.querySelectorAll('#filter-media-status .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#filter-media-status .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        mediaFilterStatus = btn.dataset.val;
        loadMedia();
      });
    });

    const searchMediaInput = document.getElementById('search-media-input');
    let searchMediaTimer;
    searchMediaInput?.addEventListener('input', (e) => {
      clearTimeout(searchMediaTimer);
      searchMediaTimer = setTimeout(() => {
        mediaSearchQuery = e.target.value;
        loadMedia();
      }, 300);
    });

    // Books Filters: Ownership
    document.querySelectorAll('#filter-books-owned .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#filter-books-owned .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        booksFilterOwned = btn.dataset.val;
        loadBooks();
      });
    });

    // Books Filters: Reading Progress Status
    document.querySelectorAll('#filter-books-status .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#filter-books-status .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        booksFilterStatus = btn.dataset.val;
        loadBooks();
      });
    });

    const searchBooksInput = document.getElementById('search-books-input');
    let searchBooksTimer;
    searchBooksInput?.addEventListener('input', (e) => {
      clearTimeout(searchBooksTimer);
      searchBooksTimer = setTimeout(() => {
        booksSearchQuery = e.target.value;
        loadBooks();
      }, 300);
    });

    // Sync TV Episodes Buttons
    btnSyncTv?.addEventListener('click', handleSyncTV);
    btnSyncDash?.addEventListener('click', handleSyncTV);

    // AI Curator Generator
    btnGenerateAi?.addEventListener('click', handleGenerateAI);

    // Modal Events
    btnOpenAddModal?.addEventListener('click', () => openAddModal('search-tv'));
    btnCloseAddModal?.addEventListener('click', closeAddModal);
    btnCloseEditModal?.addEventListener('click', closeEditModal);

    modalAdd?.addEventListener('click', (e) => {
      if (e.target === modalAdd) closeAddModal();
    });
    modalEdit?.addEventListener('click', (e) => {
      if (e.target === modalEdit) closeEditModal();
    });

    document.querySelectorAll('.modal-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        closeAddModal();
        closeEditModal();
      });
    });

    // Add Modal Tabs
    document.querySelectorAll('.modal-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.modal-tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const paneId = `modal-tab-${btn.dataset.modalTab}`;
        document.getElementById(paneId)?.classList.add('active');
      });
    });

    // Search Triggers
    document.getElementById('btn-search-tv')?.addEventListener('click', handleSearchTV);
    document.getElementById('input-search-tv')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSearchTV();
    });

    document.getElementById('btn-search-movie')?.addEventListener('click', handleSearchMovie);
    document.getElementById('input-search-movie')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSearchMovie();
    });

    document.getElementById('btn-search-book')?.addEventListener('click', handleSearchBook);
    document.getElementById('input-search-book')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSearchBook();
    });

    // Manual Entry Form
    const manualTypeSelect = document.getElementById('manual-type');
    manualTypeSelect?.addEventListener('change', (e) => {
      const type = e.target.value;
      const bookFields = document.getElementById('manual-book-fields');
      const tvFields = document.getElementById('manual-tv-fields');

      if (type === 'book') {
        bookFields.classList.remove('hidden');
        tvFields.classList.add('hidden');
      } else if (type === 'tv') {
        bookFields.classList.add('hidden');
        tvFields.classList.remove('hidden');
      } else {
        bookFields.classList.add('hidden');
        tvFields.classList.add('hidden');
      }
    });

    document.getElementById('form-manual-add')?.addEventListener('submit', handleManualAddSubmit);
    document.getElementById('form-edit')?.addEventListener('submit', handleEditSubmit);
    document.getElementById('btn-delete-item')?.addEventListener('click', handleDeleteItem);

    // Live refresh button inside series edit modal
    document.getElementById('btn-refresh-single-series')?.addEventListener('click', handleRefreshSingleSeries);
  }

  // ===================================================
  // DATA LOADING & DASHBOARD
  // ===================================================
  async function loadAllData() {
    await loadDashboard();
  }

  async function loadDashboard() {
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) throw new Error('Could not load statistics');
      const stats = await res.json();

      statNewEpisodes.textContent = stats.series.withNewEpisodesCount;
      statSeriesWatching.textContent = stats.series.activeWatching;
      statMoviesCompleted.textContent = stats.movies.completed;
      statBooksOwned.textContent = stats.books.owned;
      statBooksOwnedUnread.textContent = stats.books.ownedUnread;
      statBooksCompleted.textContent = stats.books.completed;

      // Navbar Badges
      if (stats.series.withNewEpisodesCount > 0) {
        badgeNewEpisodes.textContent = `${stats.series.withNewEpisodesCount} new`;
        badgeNewEpisodes.classList.remove('hidden');
      } else {
        badgeNewEpisodes.classList.add('hidden');
      }

      if (stats.books.owned > 0) {
        badgeOwnedBooks.textContent = `${stats.books.owned} in shelf`;
        badgeOwnedBooks.classList.remove('hidden');
      }

      renderNewEpisodesSection(stats.series.withNewEpisodes);
      renderWatchingList(stats.currentlyWatching);
      renderReadingList(stats.currentlyReading);
    } catch (err) {
      console.error('Dashboard load error:', err);
    }
  }

  function renderNewEpisodesSection(seriesList) {
    if (!seriesList || seriesList.length === 0) {
      dashNewEpisodesSection.classList.add('hidden');
      return;
    }

    dashNewEpisodesSection.classList.remove('hidden');
    dashNewEpisodesList.innerHTML = seriesList.map(item => {
      const curS = item.current_season || 1;
      const curE = item.current_episode || 0;
      const latS = item.latest_season || 1;
      const latE = item.latest_episode || 0;

      // Calculate approximate unwatched episodes
      let unwatchedNotice = '';
      if (latS === curS && latE > curE) {
        const diff = latE - curE;
        unwatchedNotice = `${diff} unwatched released episode${diff > 1 ? 's' : ''}`;
      } else if (latS > curS) {
        unwatchedNotice = `New Season ${latS} released! (Ep ${latE})`;
      }

      return `
        <div class="media-card has-new-episodes">
          <div class="card-poster">
            ${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}">` : `<div class="poster-fallback"><span>📺</span></div>`}
            <div class="card-top-badges">
              <span class="badge-tag badge-type">TV Series</span>
              <span class="badge-pulsing">⚡ New Episodes!</span>
            </div>
          </div>
          <div class="card-content">
            <h4 class="card-title">${escapeHtml(item.title)}</h4>
            
            <div class="episode-tracker-box">
              <div class="episode-current-row">
                <span>You watched to:</span>
                <strong>S${curS} E${curE}</strong>
              </div>
              <div class="episode-latest-alert">
                <span>⚡ Latest Released: <strong>S${latS} E${latE}</strong></span>
              </div>
              ${unwatchedNotice ? `<div class="unwatched-count-badge">${escapeHtml(unwatchedNotice)}</div>` : ''}
              ${item.latest_episode_name ? `<div style="font-size:0.75rem; color:#94a3b8;">"${escapeHtml(item.latest_episode_name)}"</div>` : ''}
              
              <button class="btn-increment" onclick="window.incrementEpisode(${item.id})">
                +1 Episode Watched (Mark S${curS} E${curE + 1})
              </button>
            </div>

            <div class="card-actions">
              <span class="rating-stars">${renderStars(item.rating)}</span>
              <div class="card-actions-right">
                <button class="btn btn-sm btn-secondary" onclick="window.refreshSingleShow(${item.id})" title="Refresh from TVMaze">🔄</button>
                <button class="btn btn-sm btn-outline" onclick="window.openEditModal('media', ${item.id})">Edit</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderWatchingList(items) {
    if (!items || items.length === 0) {
      dashWatchingList.innerHTML = `
        <div class="empty-state" style="padding: 1.5rem;">
          <span class="empty-icon">📺</span>
          <p>No active series or movies currently in progress.</p>
          <button class="btn btn-sm btn-primary" onclick="window.openAddModal('search-tv')">Add a Show</button>
        </div>
      `;
      return;
    }

    dashWatchingList.innerHTML = items.map(item => `
      <div class="compact-card">
        ${item.poster_url ? `<img class="compact-thumb" src="${escapeHtml(item.poster_url)}" alt="">` : `<div class="compact-thumb" style="display:flex;align-items:center;justify-content:center;">🎬</div>`}
        <div class="compact-details">
          <div class="compact-title">${escapeHtml(item.title)}</div>
          <div class="compact-sub">
            ${item.type === 'tv' ? `Season ${item.current_season || 1}, Episode ${item.current_episode || 0}` : `Movie • ${item.genre || 'Movie'}`}
          </div>
        </div>
        ${item.type === 'tv' ? `
          <button class="btn btn-sm btn-secondary" onclick="window.incrementEpisode(${item.id})" title="+1 Episode">
            +1 Ep
          </button>
        ` : ''}
        <button class="btn btn-sm btn-ghost" onclick="window.openEditModal('media', ${item.id})">✏️</button>
      </div>
    `).join('');
  }

  function renderReadingList(books) {
    if (!books || books.length === 0) {
      dashReadingList.innerHTML = `
        <div class="empty-state" style="padding: 1.5rem;">
          <span class="empty-icon">📖</span>
          <p>You are not currently reading any book.</p>
          <button class="btn btn-sm btn-primary" onclick="window.openAddModal('search-book')">Find a Book</button>
        </div>
      `;
      return;
    }

    dashReadingList.innerHTML = books.map(book => {
      const total = book.page_count || 0;
      const cur = book.current_page || 0;
      const pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;

      return `
        <div class="compact-card">
          ${book.cover_url ? `<img class="compact-thumb" src="${escapeHtml(book.cover_url)}" alt="">` : `<div class="compact-thumb" style="display:flex;align-items:center;justify-content:center;">📚</div>`}
          <div class="compact-details">
            <div class="compact-title">${escapeHtml(book.title)}</div>
            <div class="compact-sub">${escapeHtml(book.author || 'Unknown')} • Page ${cur} of ${total || '?'} (${pct}%)</div>
            <div class="progress-bar" style="margin-top: 5px;">
              <div class="progress-fill" style="width: ${pct}%;"></div>
            </div>
          </div>
          <button class="btn btn-sm btn-secondary" onclick="window.promptPageProgress(${book.id}, ${cur}, ${total})" title="Update Page">
            📖 Page
          </button>
          <button class="btn btn-sm btn-ghost" onclick="window.openEditModal('book', ${book.id})">✏️</button>
        </div>
      `;
    }).join('');
  }

  // ===================================================
  // MOVIES & SERIES TAB
  // ===================================================
  async function loadMedia() {
    try {
      let url = `/api/media?type=${encodeURIComponent(mediaFilterType)}&status=${encodeURIComponent(mediaFilterStatus)}`;
      if (mediaSearchQuery) {
        url += `&search=${encodeURIComponent(mediaSearchQuery)}`;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not load media');
      const items = await res.json();

      renderMediaGrid(items);
    } catch (err) {
      console.error(err);
      showToast('Could not load media items', 'error');
    }
  }

  function renderMediaGrid(items) {
    if (!items || items.length === 0) {
      mediaContainer.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📺</span>
          <h4>No movies or series found</h4>
          <p>Add a title to begin tracking your watched movies and series episodes.</p>
          <button class="btn btn-primary" onclick="window.openAddModal('search-tv')">➕ Add Now</button>
        </div>
      `;
      return;
    }

    mediaContainer.innerHTML = items.map(item => {
      const isTV = item.type === 'tv';
      const curS = item.current_season || 1;
      const curE = item.current_episode || 0;
      const latS = item.latest_season || 1;
      const latE = item.latest_episode || 0;

      const hasNew = isTV && item.status === 'watching' && (latS > curS || (latS === curS && latE > curE));
      const statusLabel = formatStatus(item.status);

      let unwatchedNotice = '';
      if (hasNew) {
        if (latS === curS && latE > curE) {
          const diff = latE - curE;
          unwatchedNotice = `${diff} unwatched released episode${diff > 1 ? 's' : ''}`;
        } else if (latS > curS) {
          unwatchedNotice = `Season ${latS} released! (Episode ${latE})`;
        }
      }

      return `
        <div class="media-card ${hasNew ? 'has-new-episodes' : ''}">
          <div class="card-poster">
            ${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}">` : `<div class="poster-fallback"><span>${isTV ? '📺' : '🎬'}</span></div>`}
            <div class="card-top-badges">
              <span class="badge-tag badge-type">${isTV ? 'TV Series' : 'Movie'}</span>
              <span class="badge-tag badge-status ${item.status}">${statusLabel}</span>
            </div>
          </div>
          <div class="card-content">
            <h4 class="card-title">${escapeHtml(item.title)}</h4>
            <div class="card-meta">
              ${item.release_year ? `<span>📅 ${escapeHtml(item.release_year)}</span>` : ''}
              ${item.genre ? `<span>🏷️ ${escapeHtml(item.genre)}</span>` : ''}
            </div>

            ${isTV ? `
              <div class="episode-tracker-box">
                <div class="episode-current-row">
                  <span>Watched to:</span>
                  <strong>Season ${curS}, Episode ${curE}</strong>
                </div>

                ${hasNew ? `
                  <div class="episode-latest-alert">
                    <span>⚡ Released: S${latS} E${latE}</span>
                  </div>
                  ${unwatchedNotice ? `<div class="unwatched-count-badge">${escapeHtml(unwatchedNotice)}</div>` : ''}
                ` : `
                  <div style="font-size:0.75rem; color:#94a3b8;">
                    Latest released: S${latS} E${latE} (Caught up)
                  </div>
                `}

                ${item.next_air_date ? `
                  <div style="font-size:0.74rem; color:#38bdf8;">
                    📅 Next episode airs: ${escapeHtml(item.next_air_date)}
                  </div>
                ` : ''}

                <button class="btn-increment" onclick="window.incrementEpisode(${item.id})">
                  +1 Episode Watched
                </button>
              </div>
            ` : ''}

            ${item.notes ? `
              <p style="font-size:0.8rem; color:#94a3b8; font-style:italic;">"${escapeHtml(item.notes)}"</p>
            ` : ''}

            <div class="card-actions">
              <span class="rating-stars">${renderStars(item.rating)}</span>
              <div class="card-actions-right">
                ${isTV ? `<button class="btn btn-sm btn-secondary" onclick="window.refreshSingleShow(${item.id})" title="Refresh Live Data from TVMaze">🔄 Live Sync</button>` : ''}
                <button class="btn btn-sm btn-outline" onclick="window.openEditModal('media', ${item.id})">Edit</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ===================================================
  // BOOKS TAB (Separated Ownership & Reading Status)
  // ===================================================
  async function loadBooks() {
    try {
      let ownedParam = booksFilterOwned;
      let statusParam = booksFilterStatus;

      // Convenience filter: "Owned & Unread"
      if (booksFilterOwned === 'unread-owned') {
        ownedParam = '1';
        statusParam = 'unread';
      }

      let url = `/api/books?owned=${encodeURIComponent(ownedParam)}&status=${encodeURIComponent(statusParam)}`;
      if (booksSearchQuery) {
        url += `&search=${encodeURIComponent(booksSearchQuery)}`;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not load books');
      const items = await res.json();

      renderBooksGrid(items);
    } catch (err) {
      console.error(err);
      showToast('Could not load books', 'error');
    }
  }

  function renderBooksGrid(items) {
    if (!items || items.length === 0) {
      booksContainer.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📚</span>
          <h4>No books found with selected filters</h4>
          <p>Add books you own physically or plan to read to manage your library.</p>
          <button class="btn btn-primary" onclick="window.openAddModal('search-book')">➕ Add a Book</button>
        </div>
      `;
      return;
    }

    booksContainer.innerHTML = items.map(book => {
      const isOwned = book.owned === 1;
      const total = book.page_count || 0;
      const cur = book.current_page || 0;
      const pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;
      const statusLabel = formatBookStatus(book.status);

      return `
        <div class="book-card">
          <div class="card-poster">
            ${book.cover_url ? `<img src="${escapeHtml(book.cover_url)}" alt="${escapeHtml(book.title)}">` : `<div class="poster-fallback"><span>📚</span></div>`}
            <div class="card-top-badges">
              <span class="badge-tag ${isOwned ? 'badge-owned' : 'badge-not-owned'}">
                ${isOwned ? '🏠 Owned at Home' : 'Not Owned'}
              </span>
              <span class="badge-tag badge-status ${book.status}">${statusLabel}</span>
            </div>
          </div>
          <div class="card-content">
            <h4 class="card-title">${escapeHtml(book.title)}</h4>
            <div class="book-author">✍️ ${escapeHtml(book.author || 'Unknown Author')}</div>
            <div class="card-meta">
              <span>📖 ${escapeHtml(book.format || 'Hardcover')}</span>
              ${total > 0 ? `<span>📄 ${total} pages</span>` : ''}
            </div>

            <div class="progress-container">
              <div class="progress-labels">
                <span>Reading Progress:</span>
                <strong>${cur} / ${total || '?'} pages (${pct}%)</strong>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${pct}%;"></div>
              </div>
              <button class="btn-increment" onclick="window.promptPageProgress(${book.id}, ${cur}, ${total})">
                📖 Update Page Progress
              </button>
            </div>

            ${book.notes ? `
              <p style="font-size:0.8rem; color:#94a3b8; font-style:italic; margin-top:0.4rem;">"${escapeHtml(book.notes)}"</p>
            ` : ''}

            <div class="card-actions">
              <span class="rating-stars">${renderStars(book.rating)}</span>
              <button class="btn btn-sm btn-outline" onclick="window.openEditModal('book', ${book.id})">Edit</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ===================================================
  // CENTRAL GENAI CURATOR
  // ===================================================
  async function handleGenerateAI() {
    const focus = aiFocusSelect.value;
    btnGenerateAi.disabled = true;
    btnGenerateAi.innerHTML = '<span>⏳</span> Gemini is analyzing your library...';

    aiRecommendationsContainer.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; padding: 3rem;">
        <span class="empty-icon" style="animation: pulseAmber 1.5s infinite;">✨</span>
        <h4>Analyzing your personal watch & reading history...</h4>
        <p>Connecting your favorite genres, 5-star ratings, and themes via Gemini 3.6 Flash.</p>
      </div>
    `;

    try {
      const res = await fetch('/api/ai/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to generate recommendations');
      }

      const data = await res.json();
      renderAIRecommendations(data.recommendations);
      if (aiTimestamp) {
        aiTimestamp.textContent = `Generated: ${new Date().toLocaleTimeString()}`;
      }
      showToast('✨ New personalized recommendations generated!', 'success');
    } catch (err) {
      console.error(err);
      aiRecommendationsContainer.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; color: #ef4444;">
          <span class="empty-icon">⚠️</span>
          <h4>Could not generate recommendations</h4>
          <p>${escapeHtml(err.message)}</p>
          <button class="btn btn-sm btn-primary" onclick="document.getElementById('btn-generate-ai').click()">Try Again</button>
        </div>
      `;
      showToast(err.message, 'error');
    } finally {
      btnGenerateAi.disabled = false;
      btnGenerateAi.innerHTML = '<span>✨</span> Generate Recommendations';
    }
  }

  function renderAIRecommendations(recommendations) {
    if (!recommendations || recommendations.length === 0) {
      aiRecommendationsContainer.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <span class="empty-icon">📚</span>
          <h4>No recommendations returned</h4>
          <p>Try logging a few more movies, series, or books to give the AI more context.</p>
        </div>
      `;
      return;
    }

    aiRecommendationsContainer.innerHTML = recommendations.map(rec => {
      const typeLower = (rec.type || 'movie').toLowerCase();
      const typeClass = typeLower.includes('book') ? 'book' : typeLower.includes('series') || typeLower.includes('tv') ? 'tv' : 'movie';
      const typeLabel = typeClass === 'book' ? '📚 Book' : typeClass === 'tv' ? '📺 TV Series' : '🎬 Movie';

      return `
        <div class="ai-card">
          <div class="ai-card-header">
            <span class="ai-type-pill ${typeClass}">${typeLabel}</span>
            ${rec.year ? `<span style="font-size:0.8rem; color:#94a3b8;">${escapeHtml(rec.year)}</span>` : ''}
          </div>

          <div>
            <h4 class="ai-card-title">${escapeHtml(rec.title)}</h4>
            <div class="ai-card-creator">${escapeHtml(rec.creator || rec.genre || '')}</div>
          </div>

          ${rec.whyMatched ? `
            <div class="ai-match-tag">
              <span>🎯</span> ${escapeHtml(rec.whyMatched)}
            </div>
          ` : ''}

          <div class="ai-explanation-box">
            "${escapeHtml(rec.explanation)}"
          </div>

          <div class="ai-card-footer">
            <button class="btn btn-sm btn-primary" onclick='window.addFromAI(${JSON.stringify(rec).replace(/'/g, "&apos;")})'>
              ➕ Add to Library
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  window.addFromAI = async function(rec) {
    const typeLower = (rec.type || 'movie').toLowerCase();
    const isBook = typeLower.includes('book');
    const isTV = typeLower.includes('tv') || typeLower.includes('series');

    try {
      if (isBook) {
        await fetch('/api/books', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: rec.title,
            author: rec.creator || '',
            status: 'wishlist',
            owned: 0,
            notes: `AI Recommendation: ${rec.explanation}`
          })
        });
        showToast(`📚 "${rec.title}" added to your Book Wishlist!`, 'success');
      } else {
        await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: isTV ? 'tv' : 'movie',
            title: rec.title,
            release_year: rec.year || null,
            genre: rec.genre || (isTV ? 'TV Series' : 'Movie'),
            status: 'plan_to_watch',
            notes: `AI Recommendation: ${rec.explanation}`
          })
        });
        showToast(`🎬 "${rec.title}" added to your Plan to Watch list!`, 'success');
      }

      loadAllData();
    } catch (err) {
      showToast('Error saving recommendation: ' + err.message, 'error');
    }
  };

  // ===================================================
  // SINGLE SHOW EPISODE REFRESH (TVMaze API, Real Data)
  // ===================================================
  window.refreshSingleShow = async function(id) {
    showToast('Checking TVMaze for latest episode air dates... ⏳', 'info');
    try {
      const res = await fetch(`/api/media/${id}/refresh-episodes`, { method: 'POST' });
      if (!res.ok) throw new Error('Could not refresh episode data');
      const data = await res.json();

      showToast(`📺 Updated! Latest episode: S${data.item.latest_season} E${data.item.latest_episode}`, 'success');
      loadAllData();
      if (currentView === 'media') loadMedia();
    } catch (err) {
      showToast('Refresh failed: ' + err.message, 'error');
    }
  };

  async function handleRefreshSingleSeries() {
    const id = document.getElementById('edit-id').value;
    if (!id) return;
    await window.refreshSingleShow(id);

    // Re-fetch show to update input fields in modal
    try {
      const res = await fetch(`/api/media/${id}`);
      const media = await res.json();
      document.getElementById('edit-latest-season').value = media.latest_season || 1;
      document.getElementById('edit-latest-episode').value = media.latest_episode || 0;
    } catch (err) {
      console.error(err);
    }
  }

  // ===================================================
  // SEARCH FUNCTIONS IN MODAL (TV, Movie, Book)
  // ===================================================
  async function handleSearchTV() {
    const input = document.getElementById('input-search-tv');
    const container = document.getElementById('results-search-tv');
    const query = input.value.trim();
    if (!query) return;

    container.innerHTML = '<div style="color:#94a3b8; padding:1rem; text-align:center;">Searching TVMaze database... ⏳</div>';

    try {
      const res = await fetch(`/api/search/tv?q=${encodeURIComponent(query)}`);
      const results = await res.json();

      if (results.length === 0) {
        container.innerHTML = '<div style="color:#94a3b8; padding:1rem; text-align:center;">No TV shows found. Try another title.</div>';
        return;
      }

      container.innerHTML = results.map(show => `
        <div class="search-result-item">
          ${show.poster ? `<img class="search-result-poster" src="${escapeHtml(show.poster)}" alt="">` : `<div class="search-result-poster" style="display:flex;align-items:center;justify-content:center;">📺</div>`}
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(show.title)}</div>
            <div class="search-result-meta">${show.year ? `${show.year} • ` : ''}${escapeHtml(show.genre || 'Series')} • Status: ${escapeHtml(show.status || '')}</div>
            ${show.summary ? `<div class="search-result-summary">${escapeHtml(show.summary)}</div>` : ''}
          </div>
          <button class="btn btn-sm btn-primary" onclick='window.addFromSearchTV(${JSON.stringify(show).replace(/'/g, "&apos;")})'>
            ➕ Add
          </button>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = '<div style="color:#ef4444; padding:1rem;">Search failed. Please try again.</div>';
    }
  }

  async function handleSearchMovie() {
    const input = document.getElementById('input-search-movie');
    const container = document.getElementById('results-search-movie');
    const query = input.value.trim();
    if (!query) return;

    container.innerHTML = '<div style="color:#94a3b8; padding:1rem; text-align:center;">Searching movies... ⏳</div>';

    try {
      const res = await fetch(`/api/search/movies?q=${encodeURIComponent(query)}`);
      const results = await res.json();

      if (results.length === 0) {
        container.innerHTML = '<div style="color:#94a3b8; padding:1rem; text-align:center;">No movies found.</div>';
        return;
      }

      container.innerHTML = results.map(movie => `
        <div class="search-result-item">
          ${movie.poster ? `<img class="search-result-poster" src="${escapeHtml(movie.poster)}" alt="">` : `<div class="search-result-poster" style="display:flex;align-items:center;justify-content:center;">🎬</div>`}
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(movie.title)}</div>
            <div class="search-result-meta">${movie.year ? `${movie.year} • ` : ''}Movie</div>
          </div>
          <button class="btn btn-sm btn-primary" onclick='window.addFromSearchMovie(${JSON.stringify(movie).replace(/'/g, "&apos;")})'>
            ➕ Add
          </button>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = '<div style="color:#ef4444; padding:1rem;">Could not search movies.</div>';
    }
  }

  async function handleSearchBook() {
    const input = document.getElementById('input-search-book');
    const container = document.getElementById('results-search-book');
    const query = input.value.trim();
    if (!query) return;

    container.innerHTML = '<div style="color:#94a3b8; padding:1rem; text-align:center;">Searching Open Library... ⏳</div>';

    try {
      const res = await fetch(`/api/search/books?q=${encodeURIComponent(query)}`);
      const results = await res.json();

      if (results.length === 0) {
        container.innerHTML = '<div style="color:#94a3b8; padding:1rem; text-align:center;">No books found.</div>';
        return;
      }

      container.innerHTML = results.map(book => `
        <div class="search-result-item">
          ${book.cover ? `<img class="search-result-poster" src="${escapeHtml(book.cover)}" alt="">` : `<div class="search-result-poster" style="display:flex;align-items:center;justify-content:center;">📚</div>`}
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(book.title)}</div>
            <div class="search-result-meta">Author: ${escapeHtml(book.author)} ${book.year ? `• (${book.year})` : ''} ${book.pages ? `• ${book.pages} pages` : ''}</div>
          </div>
          <button class="btn btn-sm btn-primary" onclick='window.addFromSearchBook(${JSON.stringify(book).replace(/'/g, "&apos;")})'>
            ➕ Add
          </button>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = '<div style="color:#ef4444; padding:1rem;">Could not search books.</div>';
    }
  }

  // ===================================================
  // SAVE SEARCH RESULTS TO DB
  // ===================================================
  window.addFromSearchTV = async function(show) {
    try {
      const payload = {
        type: 'tv',
        title: show.title,
        external_id: show.id,
        poster_url: show.poster,
        release_year: show.year,
        genre: show.genre,
        status: 'watching',
        current_season: 1,
        current_episode: 0
      };

      const res = await fetch('/api/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Failed to save series');
      showToast(`🎬 "${show.title}" added to your series!`, 'success');
      closeAddModal();
      loadAllData();
      if (currentView === 'media') loadMedia();
    } catch (err) {
      showToast('Error saving: ' + err.message, 'error');
    }
  };

  window.addFromSearchMovie = async function(movie) {
    try {
      const payload = {
        type: 'movie',
        title: movie.title,
        poster_url: movie.poster,
        release_year: movie.year,
        genre: 'Movie',
        status: 'completed'
      };

      const res = await fetch('/api/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Failed to save movie');
      showToast(`🎬 "${movie.title}" added as watched!`, 'success');
      closeAddModal();
      loadAllData();
      if (currentView === 'media') loadMedia();
    } catch (err) {
      showToast('Error saving: ' + err.message, 'error');
    }
  };

  window.addFromSearchBook = async function(book) {
    try {
      const payload = {
        title: book.title,
        author: book.author,
        cover_url: book.cover,
        isbn: book.isbn,
        page_count: book.pages || 0,
        current_page: 0,
        owned: 1, // Default to owned at home
        format: 'Hardcover',
        status: 'unread'
      };

      const res = await fetch('/api/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Failed to save book');
      showToast(`📚 "${book.title}" added to your shelf!`, 'success');
      closeAddModal();
      loadAllData();
      if (currentView === 'books') loadBooks();
    } catch (err) {
      showToast('Error saving: ' + err.message, 'error');
    }
  };

  // ===================================================
  // MANUAL ENTRY SUBMIT
  // ===================================================
  async function handleManualAddSubmit(e) {
    e.preventDefault();
    const type = document.getElementById('manual-type').value;
    const title = document.getElementById('manual-title').value.trim();
    const status = document.getElementById('manual-status').value;
    const rating = Number(document.getElementById('manual-rating').value);
    const poster = document.getElementById('manual-poster').value.trim() || null;
    const notes = document.getElementById('manual-notes').value.trim();

    try {
      if (type === 'book') {
        const author = document.getElementById('manual-author').value.trim();
        const page_count = Number(document.getElementById('manual-page-count').value) || 0;
        const current_page = Number(document.getElementById('manual-current-page').value) || 0;
        const format = document.getElementById('manual-format').value;
        const owned = Number(document.getElementById('manual-owned').value);

        const res = await fetch('/api/books', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title, author, page_count, current_page, format, owned,
            status: status === 'watching' ? 'reading' : status,
            rating, cover_url: poster, notes
          })
        });

        if (!res.ok) throw new Error('Failed to save book');
        showToast(`📚 Book "${title}" saved!`, 'success');
      } else {
        const curSeason = Number(document.getElementById('manual-cur-season').value) || 1;
        const curEpisode = Number(document.getElementById('manual-cur-episode').value) || 0;
        const latSeason = Number(document.getElementById('manual-latest-season').value) || 1;
        const latEpisode = Number(document.getElementById('manual-latest-episode').value) || 0;

        const res = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type, title, status, rating, poster_url: poster, notes,
            current_season: curSeason,
            current_episode: curEpisode,
            latest_season: latSeason,
            latest_episode: latEpisode
          })
        });

        if (!res.ok) throw new Error('Failed to save media');
        showToast(`🎬 "${title}" saved!`, 'success');
      }

      closeAddModal();
      loadAllData();
      if (currentView === 'media') loadMedia();
      if (currentView === 'books') loadBooks();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  // ===================================================
  // EDIT MODAL & ACTIONS
  // ===================================================
  window.openEditModal = async function(kind, id) {
    document.getElementById('edit-id').value = id;
    document.getElementById('edit-item-kind').value = kind;

    const bookFields = document.getElementById('edit-book-fields');
    const tvFields = document.getElementById('edit-tv-fields');

    try {
      if (kind === 'book') {
        bookFields.classList.remove('hidden');
        tvFields.classList.add('hidden');

        const res = await fetch(`/api/books/${id}`);
        const book = await res.json();

        const titleElem = document.getElementById('modal-edit-title');
        if (titleElem) titleElem.textContent = `Edit Book: ${book.title}`;
        document.getElementById('edit-title').value = book.title || '';
        document.getElementById('edit-author').value = book.author || '';
        document.getElementById('edit-page-count').value = book.page_count || 0;
        document.getElementById('edit-current-page').value = book.current_page || 0;
        document.getElementById('edit-format').value = book.format || 'Hardcover';
        document.getElementById('edit-owned').value = String(book.owned ?? 1);
        document.getElementById('edit-status').value = book.status || 'unread';
        document.getElementById('edit-rating').value = String(book.rating || 0);
        document.getElementById('edit-poster').value = book.cover_url || '';
        document.getElementById('edit-notes').value = book.notes || '';
      } else {
        const res = await fetch(`/api/media/${id}`);
        const media = await res.json();

        const titleElem = document.getElementById('modal-edit-title');
        if (titleElem) titleElem.textContent = `Edit: ${media.title}`;
        document.getElementById('edit-title').value = media.title || '';
        document.getElementById('edit-status').value = media.status || 'watching';
        document.getElementById('edit-rating').value = String(media.rating || 0);
        document.getElementById('edit-poster').value = media.poster_url || '';
        document.getElementById('edit-notes').value = media.notes || '';

        bookFields.classList.add('hidden');

        if (media.type === 'tv') {
          tvFields.classList.remove('hidden');
          document.getElementById('edit-cur-season').value = media.current_season || 1;
          document.getElementById('edit-cur-episode').value = media.current_episode || 0;
          document.getElementById('edit-latest-season').value = media.latest_season || 1;
          document.getElementById('edit-latest-episode').value = media.latest_episode || 0;

          // If series has external TVMaze ID, auto-refresh in background
          if (media.external_id) {
            fetch(`/api/media/${id}/refresh-episodes`, { method: 'POST' })
              .then(r => r.json())
              .then(data => {
                if (data.item) {
                  document.getElementById('edit-latest-season').value = data.item.latest_season;
                  document.getElementById('edit-latest-episode').value = data.item.latest_episode;
                }
              })
              .catch(() => {});
          }
        } else {
          tvFields.classList.add('hidden');
        }
      }

      modalEdit.classList.remove('hidden');
    } catch (err) {
      showToast('Could not load entry details', 'error');
    }
  };

  async function handleEditSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('edit-id').value;
    const kind = document.getElementById('edit-item-kind').value;
    const title = document.getElementById('edit-title').value.trim();
    const status = document.getElementById('edit-status').value;
    const rating = Number(document.getElementById('edit-rating').value);
    const poster = document.getElementById('edit-poster').value.trim() || null;
    const notes = document.getElementById('edit-notes').value.trim();

    try {
      if (kind === 'book') {
        const author = document.getElementById('edit-author').value.trim();
        const page_count = Number(document.getElementById('edit-page-count').value) || 0;
        const current_page = Number(document.getElementById('edit-current-page').value) || 0;
        const format = document.getElementById('edit-format').value;
        const owned = Number(document.getElementById('edit-owned').value);

        const res = await fetch(`/api/books/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title, author, page_count, current_page, format, owned,
            status, rating, cover_url: poster, notes
          })
        });

        if (!res.ok) throw new Error('Could not update book');
        showToast('Book updated!', 'success');
      } else {
        const curSeason = Number(document.getElementById('edit-cur-season')?.value) || 1;
        const curEpisode = Number(document.getElementById('edit-cur-episode')?.value) || 0;
        const latSeason = Number(document.getElementById('edit-latest-season')?.value) || 1;
        const latEpisode = Number(document.getElementById('edit-latest-episode')?.value) || 0;

        const res = await fetch(`/api/media/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title, status, rating, poster_url: poster, notes,
            current_season: curSeason,
            current_episode: curEpisode,
            latest_season: latSeason,
            latest_episode: latEpisode
          })
        });

        if (!res.ok) throw new Error('Could not update media');
        showToast('Updated!', 'success');
      }

      closeEditModal();
      loadAllData();
      if (currentView === 'media') loadMedia();
      if (currentView === 'books') loadBooks();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  async function handleDeleteItem() {
    const id = document.getElementById('edit-id').value;
    const kind = document.getElementById('edit-item-kind').value;

    if (!confirm('Are you sure you want to remove this item from your library?')) {
      return;
    }

    try {
      const endpoint = kind === 'book' ? `/api/books/${id}` : `/api/media/${id}`;
      const res = await fetch(endpoint, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');

      showToast('Item deleted', 'info');
      closeEditModal();
      loadAllData();
      if (currentView === 'media') loadMedia();
      if (currentView === 'books') loadBooks();
    } catch (err) {
      showToast('Delete error: ' + err.message, 'error');
    }
  }

  // ===================================================
  // QUICK ACTIONS (+1 Episode, Page Progress)
  // ===================================================
  window.incrementEpisode = async function(id) {
    try {
      const res = await fetch(`/api/media/${id}/increment-episode`, { method: 'POST' });
      if (!res.ok) throw new Error('Could not increment episode');
      const updated = await res.json();

      showToast(`📺 Marked S${updated.current_season} E${updated.current_episode} as watched!`, 'success');
      loadAllData();
      if (currentView === 'media') loadMedia();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.promptPageProgress = async function(id, currentPage, totalPages) {
    const input = prompt(`Update reading page (currently on page ${currentPage} of ${totalPages || '?'}):`, currentPage + 10);
    if (input === null) return;

    const pageNum = parseInt(input, 10);
    if (isNaN(pageNum) || pageNum < 0) {
      showToast('Invalid page number', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/books/${id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_page: pageNum })
      });

      if (!res.ok) throw new Error('Could not update page');
      const updated = await res.json();

      if (updated.status === 'completed') {
        showToast(`🎉 Congratulations! You finished reading "${updated.title}"!`, 'success');
      } else {
        showToast(`📖 Saved! Now on page ${updated.current_page}.`, 'info');
      }

      loadAllData();
      if (currentView === 'books') loadBooks();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  // Bulk sync all series against TVMaze
  async function handleSyncTV() {
    showToast('Checking for new episodes across all your series... ⏳', 'info');
    try {
      const res = await fetch('/api/media/sync-tv', { method: 'POST' });
      if (!res.ok) throw new Error('Sync failed');
      const result = await res.json();

      showToast(`✅ Synced! Checked ${result.totalSeries} series.`, 'success');
      loadAllData();
      if (currentView === 'media') loadMedia();
    } catch (err) {
      showToast('Sync error: ' + err.message, 'error');
    }
  }

  // ===================================================
  // HELPERS & FORMATTING
  // ===================================================
  function openAddModal(tabName = 'search-tv') {
    modalAdd.classList.remove('hidden');
    document.querySelectorAll('.modal-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.modalTab === tabName);
    });
    document.querySelectorAll('.modal-tab-pane').forEach(p => {
      p.classList.toggle('active', p.id === `modal-tab-${tabName}`);
    });
  }

  window.openAddModal = openAddModal;

  function closeAddModal() {
    modalAdd.classList.add('hidden');
  }

  function closeEditModal() {
    modalEdit.classList.add('hidden');
  }

  function renderStars(rating) {
    const num = Math.min(5, Math.max(0, Number(rating) || 0));
    if (num === 0) return '<span style="color:#64748b;">☆☆☆☆☆</span>';
    return '★'.repeat(num) + '☆'.repeat(5 - num);
  }

  function formatStatus(st) {
    const map = {
      watching: 'Watching Now',
      completed: 'Completed',
      plan_to_watch: 'Plan to Watch',
      dropped: 'Dropped'
    };
    return map[st] || st;
  }

  function formatBookStatus(st) {
    const map = {
      reading: 'Reading Now',
      completed: 'Completed (Read)',
      unread: 'Unread',
      wishlist: 'Wishlist'
    };
    return map[st] || st;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
      success: '✅',
      info: 'ℹ️',
      warning: '⚠️',
      error: '❌'
    };

    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function loadAccount() {
    if (!currentUser) {
      switchView('dashboard');
      openAuthModal('login');
      return;
    }
    const accountUsername = document.getElementById('account-username-display');
    const accountDetailUser = document.getElementById('account-detail-username');
    if (accountUsername) accountUsername.textContent = `${currentUser.username}'s Profile`;
    if (accountDetailUser) accountDetailUser.textContent = currentUser.username;

    const alertBox = document.getElementById('change-pwd-alert');
    if (alertBox) {
      alertBox.classList.add('hidden');
      alertBox.textContent = '';
      alertBox.className = 'auth-alert hidden';
    }
    const form = document.getElementById('form-change-password');
    if (form) form.reset();
  }

  // ===================================================
  // AUTHENTICATION LOGIC & MODAL MANAGEMENT
  // ===================================================

  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();

      if (data.loggedIn && data.user) {
        currentUser = data.user;
        csrfToken = data.csrfToken;
      } else {
        currentUser = null;
        csrfToken = data.csrfToken;
      }
    } catch {
      currentUser = null;
    }

    updateAuthUI();

    if (currentUser) {
      loadAllData();
    }
  }

  function updateAuthUI() {
    if (currentUser) {
      // Authenticated view
      btnOpenAuthModal?.classList.add('hidden');
      userLoggedInBadge?.classList.remove('hidden');
      userLoggedInBadge?.classList.add('clickable');
      if (userDisplayName) userDisplayName.textContent = currentUser.username;
      authCalloutBanner?.classList.add('hidden');

      const accountUsername = document.getElementById('account-username-display');
      const accountDetailUser = document.getElementById('account-detail-username');
      if (accountUsername) accountUsername.textContent = `${currentUser.username}'s Profile`;
      if (accountDetailUser) accountDetailUser.textContent = currentUser.username;
    } else {
      // Unauthenticated view
      btnOpenAuthModal?.classList.remove('hidden');
      userLoggedInBadge?.classList.add('hidden');
      authCalloutBanner?.classList.remove('hidden');

      if (currentView === 'account') {
        switchView('dashboard');
      }

      // Reset dashboard stats to 0
      if (statNewEpisodes) statNewEpisodes.textContent = '0';
      if (statSeriesWatching) statSeriesWatching.textContent = '0';
      if (statMoviesCompleted) statMoviesCompleted.textContent = '0';
      if (statBooksOwned) statBooksOwned.textContent = '0';
      if (statBooksOwnedUnread) statBooksOwnedUnread.textContent = '0';
      if (statBooksCompleted) statBooksCompleted.textContent = '0';

      // Clear lists
      if (dashNewEpisodesList) dashNewEpisodesList.innerHTML = '';
      if (dashWatchingList) dashWatchingList.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to view your watched series</h4></div>';
      if (dashReadingList) dashReadingList.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to view your books</h4></div>';
      if (mediaContainer) mediaContainer.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to view your movies and series</h4></div>';
      if (booksContainer) booksContainer.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to view your book library</h4></div>';
      if (aiRecommendationsContainer) aiRecommendationsContainer.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to get personalized recommendations</h4></div>';
    }
  }

  function openAuthModal(tab = 'login') {
    if (!modalAuth) return;
    modalAuth.classList.remove('hidden');
    if (authAlertBox) {
      authAlertBox.classList.add('hidden');
      authAlertBox.textContent = '';
    }
    switchAuthTab(tab);
  }

  function closeAuthModal() {
    if (!modalAuth) return;
    modalAuth.classList.add('hidden');
    if (authAlertBox) {
      authAlertBox.classList.add('hidden');
      authAlertBox.textContent = '';
    }
  }

  function switchAuthTab(tab) {
    const isLogin = tab === 'login';
    authTabLogin?.classList.toggle('active', isLogin);
    authTabRegister?.classList.toggle('active', !isLogin);
    formLogin?.classList.toggle('hidden', !isLogin);
    formRegister?.classList.toggle('hidden', isLogin);
    if (authAlertBox) {
      authAlertBox.classList.add('hidden');
      authAlertBox.textContent = '';
    }
  }

  function setupAuthEventListeners() {
    btnOpenAuthModal?.addEventListener('click', () => openAuthModal('login'));
    btnCalloutLogin?.addEventListener('click', () => openAuthModal('login'));
    btnCloseAuthModal?.addEventListener('click', closeAuthModal);

    modalAuth?.addEventListener('click', (e) => {
      if (e.target === modalAuth) closeAuthModal();
    });

    authTabLogin?.addEventListener('click', () => switchAuthTab('login'));
    authTabRegister?.addEventListener('click', () => switchAuthTab('register'));

    // Handle Login Form Submit
    formLogin?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usernameInput = document.getElementById('login-username');
      const passwordInput = document.getElementById('login-password');

      const username = usernameInput?.value?.trim();
      const password = passwordInput?.value;

      if (!username || !password) return;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Login failed');
        }

        currentUser = data.user;
        csrfToken = data.csrfToken;
        closeAuthModal();
        updateAuthUI();
        loadAllData();
        showToast(`Welcome back, ${currentUser.username}!`, 'success');
        formLogin.reset();
      } catch (err) {
        if (authAlertBox) {
          authAlertBox.textContent = err.message;
          authAlertBox.classList.remove('hidden');
        }
      }
    });

    // Handle Register Form Submit
    formRegister?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usernameInput = document.getElementById('reg-username');
      const passwordInput = document.getElementById('reg-password');
      const confirmInput = document.getElementById('reg-password-confirm');

      const username = usernameInput?.value?.trim();
      const password = passwordInput?.value;
      const confirmPassword = confirmInput?.value;

      if (!username || !password) return;

      if (password.length < 15) {
        if (authAlertBox) {
          authAlertBox.textContent = 'Password must be at least 15 characters long.';
          authAlertBox.classList.remove('hidden');
        }
        return;
      }

      if (password !== confirmPassword) {
        if (authAlertBox) {
          authAlertBox.textContent = 'Passwords do not match.';
          authAlertBox.classList.remove('hidden');
        }
        return;
      }

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Registration failed');
        }

        currentUser = data.user;
        csrfToken = data.csrfToken;
        closeAuthModal();
        updateAuthUI();
        loadAllData();
        showToast(`Account created! Welcome, ${currentUser.username}!`, 'success');
        formRegister.reset();
      } catch (err) {
        if (authAlertBox) {
          authAlertBox.textContent = err.message;
          authAlertBox.classList.remove('hidden');
        }
      }
    });

    // Handle Change Password Form Submit
    const formChangePassword = document.getElementById('form-change-password');
    const changePwdAlert = document.getElementById('change-pwd-alert');

    formChangePassword?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const curInput = document.getElementById('change-cur-password');
      const newInput = document.getElementById('change-new-password');
      const confInput = document.getElementById('change-confirm-password');

      const currentPassword = curInput?.value;
      const newPassword = newInput?.value;
      const confirmPassword = confInput?.value;

      function showFormError(msg) {
        if (changePwdAlert) {
          changePwdAlert.textContent = msg;
          changePwdAlert.className = 'auth-alert';
          changePwdAlert.classList.remove('hidden');
        }
      }

      if (!currentPassword || !newPassword || !confirmPassword) {
        showFormError('All fields are required.');
        return;
      }

      if (newPassword.length < 15 || newPassword.length > 256) {
        showFormError('New password must be between 15 and 256 characters long.');
        return;
      }

      if (newPassword !== confirmPassword) {
        showFormError('New password and confirmation do not match.');
        return;
      }

      if (newPassword === currentPassword) {
        showFormError('New password cannot be the same as your current password.');
        return;
      }

      const submitBtn = document.getElementById('btn-submit-change-pwd');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
        });

        const data = await res.json();
        if (!res.ok) {
          // Keep current password error visible in the form without logging out
          showFormError(data.error || 'Failed to change password.');
          return;
        }

        // On success: sessions revoked server-side
        showToast('Password changed successfully! All sessions revoked. Please sign in.', 'success');
        formChangePassword.reset();
        currentUser = null;
        csrfToken = null;
        updateAuthUI();
        switchView('dashboard');
        openAuthModal('login');
      } catch (err) {
        showFormError(err.message || 'An error occurred while changing password.');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    // Handle Logout
    btnLogout?.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {}
      currentUser = null;
      csrfToken = null;
      updateAuthUI();
      showToast('Logged out successfully.', 'info');
    });
  }
});
