import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const API_KEY = 'arr-api-key'
const ARR_ROUTES = {
  '/api/v3/system/status': { version: '5.2.6' },
  '/api/v3/rootfolder': [{ path: '/movies', freeSpace: 900 }],
  '/api/v3/qualityprofile': [
    { id: 4, name: 'HD-1080p' },
    { id: 5, name: 'Ultra-HD' },
  ],
}

let server
let arr
let baseUrl
let dataDir
let adminCookie

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
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

function postForm(path, fields) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminCookie },
    body: new URLSearchParams(fields),
  })
}

async function settings() {
  const response = await fetch(`${baseUrl}/api/v1/settings`, { headers: { cookie: adminCookie } })
  const data = await response.json()
  return { service: data.services.radarr, raw: data.settings }
}

before(async () => {
  // A stand-in Radarr: it answers the three endpoints the app calls and refuses
  // requests without the key, so a missing key fails the test loudly.
  arr = createHttpServer((req, res) => {
    if (req.headers['x-api-key'] !== API_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end('{"message":"unauthorized"}')
    }

    // A dispatch: remember what the app asked Radarr to add.
    if (req.method === 'POST' && req.url === '/api/v3/movie') {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        arr.lastMovie = JSON.parse(raw || '{}')
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 77 }))
      })
      return
    }

    const body = ARR_ROUTES[req.url]
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? {}))
  })

  const arrPort = await freePort()
  await new Promise((resolve) => arr.listen(arrPort, '127.0.0.1', resolve))
  arr.url = `http://127.0.0.1:${arrPort}`

  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-services-test-'))
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
  arr?.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('save and test reaches the service with the stored API key', async () => {
  const response = await postForm('/settings/test/radarr', {
    appName: 'Discovarr',
    radarrEnabled: 'on',
    radarrUrl: arr.url,
    radarrApiKey: API_KEY,
  })
  const html = await response.text()

  // Regression: the key used to be dropped from the service summary, so every
  // call failed with "URL and API key are required" before reaching the service.
  assert.equal(response.status, 200)
  assert.match(html, /Radarr 5\.2\.6 is reachable/)
  assert.doesNotMatch(html, /URL and API key are required/)
})

test('the same click pulls root folders and quality profiles', async () => {
  const html = await (await postForm('/settings/test/radarr', {
    appName: 'Discovarr',
    radarrEnabled: 'on',
    radarrUrl: arr.url,
    radarrApiKey: API_KEY,
  })).text()

  assert.match(html, /1 root folder\(s\) and 2 profile\(s\) loaded/)
  assert.match(html, /data-dialog-open="profile-radarr"/)
  assert.match(html, /Add profile/)
  // The add-profile dialog is filled with what the service reported.
  assert.match(html, /<select name="profileSelect" required>/)
  assert.match(html, /<option value="5\|Ultra-HD">/)
  assert.match(html, /<option value="\/movies">\/movies<\/option>/)

  const { service } = await settings()
  assert.equal(service.rootFolder, '/movies')
  assert.equal(service.qualityProfileId, '4')
  assert.equal(service.qualityProfileName, 'HD-1080p')
})

test('the settings page fills its dropdowns without another click', async () => {
  const html = await (await fetch(`${baseUrl}/settings`, { headers: { cookie: adminCookie } })).text()

  // The stored default is shown as a profile, and the add-profile dialog offers
  // the live quality profiles and root folders from Radarr.
  assert.match(html, /<strong>HD-1080p<\/strong> <span class="badge badge-approved">default<\/span>/)
  assert.match(html, /<option value="4\|HD-1080p">/)
  assert.match(html, /<option value="5\|Ultra-HD">/)
  assert.match(html, /<option value="\/movies">\/movies<\/option>/)
})

test('a post that omits a field keeps what is saved', async () => {
  const before = await settings()
  await postForm('/settings/test/radarr', { appName: 'Discovarr', radarrApiKey: API_KEY, radarrEnabled: 'on' })
  const after = await settings()

  assert.equal(after.raw['services.radarr.url'], before.raw['services.radarr.url'])
  assert.equal(after.raw['services.radarr.apiKey'], API_KEY)
})

test('extra profiles are stored and offered when requesting', async () => {
  await postForm('/settings/test/radarr', {
    appName: 'Discovarr',
    radarrEnabled: 'on',
    radarrUrl: arr.url,
    radarrApiKey: API_KEY,
    radarrRootFolder: '/movies',
    radarrQualityProfile: '4|HD-1080p',
    radarrProfilesSubmitted: '1',
    radarrExtraProfile: '5|Ultra-HD',
  })

  const { service } = await settings()
  assert.deepEqual(service.extraProfiles, [{ id: 5, name: 'Ultra-HD' }])

  const catalog = await (await fetch(`${baseUrl}/api/v1/media`, { headers: { cookie: adminCookie } })).json()
  const movie = (catalog.results ?? []).find((item) => item.mediaType === 'movie')
  if (!movie) return

  const detail = await (await fetch(`${baseUrl}/media/${movie.id}`, { headers: { cookie: adminCookie } })).text()
  assert.match(detail, /name="profile"/)
  assert.match(detail, /Ultra-HD/)
})

