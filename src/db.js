import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'
import {
  ALL_PERMISSIONS,
  DEFAULT_USER_PERMISSIONS,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  Role,
  SETTING_DEFAULTS,
} from './constants.js'
import { hashPassword } from './passwords.js'

mkdirSync(dirname(config.databaseFile), { recursive: true })

export const db = new DatabaseSync(config.databaseFile)
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA foreign_keys = ON;')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    title TEXT NOT NULL,
    overview TEXT NOT NULL DEFAULT '',
    release_date TEXT,
    genres TEXT NOT NULL DEFAULT '[]',
    runtime INTEGER,
    seasons_count INTEGER,
    status INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (tmdb_id, media_type)
  );

  CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    episode_count INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    UNIQUE (media_id, season_number)
  );

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status INTEGER NOT NULL DEFAULT 1,
    seasons TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_requests_media ON requests (media_id);
  CREATE INDEX IF NOT EXISTS idx_requests_user ON requests (user_id);
  CREATE INDEX IF NOT EXISTS idx_seasons_media ON seasons (media_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
`)

// Forward-only migrations for databases created by earlier versions.
function ensureColumn(table, column, definition) {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)

  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

ensureColumn('media', 'poster_path', 'TEXT')
ensureColumn('media', 'backdrop_path', 'TEXT')
ensureColumn('media', 'external_id', 'INTEGER')
ensureColumn('media', 'synced_at', 'TEXT')
ensureColumn('users', 'permissions', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'quota_movie', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'quota_tv', 'INTEGER NOT NULL DEFAULT 0')
// The quality profile a request was filed with, so a dispatch honours the
// choice made on the request form instead of always using the default.
ensureColumn('requests', 'quality_profile_id', 'INTEGER')
ensureColumn('requests', 'quality_profile_name', 'TEXT')
// Background retry bookkeeping: how many dispatches have failed and when the
// next automatic attempt is due.
ensureColumn('requests', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('requests', 'next_retry_at', 'TEXT')
// Per-user notification choices: whether to also send email, and which events
// the user cares about (1 approved, 2 declined, 4 available).
ensureColumn('users', 'notify_email', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'notify_events', 'INTEGER NOT NULL DEFAULT 7')

db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    href TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id);
  CREATE INDEX IF NOT EXISTS idx_requests_retry ON requests (status, next_retry_at);
`)

// Usernames identify an account on the sign-in form, so they are unique
// regardless of case. Older databases may hold duplicates, which makes the
// index impossible; that is logged rather than fatal.
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE)')
} catch {
  console.warn('[discovarr] duplicate usernames exist, so the unique username index was skipped')
}

const timestamp = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function mapUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    permissions: row.permissions ?? 0,
    quotaMovie: row.quota_movie ?? 0,
    quotaTv: row.quota_tv ?? 0,
    notifyEmail: row.notify_email === 1,
    notifyEvents: row.notify_events ?? 7,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
  }
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count
}

export function findUserByEmail(email) {
  return mapUser(db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email)))
}

export function findUserByUsername(username) {
  return mapUser(db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(String(username).trim()))
}

/** Sign-in lookup: the username or the email address both identify an account. */
export function findUserByLogin(identifier) {
  const value = String(identifier ?? '').trim()
  if (!value) return null

  return mapUser(
    db
      .prepare('SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)')
      .get(value, value)
  )
}

export function findUserById(id) {
  return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)))
}

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY username').all().map(mapUser)
}

export function createUser({ email, username, password, role = Role.USER, permissions = DEFAULT_USER_PERMISSIONS }) {
  const info = db
    .prepare(
      'INSERT INTO users (email, username, password_hash, role, created_at, permissions) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(String(email).toLowerCase(), username, hashPassword(password), role, timestamp(), permissions)

  return findUserById(Number(info.lastInsertRowid))
}

export function updateUser(id, { role, permissions, quotaMovie, quotaTv }) {
  db.prepare('UPDATE users SET role = ?, permissions = ?, quota_movie = ?, quota_tv = ? WHERE id = ?').run(
    role,
    Number(permissions) || 0,
    Number(quotaMovie) || 0,
    Number(quotaTv) || 0,
    Number(id)
  )
  return findUserById(id)
}

export function updateUserNotifications(id, { notifyEmail = false, notifyEvents = 7 } = {}) {
  db.prepare('UPDATE users SET notify_email = ?, notify_events = ? WHERE id = ?').run(
    notifyEmail ? 1 : 0,
    Number(notifyEvents) || 0,
    Number(id)
  )
  return findUserById(id)
}

export function updateUserPassword(id, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), Number(id))
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

