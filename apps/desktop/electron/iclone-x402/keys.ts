/**
 * V3-J — the three secrets of payments, each a file under `userData/payments/keys/` sealed by the OS through V3-F's
 * `KeySealer` (`permissionKeySealer(safeStorage)` → the macOS Keychain; the same seam, reused not copied):
 *   - the pocket key (secp256k1, `pocket.sealed`): the only key that signs money (`signer.ts`);
 *   - the owner's mandate key (P-256, `owner-mandate.sealed`): signs open mandates (`mandates.ts`);
 *   - one agent cnf key per iNFT (P-256, `agent-<slug>.sealed`): closes a mandate; the agent process never holds it.
 * No sealer (Keychain setting OFF or the OS cannot seal) ⇒ `unavailable`: nothing is created in clear, nothing is
 * read, and payments stay disabled and say why (contract R2). A sealed file the sealer cannot open is left alone.
 *
 * The pocket is never re-keyed silently (K98 follow-up): when `pocket.sealed` is missing but payments already happened
 * under a pocket — a mandate on file, or a ledger row of money or mandates — a new key would leave the funds at the old
 * address stranded. Nothing is minted; the pocket reads `unavailable` with POCKET_MISSING as its reason, and payments
 * stay off until the file is restored (or the owner deliberately clears the payment state).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { KeySealer } from '../iclone-permissions/keys'
import { writeFileAtomicSync } from '../lib/atomic-write'

import { isAgentSlug } from './types'

/** Why keys cannot be used when the OS offers no sealing (the Keychain setting is off): the status' `sealing_off`. */
export const NO_SEALING = 'OS sealing unavailable (Keychain setting off)'

export type SealedStatus = 'created' | 'sealed' | 'unavailable'

interface SealedSecret {
  status: SealedStatus
  /** The secret's text (a hex key, a PEM), or null when unavailable. Never logged, never returned past this module's callers. */
  secret: string | null
  /** Why `unavailable`, in plain words for the pane. */
  reason: string | null
}

/** Reads (or on first use creates) one sealed secret. `mint` runs only when a sealer exists and no file does. */
export function loadSealedSecret(file: string, sealer: KeySealer | null, mint: () => string): SealedSecret {
  if (!sealer) {
    return { status: 'unavailable', secret: null, reason: NO_SEALING }
  }

  if (existsSync(file)) {
    try {
      const secret = sealer.unseal(readFileSync(file, 'utf8').trim())

      return secret ? { status: 'sealed', secret, reason: null } : unavailable('sealed file is empty')
    } catch {
      return unavailable('sealed file could not be opened')
    }
  }

  const secret = mint()

  try {
    writeFileAtomicSync(file, `${sealer.seal(secret)}\n`, { mode: 0o600, dirMode: 0o700 })
  } catch {
    return unavailable('sealed file could not be written')
  }

  return { status: 'created', secret, reason: null }
}

const unavailable = (reason: string): SealedSecret => ({ status: 'unavailable', secret: null, reason })

export interface P256Key {
  status: SealedStatus
  reason: string | null
  privateKey: KeyObject | null
  publicKey: KeyObject | null
  /** The public JWK (`kty`, `crv`, `x`, `y`) for `cnf`, or null. */
  jwk: JsonWebKey | null
}

const mintP256 = (): string =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function p256From(sealed: SealedSecret): P256Key {
  if (!sealed.secret) {
    return { status: sealed.status, reason: sealed.reason, privateKey: null, publicKey: null, jwk: null }
  }

  try {
    const privateKey = createPrivateKey(sealed.secret)
    const publicKey = createPublicKey(privateKey)
    const { kty, crv, x, y } = publicKey.export({ format: 'jwk' })

    return { status: sealed.status, reason: null, privateKey, publicKey, jwk: { kty, crv, x, y } }
  } catch {
    return {
      status: 'unavailable',
      reason: 'sealed key is not a P-256 key',
      privateKey: null,
      publicKey: null,
      jwk: null
    }
  }
}

/** The owner's mandate-signing key. */
export function loadOwnerMandateKey(keysDir: string, sealer: KeySealer | null): P256Key {
  return p256From(loadSealedSecret(path.join(keysDir, 'owner-mandate.sealed'), sealer, mintP256))
}

/** One iNFT's cnf key. A slug that is not `[a-z0-9_-]{1,64}` is refused (it names a file). */
export function loadAgentKey(keysDir: string, sealer: KeySealer | null, slug: string): P256Key {
  if (!isAgentSlug(slug)) {
    return { status: 'unavailable', reason: 'agent slug is not a name', privateKey: null, publicKey: null, jwk: null }
  }

  return p256From(loadSealedSecret(path.join(keysDir, `agent-${slug}.sealed`), sealer, mintP256))
}

/** Why a pocket is refused when its sealed file is gone but payments were made under one (the pane shows it). */
export const POCKET_MISSING =
  'the pocket key file is missing but payments were made with a pocket: no new key is created (funds at the old address would be stranded); restore pocket.sealed'

/** Ledger rows that only exist once a pocket did: money signed, settled, earned or claimed, or a mandate's life. */
const POCKET_ROW_KINDS = new Set([
  'signed',
  'settled',
  'pending',
  'failed',
  'earned',
  'claim',
  'mandate_issue',
  'mandate_use',
  'mandate_revoke'
])

/**
 * Payment state that proves a pocket existed (`keysDir` is `payments/keys`; its siblings are the mandates and the
 * ledger): a mandate file, or a ledger row of one of POCKET_ROW_KINDS. Settings and stop rows alone do not count (the
 * caps can be set before the Keychain setting is on). Reads only kinds, never a key. An unreadable state is state.
 */
function pocketStateExists(keysDir: string): boolean {
  const root = path.dirname(keysDir)

  try {
    if (readdirSync(path.join(root, 'mandates')).some(name => /\.(sdjwt|revoked)$/.test(name))) {
      return true
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return true
    }
  }

  let text: string

  try {
    text = readFileSync(path.join(root, 'ledger.jsonl'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }

  return text.split('\n').some(line => {
    try {
      const row = JSON.parse(line) as { kind?: unknown }

      return typeof row.kind === 'string' && POCKET_ROW_KINDS.has(row.kind)
    } catch {
      // A line that does not parse is not a row (a torn tail); the ledger's own verifier reports it.
      return false
    }
  })
}

/** The pocket key's hex, minted with `mint` (viem's `generatePrivateKey` in `signer.ts`; tests pass their own). */
export function loadPocketSecret(keysDir: string, sealer: KeySealer | null, mint: () => string): SealedSecret {
  const file = path.join(keysDir, 'pocket.sealed')

  // Fail closed: never a second pocket over payment state that a first one made.
  if (sealer && !existsSync(file) && pocketStateExists(keysDir)) {
    return unavailable(POCKET_MISSING)
  }

  return loadSealedSecret(file, sealer, mint)
}

/** A fresh 32-byte nonce, hex. */
export const nonceHex = (): string => randomBytes(32).toString('hex')
