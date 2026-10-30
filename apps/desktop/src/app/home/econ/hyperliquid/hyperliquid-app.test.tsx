import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $econBadges, clearEconBadges } from '../badges'
import { invalidateAcp } from '../cli'
import { $econStatus } from '../live'
import { readSnapshot, writeSnapshot } from '../snapshot'
import type { EconAppProps } from '../types'

import { HL_SNAPSHOT_VERSION, shapeAccount, shapeOrder, toSnapshot } from './hyperliquid-data'
import { buyBrief, perpBrief } from './hyperliquid-forms'

// The CLI bridge is the only seam mocked: shapers, queue, cache, snapshot,
// badge and rendering all run for real.
const runAcp = vi.fn()
const ask = vi.fn()
const openSetup = vi.fn()

vi.mock('../../acp-setup', () => ({ runAcp: (...args: unknown[]) => runAcp(...args) }))

vi.mock('../handoff', () => ({
  EconWindowContext: createContext({ close: () => undefined, agentName: 'Vega' }),
  useAskInft: () => ask,
  useOpenSetup: () => openSetup
}))

const { default: HyperliquidApp } = await import('./hyperliquid-app')

const props: EconAppProps = {
  inftId: 'eip155:8453:0xabc:7',
  slug: 'inft-hl',
  identity: null,
  refreshKey: 0,
  expanded: false
}

const ADDRESS = `0x${'ab'.repeat(20)}`
const STATUS = { accountValue: '1000', address: ADDRESS, positions: [], spotBalances: [], withdrawable: '400' }

const ORDERS = {
  orders: [
    { coin: 'BTC', oid: 1, side: 'B' },
    { coin: 'ETH', oid: 2, side: 'A' }
  ]
}

const STOCKS = {
  stocks: [
    { name: 'Tesla', protocols: ['ondo'], symbol: 'TSLA' },
    { name: 'Nvidia', protocols: ['ondo'], symbol: 'NVDA' },
    { name: 'Not a symbol', protocols: ['ondo'], symbol: 'TS LA' }
  ]
}

const ROUTES = {
  routes: [
    { address: ADDRESS, chain: 'base', name: 'ondo' },
    { address: 'foo/../bar', chain: 'base', name: 'xstocks' }
  ]
}

function reply(payload: unknown) {
  return Promise.resolve({ ok: true, code: 0, stdout: JSON.stringify(payload), stderr: '' })
}

function route(_inftId: string, argv: string[]) {
  const [group, command, symbol] = argv

  if (group !== 'trade') {
    return reply({ error: 'unexpected command' })
  }

  switch (command) {
    case 'hl-status':
      return reply(STATUS)

    case 'hl-orders':
      return reply(ORDERS)

    case 'stock-list':
      return symbol === '--json' ? reply(STOCKS) : reply(ROUTES)

    default:
      return reply({ error: 'unexpected command' })
  }
}

function argvsOf(command: string): string[][] {
  return runAcp.mock.calls.map(call => call[1] as string[]).filter(argv => argv[1] === command)
}

function seedSnapshot(slug: string, orders: number) {
  const order = shapeOrder({ coin: 'BTC', oid: 1, side: 'B' })!

  writeSnapshot(
    'hyperliquid',
    slug,
    HL_SNAPSHOT_VERSION,
    toSnapshot(shapeAccount(STATUS), Array<typeof order>(orders).fill(order), []),
    1
  )
}

function statusOf(slug: string) {
  return $econStatus.get()[`hyperliquid:${slug}`]
}

