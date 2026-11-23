/**
 * JSON the television (and any other client) needs for the screens the browser
 * renders as HTML. The shapes follow the pages in pages.js: the same filters,
 * the same "already requested" rules, the same calendar scope. Nothing here
 * writes a setting or a user.
 */
import { hasPermission, requirePermission, requireUser } from './auth.js'
import {
  ACTIVE_REQUEST_STATUSES,
  MEDIA_STATUS_LABEL,
  MediaStatus,
  MediaType,
  Permission,
} from './constants.js'
import {
  approveRequest,
  declineRequest,
  deleteRequest,
  getCatalog,
  quotaSummary,
  requestMedia,
  retryRequest,
} from './core.js'
import * as store from './db.js'
import { HttpError, readBody, sendJson } from './http.js'
import { plexEntries, plexEntryFor } from './plex.js'
import { downloadQueue, serviceLookup, serviceProfiles } from './services.js'
import {
  collectionDetails,
  collectionsFor,
  contentTypeOptions,
  discoverPage,
  discoverQuery,
  genreList,
  networkOptions,
  personDetails,
  recommendedTitles,
  searchPage,
  seasonDetails,
  studioOptions,
  titleDetails,
  tmdbConfigured,
  trailerFor,
  trendingPage,
  TYPE_GENRE_IDS,
  upcomingTitles,
} from './tmdb.js'

const PER_PAGE = 24
const COLLECTION_SCAN_PAGES = 3

const SORTS = Object.freeze([
  ['popular', 'Popular'],
  ['new', 'Recently released'],
  ['upcoming', 'Upcoming'],
  ['rating', 'Highest rated'],
])

