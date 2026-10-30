/**
 * REL-6 round 2 (lead ruling on critic m7) — the OS sealing the ACP tools accept. safeStorage when it really seals:
 * on Linux, Chromium's `basic_text` backend (no keyring: a fixed, public password) is not a seal, so it counts as "this
 * session cannot seal" and the tools are `unavailable · unsealable` (no install, no run) with that reason on screen.
 */
import { permissionKeySealer } from '../iclone-permissions/ignore-dialog'

import type { KeySealer } from './manifest'

export interface SafeStorageSealing {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (sealed: Buffer) => string
  getSelectedStorageBackend?: () => string
}

export function acpToolsSealer(safeStorage: SafeStorageSealing, platform: string = process.platform): KeySealer | null {
  if (platform === 'linux') {
    let backend = 'unknown'

    try {
      backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
    } catch {
      backend = 'unknown'
    }

    if (backend === 'basic_text' || backend === 'unknown') {
      return null
    }
  }

  return permissionKeySealer(safeStorage)
}
