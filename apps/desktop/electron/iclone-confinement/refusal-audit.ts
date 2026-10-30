/**
 * K07 — a Seatbelt refusal joins V3-F's audit chain (src `confinement`, written by main's one writer through
 * `recordConfinement`), so it shows in the Background-tasks panel beside the tool call it stopped, joined by
 * `agent.session_id`. The refusal log (`refusals/<day>.jsonl`) keeps every one; the chain gets at most `perMinute`
 * a minute, so a looping build cannot flood the signed log, and the overflow is one `gap` record with its count.
 */
import type { RefusalView } from '../../src/iclone-shared/confinement'
import { redactSecrets } from '../../src/iclone-shared/redact'

interface ConfinementAuditEntry {
  kind: 'gap' | 'refuse'
  reason: string
  action?: { tool: string; target: string; project_root: string | null } | null
  agent?: {
    inft: string | null
    profile: string | null
    session_id: string | null
    subagent_id: string | null
    task_id: string | null
  } | null
}

interface RefusalAuditDeps {
  /** V3-F's `recordConfinement` (null when the authority is not up: the refusal log still has the row). */
  record: (entry: ConfinementAuditEntry) => unknown
  perMinute?: number
  now?: () => number
}

const PER_MINUTE = 30
const WINDOW_MS = 60_000

export function createRefusalAudit(deps: RefusalAuditDeps) {
  const cap = deps.perMinute ?? PER_MINUTE
  const now = deps.now ?? Date.now
  let windowStart = now()
  let written = 0
  let dropped = 0
  let timer: NodeJS.Timeout | null = null

  const roll = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    if (dropped > 0) {
      deps.record({
        kind: 'gap',
        reason: `confinement: ${dropped} more refusal${dropped === 1 ? '' : 's'} in one minute, kept in the refusal log only`
      })
    }

    windowStart = now()
    written = 0
    dropped = 0
  }

  return {
    record(refusal: RefusalView): void {
      if (now() - windowStart >= WINDOW_MS) {
        roll()
      }

      if (written >= cap) {
        dropped += 1

        if (!timer) {
          timer = setTimeout(roll, Math.max(0, windowStart + WINDOW_MS - now()))
          timer.unref?.()
        }

        return
      }

      written += 1
      deps.record({
        kind: 'refuse',
        reason: `confinement: the sandbox refused ${refusal.operation}`,
        action: { tool: refusal.process, target: redactSecrets(refusal.target), project_root: null },
        agent: refusal.sessionId
          ? { inft: null, profile: null, session_id: refusal.sessionId, subagent_id: null, task_id: null }
          : null
      })
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
