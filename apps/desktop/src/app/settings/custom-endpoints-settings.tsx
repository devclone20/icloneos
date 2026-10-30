import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import {
  activateCustomEndpoint,
  deleteCustomEndpoint,
  getCustomEndpoints,
  saveCustomEndpoint,
  validateCustomEndpoint
} from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Check, Globe, Loader2, Plus, Save, Trash2, Zap } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import type { CustomEndpoint, CustomEndpointUpdate } from '@/types/hermes'

import { credentialCopy, runRemoval } from './credential-removal'
import { customEndpointsCopyNow, useCustomEndpointsCopy } from './custom-endpoints-copy'
import { EmptyState, Pill, SectionHeading, SettingsContent, SettingsSkeleton } from './primitives'
import { SettingRow } from './setting-row'

interface CustomEndpointsSettingsProps {
  onConfigSaved?: () => void
  onMainModelChanged?: (provider: string, model: string) => void
}

interface EndpointForm {
  apiKey: string
  baseUrl: string
  contextLength: string
  discoverModels: boolean
  id: string
  makeDefault: boolean
  model: string
  name: string
}

const EMPTY_FORM: EndpointForm = {
  apiKey: '',
  baseUrl: '',
  contextLength: '',
  discoverModels: true,
  id: '',
  makeDefault: true,
  model: '',
  name: ''
}

function formFromEndpoint(endpoint: CustomEndpoint): EndpointForm {
  return {
    apiKey: '',
    baseUrl: endpoint.base_url,
    contextLength: endpoint.context_length ? String(endpoint.context_length) : '',
    discoverModels: endpoint.discover_models,
    id: endpoint.id,
    makeDefault: Boolean(endpoint.is_current),
    model: endpoint.model,
    name: endpoint.name
  }
}

function toPayload(form: EndpointForm, models?: string[]): CustomEndpointUpdate {
  const contextLength = Number.parseInt(form.contextLength, 10)

  return {
    id: form.id.trim() || undefined,
    name: form.name.trim(),
    base_url: form.baseUrl.trim(),
    model: form.model.trim(),
    api_key: form.apiKey.trim() || undefined,
    context_length: Number.isFinite(contextLength) && contextLength > 0 ? contextLength : undefined,
    discover_models: form.discoverModels,
    make_default: form.makeDefault,
    models: models?.length ? models : undefined
  }
}

