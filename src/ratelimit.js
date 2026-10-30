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

export function clientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim()
  return forwarded || req.socket?.remoteAddress || 'unknown'
}
