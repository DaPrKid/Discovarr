import {
  APP_VERSION,
  MEDIA_STATUS_LABEL,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  Permission,
  PERMISSION_LABELS,
  REQUEST_STATUS_LABEL,
  Role,
} from './constants.js'
import { countUnreadNotifications, listNotifications } from './db.js'
import { imageUrl } from './tmdb.js'

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]
  )
}

/**
 * Attributes that turn any title element into a hover preview. The basics are
 * inline so the card can open instantly; the description is fetched once from
 * /preview when the title is first hovered.
 */
export function previewAttrs({ mediaType, tmdbId, title, meta = '', overview = '', posterPath = null } = {}) {
  if (!mediaType || !tmdbId) return ''

  const poster = posterPath ? `/img/w154/${String(posterPath).replace(/^\//, '')}` : ''
  const pairs = [
    ['data-preview', '1'],
    ['data-preview-url', `/preview/${mediaType}/${tmdbId}`],
    ['data-preview-title', title ?? ''],
    ['data-preview-meta', meta],
    ['data-preview-poster', poster],
  ]

  if (overview) pairs.push(['data-preview-overview', overview])

  return pairs.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('')
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The mark beside the wordmark. Drawn inline rather than shipped as a PNG so it
 * can take the colour of whichever theme is active; the stops read the same
 * --brand-a/--brand-b variables the wordmark is painted with.
 */
function mark() {
  return `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="mark-tint" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--brand-a)" />
          <stop offset="1" stop-color="var(--brand-b)" />
        </linearGradient>
      </defs>
      <path class="mark-handle" d="M40.5 40.5 L55 55" stroke="url(#mark-tint)" />
      <circle class="mark-ring" cx="27" cy="27" r="17.5" stroke="url(#mark-tint)" />
      <circle class="mark-disc" cx="27" cy="27" r="13.5" />
      <path class="mark-play" d="M23 20.5 L34.5 27 L23 33.5 Z" />
    </svg>`
}

/**
 * The appearance picker. It lives on the settings page now; the choice is
 * remembered per browser, which is where a theme belongs.
 */
export function themeSelect({ label = 'Theme', className = 'rail-field' } = {}) {
  return `<label class="${escapeHtml(className)}">${escapeHtml(label)}
      <select data-theme-picker aria-label="${escapeHtml(label)}">
        <option value="midnight">Midnight</option>
        <option value="cinema">Cinema</option>
        <option value="teal">Deep Teal</option>
        <option value="forest">Enchanted Forest</option>
        <option value="sapphire">Midnight Sapphire</option>
        <option value="crimson">Imperial Crimson</option>
      </select>
    </label>`
}

/** The last few notifications, for the panel the bell opens. */
function notificationPanel(items) {
  const list = items.length
    ? `<ul class="notif-list">${items
        .map(
          (item) => `<li class="notif-item${item.readAt ? '' : ' is-unread'}">
            <a href="${escapeHtml(item.href || '/notifications')}">${escapeHtml(item.title)}</a>
            <span class="muted small">${escapeHtml(item.createdAt.slice(0, 16).replace('T', ' '))}</span>
          </li>`
        )
        .join('')}</ul>`
    : '<p class="muted small notif-empty">Nothing yet. Approvals, declines and titles arriving show up here.</p>'

  return `<div class="notif-pop" id="notif-pop" hidden>
      <div class="notif-pop-head">
        <strong>Notifications</strong>
        <a class="inline-link small" href="/notifications">See all</a>
      </div>
      ${list}
    </div>`
}

function navigation({ user, active, appName, canManageSettings }) {
  const items = [
    ['discover', '/', 'Discover'],
    ['calendar', '/calendar', 'Calendar'],
    ['watchlist', '/watchlist', 'Watchlist'],
    ['requests', '/requests', 'Requests'],
    ['activity', '/activity', 'Activity'],
  ]

  if (canManageSettings) items.push(['settings', '/settings', 'Settings'])

  const unread = user?.id ? countUnreadNotifications(user.id) : 0
  const recent = user?.id ? listNotifications(user.id, 6) : []

  return `<header class="topbar">
    <a class="brand" href="/">${mark()}<span class="brand-name">${escapeHtml(appName)}</span></a>
    <nav class="nav">
      ${items
        .map(
          ([key, href, label]) =>
            `<a class="${active === key ? 'is-active' : ''}" href="${href}">${label}</a>`
        )
        .join('')}
    </nav>
    <div class="account">
      <div class="notif">
        <a class="bell" href="/notifications" data-notif-toggle aria-expanded="false" aria-controls="notif-pop" aria-label="Notifications${unread ? `, ${unread} unread` : ''}" title="Notifications">
          <span aria-hidden="true">✉</span>${unread ? `<span class="bell-count">${unread > 99 ? '99+' : unread}</span>` : ''}
        </a>
        ${notificationPanel(recent)}
      </div>
      <a class="chip" href="/account">${escapeHtml(user.username)}</a>
      <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>
    </div>
  </header>`
}

export function layout({ appName = 'Discovarr', title = '', user = null, active = '', body = '', canManageSettings = false, version = APP_VERSION }) {
  return `<!doctype html>
<html lang="en" data-theme="midnight">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escapeHtml(title)} · ${escapeHtml(appName)}</title>
    <link rel="stylesheet" href="/styles.css?v=${escapeHtml(version)}" />
    <link rel="icon" type="image/png" href="/favicon-midnight.png" />
    <script>
      // The chosen look is stored per browser, so it is applied before the first
      // paint and never flashes the default theme.
      ;(function () {
        var root = document.documentElement
        var themes = ['midnight', 'cinema', 'teal', 'forest', 'sapphire', 'crimson']
        try {
          var saved = localStorage.getItem('discovarr-theme')
          if (themes.indexOf(saved) !== -1) root.dataset.theme = saved
        } catch (error) {}
        // Hiding a sidebar is a per-browser choice, applied here so the grid
        // never jumps on load. Phones start with both panels tucked away.
        var panelFlags = { nav: 'hideNav', rail: 'hideRail' }
        Object.keys(panelFlags).forEach(function (panel) {
          var stored = null
          try { stored = localStorage.getItem('discovarr-' + panel) } catch (error) {}
          var hide = stored === null ? window.innerWidth < 900 : stored === 'hidden'
          if (hide) root.dataset[panelFlags[panel]] = '1'
        })
        // Every theme has its own tab icon, drawn at 192px so the shape survives
        // the 16px a browser actually renders it at.
        var icon = document.querySelector('link[rel=icon]')
        function paintIcon(theme) {
          if (icon && themes.indexOf(theme) !== -1) icon.href = '/favicon-' + theme + '.png'
        }
        paintIcon(root.dataset.theme)
        document.addEventListener('DOMContentLoaded', function () {
          var picker = document.querySelector('[data-theme-picker]')
          if (!picker) return
          picker.value = root.dataset.theme
          picker.addEventListener('change', function () {
            root.dataset.theme = picker.value
            paintIcon(picker.value)
            try { localStorage.setItem('discovarr-theme', picker.value) } catch (error) {}
          })
        })
      })()
    </script>
  </head>
  <body>
    ${
      user
        ? navigation({ user, active, appName, canManageSettings })
        : `<header class="topbar"><span class="brand">${mark()}<span class="brand-name">${escapeHtml(appName)}</span></span></header>`
    }
    <main class="page">${body}</main>
    <div class="hover-card" id="hover-card" hidden></div>
    <script>
      // Profile dialogs and "where to watch" toggles: tiny, no dependencies.
      document.addEventListener('click', (event) => {
        const opener = event.target.closest('[data-dialog-open]')
        if (opener) {
          const dialog = document.getElementById(opener.dataset.dialogOpen)
          if (dialog) dialog.showModal()
          return
        }
        const closer = event.target.closest('[data-dialog-close]')
        if (closer) closer.closest('dialog')?.close()
      })

      // The bell opens a small panel over the page instead of leaving it, and
      // the same button closes it again, so a glance never loses your place.
      ;(function () {
        var toggle = document.querySelector('[data-notif-toggle]')
        var pop = document.getElementById('notif-pop')
        if (!toggle || !pop) return
        function close() {
          pop.hidden = true
          toggle.setAttribute('aria-expanded', 'false')
        }
        function open() {
          pop.hidden = false
          toggle.setAttribute('aria-expanded', 'true')
        }
        toggle.addEventListener('click', function (event) {
          event.preventDefault()
          if (pop.hidden) open()
          else close()
          return false
        })
        document.addEventListener('click', function (event) {
          if (pop.hidden) return
          if (pop.contains(event.target) || toggle.contains(event.target)) return
          close()
        })
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') close()
        })
      })()

      // Sidebar toggles: the choice is remembered per browser, and a hidden
      // panel gives its column back to the poster grid.
      ;(function () {
        var root = document.documentElement
        var panelFlags = { nav: 'hideNav', rail: 'hideRail' }
        function apply(panel, hidden) {
          if (hidden) root.dataset[panelFlags[panel]] = '1'
          else delete root.dataset[panelFlags[panel]]
          document.querySelectorAll('[data-panel="' + panel + '"]').forEach(function (button) {
            button.setAttribute('aria-pressed', hidden ? 'false' : 'true')
          })
        }
        document.querySelectorAll('[data-panel]').forEach(function (button) {
          var panel = button.dataset.panel
          apply(panel, root.dataset[panelFlags[panel]] === '1')
          button.addEventListener('click', function () {
            var hidden = root.dataset[panelFlags[panel]] === '1'
            apply(panel, !hidden)
            try {
              localStorage.setItem('discovarr-' + panel, hidden ? 'shown' : 'hidden')
            } catch (error) {}
            // The grid changes width when a panel goes, so anything laid out
            // against the old column count needs to know it moved.
            document.dispatchEvent(new CustomEvent('discovarr:panels'))
          })
        })
      })()

      // A last row that stops short of the edge reads as a broken grid, so the
      // grid borrows just enough titles from the next page to finish the row it
      // is on. It reuses the server's own card markup, and asks for nothing when
      // the row already ends flush or there is no next page.
      ;(function () {
        var grid = document.querySelector('.grid[data-fill]')
        if (!grid) return
        var next = document.querySelector('.pager a[rel=next]')
        if (!next) return

        var base = grid.children.length
        var pool = null
        var requested = false
        var appended = []

        function columns() {
          var first = grid.firstElementChild
          if (!first) return 0
          var top = Math.round(first.getBoundingClientRect().top)
          var count = 0
          for (var node = first; node; node = node.nextElementSibling) {
            if (Math.round(node.getBoundingClientRect().top) !== top) break
            count++
          }
          return count
        }

        function wanted() {
          var cols = columns()
          if (cols < 2) return 0
          return (cols - (base % cols)) % cols
        }

        function trim(keep) {
          while (appended.length > keep) appended.pop().remove()
        }

        function extend(keep) {
          while (appended.length < keep && pool && pool[appended.length]) {
            var card = pool[appended.length].cloneNode(true)
            card.setAttribute('data-filler', '')
            grid.appendChild(card)
            appended.push(card)
          }
        }

        function fill() {
          var keep = wanted()
          if (appended.length > keep) return trim(keep)
          if (appended.length === keep) return
          if (pool) return extend(keep)
          if (requested) return
          requested = true
          fetch(next.href, { credentials: 'same-origin' })
            .then(function (response) { return response.ok ? response.text() : '' })
            .then(function (html) {
              var doc = new DOMParser().parseFromString(html, 'text/html')
              pool = Array.prototype.slice.call(doc.querySelectorAll('.grid > .media-card'))
              fill()
            })
            .catch(function () { pool = [] })
        }

        fill()
        var timer = null
        function refill() {
          clearTimeout(timer)
          timer = setTimeout(fill, 150)
        }
        window.addEventListener('resize', refill)
        document.addEventListener('discovarr:panels', refill)
      })()

      // Discover search suggests titles as you type. Leaving the field and
      // pressing the button still runs the plain GET form, so nothing depends
      // on this script or on the suggestion endpoint being reachable.
      ;(function () {
        var form = document.querySelector('form.search[data-suggest]')
        if (!form) return
        var input = form.querySelector('input[type=search]')
        var panel = document.createElement('div')
        panel.className = 'search-suggest'
        panel.setAttribute('role', 'listbox')
        panel.hidden = true
        form.appendChild(panel)

        var timer = null
        var controller = null
        var active = -1
        var items = []

        function escapeText(value) {
          return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
          })
        }

        function close() {
          panel.hidden = true
          panel.innerHTML = ''
          items = []
          active = -1
        }

        function paint() {
          if (!items.length) return close()
          panel.innerHTML = items
            .map(function (entry, index) {
              var thumb = entry.posterPath
                ? '<img class="suggest-poster" src="/img/w92/' +
                  escapeText(String(entry.posterPath).charAt(0) === '/'
                    ? String(entry.posterPath).slice(1)
                    : String(entry.posterPath)) +
                  '" alt="" loading="lazy" />'
                : '<span class="suggest-poster is-empty" aria-hidden="true"></span>'
              return (
                '<a class="suggest-item' + (index === active ? ' is-active' : '') +
                '" role="option" aria-selected="' + (index === active) +
                '" href="' + escapeText(entry.href) + '">' + thumb +
                '<span class="suggest-text"><span class="suggest-title">' + escapeText(entry.title) +
                '</span><span class="suggest-meta">' + escapeText(entry.meta) + '</span></span>' +
                (entry.available ? '<span class="badge badge-available">Available</span>' : '') +
                '</a>'
              )
            })
            .join('')
          panel.hidden = false
        }

        function load() {
          var value = input.value.trim()
          if (value.length < 2) return close()
          var type = form.querySelector('input[name=type]')
          var url =
            form.dataset.suggest + '?q=' + encodeURIComponent(value) +
            (type && type.value ? '&type=' + encodeURIComponent(type.value) : '')
          if (controller) controller.abort()
          controller = new AbortController()
          fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: controller.signal })
            .then(function (response) { return response.ok ? response.json() : { results: [] } })
            .then(function (data) {
              items = Array.isArray(data.results) ? data.results : []
              active = -1
              paint()
            })
            .catch(function () {})
        }

        input.setAttribute('autocomplete', 'off')
        input.addEventListener('input', function () {
          clearTimeout(timer)
          timer = setTimeout(load, 180)
        })
        input.addEventListener('keydown', function (event) {
          if (panel.hidden || !items.length) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
            paint()
          } else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault()
            window.location.href = items[active].href
          } else if (event.key === 'Escape') {
            close()
          }
        })
        document.addEventListener('click', function (event) {
          if (!form.contains(event.target)) close()
        })
      })()

      // The filter panel applies as soon as a toggle or menu changes; the
      // Apply button keeps it usable (and submit-only) without this script.
      ;(function () {
        var panel = document.querySelector('form.filter-rail[data-filter-form]')
        if (!panel) return
        panel.addEventListener('change', function (event) {
          var field = event.target
          if (field.matches('input[type=checkbox], input[type=radio], select')) panel.requestSubmit()
        })
      })()

      // Each filter group remembers whether it was open. Without this the page
      // redraws the panel on every change and unticking the last network or
      // studio folds the group you were working in.
      ;(function () {
        var rail = document.querySelector('form.filter-rail')
        if (!rail) return
        var key = 'discovarr-rail-groups'
        var saved = {}
        try {
          saved = JSON.parse(localStorage.getItem(key) || '{}') || {}
        } catch (error) {
          saved = {}
        }
        rail.querySelectorAll('details.rail-group[data-group]').forEach(function (group) {
          var name = group.dataset.group
          if (typeof saved[name] === 'boolean') group.open = saved[name]
          group.addEventListener('toggle', function () {
            saved[name] = group.open
            try {
              localStorage.setItem(key, JSON.stringify(saved))
            } catch (error) {}
          })
        })
      })()
    
      // "All seasons" hides and disables the season boxes; without this script
      // the same fields still post, just with the list open.
      document.querySelectorAll('[data-season-all]').forEach(function (toggle) {
        var form = toggle.closest('form')
        var list = form ? form.querySelector('[data-season-list]') : null
        if (!list) return
        var sync = function () {
          list.hidden = toggle.checked
          list.querySelectorAll('input[type=checkbox]').forEach(function (input) {
            input.disabled = toggle.checked
          })
        }
        toggle.addEventListener('change', sync)
        sync()
      })

      // Episode lists load the first time a season is opened.
      document.querySelectorAll('details[data-episodes]').forEach(function (block) {
        block.addEventListener('toggle', function () {
          if (!block.open || block.dataset.loaded) return
          block.dataset.loaded = '1'
          var target = block.querySelector('.episode-list')
          fetch(block.dataset.episodes, { headers: { accept: 'text/html' }, credentials: 'same-origin' })
            .then(function (response) { return response.ok ? response.text() : 'Episodes could not be loaded.' })
            .then(function (html) { if (target) target.innerHTML = html })
            .catch(function () { if (target) target.textContent = 'Episodes could not be loaded.' })
        })
      })

      // "Select all" in the collection panel leaves films already held alone.
      document.querySelectorAll('[data-collection-all]').forEach(function (toggle) {
        var form = toggle.closest('form')
        if (!form) return
        toggle.addEventListener('change', function () {
          form.querySelectorAll('[data-collection-part]').forEach(function (input) {
            if (!input.disabled) input.checked = toggle.checked
          })
        })
      })

      // Hover previews: every title carries its own summary inline, and the
      // description is fetched once the first time it is hovered. Pointer, touch
      // and keyboard all work, and the card is kept inside the window.
      ;(function () {
        var card = document.getElementById('hover-card')
        if (!card || !window.fetch) return

        var cache = {}
        var showing = null

        card.innerHTML =
          '<div class="hover-art"><img alt="" loading="lazy" /></div>' +
          '<div class="hover-text"><strong class="hover-title"></strong>' +
          '<span class="hover-meta"></span><p class="hover-overview"></p></div>'

        var art = card.querySelector('.hover-art')
        var image = card.querySelector('img')
        var titleNode = card.querySelector('.hover-title')
        var metaNode = card.querySelector('.hover-meta')
        var overviewNode = card.querySelector('.hover-overview')

        function place(x, y) {
          card.style.left = '0px'
          card.style.top = '0px'
          var box = card.getBoundingClientRect()
          var left = Math.max(12, Math.min(x + 16, window.innerWidth - box.width - 12))
          var top = y + 18
          if (top + box.height > window.innerHeight - 12) top = Math.max(12, y - box.height - 18)
          card.style.left = left + 'px'
          card.style.top = top + 'px'
        }

        function hide() {
          showing = null
          card.hidden = true
        }

        function fill(node) {
          titleNode.textContent = node.dataset.previewTitle || ''
          metaNode.textContent = node.dataset.previewMeta || ''
          overviewNode.textContent = node.dataset.previewOverview || 'Loading the description…'
          var poster = node.dataset.previewPoster || ''
          art.hidden = !poster
          if (poster) image.src = poster
          return node
        }

        function overviewFor(node) {
          if (node.dataset.previewOverview) return
          var url = node.dataset.previewUrl
          if (!url) return
          if (!cache[url]) {
            cache[url] = fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
              .then(function (response) { return response.ok ? response.json() : null })
              .catch(function () { return null })
          }
          cache[url].then(function (data) {
            if (showing !== node) return
            overviewNode.textContent =
              data && data.overview ? data.overview : 'No description is available for this title yet.'
            if (data && data.meta && !node.dataset.previewMeta) metaNode.textContent = data.meta
            if (data && data.posterPath && !node.dataset.previewPoster) {
              art.hidden = false
              var art = String(data.posterPath)
              if (art.charAt(0) === '/') art = art.slice(1)
              image.src = '/img/w154/' + art
            }
          })
        }

        function consider(target, x, y) {
          var node = target && target.closest ? target.closest('[data-preview]') : null
          if (!node || node === showing) return
          showing = fill(node)
          card.hidden = false
          place(x, y)
          overviewFor(node)
        }

        document.addEventListener('pointerover', function (event) {
          consider(event.target, event.clientX, event.clientY)
        })
        document.addEventListener('pointermove', function (event) {
          if (!showing) return
          var node = event.target.closest ? event.target.closest('[data-preview]') : null
          if (!node) return hide()
          place(event.clientX, event.clientY)
        })
        document.addEventListener('focusin', function (event) {
          var node = event.target.closest ? event.target.closest('[data-preview]') : null
          if (!node) return
          var box = node.getBoundingClientRect()
          consider(node, box.left, box.bottom - 10)
        })
        document.addEventListener('focusout', hide)
        document.addEventListener('scroll', hide, true)
        document.addEventListener('keydown', function (event) { if (event.key === 'Escape') hide() })
      })()

</script>
  </body>
</html>`
}

export function alert({ notice, error } = {}) {
  return `${notice ? `<p class="alert alert-ok">${escapeHtml(notice)}</p>` : ''}${
    error ? `<p class="alert alert-err">${escapeHtml(error)}</p>` : ''
  }`
}

// ---------------------------------------------------------------------------
// Media pieces
// ---------------------------------------------------------------------------

export function poster(media, extraClass = '') {
  const artwork = imageUrl(media.posterPath, 'w342')

  if (artwork) {
    return `<div class="poster ${extraClass}">
      <img src="/img/w342/${escapeHtml(String(media.posterPath).replace(/^\//, ''))}" alt="${escapeHtml(media.title)} poster" loading="lazy" />
    </div>`
  }

  const hue = ((Number(media.id) || Number(media.tmdbId) || 1) * 47 + 205) % 360
  const initials = String(media.title ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()

  return `<div class="poster ${extraClass}" style="--hue:${hue}"><span>${escapeHtml(initials)}</span></div>`
}

function requestAction(item, local, returnTo, plex = null) {
  if (local && local.status === MediaStatus.AVAILABLE) {
    return '<span class="badge badge-available">Available</span>'
  }

  // Already playable in Plex: offering Request again would file a duplicate
  // for something the household can watch right now.
  if (plex) {
    return '<span class="badge badge-available">Available</span>'
  }

  if (local && (local.activeRequests > 0 || local.myActiveRequests > 0)) {
    return '<span class="badge badge-pending">Requested</span>'
  }

  if (local) {
    return `<form method="post" action="/media/${local.id}/request">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
      ${local.mediaType === MediaType.TV ? '<input type="hidden" name="allSeasons" value="1" />' : ''}
      <button class="btn btn-sm" type="submit">Request</button>
    </form>`
  }

  return `<form method="post" action="/media/import">
    <input type="hidden" name="tmdbId" value="${escapeHtml(item.tmdbId)}" />
    <input type="hidden" name="mediaType" value="${escapeHtml(item.mediaType)}" />
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
    <button class="btn btn-sm" type="submit">Request</button>
  </form>`
}

export function mediaCard(item, { returnTo = '/', local = null, plex = null } = {}) {
  const entry = local ?? (item.id ? item : null)
  // A seeded or imported row can lack artwork while TMDB has it; prefer the
  // local record but borrow the poster rather than falling back to initials.
  const view = { ...(entry ?? item) }
  if (!view.posterPath && item?.posterPath) view.posterPath = item.posterPath

  const mediaType = view.mediaType ?? item.mediaType
  const meta =
    mediaType === MediaType.TV
      ? `Series${view.seasonsCount ? ` · ${view.seasonsCount} seasons` : ''}`
      : `Movie${view.runtime ? ` · ${view.runtime} min` : ''}`

  const year = view.releaseDate?.slice(0, 4)
  // Every card opens a detail page: the local record when it exists, otherwise
  // the TMDB-backed page for a title that has not been requested yet.
  const href = entry ? `/media/${entry.id}` : `/title/${mediaType}/${item.tmdbId}`
  const title = escapeHtml(view.title ?? item.title)
  const preview = previewAttrs({
    mediaType,
    tmdbId: view.tmdbId ?? item.tmdbId,
    title: view.title ?? item.title,
    meta: `${meta}${year ? ` · ${year}` : ''}`,
    overview: view.overview ?? item.overview ?? '',
    posterPath: view.posterPath ?? item.posterPath ?? null,
  })

  return `<article class="media-card">
    <a href="${href}" class="poster-link"${preview}>${poster(view)}${
      plex ? '<span class="plex-ribbon" title="Available on Plex">Plex</span>' : ''
    }</a>
    <div class="media-body">
      <a class="media-title" href="${href}"${preview}>${title}</a>
      <p class="media-meta">${escapeHtml(meta)}${year ? ` · ${escapeHtml(year)}` : ''}</p>
      <div class="media-actions">${requestAction(item, entry, returnTo, plex)}${
        plex
          ? `<a class="btn btn-sm btn-plex" href="${escapeHtml(plex.playUrl)}" target="_blank" rel="noreferrer noopener" title="Play ${title} on Plex" aria-label="Play ${title} on Plex">▶ Play</a>`
          : ''
      }</div>
    </div>
  </article>`
}

export function requestStatusBadge(status) {
  const key = { 1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'completed' }[status] ?? 'pending'
  return `<span class="badge badge-${key}">${escapeHtml(REQUEST_STATUS_LABEL[status] ?? 'Unknown')}</span>`
}

export function requestCard(request, { canManage = false, bulk = false } = {}) {
  const seasons = request.seasons?.length
    ? `Season${request.seasons.length > 1 ? 's' : ''} ${request.seasons.join(', ')}`
    : request.media?.mediaType === MediaType.MOVIE
      ? 'Movie'
      : ''

  const actions = []

  if (canManage && (request.status === MediaRequestStatus.PENDING || request.status === MediaRequestStatus.FAILED)) {
    actions.push(
      `<form method="post" action="/requests/${request.id}/approve"><button class="btn btn-sm" type="submit">${request.status === MediaRequestStatus.FAILED ? 'Retry' : 'Approve'}</button></form>`
    )
  }

  if (canManage && request.status === MediaRequestStatus.PENDING) {
    actions.push(
      `<form method="post" action="/requests/${request.id}/decline"><button class="btn btn-sm btn-ghost" type="submit">Decline</button></form>`
    )
  }

  if (canManage) {
    actions.push(
      `<form method="post" action="/media/${request.mediaId}/available"><button class="btn btn-sm btn-ghost" type="submit">Mark available</button></form>`
    )
  }

  if (canManage || request.status === MediaRequestStatus.PENDING) {
    actions.push(
      `<form method="post" action="/requests/${request.id}/delete"><button class="btn btn-sm btn-danger" type="submit">Remove</button></form>`
    )
  }

  // The checkbox belongs to the bulk form outside the list: forms cannot be
  // nested, so it opts in with the form attribute instead.
  const tick = bulk
    ? `<input class="request-tick" type="checkbox" name="ids" value="${request.id}" form="bulk" aria-label="Select request ${request.id}" />`
    : ''

  return `<article class="request-card${bulk ? ' has-tick' : ''}">
    ${tick}
    <div class="request-head">
      <a class="request-title" href="/media/${request.mediaId}">${escapeHtml(request.media?.title ?? 'Unknown title')}</a>
      ${requestStatusBadge(request.status)}
    </div>
    <p class="media-meta">${escapeHtml(seasons)}${request.requester ? ` · requested by ${escapeHtml(request.requester.username)}` : ''} · ${escapeHtml(request.createdAt.slice(0, 10))}</p>
    ${request.note ? `<p class="note">${escapeHtml(request.note)}</p>` : ''}
    <div class="request-actions">${actions.join('')}</div>
  </article>`
}

export function pagination({ page, totalPages, basePath, params = {} }) {
  if (totalPages <= 1) return ''

  const link = (target, label, className = 'tab', rel = '') => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, String(value))
    search.set('page', String(target))
    return `<a class="${className}"${rel ? ` rel="${rel}"` : ''} href="${basePath}?${search}">${label}</a>`
  }

  return `<nav class="pager">
    ${page > 1 ? link(page - 1, '← Previous', 'tab', 'prev') : '<span class="tab is-disabled">← Previous</span>'}
    <span class="muted small">Page ${page} of ${totalPages}</span>
    ${page < totalPages ? link(page + 1, 'Next →', 'tab', 'next') : '<span class="tab is-disabled">Next →</span>'}
  </nav>`
}

export function statusBadge(status) {
  const key =
    status === MediaStatus.AVAILABLE
      ? 'available'
      : status === MediaStatus.PENDING
        ? 'pending'
        : status === MediaStatus.PARTIALLY_AVAILABLE
          ? 'processing'
          : 'processing'

  return `<span class="badge badge-${key}">${escapeHtml(MEDIA_STATUS_LABEL[status] ?? 'Unknown')}</span>`
}

export function permissionList(permissions, role) {
  if (role === Role.ADMIN) return '<span class="badge badge-approved">all permissions</span>'

  const labels = Object.entries(Permission)
    .filter(([, flag]) => (permissions & flag) === flag)
    .map(([name]) => PERMISSION_LABELS[Permission[name]] ?? name)

  return labels.length
    ? labels.map((label) => `<span class="badge badge-pending">${escapeHtml(label)}</span>`).join(' ')
    : '<span class="muted small">none</span>'
}
