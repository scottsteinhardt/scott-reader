/* RSS Reader — Vanilla JS SPA */

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  token: localStorage.getItem('token') ?? null,
  user: JSON.parse(localStorage.getItem('user') ?? 'null'),
  feeds: [],
  folders: [],
  counts: { feeds: {}, starred: 0 },
  articles: [],
  selectedArticle: null,
  currentView: { type: 'all' }, // { type: 'all'|'unread'|'starred'|'feed'|'folder'|'search', id?, name? }
  unreadOnly: localStorage.getItem('unreadOnly') === '1',
  sortOrder: localStorage.getItem('sortOrder') ?? 'desc',
  articleView: 'comfortable',
  loading: false,
  loadingMore: false,
  hasMore: false,
  refreshing: false,
  confirmMarkRead: localStorage.getItem('confirmMarkRead') === '1',
  scrollMarkRead: localStorage.getItem('scrollMarkRead') === '1',
  hideReadFolders: localStorage.getItem('hideReadFolders') === '1',
  selectedFeedIds: new Set(),
  articleFontFamily: localStorage.getItem('articleFontFamily') ?? 'system',
  articleFontSize: parseInt(localStorage.getItem('articleFontSize') ?? '16', 10),
  uiFontSize: parseInt(localStorage.getItem('uiFontSize') ?? '14', 10),
  sidebarWidth: parseInt(localStorage.getItem('sidebarWidth') ?? '260', 10),
  listWidth: parseInt(localStorage.getItem('listWidth') ?? '380', 10),
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function api(method, path, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    ...options,
  })

  if (res.status === 401) { logout(); return null }
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

const GET = (path) => api('GET', path)
const POST = (path, body) => api('POST', path, body)
const PATCH = (path, body) => api('PATCH', path, body)
const DELETE = (path) => api('DELETE', path)

// ─── App init ─────────────────────────────────────────────────────────────────
function init() {
  // Check for public view route
  const match = location.pathname.match(/^\/u\/([^/]+)/)
  if (match) { showPublicView(match[1]); return }

  applyTheme()
  applyLayoutPrefs()

  if (state.token && state.user) {
    showMainScreen()
  } else {
    showScreen('login-screen')
    loadTicker()
  }

  setupLoginHandlers()
  setupMainHandlers()
  setupKeyboardShortcuts()

  // Refresh state when tab regains focus (picks up changes made in Reeder or other clients)
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now()
    } else if (state.token && hiddenAt && Date.now() - hiddenAt > 5000) {
      loadSidebar()
      loadArticles()
      hiddenAt = 0
    }
  })

  // Also poll for external changes every 90 seconds while the tab is active
  setInterval(() => {
    if (state.token && !document.hidden) loadSidebar()
  }, 90000)
}

// ─── Theme ────────────────────────────────────────────────────────────────────
const FONT_FAMILIES = {
  system: 'inherit',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Courier New", Courier, monospace',
}

function applyTheme(user = state.user) {
  const theme = user?.theme ?? 'system'
  const accent = user?.accent_color ?? '#2563eb'
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.setProperty('--accent', accent)
  state.articleView = user?.article_view ?? 'comfortable'
  document.getElementById('article-list')?.classList.remove('view-comfortable', 'view-compact', 'view-magazine')
  document.getElementById('article-list')?.classList.add(`view-${state.articleView}`)
  applyArticleFont()
}

function applyArticleFont() {
  const family = FONT_FAMILIES[state.articleFontFamily] ?? 'inherit'
  const size = state.articleFontSize + 'px'
  document.documentElement.style.setProperty('--article-font-family', family)
  document.documentElement.style.setProperty('--article-font-size', size)
}

function applyLayoutPrefs() {
  document.documentElement.style.setProperty('font-size', state.uiFontSize + 'px')
  document.documentElement.style.setProperty('--sidebar-width', state.sidebarWidth + 'px')
  document.documentElement.style.setProperty('--list-width', state.listWidth + 'px')
}

// ─── Screens ──────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'))
  document.getElementById(id)?.classList.remove('hidden')
}

function showMainScreen() {
  showScreen('main-screen')
  applyTheme()
  loadSidebar()
  loadArticles()
}

// ─── Auth handlers ────────────────────────────────────────────────────────────
function setupLoginHandlers() {
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault()
    const username = document.getElementById('login-username').value.trim()
    const password = document.getElementById('login-password').value
    const err = document.getElementById('login-error')
    err.classList.add('hidden')

    const res = await POST('/api/users/login', { username, password })
    if (!res?.token) {
      err.textContent = res?.error ?? 'Login failed'
      err.classList.remove('hidden')
      return
    }
    state.token = res.token
    state.user = res.user
    localStorage.setItem('token', res.token)
    localStorage.setItem('user', JSON.stringify(res.user))
    showMainScreen()
  })

  document.getElementById('register-form').addEventListener('submit', async e => {
    e.preventDefault()
    const username = document.getElementById('reg-username').value.trim()
    const password = document.getElementById('reg-password').value
    const err = document.getElementById('register-error')
    err.classList.add('hidden')

    const res = await POST('/api/users/register', { username, password })
    if (!res?.token) {
      err.textContent = res?.error ?? 'Registration failed'
      err.classList.remove('hidden')
      return
    }
    state.token = res.token
    state.user = res.user
    localStorage.setItem('token', res.token)
    localStorage.setItem('user', JSON.stringify(res.user))
    showMainScreen()
  })

  document.getElementById('show-register').addEventListener('click', e => { e.preventDefault(); showScreen('register-screen') })
  document.getElementById('show-login').addEventListener('click', e => { e.preventDefault(); showScreen('login-screen') })
  document.getElementById('show-about').addEventListener('click', e => { e.preventDefault(); openModal('about-modal') })
}