const LANGUAGES = Object.freeze([
  ['', 'Any language'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['hi', 'Hindi'],
  ['pt', 'Portuguese'],
  ['zh', 'Chinese'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
])

const RATINGS = Object.freeze([
  ['', 'Any rating'],
  ['6', '6 or more'],
  ['7', '7 or more'],
  ['8', '8 or more'],
  ['9', '9 or more'],
])

const VOTES = Object.freeze([
  ['', 'Any votes'],
  ['100', '100+ votes'],
  ['500', '500+ votes'],
  ['1000', '1,000+ votes'],
  ['5000', '5,000+ votes'],
])

const CONTENT_TYPE_IDS = new Set(contentTypeOptions(MediaType.TV).map((type) => type.id))

function pageNumber(value) {
  const page = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(page) && page > 0 ? page : 1
}

function parseIds(values) {
  const parts = [].concat(values ?? []).flatMap((entry) => String(entry).split(/[,|]/))
  return [...new Set(parts.map((part) => part.trim()).filter((part) => /^\d+$/.test(part)))]
}

function parseKinds(values) {
  const parts = [].concat(values ?? []).flatMap((entry) => String(entry).split(','))
  return [...new Set(parts.map((part) => part.trim()).filter((part) => CONTENT_TYPE_IDS.has(part)))]
}

export function filtersFromSearch(params) {
  const number = (key, min, max) => {
    const value = Number.parseInt(String(params.get(key) ?? ''), 10)
    return Number.isFinite(value) && value >= min && value <= max ? value : null
  }
  const language = String(params.get('lang') ?? '')
  const sort = String(params.get('sort') ?? '')

  return {
    kinds: parseKinds(params.getAll('kind')),
    genres: parseIds(params.getAll('genre')),
    networks: parseIds(params.getAll('network')),
    studios: parseIds(params.getAll('studio')),
    collections: params.get('collections') === '1',
    from: number('from', 1900, 2100),
    to: number('to', 1900, 2100),
    rating: number('rating', 0, 10),
    votes: number('votes', 0, 100000),
    language: /^[a-z]{2}$/.test(language) ? language : '',
    sort: SORTS.some(([key]) => key === sort) ? sort : 'popular',
  }
}

function hasFilters(filters) {
  return Boolean(
    filters.kinds.length ||
      filters.genres.length ||
      filters.networks.length ||
      filters.studios.length ||
      filters.collections ||
      filters.from ||
      filters.to ||
      filters.rating ||
      filters.votes ||
      filters.language
  )
}

export function parseMediaType(value, { allowAll = false } = {}) {
  if (value === MediaType.MOVIE || value === MediaType.TV) return value
  if (allowAll && (value === 'all' || value === '' || value == null)) return 'all'
  return null
}

function activeCounts(mediaId, userId) {
  const requests = store.listRequestsForMedia(mediaId)
  const active = requests.filter((request) => ACTIVE_REQUEST_STATUSES.includes(request.status))
  return {
    activeRequests: active.length,
    myActiveRequests: active.filter((request) => request.userId === userId).length,
  }
}

function cardFromItem(item, userId, plex = {}) {
  const local = item.tmdbId ? store.getMediaByTmdb(item.tmdbId, item.mediaType) : item.id ? store.getMedia(item.id) : null
  const counts = local
    ? activeCounts(local.id, userId)
    : { activeRequests: item.activeRequests ?? 0, myActiveRequests: item.myActiveRequests ?? 0 }
  const entry = plexEntryFor(plex, item.mediaType ?? local?.mediaType, item.tmdbId ?? local?.tmdbId)

  return {
    id: local?.id ?? item.id ?? 0,
    tmdbId: item.tmdbId ?? local?.tmdbId ?? null,
    mediaType: item.mediaType ?? local?.mediaType ?? MediaType.MOVIE,
    title: item.title ?? local?.title ?? 'Untitled',
    overview: (local?.overview || item.overview || '').trim(),
    releaseDate: item.releaseDate ?? local?.releaseDate ?? null,
    posterPath: local?.posterPath || item.posterPath || null,
    backdropPath: local?.backdropPath || item.backdropPath || null,
    status: local?.status ?? MediaStatus.UNKNOWN,
    genres: (local?.genres?.length ? local.genres : item.genres) ?? [],
    runtime: item.runtime ?? local?.runtime ?? null,
    seasonsCount: item.seasonsCount ?? local?.seasonsCount ?? null,
    ...counts,
    plex: Boolean(entry),
  }
}

function formatDate(value) {
  return value ? String(value).slice(0, 10) : null
}

/** A fact value, or null when every candidate is missing or zero. */
function seasonCount(...values) {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return String(number)
  }
  return null
}

function profilesFor(mediaType) {
  const kind = mediaType === MediaType.TV ? 'sonarr' : 'radarr'
  return serviceProfiles(kind).map((profile, index) => ({
    index,
    name: profile.name,
    profileName: profile.profileName ?? '',
    isDefault: Boolean(profile.isDefault),
  }))
}

function partState(tmdbId) {
  const local = store.getMediaByTmdb(Number(tmdbId), MediaType.MOVIE)
  if (!local) return { state: null, label: '', blocked: false, mediaId: null }
  if (local.status === MediaStatus.AVAILABLE) {
    return { state: 'library', label: 'In library', blocked: true, mediaId: local.id }
  }
  const active = store
    .listRequestsForMedia(local.id)
    .some((request) => ACTIVE_REQUEST_STATUSES.includes(request.status))
  if (active) return { state: 'requested', label: 'Requested', blocked: true, mediaId: local.id }
  return { state: null, label: '', blocked: false, mediaId: local.id }
}

async function loadDetails(mediaType, tmdbId) {
  if (!tmdbConfigured() || !tmdbId) return null
  try {
    return await titleDetails(mediaType, Number(tmdbId))
  } catch {
    return null
  }
}

function watchPayload(details) {
  const watch = details?.watch
  if (!watch) return null
  const groups = [
    ['Streaming', watch.flatrate],
    ['Free', watch.free],
    ['Rent', watch.rent],
    ['Buy', watch.buy],
  ]
    .filter(([, providers]) => providers?.length)
    .map(([label, providers]) => ({
      label,
      providers: providers.map((provider) => ({ name: provider.name })),
    }))

  return { region: watch.region, link: watch.link ?? null, groups }
}

function seasonRows(media, details) {
  const stored = media ? store.listSeasons(media.id) : []
  const fromDetails = (details?.seasons ?? []).map((season) => ({
    seasonNumber: season.seasonNumber,
    name: season.name ?? `Season ${season.seasonNumber}`,
    episodeCount: Number(season.episodes ?? season.episodeCount ?? 0),
  }))
  const listed = fromDetails.length
    ? fromDetails
    : stored.map((season) => ({
        seasonNumber: season.seasonNumber,
        name: season.name,
        episodeCount: season.episodeCount ?? 0,
      }))

  return listed
    .filter((season) => Number(season.seasonNumber) > 0)
    .map((season) => {
      const known = stored.find((candidate) => candidate.seasonNumber === season.seasonNumber)
      const status = known?.status ?? MediaStatus.UNKNOWN
      return {
        seasonNumber: season.seasonNumber,
        name: season.name,
        episodeCount: season.episodeCount || known?.episodeCount || 0,
        status,
        inLibrary: status === MediaStatus.AVAILABLE,
      }
    })
}

/** One title, whether or not it has been imported yet. */
export async function titlePayload({ user, media = null, mediaType = null, tmdbId = null }) {
  const type = media?.mediaType ?? mediaType
  const id = media?.tmdbId ?? tmdbId
  if (type !== MediaType.MOVIE && type !== MediaType.TV) throw new HttpError(404, 'Title not found')
  if (!media && (!Number.isInteger(Number(id)) || Number(id) <= 0)) throw new HttpError(404, 'Title not found')

  const local = media ?? (id ? store.getMediaByTmdb(Number(id), type) : null)
  const details = await loadDetails(type, local?.tmdbId ?? id)
  const entry = local ?? details
  if (!entry) throw new HttpError(404, 'Title not found')

  const counts = local ? activeCounts(local.id, user.id) : { activeRequests: 0, myActiveRequests: 0 }
  const plexMap = await plexEntries()
  const plex = plexEntryFor(plexMap, type, local?.tmdbId ?? id)
  const kind = type === MediaType.TV ? 'sonarr' : 'radarr'
  const remote = local?.tmdbId || id ? await serviceLookup(kind, local?.tmdbId ?? id) : { found: false }
  const isAvailable = local?.status === MediaStatus.AVAILABLE || Boolean(plex)
  const blocked = !isAvailable && (counts.activeRequests > 0 || remote?.found === true)
  const seasons = type === MediaType.TV ? seasonRows(local, details) : []
  const quota = quotaSummary(user)[type === MediaType.TV ? 'tv' : 'movie']

  let collection = null
  if (type === MediaType.MOVIE && details?.collection?.id) {
    try {
      const full = await collectionDetails(details.collection.id)
      collection = {
        id: full.id,
        name: full.name,
        posterPath: full.posterPath ?? null,
        parts: full.parts.map((part) => ({
          ...part,
          current: Number(part.tmdbId) === Number(local?.tmdbId ?? id),
          ...partState(part.tmdbId),
        })),
      }
    } catch {
      collection = null
    }
  }

  const facts = [
    ['Release date', formatDate(entry.releaseDate)],
    type === MediaType.TV ? ['Seasons', seasonCount(details?.totalSeasons, seasons.length, entry.seasonsCount)] : null,
    type === MediaType.TV
      ? ['Episodes', seasonCount(details?.totalEpisodes, seasons.reduce((sum, season) => sum + (season.episodeCount || 0), 0))]
      : null,
    type === MediaType.TV ? ['Last aired', formatDate(details?.lastAirDate)] : null,
    entry.runtime ? [type === MediaType.TV ? 'Episode runtime' : 'Runtime', `${entry.runtime} min`] : null,
    details?.rating ? ['Rating', `${details.rating}/10 from ${Number(details.votes || 0).toLocaleString('en-US')} votes`] : null,
    details?.releaseStatus ? ['Release status', details.releaseStatus] : null,
    (entry.genres ?? local?.genres)?.length ? ['Genres', (entry.genres ?? local.genres).join(', ')] : null,
    details?.directors?.length ? ['Director', details.directors.join(', ')] : null,
    details?.creators?.length ? ['Created by', details.creators.join(', ')] : null,
    details?.networks?.length ? ['Network', details.networks.join(', ')] : null,
    local ? ['Library', `${MEDIA_STATUS_LABEL[local.status] ?? 'Unknown'} · ${counts.activeRequests} active request(s)`] : null,
  ].filter((fact) => fact && fact[1])

  const meta = [
    type === MediaType.TV ? 'Series' : 'Movie',
    formatDate(entry.releaseDate)?.slice(0, 4),
    entry.runtime ? `${entry.runtime} min` : null,
    ...((entry.genres ?? local?.genres) ?? []),
  ]
    .filter(Boolean)
    .join(' · ')

  const trailer = tmdbConfigured() ? await trailerFor(type, local?.tmdbId ?? id) : null
  const watched = store.isWatched(user.id, local?.tmdbId ?? id, type)

  return {
    media: cardFromItem(
      {
        ...(details ?? {}),
        ...(local ?? {}),
        id: local?.id ?? 0,
        tmdbId: local?.tmdbId ?? details?.tmdbId ?? Number(id),
        mediaType: type,
        title: local?.title ?? details?.title,
        overview: local?.overview || details?.overview || '',
        posterPath: local?.posterPath || details?.posterPath || null,
        releaseDate: local?.releaseDate ?? details?.releaseDate ?? null,
      },
      user.id,
      plexMap
    ),
    overview: (local?.overview || details?.overview || '').trim(),
    tagline: details?.tagline || null,
    meta,
    facts: facts.map(([label, value]) => ({ label, value: String(value) })),
    cast: (details?.cast ?? []).map((member) => ({
      id: member.id,
      name: member.name,
      character: member.character || '',
      photoPath: member.profilePath || member.artworkPath || null,
    })),
    seasons,
    plex: plex ? { playUrl: plex.playUrl, library: plex.library ?? 'Plex' } : null,
    trailer: trailer ? { url: trailer.url, name: trailer.name } : null,
    watched,
    watch: watchPayload(details),
    collection,
    profiles: profilesFor(type),
    quota: { used: quota.used, limit: quota.limit },
    inLibrary: isAvailable,
    blocked,
    blockReason: blocked
      ? [counts.activeRequests > 0 ? 'Requested in Discovarr' : null, remote?.found ? `Already in ${type === MediaType.TV ? 'Sonarr' : 'Radarr'}` : null]
          .filter(Boolean)
          .join(' · ')
      : null,
    canRequest: !isAvailable && !blocked,
    tmdb: Boolean(details),
  }
}

function localPage(type, query, page, userId) {
  const all = getCatalog({ type: type === 'all' ? 'all' : type, query, userId })
  const totalPages = Math.max(1, Math.ceil(all.length / PER_PAGE))
  const current = Math.min(page, totalPages)
  return {
    source: 'local',
    page: current,
    totalPages,
    items: all.slice((current - 1) * PER_PAGE, current * PER_PAGE),
  }
}

async function scanCollections(mediaType, filters, first, totalPages) {
  const films = [...first]
  const last = Math.min(COLLECTION_SCAN_PAGES, Math.max(1, Number(totalPages) || 1))
  for (let page = 2; page <= last; page += 1) {
    try {
      const more = await discoverPage(mediaType, discoverQuery(mediaType, filters, filters.sort), {
        page,
        sort: filters.sort,
      })
      if (!more.items.length) break
      films.push(...more.items)
    } catch {
      break
    }
  }
  return collectionsFor(films)
}

/** Discover, search and filtered browse, one page at a time. */
export async function discoverPayload({ user, type = 'all', query = '', page = 1, filters }) {
  const requested = parseMediaType(type, { allowAll: true })
  if (!requested) throw new HttpError(400, 'type must be movie, tv or all')

  const configured = tmdbConfigured()
  const mediaType =
    requested === MediaType.MOVIE || requested === MediaType.TV
      ? requested
      : filters.networks.length && !filters.studios.length
        ? MediaType.TV
        : MediaType.MOVIE

  const plex = await plexEntries()
  let source = 'local'
  let currentPage = page
  let totalPages = 1
  let items = []
  let collections = null
  let error = null

  if (configured && !query && hasFilters(filters)) {
    try {
      const collectionMode = filters.collections && mediaType === MediaType.MOVIE
      const result = await discoverPage(mediaType, discoverQuery(mediaType, filters, filters.sort), {
        page: collectionMode ? 1 : page,
        sort: filters.sort,
      })
      source = 'tmdb'
      currentPage = Math.min(result.page, result.totalPages)
      totalPages = result.totalPages
      if (collectionMode) {
        const found = await scanCollections(mediaType, filters, result.items, result.totalPages)
        collections = found.map((collection) => ({
          id: collection.id,
          name: collection.name,
          overview: collection.overview ?? '',
          posterPath: collection.posterPath ?? null,
          count: collection.parts?.length ?? 0,
        }))
        items = []
      } else {
        items = result.items
      }
    } catch (failure) {
      error = failure instanceof HttpError ? failure.message : 'TMDB unavailable'
    }
  }

  if (source !== 'tmdb') {
    if (configured) {
      try {
        const found = query ? await searchPage(query, requested, page) : await trendingPage(requested, page)
        source = 'tmdb'
        totalPages = found.totalPages
        currentPage = Math.min(found.page, found.totalPages)
        items = found.items
        for (const item of items) {
          const local = item.tmdbId ? store.getMediaByTmdb(item.tmdbId, item.mediaType) : null
          if (local && !local.posterPath && item.posterPath) {
            store.setMediaArtwork(local.id, item.posterPath, item.backdropPath ?? null)
          }
        }
      } catch (failure) {
        source = 'local'
        error = failure instanceof HttpError ? failure.message : 'TMDB unavailable'
        const local = localPage(requested, query, page, user.id)
        currentPage = local.page
        totalPages = local.totalPages
        items = local.items
      }
    } else {
      const local = localPage(requested, query, page, user.id)
      currentPage = local.page
      totalPages = local.totalPages
      items = local.items
    }
  }

  return {
    source,
    mediaType: requested === 'all' ? mediaType : requested,
    query,
    page: currentPage,
    totalPages,
    error,
    results: items.map((item) => cardFromItem(item, user.id, plex)),
    collections,
  }
}

export async function facetPayload(mediaType) {
  const type = parseMediaType(mediaType)
  if (!type) throw new HttpError(400, 'type must be movie or tv')

  let genres = []
  if (tmdbConfigured()) {
    try {
      genres = (await genreList(type)).filter((genre) => !TYPE_GENRE_IDS.has(Number(genre.id)))
    } catch {
      genres = []
    }
  }

  return {
    mediaType: type,
    tmdb: tmdbConfigured(),
    genres,
    types: contentTypeOptions(type),
    networks: networkOptions().map((network) => ({ id: network.id, name: network.name })),
    studios: studioOptions().map((studio) => ({ id: studio.id, name: studio.name })),
    sorts: SORTS.map(([id, name]) => ({ id, name })),
    ratings: RATINGS.map(([id, name]) => ({ id, name })),
    votes: VOTES.map(([id, name]) => ({ id, name })),
    languages: LANGUAGES.map(([id, name]) => ({ id, name })),
  }
}

export async function recommendationsPayload(user) {
  if (!tmdbConfigured()) {
    return { configured: false, reason: 'Add a TMDB API key to see recommendations.', results: [] }
  }

  const seeds = []
  const seen = new Set()
  const addSeed = (mediaType, tmdbId, title, why) => {
    if (!tmdbId || !title) return
    const key = `${mediaType}:${tmdbId}`
    if (seen.has(key)) return
    seen.add(key)
    seeds.push({ mediaType, tmdbId, title, why })
  }

  for (const media of store.listMedia({})) {
    if (media.status === MediaStatus.AVAILABLE) addSeed(media.mediaType, media.tmdbId, media.title, 'library')
  }
  for (const saved of store.listWatchlist(user.id)) {
    addSeed(saved.mediaType, saved.tmdbId, saved.title, 'watchlist')
  }
  for (const request of store.listRequests({ userId: user.id, take: 8 })) {
    if (request.media?.tmdbId) addSeed(request.media.mediaType, request.media.tmdbId, request.media.title, 'requested')
  }

  const chosen = seeds.slice(0, 3)
  const items = await recommendedTitles(chosen.map(({ mediaType, tmdbId }) => ({ mediaType, tmdbId })))
  const plex = await plexEntries()
  const reason = !chosen.length
    ? 'Popular titles to start with — request a few and this page follows your taste.'
    : chosen[0].why === 'library'
      ? `Because ${chosen.map((seed) => seed.title).join(', ')} ${chosen.length === 1 ? 'is' : 'are'} in your library.`
      : chosen[0].why === 'watchlist'
        ? `Because you saved ${chosen.map((seed) => seed.title).join(', ')}.`
        : `Because you requested ${chosen.map((seed) => seed.title).join(', ')}.`

  return {
    configured: true,
    reason,
    results: items.map((item) => cardFromItem(item, user.id, plex)),
  }
}

export async function personPayload(user, id, page) {
  if (!tmdbConfigured()) throw new HttpError(503, 'Person pages need a TMDB API key')
  const person = await personDetails(Number(id))
  const totalPages = Math.max(1, Math.ceil(person.credits.length / PER_PAGE))
  const current = Math.min(pageNumber(page), totalPages)
  const credits = person.credits.slice((current - 1) * PER_PAGE, current * PER_PAGE)
  const plex = await plexEntries()
  const born = [formatDate(person.birthday), person.placeOfBirth].filter(Boolean).join(' · ')
  const facts = [
    ['Known for', person.knownFor],
    ['Born', born || null],
    ['Died', formatDate(person.deathday)],
    ['Credits', person.credits.length ? `${person.credits.length} titles` : null],
  ].filter((fact) => fact[1])

  return {
    id: person.id,
    name: person.name,
    biography: String(person.biography ?? '').trim(),
    profilePath: person.profilePath ?? null,
    facts: facts.map(([label, value]) => ({ label, value: String(value) })),
    page: current,
    totalPages,
    credits: credits.map((item) => cardFromItem(item, user.id, plex)),
  }
}

export async function collectionPayload(id) {
  if (!tmdbConfigured()) throw new HttpError(503, 'Collections need a TMDB API key')
  const collection = await collectionDetails(Number(id))
  const parts = collection.parts.map((part) => ({ ...part, ...partState(part.tmdbId) }))
  return {
    id: collection.id,
    name: collection.name,
    overview: collection.overview ?? '',
    posterPath: collection.posterPath ?? null,
    inLibrary: parts.filter((part) => part.state === 'library').length,
    parts,
  }
}

export async function requestCollection({ user, tmdbIds, profileIndex = null }) {
  const ids = [...new Set([].concat(tmdbIds ?? []).map(Number))].filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) throw new HttpError(400, 'Pick at least one film')

  let done = 0
  let skipped = 0
  const problems = []

  for (const tmdbId of ids) {
    try {
      await requestMedia({
        mediaType: MediaType.MOVIE,
        tmdbId,
        userId: user.id,
        seasonNumbers: null,
        profileIndex: profileIndex === null || profileIndex === undefined ? null : Number(profileIndex),
      })
      done += 1
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      skipped += 1
      problems.push(error.message)
    }
  }

  return {
    done,
    skipped,
    message: `${done} film${done === 1 ? '' : 's'} requested${skipped ? ` · ${skipped} skipped` : ''}`,
    problems,
  }
}

