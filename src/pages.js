import { randomBytes } from 'node:crypto'
import { clearLoginAttempts, clearedSessionCookie, createSession, currentUser, endSession, hashApiToken, hasPermission, recordFailedLogin, requirePermission, requireUser, sessionCookie, sessionToken, userForApiToken } from './auth.js'
import { buildReleaseCalendar } from './ics.js'
import { config } from './config.js'
import {
  ACTIVE_REQUEST_STATUSES,
  ALL_PERMISSIONS,
  MEDIA_STATUS_LABEL,
  MediaStatus,
  MediaType,
  PERMISSION_LABELS,
  Permission,
  Role,
} from './constants.js'
import {
  addServiceProfile,
  approveRequest,
  changePassword,
  createFirstAdmin,
  createUserByAdmin,
  declineRequest,
  deleteRequest,
  deleteUserByAdmin,
  editServiceProfile,
  getCatalog,
  getMediaDetail,
  listRequestsFor,
  markAvailable,
  quotaSummary,
  removeServiceProfile,
  requestMedia,
  retryRequest,
  saveServiceSelection,
  setDefaultServiceProfile,
  updateSettings,
  updateUserByAdmin,
} from './core.js'
import * as store from './db.js'
import { HttpError, parseCookies, readBody, redirect, sendHtml, sendJson } from './http.js'
import { verifyPassword } from './passwords.js'
import {
  createPlexPin,
  plexAccount,
  plexAuthUrl,
  plexLoginEnabled,
  plexPinToken,
  plexProfiles,
  plexSwitchProfile,
  plexWatchlist,
} from './plexauth.js'
import {
  forgetServiceOptions,
  loadServiceOptions,
  serviceLookup,
  serviceProfiles,
  serviceSummary,
  testServiceConnection,
} from './services.js'
import {
  collectionDetails,
  collectionsFor,
  CONTENT_TYPE_IDS,
  contentTypeOptions,
  discoverPage,
  discoverQuery,
  genreList,
  networkOptions,
  networkWithLogo,
  personDetails,
  recommendedTitles,
  searchPage,
  searchTmdb,
  seasonDetails,
  studioOptions,
  studioWithLogo,
  titleDetails,
  tmdbConfigured,
  tmdbDetails,
  trendingPage,
  TYPE_GENRE_IDS,
} from './tmdb.js'
import { forgetPlex, plexEntries, plexEntryFor, plexSettings, testPlexConnection } from './plex.js'
import { syncLibrary, syncState } from './sync.js'
import { downloadQueue } from './services.js'
import { cacheStats, pruneCache } from './cache.js'
import { diagnosticsSnapshot } from './diagnostics.js'
import { importSettings, redactSettings } from './settingsfile.js'
import { sendTestMail } from './notifications.js'
import { upcomingTitles as loadUpcoming, trailerFor } from './tmdb.js'
import { updateNotifications } from './core.js'
import { APP_VERSION as BUILD_VERSION } from './constants.js'
import {
  alert,
  cardRequestDialog,
  collectionCard,
  escapeHtml,
  layout,
  mediaCard,
  pagination,
  poster,
  previewAttrs,
  requestAction,
  requestCard,
  statusBadge,
  themeSelect,
} from './views.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appName() {
  return store.getSetting('app.name')
}

function safeReturn(value, fallback = '/') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** One line describing a service's configuration, never its credentials. */
function serviceLine(summary) {
  if (!summary) return 'not configured'
  if (!summary.enabled) return 'disabled'
  if (!summary.configured) return 'enabled, but no URL or API key saved'
  return `enabled · root folder ${summary.rootFolder || 'not set'} · profile ${summary.qualityProfileName || 'default'}`
}

function withMessage(path, key, text) {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(text)}`
}

function failure(res, returnTo, error) {
  if (!(error instanceof HttpError)) throw error
  redirect(res, withMessage(returnTo, 'err', error.message))
}

function parseType(value) {
  return value === MediaType.MOVIE || value === MediaType.TV ? value : 'all'
}

function pageUser(req, res) {
  const user = currentUser(req)
  if (!user) {
    // An installation with no accounts at all sends visitors to the setup page
    // so the first administrator can be created. Signing in always lands on
    // Discover, so no return path is carried through the login form.
    redirect(res, store.countUsers() === 0 ? '/setup' : '/login')
    return null
  }
  return user
}

function render(res, status, { title, user = null, active = '', body }) {
  // Every page carries the same request dialog, so a Request button never has
  // to leave the page or fall back to a guessed quality profile.
  const requestDialog = user
    ? cardRequestDialog({
        movieProfiles: hasPermission(user, Permission.REQUEST_MOVIE) ? serviceProfiles('radarr') : [],
        tvProfiles: hasPermission(user, Permission.REQUEST_TV) ? serviceProfiles('sonarr') : [],
      })
    : ''

  sendHtml(
    res,
    status,
    layout({
      appName: appName(),
      title,
      user,
      active,
      body: `${body}${requestDialog}`,
      canManageSettings: user ? hasPermission(user, Permission.MANAGE_SETTINGS) : false,
    })
  )
}

function userPermissions(user) {
  return user ? { canManageRequests: hasPermission(user, Permission.MANAGE_REQUESTS), canManageSettings: hasPermission(user, Permission.MANAGE_SETTINGS), canManageUsers: hasPermission(user, Permission.MANAGE_USERS) } : {}
}

// ---------------------------------------------------------------------------
// Auth pages
// ---------------------------------------------------------------------------

function loginPage({ error, notice, plex = false }) {
  return layout({
    appName: appName(),
    title: 'Sign in',
    body: `<section class="auth">
      <h1>Sign in</h1>
      <p class="muted">Request and track media for your library.</p>
      ${alert({ error, notice })}
      <form method="post" action="/login" class="stack">
        <label>Username <input type="text" name="username" required autofocus autocomplete="username" placeholder="username or email" /></label>
        <label>Password <input type="password" name="password" required autocomplete="current-password" /></label>
        <button class="btn" type="submit">Sign in</button>
      </form>
      ${plex ? plexButton('Continue with Plex') : ''}
    </section>`,
  })
}

function setupPage({ appName, error, values = {}, plex = false }) {
  return layout({
    appName,
    title: 'Create your account',
    body: `<section class="auth">
      <h1>Welcome to ${escapeHtml(appName)}</h1>
      <p class="muted">No accounts exist yet. The first account you create is the administrator, and can invite everyone else.</p>
      ${alert({ error })}
      <form method="post" action="/setup" class="stack">
        <label>Email <input type="email" name="email" value="${escapeHtml(values.email ?? '')}" required autofocus /></label>
        <label>Username <input type="text" name="username" value="${escapeHtml(values.username ?? '')}" required minlength="3" maxlength="40" autocomplete="username" /></label>
        <label>Password <input type="password" name="password" required minlength="6" autocomplete="new-password" /></label>
        <button class="btn" type="submit">Create administrator</button>
      </form>
      <p class="muted small">Sign in from then on with your username (or email) and password.</p>
      ${plex ? plexButton('Create my account with Plex') : ''}
    </section>`,
  })
}


// ---------------------------------------------------------------------------
// Signing in with Plex
// ---------------------------------------------------------------------------

const PLEX_PIN_COOKIE = 'discovarr_plex_pin'
const PLEX_TOKEN_COOKIE = 'discovarr_plex_token'
const PLEX_COOKIE_PATH = '/auth/plex'
const PLEX_COOKIE_MAX_AGE = 600

function shortLivedCookie(name, value, req, maxAge = PLEX_COOKIE_MAX_AGE) {
  const forwarded = String(req?.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  const secure = config.cookieSecure || forwarded === 'https'

  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${PLEX_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

function clearShortCookie(name) {
  return `${name}=; Path=${PLEX_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** The public origin the browser used, so Plex can send it back here. */
function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
  const proto = forwardedProto || (config.cookieSecure ? 'https' : 'http')
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1')
    .split(',')[0]
    .trim()

  return `${proto}://${host}`
}

function plexButton(label) {
  return `<div class="auth-alt">
    <p class="muted small">or use the Plex account your library is shared with</p>
    <a class="btn btn-plex" href="/auth/plex">${escapeHtml(label)}</a>
  </div>`
}

function initialsOf(text) {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'P'
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join('')
}

