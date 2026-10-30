/**
 * iclone os — on-chain 3D model fetcher for the iNFT Stage.
 *
 * The renderer cannot fetch cross-origin GLBs reliably (file:// packaging,
 * CSP), so the main process downloads the token's `animation_*` GLB, caches
 * it on disk (userData/iclone-models, keyed by URL hash) and hands the bytes
 * over IPC. https-only, 64MB cap, 45s timeout, magic-byte sanity check.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import { app, ipcMain } from 'electron'

const MAX_BYTES = 64 * 1024 * 1024
const TIMEOUT_MS = 45000
const MAX_REDIRECTS = 4

interface IcloneModelResult {
  ok: boolean
  data?: Uint8Array
  error?: string
}

function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'iclone-models')

  mkdirSync(dir, { recursive: true })

  return dir
}

function cachePath(url: string): string {
  return path.join(cacheDir(), `${createHash('sha1').update(url).digest('hex')}.glb`)
}

function download(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL

    try {
      parsed = new URL(url)
    } catch {
      reject(new Error('invalid model URL'))

      return
    }

    if (parsed.protocol !== 'https:') {
      reject(new Error('model URLs must be https'))

      return
    }

    const request = https.get(parsed, { timeout: TIMEOUT_MS }, response => {
      const status = response.statusCode ?? 0

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()

        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('too many redirects'))
        } else {
          resolve(download(new URL(response.headers.location, parsed).toString(), redirects + 1))
        }

        return
      }

      if (status !== 200) {
        response.resume()
        reject(new Error(`model fetch failed (${status})`))

        return
      }

      const chunks: Buffer[] = []
      let total = 0

      response.on('data', (chunk: Buffer) => {
        total += chunk.length

        if (total > MAX_BYTES) {
          request.destroy(new Error('model exceeds the 64MB cap'))

          return
        }

        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })

    request.on('timeout', () => request.destroy(new Error('model fetch timed out')))
    request.on('error', reject)
  })
}

async function fetchModel(url: string): Promise<IcloneModelResult> {
  try {
    const cached = cachePath(url)

    if (existsSync(cached)) {
      return { ok: true, data: readFileSync(cached) }
    }

    const data = await download(url)

    // GLB magic ("glTF") or a JSON glTF ("{") — anything else is not a model.
    const head = data.subarray(0, 4).toString('latin1')

    if (head !== 'glTF' && !head.trimStart().startsWith('{')) {
      return { ok: false, error: 'URL did not return a glTF/GLB model' }
    }

    writeFileSync(cached, data)

    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let initialized = false

export function initIcloneModel() {
  if (initialized) {
    return
  }

  initialized = true
  ipcMain.handle('iclone:fetch-model', (_event, url: string) => fetchModel(String(url ?? '')))
}
