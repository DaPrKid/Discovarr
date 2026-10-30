import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { IMAGE_SIZES } from './tmdb.js'

const SAFE_NAME = /^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/

export function isValidImageRequest(size, file) {
  return IMAGE_SIZES.has(size) && SAFE_NAME.test(file)
}

/**
 * Serves TMDB artwork from a local cache so the browser never talks to TMDB
 * directly and posters keep working after the first view.
 */
export async function serveImage(res, size, file) {
  if (!isValidImageRequest(size, file)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Bad image request')
    return
  }

  const directory = join(config.imageCacheDir, size)
  const cachePath = join(directory, file)
  const headers = {
    'content-type': file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
    'cache-control': 'public, max-age=2592000, immutable',
  }

  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath)
    res.writeHead(200, { ...headers, 'content-length': cached.length })
    res.end(cached)
    return
  }

  try {
    const upstream = await fetch(`https://image.tmdb.org/t/p/${size}/${file}`, {
      signal: AbortSignal.timeout(8000),
    })

    if (!upstream.ok) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Image not found')
      return
    }

    const buffer = Buffer.from(await upstream.arrayBuffer())
    mkdirSync(directory, { recursive: true })
    writeFileSync(cachePath, buffer)

    res.writeHead(200, { ...headers, 'content-length': buffer.length })
    res.end(buffer)
  } catch (error) {
    console.warn(`[discovarr] image proxy failed for ${size}/${file}: ${error.message}`)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Image proxy error')
  }
}
