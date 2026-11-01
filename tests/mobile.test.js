import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const ADMIN = { email: 'owner@discovarr.local', username: 'owner', password: 'ownerpass' }

let server
let baseUrl
let dataDir
let cookie

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

function postForm(path, fields) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(fields),
  })
}

function get(path, headers = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: 'manual', headers })
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-mobile-'))
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.resume()
  server.stderr.resume()

  await waitForHealth()

  const login = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: ADMIN.username, password: ADMIN.password }),
  })
  const raw = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie')
  assert.ok(raw, 'expected a session cookie')
  cookie = raw.split(';')[0]
})

after(() => {
  server?.kill('SIGTERM')
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('the stylesheet is keyed by its content, not the app version', async () => {
  const css = readFileSync(join(projectRoot, 'public', 'styles.css'))
  const expected = createHash('sha256').update(css).digest('hex').slice(0, 10)
  const html = await (await get('/', { cookie })).text()

  // The version only moves on a tag, so `?v=1.0.0` left phones on an old
  // stylesheet for whole releases. The hash moves when the bytes do.
  assert.match(html, new RegExp(`/styles\\.css\\?v=${expected}`))
  assert.doesNotMatch(html, /styles\.css\?v=1\.0\.0/)
})

test('every page offers the phone shell and the install metadata', async () => {
  const html = await (await get('/', { cookie })).text()

  // Four tabs for the thumb, and the rest behind the account chip.
  assert.match(html, /<nav class="tabbar" aria-label="Sections">/)
  assert.equal(
    (html.match(/class="tab-icon"/g) ?? []).length,
    4,
    'the tab bar holds four destinations'
  )
  assert.match(html, /class="tab is-active"[^>]*aria-current="page"/)
  assert.match(html, /data-menu/)
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/)
  assert.match(html, /<meta name="theme-color" id="theme-color"/)
  assert.match(html, /rel="apple-touch-icon"/)
  // Desktop keeps the full row of links.
  assert.match(html, /<nav class="nav" aria-label="Sections">/)
})

test('the manifest installs the app instead of bookmarking a tab', async () => {
  const response = await get('/manifest.webmanifest')
  assert.equal(response.status, 200)
  assert.match(String(response.headers.get('content-type')), /application\/manifest\+json/)

  const manifest = await response.json()
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.name, 'Discovarr')
  assert.ok(manifest.icons.length >= 1)
})

test('tables carry a label for every value once they stack', async () => {
  // The token table only renders once there is a token to revoke, and the
  // creation response is the settings page itself, so the token shows once.
  const created = await postForm('/settings/tokens', { name: 'Phone check' })
  assert.equal(created.status, 200)

  const html = await created.text()
  assert.match(html, /New token, shown once/)
  assert.match(html, /<td data-label="Name">Phone check<\/td>/)
  assert.match(html, /<td data-label="Kind">API<\/td>/)
  assert.match(html, /<td data-label="Created">/)
  assert.match(html, /<td data-label="Last used">never<\/td>/)
})

test('the calendar also renders as a list for small screens', async () => {
  const html = await (await get('/calendar', { cookie })).text()
  assert.match(html, /class="cal-agenda/)
  assert.match(html, /class="cal-grid"/)
})

test('the phone rules exist in the stylesheet', async () => {
  const css = await (await get('/styles.css')).text()
  assert.match(css, /@media \(max-width: 760px\)/)
  assert.match(css, /\.tabbar\s*\{[^}]*position: fixed/)
  assert.match(css, /@media \(pointer: coarse\)/)
  assert.match(css, /font-size: 16px/)
  assert.match(css, /min-height: 44px/)
  assert.match(css, /\.table thead\s*\{\s*display: none/)
  assert.match(css, /\.cal-grid\s*\{\s*display: none/)
})
