import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { openExternalLink } from '@/lib/external-link'
import { ChevronLeft, ExternalLink, Package } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { Pill, SectionHeading } from '../primitives'
import { SettingRow } from '../setting-row'

import { type BillingCopy, useBillingCopy } from './copy'
import { BillingRefusalInline } from './inline-feedback'
import { type BillingPlanTierView, formatBillingDate, formatMonthlyCreditsDelta } from './use-billing-state'
import { type DowngradePhase, useDowngradeFlow } from './use-subscription-change'

type DowngradeFlow = ReturnType<typeof useDowngradeFlow>

// The sentence for the confirm panel, derived purely from the phase and the catalogue. `null` while a
// refusal is the only thing to show (BillingRefusalInline renders that separately). The preview's own
// `reason` is backend text and is never shown.
function previewMessage(phase: DowngradePhase, fallbackTierName: string, copy: BillingCopy): null | string {
  if (phase.kind === 'previewing') {
    return copy.plans.checking
  }

  if (phase.kind === 'previewFailed') {
    return null
  }

  const { preview } = phase
  const targetName = preview.target_tier_name ?? fallbackTierName
  const creditsDelta = formatMonthlyCreditsDelta(copy, preview.monthly_credits_delta)

  switch (preview.effect) {
    case 'blocked':
      return copy.plans.blocked

    case 'no_op':
      return copy.plans.noOp(targetName)
    case 'scheduled': {
      const change = copy.plans.scheduledChange(targetName, formatBillingDate(preview.effective_at))

      return creditsDelta ? `${change} ${copy.plans.creditsChange(creditsDelta)}` : change
    }

    default:
      return copy.plans.cannotSchedule
  }
}

function confirmLabel(phase: DowngradePhase, copy: BillingCopy): string {
  if (phase.kind === 'scheduling') {
    return copy.plans.scheduling
  }

  return phase.kind === 'scheduleFailed' ? copy.actions.tryAgain : copy.plans.confirm
}

// The preview → confirm panel for a downgrade (mirrors the TUI confirm flow), rendered below its plan row.
function DowngradeConfirm({ flow, tier }: { flow: DowngradeFlow; tier: BillingPlanTierView }) {
  const copy = useBillingCopy()
  const active = flow.active
  const panelRef = useRef<HTMLDivElement>(null)
  const open = active?.target.tierId === tier.tierId

  // Move focus into the panel on open so keyboard users land on the confirm flow;
  // role="status"/aria-live announces the async preview text as it arrives.
  useEffect(() => {
    if (open) {
      panelRef.current?.focus()
    }
  }, [open])

  if (!active || active.target.tierId !== tier.tierId) {
    return null
  }

  const { phase } = active
  const captionCn = 'text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'
  const refusal = phase.kind === 'previewFailed' || phase.kind === 'scheduleFailed' ? phase.refusal : null
  const busy = phase.kind === 'previewing' || phase.kind === 'scheduling'
  const message = previewMessage(phase, tier.name, copy)

  const canConfirm =
    (phase.kind === 'ready' && phase.preview.effect === 'scheduled') ||
    phase.kind === 'scheduling' ||
    phase.kind === 'scheduleFailed'

  return (
    <div
      aria-live="polite"
      className="flex min-w-0 flex-col gap-2 rounded-md bg-(--ui-bg-elevated) p-3 outline-none"
      ref={panelRef}
      role="status"
      tabIndex={-1}
    >
      {message && <div className={captionCn}>{message}</div>}

      <BillingRefusalInline refusal={refusal} />

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {phase.kind === 'previewFailed' ? (
          <Button disabled={busy} onClick={flow.retryPreview} size="sm" type="button">
            {copy.actions.tryAgain}
          </Button>
        ) : canConfirm ? (
          <Button disabled={busy} onClick={() => void flow.confirm()} size="sm" type="button">
            {confirmLabel(phase, copy)}
          </Button>
        ) : null}
        <Button disabled={busy} onClick={flow.cancel} size="sm" type="button" variant="outline">
          {copy.actions.cancel}
        </Button>
      </div>
    </div>
  )
}

