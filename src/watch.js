import { config } from './config.js'
import { getSetting } from './db.js'
import { providerOptions, streamingProviders, watchRegion } from './tmdb.js'

/**
 * Playing a title on a service the household already pays for.
 *
 * TMDB says which services carry a title in the region, but it answers with one
 * JustWatch page for all of them, so it cannot say what that title's Netflix or
 * Disney+ URL is. JustWatch's own catalogue can: every offer carries the
 * provider's link to that exact title, which is the same data TMDB's
 * "where to watch" panel is built from. Those links are what the play buttons
 * open, so a click lands on the title itself rather than a search box.
 *
 * The lookup is per title and remembered, because a browse grid of twenty
 * posters would otherwise be twenty requests.
 */

// JustWatch adds services and drops them through the day; a day-old answer is
// still the same link for a title that has not moved.
const OFFER_TTL_MS = 24 * 60 * 60 * 1000
// A title JustWatch could not answer for is not retried on every page load.
const ERROR_TTL_MS = 10 * 60 * 1000
const CACHE_LIMIT = 500
const TIMEOUT_MS = 6000

const OFFERS_QUERY = `query ($country: Country!, $language: Language!, $search: String!) {
  popularTitles(country: $country, filter: { searchQuery: $search }, first: 5, sortBy: POPULAR) {
    edges {
      node {
        ... on MovieOrShow {
          content(country: $country, language: $language) {
            externalIds { tmdbId }
          }
          offers(country: $country, platform: WEB) {
            monetizationType
            standardWebURL
            package { clearName }
          }
        }
      }
    }
  }
}`

// A subscription, not a rental: the household already pays for these, so the
// button is "play" rather than "go and buy it".
const SUBSCRIPTION_TYPES = new Set(['FLATRATE', 'FREE', 'ADS'])

/** "Netflix", "netflix", "Netflix Standard with Ads" — one service. */
function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/\bwith ads\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function nameTokens(value) {
  return new Set(normalizeName(value).split(' ').filter(Boolean))
}

/**
 * Whether a JustWatch package is the service the household ticked. The names
 * are close but not identical — TMDB says "Apple TV Plus", JustWatch "Apple
 * TV+", and a cheaper tier appends "with ads" — so one name matching every word
 * of the other counts, while two different names do not.
 */
function sameService(left, right) {
  const a = nameTokens(left)
  const b = nameTokens(right)
  if (!a.size || !b.size) return false

  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  return [...smaller].every((token) => larger.has(token))
}

/** The provider ids ticked on the settings page, in the order they were ticked. */
export function serviceIds() {
  return [
    ...new Set(
      String(getSetting('tmdb.services') ?? '')
        .split(',')
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ]
}

/**
 * The ticked services with the names TMDB knows them by, so a button says
 * "Disney Plus" rather than an id, and a service that has left the region is
 * dropped instead of shown as a number.
 */
export async function myServices() {
  const ids = serviceIds()
  if (!ids.length) return []

  const known = await streamingProviders().catch(() => providerOptions())
  const names = new Map(known.map((service) => [Number(service.id), service.name]))

  return ids
    .map((id) => ({ id, name: names.get(id) ?? null }))
    .filter((service) => Boolean(service.name))
}

const offersCache = new Map()

function remember(key, entry) {
  offersCache.delete(key)
  offersCache.set(key, entry)
  while (offersCache.size > CACHE_LIMIT) offersCache.delete(offersCache.keys().next().value)
}

/** Subscription offers for one title, keyed by package name. */
async function fetchOffers(tmdbId, title) {
  const response = await fetch(config.justwatchUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Discovarr (self-hosted media manager)',
    },
    body: JSON.stringify({
      query: OFFERS_QUERY,
      variables: { country: watchRegion(), language: 'en', search: String(title ?? '') },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) throw new Error(`JustWatch responded with HTTP ${response.status}`)

  const payload = await response.json()
  const edges = payload?.data?.popularTitles?.edges ?? []
  // Matched on the TMDB id, not the title: a remake or a same-named film must
  // not hand back another title's link.
  const node = edges
    .map((edge) => edge?.node)
    .find((candidate) => String(candidate?.content?.externalIds?.tmdbId ?? '') === String(tmdbId))

  if (!node) return []

  const offers = []
  const seen = new Set()

  for (const offer of node.offers ?? []) {
    const name = String(offer?.package?.clearName ?? '').trim()
    const url = String(offer?.standardWebURL ?? '').trim()
    const kind = String(offer?.monetizationType ?? '')

    if (!name || !url) continue
    if (!SUBSCRIPTION_TYPES.has(kind)) continue
    // The link is rendered as an href, so anything that is not a web address is
    // dropped rather than trusted to be one.
    if (!/^https?:\/\//i.test(url)) continue

    const key = normalizeName(name)
    if (seen.has(key)) continue
    seen.add(key)
    offers.push({ name, url })
  }

  return offers
}

async function titleOffers(tmdbId, title) {
  const key = `${watchRegion()}:${tmdbId}`
  const cached = offersCache.get(key)
  if (cached && Date.now() - cached.at < (cached.failed ? ERROR_TTL_MS : OFFER_TTL_MS)) return cached.offers

  let offers = null
  try {
    offers = await fetchOffers(tmdbId, title)
  } catch {
    offers = null
  }

  const entry = offers ? { at: Date.now(), offers, failed: false } : { at: Date.now(), offers: [], failed: true }
  remember(key, entry)
  return entry.offers
}

/**
 * One play link per service the household has that carries this title. Empty
 * when no services are ticked, so an install that has not asked for this pays
 * nothing for it.
 */
export async function serviceLinks({ tmdbId, title }) {
  const services = await myServices()
  if (!services.length) return []

  const offers = await titleOffers(Number(tmdbId), title)
  if (!offers.length) return []

  const links = []
  for (const service of services) {
    const offer = offers.find((candidate) => sameService(candidate.name, service.name))
    if (offer) links.push({ id: service.id, name: service.name, url: offer.url, package: offer.name })
  }

  return links
}
