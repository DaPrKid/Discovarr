import { MediaStatus, MediaType } from './constants.js'
import { getSetting, saveSettings } from './db.js'

const LABELS = { sonarr: 'Sonarr', radarr: 'Radarr' }
const TIMEOUT_MS = 8000

/** \"1|HD-1080p\" lines from older installs turned back into profiles. */
function parseLegacyProfiles(value) {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name = ''] = line.split('|')
      return { id: Number(id), name }
    })
    .filter((profile) => Number.isInteger(profile.id))
}

/** A stored profile: a label, the *arr quality profile and a root folder. */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null

  const profileId = Number(raw.profileId)
  if (!Number.isInteger(profileId) || profileId <= 0) return null

  const profileName = String(raw.profileName ?? raw.profile_name ?? raw.name ?? '').trim()
  const name = String(raw.name ?? profileName).trim() || `Profile ${profileId}`

  return {
    name,
    profileId,
    profileName: profileName || name,
    rootFolder: String(raw.rootFolder ?? raw.root_folder ?? '').trim(),
    isDefault: raw.isDefault === true || raw.is_default === true,
  }
}

function parseStoredProfiles(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeProfile).filter(Boolean)
  } catch {
    return []
  }
}

/** Exactly one profile is the default; the first wins if none was marked. */
function withSingleDefault(profiles) {
  let seen = false
  return profiles.map((profile) => {
    if (profile.isDefault && !seen) {
      seen = true
      return profile
    }
    return { ...profile, isDefault: false }
  })
}

function listProfiles(kind, summary) {
  const stored = withSingleDefault(parseStoredProfiles(getSetting(`services.${kind}.profiles`)))
  if (stored.length > 0) {
    if (!stored.some((profile) => profile.isDefault)) stored[0] = { ...stored[0], isDefault: true }
    return stored
  }

  // Databases from before named profiles: the single default plus the extra
  // profiles the administrator ticked.
  const profiles = []
  if (summary.qualityProfileId) {
    const id = Number(summary.qualityProfileId)
    profiles.push({
      name: summary.qualityProfileName || `Profile ${id}`,
      profileId: id,
      profileName: summary.qualityProfileName || `Profile ${id}`,
      rootFolder: summary.rootFolder || '',
      isDefault: true,
    })
  }

  for (const extra of summary.extraProfiles) {
    profiles.push({
      name: extra.name || `Profile ${extra.id}`,
      profileId: extra.id,
      profileName: extra.name || `Profile ${extra.id}`,
      rootFolder: summary.rootFolder || '',
      isDefault: false,
    })
  }

  return withSingleDefault(profiles)
}

export function serviceSummary(kind) {
  const enabled = getSetting(`services.${kind}.enabled`) === 'true'
  const url = getSetting(`services.${kind}.url`)
  const apiKey = getSetting(`services.${kind}.apiKey`)

  const summary = {
    enabled,
    url,
    configured: Boolean(url && apiKey),
    rootFolder: getSetting(`services.${kind}.rootFolder`),
    qualityProfileId: getSetting(`services.${kind}.qualityProfileId`),
    qualityProfileName: getSetting(`services.${kind}.qualityProfileName`),
    extraProfiles: parseLegacyProfiles(getSetting(`services.${kind}.qualityProfiles`)),
  }

  summary.profiles = listProfiles(kind, summary)
  return summary
}

/** The named profiles, the default first. */
export function serviceProfiles(kind) {
  return serviceSummary(kind).profiles
}

/**
 * Writes the profile list and mirrors the default into the older
 * single-profile settings, so the API and any older page keep agreeing.
 */
export function saveServiceProfiles(kind, profiles) {
  const list = withSingleDefault(profiles.map(normalizeProfile).filter(Boolean))
  if (list.length > 0 && !list.some((profile) => profile.isDefault)) list[0] = { ...list[0], isDefault: true }

  const fallback = list.find((profile) => profile.isDefault) ?? list[0] ?? null
  const entries = {
    [`services.${kind}.profiles`]: JSON.stringify(list),
    [`services.${kind}.qualityProfiles`]: list
      .filter((profile) => !profile.isDefault)
      .map((profile) => `${profile.profileId}|${profile.profileName}`)
      .join('\n'),
    [`services.${kind}.rootFolder`]: fallback?.rootFolder ?? '',
    [`services.${kind}.qualityProfileId`]: fallback ? String(fallback.profileId) : '',
    [`services.${kind}.qualityProfileName`]: fallback?.profileName ?? '',
  }

  saveSettings(entries)
  return list
}