function logout() {
  POST('/api/users/logout').catch(() => {})
  state.token = null
  state.user = null
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  showScreen('login-screen')
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
async function loadSidebar() {
  const [feeds, counts] = await Promise.all([
    GET('/api/feeds'),
    GET('/api/articles/counts'),
  ])
  if (!feeds || !counts) return

  state.feeds = feeds
  state.counts = counts

  // Build folder structure
  const byFolder = new Map()
  byFolder.set(null, [])
  for (const feed of feeds) {
    const key = feed.folder ?? null
    if (!byFolder.has(key)) byFolder.set(key, [])
    byFolder.get(key).push(feed)
  }
  state.folders = [...byFolder.keys()].filter(Boolean)

  // Populate datalist
  const dl = document.getElementById('folders-datalist')
  dl.innerHTML = state.folders.map(f => `<option value="${esc(f)}">`).join('')
  document.getElementById('edit-feed-folder').setAttribute('list', 'folders-datalist')

  renderSidebar(byFolder, counts)
}

function renderSidebar(byFolder, counts) {
  const nav = document.getElementById('sidebar-nav')
  const feedCounts = Object.fromEntries(counts.feeds.map(r => [r.feed_id, r]))

  // Total unread
  const totalUnread = counts.feeds.reduce((s, r) => s + r.unread, 0)

  let html = ''

  // Special views
  html += `<div class="nav-section">`
  html += navItem('all', 'all', 'All articles', totalUnread, svgIcon('inbox'))
  html += navItem('unread', 'unread', 'Unread Only', totalUnread, svgIcon('unread'))
  html += navItem('starred', 'starred', 'Starred', counts.starred, svgIcon('star'))
  html += `</div>`

  // Ungrouped feeds
  const ungrouped = byFolder.get(null) ?? []
  const visibleUngrouped = state.hideReadFolders ? ungrouped.filter(f => (f.unread_count ?? 0) > 0) : ungrouped
  if (visibleUngrouped.length) {
    html += `<div class="nav-section">`
    html += `<div class="nav-section-header"><span>Feeds</span></div>`
    for (const feed of visibleUngrouped) {
      const c = feedCounts[feed.id]
      html += feedNavItem(feed, c?.unread ?? 0)
    }
    html += `</div>`
  }

  // Folders
  for (const [folder, feeds] of byFolder) {
    if (!folder || !feeds.length) continue
    const folderUnread = feeds.reduce((s, f) => s + (feedCounts[f.id]?.unread ?? 0), 0)
    const visibleFeeds = state.hideReadFolders ? feeds.filter(f => (f.unread_count ?? 0) > 0) : feeds
    if (state.hideReadFolders && visibleFeeds.length === 0) continue
    const collapsed = localStorage.getItem(`folder-collapsed-${folder}`) === '1'
    html += `<div class="nav-section">`
    html += `<div class="nav-section-header" data-folder="${esc(folder)}">
      <span class="folder-name" data-folder-nav="${esc(folder)}" onclick="selectView({type:'folder',name:'${esc(folder)}'})">${esc(folder)}</span>
      <span class="nav-section-toggle ${collapsed ? 'collapsed' : ''}" onclick="toggleFolder(this.closest('.nav-section-header'))">▾</span>
      ${folderUnread > 0 ? `<span class="nav-count" style="margin-left:.5rem">${folderUnread}</span>` : ''}
      <button class="folder-mark-read" onclick="event.stopPropagation();markFolderRead('${esc(folder)}')" title="Mark all as read">✓</button>
    </div>`
    html += `<div class="folder-feeds" ${collapsed ? 'style="display:none"' : ''}>`
    for (const feed of visibleFeeds) {
      html += feedNavItem(feed, feedCounts[feed.id]?.unread ?? 0)
    }
    html += `</div></div>`
  }

  nav.innerHTML = html

  // Highlight active
  updateActiveNav()
}

function navItem(type, id, label, count, icon) {
  const active = state.currentView.type === type ? 'active' : ''
  const badge = count > 0 ? `<span class="nav-count">${count}</span>` : ''
  return `<div class="nav-item ${active}" onclick="selectView({type:'${type}'})" data-view-type="${type}">
    <svg class="nav-icon" viewBox="0 0 24 24">${icon}</svg>
    <span class="nav-label">${label}</span>
    ${badge}
  </div>`
}

function feedNavItem(feed, unread) {
  const isActive = state.currentView.type === 'feed' && state.currentView.id === feed.id
  const favicon = feed.favicon_url
    ? `<img class="nav-favicon" src="${esc(feed.favicon_url)}" onerror="this.style.display='none'" />`
    : `<span class="nav-favicon-placeholder"></span>`
  const title = esc(feed.custom_title ?? feed.title ?? feed.url)
  const countBadge = unread > 0 ? `<span class="nav-count">${unread}</span>` : ''
  const errorBadge = feed.error_count > 0
    ? `<span class="nav-error" title="${esc(feed.last_error ?? 'Feed error')}">⚠</span>`
    : ''
  return `<div class="nav-item ${isActive ? 'active' : ''}" onclick="selectFeed(${feed.id})" data-feed-id="${feed.id}">
    ${favicon}
    <span class="nav-label" title="${title}">${title}</span>
    <div class="nav-actions">
      <button class="nav-action-btn" onclick="event.stopPropagation();editFeed(${feed.id})" title="Edit">✎</button>
      <button class="nav-action-btn" onclick="event.stopPropagation();refreshFeed(${feed.id})" title="Refresh">↻</button>
    </div>
    ${errorBadge}${countBadge}
  </div>`
}

function toggleFolder(el) {
  const folder = el.dataset.folder
  const icon = el.querySelector('.nav-section-toggle')
  const content = el.nextElementSibling
  const collapsed = content.style.display === 'none'
  content.style.display = collapsed ? '' : 'none'
  icon.classList.toggle('collapsed', !collapsed)
  localStorage.setItem(`folder-collapsed-${folder}`, collapsed ? '0' : '1')
}

function updateActiveNav() {
  document.querySelectorAll('.nav-item[data-view-type]').forEach(el => {
    el.classList.toggle('active', el.dataset.viewType === state.currentView.type && state.currentView.type !== 'feed')
  })
  document.querySelectorAll('.nav-item[data-feed-id]').forEach(el => {
    el.classList.toggle('active', state.currentView.type === 'feed' && Number(el.dataset.feedId) === state.currentView.id)
  })
  document.querySelectorAll('.folder-name[data-folder-nav]').forEach(el => {
    el.classList.toggle('active', state.currentView.type === 'folder' && el.dataset.folderNav === state.currentView.name)
  })
}

function selectView(view) {
  state.currentView = view
  state.articles = []
  state.selectedArticle = null
  closeSidebar()
  updateActiveNav()
  updatePanelTitle()
  updateUnreadBadge()
  loadArticles()
  // On mobile, show article list
  document.getElementById('article-content-panel').classList.remove('mobile-active')
}

function selectFeed(id) {
  const feed = state.feeds.find(f => f.id === id)
  const name = feed?.custom_title ?? feed?.title ?? feed?.url ?? String(id)
  selectView({ type: 'feed', id, name })
}

function updatePanelTitle() {
  const v = state.currentView
  let title = 'All articles'
  if (v.type === 'unread') title = 'Unread Only'
  else if (v.type === 'starred') title = 'Starred'
  else if (v.type === 'feed' || v.type === 'folder') title = v.name ?? title
  else if (v.type === 'search') title = `Search: ${v.query}`
  document.getElementById('panel-title').textContent = title
  document.getElementById('mobile-title').textContent = title
}

// ─── Articles ─────────────────────────────────────────────────────────────────
async function loadArticles(append = false) {
  if (state.loading) return
  state.loading = true

  const list = document.getElementById('article-list')
  if (!append) {
    list.innerHTML = '<div class="loading-state">Loading…</div>'
    state.articles = []
  }

  const v = state.currentView
  const params = new URLSearchParams({
    unread_only: state.unreadOnly ? '1' : '0',
    sort: state.sortOrder === 'asc' ? 'oldest' : 'newest',
    limit: '50',
  })

  if (v.type === 'feed') params.set('feed_id', v.id)
  else if (v.type === 'folder') params.set('folder', v.name)
  else if (v.type === 'starred') params.set('starred', '1')
  else if (v.type === 'search') params.set('search', v.query)
  if (v.type === 'unread') params.set('unread_only', '1')

  if (append && state.articles.length) {
    params.set('before_id', state.articles[state.articles.length - 1].id)
  }

  const articles = await GET(`/api/articles?${params}`)
  state.loading = false
  if (!articles) return

  if (append) state.articles.push(...articles)
  else state.articles = articles

  state.hasMore = articles.length === 50

  renderArticleList(append)
  updateUnreadBadge()
}

function renderArticleList(append = false) {
  const list = document.getElementById('article-list')
  if (!state.articles.length) {
    list.innerHTML = `<div class="empty-list">${state.unreadOnly ? 'No unread articles' : 'No articles'}</div>`
    return
  }

  const html = state.articles.map(a => articleItemHTML(a)).join('')

  if (append) {
    list.querySelector('.load-more-sentinel')?.remove()
    list.insertAdjacentHTML('beforeend', html)
  } else {
    list.innerHTML = html
  }

  if (state.hasMore) {
    list.insertAdjacentHTML('beforeend', '<div class="load-more-sentinel" style="height:1px"></div>')
    setupIntersectionObserver()
  }
}

function articleItemHTML(a) {
  const isRead = a.is_read
  const isStarred = a.is_starred
  const time = formatTime(a.published_at)
  const feed = esc(a.custom_title ?? a.feed_title ?? a.feed_url)
  const favicon = a.feed_favicon
    ? `<img src="${esc(a.feed_favicon)}" onerror="this.style.display='none'" />`
    : ''
  const readingTime = a.word_count > 0 ? `${Math.ceil(a.word_count / 200)}m read` : ''
  const snippet = a.snippet ? `<div style="font-size:.78rem;color:var(--text-muted);margin-top:.2rem;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${a.snippet}</div>` : ''
  const feedUnread = state.counts?.feeds?.find(r => r.feed_id === a.feed_id)?.unread ?? 0
  const unreadBadge = feedUnread > 0 ? `<span class="article-feed-unread">${feedUnread}</span>` : ''

  return `<div class="article-item ${isRead ? 'read' : ''} ${state.selectedArticle?.id === a.id ? 'active' : ''}"
    data-id="${a.id}" onclick="openArticle(${a.id})">
    ${!isRead ? '<div class="unread-indicator"></div>' : ''}
    <div class="article-item-feed">
      ${favicon}<span>${feed}</span>
      ${unreadBadge}
      ${a.folder ? `<span class="article-folder-label">· ${esc(a.folder)}</span>` : ''}
    </div>
    <div class="article-item-title">${esc(a.title ?? '(no title)')}</div>
    ${snippet}
    <div class="article-item-meta">
      ${a.author ? `<span>${esc(a.author)}</span>` : ''}
      ${readingTime ? `<span>${readingTime}</span>` : ''}
      <span class="article-item-time">${time}</span>
      ${isStarred ? '<span class="article-item-star">★</span>' : ''}
    </div>
  </div>`
}

function setupIntersectionObserver() {
  const sentinel = document.querySelector('.load-more-sentinel')
  if (!sentinel) return
  const obs = new IntersectionObserver(entries => {
    if (entries[0]?.isIntersecting && !state.loading) {
      obs.disconnect()
      loadArticles(true)
    }
  }, { threshold: 0.1 })
  obs.observe(sentinel)
}

function updateUnreadBadge() {
  const v = state.currentView
  const feeds = state.counts.feeds ?? []
  let count = 0

  if (v.type === 'feed') {
    count = feeds.find(r => r.feed_id === v.id)?.unread ?? 0
  } else if (v.type === 'folder') {
    count = feeds.filter(r => r.folder === v.name).reduce((s, r) => s + r.unread, 0)
  } else if (v.type === 'starred') {
    count = state.counts.starred ?? 0
  } else {
    // all, unread, search
    count = feeds.reduce((s, r) => s + r.unread, 0)
  }

  const badge = document.getElementById('unread-badge')
  badge.textContent = count
  badge.classList.toggle('hidden', count === 0)
}

// ─── Article detail ───────────────────────────────────────────────────────────
async function openArticle(id) {
  const article = state.articles.find(a => a.id === id)
  if (!article) return

  state.selectedArticle = article

  // Update list item style
  document.querySelectorAll('.article-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.id) === id)
  })

  // Mark as read immediately in UI
  if (!article.is_read) {
    article.is_read = 1
    const item = document.querySelector(`.article-item[data-id="${id}"]`)
    if (item) {
      item.classList.add('read')
      item.querySelector('.unread-indicator')?.remove()
    }
    // Update counts
    const feedCount = state.counts.feeds?.find(r => r.feed_id === article.feed_id)
    if (feedCount && feedCount.unread > 0) feedCount.unread--
    updateUnreadBadge()

    PATCH(`/api/articles/${id}`, { is_read: true })
  }

  renderArticleDetail(article, false)

  // Mobile: show content panel
  document.getElementById('article-content-panel').classList.add('mobile-active')
  document.getElementById('mobile-title').textContent = article.title ?? ''
}

