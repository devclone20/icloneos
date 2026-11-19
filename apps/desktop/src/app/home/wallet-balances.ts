/**
 * iCLONE OS — multi-chain native-coin balances (renderer store).
 *
 * Mirrors `privy-session.ts`'s idiom one door down: a plain nanostores atom
 * plus thin action functions `wallet-panel.tsx` calls. The bridge this store
 * needs — `window.hermesDesktop.icloneBalances` — doesn't exist in
 * `src/global.d.ts`/`electron/preload.ts` yet (both are out of this module's
 * file ownership); `icloneBalancesBridge()` below reads it through a local,
 * narrow type instead of the shared ambient one, exactly like
 * `iclonePrivyBridge()` does — so this file type-checks today and needs no
 * change once that patch lands. Every call site optional-chains through it
 * and degrades to an "unavailable" status rather than throwing.
 *
 * Auto-refresh: `openWalletPanel`/`closeWalletPanel` are the "panel-open
 * flag" the owner spec asks for — call `openWalletPanel(address)` on the
 * panel's mount (it does an immediate fetch AND starts a 90s interval) and
 * `closeWalletPanel()` on unmount (it stops the interval). Nothing refetches
 * while the panel is closed.
 */
import { atom } from 'nanostores'

type IcloneChainKey = 'robinhood' | 'solana' | 'bnb' | 'ethereum' | 'base' | 'polygon' | 'arbitrum'

export interface ChainBalanceRow {
  key: IcloneChainKey
  chain: string
  symbol: string
  /** Decimal string, e.g. "0.011726" — format for display, don't re-parse as a float for math. */
  balance: string
  ok: boolean
  error?: string
}

interface IcloneBalancesResult {
  ok: boolean
  rows: ChainBalanceRow[]
  fetchedAt: number
}

type WalletBalancesStatus = 'idle' | 'loading' | 'ready' | 'error'

interface WalletBalancesState {
  /** The wallet these rows belong to (null = none yet). Rows are never shown, kept or merged under another address. */
  address: null | string
  status: WalletBalancesStatus
  rows: ChainBalanceRow[]
  fetchedAt: number | null
  error?: string
}

interface IcloneBalancesBridge {
  fetch: (address: string, solAddress?: string) => Promise<IcloneBalancesResult>
}

const IDLE: WalletBalancesState = { address: null, status: 'idle', rows: [], fetchedAt: null }
const REFRESH_INTERVAL_MS = 90_000

export const $walletBalances = atom<WalletBalancesState>(IDLE)

let panelOpen = false
let refreshTimer: ReturnType<typeof setInterval> | null = null
let activeAddress: string | null = null
let activeSolAddress: string | undefined

function icloneBalancesBridge(): IcloneBalancesBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return (window.hermesDesktop as unknown as { icloneBalances?: IcloneBalancesBridge } | undefined)?.icloneBalances
}

// A fetch that lands after a newer one started (a manual Refresh racing the 90 s tick) must not overwrite it.
let fetchTicket = 0

/** One-shot fetch. Safe to call directly (e.g. a manual "refresh" affordance)
 *  independent of the panel-open auto-refresh loop below. A failed refresh
 *  keeps the last rows it had (and their `fetchedAt`, so "Updated … ago" stays
 *  true) and only adds the error; with no rows yet it is the total-error state.
 *  Rows of another wallet are never kept: the state is reset before a fetch for
 *  a different address, and a fetch that lands after a switch or a sign-out is
 *  dropped by its ticket. */
async function refreshBalances(address: string, solAddress?: string): Promise<void> {
  const bridge = icloneBalancesBridge()

  if (!bridge) {
    $walletBalances.set({
      address,
      status: 'error',
      rows: [],
      fetchedAt: null,
      error: 'Balances are unavailable in this build.'
    })

    return
  }

  const ticket = ++fetchTicket
  const current = $walletBalances.get()

  $walletBalances.set(
    current.address === address
      ? { ...current, status: 'loading', error: undefined }
      : { ...IDLE, address, status: 'loading' }
  )

  try {
    const result = await bridge.fetch(address, solAddress)

    if (ticket !== fetchTicket) {
      return
    }

    // K21 shape guard: a refused sender gets null, never a TypeError on `.rows`.
    const rows = Array.isArray(result?.rows) ? result.rows : []
    const kept = $walletBalances.get()

    // A failed answer (`ok:false`, or null from a refused sender) is not a fresh reading: the footer keeps the
    // age of the rows it still shows (none -> no age), never "Updated just now" over the error.
    $walletBalances.set(
      result?.ok
        ? {
            address,
            status: 'ready',
            rows: rows.length > 0 ? rows : kept.rows,
            fetchedAt: typeof result.fetchedAt === 'number' ? result.fetchedAt : Date.now()
          }
        : {
            address,
            status: 'error',
            rows: kept.rows,
            fetchedAt: kept.fetchedAt,
            // v0.0.9 r4 (design r3 N6): no cause came back; the panel says it in the owner's words (failedCause).
            error: undefined
          }
    )
  } catch (e) {
    if (ticket !== fetchTicket) {
      return
    }

    const kept = $walletBalances.get()

    $walletBalances.set({
      address,
      status: 'error',
      rows: kept.rows,
      fetchedAt: kept.fetchedAt,
      error: e instanceof Error && e.message ? e.message : undefined
    })
  }
}

