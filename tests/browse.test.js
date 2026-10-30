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

  const second = await (await page('/?page=2')).text()
  assert.match(second, /Trending 2-0/)
  assert.match(second, /Page 2 of 3/)
  assert.equal(lastRequest('/3/trending/all/week').query.page, '2')
})

test('the stylesheet keeps the wide sidebar and the dense grid', async () => {
  const css = await (await fetch(`${baseUrl}/styles.css?v=0.7.0`)).text()
  assert.match(css, /\.browse-nav \{[\s\S]*?padding: 16px 14px 18px;/)
  assert.match(css, /\.discover \{[\s\S]*?grid-template-columns: 252px minmax\(0, 1fr\);/)
  assert.match(css, /minmax\(128px, 1fr\)/)
  assert.match(css, /\.logo-wall \{/)
  assert.match(css, /\.filter-pill\.is-active \{/)
})

test('networks show a logo wall and every network opens its own filtered page', async () => {
  const index = await (await page('/networks')).text()
  assert.ok((index.match(/class="logo-tile"/g) ?? []).length >= 25, 'the wall should list every network')
  assert.match(index, /\/img\/w154\/network-213\.png/)
  assert.match(index, /Netflix/)
  assert.match(index, /Popular on each network/)
  assert.match(index, /See all →/)

  const netflix = await (await page('/networks?network=213')).text()
  assert.match(netflix, /brand-logo/)
  assert.match(netflix, /\/img\/w154\/network-213\.png/)
  assert.match(netflix, /filter-pill is-active[^>]*>Popular</)
  assert.match(netflix, /Recently released/)
  assert.match(netflix, /Upcoming/)
  assert.match(netflix, /chip-link chip-sm/)
  assert.match(netflix, /All genres/)
  assert.match(netflix, /Page 1 of 2/)

  const filtered = await (
    await page('/networks?network=213&sort=upcoming&genre=18&page=2')
  ).text()
  assert.match(filtered, /filter-pill is-active[^>]*>Upcoming</)
  assert.match(filtered, /Page 2 of 2/)

  const discover = lastRequest('/3/discover/tv')
  assert.equal(discover.query.with_networks, '213')
  assert.equal(discover.query.with_genres, '18')
  assert.equal(discover.query.sort_by, 'first_air_date.asc')
  assert.equal(discover.query.page, '2')
  assert.match(discover.query['first_air_date.gte'], /^\d{4}-\d{2}-\d{2}$/)
})

test('studios mirror the network page with their own logos and genres', async () => {
  const index = await (await page('/studios')).text()
  assert.ok((index.match(/class="logo-tile"/g) ?? []).length >= 15)
  assert.match(index, /\/img\/w154\/studio-420\.png/)
  assert.match(index, /Marvel Studios/)
  assert.match(index, /Popular from each studio/)

  const marvel = await (await page('/studios?studio=420&sort=new&genre=28')).text()
  assert.match(marvel, /brand-logo/)
  assert.match(marvel, /filter-pill is-active[^>]*>Recently released</)
  assert.match(marvel, /Action/)
  assert.match(marvel, /Page 1 of 2/)

  const discover = lastRequest('/3/discover/movie')
  assert.equal(discover.query.with_companies, '420')
  assert.equal(discover.query.with_genres, '28')
  assert.equal(discover.query.sort_by, 'primary_release_date.desc')
  assert.match(discover.query['primary_release_date.lte'], /^\d{4}-\d{2}-\d{2}$/)
})

test('genre pages list titles and open a single genre', async () => {
  const index = await (await page('/genres/movie')).text()
  assert.match(index, /chip-link[^>]*genre=28/)
  assert.match(index, /class="shelf"/)
  assert.match(index, /class="media-card"/)
  assert.match(index, /See all →/)

  const action = await (await page('/genres/movie?genre=28'))
  const html = await action.text()
  assert.match(html, /<h1>Action<\/h1>/)
  assert.match(html, /filter-pill is-active[^>]*>Popular</)
  assert.match(html, /Page 1 of 2/)
  // The genre shelves on the index already cached this query, so look for it
  // among every request rather than only the most recent one.
  assert.ok(
    tmdb.requests.some((request) => request.path === '/3/discover/movie' && request.query.with_genres === '28'),
    'the genre page should ask TMDB for that genre'
  )
})
