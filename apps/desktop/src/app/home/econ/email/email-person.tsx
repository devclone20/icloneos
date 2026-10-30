/**
 * Email — a person in a thread (a participant chip, a sender's address) opens
 * a small menu: write to them, or copy the address. It lives inside the pane,
 * so it thins with the window and never outlives the thread it belongs to.
 */
import { Check, Copy, SquarePen } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'

import type { MailAddress } from './email-data'

const COPIED_MS = 900
// Keep the menu this far inside the pane's right edge before flipping it.
const EDGE_PX = 8

function PersonMenu({
  onClose,
  onComposeTo,
  person
}: {
  onClose: (refocus: boolean) => void
  onComposeTo: ((address: string) => void) | null
  person: MailAddress
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [alignEnd, setAlignEnd] = useState(false)
  const [copied, setCopied] = useState(false)

  // One measurement per open: flip to the trigger's right edge when the menu
  // would run past the pane, then hand focus to the first item.
  useLayoutEffect(() => {
    const menu = menuRef.current

    if (!menu) {
      return
    }

    const bound = menu.closest('.em-pane')?.getBoundingClientRect()

    if (bound && menu.getBoundingClientRect().right > bound.right - EDGE_PX) {
      setAlignEnd(true)
    }

    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    menu.scrollIntoView({ block: 'nearest' })
  }, [])

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = window.setTimeout(() => onClose(true), COPIED_MS)

    return () => window.clearTimeout(timer)
  }, [copied, onClose])

  const copy = () => {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(person.address))
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The mail client's own keys (j/k, u, Esc…) must not act behind the menu.
    event.stopPropagation()

    if (event.key === 'Escape') {
      event.preventDefault()
      onClose(true)

      return
    }

    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const targets: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, End: -1, Home: 0 }
    const target = targets[event.key]

    if (target !== undefined && items.length > 0) {
      event.preventDefault()
      items[(target + items.length) % items.length].focus()
    }
  }

  return (
    <div
      aria-label={`Actions for ${person.address}`}
      className={alignEnd ? 'em-menu em-menu--end' : 'em-menu'}
      onKeyDown={onKeyDown}
      ref={menuRef}
      role="menu"
    >
      <div className="em-menu__head" role="presentation">
        {person.name ? <span className="em-menu__name">{person.name}</span> : null}
        <span className="em-menu__addr">{person.address}</span>
      </div>
      {onComposeTo ? (
        <button
          className="em-menu__item"
          onClick={() => {
            onComposeTo(person.address)
            onClose(false)
          }}
          role="menuitem"
          type="button"
        >
          <SquarePen size={13} strokeWidth={1.8} />
          Write a message
        </button>
      ) : null}
      <button className="em-menu__item" onClick={copy} role="menuitem" type="button">
        {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={1.8} />}
        {copied ? 'Copied' : 'Copy address'}
      </button>
    </div>
  )
}

/** A person as a menu button. `own` (the agent's own address) offers copy only. */
export function PersonButton({
  children,
  className,
  onComposeTo,
  own,
  person
}: {
  children: ReactNode
  className: string
  onComposeTo: (address: string) => void
  own: boolean
  person: MailAddress
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback((refocus: boolean) => {
    setOpen(false)

    if (refocus) {
      triggerRef.current?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', onPointerDown, true)

    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  return (
    <span
      className="em-person"
      onBlur={event => {
        if (open && !wrapRef.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false)
        }
      }}
      ref={wrapRef}
    >
      <Tip label={person.address}>
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          className={`em-person__trigger ${className}`}
          onClick={() => setOpen(current => !current)}
          ref={triggerRef}
          type="button"
        >
          {children}
        </button>
      </Tip>
      {open ? <PersonMenu onClose={close} onComposeTo={own ? null : onComposeTo} person={person} /> : null}
    </span>
  )
}
