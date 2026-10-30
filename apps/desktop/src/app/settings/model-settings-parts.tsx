import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getEnvVars } from '@/hermes'
import type { MoaConfigResponse, MoaModelSlot, ModelOptionProvider, StaleAuxAssignment } from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertTriangle, Loader2 } from '@/lib/icons'
import type { EnvVarInfo, OAuthProvider } from '@/types/hermes'

import { type ProviderCredential, providerCredentials } from './credential-removal'
import { SettingRow } from './setting-row'

// Skeleton mirror of the Model settings DOM so the page keeps its shape while
// the provider/model catalog loads, instead of collapsing to a centered
// spinner. Same containers/rhythm as the real render below.
export function ModelSettingsSkeleton() {
  return (
    <div className="grid gap-6" data-slot="model-settings-skeleton">
      <section>
        <Skeleton className="mb-3 h-3 w-72 max-w-full" />
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-60 max-w-full" />
          <Skeleton className="h-8 w-16" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-6 w-20" />
        </div>
      </section>

      <section>
        <div className="mb-2.5 flex items-center gap-2 pt-2">
          <Skeleton className="size-4" />
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="grid gap-1">
          {[0, 1, 2, 3].map(row => (
            <div
              className="grid gap-3 py-3 @2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] @2xl:items-center"
              key={row}
            >
              <div className="min-w-0 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-52 max-w-full" />
              </div>
              <Skeleton className="h-8 w-full @2xl:justify-self-end @2xl:w-56" />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

// agent.service_tier stores "fast"/"priority"/"on" for fast; anything else is
// normal (mirrors tui_gateway _load_service_tier).
export const isFastTier = (tier: unknown): boolean =>
  ['fast', 'priority', 'on'].includes(
    String(tier ?? '')
      .trim()
      .toLowerCase()
  )

// A provider row is "ready" to pick a model from when it reports models. The
// backend now surfaces the full `hermes model` universe (every canonical
// provider), so unconfigured providers come back with `authenticated:false`
// and an empty `models` list — those need a setup step before a model exists.
// A provider that lost its credentials still lists its saved model, but with
// `authenticated:false` and a `warning` — that one needs setup too.
export type RemovalPlan =
  | { keyEnv: string; kind: 'api_key'; remaining: ProviderCredential[]; slug: string }
  | { kind: 'manage'; slug: string }
  | { kind: 'oauth'; oauth: OAuthProvider; remaining: ProviderCredential[]; slug: string }

export const getEnvVarsOrNull = (profile?: string) =>
  Promise.resolve()
    .then(() => getEnvVars(profile))
    .catch(() => null)

// Authenticated rows carry no key_env/auth_type: the env keys come from GET
// /api/env's provider grouping, the sign-ins from the OAuth catalog (never
// assumed equal to the slug). One click removes the first removable
// credential; every other one is `remaining` and keeps the provider working.
export function removalPlanFor(
  row: ModelOptionProvider,
  vars: null | Record<string, EnvVarInfo>,
  oauthProviders: OAuthProvider[]
): RemovalPlan {
  const credentials = providerCredentials(row, vars, oauthProviders)
  const first = credentials.find(credential => credential.kind !== 'manage')

  if (!first) {
    return { kind: 'manage', slug: row.slug }
  }

  const remaining = credentials.filter(credential => credential !== first)

  return first.kind === 'api_key'
    ? { keyEnv: first.keyEnv, kind: 'api_key', remaining, slug: row.slug }
    : { kind: 'oauth', oauth: first.oauth, remaining, slug: row.slug }
}

export function isProviderReady(p?: ModelOptionProvider): boolean {
  if (!p) {
    return false
  }

  if (p.authenticated !== false) {
    return true
  }

  return (p.models?.length ?? 0) > 0 && !p.warning
}

// Mirrors `_AUX_TASK_SLOTS` in hermes_cli/web_server.py. Friendly labels and
// hints make the assignments readable; raw task keys (vision, mcp, …) are
// opaque to most users.
interface AuxTaskMeta {
  key: string
}

export const AUX_TASKS: readonly AuxTaskMeta[] = [
  { key: 'vision' },
  { key: 'compression' },
  { key: 'skills_hub' },
  { key: 'approval' },
  { key: 'mcp' },
  { key: 'title_generation' },
  { key: 'review' },
  { key: 'curator' }
]

export const NO_PROVIDERS: readonly ModelOptionProvider[] = [{ name: '—', slug: '', models: [] }]

// Radix <Select> renders a blank trigger when `value` matches no <SelectItem>.
// A custom model (e.g. one added via config that isn't in the provider's
// curated list) would vanish — surface the active value so it stays selectable.
export const withActive = (models: readonly string[], active: string): readonly string[] =>
  active && !models.includes(active) ? [active, ...models] : models

// A slot is complete when both halves are chosen. Changing a slot's provider
// intentionally clears its model (see updateMoaSlot), so every provider change
// passes through an incomplete state while the user picks the new model.
const moaSlotComplete = (slot: MoaModelSlot): boolean => !!(slot.provider.trim() && slot.model.trim())

// True when every slot in every preset is fully specified — the only state
// that is safe to persist. The backend rejects configs with half-filled slots
// (HTTP 422) instead of silently swapping the preset for hardcoded defaults
// (#64156), so the autosave must simply wait for the edit to finish rather
// than trying to "repair" the payload.
export const moaConfigComplete = (config: MoaConfigResponse): boolean =>
  Object.values(config.presets).every(
    preset =>
      preset.reference_models.length > 0 &&
      preset.reference_models.every(moaSlotComplete) &&
      moaSlotComplete(preset.aggregator)
  )

interface RestartRequiredNoticeProps {
  label: string
  message: string
  onRestart: () => void
  restarting: boolean
  title: string
}

// The backend refused to list models until it is restarted, and the app can do
// that itself: one row, the restart as its control.
export function RestartRequiredNotice({ label, message, onRestart, restarting, title }: RestartRequiredNoticeProps) {
  return (
    <SettingRow
      busy={restarting}
      control={
        <Button disabled={restarting} onClick={onRestart} size="sm" variant="textStrong">
          {restarting && <Loader2 className="size-3.5 animate-spin" />}
          {label}
        </Button>
      }
      hint={message}
      title={title}
    />
  )
}

interface StaleAuxWarningProps {
  applying: boolean
  onReset: () => void
  slots: readonly StaleAuxAssignment[]
  taskLabel: (key: string) => string
}

// Shared notice: auxiliary tasks still pinned to a provider that isn't the
// current main. Surfaces the silent credit-burn path (e.g. aux pinned to a
// $0-balance provider after switching main away from it) and offers the
// existing one-click reset rather than auto-clearing legitimate pins.
export function StaleAuxWarning({ applying, onReset, slots, taskLabel }: StaleAuxWarningProps) {
  const { t } = useI18n()

  if (!slots.length) {
    return null
  }

  const m = t.settings.model
  const provider = slots[0].provider
  const allSameProvider = slots.every(slot => slot.provider === provider)
  const names = slots.map(slot => taskLabel(slot.task)).join(', ')

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="grow">{m.staleAux(slots.length, names, allSameProvider ? provider : m.otherProviders)}</span>
      <Button disabled={applying} onClick={onReset} size="sm" variant="textStrong">
        {m.resetAllToMain}
      </Button>
    </div>
  )
}