/** The profile a request should use, falling back to the default. */
export function resolveProfile(kind, { id = null, name = null } = {}) {
  const profiles = serviceProfiles(kind)
  if (profiles.length === 0) return null

  const byName = name ? profiles.find((profile) => profile.name === String(name)) : null
  if (byName) return byName

  if (id !== null && id !== undefined && String(id) !== '') {
    const byId = profiles.find((profile) => String(profile.profileId) === String(id))
    if (byId) return byId
  }

  return profiles.find((profile) => profile.isDefault) ?? profiles[0]
}

/** The profile at a position in the list shown on the request form. */
export function profileAt(kind, index) {
  const position = Number(index)
  if (!Number.isInteger(position) || position < 0) return null
  return serviceProfiles(kind)[position] ?? null
}

/** Any *arr API call; throws a readable error instead of a raw fetch failure. */
async function arrRequest(kind, path, { method = 'GET', body } = {}) {
  const { url } = serviceSummary(kind)
  const label = LABELS[kind]
  // The key is deliberately absent from serviceSummary, which the API also
  // returns, so it is read straight from settings here.
  const apiKey = getSetting(`services.${kind}.apiKey`)

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

const optionsCache = new Map()
const OPTIONS_TTL_MS = 60_000

/**
 * Root folders and profiles, cached for a minute. The settings page fills its
 * dropdowns from this on every view, so an offline or slow *arr must not make
 * the page hang: failures are cached too and the page falls back to free text.
 */
export async function loadServiceOptions(kind, { fresh = false } = {}) {
  const cached = optionsCache.get(kind)
  if (!fresh && cached && Date.now() - cached.at < OPTIONS_TTL_MS) {
    if (cached.error) throw cached.error
    return cached.value
  }

  try {
    const value = await serviceOptions(kind)
    optionsCache.set(kind, { at: Date.now(), value })
    return value
  } catch (error) {
    optionsCache.set(kind, { at: Date.now(), error })
    throw error
  }
}

/** Drops the cache, so a changed URL or key is picked up immediately. */
export function forgetServiceOptions(kind) {
  optionsCache.delete(kind)
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

/** Adds a title to Radarr/Sonarr on approval, using the request's profile. */
export async function dispatchToService(media, request) {
  const kind = media.mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr'
  const { enabled, configured } = serviceSummary(kind)

  if (!configured) return { dispatched: false, reason: `${LABELS[kind]} is not configured` }
  if (!enabled) return { dispatched: false, reason: `${LABELS[kind]} is disabled` }

  const profile = resolveProfile(kind, {
    id: request?.qualityProfileId,
    name: request?.qualityProfileName,
  })

  if (!profile) {
    throw new Error(`${LABELS[kind]} needs a quality profile in settings`)
  }

  const rootFolder = profile.rootFolder || serviceSummary(kind).rootFolder
  if (!rootFolder) throw new Error(`${LABELS[kind]} profile "${profile.name}" has no root folder`)

  if (media.mediaType === MediaType.MOVIE) {
    const created = await arrRequest(kind, '/movie', {
      method: 'POST',
      body: {
        tmdbId: media.tmdbId,
        title: media.title,
        year: media.releaseDate ? Number(media.releaseDate.slice(0, 4)) : undefined,
        qualityProfileId: profile.profileId,
        rootFolderPath: rootFolder,
        monitored: true,
        minimumAvailability: 'released',
        addOptions: { searchForMovie: true },
      },
    })

    return {
      dispatched: true,
      externalId: created.id ?? null,
      detail: `Added to Radarr with "${profile.name}" (id ${created.id ?? '?'})`,
    }
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
      qualityProfileId: profile.profileId,
      seasonFolder: true,
      monitored: true,
      addOptions: { monitor: 'none', searchForMissingEpisodes: true },
    },
  })

  return {
    dispatched: true,
    externalId: created.id ?? null,
    detail: `Added to Sonarr with "${profile.name}" (id ${created.id ?? '?'})`,
  }
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
