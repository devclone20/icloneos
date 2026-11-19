import { useStore } from '@nanostores/react'
import { createPortal } from 'react-dom'

import { IcPageButton } from '@/components/ic/ic-page'
import { IcStatusBanner } from '@/components/status-banner'
import { useI18n } from '@/i18n'
import { $billingBlock, billingCtaLabel, clearBillingBlock, runBillingRecovery } from '@/store/billing-block'

/** v0.0.9 F4 (C5): the whole message on one wrapped line — never only its first line, never cut with an ellipsis. */
function oneParagraph(text: string): string {
  return (text || '').replace(/\s*\n\s*/g, ' ').trim()
}

/** v0.0.9 F4b: where the billing wall sits among the status banners (agent stopped 100 > billing 70 > provider 60). */
export const BILLING_BANNER_PRIORITY = 70

/**
 * Persistent billing wall for THIS session. It never disables the composer — slash commands (`/topup`, `/model`,
 * `/login`) stay usable — it only offers recovery: Nous opens Settings → Billing in-app, other providers deep-link
 * out. The sticky toast is the loud surface; this is the calm reminder that outlives it.
 *
 * v0.0.9 F4b — type 2 (IcStatusBanner, one band under the titlebar, by priority): what (title), why (the provider's
 * whole message, wrapped), the recovery as the banner's action, and a ✕ that puts the reminder away. Portalled to the
 * body so the composer card's clipping and blur never hold the fixed band.
 */
export function BillingBanner({ sessionId }: { sessionId: null | string }) {
  const active = useStore($billingBlock)
  const { t } = useI18n()

  if (!active || !sessionId || active.sessionId !== sessionId || typeof document === 'undefined') {
    return null
  }

  const { block } = active
  const copy = t.billingBlock
  const title = block.is_nous ? copy.titleNous : copy.titleProvider(block.provider_label)
  const message = oneParagraph(block.message) || copy.fallbackMessage

  return createPortal(
    <IcStatusBanner
      actions={
        <IcPageButton onClick={() => runBillingRecovery(block)} tone="quiet">
          {billingCtaLabel(block, copy)}
        </IcPageButton>
      }
      cause={message}
      data={{ 'data-billing-banner': block.is_nous ? 'nous' : 'provider' }}
      dismissLabel={copy.dismiss}
      onDismiss={() => clearBillingBlock(sessionId)}
      priority={BILLING_BANNER_PRIORITY}
      title={title}
      tone="error"
    />,
    document.body
  )
}
