/**
 * V3-F's audit trail, read through its bridge (`iclone:permissions:tail`, contract V3F §5) — the ONE file that
 * knows that shape (contract R5), so a change there is a change here only.
 *
 * Per agent session: an `ask` with no later decision is a task WAITING FOR YOU; a `refuse` or `timeout` is that
 * session's last line for a while. No bridge (a build without V3-F, a test) means this source is off — never an
 * error. The newest records are also kept for the panel's read-only log view.
 */
import { atom } from 'nanostores'

import type { IclonePermissionsBridge } from '@/components/consent/types'
import { auditKindLabel, describeAuditRecord } from '@/components/permissions/audit-detail'
import { enPermissions, type PermissionsCopy } from '@/i18n/en/enPermissions'
import { errorMessage } from '@/iclone-shared/errors'
import type { AuditRecordView } from '@/iclone-shared/permissions'
import type { BgTask, TaskSource } from '@/store/background-tasks'

const PERMISSIONS_SOURCE_ID = 'perm'

/** How long a refused or timed-out call stays on the list after the decision. */
const BLOCKED_LINGER_MS = 10 * 60_000

const CLOSES_ASK: ReadonlySet<string> = new Set(['answer', 'use', 'refuse', 'timeout'])
const BLOCKS: ReadonlySet<string> = new Set(['refuse', 'timeout'])

/** The newest audit records, newest last; `null` = no bridge in this build. */
export const $permissionAudit = atom<readonly AuditRecordView[] | null>(null)

const permissionsBridge = (): IclonePermissionsBridge | undefined => window.hermesDesktop?.icloneConsent?.permissions

/**
 * V3-T3 — the reader's permission words. Main's log line (`reason`) is English, so a task's lines are said from the
 * record's fields in these words; the runtime hook sets them from the active locale, and every live source re-folds.
 */
let words: PermissionsCopy = enPermissions
const refold = new Set<() => void>()

export function setPermissionWords(next: PermissionsCopy): void {
  if (next !== words) {
    words = next
    refold.forEach(cb => cb())
  }
}

/** A task's last line: what the agent is waiting on, or what was refused and why, never main's English log line. */
export function permissionTaskLine(
  record: AuditRecordView,
  state: 'failed' | 'waiting',
  copy: PermissionsCopy = words
): string {
  const kind = auditKindLabel(copy, record.kind)
  const tool = record.action?.tool

  if (state === 'waiting') {
    return [tool, record.action?.target].filter(Boolean).join(' · ') || kind
  }

  // A confinement refusal says so instead of "Refused" (its log line names the sandbox operation, in English).
  const why =
    record.src === 'confinement' || /^confinement:/.test(record.reason ?? '') ? copy.audit.details.confined : kind

  return [why, tool, describeAuditRecord(record, copy)].filter(Boolean).join(' · ')
}

function toTask(
  sid: string,
  record: AuditRecordView,
  state: 'failed' | 'waiting',
  copy: PermissionsCopy = words
): BgTask {
  const at = Date.parse(record.ts)
  const time = Number.isFinite(at) ? at : null

  return {
    id: `${PERMISSIONS_SOURCE_ID}:${sid}`,
    kind: 'agent',
    lastLine: permissionTaskLine(record, state, copy),
    lastLineAt: time,
    seen: true,
    sessionId: sid,
    source: PERMISSIONS_SOURCE_ID,
    startedAt: state === 'waiting' ? time : null,
    state,
    stop: 'none',
    title: record.action?.tool ?? auditKindLabel(copy, record.kind)
  }
}

/** The fold, oldest record first: one task per session with an open ask or a recent refusal. */
export function foldPermissionRecords(
  records: readonly AuditRecordView[],
  now: number,
  copy: PermissionsCopy = words
): BgTask[] {
  const open = new Map<string, AuditRecordView>()
  const blocked = new Map<string, AuditRecordView>()

  for (const record of records) {
    if (record.kind === 'restart') {
      open.clear()

      continue
    }

    const sid = record.agent?.session_id

    if (!sid) {
      continue
    }

    if (record.kind === 'ask') {
      open.set(sid, record)
      blocked.delete(sid)
    } else if (CLOSES_ASK.has(record.kind)) {
      open.delete(sid)

      if (BLOCKS.has(record.kind)) {
        blocked.set(sid, record)
      } else {
        blocked.delete(sid)
      }
    }
  }

  const waiting = [...open].map(([sid, record]) => toTask(sid, record, 'waiting', copy))

  const recent = [...blocked]
    .filter(([sid, record]) => !open.has(sid) && now - Date.parse(record.ts) <= BLOCKED_LINGER_MS)
    .map(([sid, record]) => toTask(sid, record, 'failed', copy))

  return [...waiting, ...recent]
}

/** `null` when the bridge is absent: the caller does not register the source at all. */
export function permissionsSource(now: () => number = Date.now): TaskSource | null {
  const bridge = permissionsBridge()

  if (!bridge) {
    $permissionAudit.set(null)

    return null
  }

  let records: readonly AuditRecordView[] = []
  let failure: string | null = null
  let generation = 0

  return {
    id: PERMISSIONS_SOURCE_ID,
    snapshot() {
      if (failure !== null) {
        throw new Error(failure)
      }

      return foldPermissionRecords(records, now())
    },
    stop: () => Promise.resolve({ detail: 'answer it in the chat', effect: 'unsupported', ok: false }),
    subscribe(cb) {
      const read = () => {
        const mine = (generation += 1)

        bridge
          .tail(0)
          .then(next => {
            if (mine === generation) {
              records = next
              failure = null
              $permissionAudit.set(next)
              cb()
            }
          })
          .catch((error: unknown) => {
            if (mine === generation) {
              failure = errorMessage(error)
              cb()
            }
          })
      }

      const off = bridge.onChanged(read)

      refold.add(cb)
      read()

      return () => {
        generation += 1
        refold.delete(cb)
        off()
      }
    }
  }
}
