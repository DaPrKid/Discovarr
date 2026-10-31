import { SETTING_DEFAULTS } from './constants.js'
import * as store from './db.js'
import { HttpError } from './http.js'

/**
 * Settings travel as a small JSON document: download on the old machine, paste
 * into the new one. Secrets are blanked on export by default, and a blank
 * secret on import is skipped rather than written, so restoring a redacted file
 * cannot wipe the keys already on the instance.
 */

const SECRET_KEY = /(apiKey|token|password|webhookUrl)$/i

export function redactSettings(settings) {
  const out = {}
  for (const [key, value] of Object.entries(settings)) {
    out[key] = SECRET_KEY.test(key) ? '' : value
  }
  return out
}

export function importSettings(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HttpError(400, 'Paste an exported settings file first')
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'That is not valid JSON')
  }

  const settings =
    parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object'
      ? parsed.settings
      : parsed

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new HttpError(400, 'The file has no settings object')
  }

  const entries = {}
  const ignored = []

  for (const [key, value] of Object.entries(settings)) {
    if (!(key in SETTING_DEFAULTS)) {
      ignored.push(key)
      continue
    }
    if (value === null || typeof value === 'object') {
      ignored.push(key)
      continue
    }
    // A redacted export writes "" where a secret used to be; keep the one that
    // is already configured instead of clearing it.
    if (SECRET_KEY.test(key) && String(value).trim() === '') continue

    entries[key] = String(value)
  }

  if (Object.keys(entries).length === 0) {
    throw new HttpError(400, 'No known settings were found in that file')
  }

  store.saveSettings(entries)
  return { applied: Object.keys(entries).length, ignored, keys: Object.keys(entries) }
}
