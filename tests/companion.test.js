import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

let server
let baseUrl
let dataDir
let adminCookie
let userCookie

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function waitForHealth() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('server did not become healthy')
}

async function call(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

async function login(email, password) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(response.status, 200)
  const cookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  return cookie.split(';')[0]
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-companion-'))
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
      SEED_DEMO_USER: 'true',
      TMDB_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.resume()
  server.stderr.resume()
  await waitForHealth()
  adminCookie = await login('admin@discovarr.local', 'secret123')
  userCookie = await login('sam@discovarr.local', 'sam')
})

after(() => {
  server?.kill()
  rmSync(dataDir, { recursive: true, force: true })
})

test('companion routes require a session', async () => {
  for (const path of ['/api/v1/discover', '/api/v1/watchlist', '/api/v1/calendar', '/api/v1/notifications', '/api/v1/activity']) {
    const { status } = await call(path)
    assert.equal(status, 401, path)
  }
})

test('discover without TMDB is the local catalog, paged, and rejects book', async () => {
  const movies = await call('/api/v1/discover?type=movie', { cookie: userCookie })
  assert.equal(movies.status, 200)
  assert.equal(movies.json.source, 'local')
  assert.ok(movies.json.results.length > 0)
  assert.equal(movies.json.results.every((item) => item.mediaType === 'movie'), true)
  assert.equal(typeof movies.json.results[0].activeRequests, 'number')

  const books = await call('/api/v1/discover?type=book', { cookie: userCookie })
  assert.equal(books.status, 400)
})

test('a title page carries seasons, facts and a request decision', async () => {
  const list = await call('/api/v1/discover?type=tv&q=Severance', { cookie: userCookie })
  const show = list.json.results.find((item) => item.title === 'Severance')
  assert.ok(show?.id)

  const page = await call(`/api/v1/media/${show.id}/page`, { cookie: userCookie })
  assert.equal(page.status, 200)
  // The demo seed already has Sam's request for season 2, so the page must
  // refuse a second one and still say which season that is.
  assert.equal(page.json.canRequest, false)
  assert.match(page.json.blockReason, /Requested/)
  assert.equal(page.json.seasons.find((season) => season.seasonNumber === 2).status, 2)
  assert.equal(page.json.seasons.find((season) => season.seasonNumber === 1).inLibrary, false)
  assert.ok(page.json.facts.some((fact) => fact.label === 'Seasons'))

  const byTmdb = await call(`/api/v1/titles/tv/${show.tmdbId}`, { cookie: userCookie })
  assert.equal(byTmdb.status, 200)
  assert.equal(byTmdb.json.media.id, show.id)
})

test('a series request can name seasons and a movie request can be managed', async () => {
  const shows = await call('/api/v1/discover?type=tv&q=Bear', { cookie: userCookie })
  const show = shows.json.results.find((item) => item.title === 'The Bear')
  const created = await call('/api/v1/request', {
    method: 'POST',
    cookie: userCookie,
    body: { mediaId: show.id, seasons: [1] },
  })
  assert.equal(created.status, 201, created.text)
  assert.deepEqual(created.json.request.seasons, [1])

  const mine = await call('/api/v1/request?filter=pending', { cookie: userCookie })
  assert.ok(mine.json.results.some((request) => request.id === created.json.request.id))

  const forbidden = await call(`/api/v1/request/${created.json.request.id}/approve`, {
    method: 'POST',
    cookie: userCookie,
    body: {},
  })
  assert.equal(forbidden.status, 403)

  const approved = await call(`/api/v1/request/${created.json.request.id}/approve`, {
    method: 'POST',
    cookie: adminCookie,
    body: {},
  })
  assert.equal(approved.status, 200)

  const notes = await call('/api/v1/notifications', { cookie: userCookie })
  assert.equal(notes.status, 200)
  assert.ok(notes.json.unread >= 1)
  assert.ok(notes.json.results.some((item) => item.title.includes('The Bear')))

  const read = await call('/api/v1/notifications/read', { method: 'POST', cookie: userCookie, body: {} })
  assert.equal(read.status, 200)
  assert.equal(read.json.unread, 0)
})

