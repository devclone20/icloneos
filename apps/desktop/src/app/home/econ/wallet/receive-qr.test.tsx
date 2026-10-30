import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const { toDataURL } = vi.hoisted(() => ({ toDataURL: vi.fn() }))

vi.mock('qrcode', () => ({ toDataURL: (...args: unknown[]) => toDataURL(...args) }))

import { ReceiveAside } from './receive-qr'

const EVM = '0x5bB4B0bd6FFbF4D1a1b8F4E6b2F0cA7d9E1f2A3b'
const SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

const CHAINS = {
  environment: 'mainnet',
  chains: [
    { id: 8453, name: 'Base', family: 'evm' },
    { id: 501, name: 'Solana', family: 'solana' }
  ]
}

beforeEach(() => {
  toDataURL.mockReset()
  toDataURL.mockImplementation(async (text: string) => `data:image/png;base64,${text.slice(0, 6)}`)
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('draws the EVM code first, with the address in full beside a copy button', async () => {
  render(
    <ReceiveAside
      agentName="Otto"
      chains={CHAINS}
      chainsError={null}
      chainsPending={false}
      evmAddress={EVM}
      onRetryChains={() => undefined}
      solanaAddress={SOLANA}
    />
  )

  const img = await screen.findByRole('img', { name: 'EVM address QR code' })

  expect(img).toHaveProperty('src', `data:image/png;base64,${EVM.slice(0, 6)}`)
  expect(toDataURL).toHaveBeenCalledWith(EVM, expect.objectContaining({ width: 176, margin: 1 }))
  expect(screen.getByText(EVM)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  expect(screen.getByText('Base')).toBeTruthy()
  expect(screen.queryByText('Solana', { selector: '.e-pill' })).toBeNull()
})

test('the Solana tab encodes the Solana address and lists its chain', async () => {
  render(
    <ReceiveAside
      agentName="Otto"
      chains={CHAINS}
      chainsError={null}
      chainsPending={false}
      evmAddress={EVM}
      onRetryChains={() => undefined}
      solanaAddress={SOLANA}
    />
  )

  fireEvent.click(screen.getByRole('tab', { name: 'Solana' }))

  const img = await screen.findByRole('img', { name: 'Solana address QR code' })

  expect(img).toHaveProperty('src', `data:image/png;base64,${SOLANA.slice(0, 6)}`)
  expect(screen.getByText(SOLANA)).toBeTruthy()
  expect(screen.getByText(/Solana mainnet only/)).toBeTruthy()
})

test('a failed encode keeps the address and says to copy it', async () => {
  const address = '0x000000000000000000000000000000000000dEaD'

  toDataURL.mockRejectedValue(new Error('no canvas'))

  render(
    <ReceiveAside
      agentName="Otto"
      chains={null}
      chainsError={null}
      chainsPending={true}
      evmAddress={address}
      onRetryChains={() => undefined}
      solanaAddress=""
    />
  )

  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/copy the address/))
  expect(screen.getByText(address)).toBeTruthy()
  expect(screen.queryByRole('tab')).toBeNull()
  expect(screen.getByText(/reading supported chains/)).toBeTruthy()
})

test('with no address yet it says what comes next', () => {
  render(
    <ReceiveAside
      agentName="Otto"
      chains={null}
      chainsError={null}
      chainsPending={false}
      evmAddress=""
      onRetryChains={() => undefined}
      solanaAddress=""
    />
  )

  expect(screen.getByText('No address yet')).toBeTruthy()
  expect(toDataURL).not.toHaveBeenCalled()
})

test('a chain list that could not be read says so, once, with a retry', async () => {
  const onRetryChains = vi.fn()

  render(
    <ReceiveAside
      agentName="Otto"
      chains={null}
      chainsError={{ ok: false, kind: 'timeout', error: 'Request timed out' }}
      chainsPending={false}
      evmAddress={EVM}
      onRetryChains={onRetryChains}
      solanaAddress=""
    />
  )

  await screen.findByRole('img', { name: 'EVM address QR code' })

  expect(screen.getByRole('status').textContent).toMatch(/chain list unavailable/)
  expect(screen.queryByText(/reading supported chains/)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'try again' }))

  expect(onRetryChains).toHaveBeenCalledTimes(1)
})
