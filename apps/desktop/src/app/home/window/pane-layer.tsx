/**
 * v0.0.9 F6 — the home's pane layer, mounted once by HomeView inside `.ihome`:
 * - the PROBE: an invisible box on the frame (the same `--ic-frame-*` tokens as every window) whose measured width is
 *   the panes' usable width ($paneArea) — never a second copy of the frame numbers;
 * - the DIVIDER between two panes side by side: an 8 px hit target with a 1 px hairline; drag to resize (each side
 *   stays ≥ 375), double-click for half and half, ←/→ step it, Home/End jump to the limits;
 * - the TABS a folded pair shows on top of the focused pane, so the other one is one click away; the pair unfolds
 *   by itself when the width is back;
 * - which pane has the focus (a press or a focus inside it), and the toast when a 3rd pane replaced one.
 */
import { useStore } from '@nanostores/react'
import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useLayoutEffect, useRef } from 'react'

import { IcTip } from '@/components/ic/ic-system'
import { f6PaneNames, f6Panes, f6Split } from '@/i18n/en/v009-f6'
import { notify } from '@/store/notifications'

import type { IcWindowId } from './ic-window'
import { $paneAnnouncement } from './pane-announce'
import {
  $paneArea,
  $paneArrangement,
  $panes,
  focusRegisteredPane,
  onPaneReplaced,
  PANE_DIVIDER_PX,
  PANE_DIVIDER_STEP_PX,
  PANE_MIN_PX,
  persistPaneRatio,
  ratioAt,
  resetPaneRatio,
  setPaneRatio
} from './pane-layout'

const nameOf = (id: string): string => f6PaneNames[id as IcWindowId] ?? id

/** The pane a DOM node belongs to: a self window's root, a column, or one of the Message window's shells. */
export function paneOfTarget(target: EventTarget | null): null | string {
  if (!(target instanceof Element)) {
    return null
  }

  const marked = target.closest<HTMLElement>('[data-ic-pane], aside[data-ic-window]')

  if (marked) {
    return marked.dataset.icPane ?? marked.dataset.icWindow ?? null
  }

  // The Message window's chat, iT, sidebar and head are not ours to mark; they are its only shells.
  return target.closest('[data-chat-surface], .itwin, .imsg-side, .imsg-head') ? 'message' : null
}

function usePaneArea(probeRef: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const probe = probeRef.current

    if (!probe) {
      return
    }

    const measure = () => $paneArea.set(Math.round(probe.getBoundingClientRect().width))
    // A surface without ResizeObserver (a test DOM) still follows the window size.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null

    measure()
    observer?.observe(probe)
    window.addEventListener('resize', measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [probeRef])
}

function usePaneFocusTracking(): void {
  useEffect(() => {
    const onPress = (event: Event) => {
      const id = paneOfTarget(event.target)

      if (id !== null) {
        focusRegisteredPane(id)
      }
    }

    document.addEventListener('pointerdown', onPress, true)
    document.addEventListener('focusin', onPress, true)

    return () => {
      document.removeEventListener('pointerdown', onPress, true)
      document.removeEventListener('focusin', onPress, true)
    }
  }, [])
}

function useReplaceToast(): void {
  useEffect(
    () =>
      onPaneReplaced(replaced => {
        notify({ kind: 'info', message: f6Panes.replaced(nameOf(replaced)) })
      }),
    []
  )
}

/** The frame's left edge on screen, read now (a window moved or zoomed mid-drag moves it). */
function frameLeft(fallback: number): number {
  const probe = document.querySelector('.ic-pane-probe')

  return probe ? probe.getBoundingClientRect().left : fallback
}

