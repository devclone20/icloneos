/**
 * EconomyOS — Wallet · the briefs the forms hand to the iNFT, and the checks
 * that gate them. The apps never move value themselves (handoff.ts): a valid
 * form produces one precise sentence for the composer, an invalid one
 * produces `null` and the form says what is missing.
 */
import { shortAddress } from '../format'

import { safeSymbol, type WalletToken } from './wallet-data'

export type TopUpMethod = 'card' | 'coinbase'
type AddressFamily = 'evm' | 'solana'
type SendProblem = 'address' | 'amount' | 'exceeds' | 'token' | null

interface TopUpDraft {
  amount: string
  chainId: number
  method: TopUpMethod
}

interface SendDraft {
  address: string
  amount: string
  token: WalletToken | null
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
// "1,000" and "1,000,000": commas before exactly three digits group thousands.
const GROUPED_INTEGER = /^\d{1,3}(,\d{3})+$/
// "1,250.50": with a dot as the decimal mark, every comma must group thousands.
const GROUPED_DECIMAL = /^\d{1,3}(,\d{3})+\.\d+$/
// "1,5" and "1,50": one comma before one or two digits is the decimal mark.
const COMMA_DECIMAL = /^\d+,\d{1,2}$/

export function isTopUpMethod(value: string): value is TopUpMethod {
  return value === 'card' || value === 'coinbase'
}

/** The comma is either a thousands separator or a decimal mark; it is read
 *  one way per input, never guessed, and an ambiguous mix reads as nothing. */
function normaliseSeparators(raw: string): string | null {
  if (!raw.includes(',')) {
    return raw
  }

  if (GROUPED_INTEGER.test(raw) || GROUPED_DECIMAL.test(raw)) {
    return raw.replace(/,/g, '')
  }

  if (COMMA_DECIMAL.test(raw)) {
    return raw.replace(',', '.')
  }

  return null
}

/** A positive amount typed by a person: "$25", "1,5", "1,000" and "1,250.50" all read. */
export function parseAmount(text: string): number | null {
  const raw = text.trim().replace(/^\$/, '').replace(/\s+/g, '')
  const normalised = normaliseSeparators(raw)

  if (normalised === null || !/^\d*\.?\d+$/.test(normalised)) {
    return null
  }

  const value = Number(normalised)

  return Number.isFinite(value) && value > 0 ? value : null
}

/** A number the CLI reads back: no grouping, no exponent, no trailing zeros. */
export function plainAmount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0'
  }

  return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 })
}

/** What the typed amount will be sent as, when the typing had to be read
 *  ("1,000" → "$1,000.00"); null while the text already is the plain number. */
export function amountEcho(text: string, format: (value: number) => string): string | null {
  const value = parseAmount(text)

  if (value === null || text.trim() === plainAmount(value)) {
    return null
  }

  return format(value)
}

export function addressFamily(network: string): AddressFamily {
  return network.startsWith('solana') ? 'solana' : 'evm'
}

export function isPlausibleAddress(address: string, family: AddressFamily): boolean {
  const trimmed = address.trim()

  return family === 'solana' ? SOLANA_ADDRESS.test(trimmed) : EVM_ADDRESS.test(trimmed)
}

/** The contract behind a non-native token, read from its key `<network>:<address>`. */
export function tokenContract(token: WalletToken): string | null {
  if (token.isNative) {
    return null
  }

  const contract = token.key.slice(token.key.indexOf(':') + 1)

  return contract && contract !== 'native' ? contract : null
}

/** How a brief names the asset. A ticker is metadata anyone can write — a
 *  spam airdrop calls itself USDC — so a non-native token is pinned by its
 *  contract address and the ticker is re-checked; a native one says so. */
export function assetLabel(token: WalletToken): string {
  const contract = tokenContract(token)

  if (contract === null) {
    return `native ${token.symbol}`
  }

  return `${safeSymbol(token.symbol, contract)} (contract ${contract})`
}

/** The option text that tells two held tokens apart when they share a ticker. */
export function tokenDisambiguator(token: WalletToken): string {
  const contract = tokenContract(token)

  return contract === null ? 'native' : shortAddress(contract)
}

/** The first thing wrong with a send, in the order the form reads. */
export function sendProblem(draft: SendDraft): SendProblem {
  if (!draft.token) {
    return 'token'
  }

  const amount = parseAmount(draft.amount)

  if (amount === null) {
    return 'amount'
  }

  if (amount > draft.token.amount) {
    return 'exceeds'
  }

  if (!isPlausibleAddress(draft.address, addressFamily(draft.token.network))) {
    return 'address'
  }

  return null
}

export function sendBrief(draft: SendDraft): string | null {
  if (sendProblem(draft) !== null || !draft.token) {
    return null
  }

  const amount = parseAmount(draft.amount) ?? 0

  return `send ${plainAmount(amount)} ${assetLabel(draft.token)} on ${draft.token.chainLabel} to ${draft.address.trim()} — confirm the signer policy allows it, and run a dry-run first.`
}

export function topUpBrief(draft: TopUpDraft): string | null {
  const amount = parseAmount(draft.amount)

  if (amount === null || !isTopUpMethod(draft.method) || !Number.isInteger(draft.chainId) || draft.chainId <= 0) {
    return null
  }

  return `top up this wallet — run \`acp wallet topup --method ${draft.method} --chain-id ${draft.chainId} --amount ${plainAmount(amount)}\` and report back once it completes.`
}

export function computeTopUpBrief(text: string): string | null {
  const amount = parseAmount(text)

  if (amount === null) {
    return null
  }

  return `top up inference compute — run \`acp compute top-up --amount ${plainAmount(amount)}\` and confirm the new remaining balance.`
}
