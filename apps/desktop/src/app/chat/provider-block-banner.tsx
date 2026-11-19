import { useStore } from '@nanostores/react'
import { createPortal } from 'react-dom'
import { useInRouterContext, useNavigate } from 'react-router'

import { SETTINGS_ROUTE } from '@/app/routes'
import { IcPageButton } from '@/components/ic/ic-page'
import { IcStatusBanner } from '@/components/status-banner'
import {
  $providerBlock,
  dismissProviderBlock,
  type ProviderBlock,
  providerBlockCta,
  providerBlockMessage
} from '@/lib/provider-block'

/** Settings → Providers (API keys and OAuth accounts); the failed card's
 *  "Switch provider" lands on the same page. */
export const PROVIDER_SETTINGS_LINK = `${SETTINGS_ROUTE}?tab=providers`

/** v0.0.9 F4b: where this state sits among the status banners (agent stopped 100 > billing 70 > provider 60). */
export const PROVIDER_BLOCK_PRIORITY = 60

/**
 * Persistent banner while the provider refuses every turn (invalid key, model gone). The failed card in the thread
 * keeps the runtime's own text; this outlives it so the owner sees WHY replies stop.
 *
 * v0.0.9 F4b — type 2 (IcStatusBanner): the whole sentence wraps (it was one truncated line above the composer), the
 * way out is the banner's action, and the owner may put the reminder away (✕).
 */
export function ProviderBlockBanner() {
  const block = useStore($providerBlock)

  if (!block || typeof document === 'undefined') {
    return null
  }

  // Portalled: the band is fixed under the titlebar, and the chat column's transforms must not hold it.
  return createPortal(<ProviderBlockBar block={block} />, document.body)
}

function ProviderBlockBar({ block }: { block: ProviderBlock }) {
  const cta = providerBlockCta(block)

  return (
    <IcStatusBanner
      actions={cta ? <SettingsLink label={cta} /> : undefined}
      data={{ 'data-provider-block': block.kind }}
      onDismiss={dismissProviderBlock}
      priority={PROVIDER_BLOCK_PRIORITY}
      title={providerBlockMessage(block)}
      tone="error"
    />
  )
}

// useNavigate() throws outside a <Router> (bare tests, detached windows).
function SettingsLink({ label }: { label: string }) {
  return useInRouterContext() ? <RoutedSettingsLink label={label} /> : null
}

function RoutedSettingsLink({ label }: { label: string }) {
  const navigate = useNavigate()

  return (
    <IcPageButton onClick={() => navigate(PROVIDER_SETTINGS_LINK)} tone="quiet">
      {label}
    </IcPageButton>
  )
}