function mapMedia(row) {
  if (!row) return null
  return {
    id: row.id,
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    title: row.title,
    overview: row.overview,
    releaseDate: row.release_date,
    genres: JSON.parse(row.genres ?? '[]'),
    runtime: row.runtime,
    seasonsCount: row.seasons_count,
    status: row.status,
    posterPath: row.poster_path ?? null,
    backdropPath: row.backdrop_path ?? null,
    externalId: row.external_id ?? null,
    syncedAt: row.synced_at ?? null,
    activeRequests: row.active_requests ?? 0,
    myActiveRequests: row.my_active_requests ?? 0,
  }
}

export function listMedia({ type = 'all', query = '', userId = null } = {}) {
  const clauses = []
  const params = [userId ?? -1]

  if (type === MediaType.MOVIE || type === MediaType.TV) {
    clauses.push('m.media_type = ?')
    params.push(type)
  }

  if (query) {
    clauses.push('(lower(m.title) LIKE ? OR lower(m.overview) LIKE ?)')
    const like = `%${String(query).toLowerCase()}%`
    params.push(like, like)
  }

  const rows = db
    .prepare(
      `SELECT m.*,
        (SELECT COUNT(*) FROM requests r WHERE r.media_id = m.id AND r.status IN (1, 2)) AS active_requests,
        (SELECT COUNT(*) FROM requests r WHERE r.media_id = m.id AND r.status IN (1, 2) AND r.user_id = ?) AS my_active_requests
      FROM media m
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY m.release_date DESC, m.title ASC`
    )
    .all(...params)

  return rows.map(mapMedia)
}

export function getMedia(id) {
  return mapMedia(db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id)))
}

export function getMediaByTmdb(tmdbId, mediaType) {
  return mapMedia(
    db.prepare('SELECT * FROM media WHERE tmdb_id = ? AND media_type = ?').get(Number(tmdbId), mediaType)
  )
}

export function setMediaStatus(id, status) {
  db.prepare('UPDATE media SET status = ? WHERE id = ?').run(status, Number(id))
}

/** Fills artwork on a title that was seeded or imported without it. */
export function setMediaArtwork(id, posterPath, backdropPath = null) {
  db.prepare(
    'UPDATE media SET poster_path = ?, backdrop_path = COALESCE(?, backdrop_path) WHERE id = ?'
  ).run(posterPath ?? null, backdropPath ?? null, Number(id))
}

export function setMediaExternalId(id, externalId) {
  db.prepare('UPDATE media SET external_id = ? WHERE id = ?').run(externalId ?? null, Number(id))
}

export function setMediaSyncedAt(id, value = timestamp()) {
  db.prepare('UPDATE media SET synced_at = ? WHERE id = ?').run(value, Number(id))
}

export function listSeasons(mediaId) {
  return db
    .prepare('SELECT * FROM seasons WHERE media_id = ? ORDER BY season_number ASC')
    .all(Number(mediaId))
    .map((row) => ({
      id: row.id,
      mediaId: row.media_id,
      seasonNumber: row.season_number,
      name: row.name,
      episodeCount: row.episode_count,
      status: row.status,
    }))
}

export function setSeasonStatus(mediaId, seasonNumber, status) {
  db.prepare('UPDATE seasons SET status = ? WHERE media_id = ? AND season_number = ?').run(
    status,
    Number(mediaId),
    Number(seasonNumber)
  )
}

