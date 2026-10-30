import { Button } from '@/components/ui/button'
import { openExternalLink } from '@/lib/external-link'
import { ExternalLink } from '@/lib/icons'

import type { BillingRefusal } from './api'
import { useBillingCopy } from './copy'
import { resolveRefusal } from './errors'
import { FeedbackLines } from './feedback-lines'
import { useStepUpFlow } from './use-step-up'

export function StepUpInlineAction({ flow }: { flow: ReturnType<typeof useStepUpFlow> }) {
  const copy = useBillingCopy()

  if (flow.verification) {
    return (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-[0.72rem] font-semibold text-foreground">{flow.verification.code}</span>
        <Button onClick={flow.openVerification} size="sm" type="button" variant="outline">
          {copy.actions.openVerification}
          <ExternalLink className="size-3.5" />
        </Button>
      </span>
    )
  }

  if (flow.message) {
    return (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
        <FeedbackLines message={flow.message.text} title={flow.message.title} />
        <Button onClick={flow.dismiss} size="sm" type="button" variant="outline">
          {copy.actions.dismiss}
        </Button>
      </span>
    )
  }

  if (flow.phase === 'waiting') {
    return <span>{copy.status.waitingLink}</span>
  }

  return (
    <Button onClick={() => void flow.start()} size="sm" type="button" variant="outline">
      {copy.actions.verify}
    </Button>
  )
}

export function BillingRefusalInline({ refusal }: { refusal: BillingRefusal | null }) {
  const stepUp = useStepUpFlow()
  const copy = useBillingCopy()

  if (!refusal) {
    return null
  }

  const resolved = resolveRefusal(refusal, copy)
  const portalUrl = resolved.action.type === 'portal' ? resolved.action.url : undefined

  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
      <FeedbackLines message={resolved.message} title={resolved.title} />
      {resolved.action.type === 'step_up' && <StepUpInlineAction flow={stepUp} />}
      {portalUrl && (
        <Button onClick={() => openExternalLink(portalUrl)} size="sm" type="button" variant="outline">
          {copy.actions.openPortal}
          <ExternalLink className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
