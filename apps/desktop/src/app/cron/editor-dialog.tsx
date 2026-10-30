import { useQuery } from '@tanstack/react-query'
import type * as React from 'react'
import { useEffect, useState } from 'react'

import { type AutomationBlueprint, getAutomationBlueprints, getCronDeliveryTargets } from '@/hermes'
import { useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { requestModelOptions } from '@/lib/model-options'

import { IcAction } from '../command-center/ui/controls'
import { IcNote } from '../command-center/ui/feedback'
import {
  IcField,
  IcHint,
  type IcOption,
  type IcOptionGroup,
  IcSelect,
  IcTextarea,
  IcTextInput
} from '../command-center/ui/field'
import { IcModal, IcModalFoot } from '../command-center/ui/modal'

import { BlueprintSlotControl, blueprintSlotHelp, cleanBlueprintFieldError, initialBlueprintValues } from './blueprints'
import { jobIsScriptOnly, validateCronEditor } from './cron-job-model'
import { DeliverCheckboxes } from './deliver-checkboxes'
import {
  clearCronEditorDraft,
  type CronEditorDraft,
  draftIsEmpty,
  readCronEditorDraft,
  writeCronEditorDraft
} from './editor-draft'
import {
  CUSTOM_TEMPLATE,
  DEFAULT_DELIVER,
  type EditorState,
  type EditorValues,
  jobDeliver,
  jobModel,
  jobName,
  jobPrompt,
  jobProvider,
  jobScheduleExpr,
  MODEL_DEFAULT_VALUE,
  SCHEDULE_OPTIONS,
  scheduleOptionForExpr,
  scheduleSummary
} from './schedule'

/** The create/edit dialog. Draft-backed: what the user typed survives a reload
 *  (see editor-draft.ts), and `cronEditorUpdates` decides what an edit sends. */
export function CronEditorDialog({
  editor,
  onBlueprintCreate,
  onClose,
  onSave
}: {
  editor: EditorState
  onBlueprintCreate: (blueprint: AutomationBlueprint, values: Record<string, string>) => Promise<void>
  onClose: () => void
  onSave: (values: EditorValues) => Promise<void>
}) {
  const { t } = useI18n()
  const c = t.cron
  const isEdit = editor.mode === 'edit'
  const initial = editor.mode === 'edit' ? editor.job : null
  const scriptOnlyJob = initial ? jobIsScriptOnly(initial) : false

  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState('')
  const [schedulePreset, setSchedulePreset] = useState('daily')
  const [deliver, setDeliver] = useState(DEFAULT_DELIVER)
  // Per-job model override, encoded as `${providerSlug}:${model}` (split on the
  // first ':' when saving). MODEL_DEFAULT_VALUE = follow the global default.
  const [modelChoice, setModelChoice] = useState(MODEL_DEFAULT_VALUE)
  // Blueprint fills typed slots (time/enum/weekdays/text) instead of the raw
  // cron fields; the backend renders the prompt + schedule from them.
  const [slotValues, setSlotValues] = useState<Record<string, string>>({})
  // Create mode can start from a ready-made blueprint instead of a blank cron.
  // CUSTOM_TEMPLATE (default) = the manual editor; any other value is a
  // blueprint key that swaps the form for that blueprint's typed slots.
  const [templateChoice, setTemplateChoice] = useState(CUSTOM_TEMPLATE)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)
  // True once the USER changed this dialog (not when it was seeded or
  // restored). Only then does the draft follow the form: comparing state
  // against a seeded snapshot cannot tell "restored" from "typed", and a
  // restoring dialog that writes is one render away from one that clears.
  const [dirty, setDirty] = useState(false)

  // The blueprint catalog powers the create dialog's "Start from" dropdown; it's
  // meaningless when editing an existing job, so skip the fetch there.
  const blueprintsQuery = useQuery({
    queryKey: ['cron-blueprints'],
    queryFn: async () => (await getAutomationBlueprints()).blueprints,
    enabled: !isEdit
  })

  const blueprintList = blueprintsQuery.data ?? []

  const blueprint =
    templateChoice === CUSTOM_TEMPLATE ? null : (blueprintList.find(item => item.key === templateChoice) ?? null)

  const isBlueprint = blueprint !== null

  // Same catalog the chat model picker uses: configured providers and their
  // actually-available models only. Script-only + blueprint forms never pick a
  // model here, so skip the fetch entirely for them.
  const modelOptions = useQuery({
    queryKey: ['model-options', 'global'],
    queryFn: () => requestModelOptions({}),
    enabled: !scriptOnlyJob && !isBlueprint
  })

  // Single source of truth for where a cron can deliver (local + configured
  // gateways) — same endpoint the dashboard uses, so no dialog offers a platform
  // that isn't connected. Shared by the manual editor and the blueprint form.
  const deliveryTargets = useQuery({
    queryKey: ['cron-delivery-targets'],
    queryFn: getCronDeliveryTargets
  })

  useEffect(() => {
    const draft = readCronEditorDraft()

    const restorable =
      draft && draft.mode === editor.mode && (editor.mode !== 'edit' || draft.jobId === editor.job.id) ? draft : null

    const seeded = restorable
      ? {
          deliver: restorable.values.deliver,
          modelChoice: restorable.values.model
            ? `${restorable.values.provider}:${restorable.values.model}`
            : MODEL_DEFAULT_VALUE,
          name: restorable.values.name,
          prompt: restorable.values.prompt,
          schedule: restorable.values.schedule,
          schedulePreset: restorable.schedulePreset,
          slotValues: restorable.slotValues,
          templateChoice: restorable.templateChoice
        }
      : {
          deliver: initial ? jobDeliver(initial) : DEFAULT_DELIVER,
          modelChoice:
            initial && jobModel(initial) ? `${jobProvider(initial)}:${jobModel(initial)}` : MODEL_DEFAULT_VALUE,
          name: initial ? jobName(initial) : '',
          prompt: initial ? jobPrompt(initial) : '',
          schedule: initial ? jobScheduleExpr(initial) : (SCHEDULE_OPTIONS[0].expr ?? ''),
          schedulePreset: initial ? scheduleOptionForExpr(jobScheduleExpr(initial)).value : 'daily',
          slotValues: {},
          templateChoice: editor.mode === 'create' ? (editor.blueprintKey ?? CUSTOM_TEMPLATE) : CUSTOM_TEMPLATE
        }

    setName(seeded.name)
    setPrompt(seeded.prompt)
    setSchedule(seeded.schedule)
    setSchedulePreset(seeded.schedulePreset)
    setDeliver(seeded.deliver)
    setModelChoice(seeded.modelChoice)
    setSlotValues(seeded.slotValues)
    setTemplateChoice(seeded.templateChoice)
    setError(null)
    setSaving(false)
    setDirty(false)
  }, [editor, initial])

  // Seed the typed slots with the blueprint's defaults whenever a blueprint is
  // picked from "Start from" (and reset them when switching back to Custom).
  useEffect(() => {
    if (!blueprint) {
      return
    }

    setSlotValues(current => (Object.keys(current).length > 0 ? current : initialBlueprintValues(blueprint)))
    setError(null)
  }, [blueprint])

  // Mirror the in-progress form into session storage, so a reload can bring it
  // back. Untouched dialogs write nothing — a draft means "the user has work
  // here", never "a dialog was opened".
  useEffect(() => {
    if (!dirty) {
      return
    }

    const overrideIndex = modelChoice === MODEL_DEFAULT_VALUE ? -1 : modelChoice.indexOf(':')

    const draft: CronEditorDraft = {
      ...(editor.mode === 'create' && editor.blueprintKey ? { blueprintKey: editor.blueprintKey } : {}),
      ...(editor.mode === 'edit' ? { jobId: editor.job.id } : {}),
      mode: editor.mode === 'edit' ? 'edit' : 'create',
      schedulePreset,
      slotValues,
      templateChoice,
      values: {
        deliver,
        model: overrideIndex >= 0 ? modelChoice.slice(overrideIndex + 1) : '',
        name,
        prompt,
        provider: overrideIndex >= 0 ? modelChoice.slice(0, overrideIndex) : '',
        schedule
      }
    }

    if (draftIsEmpty(draft)) {
      clearCronEditorDraft()

      return
    }

    writeCronEditorDraft(draft)
  }, [deliver, dirty, editor, modelChoice, name, prompt, schedule, schedulePreset, slotValues, templateChoice])

  /** Wrap a setter so every USER edit marks the form dirty (and only those). */
  function edited<T>(setter: (next: T) => void): (next: T) => void {
    return next => {
      setDirty(true)
      setter(next)
    }
  }

  const selectedScheduleOption =
    SCHEDULE_OPTIONS.find(candidate => candidate.value === schedulePreset) ?? SCHEDULE_OPTIONS[0]

  function handleSchedulePresetChange(nextPreset: string) {
    setSchedulePreset(nextPreset)
    setError(null)

    const option = SCHEDULE_OPTIONS.find(candidate => candidate.value === nextPreset)

    if (option?.expr) {
      setSchedule(option.expr)
    } else if (scheduleOptionForExpr(schedule).value !== 'custom') {
      setSchedule('')
    }
  }

  const scheduleHint = scheduleSummary(selectedScheduleOption, schedule, c)

  // Configured providers with at least one available model — mirrors the chat
  // model picker's gate so only actually-selectable models are offered.
  const modelProviders = (modelOptions.data?.providers ?? []).filter(
    provider => provider.authenticated !== false && (provider.models ?? []).length > 0
  )

  // A previously pinned model that has since left the catalog (provider
  // removed / model retired) keeps its own row rather than vanishing from the
  // list the moment the user opens the dialog.
  const modelChoiceKnown =
    modelChoice === MODEL_DEFAULT_VALUE ||
    modelProviders.some(provider => (provider.models ?? []).some(model => `${provider.slug}:${model}` === modelChoice))

  const modelSelectOptions: (IcOption | IcOptionGroup)[] = [
    { label: c.modelDefault, value: MODEL_DEFAULT_VALUE },
    ...(modelChoiceKnown ? [] : [{ label: modelChoice.slice(modelChoice.indexOf(':') + 1), value: modelChoice }]),
    ...modelProviders.map(provider => ({
      label: provider.name,
      options: (provider.models ?? []).map(model => ({
        label: model,
        value: `${provider.slug}:${model}`
      }))
    }))
  ]

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    const validationError = validateCronEditor({
      prompt,
      schedule,
      scriptOnlyJob
    })

    if (validationError) {
      setError(
        validationError === 'schedule'
          ? c.scheduleRequired
          : validationError === 'prompt'
            ? c.promptRequired
            : c.promptScheduleRequired
      )

      return
    }

    // Decode `${providerSlug}:${model}` — the model half may itself contain
    // ':' (e.g. openrouter 'anthropic/claude-sonnet-4:beta'), so split once.
    const overrideIndex = modelChoice === MODEL_DEFAULT_VALUE ? -1 : modelChoice.indexOf(':')
    const overrideProvider = overrideIndex >= 0 ? modelChoice.slice(0, overrideIndex) : ''
    const overrideModel = overrideIndex >= 0 ? modelChoice.slice(overrideIndex + 1) : ''

    setSaving(true)
    setError(null)

    try {
      await onSave({
        deliver,
        model: overrideModel,
        name: name.trim(),
        prompt: prompt.trim(),
        provider: overrideProvider,
        schedule: schedule.trim()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : c.failedSave)
    } finally {
      setSaving(false)
    }
  }

  async function handleBlueprintSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (!blueprint) {
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onBlueprintCreate(blueprint, slotValues)
    } catch (err) {
      // 422 carries the slot-level validation message; surface it inline.
      setError(cleanBlueprintFieldError(errorMessage(err)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <IcModal
      description={isEdit ? c.editDesc : c.createDesc}
      onClose={() => !saving && onClose()}
      title={isEdit ? c.editTitle : c.createTitle}
    >
      {!isEdit && blueprintList.length > 0 ? (
        <IcField hint={blueprint?.description} htmlFor="cron-template" label={c.blueprints.startFrom}>
          <IcSelect
            id="cron-template"
            onChange={edited(setTemplateChoice)}
            options={[
              { label: c.blueprints.custom, value: CUSTOM_TEMPLATE },
              ...blueprintList.map(item => ({ label: item.title, value: item.key }))
            ]}
            value={templateChoice}
          />
        </IcField>
      ) : null}

      {isBlueprint && blueprint ? (
        <form className="cron-form" onSubmit={handleBlueprintSubmit}>
          {blueprint.fields.map(field => {
            const fieldId = `blueprint-${blueprint.key}-${field.name}`

            return (
              <IcField hint={blueprintSlotHelp(field)} htmlFor={fieldId} key={field.name} label={field.label}>
                {field.name === 'deliver' ? (
                  // Use the shared, backend-sourced delivery targets (same as the
                  // manual editor) rather than the blueprint's static field.options,
                  // so both dialogs offer exactly the connected platforms.
                  <DeliverCheckboxes
                    c={c}
                    id={fieldId}
                    onChange={edited(next => setSlotValues(prev => ({ ...prev, [field.name]: next })))}
                    targets={deliveryTargets.data ?? []}
                    value={slotValues[field.name] ?? DEFAULT_DELIVER}
                  />
                ) : (
                  <BlueprintSlotControl
                    field={field}
                    id={fieldId}
                    onChange={edited(next => setSlotValues(prev => ({ ...prev, [field.name]: next })))}
                    value={slotValues[field.name] ?? ''}
                  />
                )}
              </IcField>
            )
          })}

          {error ? <IcNote tone="danger">{error}</IcNote> : null}

          <IcModalFoot>
            <IcAction disabled={saving} onClick={onClose}>
              {t.common.cancel}
            </IcAction>
            <IcAction disabled={saving} submit tone="accent">
              {saving ? c.blueprints.scheduling : c.blueprints.scheduleIt}
            </IcAction>
          </IcModalFoot>
        </form>
      ) : (
        <form className="cron-form" onSubmit={handleSubmit}>
          {scriptOnlyJob && initial ? (
            <IcHint>
              {c.scriptOnlyEditHint} {initial.id}
            </IcHint>
          ) : null}

          <IcField htmlFor="cron-name" label={c.nameLabel} optional optionalLabel={c.optional}>
            <IcTextInput
              autoFocus
              id="cron-name"
              onChange={edited(setName)}
              placeholder={c.namePlaceholder}
              value={name}
            />
          </IcField>

          <IcField htmlFor="cron-prompt" label={c.promptLabel} optional={scriptOnlyJob} optionalLabel={c.optional}>
            <IcTextarea
              id="cron-prompt"
              mono
              onChange={edited(setPrompt)}
              placeholder={c.promptPlaceholder}
              value={prompt}
            />
          </IcField>

          <div className="cron-form__pair">
            <IcField htmlFor="cron-frequency" label={c.frequencyLabel}>
              <IcSelect
                id="cron-frequency"
                onChange={edited(handleSchedulePresetChange)}
                options={SCHEDULE_OPTIONS.map(option => ({
                  label: c.scheduleLabels[option.value],
                  value: option.value
                }))}
                value={schedulePreset}
              />
            </IcField>

            <IcField htmlFor="cron-deliver" label={c.deliverLabel}>
              <DeliverCheckboxes
                c={c}
                id="cron-deliver"
                onChange={edited(setDeliver)}
                targets={deliveryTargets.data ?? []}
                value={deliver}
              />
            </IcField>
          </div>

          {!scriptOnlyJob ? (
            <IcField htmlFor="cron-model" label={c.modelLabel} optional optionalLabel={c.optional}>
              <IcSelect
                id="cron-model"
                onChange={edited(setModelChoice)}
                options={modelSelectOptions}
                value={modelChoice}
              />
            </IcField>
          ) : null}

          {schedulePreset === 'custom' ? (
            <IcField hint={c.customHint} htmlFor="cron-schedule" label={c.customScheduleLabel}>
              <IcTextInput
                id="cron-schedule"
                mono
                onChange={edited(setSchedule)}
                placeholder={c.customPlaceholder}
                value={schedule}
              />
            </IcField>
          ) : (
            <p className="cron-schedule-hint">
              <span>{scheduleHint}</span>
              <span className="cron-schedule-hint__expr">{schedule}</span>
            </p>
          )}

          {error ? <IcNote tone="danger">{error}</IcNote> : null}

          <IcModalFoot>
            <IcAction disabled={saving} onClick={onClose}>
              {t.common.cancel}
            </IcAction>
            <IcAction disabled={saving} submit tone="accent">
              {saving ? t.common.saving : isEdit ? c.saveChanges : c.createAction}
            </IcAction>
          </IcModalFoot>
        </form>
      )}
    </IcModal>
  )
}
