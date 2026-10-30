import { useCallback, useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Tip } from '@/components/ui/tooltip'
import { getEnvVars, getMemoryProviderConfig, saveMemoryProviderConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { SlidersHorizontal, Trash2 } from '@/lib/icons'
import { notifyError } from '@/store/notifications'
import type { EnvVarInfo, MemoryProviderConfig, MemoryProviderField } from '@/types/hermes'

import { credentialCopy, envKeyForMemorySecret, runRemoval } from '../credential-removal'
import { Pill } from '../primitives'
import { SettingRow } from '../setting-row'

import { FieldControl, FieldTitle } from './field-control'
import { ProviderConfigModal } from './provider-config-modal'

// The runtime declares `env_key` on its schema but its payload omits it, so the
// key is derived from GET /api/env (see envKeyForMemorySecret).
const withEnvKey = (field: MemoryProviderField) => field as MemoryProviderField & { env_key?: string }

// Inline fields only: the compact panel must never re-write modal-owned keys.
function seedValues(config: MemoryProviderConfig): Record<string, string> {
  return Object.fromEntries(
    config.fields.filter(field => field.inline).map(field => [field.key, field.kind === 'secret' ? '' : field.value])
  )
}

export function ProviderConfigPanel({ profile, provider }: { profile?: string; provider: string }) {
  const { t } = useI18n()
  const c = t.settings.config
  const [config, setConfig] = useState<MemoryProviderConfig | null>(null)
  const [loadError, setLoadError] = useState<null | string>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [removing, setRemoving] = useState<null | string>(null)
  const [envVars, setEnvVars] = useState<null | Record<string, EnvVarInfo>>(null)

  const refresh = useCallback(async () => {
    try {
      const [next, vars] = await Promise.all([
        getMemoryProviderConfig(provider, profile),
        Promise.resolve()
          .then(() => getEnvVars(profile))
          .catch(() => null)
      ])

      const seed = seedValues(next)
      setEnvVars(vars)
      setConfig(next)
      setValues(seed)
      setSaved(seed)
      setLoadError(null)
    } catch (err) {
      setConfig(null)
      setLoadError(err instanceof Error ? err.message : c.memoryProviderLoadFailed)
    }
  }, [c.memoryProviderLoadFailed, profile, provider])

  useEffect(() => {
    setConfig(null)
    void refresh()
  }, [refresh])

  const removeSecret = useCallback(
    async (field: MemoryProviderField) => {
      const envKey = envKeyForMemorySecret(provider, withEnvKey(field), envVars)

      if (!envKey) {
        return
      }

      const result = await runRemoval(
        {
          id: envKey,
          kind: 'memory_secret',
          label: field.label,
          profile,
          surface: 'memory'
        },
        { onBusy: busy => setRemoving(busy ? field.key : null) }
      )

      if (result?.ok) {
        await refresh()
      }
    },
    [envVars, profile, provider, refresh]
  )

  // Autosave, matching the settings page around the panel: one-key partial PUT
  // on commit, silent on success, no full refresh (it would reset sibling drafts).
  const commitField = useCallback(
    async (field: MemoryProviderField, value: string) => {
      if (value === (saved[field.key] ?? '') || (field.kind === 'secret' && !value.trim())) {
        return
      }

      try {
        await saveMemoryProviderConfig(provider, { [field.key]: value }, profile)

        if (field.kind === 'secret') {
          setValues(current => ({ ...current, [field.key]: '' }))
          setConfig(
            current =>
              current && {
                ...current,
                fields: current.fields.map(f => (f.key === field.key ? { ...f, is_set: true } : f))
              }
          )
        } else {
          setSaved(current => ({ ...current, [field.key]: value }))
        }
      } catch (err) {
        notifyError(err, c.memoryProviderSaveFailed(field.label))
      }
    },
    [c, profile, provider, saved]
  )

  // Providers without a declared config surface (e.g. builtin) render nothing.
  if (config && config.fields.length === 0) {
    return null
  }

  if (!config) {
    if (loadError) {
      return (
        <SettingRow
          control={
            <Button onClick={() => void refresh()} size="sm" type="button" variant="secondary">
              {t.common.retry}
            </Button>
          }
          error={loadError}
          title={c.memoryProviderLoadFailed}
        />
      )
    }

    return <PageLoader className="min-h-24" label={c.memoryProviderLoading} />
  }

  const inlineFields = config.fields.filter(field => field.inline)
  const secretFields = config.fields.filter(field => field.kind === 'secret')
  const hasFullConfig = config.fields.some(field => !field.inline)
  // A blank save is ignored by both the panel and the runtime, so a stored
  // secret is removed through its env var. A set secret with no env var behind
  // it (e.g. honcho.json) cannot be removed here — the panel says where it is.
  // GET /api/env unreadable (`envVars === null`): neither claim can be made.
  const secretEnvKey = (field: MemoryProviderField) => envKeyForMemorySecret(provider, withEnvKey(field), envVars)
  const setSecrets = secretFields.filter(field => field.is_set)
  const removableSecrets = envVars ? setSecrets.filter(field => Boolean(secretEnvKey(field))) : []
  const externalSecrets = envVars ? setSecrets.filter(field => !secretEnvKey(field)) : []
  const uncheckedSecrets = envVars ? [] : setSecrets

  return (
    <section className="py-1">
      <div className="flex items-center gap-2 py-2">
        <button
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded(open => !open)}
          type="button"
        >
          <DisclosureCaret open={expanded} />
          <span className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">
            {c.memoryProviderSettings(config.label)}
          </span>
          {secretFields.map(field => (
            <Pill key={field.key}>
              {field.is_set ? c.memoryProviderSecretSet(field.label) : c.memoryProviderSecretNotSet(field.label)}
            </Pill>
          ))}
        </button>
        {removableSecrets.map(field => (
          <Tip key={field.key} label={credentialCopy.removeLabel(field.label)}>
            <Button
              aria-label={credentialCopy.removeLabel(field.label)}
              className="text-muted-foreground hover:text-destructive"
              data-testid="memory-secret-remove"
              disabled={removing === field.key}
              onClick={() => void removeSecret(field)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Trash2 />
            </Button>
          </Tip>
        ))}
        {externalSecrets.map(field => (
          <span className="text-xs text-muted-foreground" data-testid="memory-secret-elsewhere" key={field.key}>
            {credentialCopy.memorySecretElsewhere(field.label)}
          </span>
        ))}
        {uncheckedSecrets.map(field => (
          <span className="text-xs text-muted-foreground" data-testid="memory-secret-unchecked" key={field.key}>
            {credentialCopy.memorySecretUnchecked(field.label)}
          </span>
        ))}
        {hasFullConfig && (
          <Button onClick={() => setShowModal(true)} size="sm" type="button" variant="secondary">
            <SlidersHorizontal className="size-3.5" />
            {c.memoryProviderFullConfig}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="ml-1.5 border-l-2 border-(--ui-accent-secondary)/25 pb-4 pl-4 pr-4">
          {inlineFields.map(field => (
            <div className="border-b border-border/40 last:border-b-0" key={field.key}>
              <SettingRow
                control={
                  <FieldControl
                    field={field}
                    onChange={value => setValues(current => ({ ...current, [field.key]: value }))}
                    onCommit={value => void commitField(field, value)}
                    value={values[field.key] ?? ''}
                  />
                }
                field
                hint={field.description}
                title={<FieldTitle field={field} />}
              />
            </div>
          ))}
        </div>
      )}

      {hasFullConfig && (
        <ProviderConfigModal
          config={config}
          onOpenChange={setShowModal}
          onSaved={refresh}
          open={showModal}
          profile={profile}
          provider={provider}
        />
      )}
    </section>
  )
}
