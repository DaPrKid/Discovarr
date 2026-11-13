import {
  clearLoginAttempts,
  clearedSessionCookie,
  createSession,
  currentUser,
  endSession,
  hasPermission,
  recordFailedLogin,
  requireAdmin,
  requirePermission,
  requireUser,
  sessionCookie,
  sessionToken,
} from './auth.js'
import { APP_VERSION, MediaType, Permission } from './constants.js'
import {
  approveRequest,
  changePassword,
  createUserByAdmin,
  declineRequest,
  deleteRequest,
  getCatalog,
  getMediaDetail,
  importTmdbTitle,
  listRequestsFor,
  markAvailable,
  requestMedia,
  retryRequest,
  updateSettings,
  updateUserByAdmin,
} from './core.js'
import * as store from './db.js'
import { HttpError, readBody, sendJson } from './http.js'
import { verifyPassword } from './passwords.js'
import { serviceOptions, serviceSummary } from './services.js'
import { deviceLabel, pushPublicKey, readSubscription, sendTestPush } from './push.js'
import { searchTmdb, tmdbConfigured } from './tmdb.js'
import { registerCompanionRoutes } from './companion.js'
import { syncLibrary, syncState } from './sync.js'

function parseType(value) {
  return value === MediaType.MOVIE || value === MediaType.TV ? value : 'all'
}

function publicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    permissions: user.permissions,
    quotaMovie: user.quotaMovie,
    quotaTv: user.quotaTv,
  }
}

