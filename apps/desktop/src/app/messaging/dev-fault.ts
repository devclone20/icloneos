/**
 * Dev-only fault seam for Messaging's two failure branches.
 *
 * This front's target asks for the empty and the error state to be proven on a
 * real lab window, not only in jsdom. A probe cannot reach them from outside:
 * `contextBridge` exposes `window.hermesDesktop` as a NON-CONFIGURABLE,
 * deep-frozen property (measured on lab 2: `configurable` false, `writable`
 * false, `Object.isFrozen` true), so nothing outside the app can make the
 * platform-list call answer `[]` or throw.
 *
 * One optional window field, read only under `import.meta.env.DEV` — the same
 * shape the GPU pool already uses (`window.__icloneGpu`, app/home/gpu-lease.ts).
 * A production build drops the branch with the constant, and an app where
 * nobody sets the field behaves exactly as before.
 */
type MessagingFault = 'empty' | 'error'

/** What a dev (or a CDP probe) asked the platform list to do. */
export function messagingFault(): MessagingFault | undefined {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return undefined
  }

  const asked = (window as unknown as Record<string, unknown>).__icloneMessagingFault

  return asked === 'empty' || asked === 'error' ? asked : undefined
}
