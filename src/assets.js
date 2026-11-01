import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = dirname(dirname(fileURLToPath(import.meta.url)))

export const publicDirectory = join(appDir, 'public')

/**
 * The stylesheet is linked with a content hash rather than the app version,
 * where it used to sit. The version only moves when the app is tagged, so a
 * phone that cached /styles.css?v=1.0.0 kept the old file after a CSS-only
 * release — which is most of them. The hash changes whenever the bytes do, and
 * stays put when they do not.
 */
const stylesheet = readFileSync(join(publicDirectory, 'styles.css'))

export const stylesVersion = createHash('sha256').update(stylesheet).digest('hex').slice(0, 10)
