// Encryption of stored secrets and the remote-header store.
import fs from 'node:fs'
import path from 'node:path'

import { app, safeStorage } from 'electron'

import { isRecord } from '../../src/iclone-shared/guards'
import { modeIsRemoteLike, normalizeRemoteHeaders, normalizeSshConfig, normAuthMode } from '../connection-config'
import {
  encryptDesktopSecret as encryptDesktopSecretStrict,
  SAFE_STORAGE_ENCODING,
  writeSecretFileAtomic
} from '../hardening'
import {
  classifyStoredSecret,
  readSecretStoragePolicy,
  SECRET_STORAGE_POLICY_FILE,
  type SecretStoragePolicy,
  writeSecretStoragePolicy
} from '../secret-storage-policy'

import { remoteWsHeaderStore } from './backend-state'
import { PROFILE_NAME_RE } from './env'

// ---------------------------------------------------------------------------
// Opt-in keychain encryption (secret-storage-policy.ts owns the decision).
// Default OFF: no safeStorage call is ever made, so a broken/locked macOS
// login keychain can never throw its password dialog on launch. Settings →
// Gateway exposes the toggle; flipping it re-encrypts (or decrypts) the
// stored secrets in place.
// ---------------------------------------------------------------------------
const SECRET_STORAGE_POLICY_PATH = path.join(app.getPath('userData'), SECRET_STORAGE_POLICY_FILE)

const _secretStoragePolicyIo = {
  readText: () => fs.readFileSync(SECRET_STORAGE_POLICY_PATH, 'utf8'),
  writeText: (text: string) => writeSecretFileAtomic(SECRET_STORAGE_POLICY_PATH, text, { encoding: 'utf8' })
}

let _secretStoragePolicy: SecretStoragePolicy | null = null

export function secretStoragePolicy(): SecretStoragePolicy {
  if (!_secretStoragePolicy) {
    _secretStoragePolicy = readSecretStoragePolicy(_secretStoragePolicyIo)
  }

  return _secretStoragePolicy
}

const _policyWriteListeners = new Set<() => void>()

/** V3-FX M1: told after every write of the policy (main's keychain switch re-reads it and updates its subscribers). */
export function onSecretStoragePolicyWrite(listener: () => void): () => void {
  _policyWriteListeners.add(listener)

  return () => _policyWriteListeners.delete(listener)
}

export function setSecretStoragePolicy(next: SecretStoragePolicy) {
  _secretStoragePolicy = { on: next.on === true, migrated: next.migrated === true }
  writeSecretStoragePolicy(_secretStoragePolicy, _secretStoragePolicyIo)

  for (const listener of [..._policyWriteListeners]) {
    try {
      listener()
    } catch {
      // a subscriber's failure never undoes the owner's choice
    }
  }
}

/**
 * Keychain availability as the renderer should see it. With encryption
 * opted out this must NOT probe safeStorage — isEncryptionAvailable() is
 * itself a keychain touch that raises the macOS dialog this feature exists
 * to avoid. We report `true` so no plain-text warning banners fire: storing
 * plaintext is the user's chosen (default) mode, not a degraded state.
 */
export function probeSecureTokenStorage(): boolean {
  if (!secretStoragePolicy().on) {
    return true
  }

  try {
    return Boolean(safeStorage.isEncryptionAvailable())
  } catch {
    return false
  }
}

export function encryptDesktopSecret(value: unknown, options = {}) {
  if (!secretStoragePolicy().on) {
    const raw = String(value || '')

    return raw ? { encoding: 'plain', value: raw } : null
  }

  return encryptDesktopSecretStrict(value, safeStorage, options)
}

export function decryptDesktopSecret(secret: unknown) {
  if (!isRecord(secret)) {
    return ''
  }

  const value = String(secret.value || '')

  if (!value) {
    return ''
  }

  if (secret.encoding === SAFE_STORAGE_ENCODING) {
    // Legacy blob under an opted-out policy: once the one-shot migration pass
    // has run, never touch safeStorage again — a dead keychain would otherwise
    // prompt on every read. Before that pass, decryption is allowed so the
    // migration itself (and this launch's reads) can recover the value.
    if (classifyStoredSecret({ encoding: SAFE_STORAGE_ENCODING, value }, secretStoragePolicy()) === 'drop') {
      return ''
    }

    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return ''
    }
  }

  // Any other encoding (a hand-edited config, or one written by a pre-release
  // build) is returned verbatim on purpose: this fallback is what lets such a
  // config connect at all. Not a plaintext-writing path — nothing in this file
  // persists a token this way.
  return value
}

