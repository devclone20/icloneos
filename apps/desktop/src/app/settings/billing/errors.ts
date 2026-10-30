import type { BillingRefusal } from './api'
import { formatMoney } from './billing-amounts'
import type { BillingCopy } from './copy'

interface BillingRefusalPresentation {
  action: { type: 'none' } | { type: 'portal'; url?: string } | { type: 'retry' } | { type: 'step_up' }
  message: string
  title: string
}

type RefusalWords = BillingCopy['refusal']

const portalAction = (url?: string): BillingRefusalPresentation['action'] => ({ type: 'portal', url })

// Every word comes from the catalogue: a refusal's own `message` is backend text and never reaches the person.
const withRetryHint = (message: string, refusal: BillingRefusal, words: RefusalWords): string =>
  refusal.retryAfter ? `${message} ${words.retryIn(Math.max(1, Math.round(refusal.retryAfter / 60)))}` : message

export const resolveRefusal = (refusal: BillingRefusal, copy: BillingCopy): BillingRefusalPresentation => {
  const words = copy.refusal

  switch (refusal.kind) {
    case 'consent_required':
      return { action: portalAction(refusal.portalUrl), message: words.consentMessage, title: words.consentTitle }

    case 'insufficient_scope':
      return { action: { type: 'step_up' }, message: words.scopeMessage, title: words.scopeTitle }

    case 'remote_spending_revoked':
      return {
        action: portalAction(refusal.portalUrl),
        message: refusal.actor === 'admin' ? words.stoppedByAdmin : words.stoppedByYou,
        title: words.stoppedTitle
      }

    case 'session_revoked':
      return { action: portalAction(refusal.portalUrl), message: words.sessionMessage, title: words.sessionTitle }

    case 'cli_billing_disabled':

    case 'remote_spending_disabled':
      return { action: portalAction(refusal.portalUrl), message: words.disabledMessage, title: words.disabledTitle }

    case 'role_required':
      return { action: portalAction(refusal.portalUrl), message: words.roleMessage, title: words.roleTitle }

    case 'idempotency_conflict':
      return { action: { type: 'none' }, message: words.conflictMessage, title: words.conflictTitle }

    case 'no_payment_method':
      return { action: portalAction(refusal.portalUrl), message: words.noCardMessage, title: words.noCardTitle }

    case 'org_access_denied':
      return { action: { type: 'none' }, message: words.orgMessage, title: words.orgTitle }
    case 'monthly_cap_exceeded': {
      const remaining = refusal.payload?.remainingUsd

      return {
        action: portalAction(refusal.portalUrl),
        message:
          remaining != null ? `${words.capRemaining(formatMoney(remaining))} ${words.capMessage}` : words.capMessage,
        title: words.capTitle
      }
    }

    case 'rate_limited':

    case 'temporarily_unavailable':
      return {
        action: { type: 'retry' },
        message: withRetryHint(words.busyMessage, refusal, words),
        title: words.busyTitle
      }

    case 'stripe_unavailable':
      return {
        action: { type: 'retry' },
        message: withRetryHint(words.paymentServiceMessage, refusal, words),
        title: words.paymentServiceTitle
      }

    case 'upgrade_cap_exceeded':
      return { action: { type: 'none' }, message: words.planLimitMessage, title: words.planLimitTitle }

    case 'endpoint_unavailable':
      return { action: { type: 'retry' }, message: words.unavailableMessage, title: words.unavailableTitle }

    case 'timeout':
      return { action: { type: 'retry' }, message: words.timeoutMessage, title: words.timeoutTitle }

    case 'transport':
      return { action: { type: 'retry' }, message: words.offlineMessage, title: words.offlineTitle }

    default:
      return { action: { type: 'none' }, message: words.failedMessage, title: words.failedTitle }
  }
}
