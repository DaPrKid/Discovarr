import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createProbe } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const PROFILES = [
  { id: 1, uuid: 'owner-uuid', title: 'Owner', admin: true },
  { id: 2, uuid: 'sam-uuid', title: 'Sam', admin: false },
  { id: 3, uuid: 'kids-uuid', title: 'Kids', admin: false, protected: true },
]

let stub
let server
let baseUrl
let dataDir
let stubUrl

function freePort() {
  return new Promise((resolve) => {
    const probe = createProbe()
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

function cookiesOf(response) {
  return response.headers.getSetCookie?.() ?? []
}

function cookieValue(response, name) {
  const match = cookiesOf(response).find((entry) => entry.startsWith(`${name}=`))
  if (!match) return null
  return match.slice(name.length + 1).split(';')[0]
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

/** Runs the plex.tv round trip far enough to hold a profile token. */
async function profilePickerCookie() {
  const start = await get('/auth/plex')
  assert.equal(start.status, 303)
  const pin = cookieValue(start, 'discovarr_plex_pin')
  const callback = await get('/auth/plex/callback', `discovarr_plex_pin=${pin}`)

  assert.equal(callback.status, 200)
  return { html: await callback.text(), token: cookieValue(callback, 'discovarr_plex_token') }
}

before(async () => {
  stub = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const token = String(req.headers['x-plex-token'] ?? '')
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'POST' && url.pathname === '/api/v2/pins') {
      return json(201, { id: 4242, code: 'plex-code' })
    }
    if (url.pathname === '/api/v2/pins/4242') {
      return json(200, { id: 4242, authToken: 'owner-token' })
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/home/users') {
      return json(200, { users: PROFILES })
    }

    const switching = /^\/api\/v2\/home\/users\/([^/]+)\/switch$/.exec(url.pathname)
    if (req.method === 'POST' && switching) {
      const profile = PROFILES.find((entry) => entry.uuid === switching[1])
      if (!profile) return json(404, {})
      // A protected home user answers only to its own PIN.
      if (profile.protected && url.searchParams.get('pin') !== '1234') return json(401, { error: 'wrong pin' })
      return json(200, { authToken: `${profile.title.toLowerCase()}-token` })
    }
    if (url.pathname === '/api/v2/user') {
      if (token === 'sam-token') return json(200, { id: 77, username: 'sam', email: 'sam@example.com', title: 'Sam' })
      if (token === 'kids-token') return json(200, { id: 78, username: 'kids', email: 'kids@example.com', title: 'Kids' })
      if (token === 'owner-token') return json(200, { id: 70, username: 'owner', email: 'owner@example.com', title: 'Owner' })
      return json(401, { error: 'unknown token' })
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  stubUrl = `http://127.0.0.1:${stub.address().port}`

  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-plex-test-'))
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_FILE: join(dataDir, 'discovarr.db'),
      IMAGE_CACHE_DIR: join(dataDir, 'images'),
      ADMIN_PASSWORD: 'adminpass',
      ADMIN_USERNAME: 'admin',
      ADMIN_EMAIL: 'admin@discovarr.local',
      TMDB_API_KEY: '',
      PLEX_TV_BASE: stubUrl,
    },
    stdio: 'ignore',
  })

  await waitForHealth()
})

after(async () => {
  if (server) server.kill()
  if (stub) await new Promise((resolve) => stub.close(resolve))
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('the sign-in page offers Plex', async () => {
  const response = await get('/login')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(html, /Continue with Plex/)
  assert.match(html, /href="\/auth\/plex"/)
})

test('starting a Plex sign-in hands the browser a pin', async () => {
  const response = await get('/auth/plex')

  assert.equal(response.status, 303)
  const location = response.headers.get('location')
  assert.match(location, /^https:\/\/app\.plex\.tv\/auth#\?/)
  assert.match(location, /code=plex-code/)
  assert.match(location, /clientID=/)
  assert.match(location, /forwardUrl=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fauth%2Fplex%2Fcallback/)

  const pin = decodeURIComponent(cookieValue(response, 'discovarr_plex_pin'))
  assert.equal(pin, '4242:plex-code')
  assert.match(cookiesOf(response).join('\n'), /discovarr_plex_pin=[^;]+; Path=\/auth\/plex; HttpOnly/)
})

test('the callback asks which profile when the account has several', async () => {
  const { html, token } = await profilePickerCookie()

  assert.match(html, /Who's watching\?/)
  assert.match(html, /value="owner-uuid"/)
  assert.match(html, /value="sam-uuid"/)
  assert.match(html, /Sam/)
  assert.equal(token, 'owner-token')
})

test('choosing a profile signs that Plex user in', async () => {
  const { token } = await profilePickerCookie()
  const chosen = await postForm(
    '/auth/plex/profile',
    { uuid: 'sam-uuid' },
    `discovarr_plex_pin=4242:plex-code; discovarr_plex_token=${token}`
  )

  assert.equal(chosen.status, 303)
  assert.equal(chosen.headers.get('location'), '/')

  const session = cookieValue(chosen, 'discovarr_session')
  assert.ok(session)

  const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: `discovarr_session=${session}` } })
  const payload = await me.json()

  assert.equal(me.status, 200)
  assert.equal(payload.user.username, 'sam')
  assert.equal(payload.user.email, 'sam@example.com')
  assert.equal(payload.user.role, 'user')
})

test('signing in again reuses the account made the first time', async () => {
  const first = await profilePickerCookie()
  const firstChoice = await postForm('/auth/plex/profile', { uuid: 'sam-uuid' }, `discovarr_plex_token=${first.token}`)
  const firstSession = cookieValue(firstChoice, 'discovarr_session')
  const firstMe = await (await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: `discovarr_session=${firstSession}` } })).json()

  const second = await profilePickerCookie()
  const secondChoice = await postForm('/auth/plex/profile', { uuid: 'sam-uuid' }, `discovarr_plex_token=${second.token}`)
  const secondSession = cookieValue(secondChoice, 'discovarr_session')
  const secondMe = await (await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: `discovarr_session=${secondSession}` } })).json()

  assert.equal(secondMe.user.id, firstMe.user.id)
})

