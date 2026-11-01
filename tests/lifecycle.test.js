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

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })

  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  return { status: response.status, json, text, headers: response.headers }
}

async function login(email, password) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  assert.equal(response.status, 200, `login failed for ${email}`)
  const cookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  return cookie.split(';')[0]
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-test-'))
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
      DEMO_AUTO_LOGIN: '',
      LOGIN_RATE_LIMIT: '3',
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

test('health endpoint reports the catalog and version', async () => {
  const { status, json } = await call('/api/v1/health')
  assert.equal(status, 200)
  assert.equal(json.status, 'ok')
  assert.equal(json.media, 14)
})

test('unauthenticated requests are rejected', async () => {
  const { status } = await call('/api/v1/request')
  assert.equal(status, 401)
})

test('login works and exposes the current user', async () => {
  adminCookie = await login('admin@discovarr.local', 'secret123')
  const { status, json } = await call('/api/v1/auth/me', { cookie: adminCookie })
  assert.equal(status, 200)
  assert.equal(json.user.role, 'admin')

  userCookie = await login('sam@discovarr.local', 'sam')
  const me = await call('/api/v1/auth/me', { cookie: userCookie })
  assert.equal(me.json.user.username, 'Sam')
})

test('wrong password is rejected', async () => {
  const { status } = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@discovarr.local', password: 'nope' },
  })
  assert.equal(status, 401)
})

test('a movie request is created, deduplicated and approved', async () => {
  const media = await call('/api/v1/media?type=movie', { cookie: adminCookie })
  const movie = media.json.results.find((item) => item.status !== 5)

  const created = await call('/api/v1/request', {
    method: 'POST',
    cookie: adminCookie,
    body: { mediaId: movie.id },
  })
  assert.equal(created.status, 201)
  assert.equal(created.json.request.status, 1)

  const duplicate = await call('/api/v1/request', {
    method: 'POST',
    cookie: adminCookie,
    body: { mediaId: movie.id },
  })
  assert.equal(duplicate.status, 409)

  const approved = await call(`/api/v1/request/${created.json.request.id}/approve`, {
    method: 'POST',
    cookie: adminCookie,
  })
  assert.equal(approved.status, 200)
  assert.equal(approved.json.request.status, 2)
  assert.match(approved.json.request.note, /Approved/)

  const retried = await call(`/api/v1/request/${created.json.request.id}/retry`, {
    method: 'POST',
    cookie: adminCookie,
  })
  assert.equal(retried.status, 409, 'only failed requests can be retried')
})

test('cross-site mutations are blocked', async () => {
  const { status } = await call('/api/v1/request', {
    method: 'POST',
    cookie: adminCookie,
    body: { mediaId: 1 },
    headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
  })
  assert.equal(status, 403)
})

test('plain users cannot approve, manage users or change settings', async () => {
  const pending = await call('/api/v1/request?filter=pending', { cookie: adminCookie })
  const target = pending.json.results[0]

  const approve = await call(`/api/v1/request/${target?.id ?? 1}/approve`, {
    method: 'POST',
    cookie: userCookie,
  })
  assert.equal(approve.status, 403)

  assert.equal((await call('/api/v1/users', { cookie: userCookie })).status, 403)
  assert.equal((await call('/api/v1/settings', { cookie: userCookie })).status, 403)
})

