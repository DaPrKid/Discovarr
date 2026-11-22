import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { config } from './config.js'

/**
 * The brand lists, kept as JSON under the data directory.
 *
 * Two of them live here: TMDB's daily network export and its watch-provider list
 * for the configured region. Both are slow-moving, both are needed to name a
 * filter that was saved months ago, and both are worthless if a restart while
 * TMDB is unreachable throws them away, so they share one file format and one
 * place on disk.
 */

function fileFor(name) {
  return join(dirname(config.databaseFile), 'brands', `${name}.json`)
}

/** `{ fetchedAt, items, ...extra }` from disk, or null when there is nothing usable. */
export function readBrandCache(name) {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(name), 'utf8'))
    return Array.isArray(parsed?.items) && parsed.items.length ? parsed : null
  } catch {
    return null
  }
}

export function writeBrandCache(name, items, extra = {}) {
  try {
    mkdirSync(dirname(fileFor(name)), { recursive: true })
    writeFileSync(fileFor(name), JSON.stringify({ fetchedAt: new Date().toISOString(), ...extra, items }))
  } catch {
    // A read-only data directory still leaves the list usable in memory.
  }
}
