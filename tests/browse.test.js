import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

let tmdb
let jw
let server
let dataDir
let baseUrl
let adminCookie

function freePort() {
  return new Promise((resolve) => {
    const probe = createNetServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`)
      if (response.ok) return
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('server did not become healthy')
}

function page(path) {
  return fetch(`${baseUrl}${path}`, { headers: { cookie: adminCookie } })
}

function lastRequest(path) {
  return tmdb.requests.filter((request) => request.path === path).pop()
}

before(async () => {
  // A stand-in TMDB. It answers the endpoints the browse pages call and keeps
  // the parsed queries so the tests can check the filters that were sent.
  tmdb = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const query = Object.fromEntries(url.searchParams)
    tmdb.requests.push({ path: url.pathname, query })

    // TMDB's daily network export, which is what the live brand search reads.
    // The name is checked because it is day, month, year — the other order is a
    // 403 from the bucket, and the tests should fail rather than fall back.
    if (url.pathname.startsWith('/exports/')) {
      const named = /^\/exports\/tv_network_ids_\d{2}_\d{2}_\d{4}\.json\.gz$/.test(url.pathname)
      res.writeHead(named ? 200 : 404, { 'content-type': 'application/gzip' })
      if (!named) {
        res.end()
        return
      }
      res.end(
        gzipSync(
          [
            { id: 2, name: 'ABC' },
            { id: 49, name: 'HBO' },
            { id: 213, name: 'Netflix' },
            { id: 2949, name: 'Shudder' },
            { id: 9278, name: 'Shudder' },
            { id: 3353, name: 'Peacock' },
          ]
            .map((row) => JSON.stringify(row))
            .join('\n')
        )
      )
      return
    }

    let body = null

    if (url.pathname.startsWith('/3/trending/')) {
      const number = Number(query.page ?? 1)
      body = {
        page: number,
        total_pages: 3,
        results: Array.from({ length: 20 }, (_, index) => ({
          id: number * 100 + index,
          media_type: 'movie',
          title: `Trending ${number}-${index}`,
          release_date: '2024-01-01',
        })),
      }
    } else if (url.pathname === '/3/search/company') {
      body = {
        page: 1,
        total_pages: 1,
        results: [{ id: 120000, name: 'Shudder Films', logo_path: null }],
      }
    } else if (url.pathname.startsWith('/3/search/')) {
      body = {
        page: 1,
        total_pages: 1,
        results: [{ id: 500, media_type: 'movie', title: 'Searched title', release_date: '2020-05-05' }],
      }
    } else if (url.pathname === '/3/watch/providers/tv' || url.pathname === '/3/watch/providers/movie') {
      // Streaming services are a different catalogue from the networks: the
      // provider ids here do not match the network ids of the same service.
      body = {
        results: [
          { provider_id: 8, provider_name: 'Netflix', display_priority: 1, display_priorities: { US: 1 } },
          { provider_id: 386, provider_name: 'Peacock Premium', display_priority: 4, display_priorities: { US: 4 } },
          { provider_id: 99, provider_name: 'Shudder', display_priority: 9, display_priorities: { US: 9 } },
          { provider_id: 777, provider_name: 'Acme Stream', display_priority: 12, display_priorities: { US: 12 } },
          // The built-in list has 1899 as "Max"; TMDB is the authority on the
          // name, so a chosen id must come back as TMDB spells it.
          { provider_id: 1899, provider_name: 'Max (US)', display_priority: 2, display_priorities: { US: 2 } },
        ],
      }
    } else if (url.pathname.startsWith('/3/discover/')) {
      const number = Number(query.page ?? 1)
      const type = url.pathname.endsWith('/tv') ? 'tv' : 'movie'
      body = {
        page: number,
        total_pages: 2,
        total_results: 24,
        results: Array.from({ length: 12 }, (_, index) => ({
          id: number * 1000 + index,
          name: `${type} ${number}-${index}`,
          first_air_date: '2023-03-03',
          release_date: '2023-03-03',
        })),
      }
    } else if (url.pathname === '/3/movie/999' || url.pathname === '/3/tv/999') {
      body = {
        id: 999,
        title: 'Detail Movie',
        name: 'Detail Movie',
        overview: 'A film about testing.',
        release_date: '2021-01-01',
        first_air_date: '2021-01-01',
        vote_average: 8.1,
        vote_count: 1200,
        runtime: 110,
        backdrop_path: '/backdrop.jpg',
        number_of_seasons: 2,
        number_of_episodes: 5,
        seasons: [
          { season_number: 1, name: 'Season 1', episode_count: 3 },
          { season_number: 2, name: 'Season 2', episode_count: 2 },
        ],
        credits: {
          cast: [{ id: 77, name: 'Ada Actor', character: 'Lead', profile_path: '/ada.jpg' }],
          crew: [],
        },
      }
    } else if (url.pathname === '/3/tv/999/season/1') {
      body = {
        name: 'Season 1',
        overview: 'The first season.',
        air_date: '2021-02-03',
        episodes: [
          {
            episode_number: 1,
            name: 'Pilot Episode',
            overview: 'A test begins.',
            air_date: '2021-02-03',
            runtime: 45,
          },
          {
            episode_number: 2,
            name: 'Second Episode',
            overview: 'Testing continues.',
            air_date: '2021-02-10',
            runtime: 44,
          },
        ],
      }
    } else if (url.pathname === '/3/movie/888') {
      body = {
        id: 888,
        title: 'Collection Film',
        overview: 'One part of a pair.',
        release_date: '2019-01-01',
        backdrop_path: '/eight.jpg',
        belongs_to_collection: { id: 55, name: 'Test Collection', poster_path: '/collection.jpg' },
        credits: {
          cast: [{ id: 78, name: 'No Photo Actor', character: 'Sidekick', profile_path: null }],
          crew: [],
        },
      }
    } else if (url.pathname === '/3/movie/889') {
      body = {
        id: 889,
        title: 'Collection Film Two',
        overview: 'The other part.',
        release_date: '2021-06-01',
        credits: { cast: [], crew: [] },
      }
    } else if (url.pathname === '/3/collection/55') {
      body = {
        id: 55,
        name: 'Test Collection',
        parts: [
          { id: 888, title: 'Collection Film', release_date: '2019-01-01', poster_path: '/one.jpg', vote_average: 7 },
          { id: 889, title: 'Collection Film Two', release_date: '2021-06-01', poster_path: '/two.jpg', vote_average: 6.5 },
        ],
      }
    } else if (/^\/3\/collection\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').pop())
      body = {
        id,
        name: `Set ${id}`,
        poster_path: `/set-${id}.jpg`,
        parts: [
          { id: id - 900, title: `Movie ${id - 900}`, release_date: '2023-03-03', vote_average: 7 },
          { id: id - 902, title: `Movie ${id - 902}`, release_date: '2025-06-06', vote_average: 8 },
        ],
      }
    } else if (/^\/3\/movie\/\d+$/.test(url.pathname)) {
      // Every other film: even ids belong to a collection, odd ids stand alone.
      const id = Number(url.pathname.split('/').pop())
      body = {
        id,
        title: `Movie ${id}`,
        belongs_to_collection: id % 2 === 0 ? { id: 900 + id, name: `Set ${id}` } : null,
      }
    } else if (url.pathname === '/3/person/78/combined_credits') {
      body = {
        cast: [
          { id: 701, media_type: 'movie', title: 'Their Other Film', release_date: '2018-01-01', poster_path: '/other.jpg' },
        ],
      }
    } else if (url.pathname === '/3/person/77') {
      body = {
        id: 77,
        name: 'Ada Actor',
        biography: 'Ada has been in things.\n\nShe keeps acting.',
        birthday: '1980-02-03',
        place_of_birth: 'Leeds, England',
        known_for_department: 'Acting',
        profile_path: '/ada.jpg',
        combined_credits: {
          cast: [
            { id: 601, media_type: 'movie', title: 'First Film', release_date: '2019-05-01', vote_average: 7.2 },
            { id: 602, media_type: 'tv', name: 'A Series', first_air_date: '2022-09-01', vote_average: 8.2 },
          ],
          crew: [],
        },
      }
    } else if (url.pathname.startsWith('/3/network/')) {
      const id = url.pathname.split('/').pop()
      body = { id: Number(id), name: `Network ${id}`, logo_path: `/network-${id}.png` }
    } else if (url.pathname.startsWith('/3/company/')) {
      const id = url.pathname.split('/').pop()
      body = { id: Number(id), name: `Studio ${id}`, logo_path: `/studio-${id}.png` }
    } else if (url.pathname === '/3/genre/tv/list') {
      body = { genres: [{ id: 18, name: 'Drama' }, { id: 10765, name: 'Sci-Fi & Fantasy' }] }
    } else if (url.pathname === '/3/genre/movie/list') {
      body = { genres: [{ id: 28, name: 'Action' }, { id: 35, name: 'Comedy' }] }
    }

    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? {}))
  })
  tmdb.requests = []

  const tmdbPort = await freePort()
  await new Promise((resolve) => tmdb.listen(tmdbPort, '127.0.0.1', resolve))

  // A stand-in JustWatch: the catalogue behind TMDB's "where to watch" data,
  // and the only place a per-service link for a title exists.
  jw = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      jw.requests.push(body)

      const search = String(body.variables?.search ?? '')

      // A title nobody ever answers for, so the cap on the wait can be measured.
      if (search === 'Movie 998') return

      const edges =
        search === 'Detail Movie'
          ? [
              {
                node: {
                  content: { externalIds: { tmdbId: '999' } },
                  offers: [
                    // A cheaper tier of the service still counts as that service.
                    {
                      monetizationType: 'FLATRATE',
                      standardWebURL: 'https://www.netflix.com/title/80100172',
                      package: { clearName: 'Netflix Standard with Ads' },
                    },
                    {
                      monetizationType: 'FLATRATE',
                      standardWebURL: 'https://play.max.com/show/abc',
                      package: { clearName: 'Max' },
                    },
                    {
                      monetizationType: 'FLATRATE',
                      standardWebURL: 'https://www.peacocktv.com/watch/asset/x',
                      package: { clearName: 'Peacock Premium' },
                    },
                    // A rental is not a subscription the household already pays for.
                    {
                      monetizationType: 'RENT',
                      standardWebURL: 'https://www.shudder.com/movies/x',
                      package: { clearName: 'Shudder' },
                    },
                    // Not a web address, so it must never become a button.
                    {
                      monetizationType: 'FLATRATE',
                      standardWebURL: 'javascript:alert(1)',
                      package: { clearName: 'Acme Stream' },
                    },
                  ],
                },
              },
            ]
          : search === 'Trending 1-0'
            ? [
                {
                  node: {
                    content: { externalIds: { tmdbId: '100' } },
                    offers: [
                      {
                        monetizationType: 'FLATRATE',
                        standardWebURL: 'https://www.netflix.com/title/80100172',
                        package: { clearName: 'Netflix' },
                      },
                    ],
                  },
                },
              ]
            : []

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { popularTitles: { edges } } }))
    })
  })
  jw.requests = []

  const jwPort = await freePort()
  await new Promise((resolve) => jw.listen(jwPort, '127.0.0.1', resolve))

  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-browse-test-'))
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_FILE: join(dataDir, 'db.sqlite'),
      IMAGE_CACHE_DIR: join(dataDir, 'images'),
      ADMIN_PASSWORD: 'secret123',
      SEED_DEMO_USER: 'false',
      DEMO_AUTO_LOGIN: '',
      TMDB_API_KEY: 'test-key',
      TMDB_BASE_URL: `http://127.0.0.1:${tmdbPort}/3`,
      NETWORK_EXPORT_BASE: `http://127.0.0.1:${tmdbPort}/exports`,
      JUSTWATCH_URL: `http://127.0.0.1:${jwPort}/graphql`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  server.stdout.resume()
  server.stderr.resume()

  await waitForHealth()

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  })
  adminCookie = (login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie')).split(';')[0]
})

