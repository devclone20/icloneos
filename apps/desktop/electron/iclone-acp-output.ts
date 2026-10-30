/**
 * iclone os — reading what the `acp` CLI prints: field pickers over its JSON
 * (parsed by the shared tolerant reader) and the card-secret redaction applied
 * before any output leaves the main process.
 */
import { parseCliJson } from '../src/iclone-shared/cli-json'

/** The main process's name for the shared reader. */
export { parseCliJson as parseJsonLoose }

// ── parsing ─────────────────────────────────────────────────────────────────

export function firstString(source: Record<string, unknown> | null, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source?.[key]

    if (typeof value === 'string' && value) {
      return value
    }
  }

  return undefined
}

export function envelopeError(source: Record<string, unknown> | null): string | undefined {
  const value = source?.error

  return typeof value === 'string' ? value : undefined
}

// ── output redaction ────────────────────────────────────────────────────────

const CARD_SECRET_KEYS =
  /^(pan|cardNumber|number|cvv|cvv2|cvc|securityCode|expiry|expiryMonth|expiryYear|expMonth|expYear|exp_month|exp_year|zip|postalCode|cardholderName)$/i

function stripCardSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripCardSecrets)
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}

    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (!CARD_SECRET_KEYS.test(key)) {
        out[key] = stripCardSecrets(inner)
      }
    }

    return out
  }

  return value
}

/** Card answers cross IPC only as JSON with the secrets removed; anything
 *  the parser cannot read is replaced by an error rather than passed raw. */
export function redactCardOutput(stdout: string): { stdout: string; error?: string } {
  const parsed = parseCliJson(stdout)

  if (parsed === undefined) {
    return { stdout: '', error: 'card output was not readable JSON' }
  }

  return { stdout: JSON.stringify(stripCardSecrets(parsed)) }
}
