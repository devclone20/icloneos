import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  getAuxiliaryModels,
  getGlobalModelInfo,
  getGlobalModelOptions,
  getMoaModels,
  getRecommendedDefaultModel,
  listOAuthProviders,
  saveHermesConfig,
  setEnvVar,
  setModelAssignment
} from '@/hermes'
import type { AuxiliaryModelsResponse, MoaConfigResponse, ModelOptionProvider, StaleAuxAssignment } from '@/hermes'
import { useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { DEFAULT_REASONING_EFFORT } from '@/lib/reasoning-effort'
import { setMainModelAssignment } from '@/store/cron-model-impact'
import { notifyError, readableError } from '@/store/notifications'
import { startManualLocalEndpoint, startManualOnboarding, startManualProviderOAuth } from '@/store/onboarding'
import type { OAuthProvider } from '@/types/hermes'

import { hermesConfigCacheWriter, invalidateHermesConfig, useHermesConfigRecord } from '../hooks/use-config-record'
import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'

import {
  $credentialRemoved,
  ACCOUNTS_SETTINGS_PATH,
  clearCredentialRemoved,
  credentialRemovedFor,
  providerCredentials,
  type RemovalTarget,
  runRemoval,
  useOptionalNavigate
} from './credential-removal'
import { getNested, setNested } from './helpers'
import { AuxiliaryModelsSection } from './model-auxiliary'
import { MainModelRows } from './model-main-rows'
import { MoaSection, useMoaEditor } from './model-moa'
import { isRestartRequiredError } from './model-restart'
import type { RemovalPlan } from './model-settings-parts'
import {
  AUX_TASKS,
  getEnvVarsOrNull,
  isFastTier,
  isProviderReady,
  ModelSettingsSkeleton,
  NO_PROVIDERS,
  removalPlanFor,
  RestartRequiredNotice,
  StaleAuxWarning
} from './model-settings-parts'
import { useDeepLinkHighlight } from './use-deep-link-highlight'

export { ModelSettingsSkeleton, withActive } from './model-settings-parts'

interface ModelSettingsProps {
  /** Notified after the main model is applied, so live UI stores can sync. */
  onMainModelChanged?: (provider: string, model: string) => void
  /** Shared settings "Applies to" scope: a concrete profile to edit instead of
   *  the app's active one, or undefined to follow the active profile (default).
   *  Request-shaped on purpose — the API helpers treat `null` as "deliberately
   *  target the primary/default backend", so this prop never carries null. */
  scopeProfile?: string
}

export function ModelSettings({ onMainModelChanged, scopeProfile }: ModelSettingsProps) {
  const { t } = useI18n()
  const m = t.settings.model
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [restartRequired, setRestartRequired] = useState(false)
  const [restartingBackend, setRestartingBackend] = useState(false)
  const [mainModel, setMainModel] = useState<{ model: string; provider: string } | null>(null)
  const [removingCredentials, setRemovingCredentials] = useState(false)
  // What still authenticates the provider after the last removal on this page.
  const [remainingAfterRemoval, setRemainingAfterRemoval] = useState<null | { labels: string[]; slug: string }>(null)
  const navigate = useOptionalNavigate()
  const [providers, setProviders] = useState<ModelOptionProvider[]>([])
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [auxiliary, setAuxiliary] = useState<AuxiliaryModelsResponse | null>(null)
  const [moa, setMoa] = useState<MoaConfigResponse | null>(null)
  const [selectedMoaPreset, setSelectedMoaPreset] = useState('')
  const [newMoaPresetName, setNewMoaPresetName] = useState('')
  // agent.* defaults round-trip through the shared config cache (read → write
  // back the whole record), so a save here shows in the MCP/model surfaces.
  const { data: config } = useHermesConfigRecord(scopeProfile)
  const setConfig = useMemo(() => hermesConfigCacheWriter(scopeProfile), [scopeProfile])
  const [applying, setApplying] = useState(false)
  const [editingAuxTask, setEditingAuxTask] = useState<null | string>(null)
  const [auxDraft, setAuxDraft] = useState<{ model: string; provider: string }>({ model: '', provider: '' })
  // Aux slots reported stale by the backend immediately after a main-model
  // switch (provider differs from the new main). Cleared on next switch/reset.
  const [switchStaleAux, setSwitchStaleAux] = useState<StaleAuxAssignment[]>([])
  // Inline API-key entry for picking an unconfigured `api_key` provider in
  // place — mirrors the onboarding ApiKeyForm but scoped to the model picker.
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [activating, setActivating] = useState(false)

  // Deep link from the vision Capabilities detail (?tab=config:model&aux=vision):
  // scroll the auxiliary task row into view and flash it once the list loads.
  useDeepLinkHighlight({
    elementId: task => `aux-task-${task}`,
    param: 'aux',
    ready: task => AUX_TASKS.some(meta => meta.key === task)
  })

  // Every profile-scoped async here captures this and bails before writing back,
  // so a request in flight when the user switches profiles can't paint profile
  // A's models/providers into profile B (or fire onMainModelChanged for A).
  const profileEpoch = useRef(0)

  const refresh = useCallback(
    async ({ replaceSelection = false }: { replaceSelection?: boolean } = {}) => {
      const epoch = profileEpoch.current
      setLoading(true)
      setError('')
      setRestartRequired(false)

      try {
        // Each part loads on its own: one endpoint refusing (a restart pending after an agent update answers 503
        // on the model options) must not hide the parts that did answer — auxiliary models, Mixture of Agents.
        const [infoResult, optionsResult, auxiliaryResult, moaResult] = await Promise.allSettled([
          getGlobalModelInfo(scopeProfile),
          getGlobalModelOptions(undefined, scopeProfile),
          getAuxiliaryModels(scopeProfile),
          getMoaModels(scopeProfile)
        ])

        if (profileEpoch.current !== epoch) {
          return
        }

        if (infoResult.status === 'fulfilled') {
          const modelInfo = infoResult.value

          setMainModel({ model: modelInfo.model, provider: modelInfo.provider })

          if (replaceSelection) {
            setSelectedProvider(modelInfo.provider)
            setSelectedModel(modelInfo.model)
          } else {
            setSelectedProvider(prev => prev || modelInfo.provider)
            setSelectedModel(prev => prev || modelInfo.model)
          }
        }

        if (optionsResult.status === 'fulfilled') {
          setProviders(optionsResult.value.providers || [])
        }

        if (auxiliaryResult.status === 'fulfilled') {
          setAuxiliary(auxiliaryResult.value)
        }

        const moaModels = moaResult.status === 'fulfilled' ? moaResult.value : null

        setMoa(moaModels)

        if (moaModels) {
          setSelectedMoaPreset(prev => (prev && moaModels.presets[prev] ? prev : moaModels.default_preset))
        }

        // MoA is optional (older runtimes have no endpoint): its refusal is never an error of the pane.
        const failures = [infoResult, optionsResult, auxiliaryResult]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason as unknown)

        if (failures.some(isRestartRequiredError)) {
          setRestartRequired(true)
        } else if (failures.length) {
          setError(readableError(failures[0], m.loadFailed).message)
        }

        // The config record loads via its own shared query; a model switch can
        // change it server-side (aux slots), so nudge that cache to refetch.
        void invalidateHermesConfig(scopeProfile)
      } catch (err) {
        if (profileEpoch.current === epoch) {
          setError(readableError(err, m.loadFailed).message)
        }
      } finally {
        if (profileEpoch.current === epoch) {
          setLoading(false)
        }
      }
    },
    [m.loadFailed, scopeProfile]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const restartBackend = useCallback(async () => {
    setRestartingBackend(true)
    setError('')

    try {
      const result = await window.hermesDesktop?.restartBackend?.()

      if (!result?.ok) {
        setError(m.restartFailed)

        return
      }

      await refresh({ replaceSelection: true })
    } catch {
      setError(m.restartFailed)
    } finally {
      setRestartingBackend(false)
    }
  }, [m.restartFailed, refresh])

  // A profile switch swaps the backend under the mounted panel — reload for the
  // new profile (bumping the epoch first so any in-flight A request is discarded).
  useOnProfileSwitch(() => {
    profileEpoch.current += 1
    // The panel stays mounted across profile switches, so clear the previous
    // profile's draft selection before loading the new profile's source of
    // truth. Ordinary same-profile refreshes still preserve in-progress edits.
    setSelectedProvider('')
    setSelectedModel('')
    setApiKeyDraft('')
    void refresh({ replaceSelection: true })
  })

  const providerOptions = providers.length ? providers : NO_PROVIDERS

  // Radix renders a blank trigger when the controlled value has no matching
  // item. Keep a missing saved provider visible in the main selector while
  // leaving it out of the real inventory used for readiness/setup metadata.
  const mainProviderOptions = useMemo(
    () =>
      selectedProvider && !providers.some(provider => provider.slug === selectedProvider)
        ? [{ name: selectedProvider, slug: selectedProvider, models: [] }, ...providers]
        : providerOptions,
    [providerOptions, providers, selectedProvider]
  )

  // MoA reference/aggregator slots must never be the moa virtual provider —
  // that would create a recursive MoA tree (the backend rejects it on save).
  // Hide it from the slot selectors so it isn't offered as a dead choice.
  const moaSlotProviderOptions = providerOptions.filter(provider => (provider.slug || '').toLowerCase() !== 'moa')

  const selectedProviderRow = useMemo(
    () => providers.find(provider => provider.slug === selectedProvider),
    [providers, selectedProvider]
  )

  const selectedProviderModels = selectedProviderRow?.models ?? []

  // An unconfigured provider was picked: no credentials yet, so there are no
  // models to choose. `api_key` providers can be activated inline (paste key);
  // OAuth / external flows hand off to the onboarding sign-in.
  // After the active provider's credential is removed the page holds "choose a
  // provider" until the next successful model save (never auto-picks).
  const removedFlag = credentialRemovedFor(useStore($credentialRemoved), scopeProfile)
  const credentialRemovedHere = !!selectedProvider && removedFlag?.provider === selectedProvider
  const needsSetup = !!selectedProvider && (!isProviderReady(selectedProviderRow) || credentialRemovedHere)

  const remainingHere =
    selectedProviderRow && remainingAfterRemoval?.slug === selectedProviderRow.slug
      ? remainingAfterRemoval.labels
      : null

  // A provider still signed in through another credential keeps its control
  // even while the runtime's row catches up.
  const canRemoveCredentials =
    !!selectedProviderRow &&
    !selectedProviderRow.is_user_defined &&
    ((!needsSetup && selectedProviderRow.authenticated !== false) || (!!remainingHere && !credentialRemovedHere))

  const setupIsApiKey = needsSetup && selectedProviderRow?.auth_type === 'api_key' && !!selectedProviderRow?.key_env

  // Clear any half-typed key when switching provider so it can't leak across.
  useEffect(() => {
    setApiKeyDraft('')
  }, [selectedProvider])

  const auxDraftProviderModels = useMemo(
    () => providers.find(provider => provider.slug === auxDraft.provider)?.models ?? [],
    [auxDraft.provider, providers]
  )

  const modelsForProvider = useCallback(
    (provider: string) => providers.find(row => row.slug === provider)?.models ?? [],
    [providers]
  )

  const { currentMoaPreset, saveMoa, updateMoaPreset, updateMoaSlot } = useMoaEditor({
    moa,
    profileEpoch,
    scopeProfile,
    selectedMoaPreset,
    setApplying,
    setError,
    setMoa
  })

  const auxiliaryTaskLabel = useCallback((key: string) => m.tasks[key]?.name ?? m.tasks[key]?.label ?? key, [m.tasks])

  // Persistent mismatch: any aux slot pinned to a provider different from the
  // current main, regardless of whether the user just switched. Catches the
  // "I pinned aux months ago and forgot, now it bills a dead provider" case.
  const persistentStaleAux = useMemo<StaleAuxAssignment[]>(() => {
    const mainProvider = (mainModel?.provider ?? '').toLowerCase()

    if (!mainProvider || !auxiliary) {
      return []
    }

    return auxiliary.tasks
      .filter(entry => {
        const p = (entry.provider ?? '').toLowerCase()

        return p && p !== 'auto' && p !== mainProvider
      })
      .map(entry => ({ task: entry.task, provider: entry.provider, model: entry.model }))
  }, [auxiliary, mainModel])

  // Capabilities of the APPLIED main model — gates the profile-default
  // reasoning/speed controls the same way the composer picker gates per-model
  // edits (reasoning defaults on, fast defaults off when unreported).
  const mainCaps = useMemo(() => {
    const row = providers.find(provider => provider.slug === mainModel?.provider)

    return mainModel ? row?.capabilities?.[mainModel.model] : undefined
  }, [providers, mainModel])

  const reasoningSupported = mainCaps?.reasoning ?? true
  const fastSupported = mainCaps?.fast ?? false

  // Hand-written `reasoning_effort: false`/`off` reaches us as boolean false
  // ("false" once stringified) — show it as Off, not an empty select.
  const rawEffort = String(getNested(config ?? {}, 'agent.reasoning_effort') ?? '')
    .trim()
    .toLowerCase()

  const effortValue = rawEffort === 'false' || rawEffort === 'disabled' ? 'none' : rawEffort || DEFAULT_REASONING_EFFORT

  const fastOn = isFastTier(getNested(config ?? {}, 'agent.service_tier'))

  // Persist a single agent.* default by round-tripping the whole config record
  // (PUT /api/config replaces it) — optimistic, with rollback on failure.
  const writeAgentDefault = useCallback(
    async (key: string, value: string) => {
      if (!config) {
        return
      }

      const prev = config
      const next = setNested(config, key, value)
      setConfig(next)

      try {
        await saveHermesConfig(next, scopeProfile)
      } catch (err) {
        setConfig(prev)
        notifyError(err, m.defaultsFailed)
      }
    },
    [config, m.defaultsFailed, scopeProfile, setConfig]
  )

  // Paste an API key for the selected `api_key` provider, persist it, then
  // refresh so the now-authenticated provider's models populate. Auto-selects
  // the recommended default model so the user can Apply in one more click.
  const activateApiKeyProvider = useCallback(async () => {
    const keyEnv = selectedProviderRow?.key_env
    const slug = selectedProviderRow?.slug

    if (!keyEnv || !slug || !apiKeyDraft.trim()) {
      return
    }

    const epoch = profileEpoch.current
    setActivating(true)
    setError('')

    try {
      await setEnvVar(keyEnv, apiKeyDraft.trim(), scopeProfile)
      setApiKeyDraft('')
      clearCredentialRemoved(scopeProfile)

      // Pick a sensible default for the freshly-activated provider (mirrors
      // `hermes model` curation). Best-effort — fall through to the refreshed
      // model list if it fails.
      let nextModel = ''

      try {
        const rec = await getRecommendedDefaultModel(slug, scopeProfile)
        nextModel = rec.model || ''
      } catch {
        nextModel = ''
      }

      const options = await getGlobalModelOptions(undefined, scopeProfile)

      if (profileEpoch.current !== epoch) {
        return
      }

      setProviders(options.providers || [])
      const refreshedRow = options.providers?.find(p => p.slug === slug)
      const fallbackModel = refreshedRow?.models?.[0] ?? ''
      setSelectedModel(nextModel || fallbackModel)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setActivating(false)
    }
  }, [apiKeyDraft, scopeProfile, selectedProviderRow])

  // OAuth / external providers can't be activated with a pasted key — hand off
  // to the shared onboarding flow scoped to this provider's real sign-in. The
  // custom / local endpoint is NOT an OAuth provider, so it gets the dedicated
  // local-endpoint form (URL + optional API key) instead of being dead-ended
  // on the OAuth picker (the original "booted back to the first screen" loop).
  // Model page "Remove credentials for {provider}". Authenticated rows carry no
  // key_env/auth_type, so the plan is resolved from GET /api/env's provider
  // grouping (api_key) or the OAuth catalog (slug → id, never assumed equal);
  // only when neither holds a removable credential does the button hand off to
  // Providers → Accounts — and it is labelled that way.
  const [removalPlan, setRemovalPlan] = useState<null | { oauthProviders: OAuthProvider[]; plan: RemovalPlan }>(null)
  const [removalPlanEpoch, setRemovalPlanEpoch] = useState(0)
  const planRow = canRemoveCredentials ? selectedProviderRow : undefined

  useEffect(() => {
    let cancelled = false
    setRemovalPlan(null)

    if (!planRow) {
      return
    }
    void (async () => {
      const [vars, oauthProviders] = await Promise.all([
        getEnvVarsOrNull(scopeProfile),
        Promise.resolve()
          .then(() => listOAuthProviders())
          .then(response => response?.providers ?? [])
          .catch(() => [])
      ])

      if (!cancelled) {
        const labels = providerCredentials(planRow, vars, oauthProviders).map(credential => credential.label)
        setRemovalPlan({ oauthProviders, plan: removalPlanFor(planRow, vars, oauthProviders) })
        // Keep "still signed in through …" true to what is stored now.
        setRemainingAfterRemoval(prev =>
          prev?.slug === planRow.slug ? (labels.length > 0 ? { labels, slug: planRow.slug } : null) : prev
        )
      }
    })()

    return () => void (cancelled = true)
  }, [planRow, removalPlanEpoch, scopeProfile])

  const activeRemovalPlan = removalPlan && planRow && removalPlan.plan.slug === planRow.slug ? removalPlan.plan : null
  const planOAuthProviders = removalPlan?.oauthProviders

  const removeProviderCredentials = useCallback(async () => {
    const row = selectedProviderRow

    if (!row || !activeRemovalPlan) {
      return
    }

    // Re-read GET /api/env at click time: the key may have been removed or
    // replaced on the Keys page since the label was resolved.
    const plan =
      activeRemovalPlan.kind === 'api_key'
        ? removalPlanFor(row, await getEnvVarsOrNull(scopeProfile), planOAuthProviders ?? [])
        : activeRemovalPlan

    if (plan.kind === 'manage') {
      navigate?.(ACCOUNTS_SETTINGS_PATH)

      return
    }

    const isActive = Boolean(row.is_current) || mainModel?.provider === row.slug
    const remaining = plan.remaining.map(credential => credential.label)

    const target: RemovalTarget =
      plan.kind === 'api_key'
        ? {
            id: plan.keyEnv,
            isActiveProvider: isActive,
            kind: 'api_key',
            label: plan.keyEnv,
            profile: scopeProfile,
            providerLabel: row.name,
            providerSlug: row.slug,
            remaining,
            surface: 'model'
          }
        : {
            docsUrl: plan.oauth.docs_url,
            id: plan.oauth.id,
            isActiveProvider: isActive,
            kind: 'oauth',
            label: row.name,
            profile: scopeProfile,
            providerLabel: row.name,
            providerSlug: row.slug,
            remaining,
            surface: 'model'
          }

    const result = await runRemoval(target, { onBusy: setRemovingCredentials })

    if (result?.ok) {
      setRemainingAfterRemoval(remaining.length > 0 ? { labels: remaining, slug: row.slug } : null)
      setRemovalPlanEpoch(epoch => epoch + 1)
      await refresh()
    }
  }, [activeRemovalPlan, mainModel?.provider, navigate, planOAuthProviders, refresh, scopeProfile, selectedProviderRow])

  const startProviderSetup = useCallback(() => {
    const rowSlug = selectedProviderRow?.slug.trim() ?? ''
    const slug = rowSlug || selectedProvider.trim()

    if (!slug) {
      return
    }

    const lower = slug.toLowerCase()

    if (lower === 'custom' || lower === 'local' || lower.startsWith('custom:')) {
      startManualLocalEndpoint()
    } else if (rowSlug) {
      startManualProviderOAuth(rowSlug)
    } else {
      // An absent row has no trustworthy auth metadata. Open the generic
      // provider picker instead of deep-linking an unknown or stale slug.
      startManualOnboarding()
    }
  }, [selectedProvider, selectedProviderRow])

  const applyMainModel = useCallback(async () => {
    if (!selectedProvider || !selectedModel) {
      return
    }

    const epoch = profileEpoch.current
    setApplying(true)
    setError('')

    try {
      const result = await setMainModelAssignment(
        {
          model: selectedModel,
          provider: selectedProvider,
          ...(selectedProviderRow?.api_url ? { base_url: selectedProviderRow.api_url } : {})
        },
        scopeProfile
      )

      if (profileEpoch.current !== epoch) {
        return
      }

      const provider = result.provider || selectedProvider
      const model = result.model || selectedModel
      setMainModel({ provider, model })
      setSwitchStaleAux(result.stale_aux ?? [])
      clearCredentialRemoved(scopeProfile)

      // Live UI stores mirror the ACTIVE profile's model; a scoped apply
      // changed a different profile and must not repaint them.
      if (scopeProfile == null) {
        onMainModelChanged?.(provider, model)
      }

      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setApplying(false)
    }
  }, [onMainModelChanged, refresh, scopeProfile, selectedModel, selectedProvider, selectedProviderRow])

  // Sibling of the applyMainModel endpoint passthrough (#65254): auxiliary
  // assignments targeting a user-defined provider must carry that provider's
  // endpoint too, or the backend pins the slot without a base_url and the
  // aux resolver falls back to the (possibly different, possibly cleared)
  // main endpoint.
  const endpointForProvider = useCallback(
    (provider: string) => {
      const row = providers.find(entry => entry.slug === provider)

      return row?.api_url ? { base_url: row.api_url } : {}
    },
    [providers]
  )

  const setAuxiliaryToMain = useCallback(
    async (task: string) => {
      if (!mainModel) {
        return
      }

      setApplying(true)
      setError('')

      try {
        await setModelAssignment(
          {
            model: mainModel.model,
            provider: mainModel.provider,
            scope: 'auxiliary',
            task,
            ...endpointForProvider(mainModel.provider)
          },
          scopeProfile
        )
        await refresh()
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setApplying(false)
      }
    },
    [endpointForProvider, mainModel, refresh, scopeProfile]
  )

  const applyAuxiliaryDraft = useCallback(
    async (task: string) => {
      if (!auxDraft.provider || !auxDraft.model) {
        return
      }

      setApplying(true)
      setError('')

      try {
        await setModelAssignment(
          {
            model: auxDraft.model,
            provider: auxDraft.provider,
            scope: 'auxiliary',
            task,
            ...endpointForProvider(auxDraft.provider)
          },
          scopeProfile
        )
        setEditingAuxTask(null)
        await refresh()
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setApplying(false)
      }
    },
    [auxDraft, endpointForProvider, refresh, scopeProfile]
  )

  const beginAuxiliaryEdit = useCallback(
    (task: string) => {
      const current = auxiliary?.tasks.find(entry => entry.task === task)

      const initialProvider =
        current?.provider && current.provider !== 'auto' ? current.provider : (mainModel?.provider ?? '')

      const initialModel = current?.model || mainModel?.model || ''
      setAuxDraft({ provider: initialProvider, model: initialModel })
      setEditingAuxTask(task)
    },
    [auxiliary, mainModel]
  )

  const resetAuxiliaryModels = useCallback(async () => {
    if (!mainModel) {
      return
    }

    setApplying(true)
    setError('')

    try {
      await setModelAssignment(
        {
          model: mainModel.model,
          provider: mainModel.provider,
          scope: 'auxiliary',
          task: '__reset__'
        },
        scopeProfile
      )
      setSwitchStaleAux([])
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setApplying(false)
    }
  }, [mainModel, refresh, scopeProfile])

  if (loading && !mainModel) {
    return <ModelSettingsSkeleton />
  }

  return (
    <div className="grid gap-6">
      <section>
        <MainModelRows
          activateApiKeyProvider={activateApiKeyProvider}
          activating={activating}
          activeRemovalPlan={activeRemovalPlan}
          apiKeyDraft={apiKeyDraft}
          applying={applying}
          applyMainModel={applyMainModel}
          canRemoveCredentials={canRemoveCredentials}
          credentialRemovedHere={credentialRemovedHere}
          effortValue={effortValue}
          fastOn={fastOn}
          mainProviderOptions={mainProviderOptions}
          needsSetup={needsSetup}
          remainingHere={remainingHere}
          removeProviderCredentials={removeProviderCredentials}
          removingCredentials={removingCredentials}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedProviderModels={selectedProviderModels}
          selectedProviderRow={selectedProviderRow}
          setApiKeyDraft={setApiKeyDraft}
          setSelectedModel={setSelectedModel}
          setSelectedProvider={setSelectedProvider}
          setupIsApiKey={setupIsApiKey}
          showDefaults={!!config && !!mainModel}
          showFast={fastSupported}
          showReasoning={reasoningSupported}
          startProviderSetup={startProviderSetup}
          writeAgentDefault={writeAgentDefault}
        />
        {restartRequired && (
          <div className="mt-2">
            <RestartRequiredNotice
              label={restartingBackend ? m.restartingBackend : m.restartBackend}
              message={m.restartRequired}
              onRestart={() => void restartBackend()}
              restarting={restartingBackend}
              title={m.restartTitle}
            />
          </div>
        )}
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
        {switchStaleAux.length > 0 && (
          <div className="mt-2">
            <StaleAuxWarning
              applying={applying}
              onReset={() => void resetAuxiliaryModels()}
              slots={switchStaleAux}
              taskLabel={auxiliaryTaskLabel}
            />
          </div>
        )}
      </section>

      <AuxiliaryModelsSection
        applyAuxiliaryDraft={applyAuxiliaryDraft}
        applying={applying}
        auxDraft={auxDraft}
        auxDraftProviderModels={auxDraftProviderModels}
        auxiliary={auxiliary}
        auxiliaryTaskLabel={auxiliaryTaskLabel}
        beginAuxiliaryEdit={beginAuxiliaryEdit}
        editingAuxTask={editingAuxTask}
        hasMainModel={!!mainModel}
        persistentStaleAux={persistentStaleAux}
        providerOptions={providerOptions}
        providersLoaded={providers.length > 0}
        resetAuxiliaryModels={resetAuxiliaryModels}
        setAuxDraft={setAuxDraft}
        setAuxiliaryToMain={setAuxiliaryToMain}
        setEditingAuxTask={setEditingAuxTask}
        switchStaleAux={switchStaleAux}
      />
      {moa && currentMoaPreset && (
        <MoaSection
          applying={applying}
          currentMoaPreset={currentMoaPreset}
          moa={moa}
          moaSlotProviderOptions={moaSlotProviderOptions}
          modelsForProvider={modelsForProvider}
          newMoaPresetName={newMoaPresetName}
          saveMoa={saveMoa}
          selectedMoaPreset={selectedMoaPreset}
          setNewMoaPresetName={setNewMoaPresetName}
          setSelectedMoaPreset={setSelectedMoaPreset}
          updateMoaPreset={updateMoaPreset}
          updateMoaSlot={updateMoaSlot}
        />
      )}
    </div>
  )
}
