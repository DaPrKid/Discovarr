import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * db.js opens its database at import time, so this runs in a child process with
 * a throwaway file rather than importing the store into the test runner.
 */
function runInFreshDatabase(source) {
  const dir = mkdtempSync(join(tmpdir(), 'discovarr-tx-'))
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_FILE: join(dir, 'db.sqlite') },
    })
    return JSON.parse(output.trim().split('\n').pop())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a failed transaction leaves none of its writes behind', () => {
  const result = runInFreshDatabase(`
    import * as store from './src/db.js'
    let threw = false

    try {
      store.withTransaction(() => {
        store.recordAudit(null, 'tx.test', 'first')
        store.recordAudit(null, 'tx.test', 'second')
        throw new Error('boom')
      })
    } catch (error) {
      threw = error.message === 'boom'
    }

    const after = store.listAudit(20).filter((row) => row.action === 'tx.test').length
    console.log(JSON.stringify({ threw, after }))
  `)

  assert.equal(result.threw, true, 'the original error still reaches the caller')
  assert.equal(result.after, 0, 'nothing written inside the failed block survived')
})

test('a nested transaction joins the outer one and commits once', () => {
  const result = runInFreshDatabase(`
    import * as store from './src/db.js'

    store.withTransaction(() => {
      store.recordAudit(null, 'tx.nested', 'outer')
      store.withTransaction(() => store.recordAudit(null, 'tx.nested', 'inner'))
    })

    const rows = store.listAudit(20).filter((row) => row.action === 'tx.nested').length
    console.log(JSON.stringify({ rows }))
  `)

  assert.equal(result.rows, 2)
})