beforeEach(() => {
  window.localStorage.clear()
  clearEconBadges()
  $econStatus.set({})
  runAcp.mockReset()
  runAcp.mockImplementation(route)
  ask.mockReset()
  openSetup.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('HyperliquidApp', () => {
  it('paints the snapshot in the first render and re-persists only once orders answered live', async () => {
    const slug = 'inft-hl-snap'
    let answerOrders!: (value: unknown) => void

    runAcp.mockImplementation((inftId: string, argv: string[]) =>
      argv[1] === 'hl-orders' ? new Promise(resolve => (answerOrders = resolve)) : route(inftId, argv)
    )
    invalidateAcp(slug)
    seedSnapshot(slug, 1)

    render(<HyperliquidApp {...props} slug={slug} />)

    // Synchronously: the rail already wears the snapshot's order count.
    expect(within(screen.getByRole('button', { name: /Orders/ })).getByText('1')).toBeTruthy()
    expect(statusOf(slug)?.updatedAt).toBe(1)
    expect($econBadges.get()[slug]?.hyperliquid).toBe(1)

    // hl-status applied, hl-orders requested — the snapshot must not have moved.
    await waitFor(() => expect(argvsOf('hl-orders')).toHaveLength(1))
    expect(readSnapshot('hyperliquid', slug, HL_SNAPSHOT_VERSION)?.at).toBe(1)

    answerOrders({ ok: true, code: 0, stdout: JSON.stringify(ORDERS), stderr: '' })

    await waitFor(() => expect($econBadges.get()[slug]?.hyperliquid).toBe(2))

    const persisted = readSnapshot<{ orders: unknown[] }>('hyperliquid', slug, HL_SNAPSHOT_VERSION)

    expect(persisted?.at).toBeGreaterThan(1)
    expect(persisted?.data.orders).toHaveLength(2)
    expect(statusOf(slug)?.error).toBeNull()
    expect(statusOf(slug)?.updatedAt).toBeGreaterThan(1)
  })

  it('on a de-provisioned iNFT clears the snapshot, zeroes the badge, offers Setup and reports the header error', async () => {
    const slug = 'inft-hl-gone'
    const message = 'Trade account not set up. Call card signup first.'

    runAcp.mockImplementation(() => reply({ error: message }))
    invalidateAcp(slug)
    seedSnapshot(slug, 1)

    render(<HyperliquidApp {...props} slug={slug} />)

    expect(await screen.findByRole('button', { name: 'Open Setup' })).toBeTruthy()
    await waitFor(() => expect(statusOf(slug)?.error).toBe(message))

    expect(readSnapshot('hyperliquid', slug, HL_SNAPSHOT_VERSION)).toBeNull()
    expect($econBadges.get()[slug]?.hyperliquid).toBe(0)
    expect(screen.getByText('Account unavailable')).toBeTruthy()
    expect(argvsOf('hl-orders')).toHaveLength(0)
  })

  it('R16.copy.hyperliquid_sign_in_again: an expired session keeps the snapshot and offers Sign in again', async () => {
    const slug = 'inft-hl-expired'

    runAcp.mockImplementation(() => reply({ error: 'Not authenticated.' }))
    invalidateAcp(slug)
    seedSnapshot(slug, 1)

    render(<HyperliquidApp {...props} slug={slug} />)

    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy()
    await waitFor(() => expect(statusOf(slug)?.error).toBe('The Virtuals session for this iNFT expired.'))

    expect(readSnapshot('hyperliquid', slug, HL_SNAPSHOT_VERSION)).not.toBeNull()
    expect(screen.queryByText(/setup needed|unprovisioned/i)).toBeNull()
    expect(argvsOf('hl-orders')).toHaveLength(0)
  })

  it('on a transient hl-status failure keeps the snapshot, offers Try again and reports the header error', async () => {
    const slug = 'inft-hl-flaky'

    runAcp.mockImplementation(() =>
      Promise.resolve({ ok: false, code: null, stdout: '', stderr: '', error: 'timed out after 60s' })
    )
    invalidateAcp(slug)
    seedSnapshot(slug, 1)

    render(<HyperliquidApp {...props} slug={slug} />)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    await waitFor(() => expect(statusOf(slug)?.error).toBe('timed out after 60s'))

    expect(readSnapshot('hyperliquid', slug, HL_SNAPSHOT_VERSION)?.at).toBe(1)
    expect($econBadges.get()[slug]?.hyperliquid).toBe(1)
    expect(within(screen.getByRole('button', { name: /Orders/ })).getByText('1')).toBeTruthy()
  })

  it('lists only bridge-valid symbols, opens the first LIVE match on Enter and links only address-shaped routes', async () => {
    const slug = 'inft-hl-markets'

    invalidateAcp(slug)

    const { container } = render(<HyperliquidApp {...props} slug={slug} />)

    fireEvent.click(screen.getByRole('button', { name: /Markets/ }))

    const grid = await screen.findByRole('grid', { name: 'Markets' })

    expect(within(grid).getAllByRole('row')).toHaveLength(2)
    expect(screen.queryByText('TS LA')).toBeNull()

    const search = screen.getByRole('searchbox')

    fireEvent.change(search, { target: { value: 'nv' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect((await screen.findByRole('heading', { level: 3, name: 'NVDA' })).textContent).toBe('NVDA')
    await waitFor(() => expect(argvsOf('stock-list').some(argv => argv[2] === 'NVDA')).toBe(true))

    // Two routes come back; only the 0x-address one gets an explorer link.
    expect(await screen.findByText('xstocks')).toBeTruthy()
    expect(container.querySelectorAll('.hl-route')).toHaveLength(2)
    expect(container.querySelectorAll('.hl-route .e-addr__link')).toHaveLength(1)

    // Buy opens a form in the aside; the brief leaves only on Ask, with the real
    // amount and no CLI command (UF2B1-c1-03).
    fireEvent.click(screen.getByRole('button', { name: /Buy via/ }))
    expect(ask).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 3, name: 'Buy NVDA' })).toBeTruthy()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Spend (USDC)' }), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: /^Ask / }))
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toBe(buyBrief('NVDA', 25))
    expect(ask.mock.calls[0][0]).not.toMatch(/acp |--|<|`/)
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('U3-p2-01: Deposit opens a form inside the window; nothing reaches the composer until Ask', async () => {
    render(<HyperliquidApp {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: /Deposit/ }))

    expect(ask).not.toHaveBeenCalled()
    expect(screen.getByRole('spinbutton', { name: /Amount \(USDC\)/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Ask / })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('UF2B1-c1-02: a window painted from the snapshot reads the account before orders; after a live account a refresh spawns both at once', async () => {
    const slug = 'inft-hl-concurrent'
    let answerStatus!: (value: unknown) => void

    runAcp.mockImplementation((inftId: string, argv: string[]) =>
      argv[1] === 'hl-status' ? new Promise(resolve => (answerStatus = resolve)) : route(inftId, argv)
    )
    invalidateAcp(slug)
    seedSnapshot(slug, 1)

    const view = render(<HyperliquidApp {...props} slug={slug} />)

    await waitFor(() => expect(argvsOf('hl-status')).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    // The snapshot's account is not a live one: orders wait for hl-status.
    expect(argvsOf('hl-orders')).toHaveLength(0)

    answerStatus({ ok: true, code: 0, stdout: JSON.stringify(STATUS), stderr: '' })
    await waitFor(() => expect(argvsOf('hl-orders')).toHaveLength(1))
    await waitFor(() => expect(statusOf(slug)?.updatedAt).toBeGreaterThan(1))

    // A forced refresh with a live account: orders are in flight while the
    // account is still unanswered (U3-p2-07).
    view.rerender(<HyperliquidApp {...props} refreshKey={1} slug={slug} />)
    await waitFor(() => expect(argvsOf('hl-status')).toHaveLength(2))
    await waitFor(() => expect(argvsOf('hl-orders')).toHaveLength(2))

    answerStatus({ ok: true, code: 0, stdout: JSON.stringify(STATUS), stderr: '' })
    await waitFor(() => expect(statusOf(slug)?.error).toBeNull())
  })

  it('UF2B1-c1-03: Open perp opens a form; the brief carries side, size and leverage in plain language', async () => {
    const slug = 'inft-hl-perp'

    invalidateAcp(slug)
    render(<HyperliquidApp {...props} slug={slug} />)

    fireEvent.click(screen.getByRole('button', { name: /Markets/ }))
    await screen.findByRole('grid', { name: 'Markets' })

    const search = screen.getByRole('searchbox')

    fireEvent.change(search, { target: { value: 'ts' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await screen.findByRole('heading', { level: 3, name: 'TSLA' })

    fireEvent.click(screen.getByRole('button', { name: /Open perp via/ }))
    expect(ask).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 3, name: 'Open perp on TSLA' })).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: 'Side' }), { target: { value: 'short' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Size (TSLA)' }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Leverage' }), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /^Ask / }))

    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toBe(perpBrief('TSLA', 'short', 2, 5))
    expect(ask.mock.calls[0][0]).not.toMatch(/acp |--|<|`/)
  })
})
