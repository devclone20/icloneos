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
  status: WalletBalancesStatus
  rows: ChainBalanceRow[]
  fetchedAt: number | null
  error?: string
}

interface IcloneBalancesBridge {
  fetch: (address: string, solAddress?: string) => Promise<IcloneBalancesResult>
}

const IDLE: WalletBalancesState = { status: 'idle', rows: [], fetchedAt: null }
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

/** One-shot fetch. Safe to call directly (e.g. a manual "refresh" affordance)
 *  independent of the panel-open auto-refresh loop below. */
async function refreshBalances(address: string, solAddress?: string): Promise<void> {
  const bridge = icloneBalancesBridge()

  if (!bridge) {
    $walletBalances.set({
      status: 'error',
      rows: [],
      fetchedAt: null,
      error: 'Balances are unavailable in this build.'
    })

    return
  }

  const current = $walletBalances.get()

  $walletBalances.set({ ...current, status: 'loading' })

  try {
    const result = await bridge.fetch(address, solAddress)

    $walletBalances.set({
      status: result.ok ? 'ready' : 'error',
      rows: result.rows,
      fetchedAt: result.fetchedAt,
      error: result.ok ? undefined : 'Balance fetch failed.'
    })
  } catch (e) {
    $walletBalances.set({
      status: 'error',
      rows: [],
      fetchedAt: null,
      error: e instanceof Error ? e.message : 'Balance fetch failed.'
    })
  }
}

/** Raise the panel-open flag: fetches immediately, then keeps refreshing
 *  every 90s for as long as the panel stays open. Re-entrant — calling it
 *  again with the same (or a new) address while already open just updates
 *  the address the interval refreshes, it doesn't stack timers. */
export function openWalletPanel(address: string, solAddress?: string): void {
  panelOpen = true
  activeAddress = address
  activeSolAddress = solAddress

  void refreshBalances(address, solAddress)

  if (refreshTimer) {
    return
  }

  refreshTimer = setInterval(() => {
    if (panelOpen && activeAddress) {
      void refreshBalances(activeAddress, activeSolAddress)
    }
  }, REFRESH_INTERVAL_MS)
}

/** Lower the panel-open flag and stop the 90s refresh loop. Leaves the last
 *  fetched rows in the store — reopening shows the last-known balances while
 *  the fresh fetch is in flight, instead of flashing back to a skeleton. */
export function closeWalletPanel(): void {
  panelOpen = false

  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}