function renderArticleDetail(article, readerMode) {
  const rawContent = readerMode
    ? (article.full_content ?? article.content ?? '')
    : (article.content ?? article.full_content ?? '')
  const content = decodeEntities(rawContent)

  const feed = article.custom_title ?? article.feed_title ?? article.feed_url
  const favicon = article.feed_favicon
    ? `<img src="${esc(article.feed_favicon)}" onerror="this.style.display='none'" />`
    : ''
  const time = article.published_at ? new Date(article.published_at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
  const readingTime = article.word_count > 0 ? `${Math.ceil(article.word_count / 200)} min read` : ''

  const panel = document.getElementById('article-content')
  panel.classList.remove('empty-state')
  panel.innerHTML = `
    <div class="article-detail-header">
      <div class="article-detail-actions">
        <div class="article-detail-feed">${favicon}<span>${esc(feed)}</span></div>
        <button class="reader-mode-btn ${readerMode ? 'active' : ''}" id="reader-mode-toggle" title="Reader mode">⊡ Reader</button>
        <button class="icon-btn ${article.is_starred ? 'active' : ''}" id="star-btn" title="Star">
          <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" ${article.is_starred ? 'fill="currentColor"' : ''}/></svg>
        </button>
        ${article.url ? `<a href="${esc(article.url)}" target="_blank" rel="noopener" class="icon-btn" title="Open in browser">
          <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>` : ''}
        <button class="icon-btn" id="copy-link-btn" title="Copy link">
          <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <h1 class="article-detail-title">${article.url ? `<a href="${esc(article.url)}" target="_blank" rel="noopener">${esc(article.title ?? '(no title)')}</a>` : esc(article.title ?? '(no title)')}</h1>
      <div class="article-detail-meta">
        ${article.author ? `<span>${esc(article.author)}</span>` : ''}
        ${time ? `<span>${time}</span>` : ''}
        ${readingTime ? `<span class="reading-time">${readingTime}</span>` : ''}
        ${article.url ? `<a href="${esc(article.url)}" target="_blank" rel="noopener">Source ↗</a>` : ''}
      </div>
    </div>
    <div class="article-body">${content || '<p style="color:var(--text-muted)">No content available. <a href="' + esc(article.url ?? '#') + '" target="_blank">Open original</a></p>'}</div>
  `
  panel.scrollTop = 0

  // Reader mode toggle
  document.getElementById('reader-mode-toggle').addEventListener('click', async () => {
    if (!article.full_content && article.url) {
      const btn = document.getElementById('reader-mode-toggle')
      btn.textContent = '⊡ Loading…'
      const res = await GET(`/api/articles/${article.id}/full-content`)
      if (res?.content) {
        article.full_content = res.content
        article.word_count = res.content.split(/\s+/).length
      }
    }
    renderArticleDetail(article, !readerMode)
  })

  // Star button
  document.getElementById('star-btn').addEventListener('click', async () => {
    article.is_starred = article.is_starred ? 0 : 1
    await PATCH(`/api/articles/${article.id}`, { is_starred: !!article.is_starred })
    renderArticleDetail(article, readerMode)
    // Update list item
    const listItem = document.querySelector(`.article-item[data-id="${article.id}"] .article-item-star`)
    const container = document.querySelector(`.article-item[data-id="${article.id}"] .article-item-meta`)
    if (container) {
      const existing = container.querySelector('.article-item-star')
      if (article.is_starred && !existing) container.insertAdjacentHTML('beforeend', '<span class="article-item-star">★</span>')
      else if (!article.is_starred && existing) existing.remove()
    }
    // Update starred count
    state.counts.starred = Math.max(0, (state.counts.starred ?? 0) + (article.is_starred ? 1 : -1))
    if (state.currentView.type === 'starred') loadSidebar()
  })

  // Copy link
  document.getElementById('copy-link-btn').addEventListener('click', () => {
    if (article.url) {
      navigator.clipboard.writeText(article.url).then(() => showToast('Link copied'))
    }
  })
}

// ─── Main handlers ────────────────────────────────────────────────────────────
function setupMainHandlers() {
  // Mobile menu
  document.getElementById('mobile-menu-btn').addEventListener('click', toggleSidebar)
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar)
  document.getElementById('mobile-refresh-btn').addEventListener('click', refreshAll)

  // Search
  const searchInput = document.getElementById('search-input')
  const searchClear = document.getElementById('search-clear')
  let searchTimer
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim()
    searchClear.classList.toggle('hidden', !q)
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      if (q) {
        state.currentView = { type: 'search', query: q }
        updatePanelTitle()
        loadArticles()
      } else {
        state.currentView = { type: 'all' }
        updatePanelTitle()
        loadArticles()
      }
    }, 350)
  })
  searchClear.addEventListener('click', () => {
    searchInput.value = ''
    searchClear.classList.add('hidden')
    state.currentView = { type: 'all' }
    updatePanelTitle()
    loadArticles()
  })

  // Sort
  document.getElementById('sort-btn').addEventListener('click', () => {
    state.sortOrder = state.sortOrder === 'desc' ? 'asc' : 'desc'
    localStorage.setItem('sortOrder', state.sortOrder)
    document.getElementById('sort-icon-desc').classList.toggle('hidden', state.sortOrder === 'asc')
    document.getElementById('sort-icon-asc').classList.toggle('hidden', state.sortOrder === 'desc')
    loadArticles()
  })

  // Mark all read
  document.getElementById('mark-all-read-btn').addEventListener('click', () => markAllRead())

  // Confirm mark-read toggle
  const confirmToggle = document.getElementById('confirm-mark-read-toggle')
  confirmToggle.checked = state.confirmMarkRead
  confirmToggle.addEventListener('change', e => {
    state.confirmMarkRead = e.target.checked
    localStorage.setItem('confirmMarkRead', e.target.checked ? '1' : '0')
  })

  // Scroll mark-read toggle
  const scrollToggle = document.getElementById('scroll-mark-read-toggle')
  scrollToggle.checked = state.scrollMarkRead
  scrollToggle.addEventListener('change', e => {
    state.scrollMarkRead = e.target.checked
    localStorage.setItem('scrollMarkRead', e.target.checked ? '1' : '0')
  })

  // Context menu for article list
  const ctxMenu = document.getElementById('article-context-menu')
  let ctxArticleId = null
  document.getElementById('article-list').addEventListener('contextmenu', e => {
    const item = e.target.closest('.article-item')
    if (!item) return
    e.preventDefault()
    ctxArticleId = Number(item.dataset.id)
    ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px'
    ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 80) + 'px'
    ctxMenu.classList.remove('hidden')
  })
  document.addEventListener('click', () => ctxMenu.classList.add('hidden'))
  document.addEventListener('keydown', e => { if (e.key === 'Escape') ctxMenu.classList.add('hidden') })
  document.getElementById('ctx-mark-above').addEventListener('click', () => markAboveRead(ctxArticleId))
  document.getElementById('ctx-mark-below').addEventListener('click', () => markBelowRead(ctxArticleId))

  // Scroll-to-mark-read listener
  document.getElementById('article-list').addEventListener('scroll', () => {
    if (!state.scrollMarkRead) return
    const list = document.getElementById('article-list')
    const listTop = list.getBoundingClientRect().top
    document.querySelectorAll('.article-item:not(.read)').forEach(el => {
      if (el.getBoundingClientRect().bottom < listTop - 20) {
        const id = Number(el.dataset.id)
        const article = state.articles.find(a => a.id === id)
        if (article && !article.is_read) {
          article.is_read = 1
          el.classList.add('read')
          el.querySelector('.unread-indicator')?.remove()
          const feedCount = state.counts?.feeds?.find(r => r.feed_id === article.feed_id)
          if (feedCount && feedCount.unread > 0) feedCount.unread--
          PATCH(`/api/articles/${id}`, { is_read: true })
        }
      }
    })
    updateUnreadBadge()
  }, { passive: true })

  // Hide read folders toggle
  const hideReadFoldersToggle = document.getElementById('hide-read-folders-toggle')
  hideReadFoldersToggle.checked = state.hideReadFolders
  hideReadFoldersToggle.addEventListener('change', e => {
    state.hideReadFolders = e.target.checked
    localStorage.setItem('hideReadFolders', e.target.checked ? '1' : '0')
    loadSidebar()
  })

  // Unread only toggle
  document.getElementById('toggle-unread-btn').addEventListener('click', () => {
    state.unreadOnly = !state.unreadOnly
    localStorage.setItem('unreadOnly', state.unreadOnly ? '1' : '0')
    document.getElementById('toggle-unread-btn').classList.toggle('active', state.unreadOnly)
    loadArticles()
  })
  document.getElementById('toggle-unread-btn').classList.toggle('active', state.unreadOnly)

  // Add feed
  document.getElementById('add-feed-btn').addEventListener('click', () => openModal('add-feed-modal'))
  document.getElementById('add-feed-form').addEventListener('submit', addFeed)

  // Refresh all
  document.getElementById('refresh-all-btn').addEventListener('click', refreshAll)

  // Manage feeds
  document.getElementById('manage-feeds-btn').addEventListener('click', openManageFeeds)

  // Shortcuts button
  document.getElementById('shortcuts-btn').addEventListener('click', () => openModal('shortcuts-modal'))

  // Settings
  document.getElementById('settings-btn').addEventListener('click', openSettings)

  // Modal close
  document.querySelectorAll('.modal-close, [data-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.modal
      if (id) closeModal(id)
    })
  })
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeAllModals()
  })

  // Settings tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`tab-${tab}`)?.classList.add('active')
    })
  })

  // Appearance settings
  document.getElementById('theme-control').addEventListener('click', async e => {
    const btn = e.target.closest('[data-value]')
    if (!btn) return
    document.querySelectorAll('#theme-control button').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    const res = await PATCH('/api/users/me', { theme: btn.dataset.value })
    if (res) { state.user = res; localStorage.setItem('user', JSON.stringify(res)); applyTheme(res) }
  })

  document.getElementById('accent-swatches').addEventListener('click', async e => {
    const swatch = e.target.closest('.swatch[data-color]')
    if (!swatch) return
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'))
    swatch.classList.add('active')
    const res = await PATCH('/api/users/me', { accent_color: swatch.dataset.color })
    if (res) { state.user = res; localStorage.setItem('user', JSON.stringify(res)); applyTheme(res) }
  })

  document.getElementById('custom-accent').addEventListener('input', async e => {
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'))
    const res = await PATCH('/api/users/me', { accent_color: e.target.value })
    if (res) { state.user = res; localStorage.setItem('user', JSON.stringify(res)); applyTheme(res) }
  })

  document.getElementById('density-control').addEventListener('click', async e => {
    const btn = e.target.closest('[data-value]')
    if (!btn) return
    document.querySelectorAll('#density-control button').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    const res = await PATCH('/api/users/me', { article_view: btn.dataset.value })
    if (res) { state.user = res; localStorage.setItem('user', JSON.stringify(res)); applyTheme(res) }
  })

  document.getElementById('font-family-control').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]')
    if (!btn) return
    document.querySelectorAll('#font-family-control button').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    state.articleFontFamily = btn.dataset.value
    localStorage.setItem('articleFontFamily', btn.dataset.value)
    applyArticleFont()
  })

  const fontSizeInput = document.getElementById('font-size-control')
  const fontSizeLabel = document.getElementById('font-size-label')
  fontSizeInput.addEventListener('input', e => {
    const size = parseInt(e.target.value, 10)
    state.articleFontSize = size
    fontSizeLabel.textContent = size + 'px'
    localStorage.setItem('articleFontSize', size)
    applyArticleFont()
  })

  document.getElementById('ui-size-control').addEventListener('input', e => {
    const size = parseInt(e.target.value, 10)
    state.uiFontSize = size
    document.getElementById('ui-size-label').textContent = size + 'px'
    localStorage.setItem('uiFontSize', size)
    applyLayoutPrefs()
  })

  document.getElementById('sidebar-width-control').addEventListener('input', e => {
    const w = parseInt(e.target.value, 10)
    state.sidebarWidth = w
    document.getElementById('sidebar-width-label').textContent = w + 'px'
    localStorage.setItem('sidebarWidth', w)
    applyLayoutPrefs()
  })

  document.getElementById('list-width-control').addEventListener('input', e => {
    const w = parseInt(e.target.value, 10)
    state.listWidth = w
    document.getElementById('list-width-label').textContent = w + 'px'
    localStorage.setItem('listWidth', w)
    applyLayoutPrefs()
  })

  document.getElementById('public-toggle').addEventListener('change', async e => {
    const res = await PATCH('/api/users/me', { public_view_enabled: e.target.checked })
    if (res) {
      state.user = res
      localStorage.setItem('user', JSON.stringify(res))
      const urlEl = document.getElementById('public-url')
      if (e.target.checked) {
        const url = `${location.origin}/u/${state.user.username}`
        urlEl.innerHTML = `Public URL: <a href="${url}" target="_blank">${url}</a>`
        urlEl.classList.remove('hidden')
      } else {
        urlEl.classList.add('hidden')
      }
    }
  })

  // Password change
  document.getElementById('change-password-form').addEventListener('submit', async e => {
    e.preventDefault()
    const current = document.getElementById('current-pw').value
    const next = document.getElementById('new-pw').value
    const msg = document.getElementById('pw-change-msg')
    const res = await POST('/api/users/me/change-password', { current_password: current, new_password: next })
    msg.classList.remove('hidden', 'error-msg')
    if (res?.token) {
      state.token = res.token
      localStorage.setItem('token', res.token)
      msg.textContent = 'Password changed'
      msg.style.color = 'var(--accent)'
    } else {
      msg.textContent = res?.error ?? 'Failed'
      msg.classList.add('error-msg')
    }
    msg.classList.remove('hidden')
  })

  document.getElementById('logout-btn').addEventListener('click', logout)

  // OPML import
  document.getElementById('opml-import-input').addEventListener('change', async e => {
    const file = e.target.files?.[0]
    if (!file) return
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/opml', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: form,
    }).then(r => r.json())
    const el = document.getElementById('import-result')
    el.textContent = res.error ?? `Imported ${res.imported} feeds${res.failed ? `, ${res.failed} failed` : ''}`
    el.classList.remove('hidden')
    if (res.imported > 0) { loadSidebar(); showToast(`Imported ${res.imported} feeds`) }
  })

  // OPML export link — add auth header via fetch + download
  document.getElementById('opml-export-btn').addEventListener('click', async e => {
    e.preventDefault()
    const res = await fetch('/api/opml', { headers: { Authorization: `Bearer ${state.token}` } })
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${state.user.username}-subscriptions.opml`
    a.click()
  })

  // Add user form
  document.getElementById('add-user-form').addEventListener('submit', async e => {
    e.preventDefault()
    const username = document.getElementById('new-user-username').value.trim()
    const password = document.getElementById('new-user-password').value
    const err = document.getElementById('add-user-error')
    const res = await POST('/api/users/register', { username, password })
    if (res?.token) {
      showToast(`User ${username} created`)
      loadUsersList()
      document.getElementById('new-user-username').value = ''
      document.getElementById('new-user-password').value = ''
      err.classList.add('hidden')
    } else {
      err.textContent = res?.error ?? 'Failed'
      err.classList.remove('hidden')
    }
  })

  // Filter management
  document.getElementById('add-filter-btn').addEventListener('click', () => {
    document.getElementById('filter-form').classList.remove('hidden')
    document.getElementById('add-filter-btn').classList.add('hidden')
  })
  document.getElementById('cancel-filter').addEventListener('click', () => {
    document.getElementById('filter-form').classList.add('hidden')
    document.getElementById('add-filter-btn').classList.remove('hidden')
  })
  document.getElementById('save-filter').addEventListener('click', async () => {
    const name = document.getElementById('filter-name').value.trim()
    const match_field = document.getElementById('filter-field').value
    const keyword = document.getElementById('filter-keyword').value.trim()
    const action = document.getElementById('filter-action').value
    if (!name || !keyword) return
    const res = await POST('/api/users/filters', { name, match_field, keyword, action })
    if (res?.ok) {
      showToast('Filter saved')
      document.getElementById('filter-form').classList.add('hidden')
      document.getElementById('add-filter-btn').classList.remove('hidden')
      loadFiltersList()
    }
  })

  // Edit feed modal
  document.getElementById('edit-feed-form').addEventListener('submit', async e => {
    e.preventDefault()
    const id = document.getElementById('edit-feed-id').value
    const title = document.getElementById('edit-feed-title').value.trim() || null
    const folder = document.getElementById('edit-feed-folder').value.trim() || null
    const refresh_interval = parseInt(document.getElementById('edit-feed-interval').value)
    await PATCH(`/api/feeds/${id}`, { custom_title: title, folder, refresh_interval })
    closeModal('edit-feed-modal')
    showToast('Feed updated')
    loadSidebar()
  })

  document.getElementById('unsubscribe-btn').addEventListener('click', async () => {
    const id = document.getElementById('edit-feed-id').value
    if (!confirm('Unsubscribe from this feed?')) return
    await DELETE(`/api/feeds/${id}`)
    closeModal('edit-feed-modal')
    showToast('Unsubscribed')
    loadSidebar()
    if (state.currentView.type === 'feed' && state.currentView.id === parseInt(id)) {
      state.currentView = { type: 'all' }
      loadArticles()
    }
  })

  setupManageFeedsHandlers()
}

async function addFeed(e) {
  e.preventDefault()
  const url = document.getElementById('add-feed-url').value.trim()
  const folder = document.getElementById('add-feed-folder').value.trim() || undefined
  const btn = document.getElementById('add-feed-submit')
  const err = document.getElementById('add-feed-error')
  err.classList.add('hidden')
  btn.textContent = 'Adding…'
  btn.disabled = true

  const res = await POST('/api/feeds', { url, folder })
  btn.textContent = 'Add feed'
  btn.disabled = false

  if (res?.error) {
    err.textContent = res.error
    err.classList.remove('hidden')
    return
  }

  closeModal('add-feed-modal')
  document.getElementById('add-feed-form').reset()
  showToast('Feed added')
  loadSidebar()
}

async function refreshAll() {
  if (state.refreshing) return
  state.refreshing = true

  const btn = document.getElementById('refresh-all-btn')
  const mobileBtn = document.getElementById('mobile-refresh-btn')
  btn?.querySelector('svg')?.classList.add('spinning')
  mobileBtn?.querySelector('svg')?.classList.add('spinning')

  // Reset error/backoff state for all feeds
  await POST('/api/feeds/refresh-all', {})

  // Fetch each feed individually — each is its own Worker invocation so CPU limits
  // apply per-feed rather than per-batch, which is safe on the free tier.
  const feeds = state.feeds || []
  const total = feeds.length
  let done = 0
  const CONCURRENCY = 10

  for (let i = 0; i < feeds.length; i += CONCURRENCY) {
    const chunk = feeds.slice(i, i + CONCURRENCY)
    await Promise.allSettled(chunk.map(f => POST(`/api/feeds/${f.id}/refresh`, {})))
    done = Math.min(total, i + chunk.length)
    const pct = Math.round((done / total) * 100)
    showToast(`Refreshing… ${done}/${total} (${pct}%)`)
    if (done % 50 === 0 || done === total) loadSidebar()
  }

  state.refreshing = false
  btn?.querySelector('svg')?.classList.remove('spinning')
  mobileBtn?.querySelector('svg')?.classList.remove('spinning')

  await loadSidebar()
  await loadArticles()
  showToast('All feeds refreshed')
}

async function refreshFeed(id) {
  showToast('Refreshing…')
  const res = await POST(`/api/feeds/${id}/refresh`, {})
  await loadSidebar()
  await loadArticles()
  if (res?.error) showToast(`Error: ${res.error}`, 'error')
  else showToast(res?.newItems ? `${res.newItems} new items` : 'Up to date')
}

function editFeed(id) {
  const feed = state.feeds.find(f => f.id === id)
  if (!feed) return
  document.getElementById('edit-feed-id').value = id
  document.getElementById('edit-feed-title').value = feed.custom_title ?? ''
  document.getElementById('edit-feed-folder').value = feed.folder ?? ''
  document.getElementById('edit-feed-interval').value = feed.refresh_interval ?? 1800
  const urlEl = document.getElementById('edit-feed-url')
  urlEl.href = feed.url
  urlEl.textContent = feed.url
  openModal('edit-feed-modal')
}

// ─── Settings modal ───────────────────────────────────────────────────────────
function openSettings() {
  // Populate current values
  const user = state.user
  document.getElementById('account-username').textContent = user.username
  document.getElementById('api-server-url').textContent = location.origin + '/fever/'
  document.getElementById('api-username').textContent = user.username

  // Theme
  document.querySelectorAll('#theme-control button').forEach(b => {
    b.classList.toggle('active', b.dataset.value === (user.theme ?? 'system'))
  })

  // Accent
  document.querySelectorAll('.swatch[data-color]').forEach(s => {
    s.classList.toggle('active', s.dataset.color === user.accent_color)
  })

  // Density
  document.querySelectorAll('#density-control button').forEach(b => {
    b.classList.toggle('active', b.dataset.value === (user.article_view ?? 'comfortable'))
  })

  // Font family
  document.querySelectorAll('#font-family-control button').forEach(b => {
    b.classList.toggle('active', b.dataset.value === state.articleFontFamily)
  })

  // Font size
  const fontSizeInput = document.getElementById('font-size-control')
  const fontSizeLabel = document.getElementById('font-size-label')
  fontSizeInput.value = state.articleFontSize
  fontSizeLabel.textContent = state.articleFontSize + 'px'

  document.getElementById('ui-size-control').value = state.uiFontSize
  document.getElementById('ui-size-label').textContent = state.uiFontSize + 'px'
  document.getElementById('sidebar-width-control').value = state.sidebarWidth
  document.getElementById('sidebar-width-label').textContent = state.sidebarWidth + 'px'
  document.getElementById('list-width-control').value = state.listWidth
  document.getElementById('list-width-label').textContent = state.listWidth + 'px'

  // Reading toggles
  document.getElementById('scroll-mark-read-toggle').checked = state.scrollMarkRead
  // Hide read folders toggle
  document.getElementById('hide-read-folders-toggle').checked = state.hideReadFolders

  // Public toggle
  document.getElementById('public-toggle').checked = !!user.public_view_enabled
  const urlEl = document.getElementById('public-url')
  if (user.public_view_enabled) {
    const url = `${location.origin}/u/${user.username}`
    urlEl.innerHTML = `Public URL: <a href="${url}" target="_blank">${url}</a>`
    urlEl.classList.remove('hidden')
  } else {
    urlEl.classList.add('hidden')
  }

  // Users tab: only visible to admin (user ID 1)
  const isAdmin = state.user?.id === 1
  document.querySelector('.tab-btn[data-tab="users"]')?.classList.toggle('hidden', !isAdmin)
  document.getElementById('add-user-details')?.classList.toggle('hidden', !isAdmin)

  loadFiltersList()
  if (isAdmin) loadUsersList()
  openModal('settings-modal')
}

async function loadFiltersList() {
  const filters = await GET('/api/users/filters')
  const list = document.getElementById('filters-list')
  if (!filters?.length) {
    list.innerHTML = '<p class="hint" style="margin-bottom:.75rem">No filter rules yet</p>'
    return
  }
  list.innerHTML = filters.map(f => `
    <div class="filter-item">
      <div class="filter-item-info">
        <div class="filter-item-name">${esc(f.name)}</div>
        <div class="filter-item-detail">${esc(f.match_field)}: "${esc(f.keyword)}" → ${f.action === 'mark_read' ? 'Mark read' : 'Star'}</div>
      </div>
      <button class="filter-delete" onclick="deleteFilter(${f.id})">✕</button>
    </div>
  `).join('')
}

async function deleteFilter(id) {
  await DELETE(`/api/users/filters/${id}`)
  loadFiltersList()
  showToast('Filter removed')
}

async function loadUsersList() {
  const users = await GET('/api/users/list')
  const list = document.getElementById('users-list')
  if (!users?.length) { list.innerHTML = ''; return }
  list.innerHTML = users.map(u => `
    <div class="user-list-item">
      <span style="flex:1">${esc(u.username)}</span>
      <span style="font-size:.75rem;color:var(--text-faint)">${new Date(u.created_at * 1000).toLocaleDateString()}</span>
      ${u.id !== state.user?.id ? `<button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, '${esc(u.username)}')">Delete</button>` : ''}
    </div>
  `).join('')
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"?`)) return
  if (!confirm(`Are you sure? This will permanently delete "${username}" and all their data.`)) return
  const res = await DELETE(`/api/users/${id}`)
  if (res?.ok) {
    showToast(`User ${username} deleted`)
    loadUsersList()
  } else {
    showToast(res?.error ?? 'Failed to delete user')
  }
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById('modal-overlay').classList.remove('hidden')
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))
  document.getElementById(id).classList.remove('hidden')
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden')
  document.getElementById('modal-overlay').classList.add('hidden')
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))
  document.getElementById('modal-overlay').classList.add('hidden')
}

