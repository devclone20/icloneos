/**
 * EconomyOS — Market · the offering editor: create or edit one of the iNFT's
 * offerings, with a live preview of the card buyers will see.
 *
 * The draft lives in the app (switching views keeps it); this component only
 * renders it and reports changes. Nothing is sent until the owner presses
 * Create / Save — then the app sends the exact argv `market-editor` builds.
 */
import { type FormEvent, useMemo, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'

import { Tabs } from '../ui'

import { OfferingCard } from './market-agent'
import { failureText, type MarketSubscription, type OwnOffering, slaLabel, type Slot } from './market-data'
import {
  checkOffering,
  OFFERING_LIMIT,
  type OfferingDraft,
  offeringUpdateArgv,
  offeringValuesOf,
  previewOffering,
  type PriceType,
  priceValueArg,
  SLA_MIN
} from './market-editor'
import { EditorFrame, FormSection, ListingFields, SchemaEditor, TextField, Toggle } from './market-form'

const PRICE_TYPES: Array<{ id: PriceType; label: string }> = [
  { id: 'fixed', label: 'Fixed · USDC' },
  { id: 'percentage', label: 'Share of job value' }
]

const SLA_PRESETS: Array<{ minutes: number; label: string }> = [
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 240, label: '4 h' },
  { minutes: 1440, label: '1 day' }
]

interface OfferingEditorProps {
  agentName: string
  busy: boolean
  /** The iNFT's offerings right now (null while unread) — shown against the cap. */
  count: null | number
  draft: OfferingDraft
  /** Why the last write failed, in words. */
  error: null | string
  subscriptions: Slot<MarketSubscription[]>
  /** The offering being edited; null creates a new one. */
  target: null | OwnOffering
  onCancel: () => void
  onChange: (draft: OfferingDraft) => void
  onRetrySubscriptions: () => void
  onSubmit: () => void
}

