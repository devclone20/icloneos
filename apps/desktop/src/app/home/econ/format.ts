/**
 * EconomyOS — number, money, chain and address formatting shared by the apps.
 * Every figure a user reads in a Dock app goes through here, so a wallet, a
 * card and a perp table agree on how "$1,234.56", "0.0117 ETH" and "0x4d68…cafb"
 * look.
 */
import { type AgoLabels, formatAgo, toEpochMs } from '@/iclone-shared/time'

export { shortAddress } from '../lib/format'

/** Dock apps read in English whatever the machine's locale: the copy around
 *  every figure is English, and "0,00 US$ · updated agora" beside it is not.
 *  @public — econ/email/data/days.ts (a `data/` folder: the repo .gitignore hides it from knip). */
export const LOCALE = 'en-US'

const fmtDateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })

const AGO: AgoLabels = {
  now: 'just now',
  seconds: seconds => `${seconds}s ago`,
  minutes: minutes => `${minutes}m ago`,
  hours: hours => `${hours}h ago`,
  days: days => `${days}d ago`
}

/** "3m ago" · "just now" — compact, English, for a moment in the past given as
 *  epoch ms or an ISO string; "—" when it is neither. */
export function timeAgo(at: unknown, nowMs = Date.now()): string {
  const ms = toEpochMs(at)

  return ms === null ? '—' : formatAgo(ms, AGO, { nowMs })
}

/** The names the email and bank apps still import (their fronts move them to `timeAgo`). */
export { timeAgo as ago }

/** @public — econ/email/data/days.ts (a `data/` folder: the repo .gitignore hides it from knip). */
export { timeAgo as relativeTime }

const usdFull = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const usdFine = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
})

const plain = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })

/** "$1,234.56" · sub-cent amounts keep two more digits · non-numbers read "—". */
export function usd(value: null | number | string | undefined): string {
  const amount = typeof value === 'string' ? Number(value) : value

  if (amount == null || !Number.isFinite(amount)) {
    return '—'
  }

  if (amount !== 0 && Math.abs(amount) < 0.01) {
    return usdFine.format(amount)
  }

  return usdFull.format(amount)
}

/** "+3.9%" / "−0.3%" with the true minus sign. */
function pct(value: null | number | string | undefined, digits = 2): string {
  const amount = typeof value === 'string' ? Number(value) : value

  if (amount == null || !Number.isFinite(amount)) {
    return '—'
  }

  const sign = amount > 0 ? '+' : amount < 0 ? '−' : ''

  return `${sign}${Math.abs(amount).toFixed(digits)}%`
}

/** A token quantity: enough decimals to be honest, never a wall of zeros. */
/** `+$1,234.50` / `−$0.42` — a USD change with its sign always shown, so a flat
 *  figure reads `+$0.00` beside its `$0.00` siblings, never a bare `+0.00`. */
export function signedUsd(value: number): string {
  return `${value < 0 ? '−' : '+'}${usd(Math.abs(value))}`
}

export function tokenAmount(value: number): string {
  if (!Number.isFinite(value)) {
    return '—'
  }

  if (value === 0) {
    return '0'
  }

  const abs = Math.abs(value)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.0001 ? 6 : 8

  return value.toLocaleString(LOCALE, { maximumFractionDigits: digits })
}

export function number(value: null | number | string | undefined): string {
  const amount = typeof value === 'string' ? Number(value) : value

  return amount == null || !Number.isFinite(amount) ? '—' : plain.format(amount)
}

/** `0x…` hex quantities (Alchemy-style) → a JS number in token units. Exact
 *  through BigInt until the final division, so large balances stay right. */
export function fromHexUnits(hex: string, decimals: number): number {
  if (!/^0x[0-9a-f]*$/i.test(hex ?? '')) {
    return 0
  }

  const raw = BigInt(hex === '0x' ? '0x0' : hex)
  const scale = 10n ** BigInt(Math.max(0, decimals))
  const whole = raw / scale
  const fraction = raw % scale

  return Number(whole) + Number(fraction) / Number(scale)
}

export function when(iso: null | string | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN

  return Number.isFinite(ms) ? fmtDateTime.format(ms) : '—'
}

// ── chains ──────────────────────────────────────────────────────────────────

