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
import { stylesVersion } from './assets.js'
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
 * The six themes, in the order the picker lists them. The choice is saved on the
 * account, so a phone and a desktop signed in as the same person match.
 */
export const THEMES = [
  ['midnight', 'Midnight'],
  ['cinema', 'Cinema'],
  ['teal', 'Deep Teal'],
  ['forest', 'Enchanted Forest'],
  ['sapphire', 'Midnight Sapphire'],
  ['crimson', 'Imperial Crimson'],
]

export const THEME_NAMES = THEMES.map(([name]) => name)

/** The appearance picker: on the account page, and in settings for admins. */
export function themeSelect({ label = 'Theme', className = 'rail-field' } = {}) {
  return `<label class="${escapeHtml(className)}">${escapeHtml(label)}
      <select data-theme-picker aria-label="${escapeHtml(label)}">
        ${THEMES.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}
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

function tabIcon(path) {
  return `<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}

/**
 * Four destinations on the bottom bar, the rest under the account chip. Six
 * items never fitted a phone: `.nav` was a row that could not wrap, and the two
 * it clipped were Settings and Activity.
 */
const TABS = [
  ['discover', '/', 'Discover', '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'],
  ['calendar', '/calendar', 'Calendar', '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/>'],
  ['watchlist', '/watchlist', 'Watchlist', '<path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.2L5.5 20.5v-16a1 1 0 0 1 1-1z"/>'],
  ['requests', '/requests', 'Requests', '<path d="M3.5 12.5 6 5.5h12l2.5 7v5.5a1.5 1.5 0 0 1-1.5 1.5h-13a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 12.5h4.5l1 2.5h6l1-2.5h4.5"/>'],
]

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

  const tab = ([key, href, label, icon]) =>
    `<a class="tab${active === key ? ' is-active' : ''}" href="${href}"${
      active === key ? ' aria-current="page"' : ''
    }>${tabIcon(icon)}<span class="tab-label">${label}</span></a>`

  return `<header class="topbar">
    <a class="brand" href="/">${mark()}<span class="brand-name">${escapeHtml(appName)}</span></a>
    <nav class="nav" aria-label="Sections">
      ${items
        .map(
          ([key, href, label]) =>
            `<a class="${active === key ? 'is-active' : ''}" href="${href}"${
              active === key ? ' aria-current="page"' : ''
            }>${label}</a>`
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
      <details class="menu" data-menu>
        <summary class="chip" title="Your account">${escapeHtml(user.username)}</summary>
        <div class="menu-body">
          <a href="/account">Account</a>
          <a href="/notifications">Notifications${unread ? ` <span class="menu-count">${unread > 99 ? '99+' : unread}</span>` : ''}</a>
          <a href="/activity"${active === 'activity' ? ' aria-current="page"' : ''}>Activity</a>
          ${canManageSettings ? `<a href="/settings"${active === 'settings' ? ' aria-current="page"' : ''}>Settings</a>` : ''}
          <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>
        </div>
      </details>
    </div>
  </header>
  <nav class="tabbar" aria-label="Sections">${TABS.map(tab).join('')}</nav>`

}

