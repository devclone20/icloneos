import './ic-ui.css'

import { type ComponentType, type ReactNode, useId } from 'react'

import { AlertCircle } from '@/lib/icons'

/**
 * OUR state vocabulary: one tone scale for every page (a dot, a pill, an inline
 * note), plus the two "nothing to show" surfaces.
 *
 * econ's `Pill`/`Note`/`Empty` speak money and transport ('up'/'down', info /
 * warn / error kinds, an action-less empty): these speak run state (live, done,
 * warn, danger, muted) and take a call to action, so the tone unions are not
 * interchangeable and the names stay distinct.
 */

export type IcTone = 'danger' | 'done' | 'live' | 'muted' | 'warn'

export function IcDot({ label, tone }: { label?: string; tone: IcTone }) {
  return <span aria-label={label} className="icui-dot" data-tone={tone} role={label ? 'img' : undefined} />
}

export function IcPill({ children, tone = 'muted' }: { children: ReactNode; tone?: IcTone }) {
  return (
    <span className="icui-pill" data-tone={tone}>
      {children}
    </span>
  )
}

export function IcNote({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <span className="icui-note" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}>
      {tone === 'danger' ? <AlertCircle size={14} /> : null}
      {children}
    </span>
  )
}

export function IcEmpty({
  action,
  description,
  icon: Icon,
  title
}: {
  action?: ReactNode
  description: string
  icon?: ComponentType<{ size?: number | string }>
  title?: string
}) {
  return (
    <div className="icui-empty">
      <div>
        {Icon ? <Icon size={22} /> : null}
        {title ? <p className="icui-empty__title">{title}</p> : null}
        <p className="icui-empty__desc">{description}</p>
        {action ? <div className="icui-empty__action">{action}</div> : null}
      </div>
    </div>
  )
}

export function IcSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
  const id = useId()

  return (
    <div aria-busy="true" aria-label={label} className="icui-skeleton" role="status">
      {Array.from({ length: rows }, (_unused, index) => (
        <span key={`${id}:${index}`} />
      ))}
    </div>
  )
}
