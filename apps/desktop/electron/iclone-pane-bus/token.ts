/**
 * Per-pane bus tokens. Each token is `v1.<nonce>.<mac>` where
 * mac = HMAC-SHA256(run key, paneId | nonce). The run key never leaves main,
 * so a token cannot be derived for another pane, and the nonce → pane map is
 * the only way back to an identity: the token IS the sender, whatever the
 * request body claims. The `it.json` bearer is a different secret and is
 * never accepted here.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface PaneTokens {
  mint: (paneId: string) => string
  /** The pane a token speaks for, or null (unknown, revoked, or forged). */
  verify: (token: string) => null | string
  revoke: (paneId: string) => void
}

export function createPaneTokens(key: Buffer = randomBytes(32)): PaneTokens {
  const paneOfNonce = new Map<string, string>()
  const nonceOfPane = new Map<string, string>()

  const mac = (paneId: string, nonce: string) => createHmac('sha256', key).update(`${paneId}|${nonce}`).digest('hex')

  const revoke = (paneId: string) => {
    const nonce = nonceOfPane.get(paneId)

    if (nonce) {
      paneOfNonce.delete(nonce)
      nonceOfPane.delete(paneId)
    }
  }

  return {
    mint(paneId) {
      revoke(paneId)
      const nonce = randomBytes(16).toString('hex')

      paneOfNonce.set(nonce, paneId)
      nonceOfPane.set(paneId, nonce)

      return `v1.${nonce}.${mac(paneId, nonce)}`
    },
    verify(token) {
      const [version, nonce, given] = token.split('.')

      if (version !== 'v1' || !nonce || !given) {
        return null
      }

      const paneId = paneOfNonce.get(nonce)

      if (!paneId) {
        return null
      }

      const expected = Buffer.from(mac(paneId, nonce))
      const actual = Buffer.from(given)

      return actual.length === expected.length && timingSafeEqual(actual, expected) ? paneId : null
    },
    revoke
  }
}
