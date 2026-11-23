import { statSync } from 'node:fs'
import { cacheStats } from './cache.js'
import { config } from './config.js'
import { APP_VERSION, MediaRequestStatus } from './constants.js'
import * as store from './db.js'
import { serviceSummary } from './services.js'
import { syncState } from './sync.js'
import { watchState } from './watch.js'

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * One snapshot of the things an administrator otherwise needs SSH for: the
 * database and its write-ahead log, the artwork cache, how many titles and
 * requests exist, what each service is configured to do, and how the last sync
 * went. Nothing here is expensive enough to cache.
 */
export function diagnosticsSnapshot() {
  const requests = store.listRequests({})
  const byStatus = {}
  for (const request of requests) {
    byStatus[request.status] = (byStatus[request.status] ?? 0) + 1
  }

  const sync = syncState()

  return {
    version: APP_VERSION,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    uptimeSeconds: Math.round(process.uptime()),
    database: {
      file: config.databaseFile,
      bytes: fileSize(config.databaseFile),
      walBytes: fileSize(`${config.databaseFile}-wal`),
      // Which migration the file is on, so a support question starts with the
      // same number on both sides.
      schema: store.schemaVersion(),
    },
    cache: cacheStats(),
    counts: {
      users: store.countUsers(),
      media: store.listMedia({}).length,
      sessions: store.countSessions(),
      requests: requests.length,
      pending: byStatus[MediaRequestStatus.PENDING] ?? 0,
      approved: byStatus[MediaRequestStatus.APPROVED] ?? 0,
      failed: byStatus[MediaRequestStatus.FAILED] ?? 0,
      completed: byStatus[MediaRequestStatus.COMPLETED] ?? 0,
      declined: byStatus[MediaRequestStatus.DECLINED] ?? 0,
    },
    services: {
      radarr: serviceSummary('radarr'),
      sonarr: serviceSummary('sonarr'),
    },
    // The streaming play links come from JustWatch, which is the one dependency
    // that is not TMDB, Plex or the *arrs. Reporting it here means a change on
    // their side shows up in Tasks instead of only as missing buttons.
    watch: watchState(),
    sync: {
      lastRun: sync.lastRun,
      lastSummary: sync.lastSummary,
      attempts: sync.attempts ?? 0,
      nextAttemptAt: sync.nextAttemptAt ?? null,
      lastError: sync.lastError ?? null,
    },
  }
}
