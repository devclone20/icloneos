/**
 * V3-F — the two Electron-facing seams of the permission authority, kept out of the pure modules so they unit-test
 * without Electron: the master key's OS sealing (safeStorage → Keychain) and the native second confirm for Ignore
 * permissions (F-17: a dialog the main process owns, which no renderer can click, focus-steal or answer).
 */
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'

import { raiseConfirmText } from '../../src/iclone-shared/permission-function-copy'
import { ignoreConfirmCopy } from '../../src/iclone-shared/permission-ignore-copy'
import type { FunctionLevel, PermissionFunction } from '../../src/iclone-shared/permissions'

import type { KeySealer } from './keys'

interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (sealed: Buffer) => string
}

/** safeStorage as the master key's sealer; null when the OS offers no encryption (the authority then runs Manual). */
export function permissionKeySealer(safeStorage: SafeStorageLike): KeySealer | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return null
    }
  } catch {
    return null
  }

  return {
    seal: plain => safeStorage.encryptString(plain).toString('base64'),
    unseal: sealed => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  }
}

interface DialogLike {
  showMessageBox: {
    (window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>
    (options: MessageBoxOptions): Promise<MessageBoxReturnValue>
  }
}

/** Cancel is the default and the Escape answer; only a click on the confirm button returns true. */
export async function confirmIgnoreNatively(
  dialog: DialogLike,
  parent: BrowserWindow | null,
  locale: string,
  request: { scope: string; key: string | null }
): Promise<boolean> {
  const copy = ignoreConfirmCopy(locale)

  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: [copy.cancel, copy.confirm],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: copy.title,
    detail: [request.key ?? '', copy.lead, ...copy.lifts.map(item => `• ${item}`), '', copy.still]
      .filter((line, index) => index > 0 || line.length > 0)
      .join('\n')
  }

  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)

  return response === 1
}

/**
 * V3-F2 — the native confirm before a function's level is raised: the function, the OLD → NEW level and what the new
 * level lets the agent do. Cancel is the default and the Escape answer; only a click on the confirm button returns true.
 */
export async function confirmFunctionRaiseNatively(
  dialog: DialogLike,
  parent: BrowserWindow | null,
  locale: string,
  request: { fn: PermissionFunction; from: FunctionLevel; to: FunctionLevel }
): Promise<boolean> {
  const text = raiseConfirmText(locale, request)

  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: [text.cancel, text.confirm],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: text.title,
    detail: text.detail
  }

  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)

  return response === 1
}
