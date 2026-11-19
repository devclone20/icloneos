// v0.0.9 Q (renderer 1, 2; tests-perf 9) — the wallet balances store: rows belong to one address and never show
// under another, a failed answer is not a fresh reading, the 90 s loop stops on close and skips a hidden window,
// and a stale fetch never overwrites a newer one.
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import {
  $walletBalances,
  type ChainBalanceRow,
  closeWalletPanel,
  nextAgeTickMs,
  openWalletPanel,
  refreshWalletBalances,
  resetWalletBalances
} from './wallet-balances'

const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'

const A_ROWS: ChainBalanceRow[] = [{ key: 'ethereum', chain: 'Ethereum', symbol: 'ETH', balance: '3.25', ok: true }]
const B_ROWS: ChainBalanceRow[] = [{ key: 'base', chain: 'Base', symbol: 'ETH', balance: '0.5', ok: true }]

type Fetch = (address: string, solAddress?: string) => Promise<unknown>

let fetchBalances: Mock<Fetch>

function installBridge(impl: Fetch) {
  fetchBalances = vi.fn<Fetch>(impl)
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { icloneBalances: { fetch: fetchBalances } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => (resolve = r))

  return { promise, resolve }
}

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  resetWalletBalances()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
  resetWalletBalances()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('rows belong to one wallet', () => {
  it("opening for wallet B never shows A's rows while B's fetch is in flight", async () => {
    installBridge(async () => ({ ok: true, rows: A_ROWS, fetchedAt: 1_000 }))
    openWalletPanel(A)
    await vi.waitFor(() => expect($walletBalances.get().rows).toEqual(A_ROWS))
    closeWalletPanel()

    const pending = deferred<unknown>()

    installBridge(() => pending.promise)
    openWalletPanel(B)

    expect($walletBalances.get()).toMatchObject({ address: B, status: 'loading', rows: [], fetchedAt: null })
    pending.resolve({ ok: true, rows: B_ROWS, fetchedAt: 2_000 })
    await vi.waitFor(() => expect($walletBalances.get()).toMatchObject({ address: B, rows: B_ROWS }))
  })

  it("B's failed fetch leaves an error with no rows, never A's balances", async () => {
    installBridge(async () => ({ ok: true, rows: A_ROWS, fetchedAt: 1_000 }))
    openWalletPanel(A)
    await vi.waitFor(() => expect($walletBalances.get().rows).toEqual(A_ROWS))
    closeWalletPanel()

    installBridge(async () => ({ ok: false, rows: [], fetchedAt: Date.now() }))
    openWalletPanel(B)
    await vi.waitFor(() => expect($walletBalances.get().status).toBe('error'))
    expect($walletBalances.get()).toMatchObject({ address: B, rows: [], fetchedAt: null })
  })

  it("A's fetch landing after the switch to B is dropped", async () => {
    const slowA = deferred<unknown>()

    installBridge(() => slowA.promise)
    openWalletPanel(A)
    installBridge(async () => ({ ok: true, rows: B_ROWS, fetchedAt: 2_000 }))
    openWalletPanel(B)
    await vi.waitFor(() => expect($walletBalances.get().rows).toEqual(B_ROWS))
    slowA.resolve({ ok: true, rows: A_ROWS, fetchedAt: 1_000 })
    await Promise.resolve()
    await Promise.resolve()
    expect($walletBalances.get()).toMatchObject({ address: B, rows: B_ROWS })
  })

  it('reset (sign-out) clears the rows and drops a fetch still in flight', async () => {
    const slow = deferred<unknown>()

    installBridge(() => slow.promise)
    openWalletPanel(A)
    resetWalletBalances()
    slow.resolve({ ok: true, rows: A_ROWS, fetchedAt: 1_000 })
    await Promise.resolve()
    await Promise.resolve()
    expect($walletBalances.get()).toEqual({ address: null, status: 'idle', rows: [], fetchedAt: null })
    await refreshWalletBalances()
    expect(fetchBalances).toHaveBeenCalledTimes(1)
  })
})

describe('a failed answer is not a fresh reading (renderer 2)', () => {
  it('ok:false keeps the last reading time, not now', async () => {
    installBridge(async () => ({ ok: true, rows: A_ROWS, fetchedAt: 1_000 }))
    openWalletPanel(A)
    await vi.waitFor(() => expect($walletBalances.get().fetchedAt).toBe(1_000))

    installBridge(async () => ({ ok: false, rows: [], fetchedAt: 99_000 }))
    await refreshWalletBalances()
    expect($walletBalances.get()).toMatchObject({ status: 'error', rows: A_ROWS, fetchedAt: 1_000 })
  })

  it('a first fetch that fails (or a refused sender answering null) has no age at all', async () => {
    installBridge(async () => null)
    openWalletPanel(A)
    await vi.waitFor(() => expect($walletBalances.get().status).toBe('error'))
    expect($walletBalances.get().fetchedAt).toBeNull()
  })
})

describe('the 90 s loop (tests-perf 9)', () => {
  it('refreshes every 90 s while open and stops on close', async () => {
    vi.useFakeTimers()
    installBridge(async () => ({ ok: true, rows: A_ROWS, fetchedAt: Date.now() }))
    openWalletPanel(A)
    expect(fetchBalances).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(fetchBalances).toHaveBeenCalledTimes(2)
    closeWalletPanel()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fetchBalances).toHaveBeenCalledTimes(2)
  })

  it('a hidden window reads nothing, and catches up once when shown again', async () => {
    vi.useFakeTimers()
    installBridge(async () => ({ ok: true, rows: A_ROWS, fetchedAt: Date.now() }))
    openWalletPanel(A)
    await vi.advanceTimersByTimeAsync(0)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5 * 90_000)
    expect(fetchBalances).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchBalances).toHaveBeenCalledTimes(2)
  })

  it('showing the window again with a fresh reading fetches nothing extra', async () => {
    vi.useFakeTimers()
    installBridge(async () => ({ ok: true, rows: A_ROWS, fetchedAt: Date.now() }))
    openWalletPanel(A)
    await vi.advanceTimersByTimeAsync(10_000)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchBalances).toHaveBeenCalledTimes(1)
  })

  it('a manual Refresh racing the tick: the older answer landing last never overwrites the newer', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const answers = [first, second]

    installBridge(() => answers.shift()!.promise)
    openWalletPanel(A)

    const refresh = refreshWalletBalances()

    second.resolve({ ok: true, rows: B_ROWS, fetchedAt: 2_000 })
    await refresh
    first.resolve({ ok: true, rows: A_ROWS, fetchedAt: 1_000 })
    await Promise.resolve()
    await Promise.resolve()
    expect($walletBalances.get()).toMatchObject({ rows: B_ROWS, fetchedAt: 2_000 })
  })
})

describe('"Updated …" re-renders only when its words can change', () => {
  it('every second under a minute, then once per minute', () => {
    expect(nextAgeTickMs(0)).toBe(500)
    expect(nextAgeTickMs(12_400)).toBe(100)
    expect(nextAgeTickMs(12_500)).toBe(1_000)
    expect(nextAgeTickMs(59_500)).toBe(60_000)
    expect(nextAgeTickMs(61_000)).toBe(58_500)
    expect(nextAgeTickMs(119_499)).toBe(1)
  })
})
