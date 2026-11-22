import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * db.js opens its database at import time, so every case here runs in a child
 * process against a throwaway file and a throwaway backup directory.
 */
function runWithDatabase(source, { databaseFile, backupDir } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discovarr-backup-'))

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_FILE: databaseFile ?? join(dir, 'db.sqlite'),
        BACKUP_DIR: backupDir ?? join(dir, 'backups'),
      },
    })

    return JSON.parse(output.trim().split('\n').pop())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a database from an older release is migrated to the current schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovarr-migrate-'))
  const databaseFile = join(dir, 'old.sqlite')

  try {
    // The schema as it shipped before artwork, quotas, retries, notification
    // choices and themes were added: no user_version, none of those columns.
    const old = new DatabaseSync(databaseFile)
    old.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
      );
      CREATE TABLE media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tmdb_id INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        title TEXT NOT NULL,
        overview TEXT NOT NULL DEFAULT '',
        release_date TEXT,
        genres TEXT NOT NULL DEFAULT '[]',
        runtime INTEGER,
        seasons_count INTEGER,
        status INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE (tmdb_id, media_type)
      );
    `)
    old.close()

    const result = runWithDatabase(
      `
      import { SCHEMA_VERSION, db, schemaVersion } from './src/db.js'

      const columns = (table) => db.prepare(\`PRAGMA table_info(\${table})\`).all().map((row) => row.name)

      console.log(JSON.stringify({
        version: schemaVersion(),
        expected: SCHEMA_VERSION,
        userColumns: columns('users'),
        mediaColumns: columns('media'),
      }))
    `,
      { databaseFile }
    )

    assert.equal(result.version, result.expected, 'the database records the schema it is on')
    assert.ok(result.version > 0, 'an untouched database no longer reads as version 0')
    for (const column of ['permissions', 'quota_movie', 'quota_tv', 'notify_email', 'notify_events', 'plex_id', 'theme']) {
      assert.ok(result.userColumns.includes(column), `users.${column} was not added`)
    }
    for (const column of ['poster_path', 'backdrop_path', 'external_id', 'synced_at']) {
      assert.ok(result.mediaColumns.includes(column), `media.${column} was not added`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the schedule writes a snapshot, then waits for the interval', () => {
  const result = runWithDatabase(`
    import { getSettings } from './src/db.js'
    import { backupPath, runScheduledBackup } from './src/backup.js'

    const first = runScheduledBackup()
    const second = runScheduledBackup()
    const lastRun = getSettings()['backup.lastRun']

    console.log(JSON.stringify({
      wrote: first.skipped === null,
      name: first.name,
      recognisable: backupPath(first.name) !== null,
      bytes: first.bytes,
      secondSkipped: second.skipped,
      lastRun,
    }))
  `)

  assert.equal(result.wrote, true, 'a database with no snapshot yet gets one')
  assert.equal(result.recognisable, true, 'the file the app wrote is one it will restore')
  assert.ok(result.bytes > 4096, 'the snapshot looks empty')
  assert.match(result.secondSkipped, /next backup is due/, 'a second pass is not due yet')
  assert.ok(result.lastRun, 'the run was recorded so the interval counts from it')
})

test('rotation keeps the newest snapshots and drops the rest', () => {
  const result = runWithDatabase(`
    import { createBackup, listBackups } from './src/backup.js'

    for (let i = 0; i < 3; i += 1) createBackup({ keep: 2, label: 'manual' })
    const backups = listBackups()

    console.log(JSON.stringify({ names: backups.map((entry) => entry.name) }))
  `)

  assert.equal(result.names.length, 2, 'the oldest snapshot was pruned')
  for (const name of result.names) {
    assert.match(name, /^discovarr-[\dT-]+-manual(-\d+)?\.sqlite$/)
  }
})

test('a restore puts the snapshot back and leaves sessions alone', () => {
  const result = runWithDatabase(`
    import * as store from './src/db.js'
    import { createBackup, listBackups, restoreFromFile } from './src/backup.js'

    store.saveSettings({ 'app.name': 'Before the restore' })
    const user = store.createUser({ email: 'keeper@example.com', username: 'keeper', password: 'keeperpass' })
    const backup = createBackup({ label: 'manual' })

    // Everything below this line must be gone after the restore.
    store.saveSettings({ 'app.name': 'After the restore' })
    store.recordAudit(null, 'restore.test', 'written after the snapshot')

    // A session made after the snapshot is not part of it, and must survive.
    store.insertSession('session-kept', user.id, new Date(Date.now() + 86400000).toISOString())

    const outcome = restoreFromFile(backup.file)

    console.log(JSON.stringify({
      appName: store.getSettings()['app.name'],
      laterAuditRows: store.listAudit(50).filter((row) => row.action === 'restore.test').length,
      remembered: store.sessionUser('session-kept')?.username ?? null,
      safety: outcome.safety,
      backups: listBackups().map((entry) => entry.name),
      restored: outcome.copied,
    }))
  `)

  assert.equal(result.appName, 'Before the restore', 'settings came back from the snapshot')
  assert.equal(result.laterAuditRows, 0, 'rows written after the snapshot are gone')
  assert.equal(result.remembered, 'keeper', 'sign-in sessions are not replaced by a restore')
  assert.ok(result.backups.includes(result.safety), 'a safety copy of the replaced database was kept')
  assert.ok(result.safety.includes('pre-restore'), 'the safety copy is labelled')
  assert.ok(Object.keys(result.restored).length >= 5, 'the whole database was copied, not one table')
})

test('a file that is not a database is refused before anything changes', () => {
  const result = runWithDatabase(`
    import * as store from './src/db.js'
    import { restoreFromBytes } from './src/backup.js'

    store.saveSettings({ 'app.name': 'Still here' })

    let message = null
    try {
      restoreFromBytes(Buffer.from('this is not a sqlite file, it is a sentence'))
    } catch (error) {
      message = error.message
    }

    console.log(JSON.stringify({ message, appName: store.getSettings()['app.name'] }))
  `)

  assert.match(String(result.message), /not a database|damaged/i)
  assert.equal(result.appName, 'Still here', 'nothing was written by a rejected restore')
})
