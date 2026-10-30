// Opt-in keychain encryption: policy changes and the rewrite of every stored secret.
import { safeStorage } from 'electron'

import { encryptDesktopSecret as encryptDesktopSecretStrict, SAFE_STORAGE_ENCODING } from '../hardening'
import { noteConsentPermission } from '../iclone-consent'
import { classifyStoredSecret } from '../secret-storage-policy'

import {
  readDesktopConnectionConfig,
  readDesktopConnectionsRegistry,
  writeDesktopConnectionConfig,
  writeDesktopConnectionsRegistry
} from './connection-config'
import { rememberLog } from './log'
import { _nativeTokenStoreIo } from './oauth'
import { decryptDesktopSecret, secretStoragePolicy, setSecretStoragePolicy } from './secrets'

/**
 * Rewrite every stored desktop secret (v1 connection.json token/headers +
 * per-profile overrides, v2 registry connections, native OAuth token store)
 * through `reencode`. Returns true when any store was rewritten. Shared by
 * the one-shot legacy migration and the Settings encryption toggle.
 */
function rewriteAllStoredSecrets(shouldRewrite: (secret: any) => boolean, reencode: (secret: any) => any): boolean {
  let touched = false

  const rewriteBlock = (block: any) => {
    if (!block || typeof block !== 'object') {
      return block
    }

    const next = { ...block, ...(block.token ? { token: reencode(block.token) } : {}) }

    if (block.headers && typeof block.headers === 'object') {
      next.headers = Object.fromEntries(Object.entries(block.headers).map(([k, v]) => [k, reencode(v)]))
    }

    return next
  }

  const blockNeedsRewrite = (o: any) =>
    shouldRewrite(o?.token) ||
    Object.values(o?.headers && typeof o.headers === 'object' ? o.headers : {}).some(shouldRewrite)

  // v1 connection.json.
  const config = readDesktopConnectionConfig()

  if (blockNeedsRewrite(config.remote) || Object.values(config.profiles || {}).some(blockNeedsRewrite)) {
    touched = true
    writeDesktopConnectionConfig({
      ...config,
      remote: rewriteBlock(config.remote),
      profiles: Object.fromEntries(Object.entries(config.profiles || {}).map(([k, v]) => [k, rewriteBlock(v)]))
    })
  }

  // v2 connections.json registry.
  const registry = readDesktopConnectionsRegistry()

  if (registry.connections?.some(blockNeedsRewrite)) {
    touched = true
    writeDesktopConnectionsRegistry({ ...registry, connections: registry.connections.map(rewriteBlock) })
  }

  // Native OAuth token store: baseUrl → blob.
  const io = _nativeTokenStoreIo()

  try {
    const store = JSON.parse(io.readStoreText())

    if (store && typeof store === 'object' && !Array.isArray(store)) {
      const entries = Object.entries(store)

      if (entries.some(([, v]) => shouldRewrite(v))) {
        touched = true
        io.writeStoreText(JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, reencode(v)]))))
      }
    }
  } catch {
    // Missing/corrupt native token store: nothing to rewrite.
  }

  return touched
}

/**
 * One-shot legacy migration: builds before the opt-in policy wrote every
 * secret as a safeStorage blob. With encryption now defaulting OFF, decrypt
 * each stored blob once and rewrite it as plain so no future launch touches
 * the keychain. Marked `migrated` whether or not every blob decrypts — a
 * broken keychain costs at most ONE prompt (this pass), never one per
 * launch; blobs that would not decrypt are left in place and simply read as
 * absent from then on (classifyStoredSecret → 'drop'), so opting encryption
 * back ON later can still recover them on a healthy keychain.
 *
 * Runs before createWindow() so every later read sees the final encodings.
 */
export function migrateLegacyEncryptedSecretsOnce() {
  const policy = secretStoragePolicy()

  if (policy.on || policy.migrated) {
    return
  }

  const needsMigration = (secret: any) => classifyStoredSecret(secret, policy) === 'migrate'

  const reencode = (secret: any) => {
    if (!needsMigration(secret)) {
      return secret
    }

    const plaintext = decryptDesktopSecret(secret)

    // Undecryptable now (locked/absent keychain): keep the blob for a
    // potential future opt-in, but post-migration reads treat it as unset.
    return plaintext ? { encoding: 'plain', value: plaintext } : secret
  }

  let touchedKeychain = false

  try {
    touchedKeychain = rewriteAllStoredSecrets(needsMigration, reencode)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)

    rememberLog(`[secret-storage] legacy migration pass failed: ${detail}`)
  }

  setSecretStoragePolicy({ on: false, migrated: true })

  if (touchedKeychain) {
    rememberLog('[secret-storage] migrated legacy keychain-encrypted secrets to opt-out storage (one-shot pass)')
  }
}

/**
 * Settings → Gateway toggle: flip keychain-backed encryption and re-encode
 * every stored secret to match. Turning ON encrypts plain blobs through
 * strict safeStorage (throws loudly when the keychain is unusable — the
 * toggle stays off and the renderer shows the error). Turning OFF decrypts
 * back to plain; this is user-initiated, so a keychain prompt here is
 * expected and acceptable.
 */
export function applySecretStorageEncryption(on: boolean) {
  const enable = on === true

  if (secretStoragePolicy().on === enable) {
    return { on: enable }
  }

  if (enable) {
    const needsEncrypt = (secret: any) => secret?.encoding === 'plain' && Boolean(secret.value)

    // Probe FIRST so an unusable keychain fails before any store is touched.
    if (
      !(() => {
        try {
          return Boolean(safeStorage.isEncryptionAvailable())
        } catch {
          return false
        }
      })()
    ) {
      throw new Error(
        'OS keychain encryption is unavailable on this machine, so stored gateway secrets cannot be encrypted.'
      )
    }

    setSecretStoragePolicy({ on: true, migrated: true })

    try {
      rewriteAllStoredSecrets(needsEncrypt, secret =>
        needsEncrypt(secret) ? encryptDesktopSecretStrict(String(secret.value), safeStorage) : secret
      )
    } catch (error) {
      // Encryption failed midway: revert the policy so reads keep working
      // against whatever encodings are on disk (mixed stores read fine —
      // decryptDesktopSecret handles both encodings under either policy).
      setSecretStoragePolicy({ on: false, migrated: true })
      throw error
    }

    noteConsentPermission('keychain', true)

    return { on: true }
  }

  // Turning OFF: decrypt everything back to plain while the keychain is
  // still readable, then flip the policy.
  const needsDecrypt = (secret: any) => secret?.encoding === SAFE_STORAGE_ENCODING

  rewriteAllStoredSecrets(needsDecrypt, (secret: any) => {
    if (!needsDecrypt(secret)) {
      return secret
    }

    const plaintext = decryptDesktopSecret(secret)

    return plaintext ? { encoding: 'plain', value: plaintext } : secret
  })

  setSecretStoragePolicy({ on: false, migrated: true })

  noteConsentPermission('keychain', false)

  return { on: false }
}
