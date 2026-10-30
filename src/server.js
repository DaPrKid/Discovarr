import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerApiRoutes } from './api.js'
import { currentUser } from './auth.js'
import { config } from './config.js'
import { deleteExpiredSessions } from './db.js'
import { createRouter, HttpError, sendHtml, sendJson } from './http.js'
import { serveImage } from './images.js'
import { registerPageRoutes } from './pages.js'
import { startSyncScheduler } from './sync.js'
import { escapeHtml, layout } from './views.js'

const appDir = dirname(dirname(fileURLToPath(import.meta.url)))
const publicDir = join(appDir, 'public')

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
])

async function serveStatic(res, pathname) {
  const relative = normalize(pathname.slice(1))
  if (!relative || relative.startsWith('..') || relative.includes(`${sep}..`)) return false

  const filePath = join(publicDir, relative)
  if (!MIME_TYPES.has(extname(filePath).toLowerCase())) return false

  try {
    const file = await readFile(filePath)
    res.writeHead(200, {
      'content-type': MIME_TYPES.get(extname(filePath).toLowerCase()),
      'content-length': file.length,
      'cache-control': 'public, max-age=3600',
    })
    res.end(file)
    return true
  } catch {
    return false
  }
}

const router = createRouter({
  fallback: async ({ req, res, url, pathSegments }) => {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return false

    // Cached TMDB artwork: /img/<size>/<file>
    if (pathSegments[0] === 'img' && pathSegments.length === 3) {
      await serveImage(res, pathSegments[1], pathSegments[2])
      return true
    }

    return serveStatic(res, url.pathname)
  },
  onError: ({ req, res, url, error }) => {
    const status = error instanceof HttpError ? error.status : 500
    if (status >= 500) console.error('[discovarr]', error)
    if (res.headersSent) {
      res.end()
      return
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, status, { error: error.message ?? 'Internal server error' })
      return
    }

    sendHtml(
      res,
      status,
      layout({
        title: 'Error',
        user: currentUser(req),
        body: `<h1>${status}</h1>
          <p class="muted">${escapeHtml(error.message ?? 'Something went wrong')}</p>
          <a class="back" href="/">← Back to discover</a>`,
      })
    )
  },
})

registerPageRoutes(router)
registerApiRoutes(router)

const server = createServer((req, res) => {
  // Login attempts and home-page hits are logged (never cookie values) so a
  // proxy or cookie problem is diagnosable from `docker logs` alone.
  const requestPath = String(req.url ?? '/').split('?')[0]
  const interesting =
    (req.method !== 'GET' && req.method !== 'HEAD') || requestPath === '/' || requestPath === '/login'

  if (interesting) {
    res.on('finish', () => {
      console.log(
        `[discovarr] ${req.method} ${req.url} -> ${res.statusCode}` +
          ` host=${req.headers.host ?? '-'}` +
          ` proto=${req.headers['x-forwarded-proto'] ?? '-'}` +
          ` site=${req.headers['sec-fetch-site'] ?? '-'}` +
          ` origin=${req.headers.origin ?? '-'}` +
          ` session=${req.headers.cookie ? 'present' : 'absent'}`
      )
    })
  }

  router.handle(req, res).catch((error) => {
    console.error('[discovarr] unhandled error', error)
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' })
    else res.end()
  })
})

deleteExpiredSessions()
setInterval(deleteExpiredSessions, 60 * 60 * 1000).unref()
startSyncScheduler()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[discovarr] ${signal} received, shutting down`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })
}

server.listen(config.port, config.host, () => {
  console.log(`[discovarr] listening on http://${config.host}:${config.port}`)
  console.log(`[discovarr] database: ${config.databaseFile}`)
  console.log(`[discovarr] image cache: ${config.imageCacheDir}`)

  if (config.demoAutoLoginEmail) {
    console.warn(
      `[discovarr] DEMO MODE: every request is treated as ${config.demoAutoLoginEmail} while no session cookie exists. Never enable this on a public instance.`
    )
  }

  if (config.isDefaultAdminPassword) {
    console.warn(
      `[discovarr] SECURITY: the admin password is the default "admin". Set ADMIN_PASSWORD before exposing this instance.`
    )
  }
})
