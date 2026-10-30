import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { runInTerminal } from '@/app/home/it/engine/store'
import { apiKeyPathFor, FEATURED_ID, providerTitle, sortProviders } from '@/components/onboarding'
import { Button } from '@/components/ui/button'
import { RowButton } from '@/components/ui/row-button'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tooltip'
import { listOAuthProviders } from '@/hermes'
import { translateNow, useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { Check, ChevronDown, ChevronRight, KeyRound, Loader2, Terminal, Trash2 } from '@/lib/icons'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { confirm } from '@/store/confirm'
import { $desktopOnboarding, startManualLocalEndpoint, startManualProviderOAuth } from '@/store/onboarding'
import type { EnvVarInfo, OAuthProvider } from '@/types/hermes'

import { isKeyVar } from './credential-key-ui'
import {
  credentialCopy,
  findActiveProviderFor,
  MODEL_SETTINGS_PATH,
  runRemoval,
  safeDocsUrl,
  useOptionalNavigate
} from './credential-removal'
import { CustomEndpointsSettings } from './custom-endpoints-settings'
import { SettingsCategoryHeading, useEnvCredentials } from './env-credentials'
import { providerGroup, providerMeta, providerPriority } from './helpers'
import { useKeysCopy } from './keys-copy'
import { SettingsContent, SettingsSkeleton } from './primitives'
import { ProviderChoiceRow, type ProviderKeyGroup, ProviderKeyGroupRows } from './providers-choice-row'
import { SettingRow } from './setting-row'

// The embedded terminal (and thus the "run disconnect command" path) only
// exists in the Electron desktop shell, not the web dashboard.
const canRunInTerminal = () => typeof window !== 'undefined' && Boolean(window.hermesDesktop?.terminal)

// Parallel group headers ("Connected", "Other providers") so the expanded list
// reads as its own section instead of bleeding into the connected group.
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 px-0.5 text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-tertiary)">
      {children}
    </p>
  )
}

// Sub-views surfaced as a sidebar subnav: account sign-in vs raw API keys.
export const PROVIDER_VIEWS = ['accounts', 'keys', 'custom-endpoints'] as const

export type ProviderView = (typeof PROVIDER_VIEWS)[number]

// Group the env catalog by provider — one ListRow per vendor plus optional
// advanced overrides (base URL, region, etc.). Groups without a key field are
// skipped.
//
// Grouping key precedence:
//   1. Backend `provider_label` / `provider` (from the unified provider catalog
//      in hermes_cli/provider_catalog.py) — the SAME provider identity
//      `hermes model` uses. This is authoritative: a provider tagged by the
//      backend always renders a card, even with no PROVIDER_GROUPS row.
//   2. Desktop prefix match (`providerGroup`) — legacy fallback for provider
//      env vars that predate the backend tagging.
// Only entries that resolve to neither (the "Other" bucket) are skipped.
function buildProviderKeyGroups(vars: Record<string, EnvVarInfo>): ProviderKeyGroup[] {
  const buckets = new Map<string, [string, EnvVarInfo][]>()

  for (const [key, info] of Object.entries(vars)) {
    if (info.category !== 'provider') {
      continue
    }

    // Prefer the backend-supplied provider label/id so the Keys tab groups by
    // the same identity the CLI picker uses; fall back to the prefix guess.
    const name = info.provider_label?.trim() || info.provider?.trim() || providerGroup(key)

    if (name === 'Other') {
      continue
    }

    buckets.set(name, [...(buckets.get(name) ?? []), [key, info]])
  }

  const groups: ProviderKeyGroup[] = []

  for (const [name, entries] of buckets) {
    const primary = entries.find(([k, i]) => !i.advanced && isKeyVar(k, i)) ?? entries.find(([k, i]) => isKeyVar(k, i))

    if (!primary) {
      continue
    }

    // Presentation overlay (priority, docs) is keyed by the prefix-based
    // group name; when the backend introduced this provider it may have no
    // overlay entry, so fall back to the backend/env metadata for display.
    const meta = providerMeta(name)

    groups.push({
      // Advanced = the provider's non-key knobs (base URL, region, deployment).
      // Skip redundant alias key vars (e.g. ANTHROPIC_TOKEN vs ANTHROPIC_API_KEY)
      // so we never render a second "Paste key" input — unless one is already
      // set, in which case keep it visible so it stays clearable.
      advanced: entries
        .filter(([k, i]) => k !== primary[0] && (!isKeyVar(k, i) || i.is_set))
        .sort(([a], [b]) => a.localeCompare(b)),
      docsUrl: meta?.docsUrl ?? primary[1].url ?? undefined,
      hasAnySet: entries.some(([, i]) => i.is_set),
      name,
      primary,
      priority: providerPriority(name)
    })
  }

  return groups.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
}