function plexProfilePage({ profiles, error = '' }) {
  const card = (profile) => {
    const who = `<span class="plex-avatar" aria-hidden="true">${escapeHtml(initialsOf(profile.title))}</span>
            <span class="plex-profile-name">${escapeHtml(profile.title)}</span>
            ${profile.admin ? '<span class="muted small">owner</span>' : ''}`

    // A profile with a Plex Home PIN keeps it, so nobody borrows the rights of
    // whichever profile in the household happens to be unlocked.
    if (profile.protected) {
      return `<div class="plex-profile plex-profile-locked">
            ${who}
            <input class="plex-pin" type="password" name="pin-${escapeHtml(profile.uuid)}" inputmode="numeric"
              autocomplete="off" maxlength="4" pattern="[0-9]*" placeholder="PIN"
              aria-label="PIN for ${escapeHtml(profile.title)}" />
            <button class="btn btn-sm" type="submit" name="uuid" value="${escapeHtml(profile.uuid)}">Sign in</button>
          </div>`
    }

    return `<button class="plex-profile" type="submit" name="uuid" value="${escapeHtml(profile.uuid)}">
            ${who}
          </button>`
  }

  return layout({
    appName: appName(),
    title: 'Choose a profile',
    body: `<section class="auth auth-wide">
      <h1>Who's watching?</h1>
      <p class="muted">Pick the profile this Discovarr account belongs to. A profile with a PIN asks for it first.</p>
      ${error ? `<p class="alert alert-err">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/auth/plex/profile">
        <div class="plex-profiles">${profiles.map(card).join('')}</div>
      </form>
    </section>`,
  })
}

function uniqueUsername(base) {
  const clean =
    String(base ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '')
      .replace(/^[._-]+/, '') || 'plex'
  const trimmed = clean.slice(0, 30)
  if (!store.findUserByUsername(trimmed)) return trimmed

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${trimmed.slice(0, 27)}-${suffix}`
    if (!store.findUserByUsername(candidate)) return candidate
  }

  return `plex-${randomBytes(4).toString('hex')}`
}

/** The local account behind a Plex profile, created on first sign-in. */
function localUserForPlex(account) {
  const plexId = String(account.id ?? '').trim()

  if (plexId) {
    const linked = store.findUserByPlexId(plexId)
    if (linked) return linked
  }

  const email = String(account.email ?? '').trim().toLowerCase()
  if (email) {
    const existing = store.findUserByEmail(email)
    // An administrator links a Plex account deliberately, never just because
    // whoever owns that address on plex.tv signs in.
    if (existing && existing.role !== Role.ADMIN) {
      store.linkUserPlex(existing.id, plexId)
      return store.findUserById(existing.id)
    }
  }

  const firstAccount = store.countUsers() === 0
  const address =
    email && !store.findUserByEmail(email) ? email : `${plexId || randomBytes(6).toString('hex')}@plex.local`

  const created = store.createUser({
    email: address,
    username: uniqueUsername(account.username || account.title || 'plex'),
    // Plex is the only way in for this account, so the password is unknowable.
    password: randomBytes(24).toString('base64url'),
    role: firstAccount ? Role.ADMIN : Role.USER,
    permissions: firstAccount ? ALL_PERMISSIONS : DEFAULT_USER_PERMISSIONS,
  })

  store.linkUserPlex(created.id, plexId)
  return store.findUserById(created.id)
}

/**
 * Copies the Plex profile's watchlist into the local one. Sign-in never waits
 * for Plex's discovery host, and only titles that are not already saved are
 * added, so signing in twice changes nothing.
 */
async function importPlexWatchlist(user, token) {
  if (store.getSetting('plex.importWatchlist') !== 'true') return 0

  try {
    const items = await plexWatchlist(token)
    let imported = 0

    for (const item of items) {
      if (store.isWatched(user.id, item.tmdbId, item.mediaType)) continue
      store.toggleWatchlist(user.id, item)
      imported += 1
    }

    if (imported) store.recordAudit(user.id, 'watchlist.plex_import', `${imported} title(s) from Plex`)
    return imported
  } catch (error) {
    // A watchlist Plex will not share is not a reason to fail the sign-in.
    console.warn(`[discovarr] Plex watchlist import failed: ${error.message}`)
    return 0
  }
}

async function finishPlexSignIn({ req, res, token, profile = null }) {
  let account = null
  try {
    account = await plexAccount(token)
  } catch {
    account = null
  }

  if (!account?.id && profile) {
    account = { id: `home-${profile.uuid}`, username: profile.title, email: '', title: profile.title }
  }

  const user = localUserForPlex(account ?? { id: '', username: 'plex', email: '', title: 'Plex user' })
  const session = createSession(user.id)
  store.recordAudit(user.id, 'auth.plex_login', account?.username || user.username)

  // The profile's token is only in hand right now, so this is the moment its
  // watchlist can be copied over.
  void importPlexWatchlist(user, token)

  redirect(res, '/', {
    'set-cookie': [
      sessionCookie(session, req),
      clearShortCookie(PLEX_PIN_COOKIE),
      clearShortCookie(PLEX_TOKEN_COOKIE),
    ],
  })
}

// ---------------------------------------------------------------------------
// Discover and detail
// ---------------------------------------------------------------------------

const BROWSE_LINKS = Object.freeze([
  ['networks', '/networks', 'Networks'],
  ['studios', '/studios', 'Studios'],
  ['movie-genres', '/genres/movie', 'Movie Genres'],
  ['tv-genres', '/genres/tv', 'Series Genres'],
  ['recommendations', '/recommendations', 'Recommendations'],
])

const SORT_TABS = Object.freeze([
  ['popular', 'Popular'],
  ['new', 'Recently released'],
  ['upcoming', 'Upcoming'],
  ['rating', 'Highest rated'],
])

const LANGUAGES = Object.freeze([
  ['', 'Any language'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['hi', 'Hindi'],
  ['pt', 'Portuguese'],
  ['zh', 'Chinese'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
])

const RATINGS = Object.freeze([
  ['', 'Any rating'],
  ['6', '6 or more'],
  ['7', '7 or more'],
  ['8', '8 or more'],
  ['9', '9 or more'],
])

const VOTES = Object.freeze([
  ['', 'Any votes'],
  ['100', '100+ votes'],
  ['500', '500+ votes'],
  ['1000', '1,000+ votes'],
  ['5000', '5,000+ votes'],
])

// Titles per page in the Discover and browse grids.
const PER_PAGE = 24

function sortKey(value) {
  return SORT_TABS.some(([key]) => key === value) ? value : 'popular'
}

function pageNumber(value) {
  const page = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(page) && page > 0 ? page : 1
}

/**
 * Multi-select filters arrive either repeated (?genre=18&genre=35, straight
 * from the toggles) or joined (?genre=18,35 from the pager), so both shapes
 * are flattened into one list of ids.
 */
function parseIds(value) {
  const parts = [].concat(value ?? []).flatMap((entry) => String(entry).split(/[,|]/))
  return [...new Set(parts.map((part) => part.trim()).filter((part) => /^\d+$/.test(part)))]
}

/** Content-type switches (?kind=anime) are named, not numbered. */
function parseKinds(value) {
  const parts = [].concat(value ?? []).flatMap((entry) => String(entry).split(','))
  return [...new Set(parts.map((part) => part.trim()).filter((part) => CONTENT_TYPE_IDS.has(part)))]
}

/** Reads the right-hand filter panel out of the query string. */
function filtersFromParams(params) {
  const number = (key, min, max) => {
    const value = Number.parseInt(String(params.get(key) ?? ''), 10)
    return Number.isFinite(value) && value >= min && value <= max ? value : null
  }

  const language = String(params.get('lang') ?? '')
  return {
    kinds: parseKinds(params.getAll('kind')),
    genres: parseIds(params.getAll('genre')),
    networks: parseIds(params.getAll('network')),
    studios: parseIds(params.getAll('studio')),
    // A film-only switch: only titles that belong to a collection.
    collections: params.get('collections') === '1',
    from: number('from', 1900, 2100),
    to: number('to', 1900, 2100),
    rating: number('rating', 0, 10),
    votes: number('votes', 0, 100000),
    language: /^[a-z]{2}$/.test(language) ? language : '',
    sort: sortKey(params.get('sort')),
  }
}

function hasFilters(filters) {
  return Boolean(
    filters.kinds.length ||
    filters.genres.length ||
      filters.networks.length ||
      filters.studios.length ||
      filters.collections ||
      filters.from ||
      filters.to ||
      filters.rating ||
      filters.votes ||
      filters.language
  )
}

/** The filter state as query parameters, for page links and the pager. */
function filterParams(filters) {
  return {
    kind: filters.kinds.join(','),
    genre: filters.genres.join(','),
    network: filters.networks.join('|'),
    studio: filters.studios.join('|'),
    collections: filters.collections ? '1' : '',
    sort: filters.sort === 'popular' ? '' : filters.sort,
    from: filters.from ?? '',
    to: filters.to ?? '',
    rating: filters.rating ?? '',
    votes: filters.votes ?? '',
    lang: filters.language,
  }
}

/** Builds a query string, dropping empty values so links stay tidy. */
function browseHref(basePath, params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    search.set(key, String(value))
  }
  return `${basePath}${search.size ? `?${search}` : ''}`
}

function browseNav(browse) {
  return `<aside class="browse-nav">
    <div class="browse-head">
      <p class="browse-heading">Browse</p>
      <button class="panel-hide" type="button" data-panel="nav" aria-pressed="true" aria-label="Hide menu" title="Hide menu">&#8249;</button>
    </div>
    <a class="browse-link ${browse ? '' : 'is-active'}" href="/">Discover</a>
    ${BROWSE_LINKS.map(
      ([key, href, label]) =>
        `<a class="browse-link ${browse === key ? 'is-active' : ''}" href="${href}">${label}</a>`
    ).join('')}
  </aside>`
}

function discoverLayout(browse, body, rail = '') {
  // Each sidebar hides itself from a button in its own header. These two only
  // appear while a panel is folded away, so there is always a way back without
  // a strip of controls taking up room above the grid.
  const restore = `<div class="panel-restore">
      <button class="panel-toggle" type="button" data-panel="nav" aria-pressed="false" aria-label="Show menu" title="Show menu">&#9776; Menu</button>
      ${rail ? '<button class="panel-toggle" type="button" data-panel="rail" aria-pressed="false" aria-label="Show filters" title="Show filters">Filters</button>' : ''}
    </div>`

  return `<div class="discover${rail ? ' has-rail' : ''}">${browseNav(browse)}<div class="discover-main">${restore}${body}</div>${rail}</div>`
}

function plexFor(plex, mediaType, tmdbId) {
  return plexEntryFor(plex, mediaType, tmdbId)
}

/** A poster grid, with each title linked to its local record when it exists. */
/** How many pages of results the collections view reads to fill its grid. */
const COLLECTION_SCAN_PAGES = 3

/**
 * The sets behind a filtered browse. One page of films holds two or three
 * franchises, which left the grid nearly empty; the scan reads a few pages of
 * results and groups every film, so the collections view fills the page the way
 * the film grid does.
 */
async function scanCollections({ mediaType, filters, first = [], totalPages = 1 }) {
  const films = [...first]
  const last = Math.min(COLLECTION_SCAN_PAGES, Math.max(1, Number(totalPages) || 1))

  for (let page = 2; page <= last; page += 1) {
    try {
      const more = await discoverPage(mediaType, discoverQuery(mediaType, filters, filters.sort), {
        page,
        sort: filters.sort,
      })
      if (!more.items.length) break
      films.push(...more.items)
    } catch {
      // A later page failing still leaves a usable grid from the pages we have.
      break
    }
  }

  return { films: films.length, collections: await collectionsFor(films) }
}

function mediaGrid(items, { returnTo = '/', plex = {} } = {}) {
  if (!items.length) return '<p class="empty">Nothing found.</p>'

  return `<div class="grid" data-fill>${items
    .map((item) => {
      const local = store.getMediaByTmdb(item.tmdbId, item.mediaType)
      return mediaCard(item, { returnTo, local, plex: plexFor(plex, item.mediaType, item.tmdbId) })
    })
    .join('')}</div>`
}

function brandLogo(name, logoPath) {
  const inner = logoPath
    ? `<img src="${escapeHtml(artwork(logoPath, 'w154'))}" alt="${escapeHtml(name)} logo" loading="lazy" />`
    : `<span class="logo-fallback">${escapeHtml(initials(name))}</span>`

  return `<span class="brand-logo">${inner}</span>`
}

function toggleField(name, value, label, checked) {
  const type = name === 'type' ? 'radio' : 'checkbox'
  return `<label class="toggle"><input type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(
    value
  )}"${checked ? ' checked' : ''} /><span>${escapeHtml(label)}</span></label>`
}

function selectField(name, label, options, current) {
  const value = current === null || current === undefined ? '' : String(current)
  const known = options.some(([option]) => option === value)

  return `<label class="rail-field">${escapeHtml(label)}
    <select name="${escapeHtml(name)}">
      ${known ? '' : `<option value="${escapeHtml(value)}" selected>${escapeHtml(value || 'Any')}</option>`}
      ${options
        .map(
          ([option, text]) =>
            `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(text)}</option>`
        )
        .join('')}
    </select>
  </label>`
}

function toggleList(name, options, selected, scroll = false) {
  return `<div class="toggle-list${scroll ? ' toggle-scroll' : ''}">${options
    .map((option) =>
      toggleField(name, option.id, option.name, selected.some((id) => String(id) === String(option.id)))
    )
    .join('')}</div>`
}

function railGroup(title, count, open, body) {
  if (!body) return ''

  return `<details class="rail-group" data-group="${escapeHtml(title)}"${open ? ' open' : ''}>
    <summary>${escapeHtml(title)}${count ? `<span class="rail-count">${escapeHtml(count)}</span>` : ''}</summary>
    ${body}
  </details>`
}

/**
 * The right-hand filter panel: genres, studios and networks as toggles, plus
 * year, rating, vote, language and sort controls. It is a plain GET form, so it
 * works without JavaScript; the page script applies it on every change.
 */
function filterRail({
  action,
  mediaType,
  filters,
  genres,
  networks = [],
  studios = [],
  types = [],
  typeSwitch = false,
  clearHref,
}) {
  const isTv = mediaType === MediaType.TV
  // Series are filtered by the date they first aired and films by their release
  // date, so the year boxes move into their own group for television.
  const advancedCount = [
    isTv ? '' : filters.from,
    isTv ? '' : filters.to,
    filters.rating,
    filters.votes,
    filters.language,
    filters.sort !== 'popular' ? '1' : '',
  ].filter(Boolean).length

  const yearField = (label, fromLabel, toLabel) => `<div class="rail-field">
      <span>${escapeHtml(label)}</span>
      <div class="rail-years">
        <input type="number" name="from" min="1900" max="2100" step="1" placeholder="From" aria-label="${escapeHtml(
          fromLabel
        )}" value="${filters.from ?? ''}" />
        <span class="muted small">–</span>
        <input type="number" name="to" min="1900" max="2100" step="1" placeholder="To" aria-label="${escapeHtml(
          toLabel
        )}" value="${filters.to ?? ''}" />
      </div>
    </div>`

  const advanced = `<div class="rail-advanced">
    ${isTv ? '' : yearField('Released between', 'Released from year', 'Released up to year')}
    ${selectField('rating', 'Minimum rating', RATINGS, filters.rating ?? '')}
    ${selectField('votes', 'Minimum votes', VOTES, filters.votes ?? '')}
    ${selectField('lang', 'Original language', LANGUAGES, filters.language)}
    ${selectField('sort', 'Sort by', SORT_TABS, filters.sort)}
  </div>`

  const brandGroup =
    mediaType === MediaType.MOVIE
      ? railGroup(
          'Studios',
          filters.studios.length,
          filters.studios.length > 0,
          toggleList('studio', studios, filters.studios)
        )
      : railGroup(
          'Networks',
          filters.networks.length,
          filters.networks.length > 0,
          toggleList('network', networks, filters.networks, true)
        )

  // The broadcast window: only series have an air date to filter on.
  const airedGroup = isTv
    ? railGroup(
        'Aired on TV',
        filters.from || filters.to ? '1' : '',
        true,
        yearField('First aired between', 'First aired from year', 'First aired up to year')
      )
    : ''

  const typeRow = typeSwitch
    ? `<div class="rail-types" role="group" aria-label="Media type">
        ${toggleField('type', MediaType.MOVIE, 'Movies', mediaType === MediaType.MOVIE)}
        ${toggleField('type', MediaType.TV, 'Series', mediaType === MediaType.TV)}
      </div>`
    : ''

  // TMDB has no collections for series, so the switch only appears for films.
  const collectionRow =
    mediaType === MediaType.MOVIE
      ? `<div class="rail-collections">${toggleField(
          'collections',
          '1',
          'Collections only',
          Boolean(filters.collections)
        )}</div>`
      : ''

  return `<form class="filter-rail" method="get" action="${escapeHtml(action)}" data-filter-form>
    <div class="rail-head">
      <strong>Filters</strong>
      <div class="rail-head-actions">
        <a class="rail-clear" href="${escapeHtml(clearHref ?? action)}">Clear all</a>
        <button class="panel-hide" type="button" data-panel="rail" aria-pressed="true" aria-label="Hide filters" title="Hide filters">&#8250;</button>
      </div>
    </div>
    ${typeRow}
    ${collectionRow}
    ${railGroup('Type', filters.kinds.length, filters.kinds.length > 0, toggleList('kind', types, filters.kinds))}
    ${railGroup(
      'Genres',
      filters.genres.length,
      true,
      toggleList(
        'genre',
        genres.filter((genre) => !TYPE_GENRE_IDS.has(Number(genre.id))),
        filters.genres
      )
    )}
    ${brandGroup}
    ${airedGroup}
    ${railGroup('Advanced', advancedCount, advancedCount > 0, advanced)}
    <button class="btn btn-sm rail-apply" type="submit">Apply filters</button>
    <p class="muted small">Toggles apply straight away; year and number fields with the button.</p>
  </form>`
}

/** The Discover panel: a media-type switch plus the shared filter rail. */
async function discoverRail(mediaType, filters) {
  const genres = await genreList(mediaType).catch(() => [])

  return filterRail({
    action: '/',
    mediaType,
    filters,
    genres,
    networks: networkOptions(),
    studios: studioOptions(),
    types: contentTypeOptions(mediaType),
    typeSwitch: true,
    clearHref: '/',
  })
}

function browseUnavailable(what) {
  return `<div class="page-head">
      <div>
        <h1>${escapeHtml(what)}</h1>
        <p class="muted">This view is built from TMDB metadata.</p>
      </div>
    </div>
    <section class="panel">
      <p>Add a TMDB API key under
        <a class="inline-link" href="/settings?tab=integrations">Settings → Integrations</a>
        to browse ${escapeHtml(what.toLowerCase())}.</p>
    </section>`
}

function discoverBody({
  user,
  type,
  query,
  source,
  items,
  page = 1,
  totalPages = 1,
  error,
  plex = {},
  rail = '',
  filtered = false,
  filters = null,
  collections = null,
}) {
  const tabs = [
    ['all', 'All'],
    ['movie', 'Movies'],
    ['tv', 'Series'],
  ]

  const tabLinks = tabs
    .map(([key, label]) => {
      const params = new URLSearchParams()
      if (key !== 'all') params.set('type', key)
      if (query) params.set('q', query)
      return `<a class="tab ${type === key ? 'is-active' : ''}" href="/${params.toString() ? `?${params}` : ''}">${label}</a>`
    })
    .join('')

  // With the collections switch on the grid shows the sets, not the films.
  const collectionGrid =
    filters?.collections && Array.isArray(collections)
      ? collections.length
        ? `<div class="grid">${collections.map((collection) => collectionCard(collection)).join('')}</div>`
        : '<p class="empty">No collections match these filters.</p>'
      : null

  const grid =
    collectionGrid ??
    (items.length
      ? `<div class="grid" data-fill>${items
          .map(({ item, local }) =>
            mediaCard(item, {
              returnTo: '/',
              local,
              plex: plexFor(plex, item.mediaType, item.tmdbId),
            })
          )
          .join('')}</div>`
      : `<p class="empty">Nothing found. ${
          source === 'local'
            ? 'Add a TMDB API key in settings to search the full catalog.'
            : 'Try a wider filter.'
        }</p>`)

  const subtitle = query
    ? 'Request anything you find for the library.'
    : filtered
      ? 'Filtered with the panel on the right — change it any time.'
      : source === 'tmdb'
        ? 'Trending on TMDB — request anything for the library.'
        : 'Local catalog (offline demo data).'

  const narrowed = filtered && filters?.collections ? ' Only collections that match these filters.' : ''

  return discoverLayout(
    '',
    `<div class="page-head">
      <div>
        <h1>${query ? `Results for “${escapeHtml(query)}”` : 'Discover'}</h1>
        <p class="muted">${escapeHtml(`${subtitle}${narrowed}`)}</p>
      </div>
      <form class="search" method="get" action="/" data-suggest="/search/suggest">
        ${type !== 'all' ? `<input type="hidden" name="type" value="${escapeHtml(type)}" />` : ''}
        <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search titles" aria-label="Search titles" />
        <button class="btn btn-ghost" type="submit">Search</button>
      </form>
    </div>
    ${alert({ error })}
    ${query || filtered ? '' : `<div class="tabs">${tabLinks}</div>`}
    ${grid}
    ${
      filters?.collections
        ? ''
        : pagination({
            page,
            totalPages,
            basePath: '/',
            params: {
              type: type === 'all' ? '' : type,
              q: query,
              ...(filtered && filters ? filterParams(filters) : {}),
            },
          })
    }`,
    rail
  )
}

/**
 * The shared browse page for networks, studios and genre lists. The old pages
 * printed a wall of every logo or genre above the results; those lists now live
 * in the right-hand rail as toggles, so the grid gets the whole page.
 */
async function catalogueBody({ browse, basePath, mediaType, filters, page = 1, plex }) {
  const isMovie = mediaType === MediaType.MOVIE
  const label =
    browse === 'networks' ? 'Networks' : browse === 'studios' ? 'Studios' : isMovie ? 'Movie genres' : 'Series genres'

  if (!tmdbConfigured()) return discoverLayout(browse, browseUnavailable(label))

  const genres = await genreList(mediaType).catch(() => [])
  const types = contentTypeOptions(mediaType)
  const brands = isMovie ? studioOptions() : networkOptions()
  const brandIds = isMovie ? filters.studios : filters.networks

  const brandNames = brandIds
    .map((id) => brands.find((brand) => String(brand.id) === String(id))?.name)
    .filter(Boolean)
  const genreNames = genres
    .filter((genre) => filters.genres.some((id) => String(id) === String(genre.id)))
    .map((genre) => genre.name)
  const typeNames = types.filter((type) => filters.kinds.includes(type.id)).map((type) => type.name)

  const leading = [...typeNames, ...genreNames]
  const noun = isMovie ? 'Films' : 'Series'
  const title = brandNames.length ? brandNames.join(' + ') : leading.length ? leading.join(' + ') : label
  const subtitle = brandNames.length
    ? `${leading.length ? `${leading.join(' + ')} ${noun.toLowerCase()}` : noun} from ${brandNames.join(', ')}.`
    : leading.length
      ? `${noun} in ${leading.join(' + ')}.`
      : `Every ${isMovie ? 'film' : 'series'} we can find, most popular first — narrow it with the panel on the right.`

  const brand = brandIds.length === 1 ? brands.find((entry) => String(entry.id) === String(brandIds[0])) : null
  const logo = brand ? await (isMovie ? studioWithLogo : networkWithLogo)(brand) : null

  const collectionMode = filters.collections && isMovie
  const result = await discoverPage(mediaType, discoverQuery(mediaType, filters, filters.sort), {
    // The collections view fills its grid from several result pages, so it has
    // no pager of its own rather than reading the same films twice.
    page: collectionMode ? 1 : page,
    sort: filters.sort,
  })
  // TMDB cannot filter on collections, so the grid is built here: the films the
  // filters returned, grouped into the collections they belong to.
  const scanned = collectionMode
    ? await scanCollections({
        mediaType,
        filters,
        first: result.items,
        totalPages: result.totalPages,
      })
    : null
  const collections = scanned?.collections ?? []
  const items = collectionMode ? [] : result.items
  const collectionNote = collectionMode
    ? ` Only collections that match these filters, grouped from the top ${scanned.films} matches.`
    : ''

  const head = logo
    ? `<div class="brand-head">
        ${brandLogo(logo.name, logo.logoPath)}
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p class="muted">${escapeHtml(`${subtitle}${collectionNote}`)}</p>
        </div>
      </div>`
    : `<div class="page-head">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p class="muted">${escapeHtml(`${subtitle}${collectionNote}`)}</p>
        </div>
      </div>`

  const grid = collectionMode
    ? collections.length
      ? `<div class="grid">${collections.map((collection) => collectionCard(collection)).join('')}</div>`
      : '<p class="empty">No collections match these filters.</p>'
    : mediaGrid(items, { returnTo: browseHref(basePath, filterParams(filters)), plex })

  return discoverLayout(
    browse,
    `${head}
    ${grid}
    ${
      collectionMode
        ? ''
        : pagination({
            page: result.page,
            totalPages: result.totalPages,
            basePath,
            params: filterParams(filters),
          })
    }`,
    filterRail({
      action: basePath,
      mediaType,
      filters,
      genres,
      networks: networkOptions(),
      studios: studioOptions(),
      types,
      clearHref: basePath,
    })
  )
}

async function recommendationsBody({ user, plex }) {
  if (!tmdbConfigured()) return discoverLayout('recommendations', browseUnavailable('Recommendations'))

  const seeds = []
  const seen = new Set()
  const addSeed = (mediaType, tmdbId, title, why) => {
    if (!tmdbId || !title) return
    const key = `${mediaType}:${tmdbId}`
    if (seen.has(key)) return
    seen.add(key)
    seeds.push({ mediaType, tmdbId, title, why })
  }

  // The library speaks first: what a household actually watches says more about
  // its taste than what it once asked for. The watchlist and requests fill the
  // gaps while a library is still small.
  for (const media of store.listMedia({})) {
    if (media.status === MediaStatus.AVAILABLE) addSeed(media.mediaType, media.tmdbId, media.title, 'library')
  }
  for (const saved of store.listWatchlist(user.id)) {
    addSeed(saved.mediaType, saved.tmdbId, saved.title, 'watchlist')
  }
  for (const request of store.listRequests({ userId: user.id, take: 8 })) {
    if (request.media?.tmdbId) addSeed(request.media.mediaType, request.media.tmdbId, request.media.title, 'requested')
  }

  const chosen = seeds.slice(0, 3)
  const items = await recommendedTitles(chosen.map(({ mediaType, tmdbId }) => ({ mediaType, tmdbId })))

  const titles = chosen.map((seed) => seed.title).join(', ')
  const reason = !chosen.length
    ? 'Popular titles to start with — request a few and this page follows your taste.'
    : chosen[0].why === 'library'
      ? `Because ${titles} ${chosen.length === 1 ? 'is' : 'are'} in your library.`
      : chosen[0].why === 'watchlist'
        ? `Because you saved ${titles}.`
        : `Because you requested ${titles}.`

  return discoverLayout(
    'recommendations',
    `<div class="page-head">
      <div>
        <h1>Recommendations</h1>
        <p class="muted">${escapeHtml(reason)}</p>
      </div>
    </div>
    ${mediaGrid(items, { returnTo: '/recommendations', plex })}`
  )
}

function formatDate(value) {
  return value ? String(value).slice(0, 10) : null
}

function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()
}

function artwork(path, size) {
  return `/img/${size}/${escapeHtml(String(path).replace(/^\//, ''))}`
}

function providerGroups(watch) {
  return [
    ['Streaming', watch.flatrate],
    ['Free', watch.free],
    ['Rent', watch.rent],
    ['Buy', watch.buy],
  ].filter(([, providers]) => providers.length > 0)
}

function watchPanel(details) {
  const watch = details?.watch
  if (!watch) return ''

  const groups = providerGroups(watch)

  return `<section class="panel">
    <h2 style="margin: 0">Where to watch</h2>
    ${
      groups.length
        ? groups
            .map(
              ([label, providers]) => `<div class="provider-group">
              <p class="muted small">${escapeHtml(label)}</p>
              <div class="providers">
                ${providers
                  .map(
                    (provider) => `<span class="provider" title="${escapeHtml(provider.name)}">
                      ${provider.logoPath ? `<img src="${artwork(provider.logoPath, 'w92')}" alt="" loading="lazy" />` : ''}
                      <span>${escapeHtml(provider.name)}</span>
                    </span>`
                  )
                  .join('')}
              </div>
            </div>`
            )
            .join('')
        : `<p class="muted small">No streaming, rental or purchase options listed for ${escapeHtml(watch.region)}.</p>`
    }
    <p class="muted small">Availability for ${escapeHtml(watch.region)} from JustWatch${
      watch.link
        ? ` · <a class="inline-link" href="${escapeHtml(watch.link)}" target="_blank" rel="noreferrer noopener">all options</a>`
        : ''
    }</p>
  </section>`
}

function castPanel(details) {
  if (!details?.cast?.length) return ''

  return `<section class="panel">
    <h2 style="margin: 0">Cast</h2>
    <div class="cast-grid">
      ${details.cast
        .map((member) => {
          // TMDB has no headshot for plenty of character actors, so those tiles
          // borrow a still from one of that person's own titles instead of
          // showing initials.
          const image = member.profilePath ?? member.artworkPath ?? null
          const borrowed = !member.profilePath && Boolean(member.artworkPath)
          return `<a class="cast" href="/person/${escapeHtml(member.id)}">
            ${
              image
                ? `<img class="cast-photo${borrowed ? ' cast-photo-borrowed' : ''}" src="${artwork(
                    image,
                    'w185'
                  )}" alt="" loading="lazy" />`
                : `<span class="cast-photo cast-photo-empty">${escapeHtml(initials(member.name))}</span>`
            }
            <strong>${escapeHtml(member.name)}</strong>
            ${member.character ? `<span class="muted small">${escapeHtml(member.character)}</span>` : ''}
          </a>`
        })
        .join('')}
    </div>
  </section>`
}

