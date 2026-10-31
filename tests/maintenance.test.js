import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

let server
let dataDir
let imageDir
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
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-maintenance-'))
  imageDir = join(dataDir, 'images')
  mkdirSync(join(imageDir, 'w342'), { recursive: true })

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_FILE: join(dataDir, 'discovarr.db'),
      IMAGE_CACHE_DIR: imageDir,
      ADMIN_PASSWORD: 'maintenancepass',
      ADMIN_EMAIL: 'owner@example.com',
      ADMIN_USERNAME: 'owner',
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
    body: JSON.stringify({ username: 'owner', password: 'maintenancepass' }),
  })

  assert.equal(login.status, 200)
  cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie.startsWith('discovarr_session='))
})

after(() => {
  server?.kill()
  rmSync(dataDir, { recursive: true, force: true })
})

test('the tasks tab shows diagnostics, cache limits and backup', async () => {
  const response = await get('/settings?tab=tasks')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /Diagnostics/)
  assert.match(html, /Artwork cache/)
  assert.match(html, /Download settings/)
  assert.match(html, /Prune cache/)
  assert.match(html, /Maximum size \(MB/)
  assert.match(html, /Version<\/th><td>\d+\.\d+\.\d+/)
  assert.match(html, /Requests<\/th><td>/)
})

test('settings export leaves secrets blank unless asked for them', async () => {
  await postForm('/settings?tab=integrations', {
    settingsSection: 'integrations',
    settingsTab: 'integrations',
    appName: 'Discovarr',
    tmdbApiKey: 'secret-tmdb-key',
  })

  const redacted = await get('/settings/export')
  assert.equal(redacted.status, 200)
  assert.match(String(redacted.headers.get('content-disposition')), /discovarr-settings\.json/)
  const payload = await redacted.json()
  assert.equal(payload.app, 'discovarr')
  assert.equal(payload.settings['app.name'], 'Discovarr')
  assert.equal(payload.settings['tmdb.apiKey'], '')

  const full = await (await get('/settings/export?secrets=1')).json()
  assert.equal(full.settings['tmdb.apiKey'], 'secret-tmdb-key')
})

test('importing a settings file applies known keys and ignores the rest', async () => {
  const response = await postForm('/settings/import', {
    payload: JSON.stringify({
      app: 'discovarr',
      settings: {
        'app.name': 'Living Room',
        'tmdb.apiKey': '',
        'cache.maxMb': '250',
        'not.a.setting': 'ignored',
      },
    }),
  })

  assert.equal(response.status, 303)
  // Three keys in, two applied: the blank secret is skipped rather than wiping
  // the key that is already stored.
  assert.match(String(response.headers.get('location')), /Imported%202%20setting|Imported 2 setting/)

  const page = await (await get('/settings?tab=tasks')).text()
  assert.match(page, /Root folder|Diagnostics/)

  const brand = await (await get('/')).text()
  assert.match(brand, /Living Room/)

  const settings = await (await get('/settings/export?secrets=1')).json()
  assert.equal(settings.settings['app.name'], 'Living Room')
  assert.equal(settings.settings['cache.maxMb'], '250')
  assert.equal('not.a.setting' in settings.settings, false)
  // A blank secret in the file never clears the key already saved.
  assert.equal(settings.settings['tmdb.apiKey'], 'secret-tmdb-key')
})

test('a bad import is refused with a readable error', async () => {
  const response = await postForm('/settings/import', { payload: 'not json at all' })
  assert.equal(response.status, 303)
  const location = String(response.headers.get('location'))
  assert.match(location, /err=/)

  // follow the redirect
  const html = await (await get(location.replace(baseUrl, ''))).text()
  assert.match(html, /valid JSON/)
})

test('pruning the cache removes the oldest images past the size limit', async () => {
  const older = join(imageDir, 'w342', 'older.jpg')
  const newer = join(imageDir, 'w342', 'newer.jpg')

  writeFileSync(older, Buffer.alloc(700 * 1024))
  writeFileSync(newer, Buffer.alloc(700 * 1024))
  utimesSync(older, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))

  // 1 MB cap over 1.4 MB of files: the older one goes, the newer one stays.
  await postForm('/settings', {
    settingsSection: 'cache',
    settingsTab: 'tasks',
    cacheMaxMb: '1',
    cacheMaxAgeDays: '0',
  })

  const response = await postForm('/settings/cache/prune', {})
  assert.equal(response.status, 303)
  assert.match(String(response.headers.get('location')), /notice=/)

  assert.equal(existsSync(older), false)
  assert.equal(existsSync(newer), true)
})

test('sync backoff doubles, then caps at half an hour', async () => {
  const previous = process.env.DATABASE_FILE
  process.env.DATABASE_FILE = join(dataDir, 'backoff.db')
  try {
    const { backoffDelayMs } = await import('../src/sync.js')
    assert.equal(backoffDelayMs(0), 120_000)
    assert.equal(backoffDelayMs(1), 120_000)
    assert.equal(backoffDelayMs(2), 240_000)
    assert.equal(backoffDelayMs(3), 480_000)
    assert.equal(backoffDelayMs(12), 1_800_000)
  } finally {
    process.env.DATABASE_FILE = previous
  }
})
