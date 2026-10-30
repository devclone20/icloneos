import { useStore } from '@nanostores/react'
import { useInRouterContext, useNavigate } from 'react-router'

import { SETTINGS_ROUTE } from '@/app/routes'
import {
  $providerBlock,
  dismissProviderBlock,
  type ProviderBlock,
  providerBlockCta,
  providerBlockMessage
} from '@/lib/provider-block'
import { cn } from '@/lib/utils'

/** Settings → Providers (API keys and OAuth accounts); the failed card's
 *  "Switch provider" lands on the same page. */
export const PROVIDER_SETTINGS_LINK = `${SETTINGS_ROUTE}?tab=providers`

const BAR = cn(
  'pointer-events-auto mx-auto mb-1 flex w-full max-w-(--composer-max-width,48rem) items-center gap-2 rounded-md px-3 py-1.5',
  'border border-(--ic-border-subtle) bg-(--ic-surface-raised) text-xs text-(--ic-text-ramp-80)'
)

/**
 * Persistent one-line banner above the composer while the provider refuses
 * every turn (invalid key, model gone). The failed card in the thread keeps the
 * runtime's own text; this line outlives it so the owner sees WHY replies stop.
 */
export function ProviderBlockBanner() {
  const block = useStore($providerBlock)

  if (!block) {
    return null
  }

  return <ProviderBlockBar block={block} />
}

function ProviderBlockBar({ block }: { block: ProviderBlock }) {
  const cta = providerBlockCta(block)

  return (
    <div aria-live="polite" className={BAR} data-provider-block={block.kind} role="status">
      <span aria-hidden="true" className="text-[color:var(--ic-danger)]">
        ●
      </span>
      <span className="min-w-0 flex-1 truncate">{providerBlockMessage(block)}</span>
      {cta ? <SettingsLink label={cta} /> : null}
      <button
        aria-label="Dismiss"
        className="shrink-0 rounded px-1 text-(--ic-text-2) hover:text-[color:var(--ic-text-1)]"
        onClick={dismissProviderBlock}
        type="button"
      >
        ✕
      </button>
    </div>
  )
}

// useNavigate() throws outside a <Router> (bare tests, detached windows).
function SettingsLink({ label }: { label: string }) {
  return useInRouterContext() ? <RoutedSettingsLink label={label} /> : null
}

function RoutedSettingsLink({ label }: { label: string }) {
  const navigate = useNavigate()

  return (
    <button
      className="shrink-0 rounded px-1.5 font-medium text-[color:var(--ic-text-1)] underline-offset-2 hover:underline"
      onClick={() => navigate(PROVIDER_SETTINGS_LINK)}
      type="button"
    >
      {label}
    </button>
  )
}