// ─── Sidebar mobile ───────────────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open')
  document.getElementById('sidebar-overlay').classList.toggle('hidden')
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open')
  document.getElementById('sidebar-overlay').classList.add('hidden')
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    if (e.metaKey || e.ctrlKey) return

    switch (e.key) {
      case 'j': case 'ArrowDown': navigateArticle(1); break
      case 'k': case 'ArrowUp': navigateArticle(-1); break
      case 'r': if (state.selectedArticle) toggleRead(); break
      case 's': if (state.selectedArticle) toggleStar(); break
      case 'o': case 'Enter': if (state.selectedArticle?.url) window.open(state.selectedArticle.url, '_blank'); break
      case '/': e.preventDefault(); document.getElementById('search-input').focus(); break
      case 'Escape':
        if (document.getElementById('modal-overlay').classList.contains('hidden')) {
          // On mobile, close article view
          document.getElementById('article-content-panel').classList.remove('mobile-active')
          closeSidebar()
        }
        closeAllModals()
        break
      case 'R': refreshAll(); break
      case 'u': document.getElementById('toggle-unread-btn').click(); break
      case 'm': markAllRead(); break
      case 'a': document.getElementById('add-feed-btn').click(); break
      case '?': openModal('shortcuts-modal'); break
    }
  })
}

