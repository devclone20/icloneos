/**
 * IcState — the empty / loading / error state, once (contract IC §3, 2026-10-19).
 * Three fronts wrote this component three times; this shape won because `kind`
 * is the only one of the three that tells a screen reader something is loading:
 * `loading` is a live region, `error` is an alert and carries its retry action.
 * `className` and `icon` come from the two other shapes so nothing was lost.
 *
 * The look is still `ic-page.css`'s `icpg__state*`, so the ten pages that reach
 * it through `IcPageState` paint exactly as they did. The two remaining bodies
 * (`IcSurfaceState` on `ic-state`, `IcEmpty` on `icui-empty`) differ only in
 * their class vocabulary now: folding them in is a visual change, so it belongs
 * to E3h with the rest of the look.
 */
import './ic-page.css'

import type { ReactNode } from 'react'

interface IcStateProps {
  action?: ReactNode
  className?: string
  description?: string
  /** Rendered above the title, as `IcEmpty`/`IcSurfaceState` took it. */
  icon?: ReactNode
  kind: 'empty' | 'error' | 'loading'
  title: string
}

export function IcState({ action, className, description, icon, kind, title }: IcStateProps) {
  return (
    <div
      aria-busy={kind === 'loading' || undefined}
      aria-live={kind === 'loading' ? 'polite' : undefined}
      className={className ? `icpg__state icpg__state--${kind} ${className}` : `icpg__state icpg__state--${kind}`}
      data-ic-state={kind}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {kind === 'loading' ? <span aria-hidden="true" className="icpg__spinner" /> : null}
      {icon}
      <p className="icpg__state-title">{title}</p>
      {description ? <p className="icpg__state-text">{description}</p> : null}
      {action ? <div className="icpg__state-action">{action}</div> : null}
    </div>
  )
}