export function watchlistPayload(user) {
  return {
    results: store.listWatchlist(user.id).map((item) => {
      const local = item.local?.id ? store.getMedia(item.local.id) : store.getMediaByTmdb(item.tmdbId, item.mediaType)
      const counts = local ? activeCounts(local.id, user.id) : { activeRequests: 0, myActiveRequests: 0 }
      return {
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        title: item.title,
        posterPath: item.posterPath ?? local?.posterPath ?? null,
        releaseDate: item.releaseDate,
        mediaId: local?.id ?? null,
        status: local?.status ?? MediaStatus.UNKNOWN,
        ...counts,
      }
    }),
  }
}

export function toggleWatchlistPayload(user, body) {
  const tmdbId = Number(body.tmdbId)
  const mediaType = body.mediaType === MediaType.TV ? MediaType.TV : MediaType.MOVIE
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new HttpError(400, 'Unknown title')

  const result = store.toggleWatchlist(user.id, {
    tmdbId,
    mediaType,
    title: String(body.title ?? 'Untitled'),
    posterPath: String(body.posterPath ?? '') || null,
    releaseDate: String(body.releaseDate ?? '') || null,
  })

  return { added: result.added, watched: result.added }
}

function monthBounds(value, now = new Date()) {
  const match = /^(\d{4})-(\d{1,2})$/.exec(String(value ?? ''))
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth()
  if (match) {
    year = Number(match[1])
    month = Number(match[2]) - 1
  }
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
    year = now.getUTCFullYear()
    month = now.getUTCMonth()
  }
  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 0))
  return { year, month, start, end, key: `${year}-${String(month + 1).padStart(2, '0')}` }
}

