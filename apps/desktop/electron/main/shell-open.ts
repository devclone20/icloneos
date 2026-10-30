// Opening URLs and files outside the app, and the WSL font bootstrap.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, shell } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { describeCrashReason } from '../crash-forensics'
import { decideFileOpen } from '../file-open-policy'
import { resolveRequestedPathForIpc } from '../hardening'

import { IS_WSL } from './env'
import { rememberLog } from './log'

// A rejected loadURL leaves a blank window and, unhandled, no trace anywhere
// the user can send us. `label` names the surface so the log says which one.
export function loadWindowUrl(win: Electron.CrossProcessExports.BrowserWindow, url: string, label: string) {
  win.loadURL(url).catch(error => rememberLog(`${label} failed to load: ${describeCrashReason(error)}`))
}

export function openExternalUrl(rawUrl: string) {
  const raw = String(rawUrl || '').trim()

  if (!raw) {
    return false
  }

  let parsed

  try {
    parsed = new URL(raw)
  } catch {
    return false
  }

  // `file://` URLs come from content (a link the user clicks, a file attachment's Open; the renderer can't open them
  // itself because Chromium blocks file:// navigation from the app origin). X1c: the OS opens only a passive document
  // or media file (file-open-policy.ts) through `shell.openPath`; anything else — an executable, an app, a script — is
  // shown in the Finder, never opened. If the OS can't open an allowed file (`error` is a non-empty string), fall back
  // to revealing it too.
  if (parsed.protocol === 'file:') {
    let localPath

    try {
      localPath = resolveRequestedPathForIpc(parsed.toString(), { purpose: 'Open external file' })
    } catch {
      return false
    }

    const decision = decideFileOpen(localPath, 'open')

    if (decision.action === 'reveal') {
      revealInsteadOfOpening(localPath, decision.reason)

      return true
    }

    void shell
      .openPath(decision.path)
      .then(error => {
        if (!error) {
          return
        }

        rememberLog(`[file] openPath failed: ${error}; revealing in folder instead`)

        try {
          shell.showItemInFolder(localPath)
        } catch (revealError) {
          rememberLog(`[file] showItemInFolder failed: ${errorMessage(revealError)}`)
        }
      })
      .catch(error => rememberLog(`[file] openPath rejected: ${error.message}`))

    return true
  }

  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    return false
  }

  const url = parsed.toString()

  if (IS_WSL) {
    rememberLog(`[link] opening via WSL→Windows: ${url}`)

    const proc = spawn('cmd.exe', ['/c', 'start', '""', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })

    proc.on('error', error => {
      rememberLog(`[link] cmd.exe start failed: ${error.message}; falling back to xdg-open`)
      shell.openExternal(url).catch(fallback => rememberLog(`[link] xdg-open failed: ${fallback.message}`))
    })
    proc.unref()

    return true
  }

  shell.openExternal(url).catch(error => rememberLog(`[link] openExternal failed: ${error.message}`))

  return true
}

export async function openPreviewInBrowser(rawUrl: string) {
  const raw = String(rawUrl || '').trim()

  if (!raw) {
    return false
  }

  let parsed

  try {
    parsed = new URL(raw)
  } catch {
    return false
  }

  if (parsed.protocol === 'file:') {
    let localPath

    try {
      localPath = resolveRequestedPathForIpc(parsed.toString(), { purpose: 'Open preview in browser' })
    } catch {
      return false
    }

    const decision = decideFileOpen(localPath, 'browser')

    if (decision.action === 'reveal') {
      revealInsteadOfOpening(localPath, decision.reason)

      return true
    }

    await shell.openExternal(pathToFileURL(decision.path).toString())

    return true
  }

  return openExternalUrl(raw)
}

// X1c: show the file, selected, in the system file manager — the OS never opens (runs) it. Logs only why, never the path.
function revealInsteadOfOpening(localPath: string, reason: string) {
  rememberLog(`[file] not opened (${reason}); revealed in folder instead`)

  try {
    shell.showItemInFolder(localPath)
  } catch (error) {
    rememberLog(`[file] showItemInFolder failed: ${errorMessage(error)}`)
  }
}

export function ensureWslWindowsFonts() {
  if (!IS_WSL) {
    return
  }

  const fontsDir = ['/mnt/c/Windows/Fonts', '/mnt/c/windows/fonts'].find(candidate => {
    try {
      return fs.statSync(candidate).isDirectory()
    } catch {
      return false
    }
  })

  if (!fontsDir) {
    return
  }

  try {
    const confDir = path.join(app.getPath('home'), '.config', 'fontconfig', 'conf.d')
    const confPath = path.join(confDir, '99-hermes-wsl-windows-fonts.conf')
    let existing = ''

    try {
      existing = fs.readFileSync(confPath, 'utf8')
    } catch {
      existing = ''
    }

    if (existing.includes(fontsDir)) {
      return
    }

    fs.mkdirSync(confDir, { recursive: true })
    fs.writeFileSync(
      confPath,
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${fontsDir}</dir>\n</fontconfig>\n`
    )
    rememberLog(`[fonts] wired WSL Windows fonts for renderer: ${fontsDir}`)

    const cache = spawn('fc-cache', ['-f', fontsDir], { detached: true, stdio: 'ignore' })
    cache.on('error', () => undefined)
    cache.unref()
  } catch (error) {
    rememberLog(`[fonts] WSL font setup skipped: ${errorMessage(error)}`)
  }
}