export function CustomEndpointsSettings({ onConfigSaved, onMainModelChanged }: CustomEndpointsSettingsProps) {
  const { t } = useI18n()
  const w = t.settings.providers.endpoints
  const c = useCustomEndpointsCopy()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [activating, setActivating] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [endpoints, setEndpoints] = useState<CustomEndpoint[]>([])
  const [form, setForm] = useState<EndpointForm>(EMPTY_FORM)
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])

  async function refresh() {
    const data = await getCustomEndpoints()
    setEndpoints(data.endpoints)
  }

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const data = await getCustomEndpoints()

        if (cancelled) {
          return
        }

        setEndpoints(data.endpoints)
        const current = data.endpoints.find(endpoint => endpoint.is_current) ?? data.endpoints[0]

        if (current) {
          setForm(formFromEndpoint(current))
          setDiscoveredModels(current.models)
        }
      } catch (err) {
        notifyError(err, customEndpointsCopyNow().loadFailed)
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  async function handleSave() {
    try {
      setSaving(true)
      const response = await saveCustomEndpoint(toPayload(form, discoveredModels))
      setEndpoints(response.endpoints)
      const saved = response.endpoints.find(endpoint => endpoint.id === response.id)

      if (saved) {
        setForm(formFromEndpoint(saved))
        setDiscoveredModels(saved.models)
      }

      if (saved && saved.is_current) {
        onMainModelChanged?.(saved.id, saved.model)
      }

      triggerHaptic('success')
      onConfigSaved?.()
      notify({ kind: 'success', message: c.saved })
    } catch (err) {
      notifyError(err, c.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  async function handleValidate() {
    try {
      setTesting(true)
      const response = await validateCustomEndpoint(toPayload(form))
      setDiscoveredModels(response.models)

      if (response.ok) {
        if (!form.model && response.models[0]) {
          setForm(current => ({ ...current, model: response.models[0] }))
        }

        notify({
          kind: 'success',
          message: c.reachable(response.models.length)
        })
      } else {
        notify({
          kind: response.reachable ? 'warning' : 'error',
          message: response.message || c.validationFailedMessage
        })
      }
    } catch (err) {
      notifyError(err, c.validationFailed)
    } finally {
      setTesting(false)
    }
  }

  async function handleActivate(endpoint: CustomEndpoint) {
    try {
      setActivating(endpoint.id)
      const response = await activateCustomEndpoint(endpoint.id)
      await refresh()
      onConfigSaved?.()
      onMainModelChanged?.(response.provider, response.model)
      triggerHaptic('success')
    } catch (err) {
      notifyError(err, c.activationFailed)
    } finally {
      setActivating(null)
    }
  }

  async function handleDelete(endpoint: CustomEndpoint) {
    const result = await runRemoval(
      {
        id: endpoint.id,
        kind: 'custom_endpoint',
        label: endpoint.name,
        perform: async () => setEndpoints((await deleteCustomEndpoint(endpoint.id)).endpoints),
        surface: 'custom_endpoints'
      },
      { onBusy: busy => setDeleting(busy ? endpoint.id : null) }
    )

    if (!result?.ok) {
      return
    }

    if (result.result === 'already_removed') {
      await getCustomEndpoints()
        .then(data => setEndpoints(data.endpoints))
        .catch(() => undefined)
    }

    if (form.id === endpoint.id) {
      setForm(EMPTY_FORM)
      setDiscoveredModels([])
    }

    onConfigSaved?.()
    triggerHaptic('success')
  }

  if (loading) {
    return <SettingsSkeleton sections={[{ heading: true, rows: 3 }]} />
  }

  const allModelOptions = Array.from(new Set([...discoveredModels, form.model].filter(Boolean)))
  const canSave = form.name.trim() && form.baseUrl.trim() && form.model.trim()

  return (
    <SettingsContent>
      <div className="space-y-6">
        <section>
          <SectionHeading icon={Globe} meta={`${endpoints.length}`} title={w.heading} />
          {endpoints.length ? (
            endpoints.map(endpoint => (
              <SettingRow
                control={
                  <div className="flex items-center gap-2">
                    <Button
                      disabled={endpoint.is_current || activating === endpoint.id}
                      onClick={() => void handleActivate(endpoint)}
                      size="sm"
                      variant="outline"
                    >
                      {activating === endpoint.id ? <Loader2 className="animate-spin" /> : <Zap />}
                      {c.use}
                    </Button>
                    {endpoint.source !== 'direct-config' && (
                      <Tip label={c.deleteEndpoint}>
                        <Button
                          aria-label={credentialCopy.removeLabel(endpoint.name)}
                          className="hover:text-destructive"
                          disabled={deleting === endpoint.id}
                          onClick={() => void handleDelete(endpoint)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          {deleting === endpoint.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        </Button>
                      </Tip>
                    )}
                  </div>
                }
                detail={[endpoint.model, endpoint.has_api_key ? (endpoint.api_key_preview ?? c.apiKeySet) : null]
                  .filter(Boolean)
                  .join(' · ')}
                hint={<span className="block truncate">{endpoint.base_url}</span>}
                key={endpoint.id}
                title={
                  <button
                    className="flex min-w-0 items-center gap-2 text-left"
                    onClick={() => {
                      setForm(formFromEndpoint(endpoint))
                      setDiscoveredModels(endpoint.models)
                    }}
                    type="button"
                  >
                    <span className="truncate">{endpoint.name}</span>
                    {endpoint.is_current && (
                      <Pill tone="primary">
                        <Check className="size-3" />
                        {c.active}
                      </Pill>
                    )}
                    {endpoint.source === 'direct-config' && <Pill>config.yaml</Pill>}
                  </button>
                }
              />
            ))
          ) : (
            <EmptyState description={c.emptyDescription} title={c.emptyTitle} />
          )}
        </section>

        <section>
          <SectionHeading icon={Plus} title={form.id ? w.editHeading : w.addHeading} />
          <SettingRow
            control={
              <Input
                aria-label={w.name}
                onChange={event => setForm(current => ({ ...current, name: event.target.value }))}
                placeholder={c.placeholders.name}
                value={form.name}
              />
            }
            field
            hint={w.nameHint}
            title={w.name}
          />
          <SettingRow
            control={
              <Input
                aria-label={w.providerId}
                onChange={event => setForm(current => ({ ...current, id: event.target.value }))}
                placeholder={c.placeholders.providerId}
                value={form.id}
              />
            }
            field
            hint={w.providerIdHint}
            title={w.providerId}
          />
          <SettingRow
            control={
              <Input
                aria-label={w.url}
                onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))}
                placeholder={c.placeholders.baseUrl}
                value={form.baseUrl}
              />
            }
            field
            hint={w.urlHint}
            title={w.url}
          />
          <SettingRow
            control={
              <>
                <Input
                  aria-label={w.model}
                  list="custom-endpoint-models"
                  onChange={event => setForm(current => ({ ...current, model: event.target.value }))}
                  placeholder={c.placeholders.model}
                  value={form.model}
                />
                <datalist id="custom-endpoint-models">
                  {allModelOptions.map(model => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </>
            }
            field
            title={w.model}
          />
          <SettingRow
            control={
              <Input
                aria-label={w.context}
                inputMode="numeric"
                onChange={event => setForm(current => ({ ...current, contextLength: event.target.value }))}
                placeholder={c.placeholders.context}
                value={form.contextLength}
              />
            }
            field
            hint={w.contextHint}
            title={w.context}
          />
          <SettingRow
            control={
              <Input
                aria-label={w.apiKey}
                onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))}
                placeholder={form.id ? c.placeholders.keepKey : c.placeholders.optional}
                type="password"
                value={form.apiKey}
              />
            }
            field
            hint={w.apiKeyHint}
            title={w.apiKey}
          />
          <SettingRow
            control={
              <Switch
                aria-label={w.useForNewChats}
                checked={form.makeDefault}
                onCheckedChange={checked => setForm(current => ({ ...current, makeDefault: checked }))}
              />
            }
            title={w.useForNewChats}
          />
          <SettingRow
            control={
              <Switch
                aria-label={w.discoverModels}
                checked={form.discoverModels}
                onCheckedChange={checked => setForm(current => ({ ...current, discoverModels: checked }))}
              />
            }
            hint={w.discoverModelsHint}
            title={w.discoverModels}
          />
          <div className="flex flex-wrap justify-end gap-2 pt-3">
            <Button
              className={cn(!form.id && 'hidden')}
              onClick={() => {
                setForm(EMPTY_FORM)
                setDiscoveredModels([])
              }}
              type="button"
              variant="ghost"
            >
              {c.newEndpoint}
            </Button>
            <Button disabled={testing || !form.baseUrl.trim()} onClick={() => void handleValidate()} variant="outline">
              {testing ? <Loader2 className="animate-spin" /> : <Zap />}
              {c.test}
            </Button>
            <Button disabled={saving || !canSave} onClick={() => void handleSave()}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {c.save}
            </Button>
          </div>
        </section>
      </div>
    </SettingsContent>
  )
}
