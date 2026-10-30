import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { saveMoaModels } from '@/hermes'
import type { MoaConfigResponse, MoaModelSlot, ModelOptionProvider } from '@/hermes'
import { useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { Cpu } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { CONTROL_TEXT } from './constants'
import { moaConfigComplete, withActive } from './model-settings-parts'
import { SectionHeading } from './primitives'
import { SettingRow } from './setting-row'

type MoaPreset = MoaConfigResponse['presets'][string]

interface MoaEditorDeps {
  moa: MoaConfigResponse | null
  profileEpoch: RefObject<number>
  scopeProfile?: string
  selectedMoaPreset: string
  setApplying: (applying: boolean) => void
  setError: (error: string) => void
  setMoa: (moa: MoaConfigResponse) => void
}

// Mixture-of-Agents preset editing: debounced autosave of inline edits, explicit saves for preset-level ops.
export function useMoaEditor({
  moa,
  profileEpoch,
  scopeProfile,
  selectedMoaPreset,
  setApplying,
  setError,
  setMoa
}: MoaEditorDeps) {
  const currentMoaPreset = useMemo(() => {
    if (!moa) {
      return null
    }

    return moa.presets[selectedMoaPreset] || moa.presets[moa.default_preset] || Object.values(moa.presets)[0] || null
  }, [moa, selectedMoaPreset])

  // Mirror of `moa` so inline edits compute the next state purely (outside the
  // setState updater) and hand it straight to the debounced autosave.
  const moaRef = useRef<MoaConfigResponse | null>(null)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    moaRef.current = moa
  }, [moa])

  const moaSaveTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (moaSaveTimer.current) {
        window.clearTimeout(moaSaveTimer.current)
      }
    },
    []
  )

  // Guard against stale save responses overwriting newer state.
  const moaSaveGeneration = useRef(0)

  // Quiet debounced persist for inline MoA edits — mirrors the config page's
  // autosave so slot/aggregator tweaks save themselves, matching the
  // preset-level ops (set default / add / delete) that already persist on
  // click. No `applying` spinner, so selecting stays responsive.
  //
  // While any slot is half-filled (provider picked, model pending) the save is
  // HELD, not sent: the previous complete config stays on disk and the next
  // edit that completes the slot flushes the whole preset. Every edit bumps
  // the generation so an in-flight response from an older save can never
  // repaint over the user's mid-edit state.
  const scheduleMoaSave = useCallback(
    (next: MoaConfigResponse) => {
      if (moaSaveTimer.current) {
        window.clearTimeout(moaSaveTimer.current)
        moaSaveTimer.current = null
      }

      const generation = moaSaveGeneration.current + 1
      moaSaveGeneration.current = generation

      if (!moaConfigComplete(next)) {
        return
      }

      moaSaveTimer.current = window.setTimeout(() => {
        void saveMoaModels(next, scopeProfile)
          .then(saved => {
            if (moaSaveGeneration.current === generation) {
              setMoa(saved)
            }
          })
          .catch(err => {
            if (moaSaveGeneration.current === generation) {
              setError(errorMessage(err))
            }
          })
      }, 600)
    },
    [scopeProfile, setError, setMoa]
  )

  const updateMoaPreset = useCallback(
    (updater: (preset: NonNullable<typeof currentMoaPreset>) => NonNullable<typeof currentMoaPreset>) => {
      const prev = moaRef.current

      if (!prev || !selectedMoaPreset || !prev.presets[selectedMoaPreset]) {
        return
      }

      const next: MoaConfigResponse = {
        ...prev,
        presets: {
          ...prev.presets,
          [selectedMoaPreset]: updater(prev.presets[selectedMoaPreset])
        }
      }

      moaRef.current = next
      setMoa(next)
      scheduleMoaSave(next)
    },
    [scheduleMoaSave, selectedMoaPreset, setMoa]
  )

  const updateMoaSlot = useCallback((slot: MoaModelSlot, patch: Partial<MoaModelSlot>): MoaModelSlot => {
    const next = { ...slot, ...patch }

    // Picking a new provider invalidates the model choice (models are
    // per-provider). A same-provider update must not wipe the model — Radix
    // filters same-value changes, but programmatic callers may not.
    if (patch.provider && patch.provider !== slot.provider) {
      next.model = ''
    }

    return next
  }, [])

  const saveMoa = useCallback(
    async (next: MoaConfigResponse) => {
      const epoch = profileEpoch.current

      // Explicit preset ops (set default / add / delete) supersede any pending
      // debounced slot autosave — cancel it and invalidate in-flight responses
      // so the two writers can't race each other's state.
      if (moaSaveTimer.current) {
        window.clearTimeout(moaSaveTimer.current)
        moaSaveTimer.current = null
      }

      moaSaveGeneration.current += 1
      setApplying(true)
      setError('')

      try {
        const saved = await saveMoaModels(next, scopeProfile)

        if (profileEpoch.current !== epoch) {
          return
        }

        setMoa(saved)
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setApplying(false)
      }
    },
    [profileEpoch, scopeProfile, setApplying, setError, setMoa]
  )

  return { currentMoaPreset, saveMoa, updateMoaPreset, updateMoaSlot }
}

