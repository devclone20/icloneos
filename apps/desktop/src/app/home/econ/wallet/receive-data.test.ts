import { describe, expect, it } from 'vitest'

import { chainsForFamily, RECEIVE_QR_OPTIONS, receiveCaption, receiveTargets } from './receive-data'

const CHAINS = [
  { id: 8453, name: 'Base', family: 'evm' },
  { id: 1, name: 'Ethereum', family: 'evm' },
  { id: 501, name: 'Solana', family: 'solana' }
]

describe('receiveTargets', () => {
  it('lists EVM then Solana, trimmed, and skips what is not provisioned', () => {
    expect(receiveTargets(' 0xabc ', 'Sol111')).toEqual([
      { address: '0xabc', explorerNetwork: 'base-mainnet', family: 'evm', label: 'EVM' },
      { address: 'Sol111', explorerNetwork: 'solana-mainnet', family: 'solana', label: 'Solana' }
    ])
    expect(receiveTargets('', 'Sol111').map(target => target.family)).toEqual(['solana'])
    expect(receiveTargets('', '   ')).toEqual([])
  })
})

describe('chainsForFamily', () => {
  it('filters by family, case-insensitively', () => {
    expect(chainsForFamily(CHAINS, 'evm').map(chain => chain.name)).toEqual(['Base', 'Ethereum'])
    expect(chainsForFamily([{ id: 501, name: 'Solana', family: 'SOLANA' }], 'solana')).toHaveLength(1)
  })
})

describe('receiveCaption', () => {
  it('names the EVM chains when they are known and stays honest when they are not', () => {
    expect(receiveCaption('evm', CHAINS)).toBe(
      'The same address works on every EVM chain in the table; the agent trades on Base and Ethereum.'
    )
    expect(receiveCaption('evm', [])).toBe('The same address works on every EVM chain in the table.')
    expect(receiveCaption('solana', CHAINS)).toMatch(/Solana mainnet only/)
  })
})

describe('RECEIVE_QR_OPTIONS', () => {
  it('encodes a 176px code with a one-module quiet zone at level M', () => {
    expect(RECEIVE_QR_OPTIONS).toMatchObject({ margin: 1, width: 176, errorCorrectionLevel: 'M' })
    expect(RECEIVE_QR_OPTIONS.color?.dark).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('leaves the light cells transparent so the tile paints the paper in every theme', () => {
    expect(RECEIVE_QR_OPTIONS.color?.light).toBe('#0000')
  })
})
