/**
 * V3-I — reboot and tool-fix, in the doctor's shape (iclone-doctor-fixes.ts): every fix says what failed, what was
 * tried and what the state is now. The supervisor and the watchdog name a cause; this module decides the action, so
 * one cause always gets the same treatment and the tab can say why.
 */
import type { SupervisorState, WorkFixAction, WorkFixCause, WorkFixView } from '../../src/iclone-shared/acp-work'

const ACTIONS: Record<WorkFixCause, WorkFixAction> = {
  // A crash is retried by the listener engine with backoff (1 s doubling to 60 s), never in a tight loop.
  'listener-exited': 'restart-backoff',
  // Retrying a signed-out agent only fails again: stop, and say that sign-in is the owner's to do.
  'needs-sign-in': 'stopped-for-sign-in',
  'owner-reboot': 'restarted',
  // A failed read changes nothing on ACP; the next poll reads again.
  'read-failed': 'retry-next-poll',
  // REL-6: no retry installs the ACP tools; the owner does, then puts it online.
  'tools-missing': 'stopped-for-tools'
}

export function actionFor(cause: WorkFixCause): WorkFixAction {
  return ACTIONS[cause]
}

/** One entry for the tab and the ledger. */
export function fixEntry(id: string, at: Date, cause: WorkFixCause, now: SupervisorState): WorkFixView {
  return { id, at: at.toISOString(), cause, tried: actionFor(cause), now }
}
