/**
 * V3-I — main's WORK service and the window's door to it. Created once at startup, it lives as long as main: the
 * supervisor, the watchdog's polling and the drain run whether or not any window is open. Every channel passes the
 * app sender guard; the ones that widen what the agent does (a level, going online, approve, decline) and the ledger
 * Repair also need main's own gesture verdict for THAT sender (V3-F's lock). Going offline and reboot never need one:
 * making the agent do less must never be blockable.
 *
 * Main is the only authority over listeners for an iNFT WORK holds: once the owner has put an iNFT online or offline
 * here, the market window's own listener is not admitted for it (it mirrors the supervisor's events instead), so
 * "offline" in this tab means no listener of ours, whatever window is open.
 *
 * Custody. An iNFT is online only for the account that owns it:
 *  - going online, and every resume after a restart, waits for a fresh proof from the ownership guard;
 *  - sign-out and a wallet switch stop every listener at once and record why;
 *  - a proof that the iNFT left the wallet stops it within that check, and the tab says so.
 *
 * The watchdog spawns `acp` with its own fixed argv (supervisor: `events listen --json`; reads: `job list`,
 * `job history`, `agent whoami`, all already on the window's allowlist), so `iclone-acp-argv.ts` is not widened.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  isAutonomyLevel,
  type SupervisorState,
  WORK_JOB_ID,
  WORK_SLUG,
  type WorkActionResult,
  type WorkHold,
  type WorkStopReport,
  type WorkView
} from '../../src/iclone-shared/acp-work'
import type { AcpRunResult } from '../iclone-acp'
import type { AcpWatchEvent, WatchStart } from '../iclone-acp-watch'
import { guardedHandler } from '../iclone-consent'
import type { ConsentSenderGuard } from '../iclone-consent'

import type { WorkAuditSink } from './audit-sink'
import { createDrain } from './drain'
import { createLedger, holdOf, type Ledger, wantsOnline, workHolds } from './ledger'
import { DEFAULT_POLICY } from './policy'
import { createSupervisor } from './supervisor'
import { createWatchdog, type WorkActor } from './watchdog'

const WORK_DIR = 'acp-work'
const LEDGER_FILE = 'ledger.jsonl'
/** The watchdog's read cadence while an iNFT is online (the stream asks for an earlier read on every job event). */
const WORK_POLL_MS = 30_000
/** A burst of job events is one read. */
export const EVENT_READ_MS = 400
/** While online, the ownership guard proves the iNFT is still in the wallet at this cadence (its own held cadence). */
export const OWNERSHIP_RECHECK_MS = 60 * 60_000

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

interface AcpWorkCli {
  listen(slug: string, argv: readonly string[]): Promise<WatchStart>
  /** REL-6: why the ACP tools cannot run (absent, unverified), or null. Going online is refused while it says why. */
  toolsProblem?(): string | null
  read(slug: string, argv: string[]): Promise<AcpRunResult>
  /** The market window's listener lets go of the slug (live, starting or in backoff). */
  yieldWindowWatch(slug: string): void
  /** The market window's listener stops, whatever slug it holds. */
  stopWindowWatch(why: string): void
  /** Installs main's verdict on whether the market window may listen for a slug. */
  setWindowAdmission(admits: (slug: string) => boolean): void
  keychainPromptShowing(): boolean
}

type OwnershipState = 'held' | 'lost' | 'unknown'

/** The owner's account as main knows it: the Privy sign-in record and the ownership guard (iclone-ownership). */
export interface WorkAccount {
  /** The sign-in record: 'in' only after a sign-in this app saw; null = never recorded. */
  signedIn(): 'in' | 'out' | null
  /** A fresh proof through the ownership guard's own check (indexer, ownerOf and Transfer logs). */
  prove(slug: string): Promise<OwnershipState>
  /** The wallet the guard tracks the iNFT for (lowercase), or null when it tracks none. */
  walletOf(slug: string): string | null
}

