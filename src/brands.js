import { gunzipSync } from 'node:zlib'

import { readBrandCache, writeBrandCache } from './brand-cache.js'
import { networkOptions, providerOptions, streamingProviders, studioOptions, tmdbConfigured, tmdbGet } from './tmdb.js'

/**
 * Looking up a network or a studio by name.
 *
 * The filter panel used to offer a hand-written list of the obvious ones, so a
 * network like Shudder simply did not exist as far as the app was concerned.
 * TMDB has no "search networks" endpoint, but it does publish the complete list
 * of ids once a day as a gzipped file, which is what this module keeps: one
 * small download a week, then every network can be found by typing its name.
 *
 * Studios are companies, and TMDB does have a company search, so those are
 * simply asked for live.
 */

const TTL_MS = 7 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20000
// Overridable so a test (or a mirror) can serve the export without the internet.
const EXPORT_BASE = (process.env.NETWORK_EXPORT_BASE ?? 'https://files.tmdb.org/p/exports').replace(/\/+$/, '')

/** `{ at, items: [{ id, name }] }` for the current process. */
let memory = null
/** The last failed download, so a dead export host is not retried on every keystroke. */
let lastAttempt = 0

/**
 * The export is one JSON object per line. TMDB keeps a row per regional feed, so
 * the same name appears several times; the lowest id is the one its own site
 * treats as the network, so the rest are dropped rather than offered twice.
 */
function parseCatalogue(text) {
  const byName = new Map()

  for (const line of text.split('\n')) {
    if (!line.trim()) continue

    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }

    const id = Number(row?.id)
    const name = String(row?.name ?? '').trim()
    if (!Number.isFinite(id) || !name) continue

    const key = name.toLowerCase()
    const known = byName.get(key)
    if (!known || id < known.id) byName.set(key, { id, name })
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The export is named for its day, month first: tv_network_ids_11_22_2026. */
function exportDay(daysAgo = 0) {
  const [year, month, day] = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10).split('-')
  return `${month}_${day}_${year}`
}

async function downloadCatalogue() {
  // Published daily, but a timezone edge can leave today's file missing for a
  // moment, so a couple of older dates are tried before giving up.
  for (let back = 0; back < 3; back += 1) {
    try {
      const response = await fetch(`${EXPORT_BASE}/tv_network_ids_${exportDay(back)}.json.gz`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) continue

      const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')
      const items = parseCatalogue(text)
      if (!items.length) continue

      writeBrandCache('networks', items)

      return items
    } catch {
      // Try the next date; a 403 from a blocked host is covered below.
    }
  }

  return null
}

/** Every network TMDB knows, from memory, the data directory or the export. */
export async function networkCatalogue() {
  if (memory && Date.now() - memory.at < TTL_MS) return memory.items

  const stored = readBrandCache('networks')
  if (stored && Date.now() - Date.parse(stored.fetchedAt) < TTL_MS) {
    memory = { at: Date.now(), items: stored.items }
    return memory.items
  }

  // One attempt per ten minutes at most when the export host is unreachable,
  // so typing in the search box cannot turn into a request per keystroke.
  if (Date.now() - lastAttempt > 10 * 60 * 1000) {
    lastAttempt = Date.now()
    const fresh = await downloadCatalogue().catch(() => null)

    if (fresh) {
      memory = { at: Date.now(), items: fresh }
      return fresh
    }
  }

  if (stored) {
    memory = { at: Date.now(), items: stored.items }
    return stored.items
  }

  // Offline: the hand-written list still answers, it just answers less.
  return networkOptions()
}

function curated(kind) {
  if (kind === 'studio') return studioOptions()
  if (kind === 'provider') return providerOptions()
  return networkOptions()
}

function normalName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Networks that are really streaming services. TMDB keeps both catalogues, and
 * a service usually has a network row too — Netflix is network 213 and watch
 * provider 8 — so a network filter for it would search the shows Netflix made
 * rather than everything streaming there. Those rows belong to the streaming
 * list; broadcasters like ABC stay networks.
 */
const STREAMING_NETWORK_NAMES = new Set(
  [
    'Netflix',
    'Hulu',
    'Max',
    'HBO Max',
    'Disney+',
    'Disney+ Hotstar',
    'Hotstar',
    'Apple TV',
    'Prime Video',
    'Amazon Prime Video',
    'Amazon Freevee',
    'Freevee',
    'Paramount+',
    'Peacock',
    'Shudder',
    'Tubi',
    'Pluto TV',
    'Crunchyroll',
    'BritBox',
    'Acorn TV',
    'AMC+',
    'Criterion Channel',
    'The Criterion Channel',
    'MUBI',
    'Plex',
    'ZEE5',
    'iQiyi',
    'Viki',
    'Rakuten Viki',
    'Hayu',
    'Starzplay',
    'SkyShowtime',
    'Crave',
    'Stan',
    'Binge',
  ].map(normalName)
)

