import { useState } from 'react'

import { IcPageButton } from '@/components/ic/ic-page'
import { IcStatusBanner } from '@/components/status-banner'
import { f3Banner } from '@/i18n/en/v009-f3'
import { Loader2, RefreshCw, Wrench } from '@/lib/icons'

import type { BootCause, BootCauseCode } from '../../electron/boot-cause'

/**
 * v0.0.9 F3 (point B): the one line that stays at the top of the window while the agent is stopped. Retry clears the
 * latched failure and reloads (the boot runs again, through the permission gate); Show details brings the failure card
 * back. It never starts anything by itself and never steals focus.
 *
 * v0.0.9 F4: drawn by the status banner (type 2) — an opaque plate, the cause wrapped in full (never cut), no ✕ while
 * the agent is stopped (it collapses instead) and the highest priority of the banners, so it is the one shown.
 */
export const AGENT_STOPPED_BANNER_PRIORITY = 100

/**
 * v0.0.9 G-1 (design G): the causes whose fix is Repair install — the boot card leads with it for them. Restarting the
 * same broken environment fails again, so the banner offers Repair too (a missing package is `python-import`).
 */
const REPAIR_FIXES: ReadonlySet<BootCauseCode> = new Set<BootCauseCode>([
  'install-state-not-writable',
  'port-in-use',
  'python-import',
  'runtime-env-broken'
])

export function stoppedBannerOffersRepair(cause: BootCause | null | undefined): boolean {
  return Boolean(cause && REPAIR_FIXES.has(cause.code))
}

type Busy = 'repair' | 'retry' | null

export function AgentStoppedBanner({
  cause,
  onRepair,
  onRetry,
  onShowDetails,
  repairLabel
}: {
  /** The plain cause sentence, when the app recognised one. */
  cause: null | string
  /**
   * G-1: Repair install, when the cause is one it fixes. It leads (the restart stays beside it, quiet) and carries the
   * owner-click marker the preload lock requires, exactly as the boot card's Repair does.
   */
  onRepair?: () => Promise<void> | void
  onRetry: () => Promise<void> | void
  onShowDetails: () => void
  repairLabel?: string
}) {
  const [busy, setBusy] = useState<Busy>(null)

  const run = (which: Exclude<Busy, null>, action: () => Promise<void> | void) => {
    setBusy(which)
    void Promise.resolve(action()).finally(() => setBusy(null))
  }

  const spinner = <Loader2 aria-hidden="true" className="animate-spin" size={14} />

  return (
    <IcStatusBanner
      actions={
        <>
          {onRepair ? (
            <IcPageButton
              data={{ 'data-repair-kit-confirm': '', 'data-testid': 'agent-stopped-repair' }}
              disabled={busy !== null}
              onClick={() => run('repair', onRepair)}
              tone="note"
            >
              {busy === 'repair' ? spinner : <Wrench aria-hidden="true" size={14} />}
              {repairLabel}
            </IcPageButton>
          ) : null}
          <IcPageButton
            disabled={busy !== null}
            onClick={() => run('retry', onRetry)}
            tone={onRepair ? 'quiet' : 'note'}
          >
            {busy === 'retry' ? spinner : <RefreshCw aria-hidden="true" size={14} />}
            {f3Banner.retry}
          </IcPageButton>
        </>
      }
      cause={cause ?? undefined}
      detailsLabel={f3Banner.details}
      onShowDetails={onShowDetails}
      priority={AGENT_STOPPED_BANNER_PRIORITY}
      testId="agent-stopped-banner"
      title={f3Banner.title}
      tone="error"
    />
  )
}
