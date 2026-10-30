import { hasPermission } from './auth.js'
import {
  ACTIVE_REQUEST_STATUSES,
  ALL_PERMISSIONS,
  DEFAULT_USER_PERMISSIONS,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  Permission,
  Role,
} from './constants.js'
import * as store from './db.js'
import { HttpError } from './http.js'
import { notifyLater } from './notifications.js'
import { verifyPassword } from './passwords.js'
import { dispatchToService } from './services.js'
import { tmdbDetails } from './tmdb.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/

/** Normalises a username and rejects names that cannot be typed at sign-in. */
export function cleanUsername(value) {
  const name = String(value ?? '').trim()
  if (!name) throw new HttpError(400, 'Username is required')
  if (name.length < 3 || name.length > 40) throw new HttpError(400, 'Username must be 3-40 characters')
  if (!USERNAME_PATTERN.test(name)) {
    throw new HttpError(400, 'Username can use letters, numbers, dots, dashes and underscores')
  }
  return name
}

export function currentPeriodStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

export function quotaSummary(user) {
  const since = currentPeriodStart()
  return {
    movie: { limit: user.quotaMovie ?? 0, used: store.countMonthlyRequests(user.id, MediaType.MOVIE, since) },
    tv: { limit: user.quotaTv ?? 0, used: store.countMonthlyRequests(user.id, MediaType.TV, since) },
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export function getCatalog({ type = 'all', query = '', userId = null } = {}) {
  return store.listMedia({ type, query, userId })
}

export function getMediaDetail(id, userId = null) {
  const media = store.getMedia(id)
  if (!media) throw new HttpError(404, 'Title not found')

  const requests = store.listRequestsForMedia(media.id)

  return {
    ...media,
    seasons: store.listSeasons(media.id),
    activeRequests: requests.filter((request) => ACTIVE_REQUEST_STATUSES.includes(request.status)).length,
    myActiveRequests: requests.filter(
      (request) => request.userId === userId && ACTIVE_REQUEST_STATUSES.includes(request.status)
    ).length,
  }
}

/** Imports TMDB metadata into the local catalog. */
export async function importTmdbTitle({ mediaType, tmdbId }) {
  if (mediaType !== MediaType.MOVIE && mediaType !== MediaType.TV) {
    throw new HttpError(400, 'mediaType must be "movie" or "tv"')
  }

  const existing = store.getMediaByTmdb(tmdbId, mediaType)
  if (existing) return existing

  const details = await tmdbDetails(mediaType, tmdbId)
  return store.upsertTmdbMedia(details)
}

// ---------------------------------------------------------------------------
// Request lifecycle
// ---------------------------------------------------------------------------

async function resolveMedia({ mediaId, mediaType, tmdbId }) {
  if (mediaId) {
    const media = store.getMedia(mediaId)
    if (!media) throw new HttpError(404, 'Title not found')
    return media
  }

  if (mediaType && tmdbId) return importTmdbTitle({ mediaType, tmdbId })

  throw new HttpError(400, 'Provide mediaId, or mediaType and tmdbId')
}

export async function requestMedia({ mediaId, mediaType, tmdbId, userId, seasonNumbers = null }) {
  const user = store.findUserById(userId)
  if (!user) throw new HttpError(401, 'Sign in to continue')

  const media = await resolveMedia({ mediaId, mediaType, tmdbId })

  const permission = media.mediaType === MediaType.MOVIE ? Permission.REQUEST_MOVIE : Permission.REQUEST_TV
  if (!hasPermission(user, permission)) {
    throw new HttpError(
      403,
      `You are not allowed to request ${media.mediaType === MediaType.MOVIE ? 'movies' : 'series'}`
    )
  }

  if (media.status === MediaStatus.AVAILABLE) {
    throw new HttpError(409, 'This title is already available in the library')
  }

  if (store.findActiveRequest(media.id, user.id)) {
    throw new HttpError(409, 'You already have an active request for this title')
  }

  let seasons = null

  if (media.mediaType === MediaType.TV) {
    const available = store.listSeasons(media.id).map((season) => season.seasonNumber)
    const picked =
      seasonNumbers === null ? available : [...new Set(seasonNumbers.map(Number))]

    if (picked.length === 0) throw new HttpError(400, 'Select at least one season')

    const unknown = picked.filter((number) => !available.includes(number))
    if (unknown.length > 0) throw new HttpError(400, `Unknown season(s): ${unknown.join(', ')}`)

    seasons = picked.sort((a, b) => a - b)
  }

  const limit = media.mediaType === MediaType.MOVIE ? user.quotaMovie : user.quotaTv
  if (limit > 0) {
    const used = store.countMonthlyRequests(user.id, media.mediaType, currentPeriodStart())
    if (used >= limit) {
      throw new HttpError(429, `Monthly ${media.mediaType} limit reached (${used}/${limit})`)
    }
  }

  // Admin implies every capability, but auto-approval is a policy choice. The
  // role bypass must not leak in here, or every admin request skips review.
  const autoApprove =
    store.getSetting('requests.autoApprove') === 'true' ||
    (user.role !== Role.ADMIN &&
      (Number(user.permissions ?? 0) & Permission.AUTO_APPROVE) === Permission.AUTO_APPROVE)

  const request = store.createRequest({
    mediaId: media.id,
    userId: user.id,
    status: MediaRequestStatus.PENDING,
    seasons,
  })

  store.setMediaStatus(media.id, autoApprove ? MediaStatus.PROCESSING : MediaStatus.PENDING)
  if (seasons) {
    for (const number of seasons) {
      store.setSeasonStatus(media.id, number, autoApprove ? MediaStatus.PROCESSING : MediaStatus.PENDING)
    }
  }

  store.recordAudit(
    user.id,
    'request.created',
    `#${request.id} ${media.title}${seasons ? ` seasons ${seasons.join(', ')}` : ''}${autoApprove ? ' (auto-approved)' : ''}`
  )
  notifyLater('request', {
    message: `${user.username} requested ${media.title}${seasons ? ` (season${seasons.length > 1 ? 's' : ''} ${seasons.join(', ')})` : ''}`,
    media,
    user,
  })

  if (autoApprove) return approveAndDispatch(store.getRequestById(request.id), media, user)

  return store.getRequestById(request.id)
}

/**
 * Moves a request to approved, tells Radarr/Sonarr to fetch it, and records
 * the outcome. A dispatch failure marks the request FAILED instead of
 * pretending it worked.
 */
async function approveAndDispatch(request, media, actor) {
  store.setMediaStatus(media.id, MediaStatus.PROCESSING)
  for (const number of request.seasons ?? []) {
    store.setSeasonStatus(media.id, number, MediaStatus.PROCESSING)
  }

  try {
    const result = await dispatchToService(media, request)

    if (result.dispatched) store.setMediaExternalId(media.id, result.externalId)

    const note = result.dispatched ? result.detail : `Approved — ${result.reason}`
    store.setRequestStatus(request.id, MediaRequestStatus.APPROVED, note)

    notifyLater('approved', {
      message: `${media.title} was approved${result.dispatched ? ` and sent to the download client` : ''}`,
      media,
      user: actor,
    })

    return store.getRequestById(request.id)
  } catch (error) {
    store.setRequestStatus(request.id, MediaRequestStatus.FAILED, `Dispatch failed: ${error.message}`)
    store.recordAudit(actor?.id ?? null, 'request.dispatch_failed', `#${request.id} ${error.message}`)
    notifyLater('approved', { message: `${media.title} failed to dispatch: ${error.message}`, media, user: actor })

    return store.getRequestById(request.id)
  }
}

function loadRequest(id) {
  const request = store.getRequestById(id)
  if (!request) throw new HttpError(404, 'Request not found')
  return request
}

export async function approveRequest(id, actor) {
  const request = loadRequest(id)

  if (request.status !== MediaRequestStatus.PENDING && request.status !== MediaRequestStatus.FAILED) {
    throw new HttpError(409, 'Only pending or failed requests can be approved')
  }

  const media = store.getMedia(request.mediaId)
  const result = await approveAndDispatch(request, media, actor)

  store.recordAudit(actor?.id ?? null, 'request.approved', `#${request.id} ${media.title}`)
  return result
}

export async function retryRequest(id, actor) {
  const request = loadRequest(id)
  if (request.status !== MediaRequestStatus.FAILED) {
    throw new HttpError(409, 'Only failed requests can be retried')
  }

  const media = store.getMedia(request.mediaId)
  const result = await approveAndDispatch(request, media, actor)

  store.recordAudit(actor?.id ?? null, 'request.retried', `#${request.id} ${media.title}`)
  return result
}

export function declineRequest(id, actor) {
  const request = loadRequest(id)

  if (request.status !== MediaRequestStatus.PENDING) {
    throw new HttpError(409, 'Only pending requests can be declined')
  }

  store.setRequestStatus(request.id, MediaRequestStatus.DECLINED)

  const stillActive = store
    .listRequestsForMedia(request.mediaId)
    .filter((candidate) => ACTIVE_REQUEST_STATUSES.includes(candidate.status))

  if (stillActive.length === 0 && request.media.status !== MediaStatus.AVAILABLE) {
    store.setMediaStatus(request.mediaId, MediaStatus.UNKNOWN)
    for (const number of request.seasons ?? []) {
      store.setSeasonStatus(request.mediaId, number, MediaStatus.UNKNOWN)
    }
  }

  store.recordAudit(actor?.id ?? null, 'request.declined', `#${request.id} ${request.media.title}`)
  notifyLater('declined', { message: `${request.media.title} was declined`, media: request.media, user: actor })

  return store.getRequestById(request.id)
}

export function deleteRequest(id, user) {
  const request = loadRequest(id)

  const canManage = hasPermission(user, Permission.MANAGE_REQUESTS)
  if (!canManage && request.userId !== user.id) {
    throw new HttpError(403, 'You can only cancel your own requests')
  }

  store.deleteRequest(request.id)

  const stillActive = store
    .listRequestsForMedia(request.mediaId)
    .filter((candidate) => ACTIVE_REQUEST_STATUSES.includes(candidate.status))

  if (stillActive.length === 0 && request.media.status !== MediaStatus.AVAILABLE) {
    store.setMediaStatus(request.mediaId, MediaStatus.UNKNOWN)
  }

  store.recordAudit(user.id, 'request.deleted', `#${request.id} ${request.media.title}`)
  return request
}

export function markAvailable(mediaId, actor) {
  const media = store.getMedia(mediaId)
  if (!media) throw new HttpError(404, 'Title not found')

  store.setMediaStatus(media.id, MediaStatus.AVAILABLE)
  for (const season of store.listSeasons(media.id)) {
    store.setSeasonStatus(media.id, season.seasonNumber, MediaStatus.AVAILABLE)
  }

  for (const request of store.listRequestsForMedia(media.id)) {
    if (ACTIVE_REQUEST_STATUSES.includes(request.status)) {
      store.setRequestStatus(request.id, MediaRequestStatus.COMPLETED, 'Marked available by an administrator')
    }
  }

  store.recordAudit(actor?.id ?? null, 'media.available', media.title)
  notifyLater('available', { message: `${media.title} is now available in the library`, media, user: actor })

  return store.getMedia(media.id)
}

export function listRequestsFor(user, filter = 'all', { page = 1, take = 12 } = {}) {
  const statuses =
    filter === 'pending'
      ? [MediaRequestStatus.PENDING]
      : filter === 'approved'
        ? [MediaRequestStatus.APPROVED]
        : filter === 'failed'
          ? [MediaRequestStatus.FAILED]
          : filter === 'completed'
            ? [MediaRequestStatus.COMPLETED]
            : filter === 'declined'
              ? [MediaRequestStatus.DECLINED]
              : null

  const scope = hasPermission(user, Permission.MANAGE_REQUESTS) ? null : user.id
  const safeTake = Math.min(Math.max(Number(take) || 12, 1), 100)
  const total = store.countRequests({ userId: scope, statuses })
  const totalPages = Math.max(1, Math.ceil(total / safeTake))
  const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages)

  return {
    results: store.listRequests({
      userId: scope,
      statuses,
      take: safeTake,
      offset: (safePage - 1) * safeTake,
    }),
    total,
    page: safePage,
    take: safeTake,
    totalPages,
  }
}

// ---------------------------------------------------------------------------
// Users and settings
// ---------------------------------------------------------------------------

export function createUserByAdmin({ email, username, password, role, permissions, quotaMovie, quotaTv }, actor) {
  const cleanEmail = String(email ?? '').trim()
  const cleanName = cleanUsername(username)

  if (!cleanEmail || !password) {
    throw new HttpError(400, 'Email, username and password are required')
  }
  if (!EMAIL_PATTERN.test(cleanEmail)) throw new HttpError(400, 'Enter a valid email address')
  if (String(password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters')
  if (store.findUserByEmail(cleanEmail)) throw new HttpError(409, 'That email is already registered')
  if (store.findUserByUsername(cleanName)) throw new HttpError(409, 'That username is taken')

  const user = store.createUser({
    email: cleanEmail,
    username: cleanName,
    password: String(password),
    role: role === Role.ADMIN ? Role.ADMIN : Role.USER,
    permissions: Number(permissions) || DEFAULT_USER_PERMISSIONS,
  })

  store.updateUser(user.id, {
    role: user.role,
    permissions: Number(permissions) || DEFAULT_USER_PERMISSIONS,
    quotaMovie: Number(quotaMovie) || 0,
    quotaTv: Number(quotaTv) || 0,
  })

  store.recordAudit(actor?.id ?? null, 'user.created', `${cleanEmail} (${user.role})`)
  return store.findUserById(user.id)
}

/** Creates the very first account, which is always the administrator. */
export function createFirstAdmin({ email, username, password }) {
  if (store.countUsers() > 0) throw new HttpError(409, 'Setup is already complete')

  const cleanEmail = String(email ?? '').trim()
  const cleanName = cleanUsername(username)

  if (!cleanEmail) throw new HttpError(400, 'Email is required')
  if (!EMAIL_PATTERN.test(cleanEmail)) throw new HttpError(400, 'Enter a valid email address')
  if (String(password ?? '').length < 6) throw new HttpError(400, 'Password must be at least 6 characters')
  if (store.findUserByEmail(cleanEmail)) throw new HttpError(409, 'That email is already registered')
  if (store.findUserByUsername(cleanName)) throw new HttpError(409, 'That username is taken')

  const user = store.createUser({
    email: cleanEmail,
    username: cleanName,
    password: String(password),
    role: Role.ADMIN,
    permissions: ALL_PERMISSIONS,
  })

  store.recordAudit(user.id, 'setup.completed', cleanEmail)
  return user
}

export function updateUserByAdmin(id, input, actor) {
  const user = store.findUserById(id)
  if (!user) throw new HttpError(404, 'User not found')

  const role = input.role === Role.ADMIN ? Role.ADMIN : input.role === Role.USER ? Role.USER : user.role
  const updated = store.updateUser(user.id, {
    role,
    permissions: role === Role.ADMIN ? ALL_PERMISSIONS : Number(input.permissions) || 0,
    quotaMovie: Number(input.quotaMovie) || 0,
    quotaTv: Number(input.quotaTv) || 0,
  })

  store.recordAudit(actor?.id ?? null, 'user.updated', `${user.email} role=${role} quotas=${updated.quotaMovie}/${updated.quotaTv}`)
  return updated
}

export function changePassword(user, currentPassword, newPassword, keepToken) {
  if (!verifyPassword(String(currentPassword ?? ''), user.passwordHash)) {
    throw new HttpError(401, 'Current password is incorrect')
  }
  if (String(newPassword ?? '').length < 6) {
    throw new HttpError(400, 'New password must be at least 6 characters')
  }

  store.updateUserPassword(user.id, String(newPassword))
  const revoked = keepToken ? store.deleteOtherSessions(user.id, keepToken) : 0
  store.recordAudit(user.id, 'auth.password_changed', user.email)

  return { revoked }
}

export function updateSettings(input, actor) {
  const entries = {
    'app.name': String(input.appName ?? '').trim() || 'Discovarr',
    'requests.autoApprove': input.autoApprove ? 'true' : 'false',
    'tmdb.apiKey': String(input.tmdbApiKey ?? '').trim(),
    'sync.intervalMinutes': String(Math.max(0, Number(input.syncIntervalMinutes ?? 30) || 0)),
    'notifications.webhookUrl': String(input.notifications?.webhookUrl ?? '').trim(),
    'notifications.onRequest': input.notifications?.onRequest ? 'true' : 'false',
    'notifications.onApproval': input.notifications?.onApproval ? 'true' : 'false',
    'notifications.onAvailable': input.notifications?.onAvailable ? 'true' : 'false',
  }

  for (const kind of ['sonarr', 'radarr']) {
    const service = input[kind] ?? {}
    entries[`services.${kind}.enabled`] = service.enabled ? 'true' : 'false'
    entries[`services.${kind}.url`] = String(service.url ?? '').trim()
    entries[`services.${kind}.apiKey`] = String(service.apiKey ?? '').trim()
    entries[`services.${kind}.rootFolder`] = String(service.rootFolder ?? '').trim()
    entries[`services.${kind}.qualityProfileId`] = String(service.qualityProfileId ?? '').trim()
    entries[`services.${kind}.qualityProfileName`] = String(service.qualityProfileName ?? '').trim()
  }

  store.saveSettings(entries)
  store.recordAudit(actor?.id ?? null, 'settings.updated', Object.keys(entries).length + ' keys')
  return store.getSettings()
}