test('a named profile carries its own root folder and quality profile', async () => {
  const response = await postForm('/settings/profiles/radarr/add', {
    name: 'Kids HD',
    profileSelect: '5|Ultra-HD',
    rootFolder: '/movies-kids',
    makeDefault: 'on',
  })
  assert.equal(response.status, 303)

  const { service } = await settings()
  const index = service.profiles.findIndex((profile) => profile.name === 'Kids HD')
  assert.ok(index >= 0, 'the new profile should be listed')
  assert.equal(service.profiles[index].rootFolder, '/movies-kids')
  assert.equal(service.profiles[index].isDefault, true)
  // The default is mirrored into the older single-profile settings.
  assert.equal(service.rootFolder, '/movies-kids')
  assert.equal(service.qualityProfileId, '5')

  const page = await (await fetch(`${baseUrl}/settings?tab=integrations`, { headers: { cookie: adminCookie } })).text()
  assert.match(page, /Kids HD/)
  assert.match(page, /\/movies-kids/)

  const catalog = await (await fetch(`${baseUrl}/api/v1/media`, { headers: { cookie: adminCookie } })).json()
  const movie = (catalog.results ?? []).find((item) => item.mediaType === 'movie' && item.status !== 5)
  assert.ok(movie, 'expected a requestable movie in the seeded catalog')

  const created = await (
    await fetch(`${baseUrl}/api/v1/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ mediaId: movie.id, profileIndex: index }),
    })
  ).json()
  assert.equal(created.request.qualityProfileName, 'Kids HD')

  const approved = await (
    await fetch(`${baseUrl}/api/v1/request/${created.request.id}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    })
  ).json()

  assert.equal(approved.request.status, 2, approved.request.note ?? 'approval failed')
  assert.equal(arr.lastMovie.rootFolderPath, '/movies-kids')
  assert.equal(arr.lastMovie.qualityProfileId, 5)
})

test('the title page shows release date, facts and the seasons panel', async () => {
  const catalog = await (await fetch(`${baseUrl}/api/v1/media`, { headers: { cookie: adminCookie } })).json()
  const movie = (catalog.results ?? []).find((item) => item.mediaType === 'movie')
  const series = (catalog.results ?? []).find((item) => item.mediaType === 'tv')

  assert.ok(movie && series, 'the seeded catalog should hold a movie and a series')

  const moviePage = await (await fetch(`${baseUrl}/media/${movie.id}`, { headers: { cookie: adminCookie } })).text()
  assert.match(moviePage, /Release date/)
  assert.match(moviePage, /Runtime/)
  assert.match(moviePage, new RegExp(movie.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const seriesPage = await (await fetch(`${baseUrl}/media/${series.id}`, { headers: { cookie: adminCookie } })).text()
  assert.match(seriesPage, /Episodes/)
  assert.match(seriesPage, /Seasons to request/)
})

test('settings is split into tabs', async () => {
  const get = (tab) => fetch(`${baseUrl}/settings?tab=${tab}`, { headers: { cookie: adminCookie } }).then((r) => r.text())

  const integrations = await get('integrations')
  assert.match(integrations, /TMDB API key/)
  assert.match(integrations, /Radarr profiles/)

  const users = await get('users')
  assert.match(users, /Add a user/)
  assert.doesNotMatch(users, /TMDB API key/)

  const notifications = await get('notifications')
  assert.match(notifications, /Webhook URL/)

  const logs = await get('logs')
  assert.match(logs, /Recent activity/)

  const tasks = await get('tasks')
  assert.match(tasks, /Run a sync now/)
})

test('signing in lands on Discover', async () => {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'secret123', returnTo: '/settings' }),
  })

  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/')
})

test('notification settings survive saving another tab', async () => {
  await postForm('/settings', {
    settingsSection: 'notifications',
    settingsTab: 'notifications',
    webhookUrl: 'https://example.com/hook',
    onRequest: 'on',
  })

  const afterNotifications = await settings()
  assert.equal(afterNotifications.raw['notifications.webhookUrl'], 'https://example.com/hook')
  assert.equal(afterNotifications.raw['notifications.onApproval'], 'false')

  await postForm('/settings', {
    settingsSection: 'integrations',
    settingsTab: 'integrations',
    appName: 'Discovarr',
  })

  const afterIntegrations = await settings()
  assert.equal(afterIntegrations.raw['notifications.webhookUrl'], 'https://example.com/hook')
  assert.equal(afterIntegrations.raw['services.radarr.url'], arr.url)
})
