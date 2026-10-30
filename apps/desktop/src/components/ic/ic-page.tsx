/**
 * IcPage — OUR page chassis (E3 decision #8, 2026-10-18): the frame, head band,
 * master rail, detail column and the three states (loading · empty · error)
 * every rebuilt page is written on. Nothing here comes from the old Hermes
 * design: the look lives in `ic-page.css` on the `--ic-*` token table, and the
 * controls are our own elements, not the upstream `<Button>` / `<Panel>`.
 *
 * `frame`:
 * - 'card'  — the page paints its own window card and owns Esc + the ✕.
 * - 'bare'  — the shell already gave it a card (`contrib/wiring.tsx` still
 *   wraps Skills and Messaging in the shared overlay panel), so the page draws
 *   no second frame and leaves Esc to the shell. One prop flips back to 'card'
 *   the day that wrapper is dropped.
 *
 * Moved here from `src/app/profiles/` by front IC (2026-10-19): one home for
 * our primitives, `src/components/ic/**`. Every old path kept a re-export shim,
 * so no page changed an import line in that round.
 */
import './ic-page.css'

import { type ReactNode, useEffect, useId, useRef, useState } from 'react'

import { AlertTriangle, Check, ChevronDown, Loader2, X } from '@/lib/icons'

interface IcPageProps {
  actions?: ReactNode
  children: ReactNode
  closeLabel?: string
  /** 'bare' when the shell already drew the card — see the module docstring. */
  frame?: 'bare' | 'card'
  /** The page's accessible name; falls back to the title. */
  label?: string
  onClose?: () => void
  subtitle?: ReactNode
  title: string
}

