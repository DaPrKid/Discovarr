import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

let server
let pushService
let dataDir
let baseUrl
let cookie
let device

// What the fake push service answers, so the pruning path can be exercised.
let status = 201
const deliveries = []

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

/** Stands in for FCM or Mozilla's push service: records the request, answers. */
function startPushService() {
  return new Promise((resolve) => {
    const listener = createHttpServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        deliveries.push({ headers: req.headers, body: Buffer.concat(chunks) })
        res.writeHead(status)
        res.end()
      })
    })

    listener.listen(0, '127.0.0.1', () => resolve({ listener, port: listener.address().port }))
  })
}

/** A browser's own key pair: the server encrypts to the public half. */
function browserKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
}

/**
 * The receiving side of RFC 8291, so the test proves the payload a real browser
 * would get is readable, not merely that bytes were posted somewhere.
 */
function decrypt({ body }, { ecdh, auth }) {
  const salt = body.subarray(0, 16)
  const idLength = body[20]
  const serverKey = body.subarray(21, 21 + idLength)
  const ciphertext = body.subarray(21 + idLength)

  const secret = ecdh.computeSecret(serverKey)
  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      Buffer.from(auth, 'base64url'),
      Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]),
      32
    )
  )
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ])

  // The last byte is the padding delimiter that ends the record.
  assert.equal(plain[plain.length - 1], 2)
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'))
}

const subscribe = (body) =>
  fetch(`${baseUrl}/api/v1/push/subscribe`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-push-'))
  pushService = await startPushService()

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
      ADMIN_PASSWORD: 'pushpass',
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
    body: JSON.stringify({ username: 'owner', password: 'pushpass' }),
  })
  assert.equal(login.status, 200)
  cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0]

  device = browserKeys()
})

after(() => {
  server?.kill()
  pushService?.listener.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('push needs a session', async () => {
  const response = await fetch(`${baseUrl}/api/v1/push`)
  assert.equal(response.status, 401)
})

test('the VAPID public key is a P-256 point and no device is listed yet', async () => {
  const response = await fetch(`${baseUrl}/api/v1/push`, { headers: { cookie } })
  assert.equal(response.status, 200)

  const payload = await response.json()
  assert.equal(Buffer.from(payload.publicKey, 'base64url').length, 65)
  assert.equal(Buffer.from(payload.publicKey, 'base64url')[0], 4)
  assert.deepEqual(payload.devices, [])
})

test('a malformed subscription is refused', async () => {
  const short = await subscribe({
    endpoint: `http://127.0.0.1:${pushService.port}/short`,
    keys: { p256dh: 'nope', auth: randomBytes(16).toString('base64url') },
  })
  assert.equal(short.status, 400)

  const plainHttp = await subscribe({
    endpoint: 'http://example.com/not-secure',
    keys: { p256dh: device.p256dh, auth: device.auth },
  })
  assert.equal(plainHttp.status, 400)
})

test('the service worker is served from the root and is never cached', async () => {
  const response = await fetch(`${baseUrl}/sw.js`)
  assert.equal(response.status, 200)
  assert.match(String(response.headers.get('content-type')), /javascript/)
  assert.equal(response.headers.get('cache-control'), 'no-cache')
  assert.match(await response.text(), /addEventListener\('push'/)
})

test('a subscribed device receives a push that only it can decrypt', async () => {
  const saved = await subscribe({
    endpoint: `http://127.0.0.1:${pushService.port}/push/device-one`,
    keys: { p256dh: device.p256dh, auth: device.auth },
  })
  assert.equal(saved.status, 200)

  const list = await (await fetch(`${baseUrl}/api/v1/push`, { headers: { cookie } })).json()
  assert.equal(list.devices.length, 1)
  assert.match(list.devices[0].label, /Browser|Chrome|Firefox|Safari/)

  const result = await (await fetch(`${baseUrl}/api/v1/push/test`, { method: 'POST', headers: { cookie } })).json()
  assert.equal(result.sent, 1)
  assert.equal(deliveries.length, 1)

  const delivery = deliveries[0]
  assert.match(String(delivery.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
  assert.equal(delivery.headers['content-encoding'], 'aes128gcm')
  assert.equal(delivery.headers.ttl, '86400')

  const message = decrypt(delivery, device)
  assert.equal(message.title, 'Discovarr is notifying you')
  assert.equal(message.href, '/')
  assert.match(message.icon, /^\/favicon-\w+\.png$/)
})

test('a push service that says a device is gone has it removed', async () => {
  status = 410

  const result = await (await fetch(`${baseUrl}/api/v1/push/test`, { method: 'POST', headers: { cookie } })).json()
  assert.equal(result.sent, 0)

  const list = await (await fetch(`${baseUrl}/api/v1/push`, { headers: { cookie } })).json()
  assert.equal(list.devices.length, 0)

  status = 201
})

test('a device can turn push off for itself', async () => {
  const keys = browserKeys()
  await subscribe({
    endpoint: `http://127.0.0.1:${pushService.port}/push/device-two`,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  })

  const removed = await fetch(`${baseUrl}/api/v1/push/unsubscribe`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: `http://127.0.0.1:${pushService.port}/push/device-two` }),
  })
  assert.equal(removed.status, 200)
  assert.equal((await removed.json()).devices, 0)
})
