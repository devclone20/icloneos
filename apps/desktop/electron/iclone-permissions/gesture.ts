/**
 * V3-F §2 — the lock on every decision only the user may make (a mode change, a grant revoke, a door answer). Three
 * facts must all hold, the U1 §2.8 pattern: the renderer saw user activation, the preload's isolated world saw a
 * trusted click/Enter ON the marked control (`data-perm-mode-confirm` / `data-consent-door-answer`, single use), and
 * the browser process delivered real input to that very window within the window. A synthetic `.click()`, a devtools
 * call or an agent driving the page fails at least one of them.
 */
import { gestureAllowed } from '../agent-update'

const PERMISSION_GESTURE_WINDOW_MS = 1500

interface GestureFacts {
  /** The payload's `gesture` field as the preload filled it. */
  payload: unknown
  /** When main last saw real input reach the sender (`lastTrustedInputAt`). */
  lastInputAt: number
  now: number
}

/** Pure: true only when the preload's two flags are exactly `true` and main saw real input in the window. */
export function permissionGestureOk(facts: GestureFacts): boolean {
  return gestureAllowed({
    lastInputAt: facts.lastInputAt,
    now: facts.now,
    payload: facts.payload,
    windowMs: PERMISSION_GESTURE_WINDOW_MS
  })
}

/** Reads the `gesture` member of an IPC payload without trusting its shape. */
export function gestureOf(input: unknown): unknown {
  return input && typeof input === 'object' ? (input as Record<string, unknown>).gesture : undefined
}
