import { config } from './config.js'
import { getSetting } from './db.js'
import { MediaType } from './constants.js'
import { HttpError } from './http.js'

const IMAGE_BASE = 'https://image.tmdb.org/t/p'
const TIMEOUT_MS = 8000

export const IMAGE_SIZES = new Set(['w92', 'w154', 'w185', 'w200', 'w300', 'w342', 'w500', 'w780', 'h632', 'original'])

export function tmdbApiKey() {
  return getSetting('tmdb.apiKey') || config.tmdbApiKeyEnv || ''
}

export function tmdbConfigured() {
  return Boolean(tmdbApiKey())
}

async function tmdbGet(path, params = {}) {
  const key = tmdbApiKey()
  if (!key) throw new HttpError(503, 'TMDB is not configured. Add an API key in settings.')

  // config.tmdbBaseUrl is overridable so tests (and TMDB mirrors) can point the
  // client at another host without touching the call sites.
  const url = new URL(`${config.tmdbBaseUrl}${path}`)
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value))
  }

  // v4 read tokens are JWTs; v3 keys go in the query string.
  const headers = { accept: 'application/json' }
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`
  else url.searchParams.set('api_key', key)

  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw new HttpError(502, `TMDB request failed: ${error.message}`)
  }

  if (!response.ok) throw new HttpError(502, `TMDB responded with HTTP ${response.status}`)

  return response.json()
}

export function imageUrl(path, size = 'w342') {
  if (!path) return null
  return `${IMAGE_BASE}/${size}${path.startsWith('/') ? path : `/${path}`}`
}

/** Maps a TMDB payload onto our media shape. */
export function normalizeTmdbItem(raw, fallbackType = null) {
  const mediaType =
    raw.media_type === MediaType.TV || raw.media_type === MediaType.MOVIE ? raw.media_type : fallbackType
  if (mediaType !== MediaType.MOVIE && mediaType !== MediaType.TV) return null

  const isTv = mediaType === MediaType.TV

  return {
    tmdbId: raw.id,
    mediaType,
    title: isTv ? raw.name ?? raw.original_name ?? 'Untitled' : raw.title ?? raw.original_title ?? 'Untitled',
    overview: raw.overview ?? '',
    releaseDate: (isTv ? raw.first_air_date : raw.release_date) ?? null,
    genres: (raw.genres ?? []).map((genre) => genre.name ?? genre).filter(Boolean),
    runtime: isTv ? raw.episode_run_time?.[0] ?? null : raw.runtime ?? null,
    seasonsCount: isTv ? raw.number_of_seasons ?? null : null,
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    seasons: isTv
      ? (raw.seasons ?? [])
          .filter((season) => season.season_number > 0)
          .map((season) => ({
            seasonNumber: season.season_number,
            name: season.name ?? `Season ${season.season_number}`,
            episodes: season.episode_count ?? 0,
          }))
      : [],
  }
}

function normalizePage(data, fallbackPage) {
  return {
    items: [],
    page: Number(data.page) || Number(fallbackPage) || 1,
    totalPages: Math.min(Math.max(Number(data.total_pages) || 1, 1), 500),
  }
}

/** One page of TMDB search results, used by the Discover grid and suggestions. */
export async function searchPage(query, type = 'all', page = 1) {
  const path = type === MediaType.MOVIE || type === MediaType.TV ? `/search/${type}` : '/search/multi'
  const data = await tmdbGet(path, { query, include_adult: 'false', page })

  return {
    ...normalizePage(data, page),
    items: (data.results ?? [])
      .map((item) => normalizeTmdbItem(item, type === 'all' ? null : type))
      .filter(Boolean),
  }
}

export async function searchTmdb(query, type = 'all') {
  const { items } = await searchPage(query, type, 1)
  return items.slice(0, 30)
}

/** One page of trending titles. */
export async function trendingPage(type = 'all', page = 1) {
  const path =
    type === MediaType.MOVIE || type === MediaType.TV ? `/trending/${type}/week` : '/trending/all/week'
  const data = await tmdbGet(path, { page })

  return {
    ...normalizePage(data, page),
    items: (data.results ?? [])
      .map((item) => normalizeTmdbItem(item, type === 'all' ? null : type))
      .filter(Boolean),
  }
}

export async function trendingTmdb(type = 'all') {
  const { items } = await trendingPage(type, 1)
  return items.slice(0, 24)
}

export async function tmdbDetails(mediaType, tmdbId) {
  const raw = await tmdbGet(`/${mediaType}/${tmdbId}`)
  return normalizeTmdbItem(raw, mediaType)
}

// ---------------------------------------------------------------------------
// Browsing: networks, studios and genres
// ---------------------------------------------------------------------------

// TMDB ids for the networks and studios worth a shelf. A wrong id simply yields
// no titles on that shelf, which is why the shelf list is filtered below.
const NETWORKS = Object.freeze([
  { id: 213, name: 'Netflix' },
  { id: 49, name: 'HBO' },
  { id: 1024, name: 'Amazon Prime Video' },
  { id: 2739, name: 'Disney+' },
  { id: 2552, name: 'Apple TV+' },
  { id: 453, name: 'Hulu' },
  { id: 174, name: 'AMC' },
  { id: 88, name: 'FX' },
  { id: 67, name: 'Showtime' },
  { id: 6, name: 'NBC' },
  { id: 16, name: 'CBS' },
  { id: 2, name: 'ABC' },
  { id: 71, name: 'The CW' },
  { id: 4, name: 'BBC One' },
  { id: 19, name: 'Fox' },
  { id: 30, name: 'USA Network' },
  { id: 77, name: 'Syfy' },
  { id: 41, name: 'TNT' },
  { id: 68, name: 'TBS' },
  { id: 47, name: 'Comedy Central' },
  { id: 56, name: 'Cartoon Network' },
  { id: 80, name: 'Adult Swim' },
  { id: 13, name: 'Nickelodeon' },
  { id: 54, name: 'Disney Channel' },
  { id: 33, name: 'MTV' },
  { id: 43, name: 'National Geographic' },
  { id: 64, name: 'Discovery' },
  { id: 65, name: 'History' },
  { id: 318, name: 'Starz' },
  { id: 14, name: 'PBS' },
  { id: 26, name: 'Channel 4' },
])

const STUDIOS = Object.freeze([
  { id: 420, name: 'Marvel Studios' },
  { id: 3, name: 'Pixar' },
  { id: 2, name: 'Walt Disney Pictures' },
  { id: 174, name: 'Warner Bros. Pictures' },
  { id: 33, name: 'Universal Pictures' },
  { id: 4, name: 'Paramount Pictures' },
  { id: 5, name: 'Columbia Pictures' },
  { id: 127928, name: '20th Century Studios' },
  { id: 41077, name: 'A24' },
  { id: 1632, name: 'Lionsgate' },
  { id: 10342, name: 'Studio Ghibli' },
  { id: 521, name: 'DreamWorks Pictures' },
  { id: 12, name: 'New Line Cinema' },
  { id: 8411, name: 'Metro-Goldwyn-Mayer' },
  { id: 10146, name: 'Focus Features' },
  { id: 559, name: 'TriStar Pictures' },
  { id: 14, name: 'Miramax' },
  { id: 1, name: 'Lucasfilm' },
])

const browseCache = new Map()
const BROWSE_TTL_MS = 10 * 60 * 1000

/** Browsing shelves change slowly; caching them keeps page loads quick. */
async function cachedJson(key, loader) {
  const hit = browseCache.get(key)
  if (hit && Date.now() - hit.at < BROWSE_TTL_MS) return hit.value

  const value = await loader()
  browseCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * TMDB discover parameters for the three filters offered on browse pages.
 * "Recently released" only looks backwards and skips obscure entries, while
 * "Upcoming" only looks forwards.
 */
export function browseSort(mediaType, sort = 'popular') {
  const dateField = mediaType === MediaType.TV ? 'first_air_date' : 'primary_release_date'
  const today = new Date().toISOString().slice(0, 10)

  if (sort === 'new') {
    return { sort_by: `${dateField}.desc`, [`${dateField}.lte`]: today, 'vote_count.gte': '10' }
  }

  if (sort === 'upcoming') {
    return { sort_by: `${dateField}.asc`, [`${dateField}.gte`]: today }
  }

  return { sort_by: 'popularity.desc' }
}

/** One paged slice of /discover for a network, studio or genre. */
export async function discoverPage(mediaType, params = {}, { page = 1, sort = 'popular' } = {}) {
  const query = {
    include_adult: 'false',
    page: Math.max(1, Number(page) || 1),
    ...browseSort(mediaType, sort),
    ...params,
  }
  const data = await cachedJson(`discover:${mediaType}:${JSON.stringify(query)}`, () =>
    tmdbGet(`/discover/${mediaType}`, query)
  )

  return {
    ...normalizePage(data, query.page),
    items: (data.results ?? []).map((item) => normalizeTmdbItem(item, mediaType)).filter(Boolean),
  }
}

/** Titles for one network, studio or genre through the discover endpoint. */
export async function discoverTitles(mediaType, params = {}, limit = 24) {
  const { items } = await discoverPage(mediaType, params, { page: 1 })
  return items.slice(0, limit)
}

async function logoPathFor(kind, id) {
  return cachedJson(`${kind}-logo:${id}`, async () => {
    try {
      const data = await tmdbGet(`/${kind}/${id}`)
      return data.logo_path ?? null
    } catch {
      return null
    }
  })
}

export async function networkWithLogo(network) {
  return { ...network, logoPath: await logoPathFor('network', network.id) }
}

export async function studioWithLogo(studio) {
  return { ...studio, logoPath: await logoPathFor('company', studio.id) }
}

/** Every network we know, with its logo, for the logo wall. */
export function networkDirectory() {
  return Promise.all(NETWORKS.map(networkWithLogo))
}

export async function networkShelves(limit = 10, count = NETWORKS.length) {
  const shelves = await Promise.all(
    NETWORKS.slice(0, count).map(async (network) => ({
      ...(await networkWithLogo(network)),
      items: await discoverTitles(MediaType.TV, { with_networks: network.id }, limit).catch(() => []),
    }))
  )

  return shelves.filter((shelf) => shelf.items.length > 0)
}

export function networkById(id) {
  return NETWORKS.find((network) => String(network.id) === String(id)) ?? null
}

/** Every studio we know, with its logo, for the logo wall. */
export function studioDirectory() {
  return Promise.all(STUDIOS.map(studioWithLogo))
}

export async function studioShelves(limit = 10, count = STUDIOS.length) {
  const shelves = await Promise.all(
    STUDIOS.slice(0, count).map(async (studio) => ({
      ...(await studioWithLogo(studio)),
      items: await discoverTitles(MediaType.MOVIE, { with_companies: studio.id }, limit).catch(() => []),
    }))
  )

  return shelves.filter((shelf) => shelf.items.length > 0)
}

export function studioById(id) {
  return STUDIOS.find((studio) => String(studio.id) === String(id)) ?? null
}

export async function genreList(mediaType) {
  const data = await cachedJson(`genres:${mediaType}`, () => tmdbGet(`/genre/${mediaType}/list`))
  return (data.genres ?? []).map((genre) => ({ id: genre.id, name: genre.name })).filter((genre) => genre.id)
}

/** The busiest genres up front, each with a shelf of titles. */
export async function genreShelves(mediaType, { count = 8, limit = 10 } = {}) {
  const genres = (await genreList(mediaType)).slice(0, count)
  const shelves = await Promise.all(
    genres.map(async (genre) => ({
      ...genre,
      items: await discoverTitles(mediaType, { with_genres: genre.id }, limit).catch(() => []),
    }))
  )

  return shelves.filter((shelf) => shelf.items.length > 0)
}

/**
 * Recommendations seeded by the titles a user already asked for. Falls back to
 * popular titles for a brand new account, so the page is never empty.
 */
export async function recommendedTitles(seeds = [], limit = 30) {
  const lists = await Promise.all(
    seeds.slice(0, 3).map(async (seed) => {
      const data = await cachedJson(`recommendations:${seed.mediaType}:${seed.tmdbId}`, () =>
        tmdbGet(`/${seed.mediaType}/${seed.tmdbId}/recommendations`)
      )
      return (data.results ?? []).map((item) => normalizeTmdbItem(item, seed.mediaType)).filter(Boolean)
    })
  )

  const seen = new Set()
  const merged = []

  for (const item of lists.flat()) {
    const key = `${item.mediaType}:${item.tmdbId}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }

  if (merged.length > 0) return merged.slice(0, limit)

  const [movies, series] = await Promise.all([
    discoverTitles(MediaType.MOVIE, {}, Math.ceil(limit / 2)),
    discoverTitles(MediaType.TV, {}, Math.ceil(limit / 2)),
  ])

  const mixed = []
  for (let index = 0; index < Math.max(movies.length, series.length); index += 1) {
    if (movies[index]) mixed.push(movies[index])
    if (series[index]) mixed.push(series[index])
  }

  return mixed.slice(0, limit)
}

