import { dialog } from 'electron'

import { windowsState } from './state'

// dialog.show*Dialog has no `null`-window overload: parent the dialog on the main window when one exists,
// else open it unparented (what Electron does with a null window).
export function showOpenDialogForMainWindow(options: Electron.OpenDialogOptions) {
  const owner = windowsState.mainWindow

  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)
}

export function showSaveDialogForMainWindow(options: Electron.SaveDialogOptions) {
  const owner = windowsState.mainWindow

  return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)
}
