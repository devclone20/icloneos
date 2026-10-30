import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as setup from '../../acp-setup'
import { $econBadges, clearEconBadges } from '../badges'
import { invalidateAcp } from '../cli'
import { prefetchesSettled } from '../live'
import { readSnapshot, writeSnapshot } from '../snapshot'

import {
  HL_SNAPSHOT_VERSION,
  loadOrders,
  MARKETS_TTL_MS,
  ORDERS_TTL_MS,
  prefetch,
  readAccount,
  readMarkets,
  readOrders,
  readRoutes,
  ROUTES_TTL_MS,
  shapeAccount,
  shapeOrder,
  STATUS_TTL_MS,
  toSnapshot
} from './hyperliquid-data'

const INFT = 'robinhood:0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631:6'
const SLUG = 'robinhood-0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631-6'

const STATUS = '{"address":"0xabc","accountValue":"1000","withdrawable":"400","positions":[],"spotBalances":[]}'
const ORDERS = '{"orders":[{"coin":"BTC","side":"B","oid":1},{"coin":"ETH","side":"A","oid":2}]}'
const NOT_PROVISIONED = '{"error":"Trade account not set up. Call card signup first."}'

function ok(stdout: string) {
  return { ok: true, code: 0, stdout, stderr: '' }
}

function seedSnapshot(orders: number) {
  const order = shapeOrder({ coin: 'BTC', oid: 1, side: 'B' })!

  writeSnapshot(
    'hyperliquid',
    SLUG,
    HL_SNAPSHOT_VERSION,
    toSnapshot(shapeAccount({}), Array(orders).fill(order), []),
    1
  )
}

