import { atom } from 'nanostores'

/**
 * v0.0.9 F3 (point B): the owner closed the boot-failure card (X or Esc). The app stays open in "agent stopped" mode:
 * settings, saved chats, logs and Permissions reachable; the composer disabled with the reason; a banner with Retry
 * and Show details. Closing starts NOTHING: main keeps the failure latched, so no getConnection() can spawn an agent
 * until Retry / Repair (each one through the permission gate). Renderer-only presentation state: a reload (Retry)
 * starts a fresh boot and forgets it.
 */
export interface AgentStoppedState {
  /** The boot error the card showed when it was closed. */
  error: string
  at: number
}

export const $agentStopped = atom<AgentStoppedState | null>(null)

export function stopAgentForNow(error: string) {
  $agentStopped.set({ at: Date.now(), error })
}

/** Show details: the card comes back over the app (the failure is still there). */
export function reopenAgentFailure() {
  $agentStopped.set(null)
}
