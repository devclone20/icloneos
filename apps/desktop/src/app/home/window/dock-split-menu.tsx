/**
 * v0.0.9 F6 · owner addition — the keyboard (and screen-reader, and switch) way to split: a small menu on a Dock tile
 * that opens its pane on the left or on the right of the one already open, with the same rules as dragging it there
 * (dock-split.ts `planSide` → `applyDrop`). Opened by Shift+Enter, Shift+F10 or the context-menu key on a focused
 * tile, or a right-click. The window menu keeps exactly the owner's four options; this lives on the Dock.
 *
 * Keyboard: ↑/↓ (wrapping), Home/End, Enter/Space choose, Esc closes back to the tile (never reaching the home's Esc),
 * Tab closes. An option that would do nothing (the pane is already open there) stays reachable, disabled.
 */
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import { f6PaneNames, f6Split } from '@/i18n/en/v009-f6'

import { type DropPlan, planSide } from './dock-split'
import type { IcWindowId } from './ic-window'
import { placeMenu } from './menu-placement'
import { $paneArea, $panes, type PaneSide } from './pane-layout'

const nameOf = (id: string): string => f6PaneNames[id as IcWindowId] ?? id

export interface DockSplitChoice {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly plan: DropPlan
}

/** The menu's options for this pane right now: one per side, or one when both sides would do the same. */
export function splitChoices(pane: string): DockSplitChoice[] {
  const state = $panes.get()
  const area = $paneArea.get()
  const plans = (['left', 'right'] as PaneSide[]).map(side => ({ side, plan: planSide(state, area, pane, side) }))
  const [left, right] = plans

  const detailOf = (plan: DropPlan): string =>
    plan.kind === 'outside'
      ? f6Split.alreadyOpen(nameOf(pane))
      : plan.kind !== 'move' && plan.replaced !== null
        ? f6Split.replacing(nameOf(plan.replaced))
        : ''

  // Too narrow for halves (tabs): the side does not matter.
  if (left.plan.kind === 'tab' && right.plan.kind === 'tab') {
    return [{ id: 'one', label: f6Split.asTabItem, detail: detailOf(left.plan), plan: left.plan }]
  }

  return plans.map(({ plan, side }) => ({
    id: side,
    label: side === 'left' ? f6Split.openLeft : f6Split.openRight,
    detail: detailOf(plan),
    plan
  }))
}

interface DockSplitMenuProps {
  pane: string
  /** Runs the chosen plan (the Dock: `applyDrop` + the tile's `onDrop`). */
  onChoose: (plan: DropPlan) => void
  /** Closes the menu; `refocus` puts the keyboard back on the tile. */
  onClose: (refocus: boolean) => void
}

export function DockSplitMenu({ onChoose, onClose, pane }: DockSplitMenuProps) {
  const choices = useMemo(() => splitChoices(pane), [pane])
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    itemRefs.current[0]?.focus({ preventScroll: true })
  }, [])

  // Its own placement (design N1): inward from the Dock, flipped and clamped so it is never off-screen. Measured before
  // paint; re-placed when the window resizes while it is open.
  useLayoutEffect(() => {
    const panel = panelRef.current
    const anchor = panel?.parentElement

    if (!panel || !anchor) {
      return
    }

    const place = () => {
      const base = (panel.offsetParent ?? anchor).getBoundingClientRect()
      const at = placeMenu({
        anchor: anchor.getBoundingClientRect(),
        dir: document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr',
        menu: { height: panel.offsetHeight, width: panel.offsetWidth },
        viewport: { height: window.innerHeight, width: window.innerWidth }
      })

      panel.style.right = 'auto'
      panel.style.left = `${at.left - base.left}px`
      panel.style.top = `${at.top - base.top}px`
      panel.dataset.side = at.side
    }

    place()
    window.addEventListener('resize', place)

    return () => window.removeEventListener('resize', place)
  }, [choices])

  // A press anywhere else closes it, leaving the focus where that press puts it.
  useEffect(() => {
    const onPress = (event: Event) => {
      if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target)) {
        onClose(false)
      }
    }

    document.addEventListener('pointerdown', onPress, true)

    return () => document.removeEventListener('pointerdown', onPress, true)
  }, [onClose])

  const choose = (choice: DockSplitChoice) => {
    if (choice.plan.kind === 'outside') {
      return
    }

    onClose(false)
    onChoose(choice.plan)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = itemRefs.current.findIndex(item => item === event.target)

    const move = (to: number) =>
      itemRefs.current[(to + choices.length) % choices.length]?.focus({ preventScroll: true })

    switch (event.key) {
      case 'ArrowDown':
        move(at + 1)

        break

      case 'ArrowUp':
        move(at - 1)

        break

      case 'Home':
        move(0)

        break

      case 'End':
        move(choices.length - 1)

        break

      case 'Escape':
        // The menu's Esc: the home's Escape router (which would close a window) never sees it.
        event.nativeEvent.stopImmediatePropagation()
        onClose(true)

        break

      case 'Tab':
        onClose(false)

        return

      default:
        return
    }

    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div
      aria-label={f6Split.menuLabel(nameOf(pane))}
      className="ic-wmenu__panel dock-split-menu"
      onKeyDown={onKeyDown}
      ref={panelRef}
      role="menu"
    >
      {choices.map((choice, index) => {
        const disabled = choice.plan.kind === 'outside'

        return (
          <button
            aria-disabled={disabled ? true : undefined}
            className="ic-wmenu__item"
            data-split-choice={choice.id}
            key={choice.id}
            onClick={() => choose(choice)}
            ref={element => {
              itemRefs.current[index] = element
            }}
            role="menuitem"
            tabIndex={index === 0 ? 0 : -1}
            type="button"
          >
            <span className="ic-wmenu__label">{choice.label}</span>
            {choice.detail ? <span className="dock-split-menu__detail">{choice.detail}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
