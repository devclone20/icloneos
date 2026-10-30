import { Button } from '@/components/ui/button'
import { ExternalLink } from '@/lib/icons'

import { SettingRow } from '../setting-row'

import { useBillingCopy } from './copy'
import { BillingRefusalInline } from './inline-feedback'
import { openExternal } from './open-external'
import { TierArt } from './tier-art'
import type { BillingPlanCardView } from './use-billing-state'
import { useResumeFlow } from './use-subscription-change'

export function CurrentPlanCard({ onViewPlans, plan }: { onViewPlans: () => void; plan: BillingPlanCardView }) {
  const copy = useBillingCopy()
  const resumeFlow = useResumeFlow()

  return (
    <>
      <SettingRow
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {plan.action && (
              <Button onClick={onViewPlans} size="sm" type="button" variant="outline">
                {plan.action.label}
              </Button>
            )}
            {/* Scheduled downgrade → chargeless undo (subscription.resume), no confirm. */}
            {plan.pending && (
              <Button disabled={resumeFlow.busy} onClick={() => void resumeFlow.resume()} size="sm" type="button">
                {resumeFlow.busy ? copy.actions.undoing : copy.actions.undo}
              </Button>
            )}
            {plan.link && (
              <Button
                onClick={() => plan.link && openExternal(plan.link.url)}
                size="sm"
                type="button"
                variant="outline"
              >
                {plan.link.label}
                <ExternalLink className="size-3.5" />
              </Button>
            )}
          </div>
        }
        // Up to two buttons (change + undo): the field track, so at large text they stack under the sentence
        // instead of squeezing it.
        field
        // The title is a sentence that names the plan; its price leads the hint (a title is never the row's value).
        hint={plan.price ? `${copy.plans.perMonth(plan.price)} · ${plan.caption}` : plan.caption}
        title={
          <span className="flex min-w-0 items-center gap-3" data-plan-tier-name={plan.tierName}>
            <TierArt name={plan.tierName} />
            <span className="min-w-0">{copy.plan.currentTitle(plan.tierName)}</span>
          </span>
        }
      />
      <BillingRefusalInline refusal={resumeFlow.refusal} />
    </>
  )
}
