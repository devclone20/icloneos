// Preview targets, file watchers and gateway readiness probes.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { app } from 'electron'

import { resolveReadableFileForIpc, resolveRequestedPathForIpc } from '../hardening'

import { directoryExists, fileExists } from './env'
import { mimeTypeForPath } from './link-metadata'
import {
  LOCAL_PREVIEW_HOSTS,
  PREVIEW_HTML_EXTENSIONS,
  PREVIEW_LANGUAGE_BY_EXT,
  PREVIEW_PDF_EXTENSIONS,
  PREVIEW_WATCH_DEBOUNCE_MS,
  previewFileMetadata
} from './media-types'
import { resolveHermesCwd } from './runtime'
import { windowsState } from './state'

const previewWatchers = new Map()

export async function writeComposerImage(buffer: Buffer, ext = '.png') {
  const rawExt = String(ext || '.png')
    .trim()
    .toLowerCase()

  const normalizedExt = rawExt.startsWith('.') ? rawExt : `.${rawExt}`
  const safeExt = /^\.[a-z0-9]{1,5}$/.test(normalizedExt) ? normalizedExt : '.png'
  const dir = path.join(app.getPath('userData'), 'composer-images')
  await fs.promises.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const random = crypto.randomBytes(3).toString('hex')
  const filePath = path.join(dir, `composer_${stamp}_${random}${safeExt}`)
  await fs.promises.writeFile(filePath, buffer)

  return filePath
}

function previewLabelForUrl(url: URL) {
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
}

export function expandUserPath(filePath: string) {
  const value = String(filePath || '').trim()

  if (value === '~') {
    return app.getPath('home')
  }

  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(app.getPath('home'), value.slice(2))
  }

  return value
}

async function previewFileTarget(rawTarget: string, baseDir: string) {
  const raw = String(rawTarget || '').trim()
  const base = baseDir ? path.resolve(expandUserPath(baseDir)) : resolveHermesCwd()

  let resolved = resolveRequestedPathForIpc(/^file:/i.test(raw) ? raw : expandUserPath(raw), {
    baseDir: base,
    purpose: 'Preview target'
  })

  if (directoryExists(resolved)) {
    resolved = path.join(resolved, 'index.html')
  }

  const ext = path.extname(resolved).toLowerCase()

  if (!fileExists(resolved)) {
    return null
  }

  ;({ resolvedPath: resolved } = await resolveReadableFileForIpc(resolved, { purpose: 'Preview target' }))

  const mimeType = mimeTypeForPath(resolved)
  const metadata = previewFileMetadata(resolved, mimeType)
  const isHtml = PREVIEW_HTML_EXTENSIONS.has(ext)
  const isImage = mimeType.startsWith('image/')
  const isPdf = PREVIEW_PDF_EXTENSIONS.has(ext) || mimeType === 'application/pdf'
  const previewKind = isHtml ? 'html' : isImage ? 'image' : isPdf ? 'pdf' : metadata.binary ? 'binary' : 'text'

  return {
    binary: metadata.binary,
    byteSize: metadata.byteSize,
    kind: 'file',
    large: metadata.large,
    label: path.basename(resolved),
    language: PREVIEW_LANGUAGE_BY_EXT[ext] || 'text',
    mimeType,
    path: resolved,
    previewKind,
    source: raw,
    url: pathToFileURL(resolved).toString()
  }
}

function previewUrlTarget(rawTarget: string) {
  const raw = String(rawTarget || '').trim()
  const url = new URL(raw)

  if (!['http:', 'https:'].includes(url.protocol)) {
    return null
  }

  if (!LOCAL_PREVIEW_HOSTS.has(url.hostname.toLowerCase())) {
    return null
  }

  if (url.hostname === '0.0.0.0') {
    url.hostname = '127.0.0.1'
  }

  return {
    kind: 'url',
    label: previewLabelForUrl(url),
    source: raw,
    url: url.toString()
  }
}

export async function normalizePreviewTarget(rawTarget: string, baseDir: string) {
  const raw = String(rawTarget || '').trim()

  if (!raw) {
    return null
  }

  try {
    if (/^https?:\/\//i.test(raw)) {
      return previewUrlTarget(raw)
    }

    return await previewFileTarget(raw, baseDir)
  } catch {
    return null
  }
}

async function filePathFromPreviewUrl(rawUrl: string) {
  const { resolvedPath } = await resolveReadableFileForIpc(String(rawUrl || ''), { purpose: 'Preview file' })

  return resolvedPath
}

function sendPreviewFileChanged(payload: { id: string; path: string; url: string }) {
  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:preview-file-changed', payload)
}

export async function watchPreviewFile(rawUrl: string) {
  const filePath = await filePathFromPreviewUrl(rawUrl)
  const watchDir = path.dirname(filePath)
  const targetName = path.basename(filePath)
  const id = crypto.randomBytes(12).toString('base64url')
  let timer: ReturnType<typeof setTimeout> | null = null

  const watcher = fs.watch(watchDir, (_eventType, filename) => {
    const changedName = filename ? path.basename(String(filename)) : ''

    if (changedName && changedName !== targetName) {
      return
    }

    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      timer = null

      if (!fileExists(filePath)) {
        return
      }

      sendPreviewFileChanged({ id, path: filePath, url: pathToFileURL(filePath).toString() })
    }, PREVIEW_WATCH_DEBOUNCE_MS)
  })

  previewWatchers.set(id, {
    close: () => {
      if (timer) {
        clearTimeout(timer)
      }

      watcher.close()
    }
  })

  return { id, path: filePath }
}

export function stopPreviewFileWatch(id: string) {
  const watcher = previewWatchers.get(id)

  if (!watcher) {
    return false
  }

  watcher.close()
  previewWatchers.delete(id)

  return true
}

export function closePreviewWatchers() {
  for (const id of previewWatchers.keys()) {
    stopPreviewFileWatch(id)
  }
}

/** Watch a DIRECTORY for entry churn (folders appearing/vanishing) — the
 *  disk-plugin door's "new plugin folder" signal, replacing the renderer's 5s
 *  readdir poll. Same registry + change channel as the preview file watchers
 *  (the renderer reconciles on any tick; per-file edits stay on their own
 *  watches), so stopPreviewFileWatch/closePreviewWatchers manage these too. */
export function watchDirectory(rawDir: string) {
  const watchDir = path.resolve(String(rawDir || ''))

  if (!fs.existsSync(watchDir) || !fs.statSync(watchDir).isDirectory()) {
    throw new Error(`Not a directory: ${watchDir}`)
  }

  const id = crypto.randomBytes(12).toString('base64url')
  let timer: ReturnType<typeof setTimeout> | null = null

  const watcher = fs.watch(watchDir, () => {
    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      timer = null
      sendPreviewFileChanged({ id, path: watchDir, url: pathToFileURL(watchDir).toString() })
    }, PREVIEW_WATCH_DEBOUNCE_MS)
  })

  previewWatchers.set(id, {
    close: () => {
      if (timer) {
        clearTimeout(timer)
      }

      watcher.close()
    }
  })

  return { id, path: watchDir }
}