interface AcpWorkDeps {
  ipcMain: IpcMainLike
  isTrustedSender?: ConsentSenderGuard
  userDataDir: string
  cli: AcpWorkCli
  streaming: Set<string>
  account: WorkAccount
  /** Main's gesture verdict for the IPC sender and payload (V3-F `permissionGestureOk`). */
  gestureOk(event: unknown, input: unknown): boolean
  spendTradeOn(): boolean
  /** Where the watchdog's decisions are audited (audit-sink.ts). */
  audit: WorkAuditSink
  /** To every app window: the WORK view of a slug changed; the job stream (same shape as the market window's). */
  send(channel: 'iclone:acp-event' | 'iclone:acp-work:changed', payload: unknown): void
  /** null in this build: approved quotes are recorded and held. */
  actor?: WorkActor | null
  log(line: string): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

const field = (input: unknown, key: string): unknown =>
  input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined

const slugOf = (input: unknown): string | null => {
  const slug = field(input, 'slug')

  return typeof slug === 'string' && WORK_SLUG.test(slug) ? slug : null
}

const jobIdOf = (input: unknown): string | null => {
  const jobId = field(input, 'jobId')

  return typeof jobId === 'string' && WORK_JOB_ID.test(jobId) ? jobId : null
}

const INVALID: WorkActionResult = { ok: false, error: 'invalid' }
const ADDRESS = /^0x[0-9a-f]{40}$/

const isUp = (state: SupervisorState) => state !== 'offline' && state !== 'offline-safe'

export function createAcpWork(deps: AcpWorkDeps) {
  const root = path.join(deps.userDataDir, WORK_DIR)
  const ledgers = new Map<string, Ledger>()
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>))
  const pollers = new Map<string, unknown>()
  const ownershipTimers = new Map<string, unknown>()
  const soon = new Map<string, ReturnType<typeof setTimeout>>()
  /** Holds that live in memory: a resume waiting on its proof, and the reason of the last stop this launch. */
  const holds = new Map<string, WorkHold>()
  /** Bumped by every stop of a slug, so an online whose proof was in flight cannot land after it. */
  const epochs = new Map<string, number>()
  let wallet: string | null = null

  const ledger = (slug: string): Ledger => {
    let found = ledgers.get(slug)

    if (!found) {
      found = createLedger({ file: path.join(root, slug, LEDGER_FILE) })
      ledgers.set(slug, found)
    }

    return found
  }

  const epoch = (slug: string) => epochs.get(slug) ?? 0
  const bump = (slug: string) => epochs.set(slug, epoch(slug) + 1)
  const changed = (slug: string) => deps.send('iclone:acp-work:changed', slug)

  const watchdog = createWatchdog({
    read: deps.cli.read,
    actor: deps.actor ?? null,
    ledger,
    policy: () => ({ ...DEFAULT_POLICY }),
    spendTradeOn: deps.spendTradeOn,
    audit: deps.audit.record,
    onChange: changed,
    onReadError: slug => supervisor.note(slug, 'read-failed')
  })

  const every = (timers: Map<string, unknown>, slug: string, ms: number, fn: () => void) => {
    if (!timers.has(slug)) {
      timers.set(slug, setTimer(fn, ms))
    }
  }

  const cancel = (timers: Map<string, unknown>, slug: string) => {
    const timer = timers.get(slug)

    if (timer !== undefined) {
      clearTimer(timer)
      timers.delete(slug)
    }
  }

  const supervisor = createSupervisor({
    start: deps.cli.listen,
    toolsProblem: () => deps.cli.toolsProblem?.() ?? null,
    streaming: deps.streaming,
    keychainPromptShowing: deps.cli.keychainPromptShowing,
    yieldWindowWatch: deps.cli.yieldWindowWatch,
    emit: (event: AcpWatchEvent) => {
      deps.send('iclone:acp-event', event)

      // A job moved: read now (coalesced) instead of at the next tick, so the tab is live within seconds.
      if (event.source === 'jobs' && !soon.has(event.slug)) {
        soon.set(
          event.slug,
          setTimeout(() => {
            soon.delete(event.slug)
            void watchdog.poll(event.slug)
          }, EVENT_READ_MS)
        )
      }
    },
    onState: (slug: string, state: SupervisorState) => {
      deps.log(`[iclone-acp-work] ${slug} ${state}`)

      if (state === 'online') {
        every(pollers, slug, WORK_POLL_MS, () => void watchdog.poll(slug))
        void watchdog.poll(slug)
      } else if (state === 'offline' || state === 'offline-safe' || state === 'failed') {
        cancel(pollers, slug)
      }

      if (!isUp(state)) {
        cancel(ownershipTimers, slug)
      }

      changed(slug)
    },
    onFix: (slug, fix) => {
      ledger(slug).append({ kind: 'fix', note: `${fix.cause} -> ${fix.tried} (${fix.now})` })
      changed(slug)
    },
    log: deps.log
  })

  const drain = createDrain({ supervisor, watchdog, ledger, onChange: changed })

  /** Every slug WORK knows: a ledger on disk or a listener run this launch. */
  const knownSlugs = (): string[] => {
    let names: string[] = []

    try {
      names = fs
        .readdirSync(root)
        .filter(name => WORK_SLUG.test(name) && fs.existsSync(path.join(root, name, LEDGER_FILE)))
    } catch {
      names = []
    }

    return [...new Set([...names, ...ledgers.keys()])]
  }

  /**
   * WORK takes the slug offline for a reason the owner did not choose here. Everything stops at once (no drain: the
   * account that could finish the jobs is gone), the window's listener included, and the reason is recorded with
   * the offline so it outlives a restart.
   */
  const revoke = (slug: string, hold: WorkHold) => {
    const wasUp = isUp(supervisor.state(slug))
    const pending = holds.get(slug) === 'ownership-unverified'
    const records = ledger(slug).read().records

    bump(slug)
    drain.cancel(slug)
    cancel(pollers, slug)
    cancel(ownershipTimers, slug)

    if (wasUp) {
      supervisor.stopListener(slug, 'offline')
    }

    deps.cli.yieldWindowWatch(slug)

    if ((wasUp || pending || wantsOnline(records)) && holdOf(records) !== hold) {
      ledger(slug).append({ kind: 'offline', note: hold })
    }

    holds.set(slug, hold)
    deps.log(`[iclone-acp-work] ${slug} stopped: ${hold}`)
    changed(slug)
  }

  const revokeAll = (hold: WorkHold) => {
    deps.cli.stopWindowWatch(hold)

    for (const slug of knownSlugs()) {
      if (isUp(supervisor.state(slug)) || holds.has(slug) || wantsOnline(ledger(slug).read().records)) {
        revoke(slug, hold)
      }
    }
  }

  /**
   * The guard's verdict for this account. `held` for a wallet other than the one signed in now is not held here: it
   * reads as a wallet switch. Null = still ours to run (or not proven either way).
   */
  const lossOf = (slug: string, state: OwnershipState): WorkHold | null => {
    if (state === 'lost') {
      return 'ownership-lost'
    }

    const owner = deps.account.walletOf(slug)

    return state === 'held' && wallet !== null && owner !== null && owner !== wallet ? 'wallet-switch' : null
  }

  const start = (slug: string) => {
    holds.delete(slug)
    supervisor.online(slug)
    every(ownershipTimers, slug, OWNERSHIP_RECHECK_MS, () => void recheck(slug))
    changed(slug)
  }

  /** The periodic proof while online: a sale stops the listener within one check; `unknown` never does. */
  const recheck = async (slug: string) => {
    const before = epoch(slug)
    const loss = lossOf(slug, await deps.account.prove(slug))

    if (loss && epoch(slug) === before) {
      revoke(slug, loss)
    }
  }

  /** A resume waiting on its proof: online only on `held`, for the signed-in account, with nothing stopped since. */
  const settlePending = async (slug: string, decided?: OwnershipState): Promise<boolean> => {
    if (deps.account.signedIn() !== 'in') {
      return false
    }

    const before = epoch(slug)
    // A decisive verdict the guard just emitted settles directly: re-proving would start after that proof's commit and
    // read as 'unknown', so a resume waiting on a failed restart proof would never come back (V3-I r3 M-F).
    const state = decided ?? (await deps.account.prove(slug))
    const loss = lossOf(slug, state)

    if (holds.get(slug) !== 'ownership-unverified' || epoch(slug) !== before) {
      return false
    }

    if (loss) {
      revoke(slug, loss)

      return false
    }

    if (state !== 'held' || deps.account.signedIn() !== 'in' || !wantsOnline(ledger(slug).read().records)) {
      return false
    }

    start(slug)

    return true
  }

  const view = (slug: string): WorkView => ({
    slug,
    state: supervisor.state(slug),
    hold: holds.get(slug) ?? holdOf(ledger(slug).read().records),
    blocking: supervisor.blocking(slug),
    presence: 'unverified',
    fixes: supervisor.fixes(slug),
    ...watchdog.view(slug)
  })

  const work = {
    view,
    supervisor,
    watchdog,
    /** May the market window run its own listener for the slug? Not once WORK holds it, and never signed out. */
    windowMay(slug: string): boolean {
      return (
        deps.account.signedIn() !== 'out' &&
        !isUp(supervisor.state(slug)) &&
        !holds.has(slug) &&
        !workHolds(ledger(slug).read().records)
      )
    },
    async online(slug: string, gesture: boolean): Promise<WorkActionResult> {
      if (!gesture) {
        return { ok: false, error: 'gesture' }
      }

      if (deps.account.signedIn() !== 'in') {
        return { ok: false, error: 'sign-in' }
      }

      // REL-6: nothing can listen without the ACP tools; say so instead of starting a listener that cannot start.
      if (deps.cli.toolsProblem?.()) {
        return { ok: false, error: 'tools' }
      }

      const before = epoch(slug)
      const state = await deps.account.prove(slug)
      const loss = lossOf(slug, state)

      if (epoch(slug) !== before || deps.account.signedIn() !== 'in') {
        return { ok: false, error: 'state' }
      }

      if (loss) {
        revoke(slug, loss)

        return { ok: false, error: 'ownership' }
      }

      if (state !== 'held') {
        return { ok: false, error: 'ownership' }
      }

      drain.cancel(slug)

      if (!ledger(slug).append({ kind: 'online', gesture: true })) {
        return { ok: false, error: 'state' }
      }

      start(slug)

      return { ok: true }
    },
    async offline(slug: string): Promise<WorkStopReport> {
      bump(slug)
      cancel(ownershipTimers, slug)

      if (holds.get(slug) === 'ownership-unverified') {
        holds.delete(slug)
      }

      if (!isUp(supervisor.state(slug))) {
        // Nothing to drain here, but the owner's intent must outlive a restart. K28 n5: a slug WORK never held is
        // recorded too, so WORK takes custody and the window's own listener is not left running under "offline".
        const records = ledger(slug).read().records

        if (wantsOnline(records) || !workHolds(records)) {
          ledger(slug).append({ kind: 'offline' })
        }

        deps.cli.yieldWindowWatch(slug)
        changed(slug)

        return watchdog.stopReport(slug)
      }

      return (await drain.start(slug)).report
    },
    reboot(slug: string): WorkActionResult {
      if (!isUp(supervisor.state(slug))) {
        return { ok: false, error: 'state' }
      }

      supervisor.reboot(slug)

      return { ok: true }
    },
    /** The owner's Repair of a broken ledger (archive, keep the verified records, record the gap). */
    repair(slug: string, gesture: boolean): WorkActionResult {
      if (!gesture) {
        return { ok: false, error: 'gesture' }
      }

      const record = ledger(slug).repair()

      if (!record) {
        return { ok: false, error: 'state' }
      }

      deps.log(`[iclone-acp-work] ${slug} ledger repaired: ${record.note ?? ''}`)
      changed(slug)

      return { ok: true }
    },
    /**
     * Main start: every iNFT the owner left online waits for a fresh ownership proof (and a signed-in account) before
     * its listener starts. Resolves with the slugs that came back.
     */
    async resume(): Promise<string[]> {
      const waiting = knownSlugs().filter(slug => {
        const read = ledger(slug).read()

        return read.ok && wantsOnline(read.records)
      })

      for (const slug of waiting) {
        holds.set(slug, 'ownership-unverified')
        changed(slug)
      }

      const back = await Promise.all(waiting.map(slug => settlePending(slug)))

      return waiting.filter((_slug, index) => back[index])
    },
    /** The Privy session moved: a sign-out or another wallet stops every listener; a sign-in lets a resume proceed. */
    session(status: 'in' | 'out', address: string | null): void {
      if (status === 'out') {
        wallet = null
        revokeAll('signed-out')

        return
      }

      const next = address && ADDRESS.test(address.toLowerCase()) ? address.toLowerCase() : null

      if (next && wallet && next !== wallet) {
        wallet = next
        revokeAll('wallet-switch')

        return
      }

      wallet = next ?? wallet

      for (const slug of knownSlugs()) {
        const owner = deps.account.walletOf(slug)

        if (wallet && owner && owner !== wallet && (isUp(supervisor.state(slug)) || holds.has(slug))) {
          revoke(slug, 'wallet-switch')
        } else if (holds.get(slug) === 'ownership-unverified') {
          void settlePending(slug)
        }
      }
    },
    /** The ownership guard proved something about a slug (any check, the owner's or ours). */
    ownership(slug: string, state: OwnershipState): void {
      if (!WORK_SLUG.test(slug)) {
        return
      }

      const loss = lossOf(slug, state)
      const involved = isUp(supervisor.state(slug)) || holds.get(slug) === 'ownership-unverified'

      if (loss && involved) {
        revoke(slug, loss)
      } else if (!loss && state === 'held' && holds.get(slug) === 'ownership-unverified') {
        void settlePending(slug, state)
      }
    },
    stopAll(): void {
      for (const timers of [pollers, ownershipTimers]) {
        for (const slug of [...timers.keys()]) {
          cancel(timers, slug)
        }
      }

      supervisor.stopAll()
    }
  }

  deps.cli.setWindowAdmission(slug => work.windowMay(slug))

  return work
}