function shiftMonth(key, delta) {
  const [year, month] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthName(key) {
  const [year, month] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function agendaDayLabel(iso) {
  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function calendarScope() {
  const scope = new Map()
  for (const media of store.listMedia({})) {
    if (!media.tmdbId) continue
    const requested = store
      .listRequestsForMedia(media.id)
      .some((request) => request.status === 1 || request.status === 2 || request.status === 5)
    const available = media.status === MediaStatus.AVAILABLE
    if (!available && !requested) continue
    scope.set(`${media.mediaType}:${media.tmdbId}`, {
      mediaId: media.id,
      inLibrary: available,
      title: media.title,
      mediaType: media.mediaType,
      tmdbId: media.tmdbId,
      posterPath: media.posterPath ?? null,
      releaseDate: media.releaseDate,
    })
  }
  return scope
}

export async function calendarPayload(monthValue) {
  const month = monthBounds(monthValue)
  let items = []
  let error = null

  try {
    items = await upcomingTitles({
      from: month.start.toISOString().slice(0, 10),
      until: month.end.toISOString().slice(0, 10),
      limit: 200,
    })
  } catch (failure) {
    error = failure instanceof HttpError ? failure.message : 'The calendar could not be loaded'
  }

  const scope = calendarScope()
  const seen = new Set()
  const entries = []

  for (const item of items) {
    const key = `${item.mediaType}:${item.tmdbId}`
    const known = scope.get(key)
    if (!known || seen.has(key)) continue
    seen.add(key)
    entries.push({
      date: String(item.releaseDate).slice(0, 10),
      title: item.title,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      mediaId: known.mediaId,
      posterPath: known.posterPath || item.posterPath || null,
      inLibrary: known.inLibrary,
    })
  }

  for (const [key, known] of scope) {
    if (seen.has(key)) continue
    const day = known.releaseDate ? String(known.releaseDate).slice(0, 10) : null
    if (!day || !day.startsWith(month.key)) continue
    entries.push({
      date: day,
      title: known.title,
      mediaType: known.mediaType,
      tmdbId: known.tmdbId,
      mediaId: known.mediaId,
      posterPath: known.posterPath,
      inLibrary: known.inLibrary,
    })
  }

  entries.sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title))
  const byDay = new Map()
  for (const entry of entries) {
    if (!byDay.has(entry.date)) byDay.set(entry.date, [])
    byDay.get(entry.date).push(entry)
  }

  return {
    key: month.key,
    label: monthName(month.key),
    previous: shiftMonth(month.key, -1),
    next: shiftMonth(month.key, 1),
    count: entries.length,
    error,
    days: [...byDay.entries()].map(([date, dayEntries]) => ({
      date,
      label: agendaDayLabel(date),
      entries: dayEntries,
    })),
  }
}

export function notificationsPayload(user) {
  return {
    unread: store.countUnreadNotifications(user.id),
    results: store.listNotifications(user.id).map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      body: item.body,
      href: item.href,
      read: Boolean(item.readAt),
      createdAt: item.createdAt,
    })),
  }
}