function navigateArticle(dir) {
  const current = state.selectedArticle
  const idx = current ? state.articles.findIndex(a => a.id === current.id) : -1
  const next = state.articles[idx + dir]
  if (next) {
    openArticle(next.id)
    const el = document.querySelector(`.article-item[data-id="${next.id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
}

function toggleRead() {
  const a = state.selectedArticle
  if (!a) return
  a.is_read = a.is_read ? 0 : 1
  PATCH(`/api/articles/${a.id}`, { is_read: !!a.is_read })
  // Update list
  const el = document.querySelector(`.article-item[data-id="${a.id}"]`)
  if (el) {
    el.classList.toggle('read', !!a.is_read)
    if (a.is_read) el.querySelector('.unread-indicator')?.remove()
    else if (!el.querySelector('.unread-indicator')) el.insertAdjacentHTML('afterbegin', '<div class="unread-indicator"></div>')
  }
}

function toggleStar() {
  const a = state.selectedArticle
  if (!a) return
  a.is_starred = a.is_starred ? 0 : 1
  PATCH(`/api/articles/${a.id}`, { is_starred: !!a.is_starred })
  document.getElementById('star-btn')?.classList.toggle('active', !!a.is_starred)
}

// ─── Public view ──────────────────────────────────────────────────────────────
async function showPublicView(username) {
  showScreen('public-screen')
  document.title = `${username}'s reading list`

  const data = await fetch(`/api/public/${username}`).then(r => r.ok ? r.json() : null)
  if (!data) {
    document.getElementById('public-content').innerHTML = '<p>This profile is not public or does not exist.</p>'
    return
  }

  document.getElementById('public-username').textContent = data.username

  let html = ''

  if (data.starred?.length) {
    html += `<div class="public-section"><h2>Starred</h2>`
    html += data.starred.map(a => publicArticle(a)).join('')
    html += `</div>`
  }

  if (data.recentlyRead?.length) {
    html += `<div class="public-section"><h2>Recently read</h2>`
    html += data.recentlyRead.map(a => publicArticle(a)).join('')
    html += `</div>`
  }

  if (data.feeds?.length) {
    html += `<div class="public-section"><h2>Following (${data.feeds.length})</h2>`
    html += `<div class="public-feeds">`
    html += data.feeds.map(f => {
      const favicon = f.favicon_url ? `<img src="${esc(f.favicon_url)}" onerror="this.remove()" />` : ''
      return `<span class="public-feed-tag">${favicon}${esc(f.custom_title ?? f.title ?? f.url)}</span>`
    }).join('')
    html += `</div></div>`
  }

  document.getElementById('public-content').innerHTML = html
}

function publicArticle(a) {
  const meta = [
    a.feed_title,
    a.published_at ? new Date(a.published_at * 1000).toLocaleDateString() : null,
    a.author,
  ].filter(Boolean).join(' · ')
  const favicon = a.favicon_url ? `<img src="${esc(a.favicon_url)}" style="width:12px;height:12px;border-radius:2px" onerror="this.remove()" />` : ''
  return `<div class="public-article">
    <div>${favicon}</div>
    <div>
      <a href="${esc(a.url ?? '#')}" target="_blank" rel="noopener" class="public-article-title">${esc(a.title ?? '(no title)')}</a>
      <div class="public-article-meta">${meta}</div>
    </div>
  </div>`
}

// ─── Mark all read ────────────────────────────────────────────────────────────
async function markAllRead(folder) {
  const v = state.currentView
  const scope = folder ? `folder "${folder}"` : v.type === 'feed' ? 'this feed' : v.type === 'folder' ? `folder "${v.name}"` : 'all articles'
  if (state.confirmMarkRead && !confirm(`Mark all as read in ${scope}?`)) return
  const body = {}
  if (folder) body.folder = folder
  else if (v.type === 'feed') body.feed_id = v.id
  else if (v.type === 'folder') body.folder = v.name
  await POST('/api/articles/mark-all-read', body)
  showToast('Marked all as read')
  state.articles.forEach(a => a.is_read = 1)
  renderArticleList()
  await loadSidebar()
}

async function markFolderRead(folder) {
  await markAllRead(folder)
}

async function markAboveRead(articleId) {
  const idx = state.articles.findIndex(a => a.id === articleId)
  if (idx <= 0) return
  const targets = state.articles.slice(0, idx).filter(a => !a.is_read)
  if (!targets.length) return
  targets.forEach(a => { a.is_read = 1 })
  renderArticleList()
  await POST('/api/articles/mark-read-batch', { ids: targets.map(a => a.id) })
  await loadSidebar()
  showToast(`Marked ${targets.length} article${targets.length !== 1 ? 's' : ''} as read`)
}

async function markBelowRead(articleId) {
  const idx = state.articles.findIndex(a => a.id === articleId)
  if (idx < 0 || idx >= state.articles.length - 1) return
  const targets = state.articles.slice(idx + 1).filter(a => !a.is_read)
  if (!targets.length) return
  targets.forEach(a => { a.is_read = 1 })
  renderArticleList()
  await POST('/api/articles/mark-read-batch', { ids: targets.map(a => a.id) })
  await loadSidebar()
  showToast(`Marked ${targets.length} article${targets.length !== 1 ? 's' : ''} as read`)
}

// ─── Manage feeds modal ───────────────────────────────────────────────────────
function openManageFeeds() {
  state.selectedFeedIds = new Set()
  renderManageFeedsList()
  openModal('manage-feeds-modal')
}

function renderManageFeedsList() {
  const list = document.getElementById('manage-feeds-list')
  const count = document.getElementById('manage-selected-count')
  if (!state.feeds.length) { list.innerHTML = '<p style="padding:.5rem .75rem;color:var(--text-muted)">No feeds</p>'; return }

  list.innerHTML = state.feeds.map(f => {
    const title = esc(f.custom_title ?? f.title ?? f.url)
    const favicon = f.favicon_url ? `<img src="${esc(f.favicon_url)}" onerror="this.style.display='none'" />` : ''
    const folder = f.folder ? `<span class="feed-folder">${esc(f.folder)}</span>` : ''
    const checked = state.selectedFeedIds.has(f.id) ? 'checked' : ''
    return `<label class="manage-feed-item">
      <input type="checkbox" ${checked} onchange="toggleManageFeed(${f.id}, this.checked)" />
      ${favicon}
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span>
      ${folder}
    </label>`
  }).join('')

  count.textContent = `${state.selectedFeedIds.size} selected`
}

function toggleManageFeed(id, checked) {
  if (checked) state.selectedFeedIds.add(id)
  else state.selectedFeedIds.delete(id)
  document.getElementById('manage-selected-count').textContent = `${state.selectedFeedIds.size} selected`
}

async function setupManageFeedsHandlers() {
  document.getElementById('manage-move-btn').addEventListener('click', async () => {
    const ids = [...state.selectedFeedIds]
    if (!ids.length) { showToast('Select feeds first', 'error'); return }
    const folder = document.getElementById('manage-folder-input').value.trim() || null
    await POST('/api/feeds/batch', { ids, action: 'move', folder })
    showToast(folder ? `Moved ${ids.length} feeds to "${folder}"` : `Removed folder from ${ids.length} feeds`)
    closeModal('manage-feeds-modal')
    loadSidebar()
  })

  document.getElementById('manage-unsubscribe-btn').addEventListener('click', async () => {
    const ids = [...state.selectedFeedIds]
    if (!ids.length) { showToast('Select feeds first', 'error'); return }
    if (!confirm(`Unsubscribe from ${ids.length} feed${ids.length > 1 ? 's' : ''}?`)) return
    await POST('/api/feeds/batch', { ids, action: 'unsubscribe' })
    showToast(`Unsubscribed from ${ids.length} feeds`)
    closeModal('manage-feeds-modal')
    loadSidebar()
    if (state.currentView.type === 'feed' && ids.includes(state.currentView.id)) {
      state.currentView = { type: 'all' }
      loadArticles()
    }
  })
}

// ─── Landing ticker ───────────────────────────────────────────────────────────
async function loadTicker() {
  const data = await fetch('/api/public/ticker').then(r => r.ok ? r.json() : []).catch(() => [])
  if (!data?.length) return
  const track = document.getElementById('ticker-track')
  if (!track) return
  // Duplicate items so the seamless loop works
  const items = [...data, ...data]
  track.innerHTML = items.map(a => `
    <div class="ticker-item">
      <span class="ticker-item-title">${esc(a.title ?? '')}</span>
      <span class="ticker-item-feed">${esc(a.feed_title ?? '')}</span>
    </div>`).join('')
  // Adjust animation duration based on item count so speed stays constant
  const duration = Math.max(30, data.length * 2)
  track.style.animationDuration = `${duration}s`
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Decode XML/HTML entities that may have been stored literally (e.g. &lt;p&gt; → <p>)
// so content renders as HTML rather than as escaped text.
function decodeEntities(str) {
  if (!str) return str
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = Date.now()
  const diff = (now - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function svgIcon(name) {
  const icons = {
    inbox: '<path d="M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zM1 11h6l2 3h6l2-3h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    unread: '<circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  }
  return icons[name] ?? ''
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast')
  toast.textContent = msg
  toast.className = `toast ${type}`
  toast.classList.remove('hidden')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 2500)
}

// ─── Start ────────────────────────────────────────────────────────────────────
window.selectView = selectView
window.selectFeed = selectFeed
window.toggleFolder = toggleFolder
window.openArticle = openArticle
window.editFeed = editFeed
window.refreshFeed = refreshFeed
window.deleteFilter = deleteFilter
window.toggleManageFeed = toggleManageFeed
window.markFolderRead = markFolderRead
window.markAboveRead = markAboveRead
window.markBelowRead = markBelowRead

init()
