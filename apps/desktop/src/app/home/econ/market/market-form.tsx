/**
 * EconomyOS — Market: the form parts the offering and resource editors share —
 * a labelled field with its counter and error, a switch, and the schema
 * editor (fields builder · plain text · raw JSON).
 *
 * Every input is labelled, every error is tied to its input
 * (`aria-describedby`) and announced only after the owner tried to save.
 */
import { ArrowLeft, Plus, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useId, useMemo } from 'react'

import { Action, IconAction, Note, Tabs, Toolbar } from '../ui'

import { DESCRIPTION_MAX, NAME_MAX } from './market-editor'
import {
  type BuilderField,
  FIELD_TYPES,
  type FieldType,
  newField,
  type SchemaDraft,
  type SchemaMode,
  schemaValue,
  switchSchemaMode
} from './market-schema'

/** The chrome every listing editor shares: a back bar, the form beside a live
 *  preview of the card, and a footer with the reason it cannot submit yet. */
export function EditorFrame({
  backLabel,
  children,
  error,
  onCancel,
  onSubmit,
  preview,
  previewLabel,
  submitDisabled,
  submitLabel,
  title,
  toolbarEnd,
  why
}: {
  backLabel: string
  children: ReactNode
  error: null | string
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
  preview: ReactNode
  previewLabel: string
  submitDisabled: boolean
  submitLabel: string
  title: string
  toolbarEnd?: ReactNode
  why: string
}) {
  return (
    <form aria-label={title} className="mk-editor" noValidate onSubmit={onSubmit}>
      <Toolbar end={toolbarEnd}>
        <button className="mk-back__btn" onClick={onCancel} type="button">
          <ArrowLeft size={14} strokeWidth={1.8} />
          {backLabel}
        </button>
        <span className="mk-heading">{title}</span>
      </Toolbar>

      <div className="e-scroll mk-editor__scroll">
        <div className="mk-editor__grid">
          <div className="mk-editor__form">{children}</div>

          <aside aria-label="Preview" className="mk-editor__preview">
            <p className="mk-label">{previewLabel}</p>
            {preview}
          </aside>
        </div>
      </div>

      <footer className="mk-editor__foot">
        {error ? <Note kind="error">{error}</Note> : null}
        <div className="mk-editor__actions">
          <span aria-live="polite" className="mk-editor__why">
            {why}
          </span>
          <Action kind="quiet" onClick={onCancel}>
            Cancel
          </Action>
          <button className="e-btn e-btn--primary" disabled={submitDisabled} type="submit">
            {submitLabel}
          </button>
        </div>
      </footer>
    </form>
  )
}

/** Name + description: the two fields every listing opens with. */
export function ListingFields({
  description,
  descriptionPlaceholder,
  errors,
  name,
  namePlaceholder,
  onChange
}: {
  description: string
  descriptionPlaceholder: string
  errors: { description?: string; name?: string }
  name: string
  namePlaceholder: string
  onChange: (key: 'description' | 'name', value: string) => void
}) {
  return (
    <>
      <TextField
        error={errors.name}
        label="Name"
        max={NAME_MAX}
        onChange={value => onChange('name', value)}
        placeholder={namePlaceholder}
        value={name}
      />
      <TextField
        error={errors.description}
        label="Description"
        max={DESCRIPTION_MAX}
        multiline
        onChange={value => onChange('description', value)}
        placeholder={descriptionPlaceholder}
        value={description}
      />
    </>
  )
}

export function FormSection({ children, hint, title }: { children: ReactNode; hint?: string; title: string }) {
  const id = useId()

  return (
    <section aria-labelledby={id} className="mk-fset">
      <header className="mk-fset__head">
        <h4 className="mk-fset__title" id={id}>
          {title}
        </h4>
        {hint ? <p className="mk-fset__hint">{hint}</p> : null}
      </header>
      {children}
    </section>
  )
}