describe('hyperliquid loaders', () => {
  let run: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    run = vi.spyOn(setup, 'runAcp')
    invalidateAcp(SLUG)
    clearEconBadges()
    window.localStorage.clear()
  })

  afterEach(() => {
    run.mockRestore()
  })

  it('keeps the TTLs the timer economics rest on', () => {
    expect(STATUS_TTL_MS).toBe(30_000)
    expect(ORDERS_TTL_MS).toBe(30_000)
    expect(MARKETS_TTL_MS).toBe(600_000)
    expect(ROUTES_TTL_MS).toBe(300_000)
  })

  it('prefetch issues hl-status only, and the mount read is then a cache hit', async () => {
    run.mockResolvedValue(ok(STATUS))

    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(INFT, ['trade', 'hl-status', '--json'], undefined)

    const account = await readAccount(INFT, SLUG)

    expect(account.ok).toBe(true)
    expect(account.ok ? account.data.address : null).toBe('0xabc')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('prefetch publishes the badge from the last snapshot, and nothing without one', async () => {
    run.mockResolvedValue(ok(STATUS))

    await prefetch(INFT, SLUG)
    await prefetchesSettled()
    expect($econBadges.get()[SLUG]).toBeUndefined()

    invalidateAcp(SLUG)

    const order = shapeOrder({ coin: 'BTC', oid: 1, side: 'B' })!

    writeSnapshot('hyperliquid', SLUG, HL_SNAPSHOT_VERSION, toSnapshot(shapeAccount({}), [order, order], []), 1)
    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect($econBadges.get()[SLUG]?.hyperliquid).toBe(2)
  })

  it('prefetch publishes the badge BEFORE the CLI answers, not behind the queue', async () => {
    let answer!: (value: unknown) => void

    run.mockReturnValue(new Promise(resolve => (answer = resolve)))
    seedSnapshot(2)

    const pending = prefetch(INFT, SLUG)

    // Synchronously — the queue has not even reached the CLI yet.
    expect($econBadges.get()[SLUG]?.hyperliquid).toBe(2)

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    answer(ok(STATUS))
    await pending

    expect($econBadges.get()[SLUG]?.hyperliquid).toBe(2)
    expect(readSnapshot('hyperliquid', SLUG, HL_SNAPSHOT_VERSION)).not.toBeNull()
  })

  it('prefetch clears the snapshot and zeroes the badge for a de-provisioned iNFT', async () => {
    run.mockResolvedValue(ok(NOT_PROVISIONED))
    seedSnapshot(2)

    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect($econBadges.get()[SLUG]?.hyperliquid).toBe(0)
    expect(readSnapshot('hyperliquid', SLUG, HL_SNAPSHOT_VERSION)).toBeNull()
  })

  it('prefetch keeps the snapshot and badge across a transient failure', async () => {
    run.mockResolvedValue({ ok: false, code: null, stdout: '', stderr: '', error: 'timed out after 60s' })
    seedSnapshot(1)

    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect($econBadges.get()[SLUG]?.hyperliquid).toBe(1)
    expect(readSnapshot('hyperliquid', SLUG, HL_SNAPSHOT_VERSION)).not.toBeNull()
  })

  it('prefetch ignores a snapshot from another schema version', async () => {
    run.mockResolvedValue(ok(STATUS))

    const order = shapeOrder({ coin: 'BTC', oid: 1, side: 'B' })!

    writeSnapshot('hyperliquid', SLUG, HL_SNAPSHOT_VERSION + 1, toSnapshot(shapeAccount({}), [order], []), 1)
    await prefetch(INFT, SLUG)
    await prefetchesSettled()

    expect($econBadges.get()[SLUG]).toBeUndefined()
  })

  it('loadOrders publishes the open-order count and readOrders alone does not', async () => {
    run.mockResolvedValue(ok(ORDERS))

    const plain = await readOrders(INFT, SLUG)

    expect(plain.ok).toBe(true)
    expect($econBadges.get()[SLUG]).toBeUndefined()

    const loaded = await loadOrders(INFT, SLUG)

    expect(loaded.ok ? loaded.data.length : null).toBe(2)
    expect($econBadges.get()[SLUG]?.hyperliquid).toBe(2)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(INFT, ['trade', 'hl-orders', '--json'], undefined)
  })

  it('does not publish a badge when hl-orders fails', async () => {
    run.mockResolvedValue({ ok: false, code: null, stdout: '', stderr: '', error: 'timed out after 60s' })

    const result = await loadOrders(INFT, SLUG)

    expect(result.ok).toBe(false)
    expect($econBadges.get()[SLUG]).toBeUndefined()
  })

  it('serves the catalogue from memory within its TTL and forces on demand', async () => {
    run.mockResolvedValue(ok('{"stocks":[{"symbol":"TSLA","name":"Tesla"}]}'))

    const first = await readMarkets(INFT, SLUG)
    const second = await readMarkets(INFT, SLUG)

    expect(first.ok && second.ok).toBe(true)
    expect(first.ok && second.ok ? first.data : null).toBe(second.ok ? second.data : undefined)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(INFT, ['trade', 'stock-list', '--json'], undefined)

    await readMarkets(INFT, SLUG, true)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reads routes per symbol with the symbol before --json', async () => {
    run.mockResolvedValue(ok('{"routes":[{"name":"ondo","chain":"base"}]}'))

    const routes = await readRoutes(INFT, SLUG, 'TSLA')

    expect(routes.ok ? routes.data[0]?.network : null).toBe('base-mainnet')
    expect(run).toHaveBeenCalledWith(INFT, ['trade', 'stock-list', 'TSLA', '--json'], undefined)

    await readRoutes(INFT, SLUG, 'TSLA')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never spawns the CLI for a symbol the bridge would refuse', async () => {
    run.mockResolvedValue(ok('{"routes":[]}'))

    for (const symbol of ['TS LA', '--json', 'A'.repeat(25), '']) {
      const result = await readRoutes(INFT, SLUG, symbol)

      expect(result.ok).toBe(false)
      expect(result.ok ? null : result.kind).toBe('cli')
    }

    expect(run).not.toHaveBeenCalled()
  })
})
