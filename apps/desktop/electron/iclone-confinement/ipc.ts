/**
 * V3-G — the window's door to the confinement layer. Every channel is `iclone:confinement:*` and passes the app
 * sender guard. `state` is folded fresh on every call; `kill` only reaches a process that is confined right now
 * (a fresh `ps`), so the pane can stop an agent's command but never anything else on the Mac.
 */
import type { HardlinkAckResultView } from '../../src/iclone-shared/confinement'
import type { ConsentSenderGuard } from '../iclone-consent'
import { guardedHandler } from '../iclone-consent'
import { gestureOf, permissionGestureOk } from '../iclone-permissions/gesture'
import { activePermissions, recordConfinement } from '../iclone-permissions/ipc'

import { createRefusalAudit } from './refusal-audit'
import { createRefusalGate } from './refusal-gate'
import { startRefusalStream } from './refusals'
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
  ackHardlink: 'iclone:confinement:ack-hardlink'
} as const

interface RegisterConfinementDeps extends Omit<ConfinementDeps, 'audit'> {
  ipcMain: IpcMainLike
  /** Required (L9, r3 T6): a channel without the app sender guard would answer any renderer. */
  isTrustedSender: ConsentSenderGuard
  /** Pushes a nudge to the app windows when a refusal lands, so the pane reads `state` again. */
  broadcast?: (channel: string) => void
  /** Test seam: the audit tail; defaults to V3-F's live authority. */
  audit?: () => AuditSlice[]
  /** When main last saw real input reach this IPC sender (`lastTrustedInputAt(event.sender)`). Absent: no gesture
   *  ever counts, so nothing can be acknowledged. */
  lastInputAt?: (event: unknown) => number
  /** Test seam: where a refusal's audit record goes; defaults to V3-F's `recordConfinement`. */
  recordAudit?: Parameters<typeof createRefusalAudit>[0]['record']
  /** Test seam: the `log` children of the refusal stream. */
  refusalStream?: Pick<Parameters<typeof startRefusalStream>[0], 'spawnLog' | 'spawnShow'>
}

let active: { confinement: Confinement; stop: () => void } | null = null

const AUDIT_TAIL = 200

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

  ipcMain.handle(CONFINEMENT_CHANNELS.state, () => confinement.state())
  ipcMain.handle(CONFINEMENT_CHANNELS.kill, (_event, input) => {
    const pid = pidOf(input)

    return pid ? confinement.kill(pid) : { ok: false, pid: 0, reason: 'invalid', survivors: [], error: 'invalid pid' }
  })
  // The owner's answer to "these files are hard links to outside": the V3-F lock (a real click on the marked
  // control, seen by the preload and by main), then the files under one directory of one project, exactly the set
  // the pane showed (its digest), re-scanned here.
  ipcMain.handle(CONFINEMENT_CHANNELS.ackHardlink, (event, input): HardlinkAckResultView => {
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
  ipcMain.handle(CONFINEMENT_CHANNELS.explain, (_event, input) => {
    const pid = pidOf(input)

    return pid ? confinement.explain(pid) : []
  })

  // K07: every refusal also joins V3-F's audit chain (capped a minute; the refusal log keeps them all).
  const refusalAudit = createRefusalAudit({ record: deps.recordAudit ?? recordConfinement })

  // K97: the stream runs only while confinement is on and a confined run is live (refusal-gate.ts).
  const confinedNow = async () =>
    new Map(
      confinement
        .active()
        .list(await confinement.scan())
        .map(item => [item.pid, item.sessionId])
    )

  const stream =
    process.platform === 'darwin'
      ? createRefusalGate({
          membersDir: confinement.paths.membersDir,
          enabled: () => confinement.settings().enabled,
          live: async () => (await confinedNow()).size > 0,
          start: backfillSeconds =>
            startRefusalStream({
              log: confinement.refusals,
              confined: confinedNow,
              backfillSeconds,
              ...deps.refusalStream,
              onRefusal: refusal => {
                refusalAudit.record(refusal)
                deps.broadcast?.(CONFINEMENT_CHANNELS.changed)
              }
            })
        })
      : null

  active?.stop()
  active = {
    confinement,
    stop: () => {
      stream?.stop()
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
