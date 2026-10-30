import './ic-ui.css'

import type { ReactNode } from 'react'

/**
 * OUR page layout primitives — the skeleton every E3d3 page is poured into
 * (`--ic-*` tokens only, no upstream component underneath, owner #8).
 *
 * `app/home/econ/ui.tsx` has its own `Stat`/`StatRow` pair: those are money
 * cells (currency formatting, signed deltas) inside the econ app frame, while
 * these are plain label/value plates on a page frame. The `Ic` prefix keeps the
 * two vocabularies apart at every call site instead of by import order.
 */

export function IcStack({ children }: { children: ReactNode }) {
  return <div className="icui-stack">{children}</div>
}

export function IcScroll({ children }: { children: ReactNode }) {
  return <div className="icui-scroll">{children}</div>
}

export function IcEyebrow({ children }: { children: ReactNode }) {
  return <p className="icui-eyebrow">{children}</p>
}

export function IcMeta({ children }: { children: ReactNode }) {
  return <p className="icui-meta">{children}</p>
}

/** Small caps heading inside a page section. */
export function IcSectionLabel({ children }: { children: ReactNode }) {
  return <p className="icui-section">{children}</p>
}

export function IcStats({ children }: { children: ReactNode }) {
  return <div className="icui-stats">{children}</div>
}

export function IcStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="icui-stat__label">{label}</p>
      <p className="icui-stat__value">{value}</p>
    </div>
  )
}
