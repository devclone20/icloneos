/**
 * Window opacity wiring — the one place a window connects the shared slider
 * primitive to what it fades.
 *
 * - 'self' windows fade their own plate element, written straight to the DOM:
 *   a slider drag is dozens of events per second, and running each through
 *   the window's state re-rendered the whole app for every pixel. Only a
 *   crossing of the pointer gate reaches the window (`onInteractiveChange`).
 * - 'under-shell' windows (Message) fade shells that are not ours to render,
 *   through two custom properties on <html> (`--iclone-msg-opacity`,
 *   `--iclone-msg-pe`) consumed by home.css; the value is remembered.
 */
import { type RefObject, useCallback, useEffect, useState } from 'react'

import { OpacitySlider } from '../opacity-slider'

import { MIN_INTERACTIVE } from './pointer-gate'

// Below this the blur becomes visible through the thinned surface; above it
// the surface is opaque enough that the filter is pure cost.
const GLASS_BELOW = 0.92
const GLASS_CLASS = 'iecon__surface--glass'

interface PlateOpacityProps {
  label: string
  plateRef: RefObject<HTMLDivElement | null>
  onInteractiveChange: (interactive: boolean) => void
}

export function PlateOpacity({ label, onInteractiveChange, plateRef }: PlateOpacityProps) {
  const [opacity, setOpacity] = useState(1)

  const apply = useCallback(
    (value: number) => {
      const interactive = value >= MIN_INTERACTIVE

      setOpacity(value)
      // React bails out while the flag is unchanged: the window re-renders
      // only when the gate is crossed.
      onInteractiveChange(interactive)

      const plate = plateRef.current

      if (!plate) {
        return
      }

      plate.style.opacity = String(value)
      plate.style.pointerEvents = interactive ? 'auto' : 'none'
      plate.classList.toggle(GLASS_CLASS, value < GLASS_BELOW)
    },
    [onInteractiveChange, plateRef]
  )

  return <OpacitySlider label={label} onChange={apply} value={opacity} />
}

const MESSAGE_KEY = 'iclone.msgOpacity'

function readStored(): number {
  try {
    const raw = window.localStorage.getItem(MESSAGE_KEY)
    const value = raw === null ? 1 : Number.parseFloat(raw)

    if (!Number.isFinite(value)) {
      return 1
    }

    return Math.min(1, Math.max(MIN_INTERACTIVE, value))
  } catch {
    return 1
  }
}

function applyShellOpacity(value: number) {
  const root = document.documentElement

  root.style.setProperty('--iclone-msg-opacity', value.toFixed(3))
  root.style.setProperty('--iclone-msg-pe', value < MIN_INTERACTIVE ? 'none' : 'auto')
}

export function ShellOpacity({ label }: { label: string }) {
  const [value, setValue] = useState(readStored)

  useEffect(() => {
    applyShellOpacity(value)

    try {
      window.localStorage.setItem(MESSAGE_KEY, value.toFixed(3))
    } catch {
      /* per-session only */
    }
  }, [value])

  return <OpacitySlider label={label} onChange={setValue} value={value} />
}
