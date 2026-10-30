/**
 * OUR command sheet (plan E3, owner decision #9): the ⌘K surface rebuilt on
 * our window language — night glass, a gilt hairline, editorial caps — with no
 * upstream chrome and no component library underneath. It replaces the cmdk +
 * Radix Dialog pair the app inherited.
 *
 * Why our own and not a re-skin:
 * - ONE focusable element. Rows are `role="option"` divs addressed by
 *   `aria-activedescendant`, so the sheet can never add a control that is
 *   invisible yet tabbable (gate G5, tester ticket U5-T3). cmdk's rows are
 *   buttons, which is exactly how that defect class gets in.
 * - the ranking is ours (`rank.ts`), so the first row IS the best match; cmdk
 *   re-sorted groups by an internal id and silently no-op'd.
 * - Esc / Backspace step OUT of a sub-page instead of closing the sheet, and
 *   the exit animation is owned by the CSS: the card reports its own
 *   `animationend` and nothing here holds a duration.
 */

import './sheet.css'

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Check, ChevronLeft, ChevronRight, type IconComponent } from '@/lib/icons'
import { bindingsFor } from '@/store/keybinds'

import { PaletteHighlight } from './highlight'
import { PaletteKeys } from './keycaps'
import { flattenGroups, optionDomId } from './rank'
import type { PaletteGroup, PaletteItem } from './types'

export interface SelectMods {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

const EMPTY_GROUPS: PaletteGroup[] = []

const modsOf = (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SelectMods => ({
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey
})

/**
 * Focus cycles only between the sheet's own controls while it is up — and only
 * the ones that can really take focus. A disabled control stays in the DOM (a
 * Marketplace row greys out while a sibling installs), so counting it made Tab
 * a no-op on the stop that matters (gate G5, tester ticket U5-T3).
 */
const FOCUSABLE = '[data-icp-focus]:not(:disabled):not([aria-disabled="true"])'

export interface PaletteSheetProps {
  /** Live keybinds, so a row's hint is the combo that actually runs it. */
  bindings: Record<string, string[]>
  groups: PaletteGroup[]
  inputRef?: React.RefObject<HTMLInputElement | null>
  /** `true` while ⌘/⌃ is held: rows with a modifier variant preview it. */
  modHeld: boolean
  /** Shown when nothing matched (never while the deferred rows catch up). */
  noResultsLabel: string
  /** A line above the rows (a sub-page's error) — rows still render. */
  notice?: React.ReactNode
  onBack?: () => void
  onClose: () => void
  /** The close animation finished: the caller may retire the subtree. */
  onExited: () => void
  /** The highlighted row changed (arrows or hover); `null` = nothing active. */
  onHighlight?: (item: PaletteItem | null) => void
  onSearchChange: (value: string) => void
  onSelect: (item: PaletteItem, mods: SelectMods) => void
  /** `false` plays the exit animation. */
  open: boolean
  placeholder: string
  /** The sub-page we are inside, if any — its title heads the Back row. */
  pageTitle?: null | string
  /** Trailing control inside the search row (a sub-page's own toggle). */
  right?: React.ReactNode
  search: string
  /** Rendered INSTEAD of the rows (a sub-page's loading / empty / error). */
  status?: React.ReactNode
  /** Accessible name of the sheet. */
  title: string
}

export function PaletteSheet({
  bindings,
  groups,
  inputRef,
  modHeld,
  noResultsLabel,
  notice,
  onBack,
  onClose,
  onExited,
  onHighlight,
  onSearchChange,
  onSelect,
  open,
  pageTitle,
  placeholder,
  right,
  search,
  status,
  title
}: PaletteSheetProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const ownInputRef = useRef<HTMLInputElement>(null)
  const input = inputRef ?? ownInputRef

  // The rows arrive in an interruptible follow-up render, so opening ⌘K paints
  // the frame + input immediately however many hundred rows follow.
  const deferred = useDeferredValue(groups, EMPTY_GROUPS)
  const catchingUp = deferred !== groups
  const items = useMemo(() => flattenGroups(deferred), [deferred])

  const [activeIndex, setActiveIndex] = useState(0)

  // A new list is a new ranking: the best match takes the highlight.
  useEffect(() => {
    setActiveIndex(0)
  }, [items])

  // `status` is rendered INSTEAD of the rows, so while it shows there is
  // nothing on screen to point at: no active row, no `aria-activedescendant`
  // and Enter runs nothing. A command the user cannot see must not be
  // activatable (gate G5, tester ticket U5-T3).
  const statusReplacesRows = status !== null && status !== undefined
  const active = statusReplacesRows ? null : (items[activeIndex] ?? null)

  useEffect(() => {
    onHighlight?.(active)
  }, [active, onHighlight])

  // Keep the highlight on screen without stealing focus from the input.
  useEffect(() => {
    const row = listRef.current?.querySelector('[data-active]')

    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, items])

  // The exit is reported by the card's own `animationend`, so the CSS owns the
  // close duration and nothing here holds a timer. A native listener, not an
  // onAnimationEnd prop: React does not deliver animation events through a
  // portal mounted outside its root container.
  useEffect(() => {
    const card = cardRef.current

    if (!card || open) {
      return
    }

    const done = (event: AnimationEvent) => {
      // Descendants animate too; only the card's own exit retires the sheet.
      if (event.target === card) {
        onExited()
      }
    }

    card.addEventListener('animationend', done)

    return () => card.removeEventListener('animationend', done)
  }, [onExited, open])

  const step = useCallback(
    (delta: number) => {
      setActiveIndex(current => {
        if (items.length === 0) {
          return 0
        }

        return (current + delta + items.length) % items.length
      })
    },
    [items.length]
  )

  const stepOut = useCallback(() => {
    if (onBack) {
      onBack()

      return true
    }

    return false
  }, [onBack])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(1)

      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(-1)

      return
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : Math.max(items.length - 1, 0))

      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()

      if (active) {
        onSelect(active, modsOf(event))
      }

      return
    }

