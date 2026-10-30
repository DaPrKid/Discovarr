import { clearedSessionCookie, createSession, currentUser, endSession, hasPermission, requirePermission, requireUser, sessionCookie, sessionToken } from './auth.js'
import { config } from './config.js'
import {
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
import { HttpError, readBody, redirect, sendHtml, sendJson } from './http.js'
import { verifyPassword } from './passwords.js'
import { clientKey, createRateLimiter } from './ratelimit.js'
import {
  forgetServiceOptions,
  loadServiceOptions,
  serviceProfiles,
  serviceSummary,
  testServiceConnection,
} from './services.js'
import {
  discoverPage,
  genreList,
  genreShelves,
  networkById,
  networkDirectory,
  networkShelves,
  networkWithLogo,
  recommendedTitles,
  searchPage,
  searchTmdb,
  studioById,
  studioDirectory,
  studioShelves,
  studioWithLogo,
  titleDetails,
  tmdbConfigured,
  trendingPage,
} from './tmdb.js'
import { forgetPlex, plexEntries, plexEntryFor, plexSettings, testPlexConnection } from './plex.js'
import { syncLibrary, syncState } from './sync.js'
import {
  alert,
  escapeHtml,
  layout,
  mediaCard,
  pagination,
  permissionList,
  poster,
  requestCard,
  statusBadge,
} from './views.js'

const loginLimiter = createRateLimiter({ windowMs: config.loginRateWindowMs, max: config.loginRateLimit })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appName() {
  return store.getSetting('app.name')
}

function safeReturn(value, fallback = '/') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback
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
  sendHtml(
    res,
    status,
    layout({
      appName: appName(),
      title,
      user,
      active,
      body,
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

function loginPage({ error, notice }) {
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
    </section>`,
  })
}

function setupPage({ appName, error, values = {} }) {
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
    </section>`,
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
    <p class="browse-heading">Browse</p>
    <a class="browse-link ${browse ? '' : 'is-active'}" href="/">Discover</a>
    ${BROWSE_LINKS.map(
      ([key, href, label]) =>
        `<a class="browse-link ${browse === key ? 'is-active' : ''}" href="${href}">${label}</a>`
    ).join('')}
  </aside>`
}

function discoverLayout(browse, body) {
  return `<div class="discover">${browseNav(browse)}<div class="discover-main">${body}</div></div>`
}

function plexFor(plex, mediaType, tmdbId) {
  return plexEntryFor(plex, mediaType, tmdbId)
}

/** A poster grid, with each title linked to its local record when it exists. */
function mediaGrid(items, { returnTo = '/', plex = {} } = {}) {
  if (!items.length) return '<p class="empty">Nothing found.</p>'

  return `<div class="grid">${items
    .map((item) => {
      const local = store.getMediaByTmdb(item.tmdbId, item.mediaType)
      return mediaCard(item, { returnTo, local, plex: plexFor(plex, item.mediaType, item.tmdbId) })
    })
    .join('')}</div>`
}

/** One browsable row: a network, studio or genre and the titles it made. */
function shelf(title, items, href, plex, { logoPath = null } = {}) {
  if (!items.length) return ''

  const logo = logoPath
    ? `<img class="shelf-logo" src="${escapeHtml(artwork(logoPath, 'w154'))}" alt="" loading="lazy" />`
    : ''

  return `<section class="shelf">
    <div class="shelf-head">
      <div class="shelf-title">${logo}<h2>${escapeHtml(title)}</h2></div>
      <a class="inline-link" href="${escapeHtml(href)}">See all →</a>
    </div>
    <div class="shelf-row">${items
      .map((item) =>
        mediaCard(item, {
          returnTo: href,
          local: store.getMediaByTmdb(item.tmdbId, item.mediaType),
          plex: plexFor(plex, item.mediaType, item.tmdbId),
        })
      )
      .join('')}</div>
  </section>`
}

function brandLogo(name, logoPath) {
  const inner = logoPath
    ? `<img src="${escapeHtml(artwork(logoPath, 'w154'))}" alt="${escapeHtml(name)} logo" loading="lazy" />`
    : `<span class="logo-fallback">${escapeHtml(initials(name))}</span>`

  return `<span class="brand-logo">${inner}</span>`
}

function logoTile(name, logoPath, href) {
  const inner = logoPath
    ? `<img src="${escapeHtml(artwork(logoPath, 'w154'))}" alt="" loading="lazy" />`
    : `<span class="logo-fallback">${escapeHtml(initials(name))}</span>`

  return `<a class="logo-tile" href="${escapeHtml(href)}">
    ${inner}
    <span>${escapeHtml(name)}</span>
    <em>See all →</em>
  </a>`
}

/** Popular / recently released / upcoming, as pills that keep the other filters. */
function sortBar(basePath, params, sort) {
  return `<div class="filter-row">${SORT_TABS.map(([key, label]) => {
    const href = browseHref(basePath, { ...params, sort: key === 'popular' ? '' : key })
    return `<a class="filter-pill ${sort === key ? 'is-active' : ''}" href="${escapeHtml(href)}">${label}</a>`
  }).join('')}</div>`
}

/** Genre chips for a single network, studio or genre page. */
function genreChips(basePath, params, genres, selectedId) {
  const all = `<a class="chip-link chip-sm ${selectedId ? '' : 'is-active'}" href="${escapeHtml(
    browseHref(basePath, params)
  )}">All genres</a>`

  const links = genres
    .map((genre) => {
      const active = String(selectedId) === String(genre.id)
      return `<a class="chip-link chip-sm ${active ? 'is-active' : ''}" href="${escapeHtml(
        browseHref(basePath, { ...params, genre: genre.id })
      )}">${escapeHtml(genre.name)}</a>`
    })
    .join('')

  return `<div class="chips chips-sm">${all}${links}</div>`
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

function discoverBody({ user, type, query, source, items, page = 1, totalPages = 1, error, plex = {} }) {
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

  const grid = items.length
    ? `<div class="grid">${items
        .map(({ item, local }) =>
          mediaCard(item, {
            returnTo: '/',
            local,
            plex: plexFor(plex, item.mediaType, item.tmdbId),
          })
        )
        .join('')}</div>`
    : `<p class="empty">Nothing found. ${source === 'local' ? 'Add a TMDB API key in settings to search the full catalog.' : ''}</p>`

  return discoverLayout(
    '',
    `<div class="page-head">
      <div>
        <h1>${query ? `Results for “${escapeHtml(query)}”` : 'Discover'}</h1>
        <p class="muted">${source === 'tmdb' ? 'Trending on TMDB — request anything for the library.' : 'Local catalog (offline demo data).'}</p>
      </div>
      <form class="search" method="get" action="/" data-suggest="/search/suggest">
        ${type !== 'all' ? `<input type="hidden" name="type" value="${escapeHtml(type)}" />` : ''}
        <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search titles" aria-label="Search titles" />
        <button class="btn btn-ghost" type="submit">Search</button>
      </form>
    </div>
    ${alert({ error })}
    ${query ? '' : `<div class="tabs">${tabLinks}</div>`}
    ${grid}
    ${pagination({
      page,
      totalPages,
      basePath: '/',
      params: { type: type === 'all' ? '' : type, q: query },
    })}`
  )
}

async function networksBody({ networkId, sort: rawSort, genreId, page = 1, plex }) {
  if (!tmdbConfigured()) return discoverLayout('networks', browseUnavailable('Networks'))

  const sort = sortKey(rawSort)

  if (networkId) {
    const network = await networkWithLogo(networkById(networkId) ?? { id: Number(networkId), name: 'Network' })
    const genres = await genreList(MediaType.TV).catch(() => [])
    const selectedGenre = genreId ? genres.find((genre) => String(genre.id) === String(genreId)) : null
    const params = { network: network.id, sort: sort === 'popular' ? '' : sort, genre: genreId ?? '' }
    const result = await discoverPage(
      MediaType.TV,
      { with_networks: network.id, ...(genreId ? { with_genres: genreId } : {}) },
      { page, sort }
    )

    return discoverLayout(
      'networks',
      `<a class="back" href="/networks">← All networks</a>
      <div class="brand-head">
        ${brandLogo(network.name, network.logoPath)}
        <div>
          <h1>${escapeHtml(network.name)}</h1>
          <p class="muted">${
            selectedGenre ? `${escapeHtml(selectedGenre.name)} series` : 'Series'
          } from ${escapeHtml(network.name)}.</p>
        </div>
      </div>
      ${sortBar('/networks', { network: network.id, genre: genreId }, sort)}
      ${genreChips('/networks', { network: network.id, sort: sort === 'popular' ? '' : sort }, genres, genreId)}
      ${mediaGrid(result.items, { returnTo: browseHref('/networks', params), plex })}
      ${pagination({ page: result.page, totalPages: result.totalPages, basePath: '/networks', params })}`
    )
  }

  const [directory, rows] = await Promise.all([networkDirectory(), networkShelves(10, 8)])

  return discoverLayout(
    'networks',
    `<div class="page-head">
      <div>
        <h1>Networks</h1>
        <p class="muted">All ${directory.length} networks and streaming services. Open one for its
          popular, recently released and upcoming series.</p>
      </div>
    </div>
    <div class="logo-wall">${directory
      .map((network) => logoTile(network.name, network.logoPath, browseHref('/networks', { network: network.id })))
      .join('')}</div>
    ${
      rows.length
        ? `<h2 class="section-title">Popular on each network</h2>${rows
            .map((row) =>
              shelf(row.name, row.items, browseHref('/networks', { network: row.id }), plex, {
                logoPath: row.logoPath,
              })
            )
            .join('')}`
        : '<p class="empty">TMDB returned no networks just now.</p>'
    }`
  )
}

async function studiosBody({ studioId, sort: rawSort, genreId, page = 1, plex }) {
  if (!tmdbConfigured()) return discoverLayout('studios', browseUnavailable('Studios'))

  const sort = sortKey(rawSort)

  if (studioId) {
    const studio = await studioWithLogo(studioById(studioId) ?? { id: Number(studioId), name: 'Studio' })
    const genres = await genreList(MediaType.MOVIE).catch(() => [])
    const selectedGenre = genreId ? genres.find((genre) => String(genre.id) === String(genreId)) : null
    const params = { studio: studio.id, sort: sort === 'popular' ? '' : sort, genre: genreId ?? '' }
    const result = await discoverPage(
      MediaType.MOVIE,
      { with_companies: studio.id, ...(genreId ? { with_genres: genreId } : {}) },
      { page, sort }
    )

    return discoverLayout(
      'studios',
      `<a class="back" href="/studios">← All studios</a>
      <div class="brand-head">
        ${brandLogo(studio.name, studio.logoPath)}
        <div>
          <h1>${escapeHtml(studio.name)}</h1>
          <p class="muted">${
            selectedGenre ? `${escapeHtml(selectedGenre.name)} films` : 'Films'
          } from ${escapeHtml(studio.name)}.</p>
        </div>
      </div>
      ${sortBar('/studios', { studio: studio.id, genre: genreId }, sort)}
      ${genreChips('/studios', { studio: studio.id, sort: sort === 'popular' ? '' : sort }, genres, genreId)}
      ${mediaGrid(result.items, { returnTo: browseHref('/studios', params), plex })}
      ${pagination({ page: result.page, totalPages: result.totalPages, basePath: '/studios', params })}`
    )
  }

  const [directory, rows] = await Promise.all([studioDirectory(), studioShelves(10, 8)])

  return discoverLayout(
    'studios',
    `<div class="page-head">
      <div>
        <h1>Studios</h1>
        <p class="muted">All ${directory.length} studios. Open one for its popular, recently
          released and upcoming films.</p>
      </div>
    </div>
    <div class="logo-wall">${directory
      .map((studio) => logoTile(studio.name, studio.logoPath, browseHref('/studios', { studio: studio.id })))
      .join('')}</div>
    ${
      rows.length
        ? `<h2 class="section-title">Popular from each studio</h2>${rows
            .map((row) =>
              shelf(row.name, row.items, browseHref('/studios', { studio: row.id }), plex, {
                logoPath: row.logoPath,
              })
            )
            .join('')}`
        : '<p class="empty">TMDB returned no studios just now.</p>'
    }`
  )
}

async function genresBody({ mediaType, genreId, sort: rawSort, page = 1, plex }) {
  const isMovie = mediaType === MediaType.MOVIE
  const key = isMovie ? 'movie-genres' : 'tv-genres'
  const label = isMovie ? 'Movie Genres' : 'Series Genres'
  const sort = sortKey(rawSort)

  if (!tmdbConfigured()) return discoverLayout(key, browseUnavailable(label))

  const genres = await genreList(mediaType)
  const selected = genreId ? genres.find((genre) => String(genre.id) === String(genreId)) : null

  if (selected) {
    const params = { genre: selected.id, sort: sort === 'popular' ? '' : sort }
    const result = await discoverPage(mediaType, { with_genres: selected.id }, { page, sort })

    return discoverLayout(
      key,
      `<a class="back" href="/genres/${mediaType}">← All ${label.toLowerCase()}</a>
      <div class="page-head">
        <div>
          <h1>${escapeHtml(selected.name)}</h1>
          <p class="muted">${isMovie ? 'Films' : 'Series'} in ${escapeHtml(selected.name)}.</p>
        </div>
      </div>
      ${sortBar(`/genres/${mediaType}`, { genre: selected.id }, sort)}
      ${mediaGrid(result.items, { returnTo: browseHref(`/genres/${mediaType}`, params), plex })}
      ${pagination({ page: result.page, totalPages: result.totalPages, basePath: `/genres/${mediaType}`, params })}`
    )
  }

  const rows = await genreShelves(mediaType)

  return discoverLayout(
    key,
    `<div class="page-head">
      <div>
        <h1>${label}</h1>
        <p class="muted">Pick a genre for its most popular titles, or scroll through a few below.</p>
      </div>
    </div>
    <div class="chips">${genres
      .map(
        (genre) =>
          `<a class="chip-link" href="${escapeHtml(browseHref(`/genres/${mediaType}`, { genre: genre.id }))}">${escapeHtml(genre.name)}</a>`
      )
      .join('')}</div>
    ${
      rows.length
        ? rows
            .map((row) => shelf(row.name, row.items, browseHref(`/genres/${mediaType}`, { genre: row.id }), plex))
            .join('')
        : '<p class="empty">TMDB returned no genres just now.</p>'
    }`
  )
}

async function recommendationsBody({ user, plex }) {
  if (!tmdbConfigured()) return discoverLayout('recommendations', browseUnavailable('Recommendations'))

  const seeds = store
    .listRequests({ userId: user.id, take: 8 })
    .filter((request) => request.media?.tmdbId)
    .slice(0, 3)

  const items = await recommendedTitles(
    seeds.map((request) => ({ mediaType: request.media.mediaType, tmdbId: request.media.tmdbId }))
  )

  const reason = seeds.length
    ? `Because you requested ${seeds.map((request) => request.media.title).join(', ')}.`
    : 'Popular titles to start with — request a few and this page follows your taste.'

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
        .map(
          (member) => `<article class="cast">
            ${
              member.profilePath
                ? `<img class="cast-photo" src="${artwork(member.profilePath, 'w185')}" alt="" loading="lazy" />`
                : `<span class="cast-photo cast-photo-empty">${escapeHtml(initials(member.name))}</span>`
            }
            <strong>${escapeHtml(member.name)}</strong>
            ${member.character ? `<span class="muted small">${escapeHtml(member.character)}</span>` : ''}
          </article>`
        )
        .join('')}
    </div>
  </section>`
}

function detailBody({ user, media, details, notice, error, plex = null }) {
  const entry = media ?? details
  const isTv = entry.mediaType === MediaType.TV
  const kind = isTv ? 'sonarr' : 'radarr'
  const profiles = serviceProfiles(kind)
  const storedSeasons = media ? store.listSeasons(media.id) : []
  const detailSeasons = details?.seasons ?? []

  // Episode counts come from TMDB; the availability badge comes from the local
  // record, which the library sync keeps current.
  const listedSeasons = detailSeasons.length
    ? detailSeasons
    : storedSeasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        name: season.name,
        episodeCount: season.episodeCount,
      }))

  const seasonRows = isTv
    ? listedSeasons.map((season) => {
        const local = storedSeasons.find((candidate) => candidate.seasonNumber === season.seasonNumber)
        return `<div class="season">
          <span>${escapeHtml(season.name ?? `Season ${season.seasonNumber}`)}</span>
          <span class="muted">${Number(season.episodeCount ?? local?.episodeCount ?? 0)} episodes</span>
          ${local ? statusBadge(local.status) : ''}
        </div>`
      })
    : []

  const totalEpisodes =
    details?.totalEpisodes ?? storedSeasons.reduce((sum, season) => sum + (season.episodeCount ?? 0), 0)
  const seasonCount = details?.totalSeasons ?? (storedSeasons.length || entry.seasonsCount || null)

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
    media ? ['Library', `${MEDIA_STATUS_LABEL[media.status] ?? 'Unknown'} · ${media.activeRequests} active request(s)`] : null,
  ].filter((fact) => fact && fact[1])

  const factsHtml = facts.length
    ? `<dl class="facts">${facts
        .map(([label, value]) => `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join('')}</dl>`
    : ''

  const profilePicker =
    profiles.length > 1
      ? `<label>Profile
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
      : ''

  const picker =
    isTv && media
      ? `<fieldset class="panel">
          <legend>Seasons to request</legend>
          <div class="season-list">
            ${storedSeasons
              .map(
                (season) => `<label class="season">
                  <input type="checkbox" name="season" value="${season.seasonNumber}"
                    ${season.status === MediaStatus.AVAILABLE ? '' : 'checked'}
                    ${season.status === MediaStatus.AVAILABLE ? 'disabled' : ''} />
                  <span>${escapeHtml(season.name)}</span>
                  <span class="muted">${season.episodeCount} episodes</span>
                </label>`
              )
              .join('')}
          </div>
          <p class="muted small">Seasons already in the library are locked.</p>
        </fieldset>`
      : ''

  const plexRow = plex
    ? `<div class="plex-row">
        <span class="badge badge-available">On Plex</span>
        <a class="btn btn-sm btn-plex" href="${escapeHtml(plex.playUrl)}" target="_blank" rel="noreferrer noopener">▶ Play on Plex</a>
        <span class="muted small">${escapeHtml(plex.library)}</span>
      </div>`
    : ''

  const isAvailable = media?.status === MediaStatus.AVAILABLE
  const alreadyRequested = (media?.myActiveRequests ?? 0) > 0
  const quota = media ? quotaSummary(user)[isTv ? 'tv' : 'movie'] : null

  let action

  if (isAvailable) {
    action = '<p class="badge badge-available">In library</p>'
  } else if (alreadyRequested) {
    action = '<p class="badge badge-pending">You already requested this</p>'
  } else {
    const formAction = media ? `/media/${media.id}/request` : '/media/import'
    action = `<form method="post" action="${formAction}" class="stack">
      ${
        media
          ? `<input type="hidden" name="returnTo" value="/media/${media.id}" />`
          : `<input type="hidden" name="tmdbId" value="${escapeHtml(entry.tmdbId)}" />
             <input type="hidden" name="mediaType" value="${escapeHtml(entry.mediaType)}" />
             <input type="hidden" name="returnTo" value="/" />`
      }
      ${picker}
      ${profilePicker}
      <button class="btn" type="submit">Request ${isTv ? 'seasons' : 'movie'}</button>
      ${quota && quota.limit > 0 ? `<p class="muted small">${quota.used}/${quota.limit} requests used this month</p>` : ''}
    </form>`
  }

  const meta = [
    isTv ? 'Series' : 'Movie',
    formatDate(entry.releaseDate)?.slice(0, 4),
    entry.runtime ? `${entry.runtime} min` : null,
    ...(entry.genres ?? []),
  ]
    .filter(Boolean)
    .join(' · ')

  return `<a class="back" href="/">← Back to discover</a>
    ${alert({ notice, error })}
    <section class="detail">
      ${poster({ ...entry, posterPath: entry.posterPath ?? details?.posterPath ?? null }, 'poster-lg')}
      <div class="detail-body">
        <h1>${escapeHtml(entry.title)}</h1>
        ${details?.tagline ? `<p class="tagline">${escapeHtml(details.tagline)}</p>` : ''}
        <p class="media-meta">${escapeHtml(meta)}</p>
        <p class="overview">${escapeHtml(entry.overview || details?.overview || 'No description available yet.')}</p>
        ${factsHtml}
        ${
          seasonRows.length
            ? `<div class="panel"><h2 style="margin: 0">Seasons</h2><div class="season-list">${seasonRows.join('')}</div></div>`
            : ''
        }
        ${plexRow}
        ${action}
      </div>
    </section>
    ${castPanel(details)}
    ${watchPanel(details)}
    ${details ? '<p class="muted small">Metadata from TMDB.</p>' : ''}`
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

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
  const list = result.results.length
    ? `<div class="request-list">${result.results.map((request) => requestCard(request, { canManage: canManageRequests })).join('')}</div>`
    : '<p class="empty">No requests here yet.</p>'

  return `<div class="page-head">
      <div>
        <h1>Requests</h1>
        <p class="muted">${canManageRequests ? 'Every request across the library.' : 'Requests you have made.'}</p>
      </div>
    </div>
    ${alert({ notice, error })}
    <div class="tabs">${tabs}</div>
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
      <p class="muted small">Role: ${escapeHtml(user.role)} · ${permissionList(user.permissions, user.role)}</p>
      <p class="muted small">Monthly quotas: movies ${quota.movie.used}/${quota.movie.limit || '∞'} · series ${quota.tv.used}/${quota.tv.limit || '∞'}</p>
    </section>

    <form method="post" action="/account/password" class="stack panel">
      <h2 style="margin: 0">Change password</h2>
      <label>Current password <input type="password" name="currentPassword" required autocomplete="current-password" /></label>
      <label>New password <input type="password" name="newPassword" required minlength="6" autocomplete="new-password" /></label>
      <button class="btn btn-sm" type="submit">Update password</button>
      <p class="muted small">Changing your password signs out your other sessions.</p>
    </form>`
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_TABS = Object.freeze([
  ['integrations', 'Integrations'],
  ['users', 'Users'],
  ['notifications', 'Notifications'],
  ['logs', 'Logs'],
  ['tasks', 'Tasks'],
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
    <button class="btn btn-sm" type="submit" ${isSelf ? 'disabled' : ''}>Save</button>
  </form>`
}

function settingsBody({ user, settings, users, audit, options, tab, notice, error }) {
  const sync = syncState()
  const current = SETTINGS_TABS.some(([key]) => key === tab) ? tab : 'integrations'

  const generalPanel = `<fieldset class="panel">
      <legend>General</legend>
      <label>Application name <input type="text" name="appName" value="${escapeHtml(settings['app.name'])}" maxlength="60" /></label>
      <label class="checkbox">
        <input type="checkbox" name="autoApprove" ${settings['requests.autoApprove'] === 'true' ? 'checked' : ''} />
        <span>Auto-approve new requests</span>
      </label>
      <label>TMDB API key
        <input type="password" name="tmdbApiKey" value="${escapeHtml(settings['tmdb.apiKey'])}" autocomplete="off" placeholder="v3 key or v4 read token" />
      </label>
      <label>Where-to-watch region
        <select name="tmdbRegion">${regionOptions(settings['tmdb.region'])}</select>
      </label>
    </fieldset>`

  const integrations = `<form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="integrations" />
      <input type="hidden" name="settingsTab" value="integrations" />
      ${generalPanel}
      <button class="btn" type="submit">Save general settings</button>
    </form>
    ${servicePanel('radarr', 'Radarr', settings, options)}
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

  const tasks = `<form method="post" action="/settings" class="stack">
      <input type="hidden" name="settingsSection" value="tasks" />
      <input type="hidden" name="settingsTab" value="tasks" />
      <fieldset class="panel">
        <legend>Library sync</legend>
        <label>Interval (minutes, 0 disables)
          <input type="number" name="syncIntervalMinutes" min="0" value="${escapeHtml(settings['sync.intervalMinutes'])}" />
        </label>
        <p class="muted small">Last run: ${sync.lastRun ? escapeHtml(sync.lastRun.replace('T', ' ').slice(0, 19)) : 'never'}${sync.running ? ' · running now' : ''}</p>
        ${sync.lastSummary ? `<p class="muted small">Last result: ${escapeHtml(JSON.stringify(sync.lastSummary.services))}</p>` : ''}
        <button class="btn btn-sm" type="submit">Save schedule</button>
      </fieldset>
    </form>

    <form method="post" action="/settings/sync" class="panel">
      <h2 style="margin: 0">Run a sync now</h2>
      <p class="muted small">Pulls the Radarr and Sonarr libraries and marks finished requests as available.</p>
      <button class="btn btn-sm btn-ghost" type="submit">Sync now</button>
    </form>`

  const content =
    current === 'users'
      ? usersTab
      : current === 'notifications'
        ? notifications
        : current === 'logs'
          ? logs
          : current === 'tasks'
            ? tasks
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

  if (section === '' || section === 'integrations') {
    if (body.appName !== undefined) input.appName = body.appName
    if (body.tmdbApiKey !== undefined) input.tmdbApiKey = body.tmdbApiKey
    if (body.tmdbRegion !== undefined) input.tmdbRegion = body.tmdbRegion
  }

  // Only the general form carries the policy checkbox; saving a service must
  // not read an absent checkbox as "turn auto-approve off".
  if (section === 'integrations' && body.appName !== undefined) {
    input.autoApprove = body.autoApprove !== undefined
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
  }

  if (section === 'notifications') {
    input.notifications = {
      webhookUrl: body.webhookUrl,
      onRequest: body.onRequest !== undefined,
      onApproval: body.onApproval !== undefined,
      onAvailable: body.onAvailable !== undefined,
    }
  }

  if (section === 'tasks' && body.syncIntervalMinutes !== undefined) {
    input.syncIntervalMinutes = body.syncIntervalMinutes
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

    sendHtml(res, 200, setupPage({ appName: appName(), error: url.searchParams.get('err'), values: {} }))
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
      })
    )
  })

  router.post('/login', async ({ req, res }) => {
    const body = await readBody(req)
    const key = clientKey(req)
    const user = store.findUserByLogin(body.username ?? body.email ?? '')

    if (!user || !verifyPassword(String(body.password ?? ''), user.passwordHash)) {
      const limit = loginLimiter.record(key)

      return redirect(
        res,
        `/login?err=${encodeURIComponent(
          limit.allowed ? 'Incorrect username or password' : `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`
        )}`
      )
    }

    loginLimiter.reset(key)
    const token = createSession(user.id)
    // Every successful sign-in opens Discover.
    redirect(res, '/', { 'set-cookie': sessionCookie(token, req) })
  })

  router.post('/logout', ({ req, res }) => {
    endSession(req)
    redirect(res, '/login', { 'set-cookie': clearedSessionCookie() })
  })

  router.get('/', async ({ req, res, url }) => {
    const user = pageUser(req, res, '/')
    if (!user) return

    const type = parseType(url.searchParams.get('type'))
    const query = url.searchParams.get('q') ?? ''
    const page = pageNumber(url.searchParams.get('page'))
    let source = 'local'
    let totalPages = 1
    let currentPage = page
    let items = getCatalog({ type, query, userId: user.id }).map((item) => ({ item, local: item }))
    let error = url.searchParams.get('err')

    if (tmdbConfigured()) {
      try {
        const found = query ? await searchPage(query, type, page) : await trendingPage(type, page)
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
      } catch (tmdbError) {
        source = 'local'
        error = `TMDB unavailable, showing the local catalog: ${tmdbError.message}`
        items = getCatalog({ type, query, userId: user.id }).map((item) => ({ item, local: item }))
      }
    }

    if (source === 'local') {
      totalPages = Math.max(1, Math.ceil(items.length / PER_PAGE))
      currentPage = Math.min(page, totalPages)
      items = items.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE)
    }

    render(res, 200, {
      title: 'Discover',
      user,
      active: 'discover',
      body: discoverBody({
        user,
        type,
        query,
        source,
        items,
        page: currentPage,
        totalPages,
        error,
        plex: await plexEntries(),
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
      body: await networksBody({
        networkId: url.searchParams.get('network'),
        sort: url.searchParams.get('sort'),
        genreId: url.searchParams.get('genre'),
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
      body: await studiosBody({
        studioId: url.searchParams.get('studio'),
        sort: url.searchParams.get('sort'),
        genreId: url.searchParams.get('genre'),
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
      body: await genresBody({
        mediaType,
        genreId: url.searchParams.get('genre'),
        sort: url.searchParams.get('sort'),
        page: pageNumber(url.searchParams.get('page')),
        plex: await plexEntries(),
      }),
    })
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
      const rawSeasons = body.season
      const seasonNumbers = body.seasonsSubmitted
        ? (rawSeasons === undefined ? [] : [].concat(rawSeasons)).map(Number)
        : null

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
        seasonNumbers: null,
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
        tab: url.searchParams.get('tab') ?? 'integrations',
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
      const tab = ['integrations', 'users', 'notifications', 'logs', 'tasks'].includes(body.settingsTab)
        ? body.settingsTab
        : 'integrations'
      redirect(res, withMessage(`/settings?tab=${tab}`, 'notice', 'Settings saved'))
    } catch (error) {
      failure(res, '/settings', error)
    }
  })

  router.post('/settings/test/:kind', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')

    if (!['sonarr', 'radarr', 'plex'].includes(params.kind)) {
      return redirect(res, withMessage('/settings', 'err', 'Unknown service'))
    }

    try {
      updateSettings(settingsFromBody(await readBody(req)), actor)
      if (params.kind === 'plex') forgetPlex()
      else forgetServiceOptions(params.kind)
    } catch (error) {
      return failure(res, '/settings', error)
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
}

import { DEFAULT_USER_PERMISSIONS } from './constants.js'
