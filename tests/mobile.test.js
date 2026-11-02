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

test('a theme picked on one device follows the account to another', async () => {
  // The picker posts here instead of reloading, so the account carries the
  // choice; a second device signing in has to paint it before the first frame.
  const saved = await postForm('/account/theme', { theme: 'teal' })
  assert.equal(saved.status, 204)

  const html = await (await get('/', { cookie })).text()
  assert.match(html, /<html lang="en" data-theme="teal">/)
  // The inline script reads it from the account, so a browser holding an older
  // localStorage value cannot win.
  assert.match(html, /var accountTheme = 'teal'/)

  // A theme nobody offered is refused rather than written to the row.
  const refused = await postForm('/account/theme', { theme: 'neon' })
  assert.ok(refused.status === 400, `expected 400 for an unknown theme, got ${refused.status}`)
  assert.match(await (await get('/', { cookie })).text(), /data-theme="teal"/)

  // Back to the default so later assertions start from a known state.
  assert.equal((await postForm('/account/theme', { theme: 'midnight' })).status, 204)
  assert.match(await (await get('/', { cookie })).text(), /data-theme="midnight"/)
})

test('the account page offers the theme, so every user can set it', async () => {
  const html = await (await get('/account', { cookie })).text()
  assert.match(html, /data-theme-picker/)
  for (const theme of ['midnight', 'cinema', 'teal', 'forest', 'sapphire', 'crimson']) {
    assert.match(html, new RegExp(`<option value="${theme}">`), `${theme} in the picker`)
  }
})

test('the sidebars are sheets over the grid, with both toggles pinned', async () => {
  const css = await (await get('/styles.css')).text()

  // A panel slides over the grid on a phone or tablet instead of taking a column
  // above or below it, and the scrim is what a stray tap closes it with.
  assert.match(css, /@media \(max-width: 1024px\) \{[\s\S]*?\.discover > \.browse-nav,[\s\S]*?position: fixed/)
  assert.match(css, /html\[data-drawer='nav'\] \.discover > \.browse-nav/)
  assert.match(css, /html\[data-drawer='rail'\] \.discover\.has-rail > \.filter-rail/)
  assert.match(css, /\.drawer-scrim \{[\s\S]{0,200}?position: fixed/)
  // The heading of a sheet holds still while its body scrolls.
  assert.match(css, /\.browse-head,\s*\.rail-head \{[\s\S]{0,160}?position: sticky/)
  // Both toggles ride above the bottom bar, which is what makes a panel
  // reachable at any scroll position rather than only at the top of the page.
  assert.match(css, /html \.discover-main \.panel-restore \{[\s\S]{0,200}?position: fixed/)
  assert.match(css, /--thumb-bar/)
  // The page itself must not move sideways; only a section inside it may.
  assert.match(css, /\.page:has\(> \.discover\) \{ overflow-x: clip; \}/)
  assert.match(css, /html\.has-drawer,\s*html\.has-drawer body \{ overflow: hidden; \}/)

  // The markup the script needs: one scrim, and a toggle in each panel header.
  const pages = readFileSync(join(projectRoot, 'src', 'pages.js'), 'utf8')
  assert.match(pages, /class="drawer-scrim" data-drawer-scrim hidden/)
  assert.match(pages, /data-panel="nav"/)
  assert.match(pages, /data-panel="rail"/)

  const views = readFileSync(join(projectRoot, 'src', 'views.js'), 'utf8')
  assert.match(views, /root\.dataset\.drawer = panel/)
  assert.match(views, /scrim\.hidden = !open/)
})

test('the phone rules exist in the stylesheet', async () => {
  const css = await (await get('/styles.css')).text()
  // The swap has to sit above the portrait-tablet band (768-834px), where a
  // six-link top row no longer fits and the bottom bar must already be on.
  assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*?\.topbar \.nav \{ display: none; \}/)
  assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*?\.tabbar \{/)
  assert.match(css, /\.tabbar\s*\{[^}]*position: fixed/)
  assert.match(css, /@media \(pointer: coarse\)/)
  assert.match(css, /font-size: 16px/)
  assert.match(css, /min-height: 44px/)
  assert.match(css, /\.table thead\s*\{\s*display: none/)
  assert.match(css, /\.cal-grid\s*\{\s*display: none/)
})
