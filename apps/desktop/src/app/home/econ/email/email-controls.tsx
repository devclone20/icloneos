/**
 * Email — the controls that act on mail: the checkbox, the bar that replaces
 * the toolbar while messages are selected, the two-step button for what
 * cannot be undone, and the flash that offers Undo for what can.
 *
 * Every shortcut is named in its control's tooltip — that is the help.
 */
import { Archive, ArchiveRestore, Check, Mail, MailOpen, Minus, Trash2, Undo2 } from 'lucide-react'
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'

import { number } from '../format'
import { ButtonTip } from '../ui'

import type { MailFolder, MailMove } from './email-state'

const ICON = { size: 13, strokeWidth: 1.8 } as const
// Long enough to read what the second press does, short enough that an armed
// button is not left lying around.
const CONFIRM_MS = 4000

// ── checkbox ────────────────────────────────────────────────────────────────

export function CheckBox({
  checked,
  className,
  disabled,
  label,
  onToggle,
  tabbable = true,
  title
}: {
  checked: 'mixed' | boolean
  className?: string
  disabled?: boolean
  label: string
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void
  /** Row boxes stay out of the Tab order — `x` is their keyboard. */
  tabbable?: boolean
  title?: string
}) {
  return (
    <ButtonTip disabled={disabled} label={title ?? label} tabbable={tabbable}>
      <button
        aria-checked={checked}
        aria-label={label}
        className={className ? `em-check ${className}` : 'em-check'}
        disabled={disabled}
        onClick={onToggle}
        role="checkbox"
        tabIndex={tabbable ? undefined : -1}
        type="button"
      >
        {checked === 'mixed' ? <Minus size={11} strokeWidth={2.6} /> : <Check size={11} strokeWidth={2.6} />}
      </button>
    </ButtonTip>
  )
}

// ── two-step ────────────────────────────────────────────────────────────────

/**
 * A button for what cannot be undone: the first press arms it and says what
 * the second will do; the second does it. It disarms by itself after a few
 * seconds, when focus leaves, and on Esc — which it keeps, so one Esc never
 * also clears the selection or closes the pane underneath.
 */
export function ConfirmButton({
  armedText,
  compact,
  label,
  onConfirm
}: {
  /** Said while armed — what the second press does ("Delete 3 forever?"). */
  armedText: string
  compact?: boolean
  label: string
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) {
      return
    }

    const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS)

    return () => window.clearTimeout(timer)
  }, [armed])

  const press = () => {
    if (!armed) {
      setArmed(true)

      return
    }

    setArmed(false)
    onConfirm()
  }

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && armed) {
      event.preventDefault()
      setArmed(false)
    }
  }

  const className = [
    'e-btn',
    'e-btn--quiet',
    'em-confirm',
    compact ? 'em-confirm--compact' : '',
    armed ? 'em-confirm--armed' : ''
  ]
    .join(' ')
    .trim()

  return (
    <Tip label={armed ? 'Press again to confirm · Esc cancels' : 'Asks once more before it happens'}>
      <button
        aria-label={armed ? armedText : label}
        className={className}
        onBlur={() => setArmed(false)}
        onClick={press}
        onKeyDown={keyDown}
        type="button"
      >
        {/* Both labels share one cell, so arming never changes the width. */}
        <span className="em-confirm__stack">
          <span aria-hidden={armed} className={armed ? 'em-confirm__off' : undefined}>
            {label}
          </span>
          <span aria-hidden={!armed} className={armed ? undefined : 'em-confirm__off'}>
            {armedText}
          </span>
        </span>
      </button>
    </Tip>
  )
}

// ── the selection bar ───────────────────────────────────────────────────────

function BarAction({
  children,
  disabled,
  label,
  onClick,
  shortcut
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
  shortcut?: string
}) {
  return (
    <ButtonTip disabled={disabled} label={shortcut ? `${label} · ${shortcut}` : label}>
      <button
        aria-label={label}
        className="e-btn e-btn--quiet em-bar__action"
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {children}
        <span className="em-bar__label">{label}</span>
      </button>
    </ButtonTip>
  )
}

export interface SelectionActions {
  onMark: (read: boolean) => void
  onMove: (move: MailMove) => void
}

/** What the toolbar becomes while messages are selected. Trash offers
 *  Restore and Delete forever; Archive offers Move to inbox. */
export function SelectionBar({
  actions,
  canMarkRead,
  canMarkUnread,
  count,
  folder
}: {
  actions: SelectionActions
  canMarkRead: boolean
  canMarkUnread: boolean
  count: number
  /** null while showing search results. */
  folder: MailFolder | null
}) {
  const { onMark, onMove } = actions

  return (
    <div aria-label="Selected messages" className="em-bar" role="toolbar">
      <span aria-live="polite" className="em-bar__count">
        {number(count)} selected
      </span>
      <BarAction disabled={!canMarkRead} label="Mark read" onClick={() => onMark(true)} shortcut="⇧I">
        <MailOpen {...ICON} />
      </BarAction>
      <BarAction disabled={!canMarkUnread} label="Mark unread" onClick={() => onMark(false)} shortcut="⇧U">
        <Mail {...ICON} />
      </BarAction>
      {folder === 'trash' ? (
        <>
          <BarAction label="Restore" onClick={() => onMove('restore')}>
            <Undo2 {...ICON} />
          </BarAction>
          <ConfirmButton
            armedText={`Delete ${number(count)} forever?`}
            label="Delete forever"
            onConfirm={() => onMove('purge')}
          />
        </>
      ) : (
        <>
          {folder === 'archive' ? (
            <BarAction label="Move to inbox" onClick={() => onMove('inbox')} shortcut="E">
              <ArchiveRestore {...ICON} />
            </BarAction>
          ) : (
            <BarAction label="Archive" onClick={() => onMove('archive')} shortcut="E">
              <Archive {...ICON} />
            </BarAction>
          )}
          <BarAction label="Trash" onClick={() => onMove('trash')} shortcut="#">
            <Trash2 {...ICON} />
          </BarAction>
        </>
      )}
    </div>
  )
}

// ── the flash ───────────────────────────────────────────────────────────────

export interface Flash {
  /** Tells two flashes with the same words apart, so each gets its full time. */
  id: number
  text: string
  undo: (() => void) | null
}

/** A line over the list's foot — never above the rows, so nothing moves. The
 *  live region stays mounted, so every flash is announced. */
export function MailFlash({ flash }: { flash: Flash | null }) {
  return (
    <div aria-live="polite" className="em-flash-region" role="status">
      {flash ? (
        <div className={flash.undo ? 'em-flash em-flash--undo' : 'em-flash'} key={flash.id}>
          <span className="em-flash__text">{flash.text}</span>
          {flash.undo ? (
            <Tip label="Undo · Z">
              <button className="em-flash__undo" onClick={flash.undo} type="button">
                Undo
              </button>
            </Tip>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
