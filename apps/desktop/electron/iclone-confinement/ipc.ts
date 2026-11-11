/**
 * V3-G — the window's door to the confinement layer. Every channel is `iclone:confinement:*` and passes the app
 * sender guard. `state` is folded fresh on every call; `kill` and `stop-run` only reach processes that are confined
 * right now (a fresh `ps` and the kernel's membership), so the pane can stop an agent's command but never anything
 * else on the Mac.
 */
import type {
  ConfinementChangeNotice,
  HardlinkAckResultView,
  HardlinkGroupPathsResult,
  StopRunResultView
} from '../../src/iclone-shared/confinement'
import type { ConsentSenderGuard } from '../iclone-consent'
import { guardedHandler } from '../iclone-consent'
import { gestureOf, permissionGestureOk } from '../iclone-permissions/gesture'
import { activePermissions, recordConfinement } from '../iclone-permissions/ipc'

import { activeFirstScan, hardlinkGroupPaths, onFirstScanChange } from './hardlinks'
import { createIsolationSwitch, type IsolationRestart } from './isolation-switch'
import { createRefusalAudit } from './refusal-audit'
import { createRefusalGate } from './refusal-gate'
import { type ConfinedAt, createNoticeThrottle, startRefusalStream } from './refusals'
import type { AuditSlice } from './state'

import { type Confinement, type ConfinementDeps, createConfinement } from './index'

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

export const CONFINEMENT_CHANNELS = {
  state: 'iclone:confinement:state',
  kill: 'iclone:confinement:kill',
  explain: 'iclone:confinement:explain',
  changed: 'iclone:confinement:changed',
  ackHardlink: 'iclone:confinement:ack-hardlink',
  hardlinkPaths: 'iclone:confinement:hardlink-paths',
  stopRun: 'iclone:confinement:stop-run',
  setIsolation: 'iclone:confinement:set-isolation'
} as const

interface RegisterConfinementDeps extends Omit<ConfinementDeps, 'audit'> {
  ipcMain: IpcMainLike
  /** Required (L9, r3 T6): a channel without the app sender guard would answer any renderer. */
  isTrustedSender: ConsentSenderGuard
  /** Pushes a nudge to the app windows when a refusal lands, so the pane reads `state` again; a first scan's count
   *  rides in the notice itself (CF5, B3-n5), so the windows do not re-read the whole state twice a second. */
  broadcast?: (channel: string, notice?: ConfinementChangeNotice) => void
  /** Test seam: the audit tail; defaults to V3-F's live authority. */
  audit?: () => AuditSlice[]
  /** When main last saw real input reach this IPC sender (`lastTrustedInputAt(event.sender)`). Absent: no gesture
   *  ever counts, so nothing can be acknowledged. */
  lastInputAt?: (event: unknown) => number
  /** F41: the native dialog before isolation goes off. Absent: it cannot go off from here. */
  confirmIsolationOff?: (event: unknown, persists: boolean) => Promise<boolean>
  /** F41: stops every agent backend and starts the primary again, so nothing runs under the old state. */
  restartAgent?: () => Promise<IsolationRestart>
  /** Test seam: where a refusal's audit record goes; defaults to V3-F's `recordConfinement`. */
  recordAudit?: Parameters<typeof createRefusalAudit>[0]['record']
  /** Test seam: the `log` children of the refusal stream. */
  refusalStream?: Pick<Parameters<typeof startRefusalStream>[0], 'spawnLog' | 'spawnShow'>
}

let active: { confinement: Confinement; stop: () => void } | null = null

const AUDIT_TAIL = 200
/** The least time between two refusal change notices. */
export const CHANGED_NOTICE_MS = 250
/** CF4 (B2-M1): the least time between two first-scan change notices (start, folders counted, end). */
export const FIRST_SCAN_NOTICE_MS = 500

/** V3-F's audit tail, read through its exported authority (consumed, never edited). */
function permissionsAudit(): AuditSlice[] {
  const { authority } = activePermissions()

  return authority ? authority.tail(0, AUDIT_TAIL) : []
}

