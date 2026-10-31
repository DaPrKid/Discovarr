import { getSetting, listUsers } from './db.js'
import { sendMail } from './mail.js'

const TIMEOUT_MS = 6000

/** Which event a user must opt into to receive an email about it. */
export const EVENT_BITS = Object.freeze({ approved: 1, declined: 2, available: 4 })

export function webhookConfigured() {
  return Boolean(getSetting('notifications.webhookUrl'))
}

export function mailConfigured() {
  return (
    getSetting('smtp.enabled') === 'true' &&
    Boolean(getSetting('smtp.host')) &&
    Boolean(getSetting('smtp.from'))
  )
}

export function notificationsConfigured() {
  return webhookConfigured() || mailConfigured()
}

async function sendWebhook(event, { message, media, user }) {
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

/**
 * Emails everyone who asked for this kind of event. The person who triggered it
 * is skipped, so approving your own request does not mail you about it.
 */
async function sendEventMail(event, { message, media, user }) {
  if (!mailConfigured()) return { sent: false, reason: 'mail not configured' }

  const bit = EVENT_BITS[event]
  if (!bit) return { sent: false, reason: 'event is not mailed' }

  // The actor is skipped only for a new request, where they are the requester
  // and already know. For approvals, declines and availability the actor is an
  // administrator, so a single-user install still gets its own update.
  const recipients = listUsers().filter(
    (member) =>
      member.notifyEmail &&
      ((member.notifyEvents ?? 0) & bit) === bit &&
      (event !== 'request' || member.id !== user?.id)
  )

  if (recipients.length === 0) return { sent: false, reason: 'nobody is subscribed to this event' }

  const appName = getSetting('app.name') ?? 'Discovarr'
  const link = media?.id ? `\n\n${appName}: title #${media.id} (/media/${media.id})` : ''

  const results = await Promise.all(
    recipients.map(async (member) => {
      try {
        await sendMail({
          host: getSetting('smtp.host'),
          port: getSetting('smtp.port'),
          security: getSetting('smtp.security'),
          user: getSetting('smtp.user'),
          password: getSetting('smtp.password'),
          from: getSetting('smtp.from'),
          fromName: getSetting('smtp.fromName') || appName,
          to: member.email,
          subject: `${appName}: ${message}`,
          text: `${message}${link}\n\nYou are receiving this because you turned on email notifications in ${appName}.`,
        })
        return { email: member.email, sent: true }
      } catch (error) {
        console.warn(`[discovarr] mail to ${member.email} failed: ${error.message}`)
        return { email: member.email, sent: false, reason: error.message }
      }
    })
  )

  return { sent: results.some((result) => result.sent), results }
}

/**
 * Fan-out for one event: webhook first, then email. Failures never bubble up
 * into a user request.
 */
export async function notify(event, { message, media = null, user = null } = {}) {
  const [webhook, mail] = await Promise.all([
    sendWebhook(event, { message, media, user }),
    sendEventMail(event, { message, media, user }),
  ])

  return { sent: webhook.sent || mail.sent, webhook, mail }
}

/** Fire-and-forget wrapper so request handlers never wait on a webhook. */
export function notifyLater(event, payload) {
  notify(event, payload).catch((error) => console.warn('[discovarr] notification error', error.message))
}

/** Sends one message with the saved SMTP settings, for the settings page. */
export async function sendTestMail(to) {
  if (!getSetting('smtp.host') || !getSetting('smtp.from')) {
    throw new Error('Save a mail server host and a sender address first')
  }
  if (!to) throw new Error('Your account has no email address to send to')

  const appName = getSetting('app.name') ?? 'Discovarr'
  const result = await sendMail(
    {
      host: getSetting('smtp.host'),
      port: getSetting('smtp.port'),
      security: getSetting('smtp.security'),
      user: getSetting('smtp.user'),
      password: getSetting('smtp.password'),
      from: getSetting('smtp.from'),
      fromName: getSetting('smtp.fromName') || appName,
      to,
      subject: `${appName}: test message`,
      text: `This is a test message from ${appName}. If you are reading it, the mail settings work.`,
    },
    // Verification stays on unless a local relay with a self-signed certificate
    // was explicitly allowed in the mail settings.
    { tlsOptions: { rejectUnauthorized: getSetting('smtp.verifyTls') !== 'false' } }
  )

  const how = result.security === 'ssl' ? 'implicit TLS' : result.security === 'starttls' ? 'STARTTLS' : 'plaintext'
  const crypto = result.protocol ? ` ${result.protocol}${result.cipher ? ` / ${result.cipher}` : ''}` : ''
  const auth = result.auth ? `, AUTH ${result.auth}` : ', no authentication'

  return { ok: true, detail: `Test message sent to ${to} via ${how}${crypto}${auth}` }
}
