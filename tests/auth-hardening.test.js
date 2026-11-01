import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const ADMIN = { email: 'admin@discovarr.local', username: 'admin', password: 'correct-horse-battery' }
const RATE_LIMIT = 3

let server
let baseUrl
let dataDir

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
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('server did not become healthy')
}

function postJson(path, body, cookie) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
}

function postForm(path, fields, cookie) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields),
  })
}

function get(path, cookie) {
  return fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  })
}

function sessionCookieOf(response) {
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  assert.ok(raw, 'expected a session cookie')
  return raw.split(';')[0]
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-auth-hardening-'))
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
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_USERNAME: ADMIN.username,
      ADMIN_PASSWORD: ADMIN.password,
      SEED_DEMO_USER: 'false',
      DEMO_AUTO_LOGIN: '',
      // A small budget keeps the test fast; production defaults to 8 per 15 min.
      LOGIN_RATE_LIMIT: String(RATE_LIMIT),
      LOGIN_RATE_WINDOW_MINUTES: '15',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  server.stdout.resume()
  server.stderr.resume()

  await waitForHealth()
})

after(() => {
  server?.kill('SIGTERM')
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('the JSON API counts failed sign-ins and answers 429 once over the limit', async () => {
  const statuses = []
  for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
    const response = await postJson('/api/v1/auth/login', {
      username: ADMIN.username,
      password: 'wrong-password',
    })
    statuses.push(response.status)
  }
  assert.deepEqual(statuses, Array(RATE_LIMIT).fill(401), 'failures under the limit are plain 401s')

  const blocked = await postJson('/api/v1/auth/login', {
    username: ADMIN.username,
    password: 'wrong-password',
  })
  assert.equal(blocked.status, 429, 'the API must not be an unlimited guessing oracle')
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'retry-after tells a client how long to wait')
  assert.match((await blocked.json()).error, /Too many attempts/)

  // The same budget covers the HTML form, so switching endpoints does not
  // reset the count.
  const page = await postForm('/login', { username: ADMIN.username, password: 'wrong-password' })
  assert.equal(page.status, 303)
  assert.match(page.headers.get('location'), /Too%20many%20attempts/)
})

test('a successful sign-in clears the failure budget', async () => {
  const response = await postJson('/api/v1/auth/login', {
    username: ADMIN.username,
    password: ADMIN.password,
  })
  assert.equal(response.status, 200, 'the right password still works while the client is throttled')

  // The counter was reset, so one more failure is a plain 401 again.
  const failure = await postJson('/api/v1/auth/login', {
    username: ADMIN.username,
    password: 'wrong-password',
  })
  assert.equal(failure.status, 401)
})

test('logging out of the API ends the session, so the token cannot be replayed', async () => {
  const login = await postJson('/api/v1/auth/login', {
    username: ADMIN.username,
    password: ADMIN.password,
  })
  assert.equal(login.status, 200)

  const cookie = sessionCookieOf(login)
  const before = await get('/api/v1/auth/me', cookie)
  assert.equal(before.status, 200)

  const logout = await postJson('/api/v1/auth/logout', {}, cookie)
  assert.equal(logout.status, 200)

  const replay = await get('/api/v1/auth/me', cookie)
  assert.equal(replay.status, 401, 'the session row must be gone, not just the cookie')
})

test('Plex sign-in stays off until an administrator turns it on', async () => {
  const loginPage = await get('/login')
  assert.equal(loginPage.status, 200)
  assert.doesNotMatch(await loginPage.text(), /\/auth\/plex/, 'no Plex button on a fresh install')

  const attempt = await get('/auth/plex')
  assert.equal(attempt.status, 303)
  assert.match(attempt.headers.get('location'), /turned%20off/)
})
