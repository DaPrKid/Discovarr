import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

const KEY_LENGTH = 64

/**
 * scrypt with a per-password salt, stored as `scrypt$<salt>$<hash>`.
 *
 * Hashing stays synchronous because it only runs when an account is created or
 * its password changes, and the store's write helpers are called from code that
 * is not all async. Verification is the hot path — every sign-in — so it uses
 * the thread pool instead of freezing the single process for the whole hash.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex')
  return `scrypt$${salt}$${hash}`
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? '').split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false

  const expected = Buffer.from(hash, 'hex')
  if (expected.length === 0) return false

  const actual = await scryptAsync(password, salt, expected.length)
  return timingSafeEqual(expected, actual)
}
