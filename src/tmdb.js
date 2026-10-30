import { config } from './config.js'
import { getSetting } from './db.js'
import { MediaType } from './constants.js'
import { HttpError } from './http.js'

const BASE_URL = 'https://api.themoviedb.org/3'
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

  const url = new URL(`${BASE_URL}${path}`)
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
            episodeCount: season.episode_count ?? 0,
          }))
      : [],
  }
}

export async function searchTmdb(query, type = 'all') {
  const data =
    type === MediaType.MOVIE || type === MediaType.TV
      ? await tmdbGet(`/search/${type}`, { query, include_adult: 'false' })
      : await tmdbGet('/search/multi', { query, include_adult: 'false' })

  return (data.results ?? [])
    .map((item) => normalizeTmdbItem(item, type === 'all' ? null : type))
    .filter(Boolean)
    .slice(0, 30)
}

export async function trendingTmdb(type = 'all') {
  const path =
    type === MediaType.MOVIE || type === MediaType.TV ? `/trending/${type}/week` : '/trending/all/week'
  const data = await tmdbGet(path)
  return (data.results ?? [])
    .map((item) => normalizeTmdbItem(item, type === 'all' ? null : type))
    .filter(Boolean)
    .slice(0, 24)
}

export async function tmdbDetails(mediaType, tmdbId) {
  const raw = await tmdbGet(`/${mediaType}/${tmdbId}`)
  return normalizeTmdbItem(raw, mediaType)
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
