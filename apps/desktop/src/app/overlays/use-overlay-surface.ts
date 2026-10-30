import { type RefObject, useEffect, useRef } from 'react'

import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { triggerHaptic } from '@/lib/haptics'

// Every overlay surface (the OverlayView card, the Settings Dock window) covers
// the chat while the composer stays mounted beneath it. This marker tells
// `composerFocusBlockedBySurface` to stand the global type-to-focus / soft `/` /
// Enter down, so keystrokes don't leak into the hidden composer (and the
// overlay's own bare-key shortcuts, e.g. star map's Space, keep working). The
// `it` CLI reads the last one as the topmost overlay.
export const OVERLAY_SURFACE_MARKER = { 'data-overlay-surface': '' } as const

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

interface OverlaySurfaceOptions {
  /** The element that takes focus on mount, when the scope itself cannot (default: the scope). */
  focusRef?: RefObject<HTMLElement | null>
}

/**
 * FOCUS CONTRACT + Esc — one implementation for every overlay surface
 * (settings, skills, messaging, artifacts, cron, agents, command center):
 *  · on mount, focus moves INTO the surface, so the first Tab lands on the
 *    overlay's own controls instead of walking the covered shell beneath;
 *  · Tab is trapped inside the returned scope while the overlay is open — a
 *    keyboard user cannot fall out the back of a surface the mouse cannot reach;
 *  · on unmount, focus returns to wherever it was, so Esc from Settings puts
 *    the keyboard back on the control that opened it;
 *  · Esc closes it. Nested Radix dialogs stop propagation themselves, so
 *    opening (e.g.) the model picker inside Settings still closes the picker
 *    first instead of the underlying overlay.
 */
export function useOverlaySurface<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  { focusRef }: OverlaySurfaceOptions = {}
): RefObject<T | null> {
  const scopeRef = useRef<T>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTarget = () => focusRef?.current ?? scopeRef.current

    focusTarget()?.focus({ preventScroll: true })

    const trap = (event: KeyboardEvent) => {
      const scope = scopeRef.current

      if (event.key !== 'Tab' || !scope) {
        return
      }

      const focusables = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        el => el.offsetParent !== null && !el.hasAttribute('disabled')
      )

      if (focusables.length === 0) {
        return
      }

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const current = document.activeElement

      if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && (current === first || current === scope || current === focusTarget())) {
        event.preventDefault()
        last.focus()
      } else if (current && !scope.contains(current)) {
        // Focus escaped (a portal closed, an element unmounted under it) —
        // reel it back in instead of letting Tab wander the shell.
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', trap, true)

    return () => {
      window.removeEventListener('keydown', trap, true)

      if (previous && previous.isConnected) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [focusRef])

  useEffect(() => {
    const releaseLayer = pushEscapeLayer(ESCAPE_PRIORITY.overlay)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
        return
      }

      event.preventDefault()
      triggerHaptic('close')
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      releaseLayer()
    }
  }, [onClose])

  return scopeRef
}
