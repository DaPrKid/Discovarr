/**
 * Release calendar as iCalendar (RFC 5545): all-day events, one per title, so
 * the same upcoming releases can be subscribed to from a phone or desktop
 * calendar. No dependencies — the format is a handful of folded lines.
 */

const PRODID = '-//Discovarr//Release calendar//EN'

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

function compactDate(iso) {
  return String(iso).slice(0, 10).replace(/-/g, '')
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function nextDay(iso) {
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** RFC 5545 lines are 75 octets at most; continuations start with a space. */
function fold(line) {
  if (line.length <= 74) return line

  const parts = [line.slice(0, 74)]
  let rest = line.slice(74)

  while (rest.length > 73) {
    parts.push(` ${rest.slice(0, 73)}`)
    rest = rest.slice(73)
  }
  if (rest) parts.push(` ${rest}`)

  return parts.join('\r\n')
}

export function buildReleaseCalendar({ appName = 'Discovarr', items = [], generatedAt = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`${appName} releases`)}`,
    `X-WR-CALDESC:${escapeText('Upcoming releases and your watchlist.')}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ]

  const seen = new Set()

  for (const item of items) {
    const releaseDate = item.releaseDate ?? item.release_date
    const tmdbId = item.tmdbId ?? item.tmdb_id
    const mediaType = item.mediaType ?? item.media_type ?? 'movie'
    const title = item.title
    if (!releaseDate || !tmdbId || !title) continue

    const key = `${mediaType}-${tmdbId}`
    if (seen.has(key)) continue
    seen.add(key)

    const kind = mediaType === 'tv' ? 'Series' : 'Film'

    lines.push(
      'BEGIN:VEVENT',
      `UID:discovarr-${key}@discovarr`,
      `DTSTAMP:${stamp(generatedAt)}`,
      `DTSTART;VALUE=DATE:${compactDate(releaseDate)}`,
      `DTEND;VALUE=DATE:${compactDate(nextDay(releaseDate))}`,
      `SUMMARY:${escapeText(title)}`,
      `DESCRIPTION:${escapeText(`${kind} release${item.watchlist ? ' on your watchlist' : ''}.`)}`,
      'TRANSP:TRANSPARENT',
      `CATEGORIES:${item.watchlist ? 'Watchlist' : 'Upcoming'}`,
      'END:VEVENT'
    )
  }

  lines.push('END:VCALENDAR')

  return `${lines.map(fold).join('\r\n')}\r\n`
}