after(() => {
  server?.kill('SIGTERM')
  tmdb?.close()
  // The test that measures the cap leaves one request hanging on purpose.
  jw?.closeAllConnections?.()
  jw?.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('discover fills the grid and pages through trending titles', async () => {
  const first = await (await page('/')).text()
  assert.equal((first.match(/class="media-card"/g) ?? []).length, 20)
  assert.match(first, /Page 1 of 3/)
  assert.match(first, /href="\/\?page=2"/)
  // Discover shows the grid, not a filter panel: the filters live on the
  // networks, studios and genre pages.
  assert.doesNotMatch(first, /class="filter-rail"/)

  const second = await (await page('/?page=2')).text()
  assert.match(second, /Trending 2-0/)
  assert.match(second, /Page 2 of 3/)
  assert.equal(lastRequest('/3/trending/all/week').query.page, '2')
})

test('the stylesheet keeps the wide sidebar, the old poster size and the rail', async () => {
  const css = await (await fetch(`${baseUrl}/styles.css?v=0.7.0`)).text()
  assert.match(css, /\.browse-nav \{[\s\S]*?padding: 16px 14px 18px;/)
  assert.match(css, /\.discover \{[\s\S]*?grid-template-columns: 252px minmax\(0, 1fr\);/)
  assert.match(css, /\.grid \{\n  display: grid;\n  grid-template-columns: repeat\(auto-fill, minmax\(148px, 1fr\)\);/)
  assert.match(css, /\.page:has\(> \.discover\) \{\n  max-width: none;/)
  assert.match(css, /\.discover\.has-rail \{\n  grid-template-columns: 252px minmax\(0, 1fr\) 252px;/)
  assert.match(css, /\.filter-rail \{/)
  assert.match(css, /\.toggle input:checked \+ span \{/)
  assert.match(css, /\.person-head \{/)
})

test('the brand lists cap, search and expand, and Discover carries no filter panel', async () => {
  const studios = await (await page('/studios')).text()

  assert.match(studios, /data-brand-list/)
  assert.match(studios, /data-brand-items/)
  assert.match(studios, /data-brand-search/, 'a search box sits above the list')
  assert.match(studios, /data-brand-more/, 'the rest of the list is behind a button')
  assert.match(studios, /data-brand-limit="8"/)
  assert.match(studios, /data-brand-remote="\/search\/brands\?kind=studio"/, 'a miss asks TMDB')

  // Discover keeps the grid and nothing else: no panel, no toggle for one.
  const discover = await (await page('/')).text()
  assert.doesNotMatch(discover, /class="filter-rail"/)
  assert.doesNotMatch(discover, /class="toggle-brand"/)
  assert.doesNotMatch(discover, /data-panel="rail"/, 'no button for a panel that is not there')

  // The pages that do filter keep both the panel and the chip that folds it.
  const networks = await (await page('/networks')).text()
  assert.match(networks, /class="filter-rail"/)
  assert.match(networks, /data-panel="rail"/)
  assert.match(networks, /aria-label="Show filters"[^>]*>Filters</)

  // Networks are broadcasters; streaming services are watch providers and get
  // their own searchable group instead of sitting in the network list.
  assert.match(networks, /name="network" value="2"/)
  assert.doesNotMatch(networks, /name="network" value="213"/)
  assert.match(networks, /Streaming services/)
  assert.match(networks, /name="provider" value="8"/)
  assert.match(networks, /data-brand-remote="\/search\/brands\?kind=provider"/)
})

test('a network the printed list does not carry is found by live search', async () => {
  // "Shudder" is not in the hand-written list, which is the complaint this
  // answers: the search reads TMDB's full network export instead.
  const response = await fetch(`${baseUrl}/search/brands?kind=network&q=shudder`, {
    headers: { cookie: adminCookie },
  })
  assert.equal(response.status, 200)

  // A streaming service is not a network, so the network search answers with a
  // provider row: ticking it filters by what is on that service, and it still
  // shows up for the name somebody typed.
  const { items } = await response.json()
  assert.deepEqual(items, [{ id: 99, name: 'Shudder', field: 'provider' }])

  const service = await (
    await fetch(`${baseUrl}/search/brands?kind=provider&q=shudder`, { headers: { cookie: adminCookie } })
  ).json()
  assert.deepEqual(service.items, [{ id: 99, name: 'Shudder' }])

  // A broadcaster is still found as a network.
  const broadcaster = await (
    await fetch(`${baseUrl}/search/brands?kind=network&q=abc`, { headers: { cookie: adminCookie } })
  ).json()
  assert.deepEqual(broadcaster.items, [{ id: 2, name: 'ABC' }])

  // Studios are companies, so those come from TMDB's own company search.
  const companies = await (
    await fetch(`${baseUrl}/search/brands?kind=studio&q=shudder`, { headers: { cookie: adminCookie } })
  ).json()
  assert.deepEqual(companies.items, [{ id: 120000, name: 'Shudder Films' }])

  const anonymous = await fetch(`${baseUrl}/search/brands?kind=network&q=shudder`)
  assert.equal(anonymous.status, 401, 'the lookup is not public')

  // A filter picked from a live search comes back ticked and named, so it can
  // be seen and removed again on the next page.
  const chosen = await (await page('/networks?network=2949')).text()
  assert.match(chosen, /name="network" value="2949" checked/)
  assert.match(chosen, /<span>Shudder<\/span>/)
})

test('the networks page opens onto titles and filters from the rail', async () => {
  const index = await (await page('/networks')).text()
  assert.match(index, /class="filter-rail"/)
  assert.match(index, /name="network" value="2"/)
  assert.match(index, /class="media-card"/)
  assert.match(index, /Page 1 of 2/)
  assert.doesNotMatch(index, /class="logo-wall"|class="logo-tile"/)

  const netflix = await (await page('/networks?network=213')).text()
  assert.match(netflix, /class="filter-rail"/)
  assert.match(netflix, /name="network" value="213" checked/)
  assert.match(netflix, /name="genre" value="18"/)
  assert.match(netflix, /name="kind" value="anime"/)
  assert.match(netflix, /name="rating"/)
  assert.match(netflix, /name="votes"/)
  assert.match(netflix, /name="sort"/)
  assert.match(netflix, /brand-logo/)
  assert.match(netflix, /Apply filters/)
  assert.match(netflix, /Page 1 of 2/)

  const combined = await (
    await page(
      '/networks?network=213&network=49&genre=18&genre=10765&rating=7&votes=500&from=2000&to=2020&sort=rating&page=2'
    )
  ).text()
  assert.match(combined, /name="network" value="49" checked/)
  assert.match(combined, /Page 2 of 2/)

  const discover = lastRequest('/3/discover/tv')
  assert.equal(discover.query.with_networks, '213|49')
  assert.equal(discover.query.with_genres, '18,10765')
  assert.equal(discover.query['vote_average.gte'], '7')
  assert.equal(discover.query['vote_count.gte'], '500')
  assert.equal(discover.query['first_air_date.gte'], '2000-01-01')
  assert.equal(discover.query['first_air_date.lte'], '2020-12-31')
  assert.equal(discover.query.sort_by, 'vote_average.desc')
})

test('streaming services filter by provider, not by network', async () => {
  const index = await (await page('/networks')).text()
  assert.match(index, /name="provider" value="8"/)
  assert.doesNotMatch(index, /name="network" value="213"/, 'Netflix is a service, not a network')

  // The printed shortlist is TMDB's own list for the region, in its order: a
  // service the app has never heard of is offered, and a built-in id TMDB did
  // not list is not.
  assert.match(index, /name="provider" value="777"/)
  assert.match(index, /Acme Stream/)
  assert.doesNotMatch(index, /name="provider" value="11"/)

  // The title is named from the provider catalogue, and the query is a provider
  // one: the region is what makes "on Netflix" mean here rather than anywhere.
  const netflix = await (await page('/networks?provider=8')).text()
  assert.match(netflix, /name="provider" value="8" checked/)
  assert.match(netflix, /<h1>Netflix<\/h1>/)

  const streamed = lastRequest('/3/discover/tv')
  assert.equal(streamed.query.with_watch_providers, '8')
  assert.equal(streamed.query.watch_region, 'US')
  assert.equal(streamed.query.with_networks, undefined)

  // A broadcaster and a service narrow together, each on its own field.
  const both = await (await page('/networks?network=2&provider=8')).text()
  assert.match(both, /name="network" value="2" checked/)
  assert.match(both, /name="provider" value="8" checked/)

  const combined = lastRequest('/3/discover/tv')
  assert.equal(combined.query.with_networks, '2')
  assert.equal(combined.query.with_watch_providers, '8')

  // A network search that only matches a service returns it as a provider row,
  // so the old "cannot find it at all" complaint stays fixed either way.
  const found = await (
    await fetch(`${baseUrl}/search/brands?kind=network&q=netflix`, { headers: { cookie: adminCookie } })
  ).json()
  assert.deepEqual(found.items, [{ id: 8, name: 'Netflix', field: 'provider' }])
})

test('films filter by streaming service as well as by studio', async () => {
  const studios = await (await page('/studios')).text()
  assert.match(studios, /Streaming services/)
  assert.match(studios, /name="provider" value="8"/)
  assert.match(studios, /data-brand-remote="\/search\/brands\?kind=provider"/)

  const genres = await (await page('/genres/movie')).text()
  assert.match(genres, /Streaming services/)
  assert.match(genres, /name="provider" value="8"/)

  const netflixFilms = await (await page('/studios?studio=420&provider=8')).text()
  assert.match(netflixFilms, /name="provider" value="8" checked/)
  assert.match(netflixFilms, /<h1>Marvel Studios \+ Netflix<\/h1>/)

  const queried = lastRequest('/3/discover/movie')
  assert.equal(queried.query.with_watch_providers, '8')
  assert.equal(queried.query.watch_region, 'US')
  assert.equal(queried.query.with_companies, '420')
})

test('the regional provider list is cached on disk, so a restart can still name services', async () => {
  // Rendering the panel fetches TMDB's regional list. It has to be kept beside
  // the database like the network export, or a restart while TMDB is down would
  // fall back to the built-in ids and mislabel whatever was chosen.
  await page('/networks')

  const cacheFile = join(dataDir, 'brands', 'providers-US.json')
  assert.ok(existsSync(cacheFile), 'the provider list is written under the data directory')

  const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
  assert.equal(cached.region, 'US')
  assert.ok(cached.items.some((item) => item.name === 'Acme Stream'))

  // A fresh process — a restart — with TMDB unreachable reads that file. Only
  // the cache travels, so the built-in list is the only other answer it could
  // give.
  const readInFreshProcess = async (fetchedAt) => {
    const scratch = mkdtempSync(join(tmpdir(), 'discovarr-providers-'))
    mkdirSync(join(scratch, 'brands'), { recursive: true })
    writeFileSync(join(scratch, 'brands', 'providers-US.json'), JSON.stringify({ ...cached, fetchedAt }))
    const outFile = join(scratch, 'providers.json')

    const probe = `
      import { writeFileSync } from 'node:fs'
      const { streamingProviders } = await import(${JSON.stringify(join(projectRoot, 'src/tmdb.js'))})
      writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(await streamingProviders()))
    `

    const child = spawn(process.execPath, ['--input-type=module', '-e', probe], {
      env: {
        ...process.env,
        DATABASE_FILE: join(scratch, 'db.sqlite'),
        TMDB_API_KEY: 'test-key',
        TMDB_BASE_URL: 'http://127.0.0.1:1/3',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const exitCode = await new Promise((resolve) => child.on('exit', resolve))
    assert.equal(exitCode, 0, `the probe process should read the cache, not crash: ${stderr}`)

    const providers = JSON.parse(readFileSync(outFile, 'utf8'))
    rmSync(scratch, { recursive: true, force: true })
    return providers
  }

  const fresh = await readInFreshProcess(cached.fetchedAt)
  assert.ok(fresh.some((item) => item.name === 'Acme Stream'), 'the cached regional list answers')
  assert.ok(!fresh.some((item) => item.name === 'MUBI'), 'the built-in ids are not used over the cache')

  // Past its refresh window and TMDB still down: the names must come from the
  // file rather than from built-in ids, or a saved filter would be relabelled.
  const stale = await readInFreshProcess(new Date(Date.now() - 30 * 86400000).toISOString())
  assert.ok(stale.some((item) => item.name === 'Acme Stream'), 'a stale cache answers when TMDB is down')
  assert.ok(!stale.some((item) => item.name === 'MUBI'), 'the built-in ids are not used over a stale cache')
})

test('a chosen service is named from the regional list, not a built-in id', async () => {
  // The built-in list calls provider 1899 "Max"; TMDB now lists it as
  // "Max (US)". The tick and the heading have to follow TMDB, or a reused id
  // would put the wrong name on the filter.
  const marked = await (await page('/networks?provider=1899')).text()
  assert.match(marked, /name="provider" value="1899" checked/)
  assert.match(marked, /<h1>Max \(US\)<\/h1>/)
  assert.doesNotMatch(marked, /<h1>Max<\/h1>/)
})

test('the studios page shares the rail and sends studio filters', async () => {
  const index = await (await page('/studios')).text()
  assert.match(index, /class="filter-rail"/)
  assert.match(index, /name="studio" value="420"/)
  assert.match(index, /class="media-card"/)
  assert.doesNotMatch(index, /class="logo-wall"|class="logo-tile"/)

  const single = await (await page('/studios?studio=420')).text()
  assert.match(single, /brand-logo/)
  assert.match(single, /<h1>Marvel Studios<\/h1>/)

  const marvel = await (await page('/studios?studio=420&studio=3&sort=upcoming&genre=28')).text()
  assert.match(marvel, /name="studio" value="420" checked/)
  assert.match(marvel, /name="studio" value="3" checked/)
  assert.match(marvel, /name="genre" value="28" checked/)
  assert.match(marvel, /Page 1 of 2/)

  const discover = lastRequest('/3/discover/movie')
  assert.equal(discover.query.with_companies, '420|3')
  assert.equal(discover.query.with_genres, '28')
  assert.equal(discover.query.sort_by, 'primary_release_date.asc')
  assert.match(discover.query['primary_release_date.gte'], /^\d{4}-\d{2}-\d{2}$/)
})

test('genre pages list titles and combine a multi-select', async () => {
  const index = await (await page('/genres/movie')).text()
  assert.match(index, /class="filter-rail"/)
  assert.match(index, /name="genre" value="28"/)
  assert.match(index, /class="media-card"/)
  assert.doesNotMatch(index, /class="chip-link|class="shelf"/)

  const action = await (await page('/genres/movie?genre=28')).text()
  assert.match(action, /<h1>Action<\/h1>/)
  assert.match(action, /name="genre" value="28" checked/)
  assert.match(action, /Page 1 of 2/)

  const both = await (await page('/genres/movie?genre=28&genre=35')).text()
  assert.match(both, /Action \+ Comedy/)

  assert.ok(
    tmdb.requests.some(
      (request) => request.path === '/3/discover/movie' && request.query.with_genres === '28,35'
    ),
    'a multi-select should ask TMDB for both genres'
  )
})

test('content types cover anime separately from animation', async () => {
  const anime = await (await page('/genres/tv?kind=anime')).text()
  assert.match(anime, /name="kind" value="anime" checked/)
  assert.match(anime, /<h1>Anime<\/h1>/)

  const keyword = lastRequest('/3/discover/tv')
  assert.equal(keyword.query.with_keywords, '210024')
  assert.equal(keyword.query.with_genres, undefined)

  await page('/?type=movie&kind=animation')
  assert.equal(lastRequest('/3/discover/movie').query.with_genres, '16')

  // Reality is a series-only switch, so a film page drops it rather than asking
  // TMDB for a genre that does not exist there.
  const realityOnFilm = await (await page('/?type=movie&kind=reality')).text()
  assert.doesNotMatch(realityOnFilm, /name="kind" value="reality"/)
})

test('a title page links its cast to a person page with their credits', async () => {
  const title = await (await page('/title/movie/999')).text()
  assert.match(title, /class="cast"/)
  assert.match(title, /href="\/person\/77"/)

  const person = await (await page('/person/77')).text()
  assert.match(person, /Ada Actor/)
  assert.match(person, /Known for/)
  assert.match(person, /Born/)
  assert.match(person, /person-bio/)
  assert.match(person, /Leeds, England/)
  assert.match(person, /class="media-card"/)
  assert.match(person, /\/title\/movie\/601/)
  assert.match(person, /\/title\/tv\/602/)
})

test('a series page lists seasons and serves episode detail on demand', async () => {
  const tv = await (await page('/title/tv/999')).text()
  assert.match(tv, /class="detail-backdrop"/)
  assert.match(tv, /name="allSeasons"/)
  assert.match(tv, /data-episodes="\/partial\/tv\/999\/season\/1"/)
  assert.match(tv, /name="season" value="2"/)
  assert.match(tv, /Season 2/)
  assert.match(tv, /class="episode-list"/)

  const episodes = await (await page('/partial/tv/999/season/1')).text()
  assert.match(episodes, /Pilot Episode/)
  assert.match(episodes, /A test begins\./)
  assert.match(episodes, /2021-02-03/)
  assert.match(episodes, /class="episode"/)
})

test('a film collection sits beside the title and requests what is picked', async () => {
  const movie = await (await page('/title/movie/888')).text()
  assert.match(movie, /class="collection-side/)
  assert.match(movie, /Test Collection/)
  assert.match(movie, /class="collection-part"/)
  assert.match(movie, /name="tmdbId" value="889"/)
  // The whole collection is listed; the film on screen is marked, not dropped.
  assert.equal((movie.match(/<li class="collection-part/g) ?? []).length, 2)
  assert.match(movie, /class="collection-part is-current"/)
  assert.match(movie, /This title/)
  // A cast member with no headshot borrows a still from one of their own titles.
  assert.match(movie, /other\.jpg/)

  const response = await fetch(`${baseUrl}/collection/55/request`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'tmdbId=889&returnTo=/title/movie/888',
    redirect: 'manual',
  })
  assert.equal(response.status, 303)

  const detail = await (await page('/title/movie/889')).text()
  assert.match(detail, /Already requested/)
  assert.match(detail, /type="button" disabled/)
  assert.doesNotMatch(detail, /Request movie/)
})

test('a series request covers all seasons or only the ticked ones', async () => {
  const one = await fetch(`${baseUrl}/media/import`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'mediaType=tv&tmdbId=999&seasonsSubmitted=1&season=2&returnTo=/requests',
    redirect: 'manual',
  })
  assert.equal(one.status, 303)

  const requests = await (await page('/requests')).text()
  assert.match(requests, /Season 2/)

  // The picker is gone once the title has an active request.
  const after = await (await page('/title/tv/999')).text()
  assert.match(after, /Already requested/)
  assert.doesNotMatch(after, /name="allSeasons"/)

  // Asking again, even for every season, is refused instead of duplicated.
  const again = await fetch(`${baseUrl}/media/import`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'mediaType=tv&tmdbId=999&allSeasons=on&returnTo=/',
    redirect: 'manual',
  })
  assert.match(again.headers.get('location'), /err=/)
})

test('a request from a card is answered in place, not by the requests page', async () => {
  const post = (body, headers = {}) =>
    fetch(`${baseUrl}/media/import`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
      redirect: 'manual',
    })

  // The page's own script asks for JSON: the card turns into a badge and the
  // grid is not reloaded or left.
  const json = await post('mediaType=movie&tmdbId=500&returnTo=%2Fnetworks%3Fnetwork%3D213', {
    accept: 'application/json',
  })
  assert.equal(json.status, 200)
  assert.deepEqual(await json.json(), { ok: true, notice: 'Request submitted' })

  // A refusal comes back as JSON too, so the dialog can show it and stay open.
  const refused = await fetch(`${baseUrl}/media/999999/request`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'returnTo=%2Fnetworks',
  })
  assert.equal(refused.status, 404)
  assert.deepEqual(await refused.json(), { ok: false, error: 'Title not found' })

  // Without script the same form posts and comes back to the page it came from.
  const form = await post('mediaType=movie&tmdbId=501&returnTo=%2Fnetworks%3Fnetwork%3D213')
  assert.equal(form.status, 303)
  assert.equal(form.headers.get('location'), '/networks?network=213&notice=Request%20submitted')

  // The dialog the script drives, and the count that says the short list is all
  // TMDB has for the brand.
  const networks = await (await page('/networks?network=213')).text()
  assert.match(networks, /id="card-request-dialog"/)
  assert.match(networks, /accept: 'application\/json'/)
  assert.match(networks, /24 in all\./)
})

test('the title page styles carry the backdrop, seasons and collection panel', async () => {
  const css = await (await fetch(`${baseUrl}/styles.css?v=0.10.0`)).text()
  assert.match(css, /\.detail-backdrop \{[^}]*filter: blur\(46px\)/)
  assert.match(css, /\.detail-wrap\.has-collection \{\s*grid-template-columns: minmax\(0, 1fr\) 330px;/)
  assert.match(css, /\.season-block summary \{/)
  assert.match(css, /\.episode-overview \{/)
  assert.match(css, /\.collection-side \{/)
})

test('the collections switch shows the collections themselves', async () => {
  const studios = await (await page('/studios')).text()
  assert.match(studios, /name="collections" value="1"/)
  assert.doesNotMatch(studios, /name="collections" value="1" checked/)

  // Half the stub films belong to a set, and the view reads both result pages so
  // the grid fills up: twelve collections rather than the six on one page.
  const narrowed = await (await page('/studios?collections=1')).text()
  assert.match(narrowed, /name="collections" value="1" checked/)
  assert.match(narrowed, /Only collections that match these filters/)
  assert.match(narrowed, /grouped from the top 24 matches/)
  assert.equal((narrowed.match(/class="media-card collection-card"/g) ?? []).length, 12)
  assert.equal((narrowed.match(/class="media-card/g) ?? []).length, 12)
  assert.match(narrowed, /href="\/collection\/19\d\d"/)
  assert.match(narrowed, /2 films/)
  // The collections view has no pager of its own: it already scanned the pages.
  assert.doesNotMatch(narrowed, /Page \d+ of/)

  // Collections are a film idea, so series pages do not offer the switch.
  const networks = await (await page('/networks?collections=1')).text()
  assert.doesNotMatch(networks, /name="collections"/)
  assert.equal((networks.match(/class="media-card"/g) ?? []).length, 12)
})

test('Discover shows collections too when the switch is on', async () => {
  const html = await (await page('/?type=movie&collections=1')).text()
  assert.match(html, /Only collections that match these filters|collections that match these filters/)
  assert.match(html, /class="media-card collection-card"/)
  assert.match(html, /href="\/collection\//)
})

test('no play buttons appear until the household picks its services', async () => {
  const html = await (await page('/title/movie/999')).text()
  assert.doesNotMatch(html, /btn-watch/)
  // Nothing is asked of JustWatch either: an install that does not use this
  // pays nothing for it.
  assert.equal(jw.requests.length, 0)
})

test('a ticked service plays the title on that service, not a search page', async () => {
  const saved = await fetch(`${baseUrl}/settings`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ['settingsSection', 'general'],
      ['settingsTab', 'general'],
      ['tmdbServicesSubmitted', '1'],
      ['tmdbService', '8'],
      ['tmdbService', '1899'],
      ['tmdbService', '386'],
      ['tmdbService', '99'],
      ['tmdbService', '777'],
    ]).toString(),
  })
  assert.equal(saved.status, 303)

  const html = await (await page('/title/movie/999')).text()
  assert.match(html, /href="https:\/\/www\.netflix\.com\/title\/80100172"/)
  assert.match(html, /href="https:\/\/play\.max\.com\/show\/abc"/)
  assert.match(html, /href="https:\/\/www\.peacocktv\.com\/watch\/asset\/x"/)
  assert.match(html, /Play on Netflix/)
  assert.match(html, /Play on Max/)
  // The rental and the script URL are not subscriptions this household owns.
  assert.doesNotMatch(html, /shudder\.com/)
  assert.doesNotMatch(html, /javascript:/)
  assert.equal((html.match(/class="btn btn-sm btn-watch"/g) ?? []).length, 3)

  // The offer lookup is remembered per title, so a second visit does not ask
  // again.
  const asked = jw.requests.length
  await page('/title/movie/999')
  assert.equal(jw.requests.length, asked)

  // The settings page keeps the ticks, and the hidden flag is what lets the
  // list be cleared again.
  const settings = await (await page('/settings?tab=general')).text()
  assert.match(settings, /name="tmdbService" value="8" checked/)
  assert.match(settings, /name="tmdbService" value="99" checked/)
  assert.match(settings, /name="tmdbServicesSubmitted" value="1"/)

  // The dependency is written down where an administrator will look: the Tasks
  // tab names the catalogue, the cap and the last lookup.
  const tasks = await (await page('/settings?tab=tasks')).text()
  assert.match(tasks, /<th>Play links<\/th>/)
  assert.match(tasks, /5 service\(s\) ticked/)
  assert.match(tasks, /2000 ms cap/)
  assert.match(tasks, /last lookup (ok|failed)/)
})

test('a card carries a play pin for a service the household owns', async () => {
  const html = await (await page('/')).text()
  assert.match(html, /class="watch-pin" href="https:\/\/www\.netflix\.com\/title\/80100172"/)
  // Only the title the catalogue answered for gets a pin: the grid reads the
  // cache, it does not block on every poster.
  assert.equal((html.match(/class="watch-pin"/g) ?? []).length, 1)
})

test('a slow JustWatch cannot hold up a title page', async () => {
  const started = Date.now()
  const html = await (await page('/title/movie/998')).text()
  const elapsed = Date.now() - started

  assert.match(html, /Movie 998/)
  assert.doesNotMatch(html, /btn-watch/)
  assert.ok(elapsed < 3500, `the title page took ${elapsed} ms`)
})