/** Region used for the "where to watch" block, set on the settings page. */
export function watchRegion() {
  return String(getSetting('tmdb.region') ?? 'US').trim().toUpperCase() || 'US'
}

function providerGroup(list) {
  return (list ?? []).slice(0, 8).map((provider) => ({
    id: provider.provider_id,
    name: provider.provider_name,
    logoPath: provider.logo_path ?? null,
  }))
}

/** Credits, ratings and streaming availability for the title page. */
export function normalizeTmdbDetails(raw, mediaType) {
  const base = normalizeTmdbItem(raw, mediaType)
  if (!base) return null

  const region = watchRegion()
  const availability = raw['watch/providers']?.results?.[region] ?? null
  const creators = (raw.created_by ?? []).map((person) => person.name).filter(Boolean)
  const directors = (raw.credits?.crew ?? [])
    .filter((member) => member.job === 'Director')
    .map((member) => member.name)
    .filter(Boolean)

  return {
    ...base,
    tagline: raw.tagline ?? '',
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    votes: raw.vote_count ?? 0,
    releaseStatus: raw.status ?? null,
    originalTitle: raw.original_title ?? raw.original_name ?? null,
    totalSeasons: mediaType === MediaType.TV ? raw.number_of_seasons ?? null : null,
    totalEpisodes: mediaType === MediaType.TV ? raw.number_of_episodes ?? null : null,
    lastAirDate: raw.last_air_date ?? null,
    networks: (raw.networks ?? []).map((network) => network.name).filter(Boolean),
    creators: mediaType === MediaType.TV ? creators : [],
    directors: mediaType === MediaType.MOVIE ? directors : [],
    cast: (raw.credits?.cast ?? []).slice(0, 12).map((member) => ({
      id: member.id,
      name: member.name,
      character: member.character ?? '',
      profilePath: member.profile_path ?? null,
    })),
    watch: {
      region,
      link: availability?.link ?? null,
      flatrate: providerGroup(availability?.flatrate),
      free: providerGroup(availability?.free),
      rent: providerGroup(availability?.rent),
      buy: providerGroup(availability?.buy),
    },
  }
}

/** Full detail payload for one title, including cast and availability. */
export async function titleDetails(mediaType, tmdbId) {
  const raw = await tmdbGet(`/${mediaType}/${tmdbId}`, { append_to_response: 'credits,watch/providers' })
  return normalizeTmdbDetails(raw, mediaType)
}