export function registerApiRoutes(router) {
  router.get('/api/v1/health', ({ res }) => {
    sendJson(res, 200, {
      status: 'ok',
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      media: store.listMedia({}).length,
      setupRequired: store.countUsers() === 0,
      tmdb: tmdbConfigured() ? 'configured' : 'offline',
      sync: syncState().lastRun,
    })
  })

  router.post('/api/v1/auth/login', async ({ req, res }) => {
    const body = await readBody(req)
    const user = store.findUserByLogin(body.username ?? body.email ?? '')

    if (!user || !verifyPassword(String(body.password ?? ''), user.passwordHash)) {
      const limit = recordFailedLogin(req)

      if (!limit.allowed) {
        sendJson(
          res,
          429,
          { error: `Too many attempts. Try again in ${limit.retryAfterSeconds}s.` },
          { 'retry-after': String(limit.retryAfterSeconds) }
        )
        return
      }

      throw new HttpError(401, 'Incorrect username or password')
    }

    clearLoginAttempts(req)
    const token = createSession(user.id)
    sendJson(res, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(token, req) })
  })

  router.post('/api/v1/auth/logout', ({ req, res }) => {
    // Clearing the cookie is not enough: the token is also deleted, or a copy
    // taken before signing out would keep working until it expired.
    endSession(req)
    sendJson(res, 200, { ok: true }, { 'set-cookie': clearedSessionCookie() })
  })

  router.get('/api/v1/auth/me', ({ req, res }) => {
    const user = currentUser(req)
    if (!user) throw new HttpError(401, 'Not signed in')
    sendJson(res, 200, { user: publicUser(user) })
  })

  router.post('/api/v1/auth/password', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)

    const result = changePassword(user, body.currentPassword, body.newPassword, sessionToken(req))

    sendJson(res, 200, { ok: true, otherSessionsRevoked: result.revoked })
  })

  router.get('/api/v1/search', async ({ req, res, url }) => {
    requireUser(req)

    const query = url.searchParams.get('query') ?? ''
    if (!query) return sendJson(res, 200, { results: [] })

    const results = await searchTmdb(query, parseType(url.searchParams.get('type')))
    sendJson(res, 200, { results })
  })

  router.get('/api/v1/media', ({ req, res, url }) => {
    const user = currentUser(req)
    sendJson(res, 200, {
      page: 1,
      totalPages: 1,
      totalResults: 0,
      results: getCatalog({
        type: parseType(url.searchParams.get('type')),
        query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '',
        userId: user?.id ?? null,
      }),
    })
  })

  router.get('/api/v1/media/:id', ({ req, res, params }) => {
    const user = currentUser(req)
    sendJson(res, 200, getMediaDetail(Number(params.id), user?.id ?? null))
  })

  router.patch('/api/v1/media/:id', ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'Approving requests requires permission')
    sendJson(res, 200, { media: markAvailable(Number(params.id), actor) })
  })

  router.get('/api/v1/request', ({ req, res, url }) => {
    const user = requireUser(req)
    const page = Number(url.searchParams.get('page') ?? 1)
    const take = Number(url.searchParams.get('take') ?? 20)
    const result = listRequestsFor(user, url.searchParams.get('filter') ?? 'all', { page, take })

    sendJson(res, 200, {
      page: result.page,
      totalPages: result.totalPages,
      totalResults: result.total,
      results: result.results,
    })
  })

  router.post('/api/v1/request', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)

    const request = await requestMedia({
      mediaId: body.mediaId ? Number(body.mediaId) : null,
      mediaType: body.mediaType,
      tmdbId: body.tmdbId ? Number(body.tmdbId) : null,
      userId: user.id,
      qualityProfileId: body.qualityProfileId ? Number(body.qualityProfileId) : null,
      profileIndex: Number.isInteger(body.profileIndex) ? body.profileIndex : null,
      seasonNumbers: Array.isArray(body.seasons) ? body.seasons.map(Number) : null,
    })

    sendJson(res, 201, { request })
  })

  router.post('/api/v1/request/:id/approve', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'Approving requests requires permission')
    sendJson(res, 200, { request: await approveRequest(Number(params.id), actor) })
  })

  router.post('/api/v1/request/:id/decline', ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'Declining requests requires permission')
    sendJson(res, 200, { request: declineRequest(Number(params.id), actor) })
  })

  router.post('/api/v1/request/:id/retry', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'Retrying requests requires permission')
    sendJson(res, 200, { request: await retryRequest(Number(params.id), actor) })
  })

  router.delete('/api/v1/request/:id', ({ req, res, params }) => {
    const user = requireUser(req)
    sendJson(res, 200, { request: deleteRequest(Number(params.id), user) })
  })

  router.post('/api/v1/sync', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'Syncing requires permission')
    sendJson(res, 200, await syncLibrary({ actorId: actor.id }))
  })

  router.get('/api/v1/users', ({ req, res }) => {
    requirePermission(req, Permission.MANAGE_USERS, 'Managing users requires permission')
    sendJson(res, 200, { results: store.listUsers().map(publicUser) })
  })

  router.patch('/api/v1/users/:id', async ({ req, res, params }) => {
    const actor = requirePermission(req, Permission.MANAGE_USERS, 'Managing users requires permission')
    const body = await readBody(req)
    const updated = updateUserByAdmin(
      Number(params.id),
      {
        role: body.role,
        permissions: body.permissions,
        quotaMovie: body.quotaMovie,
        quotaTv: body.quotaTv,
      },
      actor
    )
    sendJson(res, 200, { user: publicUser(updated) })
  })

  router.get('/api/v1/settings', ({ req, res }) => {
    requirePermission(req, Permission.MANAGE_SETTINGS, 'Changing settings requires permission')
    sendJson(res, 200, {
      settings: store.getSettings(),
      services: { sonarr: serviceSummary('sonarr'), radarr: serviceSummary('radarr') },
      sync: syncState(),
    })
  })

  router.put('/api/v1/settings', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_SETTINGS, 'Changing settings requires permission')
    const body = await readBody(req)

    const settings = updateSettings(
      {
        appName: body.appName,
        tmdbApiKey: body.tmdbApiKey,
        syncIntervalMinutes: body.syncIntervalMinutes,
        notifications: body.notifications ?? {},
        radarr: body.radarr ?? {},
        sonarr: body.sonarr ?? {},
      },
      actor
    )

    sendJson(res, 200, { settings })
  })

  router.get('/api/v1/push', ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, {
      publicKey: pushPublicKey(),
      events: user.notifyEvents,
      devices: store.listPushSubscriptions(user.id).map((device) => ({
        id: device.id,
        label: device.label,
        createdAt: device.createdAt,
        lastUsedAt: device.lastUsedAt,
      })),
    })
  })

  router.post('/api/v1/push/subscribe', async ({ req, res }) => {
    const user = requireUser(req)
    const subscription = readSubscription(await readBody(req))
    if (!subscription) throw new HttpError(400, 'That is not a usable push subscription')

    store.savePushSubscription({
      userId: user.id,
      ...subscription,
      label: deviceLabel(req.headers['user-agent']),
    })

    sendJson(res, 200, { ok: true, devices: store.listPushSubscriptions(user.id).length })
  })

  router.post('/api/v1/push/unsubscribe', async ({ req, res }) => {
    const user = requireUser(req)
    const endpoint = String((await readBody(req)).endpoint ?? '')

    store.deletePushSubscription({ endpoint, userId: user.id })
    sendJson(res, 200, { ok: true, devices: store.listPushSubscriptions(user.id).length })
  })

  router.post('/api/v1/push/test', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, await sendTestPush(user.id))
  })

  router.get('/api/v1/services/:kind/options', async ({ req, res, params }) => {
    requirePermission(req, Permission.MANAGE_SETTINGS, 'Changing settings requires permission')

    if (!['sonarr', 'radarr'].includes(params.kind)) throw new HttpError(404, 'Unknown service')

    try {
      sendJson(res, 200, await serviceOptions(params.kind))
    } catch (error) {
      throw new HttpError(502, error.message)
    }
  })

  registerCompanionRoutes(router)
}
