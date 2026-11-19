/**
 * Window opacity wiring — the one place a window connects the shared slider
 * primitive to what it fades.
 *
 * v0.0.9 F6 (owner addition, 18 Nov): ONE opacity for the panes. Two panes
 * side by side fade together, up and down, from one control (the right
 * pane's column, ic-window.tsx); a pane alone shows the same control. The
 * value is one store (`$paneOpacity`), remembered under the Message window's
 * old key.
 *
 * - 'self' windows fade their own plate element (`usePlateOpacity`), written
 *   straight to the DOM from a store subscription: a slider drag is dozens of
 *   events per second, and running each through the window's state
 *   re-rendered the whole app for every pixel. Only a crossing of the pointer
 *   gate reaches the window (`onInteractiveChange`).
 * - 'under-shell' windows (Message) fade shells that are not ours to render
 *   (`useShellOpacity`), through two custom properties on <html>
 *   (`--iclone-msg-opacity`, `--iclone-msg-pe`) consumed by home.css.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type RefObject, useEffect, useLayoutEffect } from 'react'

import { readKey, writeKey } from '@/lib/storage'

import { ICLONE_STORAGE } from '../lib/storage-keys'
import { OpacitySlider } from '../opacity-slider'

import { MIN_INTERACTIVE } from './pointer-gate'

// Below this the blur becomes visible through the thinned surface; above it
// the surface is opaque enough that the filter is pure cost.
const GLASS_BELOW = 0.92
const GLASS_CLASS = 'iecon__surface--glass'

const OPACITY_KEY = ICLONE_STORAGE.msgOpacity.key

function readStored(): number {
  const raw = readKey(OPACITY_KEY)
  const value = raw === null ? 1 : Number.parseFloat(raw)

  if (!Number.isFinite(value)) {
    return 1
  }

  // A window never opens below the pointer gate: it would open unreachable.
  return Math.min(1, Math.max(MIN_INTERACTIVE, value))
}

/** The one opacity of every open pane. */
export const $paneOpacity = atom<number>(readStored())

export function setPaneOpacity(value: number): void {
  const next = Math.min(1, Math.max(0, value))

  if (next === $paneOpacity.get()) {
    return
  }

  $paneOpacity.set(next)
  writeKey(OPACITY_KEY, next.toFixed(3))
}

/** Tests only: back to the stored value (or opaque). */
export function resetPaneOpacityForTests(): void {
  $paneOpacity.set(readStored())
}

/** A self window's plate follows the panes' opacity; the window hears only the pointer-gate crossings. */
export function usePlateOpacity(
  plateRef: RefObject<HTMLDivElement | null>,
  onInteractiveChange: (interactive: boolean) => void
): void {
  useLayoutEffect(() => {
    const apply = (value: number) => {
      const interactive = value >= MIN_INTERACTIVE

      // React bails out while the flag is unchanged: the window re-renders only when the gate is crossed.
      onInteractiveChange(interactive)

      const plate = plateRef.current

      if (!plate) {
        return
      }

      plate.style.opacity = String(value)
      plate.style.pointerEvents = interactive ? 'auto' : 'none'
      plate.classList.toggle(GLASS_CLASS, value < GLASS_BELOW)
    }

    return $paneOpacity.subscribe(apply)
  }, [onInteractiveChange, plateRef])
}

function applyShellOpacity(value: number) {
  const root = document.documentElement

  root.style.setProperty('--iclone-msg-opacity', value.toFixed(3))
  root.style.setProperty('--iclone-msg-pe', value < MIN_INTERACTIVE ? 'none' : 'auto')
}

/** The Message window's shells follow the panes' opacity. */
export function useShellOpacity(): void {
  useEffect(() => $paneOpacity.subscribe(applyShellOpacity), [])
}

/** The control: one per window alone, ONE for two panes side by side (ic-window.tsx decides where it shows). */
export function PaneOpacity({ label }: { label: string }) {
  const value = useStore($paneOpacity)

  return <OpacitySlider label={label} onChange={setPaneOpacity} value={value} />
}