export function OfferingEditor(props: OfferingEditorProps) {
  const { agentName, busy, count, draft, error, onCancel, onChange, onSubmit, target } = props
  const [attempted, setAttempted] = useState(false)
  const check = useMemo(() => checkOffering(draft), [draft])
  const preview = useMemo(() => previewOffering(draft), [draft])

  // Editing: nothing changed means nothing to send.
  const unchanged = useMemo(() => {
    if (!target || !check.values) {
      return false
    }

    const update = offeringUpdateArgv(target.id, check.values, offeringValuesOf(target))

    return update.ok && update.value === null
  }, [check.values, target])

  const errors = attempted ? check.errors : {}

  const set = <K extends keyof OfferingDraft>(key: K, value: OfferingDraft[K]) => onChange({ ...draft, [key]: value })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)

    if (check.values && !unchanged && !busy) {
      onSubmit()
    }
  }

  const title = target ? 'Edit offering' : 'New offering'
  const price = priceValueArg(draft.priceType, draft.price)
  const sla = slaLabel(Number(draft.slaMinutes))

  return (
    <EditorFrame
      backLabel="My offerings"
      error={error}
      onCancel={onCancel}
      onSubmit={submit}
      preview={<OfferingCard offering={preview} />}
      previewLabel="Preview · as buyers see it"
      submitDisabled={busy || unchanged}
      submitLabel={busy ? (target ? 'Saving…' : 'Creating…') : target ? 'Save changes' : 'Create offering'}
      title={title}
      toolbarEnd={<Usage count={count} />}
      why={attempted && !check.values ? 'Fix the marked fields to continue.' : unchanged ? 'No changes yet.' : ''}
    >
      <FormSection hint="What buyers read when they search the marketplace." title="Listing">
        <ListingFields
          description={draft.description}
          descriptionPlaceholder="What you deliver, how, and for whom — one or two sentences."
          errors={errors}
          name={draft.name}
          namePlaceholder="Token research report"
          onChange={set}
        />
      </FormSection>

      <FormSection hint="The price is escrowed when a buyer funds the job." title="Price & delivery">
        <Tabs items={PRICE_TYPES} onChange={type => set('priceType', type)} value={draft.priceType} />
        <div className="mk-editor__pair">
          <TextField
            error={errors.price}
            hint={
              draft.priceType === 'percentage' && price.ok
                ? `Sent to ACP as ${price.value} of the job’s value.`
                : draft.priceType === 'fixed'
                  ? 'Paid in USDC — above 0.'
                  : 'A percent of what the buyer’s job is worth.'
            }
            inputMode="decimal"
            label={draft.priceType === 'fixed' ? 'Price' : 'Share'}
            mono
            onChange={value => set('price', value)}
            placeholder={draft.priceType === 'fixed' ? '0.5' : '5'}
            suffix={draft.priceType === 'fixed' ? 'USDC' : '%'}
            value={draft.price}
          />
          <TextField
            error={errors.slaMinutes}
            hint={sla ? `Delivered within ${sla}.` : `At least ${SLA_MIN} minutes.`}
            inputMode="numeric"
            label="SLA"
            mono
            onChange={value => set('slaMinutes', value)}
            placeholder="60"
            suffix="min"
            value={draft.slaMinutes}
          />
        </div>
        <div aria-label="SLA presets" className="mk-presets" role="group">
          {SLA_PRESETS.map(preset => (
            <button
              aria-pressed={draft.slaMinutes === String(preset.minutes)}
              className={draft.slaMinutes === String(preset.minutes) ? 'mk-cat mk-cat--on' : 'mk-cat'}
              key={preset.minutes}
              onClick={() => set('slaMinutes', String(preset.minutes))}
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </FormSection>

      <FormSection
        hint="What a buyer sends when hiring. With fields or a JSON schema, ACP checks the buyer’s input before the job starts."
        title="Requirements"
      >
        <SchemaEditor
          draft={draft.requirements}
          error={errors.requirements}
          label="Requirements"
          modes={['fields', 'text', 'json']}
          noun="requirements"
          onChange={value => set('requirements', value)}
          textPlaceholder="The token ticker and the time frame you want covered."
        />
      </FormSection>

      <FormSection hint="What the buyer receives when you deliver." title="Deliverable">
        <SchemaEditor
          draft={draft.deliverable}
          error={errors.deliverable}
          label="Deliverable"
          modes={['text', 'json']}
          noun="deliverable"
          onChange={value => set('deliverable', value)}
          textPlaceholder="A markdown report with sources."
        />
      </FormSection>

      <FormSection title="Options">
        <Toggle
          checked={draft.requiredFunds}
          hint="The buyer transfers working capital with the job — for trades or purchases made on their behalf."
          label="Requires funds up front"
          onChange={value => set('requiredFunds', value)}
        />
        <Toggle
          checked={draft.hidden}
          hint="Kept off marketplace search."
          label="Hidden"
          onChange={value => set('hidden', value)}
        />
        <SubscriptionPicker
          agentName={agentName}
          error={errors.subscriptionIds}
          onChange={ids => set('subscriptionIds', ids)}
          onRetry={props.onRetrySubscriptions}
          selected={draft.subscriptionIds}
          slot={props.subscriptions}
        />
      </FormSection>
    </EditorFrame>
  )
}

/** "12 / 40" — warm near ACP's cap, red at it. */
export function Usage({ count }: { count: null | number }) {
  if (count == null) {
    return null
  }

  const tone =
    count >= OFFERING_LIMIT
      ? 'mk-usage mk-usage--full'
      : count >= OFFERING_LIMIT - 5
        ? 'mk-usage mk-usage--near'
        : 'mk-usage'

  return (
    <Tip label={`ACP allows ${OFFERING_LIMIT} offerings per agent`}>
      <span className={tone}>
        {count} / {OFFERING_LIMIT}
      </span>
    </Tip>
  )
}

function packageLabel(item: MarketSubscription): string {
  const price = item.priceUsdc == null ? '' : `${item.priceUsdc} USDC`
  const days = item.durationDays == null ? '' : `${item.durationDays} days`

  return [price, days].filter(Boolean).join(' / ')
}

/** The iNFT's subscription packages as checkboxes — an id attached to the
 *  offering but missing from the list stays visible, never silently dropped. */
function SubscriptionPicker({
  agentName,
  error,
  onChange,
  onRetry,
  selected,
  slot
}: {
  agentName: string
  error?: string
  onChange: (ids: string[]) => void
  onRetry: () => void
  selected: string[]
  slot: Slot<MarketSubscription[]>
}) {
  const list = slot.data
  const known = new Set((list ?? []).map(item => item.id))
  const orphans = selected.filter(id => !known.has(id))

  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...selected.filter(item => item !== id), id] : selected.filter(item => item !== id))

  return (
    <div aria-label="Subscription packages" className="mk-subs" role="group">
      <p className="mk-input__label">
        <span>Subscription packages</span>
      </p>
      {list && list.length > 0 ? (
        <ul className="mk-subs__list">
          {list.map(item => (
            <li key={item.id}>
              <label className="mk-subs__item">
                <input
                  checked={selected.includes(item.id)}
                  onChange={event => toggle(item.id, event.target.checked)}
                  type="checkbox"
                />
                <span className="mk-subs__name">{item.name}</span>
                <span className="mk-subs__meta">{packageLabel(item)}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {orphans.length > 0 ? (
        <ul className="mk-subs__list">
          {orphans.map(id => (
            <li key={id}>
              <label className="mk-subs__item">
                <input checked onChange={() => toggle(id, false)} type="checkbox" />
                <span className="mk-subs__name mk-mono">{id}</span>
                <span className="mk-subs__meta">attached</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {slot.error && !list ? (
        <p className="mk-input__hint">
          Couldn’t read your packages — {failureText(slot.error)}{' '}
          <button className="e-link" onClick={onRetry} type="button">
            Try again
          </button>
        </p>
      ) : !list ? (
        <p className="mk-input__hint">Reading your packages…</p>
      ) : list.length === 0 && orphans.length === 0 ? (
        <p className="mk-input__hint">
          No packages yet. A package lets a buyer pay once for repeated jobs — ask {agentName} to create one.
        </p>
      ) : (
        <p className="mk-input__hint">
          A buyer on an active package hires the offerings attached to it at no extra cost until it expires.
        </p>
      )}
      {error ? <p className="mk-input__error">{error}</p> : null}
    </div>
  )
}