function requestView(request) {
  return {
    id: request.id,
    status: request.status,
    note: request.note,
    seasons: request.seasons,
    createdAt: request.createdAt,
    attempts: request.attempts ?? 0,
    nextRetryAt: request.nextRetryAt ?? null,
    qualityProfileName: request.qualityProfileName ?? null,
    requester: request.requester ?? null,
    media: request.media
      ? {
          id: request.media.id,
          tmdbId: request.media.tmdbId ?? null,
          mediaType: request.media.mediaType,
          title: request.media.title,
          status: request.media.status,
          releaseDate: request.media.releaseDate ?? null,
          posterPath: request.media.posterPath ?? null,
        }
      : null,
  }
}

export async function activityPayload(user) {
  const canSeeQueue = hasPermission(user, Permission.MANAGE_SETTINGS)
  const maxAttempts = Number(store.getSetting('requests.maxAttempts') ?? 3)
  const retry = store.listRetryQueue(canSeeQueue ? {} : { userId: user.id })
  const waiting = retry.filter((request) => (request.attempts ?? 0) < maxAttempts).map(requestView)
  const exhausted = retry.filter((request) => (request.attempts ?? 0) >= maxAttempts).map(requestView)

  return {
    canManage: canSeeQueue,
    maxAttempts,
    waiting,
    exhausted,
    queue: canSeeQueue ? await downloadQueue({ limit: 15 }) : [],
  }
}

