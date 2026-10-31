import * as store from './db.js'
import { retryRequest } from './core.js'

/**
 * A dispatch fails when Radarr or Sonarr is momentarily unreachable, which is
 * exactly the moment a manual retry is least likely to work. This worker picks
 * up failed requests once their backoff has elapsed, and stops after the
 * configured number of attempts.
 */

let running = false

export async function retryFailedRequests({ limit = 5, actor = null } = {}) {
  if (running) return { tried: 0, skipped: 'already running' }

  const maxAttempts = Number(store.getSetting('requests.maxAttempts') ?? 3)
  if (!(maxAttempts > 0)) return { tried: 0, skipped: 'automatic retries are off' }

  running = true
  const result = { tried: 0, recovered: 0, failed: [] }

  try {
    const due = store.listFailedForRetry(new Date().toISOString(), limit)

    for (const request of due) {
      if ((request.attempts ?? 0) >= maxAttempts) continue

      result.tried += 1
      const updated = await retryRequest(request.id, actor)

      if (updated.status === 4) result.failed.push(`#${request.id}`)
      else result.recovered += 1
    }

    if (result.tried > 0) {
      store.recordAudit(
        actor?.id ?? null,
        'request.retry_queue',
        `${result.tried} attempted, ${result.recovered} recovered${result.failed.length ? `, still failing: ${result.failed.join(', ')}` : ''}`
      )
    }

    return result
  } finally {
    running = false
  }
}

/** Checks every five minutes; the per-request backoff decides what is due. */
export function startRetryQueue() {
  return setInterval(() => {
    retryFailedRequests().catch((error) => console.warn(`[discovarr] retry queue failed: ${error.message}`))
  }, 5 * 60_000).unref()
}