/** One person: photo, biography and every title they are credited in. */
function personBody({ person, page = 1, plex = {} }) {
  const totalPages = Math.max(1, Math.ceil(person.credits.length / PER_PAGE))
  const current = Math.min(page, totalPages)
  const credits = person.credits.slice((current - 1) * PER_PAGE, current * PER_PAGE)

  const born = [formatDate(person.birthday), person.placeOfBirth].filter(Boolean).join(' · ')
  const facts = [
    ['Known for', person.knownFor],
    ['Born', born || null],
    ['Died', formatDate(person.deathday)],
    ['Credits', person.credits.length ? `${person.credits.length} titles` : null],
  ].filter((fact) => fact[1])

  const biography = String(person.biography ?? '').trim()
  const bioHtml = biography
    ? biography
        .split(/\n{2,}/)
        .slice(0, 5)
        .map((paragraph) => `<p>${escapeHtml(paragraph.trim())}</p>`)
        .join('')
    : '<p class="muted">No biography for this person yet.</p>'

  return `<a class="back" href="/">← Back to discover</a>
    <section class="person-head">
      ${
        person.profilePath
          ? `<div class="person-photo"><img src="${artwork(person.profilePath, 'w300')}" alt="${escapeHtml(
              person.name
            )}" loading="lazy" /></div>`
          : `<div class="person-photo person-photo-empty">${escapeHtml(initials(person.name))}</div>`
      }
      <div class="person-info">
        <h1>${escapeHtml(person.name)}</h1>
        ${
          facts.length
            ? `<dl class="facts">${facts
                .map(
                  ([label, value]) => `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
                )
                .join('')}</dl>`
            : ''
        }
        <div class="person-bio">${bioHtml}</div>
      </div>
    </section>
    <h2 class="section-title">Known for</h2>
    ${mediaGrid(credits, { returnTo: `/person/${person.id}`, plex })}
    ${pagination({ page: current, totalPages, basePath: `/person/${person.id}` })}`
}

function seasonEpisodeCount(season) {
  return Number(season.episodes ?? season.episodeCount ?? 0)
}

/**
 * One season row. The summary opens an episode list that is fetched the first
 * time the season is opened, and the checkbox (present only while the title can
 * still be requested) picks the season for the request.
 */
function seasonRow({ season, stored, tmdbId, pickable }) {
  const number = season.seasonNumber
  const available = stored?.status === MediaStatus.AVAILABLE
  const count = seasonEpisodeCount(season)
  const target = `/partial/tv/${escapeHtml(String(tmdbId))}/season/${escapeHtml(String(number))}`

  return `<div class="season-row">
    <details class="season-block" data-episodes="${target}">
      <summary>
        <span>${escapeHtml(season.name ?? `Season ${number}`)}</span>
        <span class="muted small">${count ? `${count} episodes` : 'Episode list'}</span>
      </summary>
      <div class="episode-list"><p class="muted small">Open the season to load its episodes.</p></div>
    </details>
    ${
      pickable
        ? `<label class="season-pick">
            <input type="checkbox" name="season" value="${escapeHtml(String(number))}" ${
              available ? 'disabled' : 'checked'
            } />
            <span>${available ? 'In library' : 'Include'}</span>
          </label>`
        : `<span class="season-pick">${stored ? statusBadge(stored.status) : ''}</span>`
    }
  </div>`
}

/** The other films of a collection, requestable from beside the title page. */
function collectionPanel(collection) {
  if (!collection?.parts?.length) return ''
  const count = collection.parts.length

  return `<aside class="collection-side panel">
    <h2 style="margin: 0">${escapeHtml(collection.name)}</h2>
    <p class="muted small">${count} film${count === 1 ? '' : 's'} in this collection · tick any you are missing</p>
    <form method="post" action="/collection/${escapeHtml(String(collection.id))}/request" class="collection-form">
      <input type="hidden" name="returnTo" value="${escapeHtml(collection.returnTo ?? '/')}" />
      <label class="switch-row"><input type="checkbox" data-collection-all checked /> <span>Select all</span></label>
      <ul class="collection-parts">
        ${collection.parts
          .map((part) => {
            const href = `/title/movie/${escapeHtml(String(part.tmdbId))}`
            const year = formatDate(part.releaseDate)
            const state = part.current
              ? ' · This title'
              : part.state === 'library'
                ? ' · In library'
                : part.state === 'requested'
                  ? ' · Requested'
                  : ''
            const locked = Boolean(part.state) || Boolean(part.current)
            return `<li class="collection-part${part.current ? ' is-current' : ''}">
              <input type="checkbox" name="tmdbId" value="${escapeHtml(String(part.tmdbId))}" ${
                locked ? 'disabled' : 'checked'
              } data-collection-part />
              <a class="collection-poster" href="${href}">
                ${
                  part.posterPath
                    ? `<img src="${artwork(part.posterPath, 'w92')}" alt="" loading="lazy" />`
                    : '<span class="collection-poster-empty" aria-hidden="true"></span>'
                }
              </a>
              <span class="collection-text">
                <a href="${href}">${escapeHtml(part.title)}</a>
                <span class="muted small">${escapeHtml(year ? year.slice(0, 4) : '')}${escapeHtml(state)}</span>
              </span>
            </li>`
          })
          .join('')}
      </ul>
      <button class="btn" type="submit">Request selected</button>
    </form>
  </aside>`
}

function detailBody({ user, media, details, notice, error, plex = null, remote = null, collection = null, trailer = null }) {
  const entry = media ?? details
  const isTv = entry.mediaType === MediaType.TV
  const kind = isTv ? 'sonarr' : 'radarr'
  const profiles = serviceProfiles(kind)
  const storedSeasons = media ? store.listSeasons(media.id) : []
  const detailSeasons = (details?.seasons ?? []).map((season) => ({
    seasonNumber: season.seasonNumber,
    name: season.name ?? `Season ${season.seasonNumber}`,
    episodeCount: seasonEpisodeCount(season),
  }))
  const listedSeasons = detailSeasons.length
    ? detailSeasons
    : storedSeasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        name: season.name,
        episodeCount: season.episodeCount,
      }))

  const totalEpisodes =
    details?.totalEpisodes ?? storedSeasons.reduce((sum, season) => sum + (season.episodeCount ?? 0), 0)
  const seasonCount =
    details?.totalSeasons ?? (storedSeasons.length || entry.seasonsCount || listedSeasons.length || null)

  const facts = [
    ['Release date', formatDate(entry.releaseDate)],
    isTv ? ['Seasons', seasonCount ? String(seasonCount) : null] : null,
    isTv ? ['Episodes', totalEpisodes ? String(totalEpisodes) : null] : null,
    isTv ? ['Last aired', formatDate(details?.lastAirDate)] : null,
    entry.runtime ? [isTv ? 'Episode runtime' : 'Runtime', `${entry.runtime} min`] : null,
    details?.rating ? ['Rating', `${details.rating}/10 from ${details.votes.toLocaleString('en-US')} votes`] : null,
    details?.releaseStatus ? ['Release status', details.releaseStatus] : null,
    entry.genres?.length ? ['Genres', entry.genres.join(', ')] : null,
    details?.directors?.length ? ['Director', details.directors.join(', ')] : null,
    details?.creators?.length ? ['Created by', details.creators.join(', ')] : null,
    details?.networks?.length ? ['Network', details.networks.join(', ')] : null,
    media
      ? ['Library', `${MEDIA_STATUS_LABEL[media.status] ?? 'Unknown'} · ${media.activeRequests} active request(s)`]
      : null,
  ].filter((fact) => fact && fact[1])

  const factsHtml = facts.length
    ? `<dl class="facts">${facts
        .map(([label, value]) => `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join('')}</dl>`
    : ''

  // Plex already holds the file even when the local row has not caught up, so
  // both count as "here" and neither offers a request again.
  const isAvailable = media?.status === MediaStatus.AVAILABLE || Boolean(plex)
  // Discovarr knows about its own active requests; Radarr/Sonarr know about
  // titles added straight in the download manager. Either one blocks a second
  // request instead of silently filing a duplicate.
  const requestedHere = (media?.activeRequests ?? 0) > 0
  const inService = remote?.found === true
  const blocked = !isAvailable && (requestedHere || inService)
  const pickable = isTv && !isAvailable && !blocked

  // The request dialog always says which profile the download will use: a menu
  // when there is a choice, a readout when the service has only one.
  const fallbackProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null
  const profilePicker =
    profiles.length > 1
      ? `<label class="request-profile">Quality profile
          <select name="profile">
            ${profiles
              .map(
                (profile, index) =>
                  `<option value="${index}" ${profile.isDefault ? 'selected' : ''}>${escapeHtml(profile.name)}${
                    profile.isDefault ? ' (default)' : ''
                  }</option>`
              )
              .join('')}
          </select>
        </label>`
      : `<div class="request-profile profile-readout">
          <span class="muted small">Quality profile</span>
          <strong>${escapeHtml(fallbackProfile?.name ?? 'Default')}</strong>
          ${
            fallbackProfile?.profileName
              ? `<span class="muted small">${escapeHtml(fallbackProfile.profileName)}</span>`
              : ''
          }
        </div>`

  const seasonRows = isTv
    ? listedSeasons
        .map((season) =>
          seasonRow({
            season,
            stored: storedSeasons.find((candidate) => candidate.seasonNumber === season.seasonNumber),
            tmdbId: entry.tmdbId,
            pickable,
          })
        )
        .join('')
    : ''

  const seasonsBlock = seasonRows
    ? `<section class="panel season-panel">
        <h2 style="margin: 0">Seasons</h2>
        ${
          pickable
            ? `<label class="switch-row">
                <input type="checkbox" name="allSeasons" value="on" checked data-season-all />
                <span>All seasons</span>
              </label>
              <div class="season-rows" data-season-list>${seasonRows}</div>`
            : `<div class="season-rows">${seasonRows}</div>`
        }
      </section>`
    : ''

  const plexRow = plex
    ? `<div class="plex-row">
        <span class="badge badge-available">On Plex</span>
        <a class="btn btn-sm btn-plex" href="${escapeHtml(plex.playUrl)}" target="_blank" rel="noreferrer noopener">▶ Play on Plex</a>
        <span class="muted small">${escapeHtml(plex.library)}</span>
      </div>`
    : ''

  const quota = quotaSummary(user)[isTv ? 'tv' : 'movie']
  const quotaLine =
    quota.limit > 0 ? `<p class="muted small">${quota.used}/${quota.limit} requests used this month</p>` : ''

  let action

  if (isAvailable) {
    action = '<p class="badge badge-available">In library</p>'
  } else if (blocked) {
    const where = [
      requestedHere ? 'Requested in Discovarr' : null,
      inService ? `Already in ${isTv ? 'Sonarr' : 'Radarr'}` : null,
    ]
      .filter(Boolean)
      .join(' · ')

    // "Already requested" would be a lie when the title is only in Radarr or
    // Sonarr and no request of ours is open.
    const doneLabel = requestedHere ? 'Already requested' : `Already in ${isTv ? 'Sonarr' : 'Radarr'}`

    action = `<div class="action-done">
      <button class="btn" type="button" disabled>${doneLabel}</button>
      <p class="muted small">${escapeHtml(where)}</p>
    </div>`
  } else {
    const formAction = media ? `/media/${media.id}/request` : '/media/import'
    // The configuration lives in a small dialog: seasons and quality profile are
    // only worth looking at once the request is actually being set up.
    action = `<div class="action-open">
      <button class="btn" type="button" data-dialog-open="request-dialog">Request ${isTv ? 'series' : 'movie'}</button>
      ${quotaLine}
    </div>
    <dialog class="dialog request-dialog" id="request-dialog">
      <form method="post" action="${formAction}" class="stack">
        ${
          media
            ? `<input type="hidden" name="returnTo" value="/media/${media.id}" />`
            : `<input type="hidden" name="tmdbId" value="${escapeHtml(entry.tmdbId)}" />
               <input type="hidden" name="mediaType" value="${escapeHtml(entry.mediaType)}" />
               <input type="hidden" name="returnTo" value="/" />`
        }
        ${isTv ? '<input type="hidden" name="seasonsSubmitted" value="1" />' : ''}
        <div class="dialog-head">
          <h2>Request ${escapeHtml(entry.title)}</h2>
          <button class="icon-btn" type="button" data-dialog-close aria-label="Close">×</button>
        </div>
        <p class="muted small">${
          isTv
            ? 'Pick the seasons to monitor and the quality profile the download should use.'
            : 'Pick the quality profile the download should use.'
        }</p>
        ${seasonsBlock}
        ${profilePicker}
        <div class="request-actions">
          <button class="btn" type="submit">Request ${isTv ? 'selected seasons' : 'movie'}</button>
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
        </div>
      </form>
    </dialog>`
  }

  const meta = [
    isTv ? 'Series' : 'Movie',
    formatDate(entry.releaseDate)?.slice(0, 4),
    entry.runtime ? `${entry.runtime} min` : null,
    ...(entry.genres ?? []),
  ]
    .filter(Boolean)
    .join(' · ')

  const returnHere = media ? `/media/${media.id}` : `/title/${entry.mediaType}/${entry.tmdbId}`
  const watched = store.isWatched(user?.id, entry.tmdbId, entry.mediaType)
  const watchToggle = `<form method="post" action="/watchlist/toggle" class="watch-toggle">
      <input type="hidden" name="tmdbId" value="${escapeHtml(entry.tmdbId)}" />
      <input type="hidden" name="mediaType" value="${escapeHtml(entry.mediaType)}" />
      <input type="hidden" name="title" value="${escapeHtml(entry.title)}" />
      <input type="hidden" name="posterPath" value="${escapeHtml(entry.posterPath ?? '')}" />
      <input type="hidden" name="releaseDate" value="${escapeHtml(entry.releaseDate ?? '')}" />
      <input type="hidden" name="returnTo" value="${escapeHtml(returnHere)}" />
      <button class="btn btn-sm btn-ghost" type="submit">${watched ? '★ Saved to your watchlist' : '☆ Save to watchlist'}</button>
    </form>`

  const backdropPath = entry.backdropPath ?? details?.backdropPath ?? null
  // The title's own artwork, blurred far enough that it reads as a tint of the
  // page rather than a picture competing with the poster.
  const backdrop = backdropPath
    ? `<div class="detail-backdrop" aria-hidden="true" style="background-image: url('${artwork(
        backdropPath,
        'w780'
      )}')"></div>`
    : ''

  return `${backdrop}
    <a class="back" href="/">← Back to discover</a>
    ${alert({ notice, error })}
    <div class="detail-wrap${collection?.parts?.length ? ' has-collection' : ''}">
      <div class="detail-main">
        <section class="detail">
          ${poster({ ...entry, posterPath: entry.posterPath ?? details?.posterPath ?? null }, 'poster-lg')}
          <div class="detail-body">
            <h1>${escapeHtml(entry.title)}</h1>
            ${details?.tagline ? `<p class="tagline">${escapeHtml(details.tagline)}</p>` : ''}
            <p class="media-meta">${escapeHtml(meta)}</p>
            <p class="overview">${escapeHtml(entry.overview || details?.overview || 'No description available yet.')}</p>
            ${factsHtml}
            ${plexRow}
            ${pickable ? '' : seasonsBlock}
            ${action}
            ${watchToggle}
            ${
              trailer
                ? `<p><a class="btn btn-sm btn-ghost" href="${escapeHtml(trailer.url)}" target="_blank" rel="noreferrer noopener">▶ Watch trailer</a></p>`
                : ''
            }
          </div>
        </section>
        ${castPanel(details)}
        ${watchPanel(details)}
        ${
          details
            ? `<p class="muted small">Metadata from TMDB.${
                collection
                  ? ` · <a href="/collection/${collection.id}">All ${collection.parts.length} films in ${escapeHtml(
                      collection.name
                    )}</a>`
                  : ''
              }</p>`
            : ''
        }
      </div>
      ${collectionPanel(collection)}
    </div>`
}

/**
 * The rest of a film's collection, with anything already held locally marked so
 * the panel only offers what is actually missing.
 */
async function loadCollection(details, mediaType, currentTmdbId, returnTo) {
  if (mediaType !== MediaType.MOVIE || !details?.collection?.id) return null

  try {
    const collection = await collectionDetails(details.collection.id)
    // The whole collection, so the panel reads as one set: the film on screen is
    // marked rather than left out.
    const parts = collection.parts.map((part) => ({
      ...part,
      current: Number(part.tmdbId) === Number(currentTmdbId),
      state: partState(part.tmdbId),
    }))

    return { ...collection, parts, returnTo }
  } catch {
    return null
  }
}

/** 'library', 'requested' or null for one film of a collection. */
function partState(tmdbId) {
  const local = store.getMediaByTmdb(Number(tmdbId), MediaType.MOVIE)
  if (!local) return null
  if (local.status === MediaStatus.AVAILABLE) return 'library'

  const active = store
    .listRequestsForMedia(local.id)
    .some((request) => ACTIVE_REQUEST_STATUSES.includes(request.status))
  return active ? 'requested' : null
}

/**
 * The season picker sends "all seasons" or a list of ticked ones. null means
 * everything, which is what the request service defaults to.
 */
function seasonSelection(body) {
  if (body.allSeasons === 'on' || body.allSeasons === '1') return null
  if (!body.seasonsSubmitted) return null
  const raw = body.season === undefined ? [] : [].concat(body.season)
  return raw.map(Number).filter((number) => Number.isInteger(number))
}

function episodesHtml(season) {
  const head = season.overview ? `<p class="muted small">${escapeHtml(season.overview)}</p>` : ''
  const episodes = season.episodes.length
    ? season.episodes
        .map(
          (episode) => `<article class="episode">
            <div class="episode-head">
              <strong>${escapeHtml(String(episode.number))}. ${escapeHtml(episode.name)}</strong>
              <span class="muted small">${escapeHtml(episode.airDate ? formatDate(episode.airDate) : 'Unaired')}${
                episode.runtime ? ` · ${episode.runtime} min` : ''
              }</span>
            </div>
            <p class="episode-overview">${escapeHtml(episode.overview || 'No description yet.')}</p>
          </article>`
        )
        .join('')
    : '<p class="muted small">No episodes listed for this season.</p>'

  return `${head}${episodes}`
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function watchlistBody({ items, notice, error }) {
  const cards = items.map((item) => {
    const local = store.getMediaByTmdb(item.tmdbId, item.mediaType)
    const active = local
      ? store.listRequestsForMedia(local.id).filter((request) => request.status === 1 || request.status === 2)
      : []

    const preview = previewAttrs({
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      title: item.title,
      meta: `${item.mediaType === 'tv' ? 'Series' : 'Film'}${
        item.releaseDate ? ` · ${item.releaseDate.slice(0, 4)}` : ''
      }${local?.status === MediaStatus.AVAILABLE ? ' · In library' : ''}`,
      posterPath: item.posterPath ?? local?.posterPath ?? null,
    })

    return `<div class="watch-row">
      ${poster({ ...item, id: item.tmdbId, title: item.title })}
      <div class="watch-body">
        <a class="media-title" href="${local ? `/media/${local.id}` : `/title/${item.mediaType}/${item.tmdbId}`}"${preview}>${escapeHtml(item.title)}</a>
        <p class="media-meta">${item.mediaType === 'tv' ? 'Series' : 'Movie'}${
          item.releaseDate ? ` · ${escapeHtml(item.releaseDate.slice(0, 4))}` : ''
        }</p>
        <div class="media-actions">${requestAction(
          item,
          local ? { ...local, activeRequests: Math.max(local.activeRequests ?? 0, active.length) } : null,
          '/watchlist'
        )}</div>
      </div>
      <form method="post" action="/watchlist/toggle">
        <input type="hidden" name="tmdbId" value="${escapeHtml(item.tmdbId)}" />
        <input type="hidden" name="mediaType" value="${escapeHtml(item.mediaType)}" />
        <input type="hidden" name="title" value="${escapeHtml(item.title)}" />
        <input type="hidden" name="returnTo" value="/watchlist" />
        <button class="btn btn-sm btn-ghost" type="submit">Remove</button>
      </form>
    </div>`
  })

  return `<div class="page-head">
      <div>
        <h1>Watchlist</h1>
        <p class="muted">Titles saved for later, newest first.</p>
      </div>
    </div>
    ${alert({ notice, error })}
    ${
      cards.length
        ? `<div class="watch-list">${cards.join('')}</div>`
        : '<p class="empty">Nothing saved yet. Open a title and press <strong>Save to watchlist</strong>.</p>'
    }`
}

/** The month a ?month=YYYY-MM parameter points at; anything odd falls back to today. */
function monthBounds(value, now = new Date()) {
  const match = /^(\d{4})-(\d{1,2})$/.exec(String(value ?? ''))
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth()

  if (match) {
    year = Number(match[1])
    month = Number(match[2]) - 1
  }

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
    year = now.getUTCFullYear()
    month = now.getUTCMonth()
  }

  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 0))

  return { year, month, start, end, key: `${year}-${String(month + 1).padStart(2, '0')}` }
}

