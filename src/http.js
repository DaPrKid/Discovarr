import { randomBytes } from 'node:crypto'

import { config } from './config.js'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const MAX_BODY_BYTES = 1024 * 1024

/**
 * A fresh nonce per response. Every inline <script> the app renders is stamped
 * with it in sendHtml, so the policy can leave 'unsafe-inline' out of
 * script-src entirely: injected markup cannot guess the value, cannot run, and
 * cannot smuggle an external file in either.
 *
 * Style keeps 'unsafe-inline' because the markup styles individual elements
 * with style attributes (poster hues, backdrop art), which no nonce can cover.
 */
export function newScriptNonce() {
  return randomBytes(16).toString('base64')
}

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors ${config.frameAncestors}`,
  ].join('; ')
}

function isHttps(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  return config.cookieSecure || forwarded === 'https'
}

/** Applied to every response, static files included. */
export function applySecurityHeaders(req, res) {
  res.cspNonce = newScriptNonce()
  res.setHeader('content-security-policy', contentSecurityPolicy(res.cspNonce))
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-permitted-cross-domain-policies', 'none')
  // X-Frame-Options cannot express a list, so it is only sent for the default.
  if (config.frameAncestors === "'self'") res.setHeader('x-frame-options', 'SAMEORIGIN')
  if (isHttps(req)) res.setHeader('strict-transport-security', 'max-age=15552000')
}

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

export function parseCookies(header = '') {
  const cookies = {}

  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue

    const name = part.slice(0, index).trim()
    if (!name) continue

    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      cookies[name] = part.slice(index + 1).trim()
    }
  }

  return cookies
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

export function sendHtml(res, status, html, headers = {}) {
  // The header and the markup are stamped in one place, so they cannot disagree
  // and no future inline script can be forgotten.
  const markup = res.cspNonce
    ? html.replace(/<script(?![^>]*\bnonce=)(?=[\s>])/gi, `<script nonce="${res.cspNonce}"`)
    : html
  const body = Buffer.from(markup)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

export function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, ...headers })
  res.end()
}

export async function readBody(req) {
  const chunks = []
  let size = 0

  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}

  const type = String(req.headers['content-type'] ?? '')
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw)
    } catch {
      throw new HttpError(400, 'Body must be valid JSON')
    }
  }

  // Repeated keys (checkbox groups) collapse into arrays instead of being lost.
  const body = {}
  for (const [key, value] of new URLSearchParams(raw)) {
    if (key in body) body[key] = [].concat(body[key], value)
    else body[key] = value
  }

  return body
}

/**
 * Blocks cross-site form posts and fetches. Non-browser clients (curl, scripts)
 * send no Origin header and rely on the session cookie instead.
 */
/**
 * Rejects cross-site mutations. Browsers attach Sec-Fetch-Site to every
 * request and page scripts cannot set it, so it is the primary signal. The
 * Origin/Host comparison is only the fallback, because reverse proxies such as
 * the preview tunnel rewrite Host while the browser keeps the public Origin.
 */
export function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site']

  if (typeof site === 'string' && site.length > 0) {
    return site === 'same-origin' || site === 'none'
  }

  const origin = req.headers.origin
  if (!origin) return true

  let originHost
  try {
    originHost = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }

  return [req.headers['x-forwarded-host'], req.headers.host].some((header) => {
    if (!header) return false
    const host = String(header).split(',')[0].trim().toLowerCase()
    return host === originHost || host.split(':')[0] === originHost
  })
}

// ---------------------------------------------------------------------------
// Tiny router
// ---------------------------------------------------------------------------

function matchPattern(segments, pathSegments) {
  if (segments.length !== pathSegments.length) return null

  const params = {}
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(pathSegments[i])
    } else if (segment !== pathSegments[i]) {
      return null
    }
  }

  return params
}

export function createRouter({ fallback = null, onError = null } = {}) {
  const routes = []

  const register = (method) => (pattern, handler) => {
    routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handler,
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathSegments = url.pathname.split('/').filter(Boolean)
    const method = String(req.method ?? 'GET').toUpperCase()

    applySecurityHeaders(req, res)

    try {
      if (!['GET', 'HEAD'].includes(method) && !isSameOrigin(req)) {
        throw new HttpError(403, 'Cross-origin requests are not allowed')
      }

      for (const route of routes) {
        if (route.method !== method) continue
        const params = matchPattern(route.segments, pathSegments)
        if (!params) continue
        return await route.handler({ req, res, url, params })
      }

      if (fallback && (await fallback({ req, res, url, pathSegments }))) return
      throw new HttpError(404, 'Not found')
    } catch (error) {
      if (onError) return onError({ req, res, url, error })
      throw error
    }
  }

  return {
    handle,
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    patch: register('PATCH'),
    delete: register('DELETE'),
  }
}