test('watchlist toggle is the same list the page uses', async () => {
  const added = await call('/api/v1/watchlist/toggle', {
    method: 'POST',
    cookie: userCookie,
    body: { tmdbId: 693134, mediaType: 'movie', title: 'Dune: Part Two', releaseDate: '2024-02-27' },
  })
  assert.equal(added.status, 200)
  assert.equal(added.json.added, true)

  const list = await call('/api/v1/watchlist', { cookie: userCookie })
  assert.ok(list.json.results.some((item) => item.tmdbId === 693134 && item.title === 'Dune: Part Two'))

  const removed = await call('/api/v1/watchlist/toggle', {
    method: 'POST',
    cookie: userCookie,
    body: { tmdbId: 693134, mediaType: 'movie', title: 'Dune: Part Two' },
  })
  assert.equal(removed.json.added, false)
  const after = await call('/api/v1/watchlist', { cookie: userCookie })
  assert.equal(after.json.results.some((item) => item.tmdbId === 693134), false)
})

test('calendar only lists library and requested titles in that month', async () => {
  const movies = await call('/api/v1/media?type=movie', { cookie: adminCookie })
  const dune = movies.json.results.find((item) => item.title === 'Dune: Part Two')
  await call(`/api/v1/media/${dune.id}`, { method: 'PATCH', cookie: adminCookie, body: { status: 5 } })

  const month = await call('/api/v1/calendar?month=2024-02', { cookie: userCookie })
  assert.equal(month.status, 200)
  assert.equal(month.json.key, '2024-02')
  const titles = month.json.days.flatMap((day) => day.entries.map((entry) => entry.title))
  assert.ok(titles.includes('Dune: Part Two'))
  assert.equal(month.json.days.every((day) => day.date.startsWith('2024-02')), true)

  const empty = await call('/api/v1/calendar?month=1999-01', { cookie: userCookie })
  assert.equal(empty.json.count, 0)
  assert.equal(empty.json.previous, '1998-12')
  assert.equal(empty.json.next, '1999-02')
})

test('activity, profiles and facets answer without TMDB', async () => {
  const activity = await call('/api/v1/activity', { cookie: userCookie })
  assert.equal(activity.status, 200)
  assert.equal(activity.json.canManage, false)
  assert.ok(Array.isArray(activity.json.waiting))
  assert.deepEqual(activity.json.queue, [])

  const adminActivity = await call('/api/v1/activity', { cookie: adminCookie })
  assert.equal(adminActivity.json.canManage, true)

  const profiles = await call('/api/v1/profiles?mediaType=movie', { cookie: userCookie })
  assert.equal(profiles.status, 200)
  assert.ok(Array.isArray(profiles.json.results))

  const bad = await call('/api/v1/profiles?mediaType=book', { cookie: userCookie })
  assert.equal(bad.status, 400)

  const facets = await call('/api/v1/discover/facets?type=tv', { cookie: userCookie })
  assert.equal(facets.status, 200)
  assert.equal(facets.json.tmdb, false)
  assert.ok(facets.json.networks.length >= 30)
  assert.ok(facets.json.types.some((type) => type.id === 'anime'))
  assert.ok(facets.json.sorts.some((sort) => sort.id === 'popular'))
})

test('recommendations, people and collections say TMDB is required', async () => {
  const recommendations = await call('/api/v1/recommendations', { cookie: userCookie })
  assert.equal(recommendations.status, 200)
  assert.equal(recommendations.json.configured, false)
  assert.deepEqual(recommendations.json.results, [])

  const person = await call('/api/v1/person/123', { cookie: userCookie })
  assert.equal(person.status, 503)

  const collection = await call('/api/v1/collection/10', { cookie: userCookie })
  assert.equal(collection.status, 503)

  const missing = await call('/api/v1/collection/0/request', {
    method: 'POST',
    cookie: userCookie,
    body: { tmdbIds: [] },
  })
  assert.equal(missing.status, 400)
})

test('bulk decline reports each request', async () => {
  const movies = await call('/api/v1/discover?type=movie&q=Arrival', { cookie: userCookie })
  const movie = movies.json.results.find((item) => item.title === 'Arrival')
  const created = await call('/api/v1/request', {
    method: 'POST',
    cookie: userCookie,
    body: { mediaId: movie.id },
  })
  assert.equal(created.status, 201)
  const id = created.json.request.id

  const bulk = await call('/api/v1/request/bulk', {
    method: 'POST',
    cookie: adminCookie,
    body: { action: 'decline', ids: [id, 999999] },
  })
  assert.equal(bulk.status, 200)
  assert.equal(bulk.json.done, 1)
  assert.equal(bulk.json.problems.length, 1)

  const denied = await call('/api/v1/request/bulk', {
    method: 'POST',
    cookie: userCookie,
    body: { action: 'approve', ids: [id] },
  })
  assert.equal(denied.status, 403)
})
