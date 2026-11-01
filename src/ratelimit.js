import { config } from './config.js'

export function createRateLimiter({ windowMs, max }) {
  const buckets = new Map()

  function prune(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
  }

  return {
    /** Counts an attempt and reports whether the caller is still allowed. */
    record(key) {
      const now = Date.now()
      if (buckets.size > 5000) prune(now)

      const bucket = buckets.get(key) ?? { count: 0, resetAt: now + windowMs }
      if (bucket.resetAt <= now) {
        bucket.count = 0
        bucket.resetAt = now + windowMs
      }

      bucket.count += 1
      buckets.set(key, bucket)

      return {
        allowed: bucket.count <= max,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        remaining: Math.max(0, max - bucket.count),
      }
    },

    reset(key) {
      buckets.delete(key)
    },
  }
}

function normalizeAddress(value) {
  const address = String(value ?? '').trim()
  // An IPv4-mapped IPv6 address is the same client as its IPv4 form.
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * What a request is counted against. X-Forwarded-For is only believed when
 * TRUST_PROXY is on, because a directly exposed instance would otherwise let
 * every client rotate the header and reset its own budget.
 */
export function clientKey(req, { trustProxy = config.trustProxy } = {}) {
  if (trustProxy) {
    const forwarded = normalizeAddress(String(req.headers['x-forwarded-for'] ?? '').split(',')[0])
    if (forwarded) return forwarded
  }

  return normalizeAddress(req.socket?.remoteAddress) || 'unknown'
}