export function IcPage({
  actions,
  children,
  closeLabel,
  frame = 'card',
  label,
  onClose,
  subtitle,
  title
}: IcPageProps) {
  const rootRef = useRef<HTMLElement>(null)
  const card = frame === 'card'

  // Our own card owns Esc; a 'bare' page is inside a shell that already does.
  useEffect(() => {
    if (!card || !onClose) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onClose()
      }
    }

    globalThis.addEventListener('keydown', onKeyDown)

    return () => globalThis.removeEventListener('keydown', onKeyDown)
  }, [card, onClose])

  // Opening a page moves the reading position into it and closing gives the
  // caller's control back — a page that steals focus and never returns it
  // strands keyboard users on the stage behind.
  useEffect(() => {
    if (!card) {
      return
    }

    const previous = globalThis.document.activeElement
    rootRef.current?.focus({ preventScroll: true })

    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [card])

  const page = (
    <section
      aria-label={label ?? title}
      className={card ? 'icpg icpg--card' : 'icpg'}
      data-ic-page=""
      ref={rootRef}
      tabIndex={card ? -1 : undefined}
    >
      <header className="icpg__head">
        <div className="icpg__titles">
          <h2 className="icpg__title">{title}</h2>
          {subtitle ? <p className="icpg__subtitle">{subtitle}</p> : null}
        </div>
        {actions || (card && onClose) ? (
          <div className="icpg__actions">
            {actions}
            {card && onClose ? (
              <button aria-label={closeLabel} className="icpg__close" onClick={onClose} type="button">
                <X aria-hidden="true" size={14} />
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      {children}
    </section>
  )

  if (!card) {
    return page
  }

  return (
    <div className="icpg-overlay">
      <div aria-hidden="true" className="icpg-scrim" />
      {page}
    </div>
  )
}

export function IcPageBody({ children, single = false }: { children: ReactNode; single?: boolean }) {
  return <div className={single ? 'icpg__body icpg__body--single' : 'icpg__body'}>{children}</div>
}

interface IcPageRailProps {
  children: ReactNode
  footer?: ReactNode
  label: string
  search?: {
    label: string
    onChange: (value: string) => void
    placeholder?: string
    value: string
  }
}

export function IcPageRail({ children, footer, label, search }: IcPageRailProps) {
  return (
    <nav aria-label={label} className="icpg__rail">
      {search ? (
        <div className="icpg__search">
          <input
            aria-label={search.label}
            onChange={event => search.onChange(event.target.value)}
            placeholder={search.placeholder ?? search.label}
            type="search"
            value={search.value}
          />
        </div>
      ) : null}
      <ul className="icpg__rows">{children}</ul>
      {footer ? <div className="icpg__rail-foot">{footer}</div> : null}
    </nav>
  )
}

interface IcPageRowProps {
  active: boolean
  lead?: ReactNode
  meta?: ReactNode
  onSelect: () => void
  title: string
  trailing?: ReactNode
}

export function IcPageRow({ active, lead, meta, onSelect, title, trailing }: IcPageRowProps) {
  return (
    <li>
      <button aria-current={active} className="icpg__row" onClick={onSelect} type="button">
        {lead ? <span className="icpg__row-lead">{lead}</span> : null}
        <span className="icpg__row-text">
          <span className="icpg__row-title">{title}</span>
          {meta ? <span className="icpg__row-meta">{meta}</span> : null}
        </span>
        {trailing ? <span className="icpg__row-trailing">{trailing}</span> : null}
      </button>
    </li>
  )
}

export function IcPageDetail({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div aria-label={label} className="icpg__detail" role={label ? 'region' : undefined}>
      {children}
    </div>
  )
}

// The canonical empty/loading/error state (contract IC §3): this module's own body, now in state.tsx so one
// name means one thing. The old name stays exported for its ten call sites.
export { IcState as IcPageState } from './state'

type IcPillTone = 'bad' | 'good' | 'neutral' | 'warn'

export function IcPagePill({ children, tone = 'neutral' }: { children: ReactNode; tone?: IcPillTone }) {
  return <span className={tone === 'neutral' ? 'icpg__pill' : `icpg__pill icpg__pill--${tone}`}>{children}</span>
}

export function IcPageMeta({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="icpg__meta">
      {rows.map(row => (
        <div key={row.label} style={{ display: 'contents' }}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

interface IcPageSectionProps {
  aside?: ReactNode
  children: ReactNode
  label: string
  note?: string
}

export function IcPageSection({ aside, children, label, note }: IcPageSectionProps) {
  return (
    <section className="icpg__section">
      <div className="icpg__section-head">
        <div>
          <h3 className="icpg__section-label">{label}</h3>
          {note ? <p className="icpg__section-note">{note}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

interface IcPageButtonProps {
  block?: boolean
  children: ReactNode
  disabled?: boolean
  /** Marks this button as the dialog's first focus (IcDialog reads the hook). */
  firstFocus?: boolean
  /** Omitted by a submit button: the form it sits in does the work. */
  onClick?: () => void
  tone?: 'accent' | 'danger' | 'default' | 'quiet'
  type?: 'button' | 'submit'
}

/** Our own button: the pages never import the upstream one. */
export function IcPageButton({
  block = false,
  children,
  disabled = false,
  firstFocus = false,
  onClick,
  tone = 'default',
  type = 'button'
}: IcPageButtonProps) {
  const classes = ['icpg__btn']

  if (tone !== 'default') {
    classes.push(`icpg__btn--${tone}`)
  }

  if (block) {
    classes.push('icpg__btn--block')
  }

  return (
    <button
      className={classes.join(' ')}
      data-ic-autofocus={firstFocus ? '' : undefined}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  )
}

/** Visually hidden text that still names a control for assistive tech. */
export function IcHiddenLabel({ children, id }: { children: ReactNode; id: string }) {
  return (
    <span className="icpg__sr" id={id}>
      {children}
    </span>
  )
}

export function IcAlert({ children }: { children: ReactNode }) {
  return (
    <p className="icpg__alert" role="alert">
      <AlertTriangle aria-hidden="true" size={14} />
      <span>{children}</span>
    </p>
  )
}

export type IcActionState = 'done' | 'idle' | 'saving'

/** idle → saving → done label for an action button; our own spinner, our icons. */
export function IcActionLabel({
  busy,
  done,
  idle,
  state
}: {
  busy: string
  done: string
  idle: string
  state: IcActionState
}) {
  return (
    <>
      {state === 'saving' ? <Loader2 aria-hidden="true" className="icpg__spin" size={14} /> : null}
      {state === 'done' ? <Check aria-hidden="true" size={14} /> : null}
      {state === 'saving' ? busy : state === 'done' ? done : idle}
    </>
  )
}

interface IcFieldProps {
  children: ReactNode
  hint?: ReactNode
  hintError?: boolean
  htmlFor: string
  label: string
  optionalLabel?: string
}

export function IcField({ children, hint, hintError = false, htmlFor, label, optionalLabel }: IcFieldProps) {
  return (
    <div className="icpg__field">
      <label className="icpg__label" htmlFor={htmlFor}>
        <span>{label}</span>
        {optionalLabel ? <span className="icpg__optional">{optionalLabel}</span> : null}
      </label>
      {children}
      {hint ? <p className={hintError ? 'icpg__hint icpg__hint--error' : 'icpg__hint'}>{hint}</p> : null}
    </div>
  )
}

interface IcTextInputProps {
  /** Marks the field as the dialog's first focus (IcDialog reads the hook). */
  firstFocus?: boolean
  id: string
  invalid?: boolean
  onValueChange: (value: string) => void
  placeholder?: string
  /** Run on every keystroke (`@/lib/sanitize`), so the field can only ever
   *  hold a value the backend accepts — validate-then-reject is never needed. */
  sanitize?: (raw: string) => string
  /** A credential: masked on screen and never kept in a draft on disk. */
  secret?: boolean
  value: string
}

export function IcTextInput({
  firstFocus = false,
  id,
  invalid = false,
  onValueChange,
  placeholder,
  sanitize,
  secret = false,
  value
}: IcTextInputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className="icpg__input"
      data-ic-autofocus={firstFocus ? '' : undefined}
      id={id}
      onChange={event => onValueChange(sanitize ? sanitize(event.target.value) : event.target.value)}
      placeholder={placeholder}
      type={secret ? 'password' : 'text'}
      value={value}
    />
  )
}

export function IcSelect({
  id,
  onValueChange,
  options,
  value
}: {
  id: string
  onValueChange: (value: string) => void
  options: { label: string; value: string }[]
  value: string
}) {
  return (
    <select className="icpg__select" id={id} onChange={event => onValueChange(event.target.value)} value={value}>
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function IcTextarea({
  compact = false,
  id,
  onValueChange,
  placeholder,
  value
}: {
  compact?: boolean
  id: string
  onValueChange: (value: string) => void
  placeholder?: string
  value: string
}) {
  return (
    <textarea
      className={compact ? 'icpg__textarea icpg__textarea--compact' : 'icpg__textarea'}
      id={id}
      onChange={event => onValueChange(event.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      value={value}
    />
  )
}

const IC_FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

interface IcDialogProps {
  /** While true Escape still stops at the dialog but does not close it. */
  busy?: boolean
  children: ReactNode
  description?: ReactNode
  /** Rendered after the body; the footer owns its own row (`icdlg__foot`). */
  footer: ReactNode
  onClose: () => void
  /** Enter/Space anywhere in the dialog runs this — a confirm whose body holds
   *  no text field, so the key is unambiguous. */
  onEnter?: () => void
  onSubmit?: (event: React.FormEvent) => void
  open: boolean
  title: ReactNode
}

/**
 * IcDialog — OUR overlay dialog (E3 ticket E3d2-T1): the rung above the page
 * card, our scrim, Escape, a focus trap and focus returned to whatever opened
 * it. Nothing of the old Hermes dialog is left: no Radix primitive, no
 * `data-slot`, no `--ui-*`/destructive/primary classes.
 *
 * Two deliberate differences from the dialog it replaces, both to protect the
 * user's work: a click on the scrim does NOT dismiss (only Escape, Cancel and
 * the action do), and Escape is handled in the CAPTURE phase and stopped there
 * — the page under us listens for a bubbling Escape, so one key press used to
 * cancel the dialog and close the whole page with it.
 */
export function IcDialog({
  busy = false,
  children,
  description,
  footer,
  onClose,
  onEnter,
  onSubmit,
  open,
  title
}: IcDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const idBase = useId()
  const titleId = `${idBase}-title`
  const descriptionId = `${idBase}-description`

  useEffect(() => {
    if (!open) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (!busy) {
        onClose()
      }
    }

    globalThis.addEventListener('keydown', onKeyDown, true)

    return () => globalThis.removeEventListener('keydown', onKeyDown, true)
  }, [busy, onClose, open])

  // The reading position moves into the dialog and comes back to the control
  // that opened it; a dialog that keeps focus strands keyboard users behind it.
  useEffect(() => {
    if (!open) {
      return
    }

    const previous = globalThis.document.activeElement
    const card = cardRef.current

    const first =
      card?.querySelector<HTMLElement>('[data-ic-autofocus]') ?? card?.querySelector<HTMLElement>(IC_FOCUSABLE) ?? card

    first?.focus({ preventScroll: true })

    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [open])

  if (!open) {
    return null
  }

  const onCardKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      const nodes = [...(cardRef.current?.querySelectorAll<HTMLElement>(IC_FOCUSABLE) ?? [])]

      if (nodes.length === 0) {
        return
      }

      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = globalThis.document.activeElement

      if (event.shiftKey && (active === first || active === cardRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }

      return
    }

    if (onEnter && !busy && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      onEnter()
    }
  }

  const body = (
    <>
      {children}
      {footer}
    </>
  )

  return (
    <div className="icdlg-overlay">
      <div aria-hidden="true" className="icdlg-scrim" />
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="icdlg"
        onKeyDown={onCardKeyDown}
        ref={cardRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="icdlg__head">
          <h2 className="icdlg__title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="icdlg__desc" id={descriptionId}>
              {description}
            </p>
          ) : null}
        </header>
        {onSubmit ? (
          <form className="icdlg__body" onSubmit={onSubmit}>
            {body}
          </form>
        ) : (
          <div className="icdlg__body">{body}</div>
        )}
      </div>
    </div>
  )
}

interface IcConfirmDialogProps {
  busyLabel: string
  cancelLabel: string
  confirmLabel: string
  description?: ReactNode
  doneLabel: string
  /** Shown when the rejection carries no message of its own. */
  errorFallback: string
  onClose: () => void
  /** Does the work; throw to keep the dialog open with an inline error. */
  onConfirm: () => Promise<void> | void
  open: boolean
  title: ReactNode
  tone?: 'danger' | 'default'
}

/**
 * The confirm shape on IcDialog: opens focused on the action, Enter confirms
 * from anywhere inside, and it owns the idle → saving → done beat plus the
 * inline error. Callers pass only the copy and an async onConfirm.
 */
export function IcConfirmDialog({
  busyLabel,
  cancelLabel,
  confirmLabel,
  description,
  doneLabel,
  errorFallback,
  onClose,
  onConfirm,
  open,
  title,
  tone = 'default'
}: IcConfirmDialogProps) {
  const [status, setStatus] = useState<IcActionState>('idle')
  const [error, setError] = useState<null | string>(null)
  const closeTimerRef = useRef<null | ReturnType<typeof setTimeout>>(null)
  const busy = status === 'saving' || status === 'done'

  useEffect(() => {
    if (open) {
      setStatus('idle')
      setError(null)
    }
  }, [open])

  // The "done" beat holds for 600 ms; an unmount inside that window used to
  // leave the timer armed and it then called onClose on a tree that is gone.
  // The write is a timer handle this component owns, not a mirror of state.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        globalThis.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }
  }, [])

  const run = async () => {
    if (busy) {
      return
    }

    setError(null)
    setStatus('saving')

    try {
      await onConfirm()
      setStatus('done')
      closeTimerRef.current = globalThis.setTimeout(() => {
        closeTimerRef.current = null
        onClose()
      }, 600)
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : errorFallback)
    }
  }

  return (
    <IcDialog
      busy={busy}
      description={description}
      footer={
        <>
          {error ? <IcAlert>{error}</IcAlert> : null}
          <div className="icdlg__foot">
            <IcPageButton disabled={busy} onClick={onClose} tone="quiet">
              {cancelLabel}
            </IcPageButton>
            <IcPageButton
              disabled={busy}
              firstFocus
              onClick={() => void run()}
              tone={tone === 'danger' ? 'danger' : 'accent'}
            >
              <IcActionLabel busy={busyLabel} done={doneLabel} idle={confirmLabel} state={status} />
            </IcPageButton>
          </div>
        </>
      }
      onClose={onClose}
      onEnter={() => void run()}
      open={open}
      title={title}
    >
      {null}
    </IcDialog>
  )
}

export type IcTone = 'bad' | 'good' | 'neutral' | 'warn'

/** The status dot our pages use — no upstream `StatusDot`. */
export function IcDot({ tone }: { tone: IcTone }) {
  return <span aria-hidden="true" className={`icpg__dot icpg__dot--${tone}`} />
}

/** A switch: one control, named, with its state in the accessibility tree. */
export function IcSwitch({
  checked,
  disabled = false,
  label,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="icpg__switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" className="icpg__switch-knob" />
    </button>
  )
}

interface IcListRowProps {
  action?: ReactNode
  description?: ReactNode
  title: ReactNode
}

/** Title · hint on the left, the control at the front (right). */
export function IcListRow({ action, description, title }: IcListRowProps) {
  return (
    <div className="icpg__listrow">
      <div className="icpg__listrow-text">
        <div className="icpg__listrow-title">{title}</div>
        {description ? <p className="icpg__listrow-hint">{description}</p> : null}
      </div>
      {action ? <div className="icpg__listrow-action">{action}</div> : null}
    </div>
  )
}

/** A section that opens: the label is the control, the caret only follows. */
export function IcDisclosure({
  children,
  label,
  onToggle,
  open
}: {
  children: ReactNode
  label: string
  onToggle: () => void
  open: boolean
}) {
  return (
    <div className="icpg__disclosure">
      <button aria-expanded={open} className="icpg__disclosure-btn" onClick={onToggle} type="button">
        <span>{label}</span>
        <ChevronDown aria-hidden="true" className={open ? 'icpg__caret icpg__caret--open' : 'icpg__caret'} size={13} />
      </button>
      {open ? <div className="icpg__disclosure-body">{children}</div> : null}
    </div>
  )
}
