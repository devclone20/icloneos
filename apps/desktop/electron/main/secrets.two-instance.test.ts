/**
 * v0.0.9 owner decision (pass 4): the at-rest "works after restart" e2e tests are N/A, because a real keychain across
 * a restart cannot be isolated (Chromium's mock keychain is per process; a throwaway keychain goes through the user's
 * real securityd and preferences). Persistence is proven here instead, across TWO app instances.
 *
 * Instance 1 and instance 2 are two fresh module graphs (vi.resetModules) over the same userData directory, each with
 * its own in-memory caches, exactly what a restart gives the main process. The one thing they share is a fake
 * safeStorage whose key lives in a fake "keychain" outside both graphs, as the OS keychain outlives the app. Nothing
 * here touches the real keychain, the security CLI or Electron: every safeStorage method is the fake below.
 *
 * Instance 1 turns keychain encryption on and saves a remote connection with a token. Instance 2 reads the policy and
 * connection.json from disk and gets the same token back. The negative controls prove the check is not vacuous: a
 * lost keychain key, a tampered blob and a lost policy file each fail to give the token back.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConnectionConfigModule from './connection-config'
import type * as SecretsModule from './secrets'

const h = vi.hoisted(() => {
  // The fake keychain: one key per app, outliving every app instance.
  const keychain = { key: 'k-1' }
  const PREFIX = 'fake-safe-storage:'

  const safeStorage = {
    decryptString: vi.fn((blob: Buffer) => {
      const text = blob.toString('utf8')
      const head = `${PREFIX}${keychain.key}:`

      if (!text.startsWith(head)) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      }

      return Buffer.from(text.slice(head.length), 'base64').toString('utf8')
    }),
    encryptString: vi.fn((plain: string) =>
      Buffer.from(`${PREFIX}${keychain.key}:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8')
    ),
    getSelectedStorageBackend: vi.fn(() => 'keychain'),
    isEncryptionAvailable: vi.fn(() => true),
    setUsePlainTextEncryption: vi.fn()
  }

  return { keychain, safeStorage, userData: '' }
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v009-two-instance-'))
h.userData = path.join(root, 'userData')
fs.mkdirSync(h.userData, { recursive: true })

afterAll(() => fs.rmSync(root, { force: true, recursive: true }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getVersion: () => '0.0.9', isPackaged: false },
  safeStorage: h.safeStorage,
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } }
}))
vi.mock('./env', () => ({ ACTIVE_HERMES_ROOT: path.join(h.userData, 'hermes-root'), PROFILE_NAME_RE: /^[a-z0-9][a-z0-9_-]{0,63}$/ }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))

const TOKEN = 'gw-token-6f1c2b9e-two-instance'
const URL_ = 'https://gateway.example.test'

type Instance = typeof SecretsModule & typeof ConnectionConfigModule

/** A fresh app instance: new module graph, new caches, the same userData on disk and the same keychain. */
async function bootInstance(): Promise<Instance> {
  vi.resetModules()
  const secrets = await import('./secrets')
  const config = await import('./connection-config')

  return { ...secrets, ...config }
}

/** Instance 1: the user turns keychain encryption on in Settings and saves a remote gateway with its token. */
async function saveInInstanceOne() {
  const one = await bootInstance()
  one.setSecretStoragePolicy({ migrated: true, on: true })
  const token = one.encryptDesktopSecret(TOKEN)
  one.writeDesktopConnectionConfig({ mode: 'remote', profiles: {}, remote: { token, url: URL_ } })

  return one
}

function tokenFrom(instance: Instance) {
  return instance.decryptDesktopSecret(instance.readDesktopConnectionConfig().remote.token)
}

beforeEach(() => {
  fs.rmSync(h.userData, { force: true, recursive: true })
  fs.mkdirSync(h.userData, { recursive: true })
  h.keychain.key = 'k-1'
  vi.clearAllMocks()
})

describe('at-rest connection token persists across two app instances (fake safeStorage)', () => {
  it('instance 1 writes it, a new instance 2 reads the same token and the remote connection', async () => {
    await saveInInstanceOne()

    const two = await bootInstance()
    expect(two.secretStoragePolicy()).toEqual({ migrated: true, on: true })
    const config = two.readDesktopConnectionConfig()
    expect(config.mode).toBe('remote')
    expect(config.remote.url).toBe(URL_)
    expect(tokenFrom(two)).toBe(TOKEN)
    // Instance 2 went through the keychain for it, not a cached plain copy.
    expect(h.safeStorage.decryptString).toHaveBeenCalled()
  })

  it('the files on disk never hold the token in plain text', async () => {
    await saveInInstanceOne()

    const onDisk = fs.readFileSync(path.join(h.userData, 'connection.json'), 'utf8')
    expect(onDisk).not.toContain(TOKEN)
    expect(onDisk).toContain('"encoding": "safeStorage"')

    for (const name of fs.readdirSync(h.userData)) {
      expect(fs.readFileSync(path.join(h.userData, name), 'utf8')).not.toContain(TOKEN)
    }

    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(h.userData, 'connection.json')).mode & 0o077).toBe(0)
    }
  })

  it('negative control: a lost keychain key gives instance 2 no token', async () => {
    await saveInInstanceOne()
    h.keychain.key = 'k-2'

    const two = await bootInstance()
    expect(tokenFrom(two)).toBe('')
  })

  it('negative control: a tampered blob on disk gives instance 2 no token', async () => {
    await saveInInstanceOne()
    const file = path.join(h.userData, 'connection.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    parsed.remote.token.value = Buffer.from('not-a-fake-safe-storage-blob').toString('base64')
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2))

    const two = await bootInstance()
    expect(tokenFrom(two)).toBe('')
  })

  it('negative control: a lost policy file means instance 2 does not see the opt-in', async () => {
    await saveInInstanceOne()
    fs.rmSync(path.join(h.userData, 'secure-token-storage.json'))

    const two = await bootInstance()
    expect(two.secretStoragePolicy().on).toBe(false)
  })
})
