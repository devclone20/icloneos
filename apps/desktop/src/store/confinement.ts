import { atom, computed } from 'nanostores'

import {
  CONFINEMENT_STATE_SCHEMA,
  type ConfinementStateView,
  type HardlinkAckResultView,
  type HardlinkFirstScanView,
  type HardlinkGroupPathsResult,
  type IsolationSetResultView,
  type KillResultView,
  type StopRunResultView
} from '@/iclone-shared/confinement'

/**
 * V3-G — the window's copy of main's confinement state for the Dock pane. Main folds it from live `ps` on every
 * read; this store only holds the last answer and asks again (every second while the pane is open, and whenever main
 * announces a refusal). It never counts anything itself.
 */
export interface IcloneConfinementBridge {
  state: () => Promise<ConfinementStateView | null>
  kill: (pid: number) => Promise<KillResultView | null>
  stopRun: (run: string) => Promise<StopRunResultView | null>
  explain: (pid: number) => Promise<string[] | null>
  ackHardlink: (input: { root: string; dir: string; digest: string }) => Promise<HardlinkAckResultView | null>
  /** fx13 (D13): "Allow this folder" — a project entry for the folder of a narrowed run, by click only. */
  allowFolder?(
    folder: string
  ): Promise<{ ok: boolean; next?: 'asks' | 'plan' | 'writes'; error?: string; message?: string }>
  /** F41: call synchronously inside the click of a control carrying data-confinement-confirm. */
  setIsolation?(enabled: boolean): Promise<IsolationSetResultView | null>
  /** CF5 (B3-n2): one page of a refused group's file names past the ones its view carries. */
  hardlinkPaths?(input: {
    root: string
    dir: string
    digest: string
    offset: number
  }): Promise<HardlinkGroupPathsResult | null>
  /** `notice`: what main's `changed` carries (CF5, B3-n5: a first scan's count), or nothing. */
  onChanged: (callback: (notice?: unknown) => void) => () => void
}

interface ConfinementStore {
  status: 'error' | 'loading' | 'ready' | 'unavailable'
  state: ConfinementStateView | null
  error: string | null
}

export const $confinement = atom<ConfinementStore>({ status: 'loading', state: null, error: null })

/** F41: the small state the composer reads: true only when main said isolation is off. */
export const $isolationOff = computed($confinement, store => store.state?.isolation.on === false)

const POLL_MS = 1_000

function bridge(): IcloneConfinementBridge | undefined {
  return window.hermesDesktop?.icloneConfinement
}

const isState = (value: unknown): value is ConfinementStateView =>
  typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === CONFINEMENT_STATE_SCHEMA

let lastLoggedError: string | null = null

/** The pane says a read failed in plain words; the detail goes here, once per distinct failure (reads are per second). */
function logReadError(detail: string): void {
  if (detail !== lastLoggedError) {
    lastLoggedError = detail
    console.warn('[confinement] could not read the state:', detail)
  }
}

// L4-02: one read in flight at a time. A poll that lands during one is skipped (it would read the same state); a
// change notice or an action that lands during one asks for exactly one more read after it, so the newest change is
// always read and a burst of notices never queues a read per notice. A read still unanswered after READ_OVERDUE_MS no
// longer holds the others back (main may never answer it); whatever it answers later is ignored.
const READ_OVERDUE_MS = 3_000

interface ReadInFlight {
  done: Promise<void>
  startedAt: number
  overdue: boolean
}

let current: ReadInFlight | null = null
let readAgain = false
let generation = 0

function startRead(): Promise<void> {
  generation += 1

  const mine = generation
  const entry: ReadInFlight = { done: Promise.resolve(), startedAt: Date.now(), overdue: false }

  const timer = window.setTimeout(() => {
    entry.overdue = true

    if (current === entry && readAgain) {
      readAgain = false
      void startRead()
    }
  }, READ_OVERDUE_MS)

  current = entry
  entry.done = readState(() => mine === generation).finally(() => {
    window.clearTimeout(timer)

    if (current === entry) {
      current = null

      if (readAgain) {
        readAgain = false
        void startRead()
      }
    }
  })

  return entry.done
}

/** Reads main's state, or joins the read in flight; `fresh` asks for one more read after it when one is. */
function loadConfinement(fresh = true): Promise<void> {
  if (current && !current.overdue && Date.now() - current.startedAt < READ_OVERDUE_MS) {
    readAgain ||= fresh

    return current.done
  }

  return startRead()
}

/** The poll's own read: skipped while another is in flight. */
const pollConfinement = () => void loadConfinement(false)

