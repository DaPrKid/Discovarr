import { dirname, join } from 'node:path'

function bool(value, fallback) {
  if (value === undefined) return fallback
  return String(value).toLowerCase() === 'true' || value === '1'
}

const databaseFile = process.env.DATABASE_FILE ?? './data/discovarr.db'

export const config = {
  port: Number(process.env.PORT ?? 5057),
  host: process.env.HOST ?? '0.0.0.0',
  databaseFile,
  // Automatic snapshots live beside the database unless another volume is
  // mounted for them.
  backupDir: process.env.BACKUP_DIR ?? join(dirname(databaseFile), 'backups'),
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
  // Overridable so tests and TMDB-compatible mirrors can be pointed at another host.
  tmdbBaseUrl: (process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3').replace(/\/+$/, ''),
  // The catalogue behind TMDB's "where to watch" data, which is where the
  // per-service links for the play buttons come from. Overridable for the same
  // reason as TMDB itself: the tests stand in for it.
  justwatchUrl: process.env.JUSTWATCH_URL ?? 'https://apis.justwatch.com/graphql',
  // Overridable so tests can stand in for plex.tv.
  plexTvBase: (process.env.PLEX_TV_BASE ?? 'https://plex.tv').replace(/\/+$/, ''),
  // Plex keeps each account's watchlist on its discovery host, which is a
  // different service from plex.tv. Overridable for the same reason.
  plexDiscoverBase: (process.env.PLEX_DISCOVER_BASE ?? 'https://discover.provider.plex.tv').replace(/\/+$/, ''),
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT ?? 8),
  loginRateWindowMs: Number(process.env.LOGIN_RATE_WINDOW_MINUTES ?? 15) * 60 * 1000,
  // A restored database is uploaded as one body, so it is allowed to be much
  // larger than the megabyte a form post may carry.
  restoreMaxBytes: Number(process.env.RESTORE_MAX_MB ?? 512) * 1024 * 1024,
  // Only believe X-Forwarded-For when a proxy of ours sets it. Otherwise any
  // client can invent an address and take a fresh budget for every guess.
  trustProxy: bool(process.env.TRUST_PROXY, false),
  // Framed by nothing but the app itself by default; a reverse proxy that
  // embeds Discovarr sets its own origin here.
  frameAncestors:
    String(process.env.FRAME_ANCESTORS ?? "'self'").replace(/[\r\n]/g, ' ').trim() || "'self'",
}

export const sessionTtlMs = config.sessionTtlHours * 60 * 60 * 1000
