import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const OWNER = { email: 'owner@example.com', username: 'owner', password: 'ownerpass' }

let server
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

function get(path, cookie) {
  return fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
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

async function apiLogin(body) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  return { status: response.status, response }
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-setup-test-'))
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
      // A fresh install: no bootstrap admin, so /setup owns the first account.
      ADMIN_PASSWORD: '',
      SEED_DEMO_USER: 'false',
      DEMO_AUTO_LOGIN: '',
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

test('a fresh install sends visitors to the setup page', async () => {
  const health = await (await fetch(`${baseUrl}/api/v1/health`)).json()
  assert.equal(health.setupRequired, true)

  for (const path of ['/', '/requests', '/account']) {
    const response = await get(path)
    assert.equal(response.status, 303, `${path} should redirect`)
    assert.equal(response.headers.get('location'), '/setup')
  }

  const login = await get('/login')
  assert.equal(login.status, 303)
  assert.equal(login.headers.get('location'), '/setup')

  const page = await get('/setup')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Create administrator/)
})

test('setup rejects an invalid account before creating anything', async () => {
  const response = await postForm('/setup', { email: 'owner@example.com', username: 'owner', password: 'short' })
  assert.equal(response.status, 400)
  assert.match(await response.text(), /at least 6 characters/)

  const health = await (await fetch(`${baseUrl}/api/v1/health`)).json()
  assert.equal(health.setupRequired, true)
})

test('the first signup becomes an authenticated administrator', async () => {
  const response = await postForm('/setup', OWNER)
  assert.equal(response.status, 303)
  assert.match(response.headers.get('location'), /^\/\?notice=/)

  adminCookie = (response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')).split(';')[0]

  const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: adminCookie } })
  const { user } = await me.json()
  assert.equal(user.role, 'admin')
  assert.equal(user.username, 'owner')
  assert.equal(user.email, 'owner@example.com')
})

test('setup is closed once an account exists', async () => {
  const page = await get('/setup')
  assert.equal(page.status, 303)
  assert.equal(page.headers.get('location'), '/login')

  const response = await postForm('/setup', { email: 'second@example.com', username: 'second', password: 'secondpass' })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/login')
})

test('sign-in accepts the username, the email, and rejects a bad password', async () => {
  const byUsername = await apiLogin({ username: OWNER.username, password: OWNER.password })
  assert.equal(byUsername.status, 200)

  const byEmail = await apiLogin({ username: OWNER.email, password: OWNER.password })
  assert.equal(byEmail.status, 200)

  const wrong = await apiLogin({ username: OWNER.username, password: 'nope' })
  assert.equal(wrong.status, 401)

  const unknown = await apiLogin({ username: 'nobody', password: OWNER.password })
  assert.equal(unknown.status, 401)
})

test('usernames are unique regardless of case', async () => {
  const duplicate = await postForm(
    '/settings/users',
    { email: 'other@example.com', username: 'OWNER', password: 'otherpass', role: 'user' },
    adminCookie
  )
  assert.equal(duplicate.status, 303)
  assert.match(decodeURIComponent(duplicate.headers.get('location')), /That username is taken/)

  const created = await postForm(
    '/settings/users',
    { email: 'other@example.com', username: 'other', password: 'otherpass', role: 'user' },
    adminCookie
  )
  assert.equal(created.status, 303)
  assert.match(decodeURIComponent(created.headers.get('location')), /Created user other/)
})
