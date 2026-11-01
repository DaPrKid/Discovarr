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
    } else if (url.pathname === '/3/movie/888/videos') {
      body = { results: [{ key: 'abc123', site: 'YouTube', type: 'Trailer', name: 'Official Trailer' }] }
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

test('the calendar lists requested titles in a month grid, and only those', async () => {
  const request = await postForm('/media/import', { tmdbId: '901', mediaType: 'movie', returnTo: '/' })
  assert.equal(request.status, 303)

  const response = await get('/calendar?month=2026-11')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /Calendar/)
  assert.match(html, /Coming Movie/)
  assert.match(html, /November 2026/)
  assert.match(html, /cal-cell/)
  assert.match(html, /cal-grid/)
  assert.match(html, /data-preview/)
  assert.match(html, /title=\"Coming Movie · Film\"/)

  // Nothing is on the calendar just because TMDB lists it: a title nobody has
  // asked for and the library does not hold stays out.
  assert.doesNotMatch(html, /Later Movie/)
  assert.doesNotMatch(html, /Coming Series/)
})

test('the hover preview endpoint answers with a title summary', async () => {
  const response = await get('/preview/movie/901')
  assert.equal(response.status, 200)

  const data = await response.json()
  assert.equal(data.title, 'Coming Movie')
  assert.match(data.meta, /Film/)
  assert.equal(typeof data.overview, 'string')

  assert.equal((await get('/preview/series/901')).status, 400)
  assert.equal((await fetch(`${baseUrl}/preview/movie/901`)).status, 401)
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

test('a title page links to its trailer', async () => {
  const html = await (await get('/title/movie/888')).text()

  assert.match(html, /Watch trailer/)
  assert.match(html, /youtube\.com\/watch\?v=abc123/)
})

test('an API token authenticates the API and can be revoked', async () => {
  const created = await postForm('/settings/tokens', { name: 'Home Assistant' })
  assert.equal(created.status, 200)

  const html = await created.text()
  const token = /New token, shown once: <code>(dcv_[^<]+)<\/code>/.exec(html)?.[1]
  assert.ok(token, 'the new token was not shown once')
  assert.match(html, /Home Assistant/)

  const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).user.username, 'owner')

  const id = /action="\/settings\/tokens\/(\d+)\/delete"/.exec(html)?.[1]
  assert.ok(id, 'the token row has no revoke button')

  const revoke = await postForm(`/settings/tokens/${id}/delete`, {})
  assert.equal(revoke.status, 303)

  const after = await fetch(`${baseUrl}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(after.status, 401)
})

test('the activity page lists the retry queue and the download queue', async () => {
  const response = await get('/activity')
  assert.equal(response.status, 200)

  const html = await response.text()
  assert.match(html, /Activity/)
  assert.match(html, /Waiting for another attempt/)
  assert.match(html, /Gave up/)
  assert.match(html, /Nothing is waiting to be retried/) // nothing has failed in this run
})

test('the database can be downloaded as a real SQLite file', async () => {
  const response = await get('/settings/backup')
  assert.equal(response.status, 200)
  assert.match(String(response.headers.get('content-type')), /sqlite3/)
  assert.match(String(response.headers.get('content-disposition')), /attachment; filename="discovarr-\d{4}-\d{2}-\d{2}\.sqlite"/)

  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.subarray(0, 15).toString('utf8'), 'SQLite format 3')
  assert.ok(bytes.length > 4096, 'the snapshot looks empty')
})

test('the release calendar can be subscribed to with a scoped token', async () => {
  // An account-wide token in a URL leaks API access through logs and history, so
  // the feed only accepts a token minted for the feed itself.
  const apiToken = await postForm('/settings/tokens', { name: 'Scripts' })
  const apiHtml = await apiToken.text()
  const api = /New token, shown once: <code>(dcv_[^<]+)<\/code>/.exec(apiHtml)?.[1]
  assert.ok(api, 'no API token was issued')

  const rejected = await fetch(`${baseUrl}/calendar.ics?token=${encodeURIComponent(api)}`)
  assert.equal(rejected.status, 401, 'an API token must not authenticate the feed')

  const created = await postForm('/settings/tokens', { name: 'Calendar', scope: 'calendar' })
  const html = await created.text()
  const token = /calendar\.ics\?token=(dcv_[^<]+)/.exec(html)?.[1]
  assert.ok(token, 'no calendar token was issued for the feed')

  const viaApi = await fetch(`${baseUrl}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(viaApi.status, 401, 'a feed token must not authenticate the API')

  const feed = await fetch(`${baseUrl}/calendar.ics?token=${encodeURIComponent(token)}`)
  assert.equal(feed.status, 200)
  assert.match(String(feed.headers.get('content-type')), /text\/calendar/)

  const body = await feed.text()
  assert.match(body, /BEGIN:VCALENDAR/)
  assert.match(body, /BEGIN:VEVENT/)
  assert.match(body, /SUMMARY:Coming Movie/)
  assert.match(body, /DTSTART;VALUE=DATE:20261105/)
  assert.match(body, /END:VCALENDAR/)

  const anonymous = await fetch(`${baseUrl}/calendar.ics`)
  assert.equal(anonymous.status, 401)
})

test('a wrong token is refused', async () => {
  const response = await fetch(`${baseUrl}/api/v1/auth/me`, {
    headers: { authorization: 'Bearer dcv_not-a-real-token' },
  })
  assert.equal(response.status, 401)
})
