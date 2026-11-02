/* Discovarr's service worker: notifications only.
 *
 * Nothing is cached on purpose. Every page is rendered on the server, so a cache
 * could only ever hand back something stale; this worker exists so a phone that
 * is not even open can show a notification.
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

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
    icon: data.icon || '/favicon-midnight.png',
    badge: data.badge || '/favicon-midnight.png',
    tag: data.tag || 'discovarr',
    // One notification per kind, so three approvals do not stack up as three
    // panels on the lock screen.
    renotify: Boolean(data.tag),
    data: { url: data.href || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.notification.close()

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        if ('navigate' in client && new URL(client.url).pathname !== target) {
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