/** One read; its answer is kept only while `isNewest` (no later read has started). */
async function readState(isNewest: () => boolean): Promise<void> {
  const door = bridge()

  if (!door) {
    $confinement.set({ status: 'unavailable', state: null, error: null })

    return
  }

  try {
    const state = await door.state()

    if (!isNewest()) {
      return
    }

    if (isState(state)) {
      lastLoggedError = null
      $confinement.set({ status: 'ready', state, error: null })

      return
    }

    logReadError('unexpected state')
    $confinement.set({ status: 'error', state: $confinement.get().state, error: 'unexpected state' })
  } catch (error) {
    if (!isNewest()) {
      return
    }

    const detail = error instanceof Error ? error.message : String(error)

    logReadError(detail)
    $confinement.set({ status: 'error', state: $confinement.get().state, error: detail })
  }
}

const isFirstScan = (value: unknown): value is HardlinkFirstScanView => {
  const scan = value as Partial<HardlinkFirstScanView> | null

  return (
    typeof scan === 'object' &&
    scan !== null &&
    typeof scan.root === 'string' &&
    Number.isSafeInteger(scan.dirs) &&
    (scan.dirs as number) >= 0 &&
    Number.isFinite(scan.startedAt)
  )
}

/**
 * CF5 (B3-n5): main's `changed` notice. One that carries a running first scan's count updates the line from it, with
 * no read of the whole state (main sends one at most twice a second per scan, to every window); anything else, or a
 * window that has no state yet, reads the state once.
 */
export function onConfinementChanged(notice?: unknown): void {
  const firstScan = (notice as { firstScan?: unknown } | null | undefined)?.firstScan
  const store = $confinement.get()

  if (isFirstScan(firstScan) && store.state) {
    $confinement.set({ ...store, state: { ...store.state, firstScan } })

    return
  }

  void loadConfinement()
}

/** CF5 (B3-n2): the next page of a refused group's file names, or null when main cannot answer (`changed`: the
 *  state is read again, the group is not the one shown). */
export async function readHardlinkGroupPaths(input: {
  root: string
  dir: string
  digest: string
  offset: number
}): Promise<string[] | null> {
  const result = await bridge()
    ?.hardlinkPaths?.(input)
    .catch(() => null)

  if (result?.ok && Array.isArray(result.paths) && result.paths.every(item => typeof item === 'string')) {
    return result.paths
  }

  if (result && !result.ok && result.reason === 'changed') {
    void loadConfinement()
  }

  return null
}

/** V3-FX M2: one read of main's live state, for a surface that only states it (the Permissions pane's note). */
export function readConfinementOnce(): Promise<void> {
  return loadConfinement()
}

/** V3-FX M2: the Permissions pane's light poll; skipped while a read is in flight. */
export function pollConfinementOnce(): void {
  pollConfinement()
}

/** While the pane is open: read now, every second, and on every refusal main announces. */
export function watchConfinement(): () => void {
  const off = bridge()?.onChanged(onConfinementChanged)
  const timer = window.setInterval(pollConfinement, POLL_MS)

  // A pane that opens reads afresh: it never waits on a read an earlier surface left unanswered.
  void startRead()

  return () => {
    off?.()
    window.clearInterval(timer)
  }
}

export async function killConfined(pid: number): Promise<KillResultView> {
  const result: KillResultView = (await bridge()?.kill(pid)) ?? {
    ok: false,
    pid,
    reason: 'not-confined',
    survivors: [],
    error: 'unavailable'
  }

  void loadConfinement()

  return result
}

/** The `error` of a Stop the bridge never answered (no main to ask): the pane says Stop is not available here. */
export const STOP_UNAVAILABLE = 'unavailable'

/** The `error` of a Stop whose call itself failed: nobody can say what stopped, so the pane says it may still run. */
export const STOP_NO_ANSWER = 'no answer'

/** The owner's Stop on one run of the ledger; main stops every live process the kernel holds in it. Always answers:
 *  a Stop must end in a result the pane can show, whatever happened to the call. */
export async function stopRun(run: string): Promise<StopRunResultView> {
  let result: StopRunResultView

  try {
    result = (await bridge()?.stopRun(run)) ?? {
      ok: false,
      run,
      reason: 'not-running',
      survivors: [],
      error: STOP_UNAVAILABLE
    }
  } catch (error) {
    console.warn('[confinement] the Stop call failed:', error)
    result = { ok: false, run, reason: 'survivors', survivors: [], error: STOP_NO_ANSWER }
  }

  void loadConfinement()

  return result
}

export async function explainConfined(pid: number): Promise<string[]> {
  return (await bridge()?.explain(pid)) ?? []
}

/**
 * Call SYNCHRONOUSLY from the click handler of a control inside `data-confinement-confirm`: the preload attaches the
 * proof of that click, and main refuses the acknowledgement without it. One gesture allows the files under `dir`
 * exactly as the pane showed them (`digest`).
 */
export async function acknowledgeHardlink(root: string, dir: string, digest: string): Promise<HardlinkAckResultView> {
  const result = (await bridge()?.ackHardlink({ root, dir, digest })) ?? { ok: false, reason: 'invalid' }

  void loadConfinement()

  return result
}
