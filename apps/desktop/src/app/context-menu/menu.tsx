/**
 * OUR right-click menu (plan E3, owner decision #9): the app-wide context menu
 * on the same card as the command sheet — night glass, a gilt hairline, our
 * rows — with no component library underneath. It replaces the inherited
 * dropdown-menu primitives the menu used to render through.
 *
 * Two constraints shape it, and both are why this is not a re-skin:
 * - **It is modal, the way a macOS menu is.** The card takes focus on open —
 *   that is what lets assistive tech announce the surface and the active row
 *   (`aria-activedescendant`) — and the capture-phase key listener swallows
 *   every key while it is up, so nothing a row does not handle is typed into
 *   the composer behind it. On close, focus goes back to the element that had
 *   it when the menu opened, which is what the edit verbs (cut/copy/paste/
 *   select all) act on: Chromium runs them against the FOCUSED element, and
 *   the caller dispatches them one frame AFTER the menu closed and re-focused
 *   that element (`withEditableFocus` in `app-context-menu.tsx`). Nothing
 *   INSIDE the card is focusable, so the surface cannot hide a focus stop
 *   (gate G5, tester ticket U5-T3): rows are `role="menuitem"` divs addressed
 *   by id, never controls.
 * - **Rows are DATA.** `Item` declares a row and never renders itself; this
 *   module paints every one, so the active row, the disabled state and the
 *   hotkey caps are decided in one place instead of 37 call sites.
 */

import '@/app/command-palette/sheet.css'

