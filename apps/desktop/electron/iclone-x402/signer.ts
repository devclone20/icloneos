/**
 * V3-J — the pocket signer: the one place in the app that signs money. A dedicated secp256k1 key minted by main
 * (viem `generatePrivateKey`), sealed with the OS (`keys.ts` → V3-F's `KeySealer`), never exported, never in env,
 * argv, a log or the ledger. It signs exactly one thing: an EIP-3009 `TransferWithAuthorization` (EIP-712) for the
 * `exact` scheme, with the token's domain from the requirements (`extra.name` / `extra.version`). No sealer ⇒
 * `unavailable` with the reason, and the client refuses with `signer_unavailable` (contract R2: refused, not degraded).
 *
 * The owner funds the pocket address with at most the daily cap; that address is the blast radius.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import type { KeySealer } from '../iclone-permissions/keys'

import { loadPocketSecret, type SealedStatus } from './keys'
import type { ExactEvmAuthorization, PaymentRequirements } from './types'
import { type Network, NETWORK_INFO } from './types'

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
} as const

export interface Eip712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: `0x${string}`
}

/**
 * The token's EIP-712 domain for one requirements entry, from `extra.name` / `extra.version` ONLY. Missing or empty ⇒
 * null and the client refuses (`payload`) before the door: no table fallback, the SDK's own behaviour (it throws
 * "EIP-712 domain parameters (name, version) are required"). A wrong guess here is a signature for another token.
 */
export function domainFor(network: Network, requirements: PaymentRequirements): Eip712Domain | null {
  const extra = requirements.extra ?? {}
  const name = typeof extra.name === 'string' && extra.name.length > 0 ? extra.name : null
  const version = typeof extra.version === 'string' && extra.version.length > 0 ? extra.version : null

  if (!name || !version) {
    return null
  }

  return {
    name,
    version,
    chainId: NETWORK_INFO[network].chainId,
    verifyingContract: requirements.asset as `0x${string}`
  }
}

/** The typed-data message viem signs / verifies. */
export function authorizationMessage(auth: ExactEvmAuthorization) {
  return {
    from: auth.from as `0x${string}`,
    to: auth.to as `0x${string}`,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce as `0x${string}`
  }
}

export interface PaymentSigner {
  status: SealedStatus
  reason: string | null
  /** The pocket address (lowercase), or null when unavailable. */
  address: string | null
  signAuthorization: (auth: ExactEvmAuthorization, domain: Eip712Domain) => Promise<`0x${string}`>
}

const refuse = (reason: string): PaymentSigner => ({
  status: 'unavailable',
  reason,
  address: null,
  signAuthorization: () => Promise.reject(new Error(`pocket signer unavailable: ${reason}`))
})

/** The pocket signer from its sealed file. The key never leaves this closure. */
export function createPocketSigner(keysDir: string, sealer: KeySealer | null): PaymentSigner {
  const sealed = loadPocketSecret(keysDir, sealer, generatePrivateKey)

  if (!sealed.secret) {
    return refuse(sealed.reason ?? 'unavailable')
  }

  let account: ReturnType<typeof privateKeyToAccount>

  try {
    account = privateKeyToAccount(sealed.secret as `0x${string}`)
  } catch {
    return refuse('sealed pocket key is not a key')
  }

  return {
    status: sealed.status,
    reason: null,
    address: account.address.toLowerCase(),
    signAuthorization: (auth, domain) =>
      account.signTypedData({
        domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: authorizationMessage(auth)
      })
  }
}