export function TextField({
  error,
  hint,
  inputMode,
  label,
  max,
  mono,
  multiline,
  onChange,
  placeholder,
  suffix,
  value
}: {
  error?: string
  hint?: ReactNode
  inputMode?: 'decimal' | 'numeric' | 'url'
  label: string
  max?: number
  mono?: boolean
  multiline?: boolean
  onChange: (value: string) => void
  placeholder?: string
  suffix?: string
  value: string
}) {
  const id = useId()
  const noteId = `${id}-note`
  const over = max != null && value.length > max

  const shared = {
    'aria-describedby': error || hint ? noteId : undefined,
    'aria-invalid': error ? true : undefined,
    id,
    placeholder,
    spellCheck: !mono
  }

  return (
    <div className={error ? 'mk-input mk-input--bad' : 'mk-input'}>
      <div className="mk-input__label">
        <label htmlFor={id}>{label}</label>
        {max != null ? (
          <span className={over ? 'mk-input__count mk-input__count--over' : 'mk-input__count'}>
            {value.length.toLocaleString('en-US')} / {max.toLocaleString('en-US')}
          </span>
        ) : null}
      </div>
      <div className={suffix ? 'mk-input__box mk-input__box--suffix' : 'mk-input__box'}>
        {multiline ? (
          <textarea
            {...shared}
            className={mono ? 'e-textarea mk-textarea mk-mono' : 'e-textarea mk-textarea'}
            onChange={event => onChange(event.target.value)}
            rows={3}
            value={value}
          />
        ) : (
          <input
            {...shared}
            className={mono ? 'e-input mk-mono' : 'e-input'}
            inputMode={inputMode}
            onChange={event => onChange(event.target.value)}
            type="text"
            value={value}
          />
        )}
        {suffix ? (
          <span aria-hidden="true" className="mk-input__suffix">
            {suffix}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="mk-input__error" id={noteId}>
          {error}
        </p>
      ) : hint ? (
        <p className="mk-input__hint" id={noteId}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Toggle({
  checked,
  hint,
  label,
  onChange
}: {
  checked: boolean
  hint?: string
  label: string
  onChange: (checked: boolean) => void
}) {
  const id = useId()

  return (
    <label className="mk-toggle" htmlFor={id}>
      <input
        aria-describedby={hint ? `${id}-hint` : undefined}
        checked={checked}
        className="mk-toggle__input"
        id={id}
        onChange={event => onChange(event.target.checked)}
        role="switch"
        type="checkbox"
      />
      <span aria-hidden="true" className="mk-toggle__track" />
      <span className="mk-toggle__text">
        <span className="mk-toggle__label">{label}</span>
        {hint ? (
          <span className="mk-toggle__hint" id={`${id}-hint`}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  )
}

const MODE_LABELS: Record<SchemaMode, string> = {
  fields: 'Fields',
  text: 'Plain text',
  json: 'JSON schema'
}

const TYPE_LABELS: Record<FieldType, string> = {
  string: 'text',
  number: 'number',
  boolean: 'yes / no',
  array: 'list of text'
}

/**
 * One schema, three ways to write it. `noun` names it in messages
 * ("requirements", "params"); `allowEmpty` accepts no fields at all (params
 * may be `{}`). JSON is checked as it is typed; the other modes say what is
 * wrong only once the owner tried to save (`error`).
 */
export function SchemaEditor({
  allowEmpty = false,
  draft,
  error,
  label,
  modes,
  noun,
  onChange,
  textPlaceholder
}: {
  allowEmpty?: boolean
  draft: SchemaDraft
  error?: string
  label: string
  modes: readonly SchemaMode[]
  noun: string
  onChange: (draft: SchemaDraft) => void
  textPlaceholder?: string
}) {
  const id = useId()
  const items = modes.map(mode => ({ id: mode, label: MODE_LABELS[mode] }))

  const live = useMemo(
    () => (draft.mode === 'json' && draft.json.trim() ? schemaValue(draft, noun, allowEmpty) : null),
    [allowEmpty, draft, noun]
  )

  const note = error ?? (live && !live.ok ? live.error : null)

  return (
    <div aria-label={label} className={error ? 'mk-schema mk-schema--bad' : 'mk-schema'} role="group">
      {items.length > 1 ? (
        <Tabs items={items} onChange={mode => onChange(switchSchemaMode(draft, mode))} value={draft.mode} />
      ) : null}

      {draft.mode === 'fields' ? (
        <FieldsBuilder
          emptyHint={
            allowEmpty ? 'No fields — callers send nothing.' : 'No fields yet — add one, or switch to plain text.'
          }
          fields={draft.fields}
          label={label}
          onChange={fields => onChange({ ...draft, fields })}
        />
      ) : null}

      {draft.mode === 'text' ? (
        <textarea
          aria-describedby={note ? `${id}-note` : undefined}
          aria-invalid={error ? true : undefined}
          aria-label={`${label} — plain text`}
          className="e-textarea mk-textarea"
          onChange={event => onChange({ ...draft, text: event.target.value })}
          placeholder={textPlaceholder}
          rows={3}
          value={draft.text}
        />
      ) : null}

      {draft.mode === 'json' ? (
        <textarea
          aria-describedby={note || live ? `${id}-note` : undefined}
          aria-invalid={note ? true : undefined}
          aria-label={`${label} — JSON schema`}
          className="e-textarea mk-textarea mk-textarea--code mk-mono"
          onChange={event => onChange({ ...draft, json: event.target.value })}
          placeholder={
            '{\n  "type": "object",\n  "properties": {\n    "ticker": { "type": "string" }\n  },\n  "required": ["ticker"]\n}'
          }
          rows={8}
          spellCheck={false}
          value={draft.json}
        />
      ) : null}

      {note ? (
        <p className="mk-input__error" id={`${id}-note`}>
          {note}
        </p>
      ) : live?.ok ? (
        <p className="mk-input__hint mk-input__hint--ok" id={`${id}-note`}>
          Valid JSON schema.
        </p>
      ) : null}
    </div>
  )
}

function FieldsBuilder({
  emptyHint,
  fields,
  label,
  onChange
}: {
  emptyHint: string
  fields: BuilderField[]
  label: string
  onChange: (fields: BuilderField[]) => void
}) {
  const patch = (key: string, change: Partial<BuilderField>) =>
    onChange(fields.map(field => (field.key === key ? { ...field, ...change } : field)))

  return (
    <div className="mk-builder">
      {fields.length > 0 ? (
        <ol className="mk-builder__list">
          {fields.map((field, index) => {
            const name = `${label} field ${index + 1}`

            return (
              <li className="mk-builder__row" key={field.key}>
                <input
                  aria-label={`${name} name`}
                  className="e-input mk-mono mk-builder__name"
                  onChange={event => patch(field.key, { name: event.target.value })}
                  placeholder="field_name"
                  spellCheck={false}
                  value={field.name}
                />
                <select
                  aria-label={`${name} type`}
                  className="e-select mk-builder__type"
                  onChange={event =>
                    patch(field.key, { type: FIELD_TYPES.find(type => type === event.target.value) ?? 'string' })
                  }
                  value={field.type}
                >
                  {FIELD_TYPES.map(type => (
                    <option key={type} value={type}>
                      {TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
                <label className="mk-builder__req">
                  <input
                    checked={field.required}
                    onChange={event => patch(field.key, { required: event.target.checked })}
                    type="checkbox"
                  />
                  required
                </label>
                <IconAction
                  label={`Remove ${name}`}
                  onClick={() => onChange(fields.filter(item => item.key !== field.key))}
                >
                  <X size={12} strokeWidth={1.8} />
                </IconAction>
                <input
                  aria-label={`${name} description`}
                  className="e-input mk-builder__desc"
                  onChange={event => patch(field.key, { description: event.target.value })}
                  placeholder="What the buyer puts here"
                  value={field.description}
                />
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="mk-input__hint">{emptyHint}</p>
      )}
      <button className="mk-add" onClick={() => onChange([...fields, newField()])} type="button">
        <Plus size={12} strokeWidth={1.9} />
        Add field
      </button>
    </div>
  )
}
