/**
 * v0.0.9 F6 — the window menu: one small icon in a pane's control column (it replaces the expand/retract button;
 * Fill is today's expand) that opens the Move / Fill & arrange menu of window-menu-model.ts.
 *
 * Behaviour (P0_DESIGN_SPECS.md F6 §3):
 * - hover opens after 120 ms and closes 200 ms after the pointer leaves both the icon and the menu (a hover-open menu
 *   never takes the focus);
 * - a click toggles it and pins it open; Enter / Space / ↓ open it on the first option, ↑ on the last;
 * - inside: ↑ ↓ move (wrapping), Home / End jump, Enter / Space choose, Esc closes back onto the icon, Tab closes;
 *   a press anywhere else closes it;
 * - a disabled option stays reachable (aria-disabled) so its Tip — "Needs a wider window" — can say why.
 */
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { Check } from '@/lib/icons'

import { GlyphWindowMenu, WindowMenuGlyph } from './window-glyphs'
import { flatItems, type WindowMenuGroup, type WindowMenuItem } from './window-menu-model'

export const MENU_HOVER_OPEN_MS = 120
export const MENU_HOVER_CLOSE_MS = 200

type OpenedBy = 'hover' | 'pin'

interface WindowMenuProps {
  /** The trigger's accessible name. */
  triggerLabel: string
  /** The menu's accessible name. */
  menuLabel: string
  groups: readonly WindowMenuGroup[]
  className?: string
}

export function WindowMenu({ className, groups, menuLabel, triggerLabel }: WindowMenuProps) {
  const [open, setOpen] = useState<null | OpenedBy>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingFocus = useRef<'first' | 'last' | null>(null)
  const menuId = useId()
  const items = useMemo(() => flatItems(groups), [groups])

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => clearTimer, [])

  const close = useCallback((refocus: boolean) => {
    clearTimer()
    setOpen(null)

    if (refocus) {
      triggerRef.current?.focus({ preventScroll: true })
    }
  }, [])

  const openWith = (by: OpenedBy, focus: 'first' | 'last' | null) => {
    clearTimer()
    pendingFocus.current = focus
    setOpen(current => (current === 'pin' ? 'pin' : by))
  }

  // A one-shot request, consumed once: reading it clears it (not a mirrored reactive value).
  const takePendingFocus = () => {
    const focus = pendingFocus.current

    pendingFocus.current = null

    return focus
  }

  // Keyboard opening lands on an option once the list exists.
  useEffect(() => {
    if (!open) {
      return
    }

    const focus = takePendingFocus()

    if (focus === null) {
      return
    }

    itemRefs.current[focus === 'first' ? 0 : items.length - 1]?.focus({ preventScroll: true })
  }, [items.length, open])

  // A press outside the icon and the menu closes it (without stealing the focus the press gives elsewhere).
  useEffect(() => {
    if (!open) {
      return
    }

    const doc = rootRef.current?.ownerDocument

    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) {
        close(false)
      }
    }

    doc?.addEventListener('pointerdown', onPointerDown, true)

    return () => doc?.removeEventListener('pointerdown', onPointerDown, true)
  }, [close, open])

  const onPointerEnter = () => {
    if (open === 'pin') {
      clearTimer()

      return
    }

    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = null
      setOpen(current => current ?? 'hover')
    }, MENU_HOVER_OPEN_MS)
  }

  const onPointerLeave = () => {
    clearTimer()

    if (open === 'pin') {
      return
    }

    timer.current = setTimeout(() => {
      timer.current = null
      setOpen(current => (current === 'hover' ? null : current))
    }, MENU_HOVER_CLOSE_MS)
  }

  // A keyboard choice gives the focus back to the icon (Tab users keep their place); a pointer choice leaves none
  // behind, so a filled window's tucked-away column is never pinned open by a mouse focus (ic-window.tsx).
  const choose = (item: WindowMenuItem, byKeyboard: boolean) => {
    if (item.disabled) {
      return
    }

    close(byKeyboard)
    item.onSelect()
  }

  const focusItem = (index: number) => {
    const count = items.length

    itemRefs.current[((index % count) + count) % count]?.focus({ preventScroll: true })
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault()
      openWith('pin', 'first')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openWith('pin', 'last')
    } else if (event.key === 'Escape' && open) {
      // Handled here so the home's Escape router (it skips a prevented event) does not also close the window.
      event.preventDefault()
      close(true)
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = itemRefs.current.findIndex(item => item === event.target)

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusItem(at + 1)

        break

      case 'ArrowUp':
        event.preventDefault()
        focusItem(at < 0 ? -1 : at - 1)

        break

      case 'Home':
        event.preventDefault()
        focusItem(0)

        break

      case 'End':
        event.preventDefault()
        focusItem(items.length - 1)

        break

      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close(true)

        break

      case 'Tab':
        close(false)

        break

      case 'Enter':

      case ' ':
        event.preventDefault()

        if (at >= 0) {
          choose(items[at], true)
        }

        break

      default:
        break
    }
  }

  let index = -1

  return (
    <div
      className={`ic-wmenu${className ? ` ${className}` : ''}`}
      data-open={open ? 'true' : undefined}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      ref={rootRef}
    >
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open ? 'true' : 'false'}
        aria-haspopup="menu"
        aria-label={triggerLabel}
        className="iwin-btn ic-wmenu__trigger"
        onClick={event => {
          // A keyboard click (detail 0) already opened from keydown; a pointer click pins or unpins.
          if (event.detail === 0) {
            return
          }

          if (open === 'pin') {
            close(false)
          } else {
            openWith('pin', null)
          }
        }}
        onKeyDown={onTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <GlyphWindowMenu />
      </button>

      {open && (
        <div aria-label={menuLabel} className="ic-wmenu__panel" id={menuId} onKeyDown={onMenuKeyDown} role="menu">
          {groups.map((group, groupIndex) => (
            <div aria-label={group.title} className="ic-wmenu__group" key={group.id} role="group">
              {groupIndex > 0 && !group.title && <div className="ic-wmenu__sep" role="separator" />}
              {group.title && (
                <div aria-hidden className="ic-wmenu__title">
                  {group.title}
                </div>
              )}
              {group.items.map(item => {
                index += 1
                const at = index

                const button = (
                  <button
                    // r4d (design r4 F6-1): the current state is a check and aria-current, never a filled row (only
                    // hover and keyboard focus paint the fill, so at most one row is lit).
                    aria-current={item.active ? 'true' : undefined}
                    aria-disabled={item.disabled ? 'true' : undefined}
                    className="ic-wmenu__item"
                    data-active={item.active ? 'true' : undefined}
                    data-item={item.id}
                    key={item.id}
                    onClick={event => choose(item, event.detail === 0)}
                    ref={element => {
                      itemRefs.current[at] = element
                    }}
                    role="menuitem"
                    tabIndex={-1}
                    type="button"
                  >
                    <span className="ic-wmenu__glyph">
                      <WindowMenuGlyph id={item.id} />
                    </span>
                    <span className="ic-wmenu__label">{item.label}</span>
                    {item.active ? (
                      <span aria-hidden="true" className="ic-wmenu__check" data-testid="wmenu-check">
                        <Check size={13} strokeWidth={2} />
                      </span>
                    ) : null}
                  </button>
                )

                return item.disabled && item.reason ? (
                  <Tip key={item.id} label={item.reason} side="left">
                    {button}
                  </Tip>
                ) : (
                  button
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
