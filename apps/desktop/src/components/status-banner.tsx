import './notification-system.css'

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type ReactNode, useId, useLayoutEffect, useState } from 'react'

import { IcIconAction } from '@/components/ic/controls'
import { IcPageButton } from '@/components/ic/ic-page'
import { f4Banner } from '@/i18n/en/v009-f4'
import { f4bBanner } from '@/i18n/en/v009-f4b'
import { ChevronDown, X } from '@/lib/icons'
import type { NotificationKind } from '@/store/notifications'

import { SeverityIcon } from './notification-glyph'

/**
 * v0.0.9 F4 — type 2, the status banner: one band at the top of the content area, bound to a STATE (the agent is not
 * running, credits are out), not to an event. One at a time: of the banners mounted, the highest `priority` shows and
 * the rest wait. It has no ✕ while its state lasts — it collapses to its title instead — and it leaves on its own when
 * the state does (its owner unmounts it). "Show details" opens the cause screen or the notification centre.
 */

const $claims = atom<readonly { key: string; priority: number }[]>([])

/** True when this banner holds the band: highest priority wins; on a tie the first mounted keeps it. */
export function holdsBand(claims: readonly { key: string; priority: number }[], key: string): boolean {
  let best: { key: string; priority: number } | undefined

  for (const claim of claims) {
    if (!best || claim.priority > best.priority) {
      best = claim
    }
  }

  return best?.key === key
}

function useBand(priority: number): boolean {
  const key = useId()
  const claims = useStore($claims)
  const [claimed, setClaimed] = useState(false)

  // Q renderer 7: the claim lands before paint (layout effect), and a banner draws nothing until it has claimed.
  // Banners mounting in the same commit (agent stopped + billing, both from one boot failure) all register before
  // the synchronous re-render the state update forces, so that re-render — the first frame painted — already sees
  // every claim: only the winner ever paints or announces, and the winner is not a frame late.
  useLayoutEffect(() => {
    $claims.set([...$claims.get(), { key, priority }])
    setClaimed(true)

    return () => $claims.set($claims.get().filter(claim => claim.key !== key))
  }, [key, priority])

  return claimed && holdsBand(claims, key)
}

export function IcStatusBanner({
  actions,
  cause,
  data,
  detailsLabel = f4Banner.showDetails,
  dismissLabel = f4bBanner.dismiss,
  onDismiss,
  onShowDetails,
  priority = 0,
  testId,
  title,
  tone = 'error'
}: {
  /** The banner's own buttons (Retry…), before "Show details". */
  actions?: ReactNode
  /** One plain sentence: why. Wraps; never cut. */
  cause?: ReactNode
  /** v0.0.9 F4b: the `data-*` hooks a migrated banner already exposes, on the announced (role=status) element. */
  data?: { [key: `data-${string}`]: string | undefined }
  detailsLabel?: string
  dismissLabel?: string
  /**
   * v0.0.9 F4b: a ✕ — only for a reminder the owner may put away while its state lasts (billing wall, provider
   * refusal, remote display). A state that must stay visible (agent not running) passes none and only collapses.
   */
  onDismiss?: () => void
  onShowDetails?: () => void
  priority?: number
  testId?: string
  /** What the state is, in a few words. */
  title: ReactNode
  tone?: NotificationKind
}) {
  const holds = useBand(priority)
  const [collapsed, setCollapsed] = useState(false)

  if (!holds) {
    return null
  }

  return (
    <div {...data} aria-live="polite" className="icn-banner-wrap" data-testid={testId} role="status">
      <div className="icn-banner" data-collapsed={collapsed ? '' : undefined} data-kind={tone} data-slot="ic-banner">
        <SeverityIcon kind={tone} />
        {/* div, not p: a migrated banner's title or cause may be block content (one line per reset, F4b). */}
        <div className="icn-text">
          <div className="icn-title">{title}</div>
          {!collapsed && cause ? <div className="icn-body">{cause}</div> : null}
        </div>
        {collapsed ? (
          <span />
        ) : (
          <div className="icn-banner__actions">
            {actions}
            {onShowDetails ? (
              <IcPageButton onClick={onShowDetails} tone="quiet">
                {detailsLabel}
              </IcPageButton>
            ) : null}
          </div>
        )}
        <div className="icn-banner__end">
          <div className="icn-banner__toggle" data-open={collapsed ? undefined : ''}>
            <IcIconAction label={collapsed ? f4Banner.expand : f4Banner.collapse} onClick={() => setCollapsed(v => !v)}>
              <ChevronDown aria-hidden="true" size={14} />
            </IcIconAction>
          </div>
          {onDismiss ? (
            <div className="icn-close">
              <IcIconAction label={dismissLabel} onClick={onDismiss}>
                <X aria-hidden="true" size={14} />
              </IcIconAction>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
