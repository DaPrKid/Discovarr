import { getSetting } from './db.js'

const TIMEOUT_MS = 6000
const LIBRARY_TTL_MS = 60_000
const ERROR_TTL_MS = 20_000
const WEB_BASE = 'https://app.plex.tv/desktop/'

/** The saved Plex connection, read straight from the settings store. */
export function plexSettings() {
  return {
    enabled: getSetting('plex.enabled') === 'true',
    url: String(getSetting('plex.url') ?? '').replace(/\/+$/, ''),
    token: String(getSetting('plex.token') ?? ''),
  }
}

export function plexConfigured() {
  const settings = plexSettings()
  return Boolean(settings.enabled && settings.url && settings.token)
}

async function plexGet(path) {
  const { url, token } = plexSettings()
  if (!url || !token) throw new Error('Plex needs both a URL and a token')

  let response
  try {
    response = await fetch(`${url}${path}`, {
      headers: {
        accept: 'application/json',
        'x-plex-token': token,
        'x-plex-client-identifier': 'discovarr',
        'x-plex-product': 'Discovarr',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`Plex is unreachable: ${error.message}`)
  }

  if (!response.ok) throw new Error(`Plex responded with HTTP ${response.status}`)
  return response.json()
}

function container(payload) {
  return payload?.MediaContainer ?? payload ?? {}
}

/** Plex stores the TMDB id in the modern Guid list or the legacy guid string. */
function tmdbIdFrom(item) {
  const guids = [
    ...(Array.isArray(item.Guid) ? item.Guid.map((entry) => entry.id) : []),
    item.guid,
  ].filter(Boolean)

  for (const guid of guids) {
    const match = String(guid).match(/(?:tmdb|themoviedb):\/\/(\d+)/i)
    if (match) return Number(match[1])
  }

  return null
}

let libraryCache = { at: 0, value: null, errorAt: 0, error: null }
let identityCache = { at: 0, value: null }

/** Drops the cached library, so a changed URL or token is picked up at once. */
export function forgetPlex() {
  libraryCache = { at: 0, value: null, errorAt: 0, error: null }
  identityCache = { at: 0, value: null }
}

export async function testPlexConnection() {
  if (!plexConfigured()) return { ok: false, error: 'Plex needs a URL, a token and the integration enabled' }

  try {
    const info = container(await plexGet('/'))
    return { ok: true, detail: `Plex ${info.version ?? 'unknown version'} is reachable` }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

async function machineIdentifier() {
  if (identityCache.value && Date.now() - identityCache.at < LIBRARY_TTL_MS) return identityCache.value
  const info = container(await plexGet('/'))
  identityCache = { at: Date.now(), value: info.machineIdentifier ?? '' }
  return identityCache.value
}

/** The Plex Web deep link that opens (and can play) one library item. */
function playUrl(machineId, ratingKey) {
  return `${WEB_BASE}#!/server/${encodeURIComponent(machineId)}/details?key=${encodeURIComponent(
    `/library/metadata/${ratingKey}`
  )}`
}

/**
 * Every movie and series Plex holds, keyed "movie:<tmdbId>" / "tv:<tmdbId>".
 * This is what verifies a download actually landed, independently of the *arr
 * APIs: the *arr says "has file", Plex says "playable right now".
 */
export async function plexLibrary() {
  if (!plexConfigured()) return {}

  if (libraryCache.value && Date.now() - libraryCache.at < LIBRARY_TTL_MS) return libraryCache.value
  if (libraryCache.error && Date.now() - libraryCache.errorAt < ERROR_TTL_MS) throw libraryCache.error

  try {
    const [machineId, sectionsPayload] = await Promise.all([machineIdentifier(), plexGet('/library/sections')])
    const sections = (container(sectionsPayload).Directory ?? []).filter(
      (section) => section.type === 'movie' || section.type === 'show'
    )

    const entries = {}

    await Promise.all(
      sections.map(async (section) => {
        const payload = await plexGet(
          `/library/sections/${encodeURIComponent(section.key)}/all?includeGuids=1`
        )
        const mediaType = section.type === 'movie' ? 'movie' : 'tv'

        for (const item of container(payload).Metadata ?? []) {
          const tmdbId = tmdbIdFrom(item)
          if (!tmdbId || !item.ratingKey) continue

          entries[`${mediaType}:${tmdbId}`] = {
            ratingKey: item.ratingKey,
            library: section.title ?? 'Plex',
            playUrl: playUrl(machineId, item.ratingKey),
          }
        }
      })
    )

    libraryCache = { at: Date.now(), value: entries, errorAt: 0, error: null }
    return entries
  } catch (error) {
    libraryCache = { at: 0, value: null, errorAt: Date.now(), error }
    throw error
  }
}

/** Never throws: an unreachable Plex just means no Plex badges on a page. */
export async function plexEntries() {
  if (!plexConfigured()) return {}
  try {
    return await plexLibrary()
  } catch {
    return {}
  }
}

export function plexEntryFor(entries, mediaType, tmdbId) {
  if (!entries || !mediaType || !tmdbId) return null
  return entries[`${mediaType}:${tmdbId}`] ?? null
}