export interface ChainInfo {
  /** The CLI's network id, e.g. `base-mainnet`. */
  network: string
  chainId: number
  label: string
  /** The gas token — what a row with `tokenAddress: null` holds. */
  native: string
  nativeDecimals: number
  /** `…/address/<addr>` explorer prefix; empty when there is no public one. */
  explorer: string
}

const CHAINS: ChainInfo[] = [
  {
    network: 'base-mainnet',
    chainId: 8453,
    label: 'Base',
    native: 'ETH',
    nativeDecimals: 18,
    explorer: 'https://basescan.org/address/'
  },
  {
    network: 'eth-mainnet',
    chainId: 1,
    label: 'Ethereum',
    native: 'ETH',
    nativeDecimals: 18,
    explorer: 'https://etherscan.io/address/'
  },
  {
    network: 'arb-mainnet',
    chainId: 42161,
    label: 'Arbitrum',
    native: 'ETH',
    nativeDecimals: 18,
    explorer: 'https://arbiscan.io/address/'
  },
  {
    network: 'opt-mainnet',
    chainId: 10,
    label: 'Optimism',
    native: 'ETH',
    nativeDecimals: 18,
    explorer: 'https://optimistic.etherscan.io/address/'
  },
  {
    network: 'bnb-mainnet',
    chainId: 56,
    label: 'BNB Chain',
    native: 'BNB',
    nativeDecimals: 18,
    explorer: 'https://bscscan.com/address/'
  },
  {
    network: 'matic-mainnet',
    chainId: 137,
    label: 'Polygon',
    native: 'POL',
    nativeDecimals: 18,
    explorer: 'https://polygonscan.com/address/'
  },
  {
    network: 'polygon-mainnet',
    chainId: 137,
    label: 'Polygon',
    native: 'POL',
    nativeDecimals: 18,
    explorer: 'https://polygonscan.com/address/'
  },
  { network: 'monad-mainnet', chainId: 143, label: 'Monad', native: 'MON', nativeDecimals: 18, explorer: '' },
  {
    network: 'robinhood-mainnet',
    chainId: 4663,
    label: 'Robinhood Chain',
    native: 'ETH',
    nativeDecimals: 18,
    explorer: 'https://robinhoodchain.blockscout.com/address/'
  },
  { network: 'arc-mainnet', chainId: 5042, label: 'Arc', native: 'USDC', nativeDecimals: 6, explorer: '' },
  {
    network: 'solana-mainnet',
    chainId: 501,
    label: 'Solana',
    native: 'SOL',
    nativeDecimals: 9,
    explorer: 'https://solscan.io/account/'
  },
  {
    network: 'hyperliquid',
    chainId: 1337,
    label: 'Hyperliquid',
    native: 'USDC',
    nativeDecimals: 6,
    explorer: 'https://app.hyperliquid.xyz/explorer/address/'
  }
]

const BY_NETWORK = new Map(CHAINS.map(chain => [chain.network, chain]))
const BY_ID = new Map(CHAINS.map(chain => [chain.chainId, chain]))

export function chainByNetwork(network: string): ChainInfo {
  return (
    BY_NETWORK.get(network) ?? {
      network,
      chainId: 0,
      label: network.replace(/-mainnet$/, '').replace(/-/g, ' '),
      native: '',
      nativeDecimals: 18,
      explorer: ''
    }
  )
}

export function chainById(chainId: number): ChainInfo | undefined {
  return BY_ID.get(chainId)
}

export function explorerAddressUrl(network: string, address: string): string {
  const chain = chainByNetwork(network)

  return chain.explorer ? `${chain.explorer}${address}` : ''
}

/** Text for a brief: one line, no control characters, bounded. */
export function oneLine(text: string, max = 160): string {
  const flat = text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** How a brief quotes untrusted text: `'single'` inside a single-quoted shell
 *  argument (`--requirements '…'`), `'double'` inside double quotes (mail). */
type BriefQuote = 'double' | 'single'

/** Untrusted text going into a brief the iNFT runs as a shell command: one
 *  line, bounded, and nothing that could close the quoting around it. */
export function briefText(text: string, max: number, quote: BriefQuote): string {
  if (quote === 'single') {
    return oneLine(text, max).replace(/'/g, '’')
  }

  const line = text
    .replace(/[`"“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
