// REL-6 round 2 — which OS sealing the ACP tools accept (lead ruling on m7: no unsealed install in 0.0.3).
import { describe, expect, it } from 'vitest'

import { acpToolsSealer, type SafeStorageSealing } from './sealer'

const storage = (available: boolean, backend?: string): SafeStorageSealing => ({
  isEncryptionAvailable: () => available,
  encryptString: plain => Buffer.from(`sealed:${plain}`),
  decryptString: sealed => sealed.toString().replace(/^sealed:/, ''),
  ...(backend ? { getSelectedStorageBackend: () => backend } : {})
})

describe('acpToolsSealer', () => {
  it('macOS with safeStorage: a sealer that round-trips', () => {
    const sealer = acpToolsSealer(storage(true), 'darwin')

    expect(sealer?.unseal(sealer.seal('k'))).toBe('k')
  })

  it('no encryption available: none (the tools say unsealable)', () => {
    expect(acpToolsSealer(storage(false), 'darwin')).toBeNull()
  })

  it('Linux without a keyring (basic_text) or an unknown backend: none — a public password is not a seal', () => {
    expect(acpToolsSealer(storage(true, 'basic_text'), 'linux')).toBeNull()
    expect(acpToolsSealer(storage(true), 'linux')).toBeNull()
    expect(acpToolsSealer(storage(true, 'gnome_libsecret'), 'linux')).not.toBeNull()
  })
})
