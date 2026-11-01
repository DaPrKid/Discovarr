import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { getSetting, saveSettings } from './db.js'

// Signing in with a Plex account. plex.tv is contacted only for the OAuth pin,
// the account's profiles and a token per profile; the library integration in
// plex.js keeps using the administrator's own saved server URL and token.
const PRODUCT = 'Discovarr'
const TIMEOUT_MS = 8000

export function plexLoginEnabled() {
  return getSetting('plex.login') === 'true'
}

/**
 * A stable id plex.tv uses to recognise this installation. It is generated
 * once and kept in the settings table, because Plex matches an authorisation
 * against the id that asked for it.
 */
export function plexClientId() {
  const saved = String(getSetting('plex.clientId') ?? '').trim()
  if (saved) return saved

  const created = randomUUID()
  saveSettings({ 'plex.clientId': created })
  return created
}

function baseUrl() {
  return String(config.plexTvBase).replace(/\/+$/, '')
}

async function plexTv(path, { method = 'GET', token = '', form = null } = {}) {
  const headers = {
    accept: 'application/json',
    'x-plex-product': PRODUCT,
    'x-plex-client-identifier': plexClientId(),
  }
  if (token) headers['x-plex-token'] = token
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded'

  let response
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`Plex could not be reached: ${error.message}`)
  }

  if (!response.ok) {
    // The status is kept so a wrong profile PIN can be told apart from an
    // outage and answered on the picker instead of the sign-in page.
    const error = new Error(`Plex responded with HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  const text = await response.text()
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch {
    // An HTML error page from a proxy is not a Plex answer.
    throw new Error('Plex returned something other than JSON')
  }
}

/** Starts a sign-in: a pin the browser carries to plex.tv and back. */
export async function createPlexPin() {
  const payload = await plexTv('/api/v2/pins?strong=true', { method: 'POST' })
  if (!payload.id || !payload.code) throw new Error('Plex did not return a sign-in code')

  return { id: String(payload.id), code: String(payload.code) }
}

export function plexAuthUrl({ id, code, forwardUrl = '' }) {
  const params = new URLSearchParams({
    clientID: plexClientId(),
    code,
    'context[device][product]': PRODUCT,
    'context[device][version]': '1',
  })
  // Plex sends the browser back here once the pin is confirmed, so the user
  // does not have to find their way back to Discovarr by hand.
  if (forwardUrl) params.set('forwardUrl', forwardUrl)

  return `https://app.plex.tv/auth#?${params}`
}

/** null while the user has not finished, the token once they have. */
export async function plexPinToken(id, code) {
  const payload = await plexTv(
    `/api/v2/pins/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`
  )
  return payload.authToken ? String(payload.authToken) : null
}

/** The account's home users: the owner plus everybody it was shared with. */
export async function plexProfiles(token) {
  const payload = await plexTv('/api/v2/home/users', { token })
  const list = payload.users ?? payload.MediaContainer?.Users ?? payload.MediaContainer?.User ?? []

  return []
    .concat(list)
    .map((entry) => ({
      id: String(entry.id ?? ''),
      uuid: String(entry.uuid ?? entry.id ?? ''),
      title: String(entry.title ?? entry.username ?? 'Plex user'),
      admin: Boolean(entry.admin),
      // A protected profile has a Plex Home PIN of its own.
      protected:
        entry.protected === true || entry.protected === 1 || entry.protected === '1' || entry.protected === 'true',
    }))
    .filter((entry) => entry.uuid)
}

/** Exchanges the account token for the token of one home user. */
export async function plexSwitchProfile(token, uuid, pin = '') {
  const query = pin ? `?pin=${encodeURIComponent(pin)}` : ''
  const payload = await plexTv(
    `/api/v2/home/users/${encodeURIComponent(uuid)}/switch${query}`,
    { method: 'POST', token }
  )

  const switched = payload.authToken ?? payload.authenticationToken
  if (!switched) throw new Error('Plex did not return a token for that profile')

  return String(switched)
}

export async function plexAccount(token) {
  const payload = await plexTv('/api/v2/user', { token })

  return {
    id: payload.id ? String(payload.id) : '',
    username: String(payload.username ?? payload.title ?? ''),
    email: String(payload.email ?? ''),
    title: String(payload.title ?? payload.username ?? 'Plex user'),
  }
}