export function layout({ appName = 'Discovarr', title = '', user = null, active = '', body = '', canManageSettings = false, version = APP_VERSION }) {
  // The account's theme is rendered into the markup, so a phone shows the same
  // look the desk chose before the first paint rather than after a flash.
  const accountTheme = THEME_NAMES.includes(user?.theme) ? user.theme : ''

  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(accountTheme || 'midnight')}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escapeHtml(title)} · ${escapeHtml(appName)}</title>
    <link rel="stylesheet" href="/styles.css?v=${escapeHtml(stylesVersion)}" />
    <link rel="icon" type="image/png" href="/favicon-midnight.png" />
    <link rel="apple-touch-icon" id="apple-icon" href="/favicon-midnight.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" id="theme-color" content="#0c0e14" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="${escapeHtml(appName)}" />
    <script>
      // The look follows the account, so it is already in the markup. The copy
      // in localStorage is a fallback for signed-out pages, and it is refreshed
      // from the account on every render so an old browser choice cannot win.
      ;(function () {
        var root = document.documentElement
        var themes = ['midnight', 'cinema', 'teal', 'forest', 'sapphire', 'crimson']
        var accountTheme = '${accountTheme}'
        try {
          if (themes.indexOf(accountTheme) !== -1) {
            root.dataset.theme = accountTheme
            localStorage.setItem('discovarr-theme', accountTheme)
          } else {
            var saved = localStorage.getItem('discovarr-theme')
            if (themes.indexOf(saved) !== -1) root.dataset.theme = saved
          }
        } catch (error) {}
        // Hiding a sidebar is a per-browser choice, applied here so the grid
        // never jumps on load. Phones start with both panels tucked away.
        var panelFlags = { nav: 'hideNav', rail: 'hideRail' }
        Object.keys(panelFlags).forEach(function (panel) {
          var stored = null
          try { stored = localStorage.getItem('discovarr-' + panel) } catch (error) {}
          var hide = stored === null ? window.innerWidth < 900 : stored === 'hidden'
          if (hide) root.dataset[panelFlags[panel]] = '1'
          // With no saved choice the default follows the window, so a tablet
          // rotated into portrait folds its sidebars away without a reload.
          if (stored === null) {
            window.matchMedia('(max-width: 900px)').addEventListener('change', function (event) {
              if (event.matches) root.dataset[panelFlags[panel]] = '1'
              else delete root.dataset[panelFlags[panel]]
            })
          }
        })
        // Every theme has its own tab icon, drawn at 192px so the shape survives
        // the 16px a browser actually renders it at.
        var icon = document.querySelector('link[rel=icon]')
        var appleIcon = document.getElementById('apple-icon')
        var themeMeta = document.getElementById('theme-color')
        // The colours the CSS actually paints the window with, so the browser
        // chrome and a phone's status bar match the app instead of sitting black.
        var chrome = {
          midnight: '#0c0e14', cinema: '#0d0a08', teal: '#07100f',
          forest: '#0f1211', sapphire: '#060a15', crimson: '#0b0709'
        }
        function paintIcon(theme) {
          if (themes.indexOf(theme) === -1) return
          var href = '/favicon-' + theme + '.png'
          if (icon) icon.href = href
          if (appleIcon) appleIcon.href = href
          if (themeMeta && chrome[theme]) themeMeta.content = chrome[theme]
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
            // Saved to the account too, so the next device to sign in paints
            // this theme instead of whatever that browser remembered.
            fetch('/account/theme', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: 'theme=' + encodeURIComponent(picker.value)
            }).catch(function () {})
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
        // Destructive buttons ask first through data-confirm: a nonce-based
        // policy means an inline onclick attribute would never run at all.
        const guarded = event.target.closest('[data-confirm]')
        if (guarded && !window.confirm(guarded.dataset.confirm)) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        const opener = event.target.closest('[data-dialog-open]')
        if (opener) {
          const dialog = document.getElementById(opener.dataset.dialogOpen)
          if (dialog) dialog.showModal()
          return
        }
        const closer = event.target.closest('[data-dialog-close]')
        if (closer) closer.closest('dialog')?.close()
      })

      // A Request button on a card opens the same dialog the title page offers,
      // so the quality profile is chosen rather than assumed. Without this
      // script the form still posts, it just takes the default profile.
      ;(function () {
        var dialog = document.getElementById('card-request-dialog')
        if (!dialog) return
        var form = dialog.querySelector('[data-card-request-form]')
        if (!form) return
        var titleNode = dialog.querySelector('[data-card-request-title]')
        var submitNode = dialog.querySelector('[data-card-request-submit]')

        function setField(name, value) {
          var field = form.querySelector('[name="' + name + '"]')
          if (field) field.value = value
        }

        document.addEventListener('submit', function (event) {
          var trigger = event.target.closest ? event.target.closest('form[data-request-card]') : null
          if (!trigger) return
          event.preventDefault()
          var data = trigger.dataset
          var isTv = data.mediaType === 'tv'
          form.action = trigger.getAttribute('action') || '/media/import'
          setField('returnTo', data.returnTo || '/')
          setField('tmdbId', data.tmdbId || '')
          setField('mediaType', data.mediaType || 'movie')
          if (titleNode) titleNode.textContent = 'Request ' + (data.title || 'this title')
          if (submitNode) submitNode.textContent = 'Request ' + (isTv ? 'series' : 'movie')
          dialog.querySelectorAll('[data-card-request-profiles]').forEach(function (group) {
            var active = group.dataset.cardRequestProfiles === (isTv ? 'tv' : 'movie')
            group.hidden = !active
            group.querySelectorAll('select').forEach(function (select) {
              select.disabled = !active
              if (active) select.name = 'profile'
              else select.removeAttribute('name')
            })
          })
          dialog.showModal()
        })
      })()

      // The account menu is a <details>, so it opens without script; closing it
      // on an outside click and on Escape is what a menu is expected to do.
      ;(function () {
        var menu = document.querySelector('[data-menu]')
        if (!menu) return
        document.addEventListener('click', function (event) {
          if (menu.open && !menu.contains(event.target)) menu.open = false
        })
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape' && menu.open) menu.open = false
        })
      })()

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

      // Sidebar panels: a column beside the grid on a desk, a sheet that slides
      // over it on a phone or tablet. The desk remembers the choice per browser;
      // the sheet simply opens and closes, and the page behind it does not move.
      ;(function () {
        var root = document.documentElement
        var panelFlags = { nav: 'hideNav', rail: 'hideRail' }
        var sheet = window.matchMedia('(max-width: 1024px)')
        var scrim = document.querySelector('[data-drawer-scrim]')

        // The filter panel is a plain GET form, so choosing a network is a
        // full page load. Without carrying the open sheet across it, the panel
        // slammed shut on the first tick and the rest of the list was hidden
        // behind the thumb that closed it.
        function syncSheetField() {
          var field = document.querySelector('form.filter-rail [data-sheet-field]')
          if (field) field.value = sheet.matches ? root.dataset.drawer || '' : ''
        }

        function refresh() {
          var open = root.dataset.drawer || ''
          if (scrim) scrim.hidden = !open
          root.classList.toggle('has-drawer', Boolean(open))
          syncSheetField()
          document.querySelectorAll('[data-panel]').forEach(function (button) {
            var panel = button.dataset.panel
            var pressed = sheet.matches ? open === panel : root.dataset[panelFlags[panel]] !== '1'
            button.setAttribute('aria-pressed', pressed ? 'true' : 'false')
          })
        }

        function close() {
          if (!root.dataset.drawer) return
          delete root.dataset.drawer
          refresh()
        }

        document.querySelectorAll('[data-panel]').forEach(function (button) {
          var panel = button.dataset.panel
          button.addEventListener('click', function (event) {
            if (sheet.matches) {
              // One button opens and closes its sheet, so a thumb never has to
              // find a second target behind the panel it just opened.
              event.preventDefault()
              if (root.dataset.drawer === panel) close()
              else {
                root.dataset.drawer = panel
                refresh()
              }
              return
            }
            var hidden = root.dataset[panelFlags[panel]] === '1'
            if (hidden) delete root.dataset[panelFlags[panel]]
            else root.dataset[panelFlags[panel]] = '1'
            try {
              localStorage.setItem('discovarr-' + panel, hidden ? 'shown' : 'hidden')
            } catch (error) {}
            refresh()
            // The grid changes width when a panel goes, so anything laid out
            // against the old column count needs to know it moved.
            document.dispatchEvent(new CustomEvent('discovarr:panels'))
          })
        })

        if (scrim) scrim.addEventListener('click', close)
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') close()
        })
        // Picking something in the sheet is the end of the job, so it closes.
        document.querySelectorAll('.browse-nav a, .filter-rail a').forEach(function (link) {
          link.addEventListener('click', close)
        })
        sheet.addEventListener('change', function () {
          close()
          refresh()
        })
        // A sheet the previous page handed over reopens, so applying a filter
        // does not lose the panel it was applied from.
        if (sheet.matches) {
          var carried = ''
          try {
            carried = new URLSearchParams(window.location.search).get('sheet') || ''
          } catch (error) {}
          if (carried === 'nav' || carried === 'rail') root.dataset.drawer = carried
        }
        refresh()
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

      // A backed-up settings file restores by picking the file, not by pasting
      // its contents. The textarea stays for anyone without JavaScript.
      ;(function () {
        var form = document.querySelector('[data-restore-form]')
        if (!form) return
        var input = form.querySelector('[data-restore-file]')
        var payload = form.querySelector('[data-restore-payload]')
        var label = form.querySelector('[data-restore-name]')
        if (!input || !payload) return
        input.addEventListener('change', function () {
          var file = input.files && input.files[0]
          if (!file) {
            if (label) label.hidden = true
            return
          }
          file.text().then(function (text) {
            payload.value = text
            if (label) {
              label.textContent = 'Loaded ' + file.name + ' · ' + Math.round(file.size / 1024) + ' KB'
              label.hidden = false
            }
          }).catch(function () {})
        })
      })()

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