const pidOf = (input: unknown): number | null => {
  const pid = Number((input as Record<string, unknown> | null)?.pid)

  return Number.isInteger(pid) && pid > 1 ? pid : null
}

export function registerConfinement(deps: RegisterConfinementDeps): Confinement {
  // T6': the type requires the guard; the runtime refuses without it too (a JS caller, a cast). Thrown before anything
  // is created or registered, so no channel exists that could answer a renderer unguarded.
  if (typeof deps.isTrustedSender !== 'function') {
    throw new TypeError('registerConfinement: isTrustedSender is required; no channel is registered without it')
  }

  const confinement = createConfinement({ ...deps, audit: deps.audit ?? permissionsAudit })
  // r5 MINOR-1: the guard's answer counts only when it is exactly true. V3-F's guardedHandler tests truthiness, so a
  // guard that answered 'false', 1 or {} would open every channel; here nothing but the boolean does.
  const ipcMain = guardedHandler(deps.ipcMain, (event, channel) => deps.isTrustedSender(event, channel) === true)

  // L4-02: the day's count comes from main's counters, never from a read of the day's file.
  // CF1: the first hard-link scan running now, read from the guard's own progress (no file system call).
  ipcMain.handle(CONFINEMENT_CHANNELS.state, async () => ({
    ...(await confinement.state()),
    refusalDay: confinement.refusals.day(),
    firstScan: activeFirstScan()
  }))
  ipcMain.handle(CONFINEMENT_CHANNELS.kill, (_event, input) => {
    const pid = pidOf(input)

    return pid ? confinement.kill(pid) : { ok: false, pid: 0, reason: 'invalid', survivors: [], error: 'invalid pid' }
  })
  // The owner's answer to "these files are hard links to outside": the V3-F lock (a real click on the marked
  // control, seen by the preload and by main), then the files under one directory of one project, exactly the set
  // the pane showed (its digest), re-scanned here.
  // CF5 (B3-n2): one page of a refused group's file names past the ones its view carries. Display only (no gesture:
  // nothing is allowed by reading), from the last check's answer, never a scan; a group that changed says so.
  ipcMain.handle(CONFINEMENT_CHANNELS.hardlinkPaths, (_event, input): HardlinkGroupPathsResult => {
    const fields = (input ?? {}) as Record<string, unknown>
    const { digest, dir, offset, root } = fields
    const known = Object.keys(fields).every(name => ['digest', 'dir', 'offset', 'root'].includes(name))

    return known &&
      typeof root === 'string' &&
      typeof dir === 'string' &&
      typeof digest === 'string' &&
      typeof offset === 'number' &&
      Number.isSafeInteger(offset) &&
      offset >= 0
      ? hardlinkGroupPaths(root, dir, digest, offset)
      : { ok: false, reason: 'invalid' }
  })
  ipcMain.handle(CONFINEMENT_CHANNELS.ackHardlink, async (event, input): Promise<HardlinkAckResultView> => {
    const gestureOk = permissionGestureOk({
      payload: gestureOf(input),
      lastInputAt: deps.lastInputAt?.(event) ?? 0,
      now: Date.now()
    })

    if (!gestureOk) {
      return { ok: false, reason: 'no-gesture' }
    }

    const { digest, dir, root } = (input ?? {}) as Record<string, unknown>

    return typeof root === 'string' && typeof dir === 'string' && typeof digest === 'string'
      ? confinement.acknowledgeHardlink(root, dir, digest)
      : { ok: false, reason: 'invalid' }
  })
  // The owner's Stop on one run of the ledger: the id is checked against the run-token shape in main (index.ts).
  ipcMain.handle(CONFINEMENT_CHANNELS.stopRun, (_event, input): Promise<StopRunResultView> | StopRunResultView => {
    const run = (input as Record<string, unknown> | null)?.run

    return typeof run === 'string'
      ? confinement.stopRun(run)
      : { ok: false, run: '', reason: 'invalid', survivors: [], error: 'invalid run' }
  })
  // F41: the only door to setEnabled. The runtime has no path here: this channel takes the app sender guard, and the
  // switch takes the gesture and the native dialog.
  ipcMain.handle(
    CONFINEMENT_CHANNELS.setIsolation,
    createIsolationSwitch({
      layer: confinement,
      platform: deps.platform ?? process.platform,
      lastInputAt: deps.lastInputAt,
      confirmOff: deps.confirmIsolationOff,
      restartAgent: deps.restartAgent,
      record: entry => recordConfinement(entry),
      changed: () => deps.broadcast?.(CONFINEMENT_CHANNELS.changed)
    })
  )
  ipcMain.handle(CONFINEMENT_CHANNELS.explain, (_event, input) => {
    const pid = pidOf(input)

    return pid ? confinement.explain(pid) : []
  })

  // K07: every refusal also joins V3-F's audit chain (capped a minute; the refusal log keeps them all).
  const refusalAudit = createRefusalAudit({ record: deps.recordAudit ?? recordConfinement })

  // L4-02: refusals reach the windows as at most one change notice per CHANGED_NOTICE_MS, the last one trailing, so a
  // burst costs each window a handful of state reads, not one per refusal.
  const refusalNotice = createNoticeThrottle(() => deps.broadcast?.(CONFINEMENT_CHANNELS.changed), CHANGED_NOTICE_MS)

  // CF4 (B2-M1): a first hard-link scan's start, progress and end reach the windows the same way, at most one notice
  // per FIRST_SCAN_NOTICE_MS with the last trailing, so the chat's status line appears, counts and goes away live.
  // CF5 (B3-n5): while the scan runs the notice carries its count (the window updates its line from it); the end
  // carries nothing, so every window reads the state once (the scan's answer may have changed what it shows).
  const firstScanNotice = createNoticeThrottle(() => {
    const firstScan = activeFirstScan()

    if (firstScan) {
      deps.broadcast?.(CONFINEMENT_CHANNELS.changed, { firstScan })
    } else {
      deps.broadcast?.(CONFINEMENT_CHANNELS.changed)
    }
  }, FIRST_SCAN_NOTICE_MS)

  const stopFirstScanNotice = onFirstScanChange(() => firstScanNotice.notify())

  // The stream runs only while confinement is on and a confined run is live (refusal-gate.ts). Each pid carries
  // its session and the run token the kernel holds it in, read at record time (the pid may be gone a moment later).
  const confinedNow = async (): Promise<Map<number, ConfinedAt>> => {
    const snapshot = await confinement.scan()
    const runOf = new Map(snapshot.rows.map(row => [row.pid, row.run ?? null]))

    return new Map(
      confinement
        .active()
        .list(snapshot)
        .map(item => [item.pid, { sessionId: item.sessionId, run: runOf.get(item.pid) ?? null }])
    )
  }

  const stream =
    process.platform === 'darwin'
      ? createRefusalGate({
          membersDir: confinement.paths.membersDir,
          enabled: () => confinement.settings().enabled,
          live: async () => (await confinedNow()).size > 0,
          start: backfillSeconds =>
            startRefusalStream({
              log: confinement.refusals,
              membersDir: confinement.paths.membersDir,
              confined: confinedNow,
              backfillSeconds,
              ...deps.refusalStream,
              onRefusal: refusal => refusalAudit.record(refusal),
              onBatch: () => refusalNotice.notify()
            })
        })
      : null

  active?.stop()
  active = {
    confinement,
    stop: () => {
      stream?.stop()
      stopFirstScanNotice()
      firstScanNotice.stop()
      refusalNotice.stop()
      refusalAudit.stop()
    }
  }

  return confinement
}

/** The env one Hermes spawn needs (start-hermes.ts); empty before registration or when confinement is off. */
export function confinementSpawnEnv(): Record<string, string> {
  return active?.confinement.spawnEnv() ?? {}
}

export function stopConfinement(): void {
  active?.stop()
  active = null
}
