// X1c: what the OS may OPEN when page content names a local file.
//
// A `file:` URL reaches main from content the model wrote — a markdown link the user clicks (the preload's link
// router), a file attachment's Open, an artifact's or a preview's "open in browser". `shell.openPath` (and
// `shell.openExternal` of a file URL) hands the file to Launch Services, which RUNS what it opens: a `.command`, a
// `.terminal`, an `.app`, a `.fileloc`, an extensionless executable. So the OS only opens a regular file whose real
// path (symlinks resolved — `report.pdf` may point at an app) has a type on a closed list of passive documents and
// media; everything else is shown in the Finder, selected, and never opened.

import fs from 'node:fs'
import path from 'node:path'

/** Passive documents and media: opened by a viewer or an editor, never executed. */
export const OPENABLE_FILE_TYPES: ReadonlySet<string> = new Set([
  // images
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'tif',
  'tiff',
  'webp',
  // audio and video
  'aac',
  'aif',
  'aiff',
  'flac',
  'm4a',
  'mp3',
  'oga',
  'ogg',
  'opus',
  'wav',
  'avi',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'webm',
  // documents
  'csv',
  'doc',
  'docx',
  'epub',
  'json',
  'log',
  'markdown',
  'md',
  'odp',
  'ods',
  'odt',
  'pdf',
  'ppt',
  'pptx',
  'rtf',
  'tsv',
  'txt',
  'xls',
  'xlsx'
])

/** "Open in browser" also takes web documents: they open in the browser's sandbox, not as a native program. */
export const BROWSER_FILE_TYPES: ReadonlySet<string> = new Set([...OPENABLE_FILE_TYPES, 'htm', 'html', 'svg', 'xhtml'])

export type FileOpenPurpose = 'browser' | 'open'

export type FileOpenDecision = { action: 'open'; path: string; type: string } | { action: 'reveal'; reason: string }

export interface FileOpenIo {
  realpath(file: string): string
  isFile(file: string): boolean
}

const realIo: FileOpenIo = {
  isFile: file => fs.statSync(file).isFile(),
  realpath: file => fs.realpathSync(file)
}

export function decideFileOpen(file: string, purpose: FileOpenPurpose, io: FileOpenIo = realIo): FileOpenDecision {
  let real: string

  try {
    real = io.realpath(file)

    if (!io.isFile(real)) {
      return { action: 'reveal', reason: 'not a regular file' }
    }
  } catch {
    return { action: 'reveal', reason: 'unreadable' }
  }

  const type = path.extname(real).slice(1).toLowerCase()
  const allowed = purpose === 'browser' ? BROWSER_FILE_TYPES : OPENABLE_FILE_TYPES

  return allowed.has(type)
    ? { action: 'open', path: real, type }
    : { action: 'reveal', reason: `type .${type || '(none)'}` }
}