function PaneDivider({ area, left, names }: { area: number; left: number; names: readonly [string, string] }) {
  // The pointer that drags, and how far from the seam's centre it grabbed (so the first move never jumps the seam
  // under the pointer).
  const drag = useRef<null | { grab: number; pointerId: number }>(null)
  const fallbackLeft = useRef(0)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current !== null) {
      return
    }

    event.preventDefault()
    // The frame's left edge, if there is no probe: the divider's own left minus its offset into the frame.
    fallbackLeft.current = event.currentTarget.getBoundingClientRect().left - left

    const seam = frameLeft(fallbackLeft.current) + left + PANE_DIVIDER_PX / 2

    drag.current = { grab: event.clientX - seam, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const live = drag.current

    if (live === null || live.pointerId !== event.pointerId) {
      return
    }

    // The store follows every move; storage waits for the end of the drag.
    setPaneRatio(ratioAt(area, event.clientX - live.grab - frameLeft(fallbackLeft.current)), { persist: false })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) {
      drag.current = null
      persistPaneRatio()
    }
  }

  const inner = area - PANE_DIVIDER_PX

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const to = (width: number) => setPaneRatio(width / inner)

    switch (event.key) {
      case 'ArrowLeft':
        to(left - PANE_DIVIDER_STEP_PX)

        break

      case 'ArrowRight':
        to(left + PANE_DIVIDER_STEP_PX)

        break

      case 'Home':
        to(PANE_MIN_PX)

        break

      case 'End':
        to(inner - PANE_MIN_PX)

        break

      case 'Enter':
        resetPaneRatio()

        break

      default:
        return
    }

    event.preventDefault()
  }

  return (
    // v0.0.9 r4b (critic-r4 03-dark): the house tip on our roles (surface, hairline, ink), not the inverted
    // browser-style chip, so the hint reads as the app in both skins.
    <IcTip label={f6Panes.dividerHint} side="top">
      <div
        aria-description={f6Split.dividerKeys}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"
        aria-label={f6Panes.divider}
        aria-orientation="vertical"
        aria-valuemax={inner - PANE_MIN_PX}
        aria-valuemin={PANE_MIN_PX}
        aria-valuenow={left}
        aria-valuetext={f6Split.dividerValue(nameOf(names[0]), left, nameOf(names[1]), inner - left)}
        className="ic-pane-divider"
        onDoubleClick={resetPaneRatio}
        onKeyDown={onKeyDown}
        onLostPointerCapture={endDrag}
        onPointerCancel={endDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        role="separator"
        style={{ left: `calc(var(--ic-frame-left) + ${left}px)` }}
        tabIndex={0}
      />
    </IcTip>
  )
}

/** One string per arrangement shape, so an effect re-runs when a pane comes, goes or swaps — not on a divider drag. */
function layoutKey(arrangement: ReturnType<typeof $paneArrangement.get>): string {
  switch (arrangement.kind) {
    case 'split':
      return `${arrangement.left}|${arrangement.right}`

    case 'folded':
      return `${arrangement.shown}|${arrangement.tabbed}`

    case 'single':
      return `${arrangement.id}|${arrangement.place}`

    default:
      return ''
  }
}

/** The panes' one polite live region, always mounted (pane-announce.ts). */
function PaneAnnouncer() {
  const { seq, text } = useStore($paneAnnouncement)

  return (
    <div aria-atomic="true" aria-live="polite" className="sr-only" data-ic-pane-announcer="" role="status">
      {/* Keyed by the announcement: the same words twice are a new node, so they are said twice. */}
      <span key={seq}>{text}</span>
    </div>
  )
}

function PaneTabs({ order, shown }: { order: readonly string[]; shown: string }) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }

    event.preventDefault()
    const at = order.indexOf(shown)
    const next = (at + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length

    focusRegisteredPane(order[next])
    tabRefs.current[next]?.focus({ preventScroll: true })
  }

  return (
    <div aria-label={f6Panes.tabs} className="ic-pane-tabs" onKeyDown={onKeyDown} role="tablist">
      {order.map((id, index) => (
        <button
          aria-selected={id === shown}
          className="ic-pane-tab"
          data-ic-pane-tab={id}
          key={id}
          onClick={() => focusRegisteredPane(id)}
          ref={element => {
            tabRefs.current[index] = element
          }}
          role="tab"
          tabIndex={id === shown ? 0 : -1}
          type="button"
        >
          {nameOf(id)}
        </button>
      ))}
    </div>
  )
}

export function PaneLayer() {
  const probeRef = useRef<HTMLDivElement>(null)
  const arrangement = useStore($paneArrangement)
  const area = useStore($paneArea)
  const panes = useStore($panes)

  usePaneArea(probeRef)
  usePaneFocusTracking()
  useReplaceToast()

  // v0.0.9 design 4: side by side, both panes wear their control column at the same inset inside their own card
  // (ic-window.css reads this to bring the Message column in from the margin).
  useEffect(() => {
    const root = document.documentElement

    root.dataset.icPanes = arrangement.kind

    return () => {
      delete root.dataset.icPanes
    }
  }, [arrangement.kind])

  // A change of arrangement (a pane closed, a drop landed): for two frames the Message column snaps with its frame
  // instead of gliding behind it (ic-window.css `data-ic-panes-changing`).
  const firstArrangement = useRef(true)
  const shapeKey = layoutKey(arrangement)

  useLayoutEffect(() => {
    if (firstArrangement.current) {
      firstArrangement.current = false

      return
    }

    const root = document.documentElement
    let frame = 0

    root.dataset.icPanesChanging = ''
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => delete root.dataset.icPanesChanging)
    })

    return () => {
      cancelAnimationFrame(frame)
      delete root.dataset.icPanesChanging
    }
  }, [arrangement.kind, shapeKey])

  return (
    <>
      <div aria-hidden className="ic-pane-probe" ref={probeRef} />
      {arrangement.kind === 'split' && (
        <PaneDivider area={area} left={arrangement.widths.left} names={[arrangement.left, arrangement.right]} />
      )}
      <PaneAnnouncer />
      {arrangement.kind === 'folded' && panes.open.length === 2 && (
        <PaneTabs order={arrangement.order} shown={arrangement.shown} />
      )}
    </>
  )
}
