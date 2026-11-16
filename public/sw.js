/* Discovarr's service worker.
 *
 * Two jobs, and they stay separate:
 *   - Push notifications, including on an iPhone home-screen app (iOS 16.4+).
 *   - A small cache of the shell (stylesheet, icons, offline page) so the next
 *     visit paints faster and a dead network shows a page instead of the
 *     browser's error.
 *
 * Pages and /api responses are never stored. They are rendered for whoever is
 * signed in, and a cache would hand that HTML back to the next person on the
 * same phone. Navigations are network-first; only a failed network falls back
 * to the offline page.
 *
 * The cache name is the build version, filled in when this file is served.
 * A new image installs a new cache and deletes the old ones. The script URL
 * and scope stay put, so an existing push subscription keeps working.
 *
 * Paths are resolved against registration.scope. The app is mounted at the
 * origin root today (every link is root-absolute), and a narrower scope still
 * caches inside itself.
 */

const CACHE = 'discovarr-__DISCOVARR_VERSION__'

const SHELL = [
  'offline.html',
  'styles.css?v=__STYLES_VERSION__',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-midnight.png',
  'icons/apple-touch-cinema.png',
  'icons/apple-touch-teal.png',
  'icons/apple-touch-forest.png',
  'icons/apple-touch-sapphire.png',
  'icons/apple-touch-crimson.png',
  'favicon-midnight.png',
  'favicon-cinema.png',
  'favicon-teal.png',
  'favicon-forest.png',
  'favicon-sapphire.png',
  'favicon-crimson.png',
]

const STATIC_FILE = /\.(?:css|png|svg|ico|woff2)$/i

function appPathname(url) {
  const scopePath = new URL(self.registration.scope).pathname
  const prefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`
  const exact = prefix.slice(0, -1) || '/'
  if (url.pathname !== exact && !url.pathname.startsWith(prefix)) return null
  return url.pathname.slice(prefix.length - 1) || '/'
}

function underScope(path) {
  try {
    const url = new URL(String(path || ''), self.registration.scope)
    if (url.origin !== self.location.origin) return self.registration.scope
    if (!url.href.startsWith(self.registration.scope)) return self.registration.scope
    return url.href
  } catch (error) {
    return self.registration.scope
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await cache.addAll(SHELL.map((path) => new URL(path, self.registration.scope)))
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((key) => key.startsWith('discovarr-') && key !== CACHE).map((key) => caches.delete(key))
      )
      await self.clients.claim()
    })()
  )
})

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response && response.status === 200 && !response.headers.has('set-cookie')) {
    await cache.put(request, response.clone())
  }
  return response
}

async function networkFirstCache(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response && response.status === 200 && !response.headers.has('set-cookie')) {
      await cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached) return cached
    throw error
  }
}

async function networkDocument(request) {
  try {
    // Do not store. The HTML belongs to the signed-in account.
    return await fetch(request)
  } catch (error) {
    const cache = await caches.open(CACHE)
    const offline = await cache.match(new URL('offline.html', self.registration.scope), { ignoreSearch: true })
    if (offline) return offline
    return new Response(
      '<!doctype html><title>Offline</title><p>Discovarr is offline. Try again once you are back on the network.</p>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    )
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  const path = appPathname(url)
  if (!path) return

  // Authenticated JSON, artwork and the worker script stay on the network.
  // Caching any of them would either leak a session or pin an old worker.
  if (path === '/sw.js' || path.startsWith('/api/') || path.startsWith('/img/')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkDocument(request))
    return
  }

  if (path === '/manifest.webmanifest') {
    event.respondWith(networkFirstCache(request))
    return
  }

  if (STATIC_FILE.test(path)) {
    event.respondWith(cacheFirst(request))
  }
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (error) {
    data = { title: 'Discovarr', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'Discovarr'
  const options = {
    body: data.body || '',
    icon: underScope(data.icon || 'favicon-midnight.png'),
    badge: underScope(data.badge || 'favicon-midnight.png'),
    tag: data.tag || 'discovarr',
    // One notification per kind, so three approvals do not stack up as three
    // panels on the lock screen.
    renotify: Boolean(data.tag),
    data: { url: data.href || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  const raw = (event.notification.data && event.notification.data.url) || '/'
  const target = underScope(raw)
  event.notification.close()

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const targetUrl = new URL(target)

      for (const client of windows) {
        let clientUrl
        try {
          clientUrl = new URL(client.url)
        } catch (error) {
          continue
        }
        if (clientUrl.origin !== self.location.origin) continue
        if (!client.url.startsWith(self.registration.scope)) continue
        await client.focus()
        if ('navigate' in client && clientUrl.pathname !== targetUrl.pathname) {
          try {
            await client.navigate(target)
          } catch (error) {
            // A window that refuses to move is still focused, which is enough.
          }
        }
        return
      }

      await self.clients.openWindow(target)
    })()
  )
})
