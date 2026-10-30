/**
 * EconomyOS — Wallet · what the Receive aside shows, computed without React:
 * the addresses worth a QR code (one EVM address serves every EVM chain,
 * Solana has its own), the chains each family can receive on, and the words
 * under the code.
 */
import type { QRCodeToDataURLOptions } from 'qrcode'

import type { WalletChain } from './wallet-data'

export type ReceiveFamily = 'evm' | 'solana'

interface ReceiveTarget {
  address: string
  /** The `format.ts` network whose explorer shows this address. */
  explorerNetwork: string
  family: ReceiveFamily
  label: string
}

// The encoder rasterises its own colours, outside CSS. Only the modules are
// painted (near-black); the light cells and the quiet zone are transparent, so
// the tile's `--e-ink` paper shows through in every theme with no seam.
export const RECEIVE_QR_OPTIONS: QRCodeToDataURLOptions = {
  margin: 1,
  width: 176,
  errorCorrectionLevel: 'M',
  color: { dark: '#0b0a10', light: '#0000' }
}

/** The addresses that exist, EVM first — an unprovisioned family yields nothing. */
export function receiveTargets(evmAddress: string, solanaAddress: string): ReceiveTarget[] {
  const targets: ReceiveTarget[] = []
  const evm = evmAddress.trim()
  const solana = solanaAddress.trim()

  if (evm) {
    targets.push({ address: evm, explorerNetwork: 'base-mainnet', family: 'evm', label: 'EVM' })
  }

  if (solana) {
    targets.push({ address: solana, explorerNetwork: 'solana-mainnet', family: 'solana', label: 'Solana' })
  }

  return targets
}

export function chainsForFamily(chains: readonly WalletChain[], family: ReceiveFamily): WalletChain[] {
  return chains.filter(chain => chain.family.toLowerCase() === family)
}

/** The sentence under the code: which chains this address is good for. */
export function receiveCaption(family: ReceiveFamily, chains: readonly WalletChain[]): string {
  if (family === 'solana') {
    return 'Solana mainnet only — EVM tokens sent here are lost.'
  }

  const names = chainsForFamily(chains, 'evm').map(chain => chain.name)
  // The ACP chain list is where the agent TRADES; the table shows every chain
  // the balance feed reads, so the caption must not pass one off as the other.
  const trades = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]

  return trades
    ? `The same address works on every EVM chain in the table; the agent trades on ${trades}.`
    : 'The same address works on every EVM chain in the table.'
}
