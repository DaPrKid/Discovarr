import { MediaStatus, MediaType } from './constants.js'
import { getSetting } from './db.js'

const LABELS = { sonarr: 'Sonarr', radarr: 'Radarr' }
const TIMEOUT_MS = 8000

export function serviceSummary(kind) {
  const enabled = getSetting(`services.${kind}.enabled`) === 'true'
  const url = getSetting(`services.${kind}.url`)
  const apiKey = getSetting(`services.${kind}.apiKey`)
  return {
    enabled,
    url,
    configured: Boolean(url && apiKey),
    rootFolder: getSetting(`services.${kind}.rootFolder`),
    qualityProfileId: getSetting(`services.${kind}.qualityProfileId`),
    qualityProfileName: getSetting(`services.${kind}.qualityProfileName`),
  }
}

/** Any *arr API call; throws a readable error instead of a raw fetch failure. */
async function arrRequest(kind, path, { method = 'GET', body } = {}) {
  const { url, apiKey } = serviceSummary(kind)
  const label = LABELS[kind]

  if (!url || !apiKey) throw new Error(`${label} URL and API key are required`)

  let baseUrl
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol')
    baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    throw new Error(`${label} URL must be a valid http(s) address`)
  }

  let response
  try {
    response = await fetch(`${baseUrl}/api/v3${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`${label} is unreachable: ${error.message}`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${label} responded with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  return response.json().catch(() => ({}))
}

export async function testServiceConnection(kind) {
  const label = LABELS[kind]
  if (!label) return { ok: false, error: 'Unknown service' }

  const { configured } = serviceSummary(kind)
  if (!configured) return { ok: false, error: `${label} needs both a URL and an API key` }

  try {
    const status = await arrRequest(kind, '/system/status')
    return { ok: true, detail: `${label} ${status.version ?? 'unknown version'} is reachable` }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

export async function serviceOptions(kind) {
  const [folders, profiles] = await Promise.all([
    arrRequest(kind, '/rootfolder'),
    arrRequest(kind, '/qualityprofile'),
  ])

  return {
    rootFolders: (Array.isArray(folders) ? folders : []).map((folder) => ({
      path: folder.path,
      freeSpace: folder.freeSpace,
    })),
    qualityProfiles: (Array.isArray(profiles) ? profiles : []).map((profile) => ({
      id: profile.id,
      name: profile.name,
    })),
  }
}

/** Adds a title to Radarr/Sonarr on approval. */
export async function dispatchToService(media, request) {
  const kind = media.mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr'
  const { enabled, configured, rootFolder, qualityProfileId } = serviceSummary(kind)

  if (!configured) return { dispatched: false, reason: `${LABELS[kind]} is not configured` }
  if (!enabled) return { dispatched: false, reason: `${LABELS[kind]} is disabled` }
  if (!rootFolder || !qualityProfileId) {
    throw new Error(`${LABELS[kind]} needs a root folder and quality profile in settings`)
  }

  if (media.mediaType === MediaType.MOVIE) {
    const created = await arrRequest(kind, '/movie', {
      method: 'POST',
      body: {
        tmdbId: media.tmdbId,
        title: media.title,
        year: media.releaseDate ? Number(media.releaseDate.slice(0, 4)) : undefined,
        qualityProfileId: Number(qualityProfileId),
        rootFolderPath: rootFolder,
        monitored: true,
        minimumAvailability: 'released',
        addOptions: { searchForMovie: true },
      },
    })

    return { dispatched: true, externalId: created.id ?? null, detail: `Added to Radarr (id ${created.id ?? '?'})` }
  }

  const lookup = await arrRequest(kind, `/series/lookup?term=${encodeURIComponent(`tmdb:${media.tmdbId}`)}`)
  const candidate = Array.isArray(lookup) ? lookup[0] : null
  if (!candidate) throw new Error(`Sonarr could not find TMDB id ${media.tmdbId}`)

  const requestedSeasons = request?.seasons ?? []
  const seasons = (candidate.seasons ?? []).map((season) => ({
    seasonNumber: season.seasonNumber,
    monitored: requestedSeasons.includes(season.seasonNumber),
  }))

  const created = await arrRequest(kind, '/series', {
    method: 'POST',
    body: {
      tvdbId: candidate.tvdbId,
      title: candidate.title,
      titleSlug: candidate.titleSlug,
      images: candidate.images ?? [],
      seasons,
      rootFolderPath: rootFolder,
      qualityProfileId: Number(qualityProfileId),
      seasonFolder: true,
      monitored: true,
      addOptions: { monitor: 'none', searchForMissingEpisodes: true },
    },
  })

  return { dispatched: true, externalId: created.id ?? null, detail: `Added to Sonarr (id ${created.id ?? '?'})` }
}

/** Pulls the current library so statuses can be reconciled. */
export async function fetchLibrary(kind) {
  const { enabled, configured } = serviceSummary(kind)
  if (!enabled || !configured) return []

  const items = await arrRequest(kind, kind === 'radarr' ? '/movie' : '/series')
  if (!Array.isArray(items)) return []

  return items.slice(0, 500).map((item) => {
    if (kind === 'radarr') {
      return {
        tmdbId: item.tmdbId,
        mediaType: MediaType.MOVIE,
        title: item.title,
        releaseDate: item.releaseDate ?? item.inCinemas ?? null,
        status: item.hasFile ? MediaStatus.AVAILABLE : MediaStatus.PROCESSING,
        seasons: [],
      }
    }

    const seasons = (item.seasons ?? []).map((season) => {
      const stats = season.statistics ?? {}
      const total = stats.totalEpisodeCount ?? 0
      const have = stats.episodeFileCount ?? 0

      return {
        seasonNumber: season.seasonNumber,
        status:
          total > 0 && have >= total
            ? MediaStatus.AVAILABLE
            : have > 0
              ? MediaStatus.PARTIALLY_AVAILABLE
              : MediaStatus.PROCESSING,
      }
    })

    const available = seasons.filter((season) => season.status === MediaStatus.AVAILABLE).length
    const status =
      seasons.length > 0 && available === seasons.length
        ? MediaStatus.AVAILABLE
        : available > 0
          ? MediaStatus.PARTIALLY_AVAILABLE
          : MediaStatus.PROCESSING

    return {
      tmdbId: item.tmdbId,
      mediaType: MediaType.TV,
      title: item.title,
      releaseDate: item.firstAired ?? null,
      status,
      seasons,
    }
  })
}
