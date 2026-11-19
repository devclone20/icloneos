import type { CSSProperties } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { AlertCircle, AlertTriangle, CheckCircle2, type IconComponent, Info } from '@/lib/icons'
import type { NotificationKind } from '@/store/notifications'

/** v0.0.9 F4 — the severity glyph shared by the toast, the status banner and the notification centre. */
export const SEVERITY_ICON: Record<NotificationKind, IconComponent> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2
}

/** The severity glyph (or the caller's codicon) in the 20px icon column; its colour is the surface's --icn-tone. */
export function SeverityIcon({ icon, kind }: { icon?: string; kind: NotificationKind }) {
  const Icon = SEVERITY_ICON[kind]

  return (
    <span aria-hidden="true" className="icn-icon">
      {icon ? <Codicon name={icon} size="1rem" /> : <Icon />}
    </span>
  )
}

/** The accent a caller passed (usage bands) reaches the icon and the bar through one custom property, never the text. */
export function accentStyle(accent?: string): CSSProperties | undefined {
  return accent ? ({ '--icn-accent': accent } as CSSProperties) : undefined
}
