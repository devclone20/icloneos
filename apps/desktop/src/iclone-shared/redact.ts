/**
 * iCLONE OS — secret scrubbing shared by the electron main process and the
 * renderer (plain TS: no DOM or Node imports). The agent door redacts CLI
 * output with it; the wizard redacts saved notes and "ask Hermes" payloads.
 */

import { redactBareMnemonics } from './redact-bip39'

// Seed-phrase names in any casing or separator: mnemonic(Phrase), seed_words, recoveryPhrase, secretRecoveryPhrase…
const SEED_KEY = String.raw`mnemonic(?:[ _-]?(?:phrase|words))?|(?:secret[ _-]?)?(?:seed|recovery)[ _-]?(?:phrase|words)`
const SECRET_KEY = String.raw`(?:access|refresh|id|auth|session)[_-]?token|private[_-]?key|secret[_-]?key|api[_-]?key|client[_-]?secret|secret|password|passwd`

// A numbered or bulleted word list on the lines under a seed-phrase label ("Seed phrase:\n1. abandon\n2. ability…").
const LIST_ITEM = String.raw`[ \t]*(?:\d{1,2}[.)]|[-*•])[ \t]*[a-z]+(?:[ \t]+(?:\d{1,2}[.)][ \t]*)?[a-z]+)*[ \t]*`

