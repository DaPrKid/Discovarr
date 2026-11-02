import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto'

import {
  deletePushSubscription,
  getPushKeys,
  getSetting,
  listPushSubscriptions,
  listUsers,
  savePushKeys,
  touchPushSubscription,
} from './db.js'

const VAPID_TTL_SECONDS = 12 * 60 * 60
const PUSH_TTL_SECONDS = 24 * 60 * 60
const SEND_TIMEOUT_MS = 8000
// Push services cap the encrypted record at 4096 bytes; leaving room for the
// header and the padding delimiter keeps a long title from being rejected.
const MAX_PAYLOAD_BYTES = 3000
const RECORD_SIZE = 4096

/** The per-user event flags, matching the checkboxes on the account page. */
const EVENT_BITS = Object.freeze({ approved: 1, declined: 2, failed: 1, available: 4 })
const THEMES = ['midnight', 'cinema', 'teal', 'forest', 'sapphire', 'crimson']

const base64url = (buffer) => Buffer.from(buffer).toString('base64url')

/**
 * VAPID keys are generated once and then kept: every subscription a browser
 * hands out is bound to the key that created it, so a new key would silently
 * stop every existing device from receiving anything.
 */
export function vapidKeys() {
  const stored = getPushKeys()
  if (stored) return stored

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  // The browser wants the uncompressed point (0x04 || x || y), which is the tail
  // of the SPKI structure.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65)
  const keys = {
    publicKey: base64url(raw),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  }

  savePushKeys(keys)
  return keys
}

export function pushPublicKey() {
  return vapidKeys().publicKey
}

/** VAPID wants a contact address so a push service can complain about us. */
function contactAddress() {
  const from = String(getSetting('smtp.from') ?? '').trim()
  return /^[^@\s]+@[^@\s]+$/.test(from) ? `mailto:${from}` : 'mailto:admin@localhost'
}

function vapidAuthorization(endpoint) {
  const keys = vapidKeys()
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const payload = base64url(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + VAPID_TTL_SECONDS,
      sub: contactAddress(),
    })
  )

  const key = createPrivateKey({
    key: Buffer.from(keys.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  })
  // ES256 signatures are JWS style (r || s), not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' })

  return `vapid t=${header}.${payload}.${base64url(signature)}, k=${keys.publicKey}`
}

/**
 * RFC 8291 aes128gcm: ECDH with an ephemeral key, HKDF for the content key and
 * nonce, AES-128-GCM for the record. The push service only ever sees ciphertext,
 * so a title never travels in the clear through Google's or Apple's servers.
 */
export function encryptPayload(subscription, payload) {
  const uaPublic = Buffer.from(String(subscription.p256dh), 'base64url')
  const authSecret = Buffer.from(String(subscription.auth), 'base64url')
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('subscription keys are malformed')

  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(uaPublic)

  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      authSecret,
      Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]),
      32
    )
  )
  const salt = randomBytes(16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const record = Buffer.concat([Buffer.from(payload), Buffer.from([2])])
  const encrypted = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const prefix = Buffer.alloc(21)
  salt.copy(prefix, 0)
  prefix.writeUInt32BE(RECORD_SIZE, 16)
  prefix.writeUInt8(65, 20)

  return Buffer.concat([prefix, asPublic, encrypted])
}

/** Sends one message to one subscription. Never throws: a dead device is not an error. */
export async function sendPush(subscription, message) {
  const payload = JSON.stringify(message)
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'payload too large' }

  let body
  try {
    body = encryptPayload(subscription, payload)
  } catch (error) {
    return { ok: false, reason: error.message }
  }

  let response
  try {
    response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(subscription.endpoint),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(PUSH_TTL_SECONDS),
        urgency: 'normal',
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch (error) {
    touchPushSubscription(subscription.id, { failed: true })
    return { ok: false, reason: error.message }
  }

  // 404 and 410 mean the browser threw this subscription away. Keeping it would
  // waste a request on every future event, so it goes.
  if (response.status === 404 || response.status === 410) {
    deletePushSubscription({ id: subscription.id })
    return { ok: false, gone: true, status: response.status }
  }

  if (!response.ok) {
    touchPushSubscription(subscription.id, { failed: true })
    return { ok: false, status: response.status }
  }

  touchPushSubscription(subscription.id, { failed: false })
  return { ok: true, status: response.status }
}

function wantsEvent(user, event) {
  const bit = EVENT_BITS[event]
  if (!bit) return false
  return ((user?.notifyEvents ?? 7) & bit) === bit
}

/**
 * Fan-out for one event to every device the user subscribed. The account's event
 * checkboxes apply here too, so turning off "declined" silences both mail and push.
 */
export async function pushToUser(userId, event, { title, body = '', href = '/' } = {}) {
  const subscriptions = listPushSubscriptions(Number(userId))
  if (subscriptions.length === 0) return { sent: 0, total: 0 }

  const user = listUsers().find((member) => member.id === Number(userId))
  if (!wantsEvent(user, event)) return { sent: 0, total: subscriptions.length, reason: 'event turned off' }

  const theme = THEMES.includes(user?.theme) ? user.theme : 'midnight'
  const message = {
    title,
    body,
    href,
    tag: `discovarr-${event}`,
    icon: `/favicon-${theme}.png`,
    badge: '/favicon-midnight.png',
  }

  const results = await Promise.all(subscriptions.map((subscription) => sendPush(subscription, message)))
  return {
    sent: results.filter((result) => result.ok).length,
    total: subscriptions.length,
    gone: results.filter((result) => result.gone).length,
  }
}

/** Fire-and-forget: a request thread must never wait on a phone waking up. */
export function pushLater(userId, event, payload) {
  pushToUser(userId, event, payload).catch((error) => console.warn('[discovarr] push failed', error.message))
}

/** Used by the settings card so a person can see the round trip works. */
export async function sendTestPush(userId) {
  const subscriptions = listPushSubscriptions(Number(userId))
  const results = await Promise.all(
    subscriptions.map((subscription) =>
      sendPush(subscription, {
        title: 'Discovarr is notifying you',
        body: 'Push works on this device. Request updates will land here.',
        href: '/',
        tag: 'discovarr-test',
        icon: '/favicon-midnight.png',
        badge: '/favicon-midnight.png',
      })
    )
  )

  return { sent: results.filter((result) => result.ok).length, total: subscriptions.length }
}

/**
 * Validates what the browser posts. Endpoints are push-service URLs, so plain
 * http is only accepted for loopback, which is where the test suite stands in
 * for a real push service.
 */
export function readSubscription(body = {}) {
  const endpoint = String(body.endpoint ?? '').trim()
  const keys = body.keys ?? body
  const p256dh = String(keys.p256dh ?? '').trim()
  const auth = String(keys.auth ?? '').trim()

  if (!endpoint || endpoint.length > 1000) return null

  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    return null
  }

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null

  if (Buffer.from(p256dh, 'base64url').length !== 65) return null
  if (Buffer.from(auth, 'base64url').length !== 16) return null

  return { endpoint, p256dh, auth }
}

/** A short readable name for the device list, from the sign-up request's UA. */
export function deviceLabel(userAgent = '') {
  const ua = String(userAgent)

  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'

  const system = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''

  return system ? `${browser} on ${system}` : browser
}
