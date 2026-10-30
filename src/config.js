import { dirname, join } from 'node:path'

function bool(value, fallback) {
  if (value === undefined) return fallback
  return String(value).toLowerCase() === 'true' || value === '1'
}

const databaseFile = process.env.DATABASE_FILE ?? './data/discovarr.db'

export const config = {
  port: Number(process.env.PORT ?? 5055),
  host: process.env.HOST ?? '0.0.0.0',
  databaseFile,
  // TMDB artwork is cached next to the database so it survives restarts.
  imageCacheDir: process.env.IMAGE_CACHE_DIR ?? join(dirname(databaseFile), 'images'),
  // Optional hands-off bootstrap. When ADMIN_PASSWORD is set the first
  // administrator is created at boot; otherwise the app serves the /setup
  // page so the first account is created in the browser.
  adminEmail: (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase() || 'admin@discovarr.local',
  adminUsername: (process.env.ADMIN_USERNAME ?? '').trim() || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 168),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  cookieSameSite: (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase(),
  seedDemoUser: bool(process.env.SEED_DEMO_USER, false),
  // Preview/demo only: treat every request as this user when no session
  // cookie is present, so a cookie-blocking embedded browser still works.
  demoAutoLoginEmail: (process.env.DEMO_AUTO_LOGIN ?? '').trim().toLowerCase() || null,
  tmdbApiKeyEnv: process.env.TMDB_API_KEY ?? '',
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT ?? 8),
  loginRateWindowMs: Number(process.env.LOGIN_RATE_WINDOW_MINUTES ?? 15) * 60 * 1000,
}

export const sessionTtlMs = config.sessionTtlHours * 60 * 60 * 1000