const SECRET_PATTERNS: [RegExp, string | ((match: string, ...groups: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted token]'],
  [/\b(Bearer)\s+[\w.~+/=-]{16,}/gi, '$1 [redacted]'],
  [new RegExp(String.raw`("(?:${SECRET_KEY}|${SEED_KEY}|seed)")\s*:\s*"(?:[^"\\]|\\.)*"`, 'gi'), '$1:"[redacted]"'],
  // A seed phrase as a JSON array of words: the whole array goes.
  [
    new RegExp(String.raw`("(?:${SEED_KEY}|seed)")\s*:\s*\[\s*(?:"(?:[^"\\]|\\.)*"\s*,?\s*)*\]`, 'gi'),
    '$1:["[redacted]"]'
  ],
  [
    new RegExp(
      String.raw`\b(${SEED_KEY}|seed(?=[ \t]*[:=]))([ \t]*[:=]?[ \t]*)(?:\r?\n${LIST_ITEM}(?=\r?\n|$))+`,
      'gi'
    ),
    (_match, label: string, sep: string) => `${label}${sep.trim() || ':'} [redacted]`
  ],
  // A labelled seed phrase on one line: the whole value goes, through the end of THAT line (never the next one).
  [
    new RegExp(String.raw`\b(${SEED_KEY}|seed)([ \t]*[:=][ \t]*)(?![ \t]*\[redacted)[^\r\n]*\S`, 'gi'),
    '$1$2[redacted]'
  ],
  [
    /\b((?:access|refresh|id|auth|session)[ _-]?token|private[ _-]?key|secret[ _-]?key|api[ _-]?key|client[ _-]?secret)(\s*[:=]\s*)(?!\[redacted)\S{8,}/gi,
    '$1$2[redacted]'
  ],
  // Labels whose value is a secret at any length (short passwords included), quoted or bare, JSON key or not.
  [
    /(["']?)\b(password|passwd|secret|api[ _-]?key|private[ _-]?key|access[ _-]?token)\1(\s*[:=]\s*)(?!["']?\[redacted)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
    '$1$2$1$3[redacted]'
  ],
  // Environment assignments: OPENAI_API_KEY=…, HERMES_DASHBOARD_SESSION_TOKEN=…
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY))=(?!\[redacted)[^\s"'&]+/g,
    '$1=[redacted]'
  ],
  // Credential headers of any length: X-…-Token / -Key / -Secret / -Signature and Authorization schemes.
  [/\b(X-[\w-]*?(?:Token|Key|Secret|Signature))(["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"'&,;]+/gi, '$1$2[redacted]'],
  [/\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)(?!\[redacted)[^\s"',;]+/gi, '$1[redacted]'],
  // Provider key formats: OpenAI/Anthropic/Stripe sk-/pk-/rk-, GitHub ghp_/gho_/ghs_/ghu_/ghr_/github_pat_, Slack xox?-.
  [/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|github_pat|xox[abeoprs])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]'],
  // One-time URL credentials: magic-link / OAuth query params and Stripe checkout sessions (+ their fragment).
  [
    /([?&#](?:[\w-]*token|code|state|session(?:[_-]?id)?|sid|otp|nonce|ticket|signature|sig|magic(?:[_-]?link)?)=)(?!\[redacted)[^&#\s"'<>]+/gi,
    '$1[redacted]'
  ],
  [/\bcs_(live|test)_[A-Za-z0-9]{8,}(?:#[^\s"'<>]*)?/g, 'cs_$1_[redacted]']
]

// 13–19 digits in groups of 4–6 (or contiguous), first digit 2–6; masked only when the Luhn check passes.
const CARD_NUMBER = /\b[2-6]\d{3}(?:[ -]?\d{3,6}){2,4}\b/g

function luhnValid(digits: string): boolean {
  let sum = 0

  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i])

    if (i % 2 === 1) {
      d *= 2
      d -= d > 9 ? 9 : 0
    }

    sum += d
  }

  return sum % 10 === 0
}

/** Pure: a card number typed into a note or an error (13–19 digits, Luhn-valid) → masked. */
function redactCardNumbers(text: string): string {
  return text.replace(CARD_NUMBER, match => {
    const digits = match.replace(/[ -]/g, '')

    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[redacted card number]' : match
  })
}

export interface RedactOptions {
  /** Also mask 0x + 64 hex digits (raw private keys). Off by default: transaction hashes have the same shape. */
  hex64?: boolean | undefined
  /** Also mask a non-numeric segment where an SSH port belongs (`user@host:SECRET`). Off by default: git remotes look alike. */
  sshTargets?: boolean | undefined
}

const HEX64 = /\b0x[0-9a-fA-F]{64}\b/g
const SSH_TARGET_SECRET = /(\S+@[^\s:]+):(?!\d+\b)(?!\[redacted)[^\s:]+/g

/**
 * Pure: scrub bearer tokens, JWTs, PEM keys, provider keys, secret-named fields and headers, env assignments,
 * seed phrases, card numbers and one-time URL credentials. Non-strings are stringified (nullish → '').
 */
export function redactSecrets(text: unknown, options: RedactOptions = {}): string {
  let out = typeof text === 'string' ? text : String(text ?? '')

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement)
  }

  if (options.hex64) {
    out = out.replace(HEX64, '[redacted-hex]')
  }

  if (options.sshTargets) {
    out = out.replace(SSH_TARGET_SECRET, '$1:[redacted]')
  }

  return redactCardNumbers(redactBareMnemonics(out))
}

/** Pure: true when `text` holds anything `redactSecrets` would rewrite. */
export function hasSecrets(text: string): boolean {
  return redactSecrets(text) !== text
}

const SEED_FIELD = new RegExp(String.raw`^(?:${SEED_KEY}|seed)$`, 'i')

/** Pure: every string leaf of a JSON value passed through `redactSecrets`; every leaf under a seed-phrase key masked whole. */
export function redactDeep(value: unknown): { value: unknown; masked: boolean } {
  let masked = false

  const walk = (node: unknown, seed = false): unknown => {
    if (typeof node === 'string') {
      const clean = seed ? '[redacted]' : redactSecrets(node)

      masked ||= clean !== node

      return clean
    }

    if (Array.isArray(node)) {
      return node.map(item => walk(item, seed))
    }

    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, item]) => [
          key,
          walk(item, seed || SEED_FIELD.test(key))
        ])
      )
    }

    return node
  }

  return { value: walk(value), masked }
}