/** The popover's manual Refresh (and its error Retry): one fetch of the open wallet now. The 90 s loop keeps
 *  running on its own clock. A no-op while the panel is closed — nothing refetches for a closed panel. */
export function refreshWalletBalances(): Promise<void> {
  if (!panelOpen || !activeAddress) {
    return Promise.resolve()
  }

  return refreshBalances(activeAddress, activeSolAddress)
}

/** A row's balance as a number for ordering only (display keeps the decimal string). */
function amountOf(row: ChainBalanceRow): number {
  const value = Number(row.balance)

  return Number.isFinite(value) ? value : 0
}

export interface PartitionedBalanceRows {
  /** Networks that hold something, in the bridge's chain order (amounts in different coins do not rank). */
  funded: ChainBalanceRow[]
  /** Networks that did not answer — never folded away, each says why. */
  unavailable: ChainBalanceRow[]
  /** Networks that answered 0 — collapsed under "N networks with no balance". */
  zero: ChainBalanceRow[]
}

/** The popover's flat list order: networks with a balance first, the unavailable ones next (each with its
 *  cause), and the zero-balance ones folded. Pure, so the order is tested without a DOM. */
export function partitionBalanceRows(rows: readonly ChainBalanceRow[]): PartitionedBalanceRows {
  const funded: ChainBalanceRow[] = []
  const unavailable: ChainBalanceRow[] = []
  const zero: ChainBalanceRow[] = []

  for (const row of rows) {
    if (!row.ok) {
      unavailable.push(row)
    } else if (amountOf(row) > 0) {
      funded.push(row)
    } else {
      zero.push(row)
    }
  }

  return { funded, unavailable, zero }
}

/** Milliseconds until the "Updated …" words can next change: every second under a minute (the words count
 *  seconds), then at the next whole minute (they count minutes). Pure, for the test. */
export function nextAgeTickMs(ageMs: number): number {
  // The age is rounded to whole seconds, so each word changes half a second before the boundary.
  const shifted = ageMs + 500

  if (shifted < 60_000) {
    return 1_000 - (shifted % 1_000)
  }

  return 60_000 - (shifted % 60_000)
}

/** Display form of a balance: four decimals, tabular; a dust amount says so instead of rounding to zero. */
export function formatBalance(balance: string): string {
  const value = Number(balance)

  if (!Number.isFinite(value) || value <= 0) {
    return '0.0000'
  }

  return value < 0.0001 ? '<0.0001' : value.toFixed(4)
}

/** Raise the panel-open flag: fetches immediately, then keeps refreshing
 *  every 90s for as long as the panel stays open. Re-entrant — calling it
 *  again with the same (or a new) address while already open just updates
 *  the address the interval refreshes, it doesn't stack timers. */
export function openWalletPanel(address: string, solAddress?: string): void {
  // Another wallet's balances never show under this address, not even for the seconds this fetch takes.
  if ($walletBalances.get().address !== address) {
    fetchTicket += 1
    $walletBalances.set({ ...IDLE, address })
  }

  panelOpen = true
  activeAddress = address
  activeSolAddress = solAddress

  void refreshBalances(address, solAddress)
  watchVisibility(true)

  if (refreshTimer) {
    return
  }

  refreshTimer = setInterval(() => {
    // A hidden window (minimized, another Space, screen locked) reads nothing; it catches up when shown.
    if (panelOpen && activeAddress && !documentHidden()) {
      void refreshBalances(activeAddress, activeSolAddress)
    }
  }, REFRESH_INTERVAL_MS)
}

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** Back from hidden with the popover still open: one fetch if the last reading is older than the loop's period. */
function onVisibilityChange(): void {
  if (documentHidden() || !panelOpen || !activeAddress) {
    return
  }

  const { fetchedAt, status } = $walletBalances.get()

  if (status !== 'loading' && (fetchedAt === null || Date.now() - fetchedAt >= REFRESH_INTERVAL_MS)) {
    void refreshBalances(activeAddress, activeSolAddress)
  }
}

let watchingVisibility = false

function watchVisibility(on: boolean): void {
  if (typeof document === 'undefined' || on === watchingVisibility) {
    return
  }

  watchingVisibility = on

  if (on) {
    document.addEventListener('visibilitychange', onVisibilityChange)
  } else {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

/** Lower the panel-open flag and stop the 90s refresh loop. Leaves the last
 *  fetched rows in the store — reopening shows the last-known balances while
 *  the fresh fetch is in flight, instead of flashing back to a skeleton. */
export function closeWalletPanel(): void {
  panelOpen = false
  watchVisibility(false)

  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

/** Sign-out (or a wallet switch): forget the rows, their owner and any fetch in flight, so nothing of this
 *  wallet is shown to — or written over — the next one. */
export function resetWalletBalances(): void {
  closeWalletPanel()
  fetchTicket += 1
  activeAddress = null
  activeSolAddress = undefined
  $walletBalances.set(IDLE)
}