test('a profile choice without a Plex token is refused', async () => {
  const response = await postForm('/auth/plex/profile', { uuid: 'sam-uuid' })

  assert.equal(response.status, 303)
  assert.match(response.headers.get('location'), /^\/login\?err=/)
})

test('a protected profile shows a PIN field', async () => {
  const { html } = await profilePickerCookie()

  assert.match(html, /name="pin-kids-uuid"/)
  assert.match(html, /PIN for Kids/)
  assert.match(html, /Sign in/)
})

test('a protected profile needs its own PIN before it signs in', async () => {
  const { token } = await profilePickerCookie()
  const cookie = `discovarr_plex_token=${token}`

  const missing = await postForm('/auth/plex/profile', { uuid: 'kids-uuid' }, cookie)
  assert.equal(missing.status, 200)
  assert.match(await missing.text(), /Enter the 4-digit PIN for Kids/)

  const wrong = await postForm('/auth/plex/profile', { uuid: 'kids-uuid', 'pin-kids-uuid': '0000' }, cookie)
  assert.equal(wrong.status, 200)
  const refused = await wrong.text()
  assert.match(refused, /That PIN is not right for Kids/)
  assert.match(refused, /name="pin-kids-uuid"/)

  const accepted = await postForm('/auth/plex/profile', { uuid: 'kids-uuid', 'pin-kids-uuid': '1234' }, cookie)
  assert.equal(accepted.status, 303)
  assert.equal(accepted.headers.get('location'), '/')

  const session = cookieValue(accepted, 'discovarr_session')
  const me = await (await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: `discovarr_session=${session}` } })).json()
  assert.equal(me.user.username, 'kids')
})