/** Inserts or refreshes a title from TMDB metadata. */
export function upsertTmdbMedia(item) {
  const existing = db
    .prepare('SELECT id FROM media WHERE tmdb_id = ? AND media_type = ?')
    .get(Number(item.tmdbId), item.mediaType)

  let mediaId

  if (existing) {
    mediaId = existing.id
    db.prepare(
      `UPDATE media SET title = ?, overview = ?, release_date = ?, genres = ?, runtime = ?,
        seasons_count = ?, poster_path = ?, backdrop_path = ? WHERE id = ?`
    ).run(
      item.title,
      item.overview ?? '',
      item.releaseDate ?? null,
      JSON.stringify(item.genres ?? []),
      item.runtime ?? null,
      item.seasonsCount ?? null,
      item.posterPath ?? null,
      item.backdropPath ?? null,
      mediaId
    )
  } else {
    const info = db
      .prepare(
        `INSERT INTO media (tmdb_id, media_type, title, overview, release_date, genres, runtime, seasons_count,
          status, created_at, poster_path, backdrop_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Number(item.tmdbId),
        item.mediaType,
        item.title,
        item.overview ?? '',
        item.releaseDate ?? null,
        JSON.stringify(item.genres ?? []),
        item.runtime ?? null,
        item.seasonsCount ?? null,
        MediaStatus.UNKNOWN,
        timestamp(),
        item.posterPath ?? null,
        item.backdropPath ?? null
      )

    mediaId = Number(info.lastInsertRowid)
  }

  for (const season of item.seasons ?? []) {
    db.prepare(
      'INSERT OR IGNORE INTO seasons (media_id, season_number, name, episode_count, status) VALUES (?, ?, ?, ?, ?)'
    ).run(
      mediaId,
      season.seasonNumber,
      season.name ?? `Season ${season.seasonNumber}`,
      season.episodeCount ?? 0,
      MediaStatus.UNKNOWN
    )
  }

  return getMedia(mediaId)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function mapRequest(row) {
  if (!row) return null
  return {
    id: row.id,
    mediaId: row.media_id,
    userId: row.user_id,
    status: row.status,
    seasons: row.seasons ? JSON.parse(row.seasons) : null,
    note: row.note,
    qualityProfileId: row.quality_profile_id ?? null,
    qualityProfileName: row.quality_profile_name ?? null,
    attempts: row.attempts ?? 0,
    nextRetryAt: row.next_retry_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    media: row.title
      ? {
          id: row.media_id,
          title: row.title,
          mediaType: row.media_type,
          status: row.media_status,
          tmdbId: row.tmdb_id,
          releaseDate: row.release_date,
          posterPath: row.poster_path ?? null,
        }
      : undefined,
    requester: row.requester_username
      ? { id: row.user_id, username: row.requester_username, email: row.requester_email }
      : undefined,
  }
}

const REQUEST_SELECT = `
  SELECT r.*,
    m.title, m.media_type, m.status AS media_status, m.tmdb_id, m.release_date, m.poster_path,
    u.username AS requester_username, u.email AS requester_email
  FROM requests r
  JOIN media m ON m.id = r.media_id
  JOIN users u ON u.id = r.user_id
`

function requestFilters({ userId = null, statuses = null }) {
  const clauses = []
  const params = []

  if (userId !== null) {
    clauses.push('r.user_id = ?')
    params.push(Number(userId))
  }

  if (statuses?.length) {
    clauses.push(`r.status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function listRequests({ userId = null, statuses = null, take = null, offset = 0 } = {}) {
  const { where, params } = requestFilters({ userId, statuses })
  const limit = take === null ? '' : 'LIMIT ? OFFSET ?'
  const args = take === null ? params : [...params, Number(take), Number(offset) || 0]

  return db
    .prepare(`${REQUEST_SELECT} ${where} ORDER BY r.created_at DESC ${limit}`)
    .all(...args)
    .map(mapRequest)
}

export function countRequests({ userId = null, statuses = null } = {}) {
  const { where, params } = requestFilters({ userId, statuses })
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM requests r
      JOIN media m ON m.id = r.media_id
      ${where}`
    )
    .get(...params).count
}

export function countMonthlyRequests(userId, mediaType, sinceIso) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM requests r
      JOIN media m ON m.id = r.media_id
      WHERE r.user_id = ? AND m.media_type = ? AND r.created_at >= ?`
    )
    .get(Number(userId), mediaType, sinceIso).count
}

export function listRequestsForMedia(mediaId) {
  return db
    .prepare(`${REQUEST_SELECT} WHERE r.media_id = ? ORDER BY r.created_at DESC`)
    .all(Number(mediaId))
    .map(mapRequest)
}

export function getRequestById(id) {
  return mapRequest(db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(Number(id)))
}

export function findActiveRequest(mediaId, userId) {
  return mapRequest(
    db
      .prepare(
        `${REQUEST_SELECT}
        WHERE r.media_id = ? AND r.user_id = ? AND r.status IN (?, ?)
        ORDER BY r.created_at DESC`
      )
      .get(Number(mediaId), Number(userId), MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED)
  )
}

export function createRequest({
  mediaId,
  userId,
  status,
  seasons,
  qualityProfileId = null,
  qualityProfileName = null,
}) {
  const now = timestamp()
  const info = db
    .prepare(
      'INSERT INTO requests (media_id, user_id, status, seasons, quality_profile_id, quality_profile_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      Number(mediaId),
      Number(userId),
      status,
      seasons ? JSON.stringify(seasons) : null,
      qualityProfileId === null ? null : Number(qualityProfileId),
      qualityProfileName,
      now,
      now
    )

  return getRequestById(Number(info.lastInsertRowid))
}

export function setRequestRetry(id, { attempts = 0, nextRetryAt = null } = {}) {
  db.prepare('UPDATE requests SET attempts = ?, next_retry_at = ?, updated_at = ? WHERE id = ?').run(
    Number(attempts) || 0,
    nextRetryAt,
    timestamp(),
    Number(id)
  )
}

/** Failed requests whose next automatic attempt is due. */
export function listFailedForRetry(now = timestamp(), limit = 20) {
  return db
    .prepare(
      `${REQUEST_SELECT}
      WHERE r.status = ? AND (r.next_retry_at IS NULL OR r.next_retry_at <= ?)
      ORDER BY r.next_retry_at IS NOT NULL, r.next_retry_at ASC
      LIMIT ?`
    )
    .all(MediaRequestStatus.FAILED, now, Number(limit))
    .map(mapRequest)
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function createNotification({ userId, kind, title, body = '', href = null }) {
  const info = db
    .prepare('INSERT INTO notifications (user_id, kind, title, body, href, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Number(userId), kind, title, body, href, timestamp())

  return Number(info.lastInsertRowid)
}

export function listNotifications(userId, limit = 40) {
  return db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(userId), Number(limit))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      readAt: row.read_at,
      createdAt: row.created_at,
    }))
}

