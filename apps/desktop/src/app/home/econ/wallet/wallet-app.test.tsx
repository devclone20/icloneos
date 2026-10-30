import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { $econStatus } from '../live'
import { writeSnapshot } from '../snapshot'
import type { AgentIdentity } from '../types'

const runAcp = vi.fn()

vi.mock('../../acp-setup', () => ({ runAcp: (...args: unknown[]) => runAcp(...args) }))

vi.mock('../../../chat/composer/focus', () => ({
  requestComposerFocus: () => undefined,
  requestComposerInsert: () => undefined
}))

vi.mock('qrcode', () => ({ toDataURL: async () => 'data:image/png;base64,AAAA' }))

const { default: WalletApp } = await import('./wallet-app')
const data = await import('./wallet-data')

const EVM = '0x5bB4B0bd6FFbF4D1a1b8F4E6b2F0cA7d9E1f2A3b'
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const IDENTITY: AgentIdentity = {
  id: '1042',
  name: 'Otto',
  description: '',
  imageUrl: '',
  walletAddress: EVM,
  solWalletAddress: '',
  role: '',
  rating: null,
  createdAt: '',
  builderCode: ''
}

const BALANCES = {
  address: EVM,
  solanaAddress: '',
  tokens: [
    {
      network: 'base-mainnet',
      tokenAddress: USDC_CONTRACT,
      tokenBalance: '0x5f5e100',
      tokenMetadata: { symbol: 'USDC', decimals: 6, name: 'USD Coin', logo: null },
      tokenPrices: [{ currency: 'usd', value: '1' }]
    }
  ],
  stocks: [],
  hyperliquid: { balanceUsd: '0' }
}

const COMPUTE = { limit: 50, limitRemaining: 12.5, usage: 37.5, preferredModel: 'deepseek' }
const CHAINS = { environment: 'mainnet', chains: [{ id: 8453, name: 'Base', family: 'evm' }] }

// Per-test overrides: a two-word command → the JSON it prints.
let overrides: Record<string, unknown> = {}

function answer(argv: string[]): unknown {
  const command = argv.slice(0, 2).join(' ')

  if (command in overrides) {
    return overrides[command]
  }

  switch (command) {
    case 'wallet balance':
      return BALANCES

    case 'compute status':
      return COMPUTE

    case 'chain list':
      return CHAINS

    default:
      return { error: 'unexpected command' }
  }
}

class QuietResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let slugSeq = 0

function nextSlug(): string {
  slugSeq += 1

  return `wallet-test-${slugSeq}`
}

function commands(): string[] {
  return runAcp.mock.calls.map(call => (call[1] as string[]).join(' '))
}

function mount(slug: string) {
  return render(
    <MemoryRouter>
      <WalletApp expanded={false} identity={IDENTITY} inftId="8453:0xabc:7" refreshKey={0} slug={slug} />
    </MemoryRouter>
  )
}

function seedSnapshot(slug: string, at: number) {
  const balances = data.shapeBalances(BALANCES)

  writeSnapshot('wallet', slug, data.WALLET_SNAPSHOT_VERSION, data.toWalletSnapshot(balances, null, null), at)
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', QuietResizeObserver)
  runAcp.mockImplementation(async (_inftId: string, argv: string[]) => ({
    ok: true,
    code: 0,
    stdout: JSON.stringify(answer(argv)),
    stderr: ''
  }))
})

afterEach(() => {
  runAcp.mockReset()
  overrides = {}
  vi.unstubAllGlobals()
})

test('a corrupted snapshot never reaches render, and the open reads balances then compute — nothing else', async () => {
  const slug = nextSlug()

  window.localStorage.setItem(
    `iclone.econ.snap.${slug}.wallet`,
    JSON.stringify({ v: data.WALLET_SNAPSHOT_VERSION, at: 1, data: { balances: { totalUsd: 'lots' } } })
  )

  mount(slug)

  expect(await screen.findByText('USDC')).toBeTruthy()
  await waitFor(() => expect(commands()).toContain('compute status --json'))

  expect(commands()).toEqual(['wallet balance --json', 'compute status --json'])
  expect(screen.getByText('$12.50')).toBeTruthy()
})

