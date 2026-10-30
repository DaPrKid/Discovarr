import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

let tmdb
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
    } else if (url.pathname.startsWith('/3/search/')) {
      body = {
        page: 1,
        total_pages: 1,
        results: [{ id: 500, media_type: 'movie', title: 'Searched title', release_date: '2020-05-05' }],
      }
    } else if (url.pathname.startsWith('/3/discover/')) {
      const number = Number(query.page ?? 1)
      const type = url.pathname.endsWith('/tv') ? 'tv' : 'movie'
      body = {
        page: number,
        total_pages: 2,
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
        credits: {
          cast: [{ id: 77, name: 'Ada Actor', character: 'Lead', profile_path: '/ada.jpg' }],
          crew: [],
        },
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
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('discover fills the grid and pages through trending titles', async () => {
  const first = await (await page('/')).text()
  assert.equal((first.match(/class="media-card"/g) ?? []).length, 20)
  assert.match(first, /Page 1 of 3/)
  assert.match(first, /href="\/\?page=2"/)
  assert.match(first, /class="filter-rail"/)

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
  assert.match(css, /\.logo-wall \{/)
  assert.match(css, /\.filter-rail \{/)
  assert.match(css, /\.toggle input:checked \+ span \{/)
  assert.match(css, /\.person-head \{/)
})

test('networks show a logo wall and a filter panel per network', async () => {
  const index = await (await page('/networks')).text()
  assert.ok((index.match(/class="logo-tile"/g) ?? []).length >= 25, 'the wall should list every network')
  assert.match(index, /\/img\/w154\/network-213\.png/)
  assert.match(index, /Netflix/)
  assert.match(index, /See all →/)

  const netflix = await (await page('/networks?network=213')).text()
  assert.match(netflix, /class="filter-rail"/)
  assert.match(netflix, /name="network" value="213" checked/)
  assert.match(netflix, /name="genre" value="18"/)
  assert.match(netflix, /name="rating"/)
  assert.match(netflix, /name="votes"/)
  assert.match(netflix, /name="sort"/)
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

test('the discover filter panel narrows the grid and switches to discover', async () => {
  const html = await (await page('/?type=movie&genre=28&rating=8')).text()
  assert.match(html, /class="filter-rail"/)
  assert.match(html, /name="genre" value="28" checked/)
  assert.match(html, /name="type" value="movie" checked/)
  assert.match(html, /name="studio"/)
  assert.match(html, /Page 1 of 2/)
  assert.match(html, /class="media-card"/)

  const discover = lastRequest('/3/discover/movie')
  assert.equal(discover.query.with_genres, '28')
  assert.equal(discover.query['vote_average.gte'], '8')
  assert.equal(discover.query.sort_by, 'popularity.desc')
})

test('studios mirror the network page with their own toggles', async () => {
  const index = await (await page('/studios')).text()
  assert.ok((index.match(/class="logo-tile"/g) ?? []).length >= 15)
  assert.match(index, /\/img\/w154\/studio-420\.png/)
  assert.match(index, /Marvel Studios/)

  const marvel = await (await page('/studios?studio=420&studio=3&sort=upcoming&genre=28')).text()
  assert.match(marvel, /class="filter-rail"/)
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
  assert.match(index, /chip-link[^>]*genre=28/)
  assert.match(index, /class="shelf"/)
  assert.match(index, /class="media-card"/)
  assert.match(index, /See all →/)

  const action = await (await page('/genres/movie?genre=28')).text()
  assert.match(action, /<h1>Action<\/h1>/)
  assert.match(action, /class="filter-rail"/)
  assert.match(action, /name="genre" value="28" checked/)
  assert.match(action, /Page 1 of 2/)

  const both = await (await page('/genres/movie?genre=28&genre=35')).text()
  assert.match(both, /Action \+ Comedy/)

  // The genre shelves on the index already cached this query, so look for it
  // among every request rather than only the most recent one.
  assert.ok(
    tmdb.requests.some(
      (request) => request.path === '/3/discover/movie' && request.query.with_genres === '28,35'
    ),
    'a multi-select should ask TMDB for both genres'
  )
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
