/**
 * v0.0.9 F3 — the repair kit wired into the app: real paths and process probes as deps, and IPC
 * `iclone:repair-kit:{scan,apply,undo,history}` behind the app sender guard.
 *
 * The owner's own click: a REAL repair (apply with dryRun:false) and an undo move files, so each needs the V3-F gesture
 * (activation + a trusted click on a `data-repair-kit-confirm` control + real input to this window, the same three
 * facts as every other owner decision; never loosened). Scan, history and the dry run read only and need none.
 * The preload half of that lock (tracker `repairKitConfirm`) is requested from F1-S (v009-requests.md); until it lands
 * the preload sends no gesture and every real repair is refused with `refused: 'gesture'` — fail closed.
 */
import net from 'node:net'
import path from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'

import type { BackendOwnershipEntry } from '../backend-ownership'
import { gestureOf, permissionGestureOk } from '../iclone-permissions/gesture'

import { createRepairKit, type OrphanCandidate, type RepairKit, type RepairKitDeps } from './kit'
import { isRepairClassId, type RepairReport, type UndoReport } from './types'

const SOCKET_PROBE_MS = 500

/** True when something answers on a unix socket; a probe that cannot decide counts as alive (never moved). */
export function socketAnswers(file: string, timeoutMs = SOCKET_PROBE_MS): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ path: file })

    const done = (alive: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(alive)
    }

    const timer = setTimeout(() => done(true), timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      // Refused / gone: nobody listens. Anything else (EACCES…) is not ours to judge.
      done(!(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' || error.code === 'ENOTSOCK'))
    })
  })
}

/**
 * The app's OWN backend records that `backendOwnership.reapOrphans()` would stop — `verified` is its read-only
 * `listOrphans()`: the recorded parent is gone (or its pid reused) AND the process is still the recorded one (start
 * marker + command) — minus this app run's own children and its live backend. v0.0.9 Q (correctness 7): never a
 * record whose parent is another live instance (a dev build beside the packaged app) and never a reused pid, so a
 * listed orphan is one the reap really stops, and the kit never stops the agent for nothing. Never a match over `ps`.
 */
export function ownOrphanCandidates(
  verified: readonly BackendOwnershipEntry[],
  mainPid: number,
  livePid: number | null
): OrphanCandidate[] {
  return verified
    .filter(entry => entry.parentPid !== mainPid && entry.pid !== livePid)
    .map(entry => (entry.command ? { command: entry.command, pid: entry.pid } : { pid: entry.pid }))
}

export interface RepairKitIpcDeps {
  kit: RepairKit
  handle(channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown): void
  isTrustedSender(event: IpcMainInvokeEvent, channel: string): boolean
  lastInputAt(event: IpcMainInvokeEvent): number
  /** After a real repair or undo that changed something: clear the latched failure so the next start is fresh. */
  afterChange(report: { reinstall: boolean }): void
  /**
   * v0.0.9 r3 (eng n4): one permissions-audit line per real apply and undo, and per refused one (the kit moved user
   * files and wrote only its own manifest). The sink returns the record, or null when it could not write one.
   */
  audit?(entry: RepairKitAuditEntry): unknown
  now?(): number
}

export interface RepairKitAuditEntry {
  kind: 'refuse' | 'use'
  tool: 'repair-kit.apply' | 'repair-kit.undo'
  reason: string
  gesture: boolean
}

/** The audit reason of a real apply: the class, the manifest id and every step that ran, never a path. */
export function applyAuditReason(report: RepairReport): string {
  const steps = report.applied.map(applied => applied.step.kind).join(',') || 'none'
  const outcome = report.rolledBack ? 'rolled back' : report.ok ? 'ok' : 'failed'

  return `${report.classId}: ${outcome}; manifest ${report.manifestId ?? 'none'}; steps ${report.applied.length} [${steps}]`
}

/** The audit reason of a real undo. */
export function undoAuditReason(report: UndoReport): string {
  return `undo ${report.manifestId}: ${report.ok ? 'ok' : (report.refused ?? 'failed')}; restored ${report.restored.length}; skipped ${report.skipped.length}`
}

