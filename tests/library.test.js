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
let cookie

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
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('server did not become healthy')
}

function get(path) {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' })
}

function postForm(path, fields) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}

before(async () => {
  tmdb = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let body = null

    if (url.pathname === '/3/discover/movie') {
      body = {
        results: [
          { id: 901, title: 'Coming Movie', release_date: '2026-11-05', poster_path: '/a.jpg' },
          { id: 902, title: 'Later Movie', release_date: '2026-11-20', poster_path: '/b.jpg' },
        ],
      }
    } else if (url.pathname === '/3/discover/tv') {
      body = { results: [{ id: 903, name: 'Coming Series', first_air_date: '2026-11-10' }] }
    } else if (url.pathname === '/3/movie/888') {
      body = {
        id: 888,
        title: 'Collection Film',
        overview: 'One part of a pair.',
        release_date: '2019-01-01',
        belongs_to_collection: { id: 55, name: 'Test Collection' },
        credits: { cast: [], crew: [] },
      }
    } else if (url.pathname === '/3/collection/55') {
      body = {
        id: 55,
        name: 'Test Collection',
        parts: [
          { id: 888, title: 'Collection Film', release_date: '2019-01-01', poster_path: '/one.jpg' },
          { id: 889, title: 'Collection Film Two', release_date: '2021-06-01', poster_path: '/two.jpg' },
        ],
      }
    } else if (url.pathname === '/3/movie/901' || url.pathname === '/3/movie/902') {
      body = { id: Number(url.pathname.split('/').pop()), title: 'Coming Movie', release_date: '2026-11-05' }
    } else {
      body = { results: [] }
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  await new Promise((resolve) => tmdb.listen(0, '127.0.0.1', resolve))
  const tmdbPort = tmdb.address().port

  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-library-'))
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_FILE: join(dataDir, 'discovarr.db'),
      IMAGE_CACHE_DIR: join(dataDir, 'images'),
      ADMIN_PASSWORD: 'librarypass',
      ADMIN_EMAIL: 'owner@example.com',
      ADMIN_USERNAME: 'owner',
      TMDB_API_KEY: 'test-key',
      TMDB_BASE_URL: `http://127.0.0.1:${tmdbPort}/3`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  server.stderr.on('data', (chunk) => {
    if (process.env.DEBUG_TESTS) process.stderr.write(chunk)
  })

  await waitForHealth()

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'librarypass' }),
  })

  assert.equal(login.status, 200)
  cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0]
})

after(() => {
  server?.kill()
  tmdb?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a title can be saved to and removed from the watchlist', async () => {
  const save = await postForm('/watchlist/toggle', {
    tmdbId: '888',
    mediaType: 'movie',
    title: 'Collection Film',
    releaseDate: '2019-01-01',
    returnTo: '/title/movie/888',
  })

  assert.equal(save.status, 303)
  assert.match(String(save.headers.get('location')), /notice=/)

  const page = await (await get('/watchlist')).text()
  assert.match(page, /Collection Film/)
  assert.match(page, /Remove/)
  assert.match(page, /Watchlist/)

  const remove = await postForm('/watchlist/toggle', {
    tmdbId: '888',
    mediaType: 'movie',
    title: 'Collection Film',
    returnTo: '/watchlist',
  })
  assert.equal(remove.status, 303)

  assert.doesNotMatch(await (await get('/watchlist')).text(), /Collection Film/)
})

test('the title page offers the watchlist toggle', async () => {
  const html = await (await get('/title/movie/888')).text()

  assert.match(html, /action="\/watchlist\/toggle"/)
  assert.match(html, /Save to your watchlist|Save to watchlist/)
  assert.match(html, /All 2 films in Test Collection/)
})

test('the calendar lists upcoming films and series by release date', async () => {
  const response = await get('/calendar')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /Calendar/)
  assert.match(html, /Coming Movie/)
  assert.match(html, /Coming Series/)
  assert.match(html, /Later Movie/)
  assert.match(html, /calendar-day/)
})

test('the collection page ticks only the films that are missing', async () => {
  const response = await get('/collection/55')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /Test Collection/)
  assert.match(html, /Collection Film Two/)
  assert.match(html, /action="\/collection\/55\/request"/)
  assert.match(html, /name="tmdbId" value="889"/)
  assert.match(html, /2 film\(s\)/)
})