// Deliberately a near-1:1 replica of the first-run onboarding picker
// (`Picker` in desktop-onboarding-overlay): same recommended card, same
// Fireworks #2 quick-key row, same provider rows, same "Other providers"
// disclosure, same OpenRouter quick-key row, and the same bottom-right
// "I have an API key" affordance. Each choice is a settings row
// (ProviderChoiceRow), so the order matches the onboarding picker. Selecting a
// provider hands off to the shared onboarding overlay, which runs that
// provider's real sign-in flow; the key affordances open the API-key
// catalog below.
function OAuthPicker({
  disconnecting,
  onDisconnect,
  onTerminalDisconnect,
  onWantApiKey,
  onWantKeyFor,
  providers
}: {
  disconnecting: null | string
  onDisconnect: (provider: OAuthProvider) => void
  onTerminalDisconnect: (provider: OAuthProvider) => void
  onWantApiKey: () => void
  onWantKeyFor: (envKey: string) => void
  providers: OAuthProvider[]
}) {
  const { t } = useI18n()
  const keyWords = useKeysCopy()
  const p = t.settings.providers
  const [showAll, setShowAll] = useState(false)
  const ordered = useMemo(() => sortProviders(providers), [providers])

  if (ordered.length === 0) {
    return null
  }

  // An API-key-path card opens its key row; only real OAuth cards hand off to
  // the overlay's sign-in (which opens the browser).
  const select = (p: OAuthProvider) => {
    const keyPath = apiKeyPathFor(p.id)

    if (keyPath) {
      onWantKeyFor(keyPath.option.envKey)
    } else {
      startManualProviderOAuth(p.id)
    }
  }

  const featured = ordered.find(p => p.id === FEATURED_ID && !p.status?.logged_in) ?? null
  const rest = featured ? ordered.filter(p => p.id !== FEATURED_ID) : ordered
  // Keep connected accounts grouped and always visible; only the unconnected
  // providers hide behind the disclosure, so the page leads with what's set up.
  // Both lists preserve `sortProviders` order (curated priority, then name).
  const connected = rest.filter(p => p.status?.logged_in)
  const others = rest.filter(p => !p.status?.logged_in)
  const collapsible = others.length > 0
  const showOthers = !collapsible || showAll

  return (
    <section className="mb-5 grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <SettingsCategoryHeading icon={KeyRound} title={p.connectAccount} />
        <Button
          className="text-[length:var(--conversation-caption-font-size)]"
          onClick={onWantApiKey}
          size="inline"
          type="button"
          variant="textStrong"
        >
          {p.haveApiKey}
        </Button>
      </div>
      <p className="-mt-2 mb-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {p.intro}
      </p>
      {featured && (
        <ProviderChoiceRow
          badge={t.onboarding.recommended}
          hint={p.featuredPitch}
          onSelect={() => select(featured)}
          title={providerTitle(featured)}
        />
      )}
      {/* Slot #2 — always visible, matching onboarding / CANONICAL_PROVIDERS. */}
      <ProviderChoiceRow hint={t.onboarding.fireworksPitch} onSelect={onWantApiKey} title="Fireworks AI" />
      {connected.length > 0 && (
        <>
          <GroupLabel>{p.connected}</GroupLabel>
          {connected.map(p => (
            <ConnectedProviderRow
              disconnecting={disconnecting === p.id}
              key={p.id}
              onDisconnect={onDisconnect}
              onSelect={select}
              onTerminalDisconnect={onTerminalDisconnect}
              provider={p}
            />
          ))}
        </>
      )}
      {showOthers && (
        <>
          {connected.length > 0 && <GroupLabel>{p.otherProviders}</GroupLabel>}
          {others.map(p => {
            const keyPath = apiKeyPathFor(p.id)

            return (
              <ProviderChoiceRow
                external={!keyPath && p.flow === 'external'}
                // A key path's words come from the five-locale catalogue (S27.1), never onboarding's English pitch.
                hint={keyPath ? (keyWords.apiKeyProviders[p.id]?.[1] ?? '') : t.onboarding.flowSubtitles[p.flow]}
                key={p.id}
                onSelect={() => select(p)}
                title={keyPath ? (keyWords.apiKeyProviders[p.id]?.[0] ?? providerTitle(p)) : providerTitle(p)}
              />
            )
          })}
          <ProviderChoiceRow hint={t.onboarding.openRouterPitch} onSelect={onWantApiKey} title="OpenRouter" />
        </>
      )}
      {collapsible && (
        <Button
          className="py-1 text-[length:var(--conversation-caption-font-size)]"
          onClick={() => setShowAll(v => !v)}
          size="inline"
          type="button"
          variant="text"
        >
          {showAll ? p.collapse : connected.length > 0 ? p.connectAnother : p.otherProviders}
          <ChevronDown className={cn('size-3.5 transition', showAll && 'rotate-180')} />
        </Button>
      )}
    </section>
  )
}

