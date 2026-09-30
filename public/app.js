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

  let moviesFilterStatus = 'all';
  let moviesSearchQuery = '';

  let seriesFilterStatus = 'all';
  let seriesSearchQuery = '';

  let currentGoalsPlanningSubtab = 'goals';

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
  let tabs = document.querySelectorAll('.tab-btn');
  let views = document.querySelectorAll('.view-section');

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
  const moviesContainer = document.getElementById('movies-cards-container');
  const seriesContainer = document.getElementById('series-cards-container');
  const booksContainer = document.getElementById('books-cards-container');
  const aiRecommendationsContainer = document.getElementById('ai-recommendations-container');
  const aiTimestamp = document.getElementById('ai-timestamp');

  // Modals & Navigation
  const modalAdd = document.getElementById('modal-add');
  const modalEdit = document.getElementById('modal-edit');
  const modalSeriesDetail = document.getElementById('modal-series-detail');
  const btnOpenAddModal = document.getElementById('btn-open-add-modal');
  const btnCloseAddModal = document.getElementById('btn-close-add-modal');
  const btnCloseEditModal = document.getElementById('btn-close-edit-modal');
  const btnCloseSeriesModal = document.getElementById('btn-close-series-modal');
  const btnSyncTv = document.getElementById('btn-sync-tv');
  const btnSyncDash = document.getElementById('btn-sync-dash');
  const btnGenerateAi = document.getElementById('btn-generate-ai');
  const aiFocusSelect = document.getElementById('ai-focus-select');

  // Seasons & Episodes Modal State
  let currentSeriesDetailId = null;
  let currentSeriesDetailData = null;
  let currentEditingShowData = null;
  let undoActionCallback = null;
  let undoToastTimer = null;
  const expandedSeasonsSet = new Set();

  // Initialize
  setupEventListeners();
  setupAuthEventListeners();
  checkAuthStatus();

  // ===================================================
  // NAVIGATION & TAB SWITCHING
  // ===================================================
  function switchView(viewName) {
    if (viewName === 'goals') {
      currentView = 'goals-planning';
      currentGoalsPlanningSubtab = 'goals';
    } else if (viewName === 'planner') {
      currentView = 'goals-planning';
      currentGoalsPlanningSubtab = 'planner';
    } else if (viewName === 'media') {
      currentView = 'movies';
    } else {
      currentView = viewName;
    }

    const allTabs = document.querySelectorAll('.tab-btn');
    const allViews = document.querySelectorAll('.view-section');

    const navCollapse = document.getElementById('nav-collapse-menu');
    const navTog = document.getElementById('btn-nav-toggle');
    const navBack = document.getElementById('nav-backdrop');
    if (navCollapse?.classList.contains('is-open')) {
      navCollapse.classList.remove('is-open');
      navTog?.classList.remove('is-active');
      navTog?.setAttribute('aria-expanded', 'false');
      navTog?.setAttribute('aria-label', 'Open navigation menu');
      navCollapse.setAttribute('aria-hidden', 'true');
      navBack?.classList.remove('is-active');
      document.body.style.overflow = '';
    }

    allTabs.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === currentView);
    });
    allViews.forEach(section => {
      section.classList.toggle('active', section.id === `view-${currentView}`);
    });

    const btnUserAccount = document.getElementById('btn-user-account');
    if (btnUserAccount) {
      btnUserAccount.classList.toggle('active', currentView === 'account');
    }
    if (userLoggedInBadge) {
      userLoggedInBadge.classList.toggle('active', currentView === 'account');
    }

    if (currentView === 'dashboard') loadDashboard();
    if (currentView === 'movies') loadMovies();
    if (currentView === 'series') loadSeries();
    if (currentView === 'books') loadBooks();
    if (currentView === 'statistics') loadPersonalStatistics();
    if (currentView === 'goals-planning') {
      switchGoalsPlanningSubtab(currentGoalsPlanningSubtab);
    }
    if (currentView === 'calendar') loadCalendar();
    if (currentView === 'discover') loadDiscover();
    if (currentView === 'account') loadAccount();
  }

  function switchGoalsPlanningSubtab(tabName) {
    currentGoalsPlanningSubtab = tabName;
    const subtabG = document.getElementById('subtab-goals');
    const subtabP = document.getElementById('subtab-planner');
    const paneG = document.getElementById('pane-goals');
    const paneP = document.getElementById('pane-planner');

    if (subtabG) {
      subtabG.classList.toggle('active', tabName === 'goals');
      subtabG.setAttribute('aria-selected', tabName === 'goals' ? 'true' : 'false');
    }
    if (subtabP) {
      subtabP.classList.toggle('active', tabName === 'planner');
      subtabP.setAttribute('aria-selected', tabName === 'planner' ? 'true' : 'false');
    }

    if (paneG) paneG.classList.toggle('hidden', tabName !== 'goals');
    if (paneP) paneP.classList.toggle('hidden', tabName !== 'planner');

    if (tabName === 'goals') loadGoals();
    if (tabName === 'planner') loadPlanner();
  }
  window.switchGoalsPlanningSubtab = switchGoalsPlanningSubtab;

  function updateMoviesFilterButtons(status) {
    moviesFilterStatus = status;
    document.querySelectorAll('#filter-movies-status .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.val === status);
    });
  }

  function updateSeriesFilterButtons(status) {
    seriesFilterStatus = status;
    document.querySelectorAll('#filter-series-status .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.val === status);
    });
  }

  function updateBooksFilterButtons(owned, status) {
    booksFilterOwned = owned;
    booksFilterStatus = status;
    document.querySelectorAll('#filter-books-owned .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.val === String(owned));
    });
    document.querySelectorAll('#filter-books-status .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.val === status);
    });
  }

  window.setMoviesFilter = function(status) {
    updateMoviesFilterButtons(status);
    loadMovies();
  };

  window.setSeriesFilter = function(status) {
    updateSeriesFilterButtons(status);
    loadSeries();
  };

  window.setBooksFilter = function(owned, status) {
    updateBooksFilterButtons(owned, status);
    loadBooks();
  };

  function setupDashboardCardNavigation() {
    // 1. Series with New Episodes -> TV Series with released, unwatched episodes
    document.getElementById('stat-card-episodes')?.addEventListener('click', () => {
      seriesSearchQuery = '';
      const inp = document.getElementById('search-series-input');
      if (inp) inp.value = '';
      updateSeriesFilterButtons('new_episodes');
      switchView('series');
    });

    // 2. Active Series -> TV Series filtered by active watching
    document.getElementById('stat-card-active-series')?.addEventListener('click', () => {
      seriesSearchQuery = '';
      const inp = document.getElementById('search-series-input');
      if (inp) inp.value = '';
      updateSeriesFilterButtons('watching');
      switchView('series');
    });

    // 3. Watched Movies -> Movies filtered to completed
    document.getElementById('stat-card-watched-movies')?.addEventListener('click', () => {
      moviesSearchQuery = '';
      const inp = document.getElementById('search-movies-input');
      if (inp) inp.value = '';
      updateMoviesFilterButtons('completed');
      switchView('movies');
    });

    // 4. Books Owned at Home -> Books filtered to owned
    document.getElementById('stat-card-books-owned')?.addEventListener('click', () => {
      booksSearchQuery = '';
      const inp = document.getElementById('search-books-input');
      if (inp) inp.value = '';
      updateBooksFilterButtons('1', 'all');
      switchView('books');
    });

    // 5. Owned & Unread (TBR) -> Books filtered to owned and unread (status != completed)
    document.getElementById('stat-card-unread-owned')?.addEventListener('click', () => {
      booksSearchQuery = '';
      const inp = document.getElementById('search-books-input');
      if (inp) inp.value = '';
      updateBooksFilterButtons('unread-owned', 'all');
      switchView('books');
    });

    // 6. Books Read -> Books filtered to completed
    document.getElementById('stat-card-books-read')?.addEventListener('click', () => {
      booksSearchQuery = '';
      const inp = document.getElementById('search-books-input');
      if (inp) inp.value = '';
      updateBooksFilterButtons('all', 'completed');
      switchView('books');
    });
  }

  function setupEventListeners() {
    // Responsive Mobile/Tablet Navigation Toggle & Menu Handlers
    const btnNavToggle = document.getElementById('btn-nav-toggle');
    const navCollapseMenu = document.getElementById('nav-collapse-menu');
    const navBackdrop = document.getElementById('nav-backdrop');
    const btnCloseNavMenu = document.getElementById('btn-close-nav-menu');

    function closeNavMenu(restoreFocus = true) {
      if (navCollapseMenu?.classList.contains('is-open')) {
        navCollapseMenu.classList.remove('is-open');
        btnNavToggle?.classList.remove('is-active');
        btnNavToggle?.setAttribute('aria-expanded', 'false');
        btnNavToggle?.setAttribute('aria-label', 'Open navigation menu');
        navCollapseMenu.setAttribute('aria-hidden', 'true');
        navBackdrop?.classList.remove('is-active');
        document.body.style.overflow = '';
        if (restoreFocus) {
          btnNavToggle?.focus();
        }
      }
    }

    function openNavMenu() {
      navCollapseMenu?.classList.add('is-open');
      btnNavToggle?.classList.add('is-active');
      btnNavToggle?.setAttribute('aria-expanded', 'true');
      btnNavToggle?.setAttribute('aria-label', 'Close navigation menu');
      navCollapseMenu?.setAttribute('aria-hidden', 'false');
      navBackdrop?.classList.add('is-active');
      document.body.style.overflow = 'hidden';

      // Focus close button or first interactive element inside menu
      const focusTarget = btnCloseNavMenu || navCollapseMenu?.querySelector('.tab-btn.active') || navCollapseMenu?.querySelector('.tab-btn');
      setTimeout(() => focusTarget?.focus(), 50);
    }

    function toggleNavMenu() {
      if (navCollapseMenu?.classList.contains('is-open')) {
        closeNavMenu(true);
      } else {
        openNavMenu();
      }
    }

    btnNavToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNavMenu();
    });

    btnCloseNavMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeNavMenu(true);
    });

    // Close menu when clicking backdrop
    navBackdrop?.addEventListener('click', () => {
      closeNavMenu(true);
    });

    // Close menu when clicking outside navbar and menu
    document.addEventListener('click', (e) => {
      if (navCollapseMenu?.classList.contains('is-open')) {
        const toolbar = document.querySelector('.top-toolbar, .navbar');
        if (toolbar && !toolbar.contains(e.target) && !navCollapseMenu.contains(e.target)) {
          closeNavMenu(true);
        }
      }
    });

    // Close menu on Escape key press
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && navCollapseMenu?.classList.contains('is-open')) {
        e.preventDefault();
        closeNavMenu(true);
      }
    });

    // Handle resizing while the menu is open: returning to desktop removes stale backdrop or scroll lock
    window.addEventListener('resize', () => {
      if (window.innerWidth >= 1024) {
        if (navCollapseMenu?.classList.contains('is-open')) {
          closeNavMenu(false);
        } else {
          navBackdrop?.classList.remove('is-active');
          document.body.style.overflow = '';
          navCollapseMenu?.setAttribute('aria-hidden', 'false');
        }
      } else {
        if (!navCollapseMenu?.classList.contains('is-open')) {
          navCollapseMenu?.setAttribute('aria-hidden', 'true');
        }
      }
    });

    // Close card action menus when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.card-action-menu-wrap')) {
        document.querySelectorAll('.card-action-menu-dropdown:not(.hidden)').forEach(d => {
          d.classList.add('hidden');
          const toggleBtn = d.closest('.card-action-menu-wrap')?.querySelector('.btn-card-menu-toggle');
          toggleBtn?.setAttribute('aria-expanded', 'false');
        });
      }
    });

    // Keyboard support for card action menus (Escape to close, Up/Down arrows to navigate items)
    document.addEventListener('keydown', (e) => {
      const openDropdown = document.querySelector('.card-action-menu-dropdown:not(.hidden)');
      if (!openDropdown) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        const toggleBtn = openDropdown.closest('.card-action-menu-wrap')?.querySelector('.btn-card-menu-toggle');
        openDropdown.classList.add('hidden');
        toggleBtn?.setAttribute('aria-expanded', 'false');
        toggleBtn?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (openDropdown.contains(document.activeElement)) {
          e.preventDefault();
          const items = Array.from(openDropdown.querySelectorAll('.card-menu-item'));
          const idx = items.indexOf(document.activeElement);
          if (e.key === 'ArrowDown') {
            const next = items[(idx + 1) % items.length];
            next?.focus();
          } else {
            const prev = items[(idx - 1 + items.length) % items.length];
            prev?.focus();
          }
        }
      }
    });

    // Close menu when opening modals
    document.getElementById('btn-open-add-modal')?.addEventListener('click', () => closeNavMenu(false));
    document.getElementById('btn-open-auth-modal')?.addEventListener('click', () => closeNavMenu(false));

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        closeNavMenu(false);
        switchView(btn.dataset.view);
      });
    });

    // Sub-navigation for Goals & Planning
    document.getElementById('subtab-goals')?.addEventListener('click', () => switchGoalsPlanningSubtab('goals'));
    document.getElementById('subtab-planner')?.addEventListener('click', () => switchGoalsPlanningSubtab('planner'));

    // Statistics Period Selector
    document.querySelectorAll('.period-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.period-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStatsPeriod = btn.dataset.period || 'all_time';
        loadPersonalStatistics(currentStatsPeriod);
      });
    });

    const btnUserAccount = document.getElementById('btn-user-account');
    btnUserAccount?.addEventListener('click', () => {
      closeNavMenu(false);
      switchView('account');
    });
    userDisplayName?.addEventListener('click', () => {
      closeNavMenu(false);
      switchView('account');
    });
    userLoggedInBadge?.addEventListener('click', (e) => {
      if (e.target.closest('#btn-logout')) return;
      closeNavMenu(false);
      switchView('account');
    });

    // Quick add buttons on dashboard
    document.getElementById('dash-quick-add-serie')?.addEventListener('click', () => openAddModal('search-tv'));
    document.getElementById('dash-quick-add-movie')?.addEventListener('click', () => openAddModal('search-movie'));
    document.getElementById('dash-quick-add-book')?.addEventListener('click', () => openAddModal('search-book'));
    document.getElementById('dash-quick-goto-ai')?.addEventListener('click', () => switchView('ai'));

    document.getElementById('btn-goto-media')?.addEventListener('click', () => {
      updateSeriesFilterButtons('watching');
      switchView('series');
    });
    document.getElementById('btn-goto-books')?.addEventListener('click', () => switchView('books'));

    // Movies Filters
    document.querySelectorAll('#filter-movies-status .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#filter-movies-status .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        moviesFilterStatus = btn.dataset.val;
        loadMovies();
      });
    });

    const searchMoviesInput = document.getElementById('search-movies-input');
    let searchMoviesTimer;
    searchMoviesInput?.addEventListener('input', (e) => {
      clearTimeout(searchMoviesTimer);
      searchMoviesTimer = setTimeout(() => {
        moviesSearchQuery = e.target.value;
        loadMovies();
      }, 300);
    });

    // TV Series Filters
    document.querySelectorAll('#filter-series-status .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#filter-series-status .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        seriesFilterStatus = btn.dataset.val;
        loadSeries();
      });
    });

    const searchSeriesInput = document.getElementById('search-series-input');
    let searchSeriesTimer;
    searchSeriesInput?.addEventListener('input', (e) => {
      clearTimeout(searchSeriesTimer);
      searchSeriesTimer = setTimeout(() => {
        seriesSearchQuery = e.target.value;
        loadSeries();
      }, 300);
    });

    // Setup Clickable Dashboard Summary Cards
    setupDashboardCardNavigation();

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

    document.getElementById('btn-search-movie')?.addEventListener('click', () => handleSearchMovie(1));
    document.getElementById('input-search-movie')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSearchMovie(1);
    });

    // Link Movie Modal Triggers
    document.getElementById('btn-link-movie-search')?.addEventListener('click', () => handleSearchLinkMovie(1));
    document.getElementById('input-link-movie-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSearchLinkMovie(1);
    });
    document.getElementById('btn-close-link-movie-modal')?.addEventListener('click', window.closeLinkMovieModal);
    document.getElementById('btn-cancel-link-movie-modal')?.addEventListener('click', window.closeLinkMovieModal);
    const modalLinkMovie = document.getElementById('modal-link-movie');
    modalLinkMovie?.addEventListener('click', (e) => {
      if (e.target === modalLinkMovie) window.closeLinkMovieModal();
    });
    modalLinkMovie?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.closeLinkMovieModal();
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
      const movieFields = document.getElementById('manual-movie-fields');

      if (type === 'book') {
        bookFields?.classList.remove('hidden');
        tvFields?.classList.add('hidden');
        movieFields?.classList.add('hidden');
      } else if (type === 'tv') {
        bookFields?.classList.add('hidden');
        tvFields?.classList.remove('hidden');
        movieFields?.classList.add('hidden');
      } else if (type === 'movie') {
        bookFields?.classList.add('hidden');
        tvFields?.classList.add('hidden');
        movieFields?.classList.remove('hidden');
      } else {
        bookFields?.classList.add('hidden');
        tvFields?.classList.add('hidden');
        movieFields?.classList.add('hidden');
      }
    });

    document.getElementById('form-manual-add')?.addEventListener('submit', handleManualAddSubmit);
    document.getElementById('form-edit')?.addEventListener('submit', handleEditSubmit);
    document.getElementById('btn-delete-item')?.addEventListener('click', handleDeleteItem);

    // Live refresh button inside series edit modal
    document.getElementById('btn-refresh-single-series')?.addEventListener('click', handleRefreshSingleSeries);

    // Live validation for Edit TV fields
    const curSeasonInput = document.getElementById('edit-cur-season');
    const curEpisodeInput = document.getElementById('edit-cur-episode');

    curSeasonInput?.addEventListener('blur', () => { validateEditTVFields('season'); });
    curSeasonInput?.addEventListener('input', () => {
      document.getElementById('edit-season-error')?.classList.add('hidden');
      curSeasonInput.classList.remove('input-error');
    });
    curSeasonInput?.addEventListener('change', () => {
      validateEditTVFields('both');
    });

    curEpisodeInput?.addEventListener('blur', () => { validateEditTVFields('episode'); });
    curEpisodeInput?.addEventListener('input', () => {
      document.getElementById('edit-episode-error')?.classList.add('hidden');
      curEpisodeInput.classList.remove('input-error');
    });

    // Close Series Detail Modal
    btnCloseSeriesModal?.addEventListener('click', closeSeriesDetailModal);
    modalSeriesDetail?.addEventListener('click', (e) => {
      if (e.target === modalSeriesDetail) closeSeriesDetailModal();
    });

    // Undo toast button
    document.getElementById('btn-undo-action')?.addEventListener('click', () => {
      if (undoActionCallback) {
        undoActionCallback();
      }
    });
  }

  // ===================================================
  // DATA LOADING & DASHBOARD
  // ===================================================
  async function loadAllData() {
    await loadDashboard();
  }

  // 7-day window rule for genuine new releases based on latest_air_date metadata
  function isRecentRelease(airDate) {
    if (!airDate) return false;
    const airDateMs = new Date(airDate).getTime();
    if (isNaN(airDateMs)) return false;
    const nowMs = Date.now();
    const daysDiff = (nowMs - airDateMs) / (1000 * 60 * 60 * 24);
    return daysDiff >= 0 && daysDiff <= 7;
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

      // Navbar Badges - accurate unwatched wording matching backlog vs new distinction
      if (stats.series.withNewEpisodesCount > 0) {
        badgeNewEpisodes.textContent = `${stats.series.withNewEpisodesCount} unwatched`;
        badgeNewEpisodes.classList.remove('hidden');
      } else {
        badgeNewEpisodes.classList.add('hidden');
      }

      if (stats.books.owned > 0) {
        badgeOwnedBooks.textContent = `${stats.books.owned} in shelf`;
        badgeOwnedBooks.classList.remove('hidden');
      }

      // Check if any unwatched series have genuinely recent releases (7-day window)
      const hasRecentReleases = (stats.series.withNewEpisodes || []).some(item => isRecentRelease(item.latest_air_date));
      const sectionBadge = document.getElementById('dash-episodes-section-badge');
      const sectionTitle = document.getElementById('dash-episodes-section-title');
      if (sectionBadge) {
        sectionBadge.className = hasRecentReleases ? 'badge-status-new' : 'badge-status-neutral';
        sectionBadge.textContent = hasRecentReleases ? '⚡ New Releases' : 'Unwatched Episodes';
      }
      if (sectionTitle) {
        sectionTitle.textContent = hasRecentReleases ? 'New & Unwatched Episodes Waiting For You' : 'Unwatched Episodes Waiting For You';
      }

      renderNewEpisodesSection(stats.series.withNewEpisodes);
      renderWatchingList(stats.currentlyWatching);
      renderReadingList(stats.currentlyReading);
      loadNotifications().catch(err => console.error('Dashboard load notifications error:', err));
    } catch (err) {
      console.error('Dashboard load error:', err);
    }
  }

  function renderEpisodeProgressControls(item) {
    if (item.type !== 'tv') return '';

    if (item.is_progress_invalid) {
      return `
        <div class="episode-invalid-alert">⚠️ Invalid progress (S${item.current_season || 1} E${item.current_episode || 0}): ${escapeHtml(item.invalid_progress_reason || 'Please select a valid episode in Edit.')}</div>
        <button type="button" class="btn-increment btn-disabled" disabled title="${escapeHtml(item.invalid_progress_reason || 'Invalid progress')}">
          ⚠️ Invalid Progress — Edit to fix
        </button>
      `;
    }

    if (item.is_caught_up) {
      return `
        <button type="button" class="btn-increment btn-disabled" disabled>
          ✓ You’re caught up
        </button>
      `;
    }

    if (item.episode_data_unavailable) {
      return `
        <div class="episode-unavailable-alert">Episode data unavailable for this series. Update progress via Edit.</div>
        <button type="button" class="btn-increment btn-disabled" disabled>
          Episode data unavailable
        </button>
      `;
    }

    if (item.next_episode) {
      const nextS = item.next_episode.season;
      const nextE = item.next_episode.episode;
      return `
        <button type="button" class="btn-increment" onclick="window.incrementEpisode(${item.id}, this)">
          +1 Episode Watched (Mark S${nextS} E${nextE})
        </button>
      `;
    }

    return `
      <button type="button" class="btn-increment btn-disabled" disabled>
        ✓ You’re caught up
      </button>
    `;
  }

  function renderCompactEpisodeButton(item) {
    if (item.type !== 'tv') return '';

    if (item.is_progress_invalid) {
      return `<button type="button" class="btn btn-sm btn-secondary btn-disabled" disabled title="${escapeHtml(item.invalid_progress_reason || 'Invalid progress - Edit to fix')}">⚠️ Fix</button>`;
    }
    if (item.is_caught_up) {
      return `<button type="button" class="btn btn-sm btn-secondary btn-disabled" disabled title="You're caught up">Caught up</button>`;
    }
    if (item.episode_data_unavailable) {
      return `<button type="button" class="btn btn-sm btn-secondary btn-disabled" disabled title="Episode data unavailable">No data</button>`;
    }
    if (item.next_episode) {
      return `<button type="button" class="btn btn-sm btn-secondary" onclick="window.incrementEpisode(${item.id}, this)" title="Mark S${item.next_episode.season} E${item.next_episode.episode}">+1 (S${item.next_episode.season}E${item.next_episode.episode})</button>`;
    }
    return `<button type="button" class="btn btn-sm btn-secondary btn-disabled" disabled title="You're caught up">Caught up</button>`;
  }

  // Three-dot action menu toggle with collision avoidance and outside-click support
  window.toggleCardActionMenu = function(event, btn) {
    if (event) event.stopPropagation();
    const wrap = btn.closest('.card-action-menu-wrap');
    if (!wrap) return;
    const dropdown = wrap.querySelector('.card-action-menu-dropdown');
    if (!dropdown) return;

    const isCurrentlyOpen = !dropdown.classList.contains('hidden');

    // Close any open action menus
    document.querySelectorAll('.card-action-menu-dropdown:not(.hidden)').forEach(d => {
      d.classList.add('hidden');
      const toggleBtn = d.closest('.card-action-menu-wrap')?.querySelector('.btn-card-menu-toggle');
      toggleBtn?.setAttribute('aria-expanded', 'false');
    });

    if (isCurrentlyOpen) return;

    // Open menu
    dropdown.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');

    // Viewport collision adjustment: prevent overflowing right or bottom
    dropdown.style.left = '';
    dropdown.style.right = '0';
    dropdown.style.top = 'calc(100% + 4px)';
    dropdown.style.bottom = '';

    const rect = dropdown.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      dropdown.style.right = '0';
    }
    if (rect.left < 8) {
      dropdown.style.right = 'auto';
      dropdown.style.left = '0';
    }
    if (rect.bottom > window.innerHeight - 8) {
      dropdown.style.top = 'auto';
      dropdown.style.bottom = 'calc(100% + 4px)';
    }

    const firstItem = dropdown.querySelector('.card-menu-item');
    firstItem?.focus();
  };

  // Mark movie completed helper for dashboard cards
  window.markMovieCompleted = async function(id) {
    try {
      const res = await fetch(`/api/media/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to update movie status');
      }
      showToast('Movie marked as completed! 🎬', 'success');
      loadDashboard();
    } catch (err) {
      console.error(err);
      showToast('Could not mark movie as completed: ' + err.message, 'error');
    }
  };

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
      const isRecent = isRecentRelease(item.latest_air_date);

      // Unwatched count calculation
      let unwatchedNotice = '';
      if (latS === curS && latE > curE) {
        const diff = latE - curE;
        unwatchedNotice = isRecent 
          ? `${diff} new episode${diff > 1 ? 's' : ''}` 
          : `${diff} unwatched episode${diff > 1 ? 's' : ''}`;
      } else if (latS > curS) {
        // Distinguish genuine recent release from backlog (never assume new merely because latest_season > current_season)
        unwatchedNotice = isRecent 
          ? `Season ${latS} recently released (Ep ${latE})` 
          : `Season ${latS} unwatched (Ep ${latE})`;
      } else {
        unwatchedNotice = 'Unwatched episodes';
      }

      const statusPill = isRecent 
        ? '<span class="status-pill status-new-release">⚡ New Release</span>' 
        : '<span class="status-pill status-unwatched">Unwatched</span>';

      // Primary Action
      let primaryActionHtml = '';
      if (item.is_progress_invalid) {
        primaryActionHtml = `<button type="button" class="btn btn-sm btn-danger btn-primary-action" onclick="window.openEditModal('media', ${item.id})">Fix Progress</button>`;
      } else if (item.is_caught_up) {
        primaryActionHtml = `<button type="button" class="btn btn-sm btn-outline btn-primary-action btn-disabled" disabled>✓ Caught Up</button>`;
      } else if (item.next_episode) {
        primaryActionHtml = `<button type="button" class="btn btn-sm btn-primary btn-primary-action" onclick="window.incrementEpisode(${item.id}, this)">+1 Watched (S${item.next_episode.season}E${item.next_episode.episode})</button>`;
      } else {
        primaryActionHtml = `<button type="button" class="btn btn-sm btn-outline btn-primary-action btn-disabled" disabled>✓ Caught Up</button>`;
      }

      return `
        <div class="dash-compact-card ${isRecent ? 'has-new-release' : ''}">
          <div class="dash-compact-thumb-wrap" style="cursor:pointer;" onclick="window.openSeriesDetailModal(${item.id})" title="Click to view seasons and episodes">
            ${item.poster_url 
              ? `<img src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}">` 
              : `<div class="dash-thumb-fallback">📺</div>`}
          </div>

          <div class="dash-compact-body">
            <div class="dash-compact-header">
              <div class="dash-compact-title-wrap">
                <h4 class="dash-compact-title is-clickable" onclick="window.openSeriesDetailModal(${item.id})" title="${escapeHtml(item.title)}">
                  ${escapeHtml(item.title)}
                </h4>
                <div class="dash-compact-meta">
                  <span>Watched: <strong class="meta-highlight">S${curS} E${curE}</strong></span>
                  <span>Latest: <strong>S${latS} E${latE}</strong></span>
                  ${statusPill}
                </div>
                <div class="compact-next-ep">
                  ${escapeHtml(unwatchedNotice)}${item.latest_episode_name ? ` · "${escapeHtml(item.latest_episode_name)}"` : ''}
                </div>
              </div>
            </div>

            <div class="dash-compact-actions">
              <div class="dash-compact-actions-left">
                ${primaryActionHtml}
              </div>
              <div class="dash-compact-actions-right">
                <button type="button" class="btn btn-sm btn-ghost" onclick="window.openSeriesDetailModal(${item.id})" title="View Seasons & Episodes" aria-label="View Seasons & Episodes for ${escapeHtml(item.title)}">📺 Episodes</button>
                <div class="card-action-menu-wrap">
                  <button type="button" class="btn-card-menu-toggle" aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${escapeHtml(item.title)}" onclick="window.toggleCardActionMenu(event, this)">
                    <span aria-hidden="true">⋮</span>
                  </button>
                  <div class="card-action-menu-dropdown hidden" role="menu">
                    <button type="button" class="card-menu-item" role="menuitem" onclick="window.refreshEpisodeDetails(${item.id}, this)">🔄 Sync TVMaze</button>
                    <button type="button" class="card-menu-item" role="menuitem" onclick="window.openSeriesDetailModal(${item.id})">📺 View Episodes</button>
                    <button type="button" class="card-menu-item" role="menuitem" onclick="window.openEditModal('media', ${item.id})">✏️ Edit Details</button>
                  </div>
                </div>
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
        <div class="empty-state" style="padding: 1.5rem; text-align: center;">
          <span class="empty-icon">📺</span>
          <p>No active series or movies currently in progress.</p>
          <div class="empty-state-actions">
            <button class="btn btn-sm btn-primary" onclick="window.openAddModal('search-tv')">Add a Show</button>
            <button class="btn btn-sm btn-outline" onclick="window.switchView('series')">Browse TV Series</button>
            <button class="btn btn-sm btn-outline" onclick="window.switchView('movies')">Browse Movies</button>
          </div>
        </div>
      `;
      return;
    }

    dashWatchingList.innerHTML = items.map(item => {
      const isTV = item.type === 'tv';
      const curS = item.current_season || 1;
      const curE = item.current_episode || 0;
      const hasRecent = isTV && isRecentRelease(item.latest_air_date);

      let statusPillHtml = '';
      if (isTV) {
        if (item.is_caught_up) {
          statusPillHtml = '<span class="status-pill status-caught-up">Caught Up</span>';
        } else if (hasRecent) {
          statusPillHtml = '<span class="status-pill status-new-release">⚡ New Episode</span>';
        } else if (item.is_progress_invalid) {
          statusPillHtml = '<span class="status-pill status-unwatched" style="color:#fca5a5;">Fix Progress</span>';
        } else {
          statusPillHtml = '<span class="status-pill status-in-progress">In Progress</span>';
        }
      } else {
        statusPillHtml = '<span class="status-pill status-in-progress">Movie</span>';
      }

      // Next episode info for TV
      let nextEpText = '';
      if (isTV) {
        if (item.next_episode) {
          nextEpText = `<div class="compact-next-ep" title="Next: Season ${item.next_episode.season}, Episode ${item.next_episode.episode}">Next: <strong>S${item.next_episode.season} E${item.next_episode.episode}</strong></div>`;
        } else if (item.is_caught_up) {
          nextEpText = `<div class="compact-next-ep" style="color:#34d399;">All caught up (S${curS} E${curE})</div>`;
        }
      }

      // Primary Action
      let primaryActionHtml = '';
      if (isTV) {
        if (item.is_progress_invalid) {
          primaryActionHtml = `<button type="button" class="btn btn-sm btn-danger btn-primary-action" onclick="window.openEditModal('media', ${item.id})" title="${escapeHtml(item.invalid_progress_reason || 'Invalid progress')}">Fix Progress</button>`;
        } else if (item.is_caught_up) {
          primaryActionHtml = `<button type="button" class="btn btn-sm btn-outline btn-primary-action btn-disabled" disabled>✓ Caught Up</button>`;
        } else if (item.next_episode) {
          primaryActionHtml = `<button type="button" class="btn btn-sm btn-primary btn-primary-action" onclick="window.incrementEpisode(${item.id}, this)">+1 Watched (S${item.next_episode.season}E${item.next_episode.episode})</button>`;
        } else {
          primaryActionHtml = `<button type="button" class="btn btn-sm btn-outline btn-primary-action btn-disabled" disabled>✓ Caught Up</button>`;
        }
      } else {
        primaryActionHtml = `<button type="button" class="btn btn-sm btn-primary btn-primary-action" onclick="window.markMovieCompleted(${item.id})">✓ Mark Watched</button>`;
      }

      return `
        <div class="dash-compact-card">
          <div class="dash-compact-thumb-wrap" ${isTV ? `style="cursor:pointer;" onclick="window.openSeriesDetailModal(${item.id})" title="Click to view episodes"` : `style="cursor:pointer;" onclick="window.openEditModal('media', ${item.id})" title="Click to view details"`}>
            ${item.poster_url 
              ? `<img src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}">` 
              : `<div class="dash-thumb-fallback">${isTV ? '📺' : '🎬'}</div>`}
          </div>

          <div class="dash-compact-body">
            <div class="dash-compact-header">
              <div class="dash-compact-title-wrap">
                <h4 class="dash-compact-title ${isTV ? 'is-clickable' : ''}" ${isTV ? `onclick="window.openSeriesDetailModal(${item.id})" title="Click to view seasons and episodes"` : ''}>
                  ${escapeHtml(item.title)}
                </h4>
                <div class="dash-compact-meta">
                  ${isTV ? `<span>Watched: <strong class="meta-highlight">S${curS} E${curE}</strong></span>` : `<span>${escapeHtml(item.genre || 'Film')}</span>`}
                  ${statusPillHtml}
                </div>
                ${nextEpText}
              </div>
            </div>

            <div class="dash-compact-actions">
              <div class="dash-compact-actions-left">
                ${primaryActionHtml}
              </div>
              <div class="dash-compact-actions-right">
                ${isTV ? `<button type="button" class="btn btn-sm btn-ghost" onclick="window.openSeriesDetailModal(${item.id})" title="View Seasons & Episodes" aria-label="View Seasons & Episodes for ${escapeHtml(item.title)}">📺 Episodes</button>` : ''}
                <div class="card-action-menu-wrap">
                  <button type="button" class="btn-card-menu-toggle" aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${escapeHtml(item.title)}" onclick="window.toggleCardActionMenu(event, this)">
                    <span aria-hidden="true">⋮</span>
                  </button>
                  <div class="card-action-menu-dropdown hidden" role="menu">
                    ${isTV ? `<button type="button" class="card-menu-item" role="menuitem" onclick="window.refreshEpisodeDetails(${item.id}, this)">🔄 Sync TVMaze</button>` : `<button type="button" class="card-menu-item" role="menuitem" onclick="window.refreshMovieDetails(${item.id}, this)">🔄 Refresh TMDB</button>`}
                    ${isTV ? `<button type="button" class="card-menu-item" role="menuitem" onclick="window.openSeriesDetailModal(${item.id})">📺 View Episodes</button>` : ''}
                    <button type="button" class="card-menu-item" role="menuitem" onclick="window.openEditModal('media', ${item.id})">✏️ Edit Details</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderReadingList(books) {
    if (!books || books.length === 0) {
      dashReadingList.innerHTML = `
        <div class="empty-state" style="padding: 1.5rem; text-align: center;">
          <span class="empty-icon">📖</span>
          <p>You are not currently reading any book.</p>
          <div class="empty-state-actions">
            <button class="btn btn-sm btn-primary" onclick="window.openAddModal('search-book')">Find a Book</button>
            <button class="btn btn-sm btn-outline" onclick="window.switchView('books')">Browse Books Library</button>
          </div>
        </div>
      `;
      return;
    }

    dashReadingList.innerHTML = books.map(book => {
      const total = book.page_count || 0;
      const cur = book.current_page || 0;
      const pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;

      return `
        <div class="dash-compact-card">
          <div class="dash-compact-thumb-wrap" style="cursor:pointer;" onclick="window.openEditModal('book', ${book.id})" title="Click to view details">
            ${book.cover_url 
              ? `<img src="${escapeHtml(book.cover_url)}" alt="${escapeHtml(book.title)}">` 
              : `<div class="dash-thumb-fallback">📚</div>`}
          </div>

          <div class="dash-compact-body">
            <div class="dash-compact-header">
              <div class="dash-compact-title-wrap">
                <h4 class="dash-compact-title is-clickable" onclick="window.openEditModal('book', ${book.id})" title="${escapeHtml(book.title)}">
                  ${escapeHtml(book.title)}
                </h4>
                <div class="dash-compact-meta">
                  <span>${escapeHtml(book.author || 'Unknown Author')}</span>
                  <span class="status-pill status-in-progress">Reading</span>
                </div>
                <div class="compact-next-ep" style="margin-top: 0.2rem;">
                  Page <strong style="color:#38bdf8;">${cur}</strong> of ${total || '?'} (${pct}%)
                </div>
                <div class="progress-bar" style="margin-top: 4px; height: 5px;">
                  <div class="progress-fill" style="width: ${pct}%;"></div>
                </div>
              </div>
            </div>

            <div class="dash-compact-actions">
              <div class="dash-compact-actions-left">
                <button type="button" class="btn btn-sm btn-primary btn-primary-action" onclick="window.promptPageProgress(${book.id}, ${cur}, ${total})">
                  📖 Update Page
                </button>
              </div>
              <div class="dash-compact-actions-right">
                <div class="card-action-menu-wrap">
                  <button type="button" class="btn-card-menu-toggle" aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${escapeHtml(book.title)}" onclick="window.toggleCardActionMenu(event, this)">
                    <span aria-hidden="true">⋮</span>
                  </button>
                  <div class="card-action-menu-dropdown hidden" role="menu">
                    <button type="button" class="card-menu-item" role="menuitem" onclick="window.markBookCompleted(${book.id})">✅ Mark Completed</button>
                    <button type="button" class="card-menu-item" role="menuitem" onclick="window.openEditModal('book', ${book.id})">✏️ Edit Book</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ===================================================
  // MOVIES TAB (Only Movies)
  // ===================================================
  async function loadMovies() {
    try {
      let url = `/api/media?type=movie&status=${encodeURIComponent(moviesFilterStatus)}`;
      if (moviesSearchQuery) {
        url += `&search=${encodeURIComponent(moviesSearchQuery)}`;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not load movies');
      const items = await res.json();

      renderMoviesGrid(items);
    } catch (err) {
      console.error(err);
      showToast('Could not load movies', 'error');
    }
  }

  function renderMoviesGrid(items) {
    const container = document.getElementById('movies-cards-container');
    if (!container) return;

    if (!items || items.length === 0) {
      let emptyTitle = 'No movies found';
      let emptyMsg = 'Add movies you have watched or plan to watch to begin tracking your film library.';
      let emptyBtnAction = "window.openAddModal('search-movie')";
      let emptyBtnText = '➕ Add a Movie';

      if (moviesFilterStatus === 'completed') {
        emptyTitle = 'No Watched Movies Yet 🎬';
        emptyMsg = 'Mark movies as watched to record ratings, reviews, and viewing milestones.';
      } else if (moviesFilterStatus === 'plan_to_watch') {
        emptyTitle = 'No Movies in Plan to Watch ⏳';
        emptyMsg = 'Add films you want to watch soon.';
      } else if (moviesFilterStatus === 'watching') {
        emptyTitle = 'No Movies In Progress 🍿';
        emptyMsg = 'Movies you are currently watching will appear here.';
      }

      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🎬</span>
          <h4>${escapeHtml(emptyTitle)}</h4>
          <p>${escapeHtml(emptyMsg)}</p>
          <button class="btn btn-primary" onclick="${emptyBtnAction}">${escapeHtml(emptyBtnText)}</button>
        </div>
      `;
      return;
    }

    container.innerHTML = items.map(item => {
      const statusLabel = formatStatus(item.status);
      return `
        <div class="media-card">
          <div class="card-poster">
            ${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}">` : `<div class="poster-fallback"><span>🎬</span></div>`}
            <div class="card-top-badges">
              <span class="badge-tag badge-type">Movie</span>
              <span class="badge-tag badge-status ${item.status}">${statusLabel}</span>
              ${item.current_cycle && item.current_cycle > 1 ? `<span class="cycle-badge">🔁 Cycle ${item.current_cycle}</span>` : ''}
            </div>
          </div>
          <div class="card-content">
            <h4 class="card-title">${escapeHtml(item.title)}</h4>
            <div class="card-meta">
              ${item.release_year ? `<span>📅 ${escapeHtml(item.release_year)}</span>` : ''}
              ${item.runtime && item.runtime > 0 ? `<span>⏱️ ${item.runtime}m${item.is_runtime_manual ? ' (manual)' : ''}</span>` : (item.status === 'completed' ? `<span class="badge-tag badge-runtime-missing" title="Excluded from viewing statistics due to missing runtime">⚠️ Missing runtime</span>` : '<span>⏱️ Unknown duration</span>')}
              ${item.genre ? `<span>🏷️ ${escapeHtml(item.genre)}</span>` : ''}
            </div>

            ${item.notes ? `
              <p style="font-size:0.8rem; color:#94a3b8; font-style:italic;">"${escapeHtml(item.notes)}"</p>
            ` : ''}

            <div class="card-actions">
              <span class="rating-stars">${renderStars(item.rating)}</span>
              <div class="card-actions-right">
                ${item.status === 'completed' ? `<button type="button" class="btn btn-sm btn-repeat-action" onclick="window.startRepeatCycle('movie', ${item.id}, this)">🔁 Start Rewatch</button>` : ''}
                ${item.current_cycle > 1 && item.status !== 'completed' ? `<button type="button" class="btn btn-sm btn-outline" onclick="window.completeRepeatCycle('movie', ${item.id}, this)">✓ Complete Rewatch</button>` : ''}
                <button type="button" class="btn btn-sm btn-outline" title="Refresh movie details from TMDB" onclick="window.refreshMovieDetails(${item.id}, this)">🔄 Refresh</button>
                <button type="button" class="btn btn-sm btn-outline" onclick="window.openEditModal('media', ${item.id})">Edit</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ===================================================
  // TV SERIES TAB (Only Series)
  // ===================================================
  async function loadSeries() {
    try {
      let url = `/api/media?type=tv&status=${encodeURIComponent(seriesFilterStatus)}`;
      if (seriesSearchQuery) {
        url += `&search=${encodeURIComponent(seriesSearchQuery)}`;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not load TV series');
      const items = await res.json();

      renderSeriesGrid(items);
    } catch (err) {
      console.error(err);
      showToast('Could not load TV series', 'error');
    }
  }

  function renderSeriesGrid(items) {
    const container = document.getElementById('series-cards-container');
    if (!container) return;

    if (!items || items.length === 0) {
      let emptyTitle = 'No TV series found';
      let emptyMsg = 'Add a TV series to track seasons, episodes, and real-time release schedules.';
      let emptyBtnAction = "window.openAddModal('search-tv')";
      let emptyBtnText = '➕ Add a TV Series';

      if (seriesFilterStatus === 'new_episodes') {
        emptyTitle = 'All Caught Up! ⚡';
        emptyMsg = 'No active series have unwatched released episodes waiting for you.';
        emptyBtnAction = "window.setSeriesFilter('all')";
        emptyBtnText = 'View All TV Series';
      } else if (seriesFilterStatus === 'watching') {
        emptyTitle = 'No Active Series 📺';
        emptyMsg = 'You do not have any TV series marked as currently watching.';
      } else if (seriesFilterStatus === 'completed') {
        emptyTitle = 'No Completed Series ✅';
        emptyMsg = 'TV series you have completely finished will appear here.';
      } else if (seriesFilterStatus === 'plan_to_watch') {
        emptyTitle = 'No Series in Plan to Watch ⏳';
        emptyMsg = 'Add shows you plan to binge in the future.';
      }

      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📺</span>
          <h4>${escapeHtml(emptyTitle)}</h4>
          <p>${escapeHtml(emptyMsg)}</p>
          <button class="btn btn-primary" onclick="${emptyBtnAction}">${escapeHtml(emptyBtnText)}</button>
        </div>
      `;
      return;
    }

    container.innerHTML = items.map(item => {
      const curS = item.current_season || 1;
      const curE = item.current_episode || 0;
      const latS = item.latest_season || 1;
      const latE = item.latest_episode || 0;

      const hasNew = item.status === 'watching' && (latS > curS || (latS === curS && latE > curE));
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
          <div class="card-poster" style="cursor:pointer;" onclick="window.openSeriesDetailModal(${item.id})" title="Click to view seasons and episodes">
            ${item.poster_url ? `<img src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}">` : `<div class="poster-fallback"><span>📺</span></div>`}
            <div class="card-top-badges">
              <span class="badge-tag badge-type">TV Series</span>
              <span class="badge-tag badge-status ${item.status}">${statusLabel}</span>
              ${item.current_cycle && item.current_cycle > 1 ? `<span class="cycle-badge">🔁 Cycle ${item.current_cycle}</span>` : ''}
            </div>
          </div>
          <div class="card-content">
            <h4 class="card-title" style="cursor:pointer;" onclick="window.openSeriesDetailModal(${item.id})" title="Click to view seasons and episodes">${escapeHtml(item.title)}</h4>
            <div class="card-meta">
              ${item.release_year ? `<span>📅 ${escapeHtml(item.release_year)}</span>` : ''}
              ${item.genre ? `<span>🏷️ ${escapeHtml(item.genre)}</span>` : ''}
            </div>

            <div class="episode-tracker-box">
              <div class="episode-current-row">
                <span>Watched to:</span>
                <strong>Season ${curS}, Episode ${curE}</strong>
              </div>

              ${item.is_progress_invalid ? `
                <div class="episode-invalid-alert">⚠️ Invalid progress: S${curS} E${curE}. ${escapeHtml(item.invalid_progress_reason || '')} Please select a valid episode in Edit.</div>
              ` : hasNew ? `
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

              ${renderEpisodeProgressControls(item)}
            </div>

            ${item.notes ? `
              <p style="font-size:0.8rem; color:#94a3b8; font-style:italic;">"${escapeHtml(item.notes)}"</p>
            ` : ''}

            <div class="card-actions">
              <span class="rating-stars">${renderStars(item.rating)}</span>
              <div class="card-actions-right">
                ${item.status === 'completed' ? `<button type="button" class="btn btn-sm btn-repeat-action" onclick="window.startRepeatCycle('tv', ${item.id}, this)">🔁 Start Rewatch</button>` : ''}
                ${item.current_cycle > 1 && item.status !== 'completed' ? `<button type="button" class="btn btn-sm btn-outline" onclick="window.completeRepeatCycle('tv', ${item.id}, this)">✓ Complete Rewatch</button>` : ''}
                <button type="button" class="btn btn-sm btn-view-seasons" onclick="window.openSeriesDetailModal(${item.id})" title="View Seasons & Episodes">📺 Seasons</button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="window.refreshEpisodeDetails(${item.id}, this)" title="Refresh episode details and runtimes from TVMaze">🔄</button>
                <button type="button" class="btn btn-sm btn-outline" onclick="window.openEditModal('media', ${item.id})">Edit</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Wrapper for backward compatibility
  async function loadMedia() {
    await Promise.all([loadMovies(), loadSeries()]);
  }

  function refreshMediaViews() {
    if (currentView === 'movies') loadMovies();
    if (currentView === 'series') loadSeries();
    if (currentView === 'media') loadMedia();
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
        statusParam = 'not_completed';
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
      let emptyTitle = 'No books found with selected filters';
      let emptyMsg = 'Add books you own physically or plan to read to manage your library.';
      let emptyBtnAction = "window.openAddModal('search-book')";
      let emptyBtnText = '➕ Add a Book';

      if (booksFilterOwned === 'unread-owned' || (booksFilterOwned === '1' && booksFilterStatus === 'not_completed')) {
        emptyTitle = 'No Unread Books on Your Shelf 📖';
        emptyMsg = 'You have read every book you physically own at home, or haven\'t added any owned books yet!';
        emptyBtnAction = "window.openAddModal('search-book')";
        emptyBtnText = '➕ Add an Owned Book';
      } else if (booksFilterOwned === '1' && booksFilterStatus === 'all') {
        emptyTitle = 'No Books Owned at Home 🏠';
        emptyMsg = 'You haven\'t marked any books in your library as owned at home yet.';
      } else if (booksFilterStatus === 'completed') {
        emptyTitle = 'No Completed Books Yet ✅';
        emptyMsg = 'Finish reading a book and mark it completed to start tracking your reading milestones.';
      }

      booksContainer.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📚</span>
          <h4>${escapeHtml(emptyTitle)}</h4>
          <p>${escapeHtml(emptyMsg)}</p>
          <button class="btn btn-primary" onclick="${emptyBtnAction}">${escapeHtml(emptyBtnText)}</button>
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
              ${book.current_cycle && book.current_cycle > 1 ? `<span class="cycle-badge">📖 Cycle ${book.current_cycle}</span>` : ''}
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
              ${book.status !== 'completed' ? `
                <button type="button" class="btn btn-sm btn-ghost" style="width:100%; margin-top:0.4rem; font-size:0.75rem; color:#34d399;" onclick="window.markBookCompleted(${book.id})">
                  ✅ Mark as Completed
                </button>
              ` : ''}
            </div>

            ${book.notes ? `
              <p style="font-size:0.8rem; color:#94a3b8; font-style:italic; margin-top:0.4rem;">"${escapeHtml(book.notes)}"</p>
            ` : ''}

            <div class="card-actions">
              <span class="rating-stars">${renderStars(book.rating)}</span>
              <div class="card-actions-right">
                ${book.status === 'completed' ? `<button type="button" class="btn btn-sm btn-repeat-action" onclick="window.startRepeatCycle('book', ${book.id}, this)">📖 Start Reread</button>` : ''}
                ${book.current_cycle > 1 && book.status !== 'completed' ? `<button type="button" class="btn btn-sm btn-outline" onclick="window.completeRepeatCycle('book', ${book.id}, this)">✓ Complete Reread</button>` : ''}
                <button class="btn btn-sm btn-outline" onclick="window.openEditModal('book', ${book.id})">Edit</button>
              </div>
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
  // REFRESH EPISODE DETAILS & RUNTIMES (TVMaze API)
  // ===================================================
  window.refreshEpisodeDetails = async function(id, btnElement) {
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.dataset.originalHtml = btnElement.innerHTML;
      btnElement.innerHTML = '⏳ Refreshing...';
    }
    showToast('Refreshing episode details & runtimes from TVMaze... ⏳', 'info');
    try {
      const res = await fetch(`/api/media/${id}/refresh-episodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not refresh episode details');
      }

      const msg = data.message || `Refreshed "${data.show?.title || 'series'}": metadata updated.`;
      showToast(msg, 'success');

      await refreshAfterDataChange();

      // If series modal is currently open for this show, re-open it to refresh view
      if (currentSeriesDetailId === Number(id)) {
        window.openSeriesDetailModal(id);
      }
    } catch (err) {
      showToast('Refresh failed: ' + err.message, 'error');
    } finally {
      if (btnElement) {
        btnElement.disabled = false;
        if (btnElement.dataset.originalHtml) {
          btnElement.innerHTML = btnElement.dataset.originalHtml;
        }
      }
    }
  };
  window.refreshSingleShow = window.refreshEpisodeDetails;

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

  let movieSearchSeq = 0;
  let currentMovieSearchQuery = '';
  let currentMovieSearchPage = 1;

  async function handleSearchMovie(page = 1) {
    const input = document.getElementById('input-search-movie');
    const container = document.getElementById('results-search-movie');
    const query = (input?.value || currentMovieSearchQuery || '').trim();
    if (!query) return;

    currentMovieSearchQuery = query;
    currentMovieSearchPage = page;
    const thisSeq = ++movieSearchSeq;

    container.innerHTML = `<div style="color:#94a3b8; padding:1.5rem; text-align:center;">Searching TMDB for "${escapeHtml(query)}" (page ${page})... ⏳</div>`;

    try {
      const res = await fetch(`/api/search/movies?q=${encodeURIComponent(query)}&page=${page}`);
      if (thisSeq !== movieSearchSeq) return; // Discard older/stale query response

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        container.innerHTML = `<div style="color:#ef4444; padding:1.25rem; text-align:center;">Could not search movies: ${escapeHtml(errData.error || 'Server error')}</div>`;
        return;
      }

      const data = await res.json();
      if (thisSeq !== movieSearchSeq) return; // Discard older/stale query response

      const results = Array.isArray(data) ? data : (data.results || []);
      const totalPages = data.total_pages || 1;
      const totalResults = data.total_results || results.length;

      if (results.length === 0) {
        container.innerHTML = `<div style="color:#94a3b8; padding:1.5rem; text-align:center;">No movies found for "${escapeHtml(query)}". Try another title or spelling.</div>`;
        return;
      }

      let html = results.map(movie => {
        const posterUrl = movie.poster_url || movie.poster;
        const yearStr = movie.release_year || movie.year || '';
        const overviewStr = movie.overview || movie.summary || '';
        return `
          <div class="search-result-item">
            ${posterUrl ? `<img class="search-result-poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(movie.title)}" onerror="this.onerror=null; this.src=''; this.parentElement.innerHTML='<div class=\\'search-result-poster fallback-poster\\'>🎬</div>';">` : `<div class="search-result-poster fallback-poster">🎬</div>`}
            <div class="search-result-info">
              <div class="search-result-title">${escapeHtml(movie.title)} ${yearStr ? `<span style="color:#94a3b8; font-weight:normal; font-size:0.85rem;">(${escapeHtml(yearStr)})</span>` : ''}</div>
              <div class="search-result-meta">${yearStr ? `${yearStr} • ` : ''}Movie ${movie.vote_average ? `• ⭐ ${movie.vote_average}` : ''}</div>
              ${overviewStr ? `<div class="search-result-summary">${escapeHtml(overviewStr)}</div>` : ''}
            </div>
            <button class="btn btn-sm btn-primary" onclick='window.addFromSearchMovie(${JSON.stringify(movie).replace(/'/g, "&apos;")})'>
              ➕ Add
            </button>
          </div>
        `;
      }).join('');

      if (totalPages > 1) {
        html += `
          <div class="search-pagination">
            <span>Page <strong>${page}</strong> of <strong>${totalPages}</strong> (${totalResults} results)</span>
            <div class="search-pagination-btns">
              <button type="button" class="btn btn-sm btn-outline" ${page <= 1 ? 'disabled' : ''} onclick="window.handleSearchMoviePage(${page - 1})">◀ Prev</button>
              <button type="button" class="btn btn-sm btn-outline" ${page >= totalPages ? 'disabled' : ''} onclick="window.handleSearchMoviePage(${page + 1})">Next ▶</button>
            </div>
          </div>
        `;
      }

      container.innerHTML = html;
    } catch (err) {
      if (thisSeq !== movieSearchSeq) return;
      container.innerHTML = `<div style="color:#ef4444; padding:1.25rem; text-align:center;">Network error searching movies: ${escapeHtml(err.message)}</div>`;
    }
  }

  window.handleSearchMoviePage = function(page) {
    handleSearchMovie(page);
  };

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
      refreshMediaViews();
    } catch (err) {
      showToast('Error saving: ' + err.message, 'error');
    }
  };

  window.addFromSearchMovie = async function(movie) {
    try {
      const payload = {
        type: 'movie',
        title: movie.title,
        external_id: String(movie.id || movie.tmdb_id),
        poster_url: movie.poster_url || movie.poster,
        release_year: movie.release_year || movie.year,
        genre: movie.genre || 'Movie',
        status: 'completed'
      };

      const res = await fetch('/api/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (res.status === 409) {
          showToast(errData.error || `"${movie.title}" is already in your library.`, 'warning');
          return;
        }
        throw new Error(errData.error || 'Failed to save movie');
      }

      const created = await res.json();
      const rtMsg = created.runtime ? ` Runtime: ${created.runtime}m.` : '';
      showToast(`🎬 "${movie.title}" added to your movie library!${rtMsg}`, 'success');
      closeAddModal();
      await loadAllData();
      refreshMediaViews();
    } catch (err) {
      showToast('Error saving: ' + err.message, 'error');
    }
  };

  // ===================================================
  // REFRESH MOVIE DETAILS & TMDB LINKING
  // ===================================================
  let currentLinkingMovieId = null;
  let linkMovieSearchSeq = 0;
  let currentLinkMovieResultsMap = new Map();

  window.refreshMovieDetails = async function(id, btnElement) {
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.dataset.origText = btnElement.innerHTML;
      btnElement.innerHTML = '⏳ Refreshing...';
    }

    try {
      // 1. Fetch current movie details from backend to verify external_id and title
      const checkRes = await fetch(`/api/media/${id}`);
      if (!checkRes.ok) {
        throw new Error('Movie not found in library');
      }
      const item = await checkRes.json();

      if (!item.external_id) {
        // Unlinked movie: open the search dialog using its title so user can confirm correct movie
        await window.openLinkMovieModal(id, item.title);
        return;
      }

      showToast(`Refreshing details for "${item.title}"... ⏳`, 'info');
      const res = await fetch(`/api/media/${id}/refresh-movie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Could not refresh movie details');
      }

      const data = await res.json();
      const movie = data.movie || {};
      if (data.manual_runtime_preserved) {
        showToast(`🎬 "${movie.title || item.title}" refreshed! Manual runtime (${movie.runtime}m) preserved.`, 'info');
      } else if (movie.runtime && Number(movie.runtime) > 0) {
        showToast(`🎬 "${movie.title || item.title}" metadata refreshed! Runtime: ${movie.runtime}m.`, 'success');
      } else {
        showToast(`🎬 "${movie.title || item.title}" refreshed from TMDB (no runtime provided by TMDB).`, 'info');
      }

      await refreshAfterDataChange();
      if (currentView === 'movies') loadMovies();
    } catch (err) {
      showToast('Refresh failed: ' + err.message, 'error');
    } finally {
      if (btnElement) {
        btnElement.disabled = false;
        if (btnElement.dataset.origText) btnElement.innerHTML = btnElement.dataset.origText;
      }
    }
  };

  window.openLinkMovieModal = async function(id, initialTitle = '') {
    currentLinkingMovieId = id;
    const modal = document.getElementById('modal-link-movie');
    const titleEl = document.getElementById('modal-link-movie-title');
    const input = document.getElementById('input-link-movie-search');
    const resultsContainer = document.getElementById('results-link-movie');

    if (!modal) return;

    let movieTitle = initialTitle;
    if (!movieTitle) {
      try {
        const res = await fetch(`/api/media/${id}`);
        if (res.ok) {
          const m = await res.json();
          movieTitle = m.title || '';
        }
      } catch {}
    }

    if (titleEl) titleEl.textContent = movieTitle ? `Link Movie: "${movieTitle}"` : 'Link Movie to TMDB';
    if (input) input.value = movieTitle;
    if (resultsContainer) resultsContainer.innerHTML = '';

    modal.classList.remove('hidden');

    if (movieTitle) {
      handleSearchLinkMovie(1);
    }
  };

  window.closeLinkMovieModal = function() {
    const modal = document.getElementById('modal-link-movie');
    if (modal) modal.classList.add('hidden');
    currentLinkingMovieId = null;
  };

  async function handleSearchLinkMovie(page = 1) {
    const input = document.getElementById('input-link-movie-search');
    const container = document.getElementById('results-link-movie');
    const query = input ? input.value.trim() : '';
    if (!query || !container) return;

    const thisSeq = ++linkMovieSearchSeq;
    container.innerHTML = `<div style="color:#94a3b8; padding:1.25rem; text-align:center;">Searching TMDB for "${escapeHtml(query)}"... ⏳</div>`;

    try {
      const res = await fetch(`/api/search/movies?q=${encodeURIComponent(query)}&page=${page}`);
      if (thisSeq !== linkMovieSearchSeq) return;

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        container.innerHTML = `
          <div style="color:#ef4444; padding:1rem; text-align:center;">
            Search failed: ${escapeHtml(errData.error || 'Server error')}
            <div style="margin-top:0.75rem;">
              <button type="button" class="btn btn-sm btn-outline" onclick="window.handleSearchLinkMoviePage(${page})">🔄 Retry Search</button>
            </div>
          </div>
        `;
        return;
      }

      const data = await res.json();
      if (thisSeq !== linkMovieSearchSeq) return;

      const results = Array.isArray(data) ? data : (data.results || []);
      currentLinkMovieResultsMap.clear();
      for (const m of results) {
        const tid = m.id || m.tmdb_id;
        if (tid) currentLinkMovieResultsMap.set(String(tid), m);
      }

      const totalPages = data.total_pages || 1;

      if (results.length === 0) {
        container.innerHTML = `
          <div style="color:#94a3b8; padding:1.25rem; text-align:center;">
            No matching movies found on TMDB for "${escapeHtml(query)}".
            <p style="font-size:0.8rem; margin-top:0.5rem; color:#64748b;">Try adjusting your search terms above.</p>
          </div>
        `;
        return;
      }

      let html = results.map(movie => {
        const posterUrl = movie.poster_url || movie.poster;
        const yearStr = movie.release_year || movie.year || '';
        const overviewStr = movie.overview || movie.summary || '';
        const tmdbId = movie.id || movie.tmdb_id;
        return `
          <div class="search-result-item" id="link-movie-item-${tmdbId}">
            ${posterUrl ? `<img class="search-result-poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(movie.title)}" onerror="this.onerror=null; this.src=''; this.parentElement.innerHTML='<div class=\\'search-result-poster fallback-poster\\'>🎬</div>';">` : `<div class="search-result-poster fallback-poster">🎬</div>`}
            <div class="search-result-info">
              <div class="search-result-title">${escapeHtml(movie.title)} ${yearStr ? `<span style="color:#94a3b8; font-weight:normal; font-size:0.85rem;">(${escapeHtml(yearStr)})</span>` : ''}</div>
              <div class="search-result-meta">${yearStr ? `${yearStr} • ` : ''}TMDB ID: ${tmdbId} ${movie.vote_average ? `• ⭐ ${movie.vote_average}` : ''}</div>
              ${overviewStr ? `<div class="search-result-summary">${escapeHtml(overviewStr)}</div>` : ''}
            </div>
            <button type="button" class="btn btn-sm btn-primary" onclick="window.confirmLinkMovieById(${tmdbId}, this)">
              🔗 Confirm & Link
            </button>
          </div>
        `;
      }).join('');

      if (totalPages > 1) {
        html += `
          <div class="search-pagination">
            <span>Page <strong>${page}</strong> of <strong>${totalPages}</strong></span>
            <div class="search-pagination-btns">
              <button type="button" class="btn btn-sm btn-outline" ${page <= 1 ? 'disabled' : ''} onclick="window.handleSearchLinkMoviePage(${page - 1})">◀ Prev</button>
              <button type="button" class="btn btn-sm btn-outline" ${page >= totalPages ? 'disabled' : ''} onclick="window.handleSearchLinkMoviePage(${page + 1})">Next ▶</button>
            </div>
          </div>
        `;
      }

      container.innerHTML = html;
    } catch (err) {
      if (thisSeq !== linkMovieSearchSeq) return;
      container.innerHTML = `
        <div style="color:#ef4444; padding:1rem; text-align:center;">
          Network error: ${escapeHtml(err.message)}
          <div style="margin-top:0.75rem;">
            <button type="button" class="btn btn-sm btn-outline" onclick="window.handleSearchLinkMoviePage(${page})">🔄 Retry Search</button>
          </div>
        </div>
      `;
    }
  }

  window.handleSearchLinkMoviePage = function(page) {
    handleSearchLinkMovie(page);
  };

  window.confirmLinkMovieById = async function(tmdbId, btnElement) {
    if (!currentLinkingMovieId) return;

    if (btnElement) {
      btnElement.disabled = true;
      btnElement.dataset.origHtml = btnElement.innerHTML;
      btnElement.innerHTML = '⏳ Linking...';
    }

    try {
      const res = await fetch(`/api/media/${currentLinkingMovieId}/refresh-movie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdb_id: tmdbId })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (res.status === 409) {
          showToast(errData.error || 'This movie is already in your library.', 'warning');
          return;
        }
        throw new Error(errData.error || 'Could not link movie');
      }

      const data = await res.json();
      const updated = data.movie || {};
      if (data.manual_runtime_preserved) {
        showToast(`🎬 Linked to "${updated.title}"! Manual runtime (${updated.runtime}m) preserved.`, 'info');
      } else if (updated.runtime && Number(updated.runtime) > 0) {
        showToast(`🎬 Linked to "${updated.title}"! Runtime: ${updated.runtime}m.`, 'success');
      } else {
        showToast(`🎬 Linked to "${updated.title}"! (TMDB has no runtime metadata for this movie).`, 'info');
      }

      window.closeLinkMovieModal();
      await refreshAfterDataChange();
      if (currentView === 'movies') loadMovies();
    } catch (err) {
      showToast('Error linking movie: ' + err.message, 'error');
    } finally {
      if (btnElement) {
        btnElement.disabled = false;
        if (btnElement.dataset.origHtml) btnElement.innerHTML = btnElement.dataset.origHtml;
      }
    }
  };

  window.confirmLinkMovie = function(movie) {
    const tmdbId = movie?.id || movie?.tmdb_id;
    if (tmdbId) window.confirmLinkMovieById(tmdbId);
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
        const pageCountVal = document.getElementById('manual-page-count').value;
        const curPageVal = document.getElementById('manual-current-page').value;
        const page_count = Number(pageCountVal) || 0;
        const current_page = Number(curPageVal) || 0;

        if (!Number.isInteger(page_count) || page_count < 0) {
          showToast('Total pages must be a whole non-negative integer.', 'warning');
          return;
        }
        if (!Number.isInteger(current_page) || current_page < 0) {
          showToast('Current page must be a whole non-negative integer.', 'warning');
          return;
        }
        if (page_count > 0 && current_page > page_count) {
          showToast(`Current page cannot exceed total pages (${page_count}).`, 'warning');
          return;
        }

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

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to save book');
        }
        showToast(`📚 Book "${title}" saved!`, 'success');
      } else {
        const curSeason = Number(document.getElementById('manual-cur-season').value) || 1;
        const curEpisode = Number(document.getElementById('manual-cur-episode').value) || 0;
        const latSeason = Number(document.getElementById('manual-latest-season').value) || 1;
        const latEpisode = Number(document.getElementById('manual-latest-episode').value) || 0;

        let runtime = null;
        let is_runtime_manual = undefined;
        if (type === 'movie') {
          const rInput = document.getElementById('manual-movie-runtime');
          const val = rInput ? rInput.value.trim() : '';
          if (val !== '') {
            runtime = Number(val) > 0 ? Math.round(Number(val)) : null;
            is_runtime_manual = 1;
          }
        }

        const res = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type, title, status, rating, poster_url: poster, notes,
            runtime,
            is_runtime_manual,
            current_season: curSeason,
            current_episode: curEpisode,
            latest_season: latSeason,
            latest_episode: latEpisode
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to save media');
        }
        showToast(`🎬 "${title}" saved!`, 'success');
      }

      closeAddModal();
      loadAllData();
      refreshMediaViews();
      if (currentView === 'books') loadBooks();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  // ===================================================
  // EDIT TV FIELDS VALIDATION (Requirement 4)
  // ===================================================

  // ===================================================
  // EDIT TV FIELDS VALIDATION (Requirement 4)
  // ===================================================
  function validateEditTVFields(activeField = 'both') {
    const seasonInput = document.getElementById('edit-cur-season');
    const episodeInput = document.getElementById('edit-cur-episode');
    const seasonErrorEl = document.getElementById('edit-season-error');
    const episodeErrorEl = document.getElementById('edit-episode-error');

    if (!seasonInput || !episodeInput || !seasonErrorEl || !episodeErrorEl) return { valid: true };

    const sStr = seasonInput.value.trim();
    const eStr = episodeInput.value.trim();

    // Reject negative numbers
    if (sStr.startsWith('-') || eStr.startsWith('-')) {
      const isS = sStr.startsWith('-');
      const err = 'Season and episode numbers cannot be negative.';
      if (isS && (activeField === 'season' || activeField === 'both')) {
        seasonErrorEl.textContent = err;
        seasonErrorEl.classList.remove('hidden');
        seasonInput.classList.add('input-error');
      } else if (!isS && (activeField === 'episode' || activeField === 'both')) {
        episodeErrorEl.textContent = err;
        episodeErrorEl.classList.remove('hidden');
        episodeInput.classList.add('input-error');
      }
      return { valid: false, field: isS ? 'season' : 'episode', error: err };
    }

    // Reject decimals
    if (sStr.includes('.') || eStr.includes('.')) {
      const isS = sStr.includes('.');
      const err = 'Season and episode numbers must be whole integers.';
      if (isS && (activeField === 'season' || activeField === 'both')) {
        seasonErrorEl.textContent = err;
        seasonErrorEl.classList.remove('hidden');
        seasonInput.classList.add('input-error');
      } else if (!isS && (activeField === 'episode' || activeField === 'both')) {
        episodeErrorEl.textContent = err;
        episodeErrorEl.classList.remove('hidden');
        episodeInput.classList.add('input-error');
      }
      return { valid: false, field: isS ? 'season' : 'episode', error: err };
    }

    const s = parseInt(sStr, 10);
    const e = parseInt(eStr, 10);

    if (isNaN(s) || isNaN(e)) {
      return { valid: false, error: 'Season and episode must be numbers.' };
    }

    // Validate against real series seasons if loaded
    if (currentEditingShowData) {
      if (!currentEditingShowData.available) {
        if (activeField === 'episode' || activeField === 'both') {
          episodeErrorEl.textContent = 'Episode data is unavailable. Please retry TVMaze sync before saving.';
          episodeErrorEl.classList.remove('hidden');
        }
        return { valid: false, unavailable: true, error: 'Episode data is unavailable.' };
      }

      // Check season existence
      const seasonObj = currentEditingShowData.seasons.find(x => x.seasonNumber === s);
      if (!seasonObj) {
        const allNums = currentEditingShowData.seasons.map(x => x.seasonNumber);
        const maxSeason = allNums.length > 0 ? Math.max(...allNums) : 0;
        const err = `Season ${s} does not exist. This series has ${maxSeason} season${maxSeason === 1 ? '' : 's'}.`;
        if (activeField === 'season' || activeField === 'both') {
          seasonErrorEl.textContent = err;
          seasonErrorEl.classList.remove('hidden');
          seasonInput.classList.add('input-error');
        }
        return { valid: false, field: 'season', error: err };
      } else {
        seasonErrorEl.textContent = '';
        seasonErrorEl.classList.add('hidden');
        seasonInput.classList.remove('input-error');
      }

      // Allow episode 0 to mean no episodes watched in the selected season
      if (e === 0) {
        episodeErrorEl.textContent = '';
        episodeErrorEl.classList.add('hidden');
        episodeInput.classList.remove('input-error');
        return { valid: true };
      }

      // Check episode in season
      const totalInSeason = seasonObj.totalEpisodes;
      if (e > totalInSeason || e < 0) {
        const err = `Season ${s} has ${totalInSeason} episodes. Enter an episode between 0 and ${totalInSeason}.`;
        if (activeField === 'episode' || activeField === 'both') {
          episodeErrorEl.textContent = err;
          episodeErrorEl.classList.remove('hidden');
          episodeInput.classList.add('input-error');
        }
        return { valid: false, field: 'episode', error: err };
      }

      // Check if episode has been released
      const ep = seasonObj.episodes.find(x => x.number === e);
      if (ep && !ep.isReleased) {
        const err = `Season ${s} Episode ${e} has not been released yet.`;
        if (activeField === 'episode' || activeField === 'both') {
          episodeErrorEl.textContent = err;
          episodeErrorEl.classList.remove('hidden');
          episodeInput.classList.add('input-error');
        }
        return { valid: false, field: 'episode', error: err };
      }

      // Clear errors
      episodeErrorEl.textContent = '';
      episodeErrorEl.classList.add('hidden');
      episodeInput.classList.remove('input-error');
      return { valid: true };
    }

    return { valid: true };
  }

  // ===================================================
  // EDIT MODAL & ACTIONS
  // ===================================================
  window.openEditModal = async function(kind, id) {
    document.getElementById('edit-id').value = id;
    document.getElementById('edit-item-kind').value = kind;

    const bookFields = document.getElementById('edit-book-fields');
    const tvFields = document.getElementById('edit-tv-fields');
    const movieFields = document.getElementById('edit-movie-fields');
    currentEditingShowData = null;

    try {
      if (kind === 'book') {
        bookFields.classList.remove('hidden');
        tvFields.classList.add('hidden');
        movieFields?.classList.add('hidden');

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
          movieFields?.classList.add('hidden');
          document.getElementById('edit-cur-season').value = media.current_season !== undefined ? media.current_season : 1;
          document.getElementById('edit-cur-episode').value = media.current_episode !== undefined ? media.current_episode : 0;
          document.getElementById('edit-latest-season').value = media.latest_season || 1;
          document.getElementById('edit-latest-episode').value = media.latest_episode || 0;

          // Clear field errors
          const seasonErrorEl = document.getElementById('edit-season-error');
          const episodeErrorEl = document.getElementById('edit-episode-error');
          if (seasonErrorEl) { seasonErrorEl.textContent = ''; seasonErrorEl.classList.add('hidden'); }
          if (episodeErrorEl) { episodeErrorEl.textContent = ''; episodeErrorEl.classList.add('hidden'); }
          document.getElementById('edit-cur-season')?.classList.remove('input-error');
          document.getElementById('edit-cur-episode')?.classList.remove('input-error');

          const alertEl = document.getElementById('edit-tv-invalid-alert');
          const hintEl = document.getElementById('edit-tv-hint');

          if (media.is_progress_invalid) {
            if (alertEl) {
              alertEl.textContent = `⚠️ Current progress (Season ${media.current_season || 1} Episode ${media.current_episode || 0}) is invalid: ${media.invalid_progress_reason || 'Please select a valid released season and episode'}.`;
              alertEl.classList.remove('hidden');
            }
          } else {
            if (alertEl) alertEl.classList.add('hidden');
          }

          if (hintEl) {
            hintEl.textContent = media.latest_season ? `Latest released: Season ${media.latest_season}, Episode ${media.latest_episode}` : '';
          }

          // Fetch show season details for live inline validation
          fetch(`/api/media/${id}/seasons`)
            .then(r => r.json())
            .then(data => {
              currentEditingShowData = data;
              if (!data.available && alertEl) {
                alertEl.innerHTML = `⚠️ Episode data is currently unavailable. <button type="button" class="btn btn-sm btn-secondary" onclick="window.retryEditSync(${id})">Retry TVMaze Sync</button>`;
                alertEl.classList.remove('hidden');
              }
            })
            .catch(() => {});
        } else {
          tvFields.classList.add('hidden');
          movieFields?.classList.remove('hidden');
          const runtimeInput = document.getElementById('edit-movie-runtime');
          if (runtimeInput) runtimeInput.value = (media.runtime && media.runtime > 0) ? media.runtime : '';

          const manualInd = document.getElementById('edit-movie-manual-indicator');
          if (manualInd) manualInd.classList.toggle('hidden', media.is_runtime_manual !== 1);

          const tmdbInfo = document.getElementById('edit-movie-tmdb-info');
          const tmdbSub = document.getElementById('edit-movie-tmdb-sub');
          if (tmdbInfo) {
            tmdbInfo.textContent = media.external_id ? `TMDB ID: ${media.external_id}` : 'TMDB: Not Linked';
          }
          if (tmdbSub) {
            tmdbSub.textContent = media.external_id
              ? (media.runtime ? `Synced runtime: ${media.runtime}m.` : 'Linked, but runtime unknown.')
              : 'Link to TMDB to automatically retrieve runtime & poster.';
          }

          const btnRefresh = document.getElementById('btn-refresh-modal-movie');
          if (btnRefresh) {
            btnRefresh.onclick = () => window.refreshMovieDetails(media.id);
          }
          const btnLink = document.getElementById('btn-link-modal-movie');
          if (btnLink) {
            btnLink.onclick = () => window.openLinkMovieModal(media.id);
          }
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
        const pageCountVal = document.getElementById('edit-page-count').value;
        const curPageVal = document.getElementById('edit-current-page').value;
        const page_count = Number(pageCountVal) || 0;
        const current_page = Number(curPageVal) || 0;

        if (!Number.isInteger(page_count) || page_count < 0) {
          showToast('Total pages must be a whole non-negative integer.', 'warning');
          return;
        }
        if (!Number.isInteger(current_page) || current_page < 0) {
          showToast('Current page must be a whole non-negative integer.', 'warning');
          return;
        }
        if (page_count > 0 && current_page > page_count) {
          showToast(`Current page cannot exceed total pages (${page_count}).`, 'warning');
          return;
        }

        const format = document.getElementById('edit-format').value;
        const owned = Number(document.getElementById('edit-owned').value);

        const res = await fetch(`/api/books/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title, author, page_count, current_page, format, owned,
            status, rating, cover_url: poster, notes,
            is_correction: 1
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Could not update book');
        }
        showToast('Book updated!', 'success');
      } else {
        const isTV = !document.getElementById('edit-tv-fields')?.classList.contains('hidden');
        if (isTV) {
          const valResult = validateEditTVFields('both');
          if (!valResult.valid) {
            showToast(valResult.error || 'Please correct the highlighted fields before saving.', 'warning');
            if (valResult.field === 'season') {
              document.getElementById('edit-cur-season')?.focus();
            } else {
              document.getElementById('edit-cur-episode')?.focus();
            }
            return; // Keep modal open!
          }
        }

        const curSeason = Number(document.getElementById('edit-cur-season')?.value) || 1;
        const curEpisode = Number(document.getElementById('edit-cur-episode')?.value) || 0;
        const latSeason = Number(document.getElementById('edit-latest-season')?.value) || 1;
        const latEpisode = Number(document.getElementById('edit-latest-episode')?.value) || 0;

        let runtime = null;
        let is_runtime_manual = undefined;
        if (!isTV) {
          const rInput = document.getElementById('edit-movie-runtime');
          const val = rInput ? rInput.value.trim() : '';
          if (val !== '') {
            runtime = Number(val) > 0 ? Math.round(Number(val)) : null;
            is_runtime_manual = 1;
          } else {
            runtime = null;
            is_runtime_manual = 0;
          }
        }

        const res = await fetch(`/api/media/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title, status, rating, poster_url: poster, notes,
            runtime,
            is_runtime_manual,
            current_season: curSeason,
            current_episode: curEpisode,
            latest_season: latSeason,
            latest_episode: latEpisode
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData.error || 'Could not update media';
          showToast(errMsg, 'error');

          const episodeErrorEl = document.getElementById('edit-episode-error');
          if (episodeErrorEl && (errMsg.includes('episodes') || errMsg.includes('Season'))) {
            episodeErrorEl.textContent = errMsg.replace('Invalid progress: ', '');
            episodeErrorEl.classList.remove('hidden');
            document.getElementById('edit-cur-episode')?.classList.add('input-error');
          }
          return; // Keep modal open!
        }
        showToast('Updated!', 'success');
      }

      closeEditModal();
      await refreshAfterDataChange();
      refreshMediaViews();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  // Retry sync button helper
  window.retryEditSync = async function(id) {
    showToast('Retrying TVMaze sync... ⏳', 'info');
    try {
      const res = await fetch(`/api/media/${id}/refresh-episodes`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync retry failed');
      showToast('TVMaze data refreshed!', 'success');
      openEditModal('media', id);
    } catch (err) {
      showToast('Retry error: ' + err.message, 'error');
    }
  };

  // ===================================================
  // UNDO TOAST MANAGEMENT
  // ===================================================
  function showUndoToast(message, undoFn) {
    const toast = document.getElementById('undo-toast-container');
    const textEl = document.getElementById('undo-toast-text');
    if (!toast || !textEl) return;

    if (undoToastTimer) clearTimeout(undoToastTimer);

    textEl.textContent = message;
    undoActionCallback = undoFn;
    toast.classList.remove('hidden');

    undoToastTimer = setTimeout(() => {
      toast.classList.add('hidden');
      undoActionCallback = null;
    }, 8000);
  }

  function hideUndoToast() {
    const toast = document.getElementById('undo-toast-container');
    if (toast) toast.classList.add('hidden');
    if (undoToastTimer) clearTimeout(undoToastTimer);
    undoActionCallback = null;
  }

  // ===================================================
  // TV SERIES SEASONS & EPISODES DETAIL VIEW
  // ===================================================
  window.openSeriesDetailModal = async function(id, targetSeason = null) {
    if (!currentUser) {
      showToast('Please sign in to view episode details.', 'warning');
      openAuthModal('login');
      return;
    }

    currentSeriesDetailId = id;
    const modal = document.getElementById('modal-series-detail');
    const titleEl = document.getElementById('modal-series-title');
    const metaEl = document.getElementById('series-modal-meta');
    const posterWrap = document.getElementById('series-modal-poster-wrap');
    const quickProgEl = document.getElementById('series-modal-quick-progress');
    const seasonsListEl = document.getElementById('seasons-list');
    const statsEl = document.getElementById('series-overall-stats');
    const seasonsTitle = document.getElementById('seasons-count-title');
    const alertBox = document.getElementById('series-detail-alert-box');

    if (!modal) return;

    modal.classList.remove('hidden');
    if (titleEl) titleEl.textContent = 'Loading series details...';
    if (metaEl) metaEl.innerHTML = '';
    if (posterWrap) posterWrap.innerHTML = '<div class="poster-fallback">📺</div>';
    if (quickProgEl) quickProgEl.innerHTML = '';
    if (seasonsListEl) seasonsListEl.innerHTML = '<div style="padding:2rem;text-align:center;color:#94a3b8;">Loading season and episode data... ⏳</div>';
    if (statsEl) statsEl.textContent = '';
    if (alertBox) alertBox.classList.add('hidden');

    try {
      const res = await fetch(`/api/media/${id}/seasons`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to load season details');
      }

      currentSeriesDetailData = data;
      const show = data.show;

      if (titleEl) titleEl.textContent = show.title;

      if (metaEl) {
        metaEl.innerHTML = `
          ${show.release_year ? `<span>📅 ${escapeHtml(show.release_year)}</span>` : ''}
          ${show.genre ? `<span>🏷️ ${escapeHtml(show.genre)}</span>` : ''}
          <span class="rating-stars">${renderStars(show.rating)}</span>
          <span class="badge-tag badge-status ${show.status}">${formatStatus(show.status)}</span>
          ${show.current_cycle && show.current_cycle > 1 ? `<span class="cycle-badge">🔁 Cycle ${show.current_cycle}</span>` : ''}
          <button type="button" class="btn btn-sm ${show.notify_enabled !== 0 ? 'btn-secondary' : 'btn-outline'}" onclick="window.toggleSeriesNotifications(${show.id}, ${show.notify_enabled !== 0 ? 0 : 1})">
            ${show.notify_enabled !== 0 ? '🔔 Alert ON' : '🔕 Alert OFF'}
          </button>
          <button type="button" class="btn btn-sm btn-secondary" onclick="window.refreshEpisodeDetails(${show.id}, this)" title="Refresh episode runtimes and latest info from TVMaze">
            🔄 Refresh episode details
          </button>
          ${show.status === 'completed' ? `<button type="button" class="btn btn-sm btn-repeat-action" onclick="window.startRepeatCycle('tv', ${show.id}, this)">🔁 Start Rewatch</button>` : ''}
          ${show.current_cycle > 1 && show.status !== 'completed' ? `<button type="button" class="btn btn-sm btn-outline" onclick="window.completeRepeatCycle('tv', ${show.id}, this)">✓ Complete Rewatch</button>` : ''}
        `;
      }

      if (posterWrap) {
        posterWrap.innerHTML = show.poster_url 
          ? `<img src="${escapeHtml(show.poster_url)}" alt="${escapeHtml(show.title)}">` 
          : '<div class="poster-fallback">📺</div>';
      }

      renderModalQuickProgress(data);

      if (!data.available) {
        if (alertBox) {
          alertBox.className = 'episode-unavailable-alert';
          alertBox.innerHTML = `⚠️ ${escapeHtml(data.error || 'Episode data unavailable from TVMaze.')}`;
          alertBox.classList.remove('hidden');
        }
        if (seasonsListEl) seasonsListEl.innerHTML = '';
        return;
      }

      if (data.isProgressInvalid && alertBox) {
        alertBox.className = 'episode-invalid-alert';
        alertBox.textContent = `⚠️ Invalid progress: ${data.invalidProgressReason || 'Please select a valid season and episode in Edit.'}`;
        alertBox.classList.remove('hidden');
      }

      if (seasonsTitle) {
        seasonsTitle.textContent = `Seasons (${data.seasons.length})`;
      }

      if (statsEl) {
        statsEl.textContent = `${data.totalWatchedCount} of ${data.totalReleasedCount} released episodes watched`;
      }

      const curS = show.current_season || 1;
      if (targetSeason !== null && targetSeason !== undefined) {
        expandedSeasonsSet.clear();
        expandedSeasonsSet.add(Number(targetSeason));
      } else if (expandedSeasonsSet.size === 0) {
        expandedSeasonsSet.add(curS);
      }

      renderSeasonsAccordion(data);

      if (targetSeason !== null && targetSeason !== undefined) {
        setTimeout(() => {
          const panel = document.getElementById(`season-panel-${targetSeason}`) || document.getElementById(`season-accordion-${targetSeason}`);
          if (panel) {
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 120);
      }
    } catch (err) {
      if (titleEl) titleEl.textContent = 'Error Loading Series';
      if (seasonsListEl) seasonsListEl.innerHTML = `<div class="empty-state">❌ ${escapeHtml(err.message)}</div>`;
    }
  };

  function closeSeriesDetailModal() {
    const modal = document.getElementById('modal-series-detail');
    if (modal) modal.classList.add('hidden');
    currentSeriesDetailId = null;
    currentSeriesDetailData = null;
    expandedSeasonsSet.clear();
  }

  function renderModalQuickProgress(data) {
    const quickProgEl = document.getElementById('series-modal-quick-progress');
    if (!quickProgEl) return;

    if (!data.available) {
      quickProgEl.innerHTML = `<span class="badge-tag" style="background:#334155;color:#94a3b8;">Data unavailable</span>`;
      return;
    }

    if (data.isProgressInvalid) {
      quickProgEl.innerHTML = `<button type="button" class="btn btn-sm btn-secondary" onclick="window.openEditModal('media', ${data.show.id})">⚠️ Fix Progress in Edit</button>`;
      return;
    }

    if (data.isCaughtUp) {
      quickProgEl.innerHTML = `<span class="badge-tag" style="background:rgba(16,185,129,0.2);color:#34d399;font-weight:600;padding:0.4rem 0.8rem;border-radius:9999px;">✓ You’re caught up</span>`;
      return;
    }

    if (data.nextEpisode) {
      quickProgEl.innerHTML = `
        <button type="button" class="btn btn-sm btn-primary" onclick="window.incrementFromDetailModal(${data.show.id}, this)">
          +1 Episode Watched (Mark S${data.nextEpisode.season} E${data.nextEpisode.episode})
        </button>
      `;
      return;
    }

    quickProgEl.innerHTML = `<span class="badge-tag" style="background:rgba(16,185,129,0.2);color:#34d399;font-weight:600;padding:0.4rem 0.8rem;border-radius:9999px;">✓ You’re caught up</span>`;
  }

  function renderSeasonsAccordion(data) {
    const seasonsListEl = document.getElementById('seasons-list');
    if (!seasonsListEl) return;

    const show = data.show;

    seasonsListEl.innerHTML = data.seasons.map(season => {
      const isExpanded = expandedSeasonsSet.has(season.seasonNumber);
      const statusClass = season.status.toLowerCase().replace(/\s+/g, '-');
      const fillClass = `fill-${statusClass}`;

      let subtitle = `${season.totalEpisodes} episodes`;
      if (season.premiereDate) subtitle = `${season.premiereDate} · ` + subtitle;
      subtitle += ` · ${season.watchedCount} of ${season.releasedEpisodes} watched`;
      if (season.upcomingEpisodes > 0) {
        subtitle += ` (${season.upcomingEpisodes} upcoming)`;
      }

      return `
        <div class="season-card ${isExpanded ? 'expanded' : ''}" id="season-card-${season.seasonNumber}">
          <div class="season-summary-row" onclick="window.toggleSeasonAccordion(${season.seasonNumber})" tabindex="0" role="button" aria-expanded="${isExpanded}">
            ${season.poster 
              ? `<img class="season-poster-img" src="${escapeHtml(season.poster)}" alt="Season ${season.seasonNumber}">` 
              : `<div class="season-poster-fallback">📺</div>`}
            
            <div class="season-info">
              <div class="season-title-row">
                <span class="season-title">Season ${season.seasonNumber}</span>
                <span class="season-badge status-${statusClass}">${season.status}${season.status === 'In progress' ? ` (${season.progressPercent}%)` : ''}</span>
              </div>
              <div class="season-subtitle">${escapeHtml(subtitle)}</div>
              <div class="season-progress-bar-wrap">
                <div class="season-progress-bar-fill ${fillClass}" style="width: ${season.progressPercent}%;"></div>
              </div>
            </div>

            <div class="season-actions">
              ${season.releasedEpisodes > 0 && season.watchedCount < season.releasedEpisodes ? `
                <button type="button" class="btn-mark-season-watched" onclick="event.stopPropagation(); window.confirmMarkSeasonWatched(${show.id}, ${season.seasonNumber}, ${season.releasedEpisodes})" title="Mark all ${season.releasedEpisodes} released episodes in Season ${season.seasonNumber} as watched">
                  👁️ Mark Season Watched
                </button>
              ` : ''}
              <button type="button" class="btn-expand-season" aria-label="Toggle Season ${season.seasonNumber} episodes" aria-expanded="${isExpanded}">
                ▼
              </button>
            </div>
          </div>

          <div class="season-episodes-panel ${isExpanded ? '' : 'hidden'}" id="season-panel-${season.seasonNumber}">
            ${renderEpisodesList(season.episodes, show)}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderEpisodesList(episodes, show) {
    if (!episodes || episodes.length === 0) {
      return '<div style="padding:1rem;color:#94a3b8;font-size:0.85rem;">No regular episodes listed for this season.</div>';
    }

    return episodes.map(ep => {
      let metaStr = `S${String(ep.season).padStart(2, '0')} E${String(ep.number).padStart(2, '0')}`;
      if (ep.airdate) metaStr += ` · ${ep.airdate}`;

      let runtimeBadge = '';
      if (ep.runtime && Number(ep.runtime) > 0) {
        metaStr += ` · ${ep.runtime}m${ep.is_runtime_manual ? ' (manual)' : ''}`;
      } else {
        runtimeBadge = ` <span class="badge-tag badge-runtime-missing" style="cursor:pointer;font-size:0.75rem;padding:2px 6px;border-radius:4px;background:#334155;color:#94a3b8;margin-left:6px;" onclick="window.promptEpisodeManualRuntime(${show.id}, ${ep.season}, ${ep.number})" title="Runtime unknown from TVMaze. Click to enter manual duration.">⏱️ Unknown duration ✏️</span>`;
      }

      return `
        <div class="episode-row" id="episode-row-${ep.season}-${ep.number}">
          <div class="episode-thumb-wrap">
            ${ep.image 
              ? `<img class="episode-thumb-img" src="${escapeHtml(ep.image)}" alt="${escapeHtml(ep.name)}" loading="lazy">` 
              : `<div class="episode-thumb-fallback">🎬</div>`}
          </div>

          <div class="episode-details">
            <div class="episode-title">
              <span>${ep.number}. ${escapeHtml(ep.name)}</span>
              ${ep.rating ? `<span class="episode-rating-badge">★ ${ep.rating}</span>` : ''}
            </div>
            <div class="episode-meta">
              <span>${escapeHtml(metaStr)}</span>${runtimeBadge}
            </div>
            ${ep.summary ? `<div class="episode-summary">${escapeHtml(ep.summary.replace(/<[^>]*>/g, ''))}</div>` : ''}
          </div>

          <div class="episode-action-wrap">
            ${!ep.isReleased ? `
              <button type="button" class="btn-episode-toggle unreleased" disabled title="Not yet released (${ep.airdate || 'TBA'})">
                <span class="badge-tag">Upcoming</span>
              </button>
            ` : ep.isWatched ? `
              <button type="button" class="btn-episode-toggle watched" onclick="window.toggleEpisodeWatchedClick(${show.id}, ${ep.season}, ${ep.number}, this)" aria-pressed="true" aria-label="Mark Season ${ep.season} Episode ${ep.number} unwatched">
                <span class="episode-icon">👁️</span>
                <span>Watched</span>
              </button>
            ` : `
              <button type="button" class="btn-episode-toggle unwatched" onclick="window.toggleEpisodeWatchedClick(${show.id}, ${ep.season}, ${ep.number}, this)" aria-pressed="false" aria-label="Mark Season ${ep.season} Episode ${ep.number} watched">
                <span class="episode-icon">👁️</span>
                <span>Unwatched</span>
              </button>
            `}
          </div>
        </div>
      `;
    }).join('');
  }

  window.promptEpisodeManualRuntime = async function(showId, season, episode) {
    const input = prompt(`Enter duration in minutes for Season ${season}, Episode ${episode}:`, '45');
    if (input === null) return;
    const trimmed = input.trim();
    const rt = Math.round(Number(trimmed));
    if (trimmed === '' || isNaN(rt) || rt <= 0) {
      showToast('Please enter a valid positive number of minutes.', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/media/${showId}/episodes/manual-runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season, episode, runtime: rt })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not save manual runtime');
      }

      showToast(data.message || `Set runtime to ${rt}m`, 'success');
      await refreshAfterDataChange();
      if (currentSeriesDetailId === Number(showId)) {
        window.openSeriesDetailModal(showId);
      }
    } catch (err) {
      showToast('Error setting runtime: ' + err.message, 'error');
    }
  };

  window.toggleSeasonAccordion = function(seasonNum) {
    if (expandedSeasonsSet.has(seasonNum)) {
      expandedSeasonsSet.delete(seasonNum);
    } else {
      expandedSeasonsSet.add(seasonNum);
    }
    const card = document.getElementById(`season-card-${seasonNum}`);
    const panel = document.getElementById(`season-panel-${seasonNum}`);
    const btn = card?.querySelector('.btn-expand-season');
    if (card && panel) {
      const isExpanded = expandedSeasonsSet.has(seasonNum);
      card.classList.toggle('expanded', isExpanded);
      panel.classList.toggle('hidden', !isExpanded);
      btn?.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    }
  };

  let activeEarlierModalContext = null;

  function closeEarlierEpisodesModal() {
    const modal = document.getElementById('modal-confirm-earlier-episodes');
    if (modal) modal.classList.add('hidden');
    if (activeEarlierModalContext?.btnElement) {
      try {
        activeEarlierModalContext.btnElement.focus();
      } catch {}
    }
    activeEarlierModalContext = null;
  }
  window.closeEarlierEpisodesModal = closeEarlierEpisodesModal;

  function openEarlierEpisodesModal(mediaId, season, episode, earlierUnwatched, btnElement, earlierInfo = null) {
    const modal = document.getElementById('modal-confirm-earlier-episodes');
    if (!modal) return;

    activeEarlierModalContext = { mediaId, season, episode, earlierUnwatched, btnElement };

    // Find episode name if available
    let epLabel = `Season ${season}, Episode ${episode}`;
    if (currentSeriesDetailData && currentSeriesDetailData.seasons) {
      const sObj = currentSeriesDetailData.seasons.find(s => s.seasonNumber === season);
      const epObj = sObj?.episodes.find(e => e.number === episode);
      if (epObj?.name) {
        epLabel += ` - ${epObj.name}`;
      }
    }

    const labelEl = document.getElementById('earlier-selected-ep-label');
    if (labelEl) labelEl.textContent = epLabel;

    const count = earlierInfo ? earlierInfo.count : earlierUnwatched.length;
    const countEl = document.getElementById('earlier-unwatched-count');
    if (countEl) countEl.textContent = count;

    const pluralEl = document.getElementById('earlier-unwatched-plural');
    if (pluralEl) pluralEl.textContent = count === 1 ? 'is' : 'are';

    const sEl = document.getElementById('earlier-unwatched-s');
    if (sEl) sEl.textContent = count === 1 ? '' : 's';

    const badgeEl = document.getElementById('earlier-seasons-badge');
    if (badgeEl) {
      const earlierSeasonsIncluded = earlierInfo
        ? earlierInfo.earlierSeasonsIncluded
        : earlierUnwatched.some(ep => (ep.season !== undefined ? ep.season < season : false));

      if (earlierSeasonsIncluded) {
        let breakdown = '';
        if (earlierInfo && Array.isArray(earlierInfo.seasonsBreakdown) && earlierInfo.seasonsBreakdown.length > 0) {
          breakdown = earlierInfo.seasonsBreakdown
            .map(sb => `Season ${sb.season} (${sb.count} episode${sb.count === 1 ? '' : 's'})`)
            .join(', ');
        } else {
          const seasonCounts = new Map();
          for (const ep of earlierUnwatched) {
            seasonCounts.set(ep.season, (seasonCounts.get(ep.season) || 0) + 1);
          }
          breakdown = [...seasonCounts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([sNum, cnt]) => `Season ${sNum} (${cnt} episode${cnt === 1 ? '' : 's'})`)
            .join(', ');
        }
        badgeEl.innerHTML = `⚠️ <strong>Includes earlier seasons:</strong> ${escapeHtml(breakdown)}`;
      } else {
        badgeEl.innerHTML = `ℹ️ <strong>Same season:</strong> All ${count} earlier episode${count === 1 ? '' : 's'} are in Season ${season}.`;
      }
    }

    const dateCheckbox = document.getElementById('earlier-unknown-date-checkbox');
    if (dateCheckbox) dateCheckbox.checked = true;

    modal.classList.remove('hidden');

    const primaryBtn = document.getElementById('btn-mark-earlier-too');
    if (primaryBtn) primaryBtn.focus();
  }

  async function submitEpisodeWatched(mediaId, season, episode, options = {}, btnElement = null) {
    if (btnElement) btnElement.disabled = true;

    try {
      const res = await fetch(`/api/media/${mediaId}/episodes/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          season,
          episode,
          markEarlier: Boolean(options.markEarlier),
          leaveDateUnknown: options.leaveDateUnknown !== undefined ? Boolean(options.leaveDateUnknown) : true
        })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to update episode');
      }

      currentSeriesDetailData = data.showData;
      renderSeasonsAccordion(data.showData);
      renderModalQuickProgress(data.showData);
      await refreshAfterDataChange();
      refreshMediaViews();

      if (options.markEarlier && data.earlierCount > 0) {
        showToast(`Marked S${season} E${episode} and ${data.earlierCount} earlier episodes as watched!`, 'success');
      } else {
        showToast(`Marked S${season} E${episode} as watched!`, 'success');
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      if (btnElement) btnElement.disabled = false;
    }
  }

  window.toggleEpisodeWatchedClick = async function(mediaId, season, episode, btnElement) {
    const wasWatched = btnElement.classList.contains('watched');

    // 1. If currently watched, user is UNMARKING the episode
    // Requirement: "Do not show this dialog when unmarking an episode."
    if (wasWatched) {
      btnElement.classList.toggle('watched', false);
      btnElement.classList.toggle('unwatched', true);
      btnElement.setAttribute('aria-pressed', 'false');
      btnElement.innerHTML = `
        <span class="episode-icon">👁️</span>
        <span>Unwatched</span>
      `;

      try {
        const res = await fetch(`/api/media/${mediaId}/episodes/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ season, episode })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update episode');

        currentSeriesDetailData = data.showData;
        renderModalQuickProgress(data.showData);
        updateSeasonRowStats(season, data.showData);
        await refreshAfterDataChange();
        refreshMediaViews();
      } catch (err) {
        btnElement.classList.toggle('watched', true);
        btnElement.classList.toggle('unwatched', false);
        btnElement.setAttribute('aria-pressed', 'true');
        btnElement.innerHTML = `
          <span class="episode-icon">👁️</span>
          <span>Watched</span>
        `;
        showToast('Error: ' + err.message, 'error');
      }
      return;
    }

    // 2. User is MARKING the episode as watched
    // Check for earlier unwatched regular released episodes in the current viewing cycle
    let earlierInfo = null;
    try {
      btnElement.disabled = true;
      const checkRes = await fetch(`/api/media/${mediaId}/episodes/earlier-unwatched?season=${season}&episode=${episode}`);
      if (checkRes.ok) {
        earlierInfo = await checkRes.json();
      }
    } catch (err) {
      console.warn('Could not query earlier unwatched episodes endpoint:', err);
    } finally {
      btnElement.disabled = false;
    }

    // Fallback to in-memory show data if endpoint was unavailable
    let earlierUnwatched = [];
    if (earlierInfo && Array.isArray(earlierInfo.episodes)) {
      earlierUnwatched = earlierInfo.episodes;
    } else if (currentSeriesDetailData && currentSeriesDetailData.seasons) {
      for (const s of currentSeriesDetailData.seasons) {
        for (const ep of s.episodes) {
          if (ep.isReleased && (ep.season < season || (ep.season === season && ep.number < episode))) {
            if (!ep.isWatched) {
              earlierUnwatched.push(ep);
            }
          }
        }
      }
    }

    const hasEarlier = earlierInfo ? earlierInfo.hasEarlierUnwatched : earlierUnwatched.length > 0;

    // If NO earlier unwatched episodes, mark directly without dialog
    // Requirement: "If all earlier episodes are watched, mark the selected episode normally without a dialog."
    if (!hasEarlier || earlierUnwatched.length === 0) {
      btnElement.classList.toggle('watched', true);
      btnElement.classList.toggle('unwatched', false);
      btnElement.setAttribute('aria-pressed', 'true');
      btnElement.innerHTML = `
        <span class="episode-icon">👁️</span>
        <span>Watched</span>
      `;

      try {
        const res = await fetch(`/api/media/${mediaId}/episodes/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ season, episode })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update episode');

        currentSeriesDetailData = data.showData;
        renderModalQuickProgress(data.showData);
        updateSeasonRowStats(season, data.showData);
        await refreshAfterDataChange();
        refreshMediaViews();
      } catch (err) {
        btnElement.classList.toggle('watched', false);
        btnElement.classList.toggle('unwatched', true);
        btnElement.setAttribute('aria-pressed', 'false');
        btnElement.innerHTML = `
          <span class="episode-icon">👁️</span>
          <span>Unwatched</span>
        `;
        showToast('Error: ' + err.message, 'error');
      }
      return;
    }

    // 3. Earlier unwatched episodes exist: open dialog!
    // Requirement: "Do not mark anything until the user chooses an option."
    openEarlierEpisodesModal(mediaId, season, episode, earlierUnwatched, btnElement, earlierInfo);
  };

  function updateSeasonRowStats(seasonNum, data) {
    const season = data.seasons.find(s => s.seasonNumber === seasonNum);
    if (!season) return;

    const card = document.getElementById(`season-card-${seasonNum}`);
    if (!card) return;

    const statusClass = season.status.toLowerCase().replace(/\s+/g, '-');
    const badge = card.querySelector('.season-badge');
    if (badge) {
      badge.className = `season-badge status-${statusClass}`;
      badge.textContent = `${season.status}${season.status === 'In progress' ? ` (${season.progressPercent}%)` : ''}`;
    }

    const fill = card.querySelector('.season-progress-bar-fill');
    if (fill) {
      fill.className = `season-progress-bar-fill fill-${statusClass}`;
      fill.style.width = `${season.progressPercent}%`;
    }

    const sub = card.querySelector('.season-subtitle');
    if (sub) {
      let subtitle = `${season.totalEpisodes} episodes`;
      if (season.premiereDate) subtitle = `${season.premiereDate} · ` + subtitle;
      subtitle += ` · ${season.watchedCount} of ${season.releasedEpisodes} watched`;
      if (season.upcomingEpisodes > 0) subtitle += ` (${season.upcomingEpisodes} upcoming)`;
      sub.textContent = subtitle;
    }

    const overallStats = document.getElementById('series-overall-stats');
    if (overallStats) {
      overallStats.textContent = `${data.totalWatchedCount} of ${data.totalReleasedCount} released episodes watched`;
    }
  }

  let activeSeasonWatchedModalContext = null;

  function closeSeasonWatchedModal() {
    const modal = document.getElementById('modal-confirm-season-watched');
    if (modal) modal.classList.add('hidden');
    activeSeasonWatchedModalContext = null;
  }
  window.closeSeasonWatchedModal = closeSeasonWatchedModal;

  window.confirmMarkSeasonWatched = async function(mediaId, seasonNumber, releasedCount) {
    let summary = null;
    try {
      const summaryRes = await fetch(`/api/media/${mediaId}/seasons/${seasonNumber}/earlier-summary`);
      if (summaryRes.ok) {
        summary = await summaryRes.json();
      }
    } catch (_) {}

    // Fallback to client-side computation from currentSeriesDetailData if summary endpoint unavailable
    if (!summary) {
      const seasons = currentSeriesDetailData?.seasons || [];
      const curSeasonObj = seasons.find(s => s.seasonNumber === seasonNumber);
      const unwatchedInThisSeason = curSeasonObj 
        ? Math.max(0, curSeasonObj.releasedEpisodes - curSeasonObj.watchedCount)
        : releasedCount;

      const earlierSeasons = [];
      let totalEarlierUnwatched = 0;
      for (const s of seasons) {
        if (s.seasonNumber < seasonNumber) {
          const unwatched = Math.max(0, s.releasedEpisodes - s.watchedCount);
          if (unwatched > 0) {
            earlierSeasons.push({
              seasonNumber: s.seasonNumber,
              unwatchedCount: unwatched,
              releasedEpisodes: s.releasedEpisodes,
              watchedCount: s.watchedCount
            });
            totalEarlierUnwatched += unwatched;
          }
        }
      }
      summary = {
        currentSeason: {
          seasonNumber,
          unwatchedCount: unwatchedInThisSeason,
          releasedEpisodes: curSeasonObj?.releasedEpisodes || releasedCount,
          watchedCount: curSeasonObj?.watchedCount || 0
        },
        earlierSeasons,
        totalEarlierUnwatched,
        hasEarlierUnwatched: totalEarlierUnwatched > 0
      };
    }

    const unwatchedInThisSeason = summary.currentSeason.unwatchedCount;
    const earlierSeasons = summary.earlierSeasons || [];
    const totalEarlier = summary.totalEarlierUnwatched || 0;

    // If no earlier seasons have unwatched released episodes, keep the simple selected-season confirmation
    if (!summary.hasEarlierUnwatched || earlierSeasons.length === 0) {
      const countLabel = unwatchedInThisSeason > 0 ? `${unwatchedInThisSeason} released` : 'all released';
      if (!confirm(`Mark ${countLabel} episode${unwatchedInThisSeason === 1 ? '' : 's'} in Season ${seasonNumber} as watched?`)) {
        return;
      }
      return executeMarkSeasonWatched(mediaId, seasonNumber, false);
    }

    // Earlier seasons contain unwatched released episodes: show confirmation dialog with 3 options
    const modal = document.getElementById('modal-confirm-season-watched');
    const promptEl = document.getElementById('season-watched-prompt');
    const opt1DetailEl = document.getElementById('season-opt1-detail');
    const opt2DetailEl = document.getElementById('season-opt2-detail');
    const btnOnly = document.getElementById('btn-mark-season-only');
    const btnBoth = document.getElementById('btn-mark-season-and-earlier');

    if (!modal) {
      // Fallback if modal missing from DOM
      if (confirm(`Earlier seasons contain ${totalEarlier} unwatched episodes. Mark Season ${seasonNumber} and earlier seasons too? (Click Cancel to mark only Season ${seasonNumber})`)) {
        return executeMarkSeasonWatched(mediaId, seasonNumber, true);
      } else {
        return executeMarkSeasonWatched(mediaId, seasonNumber, false);
      }
    }

    const totalBoth = unwatchedInThisSeason + totalEarlier;
    const earlierBreakdown = earlierSeasons
      .map(s => `Season ${s.seasonNumber} (${s.unwatchedCount} ep${s.unwatchedCount === 1 ? '' : 's'})`)
      .join(', ');

    if (promptEl) {
      promptEl.innerHTML = `Earlier seasons contain <strong style="color:#f59e0b;">${totalEarlier} unwatched released episode${totalEarlier === 1 ? '' : 's'}</strong> (${escapeHtml(earlierBreakdown)}) before Season ${seasonNumber}. How would you like to proceed?`;
    }

    if (opt1DetailEl) {
      opt1DetailEl.innerHTML = `Will mark <strong>${unwatchedInThisSeason} unwatched episode${unwatchedInThisSeason === 1 ? '' : 's'}</strong> in Season ${seasonNumber}. Earlier seasons will remain unwatched.`;
    }

    if (opt2DetailEl) {
      opt2DetailEl.innerHTML = `Will mark <strong>${totalBoth} unwatched episode${totalBoth === 1 ? '' : 's'}</strong> across ${escapeHtml(earlierBreakdown)}, and Season ${seasonNumber} (${unwatchedInThisSeason} ep${unwatchedInThisSeason === 1 ? '' : 's'}).`;
    }

    if (btnOnly) {
      btnOnly.textContent = `Mark only Season ${seasonNumber} (${unwatchedInThisSeason} ep${unwatchedInThisSeason === 1 ? '' : 's'})`;
    }

    if (btnBoth) {
      btnBoth.textContent = `Mark Season ${seasonNumber} and earlier seasons (${totalBoth} eps)`;
    }

    activeSeasonWatchedModalContext = { mediaId, seasonNumber };
    modal.classList.remove('hidden');
    btnBoth?.focus();
  };

  async function executeMarkSeasonWatched(mediaId, seasonNumber, includeEarlier = false) {
    try {
      const res = await fetch(`/api/media/${mediaId}/seasons/${seasonNumber}/mark-watched`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeEarlier })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to mark season watched');

      currentSeriesDetailData = data.showData;
      renderSeasonsAccordion(data.showData);
      renderModalQuickProgress(data.showData);
      loadAllData();
      refreshMediaViews();

      const label = includeEarlier
        ? `Marked Season ${seasonNumber} and earlier seasons (${data.markedCount} episodes) as watched.`
        : `Marked Season ${seasonNumber} (${data.markedCount} episodes) as watched.`;

      showUndoToast(label, async () => {
        try {
          const undoRes = await fetch(`/api/media/${mediaId}/episodes/batch-unmark`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ episodes: data.markedEpisodes })
          });
          const undoData = await undoRes.json();
          if (!undoRes.ok) throw new Error(undoData.error || 'Undo failed');

          showToast(`Reverted watched changes.`, 'info');
          currentSeriesDetailData = undoData.showData;
          renderSeasonsAccordion(undoData.showData);
          renderModalQuickProgress(undoData.showData);
          loadAllData();
          refreshMediaViews();
          hideUndoToast();
        } catch (err) {
          showToast('Undo failed: ' + err.message, 'error');
        }
      });
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  window.incrementFromDetailModal = async function(id, btnElement) {
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.textContent = 'Updating... ⏳';
    }

    try {
      const res = await fetch(`/api/media/${id}/increment-episode`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not increment episode');

      showToast(`📺 Marked S${data.current_season} E${data.current_episode} as watched!`, 'success');
      loadAllData();
      refreshMediaViews();
      openSeriesDetailModal(id);
    } catch (err) {
      showToast(err.message, 'warning');
      if (btnElement) btnElement.disabled = false;
    }
  };

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
      refreshMediaViews();
      if (currentView === 'books') loadBooks();
    } catch (err) {
      showToast('Delete error: ' + err.message, 'error');
    }
  }

  // ===================================================
  // QUICK ACTIONS (+1 Episode, Page Progress)
  // ===================================================
  const pendingIncrements = new Set();

  window.incrementEpisode = async function(id, btnElement) {
    if (pendingIncrements.has(id)) return;
    pendingIncrements.add(id);

    const originalText = btnElement?.textContent;
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.classList.add('btn-loading');
      btnElement.textContent = 'Updating... ⏳';
    }

    try {
      const res = await fetch(`/api/media/${id}/increment-episode`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not increment episode');
      }

      showToast(`📺 Marked S${data.current_season} E${data.current_episode} as watched!`, 'success');
      loadAllData();
      refreshMediaViews();
    } catch (err) {
      showToast(err.message, 'warning');
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.classList.remove('btn-loading');
        btnElement.textContent = originalText;
      }
    } finally {
      pendingIncrements.delete(id);
    }
  };

  async function refreshAfterDataChange() {
    await Promise.all([
      loadDashboard(),
      loadGoals(),
      loadPersonalStatistics(currentStatsPeriod)
    ]);
    if (currentView === 'movies') loadMovies();
    if (currentView === 'series') loadSeries();
    if (currentView === 'books') loadBooks();
  }
  window.refreshAfterDataChange = refreshAfterDataChange;

  window.promptPageProgress = async function(id, currentPage, totalPages) {
    const input = prompt(`Update reading page (currently on page ${currentPage} of ${totalPages || '?'}):`, currentPage + 10);
    if (input === null) return;

    const trimmed = input.trim();
    const pageNum = Number(trimmed);
    if (trimmed === '' || isNaN(pageNum) || !Number.isInteger(pageNum) || pageNum < 0) {
      showToast('Please enter a valid whole number greater than or equal to 0.', 'warning');
      return;
    }

    if (totalPages > 0 && pageNum > totalPages) {
      showToast(`Current page cannot exceed total pages (${totalPages}). Edit book to adjust edition pages if needed.`, 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/books/${id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_page: pageNum })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update page');

      if (data.status === 'completed') {
        showToast(`🎉 Congratulations! You finished reading "${data.title}"!`, 'success');
      } else {
        showToast(`📖 Saved! Now on page ${data.current_page}.`, 'info');
      }

      await refreshAfterDataChange();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  window.markBookCompleted = async function(id) {
    try {
      const res = await fetch(`/api/books/${id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not mark book as completed');

      showToast(`🎉 Marked "${data.title || 'book'}" as completed!`, 'success');
      await refreshAfterDataChange();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  };

  // ===================================================
  // PERSONAL STATISTICS CONTROLLER
  // ===================================================
  let currentStatsPeriod = 'all_time';

  async function loadPersonalStatistics(period = currentStatsPeriod) {
    currentStatsPeriod = period;
    try {
      const res = await fetch(`/api/stats/personal?period=${encodeURIComponent(period)}`);
      if (!res.ok) {
        if (res.status === 401) return;
        throw new Error('Failed to load statistics');
      }
      const data = await res.json();

      // Summary KPIs
      const elMoviesVal = document.getElementById('stat-movies-watched-val');
      const elEpisodesVal = document.getElementById('stat-episodes-watched-val');
      const elSeasonsSub = document.getElementById('stat-seasons-completed-sub');
      const elBooksVal = document.getElementById('stat-books-completed-val');
      const elPagesVal = document.getElementById('stat-pages-read-val');
      const elUnfinishedSub = document.getElementById('stat-unfinished-pages-sub');

      if (elMoviesVal) elMoviesVal.textContent = data.summary?.moviesWatched ?? 0;
      if (elEpisodesVal) elEpisodesVal.textContent = data.summary?.episodesWatched ?? 0;
      if (elSeasonsSub) elSeasonsSub.textContent = `${data.summary?.seasonsCompleted ?? 0} season${data.summary?.seasonsCompleted === 1 ? '' : 's'} completed`;
      if (elBooksVal) elBooksVal.textContent = data.summary?.booksCompleted ?? 0;
      if (elPagesVal) elPagesVal.textContent = Number(data.summary?.totalPagesRead || 0).toLocaleString();
      if (elUnfinishedSub) {
        const unfPages = data.summary?.unfinishedPagesRead || 0;
        if (unfPages > 0) {
          elUnfinishedSub.textContent = `Includes ${unfPages.toLocaleString()} pages in unfinished books`;
        } else {
          elUnfinishedSub.textContent = 'Includes progress in unfinished books';
        }
      }

      // Viewing Time Card
      const elViewingHours = document.getElementById('stat-viewing-total-hours');
      const elViewingDays = document.getElementById('stat-viewing-days-hours');
      const elMovieHours = document.getElementById('stat-movie-hours-val');
      const elMovieDays = document.getElementById('stat-movie-days-sub');
      const elTvHours = document.getElementById('stat-tv-hours-val');
      const elTvDays = document.getElementById('stat-tv-days-sub');

      if (elViewingHours) elViewingHours.textContent = data.viewingTime?.formattedHours || '0 hrs';
      if (elViewingDays) elViewingDays.textContent = data.viewingTime?.formattedDaysAndHours || '0 days, 0 hrs';
      if (elMovieHours) elMovieHours.textContent = data.viewingTime?.movies?.formattedHours || '0 hrs';
      if (elMovieDays) elMovieDays.textContent = data.viewingTime?.movies?.formattedDaysAndHours || '0 days, 0 hrs';
      if (elTvHours) elTvHours.textContent = data.viewingTime?.tv?.formattedHours || '0 hrs';
      if (elTvDays) elTvDays.textContent = data.viewingTime?.tv?.formattedDaysAndHours || '0 days, 0 hrs';

      // Reading Progress Details Card
      const elReadingTotalPages = document.getElementById('stat-reading-total-pages');
      const elReadingBooksCompleted = document.getElementById('stat-reading-books-completed');
      const elReadingFinishedPages = document.getElementById('stat-reading-finished-pages');
      const elReadingFinishedCount = document.getElementById('stat-reading-finished-count');
      const elReadingUnfinishedPages = document.getElementById('stat-reading-unfinished-pages');
      const elReadingUnfinishedCount = document.getElementById('stat-reading-unfinished-count');
      const elReadingMainNums = document.getElementById('stat-reading-main-numbers');
      const elReadingSplitGrid = document.getElementById('stat-reading-split-grid');
      const elReadingEmpty = document.getElementById('stat-reading-empty-state');

      const totalPRead = Number(data.readingProgress?.totalPagesRead ?? data.summary?.totalPagesRead ?? 0);
      const bCompleted = Number(data.readingProgress?.booksCompleted ?? data.summary?.booksCompleted ?? 0);
      const unfPages = Number(data.readingProgress?.unfinishedPagesRead ?? data.summary?.unfinishedPagesRead ?? 0);
      const unfCount = Number(data.readingProgress?.unfinishedBooksCount ?? data.summary?.unfinishedBooksInProgress ?? 0);
      const finPages = Math.max(0, totalPRead - unfPages);

      if (elReadingTotalPages) elReadingTotalPages.textContent = `${totalPRead.toLocaleString()} pages`;
      if (elReadingBooksCompleted) elReadingBooksCompleted.textContent = `${bCompleted} book${bCompleted === 1 ? '' : 's'} completed`;
      if (elReadingFinishedPages) elReadingFinishedPages.textContent = `${finPages.toLocaleString()} pages`;
      if (elReadingFinishedCount) elReadingFinishedCount.textContent = `${bCompleted} book${bCompleted === 1 ? '' : 's'} completed`;
      if (elReadingUnfinishedPages) elReadingUnfinishedPages.textContent = `${unfPages.toLocaleString()} pages`;
      if (elReadingUnfinishedCount) elReadingUnfinishedCount.textContent = `${unfCount} book${unfCount === 1 ? '' : 's'} in progress`;

      const hasAnyReading = totalPRead > 0 || bCompleted > 0 || unfCount > 0;
      if (elReadingEmpty) elReadingEmpty.classList.toggle('hidden', hasAnyReading);
      if (elReadingMainNums) elReadingMainNums.classList.toggle('hidden', !hasAnyReading);
      if (elReadingSplitGrid) elReadingSplitGrid.classList.toggle('hidden', !hasAnyReading);

      // Missing Runtimes Callout
      const elMissingRuntime = document.getElementById('stat-missing-runtime-alert');
      if (elMissingRuntime) {
        if (data.missingMetadata && data.missingMetadata.hasMissingRuntimes) {
          const parts = [];
          if (data.missingMetadata.missingMovieRuntimes > 0) {
            parts.push(`<strong>${data.missingMetadata.missingMovieRuntimes}</strong> watched movie${data.missingMetadata.missingMovieRuntimes > 1 ? 's' : ''}`);
          }
          if (data.missingMetadata.missingEpisodeRuntimes > 0) {
            parts.push(`<strong>${data.missingMetadata.missingEpisodeRuntimes}</strong> watched episode${data.missingMetadata.missingEpisodeRuntimes > 1 ? 's' : ''}`);
          }
          elMissingRuntime.innerHTML = `⚠️ Excluded from estimated viewing time: ${parts.join(' and ')} with missing runtime metadata. MediaVault never invents runtimes.`;
          elMissingRuntime.classList.remove('hidden');
        } else {
          elMissingRuntime.classList.add('hidden');
        }
      }

      // Missing Pages Callout
      const elMissingPages = document.getElementById('stat-missing-pages-alert');
      if (elMissingPages) {
        if (data.missingMetadata && data.missingMetadata.hasMissingPages) {
          const count = data.missingMetadata.missingBookPageCounts;
          elMissingPages.innerHTML = `ℹ️ <strong>${count}</strong> completed book${count > 1 ? 's' : ''} lack page count metadata. They are counted as completed books, but excluded from total pages read until the page count is supplied. You can edit the book to enter your edition's page count.`;
          elMissingPages.classList.remove('hidden');
        } else {
          elMissingPages.classList.add('hidden');
        }
      }

      // Historical Notice
      const elHistBox = document.getElementById('stat-historical-callout');
      const elHistText = document.getElementById('stat-historical-text');
      if (elHistBox && elHistText) {
        if (data.notes && data.notes.historicalData) {
          elHistText.textContent = data.notes.historicalData;
          elHistBox.classList.remove('hidden');
        } else {
          elHistBox.classList.add('hidden');
        }
      }

      // Activity Charts
      if (data.charts) {
        const viewingYearEl = document.getElementById('chart-viewing-year');
        const readingYearEl = document.getElementById('chart-reading-year');
        if (viewingYearEl) viewingYearEl.textContent = data.year || '2026';
        if (readingYearEl) readingYearEl.textContent = data.year || '2026';

        renderActivityChart('chart-viewing-bars', data.charts.viewing || [], 'hrs', 'bar-viewing');
        renderActivityChart('chart-reading-bars', data.charts.reading || [], 'pages', 'bar-reading');
      }

      loadActivityLog();
    } catch (err) {
      console.error('Failed to load personal statistics:', err);
    }
  }

  function renderActivityChart(containerId, items, unit, barClass) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!items || items.length === 0) {
      container.innerHTML = '<div style="color:#64748b; font-size:0.85rem; width:100%; text-align:center; padding-top:2rem;">No activity data available.</div>';
      return;
    }

    const valProp = unit === 'hrs' ? 'hours' : 'pages';
    const maxVal = Math.max(1, ...items.map(i => i[valProp] || 0));

    container.innerHTML = items.map(item => {
      const val = item[valProp] || 0;
      const pct = maxVal > 0 ? Math.max(val > 0 ? 10 : 4, Math.round((val / maxVal) * 100)) : 4;
      const isEmpty = val === 0;

      return `
        <div class="chart-bar-col">
          <div class="chart-bar-fill ${isEmpty ? 'bar-empty' : barClass}" style="height: ${pct}%;">
            <div class="chart-bar-tooltip">${escapeHtml(item.month)}: ${val} ${unit}</div>
          </div>
          <span class="chart-bar-label">${escapeHtml(item.month)}</span>
        </div>
      `;
    }).join('');
  }

  // Bulk sync all series against TVMaze
  async function handleSyncTV() {
    dismissToastMatching('Checking for new episodes');
    const checkingToast = showToast('Checking for new episodes across all your series... ⏳', 'info');

    if (btnSyncTv) btnSyncTv.disabled = true;
    if (btnSyncDash) btnSyncDash.disabled = true;

    try {
      let result;
      try {
        const res = await fetch('/api/media/sync-tv', { method: 'POST' });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Server responded with status ${res.status}`);
        }
        result = await res.json();
      } catch (syncErr) {
        dismissToast(checkingToast);
        dismissToastMatching('Checking for new episodes');
        showToast('Sync failed: ' + syncErr.message, 'error');
        return;
      }

      // Sync succeeded: dismiss the checking toast immediately before showing success
      dismissToast(checkingToast);
      dismissToastMatching('Checking for new episodes');

      const count = result.totalSeries ?? result.updatedCount ?? 0;
      let msg = `✅ Synced! Checked ${count} series.`;
      if (result.newNotifications > 0) {
        msg += ` Found ${result.newNotifications} new episode alert${result.newNotifications > 1 ? 's' : ''}! 🔔`;
      }
      showToast(msg, 'success');

      // Update dashboard, library data, and episode progress
      try {
        await loadAllData();
        refreshMediaViews();
        if (currentSeriesDetailId && modalSeriesDetail && !modalSeriesDetail.classList.contains('hidden')) {
          await openSeriesDetailModal(currentSeriesDetailId);
        }
      } catch (dataErr) {
        console.warn('[Sync] Error refreshing library data:', dataErr);
      }

      // Update notification list and unread badge (isolated error handling)
      try {
        await loadNotifications();
      } catch (notifErr) {
        console.error('[Sync] Notification refresh error:', notifErr);
        showToast('Synced series successfully, but failed to refresh notifications: ' + notifErr.message, 'warning');
      }
    } finally {
      if (btnSyncTv) btnSyncTv.disabled = false;
      if (btnSyncDash) btnSyncDash.disabled = false;
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

  function dismissToast(toastEl) {
    if (!toastEl || !toastEl.parentNode) return;
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateY(12px)';
    toastEl.style.transition = 'all 0.15s ease';
    setTimeout(() => {
      if (toastEl.parentNode) toastEl.remove();
    }, 150);
  }

  function dismissToastMatching(substring) {
    const container = document.getElementById('toast-container');
    if (!container || !substring) return;
    container.querySelectorAll('.toast').forEach(t => {
      if (t.textContent && t.textContent.includes(substring)) {
        dismissToast(t);
      }
    });
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return null;

    // Deduplication: prevent stacking identical notifications
    const existingToasts = Array.from(container.querySelectorAll('.toast'));
    const isDuplicate = existingToasts.some(t => {
      const text = t.textContent || '';
      return text.includes(message);
    });
    if (isDuplicate) return null;

    // Cap maximum active toasts to 3
    if (existingToasts.length >= 3) {
      existingToasts[0].remove();
    }

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
      dismissToast(toast);
    }, 4000);

    return toast;
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
      const btnUserAccount = document.getElementById('btn-user-account');
      if (btnUserAccount) {
        btnUserAccount.title = `${currentUser.username}'s Account`;
        btnUserAccount.setAttribute('aria-label', `${currentUser.username}'s Account`);
      }
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
      if (moviesContainer) moviesContainer.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to view your movies</h4></div>';
      if (seriesContainer) seriesContainer.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to view your series</h4></div>';
      if (mediaContainer) mediaContainer.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to view your movies and series</h4></div>';
      if (booksContainer) booksContainer.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to view your book library</h4></div>';
      if (aiRecommendationsContainer) aiRecommendationsContainer.innerHTML = '<div class="empty-state"><span class="empty-icon">🔒</span><h4>Sign in to get personalized recommendations</h4></div>';
    }
  }

  function setLoginPasswordVisibility(show) {
    const passwordInput = document.getElementById('login-password');
    const toggleBtn = document.getElementById('btn-toggle-login-password');
    if (!passwordInput || !toggleBtn) return;

    const eyeShow = toggleBtn.querySelector('.eye-show');
    const eyeHide = toggleBtn.querySelector('.eye-hide');

    if (show) {
      passwordInput.type = 'text';
      toggleBtn.setAttribute('aria-label', 'Hide password');
      toggleBtn.setAttribute('title', 'Hide password');
      eyeShow?.classList.add('hidden');
      eyeHide?.classList.remove('hidden');
    } else {
      passwordInput.type = 'password';
      toggleBtn.setAttribute('aria-label', 'Show password');
      toggleBtn.setAttribute('title', 'Show password');
      eyeShow?.classList.remove('hidden');
      eyeHide?.classList.add('hidden');
    }
  }

  function openAuthModal(tab = 'login') {
    if (!modalAuth) return;
    modalAuth.classList.remove('hidden');
    if (authAlertBox) {
      authAlertBox.classList.add('hidden');
      authAlertBox.textContent = '';
    }
    setLoginPasswordVisibility(false);
    switchAuthTab(tab);
  }

  function closeAuthModal() {
    if (!modalAuth) return;
    modalAuth.classList.add('hidden');
    if (authAlertBox) {
      authAlertBox.classList.add('hidden');
      authAlertBox.textContent = '';
    }
    setLoginPasswordVisibility(false);
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

    // Toggle Login Password Visibility
    const btnToggleLoginPassword = document.getElementById('btn-toggle-login-password');
    btnToggleLoginPassword?.addEventListener('click', (e) => {
      e.preventDefault();
      const passwordInput = document.getElementById('login-password');
      if (!passwordInput) return;
      const isCurrentlyVisible = passwordInput.type === 'text';
      setLoginPasswordVisibility(!isCurrentlyVisible);
    });

    formLogin?.addEventListener('reset', () => {
      setLoginPasswordVisibility(false);
    });

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
        setLoginPasswordVisibility(false);
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

  // ===================================================
  // INTERACTIVE LIBRARY AI ASSISTANT (Gemini Tool Calling)
  // ===================================================
    const btnToggleAssistant = document.getElementById('btn-toggle-assistant');
    const btnHeaderAssistant = document.getElementById('btn-header-assistant');
    const btnSidebarAssistant = document.getElementById('btn-sidebar-assistant');
    const assistantDrawer = document.getElementById('assistant-drawer');
    const btnCloseAssistant = document.getElementById('btn-close-assistant');
    const assistantMessages = document.getElementById('assistant-messages');
    const assistantForm = document.getElementById('assistant-form');
    const assistantInput = document.getElementById('assistant-input');
    const btnOpenAssistantBanner = document.getElementById('btn-open-assistant-banner');
    const assistantChipBtns = document.querySelectorAll('.assistant-chip-btn');

    let assistantHistory = [];
    let isAssistantLoading = false;

    function toggleAssistantDrawer(forceOpen) {
      if (!assistantDrawer) return;
      const shouldOpen = forceOpen !== undefined ? forceOpen : assistantDrawer.classList.contains('hidden');
      if (shouldOpen) {
        if (!currentUser) {
          showToast('Please sign in to ask the assistant about your private library.', 'warning');
          openAuthModal('login');
          return;
        }
        assistantDrawer.classList.remove('hidden');
        setTimeout(() => assistantInput?.focus(), 150);
      } else {
        assistantDrawer.classList.add('hidden');
      }
    }

    function formatAssistantMarkdown(text) {
      if (!text) return '';
      let html = escapeHtml(text);
      // Bold: **text**
      html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      // Italic: *text*
      html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
      // Bullet points: lines starting with * or -
      html = html.replace(/^\s*[\*\-]\s+(.*)$/gm, '<li>$1</li>');
      // Group adjacent <li> into <ul>
      html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
      // Newlines to <br> or <p>
      html = html.replace(/\n\n+/g, '</p><p>');
      html = html.replace(/\n/g, '<br>');
      return `<p>${html}</p>`;
    }

    function appendAssistantMessage(role, text, facts = []) {
      if (!assistantMessages) return;

      const msgEl = document.createElement('div');
      msgEl.className = `assistant-msg ${role === 'user' ? 'msg-user' : 'msg-ai'}`;

      const avatar = role === 'user' ? '👤' : '✨';
      let bodyContent = '';

      if (role === 'user') {
        bodyContent = `<p>${escapeHtml(text)}</p>`;
      } else {
        let factsHtml = '';
        if (facts && facts.length > 0) {
          const factChips = facts.map(f => {
            if (f.type === 'book') {
              return `
                <div class="fact-chip">
                  <div class="fact-chip-title">📖 ${escapeHtml(f.title)}</div>
                  <div class="fact-chip-meta">
                    <span>by ${escapeHtml(f.author || 'Unknown')}</span>
                    ${f.page_count ? `<span>• ${f.page_count} pages</span>` : ''}
                    <span class="fact-tag ${f.owned ? 'owned' : ''}">${f.owned ? '🏠 Owned' : 'Not owned'}</span>
                    <span class="fact-tag">${escapeHtml(formatBookStatus(f.status || 'unread'))}</span>
                    ${f.rating ? `<span>• ${renderStars(f.rating)}</span>` : ''}
                  </div>
                </div>
              `;
            } else {
              const isTV = f.type === 'tv';
              return `
                <div class="fact-chip">
                  <div class="fact-chip-title">${isTV ? '📺' : '🎬'} ${escapeHtml(f.title)}</div>
                  <div class="fact-chip-meta">
                    <span>${escapeHtml(f.genre || (isTV ? 'Series' : 'Movie'))}</span>
                    ${f.release_year ? `<span>• (${f.release_year})</span>` : ''}
                    <span class="fact-tag">${escapeHtml(formatStatus(f.status || 'watching'))}</span>
                    ${isTV && f.current_season ? `<span>• S${f.current_season}E${f.current_episode}</span>` : ''}
                    ${f.rating ? `<span>• ${renderStars(f.rating)}</span>` : ''}
                  </div>
                </div>
              `;
            }
          }).join('');

          factsHtml = `
            <div class="assistant-facts-box">
              <div class="facts-header">
                <span class="facts-badge">🛡️ Verified Library Records (${facts.length})</span>
                <span class="facts-sub">Retrieved from your SQLite database</span>
              </div>
              <div class="facts-grid">
                ${factChips}
              </div>
            </div>
          `;
        }

        bodyContent = `${factsHtml}${formatAssistantMarkdown(text)}`;
      }

      msgEl.innerHTML = `
        <div class="msg-avatar">${avatar}</div>
        <div class="msg-body">${bodyContent}</div>
      `;

      assistantMessages.appendChild(msgEl);
      assistantMessages.scrollTop = assistantMessages.scrollHeight;
    }

    function showAssistantTyping() {
      const typingEl = document.createElement('div');
      typingEl.id = 'assistant-typing-indicator';
      typingEl.className = 'assistant-msg msg-ai';
      typingEl.innerHTML = `
        <div class="msg-avatar">✨</div>
        <div class="msg-body">
          <div class="typing-indicator">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <span style="font-size:0.75rem; color:#94a3b8; margin-left:0.5rem;">Checking your library records...</span>
          </div>
        </div>
      `;
      assistantMessages.appendChild(typingEl);
      assistantMessages.scrollTop = assistantMessages.scrollHeight;
    }

    function removeAssistantTyping() {
      const el = document.getElementById('assistant-typing-indicator');
      if (el) el.remove();
    }

    async function handleAssistantQuery(query) {
      if (!query || !query.trim() || isAssistantLoading) return;
      const cleanQuery = query.trim();

      if (!currentUser) {
        showToast('Please sign in to use the library assistant.', 'warning');
        openAuthModal('login');
        return;
      }

      appendAssistantMessage('user', cleanQuery);
      if (assistantInput) assistantInput.value = '';
      isAssistantLoading = true;
      showAssistantTyping();

      const submitBtn = document.getElementById('btn-assistant-send');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await fetch('/api/ai/assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: cleanQuery,
            history: assistantHistory.slice(-6)
          })
        });

        removeAssistantTyping();

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to query assistant');
        }

        const data = await res.json();
        appendAssistantMessage('assistant', data.answer, data.facts || []);

        assistantHistory.push({ role: 'user', text: cleanQuery });
        assistantHistory.push({ role: 'assistant', text: data.answer });
      } catch (err) {
        removeAssistantTyping();
        appendAssistantMessage('assistant', `⚠️ Sorry, I could not complete your request: ${err.message}`);
      } finally {
        isAssistantLoading = false;
        if (submitBtn) submitBtn.disabled = false;
        setTimeout(() => assistantInput?.focus(), 100);
      }
    }

    // Event Listeners for Assistant
    btnToggleAssistant?.addEventListener('click', () => toggleAssistantDrawer());
    btnHeaderAssistant?.addEventListener('click', () => toggleAssistantDrawer(true));
    btnSidebarAssistant?.addEventListener('click', () => {
      const navCollapseMenu = document.getElementById('nav-collapse-menu');
      if (navCollapseMenu?.classList.contains('is-open')) {
        const btnNavToggle = document.getElementById('btn-nav-toggle');
        const navBackdrop = document.getElementById('nav-backdrop');
        navCollapseMenu.classList.remove('is-open');
        btnNavToggle?.classList.remove('is-active');
        btnNavToggle?.setAttribute('aria-expanded', 'false');
        navCollapseMenu.setAttribute('aria-hidden', 'true');
        navBackdrop?.classList.remove('is-active');
        document.body.style.overflow = '';
      }
      toggleAssistantDrawer(true);
    });
    btnCloseAssistant?.addEventListener('click', () => toggleAssistantDrawer(false));
    btnOpenAssistantBanner?.addEventListener('click', () => toggleAssistantDrawer(true));
    window.toggleAssistantDrawer = toggleAssistantDrawer;

    assistantChipBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const prompt = btn.getAttribute('data-prompt');
        if (prompt) {
          toggleAssistantDrawer(true);
          handleAssistantQuery(prompt);
        }
      });
    });

    assistantForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      handleAssistantQuery(assistantInput?.value || '');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && assistantDrawer && !assistantDrawer.classList.contains('hidden')) {
        e.preventDefault();
        toggleAssistantDrawer(false);
        (btnHeaderAssistant || btnSidebarAssistant || btnToggleAssistant)?.focus();
      }
    });

    // ===================================================
    // IN-APP NOTIFICATIONS & EPISODE MONITORING CLIENT
    // ===================================================
    const btnToggleNotifications = document.getElementById('btn-toggle-notifications');
    const badgeNotificationsCount = document.getElementById('badge-notifications-count');
    const notificationsFlyout = document.getElementById('notifications-flyout');
    const notifUnreadTag = document.getElementById('notif-unread-tag');
    const btnMarkAllRead = document.getElementById('btn-mark-all-read');
    const notificationsList = document.getElementById('notifications-list');
    const navNotificationWrapper = document.getElementById('nav-notification-wrapper');

    async function loadNotifications() {
      if (!currentUser) {
        if (badgeNotificationsCount) badgeNotificationsCount.classList.add('hidden');
        if (notificationsFlyout) notificationsFlyout.classList.add('hidden');
        return { unreadCount: 0, notifications: [] };
      }

      try {
        const res = await fetch('/api/notifications');
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Failed to fetch notifications (${res.status})`);
        }
        const data = await res.json();

        const unreadCount = data.unreadCount || 0;
        if (badgeNotificationsCount) {
          if (unreadCount > 0) {
            badgeNotificationsCount.textContent = unreadCount > 99 ? '99+' : unreadCount;
            badgeNotificationsCount.classList.remove('hidden');
          } else {
            badgeNotificationsCount.classList.add('hidden');
          }
        }

        if (notifUnreadTag) {
          notifUnreadTag.textContent = `${unreadCount} unread`;
        }

        renderNotificationsList(data.notifications || []);
        return data;
      } catch (err) {
        console.error('Failed to load notifications:', err);
        throw err;
      }
    }

    window.loadNotifications = loadNotifications;

    function renderNotificationsList(notifications) {
      if (!notificationsList) return;

      if (!notifications || notifications.length === 0) {
        notificationsList.innerHTML = '<div class="notif-empty">No episode alerts recorded yet.</div>';
        return;
      }

      notificationsList.innerHTML = notifications.map(n => {
        const isUnread = !n.is_read;
        const dateStr = n.air_date ? `Aired: ${n.air_date}` : (n.created_at ? n.created_at.slice(0, 16) : '');

        return `
          <div class="notif-item ${isUnread ? 'unread' : ''}" data-id="${n.id}" ${n.media_id ? `onclick="window.openSeriesDetailModal(${n.media_id}, ${n.season || 'null'})" style="cursor:pointer;" title="Click to view series"` : ''}>
            <div class="notif-item-content">
              <div class="notif-item-title">
                <span>📺</span> <span>${escapeHtml(n.title)}</span>
              </div>
              <div class="notif-item-msg">${escapeHtml(n.message)}</div>
              ${dateStr ? `<div class="notif-item-time">📅 ${escapeHtml(dateStr)}</div>` : ''}
            </div>
            ${isUnread ? `
              <button class="btn-notif-action" onclick="event.stopPropagation(); window.markNotifRead(${n.id})" title="Mark as read">✓</button>
            ` : `
              <button class="btn-notif-action" onclick="event.stopPropagation(); window.deleteNotif(${n.id})" title="Dismiss notification" style="font-size:0.85rem;">&times;</button>
            `}
          </div>
        `;
      }).join('');
    }

    window.markNotifRead = async function(id) {
      try {
        const res = await fetch(`/api/notifications/${id}/read`, { method: 'PATCH' });
        if (!res.ok) throw new Error('Could not mark notification as read');
        loadNotifications().catch(() => {});
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    window.deleteNotif = async function(id) {
      try {
        const res = await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Could not delete notification');
        loadNotifications().catch(() => {});
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    btnMarkAllRead?.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/notifications/read-all', { method: 'POST' });
        if (!res.ok) throw new Error('Could not mark all as read');
        showToast('All notifications marked as read.', 'success');
        loadNotifications().catch(() => {});
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    btnToggleNotifications?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentUser) {
        showToast('Please sign in to view episode notifications.', 'warning');
        openAuthModal('login');
        return;
      }
      const isHidden = notificationsFlyout?.classList.contains('hidden');
      if (isHidden) {
        notificationsFlyout?.classList.remove('hidden');
        loadNotifications().catch(err => showToast('Could not load notifications: ' + err.message, 'error'));
      } else {
        notificationsFlyout?.classList.add('hidden');
      }
    });

    // Close flyout when clicking outside
    document.addEventListener('click', (e) => {
      if (navNotificationWrapper && !navNotificationWrapper.contains(e.target)) {
        notificationsFlyout?.classList.add('hidden');
      }
    });

    // Periodic check for notifications every 60 seconds
    setInterval(() => {
      loadNotifications().catch(() => {});
    }, 60 * 1000);

  // ===================================================
  // DISCOVER TV SHOWS CONTROLLER
  // ===================================================
  const currentDiscoverShowsMap = new Map();
  let isDiscoverLoading = false;

  async function loadDiscover(forceRefresh = false) {
    if (isDiscoverLoading) return;
    isDiscoverLoading = true;

    const btnRefresh = document.getElementById('btn-refresh-discover');
    const lastUpdatedTag = document.getElementById('discover-last-updated');
    const unconfiguredBanner = document.getElementById('discover-unconfigured-banner');
    const cacheNotice = document.getElementById('discover-cache-notice');
    const rowsContainer = document.getElementById('discover-rows-container');

    if (btnRefresh) {
      btnRefresh.disabled = true;
      btnRefresh.innerHTML = '<span class="btn-icon">⏳</span> <span>Refreshing...</span>';
    }

    try {
      const res = await fetch(`/api/discover/tv?refresh=${forceRefresh ? '1' : '0'}`);
      if (!res.ok) {
        if (res.status === 401) return;
        throw new Error('Could not load discovery lists');
      }
      const data = await res.json();

      if (!data.configured) {
        unconfiguredBanner?.classList.remove('hidden');
        cacheNotice?.classList.add('hidden');
        if (rowsContainer) rowsContainer.style.display = 'none';
        if (lastUpdatedTag) lastUpdatedTag.textContent = 'API Key Required';
        return;
      }

      unconfiguredBanner?.classList.add('hidden');
      if (rowsContainer) rowsContainer.style.display = 'block';

      if (data.isOutdated) {
        cacheNotice?.classList.remove('hidden');
      } else {
        cacheNotice?.classList.add('hidden');
      }

      if (lastUpdatedTag && data.lastUpdated) {
        const timeStr = new Date(data.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        lastUpdatedTag.textContent = `Last updated: ${timeStr}`;
      }

      // Populate local show lookup
      const cats = data.categories || {};
      ['popular', 'trending', 'airing', 'upcoming'].forEach(cat => {
        (cats[cat] || []).forEach(show => {
          currentDiscoverShowsMap.set(show.id, show);
        });
      });

      renderDiscoverRow('discover-row-popular', cats.popular || []);
      renderDiscoverRow('discover-row-trending', cats.trending || []);
      renderDiscoverRow('discover-row-airing', cats.airing || []);
      renderDiscoverRow('discover-row-upcoming', cats.upcoming || []);

    } catch (err) {
      console.error('Failed to load discover page:', err);
      showToast('Could not load discovery shows: ' + err.message, 'error');
    } finally {
      isDiscoverLoading = false;
      if (btnRefresh) {
        btnRefresh.disabled = false;
        btnRefresh.innerHTML = '<span class="btn-icon">🔄</span> <span>Refresh</span>';
      }
    }
  }

  function renderDiscoverRow(containerId, shows) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!shows || shows.length === 0) {
      container.innerHTML = '<div class="discover-loading-skeleton">No shows available in this category right now.</div>';
      return;
    }

    container.innerHTML = shows.map(show => {
      const year = show.release_year || (show.first_air_date ? new Date(show.first_air_date).getFullYear() : 'TBA');
      const ratingTag = show.rating ? `<span class="discover-rating-badge">⭐ ${show.rating}</span>` : '';
      const posterContent = show.poster_url
        ? `<img class="discover-poster-img" src="${escapeHtml(show.poster_url)}" alt="${escapeHtml(show.title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'discover-poster-fallback\\'>📺<span class=\\'discover-poster-fallback-text\\'>${escapeHtml(show.title)}</span></div>'">`
        : `<div class="discover-poster-fallback">📺<span class="discover-poster-fallback-text">${escapeHtml(show.title)}</span></div>`;

      const actionBtn = show.inLibrary
        ? `<div class="badge-in-library">✓ In your library</div>`
        : `<button type="button" class="btn-discover-add" id="btn-add-discover-${show.id}" onclick="window.handleDiscoverAdd(${show.id})">➕ Add to Library</button>`;

      return `
        <div class="discover-card" data-show-id="${show.id}">
          <div class="discover-poster-thumb">
            ${posterContent}
            ${ratingTag}
          </div>
          <div class="discover-card-info">
            <div>
              <h4 class="discover-card-title" title="${escapeHtml(show.title)}">${escapeHtml(show.title)}</h4>
              <div class="discover-card-meta">
                <span>${escapeHtml(String(year))}</span>
              </div>
            </div>
            <div class="discover-card-actions">
              <button type="button" class="btn-discover-details" onclick="window.openDiscoverDetailModal(${show.id})">Details</button>
              <div id="discover-card-action-wrap-${show.id}">
                ${actionBtn}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Open Show Details Modal
  window.openDiscoverDetailModal = function(id) {
    const show = currentDiscoverShowsMap.get(id);
    if (!show) return;

    const modal = document.getElementById('modal-discover-detail');
    const nameEl = document.getElementById('discover-modal-show-name');
    const metaRow = document.getElementById('discover-modal-meta-row');
    const genresEl = document.getElementById('discover-modal-genres');
    const overviewEl = document.getElementById('discover-modal-overview');
    const actionsEl = document.getElementById('discover-modal-actions');
    const posterWrap = document.getElementById('discover-detail-poster-wrap');

    if (nameEl) nameEl.textContent = show.title;

    const year = show.release_year || (show.first_air_date ? new Date(show.first_air_date).getFullYear() : 'TBA');
    if (metaRow) {
      metaRow.innerHTML = `
        <span>📅 ${escapeHtml(String(year))}</span>
        ${show.rating ? `<span>⭐ ${show.rating} / 10</span>` : ''}
        ${show.vote_count ? `<span>(${show.vote_count.toLocaleString()} votes)</span>` : ''}
      `;
    }

    if (genresEl) {
      genresEl.innerHTML = (show.genres || []).map(g => `<span class="genre-tag">${escapeHtml(g.name || g)}</span>`).join('');
    }

    if (overviewEl) {
      overviewEl.textContent = show.overview || 'No synopsis provided for this series.';
    }

    if (posterWrap) {
      posterWrap.innerHTML = show.poster_url
        ? `<img src="${escapeHtml(show.poster_url)}" alt="${escapeHtml(show.title)}">`
        : `<div class="discover-poster-fallback">📺</div>`;
    }

    if (actionsEl) {
      actionsEl.innerHTML = show.inLibrary
        ? `<div class="badge-in-library" style="padding:0.6rem 1.25rem;">✓ In your library</div>`
        : `<button type="button" class="btn btn-primary" id="btn-discover-modal-add" onclick="window.handleDiscoverAdd(${show.id})">➕ Add to Library</button>`;
    }

    modal?.classList.remove('hidden');
  };

  // Add Show from Discover to Library
  window.handleDiscoverAdd = async function(id) {
    const show = currentDiscoverShowsMap.get(id);
    if (!show) return;

    const addBtn = document.getElementById(`btn-add-discover-${id}`);
    const modalAddBtn = document.getElementById('btn-discover-modal-add');

    if (addBtn) {
      addBtn.disabled = true;
      addBtn.classList.add('btn-loading');
      addBtn.textContent = 'Adding... ⏳';
    }
    if (modalAddBtn) {
      modalAddBtn.disabled = true;
      modalAddBtn.textContent = 'Adding... ⏳';
    }

    try {
      const res = await fetch('/api/discover/add-to-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add show');

      // Update state: show is now in library
      show.inLibrary = true;

      // Update UI on cards
      const cardActionWrap = document.getElementById(`discover-card-action-wrap-${id}`);
      if (cardActionWrap) {
        cardActionWrap.innerHTML = `<div class="badge-in-library">✓ In your library</div>`;
      }

      // Update UI in modal
      const modalActionsEl = document.getElementById('discover-modal-actions');
      if (modalActionsEl) {
        modalActionsEl.innerHTML = `<div class="badge-in-library" style="padding:0.6rem 1.25rem;">✓ In your library</div>`;
      }

      showToast(`🎉 "${show.title}" added to your library!`, 'success');
      loadAllData();
      refreshMediaViews();
    } catch (err) {
      showToast('Error adding show: ' + err.message, 'error');
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.classList.remove('btn-loading');
        addBtn.textContent = '➕ Add to Library';
      }
      if (modalAddBtn) {
        modalAddBtn.disabled = false;
        modalAddBtn.textContent = '➕ Add to Library';
      }
    }
  };

  // Wire up discover controls
  document.getElementById('btn-refresh-discover')?.addEventListener('click', () => loadDiscover(true));
  document.getElementById('btn-close-discover-modal')?.addEventListener('click', () => {
    document.getElementById('modal-discover-detail')?.classList.add('hidden');
  });

  // Modal outside click to close
  document.getElementById('modal-discover-detail')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-discover-detail') {
      e.target.classList.add('hidden');
    }
  });

  // Horizontal scroll arrows for poster rows
  document.querySelectorAll('.scroll-arrow').forEach(arrow => {
    arrow.addEventListener('click', () => {
      const targetId = arrow.dataset.target;
      const row = document.getElementById(targetId);
      if (!row) return;
      const scrollAmount = arrow.classList.contains('scroll-arrow-left') ? -360 : 360;
      row.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    });
  });

  // ===================================================
  // REPEAT VIEWING & REREADING CYCLES
  // ===================================================
  const repeatCyclesInFlight = new Set();

  window.startRepeatCycle = async function(itemType, itemId, btnElement = null) {
    if (!currentUser) {
      showToast('Please sign in to track repeat cycles.', 'warning');
      return;
    }
    const key = `${itemType}-${itemId}`;
    if (repeatCyclesInFlight.has(key)) {
      return;
    }

    const typeLabel = itemType === 'book' ? 'reread' : 'rewatch';

    try {
      repeatCyclesInFlight.add(key);
      if (btnElement && btnElement.disabled !== undefined) {
        btnElement.disabled = true;
      }

      // Check if an unfinished cycle already exists
      try {
        const checkRes = await fetch(`/api/cycles/${itemType}/${itemId}`);
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          const activeCycle = (checkData.cycles || []).find(c => c.status === 'in_progress');
          if (activeCycle) {
            const shouldResume = confirm(
              `An unfinished ${typeLabel} (Cycle ${activeCycle.cycle_number}) is already in progress.\n\nWould you like to resume it instead of starting another?`
            );
            if (shouldResume) {
              showToast(`Resumed ${typeLabel} Cycle ${activeCycle.cycle_number}.`, 'info');
              if (itemType === 'tv' && typeof window.openSeriesDetailModal === 'function') {
                window.openSeriesDetailModal(itemId);
              }
              await refreshAfterDataChange();
              refreshMediaViews();
              return;
            } else {
              return;
            }
          }
        }
      } catch (err) {
        console.warn('Could not check existing cycles beforehand:', err);
      }

      // Ask for confirmation before starting a new cycle
      const confirmed = confirm(
        `Are you sure you want to start a new ${typeLabel} cycle?\n\nYour previous progress, completion dates, and activity history will be safely preserved.`
      );
      if (!confirmed) {
        return;
      }

      const res = await fetch('/api/cycles/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemType, itemId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to start ${typeLabel}`);

      if (data.alreadyActive) {
        showToast(`Resumed existing ${typeLabel} Cycle ${data.cycleNumber}.`, 'info');
      } else {
        showToast(`🎉 Started ${typeLabel} Cycle ${data.cycleNumber}!`, 'success');
      }

      await refreshAfterDataChange();
      refreshMediaViews();
      if (itemType === 'tv' && typeof window.openSeriesDetailModal === 'function') {
        window.openSeriesDetailModal(itemId);
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      repeatCyclesInFlight.delete(key);
      if (btnElement && btnElement.disabled !== undefined) {
        btnElement.disabled = false;
      }
    }
  };

  window.completeRepeatCycle = async function(itemType, itemId, btnElement = null) {
    if (!currentUser) return;
    const typeLabel = itemType === 'book' ? 'reread' : 'rewatch';
    if (!confirm(`Are you sure you want to mark this ${typeLabel} cycle as completed?`)) {
      return;
    }
    const key = `complete-${itemType}-${itemId}`;
    if (repeatCyclesInFlight.has(key)) return;

    try {
      repeatCyclesInFlight.add(key);
      if (btnElement && btnElement.disabled !== undefined) {
        btnElement.disabled = true;
      }

      const res = await fetch('/api/cycles/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemType, itemId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to complete cycle');

      showToast(`🎉 Completed ${typeLabel}!`, 'success');
      await refreshAfterDataChange();
      refreshMediaViews();
      if (itemType === 'tv' && typeof window.openSeriesDetailModal === 'function') {
        window.openSeriesDetailModal(itemId);
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      repeatCyclesInFlight.delete(key);
      if (btnElement && btnElement.disabled !== undefined) {
        btnElement.disabled = false;
      }
    }
  };

  // ===================================================
  // PERSONAL GOALS CONTROLLER
  // ===================================================
  let userGoalsCache = [];

  async function loadGoals() {
    const grid = document.getElementById('goals-cards-grid');
    if (!grid) return;

    if (!currentUser) {
      grid.innerHTML = `
        <div class="goals-empty-state">
          <span class="empty-icon">🔒</span>
          <h3>Private Goals</h3>
          <p>Please sign in to view and set your personal reading and watching goals.</p>
          <button type="button" class="btn btn-primary" onclick="window.openAuthModal('login')">Sign In</button>
        </div>
      `;
      return;
    }

    try {
      const res = await fetch('/api/goals');
      if (!res.ok) throw new Error('Failed to load goals');
      const data = await res.json();
      userGoalsCache = data.goals || [];

      renderGoalsGrid(userGoalsCache);
      populatePlannerGoalSelect(userGoalsCache);
    } catch (err) {
      grid.innerHTML = `<div class="empty-state">Error loading goals: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderGoalsGrid(goals) {
    const grid = document.getElementById('goals-cards-grid');
    if (!grid) return;

    if (!goals || goals.length === 0) {
      grid.innerHTML = `
        <div class="goals-empty-state">
          <span class="empty-icon">🎯</span>
          <h3>No Active Goals Set</h3>
          <p>Define a yearly book target or a monthly reading/movie goal to track your personal entertainment journey.</p>
          <button type="button" class="btn btn-primary" id="btn-empty-create-goal" onclick="window.openGoalModal()">Set Your First Goal</button>
        </div>
      `;
      return;
    }

    grid.innerHTML = goals.map(goal => {
      const isBook = goal.goalType.includes('book');
      const isPages = goal.goalType.includes('pages');
      const icon = isBook ? '📚' : (isPages ? '📖' : '🎬');
      const badgeClass = goal.isOnTrack ? 'goal-badge-ontrack' : 'goal-badge-behind';
      const statusText = goal.isOnTrack ? 'On Track' : 'Behind Pace';

      return `
        <div class="goal-card" id="goal-card-${goal.id}">
          <div class="goal-card-header">
            <div class="goal-card-title-group">
              <span class="goal-type-icon">${icon}</span>
              <div class="goal-title-text">
                <h3>${escapeHtml(goal.title)}</h3>
                <span class="goal-timeframe-sub">${escapeHtml(goal.timeframe)}</span>
              </div>
            </div>
            <span class="goal-status-badge ${badgeClass}">${statusText}</span>
          </div>

          <div class="goal-progress-section">
            <div class="goal-progress-numbers">
              <span class="goal-current-target">${escapeHtml(goal.progressText)}</span>
              <span class="goal-percent-text">${goal.percentCompleted}%</span>
            </div>
            <div class="goal-progress-bar">
              <div class="goal-progress-fill" style="width: ${goal.percentCompleted}%;"></div>
            </div>
            <div class="goal-meta-info">
              <span>${escapeHtml(goal.timeRemainingText)}</span>
              <span>Pace: ${goal.current} of ${goal.target}</span>
            </div>
          </div>

          <div class="goal-footer-actions">
            <label class="goal-repeat-label" title="Toggle counting repeat viewings/rereads">
              <input type="checkbox" ${goal.includeRepeats ? 'checked' : ''} onchange="window.handleToggleGoalRepeats(${goal.id}, this.checked)">
              <span>Count repeats</span>
            </label>
            <div class="goal-btn-group">
              <button type="button" class="btn-icon-action" onclick="window.openGoalModal(${goal.id})" title="Edit Target">✏️ Edit</button>
              <button type="button" class="btn-icon-action danger" onclick="window.handleDeleteGoal(${goal.id})" title="Delete Goal">🗑️</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function populatePlannerGoalSelect(goals) {
    const sel = document.getElementById('planner-goal-select');
    if (!sel) return;
    const curVal = sel.value;
    sel.innerHTML = '<option value="">No goal focus (Balanced)</option>' +
      goals.map(g => `<option value="${g.id}" ${String(g.id) === String(curVal) ? 'selected' : ''}>${escapeHtml(g.title)} (${g.progressText})</option>`).join('');
  }

  window.openGoalModal = function(goalId = null) {
    const modal = document.getElementById('modal-goal');
    const form = document.getElementById('form-goal');
    const idInput = document.getElementById('goal-id');
    const titleEl = document.getElementById('modal-goal-title');
    const typeSelect = document.getElementById('goal-type-select');
    const targetInput = document.getElementById('goal-target-input');
    const yearInput = document.getElementById('goal-year-input');
    const monthSelect = document.getElementById('goal-month-select');
    const monthGroup = document.getElementById('goal-month-group');
    const repeatsCheck = document.getElementById('goal-include-repeats');
    const typeRow = document.getElementById('goal-type-row');
    const hintEl = document.getElementById('goal-target-hint');

    if (!modal) return;
    form.reset();

    const now = new Date();
    yearInput.value = now.getFullYear();
    monthSelect.value = now.getMonth() + 1;

    if (goalId) {
      const existing = userGoalsCache.find(g => g.id === goalId);
      if (!existing) return;

      idInput.value = existing.id;
      titleEl.textContent = 'Edit Personal Goal';
      typeSelect.value = existing.goalType;
      targetInput.value = existing.target;
      yearInput.value = existing.year;
      if (existing.month) monthSelect.value = existing.month;
      repeatsCheck.checked = Boolean(existing.includeRepeats);
      if (typeRow) typeRow.style.display = 'none';
    } else {
      idInput.value = '';
      titleEl.textContent = 'Set Personal Goal';
      if (typeRow) typeRow.style.display = 'block';
      repeatsCheck.checked = true;
    }

    const updateHints = () => {
      const t = typeSelect.value;
      if (t === 'books_yearly') {
        if (monthGroup) monthGroup.style.display = 'none';
        if (hintEl) hintEl.textContent = 'Target number of books to complete this year.';
      } else if (t === 'pages_monthly') {
        if (monthGroup) monthGroup.style.display = 'block';
        if (hintEl) hintEl.textContent = 'Target number of pages to read this month.';
      } else {
        if (monthGroup) monthGroup.style.display = 'block';
        if (hintEl) hintEl.textContent = 'Target number of movies to watch this month.';
      }
    };
    updateHints();
    typeSelect.onchange = updateHints;

    modal.classList.remove('hidden');
  };

  async function handleSaveGoal(e) {
    e.preventDefault();
    const id = document.getElementById('goal-id').value;
    const goalType = document.getElementById('goal-type-select').value;
    const target = parseInt(document.getElementById('goal-target-input').value, 10);
    const year = parseInt(document.getElementById('goal-year-input').value, 10);
    const month = goalType === 'books_yearly' ? null : parseInt(document.getElementById('goal-month-select').value, 10);
    const includeRepeats = document.getElementById('goal-include-repeats').checked ? 1 : 0;

    if (isNaN(target) || target <= 0) {
      showToast('Please enter a valid positive whole target.', 'warning');
      return;
    }

    try {
      if (id) {
        // Update existing goal
        const res = await fetch(`/api/goals/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, includeRepeats })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update goal');
        showToast('Goal updated successfully!', 'success');
      } else {
        // Create new goal
        const res = await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goalType, target, year, month, includeRepeats })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create goal');
        showToast('Personal goal created!', 'success');
      }

      document.getElementById('modal-goal')?.classList.add('hidden');
      loadGoals();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  window.handleToggleGoalRepeats = async function(goalId, includeRepeats) {
    try {
      const res = await fetch(`/api/goals/${goalId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeRepeats: includeRepeats ? 1 : 0 })
      });
      if (!res.ok) throw new Error('Failed to update repeat setting');
      loadGoals();
    } catch (err) {
      showToast(err.message, 'error');
      loadGoals();
    }
  };

  window.handleDeleteGoal = async function(goalId) {
    if (!confirm('Are you sure you want to delete this personal goal?')) return;
    try {
      const res = await fetch(`/api/goals/${goalId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete goal');
      showToast('Goal deleted.', 'info');
      loadGoals();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ===================================================
  // AI WEEKLY PLANNER CONTROLLER
  // ===================================================
  let currentGeneratedPlan = null;
  let savedPlansCache = [];
  window.savedPlansCache = savedPlansCache;
  let isGeneratingPlan = false;
  let isSavingPlan = false;

  function setPlannerError(message) {
    const alertEl = document.getElementById('planner-error-alert');
    if (!alertEl) return;
    if (!message) {
      alertEl.classList.add('hidden');
      alertEl.innerHTML = '';
      return;
    }
    alertEl.innerHTML = `<span>⚠️</span> <span>${escapeHtml(message)}</span>`;
    alertEl.classList.remove('hidden');
    alertEl.focus?.();
  }

  function handlePlannerInputChange() {
    setPlannerError(null);
    const resultContainer = document.getElementById('planner-result-container');
    const staleNotice = document.getElementById('planner-stale-notice');
    if (resultContainer && !resultContainer.classList.contains('hidden')) {
      resultContainer.classList.add('stale');
      if (staleNotice) staleNotice.classList.remove('hidden');
    }
  }

  async function loadPlanner() {
    loadGoals();
    loadSavedPlans();
  }
  window.loadPlanner = loadPlanner;

  async function handleGeneratePlan(e) {
    e.preventDefault();
    setPlannerError(null);

    if (isGeneratingPlan) return;

    if (!currentUser) {
      setPlannerError('Please sign in to generate weekly plans.');
      openAuthModal('login');
      return;
    }

    const timeInputEl = document.getElementById('planner-time-input');
    const timeInput = timeInputEl ? timeInputEl.value.trim() : '';
    if (!timeInput) {
      setPlannerError('Please enter your available time for this week (e.g. "3 hours", "90 minutes", or 180).');
      timeInputEl?.focus();
      return;
    }

    const speedEl = document.getElementById('planner-reading-speed');
    const speed = speedEl ? parseInt(speedEl.value, 10) : 30;
    if (isNaN(speed) || speed <= 0) {
      setPlannerError('Please enter a valid reading speed (at least 1 page/hour).');
      speedEl?.focus();
      return;
    }

    const goalId = document.getElementById('planner-goal-select')?.value || null;

    const types = [];
    if (document.getElementById('planner-type-movies')?.checked) types.push('movie');
    if (document.getElementById('planner-type-tv')?.checked) types.push('tv');
    if (document.getElementById('planner-type-books')?.checked) types.push('book');

    if (types.length === 0) {
      setPlannerError('Please select at least one entertainment category (Movies, TV Episodes, or Book Reading Sessions).');
      return;
    }

    const btn = document.getElementById('btn-generate-weekly-plan');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Planning your week...';
    }
    isGeneratingPlan = true;

    try {
      const res = await fetch('/api/planner/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeInput, pagesPerHour: speed, types, goalId })
      });

      let plan = null;
      try {
        plan = await res.json();
      } catch (_) {
        plan = {};
      }

      if (!res.ok) {
        if (res.status === 401) {
          setPlannerError('Your session has expired. Please sign in again.');
        } else if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After');
          const retryMsg = retryAfter ? ` Please retry after ${retryAfter} seconds.` : ' Please wait a moment before generating another plan.';
          setPlannerError(`Too many requests.${retryMsg}`);
        } else {
          setPlannerError(plan.error || 'Failed to generate plan.');
        }
        return;
      }

      currentGeneratedPlan = plan;
      renderGeneratedPlan(plan);
      showToast('Weekly plan generated! ✨', 'success');
    } catch (err) {
      if (err.name === 'TypeError' || String(err.message).toLowerCase().includes('fetch')) {
        setPlannerError('Unable to connect to the server. Please check your network connection or verify the server is running.');
      } else {
        setPlannerError(err.message || 'An unexpected error occurred while generating the plan.');
      }
    } finally {
      isGeneratingPlan = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>✨</span> Generate Weekly Plan';
      }
    }
  }

  function renderGeneratedPlan(plan) {
    const container = document.getElementById('planner-result-container');
    const staleNotice = document.getElementById('planner-stale-notice');
    const badgeEl = document.getElementById('planner-budget-summary');
    const methodBadgeEl = document.getElementById('planner-method-badge');
    const fallbackAlert = document.getElementById('planner-fallback-reason-alert');
    const settingsBar = document.getElementById('planner-settings-bar');
    const explanationEl = document.getElementById('planner-explanation-card');
    const unusedCard = document.getElementById('planner-unused-time-card');
    const listEl = document.getElementById('planner-activities-list');
    const saveBtn = document.getElementById('btn-save-current-plan');

    if (!container) return;

    container.classList.remove('hidden', 'stale');
    if (staleNotice) staleNotice.classList.add('hidden');

    if (badgeEl) {
      badgeEl.textContent = `⏱️ ${plan.totalPlannedMinutes} of ${plan.budgetMinutes} mins planned`;
    }

    if (methodBadgeEl) {
      if (plan.isAiGenerated) {
        methodBadgeEl.className = 'planner-method-badge ai-active';
        methodBadgeEl.innerHTML = '✨ Gemini AI Planned';
      } else {
        methodBadgeEl.className = 'planner-method-badge ai-fallback';
        methodBadgeEl.innerHTML = '⚡ Smart Local Schedule';
      }
    }

    if (fallbackAlert) {
      if (!plan.isAiGenerated && plan.aiError) {
        fallbackAlert.className = 'planner-alert planner-alert-warning';
        fallbackAlert.innerHTML = `<span>ℹ️</span> <span><strong>Fallback Reason:</strong> ${escapeHtml(plan.aiError)}</span>`;
        fallbackAlert.classList.remove('hidden');
      } else {
        fallbackAlert.classList.add('hidden');
        fallbackAlert.innerHTML = '';
      }
    }

    if (settingsBar) {
      const s = plan.settings || {};
      let chipsHtml = `
        <span class="setting-chip">⏱️ Budget: ${escapeHtml(s.timeInput || (plan.budgetMinutes + 'm'))}</span>
        <span class="setting-chip">📁 Categories: ${escapeHtml(s.categoryNames || 'Selected')}</span>
      `;
      if (s.types && s.types.includes('book')) {
        chipsHtml += `<span class="setting-chip">📖 ${s.pagesPerHour || 30} pgs/hr</span>`;
      }
      if (s.goalTitle) {
        chipsHtml += `<span class="setting-chip">🎯 Goal: ${escapeHtml(s.goalTitle)}</span>`;
      }
      settingsBar.innerHTML = chipsHtml;
    }

    if (explanationEl) {
      const heading = plan.isAiGenerated ? 'AI Curator Reasoning' : 'Planner Schedule Overview';
      explanationEl.innerHTML = `<strong>${heading}:</strong> ${escapeHtml(plan.explanation || 'Curated schedule tailored to your available time.')}`;
    }

    if (unusedCard) {
      if (plan.unusedMinutes > 0 && plan.activities && plan.activities.length > 0) {
        unusedCard.classList.remove('hidden');
        unusedCard.innerHTML = `💡 <strong>Unused Time (${plan.unusedMinutes}m):</strong> ${escapeHtml(plan.unusedMinutesExplanation || `${plan.unusedMinutes} minutes remain unscheduled because no further items in your selected categories fit within the remaining budget.`)}`;
      } else {
        unusedCard.classList.add('hidden');
        unusedCard.innerHTML = '';
      }
    }

    if (listEl) {
      if (!plan.activities || plan.activities.length === 0) {
        listEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><p>${escapeHtml(plan.explanation || 'No suitable items fit within this time budget.')}</p></div>`;
        if (saveBtn) saveBtn.disabled = true;
      } else {
        listEl.innerHTML = plan.activities.map((act, idx) => renderPlannerActivityCard(act, idx, false)).join('');
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function handleSavePlan() {
    if (isSavingPlan) return;

    if (!currentGeneratedPlan || !currentGeneratedPlan.activities || currentGeneratedPlan.activities.length === 0) {
      showToast('No active plan to save.', 'warning');
      return;
    }

    const titlePrompt = prompt('Enter a name for this plan:', `Week of ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} (${currentGeneratedPlan.budgetMinutes} mins)`);
    if (!titlePrompt || !titlePrompt.trim()) return;

    const btn = document.getElementById('btn-save-current-plan');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Saving...';
    }
    isSavingPlan = true;

    try {
      const res = await fetch('/api/planner/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: titlePrompt.trim(),
          budgetMinutes: currentGeneratedPlan.budgetMinutes,
          totalPlannedMinutes: currentGeneratedPlan.totalPlannedMinutes,
          activities: currentGeneratedPlan.activities,
          settings: currentGeneratedPlan.settings,
          explanation: currentGeneratedPlan.explanation,
          isAiGenerated: currentGeneratedPlan.isAiGenerated,
          aiStatus: currentGeneratedPlan.aiStatus,
          aiError: currentGeneratedPlan.aiError
        })
      });
      const saved = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(saved.error || 'Failed to save plan');

      showToast('Plan saved to your history! 💾', 'success');
      loadSavedPlans();
    } catch (err) {
      const msg = (err.name === 'TypeError' || String(err.message).toLowerCase().includes('fetch'))
        ? 'Could not connect to the server to save plan. Please check your connection.'
        : (err.message || 'Failed to save plan');
      showToast(msg, 'error');
    } finally {
      isSavingPlan = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>💾</span> Save This Plan';
      }
    }
  }

  async function loadSavedPlans() {
    const list = document.getElementById('saved-plans-list');
    if (!list) return;

    if (!currentUser) {
      list.innerHTML = '<div class="saved-plans-empty">Please sign in to view saved plans.</div>';
      return;
    }

    try {
      const res = await fetch('/api/planner/saved');
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Could not load saved plans');
      }
      const data = await res.json();
      const plans = data.plans || [];
      savedPlansCache = plans;
      window.savedPlansCache = plans;

      if (plans.length === 0) {
        list.innerHTML = '<div class="saved-plans-empty">No saved plans yet. Generate and save a plan above.</div>';
        return;
      }

      list.innerHTML = plans.map(p => {
        const dateStr = new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const items = p.activities || [];
        const s = p.settings || {};
        let settingsBadges = '';
        if (s.categoryNames) {
          settingsBadges += `<span class="setting-chip" style="font-size:0.75rem;padding:2px 8px;">📁 ${escapeHtml(s.categoryNames)}</span>`;
        }
        if (s.goalTitle) {
          settingsBadges += `<span class="setting-chip" style="font-size:0.75rem;padding:2px 8px;">🎯 ${escapeHtml(s.goalTitle)}</span>`;
        }
        const isAllDone = items.length > 0 && items.every(a => Boolean(a.completed));
        const methodBadge = p.isAiGenerated
          ? '<span class="planner-method-badge ai-active" style="font-size:0.75rem;padding:2px 8px;">✨ Gemini AI</span>'
          : `<span class="planner-method-badge ai-fallback" style="font-size:0.75rem;padding:2px 8px;" title="${escapeHtml(p.aiError || 'Local Schedule')}">⚡ Smart Local Schedule</span>`;

        return `
          <div class="saved-plan-card" id="saved-plan-${p.id}">
            <div class="saved-plan-header">
              <div>
                <span class="saved-plan-title">${escapeHtml(p.title)}</span>
                <div class="saved-plan-items-summary">⏱️ ${p.totalPlannedMinutes} mins planned of ${p.timeBudgetMinutes} mins budget • Created ${dateStr}</div>
                <div class="saved-plan-meta" style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;">
                  ${methodBadge}
                  ${settingsBadges}
                  ${(p.status === 'completed' || isAllDone) ? '<span class="status-badge badge-completed" style="font-size:0.75rem;padding:2px 8px;background:rgba(16,185,129,0.2);color:#6ee7b7;border-radius:4px;border:1px solid rgba(16,185,129,0.4);">✅ All Completed</span>' : ''}
                </div>
              </div>
              <button type="button" class="btn-icon-action danger" onclick="window.handleDeleteSavedPlan(${p.id})" title="Delete Saved Plan">🗑️ Delete</button>
            </div>
            ${p.explanation ? `<p style="font-size:0.85rem; color:#94a3b8; font-style:italic;">"${escapeHtml(p.explanation)}"</p>` : ''}
            ${(!p.isAiGenerated && p.aiError) ? `<div style="font-size:0.8rem; color:#f59e0b; margin-top:4px;">⚠️ <em>${escapeHtml(p.aiError)}</em></div>` : ''}
            <div class="planner-activities-grid">
              ${items.map((act, idx) => renderPlannerActivityCard(act, idx, true, p.id)).join('')}
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      list.innerHTML = `
        <div class="empty-state" style="padding:1.5rem;text-align:center;">
          <p style="color:#ef4444;margin-bottom:0.75rem;">⚠️ Error loading saved plans: ${escapeHtml(err.message)}</p>
          <button type="button" class="btn btn-secondary btn-sm" onclick="window.loadSavedPlans()">🔄 Retry</button>
        </div>
      `;
    }
  }
  window.loadSavedPlans = loadSavedPlans;

  function renderPlannerActivityCard(act, idx, isSavedView = false, planId = null) {
    const poster = act.posterUrl || act.coverUrl;
    const typeIcon = act.itemType === 'movie' ? '🎬' : (act.itemType === 'tv' ? '📺' : '📚');
    const typeLabel = act.itemType === 'movie' ? 'Movie' : (act.itemType === 'tv' ? 'Next Episode' : 'Reading Session');
    const isCompleted = Boolean(act.completed);
    const btnId = isSavedView ? `act-btn-saved-${planId}-${idx}` : `act-btn-${idx}`;
    const clickHandler = isSavedView 
      ? `window.handleCompletePlannerActivity(${idx}, ${planId})` 
      : `window.handleCompletePlannerActivity(${idx}, null)`;

    return `
      <div class="planner-activity-card">
        ${poster ? `<img src="${escapeHtml(poster)}" class="planner-act-poster" alt="">` : `<div class="planner-act-poster" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem;">${typeIcon}</div>`}
        <div class="planner-act-info">
          <span class="planner-act-type">${typeLabel}</span>
          <span class="planner-act-title">${escapeHtml(act.title)}</span>
          <span class="planner-act-details">${escapeHtml(act.details || '')}</span>
          <div class="planner-act-actions" style="margin-top:0.5rem;">
            <button type="button" class="btn-complete-activity ${isCompleted ? 'completed' : ''}" id="${btnId}" onclick="${clickHandler}" ${isCompleted ? 'disabled' : ''}>
              ${isCompleted ? '✅ Completed' : 'Mark Complete'}
            </button>
          </div>
        </div>
        <span class="activity-duration-badge">⏱️ ${act.durationMinutes}m</span>
      </div>
    `;
  }

  window.handleCompletePlannerActivity = async function(idx, planId = null) {
    let act = null;
    let btnId = '';

    if (planId !== null && planId !== undefined) {
      const plan = (savedPlansCache || []).find(p => p.id === planId);
      act = plan?.activities?.[idx];
      btnId = `act-btn-saved-${planId}-${idx}`;
    } else {
      act = currentGeneratedPlan?.activities?.[idx];
      btnId = `act-btn-${idx}`;
    }

    if (!act) return;

    const btn = document.getElementById(btnId) || document.getElementById(`act-btn-${idx}`);
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Updating...';
    }

    try {
      const res = await fetch('/api/planner/complete-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: planId || null,
          activityIndex: idx,
          candidateId: act.candidateId || null,
          itemType: act.itemType,
          itemId: act.itemId,
          season: act.season,
          episode: act.episode,
          endPage: act.endPage || act.targetPage
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to complete activity');

      act.completed = true;
      if (btn) {
        btn.disabled = true;
        btn.className = 'btn-complete-activity completed';
        btn.innerHTML = '✅ Completed';
      }

      // If all activities in this saved plan are now completed, update the badge in UI
      if (planId) {
        const plan = (savedPlansCache || []).find(p => p.id === planId);
        if (plan && plan.activities && plan.activities.every(a => Boolean(a.completed))) {
          plan.status = 'completed';
          const planCard = document.getElementById(`saved-plan-${planId}`);
          if (planCard) {
            const metaDiv = planCard.querySelector('.saved-plan-meta');
            if (metaDiv && !metaDiv.querySelector('.badge-completed')) {
              metaDiv.insertAdjacentHTML('beforeend', '<span class="status-badge badge-completed" style="font-size:0.75rem;padding:2px 8px;background:rgba(16,185,129,0.2);color:#6ee7b7;border-radius:4px;border:1px solid rgba(16,185,129,0.4);">✅ All Completed</span>');
            }
          }
        }
      }

      showToast(data.message || 'Activity completed!', data.alreadyCompleted ? 'info' : 'success');

      // Update book progress, statistics and applicable goals after a successful completion
      loadGoals();
      loadDashboard();
      loadPersonalStatistics();
      if (typeof loadBooks === 'function') loadBooks();
      if (typeof loadMedia === 'function') loadMedia();
      if (typeof loadMovies === 'function') loadMovies();
      if (typeof loadSeries === 'function') loadSeries();
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'Mark Complete';
      }
      showToast(err.message, 'error');
    }
  };

  window.handleDeleteSavedPlan = async function(planId) {
    if (!confirm('Are you sure you want to delete this saved plan?')) return;
    try {
      const res = await fetch(`/api/planner/saved/${planId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete saved plan');
      showToast('Saved plan deleted.', 'info');
      loadSavedPlans();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ===================================================
  // EPISODE CALENDAR CONTROLLER
  // ===================================================
  async function loadCalendar() {
    const container = document.getElementById('calendar-agenda-container');
    if (!container) return;

    if (!currentUser) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 3rem;">
          <span class="empty-icon">🔒</span>
          <h3>Private Calendar</h3>
          <p>Please sign in to view upcoming episodes for your followed series.</p>
          <button type="button" class="btn btn-primary" onclick="window.openAuthModal('login')">Sign In</button>
        </div>
      `;
      return;
    }

    const daysSelect = document.getElementById('calendar-days-select');
    const includeWatchedCheck = document.getElementById('calendar-include-watched');
    const days = daysSelect ? daysSelect.value : 30;
    const includeWatched = includeWatchedCheck ? includeWatchedCheck.checked : false;

    let userTz = 'UTC';
    try {
      userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (_) {}

    const tzBadge = document.getElementById('calendar-tz-display');
    if (tzBadge) {
      tzBadge.textContent = `🕒 Times localized to ${userTz}`;
    }

    try {
      const res = await fetch(`/api/calendar/upcoming?days=${days}&includeWatched=${includeWatched}&timeZone=${encodeURIComponent(userTz)}`);
      if (!res.ok) throw new Error('Could not load calendar');
      const data = await res.json();

      const syncNotice = document.getElementById('calendar-sync-notice');
      if (syncNotice) {
        if (data.lastSyncedAt) {
          const syncDate = new Date(data.lastSyncedAt).toLocaleString();
          const staleBadge = data.isStale ? '<span style="color:#ef4444;font-weight:600;margin-left:6px;">⚠️ Stale data</span>' : '';
          syncNotice.innerHTML = `<span>🔄 Last synced: ${escapeHtml(syncDate)} ${staleBadge}</span> <span style="margin-left:8px;">ℹ️ Automatic checks run in background only while server is running.</span>`;
        } else {
          syncNotice.innerHTML = `<span>🔄 Not yet synced</span> <span style="margin-left:8px;">ℹ️ Automatic checks run in background only while server is running.</span>`;
        }
      }

      renderCalendarAgenda(data);
    } catch (err) {
      container.innerHTML = `<div class="empty-state">Error loading calendar: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderCalendarAgenda(calData) {
    const gridToday = document.getElementById('agenda-grid-today');
    const gridWeek = document.getElementById('agenda-grid-this-week');
    const gridLater = document.getElementById('agenda-grid-later');

    // Handle overall empty states
    if (calData.totalCount === 0) {
      const container = document.getElementById('calendar-agenda-container');
      if (calData.followedSeriesCount === 0) {
        if (container) {
          container.innerHTML = `
            <div class="empty-state" style="padding: 3rem 1.5rem; text-align: center;">
              <span class="empty-icon">📺</span>
              <h3>No Followed TV Shows</h3>
              <p style="max-width: 480px; margin: 0.5rem auto 1.5rem; color: #94a3b8;">You haven’t added any TV series to your library yet. Add shows you watch to see upcoming release dates on this calendar.</p>
              <button type="button" class="btn btn-primary" onclick="window.switchView('library')">Browse Library</button>
            </div>
          `;
        }
        return;
      } else {
        // Has followed series, but no episodes in window
        if (gridToday) gridToday.innerHTML = `<div class="agenda-empty-text">No episodes airing today.</div>`;
        if (gridWeek) gridWeek.innerHTML = `<div class="agenda-empty-text">No episodes scheduled for the next 7 days.</div>`;
        if (gridLater) gridLater.innerHTML = `<div class="agenda-empty-text">No upcoming episodes scheduled within ${calData.windowDays || 30} days for your ${calData.followedSeriesCount} followed series. All caught up or waiting for new release dates.</div>`;
        return;
      }
    }

    const renderList = (episodes, targetEl, emptyMsg) => {
      if (!targetEl) return;
      if (!episodes || episodes.length === 0) {
        targetEl.innerHTML = `<div class="agenda-empty-text">${emptyMsg}</div>`;
        return;
      }

      targetEl.innerHTML = episodes.map(ep => {
        return `
          <div class="calendar-episode-card" id="${ep.id}" style="cursor: pointer;" onclick="window.openSeriesDetailModal(${ep.showId}, ${ep.season})" title="Open ${escapeHtml(ep.showTitle)} Season ${ep.season}">
            ${ep.posterUrl ? `<img src="${escapeHtml(ep.posterUrl)}" class="cal-ep-poster" alt="${escapeHtml(ep.showTitle)}">` : '<div class="cal-ep-poster" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem;">📺</div>'}
            <div class="cal-ep-body">
              <div class="cal-ep-title-row">
                <span class="cal-show-title" title="View Season ${ep.season} in library">${escapeHtml(ep.showTitle)}</span>
                <span class="cal-badge-relative">${escapeHtml(ep.relativeLabel)}</span>
              </div>
              <div class="cal-ep-code">Season ${ep.season}, Episode ${ep.episode}</div>
              <div class="cal-ep-name">${escapeHtml(ep.episodeTitle)}</div>
              <div class="cal-ep-airtime">📅 ${escapeHtml(ep.formattedDate)} ${ep.formattedTime ? `• ⏰ ${escapeHtml(ep.formattedTime)}` : ''}</div>
              <button type="button" class="cal-notif-btn ${ep.notifyEnabled ? 'active' : ''}" onclick="event.stopPropagation(); window.toggleSeriesNotifications(${ep.showId}, ${ep.notifyEnabled ? 0 : 1})">
                ${ep.notifyEnabled ? '🔔 Alert ON' : '🔕 Alert OFF'}
              </button>
            </div>
          </div>
        `;
      }).join('');
    };

    renderList(calData.agenda?.today, gridToday, 'No episodes airing today.');
    renderList(calData.agenda?.thisWeek, gridWeek, 'No episodes scheduled for the next 7 days.');
    renderList(calData.agenda?.later, gridLater, 'No upcoming episodes scheduled further out.');
  }

  window.toggleSeriesNotifications = async function(mediaId, newState) {
    try {
      const res = await fetch(`/api/media/${mediaId}/notifications`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notify_enabled: newState })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update notification settings');

      showToast(newState ? '🔔 Episode alerts turned ON for this show.' : '🔕 Episode alerts muted for this show.', 'info');
      loadCalendar();
      if (currentSeriesDetailId === mediaId) {
        window.openSeriesDetailModal(mediaId);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ===================================================
  // ACTIVITY HISTORY & CORRECTIONS CONTROLLER
  // ===================================================
  let userActivitiesCache = [];

  async function loadActivityLog() {
    const list = document.getElementById('activity-log-list');
    if (!list) return;

    if (!currentUser) {
      list.innerHTML = '<div class="activity-empty-state">Please sign in to view activity history.</div>';
      return;
    }

    try {
      const res = await fetch('/api/activity?limit=50');
      if (!res.ok) throw new Error('Could not load activity log');
      const data = await res.json();
      userActivitiesCache = data.activities || [];

      if (userActivitiesCache.length === 0) {
        list.innerHTML = '<div class="activity-empty-state">No activity logged yet. Complete books, track pages, or log viewing cycles to build history.</div>';
        return;
      }

      list.innerHTML = userActivitiesCache.map(act => {
        const isReading = act.activity_type.includes('reading') || act.activity_type.includes('book');
        const icon = isReading ? '📖' : '🎬';
        const dateStr = new Date(act.timestamp || act.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

        let desc = '';
        if (act.activity_type === 'reading_progress') {
          desc = `Read ${act.pages_read} pages of ${act.item_title || 'book'}`;
        } else if (act.activity_type === 'book_completed') {
          desc = `Completed book: ${act.item_title || 'book'}`;
        } else if (act.activity_type === 'episode_watched') {
          desc = `Watched episode of ${act.item_title || 'series'}`;
        } else if (act.activity_type === 'movie_watched') {
          desc = `Watched movie: ${act.item_title || 'movie'}`;
        } else {
          desc = `${act.activity_type} on ${act.item_title || 'item'}`;
        }

        if (act.cycle_number > 1) {
          desc += ` (Cycle ${act.cycle_number})`;
        }

        return `
          <div class="activity-log-item" id="activity-entry-${act.id}">
            <div class="activity-item-left">
              <span class="activity-icon">${icon}</span>
              <div>
                <span class="activity-desc">${escapeHtml(desc)}</span>
                ${act.is_correction ? '<span class="activity-correction-badge">Edited</span>' : ''}
              </div>
            </div>
            <div class="activity-item-right">
              <span class="activity-date">${dateStr}</span>
              <div class="activity-actions">
                ${act.pages_read ? `<button type="button" class="btn-icon-action" onclick="window.openActivityEditModal(${act.id}, ${act.pages_read}, 'pages')" title="Correct Pages">✏️</button>` : ''}
                ${act.minutes_viewed ? `<button type="button" class="btn-icon-action" onclick="window.openActivityEditModal(${act.id}, ${act.minutes_viewed}, 'minutes')" title="Correct Minutes">✏️</button>` : ''}
                <button type="button" class="btn-icon-action danger" onclick="window.handleDeleteActivity(${act.id})" title="Delete Entry">🗑️</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  window.openActivityEditModal = function(id, curVal, type) {
    const modal = document.getElementById('modal-activity-edit');
    const idInput = document.getElementById('edit-activity-id');
    const valInput = document.getElementById('edit-activity-value');
    const label = document.getElementById('edit-activity-value-label');
    if (!modal) return;

    idInput.value = id;
    idInput.dataset.type = type;
    valInput.value = curVal;
    label.textContent = type === 'pages' ? 'Corrected Pages Read *' : 'Corrected Minutes Viewed *';
    modal.classList.remove('hidden');
  };

  async function handleSaveActivityCorrection(e) {
    e.preventDefault();
    const id = document.getElementById('edit-activity-id').value;
    const type = document.getElementById('edit-activity-id').dataset.type;
    const val = parseInt(document.getElementById('edit-activity-value').value, 10);

    if (isNaN(val) || val < 0) {
      showToast('Please enter a valid non-negative integer.', 'warning');
      return;
    }

    const payload = {};
    if (type === 'pages') payload.pagesRead = val;
    else payload.minutesViewed = val;

    try {
      const res = await fetch(`/api/activity/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update activity');

      showToast('Activity correction saved.', 'success');
      document.getElementById('modal-activity-edit')?.classList.add('hidden');
      loadActivityLog();
      loadPersonalStatistics();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  window.handleDeleteActivity = async function(id) {
    if (!confirm('Are you sure you want to delete this activity entry? This will update your personal statistics.')) return;
    try {
      const res = await fetch(`/api/activity/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete activity');
      showToast('Activity entry removed.', 'info');
      loadActivityLog();
      loadPersonalStatistics();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Wire up feature event listeners
  document.getElementById('btn-open-create-goal-modal')?.addEventListener('click', () => window.openGoalModal());
  document.getElementById('btn-empty-create-goal')?.addEventListener('click', () => window.openGoalModal());
  document.getElementById('btn-close-goal-modal')?.addEventListener('click', () => document.getElementById('modal-goal')?.classList.add('hidden'));
  document.getElementById('btn-cancel-goal')?.addEventListener('click', () => document.getElementById('modal-goal')?.classList.add('hidden'));
  document.getElementById('form-goal')?.addEventListener('submit', handleSaveGoal);

  document.getElementById('form-generate-plan')?.addEventListener('submit', handleGeneratePlan);
  document.getElementById('btn-save-current-plan')?.addEventListener('click', handleSavePlan);

  // Mark plan stale and clear inline error when inputs change
  ['planner-time-input', 'planner-reading-speed', 'planner-goal-select', 'planner-type-movies', 'planner-type-tv', 'planner-type-books'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', handlePlannerInputChange);
      el.addEventListener('change', handlePlannerInputChange);
    }
  });

  document.getElementById('calendar-days-select')?.addEventListener('change', loadCalendar);
  document.getElementById('calendar-include-watched')?.addEventListener('change', loadCalendar);
  document.getElementById('btn-refresh-calendar')?.addEventListener('click', loadCalendar);

  document.getElementById('btn-refresh-activities')?.addEventListener('click', loadActivityLog);
  document.getElementById('btn-close-activity-modal')?.addEventListener('click', () => document.getElementById('modal-activity-edit')?.classList.add('hidden'));
  document.getElementById('btn-cancel-activity-edit')?.addEventListener('click', () => document.getElementById('modal-activity-edit')?.classList.add('hidden'));
  document.getElementById('form-edit-activity')?.addEventListener('submit', handleSaveActivityCorrection);

  // Earlier episodes catch-up modal listeners
  document.getElementById('btn-mark-earlier-too')?.addEventListener('click', async () => {
    if (!activeEarlierModalContext) return;
    const { mediaId, season, episode, btnElement } = activeEarlierModalContext;
    const leaveDateUnknown = document.getElementById('earlier-unknown-date-checkbox')?.checked ?? true;
    closeEarlierEpisodesModal();
    await submitEpisodeWatched(mediaId, season, episode, { markEarlier: true, leaveDateUnknown }, btnElement);
  });

  document.getElementById('btn-only-this-episode')?.addEventListener('click', async () => {
    if (!activeEarlierModalContext) return;
    const { mediaId, season, episode, btnElement } = activeEarlierModalContext;
    closeEarlierEpisodesModal();
    await submitEpisodeWatched(mediaId, season, episode, { markEarlier: false }, btnElement);
  });

  document.getElementById('btn-cancel-earlier-dialog')?.addEventListener('click', () => {
    closeEarlierEpisodesModal();
  });

  document.getElementById('btn-close-earlier-modal')?.addEventListener('click', () => {
    closeEarlierEpisodesModal();
  });

  document.getElementById('modal-confirm-earlier-episodes')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeEarlierEpisodesModal();
    }
  });

  const earlierModal = document.getElementById('modal-confirm-earlier-episodes');
  earlierModal?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeEarlierEpisodesModal();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = earlierModal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
  });

  // Season watched confirmation modal listeners
  document.getElementById('btn-mark-season-only')?.addEventListener('click', async () => {
    if (!activeSeasonWatchedModalContext) return;
    const { mediaId, seasonNumber } = activeSeasonWatchedModalContext;
    closeSeasonWatchedModal();
    await executeMarkSeasonWatched(mediaId, seasonNumber, false);
  });

  document.getElementById('btn-mark-season-and-earlier')?.addEventListener('click', async () => {
    if (!activeSeasonWatchedModalContext) return;
    const { mediaId, seasonNumber } = activeSeasonWatchedModalContext;
    closeSeasonWatchedModal();
    await executeMarkSeasonWatched(mediaId, seasonNumber, true);
  });

  document.getElementById('btn-cancel-season-watched')?.addEventListener('click', () => {
    closeSeasonWatchedModal();
  });

  document.getElementById('btn-close-season-watched-modal')?.addEventListener('click', () => {
    closeSeasonWatchedModal();
  });

  document.getElementById('modal-confirm-season-watched')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeSeasonWatchedModal();
    }
  });

  const seasonWatchedModal = document.getElementById('modal-confirm-season-watched');
  seasonWatchedModal?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSeasonWatchedModal();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = seasonWatchedModal.querySelectorAll(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
  });
});

