import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { config } from './config.js'
import {
  SCHEMA_VERSION,
  copySnapshotIntoDatabase,
  db,
  getSettings,
  recordAudit,
  saveSettings,
  writeSnapshotTo,
} from './db.js'

/**
 * Database snapshots that live on disk and can be restored from the settings
 * page, as opposed to `/settings/backup` which streams one to the browser.
 *
 * They are written by SQLite itself (`VACUUM INTO`), so a backup is consistent
 * while the app is serving, needs no second process, and is a single file an
 * administrator can copy off the box.
 */

// discovarr-2026-11-22T07-45-01-scheduled.sqlite, and a -2 suffix when two
// snapshots land in the same second.
const FILE_PATTERN = /^discovarr-[0-9T-]+-[a-z]+(?:-[a-z]+)*(?:-[0-9]+)?\.sqlite$/

/** The tables a snapshot must carry before it is allowed to replace the live database. */
const REQUIRED_TABLES = Object.freeze(['users', 'media', 'settings'])

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

export function backupDirectory() {
  return config.backupDir
}

/**
 * A stored snapshot by name, or null when the name is not one this app wrote.
 * Only bare file names in the backup directory are accepted, so a crafted name
 * cannot reach anything else on the disk.
 */
export function backupPath(name) {
  const clean = String(name ?? '')
  if (!FILE_PATTERN.test(clean) || clean.includes('/') || clean.includes('\\')) return null

  const full = resolve(join(backupDirectory(), clean))
  if (dirname(full) !== resolve(backupDirectory())) return null
  return existsSync(full) ? full : null
}

export function listBackups() {
  let entries = []
  try {
    entries = readdirSync(backupDirectory())
  } catch {
    return []
  }

  return entries
    .filter((name) => FILE_PATTERN.test(name))
    .map((name) => {
      const stats = statSync(join(backupDirectory(), name))
      return {
        name,
        bytes: stats.size,
        createdAt: stats.mtime.toISOString(),
        // "pre-restore" is worth calling out: it is the safety copy taken just
        // before a restore overwrote the database.
        automatic: name.includes('-scheduled'),
      }
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1))
}

/** Drops the oldest snapshots once there are more than `keep` of them. */
export function pruneBackups(keep = 7) {
  const limit = Math.max(1, Number(keep) || 7)
  const all = listBackups()
  const removed = []

  for (const backup of all.slice(limit)) {
    try {
      unlinkSync(join(backupDirectory(), backup.name))
      removed.push(backup.name)
    } catch {
      // A file that vanished or cannot be removed is not worth failing a backup.
    }
  }

  return removed
}

/**
 * Writes one snapshot now. `label` only shows up in the file name, so the list
 * on the settings page says why it exists.
 */
export function createBackup({ keep = null, label = 'manual' } = {}) {
  // A snapshot taken by hand, or before a restore, rotates against the same
  // limit the schedule uses, or the disk would grow with every button press.
  const limit = Math.max(1, Number(keep ?? getSettings()['backup.keep'] ?? 7) || 7)
  const directory = backupDirectory()
  mkdirSync(directory, { recursive: true })

  const base = `discovarr-${stamp()}-${label}`
  let name = `${base}.sqlite`
  for (let attempt = 2; existsSync(join(directory, name)); attempt += 1) {
    name = `${base}-${attempt}.sqlite`
  }

  const file = join(directory, name)
  writeSnapshotTo(file)

  const pruned = pruneBackups(limit)
  return { name, file, bytes: statSync(file).size, pruned }
}

export function backupState() {
  const settings = getSettings()
  const intervalDays = Math.max(0, Number(settings['backup.intervalDays'] ?? 7) || 0)
  const keep = Math.max(1, Number(settings['backup.keep'] ?? 7) || 7)
  const lastRun = String(settings['backup.lastRun'] ?? '') || null
  const nextDue =
    intervalDays > 0 && lastRun
      ? new Date(Date.parse(lastRun) + intervalDays * 86400000).toISOString()
      : null

  return {
    directory: backupDirectory(),
    intervalDays,
    keep,
    lastRun,
    nextDue,
    backups: listBackups(),
  }
}

