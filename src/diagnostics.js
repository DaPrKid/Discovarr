import { statSync } from 'node:fs'
import { cacheStats } from './cache.js'
import { config } from './config.js'
import { APP_VERSION, MediaRequestStatus } from './constants.js'
import * as store from './db.js'
import { serviceSummary } from './services.js'
import { syncState } from './sync.js'

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
    sync: {
      lastRun: sync.lastRun,
      lastSummary: sync.lastSummary,
      attempts: sync.attempts ?? 0,
      nextAttemptAt: sync.nextAttemptAt ?? null,
      lastError: sync.lastError ?? null,
    },
  }
}
