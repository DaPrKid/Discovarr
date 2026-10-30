import { getSetting } from './db.js'

const TIMEOUT_MS = 6000

export function notificationsConfigured() {
  return Boolean(getSetting('notifications.webhookUrl'))
}

/**
 * Posts a JSON payload to the configured webhook. Discord reads `content`,
 * generic endpoints get the structured fields too. Failures never bubble up
 * into a user request.
 */
export async function notify(event, { message, media = null, user = null } = {}) {
  const url = getSetting('notifications.webhookUrl')
  const eventSetting = {
    request: 'notifications.onRequest',
    approved: 'notifications.onApproval',
    declined: 'notifications.onApproval',
    available: 'notifications.onAvailable',
  }[event]

  if (!url) return { sent: false, reason: 'no webhook configured' }
  if (eventSetting && getSetting(eventSetting) !== 'true') return { sent: false, reason: 'event disabled' }

  let target
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol')
    target = parsed.toString()
  } catch {
    console.warn('[discovarr] notification webhook URL is not a valid http(s) address')
    return { sent: false, reason: 'invalid webhook url' }
  }

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: message,
        event,
        message,
        media: media ? { id: media.id, title: media.title, mediaType: media.mediaType, tmdbId: media.tmdbId } : null,
        user: user ? { id: user.id, username: user.username } : null,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!response.ok) {
      console.warn(`[discovarr] notification webhook responded ${response.status}`)
      return { sent: false, reason: `HTTP ${response.status}` }
    }

    return { sent: true }
  } catch (error) {
    console.warn(`[discovarr] notification failed: ${error.message}`)
    return { sent: false, reason: error.message }
  }
}

/** Fire-and-forget wrapper so request handlers never wait on a webhook. */
export function notifyLater(event, payload) {
  notify(event, payload).catch((error) => console.warn('[discovarr] notification error', error.message))
}