/**
 * One turn of the schedule. Returns `{ skipped }` when nothing was due, so the
 * hourly timer stays silent on most passes.
 */
export function runScheduledBackup({ force = false, actorId = null } = {}) {
  const state = backupState()

  if (!force && state.intervalDays <= 0) return { skipped: 'automatic backups are switched off' }
  if (!force && state.nextDue && Date.parse(state.nextDue) > Date.now()) {
    return { skipped: `next backup is due ${state.nextDue.slice(0, 16).replace('T', ' ')}` }
  }

  const backup = createBackup({ keep: state.keep, label: force ? 'manual' : 'scheduled' })
  saveSettings({ 'backup.lastRun': new Date().toISOString() })
  recordAudit(actorId, 'settings.backup_created', `${backup.name} (${backup.bytes} bytes)`)

  return { ...backup, skipped: null }
}

/**
 * Opens a candidate snapshot away from the live database and refuses anything
 * that is not a healthy Discovarr database this release understands. Nothing is
 * written until this has passed.
 */
function verifySnapshot(file) {
  let probe

  try {
    probe = new DatabaseSync(file)
  } catch (error) {
    throw new Error(`that file is not a database (${error.message})`)
  }

  try {
    const verdict = probe.prepare('PRAGMA integrity_check').get()
    const first = verdict ? Object.values(verdict)[0] : null
    if (first !== 'ok') throw new Error(`that database is damaged (${first ?? 'unknown reason'})`)

    const tables = new Set(
      probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
    )

    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table))
    if (missing.length) throw new Error('that file is not a Discovarr database')

    const version = Number(probe.prepare('PRAGMA user_version').get().user_version ?? 0)
    if (version > SCHEMA_VERSION) {
      throw new Error(`that database is schema ${version}; this version of Discovarr only knows ${SCHEMA_VERSION}`)
    }

    return { version }
  } finally {
    probe.close()
  }
}

/**
 * Replaces the live database with a snapshot, after taking a safety copy of
 * what is there now. Sessions are kept (see `RESTORE_TABLES`), so whoever
 * clicked the button stays signed in.
 */
export function restoreFromFile(file, { actorId = null } = {}) {
  if (!file) throw new Error('No backup was chosen')

  const { version } = verifySnapshot(file)
  const safety = createBackup({ label: 'pre-restore' })

  const quoted = String(file).replace(/'/g, "''")
  db.exec(`ATTACH DATABASE '${quoted}' AS restored`)

  let copied
  try {
    copied = copySnapshotIntoDatabase()
  } finally {
    try {
      db.exec('DETACH DATABASE restored')
    } catch {
      // DETACH can fail if SQLite already dropped the attachment; the copy
      // result is what matters.
    }
  }

  recordAudit(
    actorId,
    'settings.backup_restored',
    `${basename(file)} (schema ${version}, ${Object.keys(copied).length} tables)`
  )

  return { source: basename(file), safety: safety.name, copied }
}

/** The same restore from bytes the browser just uploaded. */
export function restoreFromBytes(bytes, { actorId = null } = {}) {
  if (!bytes?.length) throw new Error('No file was uploaded')

  const staging = join(tmpdir(), `discovarr-restore-${randomBytes(6).toString('hex')}.sqlite`)

  try {
    writeFileSync(staging, bytes)
    return restoreFromFile(staging, { actorId })
  } finally {
    rmSync(staging, { force: true })
  }
}

/** A stored snapshot's bytes, for the download link on the settings page. */
export function readBackup(name) {
  const file = backupPath(name)
  return file ? { file, bytes: readFileSync(file) } : null
}