test('paints the last snapshot on the first frame and reads the chain list only when Receive opens', async () => {
  const slug = nextSlug()

  const at = Date.now() - 3 * 3_600_000

  seedSnapshot(slug, at)
  mount(slug)

  // Synchronously, before any CLI answer — no skeleton. The header owns the
  // window's one age (U2-p1-02); the Portfolio line carries none of its own.
  expect(screen.getByText('USDC')).toBeTruthy()
  expect($econStatus.get()[`wallet:${slug}`]?.updatedAt).toBe(at)
  expect(screen.queryByText(/updated/)).toBeNull()

  await waitFor(() => expect(commands()).toContain('compute status --json'))

  expect(commands()).not.toContain('chain list --json')

  fireEvent.click(screen.getByRole('button', { name: 'Receive' }))

  expect(await screen.findByRole('img', { name: 'EVM address QR code' })).toBeTruthy()
  await waitFor(() => expect(commands()).toContain('chain list --json'))
})

test('a failed refresh keeps the snapshot on screen, offers Try again, and labels the header', async () => {
  const slug = nextSlug()

  seedSnapshot(slug, Date.now() - 3 * 3_600_000)
  overrides = { 'wallet balance': { error: 'Request timed out after 30000 ms' } }
  mount(slug)

  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
  expect(screen.getByText('USDC')).toBeTruthy()
  // The hero figure, the rail and the row still say what the snapshot said.
  expect(screen.getAllByText('$100.00').length).toBeGreaterThanOrEqual(2)
  await waitFor(() => expect($econStatus.get()[`wallet:${slug}`]?.error).toBe('timed out'))
})

test('a wallet that could not be read prints em dashes, never $0.00', async () => {
  const slug = nextSlug()

  overrides = { 'wallet balance': { error: 'Request timed out after 30000 ms' } }
  mount(slug)

  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
  expect(screen.queryAllByText('$0.00')).toHaveLength(0)
  expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
  expect(screen.queryByText(/positions?$/)).toBeNull()
})

test('a sign-in state stops at the balance read — compute is not spent on it', async () => {
  const slug = nextSlug()

  overrides = { 'wallet balance': { error: 'HTTP 401: {"message":"REAUTH:1b2c3d4e-0000-4000-8000-000000000000"}' } }
  mount(slug)

  expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy()
  await waitFor(() => expect($econStatus.get()[`wallet:${slug}`]?.error).toBe('sign-in required'))
  expect(commands()).toEqual(['wallet balance --json'])
})

test('R16.copy.wallet_sign_in_again: an expired Virtuals session says Sign in again, keeps the Setup action', async () => {
  const slug = nextSlug()

  overrides = { 'wallet balance': { error: 'Not authenticated.' } }
  mount(slug)

  expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy()
  expect(screen.getByText(/The Virtuals session for this iNFT expired\./)).toBeTruthy()
  expect(screen.queryByText(/setup needed/i)).toBeNull()
  await waitFor(() => expect($econStatus.get()[`wallet:${slug}`]?.error).toBe('sign-in required'))
  expect(commands()).toEqual(['wallet balance --json'])
})

/** Holds every `compute status` read until `release()` — the slow Compute CLI spawn under load. */
function holdCompute(): { release: () => void } {
  let release = (): void => undefined

  const gate = new Promise<void>(resolve => {
    release = resolve
  })

  runAcp.mockImplementation(async (_inftId: string, argv: string[]) => {
    if (argv.slice(0, 2).join(' ') === 'compute status') {
      await gate
    }

    return { ok: true, code: 0, stdout: JSON.stringify(answer(argv)), stderr: '' }
  })

  return { release: () => release() }
}

test('U2-p1-02: the balances answer the window age — a pending compute read holds neither the header nor a second age', async () => {
  const slug = nextSlug()
  const at = Date.now() - 47 * 60_000
  const compute = holdCompute()

  overrides = { 'compute status': { ...COMPUTE, preferredModel: 'deepseek-deepseek-v4-1-flash' } }
  seedSnapshot(slug, at)
  mount(slug)

  await waitFor(() => expect($econStatus.get()[`wallet:${slug}`]?.updatedAt).toBeGreaterThan(at))
  expect(commands()).toEqual(['wallet balance --json', 'compute status --json'])
  expect($econStatus.get()[`wallet:${slug}`]?.refreshing).toBe(false)
  expect(screen.getByText('loading…')).toBeTruthy()
  expect(screen.queryByText(/updated/)).toBeNull()

  compute.release()

  // U2-p1-03: the model reads as a name, the provider once.
  expect(await screen.findByText('of $50.00 · Deepseek V4.1 Flash')).toBeTruthy()
})