export async function seasonPayload(tmdbId, seasonNumber) {
  if (!tmdbConfigured()) return { episodes: [] }
  const season = await seasonDetails(Number(tmdbId), Number(seasonNumber))
  return {
    name: season.name,
    overview: season.overview || null,
    episodes: (season.episodes ?? []).map((episode) => ({
      number: episode.number,
      name: episode.name,
      airDate: episode.airDate,
      runtime: episode.runtime,
      overview: episode.overview || null,
      meta: [episode.airDate ? String(episode.airDate).slice(0, 10) : 'Unaired', episode.runtime ? `${episode.runtime} min` : null]
        .filter(Boolean)
        .join(' · '),
    })),
  }
}

export function registerCompanionRoutes(router) {
  router.get('/api/v1/discover', async ({ req, res, url }) => {
    const user = requireUser(req)
    sendJson(
      res,
      200,
      await discoverPayload({
        user,
        type: url.searchParams.get('type') ?? 'all',
        query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '',
        page: pageNumber(url.searchParams.get('page')),
        filters: filtersFromSearch(url.searchParams),
      })
    )
  })

  router.get('/api/v1/discover/facets', async ({ req, res, url }) => {
    requireUser(req)
    sendJson(res, 200, await facetPayload(url.searchParams.get('type') ?? MediaType.MOVIE))
  })

  router.get('/api/v1/recommendations', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, await recommendationsPayload(user))
  })

  router.get('/api/v1/titles/:mediaType/:tmdbId', async ({ req, res, params }) => {
    const user = requireUser(req)
    const mediaType = parseMediaType(params.mediaType)
    const tmdbId = Number(params.tmdbId)
    if (!mediaType) throw new HttpError(404, 'Title not found')
    const local = store.getMediaByTmdb(tmdbId, mediaType)
    sendJson(res, 200, await titlePayload({ user, media: local, mediaType, tmdbId }))
  })

  router.get('/api/v1/media/:id/page', async ({ req, res, params }) => {
    const user = requireUser(req)
    const media = store.getMedia(Number(params.id))
    if (!media) throw new HttpError(404, 'Title not found')
    sendJson(res, 200, await titlePayload({ user, media }))
  })

  router.get('/api/v1/person/:id', async ({ req, res, url, params }) => {
    const user = requireUser(req)
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Person not found')
    sendJson(res, 200, await personPayload(user, id, url.searchParams.get('page')))
  })

  router.get('/api/v1/collection/:id', async ({ req, res, params }) => {
    requireUser(req)
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Collection not found')
    sendJson(res, 200, await collectionPayload(id))
  })

  router.post('/api/v1/collection/:id/request', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)
    sendJson(
      res,
      200,
      await requestCollection({
        user,
        tmdbIds: body.tmdbIds ?? body.tmdbId,
        profileIndex: body.profileIndex,
      })
    )
  })

  router.get('/api/v1/watchlist', ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, watchlistPayload(user))
  })

  router.post('/api/v1/watchlist/toggle', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, toggleWatchlistPayload(user, await readBody(req)))
  })

  router.get('/api/v1/calendar', async ({ req, res, url }) => {
    requireUser(req)
    sendJson(res, 200, await calendarPayload(url.searchParams.get('month')))
  })

  router.get('/api/v1/notifications', ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, notificationsPayload(user))
  })

  router.post('/api/v1/notifications/read', async ({ req, res }) => {
    const user = requireUser(req)
    const body = await readBody(req)
    const id = body.id === undefined || body.id === null || body.id === '' ? null : Number(body.id)
    const marked = store.markNotificationsRead(user.id, id)
    sendJson(res, 200, { marked, unread: store.countUnreadNotifications(user.id) })
  })

  router.get('/api/v1/activity', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, await activityPayload(user))
  })

  router.get('/api/v1/profiles', ({ req, res, url }) => {
    requireUser(req)
    const type = parseMediaType(url.searchParams.get('mediaType') ?? url.searchParams.get('type'))
    if (!type) throw new HttpError(400, 'mediaType must be movie or tv')
    sendJson(res, 200, { results: profilesFor(type) })
  })

  router.get('/api/v1/tv/:tmdbId/season/:seasonNumber', async ({ req, res, params }) => {
    requireUser(req)
    const tmdbId = Number(params.tmdbId)
    const seasonNumber = Number(params.seasonNumber)
    if (!Number.isInteger(tmdbId) || !Number.isInteger(seasonNumber)) throw new HttpError(400, 'Unknown season')
    sendJson(res, 200, await seasonPayload(tmdbId, seasonNumber))
  })

  // Same per-item outcome the requests page reports for a ticked batch.
  // The television acts on one row at a time and does not need this.
  router.post('/api/v1/request/bulk', async ({ req, res }) => {
    const actor = requirePermission(req, Permission.MANAGE_REQUESTS, 'You cannot manage requests')
    const body = await readBody(req)
    const action = String(body.action ?? '')
    const ids = [...new Set([].concat(body.ids ?? []).map(Number))].filter((id) => Number.isInteger(id) && id > 0)
    if (!['approve', 'decline', 'retry', 'delete'].includes(action)) throw new HttpError(400, 'Unknown bulk action')
    if (ids.length === 0) throw new HttpError(400, 'Tick at least one request first')

    let done = 0
    const problems = []
    for (const id of ids) {
      try {
        if (action === 'approve') await approveRequest(id, actor)
        else if (action === 'retry') await retryRequest(id, actor)
        else if (action === 'decline') declineRequest(id, actor)
        else deleteRequest(id, actor)
        done += 1
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        problems.push({ id, error: error.message })
      }
    }

    sendJson(res, 200, { done, problems })
  })
}