interface MoaSectionProps {
  applying: boolean
  currentMoaPreset: MoaPreset
  moa: MoaConfigResponse
  moaSlotProviderOptions: readonly ModelOptionProvider[]
  modelsForProvider: (provider: string) => readonly string[]
  newMoaPresetName: string
  saveMoa: (next: MoaConfigResponse) => Promise<void>
  selectedMoaPreset: string
  setNewMoaPresetName: (name: string) => void
  setSelectedMoaPreset: (name: string) => void
  updateMoaPreset: (updater: (preset: MoaPreset) => MoaPreset) => void
  updateMoaSlot: (slot: MoaModelSlot, patch: Partial<MoaModelSlot>) => MoaModelSlot
}

export function MoaSection({
  applying,
  currentMoaPreset,
  moa,
  moaSlotProviderOptions,
  modelsForProvider,
  newMoaPresetName,
  saveMoa,
  selectedMoaPreset,
  setNewMoaPresetName,
  setSelectedMoaPreset,
  updateMoaPreset,
  updateMoaSlot
}: MoaSectionProps) {
  const { t } = useI18n()
  const m = t.settings.model

  return (
    <section>
      <SectionHeading icon={Cpu} title={m.moaTitle} />
      <SettingRow
        control={
          <Switch
            aria-label={m.moaEnabled}
            checked={currentMoaPreset.enabled !== false}
            disabled={applying}
            onCheckedChange={checked => updateMoaPreset(prev => ({ ...prev, enabled: checked }))}
          />
        }
        hint={m.moaDesc}
        title={m.moaSentence}
      />
      <SettingRow
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Select onValueChange={setSelectedMoaPreset} value={selectedMoaPreset || moa.default_preset}>
              <SelectTrigger className={cn('min-w-40', CONTROL_TEXT)}>
                <SelectValue placeholder={m.moaPresetPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(moa.presets).map(name => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={applying}
              onClick={() => {
                const next: MoaConfigResponse = {
                  ...moa,
                  default_preset: selectedMoaPreset || moa.default_preset
                }

                void saveMoa(next)
              }}
              size="sm"
              variant="text"
            >
              {m.moaSetDefault}
            </Button>
            <Button
              disabled={Object.keys(moa.presets).length <= 1 || applying}
              onClick={() => {
                if (Object.keys(moa.presets).length <= 1) {
                  return
                }

                const presets = { ...moa.presets }
                delete presets[selectedMoaPreset]
                const fallback = Object.keys(presets)[0]

                const next: MoaConfigResponse = {
                  ...moa,
                  presets,
                  default_preset: moa.default_preset === selectedMoaPreset ? fallback : moa.default_preset,
                  active_preset: moa.active_preset === selectedMoaPreset ? '' : moa.active_preset
                }

                setSelectedMoaPreset(Object.keys(moa.presets).find(name => name !== selectedMoaPreset) || '')
                void saveMoa(next)
              }}
              size="sm"
              variant="ghost"
            >
              {m.moaDelete}
            </Button>
          </div>
        }
        field
        title={m.moaPresetTitle}
      />
      <SettingRow
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Input
              className={cn('w-40', CONTROL_TEXT)}
              onChange={event => setNewMoaPresetName(event.target.value)}
              placeholder={m.moaNewPlaceholder}
              value={newMoaPresetName}
            />
            <Button
              disabled={!newMoaPresetName.trim() || !!moa.presets[newMoaPresetName.trim()] || applying}
              onClick={() => {
                const name = newMoaPresetName.trim()

                const next: MoaConfigResponse = {
                  ...moa,
                  presets: {
                    ...moa.presets,
                    [name]: { ...currentMoaPreset, reference_models: [...currentMoaPreset.reference_models] }
                  }
                }

                setSelectedMoaPreset(name)
                setNewMoaPresetName('')
                void saveMoa(next)
              }}
              size="sm"
              variant="textStrong"
            >
              {m.moaAdd}
            </Button>
          </div>
        }
        field
        title={m.moaNewTitle}
      />
      <div className="grid gap-1">
        {currentMoaPreset.reference_models.map((slot, index) => (
          <SettingRow
            aside={
              <Switch
                aria-label={m.moaReferenceToggle(index + 1)}
                checked={slot.enabled !== false}
                disabled={applying}
                onCheckedChange={checked =>
                  updateMoaPreset(prev => ({
                    ...prev,
                    reference_models: prev.reference_models.map((s, i) =>
                      i === index ? { ...s, enabled: checked === true } : s
                    )
                  }))
                }
              />
            }
            className={cn(slot.enabled === false && 'opacity-60')}
            control={
              <div className="flex w-full flex-wrap items-center gap-2">
                <Select
                  onValueChange={value =>
                    updateMoaPreset(prev => ({
                      ...prev,
                      reference_models: prev.reference_models.map((s, i) =>
                        i === index ? updateMoaSlot(s, { provider: value }) : s
                      )
                    }))
                  }
                  value={slot.provider}
                >
                  <SelectTrigger className={cn('min-w-32', CONTROL_TEXT)}>
                    <SelectValue placeholder={m.provider} />
                  </SelectTrigger>
                  <MoaProviderItems current={slot.provider} options={moaSlotProviderOptions} />
                </Select>
                <Select
                  onValueChange={value =>
                    updateMoaPreset(prev => ({
                      ...prev,
                      reference_models: prev.reference_models.map((s, i) =>
                        i === index ? updateMoaSlot(s, { model: value }) : s
                      )
                    }))
                  }
                  value={slot.model}
                >
                  <SelectTrigger className={cn('min-w-48', CONTROL_TEXT)}>
                    <SelectValue placeholder={m.model} />
                  </SelectTrigger>
                  <SelectContent>
                    {withActive(modelsForProvider(slot.provider), slot.model).map(model => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  disabled={currentMoaPreset.reference_models.length <= 1 || applying}
                  onClick={() =>
                    updateMoaPreset(prev => ({
                      ...prev,
                      reference_models: prev.reference_models.filter((_, i) => i !== index)
                    }))
                  }
                  size="sm"
                  variant="ghost"
                >
                  {m.moaRemove}
                </Button>
              </div>
            }
            key={`${selectedMoaPreset}-${index}`}
            title={m.moaReference(index + 1)}
            wide
          />
        ))}
        <SettingRow
          control={
            <Button
              disabled={applying}
              onClick={() =>
                updateMoaPreset(prev => ({
                  ...prev,
                  reference_models: [...prev.reference_models, { ...prev.aggregator, enabled: true }]
                }))
              }
              size="sm"
              variant="textStrong"
            >
              {m.moaAddReference}
            </Button>
          }
          title={m.moaAddReferenceTitle}
        />
        <SettingRow
          control={
            <div className="flex w-full flex-wrap items-center gap-2">
              <Select
                onValueChange={value =>
                  updateMoaPreset(prev => ({
                    ...prev,
                    aggregator: updateMoaSlot(prev.aggregator, { provider: value })
                  }))
                }
                value={currentMoaPreset.aggregator.provider}
              >
                <SelectTrigger className={cn('min-w-32', CONTROL_TEXT)}>
                  <SelectValue placeholder={m.provider} />
                </SelectTrigger>
                <MoaProviderItems current={currentMoaPreset.aggregator.provider} options={moaSlotProviderOptions} />
              </Select>
              <Select
                onValueChange={value =>
                  updateMoaPreset(prev => ({
                    ...prev,
                    aggregator: updateMoaSlot(prev.aggregator, { model: value })
                  }))
                }
                value={currentMoaPreset.aggregator.model}
              >
                <SelectTrigger className={cn('min-w-48', CONTROL_TEXT)}>
                  <SelectValue placeholder={m.model} />
                </SelectTrigger>
                <SelectContent>
                  {withActive(
                    modelsForProvider(currentMoaPreset.aggregator.provider),
                    currentMoaPreset.aggregator.model
                  ).map(model => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
          hint={m.moaAggregatorHint}
          title={m.moaAggregatorTitle}
          wide
        />
      </div>
    </section>
  )
}

/** The provider choices of one MoA slot, keeping the slot's current provider listed. */
function MoaProviderItems({ current, options }: { current: string; options: readonly ModelOptionProvider[] }) {
  return (
    <SelectContent>
      {withActive(
        options.map(p => p.slug || 'none'),
        current
      ).map(slug => (
        <SelectItem key={slug} value={slug}>
          {options.find(p => (p.slug || 'none') === slug)?.name || slug}
        </SelectItem>
      ))}
    </SelectContent>
  )
}
