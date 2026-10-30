/**
 * Email — the compose sheet. It lives inside the window, in the reading
 * pane's place (never a modal over the app): To / Subject / Body, validated
 * before anything runs. Esc tucks it away and keeps the draft; Discard drops it.
 */
import { PanelRightClose, Send } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { Action, IconAction, Note } from '../ui'

import { type Draft, type DraftErrors, hasDraft, validateDraft } from './email-data'

const MOD_KEY = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'

type Field = keyof Draft

const FIELD_ORDER: Field[] = ['to', 'subject', 'body']

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <span className="em-field__error" id={id}>
      {message}
    </span>
  ) : null
}

export function ComposeSheet({
  draft,
  from,
  onChange,
  onClose,
  onDiscard,
  onSend
}: {
  draft: Draft
  from: string
  onChange: (draft: Draft) => void
  /** Hide the sheet, keep the draft. */
  onClose: () => void
  /** Drop the draft and hide the sheet. */
  onDiscard: () => void
  /** Resolves to an error message, or null once the service accepted it. */
  onSend: (draft: Draft) => Promise<null | string>
}) {
  const [attempted, setAttempted] = useState(false)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<null | string>(null)
  const fields = useRef<Partial<Record<Field, HTMLInputElement | HTMLTextAreaElement | null>>>({})
  const errors: DraftErrors = attempted ? validateDraft(draft) : {}

  useEffect(() => {
    const first = FIELD_ORDER.find(field => !draft[field].trim()) ?? 'body'

    fields.current[first]?.focus()
    // Focus once, when the sheet opens — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (field: Field, value: string) => {
    onChange({ ...draft, [field]: value })
    setFailure(null)
  }

  const submit = async () => {
    setAttempted(true)
    const problems = validateDraft(draft)
    const invalid = FIELD_ORDER.find(field => problems[field])

    if (invalid) {
      fields.current[invalid]?.focus()

      return
    }

    setSending(true)
    setFailure(null)
    const error = await onSend(draft)
    setSending(false)

    if (error) {
      setFailure(error)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void submit()
    }
  }

  const bind = (field: Field) => ({
    'aria-describedby': errors[field] ? `em-compose-${field}-error` : undefined,
    'aria-invalid': errors[field] ? true : undefined,
    disabled: sending,
    id: `em-compose-${field}`,
    onChange: (event: { target: { value: string } }) => update(field, event.target.value),
    ref: (element: HTMLInputElement | HTMLTextAreaElement | null) => {
      fields.current[field] = element
    },
    value: draft[field]
  })

  return (
    <section aria-label="New message" className="em-compose" onKeyDown={onKeyDown}>
      <header className="em-compose__head">
        <h3>New message</h3>
        <IconAction label="Close · Esc (keeps the draft)" onClick={onClose}>
          <PanelRightClose size={14} strokeWidth={1.7} />
        </IconAction>
      </header>

      <p className="em-compose__from">
        From <span>{from || 'your agent’s address'}</span>
      </p>

      <div className="e-field">
        <label className="e-field__label" htmlFor="em-compose-to">
          To
        </label>
        <input
          autoComplete="off"
          className="e-input"
          placeholder="name@example.com"
          spellCheck={false}
          type="email"
          {...bind('to')}
        />
        <FieldError id="em-compose-to-error" message={errors.to} />
      </div>

      <div className="e-field">
        <label className="e-field__label" htmlFor="em-compose-subject">
          Subject
        </label>
        <input
          autoComplete="off"
          className="e-input"
          placeholder="What is it about?"
          type="text"
          {...bind('subject')}
        />
        <FieldError id="em-compose-subject-error" message={errors.subject} />
      </div>

      <div className="e-field em-compose__body">
        <label className="e-field__label" htmlFor="em-compose-body">
          Message
        </label>
        <textarea className="e-textarea" placeholder="Write your message…" {...bind('body')} />
        <FieldError id="em-compose-body-error" message={errors.body} />
      </div>

      {failure ? <Note kind="error">{failure}</Note> : null}

      <footer className="em-compose__foot">
        <span className="em-hint">{MOD_KEY}↩ to send · Esc to close</span>
        <Action disabled={sending} kind="quiet" onClick={hasDraft(draft) ? onDiscard : onClose}>
          {hasDraft(draft) ? 'Discard' : 'Cancel'}
        </Action>
        <Action disabled={sending} kind="primary" onClick={() => void submit()}>
          <Send size={13} strokeWidth={1.8} />
          {sending ? 'Sending…' : 'Send'}
        </Action>
      </footer>
    </section>
  )
}