export function decryptRemoteHeaders(headers: unknown) {
  const normalized = normalizeRemoteHeaders(headers)
  const out: Record<string, string> = {}

  for (const [name, secret] of Object.entries(normalized)) {
    const value = decryptDesktopSecret(secret)

    if (value) {
      out[name] = value
    }
  }

  return out
}

/**
 * Turn an editor payload of remote gateway headers into stored secret
 * envelopes. The payload map is authoritative (a name missing from it is
 * cleared); per-name values are:
 *   - non-empty string  → new plaintext value, encrypted like a token
 *   - null              → keep the currently stored envelope for that name
 *                         (the editor shows a set-but-hidden secret)
 *   - envelope object   → stored verbatim (hand-edited import path)
 * Name filtering (forbidden/managed headers) happens in
 * normalizeRemoteHeaders at the registry/config layer.
 */
export function encryptIncomingRemoteHeaders(
  raw: unknown,
  existing: unknown,
  options: { allowPlainText?: boolean } = {}
) {
  const out: Record<string, unknown> = {}
  const stored: Record<string, unknown> = normalizeRemoteHeaders(existing)

  for (const [name, value] of Object.entries(raw || {})) {
    const key = String(name || '').trim()

    if (!key) {
      continue
    }

    if (typeof value === 'string') {
      const trimmed = value.trim()

      if (trimmed) {
        out[key] = encryptDesktopSecret(trimmed, { allowPlainText: options.allowPlainText === true })
      }

      continue
    }

    if (value === null) {
      if (stored[key]) {
        out[key] = stored[key]
      }

      continue
    }

    if (value && typeof value === 'object') {
      out[key] = value
    }
  }

  return out
}

export function rememberRemoteWsHeaders(wsUrl: string, headers = {}) {
  remoteWsHeaderStore.remember(wsUrl, headers)
}

// Validate + normalize the per-profile remote overrides map read from disk.
// Drops malformed names/entries and keeps only the recognized fields so a
// hand-edited or stale connection.json can't inject junk into resolution.
export function sanitizeConnectionProfiles(raw: Record<string, any>) {
  if (!raw || typeof raw !== 'object') {
    return {}
  }

  const out: Record<string, Record<string, unknown>> = {}

  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    if (name !== 'default' && !PROFILE_NAME_RE.test(name)) {
      continue
    }

    if (entry.mode === 'ssh') {
      const ssh = normalizeSshConfig(entry)

      if (ssh) {
        if (entry.token && typeof entry.token === 'object') {
          ssh.token = entry.token
        }

        out[name] = ssh
      }

      continue
    }

    const cleaned: {
      mode: 'remote' | 'local' | 'cloud'
      url?: string
      authMode?: string
      token?: object
      headers?: object
      org?: string
      savedSsh?: object
    } = {
      mode: modeIsRemoteLike(entry.mode) ? entry.mode : 'local'
    }

    if (cleaned.mode === 'local') {
      const savedSsh = normalizeSshConfig(entry.savedSsh)

      if (savedSsh) {
        cleaned.savedSsh = savedSsh
      }
    }

    const url = String(entry.url || '').trim()

    if (url) {
      cleaned.url = url
    }

    cleaned.authMode = normAuthMode(entry.authMode)

    if ((entry as any).token && typeof entry.token === 'object') {
      cleaned.token = entry.token
    }

    const headers = normalizeRemoteHeaders((entry as any).headers)

    if (Object.keys(headers).length > 0) {
      cleaned.headers = headers
    }

    // Preserve the Hermes Cloud org tag on cloud-mode entries so Settings can
    // reopen into the same org for a per-profile cloud connection.
    if (cleaned.mode === 'cloud') {
      const org = String(entry.org || '').trim()

      if (org) {
        cleaned.org = org
      }
    }

    out[name] = cleaned
  }

  return out
}