    // Esc and empty-input Backspace step up one level inside a sub-page; at the
    // root, Esc closes. Stopped either way so no surface behind us also reacts.
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()

      if (!stepOut()) {
        onClose()
      }

      return
    }

    if (event.key === 'Backspace' && search === '' && onBack) {
      event.preventDefault()
      event.stopPropagation()
      stepOut()

      return
    }

    // Focus never leaves the sheet: Tab cycles its own controls.
    if (event.key === 'Tab') {
      event.preventDefault()

      const stops = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])

      if (stops.length === 0) {
        return
      }

      const here = stops.indexOf(document.activeElement as HTMLElement)
      const next = (here + (event.shiftKey ? -1 : 1) + stops.length) % stops.length

      stops[next]?.focus()
    }
  }

  const activeId = statusReplacesRows || !active ? undefined : optionDomId(activeIndex)
  let flatIndex = -1

  return createPortal(
    <div className="icp-root" data-state={open ? 'open' : 'closed'}>
      {/* No dim, no blur: the sheet separates with its own edge + float, and
          the work behind it stays readable (owner, AD2). The scrim is still a
          real element so a click outside closes. */}
      <div className="icp-scrim" onMouseDown={onClose} />
      <div
        aria-label={title}
        aria-modal="true"
        className="icp"
        data-state={open ? 'open' : 'closed'}
        onKeyDown={handleKeyDown}
        ref={cardRef}
        role="dialog"
      >
        {pageTitle && onBack && (
          <button className="icp-back" data-icp-focus onClick={onBack} type="button">
            <ChevronLeft aria-hidden="true" className="icp-back__chevron" focusable="false" />
            <span className="icp-back__crumb">{pageTitle}</span>
          </button>
        )}
        <div className="icp-search">
          <input
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-controls="icp-list"
            aria-expanded="true"
            aria-label={placeholder}
            autoComplete="off"
            autoCorrect="off"
            autoFocus
            className="icp-input"
            data-icp-focus
            onChange={event => onSearchChange(event.target.value)}
            placeholder={placeholder}
            ref={input}
            role="combobox"
            spellCheck={false}
            type="text"
            value={search}
          />
          {right}
        </div>
        <div className="icp-list" id="icp-list" ref={listRef} role="listbox" tabIndex={-1}>
          {notice}
          {status ??
            (items.length === 0 && !catchingUp ? (
              <div className="icp-status">{noResultsLabel}</div>
            ) : (
              deferred.map((group, groupIndex) => (
                <div className="icp-group" key={group.heading ?? `icp-group-${groupIndex}`} role="group">
                  {group.heading && <div className="icp-heading">{group.heading}</div>}
                  {group.items.map(item => {
                    flatIndex += 1

                    return (
                      <PaletteOption
                        bindings={bindings}
                        index={flatIndex}
                        isActive={flatIndex === activeIndex}
                        item={item}
                        key={item.id}
                        modHeld={modHeld}
                        onActivate={onSelect}
                        onHover={setActiveIndex}
                        search={search}
                      />
                    )
                  })}
                </div>
              ))
            ))}
        </div>
      </div>
    </div>,
    document.body
  )
}

