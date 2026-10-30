import type { Dispatch, SetStateAction } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AuxiliaryModelsResponse, ModelOptionProvider, StaleAuxAssignment } from '@/hermes'
import { useI18n } from '@/i18n'
import { Cpu } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { CONTROL_TEXT } from './constants'
import { AUX_TASKS, StaleAuxWarning, withActive } from './model-settings-parts'
import { SectionHeading } from './primitives'
import { SettingRow } from './setting-row'

interface AuxDraft {
  model: string
  provider: string
}

interface AuxiliaryModelsSectionProps {
  applyAuxiliaryDraft: (task: string) => Promise<void>
  applying: boolean
  auxDraft: AuxDraft
  auxDraftProviderModels: readonly string[]
  auxiliary: AuxiliaryModelsResponse | null
  auxiliaryTaskLabel: (task: string) => string
  beginAuxiliaryEdit: (task: string) => void
  editingAuxTask: null | string
  hasMainModel: boolean
  persistentStaleAux: StaleAuxAssignment[]
  providerOptions: readonly ModelOptionProvider[]
  providersLoaded: boolean
  resetAuxiliaryModels: () => Promise<void>
  setAuxDraft: Dispatch<SetStateAction<AuxDraft>>
  setAuxiliaryToMain: (task: string) => Promise<void>
  setEditingAuxTask: (task: null | string) => void
  switchStaleAux: StaleAuxAssignment[]
}

/** The helper tasks (vision, compression, titles…) and the model each one runs on. */
export function AuxiliaryModelsSection({
  applyAuxiliaryDraft,
  applying,
  auxDraft,
  auxDraftProviderModels,
  auxiliary,
  auxiliaryTaskLabel,
  beginAuxiliaryEdit,
  editingAuxTask,
  hasMainModel,
  persistentStaleAux,
  providerOptions,
  providersLoaded,
  resetAuxiliaryModels,
  setAuxDraft,
  setAuxiliaryToMain,
  setEditingAuxTask,
  switchStaleAux
}: AuxiliaryModelsSectionProps) {
  const { t } = useI18n()
  const m = t.settings.model

  return (
    <section>
      <SectionHeading icon={Cpu} title={m.auxiliaryTitle} />
      <SettingRow
        control={
          <Button
            disabled={!hasMainModel || applying}
            onClick={() => void resetAuxiliaryModels()}
            size="sm"
            variant="textStrong"
          >
            {m.resetAllToMain}
          </Button>
        }
        // A long-labelled button (Arabic, large text) is laid out like a field: it drops under the sentence
        // where the row is narrow instead of squeezing it (I-B r5).
        field
        hint={m.auxiliaryDesc}
        title={m.auxiliarySentence}
      />
      {switchStaleAux.length === 0 && persistentStaleAux.length > 0 && (
        <div className="mb-2.5">
          <StaleAuxWarning
            applying={applying}
            onReset={() => void resetAuxiliaryModels()}
            slots={persistentStaleAux}
            taskLabel={auxiliaryTaskLabel}
          />
        </div>
      )}
      <div className="grid gap-1">
        {AUX_TASKS.map(meta => {
          const copy = m.tasks[meta.key] ?? { label: meta.key, hint: meta.key }
          const current = auxiliary?.tasks.find(entry => entry.task === meta.key)
          const isAuto = !current || !current.provider || current.provider === 'auto'
          const isEditing = editingAuxTask === meta.key

          return (
            <div className="scroll-mt-6 rounded-lg" id={`aux-task-${meta.key}`} key={meta.key}>
              <SettingRow
                below={
                  isEditing && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 pt-1">
                      <Select
                        onValueChange={value => setAuxDraft(prev => ({ ...prev, provider: value, model: '' }))}
                        value={auxDraft.provider}
                      >
                        <SelectTrigger className={cn('min-w-32', CONTROL_TEXT)}>
                          <SelectValue placeholder={m.provider} />
                        </SelectTrigger>
                        <SelectContent>
                          {providerOptions.map(provider => (
                            <SelectItem key={provider.slug || 'none'} value={provider.slug || 'none'}>
                              {provider.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        onValueChange={value => setAuxDraft(prev => ({ ...prev, model: value }))}
                        value={auxDraft.model}
                      >
                        <SelectTrigger className={cn('min-w-48', CONTROL_TEXT)}>
                          <SelectValue placeholder={m.model} />
                        </SelectTrigger>
                        <SelectContent>
                          {withActive(auxDraftProviderModels, auxDraft.model).map(model => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        disabled={!auxDraft.provider || !auxDraft.model || applying}
                        onClick={() => void applyAuxiliaryDraft(meta.key)}
                        size="sm"
                      >
                        {applying ? m.applying : t.common.apply}
                      </Button>
                      <Button onClick={() => setEditingAuxTask(null)} size="sm" variant="ghost">
                        {t.common.cancel}
                      </Button>
                    </div>
                  )
                }
                control={
                  !isEditing && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        disabled={!hasMainModel || applying}
                        onClick={() => void setAuxiliaryToMain(meta.key)}
                        size="sm"
                        variant="text"
                      >
                        {m.setToMain}
                      </Button>
                      <Button
                        disabled={!providersLoaded || applying}
                        onClick={() => beginAuxiliaryEdit(meta.key)}
                        size="sm"
                        variant="textStrong"
                      >
                        {m.change}
                      </Button>
                    </div>
                  )
                }
                detail={isAuto ? undefined : `${current.provider} · ${current.model || m.providerDefault}`}
                hint={isAuto ? `${copy.hint} ${m.autoUseMain}.` : copy.hint}
                title={copy.label}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}
