import { connect as netConnect, isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/**
 * A deliberately small SMTP client: enough for a notification mail to a relay
 * or a mail provider, with no dependencies. Supports implicit TLS (465),
 * STARTTLS (587) and plaintext (25, for a relay on the same host), plus AUTH
 * PLAIN and LOGIN.
 */

const DEFAULT_TIMEOUT = 12_000

class SmtpSession {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.waiters = []
    this.error = null

    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      this.buffer += chunk
      this.drain()
    })
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('The mail server closed the connection')))
  }

  fail(error) {
    if (this.error) return
    this.error = error
    while (this.waiters.length) this.waiters.shift()(Promise.reject(error))
  }

  drain() {
    if (!this.waiters.length) return

    // An SMTP reply is one or more "250-..." lines ending with "250 ...".
    const lines = this.buffer.split('\r\n')
    let finalIndex = -1
    for (let index = 0; index < lines.length; index += 1) {
      if (/^\d{3} /.test(lines[index])) finalIndex = index
    }
    if (finalIndex < 0) return

    const replyLines = lines.slice(0, finalIndex + 1)
    this.buffer = lines.slice(finalIndex + 1).join('\r\n')
    const code = Number(replyLines[finalIndex].slice(0, 3))
    const text = replyLines.map((line) => line.slice(4)).join(' ')

    const waiter = this.waiters.shift()
    if (waiter) waiter(Promise.resolve({ code, text }))
    this.drain()
  }

  read() {
    if (this.error) return Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      this.waiters.push((promise) => promise.then(resolve, reject))
      this.drain()
    })
  }

  async command(line, expected = [250]) {
    this.socket.write(`${line}\r\n`)
    const reply = await this.read()
    if (!expected.includes(reply.code)) {
      throw new Error(`Mail server refused ${line.split(' ')[0]}: ${reply.code} ${reply.text}`)
    }
    return reply
  }

  write(line) {
    this.socket.write(`${line}\r\n`)
  }
}

function greet(socket, timeoutMs) {
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('The mail server did not answer in time')))
  return new SmtpSession(socket)
}

/** What the connection actually negotiated, for the settings test message. */
function describe(socket) {
  try {
    return { protocol: socket.getProtocol(), cipher: socket.getCipher()?.name ?? null }
  } catch {
    return { protocol: null, cipher: null }
  }
}

// Node refuses to set a TLS servername to a bare address, and a relay reached by
// IP has no name to verify anyway, so the option is left off in that case.
function tlsTarget(host) {
  return isIP(String(host)) ? {} : { servername: host }
}

function upgradeToTls(socket, host, timeoutMs, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, ...tlsTarget(host), ...tlsOptions }, () => {
      secure.setTimeout(timeoutMs)
      resolve(secure)
    })
    secure.once('error', reject)
  })
}

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function encodeHeader(value) {
  // Non-ASCII subjects and names must be RFC 2047 encoded or relays mangle them.
  const text = String(value ?? '')
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function buildMessage({ from, fromName, to, subject, text }) {
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} ` : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@discovarr>`,
  ]

  // Dot-stuffing: a line that is a single "." would end the DATA block.
  const body = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')

  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n.`
}

export async function sendMail(
  { host, port = 587, security = 'starttls', user = '', password = '', from, fromName = 'Discovarr', to, subject, text },
  { timeoutMs = DEFAULT_TIMEOUT, tlsOptions = {} } = {}
) {
  if (!host) throw new Error('No mail server host configured')
  if (!from) throw new Error('No sender address configured')
  if (!to) throw new Error('No recipient address')

  const portNumber = Number(port) || 587
  const implicitTls = security === 'ssl'

  const socket = await new Promise((resolve, reject) => {
    const connect = implicitTls ? tlsConnect : netConnect
    const options = implicitTls
      ? { host, port: portNumber, ...tlsTarget(host), ...tlsOptions }
      : { host, port: portNumber }
    const attempt = connect(options, () => resolve(attempt))
    attempt.setTimeout(timeoutMs, () => attempt.destroy(new Error('Connecting to the mail server timed out')))
    attempt.once('error', reject)
  })

  let session = greet(socket, timeoutMs)
  let reply = await session.read()
  if (reply.code !== 220) throw new Error(`Mail server greeted with ${reply.code}`)

  await session.command(`EHLO discovarr`, [250])

  // Reported back so a settings test can say what it actually negotiated rather
  // than just "sent".
  let encrypted = implicitTls ? describe(socket) : null
  let auth = null

  if (security === 'starttls') {
    await session.command('STARTTLS', [220])
    const secure = await upgradeToTls(session.socket, host, timeoutMs, tlsOptions)
    encrypted = describe(secure)
    session = greet(secure, timeoutMs)
    await session.command('EHLO discovarr', [250])
  } else if (!implicitTls) {
    encrypted = { protocol: null, cipher: null }
  }

  if (user) {
    // AUTH PLAIN is one round trip; fall back to LOGIN when it is refused.
    try {
      await session.command(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`, [235])
      auth = 'PLAIN'
    } catch (plainError) {
      if (/^535/.test(String(plainError.message))) throw plainError
      await session.command('AUTH LOGIN', [334])
      await session.command(b64(user), [334])
      await session.command(b64(password), [235])
      auth = 'LOGIN'
    }
  }

  await session.command(`MAIL FROM:<${from}>`, [250])
  await session.command(`RCPT TO:<${to}>`, [250, 251])
  await session.command('DATA', [354])
  session.write(buildMessage({ from, fromName, to, subject, text }))
  reply = await session.read()
  if (reply.code !== 250) throw new Error(`Mail server rejected the message: ${reply.code} ${reply.text}`)

  try {
    await session.command('QUIT', [221])
  } catch {
    // Some relays close immediately after accepting; the mail is already sent.
  }

  session.socket.end()
  return {
    sent: true,
    security: implicitTls ? 'ssl' : security === 'starttls' ? 'starttls' : 'none',
    protocol: encrypted?.protocol ?? null,
    cipher: encrypted?.cipher ?? null,
    auth,
  }
}
