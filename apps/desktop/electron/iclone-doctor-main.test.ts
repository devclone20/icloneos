import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const stub = { getPath: () => os.tmpdir(), isPackaged: false, on: () => {}, once: () => {} }

  return {
    app: stub,
    ipcMain: { handle: () => {} },
    net: {},
    safeStorage: {},
    session: {},
    shell: {},
    systemPreferences: {},
    BrowserWindow: class {},
    default: { app: stub }
  }
})

const { gatedKeychainProbe, ownRegistryText, spawnHelperCandidates, stampedAbi } = await import('./iclone-doctor-main')

let root = ''

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-main-')))
})

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true })
})

describe('doctor main wiring', () => {
  it('finds spawn-helper in the prebuilds layout first, unpacked from the asar', () => {
    const dir = path.join(root, 'app.asar', 'node_modules', 'node-pty')

    expect(spawnHelperCandidates(dir, 'darwin', 'arm64')).toEqual([
      path.join(root, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      path.join(root, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper')
    ])
  })

  it('renders this instance rows (slug + configDir) the way the app writes the registry', () => {
    const slug = `0x${'a'.repeat(40)}-6`
    fs.mkdirSync(path.join(root, 'inft', slug, 'acp'), { recursive: true })
    fs.mkdirSync(path.join(root, 'inft', 'not-an-inft', 'acp'), { recursive: true })
    fs.mkdirSync(path.join(root, 'inft', `0x${'b'.repeat(40)}-7`), { recursive: true })

    const rows = ownRegistryText(root)
      .split('\n')
      .filter(l => l && !l.startsWith('#'))

    expect(rows).toEqual([`6\t${slug}\t${path.join(root, 'inft', slug, 'acp')}\t#6\tinft-aaaaaa-6`])
    expect(ownRegistryText(path.join(root, 'none')).split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('reads the ABI stamp only when the build carries one', () => {
    expect(stampedAbi(root)).toBeNull()
    fs.writeFileSync(path.join(root, 'install-stamp.json'), JSON.stringify({ commit: 'x', abi: '143' }))
    expect(stampedAbi(root)).toBe('143')
    fs.writeFileSync(path.join(root, 'install-stamp.json'), JSON.stringify({ abi: '../x' }))
    expect(stampedAbi(root)).toBeNull()
  })

  it('probes the keychain only when the owner turned encryption on', () => {
    const probe = vi.fn(() => true)

    expect(gatedKeychainProbe(undefined, probe)).toBe(false)
    expect(gatedKeychainProbe(() => false, probe)).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(gatedKeychainProbe(() => true, probe)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