/** Main's verdict on the owner's click for one IPC payload (pure, testable). */
export function repairGestureOk(input: unknown, lastInputAt: number, now: number): boolean {
  return permissionGestureOk({ lastInputAt, now, payload: gestureOf(input) })
}

export function registerRepairKitIpc(deps: RepairKitIpcDeps): void {
  const now = deps.now ?? Date.now

  // The audit never blocks the owner's repair (the kit's own manifest is the undo record); a failed write is logged by
  // the sink.
  const record = (entry: RepairKitAuditEntry) => {
    try {
      deps.audit?.(entry)
    } catch {
      // the sink logs its own failure
    }
  }

  const guarded = (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
    deps.handle(channel, (event, input) => (deps.isTrustedSender(event, channel) ? handler(event, input) : null))

  guarded('iclone:repair-kit:scan', () => deps.kit.scan())
  guarded('iclone:repair-kit:history', () => deps.kit.history())

  guarded('iclone:repair-kit:apply', async (event, input): Promise<RepairReport | null> => {
    const { classId, dryRun } = (input && typeof input === 'object' ? input : {}) as {
      classId?: unknown
      dryRun?: unknown
    }

    if (!isRepairClassId(classId)) {
      return null
    }

    const real = dryRun === false

    if (real && !repairGestureOk(input, deps.lastInputAt(event), now())) {
      const plan = await deps.kit.apply(classId, { dryRun: true })

      record({ kind: 'refuse', tool: 'repair-kit.apply', reason: `${classId}: without the owner's click`, gesture: false })

      return { ...plan, dryRun: false, ok: false, refused: 'gesture' }
    }

    const report = await deps.kit.apply(classId, { dryRun: !real })

    if (real) {
      record({ kind: 'use', tool: 'repair-kit.apply', reason: applyAuditReason(report), gesture: true })
    }

    // A rolled-back run changed nothing the next start could use (correctness 8): the failure card and the restart
    // budget stay as they are.
    if (real && report.applied.length > 0 && !report.rolledBack) {
      deps.afterChange({ reinstall: report.steps.some(step => step.kind === 'reinstall-runtime') })
    }

    return report
  })

  guarded('iclone:repair-kit:undo', async (event, input): Promise<UndoReport | null> => {
    const { manifestId } = (input && typeof input === 'object' ? input : {}) as { manifestId?: unknown }

    if (typeof manifestId !== 'string' || manifestId.length > 120) {
      return null
    }

    if (!repairGestureOk(input, deps.lastInputAt(event), now())) {
      record({ kind: 'refuse', tool: 'repair-kit.undo', reason: `undo ${manifestId}: without the owner's click`, gesture: false })

      return { manifestId, ok: false, refused: 'gesture', restored: [], skipped: [] }
    }

    const report = await deps.kit.undo(manifestId)

    record({ kind: 'use', tool: 'repair-kit.undo', reason: undoAuditReason(report), gesture: true })

    if (report.restored.length > 0) {
      deps.afterChange({ reinstall: false })
    }

    return report
  })
}

/** The kit with this machine's real paths and probes (main.ts → bootstrap-ipc.ts). */
export function createAppRepairKit(
  base: Omit<RepairKitDeps, 'orphans' | 'socketAlive'> & {
    /** `backendOwnership.listOrphans()`: the records the reap would stop (proven parent gone + identity). */
    listOrphans(): Promise<BackendOwnershipEntry[]>
    livePid(): number | null
    reapOrphans(): Promise<number[]>
  }
): RepairKit {
  const { listOrphans, livePid, reapOrphans, ...rest } = base

  return createRepairKit({
    ...rest,
    orphans: {
      list: async () => ownOrphanCandidates(await listOrphans(), process.pid, livePid()),
      reap: reapOrphans
    },
    socketAlive: file => socketAnswers(path.resolve(file))
  })
}