export function requestAction(item, local, returnTo, plex = null) {
  if (local && local.status === MediaStatus.AVAILABLE) {
    return '<span class="badge badge-available">Available</span>'
  }

  // Already playable in Plex: offering Request again would file a duplicate
  // for something the household can watch right now.
  if (plex) {
    return '<span class="badge badge-available">Available</span>'
  }

  // A title the download manager already holds is on its way even when the
  // request that put it there has been closed or failed, so the card says so
  // instead of offering a request the *arr would refuse.
  const queued =
    local &&
    (local.activeRequests > 0 ||
      local.myActiveRequests > 0 ||
      local.status === MediaStatus.PENDING ||
      local.status === MediaStatus.PROCESSING ||
      local.status === MediaStatus.PARTIALLY_AVAILABLE)

  if (queued) return '<span class="badge badge-pending">Requested</span>'

  const action = local ? `/media/${local.id}/request` : '/media/import'
  const tmdbId = local?.tmdbId ?? item?.tmdbId ?? ''
  const mediaType = local?.mediaType ?? item?.mediaType ?? MediaType.MOVIE
  const title = local?.title ?? item?.title ?? ''

  // The hidden fields keep this a working request without JavaScript. With it,
  // the layout script opens the same dialog the title page uses, so the quality
  // profile is asked for instead of assumed.
  return `<form method="post" action="${escapeHtml(action)}" data-request-card
      data-return-to="${escapeHtml(returnTo)}" data-tmdb-id="${escapeHtml(tmdbId)}"
      data-media-type="${escapeHtml(mediaType)}" data-title="${escapeHtml(title)}">
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
    ${
      local
        ? ''
        : `<input type="hidden" name="tmdbId" value="${escapeHtml(tmdbId)}" />
           <input type="hidden" name="mediaType" value="${escapeHtml(mediaType)}" />`
    }
    <button class="btn btn-sm" type="submit">Request</button>
  </form>`
}