function isStreamingNetwork(name) {
  return STREAMING_NETWORK_NAMES.has(normalName(name))
}

/** Exact matches first, then names that start with the term, then the rest. */
function rank(items, query, limit) {
  const term = String(query ?? '').trim().toLowerCase()
  if (!term) return []

  const exact = []
  const starts = []
  const contains = []

  for (const item of items) {
    const name = String(item.name ?? '').toLowerCase()
    if (!name) continue
    if (name === term) exact.push(item)
    else if (name.startsWith(term)) starts.push(item)
    else if (name.includes(term)) contains.push(item)
  }

  return [...exact, ...starts, ...contains].slice(0, limit)
}

export async function searchProviders(query, limit = 12) {
  return rank(await streamingProviders(), query, limit)
}

export async function searchNetworks(query, limit = 12) {
  const networks = (await networkCatalogue()).filter((network) => !isStreamingNetwork(network.name))
  const found = rank(networks, query, limit)
  if (found.length) return found

  // Nothing that is a network: the name may still be a streaming service, and
  // then the row carries its own field so ticking it filters by provider. The
  // old complaint was that a service could not be found at all.
  try {
    return (await searchProviders(query, limit)).map((service) => ({ ...service, field: 'provider' }))
  } catch {
    return []
  }
}

/** Companies, which is what TMDB calls a studio for a film. */
export async function searchStudios(query, limit = 12) {
  const term = String(query ?? '').trim()
  if (!term) return []

  if (!tmdbConfigured()) return rank(curated('studio'), term, limit)

  try {
    const data = await tmdbGet('/search/company', { query: term, page: '1' })
    const found = (data.results ?? []).map((row) => ({ id: row.id, name: row.name }))
    return rank(found, term, limit)
  } catch {
    // A TMDB outage should still match against the list already on the page.
    return rank(curated('studio'), term, limit)
  }
}

export async function searchBrands(kind, query, limit = 12) {
  if (kind === 'studio') return searchStudios(query, limit)
  if (kind === 'provider') return searchProviders(query, limit)
  return searchNetworks(query, limit)
}

function looksLikeId(value) {
  return /^\d+$/.test(String(value ?? ''))
}

/** One name from TMDB when the id is not in the list we already hold. */
async function remoteName(kind, id) {
  // Providers have no per-id endpoint; the region's list is already in hand.
  if (kind === 'provider') return null
  if (!tmdbConfigured() || !looksLikeId(id)) return null

  try {
    const row = await tmdbGet(`/${kind === 'studio' ? 'company' : 'network'}/${Number(id)}`)
    return row?.name ? String(row.name) : null
  } catch {
    return null
  }
}

/**
 * Names for ids that were picked from a live search: a filter chosen last visit
 * has to come back as a ticked box with its name, or it cannot be seen or
 * removed. Anything unresolvable still appears, as `Network 2949`, so the
 * filter is never invisible.
 */
export async function brandNames(kind, ids) {
  const wanted = [...new Set((ids ?? []).map(String).filter(looksLikeId))]
  if (!wanted.length) return []

  const known = new Map()

  // A streaming service is named by TMDB's regional list before any built-in
  // id: provider ids get reused and retired, and a chosen service must not come
  // back wearing another service's name. The built-in shortlist only fills the
  // gaps left when TMDB cannot be reached.
  if (kind === 'provider') {
    for (const item of await streamingProviders().catch(() => [])) known.set(String(item.id), item.name)
  }

  for (const item of curated(kind)) {
    if (!known.has(String(item.id))) known.set(String(item.id), item.name)
  }

  const unknown = wanted.filter((id) => !known.has(id))
  if (unknown.length) {
    const list = kind === 'studio' || kind === 'provider' ? [] : await networkCatalogue().catch(() => [])
    for (const item of list) {
      if (!known.has(String(item.id))) known.set(String(item.id), item.name)
    }

    for (const id of unknown.filter((value) => !known.has(value))) {
      const name = await remoteName(kind, id)
      if (name) known.set(id, name)
    }
  }

  const fallback = kind === 'studio' ? 'Studio' : kind === 'provider' ? 'Service' : 'Network'
  return wanted.map((id) => ({ id, name: known.get(id) ?? `${fallback} ${id}` }))
}
