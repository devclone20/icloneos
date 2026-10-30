import { atom } from 'nanostores'

/** True while the install overlay shows a failed install with its diagnosis: it owns the failure, so the
 * post-install failure card (BootFailureOverlay) stays down instead of covering it (RTB-6). */
export const $installOverlayOwnsFailure = atom(false)

/** True once the user chose "Skip for now": the app runs without the agent this session (nothing nags). */
export const $agentRuntimeSkipped = atom(false)
