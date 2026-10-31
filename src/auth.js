import { createHash, randomBytes } from 'node:crypto'
import { config, sessionTtlMs } from './config.js'
import { Role } from './constants.js'
import {
  deleteOtherSessions,
  deleteSession,
  findApiToken,
  findUserByEmail,
  findUserById,
  insertSession,
  sessionUser,
  touchApiToken,
} from './db.js'
import { HttpError, parseCookies } from './http.js'

export const SESSION_COOKIE = 'discovarr_session'

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url')
  insertSession(token, userId, new Date(Date.now() + sessionTtlMs).toISOString())
  return token
}

export function sessionCookie(token, req) {
  const forwardedProto = String(req?.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()

  const secure = config.cookieSecure || forwardedProto === 'https'
  // Browsers reject SameSite=None on a non-secure cookie, so fall back to Lax.
  const sameSite = config.cookieSameSite === 'none' && !secure ? 'lax' : config.cookieSameSite

  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`,
    `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
  ]

  if (secure) parts.push('Secure')
  // CHIPS: keeps the session usable inside a third-party iframe.
  if (secure && sameSite === 'none') parts.push('Partitioned')

  return parts.join('; ')
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function sessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null
}

export function hashApiToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** Resolves a plaintext personal token to its user, or null. */
export function userForApiToken(token) {
  if (!token) return null

  const record = findApiToken(hashApiToken(token))
  if (!record) return null

  touchApiToken(record.id)
  return findUserById(record.user_id)
}

/** Personal API tokens authenticate scripts and home automation. */
function bearerUser(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim())
  return match ? userForApiToken(match[1]) : null
}

export function currentUser(req) {
  const viaToken = bearerUser(req)
  if (viaToken) return viaToken

  const token = sessionToken(req)
  if (token) {
    const user = sessionUser(token)
    if (user) return user
  }

  // DEMO_AUTO_LOGIN only ever applies to a preview instance; it is unset in
  // the Docker image and compose file.
  if (config.demoAutoLoginEmail) return findUserByEmail(config.demoAutoLoginEmail)

  return null
}

export function endSession(req) {
  const token = sessionToken(req)
  if (token) deleteSession(token)
}

export function requireUser(req) {
  const user = currentUser(req)
  if (!user) throw new HttpError(401, 'Sign in to continue')
  return user
}

export function hasPermission(user, permission) {
  if (!user) return false
  if (user.role === Role.ADMIN) return true
  return (Number(user.permissions ?? 0) & permission) === permission
}

export function requirePermission(req, permission, message = 'You do not have permission to do that') {
  const user = requireUser(req)
  if (!hasPermission(user, permission)) throw new HttpError(403, message)
  return user
}

export function requireAdmin(req) {
  const user = requireUser(req)
  if (user.role !== Role.ADMIN) throw new HttpError(403, 'Administrator access required')
  return user
}

/** Revokes every other session after a password change. */
export function revokeOtherSessions(userId, keepToken) {
  return deleteOtherSessions(userId, keepToken)
}
