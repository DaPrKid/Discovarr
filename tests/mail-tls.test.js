import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer, TLSSocket, createSecureContext } from 'node:tls'
import { after, before, test } from 'node:test'
import { sendMail } from '../src/mail.js'

/**
 * The mail client's TLS paths are the ones that cannot be checked against a
 * fake listening on port 25, so these tests run a real TLS handshake against a
 * certificate generated for the run. Verification is proven twice: once with
 * the certificate trusted, once without, where it must fail.
 */

let dataDir
let key
let cert
let secureContext
let servers = []

function smtpConversation(socket, state = {}) {
  socket.setEncoding('utf8')
  let buffer = ''

  socket.on('data', (chunk) => {
    buffer += chunk

    let index = buffer.indexOf('\r\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\r\n')

      if (state.data) {
        if (line === '.') {
          state.data = false
          socket.write('250 queued as 1\r\n')
        }
        continue
      }

      if (line.startsWith('EHLO')) socket.write('250-test.local\r\n250 AUTH PLAIN LOGIN\r\n')
      else if (line.startsWith('AUTH PLAIN')) {
        state.auth = 'PLAIN'
        socket.write('235 authenticated\r\n')
      } else if (line.startsWith('AUTH LOGIN')) {
        state.auth = 'LOGIN'
        socket.write('334 VXNlcm5hbWU6\r\n')
      } else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 ok\r\n')
      else if (line === 'DATA') {
        state.data = true
        socket.write('354 go ahead\r\n')
      } else if (line === 'QUIT') socket.write('221 bye\r\n')
      else socket.write('250 ok\r\n')
    }

    // The message ends with a bare "." line and no trailing break, so the loop
    // above never sees it as a complete line.
    if (state.data && buffer === '.') {
      buffer = ''
      state.data = false
      socket.write('250 queued as 1\r\n')
    }
  })
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return server.address().port
}

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'discovarr-mail-'))
  const keyPath = join(dataDir, 'key.pem')
  const certPath = join(dataDir, 'cert.pem')

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'pipe' })

  key = readFileSync(keyPath)
  cert = readFileSync(certPath)
  secureContext = createSecureContext({ key, cert })
})

after(() => {
  for (const server of servers) server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('implicit TLS sends, negotiates a protocol and reports it', async () => {
  const server = createTlsServer({ key, cert }, (socket) => {
    // Unlike the STARTTLS front server, nothing has greeted the client yet.
    socket.write('220 test.local ESMTP\r\n')
    smtpConversation(socket)
  })
  const port = await listen(server)

  const result = await sendMail(
    {
      host: '127.0.0.1',
      port,
      security: 'ssl',
      user: 'mailer',
      password: 'secret',
      from: 'discovarr@example.com',
      to: 'owner@example.com',
      subject: 'Test',
      text: 'hello',
    },
    { tlsOptions: { ca: cert } }
  )

  assert.equal(result.sent, true)
  assert.equal(result.security, 'ssl')
  assert.match(String(result.protocol), /^TLS/)
  assert.ok(result.cipher, 'no cipher was reported')
  assert.equal(result.auth, 'PLAIN')
})

test('a self-signed certificate is rejected unless it is trusted', async () => {
  const server = createTlsServer({ key, cert }, (socket) => smtpConversation(socket))
  const port = await listen(server)

  await assert.rejects(
    sendMail({
      host: '127.0.0.1',
      port,
      security: 'ssl',
      from: 'discovarr@example.com',
      to: 'owner@example.com',
      subject: 'Test',
      text: 'hello',
    }),
    (error) => /self[- ]signed|unable to verify|certificate/i.test(String(error.message))
  )
})

test('STARTTLS upgrades the plaintext connection', async () => {
  const front = createNetServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('220 test.local ESMTP\r\n')
    let buffer = ''

    const handler = (chunk) => {
      buffer += chunk

      let index = buffer.indexOf('\r\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\r\n')

        if (line.startsWith('EHLO')) {
          socket.write('250-test.local\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n')
        } else if (line === 'STARTTLS') {
          socket.write('220 ready for TLS\r\n')
          socket.removeListener('data', handler)
          const secure = new TLSSocket(socket, { isServer: true, secureContext })
          smtpConversation(secure)
          return
        } else {
          socket.write('250 ok\r\n')
        }
      }
    }

    socket.on('data', handler)
  })

  const port = await listen(front)

  const result = await sendMail(
    {
      host: '127.0.0.1',
      port,
      security: 'starttls',
      user: 'mailer',
      password: 'secret',
      from: 'discovarr@example.com',
      to: 'owner@example.com',
      subject: 'Test',
      text: 'hello',
    },
    { tlsOptions: { ca: cert }, timeoutMs: 8000 }
  )

  assert.equal(result.sent, true)
  assert.equal(result.security, 'starttls')
  assert.match(String(result.protocol), /^TLS/)
})
