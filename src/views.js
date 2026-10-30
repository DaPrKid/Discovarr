import {
  MEDIA_STATUS_LABEL,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  Permission,
  PERMISSION_LABELS,
  REQUEST_STATUS_LABEL,
  Role,
} from './constants.js'
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

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function navigation({ user, active, appName, canManageSettings }) {
  const items = [
    ['discover', '/', 'Discover'],
    ['requests', '/requests', 'Requests'],
  ]

  if (canManageSettings) items.push(['settings', '/settings', 'Settings'])

  return `<header class="topbar">
    <a class="brand" href="/">${escapeHtml(appName)}</a>
    <nav class="nav">
      ${items
        .map(
          ([key, href, label]) =>
            `<a class="${active === key ? 'is-active' : ''}" href="${href}">${label}</a>`
        )
        .join('')}
    </nav>
    <div class="account">
      <a class="chip" href="/account">${escapeHtml(user.username)}<em>${escapeHtml(user.role)}</em></a>
      <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>
    </div>
  </header>`
}

export function layout({ appName = 'Discovarr', title = '', user = null, active = '', body = '', canManageSettings = false }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · ${escapeHtml(appName)}</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    ${
      user
        ? navigation({ user, active, appName, canManageSettings })
        : `<header class="topbar"><span class="brand">${escapeHtml(appName)}</span></header>`
    }
    <main class="page">${body}</main>
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

function requestAction(item, local, returnTo) {
  if (local && local.status === MediaStatus.AVAILABLE) {
    return '<span class="badge badge-available">Available</span>'
  }

  if (local && local.myActiveRequests > 0) {
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

  return `<article class="media-card">
    <a href="${href}" class="poster-link">${poster(view)}${
      plex ? '<span class="plex-ribbon" title="Available on Plex">Plex</span>' : ''
    }</a>
    <div class="media-body">
      <a class="media-title" href="${href}">${title}</a>
      <p class="media-meta">${escapeHtml(meta)}${year ? ` · ${escapeHtml(year)}` : ''}</p>
      <div class="media-actions">${requestAction(item, entry, returnTo)}${
        plex
          ? `<a class="btn btn-sm btn-plex" href="${escapeHtml(plex.playUrl)}" target="_blank" rel="noreferrer noopener">▶ Play on Plex</a>`
          : ''
      }</div>
    </div>
  </article>`
}

export function requestStatusBadge(status) {
  const key = { 1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'completed' }[status] ?? 'pending'
  return `<span class="badge badge-${key}">${escapeHtml(REQUEST_STATUS_LABEL[status] ?? 'Unknown')}</span>`
}

export function requestCard(request, { canManage = false } = {}) {
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

  return `<article class="request-card">
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

  const link = (target, label, className = 'tab') => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, String(value))
    search.set('page', String(target))
    return `<a class="${className}" href="${basePath}?${search}">${label}</a>`
  }

  return `<nav class="pager">
    ${page > 1 ? link(page - 1, '← Previous') : '<span class="tab is-disabled">← Previous</span>'}
    <span class="muted small">Page ${page} of ${totalPages}</span>
    ${page < totalPages ? link(page + 1, 'Next →') : '<span class="tab is-disabled">Next →</span>'}
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