/** A collection in the poster grid, for the collections filter. */
export function collectionCard(collection) {
  const parts = Array.isArray(collection.parts) ? collection.parts : []
  const cover = collection.posterPath ?? parts.find((part) => part.posterPath)?.posterPath ?? null
  const years = parts
    .map((part) => String(part.releaseDate ?? '').slice(0, 4))
    .filter(Boolean)
    .sort()
  const span = years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : ''
  const href = `/collection/${escapeHtml(String(collection.id))}`

  return `<article class="media-card collection-card">
    <a href="${href}" class="poster-link">${poster({
      id: collection.id,
      title: collection.name,
      posterPath: cover,
    })}<span class="collection-ribbon">Collection</span></a>
    <div class="media-body">
      <a class="media-title" href="${href}">${escapeHtml(collection.name)}</a>
      <p class="media-meta">${parts.length} film${parts.length === 1 ? '' : 's'}${
        span ? ` · ${escapeHtml(span)}` : ''
      }</p>
      <div class="media-actions"><a class="btn btn-sm btn-ghost" href="${href}">Open collection</a></div>
    </div>
  </article>`
}

/**
 * The quality-profile picker inside the shared request dialog. The select only
 * gets its name when the dialog decides which media type is being requested, so
 * the two pickers never both submit.
 */
function profilePickerBlock(profiles) {
  const list = Array.isArray(profiles) ? profiles : []

  if (list.length === 0) {
    return '<p class="muted small">No Radarr or Sonarr profile is set up for this yet, so the request waits for an administrator.</p>'
  }

  if (list.length === 1) {
    return `<div class="request-profile profile-readout">
      <span class="muted small">Quality profile</span>
      <strong>${escapeHtml(list[0].name)}</strong>
      ${list[0].profileName ? `<span class="muted small">${escapeHtml(list[0].profileName)}</span>` : ''}
    </div>`
  }

  return `<label class="request-profile">Quality profile
    <select data-profile-select>
      ${list
        .map(
          (profile, index) =>
            `<option value="${index}" ${profile.isDefault ? 'selected' : ''}>${escapeHtml(profile.name)}${
              profile.isDefault ? ' (default)' : ''
            }</option>`
        )
        .join('')}
    </select>
  </label>`
}

/**
 * One request dialog for the whole page, so the Request button on any card asks
 * the same questions as the title page instead of filing with a guessed profile.
 */
export function cardRequestDialog({ movieProfiles = [], tvProfiles = [] } = {}) {
  return `<dialog class="dialog request-dialog" id="card-request-dialog">
    <form method="post" action="/media/import" class="stack" data-card-request-form>
      <input type="hidden" name="returnTo" value="/" />
      <input type="hidden" name="tmdbId" value="" />
      <input type="hidden" name="mediaType" value="movie" />
      <div class="dialog-head">
        <h2 data-card-request-title>Request</h2>
        <button class="icon-btn" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <p class="muted small" data-card-request-note>Pick the quality profile the download should use. A series request covers every season; open its page to pick single seasons.</p>
      <div data-card-request-profiles="movie">${profilePickerBlock(movieProfiles)}</div>
      <div data-card-request-profiles="tv" hidden>${profilePickerBlock(tvProfiles)}</div>
      <div class="request-actions">
        <button class="btn" type="submit" data-card-request-submit>Request</button>
        <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
      </div>
    </form>
  </dialog>`
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
