// U1 contract 2.8, the renderer half of the second lock. It lives in the preload's isolated world, where page scripts
// can neither read nor reset it: a confirm counts only for a trusted event (real pointer or keyboard input, never a DOM
// `.click()` or a dispatched event) on the control marked `data-agent-update-confirm`, and only once.
const AGENT_UPDATE_CONFIRM_WINDOW_MS = 1500

interface ConfirmEventLike {
  altKey?: boolean
  ctrlKey?: boolean
  isTrusted: boolean
  key?: string
  metaKey?: boolean
  repeat?: boolean
  target: unknown
  type: string
}

const CONFIRM_KEYS = new Set([' ', 'Enter'])
const SHORTCUT_KEYS = new Set(['1', '2', '3', '4', '5'])

/**
 * G20: where a digit is the permission selector's own shortcut: inside the open menu (the selector's content is marked,
 * and it exists only while the selector is open), in this window while it has focus, and never from a text field.
 */
export function isPermModeShortcutTarget(target: unknown, windowFocused: boolean): boolean {
  if (!windowFocused || typeof (target as Element | null)?.closest !== 'function') {
    return false
  }

  const element = target as Element

  return (
    element.closest('[data-perm-mode-shortcuts]') !== null &&
    element.closest('input, textarea, select, [contenteditable]') === null
  )
}

/**
 * `isConfirmTarget` is the DOM test (the preload passes `closest('[data-agent-update-confirm]')`). `isShortcutTarget`,
 * only for a lock that has shortcuts, is where a plain, unrepeated digit counts as well: the same trusted, single use,
 * short-lived proof, so a script's event never counts.
 */
export function createConfirmTracker(opts: {
  isConfirmTarget: (target: unknown) => boolean
  isShortcutTarget?: (target: unknown) => boolean
  now?: () => number
  windowMs?: number
}) {
  const now = opts.now ?? Date.now
  const windowMs = opts.windowMs ?? AGENT_UPDATE_CONFIRM_WINDOW_MS
  let lastConfirmAt: null | number = null

  return {
    observe(event: ConfirmEventLike): void {
      const confirmInput = event.type === 'click' || (event.type === 'keydown' && CONFIRM_KEYS.has(event.key ?? ''))

      const shortcutInput =
        event.type === 'keydown' &&
        SHORTCUT_KEYS.has(event.key ?? '') &&
        !event.repeat &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey

      if (!event.isTrusted) {
        return
      }

      if ((confirmInput && opts.isConfirmTarget(event.target)) || (shortcutInput && opts.isShortcutTarget?.(event.target))) {
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