test('U2-p1-01: a forced refresh ends "refreshing…" when the balances land, not when compute does', async () => {
  const slug = nextSlug()
  const view = mount(slug)

  expect(await screen.findByText('$12.50')).toBeTruthy()
  await waitFor(() => expect($econStatus.get()[`wallet:${slug}`]?.updatedAt).toBeGreaterThan(0))

  const compute = holdCompute()

  view.rerender(
    <MemoryRouter>
      <WalletApp expanded={false} identity={IDENTITY} inftId="8453:0xabc:7" refreshKey={1} slug={slug} />
    </MemoryRouter>
  )

  expect($econStatus.get()[`wallet:${slug}`]).toMatchObject({ refreshing: true, silent: false })
  await waitFor(() => expect(commands().filter(command => command === 'compute status --json')).toHaveLength(2))
  await waitFor(() => expect($econStatus.get()[`wallet:${slug}`]?.refreshing).toBe(false))
  expect(commands().filter(command => command === 'wallet balance --json')).toHaveLength(2)

  compute.release()
})

test('UF2B1-c1-01: a wallet grouped by chain drops the PRICE column while the Receive aside is open', async () => {
  const slug = nextSlug()

  overrides['wallet balance'] = {
    ...BALANCES,
    tokens: [
      ...BALANCES.tokens,
      {
        network: 'eth-mainnet',
        tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // gitleaks:allow — the public USDT contract on Ethereum mainnet, not a key
        tokenBalance: '0x3b9aca00',
        tokenMetadata: { symbol: 'USDT', decimals: 6, name: 'Tether USD', logo: null },
        tokenPrices: [{ currency: 'usd', value: '1' }]
      }
    ]
  }

  const { container } = mount(slug)

  expect(await screen.findByText('USDT')).toBeTruthy()
  // Two chains → the table is rendered through ChainGroup, one section per chain.
  expect(container.querySelectorAll('.wallet-group').length).toBe(2)
  expect(screen.getByText('Price')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Receive' }))

  expect(await screen.findByRole('img', { name: 'EVM address QR code' })).toBeTruthy()
  expect(container.querySelectorAll('.wallet-group').length).toBe(2)
  expect(screen.queryByText('Price')).toBeNull()
})

test('doc 07 #10: the open starts its balance read at paint, ahead of the dock warm-ups, and the header leaves "3d ago"', async () => {
  const slug = nextSlug()
  const threeDaysAgo = Date.now() - 3 * 86_400_000
  const { acpJson } = await import('../cli')
  const held: Array<() => void> = []

  // Another dock app's warm-up holds the background slot of this iNFT's lane, and one more waits behind it.
  runAcp.mockImplementation(async (_inftId: string, argv: string[]) => {
    const command = argv.slice(0, 2).join(' ')
    const reply = { ok: true, code: 0, stdout: JSON.stringify(answer(argv)), stderr: '' }

    if (command === 'card list' || command === 'email list') {
      return new Promise(resolve => held.push(() => resolve(reply)))
    }

    return reply
  })

  const warmups = [
    acpJson('8453:0xabc:7', slug, ['card', 'list', '--json'], raw => raw),
    acpJson('8453:0xabc:7', slug, ['email', 'list', '--json'], raw => raw)
  ]

  await waitFor(() => expect(commands()).toEqual(['card list --json']))

  seedSnapshot(slug, threeDaysAgo)
  mount(slug)

  expect($econStatus.get()[`wallet:${slug}`]?.updatedAt).toBe(threeDaysAgo)
  await waitFor(() => expect(commands()).toContain('wallet balance --json'))
  await waitFor(() => expect($econStatus.get()[`wallet:${slug}`]?.updatedAt ?? 0).toBeGreaterThan(Date.now() - 60_000))
  // The warm-up that was ahead of it in the queue is still waiting: the open did not queue behind it.
  expect(commands()).not.toContain('email list --json')

  const drain = async () => {
    while (held.length > 0) {
      held.shift()?.()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  await drain()
  await waitFor(() => expect(commands()).toContain('email list --json'))
  await drain()
  await Promise.all(warmups)
})

test('doc 07 #10: the first read of an open asks for the urgent slot, without forcing past the cache', async () => {
  const slug = nextSlug()
  const reads = vi.spyOn(data, 'readBalances')

  mount(slug)

  await waitFor(() => expect(reads).toHaveBeenCalled())
  expect(reads.mock.calls[0]?.[2]).toMatchObject({ atPaint: true, force: false })

  reads.mockRestore()
})
