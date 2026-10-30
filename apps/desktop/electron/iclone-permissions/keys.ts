/**
 * V3-F — the one secret of the permission authority. A 32-byte master key, sealed at rest by the OS (Electron
 * `safeStorage` → the macOS Keychain; never on disk in clear), from which main derives:
 *   - the audit key: every audit record and the chain's head anchor carry an HMAC with it (critic F-10: a writer
 *     without it can neither re-chain nor cut the tail unseen);
 *   - every Hermes spawn key, as HMAC(master, nonce): the nonce is the key's public id, so a main that restarted can
 *     still verify the write-ahead log of a Hermes that died before delivering it (F-11) without keeping a key list;
 *   - the state key: the mode, the grants and the function levels (store.ts) are written under an HMAC with it, so
 *     a well-formed edit of those files is refused, not honoured (review panel 2, A-1 — the files that grant
 *     authority had no integrity control while the audit that watches them did).
 * When the OS cannot seal or unseal, the master is ephemeral for this run and `sealed` is false: the authority then
 * runs Manual only and says so (fail closed), and earlier records cannot be authenticated.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeFileAtomicSync } from '../lib/atomic-write'

const MASTER_FILE = 'master.sealed'
const NONCE_RE = /^[0-9a-f]{32}$/

/** The OS sealing seam: main passes `safeStorage`; tests pass an in-memory double. Both throw on failure. */
export interface KeySealer {
  seal: (plain: string) => string
  unseal: (sealed: string) => string
}

type KeyStatus = 'created' | 'sealed' | 'unavailable'

export interface PermissionKeys {
  status: KeyStatus
  /** False when the master is ephemeral: the authority falls back to Manual and the UI says why. */
  sealed: boolean
  /** Public id of the master (which key signed a record). */
  kid: string
  auditKey: Buffer
  /** Authenticates the permission state files (store.ts): mode, grants, function levels and function grants. */
  stateKey: Buffer
  newSpawnNonce: () => string
  /** The spawn key for a nonce, or null for anything that is not a nonce. */
  spawnKey: (nonce: unknown) => Buffer | null
}

const derive = (master: Buffer, label: string) => createHmac('sha256', master).update(label).digest()

function fromMaster(master: Buffer, status: KeyStatus): PermissionKeys {
  return {
    status,
    sealed: status !== 'unavailable',
    kid: derive(master, 'iclone-perm-kid').toString('hex').slice(0, 16),
    auditKey: derive(master, 'iclone-perm-audit'),
    stateKey: derive(master, 'iclone-perm-state'),
    newSpawnNonce: () => randomBytes(16).toString('hex'),
    spawnKey: nonce => (typeof nonce === 'string' && NONCE_RE.test(nonce) ? derive(master, `spawn\n${nonce}`) : null)
  }
}

/** Reads (or on a fresh install creates) the sealed master. Never overwrites a sealed file it could not open. */
export function loadPermissionKeys(dir: string, sealer: KeySealer | null): PermissionKeys {
  const file = path.join(dir, MASTER_FILE)

  if (existsSync(file)) {
    try {
      const master = Buffer.from(sealer?.unseal(readFileSync(file, 'utf8').trim()) ?? '', 'hex')

      if (master.length === 32) {
        return fromMaster(master, 'sealed')
      }
    } catch {
      // falls through to an ephemeral key below
    }

    return fromMaster(randomBytes(32), 'unavailable')
  }

  const master = randomBytes(32)

  try {
    if (!sealer) {
      return fromMaster(master, 'unavailable')
    }

    writeFileAtomicSync(file, `${sealer.seal(master.toString('hex'))}\n`, { mode: 0o600, dirMode: 0o700 })

    return fromMaster(master, 'created')
  } catch {
    return fromMaster(master, 'unavailable')
  }
}