export function countUnreadNotifications(userId) {
  return db
    .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(Number(userId)).count
}

export function markNotificationsRead(userId, id = null) {
  if (id === null) {
    return Number(
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(timestamp(), Number(userId))
        .changes
    )
  }

  return Number(
    db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      .run(timestamp(), Number(id), Number(userId)).changes
  )
}

export function setRequestStatus(id, status, note = null) {
  db.prepare('UPDATE requests SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?').run(
    status,
    note,
    timestamp(),
    Number(id)
  )
}

export function deleteRequest(id) {
  db.prepare('DELETE FROM requests WHERE id = ?').run(Number(id))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSettings() {
  const settings = { ...SETTING_DEFAULTS }
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in settings) settings[row.key] = row.value
  }
  return settings
}

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : (SETTING_DEFAULTS[key] ?? null)
}

export function saveSettings(entries) {
  const statement = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
  )

  for (const [key, value] of Object.entries(entries)) {
    if (!(key in SETTING_DEFAULTS)) continue
    statement.run(key, String(value))
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function insertSession(token, userId, expiresAt) {
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    Number(userId),
    timestamp(),
    expiresAt
  )
}

export function sessionUser(token) {
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(String(token), timestamp())

  return mapUser(row)
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token))
}

export function deleteOtherSessions(userId, keepToken) {
  return Number(
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(Number(userId), String(keepToken)).changes
  )
}

export function countSessions() {
  return db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?').get(timestamp()).count
}

export function deleteExpiredSessions() {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(timestamp()).changes)
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export function recordAudit(userId, action, detail = '') {
  db.prepare('INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?, ?, ?, ?)').run(
    userId ? Number(userId) : null,
    action,
    detail,
    timestamp()
  )
}

export function listAudit(limit = 25) {
  return db
    .prepare(
      `SELECT a.*, u.username FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?`
    )
    .all(Number(limit))
    .map((row) => ({
      id: row.id,
      action: row.action,
      detail: row.detail,
      createdAt: row.created_at,
      username: row.username ?? 'system',
    }))
}

// ---------------------------------------------------------------------------
// Seed data (offline fallback catalog; TMDB takes over once a key is set)
// ---------------------------------------------------------------------------