function shiftMonth(key, delta) {
  const [year, month] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthName(key, { short = false } = {}) {
  const [year, month] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', {
    month: short ? 'short' : 'long',
    year: short ? undefined : 'numeric',
    timeZone: 'UTC',
  })
}

function activityBody({ user, canManage, retry, queue, maxAttempts, notice, error }) {
  const waiting = retry.filter((request) => (request.attempts ?? 0) < maxAttempts)
  const exhausted = retry.filter((request) => (request.attempts ?? 0) >= maxAttempts)

  const requestRow = (request) => `<tr>
      <td>${escapeHtml(request.media?.title ?? `Request #${request.id}`)}<span class="muted small"> · #${request.id}</span></td>
      <td>${escapeHtml(request.requester?.username ?? '—')}</td>
      <td>${request.attempts ?? 0}</td>
      <td>${
        request.nextRetryAt
          ? escapeHtml(String(request.nextRetryAt).replace('T', ' ').slice(0, 16))
          : '<span class="muted">not scheduled</span>'
      }</td>
      <td class="muted small">${escapeHtml(String(request.note ?? '').slice(0, 180) || '—')}</td>
    </tr>`

  const requestTable = (rows, empty) =>
    rows.length
      ? `<table class="table">
          <thead><tr><th>Title</th><th>Requested by</th><th>Attempts</th><th>Next attempt</th><th>Last error</th></tr></thead>
          <tbody>${rows.map(requestRow).join('')}</tbody>
        </table>`
      : `<p class="muted small">${empty}</p>`

  const queueTable = (service) => `<section class="panel">
      <h2 style="margin: 0">${escapeHtml(service.label)} queue</h2>
      ${
        service.error
          ? `<p class="muted small">${escapeHtml(service.error)}</p>`
          : service.items.length
            ? `<table class="table">
                <thead><tr><th>Title</th><th>Status</th><th>Progress</th><th>Finishes</th></tr></thead>
                <tbody>${service.items
                  .map(
                    (item) => `<tr>
                      <td>${escapeHtml(item.title)}</td>
                      <td>${escapeHtml(String(item.status))}</td>
                      <td>${item.progress === null ? '—' : `${item.progress}%`}</td>
                      <td>${item.eta ? escapeHtml(String(item.eta).replace('T', ' ').slice(0, 16)) : '—'}</td>
                    </tr>`
                  )
                  .join('')}</tbody>
              </table>`
            : '<p class="muted small">Nothing queued.</p>'
      }
    </section>`

  return `<div class="page-head">
      <div>
        <h1>Activity</h1>
        <p class="muted">Sent to your download client and what happened next.</p>
      </div>
    </div>
    ${alert({ notice, error })}

    <section class="panel">
      <h2 style="margin: 0">Waiting for another attempt</h2>
      <p class="muted small">Retried automatically after the backoff, up to ${maxAttempts} attempt(s).</p>
      ${requestTable(waiting, 'Nothing is waiting to be retried.')}
    </section>

    <section class="panel">
      <h2 style="margin: 0">Gave up</h2>
      <p class="muted small">Out of attempts. Retry one by hand from the Requests page once the service is healthy.</p>
      ${requestTable(exhausted, 'No request has run out of attempts.')}
    </section>

    ${canManage ? queue.map(queueTable).join('') : ''}`
}

function calendarChip(item) {
  const kind = item.mediaType === MediaType.TV ? 'Series' : 'Film'
  const href = item.localId ? `/media/${item.localId}` : `/title/${item.mediaType}/${item.tmdbId}`
  const preview = previewAttrs({
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
    title: item.title,
    meta: `${kind}${item.inLibrary ? ' · In library' : ' · Requested'}`,
    posterPath: item.posterPath ?? null,
  })

  return `<a class="cal-item cal-item-${item.mediaType === MediaType.TV ? 'tv' : 'movie'}${
    item.inLibrary ? ' is-library' : ''
  }" href="${href}"${preview} title="${escapeHtml(`${item.title} · ${kind}`)}">${escapeHtml(item.title)}</a>`
}

/**
 * What belongs on a household calendar: titles already in the library, and
 * titles somebody asked for. TMDB's whole release slate is noise next to that.
 */
function calendarScope() {
  const scope = new Map()

  for (const media of store.listMedia({})) {
    if (!media.tmdbId) continue
    const requested = store
      .listRequestsForMedia(media.id)
      .some((request) => request.status === 1 || request.status === 2 || request.status === 5)
    const available = media.status === MediaStatus.AVAILABLE
    if (!available && !requested) continue
    scope.set(`${media.mediaType}:${media.tmdbId}`, { localId: media.id, inLibrary: available })
  }

  return scope
}

/** TMDB's month listing, narrowed to that scope, plus local titles it missed. */
function calendarEntries(items, scope, month) {
  const seen = new Set()
  const entries = []

  for (const item of items) {
    const key = `${item.mediaType}:${item.tmdbId}`
    const entry = scope.get(key)
    if (!entry || seen.has(key)) continue
    seen.add(key)
    entries.push({ ...item, ...entry })
  }

  for (const [key, entry] of scope) {
    if (seen.has(key)) continue
    const media = store.getMedia(entry.localId)
    const day = media?.releaseDate ? String(media.releaseDate).slice(0, 10) : null
    if (!day || !day.startsWith(month.key)) continue
    entries.push({
      tmdbId: media.tmdbId,
      mediaType: media.mediaType,
      title: media.title,
      releaseDate: day,
      posterPath: media.posterPath ?? null,
      ...entry,
    })
  }

  return entries.sort((left, right) => String(left.releaseDate).localeCompare(String(right.releaseDate)))
}

/** A month grid: one box per day, with what releases that day inside it. */
function calendarBody({ items, month, notice, error }) {
  const byDay = new Map()
  for (const item of items) {
    const day = item.releaseDate ? String(item.releaseDate).slice(0, 10) : null
    if (!day || !day.startsWith(month.key)) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(item)
  }

  const today = new Date().toISOString().slice(0, 10)
  const lead = (month.start.getUTCDay() + 6) % 7
  const total = month.end.getUTCDate()
  const cells = []

  for (let blank = 0; blank < lead; blank += 1) {
    cells.push('<div class="cal-cell is-blank" aria-hidden="true"></div>')
  }

  for (let day = 1; day <= total; day += 1) {
    const iso = `${month.key}-${String(day).padStart(2, '0')}`
    const entries = byDay.get(iso) ?? []
    const shown = entries.slice(0, 3)

    cells.push(`<div class="cal-cell${iso === today ? ' is-today' : ''}${entries.length ? ' has-releases' : ''}">
        <span class="cal-day">${day}</span>
        <div class="cal-items">${shown.map((item) => calendarChip(item)).join('')}${
          entries.length > shown.length ? `<span class="cal-more">+${entries.length - shown.length} more</span>` : ''
        }</div>
      </div>`)
  }

  while (cells.length % 7 !== 0) {
    cells.push('<div class="cal-cell is-blank" aria-hidden="true"></div>')
  }

  const count = [...byDay.values()].reduce((total, entries) => total + entries.length, 0)
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return `<div class="page-head">
      <div>
        <h1>Calendar</h1>
        <p class="muted">${count} release(s) in ${escapeHtml(monthName(month.key))} — everything in your library and everything you have asked for.</p>
      </div>
      <div class="cal-nav">
        <a class="btn btn-sm btn-ghost" href="/calendar?month=${shiftMonth(month.key, -1)}">← ${escapeHtml(
          monthName(shiftMonth(month.key, -1), { short: true })
        )}</a>
        <a class="btn btn-sm" href="/calendar">Today</a>
        <a class="btn btn-sm btn-ghost" href="/calendar?month=${shiftMonth(month.key, 1)}">${escapeHtml(
          monthName(shiftMonth(month.key, 1), { short: true })
        )} →</a>
      </div>
    </div>
    ${alert({ notice, error })}
    <div class="cal-grid">
      ${weekdays.map((name) => `<div class="cal-weekday">${name}</div>`).join('')}
      ${cells.join('')}
    </div>`
}

/** Local state of one collection part, for the collection page's tick boxes. */
function collectionPartState(tmdbId) {
  const local = store.getMediaByTmdb(tmdbId, MediaType.MOVIE)
  if (!local) return { state: 'unknown', label: 'Not requested', blocked: false }
  if (local.status === MediaStatus.AVAILABLE) return { state: 'available', label: 'In library', blocked: true }

  const active = store
    .listRequestsForMedia(local.id)
    .filter((request) => request.status === 1 || request.status === 2)

  if (active.length) return { state: 'pending', label: 'Requested', blocked: true }
  return { state: 'unknown', label: '', blocked: false }
}

function collectionPageBody({ collection, parts, notice, error }) {
  const inLibrary = parts.filter((part) => part.state === 'available').length

  const rows = parts
    .map(
      (part) => `<label class="collection-page-row${part.blocked ? ' is-blocked' : ''}">
        <input type="checkbox" name="tmdbId" value="${escapeHtml(part.tmdbId)}" ${part.blocked ? 'disabled' : 'checked'} />
        ${poster(part, 'poster-sm')}
        <span class="collection-page-text">
          <strong>${escapeHtml(part.title)}</strong>
          <span class="muted small">${part.releaseDate ? escapeHtml(part.releaseDate.slice(0, 4)) : 'No date'}${
            part.voteAverage ? ` · ${escapeHtml(String(part.voteAverage))}/10` : ''
          }</span>
          ${part.label ? `<span class="badge badge-${part.state}">${escapeHtml(part.label)}</span>` : ''}
        </span>
      </label>`
    )
    .join('')

  return `<a class="back" href="/">← Back to discover</a>
    ${alert({ notice, error })}
    <div class="page-head">
      <div>
        <h1>${escapeHtml(collection.name)}</h1>
        <p class="muted">${parts.length} film(s) · ${inLibrary} in your library</p>
      </div>
    </div>
    <form method="post" action="/collection/${escapeHtml(collection.id)}/request" class="stack panel">
      <input type="hidden" name="returnTo" value="/collection/${escapeHtml(collection.id)}" />
      <div class="collection-page-list">${rows}</div>
      <button class="btn" type="submit">Request selected films</button>
      <p class="muted small">Films already in the library or already requested stay unticked.</p>
    </form>`
}

function notificationsBody({ items, notice, error }) {
  const list = items.length
    ? `<div class="notification-list">${items
        .map(
          (item) => `<article class="notification${item.readAt ? '' : ' is-unread'}">
            <div class="notification-head">
              <strong>${escapeHtml(item.title)}</strong>
              <span class="muted small">${escapeHtml(item.createdAt.slice(0, 16).replace('T', ' '))}</span>
            </div>
            ${item.body ? `<p class="muted small">${escapeHtml(item.body)}</p>` : ''}
            ${item.href ? `<a class="small" href="${escapeHtml(item.href)}">Open the title →</a>` : ''}
          </article>`
        )
        .join('')}</div>`
    : '<p class="empty">Nothing yet. Approvals, declines and titles arriving will show up here.</p>'

  return `<div class="page-head">
      <div>
        <h1>Notifications</h1>
        <p class="muted">Updates about your own requests.</p>
      </div>
      ${
        items.some((item) => !item.readAt)
          ? '<form method="post" action="/notifications/read"><button class="btn btn-sm btn-ghost" type="submit">Mark all read</button></form>'
          : ''
      }
    </div>
    ${alert({ notice, error })}
    ${list}`
}