type AcpWork = ReturnType<typeof createAcpWork>

/** The IPC door. Returns the service so main can resume and stop it. */
export function registerAcpWork(deps: AcpWorkDeps): AcpWork {
  const work = createAcpWork(deps)
  const ipcMain = guardedHandler(deps.ipcMain, deps.isTrustedSender)

  ipcMain.handle('iclone:acp-work:state', (_event, input) => {
    const slug = slugOf(input)

    return slug ? work.view(slug) : null
  })
  ipcMain.handle('iclone:acp-work:set-level', (event, input) => {
    const slug = slugOf(input)
    const level = field(input, 'level')

    return slug && isAutonomyLevel(level) ? work.watchdog.setLevel(slug, level, deps.gestureOk(event, input)) : INVALID
  })
  ipcMain.handle('iclone:acp-work:online', (event, input) => {
    const slug = slugOf(input)

    return slug ? work.online(slug, deps.gestureOk(event, input)) : INVALID
  })
  ipcMain.handle('iclone:acp-work:offline', (_event, input) => {
    const slug = slugOf(input)

    return slug ? work.offline(slug) : INVALID
  })
  ipcMain.handle('iclone:acp-work:reboot', (_event, input) => {
    const slug = slugOf(input)

    return slug ? work.reboot(slug) : INVALID
  })
  ipcMain.handle('iclone:acp-work:repair', (event, input) => {
    const slug = slugOf(input)

    return slug ? work.repair(slug, deps.gestureOk(event, input)) : INVALID
  })
  ipcMain.handle('iclone:acp-work:approve', (event, input) => {
    const slug = slugOf(input)
    const jobId = jobIdOf(input)

    return slug && jobId ? work.watchdog.approve(slug, jobId, deps.gestureOk(event, input)) : INVALID
  })
  ipcMain.handle('iclone:acp-work:decline', (event, input) => {
    const slug = slugOf(input)
    const jobId = jobIdOf(input)

    return slug && jobId ? work.watchdog.decline(slug, jobId, deps.gestureOk(event, input)) : INVALID
  })
  ipcMain.handle('iclone:acp-work:refresh', (_event, input) => {
    const slug = slugOf(input)

    return slug ? work.watchdog.poll(slug).then(() => work.view(slug)) : null
  })

  return work
}
