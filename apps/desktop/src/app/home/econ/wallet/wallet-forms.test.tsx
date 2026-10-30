import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { WalletToken } from './wallet-data'
import { SendForm, TopUpForm } from './wallet-forms'

const EVM = '0x5bB4B0bd6FFbF4D1a1b8F4E6b2F0cA7d9E1f2A3b'
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const FAKE_CONTRACT = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead'

const USDC: WalletToken = {
  key: `base-mainnet:${USDC_CONTRACT}`,
  network: 'base-mainnet',
  chainId: 8453,
  chainLabel: 'Base',
  symbol: 'USDC',
  name: 'USD Coin',
  logo: '',
  isNative: false,
  amount: 100,
  price: 1,
  usd: 100
}

const FAKE_USDC: WalletToken = { ...USDC, key: `base-mainnet:${FAKE_CONTRACT}`, name: 'USDC', amount: 5000, usd: 0 }

const ETH: WalletToken = {
  ...USDC,
  key: 'base-mainnet:native',
  symbol: 'ETH',
  name: 'Ether',
  isNative: true,
  amount: 2
}

const NO_RETRY = () => undefined

test('Send stays disabled until the draft is sound, explains why, and hands over one brief with the contract', () => {
  const onSubmit = vi.fn()

  render(<SendForm agentName="Otto" onSubmit={onSubmit} onTopUp={() => undefined} tokens={[USDC]} />)

  const submit = screen.getByRole('button', { name: 'Ask Otto to send' })

  expect(submit).toHaveProperty('disabled', true)

  fireEvent.change(screen.getByLabelText('Token'), { target: { value: USDC.key } })
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } })

  expect(screen.getByText('Only 100 USDC available.')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /Max/ }))
  fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: '0x123' } })

  expect(screen.getByText(/EVM address is 0x/)).toBeTruthy()
  expect(submit).toHaveProperty('disabled', true)

  fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: EVM } })

  expect(submit).toHaveProperty('disabled', false)
  expect(onSubmit).not.toHaveBeenCalled()

  fireEvent.click(submit)

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit.mock.calls[0][0]).toBe(
    `send 100 USDC (contract ${USDC_CONTRACT}) on Base to ${EVM} — confirm the signer policy allows it, and run a dry-run first.`
  )
})

test('Send echoes an amount that had to be read, and tells two same-ticker tokens apart by contract', () => {
  render(
    <SendForm agentName="Otto" onSubmit={() => undefined} onTopUp={() => undefined} tokens={[USDC, FAKE_USDC, ETH]} />
  )

  const options = screen.getAllByRole('option').map(option => option.textContent)

  expect(options).toEqual([
    'Select a token',
    'USDC (0x8335…2913) · Base · 100',
    'USDC (0xdead…dead) · Base · 5,000',
    'ETH · Base · 2'
  ])

  fireEvent.change(screen.getByLabelText('Token'), { target: { value: USDC.key } })
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1,5' } })

  expect(screen.getByText('= 1.5 USDC')).toBeTruthy()

  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1.5' } })

  expect(screen.queryByText('= 1.5 USDC')).toBeNull()
})

test('Send with nothing funded points at Top up', () => {
  const onTopUp = vi.fn()

  render(<SendForm agentName="Otto" onSubmit={() => undefined} onTopUp={onTopUp} tokens={[]} />)

  fireEvent.click(screen.getByRole('button', { name: 'Top up' }))

  expect(onTopUp).toHaveBeenCalledTimes(1)
})

test('Top up defaults to Coinbase on Base for $25 and follows the chain list once it lands', () => {
  const onSubmit = vi.fn()

  const { rerender } = render(
    <TopUpForm agentName="Otto" chains={[]} chainsError={null} onRetryChains={NO_RETRY} onSubmit={onSubmit} />
  )

  fireEvent.click(screen.getByRole('button', { name: 'Ask Otto to top up' }))

  expect(onSubmit.mock.calls[0][0]).toContain('--method coinbase --chain-id 8453 --amount 25')
  expect(screen.queryByRole('status')).toBeNull()

  rerender(
    <TopUpForm
      agentName="Otto"
      chains={[
        { id: 1, name: 'Ethereum', family: 'EVM' },
        { id: 501, name: 'Solana', family: 'solana' }
      ]}
      chainsError={null}
      onRetryChains={NO_RETRY}
      onSubmit={onSubmit}
    />
  )

  // The list's family casing is the CLI's business — "EVM" still fills the select.
  fireEvent.change(screen.getByLabelText('Chain'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: '$100' }))
  fireEvent.click(screen.getByRole('button', { name: 'Ask Otto to top up' }))

  expect(onSubmit.mock.calls[1][0]).toContain('--method coinbase --chain-id 1 --amount 100')
  expect(screen.queryByRole('option', { name: 'Solana' })).toBeNull()
})

test('Top up echoes a grouped amount as the dollars that will be sent', () => {
  const onSubmit = vi.fn()

  render(<TopUpForm agentName="Otto" chains={[]} chainsError={null} onRetryChains={NO_RETRY} onSubmit={onSubmit} />)

  fireEvent.change(screen.getByLabelText('Amount (USD)'), { target: { value: '1,000' } })

  expect(screen.getByText('= $1,000.00')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Ask Otto to top up' }))

  expect(onSubmit.mock.calls[0][0]).toContain('--amount 1000')
})

test('Top up says when the chain list could not be read, assumes Base, and retries on request', () => {
  const onRetryChains = vi.fn()

  render(
    <TopUpForm
      agentName="Otto"
      chains={[]}
      chainsError={{ ok: false, kind: 'timeout', error: 'Request timed out' }}
      onRetryChains={onRetryChains}
      onSubmit={() => undefined}
    />
  )

  expect(screen.getByRole('status').textContent).toMatch(/Chain list unavailable — Base assumed/)
  expect(screen.getByRole('option', { name: 'Base' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

  expect(onRetryChains).toHaveBeenCalledTimes(1)
})

test('a tampered method select never reaches the command', () => {
  const onSubmit = vi.fn()

  render(<TopUpForm agentName="Otto" chains={[]} chainsError={null} onRetryChains={NO_RETRY} onSubmit={onSubmit} />)

  fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'card --amount 999' } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask Otto to top up' }))

  expect(onSubmit.mock.calls[0][0]).toContain('--method coinbase --chain-id 8453 --amount 25')
})
