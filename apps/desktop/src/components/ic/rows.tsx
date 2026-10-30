import './ic-ui.css'

import type { ReactNode } from 'react'

/**
 * OUR list row — one line of a master list on a page frame: a status glyph, a
 * title with one meta line, and actions that surface on hover/focus.
 *
 * `app/home/econ/ui.tsx` also exports `Rows`/`Row`: that pair is a data TABLE
 * (`Cell` children, column template) for the econ ledgers. This one is a
 * selectable navigation row — hence `IcRow`, and no shared base: a table row
 * and a nav row only look alike until the first column arrives.
 */

export function IcRows({ children }: { children: ReactNode }) {
  return <ul className="icui-rows">{children}</ul>
}

export function IcRow({
  actions,
  current,
  meta,
  onOpen,
  rowKey,
  status,
  title
}: {
  actions?: ReactNode
  /** Marks the row the detail pane is showing (`aria-current`). */
  current?: boolean
  meta?: string
  onOpen?: () => void
  /** Scroll anchor: a row opened from elsewhere is found by this value. */
  rowKey?: string
  status?: ReactNode
  title: string
}) {
  return (
    <li aria-current={current ? 'true' : undefined} className="icui-row" data-ic-row={rowKey}>
      {status}
      {onOpen ? (
        <button className="icui-row__open" onClick={onOpen} type="button">
          <span className="icui-row__title">{title}</span>
          {meta ? <span className="icui-row__meta">{meta}</span> : null}
        </button>
      ) : (
        <span className="icui-row__open">
          <span className="icui-row__title">{title}</span>
          {meta ? <span className="icui-row__meta">{meta}</span> : null}
        </span>
      )}
      {actions ? <span className="icui-row__actions">{actions}</span> : null}
    </li>
  )
}
