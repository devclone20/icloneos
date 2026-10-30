// U1 contract 2.8, the renderer half of the second lock. It lives in the preload's isolated world, where page scripts
// can neither read nor reset it: a confirm counts only for a trusted event (real pointer or keyboard input, never a DOM
// `.click()` or a dispatched event) on the control marked `data-agent-update-confirm`, and only once.
const AGENT_UPDATE_CONFIRM_WINDOW_MS = 1500

interface ConfirmEventLike {
  isTrusted: boolean
  key?: string
  target: unknown
  type: string
}

const CONFIRM_KEYS = new Set([' ', 'Enter'])

/** `isConfirmTarget` is the DOM test (the preload passes `closest('[data-agent-update-confirm]')`). */
export function createConfirmTracker(opts: {
  isConfirmTarget: (target: unknown) => boolean
  now?: () => number
  windowMs?: number
}) {
  const now = opts.now ?? Date.now
  const windowMs = opts.windowMs ?? AGENT_UPDATE_CONFIRM_WINDOW_MS
  let lastConfirmAt: null | number = null

  return {
    observe(event: ConfirmEventLike): void {
      const confirmInput = event.type === 'click' || (event.type === 'keydown' && CONFIRM_KEYS.has(event.key ?? ''))

      if (event.isTrusted && confirmInput && opts.isConfirmTarget(event.target)) {
        lastConfirmAt = now()
      }
    },
    /** True once per trusted confirm, inside its window. */
    take(): boolean {
      const at = lastConfirmAt
      lastConfirmAt = null

      return at !== null && now() - at < windowMs
    }
  }
}
