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
import { backoffDelayMs } from './sync.js'
import { verifyPassword } from './passwords.js'
import { dispatchToService, profileAt, resolveProfile, saveServiceProfiles, serviceProfiles } from './services.js'
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

export async function requestMedia({
  mediaId,
  mediaType,
  tmdbId,
  userId,
  seasonNumbers = null,
  qualityProfileId = null,
  profileIndex = null,
}) {
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

  // Auto-approval is a permission set per account in Settings -> Users, so one
  // trusted requester can skip review without the whole household doing so.
  const autoApprove =
    (Number(user.permissions ?? 0) & Permission.AUTO_APPROVE) === Permission.AUTO_APPROVE

  // The profile the requester picked, if it is one of the configured ones.
  const kind = media.mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr'
  const profile =
    profileIndex !== null && profileIndex !== undefined
      ? profileAt(kind, Number(profileIndex))
      : resolveProfile(kind, { id: qualityProfileId })

  const request = store.createRequest({
    mediaId: media.id,
    userId: user.id,
    status: MediaRequestStatus.PENDING,
    seasons,
    qualityProfileId: profile?.profileId ?? null,
    qualityProfileName: profile?.name ?? null,
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
    store.setRequestRetry(request.id, { attempts: 0, nextRetryAt: null })
    store.createNotification({
      userId: request.userId,
      kind: 'approved',
      title: `${media.title} was approved`,
      body: result.dispatched ? 'Sent to the download client.' : note,
      href: `/media/${media.id}`,
    })

    notifyLater('approved', {
      message: `${media.title} was approved${result.dispatched ? ` and sent to the download client` : ''}`,
      media,
      user: actor,
    })

    return store.getRequestById(request.id)
  } catch (error) {
    store.setRequestStatus(request.id, MediaRequestStatus.FAILED, `Dispatch failed: ${error.message}`)
    store.recordAudit(actor?.id ?? null, 'request.dispatch_failed', `#${request.id} ${error.message}`)

    // Background retries take over from here unless the attempts are spent.
    const attempts = (request.attempts ?? 0) + 1
    const maxAttempts = Number(store.getSetting('requests.maxAttempts') ?? 3)
    const exhausted = attempts >= Math.max(1, maxAttempts)

    store.setRequestRetry(request.id, {
      attempts,
      nextRetryAt: exhausted ? null : new Date(Date.now() + backoffDelayMs(attempts)).toISOString(),
    })

    if (exhausted) {
      store.createNotification({
        userId: request.userId,
        kind: 'failed',
        title: `${media.title} could not be sent to ${media.mediaType === MediaType.MOVIE ? 'Radarr' : 'Sonarr'}`,
        body: `Gave up after ${attempts} attempt(s): ${error.message}`,
        href: `/media/${media.id}`,
      })
    }

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
  store.createNotification({
    userId: request.userId,
    kind: 'declined',
    title: `${request.media.title} was declined`,
    body: 'An administrator declined this request.',
    href: `/media/${request.mediaId}`,
  })

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
      store.createNotification({
        userId: request.userId,
        kind: 'available',
        title: `${media.title} is now available`,
        body: 'Marked available by an administrator.',
        href: `/media/${media.id}`,
      })
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

/** Deletes an account, keeping the person doing it out of their own way. */
export function deleteUserByAdmin(id, actor) {
  const user = store.findUserById(id)
  if (!user) throw new HttpError(404, 'User not found')
  if (user.id === actor?.id) throw new HttpError(400, 'You cannot delete your own account')

  const admins = store.listUsers().filter((member) => member.role === Role.ADMIN)
  if (user.role === Role.ADMIN && admins.length <= 1) {
    throw new HttpError(400, 'Keep at least one administrator')
  }

  store.deleteUser(user.id)
  store.recordAudit(actor?.id ?? null, 'user.deleted', `${user.email} (${user.role})`)
  return user
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

/**
 * Stores the root folder and quality profile picked for one service without
 * rewriting the other settings, which a partial updateSettings call would do.
 */
export function saveServiceSelection(kind, selection, actor) {
  const entries = {}
  if (selection.rootFolder !== undefined) {
    entries[`services.${kind}.rootFolder`] = String(selection.rootFolder)
  }
  if (selection.qualityProfileId !== undefined) {
    entries[`services.${kind}.qualityProfileId`] = String(selection.qualityProfileId)
  }
  if (selection.qualityProfileName !== undefined) {
    entries[`services.${kind}.qualityProfileName`] = String(selection.qualityProfileName)
  }
  if (Object.keys(entries).length === 0) return

  store.saveSettings(entries)
  store.recordAudit(actor?.id ?? null, 'settings.updated', `${kind} root folder and profile`)
}

/** Adds a named profile: a label, a quality profile and a root folder. */
export function addServiceProfile(kind, input, actor) {
  const label = kind === 'sonarr' ? 'Sonarr' : 'Radarr'
  const name = String(input.name ?? '').trim()
  if (!name) throw new HttpError(400, 'Give the profile a name')
  if (name.length > 60) throw new HttpError(400, 'Profile names are limited to 60 characters')

  const [rawId, rawName = ''] = String(input.qualityProfile ?? '').split('|')
  const profileId = Number(rawId)
  if (!Number.isInteger(profileId) || profileId <= 0) {
    throw new HttpError(400, 'Choose a quality profile')
  }

  const rootFolder = String(input.rootFolder ?? '').trim()
  if (!rootFolder) throw new HttpError(400, 'Choose a root folder')

  const existing = serviceProfiles(kind)
  if (existing.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, `A profile named "${name}" already exists`)
  }

  const isDefault = input.isDefault === true || existing.length === 0
  const list = existing.map((profile) => ({ ...profile, isDefault: isDefault ? false : profile.isDefault }))
  list.push({
    name,
    profileId,
    profileName: String(rawName).trim() || `Profile ${profileId}`,
    rootFolder,
    isDefault,
  })

  saveServiceProfiles(kind, list)
  store.recordAudit(actor?.id ?? null, 'settings.profile_added', `${label}: ${name} -> ${rootFolder}`)
  return list
}

/** Changes a profile in place: its label, quality profile, folder or default flag. */
export function editServiceProfile(kind, originalName, input, actor) {
  const label = kind === 'sonarr' ? 'Sonarr' : 'Radarr'
  const existing = serviceProfiles(kind)
  const index = existing.findIndex((profile) => profile.name === String(originalName))
  if (index < 0) throw new HttpError(404, 'Profile not found')

  const name = String(input.name ?? '').trim() || existing[index].name
  if (name.length > 60) throw new HttpError(400, 'Profile names are limited to 60 characters')

  const duplicate = existing.some(
    (profile, position) => position !== index && profile.name.toLowerCase() === name.toLowerCase()
  )
  if (duplicate) throw new HttpError(409, `A profile named "${name}" already exists`)

  const [rawId, rawName = ''] = String(input.qualityProfile ?? '').split('|')
  const profileId = Number(rawId)
  if (!Number.isInteger(profileId) || profileId <= 0) {
    throw new HttpError(400, 'Choose a quality profile')
  }

  const rootFolder = String(input.rootFolder ?? '').trim()
  if (!rootFolder) throw new HttpError(400, 'Choose a root folder')

  const isDefault = input.isDefault === true || existing[index].isDefault

  const list = existing.map((profile, position) => {
    if (position === index) {
      return {
        ...profile,
        name,
        profileId,
        profileName: String(rawName).trim() || `Profile ${profileId}`,
        rootFolder,
        isDefault,
      }
    }
    return { ...profile, isDefault: isDefault ? false : profile.isDefault }
  })

  if (!list.some((profile) => profile.isDefault)) list[0] = { ...list[0], isDefault: true }

  saveServiceProfiles(kind, list)
  store.recordAudit(actor?.id ?? null, 'settings.profile_updated', `${label}: ${name} -> ${rootFolder}`)
  return list
}

export function removeServiceProfile(kind, name, actor) {
  const label = kind === 'sonarr' ? 'Sonarr' : 'Radarr'
  const existing = serviceProfiles(kind)
  const remaining = existing.filter((profile) => profile.name !== String(name))

  if (remaining.length === existing.length) throw new HttpError(404, 'Profile not found')
  if (remaining.length === 0) throw new HttpError(400, `Keep at least one ${label} profile`)

  saveServiceProfiles(kind, remaining)
  store.recordAudit(actor?.id ?? null, 'settings.profile_removed', `${label}: ${name}`)
  return remaining
}

export function setDefaultServiceProfile(kind, name, actor) {
  const label = kind === 'sonarr' ? 'Sonarr' : 'Radarr'
  const existing = serviceProfiles(kind)
  if (!existing.some((profile) => profile.name === String(name))) {
    throw new HttpError(404, 'Profile not found')
  }

  const list = existing.map((profile) => ({ ...profile, isDefault: profile.name === String(name) }))
  saveServiceProfiles(kind, list)
  store.recordAudit(actor?.id ?? null, 'settings.profile_default', `${label}: ${name}`)
  return list
}
/** Per-user notification choices, saved from the Account page. */
export function updateNotifications(user, { notifyEmail, events }) {
  const mask = [].concat(events ?? []).reduce((total, value) => total | Number(value), 0)
  const updated = store.updateUserNotifications(user.id, {
    notifyEmail: notifyEmail === true || notifyEmail === 'true' || notifyEmail === 'on',
    notifyEvents: mask,
  })

  store.recordAudit(user.id, 'account.notifications', `email=${updated.notifyEmail} events=${updated.notifyEvents}`)
  return updated
}

export function updateSettings(input, actor) {
  const entries = {}

  // Only fields that were submitted are written, so each settings tab can post
  // its own form without clearing the others.
  if (input.appName !== undefined) {
    entries['app.name'] = String(input.appName ?? '').trim() || 'Discovarr'
  }
  if (input.tmdbApiKey !== undefined) {
    entries['tmdb.apiKey'] = String(input.tmdbApiKey ?? '').trim()
  }
  if (input.tmdbRegion !== undefined) {
    entries['tmdb.region'] = String(input.tmdbRegion ?? '').trim().toUpperCase() || 'US'
  }
  if (input.syncIntervalMinutes !== undefined) {
    entries['sync.intervalMinutes'] = String(Math.max(0, Number(input.syncIntervalMinutes ?? 30) || 0))
  }

  if (input.maxAttempts !== undefined) {
    entries['requests.maxAttempts'] = String(Math.min(10, Math.max(0, Number(input.maxAttempts ?? 3) || 0)))
  }

  if (input.smtp) {
    const smtp = input.smtp
    if (smtp.enabled !== undefined) entries['smtp.enabled'] = smtp.enabled ? 'true' : 'false'
    if (smtp.host !== undefined) entries['smtp.host'] = String(smtp.host ?? '').trim()
    if (smtp.port !== undefined) {
      entries['smtp.port'] = String(Math.min(65535, Math.max(1, Number(smtp.port ?? 587) || 587)))
    }
    if (smtp.security !== undefined) {
      const security = String(smtp.security ?? '').toLowerCase()
      entries['smtp.security'] = ['starttls', 'ssl', 'none'].includes(security) ? security : 'starttls'
    }
    if (smtp.user !== undefined) entries['smtp.user'] = String(smtp.user ?? '').trim()
    if (smtp.password !== undefined) entries['smtp.password'] = String(smtp.password ?? '')
    if (smtp.from !== undefined) entries['smtp.from'] = String(smtp.from ?? '').trim()
    if (smtp.fromName !== undefined) entries['smtp.fromName'] = String(smtp.fromName ?? '').trim()
    if (smtp.verifyTls !== undefined) entries['smtp.verifyTls'] = smtp.verifyTls ? 'true' : 'false'
  }

  if (input.cache) {
    if (input.cache.maxMb !== undefined) {
      entries['cache.maxMb'] = String(Math.max(0, Number(input.cache.maxMb ?? 500) || 0))
    }
    if (input.cache.maxAgeDays !== undefined) {
      entries['cache.maxAgeDays'] = String(Math.max(0, Number(input.cache.maxAgeDays ?? 60) || 0))
    }
  }

  if (input.plex) {
    const plex = input.plex
    if (plex.enabled !== undefined) entries['plex.enabled'] = plex.enabled ? 'true' : 'false'
    if (plex.url !== undefined) entries['plex.url'] = String(plex.url ?? '').trim()
    if (plex.token !== undefined) entries['plex.token'] = String(plex.token ?? '').trim()
    if (plex.login !== undefined) entries['plex.login'] = plex.login ? 'true' : 'false'
    if (plex.importWatchlist !== undefined) {
      entries['plex.importWatchlist'] = plex.importWatchlist ? 'true' : 'false'
    }
  }

  if (input.notifications) {
    const notifications = input.notifications
    if (notifications.webhookUrl !== undefined) {
      entries['notifications.webhookUrl'] = String(notifications.webhookUrl ?? '').trim()
    }
    for (const [field, key] of [
      ['onRequest', 'notifications.onRequest'],
      ['onApproval', 'notifications.onApproval'],
      ['onAvailable', 'notifications.onAvailable'],
    ]) {
      if (notifications[field] !== undefined) entries[key] = notifications[field] ? 'true' : 'false'
    }
  }

  for (const kind of ['sonarr', 'radarr']) {
    const service = input[kind]
    if (!service) continue

    const assign = (field, key) => {
      if (service[field] === undefined) return
      entries[`services.${kind}.${key}`] = String(service[field] ?? '').trim()
    }

    if (typeof service.enabled === 'boolean') {
      entries[`services.${kind}.enabled`] = service.enabled ? 'true' : 'false'
    }
    assign('url', 'url')
    assign('apiKey', 'apiKey')
    assign('rootFolder', 'rootFolder')
    assign('qualityProfileId', 'qualityProfileId')
    assign('qualityProfileName', 'qualityProfileName')

    if (service.qualityProfiles !== undefined) {
      const profiles = [].concat(service.qualityProfiles)
        .map((value) => String(value).trim())
        .filter(Boolean)
      entries[`services.${kind}.qualityProfiles`] = [...new Set(profiles)].join('\n')
    }
  }

  if (Object.keys(entries).length === 0) return store.getSettings()

  store.saveSettings(entries)
  store.recordAudit(actor?.id ?? null, 'settings.updated', Object.keys(entries).length + ' keys')
  return store.getSettings()
}