function PaletteOption({
  bindings,
  index,
  isActive,
  item,
  modHeld,
  onActivate,
  onHover,
  search
}: {
  bindings: Record<string, string[]>
  index: number
  isActive: boolean
  item: PaletteItem
  modHeld: boolean
  onActivate: (item: PaletteItem, mods: SelectMods) => void
  onHover: (index: number) => void
  search: string
}) {
  const Icon = item.icon
  // The row's live keybind, else a static modifier-variant hint (⌘↵).
  // `bindingsFor`, not a raw lookup: a plugin's action is contributed after
  // $bindings was seeded, so its combo only resolves through the fallback chain.
  const combo = (item.action ? bindingsFor(item.action, bindings)[0] : undefined) ?? item.comboHint
  // While ⌘/⌃ is held, a row with a modifier variant previews it: the label
  // swaps to the variant's copy so Enter reads as what it will actually do.
  const modPreview = modHeld && Boolean(item.modLabel)
  const Trailing: IconComponent | undefined = item.trailing?.icon

  return (
    <div
      // The detail (a pane's group, a shortcut's keys) belongs to the name a
      // reader announces, not only to the eye (U4-p2b-06).
      aria-label={item.detail ? `${item.label}, ${item.detail}` : undefined}
      aria-selected={isActive}
      className="icp-row"
      data-active={isActive ? '' : undefined}
      id={optionDomId(index)}
      onClick={event => onActivate(item, modsOf(event))}
      // The input keeps focus through a click, so the sheet never has a second
      // focus owner and `aria-activedescendant` stays the single truth.
      onMouseDown={event => event.preventDefault()}
      onMouseMove={() => onHover(index)}
      role="option"
    >
      <Icon aria-hidden="true" className="icp-row__icon" focusable="false" />
      <span className="icp-row__body">
        <span className="icp-row__label" data-preview={modPreview ? '' : undefined}>
          {modPreview ? item.modLabel : <PaletteHighlight search={search} text={item.label} />}
        </span>
        {item.note && <span className="icp-row__note">{item.note}</span>}
      </span>
      {item.detail && (
        <span className="icp-row__detail" data-tone={item.detailVariant ?? 'muted'}>
          {item.detail}
        </span>
      )}
      {item.trailing && Trailing && (
        <span className="icp-row__trailing" data-tone={item.trailing.tone ?? 'muted'}>
          <Trailing
            aria-hidden="true"
            className="icp-row__trailing-icon"
            data-spin={item.trailing.spin ? '' : undefined}
            focusable="false"
          />
          {item.trailing.label}
        </span>
      )}
      {combo && <PaletteKeys combo={combo} dim={!modPreview} />}
      {item.to && <ChevronRight aria-hidden="true" className="icp-row__chevron" focusable="false" />}
      {item.active && <Check aria-hidden="true" className="icp-row__check" focusable="false" />}
    </div>
  )
}