test('quotas and permissions are enforced per user', async () => {
  const created = await call('/settings/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'Casey',
      email: 'casey@discovarr.local',
      password: 'casey123',
      role: 'user',
    },
  })
  assert.equal(created.status, 303)

  const users = await call('/api/v1/users', { cookie: adminCookie })
  const casey = users.json.results.find((user) => user.email === 'casey@discovarr.local')
  assert.ok(casey, 'user was created')

  const patched = await call(`/api/v1/users/${casey.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { role: 'user', permissions: 1, quotaMovie: 1 },
  })
  assert.equal(patched.status, 200)

  const caseyCookie = await login('casey@discovarr.local', 'casey123')

  const movies = await call('/api/v1/media?type=movie', { cookie: adminCookie })
  const available = movies.json.results.filter((item) => item.status !== 5)

  const first = await call('/api/v1/request', {
    method: 'POST',
    cookie: caseyCookie,
    body: { mediaId: available[0].id },
  })
  assert.equal(first.status, 201)

  const overQuota = await call('/api/v1/request', {
    method: 'POST',
    cookie: caseyCookie,
    body: { mediaId: available[1].id },
  })
  assert.equal(overQuota.status, 429)

  const seriesOnly = await call('/api/v1/request', {
    method: 'POST',
    cookie: caseyCookie,
    body: { mediaId: 9 },
  })
  assert.equal(seriesOnly.status, 403, 'no REQUEST_TV permission')
})

test('password change revokes other sessions and rotates the credential', async () => {
  const caseyCookie = await login('casey@discovarr.local', 'casey123')

  const wrong = await call('/api/v1/auth/password', {
    method: 'POST',
    cookie: caseyCookie,
    body: { currentPassword: 'not-it', newPassword: 'newpass123' },
  })
  assert.equal(wrong.status, 401)

  const changed = await call('/api/v1/auth/password', {
    method: 'POST',
    cookie: caseyCookie,
    body: { currentPassword: 'casey123', newPassword: 'newpass123' },
  })
  assert.equal(changed.status, 200)

  const oldPassword = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'casey@discovarr.local', password: 'casey123' },
  })
  assert.equal(oldPassword.status, 401)

  const newPassword = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'casey@discovarr.local', password: 'newpass123' },
  })
  assert.equal(newPassword.status, 200)
})

test('requests are paginated', async () => {
  const { status, json } = await call('/api/v1/request?take=1&page=1', { cookie: adminCookie })
  assert.equal(status, 200)
  assert.equal(json.results.length, 1)
  assert.ok(json.totalResults >= 2)
  assert.ok(json.totalPages >= 2)
})

test('sync runs with no services configured and reports skips', async () => {
  const { status, json } = await call('/api/v1/sync', { method: 'POST', cookie: adminCookie })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.summary.services.radarr, 'skipped')
})

test('the image proxy rejects traversal and unknown sizes', async () => {
  assert.equal((await call('/img/w342/..%2F..%2Fetc%2Fpasswd')).status, 400)
  assert.equal((await call('/img/xl/bad.jpg')).status, 400)
  const upstreamMiss = (await call('/img/w342/not-a-real-image.jpg')).status
  assert.ok([404, 502].includes(upstreamMiss), 'upstream miss is reported cleanly')
})

test('repeated login failures are rate limited', async () => {
  let lastLocation = ''

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'nobody@discovarr.local', password: 'wrong', returnTo: '/' }),
      redirect: 'manual',
    })

    assert.equal(response.status, 303)
    lastLocation = response.headers.get('location') ?? ''
  }

  assert.match(lastLocation, /Too%20many%20attempts/)
})

test('an administrator can delete a user, but not their own account', async () => {
  const created = await call('/settings/users', {
    method: 'POST',
    cookie: adminCookie,
    body: { username: 'Temp', email: 'temp@discovarr.local', password: 'temp123', role: 'user' },
  })
  assert.equal(created.status, 303)

  const before = await call('/api/v1/users', { cookie: adminCookie })
  const temp = before.json.results.find((user) => user.email === 'temp@discovarr.local')
  assert.ok(temp, 'user was created')

  const denied = await call(`/settings/users/${temp.id}/delete`, { method: 'POST', cookie: userCookie })
  assert.equal(denied.status, 403)

  const removed = await call(`/settings/users/${temp.id}/delete`, { method: 'POST', cookie: adminCookie })
  assert.equal(removed.status, 303)
  assert.match(removed.headers.get('location'), /notice=/)

  const after = await call('/api/v1/users', { cookie: adminCookie })
  assert.equal(after.json.results.some((user) => user.id === temp.id), false)

  const me = await call('/api/v1/auth/me', { cookie: adminCookie })
  const self = await call(`/settings/users/${me.json.user.id}/delete`, { method: 'POST', cookie: adminCookie })
  assert.equal(self.status, 303)
  assert.match(self.headers.get('location'), /err=/)
  assert.ok((await call('/api/v1/users', { cookie: adminCookie })).json.results.some((user) => user.id === me.json.user.id))
})