const MOVIES = [
  [693134, 'Dune: Part Two', '2024-02-27', 167, 'Science Fiction,Adventure'],
  [545611, 'Everything Everywhere All at Once', '2022-03-24', 139, 'Comedy,Science Fiction'],
  [414906, 'The Batman', '2022-03-01', 176, 'Action,Crime'],
  [335984, 'Blade Runner 2049', '2017-10-04', 164, 'Science Fiction,Thriller'],
  [329865, 'Arrival', '2016-11-10', 116, 'Science Fiction,Drama'],
  [157336, 'Interstellar', '2014-11-05', 169, 'Science Fiction,Drama'],
  [244786, 'Whiplash', '2014-10-10', 107, 'Drama,Music'],
  [496243, 'Parasite', '2019-05-30', 132, 'Thriller,Drama'],
]

const SERIES = [
  [95396, 'Severance', '2022-02-17', 'Science Fiction,Mystery', [[1, 9], [2, 10]]],
  [136315, 'The Bear', '2022-06-23', 'Comedy,Drama', [[1, 8], [2, 10], [3, 10]]],
  [83867, 'Andor', '2022-09-21', 'Science Fiction,Drama', [[1, 12], [2, 12]]],
  [70523, 'Dark', '2017-12-01', 'Mystery,Science Fiction', [[1, 10], [2, 8], [3, 8]]],
  [100088, 'Arcane', '2021-11-06', 'Animation,Science Fiction', [[1, 9], [2, 9]]],
  [95480, 'Slow Horses', '2022-04-01', 'Thriller,Drama', [[1, 6], [2, 6], [3, 6], [4, 6]]],
]

function seedCatalog(now) {
  const insertMedia = db.prepare(
    `INSERT OR IGNORE INTO media (tmdb_id, media_type, title, overview, release_date, genres, runtime, seasons_count, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertSeason = db.prepare(
    'INSERT OR IGNORE INTO seasons (media_id, season_number, name, episode_count, status) VALUES (?, ?, ?, ?, ?)'
  )

  for (const [tmdbId, title, releaseDate, runtime, genres] of MOVIES) {
    insertMedia.run(tmdbId, MediaType.MOVIE, title, '', releaseDate, JSON.stringify(genres.split(',')), runtime, null, MediaStatus.UNKNOWN, now)
  }

  for (const [tmdbId, title, releaseDate, genres, seasons] of SERIES) {
    insertMedia.run(
      tmdbId,
      MediaType.TV,
      title,
      '',
      releaseDate,
      JSON.stringify(genres.split(',')),
      null,
      seasons.length,
      MediaStatus.UNKNOWN,
      now
    )

    const media = db.prepare('SELECT id FROM media WHERE tmdb_id = ?').get(tmdbId)
    for (const [number, episodes] of seasons) {
      insertSeason.run(media.id, number, `Season ${number}`, episodes, MediaStatus.UNKNOWN)
    }
  }
}

function seed() {
  const now = timestamp()

  if (db.prepare('SELECT COUNT(*) AS count FROM settings').get().count === 0) {
    saveSettings(SETTING_DEFAULTS)
  }

  // Only the optional ADMIN_PASSWORD bootstrap seeds accounts. Without it the
  // database stays empty and the app serves /setup for the first account.
  if (countUsers() === 0 && config.adminPassword) {
    createUser({
      email: config.adminEmail,
      username: config.adminUsername,
      password: config.adminPassword,
      role: Role.ADMIN,
      permissions: ALL_PERMISSIONS,
    })

    if (config.seedDemoUser) {
      createUser({ email: 'sam@discovarr.local', username: 'Sam', password: 'sam', role: Role.USER })
    }
  }

  if (db.prepare('SELECT COUNT(*) AS count FROM media').get().count === 0) {
    seedCatalog(now)

    const interstellar = db.prepare('SELECT id FROM media WHERE title = ?').get('Interstellar')
    if (interstellar) db.prepare('UPDATE media SET status = ? WHERE id = ?').run(MediaStatus.AVAILABLE, interstellar.id)

    const sam = db.prepare('SELECT id FROM users WHERE email = ?').get('sam@discovarr.local')
    const severance = db.prepare('SELECT id FROM media WHERE title = ?').get('Severance')

    if (sam && severance) {
      db.prepare(
        'INSERT INTO requests (media_id, user_id, status, seasons, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(severance.id, sam.id, MediaRequestStatus.PENDING, JSON.stringify([2]), now, now)
      db.prepare('UPDATE media SET status = ? WHERE id = ?').run(MediaStatus.PENDING, severance.id)
      db.prepare('UPDATE seasons SET status = ? WHERE media_id = ? AND season_number = 2').run(
        MediaStatus.PENDING,
        severance.id
      )
    }
  }
}

seed()