function ConnectedProviderRow({
  disconnecting,
  onDisconnect,
  onSelect,
  onTerminalDisconnect,
  provider
}: {
  disconnecting: boolean
  onDisconnect: (provider: OAuthProvider) => void
  onSelect: (provider: OAuthProvider) => void
  onTerminalDisconnect: (provider: OAuthProvider) => void
  provider: OAuthProvider
}) {
  const { t } = useI18n()
  const copy = t.settings.providers
  const keyWords = useKeysCopy().apiKeyProviders[provider.id]
  const hasKeyPath = apiKeyPathFor(provider.id) !== null
  const title = providerTitle(provider)
  const Trail = provider.flow === 'external' ? Terminal : ChevronRight
  // Hermes can clear this provider's creds via the API.
  const canDisconnect = provider.disconnectable ?? provider.flow !== 'external'
  // External (CLI-managed) provider Hermes can't clear via the API, but ships a
  // command we can run in the embedded terminal (Electron shell only).
  const terminalDisconnect = !canDisconnect && Boolean(provider.disconnect_command) && canRunInTerminal()
  // Only fall back to a static "remove it elsewhere" hint when we offer no button.
  const showHint = !canDisconnect && !terminalDisconnect

  return (
    <SettingRow
      control={
        <div className="flex items-center gap-1">
          <Button
            aria-label={copy.manage(title)}
            className="text-muted-foreground"
            onClick={() => onSelect(provider)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Trail className="size-4" />
          </Button>
          {canDisconnect && (
            <Tip label={`${t.common.remove} ${title}`}>
              <Button
                aria-label={`${t.common.remove} ${title}`}
                className="text-muted-foreground hover:text-destructive"
                data-testid="account-remove"
                disabled={disconnecting}
                onClick={() => onDisconnect(provider)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {disconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                {t.common.remove}
              </Button>
            </Tip>
          )}
          {terminalDisconnect && (
            <Tip label={copy.disconnectInTerminal}>
              <Button
                aria-label={`${copy.disconnect} ${title}`}
                className="text-muted-foreground hover:text-destructive"
                data-testid="account-remove"
                onClick={() => onTerminalDisconnect(provider)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
                {t.common.remove}
              </Button>
            </Tip>
          )}
          {showHint && (
            <Tip label={provider.disconnect_hint || copy.removeExternalGeneric(title)}>
              <Button
                aria-label={`${credentialCopy.howToRemove} ${title}`}
                className="text-muted-foreground"
                data-testid="account-how-to-remove"
                onClick={() => void explainRemoval(provider, title)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {credentialCopy.howToRemove}
              </Button>
            </Tip>
          )}
        </div>
      }
      hint={hasKeyPath ? (keyWords?.[1] ?? '') : t.onboarding.flowSubtitles[provider.flow]}
      title={
        <RowButton className="flex min-w-0 items-center gap-2 text-left" onClick={() => onSelect(provider)}>
          <span className="truncate">{(hasKeyPath && keyWords?.[0]) || title}</span>
          <span className="inline-flex shrink-0 items-center gap-1 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            <Check className="size-3" />
            {copy.connected}
          </span>
        </RowButton>
      }
    />
  )
}

// Providers Hermes cannot clear (managed by another CLI, or backed by an API
// key): explain where removal lives using the runtime's own hint. The login
// `cli_command` is never offered here — it would re-add the account.
async function explainRemoval(provider: OAuthProvider, title: string) {
  const hint =
    provider.disconnect_hint?.trim() ||
    (provider.flow === 'external'
      ? translateNow('settings.providers.removeExternalGeneric', title)
      : translateNow('settings.providers.removeKeyManaged', title))

  const docsUrl = safeDocsUrl(provider.docs_url)

  const ok = await confirm({
    confirmLabel: docsUrl ? credentialCopy.openDocs : credentialCopy.understood,
    description: hint,
    title: `${credentialCopy.howToRemove.replace('…', '')} ${title}`
  })

  if (ok && docsUrl) {
    openExternalLink(docsUrl)
  }
}

function NoProviderKeys() {
  const { t } = useI18n()

  return (
    <div className="grid min-h-32 place-items-center px-4 py-8 text-center text-[length:var(--conversation-caption-font-size)] text-muted-foreground">
      {t.settings.providers.noProviderKeys}
    </div>
  )
}

// Surfaces the "Local / custom endpoint" entry point directly in the API-keys
// tab so users can add any OpenAI-compatible endpoint (Zyphra, vLLM, Ollama…)
// from the GUI. The composer pill and the providers "have an API key" affordance
// both dead-end on the env-var-driven key catalog, which never lists a custom
// endpoint — so without this row there is no reachable Desktop path to it.
// The whole row is the button so the click target and a11y focus match the
// visible area (the chevron + gutter are inside the button, not beside it).
// Pass reason: null — the onboarding overlay renders an unmapped reason string
// verbatim as a banner (see ReasonNotice in onboarding/index.tsx), and we don't
// want a raw identifier like "providers-keys-tab" showing as literal text.
function LocalEndpointRow({ onOpen }: { onOpen: (reason: null | string) => void }) {
  const { t } = useI18n()
  const copy = t.settings.providers.localEndpoint

  return (
    <SettingRow
      control={
        <Button onClick={() => onOpen(null)} size="sm" type="button" variant="outline">
          {copy.action}
          <ChevronRight className="size-3.5" />
        </Button>
      }
      hint={copy.description}
      title={copy.title}
    />
  )
}

export function ProvidersSettings({
  onClose,
  onConfigSaved,
  onMainModelChanged,
  onViewChange,
  view
}: ProvidersSettingsProps) {
  const { t } = useI18n()
  const keyWords = useKeysCopy()
  const { rowProps, vars } = useEnvCredentials(undefined, 'provider_keys')
  const navigate = useOptionalNavigate()
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([])
  const [openProvider, setOpenProvider] = useState<null | string>(null)
  const [disconnecting, setDisconnecting] = useState<null | string>(null)
  // Free-text filter for the API-keys view (provider name / env-var key / desc).
  const [keyQuery, setKeyQuery] = useState('')
  // The onboarding overlay owns the OAuth flow. Watch its `manual` flag so we
  // re-read connection state when the user finishes (or dismisses) a sign-in
  // they launched from this page — otherwise the cards keep their stale status.
  const onboardingActive = useStore($desktopOnboarding).manual

  const refreshOAuthProviders = useCallback(async () => {
    // OAuth providers are best-effort — a failure here just hides the panel.
    const { providers } = await listOAuthProviders()
    setOauthProviders(providers)
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      if (onboardingActive) {
        return
      }

      try {
        const { providers } = await listOAuthProviders()

        if (!cancelled) {
          setOauthProviders(providers)
        }
      } catch {
        // Ignore — the OAuth panel just won't render.
      }
    })()

    return () => void (cancelled = true)
  }, [onboardingActive])

  // External (CLI-managed) providers can't be cleared via the API by design —
  // Hermes never deletes creds another tool owns behind a silent API call.
  // Instead we run the documented removal command in the embedded terminal so
  // the user sees exactly what executes, then return them to chat to watch it.
  async function handleTerminalDisconnect(provider: OAuthProvider) {
    const command = provider.disconnect_command

    if (!command) {
      return
    }

    const name = providerTitle(provider)

    await runRemoval(
      {
        command,
        id: provider.id,
        kind: 'external',
        label: name,
        perform: async () => {
          // Leave the settings overlay so the terminal pane (chat-only) is visible.
          onClose()
          runInTerminal(command)
        },
        surface: 'accounts'
      },
      {
        notice: { message: t.settings.providers.removeTerminalRunning(name), title: t.settings.providers.removedTitle }
      }
    )
  }

  async function handleDisconnect(provider: OAuthProvider) {
    const name = providerTitle(provider)
    const active = await findActiveProviderFor({ oauthId: provider.id })

    const result = await runRemoval(
      {
        docsUrl: provider.docs_url,
        id: provider.id,
        isActiveProvider: Boolean(active),
        kind: 'oauth',
        label: name,
        providerSlug: active?.slug,
        surface: 'accounts'
      },
      {
        notice: { message: t.settings.providers.removedMessage(name), title: t.settings.providers.removedTitle },
        onBusy: busy => setDisconnecting(busy ? provider.id : null)
      }
    )

    if (!result?.ok) {
      return
    }

    await refreshOAuthProviders().catch(() => undefined)

    if (active) {
      navigate?.(MODEL_SETTINGS_PATH)
    }
  }

  if (!vars) {
    return <SettingsSkeleton search sections={[{ rows: 6 }]} />
  }

  const hasOauth = oauthProviders.length > 0
  // The sidebar subnav owns the Accounts/API-keys split now; with no OAuth
  // providers there's nothing for the "Accounts" view to show, so fall to keys.
  const showApiKeys = view === 'keys' || (!hasOauth && view !== 'custom-endpoints')

  const keyGroups = buildProviderKeyGroups(vars)

  if (showApiKeys) {
    const q = normalize(keyQuery)

    const visibleGroups = q
      ? keyGroups.filter(group => {
          const haystack = [
            group.name,
            keyWords.providers[group.name] ?? '',
            group.primary[0],
            ...group.advanced.map(([k]) => k)
          ]

          return haystack.some(s => s.toLowerCase().includes(q))
        })
      : keyGroups

    return (
      <SettingsContent>
        <LocalEndpointRow onOpen={startManualLocalEndpoint} />
        {keyGroups.length > 0 ? (
          <div className="grid gap-3">
            <SearchField
              aria-label={t.settings.providers.searchKeys}
              containerClassName="w-full"
              onChange={setKeyQuery}
              placeholder={t.settings.providers.searchKeys}
              value={keyQuery}
            />
            {visibleGroups.length > 0 ? (
              <div className="grid">
                {visibleGroups.map(group => (
                  <ProviderKeyGroupRows
                    expanded={openProvider === group.name}
                    group={group}
                    key={group.name}
                    onExpand={() => setOpenProvider(group.name)}
                    onToggle={() => setOpenProvider(prev => (prev === group.name ? null : group.name))}
                    rowProps={rowProps}
                  />
                ))}
              </div>
            ) : (
              <div className="grid min-h-24 place-items-center px-4 py-6 text-center text-[length:var(--conversation-caption-font-size)] text-muted-foreground">
                {t.settings.providers.noKeysMatch}
              </div>
            )}
          </div>
        ) : (
          <NoProviderKeys />
        )}
      </SettingsContent>
    )
  }

  if (view === 'custom-endpoints') {
    return <CustomEndpointsSettings onConfigSaved={onConfigSaved} onMainModelChanged={onMainModelChanged} />
  }

  return (
    <SettingsContent>
      <OAuthPicker
        disconnecting={disconnecting}
        onDisconnect={provider => void handleDisconnect(provider)}
        onTerminalDisconnect={provider => void handleTerminalDisconnect(provider)}
        onWantApiKey={() => onViewChange('keys')}
        onWantKeyFor={envKey => {
          const group = keyGroups.find(g => g.primary[0] === envKey || g.advanced.some(([k]) => k === envKey))

          setKeyQuery('')
          setOpenProvider(group?.name ?? null)
          onViewChange('keys')
        }}
        providers={oauthProviders}
      />
    </SettingsContent>
  )
}

interface ProvidersSettingsProps {
  onClose: () => void
  onConfigSaved?: () => void
  onMainModelChanged?: (provider: string, model: string) => void
  onViewChange: (view: ProviderView) => void
  view: ProviderView
}
