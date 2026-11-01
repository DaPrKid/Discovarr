import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

let server
let smtp
let dataDir
let baseUrl
let cookie
let requesterCookie

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

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function get(path, using = cookie) {
  return fetch(`${baseUrl}${path}`, { headers: { cookie: using }, redirect: 'manual' })
}

function postForm(path, fields, using = cookie) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { cookie: using, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}

/** A tiny SMTP server: greets, accepts one message, records its DATA block. */
function startSmtp() {
  return new Promise((resolve) => {
    const messages = []

    const listener = createNetServer((socket) => {
      socket.setEncoding('utf8')
      socket.write('220 test.local ESMTP ready\r\n')

      let buffer = ''
      let inData = false
      let body = ''

      socket.on('data', (chunk) => {
        buffer += chunk

        let index
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)

          if (inData) {
            if (line === '.') {
              inData = false
              messages.push(body)
              body = ''
              socket.write('250 2.0.0 queued\r\n')
            } else {
              body += `${line}\n`
            }
            continue
          }

          const upper = line.toUpperCase()
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-test.local\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10240000\r\n')
          } else if (upper.startsWith('AUTH PLAIN')) {
            socket.write('235 2.7.0 accepted\r\n')
          } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
            socket.write('250 2.1.0 ok\r\n')
          } else if (upper === 'DATA') {
            inData = true
            body = ''
            socket.write('354 end with a lone dot\r\n')
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 bye\r\n')
            socket.end()
          } else {
            socket.write('250 ok\r\n')
          }
        }
      })

      socket.on('error', () => {})
    })

    listener.listen(0, '127.0.0.1', () => {
      resolve({ listener, port: listener.address().port, messages })
    })
  })
}

async function pendingRequests() {
  const response = await fetch(`${baseUrl}/api/v1/request?filter=pending&take=50`, { headers: { cookie } })
  const payload = await response.json()
  return payload.results ?? []
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-notify-'))
  smtp = await startSmtp()

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_FILE: join(dataDir, 'discovarr.db'),
      IMAGE_CACHE_DIR: join(dataDir, 'images'),
      ADMIN_PASSWORD: 'notifypass',
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
    body: JSON.stringify({ username: 'owner', password: 'notifypass' }),
  })

  assert.equal(login.status, 200)
  cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0]

  // The administrator holds every permission, auto-approval included, so these
  // tests file their requests from a plain account and approve them as the admin.
  await fetch(`${baseUrl}/settings/users`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: 'requester',
      email: 'requester@example.com',
      password: 'requesterpass',
      role: 'user',
    }).toString(),
    redirect: 'manual',
  })

  const requester = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'requester', password: 'requesterpass' }),
  })
  assert.equal(requester.status, 200)
  requesterCookie = String(requester.headers.get('set-cookie') ?? '').split(';')[0]
})

after(() => {
  server?.kill()
  smtp?.listener.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('the notifications page starts empty and the header carries a bell', async () => {
  const response = await get('/notifications')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /Notifications/)
  assert.match(html, /Nothing yet/)
  assert.match(html, /class="bell"/)
})

test('approving a request leaves the requester an in-app notification', async () => {
  const request = await postForm('/media/1/request', { returnTo: '/' }, requesterCookie)
  assert.equal(request.status, 303)

  const pending = await pendingRequests()
  assert.equal(pending.length, 1)

  const approve = await postForm(`/requests/${pending[0].id}/approve`, {})
  assert.equal(approve.status, 303)

  const html = await (await get('/notifications', requesterCookie)).text()
  assert.match(html, /was approved/)
  assert.match(html, /Open the title/)
  assert.match(html, /bell-count/)
  assert.match(html, /Mark all read/)

  const read = await postForm('/notifications/read', {}, requesterCookie)
  assert.equal(read.status, 303)
  assert.doesNotMatch(await (await get('/notifications', requesterCookie)).text(), /Mark all read/)
})

test('bulk approve handles the ticked requests in one post', async () => {
  await postForm('/media/2/request', { returnTo: '/' }, requesterCookie)
  const pending = await pendingRequests()
  assert.ok(pending.length >= 1)

  const ids = pending.map((item) => item.id)
  const body = new URLSearchParams()
  body.set('action', 'approve')
  body.set('returnTo', '/requests?filter=pending')
  for (const id of ids) body.append('ids', String(id))

  const response = await fetch(`${baseUrl}/requests/bulk`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  })

  assert.equal(response.status, 303)
  assert.match(String(response.headers.get('location')), /notice=/)

  const html = await (await get('/requests?filter=all')).text()
  assert.match(html, /action="\/requests\/bulk"/)
  assert.match(html, /name="ids"/)
})

test('bulk without a selection is refused with a message', async () => {
  const response = await postForm('/requests/bulk', { action: 'approve' })
  assert.equal(response.status, 303)
  assert.match(String(response.headers.get('location')), /err=/)
})

test('saving SMTP settings and sending a test message uses the transport', async () => {
  const save = await postForm('/settings', {
    settingsSection: 'mail',
    settingsTab: 'notifications',
    smtpEnabled: 'on',
    smtpHost: '127.0.0.1',
    smtpPort: String(smtp.port),
    smtpSecurity: 'none',
    smtpFrom: 'discovarr@example.com',
    smtpFromName: 'Discovarr',
  })

  assert.equal(save.status, 303)

  const test1 = await postForm('/settings/test/mail', {
    settingsSection: 'mail',
    settingsTab: 'notifications',
    smtpEnabled: 'on',
    smtpHost: '127.0.0.1',
    smtpPort: String(smtp.port),
    smtpSecurity: 'none',
    smtpFrom: 'discovarr@example.com',
  })

  assert.equal(test1.status, 200)
  const html = await test1.text()
  assert.match(html, /Test message sent to owner@example\.com/)

  assert.ok(await waitFor(() => smtp.messages.length >= 1), 'the test message never arrived')
  const message = smtp.messages[0]
  assert.match(message, /Subject: Discovarr: test message/)
  assert.match(message, /To: <owner@example\.com>/)
  assert.match(message, /From: .*<discovarr@example\.com>/)
})

test('a user who opts into email is mailed when their request is approved', async () => {
  const prefs = await postForm('/account/notifications', { notifyEmail: 'on', events: '1' }, requesterCookie)
  assert.equal(prefs.status, 303)

  const before = smtp.messages.length

  await postForm('/media/3/request', { returnTo: '/' }, requesterCookie)
  const pending = await pendingRequests()
  assert.ok(pending.length >= 1)
  await postForm(`/requests/${pending[0].id}/approve`, {})

  assert.ok(
    await waitFor(() => smtp.messages.length > before),
    'no approval email was sent'
  )

  const message = smtp.messages[smtp.messages.length - 1]
  assert.match(message, /Subject: Discovarr: .*was approved/)
  assert.match(message, /To: <requester@example\.com>/)
})

test('a failing mail server reports the error instead of pretending to send', async () => {
  const closedPort = await freePort()

  const response = await postForm('/settings/test/mail', {
    settingsSection: 'mail',
    settingsTab: 'notifications',
    smtpEnabled: 'on',
    smtpHost: '127.0.0.1',
    smtpPort: String(closedPort),
    smtpSecurity: 'none',
    smtpFrom: 'discovarr@example.com',
  })

  assert.equal(response.status, 200)
  assert.match(await response.text(), /Mail test failed/)
})
