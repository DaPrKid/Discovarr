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
  assert.match(html, /<select name="radarrRootFolder">/)
  assert.match(html, /Ultra-HD/)
  assert.match(html, /name="radarrExtraProfile"/)

  const { service } = await settings()
  assert.equal(service.rootFolder, '/movies')
  assert.equal(service.qualityProfileId, '4')
  assert.equal(service.qualityProfileName, 'HD-1080p')
})

test('the settings page fills its dropdowns without another click', async () => {
  const html = await (await fetch(`${baseUrl}/settings`, { headers: { cookie: adminCookie } })).text()
  assert.match(html, /<select name="radarrRootFolder">/)
  assert.match(html, /Ultra-HD/)
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
  assert.match(detail, /name="qualityProfile"/)
  assert.match(detail, /Ultra-HD/)
})