import { Children, isValidElement, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { PaletteKeys } from '@/app/command-palette/keycaps'
import type { IconComponent } from '@/lib/icons'

/** A row's whole declaration. Not exported: `Item` is the only way to make
 *  one, so the shape cannot drift away from the surface that paints it. */
interface MenuItemProps {
  disabled?: boolean
  icon?: IconComponent
  label: string
  onSelect: () => void
  /** Canonical combo (`mod+v`), rendered as our key caps — never a string. */
  shortcut?: string
}

/**
 * A row DECLARATION. It returns nothing on purpose: `ContextMenuSurface` reads
 * these props and paints the row, which is what keeps one keyboard owner and
 * one visual language for every section builder in this front.
 */
export function Item(_props: MenuItemProps): null {
  return null
}

/** Distance kept from the viewport edge when the menu has to flip or clamp. */
const EDGE = 8

/** Row id for `aria-activedescendant`. Exactly one menu exists at a time (one
 *  store, one mount in `AppContextMenu`), so a fixed prefix cannot collide. */
const rowDomId = (index: number) => `icm-row-${index}`

const rowsOf = (sections: ReactNode[][]): MenuItemProps[][] =>
  sections.map(section =>
    Children.toArray(section)
      .filter((child): child is React.ReactElement<MenuItemProps> => isValidElement(child))
      .map(child => child.props)
  )

export function ContextMenuSurface({
  container,
  label,
  onClose,
  sections,
  x,
  y
}: {
  /** Portal host — a dialog's own container when the click came from inside one. */
  container?: HTMLElement | null
  /**
   * Accessible name of the menu. Optional: a `role="menu"` takes its meaning
   * from its items, and this app has no locale key for the surface yet — now
   * that the card holds focus, a name is what a screen reader reads BEFORE the
   * active row (LEAD: `contextMenu.title`, front FB, then pass it from here).
   */
  label?: string
  onClose: () => void
  sections: ReactNode[][]
  x: number
  y: number
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  /** Where focus was when the menu opened: the edit verbs act on that element. */
  const openerRef = useRef<Element | null>(null)
  const groups = rowsOf(sections).filter(group => group.length > 0)
  const flat = groups.flat()
  const [activeIndex, setActiveIndex] = useState(-1)
  const [spot, setSpot] = useState({ left: x, top: y })

  // Flip/clamp before the first paint: a menu opened near the right or bottom
  // edge must not hang outside the window (the one thing the primitive did for
  // us that a plain `position: fixed` does not).
  useLayoutEffect(() => {
    const card = cardRef.current

    if (!card) {
      return
    }

    const { height, width } = card.getBoundingClientRect()
    const maxLeft = window.innerWidth - width - EDGE
    const maxTop = window.innerHeight - height - EDGE

    setSpot({
      left: Math.max(EDGE, x > maxLeft ? Math.min(x - width, maxLeft) : x),
      top: Math.max(EDGE, y > maxTop ? Math.min(y - height, maxTop) : y)
    })
  }, [x, y])

  // Focus the card on open and hand focus back when the menu goes away.
  // A `role="menu"` nobody focuses is a surface assistive tech cannot
  // announce, and keys the listener below swallows would otherwise have no
  // owner at all. A LAYOUT effect on purpose: its cleanup runs while the card
  // is still in the DOM, so `contains` can tell whether we still own focus —
  // if a row handed focus to something else (a dialog it opened), the restore
  // is skipped instead of stealing it back.
  useLayoutEffect(() => {
    // Held in a local: the cleanup must ask the SAME node whether it still has
    // focus, and by then the ref may already have been cleared.
    const card = cardRef.current

    openerRef.current = document.activeElement
    card?.focus({ preventScroll: true })

    return () => {
      const opener = openerRef.current
      const ours = !!card && (card === document.activeElement || card.contains(document.activeElement))

      if (ours && opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [])

  const run = (row: MenuItemProps) => {
    if (row.disabled) {
      return
    }

    onClose()
    row.onSelect()
  }

  // The keyboard. A capture-phase window listener mounted with the menu and
  // removed with it: arrows skip disabled rows, Enter runs the active one, Esc
  // and Tab close. EVERY key is stopped, handled or not — a menu is modal, so
  // a keystroke it does not act on must not reach the composer underneath
  // (app-menu accelerators live in main and are not cancelable from the
  // renderer, so ⌘Q still quits with the menu up).
  useEffect(() => {
    const step = (delta: number) => {
      setActiveIndex(current => {
        // Nothing active yet: ↓ lands on the first row, ↑ on the last.
        const from = current < 0 ? (delta > 0 ? -1 : 0) : current

        for (let hop = 1; hop <= flat.length; hop += 1) {
          const next = (from + delta * hop + flat.length * hop) % flat.length

          if (!flat[next]?.disabled) {
            return next
          }
        }

        return current
      })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // Stopped first, handled second: the surface behind the menu must not
      // act on a key just because this menu has no verb for it.
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        step(event.key === 'ArrowDown' ? 1 : -1)

        return
      }

      if (event.key === 'Home' || event.key === 'End') {
        setActiveIndex(event.key === 'Home' ? 0 : flat.length - 1)

        return
      }

      if (event.key === 'Enter' || event.key === ' ') {
        const row = flat[activeIndex]

        if (row) {
          run(row)
        }

        return
      }

      if (event.key === 'Escape' || event.key === 'Tab') {
        onClose()
      }

      // Everything else, a printable character (`event.key.length === 1`)
      // included, is swallowed by the two calls above: with the menu up it
      // would be typed into the field the user opened it on, where they cannot
      // see it land.
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  let flatIndex = -1

  return createPortal(
    <div className="icp-root" data-kind="menu" data-state="open">
      {/* A real element so a click or a second right-click outside closes,
          with no dim: the work behind the menu stays readable (AD2). */}
      <div className="icp-scrim" onContextMenu={onClose} onMouseDown={onClose} />
      <div
        aria-activedescendant={activeIndex < 0 ? undefined : rowDomId(activeIndex)}
        aria-label={label}
        className="icp"
        ref={cardRef}
        role="menu"
        style={{ left: spot.left, top: spot.top }}
        /* -1: the menu is focused programmatically on open and is never a Tab
           stop, so it cannot add a focus stop to the surface behind it (G5). */
        tabIndex={-1}
      >
        {groups.map((group, groupIndex) => (
          // Sections are positional by construction, so the index IS the key.
          <div className="icp-group" key={groupIndex} role="group">
            {groupIndex > 0 && <div className="icp-sep" role="separator" />}
            {group.map(row => {
              flatIndex += 1

              return (
                <MenuRow
                  index={flatIndex}
                  isActive={flatIndex === activeIndex}
                  key={flatIndex}
                  onHover={setActiveIndex}
                  onRun={run}
                  row={row}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>,
    container ?? document.body
  )
}

function MenuRow({
  index,
  isActive,
  onHover,
  onRun,
  row
}: {
  index: number
  isActive: boolean
  onHover: (index: number) => void
  onRun: (row: MenuItemProps) => void
  row: MenuItemProps
}) {
  const Icon = row.icon

  return (
    <div
      aria-disabled={row.disabled ? 'true' : undefined}
      className="icp-row"
      data-active={isActive ? '' : undefined}
      id={rowDomId(index)}
      onClick={() => onRun(row)}
      // A click must not move focus off the card: the card is the menu's only
      // focus owner, so `aria-activedescendant` stays the single truth and the
      // restore on close knows it still has focus to hand back.
      onMouseDown={event => event.preventDefault()}
      onMouseMove={() => onHover(index)}
      role="menuitem"
    >
      {Icon && <Icon className="icp-row__icon" />}
      <span className="icp-row__body">
        <span className="icp-row__label">{row.label}</span>
      </span>
      {row.shortcut && <PaletteKeys combo={row.shortcut} dim />}
    </div>
  )
}