function PlanControl({ flow, tier }: { flow: DowngradeFlow; tier: BillingPlanTierView }) {
  const copy = useBillingCopy()

  switch (tier.state) {
    case 'current':
      return <Pill tone="primary">{copy.plans.current}</Pill>

    case 'scheduled':
      return <Pill>{copy.plans.scheduled}</Pill>

    case 'upgrade':
      return (
        <Button
          onClick={() => tier.action && openExternalLink(tier.action.url)}
          size="sm"
          type="button"
          variant="outline"
        >
          {tier.action.label}
          <ExternalLink className="size-3.5" />
        </Button>
      )

    case 'downgrade':
      // While this plan's confirm panel is open below the row, the panel holds the actions.
      return flow.active?.target.tierId === tier.tierId ? null : (
        // Disabled while another plan's change is committing — no concurrent mutation.
        <Button
          disabled={flow.mutating}
          onClick={() => flow.begin({ tierId: tier.tierId, tierName: tier.name })}
          size="sm"
          type="button"
          variant="outline"
        >
          {copy.plans.downgrade}
        </Button>
      )

    default:
      return null
  }
}

// One plan = one row: a sentence naming the plan and what choosing it does, price and monthly credits below, the action trailing.
function planRowTitle(tier: BillingPlanTierView, copy: BillingCopy): string {
  switch (tier.state) {
    case 'current':
      return copy.plan.currentTitle(tier.name)

    case 'downgrade':
      return copy.plans.titleDowngrade(tier.name)

    case 'scheduled':
      return copy.plans.titleScheduled(tier.name)

    case 'upgrade':
      return copy.plans.titleUpgrade(tier.name)
  }
}

function PlanRow({ flow, tier }: { flow: DowngradeFlow; tier: BillingPlanTierView }) {
  const copy = useBillingCopy()
  const isCurrent = tier.state === 'current'
  const confirming = flow.active?.target.tierId === tier.tierId
  const rowRef = useRef<HTMLDivElement>(null)
  const wasConfirming = useRef(false)

  // When the confirm panel closes (cancel / scheduled), return focus to this row
  // so keyboard focus is never left detached on the removed panel.
  // eslint-disable-next-line no-restricted-syntax -- tracks previous confirming state for focus return, not an atom mirror
  useEffect(() => {
    if (wasConfirming.current && !confirming) {
      rowRef.current?.focus()
    }

    wasConfirming.current = confirming
  }, [confirming])

  const hint = [copy.plans.perMonth(tier.priceDisplay), tier.creditsDisplay].filter(Boolean).join(' · ')
  const title = planRowTitle(tier, copy)

  return (
    <div
      aria-current={isCurrent || undefined}
      className="outline-none"
      data-plan-tier={tier.tierId}
      ref={rowRef}
      tabIndex={-1}
    >
      <SettingRow
        below={tier.state === 'downgrade' && confirming ? <DowngradeConfirm flow={flow} tier={tier} /> : undefined}
        // The current plan keeps the tint its tile had (same token), so it still reads as yours at a glance.
        className={cn(isCurrent && 'bg-(--ui-green)/10 hover:bg-(--ui-green)/10')}
        control={<PlanControl flow={flow} tier={tier} />}
        hint={hint}
        title={title}
      />
    </div>
  )
}

export function BillingPlansView({ onBack, tiers }: { onBack: () => void; tiers: BillingPlanTierView[] }) {
  // A scheduled downgrade lands the user back on the overview, where the plan card
  // now shows the pending state with its undo.
  const copy = useBillingCopy()
  const flow = useDowngradeFlow({ onScheduled: onBack })

  return (
    <section className="mb-6">
      {/* The sub-page's own header: the back control belongs to navigation, not to a setting. */}
      <header>
        <SectionHeading
          aside={
            <Button
              className="text-(--ui-text-tertiary)"
              disabled={flow.mutating}
              onClick={onBack}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ChevronLeft className="size-4" />
              {copy.plan.back}
            </Button>
          }
          icon={Package}
          title={copy.plans.title}
        />
      </header>

      {tiers.length > 0 ? (
        tiers.map(tier => <PlanRow flow={flow} key={tier.tierId} tier={tier} />)
      ) : (
        <SettingRow title={copy.plans.empty} />
      )}
    </section>
  )
}