function requestsBody({ user, result, filter, notice, error }) {
  const filters = [
    ['all', 'All'],
    ['pending', 'Pending'],
    ['approved', 'Approved'],
    ['failed', 'Failed'],
    ['completed', 'Completed'],
    ['declined', 'Declined'],
  ]

  const tabs = filters
    .map(
      ([key, label]) =>
        `<a class="tab ${filter === key ? 'is-active' : ''}" href="/requests${key === 'all' ? '' : `?filter=${key}`}">${label}</a>`
    )
    .join('')

  const { canManageRequests } = userPermissions(user)
  const returnTo = `/requests${filter === 'all' ? '' : `?filter=${filter}`}`

  const bulkBar = canManageRequests
    ? `<form id="bulk" method="post" action="/requests/bulk" class="bulk-bar">
        <span class="muted small">With selected:</span>
        <button class="btn btn-sm" type="submit" name="action" value="approve">Approve</button>
        <button class="btn btn-sm btn-ghost" type="submit" name="action" value="retry">Retry failed</button>
        <button class="btn btn-sm btn-ghost" type="submit" name="action" value="decline">Decline</button>
        <button class="btn btn-sm btn-danger" type="submit" name="action" value="delete">Delete</button>
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
      </form>`
    : ''

  const list = result.results.length
    ? `<div class="request-list">${result.results
        .map((request) => requestCard(request, { canManage: canManageRequests, bulk: canManageRequests }))
        .join('')}</div>`
    : '<p class="empty">No requests here yet.</p>'

  return `<div class="page-head">
      <div>
        <h1>Requests</h1>
        <p class="muted">${canManageRequests ? 'Every request across the library.' : 'Requests you have made.'}</p>
      </div>
    </div>
    ${alert({ notice, error })}
    <div class="tabs">${tabs}</div>
    ${bulkBar}
    ${list}
    ${pagination({ page: result.page, totalPages: result.totalPages, basePath: '/requests', params: { filter: filter === 'all' ? '' : filter } })}`
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function accountBody({ user, quota, notice, error }) {
  return `<h1>Account</h1>
    ${alert({ notice, error })}
    <section class="panel">
      <p><strong>${escapeHtml(user.username)}</strong> <span class="muted">${escapeHtml(user.email)}</span></p>
      <p class="muted small">Monthly quotas: movies ${quota.movie.used}/${quota.movie.limit || '∞'} · series ${quota.tv.used}/${quota.tv.limit || '∞'}</p>
    </section>

    <form method="post" action="/account/password" class="stack panel">
      <h2 style="margin: 0">Change password</h2>
      <label>Current password <input type="password" name="currentPassword" required autocomplete="current-password" /></label>
      <label>New password <input type="password" name="newPassword" required minlength="6" autocomplete="new-password" /></label>
      <button class="btn btn-sm" type="submit">Update password</button>
      <p class="muted small">Changing your password signs out your other sessions.</p>
    </form>

    <form method="post" action="/account/notifications" class="stack panel">
      <h2 style="margin: 0">Notifications</h2>
      <p class="muted small">The bell in the header always shows your own updates. Email is optional.</p>
      <label class="checkbox">
        <input type="checkbox" name="notifyEmail" ${user.notifyEmail ? 'checked' : ''} />
        <span>Also email me (needs SMTP configured by an administrator)</span>
      </label>
      <fieldset class="plain">
        <legend class="muted small">Email me when</legend>
        <label class="checkbox"><input type="checkbox" name="events" value="1" ${(user.notifyEvents ?? 0) & 1 ? 'checked' : ''} /> <span>My request is approved</span></label>
        <label class="checkbox"><input type="checkbox" name="events" value="2" ${(user.notifyEvents ?? 0) & 2 ? 'checked' : ''} /> <span>My request is declined</span></label>
        <label class="checkbox"><input type="checkbox" name="events" value="4" ${(user.notifyEvents ?? 0) & 4 ? 'checked' : ''} /> <span>A title I asked for becomes available</span></label>
      </fieldset>
      <button class="btn btn-sm" type="submit">Save notification preferences</button>
    </form>

`
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_TABS = Object.freeze([
  ['general', 'General'],
  ['integrations', 'Integrations'],
  ['users', 'Users'],
  ['notifications', 'Notifications'],
  ['tokens', 'API tokens'],
  ['tasks', 'Tasks'],
  ['logs', 'Logs'],
])

const WATCH_REGIONS = [
  ['US', 'United States'],
  ['CA', 'Canada'],
  ['GB', 'United Kingdom'],
  ['IE', 'Ireland'],
  ['AU', 'Australia'],
  ['NZ', 'New Zealand'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['SE', 'Sweden'],
  ['DK', 'Denmark'],
  ['NO', 'Norway'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['BR', 'Brazil'],
  ['IN', 'India'],
  ['JP', 'Japan'],
]

function settingsTabs(tab) {
  return `<nav class="tabs settings-tabs">
    ${SETTINGS_TABS.map(
      ([key, label]) => `<a class="tab ${tab === key ? 'is-active' : ''}" href="/settings?tab=${key}">${label}</a>`
    ).join('')}
  </nav>`
}

function tokensPanel({ tokens, newToken }) {
  return `<section class="panel">
      <h2 style="margin: 0">Your API tokens</h2>
      <p class="muted small">For scripts and home automation: send <code>Authorization: Bearer &lt;token&gt;</code> to <code>/api/v1/…</code>. A token acts as your account, so treat it like a password.</p>
      ${newToken ? `<p class="alert alert-ok">New token, shown once: <code>${escapeHtml(newToken)}</code></p>` : ''}
      ${newToken ? `<p class="muted small">Calendar feed for your phone: <code>/calendar.ics?token=${escapeHtml(newToken)}</code></p>` : ''}
      ${
        tokens.length
          ? `<table class="table">
              <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th></th></tr></thead>
              <tbody>${tokens
                .map(
                  (token) => `<tr>
                    <td>${escapeHtml(token.name)}</td>
                    <td><code>${escapeHtml(token.prefix)}…</code></td>
                    <td>${escapeHtml(token.createdAt.slice(0, 10))}</td>
                    <td>${token.lastUsedAt ? escapeHtml(token.lastUsedAt.slice(0, 16).replace('T', ' ')) : 'never'}</td>
                    <td><form method="post" action="/settings/tokens/${token.id}/delete"><button class="btn btn-sm btn-danger" type="submit">Revoke</button></form></td>
                  </tr>`
                )
                .join('')}</tbody>
            </table>`
          : '<p class="muted small">No tokens yet.</p>'
      }
      <form method="post" action="/settings/tokens" class="row">
        <label>Name <input type="text" name="name" maxlength="60" placeholder="Home Assistant" /></label>
        <button class="btn btn-sm" type="submit">Create token</button>
      </form>
    </section>`
}

function regionOptions(current) {
  const value = String(current || 'US').toUpperCase()
  const known = WATCH_REGIONS.some(([code]) => code === value)
  return `${known ? '' : `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>`}${WATCH_REGIONS.map(
    ([code, name]) => `<option value="${code}" ${code === value ? 'selected' : ''}>${escapeHtml(name)}</option>`
  ).join('')}`
}

// The real Radarr and Sonarr marks, inlined so they render offline and stay
// crisp at 20px. Radarr's dark strokes take the panel colour, its arrow keeps
// the brand yellow.
const SERVICE_ICONS = Object.freeze({
  radarr:
    '<svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true"><g transform="translate(70 21)"><path fill="currentColor" d="m10.3 59.8 3.9 372.4c-31.4 3.9-54.9-11.8-54.9-43.1l-3.9-309.7c0-98 90.2-121.5 145.1-82.3l278.3 160.7c39.2 27.4 47 78.4 27.4 113.7-3.9-27.4-15.7-43.1-39.2-58.8L53.4 36.2C29.9 20.6 10.3 24.5 10.3 59.8"/><path fill="currentColor" d="M-13.2 451.8c23.5 7.8 47 3.9 66.6-7.8l321.5-188.2c19.6 27.4 15.7 54.9-7.8 70.6L96.5 483.2c-39.2 19.6-90.1 0-109.7-31.4"/><path fill="#ffc230" d="M80.9 342 273 232.3 84.8 126.4z"/></g></svg>',
  sonarr:
    '<svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true"><path fill="#eee" d="M511.8 256c0 70.4-24.9 130.8-74.6 181.1-1.7 2-3.5 3.8-5.5 5.4-8.2 8-16.8 15.3-26 21.8Q341.05 512 256.3 512c-56.6 0-106.3-15.9-149.2-47.7-11.3-8-22-17.1-31.9-27.3C36.5 398.7 12.8 354 4 303.2c-1.7-9.9-2.9-20-3.4-30.2-.2-5.7-.4-11.3-.4-17 0-6 .1-11.7.4-17.1 0-.6.2-1.1.5-1.7 3.7-62.8 28.4-117 74.1-162.8C125.5 24.8 185.8 0 256.2 0c70.7 0 131 24.8 180.9 74.5q74.7 75.9 74.7 181.5"/><path fill="#3a3f51" d="m459.7 100.3-52.9 52.9c-30.9 30.9-33.6 57.8-33.6 105.3 0 42.3 6.7 81.1 38.2 112.6 23 23 44.9 44.7 44.9 44.7-5.9 7.2-12.3 14.3-19.1 21.2-1.7 2-3.5 3.8-5.5 5.4-6 5.9-12.2 11.4-18.6 16.4l-41.4-41.4C334.9 380.6 305.6 377 257 377c-46.7 0-78.4 4.3-112.6 38.5-20.4 20.4-43.8 43.9-43.8 43.9-8.9-6.8-17.3-14.2-25.3-22.4-6.6-6.6-12.8-13.4-18.5-20.3 0 0 23.1-23.2 45.2-45.3 32.7-32.7 38-70.6 38-113 0-41.3-6.8-79.8-36.8-109.9C82.2 127.7 53.3 99 53.3 99c6.7-8.5 14-16.7 21.8-24.5 6.9-6.8 14-13.1 21.2-19l48 48c30.7 30.7 70 38.6 112.4 38.6 43.6 0 82.8-8.4 114.7-40.4C391 82.1 417 56.3 417 56.3c6.8 5.6 13.5 11.6 20.1 18.2 8.3 8.3 15.8 16.9 22.6 25.8"/><path fill="#0cf" d="M186 269.1c-.5-2.8-.8-5.5-.9-8.4-.1-1.6-.1-3.1-.1-4.7 0-1.7 0-3.2.1-4.7 0-.2 0-.3.1-.5 1-17.4 7.9-32.4 20.5-45.1 13.9-13.8 30.6-20.7 50.2-20.7s36.3 6.9 50.2 20.7c13.8 14 20.7 30.8 20.7 50.3s-6.9 36.2-20.7 50.2c-.5.5-1 1.1-1.5 1.5q-3.45 3.3-7.2 6-18 13.2-41.4 13.2c-23.4 0-29.4-4.4-41.3-13.2-3.1-2.2-6.1-4.7-8.9-7.6-10.8-10.6-17.3-22.9-19.8-37"/></svg>',
})

function serviceIcon(kind) {
  return SERVICE_ICONS[kind] ?? SERVICE_ICONS.radarr
}

/** One saved profile as a bubble: service icon, name and edit/delete buttons. */
function profileBubble(kind, profile, index, total) {
  const name = escapeHtml(profile.name)
  const icon = serviceIcon(kind)

  return `<div class="profile-bubble${profile.isDefault ? ' is-default' : ''} profile-bubble-${kind}">
    <span class="bubble-icon bubble-icon-${kind}" aria-hidden="true">${icon}</span>
    <span class="bubble-text">
      <span class="bubble-name"><strong>${name}</strong>${
        profile.isDefault ? ' <span class="badge badge-approved">default</span>' : ''
      }</span>
      <span class="muted small">${escapeHtml(profile.profileName)} · <code>${escapeHtml(
        profile.rootFolder || '—'
      )}</code></span>
    </span>
    <span class="bubble-actions">
      <button class="icon-btn" type="button" data-dialog-open="profile-${kind}-${index}" title="Edit ${name}" aria-label="Edit ${name}">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M4 20h4l10-10-4-4L4 16v4Zm12.7-12.7 2-2a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0l-2 2 4 4Z"/></svg>
      </button>
      <form method="post" action="/settings/profiles/${kind}/delete">
        <input type="hidden" name="name" value="${name}" />
        <button class="icon-btn icon-btn-danger" type="submit" title="Delete ${name}" aria-label="Delete ${name}" ${
          total <= 1 ? 'disabled' : ''
        }>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z"/></svg>
        </button>
      </form>
    </span>
  </div>`
}

/** The add dialog (profile = null) or the edit dialog for one saved profile. */
function profileDialog(kind, label, options, profile = null, index = null) {
  const list = options?.[kind] ?? null
  const editing = Boolean(profile)
  const id = editing ? `profile-${kind}-${index}` : `profile-${kind}`
  const selectedId = profile?.profileId ?? null

  const qualityField = list?.qualityProfiles?.length
    ? `<label>Quality profile
        <select name="profileSelect" required>
          ${list.qualityProfiles
            .map(
              (entry) =>
                `<option value="${entry.id}|${escapeHtml(entry.name)}"${
                  String(entry.id) === String(selectedId) ? ' selected' : ''
                }>${escapeHtml(entry.name)}</option>`
            )
            .join('')}
        </select>
      </label>`
    : `<label>Quality profile
        <input type="text" name="profileSelect" required value="${escapeHtml(
          profile ? `${profile.profileId}|${profile.profileName}` : ''
        )}" placeholder="4|HD-1080p" />
        <span class="muted small">Format: id|name — load folders and profiles first for a list.</span>
      </label>`

  const rootField = list?.rootFolders?.length
    ? `<label>Root folder
        <select name="rootFolder" required>
          ${list.rootFolders
            .map(
              (folder) =>
                `<option value="${escapeHtml(folder.path)}"${
                  folder.path === profile?.rootFolder ? ' selected' : ''
                }>${escapeHtml(folder.path)}</option>`
            )
            .join('')}
          ${
            profile?.rootFolder && !list.rootFolders.some((folder) => folder.path === profile.rootFolder)
              ? `<option value="${escapeHtml(profile.rootFolder)}" selected>${escapeHtml(profile.rootFolder)}</option>`
              : ''
          }
        </select>
      </label>`
    : `<label>Root folder
        <input type="text" name="rootFolder" required value="${escapeHtml(profile?.rootFolder ?? '')}" placeholder="/media/movies" />
      </label>`

  return `<dialog class="dialog" id="${id}">
    <form method="post" action="/settings/profiles/${kind}/${editing ? 'edit' : 'add'}" class="stack">
      <h2 style="margin: 0">${editing ? `Edit ${escapeHtml(profile.name)}` : `Add a ${label} profile`}</h2>
      <p class="muted small">${
        editing
          ? 'Change the name, quality profile or root folder. Requests already sent keep the profile they were filed with.'
          : `The name is what requesters see. The quality profile and root folder are what ${label} uses for that choice.`
      }</p>
      ${
        editing
          ? `<input type="hidden" name="originalName" value="${escapeHtml(profile.name)}" />`
          : ''
      }
      <label>Profile name <input type="text" name="name" required maxlength="60" value="${escapeHtml(
        profile?.name ?? ''
      )}" placeholder="4K Movies" /></label>
      ${qualityField}
      ${rootField}
      ${
        profile?.isDefault
          ? '<p class="muted small">This is the default profile. Pick another one to make it the default instead.</p>'
          : `<label class="checkbox"><input type="checkbox" name="makeDefault" /> <span>Make this the default profile</span></label>`
      }
      <div class="request-actions">
        <button class="btn" type="submit">${editing ? 'Save profile' : 'Add profile'}</button>
        <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
      </div>
    </form>
  </dialog>`
}

function profileStrip(kind, label, options) {
  const profiles = serviceProfiles(kind)

  return `<div class="profiles">
    <div class="panel-head">
      <h3>${label} profiles</h3>
      <button class="btn btn-sm btn-ghost" type="button" data-dialog-open="profile-${kind}">+ Add profile</button>
    </div>
    <p class="muted small">Each bubble is a quality profile and root folder. Requesters choose one, and approval dispatches with it.</p>
    <div class="profile-bubbles">
      ${
        profiles.length
          ? profiles.map((profile, index) => profileBubble(kind, profile, index, profiles.length)).join('')
          : '<p class="empty small">No profiles yet — add one so requests know which quality and folder to use.</p>'
      }
    </div>
    ${profiles.map((profile, index) => profileDialog(kind, label, options, profile, index)).join('')}
    ${profileDialog(kind, label, options)}
  </div>`
}

/** One service: its connection form and its profile bubbles, side by side. */
function servicePanel(kind, label, settings, options) {
  const service = serviceSummary(kind)

  return `<section class="panel service-panel">
    <div class="service-head">
      <span class="service-icon service-icon-${kind}">${serviceIcon(kind)}</span>
      <h2>${label}</h2>
      <span class="badge badge-${service.enabled ? 'approved' : 'pending'}">${service.enabled ? 'enabled' : 'disabled'}</span>
    </div>
    <form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="integrations" />
      <input type="hidden" name="settingsTab" value="integrations" />
      <input type="hidden" name="${kind}EnabledSubmitted" value="1" />
      <label class="checkbox">
        <input type="checkbox" name="${kind}Enabled" ${service.enabled ? 'checked' : ''} />
        <span>Enable ${label} integration</span>
      </label>
      <label>Base URL
        <input type="url" name="${kind}Url" value="${escapeHtml(
          settings[`services.${kind}.url`]
        )}" placeholder="http://192.168.1.20:8989" />
      </label>
      <label>API key
        <input type="password" name="${kind}ApiKey" value="${escapeHtml(
          settings[`services.${kind}.apiKey`]
        )}" autocomplete="off" />
      </label>
      <div class="request-actions">
        <button class="btn btn-sm" type="submit">Save</button>
        <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/options/${kind}">Load folders and profiles</button>
        <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/test/${kind}">Save and test connection</button>
      </div>
    </form>
    ${profileStrip(kind, label, options)}
  </section>`
}

function plexPanel(settings) {
  const plex = plexSettings()

  return `<fieldset class="panel">
    <legend>Plex <span class="badge badge-${plex.enabled ? 'approved' : 'pending'}">${
      plex.enabled ? 'enabled' : 'disabled'
    }</span></legend>
    <form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="integrations" />
      <input type="hidden" name="settingsTab" value="integrations" />
      <input type="hidden" name="plexEnabledSubmitted" value="1" />
      <label class="checkbox">
        <input type="checkbox" name="plexEnabled" ${plex.enabled ? 'checked' : ''} />
        <span>Enable Plex integration</span>
      </label>
      <label>Plex URL
        <input type="url" name="plexUrl" value="${escapeHtml(settings['plex.url'])}" placeholder="http://192.168.1.20:32400" />
      </label>
      <label>Plex token
        <input type="password" name="plexToken" value="${escapeHtml(settings['plex.token'])}" autocomplete="off" />
      </label>
      <input type="hidden" name="plexLoginSubmitted" value="1" />
      <label class="checkbox">
        <input type="checkbox" name="plexLogin" ${settings['plex.login'] === 'true' ? 'checked' : ''} />
        <span>Allow signing in with Plex</span>
      </label>
      <input type="hidden" name="plexImportSubmitted" value="1" />
      <label class="checkbox">
        <input type="checkbox" name="plexImportWatchlist" ${settings['plex.importWatchlist'] === 'true' ? 'checked' : ''} />
        <span>Copy a profile's Plex watchlist into its Discovarr watchlist when it signs in</span>
      </label>
      <p class="muted small">A Plex account that has never used this instance gets its own Discovarr account the first time it
        signs in, and picks its Plex profile when the account has more than one. A profile with a Plex Home PIN has to
        enter that PIN before it signs in.</p>
      <p class="muted small">Used to check that a title really is in Plex and to link cards straight to playback. The token is the
        <code>X-Plex-Token</code> value in any Plex item's <code>Get Info → View XML</code> link.</p>
      <div class="request-actions">
        <button class="btn btn-sm" type="submit">Save</button>
        <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/test/plex">Save and test connection</button>
      </div>
    </form>
  </fieldset>`
}

function userRow(member, actor) {
  const isSelf = member.id === actor.id
  return `<form method="post" action="/settings/users/${member.id}" class="user-row">
    <div class="user-id">
      <strong>${escapeHtml(member.username)}</strong>
      <span class="muted small">${escapeHtml(member.email)}</span>
    </div>
    <label>Role
      <select name="role" ${isSelf ? 'disabled' : ''}>
        <option value="user" ${member.role === Role.USER ? 'selected' : ''}>User</option>
        <option value="admin" ${member.role === Role.ADMIN ? 'selected' : ''}>Admin</option>
      </select>
    </label>
    <div class="permissions">
      ${Object.entries(Permission)
        .map(
          ([name, flag]) => `<label class="checkbox">
            <input type="checkbox" name="permission" value="${flag}" ${(member.permissions & flag) === flag || member.role === Role.ADMIN ? 'checked' : ''} ${member.role === Role.ADMIN || isSelf ? 'disabled' : ''} />
            <span>${escapeHtml(PERMISSION_LABELS[flag] ?? name)}</span>
          </label>`
        )
        .join('')}
    </div>
    <div class="quota">
      <label>Movie quota <input type="number" name="quotaMovie" min="0" value="${member.quotaMovie}" /></label>
      <label>Series quota <input type="number" name="quotaTv" min="0" value="${member.quotaTv}" /></label>
    </div>
    <div class="user-actions">
      <button class="btn btn-sm" type="submit" ${isSelf ? 'disabled' : ''}>Save</button>
      ${
        isSelf
          ? ''
          : `<button class="btn btn-sm btn-danger" type="submit" formaction="/settings/users/${member.id}/delete"
              data-confirm="Delete this user? Their requests, sessions and watchlist go with the account.">Delete</button>`
      }
    </div>
  </form>`
}

function settingsBody({
  user,
  settings,
  users,
  audit,
  options,
  tab,
  tokens = [],
  newToken = null,
  notice,
  error,
}) {
  const sync = syncState()
  const current = SETTINGS_TABS.some(([key]) => key === tab) ? tab : 'general'

  const general = `<form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="general" />
      <input type="hidden" name="settingsTab" value="general" />
      <fieldset class="panel">
        <legend>Application</legend>
        <label>Application name <input type="text" name="appName" value="${escapeHtml(settings['app.name'])}" maxlength="60" /></label>
        <p class="muted small">Auto-approval is a per-account permission: tick
          <strong>Auto-approve own requests</strong> for someone in the Users tab and their
          requests go straight to Radarr or Sonarr instead of waiting for review.</p>
      </fieldset>
      <fieldset class="panel">
        <legend>Metadata</legend>
        <label>TMDB API key
          <input type="password" name="tmdbApiKey" value="${escapeHtml(settings['tmdb.apiKey'])}" autocomplete="off" placeholder="v3 key or v4 read token" />
        </label>
        <label>Where-to-watch region
          <select name="tmdbRegion">${regionOptions(settings['tmdb.region'])}</select>
        </label>
      </fieldset>
      <button class="btn" type="submit">Save general settings</button>
    </form>

    <section class="panel">
      <h2 style="margin: 0">Appearance</h2>
      <p class="muted small">The theme is remembered in this browser, so everyone can keep their own. It applies straight away.</p>
      ${themeSelect({ label: 'Theme' })}
    </section>`

  const integrations = `${servicePanel('radarr', 'Radarr', settings, options)}
    ${servicePanel('sonarr', 'Sonarr', settings, options)}
    ${plexPanel(settings)}`

  const usersTab = `<h2>Users</h2>
    <div class="user-list">${users.map((member) => userRow(member, user)).join('')}</div>

    <form method="post" action="/settings/users" class="stack panel">
      <h2 style="margin: 0">Add a user</h2>
      <div class="row-grid">
        <label>Username <input type="text" name="username" required minlength="3" maxlength="40" /></label>
        <label>Email <input type="email" name="email" required /></label>
        <label>Password <input type="password" name="password" required minlength="6" /></label>
        <label>Role
          <select name="role">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
      <button class="btn btn-sm" type="submit">Create user</button>
    </form>`

  const notifications = `<form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="notifications" />
      <input type="hidden" name="settingsTab" value="notifications" />
      <fieldset class="panel">
        <legend>Webhook</legend>
        <label>Webhook URL
          <input type="url" name="webhookUrl" value="${escapeHtml(settings['notifications.webhookUrl'])}" placeholder="https://discord.com/api/webhooks/..." />
        </label>
        <label class="checkbox"><input type="checkbox" name="onRequest" ${settings['notifications.onRequest'] === 'true' ? 'checked' : ''} /> <span>New requests</span></label>
        <label class="checkbox"><input type="checkbox" name="onApproval" ${settings['notifications.onApproval'] === 'true' ? 'checked' : ''} /> <span>Approvals and declines</span></label>
        <label class="checkbox"><input type="checkbox" name="onAvailable" ${settings['notifications.onAvailable'] === 'true' ? 'checked' : ''} /> <span>Titles becoming available</span></label>
        <p class="muted small">A Discord or Slack incoming webhook works; the payload is a plain JSON message.</p>
      </fieldset>
      <button class="btn" type="submit">Save notification settings</button>
    </form>

    <form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="mail" />
      <input type="hidden" name="settingsTab" value="notifications" />
      <fieldset class="panel">
        <legend>Email (SMTP)</legend>
        <label class="checkbox">
          <input type="checkbox" name="smtpEnabled" ${settings['smtp.enabled'] === 'true' ? 'checked' : ''} />
          <span>Send notification email</span>
        </label>
        <div class="row-grid">
          <label>Server <input type="text" name="smtpHost" value="${escapeHtml(settings['smtp.host'])}" placeholder="smtp.example.com" /></label>
          <label>Port <input type="number" name="smtpPort" min="1" max="65535" value="${escapeHtml(settings['smtp.port'])}" /></label>
          <label>Security
            <select name="smtpSecurity">
              <option value="starttls" ${settings['smtp.security'] === 'starttls' ? 'selected' : ''}>STARTTLS (587)</option>
              <option value="ssl" ${settings['smtp.security'] === 'ssl' ? 'selected' : ''}>Implicit TLS (465)</option>
              <option value="none" ${settings['smtp.security'] === 'none' ? 'selected' : ''}>None (relay on this host)</option>
            </select>
          </label>
          <label>Username <input type="text" name="smtpUser" value="${escapeHtml(settings['smtp.user'])}" autocomplete="off" /></label>
          <label>Password <input type="password" name="smtpPassword" value="${escapeHtml(settings['smtp.password'])}" autocomplete="off" /></label>
          <label>From address <input type="email" name="smtpFrom" value="${escapeHtml(settings['smtp.from'])}" placeholder="discovarr@example.com" /></label>
          <label>From name <input type="text" name="smtpFromName" value="${escapeHtml(settings['smtp.fromName'])}" /></label>
          <label><input type="checkbox" name="smtpVerifyTls" ${settings['smtp.verifyTls'] === 'false' ? '' : 'checked'} /> Verify the server certificate</label>
          <p class="muted small">Leave this on. Turn it off only for a relay on your own network with a self-signed certificate.</p>
        </div>
        <p class="muted small">Email goes to the users who turn it on in Account and tick the events they want.</p>
        <div class="row">
          <button class="btn btn-sm" type="submit">Save mail settings</button>
          <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/test/mail">Send me a test message</button>
        </div>
      </fieldset>
    </form>`

  const logs = `<section class="panel">
      <h2 style="margin: 0">Recent activity</h2>
      <p class="muted small">The last ${audit.length} actions, newest first. Container output is available in <code>docker logs discovarr</code>.</p>
      <table class="table">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>
          ${
            audit.length
              ? audit
                  .map(
                    (entry) =>
                      `<tr><td>${escapeHtml(entry.createdAt.slice(0, 16).replace('T', ' '))}</td><td>${escapeHtml(entry.username)}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.detail)}</td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>'
          }
        </tbody>
      </table>
    </section>`

  const diag = diagnosticsSnapshot()
  const cache = cacheStats()

  // A failing sync used to be visible only in docker logs; surface it here with
  // the retry time so an administrator does not have to watch the container.
  const syncHealth = diag.sync.lastError
    ? `<section class="panel alert-panel">
        <h2 style="margin: 0">The last sync had errors</h2>
        <p class="muted small">${escapeHtml(diag.sync.lastError)}</p>
        ${
          diag.sync.nextAttemptAt
            ? `<p class="muted small">Attempt ${escapeHtml(String(diag.sync.attempts))}, retrying after ${escapeHtml(
                diag.sync.nextAttemptAt.replace('T', ' ').slice(0, 19)
              )}.</p>`
            : ''
        }
        <form method="post" action="/settings/sync"><button class="btn btn-sm" type="submit">Retry now</button></form>
      </section>`
    : ''

  const cachePanel = `<form method="post" action="/settings" class="stack panel">
      <h2 style="margin: 0">Artwork cache</h2>
      <p class="muted small">${cache.files} file(s), ${formatBytes(cache.bytes)}, in <code>${escapeHtml(cache.directory)}</code></p>
      <input type="hidden" name="settingsSection" value="cache" />
      <input type="hidden" name="settingsTab" value="tasks" />
      <div class="row-grid">
        <label>Maximum size (MB, 0 = unlimited)
          <input type="number" name="cacheMaxMb" min="0" value="${escapeHtml(settings['cache.maxMb'])}" />
        </label>
        <label>Delete images older than (days, 0 = never)
          <input type="number" name="cacheMaxAgeDays" min="0" value="${escapeHtml(settings['cache.maxAgeDays'])}" />
        </label>
      </div>
      <button class="btn btn-sm" type="submit">Save cache limits</button>
    </form>

    <form method="post" action="/settings/cache/prune" class="panel">
      <h2 style="margin: 0">Prune now</h2>
      <p class="muted small">Removes images past those limits, least recently used first. Posters are fetched from TMDB again the next time they are shown.</p>
      <button class="btn btn-sm btn-ghost" type="submit">Prune cache</button>
    </form>`

  const backupPanel = `<section class="panel">
      <h2 style="margin: 0">Backup and restore</h2>
      <p class="muted small">Every setting as one JSON file, so a move to another machine does not mean retyping keys.</p>
      <p><a class="btn btn-sm" href="/settings/export">Download settings file</a>
        <a class="btn btn-sm btn-ghost" href="/settings/export?secrets=1">Download with secrets</a></p>
      <form method="post" action="/settings/import" class="stack" data-restore-form>
        <label class="file-pick">Restore from a settings file
          <input type="file" accept=".json,application/json" data-restore-file />
        </label>
        <p class="muted small" data-restore-name hidden></p>
        <label>Or paste the JSON
          <textarea name="payload" rows="6" data-restore-payload placeholder="Paste the contents of discovarr-settings.json"></textarea>
        </label>
        <button class="btn btn-sm btn-ghost" type="submit">Restore settings</button>
        <p class="muted small">Only known settings are written and unknown keys are ignored. Blank secrets are skipped, so a redacted file cannot wipe keys that are already saved.</p>
      </form>
    </section>`

  const diagnosticsPanel = `<section class="panel">
      <h2 style="margin: 0">Diagnostics</h2>
      <table class="table">
        <tbody>
          <tr><th>Version</th><td>${escapeHtml(diag.version)} · Node ${escapeHtml(diag.node)} · ${escapeHtml(diag.platform)}</td></tr>
          <tr><th>Uptime</th><td>${escapeHtml(formatDuration(diag.uptimeSeconds))}</td></tr>
          <tr><th>Database</th><td>${formatBytes(diag.database.bytes)} (write-ahead log ${formatBytes(diag.database.walBytes)})</td></tr>
          <tr><th>Artwork cache</th><td>${diag.cache.files} file(s), ${formatBytes(diag.cache.bytes)}</td></tr>
          <tr><th>Catalog</th><td>${diag.counts.media} title(s) · ${diag.counts.users} user(s) · ${diag.counts.sessions} active session(s)</td></tr>
          <tr><th>Requests</th><td>${diag.counts.pending} pending · ${diag.counts.approved} approved · ${diag.counts.failed} failed · ${diag.counts.completed} completed · ${diag.counts.declined} declined</td></tr>
          <tr><th>Radarr</th><td>${escapeHtml(serviceLine(diag.services.radarr))}</td></tr>
          <tr><th>Sonarr</th><td>${escapeHtml(serviceLine(diag.services.sonarr))}</td></tr>
          <tr><th>Last sync</th><td>${diag.sync.lastRun ? escapeHtml(diag.sync.lastRun.replace('T', ' ').slice(0, 19)) : 'never'}${diag.sync.lastError ? ' · last attempt failed' : ''}</td></tr>
        </tbody>
      </table>
    </section>`

  const tasks = `<form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="tasks" />
      <input type="hidden" name="settingsTab" value="tasks" />
      <fieldset class="panel">
        <legend>Library sync</legend>
        <label>Interval (minutes, 0 disables)
          <input type="number" name="syncIntervalMinutes" min="0" value="${escapeHtml(settings['sync.intervalMinutes'])}" />
        </label>
        <label>Automatic retries of a failed dispatch
          <input type="number" name="maxAttempts" min="0" max="10" value="${escapeHtml(settings['requests.maxAttempts'])}" />
        </label>
        <p class="muted small">A failed dispatch is retried after two minutes, then four, and so on. At 0 only a manual retry runs.</p>
        <p class="muted small">Last run: ${sync.lastRun ? escapeHtml(sync.lastRun.replace('T', ' ').slice(0, 19)) : 'never'}${sync.running ? ' · running now' : ''}</p>
        ${sync.lastSummary ? `<p class="muted small">Last result: ${escapeHtml(JSON.stringify(sync.lastSummary.services))}</p>` : ''}
        <button class="btn btn-sm" type="submit">Save schedule</button>
      </fieldset>
    </form>

    <form method="post" action="/settings/sync" class="panel">
      <h2 style="margin: 0">Run a sync now</h2>
      <p class="muted small">Pulls the Radarr and Sonarr libraries and marks finished requests as available.</p>
      <button class="btn btn-sm btn-ghost" type="submit">Sync now</button>
    </form>

    ${syncHealth}
    ${cachePanel}
    ${backupPanel}
    ${diagnosticsPanel}`

  const content =
    current === 'users'
      ? usersTab
      : current === 'notifications'
        ? notifications
        : current === 'logs'
          ? logs
          : current === 'tasks'
            ? tasks
            : current === 'tokens'
              ? tokensPanel({ tokens, newToken })
              : current === 'general'
                ? general
                : integrations

  return `<h1>Settings</h1>
    ${alert({ notice, error })}
    ${settingsTabs(current)}
    ${content}`
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

function serviceFromBody(body, kind) {
  const service = {}

  // Only fields that were actually submitted are written, so a partial post
  // cannot blank a URL or key that is already saved.
  for (const [field, suffix] of [
    ['url', 'Url'],
    ['apiKey', 'ApiKey'],
    ['rootFolder', 'RootFolder'],
  ]) {
    if (body[`${kind}${suffix}`] !== undefined) service[field] = body[`${kind}${suffix}`]
  }

  // A form that carries the marker can turn a service off; without it an
  // unchecked box is indistinguishable from a field that was never shown.
  if (body[`${kind}EnabledSubmitted`] !== undefined) {
    service.enabled = body[`${kind}Enabled`] !== undefined
  } else if (body[`${kind}Enabled`] !== undefined) {
    service.enabled = true
  }

  const profile = body[`${kind}QualityProfile`]
  if (profile !== undefined) {
    const [id, name] = String(profile).split('|')
    service.qualityProfileId = id ?? ''
    service.qualityProfileName = name ?? ''
  }

  if (body[`${kind}ProfilesSubmitted`] !== undefined) {
    const picked = body[`${kind}ExtraProfile`]
    service.qualityProfiles = picked === undefined ? [] : [].concat(picked)
  }

  return service
}

/**
 * Root folders and profiles for every configured service, so the settings page
 * can show dropdowns without the extra "load" round trip. Failures are
 * swallowed: the form then falls back to free-text inputs.
 */
async function loadOptionsForPage({ fresh = false, kinds = ['radarr', 'sonarr'] } = {}) {
  const entries = await Promise.all(
    kinds.map(async (kind) => {
      if (!serviceSummary(kind).configured) return [kind, null]
      try {
        return [kind, await loadServiceOptions(kind, { fresh })]
      } catch {
        return [kind, null]
      }
    })
  )

  return Object.fromEntries(entries)
}

/** Stores the first folder and profile when the service has neither yet. */
function applyFirstServiceDefaults(kind, loaded, actor) {
  const service = serviceSummary(kind)
  const selection = {
    rootFolder: service.rootFolder || loaded.rootFolders[0]?.path || '',
    qualityProfileId:
      service.qualityProfileId || (loaded.qualityProfiles[0] ? String(loaded.qualityProfiles[0].id) : ''),
    qualityProfileName: service.qualityProfileName || loaded.qualityProfiles[0]?.name || '',
  }

  const unchanged =
    selection.rootFolder === String(service.rootFolder ?? '') &&
    selection.qualityProfileId === String(service.qualityProfileId ?? '') &&
    selection.qualityProfileName === String(service.qualityProfileName ?? '')

  if (!unchanged) saveServiceSelection(kind, selection, actor)
}

function settingsFromBody(body) {
  const section = body.settingsSection ?? ''
  const touchesServices = ['radarr', 'sonarr'].some((kind) =>
    ['Url', 'ApiKey', 'Enabled', 'EnabledSubmitted', 'RootFolder', 'QualityProfile', 'ProfilesSubmitted'].some(
      (suffix) => body[`${kind}${suffix}`] !== undefined
    )
  )

  const input = {}

  if (section === 'integrations' || touchesServices) {
    input.radarr = serviceFromBody(body, 'radarr')
    input.sonarr = serviceFromBody(body, 'sonarr')
  }

  const generalForm = section === '' || section === 'general' || section === 'integrations'

  if (generalForm) {
    if (body.appName !== undefined) input.appName = body.appName
    if (body.tmdbApiKey !== undefined) input.tmdbApiKey = body.tmdbApiKey
    if (body.tmdbRegion !== undefined) input.tmdbRegion = body.tmdbRegion
  }

  if (
    body.plexUrl !== undefined ||
    body.plexToken !== undefined ||
    body.plexEnabledSubmitted !== undefined
  ) {
    input.plex = {}
    if (body.plexUrl !== undefined) input.plex.url = body.plexUrl
    if (body.plexToken !== undefined) input.plex.token = body.plexToken
    if (body.plexEnabledSubmitted !== undefined) input.plex.enabled = body.plexEnabled !== undefined
    if (body.plexLoginSubmitted !== undefined) input.plex.login = body.plexLogin !== undefined
    if (body.plexImportSubmitted !== undefined) {
      input.plex.importWatchlist = body.plexImportWatchlist !== undefined
    }
  }

  if (section === 'notifications') {
    input.notifications = {
      webhookUrl: body.webhookUrl,
      onRequest: body.onRequest !== undefined,
      onApproval: body.onApproval !== undefined,
      onAvailable: body.onAvailable !== undefined,
    }
  }

  if (section === 'mail') {
    input.smtp = {
      enabled: body.smtpEnabled !== undefined,
      host: body.smtpHost,
      port: body.smtpPort,
      security: body.smtpSecurity,
      user: body.smtpUser,
      password: body.smtpPassword,
      from: body.smtpFrom,
      fromName: body.smtpFromName,
      verifyTls: body.smtpVerifyTls !== undefined,
    }
  }

  if (section === 'tasks') {
    if (body.syncIntervalMinutes !== undefined) input.syncIntervalMinutes = body.syncIntervalMinutes
    if (body.maxAttempts !== undefined) input.maxAttempts = body.maxAttempts
  }

  if (section === 'cache') {
    input.cache = {}
    if (body.cacheMaxMb !== undefined) input.cache.maxMb = body.cacheMaxMb
    if (body.cacheMaxAgeDays !== undefined) input.cache.maxAgeDays = body.cacheMaxAgeDays
  }

  return input
}

function permissionsFromBody(body) {
  const values = body.permission === undefined ? [] : [].concat(body.permission)
  return values.reduce((mask, value) => mask | Number(value), 0)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerPageRoutes(router) {
  router.get('/setup', ({ req, res, url }) => {
    if (store.countUsers() > 0) return redirect(res, currentUser(req) ? '/' : '/login')

    sendHtml(
      res,
      200,
      setupPage({
        appName: appName(),
        error: url.searchParams.get('err'),
        values: {},
        plex: plexLoginEnabled(),
      })
    )
  })

  router.post('/setup', async ({ req, res }) => {
    if (store.countUsers() > 0) return redirect(res, '/login')

    const body = await readBody(req)

    try {
      const user = createFirstAdmin({ email: body.email, username: body.username, password: body.password })
      const token = createSession(user.id)
      redirect(res, withMessage('/', 'notice', `Welcome, ${user.username}`), {
        'set-cookie': sessionCookie(token, req),
      })
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      sendHtml(
        res,
        error.status,
        setupPage({
          appName: appName(),
          error: error.message,
          values: { email: body.email ?? '', username: body.username ?? '' },
          plex: plexLoginEnabled(),
        })
      )
    }
  })

  router.get('/login', ({ req, res, url }) => {
    if (store.countUsers() === 0) return redirect(res, '/setup')
    if (currentUser(req)) return redirect(res, '/')

    sendHtml(
      res,
      200,
      loginPage({
        error: url.searchParams.get('err'),
        notice: url.searchParams.get('notice'),
        plex: plexLoginEnabled(),
      })
    )
  })

  router.post('/login', async ({ req, res }) => {
    const body = await readBody(req)
    const user = store.findUserByLogin(body.username ?? body.email ?? '')

    if (!user || !verifyPassword(String(body.password ?? ''), user.passwordHash)) {
      const limit = recordFailedLogin(req)

      return redirect(
        res,
        `/login?err=${encodeURIComponent(
          limit.allowed ? 'Incorrect username or password' : `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`
        )}`
      )
    }

    clearLoginAttempts(req)
    const token = createSession(user.id)
    // Every successful sign-in opens Discover.
    redirect(res, '/', { 'set-cookie': sessionCookie(token, req) })
  })

  // Plex sign-in: plex.tv holds the pin, then returns the browser here. One
  // profile signs straight in; several ask which one this account belongs to.
  router.get('/auth/plex', async ({ req, res }) => {
    if (!plexLoginEnabled()) {
      return redirect(res, `/login?err=${encodeURIComponent('Signing in with Plex is turned off')}`)
    }

    try {
      const pin = await createPlexPin()
      const forwardUrl = `${requestOrigin(req)}/auth/plex/callback`

      redirect(res, plexAuthUrl({ ...pin, forwardUrl }), {
        'set-cookie': shortLivedCookie(PLEX_PIN_COOKIE, `${pin.id}:${pin.code}`, req),
      })
    } catch (error) {
      redirect(res, `/login?err=${encodeURIComponent(error.message)}`)
    }
  })

  router.get('/auth/plex/callback', async ({ req, res, url }) => {
    const stored = String(parseCookies(req.headers.cookie)[PLEX_PIN_COOKIE] ?? '')
    const [pinId, pinCode] = stored.split(':')

    if (!pinId || !pinCode) {
      return redirect(res, `/login?err=${encodeURIComponent('That Plex sign-in expired. Start again.')}`)
    }

    try {
      let token = url.searchParams.get('authToken') ?? null
      // Plex normally has the token already when it forwards the browser back;
      // the poll covers an account that was slower to confirm.
      for (let attempt = 0; attempt < 4 && !token; attempt += 1) {
        token = await plexPinToken(pinId, pinCode)
        if (!token) await new Promise((resolve) => setTimeout(resolve, 600))
      }

      if (!token) {
        return redirect(
          res,
          `/login?err=${encodeURIComponent('Plex did not confirm the sign-in. Try again.')}`
        )
      }

      const profiles = await plexProfiles(token)

      // A lone profile with a home PIN still gets the picker, because that PIN
      // is the only thing standing between two people in a household.
      if (profiles.length > 1 || profiles.some((entry) => entry.protected)) {
        return sendHtml(res, 200, plexProfilePage({ profiles }), {
          'set-cookie': shortLivedCookie(PLEX_TOKEN_COOKIE, token, req),
        })
      }

      const profile = profiles[0] ?? null
      const profileToken = profile ? await plexSwitchProfile(token, profile.uuid).catch(() => token) : token

      await finishPlexSignIn({ req, res, token: profileToken, profile })
    } catch (error) {
      redirect(res, `/login?err=${encodeURIComponent(error.message)}`)
    }
  })

  router.post('/auth/plex/profile', async ({ req, res }) => {
    const token = String(parseCookies(req.headers.cookie)[PLEX_TOKEN_COOKIE] ?? '')
    const body = await readBody(req)
    const uuid = String(body.uuid ?? '')

    if (!token) {
      return redirect(res, `/login?err=${encodeURIComponent('That Plex sign-in expired. Start again.')}`)
    }
    if (!uuid) {
      return redirect(res, `/login?err=${encodeURIComponent('Pick a Plex profile')}`)
    }

    let profile = { uuid, title: 'Plex user', protected: false }
    try {
      const profiles = await plexProfiles(token)
      profile = profiles.find((entry) => entry.uuid === uuid) ?? profile

      const pin = String(body[`pin-${uuid}`] ?? '').trim()
      if (profile.protected && !/^\d{4}$/.test(pin)) {
        return sendHtml(
          res,
          200,
          plexProfilePage({ profiles, error: `Enter the 4-digit PIN for ${profile.title}` })
        )
      }

      const profileToken = await plexSwitchProfile(token, uuid, profile.protected ? pin : '')

      await finishPlexSignIn({ req, res, token: profileToken, profile })
    } catch (error) {
      // A wrong PIN deserves the picker again, not the sign-in page.
      if (profile.protected && (error.status === 401 || error.status === 403)) {
        try {
          const profiles = await plexProfiles(token)
          return sendHtml(
            res,
            200,
            plexProfilePage({ profiles, error: `That PIN is not right for ${profile.title}` })
          )
        } catch {
          // a Plex outage falls through to the sign-in page below
        }
      }
      redirect(res, `/login?err=${encodeURIComponent(error.message)}`)
    }
  })

  router.post('/logout', ({ req, res }) => {
    endSession(req)
    redirect(res, '/login', { 'set-cookie': clearedSessionCookie() })
  })

  router.get('/', async ({ req, res, url }) => {
    const user = pageUser(req, res, '/')
    if (!user) return

    const requestedType = parseType(url.searchParams.get('type'))
    const query = url.searchParams.get('q') ?? ''
    const page = pageNumber(url.searchParams.get('page'))
    const filters = filtersFromParams(url.searchParams)
    const plex = await plexEntries()
    const configured = tmdbConfigured()
    // A filtered view needs one media type: the tab in the URL, or the one the
    // filters imply (networks are television, studios are films).
    const mediaType =
      requestedType === MediaType.MOVIE || requestedType === MediaType.TV
        ? requestedType
        : filters.networks.length > 0 && filters.studios.length === 0
          ? MediaType.TV
          : MediaType.MOVIE

    let source = 'local'
    let currentPage = page
    let totalPages = 1
    let items = []
    let collections = null
    let rail = ''
    let filtered = false
    let error = url.searchParams.get('err')

    if (configured && !query && hasFilters(filters)) {
      try {
        const collectionMode = filters.collections && mediaType === MediaType.MOVIE
        const result = await discoverPage(mediaType, discoverQuery(mediaType, filters, filters.sort), {
          page: collectionMode ? 1 : page,
          sort: filters.sort,
        })
        source = 'tmdb'
        filtered = true
        currentPage = Math.min(result.page, result.totalPages)
        totalPages = result.totalPages
        // The switch shows the collections themselves, filled from the first
        // pages of results, not one card per film.
        collections = collectionMode
          ? (
              await scanCollections({
                mediaType,
                filters,
                first: result.items,
                totalPages: result.totalPages,
              })
            ).collections
          : null
        items = collections
          ? []
          : result.items.map((item) => ({ item, local: store.getMediaByTmdb(item.tmdbId, item.mediaType) }))
        rail = await discoverRail(mediaType, filters)
      } catch (tmdbError) {
        error = `TMDB unavailable: ${tmdbError.message}`
      }
    }

    if (!filtered) {
      items = getCatalog({ type: requestedType, query, userId: user.id }).map((item) => ({ item, local: item }))

      if (configured) {
        try {
          const found = query
            ? await searchPage(query, requestedType, page)
            : await trendingPage(requestedType, page)
          source = 'tmdb'
          totalPages = found.totalPages
          currentPage = Math.min(found.page, found.totalPages)
          items = found.items.map((item) => ({ item, local: store.getMediaByTmdb(item.tmdbId, item.mediaType) }))
          // Seeded rows have no artwork; the first browse fills it in from TMDB so
          // posters keep working on later visits without another lookup.
          for (const { item, local } of items) {
            if (local && !local.posterPath && item.posterPath) {
              store.setMediaArtwork(local.id, item.posterPath, item.backdropPath ?? null)
            }
          }
          if (!query) rail = await discoverRail(mediaType, filters)
        } catch (tmdbError) {
          source = 'local'
          error = `TMDB unavailable, showing the local catalog: ${tmdbError.message}`
          items = getCatalog({ type: requestedType, query, userId: user.id }).map((item) => ({ item, local: item }))
        }
      }

      if (source === 'local') {
        totalPages = Math.max(1, Math.ceil(items.length / PER_PAGE))
        currentPage = Math.min(page, totalPages)
        items = items.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE)
      }
    }

    render(res, 200, {
      title: 'Discover',
      user,
      active: 'discover',
      body: discoverBody({
        user,
        type: filtered ? mediaType : requestedType,
        query,
        source,
        items,
        page: currentPage,
        totalPages,
        error,
        plex,
        rail,
        filtered,
        filters,
        collections,
      }),
    })
  })

  // Suggestions for the Discover box. The form still submits normally, so a
  // failure here just means no dropdown.
  router.get('/search/suggest', async ({ req, res, url }) => {
    const user = currentUser(req)
    if (!user) {
      sendJson(res, 401, { results: [] })
      return
    }

    const query = (url.searchParams.get('q') ?? '').trim()
    const type = parseType(url.searchParams.get('type'))
    if (query.length < 2) {
      sendJson(res, 200, { results: [] })
      return
    }

    let found = []
    if (tmdbConfigured()) {
      try {
        found = await searchTmdb(query, type)
      } catch {
        found = []
      }
    }
    if (!found.length) found = getCatalog({ type, query, userId: user.id })

    const results = found.slice(0, 8).map((item) => {
      const local = item.tmdbId ? store.getMediaByTmdb(item.tmdbId, item.mediaType) : null
      const year = String(item.releaseDate ?? '').slice(0, 4)
      return {
        title: item.title,
        href: local ? `/media/${local.id}` : `/title/${item.mediaType}/${item.tmdbId}`,
        posterPath: local?.posterPath ?? item.posterPath ?? null,
        meta: `${item.mediaType === MediaType.TV ? 'Series' : 'Movie'}${year ? ` · ${year}` : ''}`,
        available: local?.status === MediaStatus.AVAILABLE,
      }
    })

    sendJson(res, 200, { results }, { 'cache-control': 'private, no-store' })
  })

  router.get('/networks', async ({ req, res, url }) => {
    const user = pageUser(req, res)
    if (!user) return

    render(res, 200, {
      title: 'Networks',
      user,
      active: 'discover',
      body: await catalogueBody({
        browse: 'networks',
        basePath: '/networks',
        mediaType: MediaType.TV,
        filters: filtersFromParams(url.searchParams),
        page: pageNumber(url.searchParams.get('page')),
        plex: await plexEntries(),
      }),
    })
  })

  router.get('/studios', async ({ req, res, url }) => {
    const user = pageUser(req, res)
    if (!user) return

    render(res, 200, {
      title: 'Studios',
      user,
      active: 'discover',
      body: await catalogueBody({
        browse: 'studios',
        basePath: '/studios',
        mediaType: MediaType.MOVIE,
        filters: filtersFromParams(url.searchParams),
        page: pageNumber(url.searchParams.get('page')),
        plex: await plexEntries(),
      }),
    })
  })

  router.get('/genres/:mediaType', async ({ req, res, url, params }) => {
    const user = pageUser(req, res)
    if (!user) return

    const mediaType =
      params.mediaType === MediaType.MOVIE || params.mediaType === MediaType.TV ? params.mediaType : null
    if (!mediaType) throw new HttpError(404, 'Unknown genre list')

    render(res, 200, {
      title: mediaType === MediaType.MOVIE ? 'Movie Genres' : 'Series Genres',
      user,
      active: 'discover',
      body: await catalogueBody({
        browse: mediaType === MediaType.MOVIE ? 'movie-genres' : 'tv-genres',
        basePath: `/genres/${mediaType}`,
        mediaType,
        filters: filtersFromParams(url.searchParams),
        page: pageNumber(url.searchParams.get('page')),
        plex: await plexEntries(),
      }),
    })
  })

  router.get('/person/:id', async ({ req, res, url, params }) => {
    const user = pageUser(req, res)
    if (!user) return

    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Person not found')

    if (!tmdbConfigured()) {
      return render(res, 200, {
        title: 'Person',
        user,
        active: 'discover',
        body: `<a class="back" href="/">← Back to discover</a>
          <h1>Person</h1>
          <p class="muted">This page is built from TMDB metadata. Add an API key under
            <a class="inline-link" href="/settings?tab=integrations">Settings → Integrations</a>.</p>`,
      })
    }

    try {
      const person = await personDetails(id)
      render(res, 200, {
        title: person.name,
        user,
        active: 'discover',
        body: personBody({
          person,
          page: pageNumber(url.searchParams.get('page')),
          plex: await plexEntries(),
        }),
      })
    } catch (error) {
      render(res, 502, {
        title: 'Person unavailable',
        user,
        active: 'discover',
        body: `<h1>Person unavailable</h1><p class="muted">${escapeHtml(error.message)}</p><a class="back" href="/">← Back to discover</a>`,
      })
    }
  })

  router.get('/recommendations', async ({ req, res }) => {
    const user = pageUser(req, res)
    if (!user) return

    render(res, 200, {
      title: 'Recommendations',
      user,
      active: 'discover',
      body: await recommendationsBody({ user, plex: await plexEntries() }),
    })
  })

  /** TMDB detail for the title page; null when TMDB is off or unreachable. */
  async function loadTitleDetails(mediaType, tmdbId) {
    if (!tmdbConfigured()) return null
    try {
      return await titleDetails(mediaType, Number(tmdbId))
    } catch {
      return null
    }
  }

  router.get('/media/:id', async ({ req, res, url, params }) => {
    const user = pageUser(req, res)
    if (!user) return

    try {
      const media = getMediaDetail(Number(params.id), user.id)
      const details = await loadTitleDetails(media.mediaType, media.tmdbId)
      const kind = media.mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr'
      const remote = await serviceLookup(kind, media.tmdbId)
      const collection = await loadCollection(details, media.mediaType, media.tmdbId, `/media/${media.id}`)
      render(res, 200, {
        title: media.title,
        user,
        active: 'discover',
        body: detailBody({
          user,
          media,
          details,
          notice: url.searchParams.get('notice'),
          error: url.searchParams.get('err'),
          plex: plexEntryFor(await plexEntries(), media.mediaType, media.tmdbId),
          remote,
          collection,
        }),
      })
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      render(res, error.status, {
        title: 'Not found',
        user,
        body: `<h1>Not found</h1><p class="muted">${escapeHtml(error.message)}</p><a class="back" href="/">← Back to discover</a>`,
      })
    }
  })

  // A title found on TMDB has no local row until someone requests it; this page
  // shows the full metadata either way.
  router.get('/title/:mediaType/:tmdbId', async ({ req, res, url, params }) => {
    const user = pageUser(req, res)
    if (!user) return

    const mediaType =
      params.mediaType === MediaType.TV || params.mediaType === MediaType.MOVIE ? params.mediaType : null
    const tmdbId = Number(params.tmdbId)

    if (!mediaType || !Number.isInteger(tmdbId) || tmdbId <= 0) throw new HttpError(404, 'Title not found')

    const local = store.getMediaByTmdb(tmdbId, mediaType)
    if (local) return redirect(res, `/media/${local.id}`)

    try {
      const details = await titleDetails(mediaType, tmdbId)
      const remote = await serviceLookup(mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr', tmdbId)
      const collection = await loadCollection(details, mediaType, tmdbId, `/title/${mediaType}/${tmdbId}`)
      render(res, 200, {
        title: details?.title ?? 'Title',
        user,
        active: 'discover',
        body: detailBody({
          user,
          media: null,
          details,
          notice: url.searchParams.get('notice'),
          error: url.searchParams.get('err'),
          plex: plexEntryFor(await plexEntries(), mediaType, tmdbId),
          remote,
          collection,
          trailer: await trailerFor(mediaType, tmdbId),
        }),
      })
    } catch (error) {
      render(res, 502, {
        title: 'Title unavailable',
        user,
        active: 'discover',
        body: `<h1>Title unavailable</h1><p class="muted">${escapeHtml(error.message)}</p><a class="back" href="/">← Back to discover</a>`,
      })
    }
  })

  router.post('/media/:id/request', async ({ req, res, params }) => {
    const user = requireUser(req)
    const body = await readBody(req)
    const returnTo = safeReturn(body.returnTo, `/media/${params.id}`)

    try {
      const seasonNumbers = seasonSelection(body)

      await requestMedia({
        mediaId: Number(params.id),
        userId: user.id,
        seasonNumbers,
        qualityProfileId: body.qualityProfile ? Number(body.qualityProfile) : null,
        profileIndex: body.profile !== undefined && body.profile !== '' ? Number(body.profile) : null,
      })
      redirect(res, withMessage(returnTo, 'notice', 'Request submitted'))
    } catch (error) {
      failure(res, returnTo, error)
    }
  })

  router.post('/media/import', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)
    const returnTo = safeReturn(body.returnTo, '/')

    try {
      await requestMedia({
        mediaType: body.mediaType,
        tmdbId: Number(body.tmdbId),
        userId: user.id,
        seasonNumbers: seasonSelection(body),
        profileIndex: body.profile !== undefined && body.profile !== '' ? Number(body.profile) : null,
      })
      redirect(res, withMessage('/requests', 'notice', 'Request submitted'))
    } catch (error) {
      failure(res, returnTo, error)
    }
  })

  router.post('/media/:id/available', ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'You cannot mark titles available')

    try {
      markAvailable(Number(params.id), actor)
      redirect(res, withMessage('/requests', 'notice', 'Marked as available'))
    } catch (error) {
      failure(res, '/requests', error)
    }
  })

  // A season's episodes are fetched by the series page when the season is
  // opened, so a twenty-season show asks TMDB for one list, not twenty.
  router.get('/partial/tv/:tmdbId/season/:seasonNumber', async ({ req, res, params }) => {
    const user = pageUser(req, res)
    if (!user) return

    const tmdbId = Number(params.tmdbId)
    const seasonNumber = Number(params.seasonNumber)
    if (!Number.isInteger(tmdbId) || !Number.isInteger(seasonNumber)) throw new HttpError(400, 'Unknown season')

    try {
      sendHtml(res, 200, episodesHtml(await seasonDetails(tmdbId, seasonNumber)))
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'Episodes could not be loaded'
      sendHtml(res, 200, `<p class="muted small">${escapeHtml(message)}</p>`)
    }
  })

  // Requesting from the collection panel files one request per ticked film; a
  // film that is already there is reported instead of failing the whole batch.
  router.post('/collection/:id/request', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)
    const returnTo = safeReturn(body.returnTo, '/')
    const ids = [...new Set([].concat(body.tmdbId ?? []).map(Number))].filter(
      (id) => Number.isInteger(id) && id > 0
    )

    if (ids.length === 0) {
      redirect(res, withMessage(returnTo, 'err', 'Pick at least one film'))
      return
    }

    let done = 0
    let skipped = 0

    for (const tmdbId of ids) {
      try {
        await requestMedia({ mediaType: MediaType.MOVIE, tmdbId, userId: user.id, seasonNumbers: null })
        done += 1
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        skipped += 1
      }
    }

    const message = `${done} film${done === 1 ? '' : 's'} requested${skipped ? ` · ${skipped} skipped` : ''}`
    redirect(res, withMessage(returnTo, done ? 'notice' : 'err', message))
  })

  router.post('/watchlist/toggle', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)
    const returnTo = safeReturn(body.returnTo, '/watchlist')

    const tmdbId = Number(body.tmdbId)
    const mediaType = body.mediaType === MediaType.TV ? MediaType.TV : MediaType.MOVIE

    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      return redirect(res, withMessage(returnTo, 'err', 'Unknown title'))
    }

    const result = store.toggleWatchlist(user.id, {
      tmdbId,
      mediaType,
      title: String(body.title ?? 'Untitled'),
      posterPath: String(body.posterPath ?? '') || null,
      releaseDate: String(body.releaseDate ?? '') || null,
    })

    redirect(
      res,
      withMessage(returnTo, 'notice', result.added ? 'Saved to your watchlist' : 'Removed from your watchlist')
    )
  })

  router.get('/watchlist', ({ req, res, url }) => {
    const user = pageUser(req, res)
    if (!user) return

    render(res, 200, {
      title: 'Watchlist',
      user,
      active: 'watchlist',
      body: watchlistBody({
        items: store.listWatchlist(user.id),
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('err'),
      }),
    })
  })

  // The hover card asks about one title at a time. Metadata only, and only for a
  // signed-in member, so it cannot be used as an open TMDB proxy.
  router.get('/preview/:mediaType/:tmdbId', async ({ req, res, params }) => {
    if (!currentUser(req)) return sendJson(res, 401, { error: 'Sign in first' })

    const mediaType = parseType(params.mediaType)
    if (mediaType === 'all' || !/^\d+$/.test(String(params.tmdbId))) {
      return sendJson(res, 400, { error: 'Unknown title' })
    }

    const tmdbId = Number(params.tmdbId)
    const local = store.getMediaByTmdb(tmdbId, mediaType)
    let details = null
    try {
      details = await tmdbDetails(mediaType, tmdbId)
    } catch {
      details = null
    }

    const active = local
      ? store.listRequestsForMedia(local.id).filter((request) => request.status === 1 || request.status === 2)
      : []
    const status = local?.status === MediaStatus.AVAILABLE ? 'In library' : active.length ? 'Requested' : ''
    const year = String(details?.releaseDate ?? local?.releaseDate ?? '').slice(0, 4)

    sendJson(res, 200, {
      title: details?.title ?? local?.title ?? '',
      meta: [mediaType === MediaType.TV ? 'Series' : 'Film', year || null, status || null]
        .filter(Boolean)
        .join(' · '),
      overview: details?.overview ?? local?.overview ?? '',
      posterPath: details?.posterPath ?? local?.posterPath ?? null,
    })
  })

  // Calendar apps cannot send headers or cookies, so the feed accepts a personal
  // API token in the query string; the same URL therefore works in any client.
  router.get('/calendar.ics', async ({ req, res, url }) => {
    const token = url.searchParams.get('token')
    const user = currentUser(req) ?? (token ? userForApiToken(token) : null)

    if (!user) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end('A personal API token is required: Account → API tokens.')
    }

    let items = []
    try {
      items = await loadUpcoming({ days: 120, limit: 200 })
    } catch {
      items = []
    }

    // The feed follows the page: only titles in the library or asked for, plus
    // the subscriber's own watchlist.
    const scope = calendarScope()
    const watchlist = store.listWatchlist(user.id).map((entry) => ({ ...entry, watchlist: true }))
    const followed = items
      .filter((item) => scope.has(`${item.mediaType}:${item.tmdbId}`))
      .map((item) => ({ ...item, ...scope.get(`${item.mediaType}:${item.tmdbId}`) }))
    const body = buildReleaseCalendar({ appName: appName(), items: [...watchlist, ...followed] })

    res.writeHead(200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="discovarr.ics"',
      'cache-control': 'no-store',
    })
    res.end(body)
  })

  router.get('/activity', async ({ req, res, url }) => {
    const user = pageUser(req, res)
    if (!user) return

    const canManage = hasPermission(user, Permission.MANAGE_SETTINGS)
    const maxAttempts = Number(store.getSetting('requests.maxAttempts') ?? 3)

    render(res, 200, {
      title: 'Activity',
      user,
      active: 'activity',
      body: activityBody({
        user,
        canManage,
        retry: store.listRetryQueue(canManage ? {} : { userId: user.id }),
        maxAttempts,
        queue: canManage ? await downloadQueue({ limit: 15 }) : [],
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('err'),
      }),
    })
  })

  router.get('/calendar', async ({ req, res, url }) => {
    const user = pageUser(req, res)
    if (!user) return

    const month = monthBounds(url.searchParams.get('month'))
    let items = []
    let error = url.searchParams.get('err')

    try {
      items = await loadUpcoming({
        from: month.start.toISOString().slice(0, 10),
        until: month.end.toISOString().slice(0, 10),
        limit: 200,
      })
    } catch (failure) {
      error = failure instanceof HttpError ? failure.message : 'The calendar could not be loaded'
    }

    items = calendarEntries(items, calendarScope(), month)

    render(res, 200, {
      title: 'Calendar',
      user,
      active: 'calendar',
      body: calendarBody({ items, month, notice: url.searchParams.get('notice'), error }),
    })
  })

  router.get('/collection/:id', async ({ req, res, params, url }) => {
    const user = pageUser(req, res)
    if (!user) return

    try {
      const collection = await collectionDetails(Number(params.id))
      const parts = collection.parts.map((part) => ({ ...part, ...collectionPartState(part.tmdbId) }))

      render(res, 200, {
        title: collection.name,
        user,
        active: 'discover',
        body: collectionPageBody({
          collection,
          parts,
          notice: url.searchParams.get('notice'),
          error: url.searchParams.get('err'),
        }),
      })
    } catch (error) {
      render(res, 502, {
        title: 'Collection unavailable',
        user,
        active: 'discover',
        body: `<h1>Collection unavailable</h1><p class="muted">${escapeHtml(error.message)}</p><a class="back" href="/">← Back to discover</a>`,
      })
    }
  })

  router.post('/requests/bulk', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'You cannot manage requests')
    const body = await readBody(req)
    const returnTo = safeReturn(body.returnTo, '/requests')
    const action = String(body.action ?? '')
    const ids = [...new Set([].concat(body.ids ?? []).map(Number))].filter(
      (id) => Number.isInteger(id) && id > 0
    )

    if (ids.length === 0) return redirect(res, withMessage(returnTo, 'err', 'Tick at least one request first'))

    if (!['approve', 'decline', 'retry', 'delete'].includes(action)) {
      return redirect(res, withMessage(returnTo, 'err', 'Unknown bulk action'))
    }

    let done = 0
    const problems = []

    for (const id of ids) {
      try {
        if (action === 'approve') await approveRequest(id, actor)
        else if (action === 'retry') await retryRequest(id, actor)
        else if (action === 'decline') declineRequest(id, actor)
        else deleteRequest(id, actor)
        done += 1
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        problems.push(`#${id}: ${error.message}`)
      }
    }

    const label = { approve: 'approved', decline: 'declined', retry: 'retried', delete: 'deleted' }[action]
    const message = `${done} request${done === 1 ? '' : 's'} ${label}${
      problems.length ? ` · ${problems.join('; ')}` : ''
    }`

    redirect(res, withMessage(returnTo, problems.length ? 'err' : 'notice', message))
  })

  router.get('/requests', ({ req, res, url }) => {
    const user = pageUser(req, res, '/requests')
    if (!user) return

    const filter = url.searchParams.get('filter') ?? 'all'
    const result = listRequestsFor(user, filter, {
      page: Number(url.searchParams.get('page') ?? 1),
      take: 12,
    })

    render(res, 200, {
      title: 'Requests',
      user,
      active: 'requests',
      body: requestsBody({
        user,
        result,
        filter,
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('err'),
      }),
    })
  })

  router.post('/requests/:id/approve', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'You cannot approve requests')

    try {
      const request = await approveRequest(Number(params.id), actor)
      const message =
        request.status === 4
          ? `Dispatch failed: ${request.note ?? 'see the request note'}`
          : 'Request approved'
      redirect(res, withMessage('/requests', request.status === 4 ? 'err' : 'notice', message))
    } catch (error) {
      failure(res, '/requests', error)
    }
  })

  router.post('/requests/:id/decline', ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'You cannot decline requests')

    try {
      declineRequest(Number(params.id), actor)
      redirect(res, withMessage('/requests', 'notice', 'Request declined'))
    } catch (error) {
      failure(res, '/requests', error)
    }
  })

  router.post('/requests/:id/retry', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'You cannot retry requests')

    try {
      await retryRequest(Number(params.id), actor)
      redirect(res, withMessage('/requests', 'notice', 'Retried'))
    } catch (error) {
      failure(res, '/requests', error)
    }
  })

  router.post('/requests/:id/delete', ({ req, res, params }) => {
    const user = requireUser(req)

    try {
      deleteRequest(Number(params.id), user)
      redirect(res, withMessage('/requests', 'notice', 'Request removed'))
    } catch (error) {
      failure(res, '/requests', error)
    }
  })

  router.get('/notifications', ({ req, res, url }) => {
    const user = pageUser(req, res)
    if (!user) return

    render(res, 200, {
      title: 'Notifications',
      user,
      active: 'notifications',
      body: notificationsBody({
        items: store.listNotifications(user.id),
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('err'),
      }),
    })
  })

  router.post('/notifications/read', ({ req, res }) => {
    const user = requireUser(req)
    store.markNotificationsRead(user.id)
    redirect(res, withMessage('/notifications', 'notice', 'All notifications marked read'))
  })

  router.get('/account', ({ req, res, url }) => {
    const user = pageUser(req, res, '/account')
    if (!user) return

    render(res, 200, {
      title: 'Account',
      user,
      active: 'account',
      body: accountBody({
        user,
        quota: quotaSummary(user),
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('err'),
      }),
    })
  })

  router.post('/settings/tokens', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')
    const body = await readBody(req)
    const name = String(body.name ?? '').trim().slice(0, 60) || 'API token'

    const token = `dcv_${randomBytes(24).toString('base64url')}`
    store.createApiToken({
      userId: actor.id,
      name,
      prefix: token.slice(0, 10),
      tokenHash: hashApiToken(token),
    })
    store.recordAudit(actor.id, 'account.token_created', name)

    // Shown once, on the response to the creation itself, so it never appears
    // in a redirect URL or a log line.
    renderSettings(res, actor, { tab: 'tokens', newToken: token, notice: 'Token created' })
  })

  router.post('/settings/tokens/:id/delete', ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')
    const removed = store.deleteApiToken(Number(params.id), actor.id)
    store.recordAudit(actor.id, 'account.token_revoked', String(params.id))

    redirect(
      res,
      withMessage('/settings?tab=tokens', removed ? 'notice' : 'err', removed ? 'Token revoked' : 'Token not found')
    )
  })

  router.post('/account/notifications', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)

    try {
      updateNotifications(user, {
        notifyEmail: body.notifyEmail !== undefined,
        events: body.events,
      })
      redirect(res, withMessage('/account', 'notice', 'Notification preferences saved'))
    } catch (error) {
      failure(res, '/account', error)
    }
  })

  router.post('/account/password', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)

    try {
      const result = changePassword(user, body.currentPassword, body.newPassword, sessionToken(req))
      redirect(res, withMessage('/account', 'notice', `Password updated (${result.revoked} other session(s) signed out)`))
    } catch (error) {
      failure(res, '/account', error)
    }
  })

  router.get('/settings/backup', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot download a backup')

    const snapshot = store.snapshotDatabase()
    store.recordAudit(actor.id, 'settings.backup_downloaded', `${snapshot.length} bytes`)

    res.writeHead(200, {
      'content-type': 'application/vnd.sqlite3',
      'content-disposition': `attachment; filename="discovarr-${new Date().toISOString().slice(0, 10)}.sqlite"`,
      'cache-control': 'no-store',
      'content-length': snapshot.length,
    })
    res.end(snapshot)
  })

  /** The settings page in one call, so POST handlers can answer without a redirect. */
  async function renderSettings(res, actor, { tab, notice = null, error = null, tokens = null, newToken = null }) {
    render(res, 200, {
      title: 'Settings',
      user: actor,
      active: 'settings',
      body: settingsBody({
        user: actor,
        settings: store.getSettings(),
        users: store.listUsers(),
        audit: store.listAudit(30),
        options: await loadOptionsForPage(),
        tab,
        tokens: tokens ?? store.listApiTokens(actor.id),
        newToken,
        notice,
        error,
      }),
    })
  }

  router.get('/settings', async ({ req, res, url }) => {
    const user = pageUser(req, res, '/settings')
    if (!user) return

    if (!hasPermission(user, Permission.MANAGE_SETTINGS)) {
      return redirect(res, withMessage('/', 'err', 'You cannot change settings'))
    }

    render(res, 200, {
      title: 'Settings',
      user,
      active: 'settings',
      body: settingsBody({
        user,
        settings: store.getSettings(),
        users: store.listUsers(),
        audit: store.listAudit(30),
        options: await loadOptionsForPage(),
        tokens: store.listApiTokens(user.id),
        tab: url.searchParams.get('tab') ?? 'general',
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('err'),
      }),
    })
  })

  router.post('/settings', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')
    const body = await readBody(req)

    try {
      updateSettings(settingsFromBody(body), actor)
      if (body.plexUrl !== undefined || body.plexToken !== undefined || body.plexEnabledSubmitted !== undefined) {
        forgetPlex()
      }
      const tab = SETTINGS_TABS.some(([key]) => key === body.settingsTab) ? body.settingsTab : 'general'
      redirect(res, withMessage(`/settings?tab=${tab}`, 'notice', 'Settings saved'))
    } catch (error) {
      failure(res, '/settings', error)
    }
  })

  router.post('/settings/test/:kind', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')

    if (!['sonarr', 'radarr', 'plex', 'mail'].includes(params.kind)) {
      return redirect(res, withMessage('/settings', 'err', 'Unknown service'))
    }

    try {
      updateSettings(settingsFromBody(await readBody(req)), actor)
      if (params.kind === 'plex') forgetPlex()
      else if (params.kind !== 'mail') forgetServiceOptions(params.kind)
    } catch (error) {
      return failure(res, '/settings', error)
    }

    if (params.kind === 'mail') {
      const settings = store.getSettings()
      const body = {
        user: actor,
        settings,
        users: store.listUsers(),
        audit: store.listAudit(30),
        options: await loadOptionsForPage(),
        tab: 'notifications',
      }

      try {
        const result = await sendTestMail(actor.email)
        return render(res, 200, {
          title: 'Settings',
          user: actor,
          active: 'settings',
          body: settingsBody({ ...body, notice: result.detail, error: null }),
        })
      } catch (error) {
        return render(res, 200, {
          title: 'Settings',
          user: actor,
          active: 'settings',
          body: settingsBody({ ...body, notice: null, error: `Mail test failed: ${error.message}` }),
        })
      }
    }

    if (params.kind === 'plex') {
      const plexResult = await testPlexConnection()

      return render(res, 200, {
        title: 'Settings',
        user: actor,
        active: 'settings',
        body: settingsBody({
          user: actor,
          settings: store.getSettings(),
          users: store.listUsers(),
          audit: store.listAudit(30),
          options: await loadOptionsForPage(),
          tab: 'integrations',
          notice: plexResult.ok ? plexResult.detail : null,
          error: plexResult.ok ? null : plexResult.error,
        }),
      })
    }

    const result = await testServiceConnection(params.kind)

    // A working connection means the folders and profiles can be pulled in the
    // same click, instead of asking for a second "load" round trip.
    const options = result.ok ? await loadOptionsForPage({ fresh: true, kinds: [params.kind] }) : {}
    const loaded = options[params.kind] ?? null
    if (loaded) applyFirstServiceDefaults(params.kind, loaded, actor)

    const loadedDetail = loaded
      ? ` · ${loaded.rootFolders.length} root folder(s) and ${loaded.qualityProfiles.length} profile(s) loaded`
      : ''

    render(res, 200, {
      title: 'Settings',
      user: actor,
      active: 'settings',
      body: settingsBody({
        user: actor,
        settings: store.getSettings(),
        users: store.listUsers(),
        audit: store.listAudit(30),
        options,
        tab: 'integrations',
        notice: result.ok ? `${result.detail}${loadedDetail}` : null,
        error: result.ok ? null : result.error,
      }),
    })
  })

  router.post('/settings/options/:kind', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')

    if (!['sonarr', 'radarr'].includes(params.kind)) {
      return redirect(res, withMessage('/settings', 'err', 'Unknown service'))
    }

    const body = await readBody(req)

    try {
      updateSettings(settingsFromBody(body), actor)
    } catch (error) {
      return failure(res, '/settings', error)
    }

    try {
      forgetServiceOptions(params.kind)
      const loaded = await loadServiceOptions(params.kind, { fresh: true })
      const options = { [params.kind]: loaded }
      applyFirstServiceDefaults(params.kind, loaded, actor)
      render(res, 200, {
        title: 'Settings',
        user: actor,
        active: 'settings',
        body: settingsBody({
          user: actor,
          settings: store.getSettings(),
          users: store.listUsers(),
          audit: store.listAudit(30),
          options,
          tab: 'integrations',
          notice: `Loaded ${loaded.rootFolders.length} root folder(s) and ${loaded.qualityProfiles.length} profile(s)`,
          error: null,
        }),
      })
    } catch (error) {
      render(res, 200, {
        title: 'Settings',
        user: actor,
        active: 'settings',
        body: settingsBody({
          user: actor,
          settings: store.getSettings(),
          users: store.listUsers(),
          audit: store.listAudit(30),
          options: null,
          tab: 'integrations',
          notice: null,
          error: error.message,
        }),
      })
    }
  })

  router.post('/settings/profiles/:kind/add', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')

    if (!['sonarr', 'radarr'].includes(params.kind)) {
      return redirect(res, withMessage('/settings?tab=integrations', 'err', 'Unknown service'))
    }

    const body = await readBody(req)

    try {
      addServiceProfile(
        params.kind,
        {
          name: body.name,
          qualityProfile: body.profileSelect,
          rootFolder: body.rootFolder,
          isDefault: body.makeDefault !== undefined,
        },
        actor
      )
      redirect(
        res,
        withMessage('/settings?tab=integrations', 'notice', `Profile "${String(body.name ?? '').trim()}" added`)
      )
    } catch (error) {
      failure(res, '/settings?tab=integrations', error)
    }
  })

  router.post('/settings/profiles/:kind/edit', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')

    if (!['sonarr', 'radarr'].includes(params.kind)) {
      return redirect(res, withMessage('/settings?tab=integrations', 'err', 'Unknown service'))
    }

    const body = await readBody(req)

    try {
      editServiceProfile(
        params.kind,
        body.originalName,
        {
          name: body.name,
          qualityProfile: body.profileSelect,
          rootFolder: body.rootFolder,
          isDefault: body.makeDefault !== undefined,
        },
        actor
      )
      redirect(
        res,
        withMessage('/settings?tab=integrations', 'notice', `Profile "${String(body.name ?? '').trim()}" saved`)
      )
    } catch (error) {
      failure(res, '/settings?tab=integrations', error)
    }
  })

  router.post('/settings/profiles/:kind/default', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')

    if (!['sonarr', 'radarr'].includes(params.kind)) {
      return redirect(res, withMessage('/settings?tab=integrations', 'err', 'Unknown service'))
    }

    const body = await readBody(req)

    try {
      setDefaultServiceProfile(params.kind, body.name, actor)
      redirect(res, withMessage('/settings?tab=integrations', 'notice', 'Default profile updated'))
    } catch (error) {
      failure(res, '/settings?tab=integrations', error)
    }
  })

  router.post('/settings/profiles/:kind/delete', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')

    if (!['sonarr', 'radarr'].includes(params.kind)) {
      return redirect(res, withMessage('/settings?tab=integrations', 'err', 'Unknown service'))
    }

    const body = await readBody(req)

    try {
      removeServiceProfile(params.kind, body.name, actor)
      redirect(res, withMessage('/settings?tab=integrations', 'notice', `Profile "${body.name}" removed`))
    } catch (error) {
      failure(res, '/settings?tab=integrations', error)
    }
  })

  router.post('/settings/sync', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot run a sync')

    try {
      const result = await syncLibrary({ actorId: actor.id })
      const message = result.ok
        ? `Sync finished: ${result.summary.updated} updated, ${result.summary.completed} completed`
        : `Sync had errors: ${result.summary.errors.join(' | ')}`
      redirect(res, withMessage('/settings?tab=tasks', result.ok ? 'notice' : 'err', message))
    } catch (error) {
      failure(res, '/settings', error)
    }
  })

  router.post('/settings/cache/prune', ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')
    const settings = store.getSettings()

    const result = pruneCache({
      maxMb: Number(settings['cache.maxMb'] ?? 500),
      maxAgeDays: Number(settings['cache.maxAgeDays'] ?? 60),
    })

    store.recordAudit(
      actor.id,
      'settings.cache_pruned',
      `${result.removed} file(s), ${formatBytes(result.bytes)} freed`
    )
    redirect(
      res,
      withMessage(
        '/settings?tab=tasks',
        'notice',
        result.removed
          ? `Removed ${result.removed} cached image(s), freeing ${formatBytes(result.bytes)}`
          : 'The cache is already within its limits'
      )
    )
  })

  router.get('/settings/export', ({ req, res, url }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')
    const includeSecrets = url.searchParams.get('secrets') === '1'
    const settings = store.getSettings()

    store.recordAudit(actor.id, 'settings.exported', includeSecrets ? 'including secrets' : 'secrets redacted')

    sendJson(
      res,
      200,
      {
        app: 'discovarr',
        version: BUILD_VERSION,
        exportedAt: new Date().toISOString(),
        settings: includeSecrets ? settings : redactSettings(settings),
      },
      { 'content-disposition': 'attachment; filename="discovarr-settings.json"' }
    )
  })

  router.post('/settings/import', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')
    const body = await readBody(req)

    try {
      const result = importSettings([].concat(body.payload ?? '')[0])
      store.recordAudit(actor.id, 'settings.imported', `${result.applied} key(s)`)
      redirect(
        res,
        withMessage(
          '/settings?tab=tasks',
          'notice',
          `Imported ${result.applied} setting(s)${
            result.ignored.length ? ` · ignored ${result.ignored.length} unknown key(s)` : ''
          }`
        )
      )
    } catch (error) {
      failure(res, '/settings?tab=tasks', error)
    }
  })

  router.post('/settings/users', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_USERS, 'You cannot manage users')
    const body = await readBody(req)

    try {
      const created = createUserByAdmin(
        {
          email: body.email,
          username: body.username,
          password: body.password,
          role: body.role,
          permissions: DEFAULT_USER_PERMISSIONS,
        },
        actor
      )
      redirect(res, withMessage('/settings?tab=users', 'notice', `Created user ${created.username}`))
    } catch (error) {
      failure(res, '/settings', error)
    }
  })

  router.post('/settings/users/:id', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_USERS, 'You cannot manage users')

    if (Number(params.id) === actor.id) {
      return redirect(res, withMessage('/settings?tab=users', 'err', 'Use the Account page to change your own details'))
    }

    const body = await readBody(req)

    try {
      const updated = updateUserByAdmin(
        Number(params.id),
        {
          role: body.role,
          permissions: body.role === Role.ADMIN ? ALL_PERMISSIONS : permissionsFromBody(body),
          quotaMovie: body.quotaMovie,
          quotaTv: body.quotaTv,
        },
        actor
      )
      redirect(res, withMessage('/settings?tab=users', 'notice', `Updated ${updated.username}`))
    } catch (error) {
      failure(res, '/settings', error)
    }
  })

  router.post('/settings/users/:id/delete', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_USERS, 'You cannot manage users')

    try {
      const removed = deleteUserByAdmin(Number(params.id), actor)
      redirect(res, withMessage('/settings?tab=users', 'notice', `Deleted ${removed.username}`))
    } catch (error) {
      failure(res, '/settings?tab=users', error)
    }
  })
}

import { DEFAULT_USER_PERMISSIONS } from './constants.js'
