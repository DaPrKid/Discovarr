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
  approveRequest,
  changePassword,
  createFirstAdmin,
  createUserByAdmin,
  declineRequest,
  deleteRequest,
  getCatalog,
  getMediaDetail,
  listRequestsFor,
  markAvailable,
  quotaSummary,
  requestMedia,
  retryRequest,
  saveServiceSelection,
  updateSettings,
  updateUserByAdmin,
} from './core.js'
import * as store from './db.js'
import { HttpError, readBody, redirect, sendHtml } from './http.js'
import { verifyPassword } from './passwords.js'
import { clientKey, createRateLimiter } from './ratelimit.js'
import {
  forgetServiceOptions,
  loadServiceOptions,
  serviceSummary,
  testServiceConnection,
} from './services.js'
import { searchTmdb, tmdbConfigured, trendingTmdb } from './tmdb.js'
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

function pageUser(req, res, returnTo) {
  const user = currentUser(req)
  if (!user) {
    // An installation with no accounts at all sends visitors to the setup page
    // so the first administrator can be created.
    redirect(res, store.countUsers() === 0 ? '/setup' : `/login?returnTo=${encodeURIComponent(returnTo)}`)
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

function loginPage({ returnTo, error, notice }) {
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
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
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

function discoverBody({ user, type, query, source, items, error }) {
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
    ? `<div class="grid">${items.map(({ item, local }) => mediaCard(item, { returnTo: '/', local })).join('')}</div>`
    : `<p class="empty">Nothing found. ${source === 'local' ? 'Add a TMDB API key in settings to search the full catalog.' : ''}</p>`

  return `<div class="page-head">
      <div>
        <h1>Discover</h1>
        <p class="muted">${source === 'tmdb' ? 'Trending on TMDB — request anything for the library.' : 'Local catalog (offline demo data).'}</p>
      </div>
      <form class="search" method="get" action="/">
        ${type !== 'all' ? `<input type="hidden" name="type" value="${escapeHtml(type)}" />` : ''}
        <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search titles" />
        <button class="btn btn-ghost" type="submit">Search</button>
      </form>
    </div>
    ${alert({ error })}
    <div class="tabs">${tabLinks}</div>
    ${grid}`
}

function detailBody({ user, media, notice, error }) {
  const isAvailable = media.status === MediaStatus.AVAILABLE
  const alreadyRequested = media.myActiveRequests > 0
  const quota = quotaSummary(user)[media.mediaType === MediaType.MOVIE ? 'movie' : 'tv']

  const seasons = media.mediaType === MediaType.TV
    ? `<div class="panel">
        <h2 style="margin: 0">Seasons</h2>
        <div class="season-list">
          ${media.seasons
            .map(
              (season) => `<div class="season">
                <span>${escapeHtml(season.name)}</span>
                <span class="muted">${season.episodeCount} episodes</span>
                ${statusBadge(season.status)}
              </div>`
            )
            .join('')}
        </div>
      </div>`
    : ''

  const picker = media.mediaType === MediaType.TV
    ? `<fieldset class="panel">
        <legend>Seasons to request</legend>
        <div class="season-list">
          ${media.seasons
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

  // The default profile plus the extra ones the admin allowed, so a requester
  // can pick a different one per title.
  const service = serviceSummary(media.mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr')
  const requestProfiles = service.qualityProfileId
    ? [
        { id: Number(service.qualityProfileId), name: service.qualityProfileName },
        ...service.extraProfiles,
      ]
    : []

  const profilePicker =
    requestProfiles.length > 1
      ? `<label>Quality profile
        <select name="qualityProfile">
          ${requestProfiles
            .map(
              (profile) =>
                `<option value="${profile.id}">${escapeHtml(profile.name || `Profile ${profile.id}`)}</option>`
            )
            .join('')}
        </select>
      </label>`
      : ''

  let action

  if (isAvailable) {
    action = '<p class="badge badge-available">In library</p>'
  } else if (alreadyRequested) {
    action = '<p class="badge badge-pending">You already requested this</p>'
  } else {
    action = `<form method="post" action="/media/${media.id}/request" class="stack">
      <input type="hidden" name="returnTo" value="/media/${media.id}" />
      <input type="hidden" name="seasonsSubmitted" value="1" />
      ${picker}
      ${profilePicker}
      <button class="btn" type="submit">Request ${media.mediaType === MediaType.TV ? 'seasons' : 'movie'}</button>
      ${quota.limit > 0 ? `<p class="muted small">${quota.used}/${quota.limit} requests used this month</p>` : ''}
    </form>`
  }

  const meta = [
    media.mediaType === MediaType.TV ? 'Series' : 'Movie',
    media.releaseDate?.slice(0, 4),
    media.runtime ? `${media.runtime} min` : null,
    ...media.genres,
  ]
    .filter(Boolean)
    .join(' · ')

  return `<a class="back" href="/">← Back to discover</a>
    ${alert({ notice, error })}
    <section class="detail">
      ${poster(media, 'poster-lg')}
      <div class="detail-body">
        <h1>${escapeHtml(media.title)}</h1>
        <p class="media-meta">${escapeHtml(meta)}</p>
        <p class="overview">${escapeHtml(media.overview)}</p>
        <p class="muted small">Library status: ${escapeHtml(MEDIA_STATUS_LABEL[media.status] ?? 'Unknown')} · ${media.activeRequests} active request(s)${media.syncedAt ? ` · synced ${escapeHtml(media.syncedAt.slice(0, 16).replace('T', ' '))}` : ''}</p>
        ${seasons}
        ${action}
      </div>
    </section>`
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

function serviceFields(kind, label, settings, options) {
  const service = serviceSummary(kind)
  const profileValue = service.qualityProfileId
    ? `${service.qualityProfileId}${service.qualityProfileName ? `|${service.qualityProfileName}` : ''}`
    : ''

  const list = options?.[kind] ?? null

  const rootField = list?.rootFolders?.length
    ? `<label>Root folder
        <select name="${kind}RootFolder">
          ${list.rootFolders
            .map(
              (folder) =>
                `<option value="${escapeHtml(folder.path)}" ${folder.path === service.rootFolder ? 'selected' : ''}>${escapeHtml(folder.path)}</option>`
            )
            .join('')}
        </select>
      </label>`
    : `<label>Root folder
        <input type="text" name="${kind}RootFolder" value="${escapeHtml(service.rootFolder)}" placeholder="/media/movies" />
      </label>`

  const profileField = list?.qualityProfiles?.length
    ? `<label>Default quality profile
        <select name="${kind}QualityProfile">
          ${list.qualityProfiles
            .map(
              (profile) =>
                `<option value="${profile.id}|${escapeHtml(profile.name)}" ${String(profile.id) === String(service.qualityProfileId) ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`
            )
            .join('')}
        </select>
      </label>`
    : `<label>Quality profile id
        <input type="text" name="${kind}QualityProfile" value="${escapeHtml(profileValue)}" placeholder="1" />
      </label>`

  const extraChoices = list?.qualityProfiles?.length
    ? list.qualityProfiles
        .filter((profile) => String(profile.id) !== String(service.qualityProfileId))
        .map(
          (profile) => `<label class="checkbox">
            <input type="checkbox" name="${kind}ExtraProfile" value="${profile.id}|${escapeHtml(profile.name)}" ${
              service.extraProfiles.some((extra) => String(extra.id) === String(profile.id)) ? 'checked' : ''
            } />
            <span>${escapeHtml(profile.name)}</span>
          </label>`
        )
        .join('')
    : ''

  const extraField = extraChoices
    ? `<div class="panel-inline">
        <input type="hidden" name="${kind}ProfilesSubmitted" value="1" />
        <p class="muted small">Additional profiles requesters may choose</p>
        <div class="permissions">${extraChoices}</div>
      </div>`
    : ''

  return `<fieldset class="panel">
    <legend>${label} <span class="badge badge-${service.enabled ? 'approved' : 'pending'}">${service.enabled ? 'enabled' : 'disabled'}</span></legend>
    <label class="checkbox">
      <input type="checkbox" name="${kind}Enabled" ${service.enabled ? 'checked' : ''} />
      <span>Enable ${label} integration</span>
    </label>
    <label>Base URL
      <input type="url" name="${kind}Url" value="${escapeHtml(settings[`services.${kind}.url`])}" placeholder="http://192.168.1.20:8989" />
    </label>
    <label>API key
      <input type="password" name="${kind}ApiKey" value="${escapeHtml(settings[`services.${kind}.apiKey`])}" autocomplete="off" />
    </label>
    ${rootField}
    ${profileField}
    ${extraField}
    <div class="request-actions">
      <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/options/${kind}">Load folders and profiles</button>
      <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/test/${kind}">Save and test connection</button>
    </div>
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

function settingsBody({ user, settings, users, audit, options, notice, error }) {
  const sync = syncState()

  return `<h1>Settings</h1>
    ${alert({ notice, error })}

    <form method="post" action="/settings" class="stack">
      <fieldset class="panel">
        <legend>General</legend>
        <label>Application name <input type="text" name="appName" value="${escapeHtml(settings['app.name'])}" maxlength="60" /></label>
        <label class="checkbox">
          <input type="checkbox" name="autoApprove" ${settings['requests.autoApprove'] === 'true' ? 'checked' : ''} />
          <span>Auto-approve new requests</span>
        </label>
        <label>TMDB API key
          <input type="password" name="tmdbApiKey" value="${escapeHtml(settings['tmdb.apiKey'])}" autocomplete="off" placeholder="v3 key or v4 read token" />
        </label>
      </fieldset>

      ${serviceFields('radarr', 'Radarr', settings, options)}
      ${serviceFields('sonarr', 'Sonarr', settings, options)}

      <fieldset class="panel">
        <legend>Notifications</legend>
        <label>Webhook URL
          <input type="url" name="webhookUrl" value="${escapeHtml(settings['notifications.webhookUrl'])}" placeholder="https://discord.com/api/webhooks/..." />
        </label>
        <label class="checkbox"><input type="checkbox" name="onRequest" ${settings['notifications.onRequest'] === 'true' ? 'checked' : ''} /> <span>New requests</span></label>
        <label class="checkbox"><input type="checkbox" name="onApproval" ${settings['notifications.onApproval'] === 'true' ? 'checked' : ''} /> <span>Approvals and declines</span></label>
        <label class="checkbox"><input type="checkbox" name="onAvailable" ${settings['notifications.onAvailable'] === 'true' ? 'checked' : ''} /> <span>Titles becoming available</span></label>
      </fieldset>

      <fieldset class="panel">
        <legend>Library sync</legend>
        <label>Interval (minutes, 0 disables)
          <input type="number" name="syncIntervalMinutes" min="0" value="${escapeHtml(settings['sync.intervalMinutes'])}" />
        </label>
        <p class="muted small">Last run: ${sync.lastRun ? escapeHtml(sync.lastRun.replace('T', ' ').slice(0, 19)) : 'never'}${sync.running ? ' · running now' : ''}</p>
        <button class="btn btn-sm btn-ghost" type="submit" formaction="/settings/sync">Sync now</button>
      </fieldset>

      <button class="btn" type="submit">Save settings</button>
    </form>

    <h2>Users</h2>
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
    </form>

    <h2>Recent activity</h2>
    <table class="table">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>
        ${audit
          .map(
            (entry) =>
              `<tr><td>${escapeHtml(entry.createdAt.slice(0, 16).replace('T', ' '))}</td><td>${escapeHtml(entry.username)}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.detail)}</td></tr>`
          )
          .join('')}
      </tbody>
    </table>`
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

function serviceFromBody(body, kind) {
  const service = { enabled: body[`${kind}Enabled`] !== undefined }

  // Only fields that were actually submitted are written, so a partial post
  // cannot blank a URL or key that is already saved.
  for (const [field, suffix] of [
    ['url', 'Url'],
    ['apiKey', 'ApiKey'],
    ['rootFolder', 'RootFolder'],
  ]) {
    if (body[`${kind}${suffix}`] !== undefined) service[field] = body[`${kind}${suffix}`]
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
  return {
    appName: body.appName,
    autoApprove: body.autoApprove !== undefined,
    tmdbApiKey: body.tmdbApiKey,
    syncIntervalMinutes: body.syncIntervalMinutes,
    notifications: {
      webhookUrl: body.webhookUrl,
      onRequest: body.onRequest !== undefined,
      onApproval: body.onApproval !== undefined,
      onAvailable: body.onAvailable !== undefined,
    },
    radarr: serviceFromBody(body, 'radarr'),
    sonarr: serviceFromBody(body, 'sonarr'),
  }
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
      redirect(res, withMessage('/settings', 'notice', `Welcome, ${user.username}`), {
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
        returnTo: safeReturn(url.searchParams.get('returnTo'), '/'),
        error: url.searchParams.get('err'),
        notice: url.searchParams.get('notice'),
      })
    )
  })

  router.post('/login', async ({ req, res }) => {
    const body = await readBody(req)
    const returnTo = safeReturn(body.returnTo, '/')
    const key = clientKey(req)
    const user = store.findUserByLogin(body.username ?? body.email ?? '')

    if (!user || !verifyPassword(String(body.password ?? ''), user.passwordHash)) {
      const limit = loginLimiter.record(key)

      return redirect(
        res,
        `/login?returnTo=${encodeURIComponent(returnTo)}&err=${encodeURIComponent(
          limit.allowed ? 'Incorrect username or password' : `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`
        )}`
      )
    }

    loginLimiter.reset(key)
    const token = createSession(user.id)
    redirect(res, returnTo, { 'set-cookie': sessionCookie(token, req) })
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
    let source = 'local'
    let items = getCatalog({ type, query, userId: user.id }).map((item) => ({ item, local: item }))
    let error = url.searchParams.get('err')

    if (tmdbConfigured()) {
      try {
        const found = query ? await searchTmdb(query, type) : await trendingTmdb(type)
        source = 'tmdb'
        items = found.map((item) => ({ item, local: store.getMediaByTmdb(item.tmdbId, item.mediaType) }))
      } catch (tmdbError) {
        error = `TMDB unavailable, showing the local catalog: ${tmdbError.message}`
      }
    }

    render(res, 200, {
      title: 'Discover',
      user,
      active: 'discover',
      body: discoverBody({ user, type, query, source, items, error }),
    })
  })

  router.get('/media/:id', ({ req, res, url, params }) => {
    const user = pageUser(req, res, `/media/${params.id}`)
    if (!user) return

    try {
      const media = getMediaDetail(Number(params.id), user.id)
      render(res, 200, {
        title: media.title,
        user,
        active: 'discover',
        body: detailBody({ user, media, notice: url.searchParams.get('notice'), error: url.searchParams.get('err') }),
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
        audit: store.listAudit(15),
        options: await loadOptionsForPage(),
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
      redirect(res, withMessage('/settings', 'notice', 'Settings saved'))
    } catch (error) {
      failure(res, '/settings', error)
    }
  })

  router.post('/settings/test/:kind', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot change settings')

    if (!['sonarr', 'radarr'].includes(params.kind)) {
      return redirect(res, withMessage('/settings', 'err', 'Unknown service'))
    }

    try {
      updateSettings(settingsFromBody(await readBody(req)), actor)
      forgetServiceOptions(params.kind)
    } catch (error) {
      return failure(res, '/settings', error)
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
        audit: store.listAudit(15),
        options,
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
          audit: store.listAudit(15),
          options,
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
          audit: store.listAudit(15),
          options: null,
          notice: null,
          error: error.message,
        }),
      })
    }
  })

  router.post('/settings/sync', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'You cannot run a sync')

    try {
      const result = await syncLibrary({ actorId: actor.id })
      const message = result.ok
        ? `Sync finished: ${result.summary.updated} updated, ${result.summary.completed} completed`
        : `Sync had errors: ${result.summary.errors.join(' | ')}`
      redirect(res, withMessage('/settings', result.ok ? 'notice' : 'err', message))
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
      redirect(res, withMessage('/settings', 'notice', `Created user ${created.username}`))
    } catch (error) {
      failure(res, '/settings', error)
    }
  })

  router.post('/settings/users/:id', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_USERS, 'You cannot manage users')

    if (Number(params.id) === actor.id) {
      return redirect(res, withMessage('/settings', 'err', 'Use the Account page to change your own details'))
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
      redirect(res, withMessage('/settings', 'notice', `Updated ${updated.username}`))
    } catch (error) {
      failure(res, '/settings', error)
    }
  })
}

import { DEFAULT_USER_PERMISSIONS } from './constants.js'
