import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

/**
 * TMDB artwork is cached on disk so posters survive restarts, but nothing ever
 * removed it, so a long-lived install accumulates gigabytes. These helpers
 * report what is there and evict the oldest entries once the cache outgrows
 * its configured size or age.
 */

export function listCacheFiles(directory = config.imageCacheDir) {
  const files = []

  let sizes = []
  try {
    sizes = readdirSync(directory, { withFileTypes: true })
  } catch {
    return files
  }

  for (const size of sizes) {
    if (!size.isDirectory()) continue
    const sizeDir = join(directory, size.name)

    let entries = []
    try {
      entries = readdirSync(sizeDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(sizeDir, entry.name)
      try {
        const info = statSync(path)
        files.push({ path, size: info.size, modified: info.mtimeMs })
      } catch {
        // A file removed between readdir and stat is simply not counted.
      }
    }
  }

  return files
}

export function cacheStats(directory = config.imageCacheDir) {
  const files = listCacheFiles(directory)
  return {
    directory,
    files: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    newest: files.length ? new Date(Math.max(...files.map((file) => file.modified))).toISOString() : null,
  }
}

/**
 * Removes files older than `maxAgeDays`, then the least recently modified ones
 * until the cache fits in `maxMb`. A limit of 0 disables that rule, so an
 * administrator can turn either half off.
 */
export function pruneCache({ maxMb = 500, maxAgeDays = 60, directory = config.imageCacheDir } = {}) {
  const files = listCacheFiles(directory)
  const before = files.reduce((total, file) => total + file.size, 0)
  const now = Date.now()

  const doomed = new Set()
  let remainingBytes = before

  if (maxAgeDays > 0) {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
    for (const file of files) {
      if (file.modified < cutoff) {
        doomed.add(file.path)
        remainingBytes -= file.size
      }
    }
  }

  const cap = maxMb > 0 ? maxMb * 1024 * 1024 : Infinity
  if (remainingBytes > cap) {
    const candidates = files
      .filter((file) => !doomed.has(file.path))
      .sort((a, b) => a.modified - b.modified)

    for (const file of candidates) {
      if (remainingBytes <= cap) break
      doomed.add(file.path)
      remainingBytes -= file.size
    }
  }

  let removed = 0
  let bytes = 0

  for (const file of files) {
    if (!doomed.has(file.path)) continue
    try {
      unlinkSync(file.path)
      removed += 1
      bytes += file.size
    } catch {
      // Locked or already gone: leave it for the next pass.
    }
  }

  return { removed, bytes, before, after: before - bytes }
}
