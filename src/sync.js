import { MediaRequestStatus, MediaStatus } from './constants.js'
import * as store from './db.js'
import { fetchLibrary, serviceSummary } from './services.js'

let running = false
let lastRun = null
let lastSummary = null

export function syncState() {
  return { running, lastRun, lastSummary }
}

function applyLibraryItem(item) {
  let media = store.getMediaByTmdb(item.tmdbId, item.mediaType)
  let updated = false

  if (!media) {
    media = store.upsertTmdbMedia({
      tmdbId: item.tmdbId,
      mediaType: item.mediaType,
      title: item.title,
      releaseDate: item.releaseDate,
      seasons: (item.seasons ?? []).map((season) => ({ seasonNumber: season.seasonNumber })),
    })
    updated = true
  }

  if (media.status !== item.status) {
    store.setMediaStatus(media.id, item.status)
    updated = true
  }

  const seasons = store.listSeasons(media.id)
  for (const season of item.seasons ?? []) {
    const existing = seasons.find((candidate) => candidate.seasonNumber === season.seasonNumber)
    if (existing && existing.status !== season.status) {
      store.setSeasonStatus(media.id, season.seasonNumber, season.status)
      updated = true
    }
  }

  store.setMediaSyncedAt(media.id, new Date().toISOString())

  // Complete active requests whose content is now in the library.
  let completed = 0
  for (const request of store.listRequestsForMedia(media.id)) {
    if (request.status !== MediaRequestStatus.PENDING && request.status !== MediaRequestStatus.APPROVED) continue

    const ready =
      item.mediaType === 'tv'
        ? (request.seasons ?? []).every((number) =>
            (item.seasons ?? []).some(
              (season) => season.seasonNumber === number && season.status === MediaStatus.AVAILABLE
            )
          )
        : item.status === MediaStatus.AVAILABLE

    if (ready) {
      store.setRequestStatus(request.id, MediaRequestStatus.COMPLETED, 'Available in the library (sync)')
      completed += 1
    }
  }

  return { updated, completed }
}

export async function syncLibrary({ actorId = null } = {}) {
  if (running) return { ok: false, error: 'A sync is already running' }

  running = true
  const summary = { started: new Date().toISOString(), services: {}, updated: 0, completed: 0, errors: [] }

  try {
    for (const kind of ['radarr', 'sonarr']) {
      const service = serviceSummary(kind)
      if (!service.enabled || !service.configured) {
        summary.services[kind] = 'skipped'
        continue
      }

      try {
        const items = await fetchLibrary(kind)
        summary.services[kind] = `${items.length} items`

        for (const item of items) {
          const result = applyLibraryItem(item)
          if (result.updated) summary.updated += 1
          summary.completed += result.completed
        }
      } catch (error) {
        summary.services[kind] = `error: ${error.message}`
        summary.errors.push(`${kind}: ${error.message}`)
      }
    }

    lastRun = new Date().toISOString()
    lastSummary = summary
    store.recordAudit(
      actorId,
      'sync.run',
      `updated ${summary.updated}, completed ${summary.completed}${
        summary.errors.length ? `, errors: ${summary.errors.join(' | ')}` : ''
      }`
    )

    return { ok: summary.errors.length === 0, summary }
  } finally {
    running = false
  }
}

/** Checks every minute and syncs when the configured interval has elapsed. */
export function startSyncScheduler() {
  return setInterval(async () => {
    const minutes = Number(store.getSetting('sync.intervalMinutes') ?? 30)
    if (!Number.isFinite(minutes) || minutes <= 0) return
    if (lastRun && Date.now() - Date.parse(lastRun) < minutes * 60 * 1000) return

    const ready = ['radarr', 'sonarr'].some((kind) => {
      const service = serviceSummary(kind)
      return service.enabled && service.configured
    })
    if (!ready) return

    await syncLibrary().catch((error) => console.warn(`[discovarr] scheduled sync failed: ${error.message}`))
  }, 60_000).unref()
}
