import path from 'node:path'

import { dialog } from 'electron'

import { windowsState } from './state'

/**
 * What a dialog is for. Each purpose remembers the folder of its last pick for the life of the process: since
 * Electron 44 a dialog with an empty `defaultPath` opens in Downloads, and one given a bare file name leaves the
 * folder to the OS, so neither opens where the user last was unless the folder is supplied here.
 */
export type DialogPurpose = 'add-context' | 'save-download' | 'save-path'

const lastDirectoryByPurpose = new Map<DialogPurpose, string>()

/**
 * The `defaultPath` to open with: an absolute path the caller chose is kept as it is; otherwise the purpose's last
 * folder is used, joined with the caller's file name when it gave one.
 */
export function rememberedDefaultPath(purpose: DialogPurpose | undefined, defaultPath: string | undefined) {
  if (defaultPath && path.isAbsolute(defaultPath)) {
    return defaultPath
  }

  const lastDirectory = purpose ? lastDirectoryByPurpose.get(purpose) : undefined

  if (!lastDirectory) {
    return defaultPath
  }

  return defaultPath ? path.join(lastDirectory, defaultPath) : lastDirectory
}

function rememberPick(purpose: DialogPurpose | undefined, picked: string | undefined) {
  if (purpose && picked && path.isAbsolute(picked)) {
    lastDirectoryByPurpose.set(purpose, path.dirname(picked))
  }
}

/** Test-only: forget every remembered folder. */
export function forgetDialogDirectories() {
  lastDirectoryByPurpose.clear()
}

// dialog.show*Dialog has no `null`-window overload: parent the dialog on the main window when one exists,
// else open it unparented (what Electron does with a null window).
export async function showOpenDialogForMainWindow(options: Electron.OpenDialogOptions, purpose?: DialogPurpose) {
  const owner = windowsState.mainWindow
  const resolved = { ...options, defaultPath: rememberedDefaultPath(purpose, options.defaultPath) }
  const result = await (owner ? dialog.showOpenDialog(owner, resolved) : dialog.showOpenDialog(resolved))

  if (!result.canceled) {
    rememberPick(purpose, result.filePaths[0])
  }

  return result
}

export async function showSaveDialogForMainWindow(options: Electron.SaveDialogOptions, purpose?: DialogPurpose) {
  const owner = windowsState.mainWindow
  const resolved = { ...options, defaultPath: rememberedDefaultPath(purpose, options.defaultPath) }
  const result = await (owner ? dialog.showSaveDialog(owner, resolved) : dialog.showSaveDialog(resolved))

  if (!result.canceled) {
    rememberPick(purpose, result.filePath)
  }

  return result
}
