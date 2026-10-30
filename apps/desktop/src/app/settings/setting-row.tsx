import {
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useId,
  useMemo
} from 'react'

import { cn } from '@/lib/utils'

/** The ids a row's control points at: its title names it, its hint describes it. */
interface SettingRowA11y {
  'aria-labelledby': string
  'aria-describedby'?: string
}

const SettingRowA11yContext = createContext<SettingRowA11y | undefined>(undefined)

/** The enclosing row's title/hint ids, for a control built deeper than the `control` slot (a key field, a sub-form). */
export function useSettingRowA11y(): SettingRowA11y | undefined {
  return useContext(SettingRowA11yContext)
}

// Tags that cannot carry an accessible name of their own: a wrapper around the
// real control is left alone instead of being named by the row's title.
const WRAPPER_TAGS = new Set(['div', 'span', 'p'])

/** Names a bare control (no children) by the row's title and describes any plain control by the hint, unless it brought its own. */
function withRowA11y(control: SettingRowProps['control'], a11y: SettingRowA11y): ReactNode {
  if (typeof control === 'function') {
    return control(a11y)
  }

  if (!isValidElement(control) || control.type === Fragment) {
    return control
  }

  if (typeof control.type === 'string' && WRAPPER_TAGS.has(control.type)) {
    return control
  }

  const props = control.props as Record<string, unknown>
  const next: Partial<SettingRowA11y> = {}

  // A control with content of its own (a button's text) keeps that as its name;
  // only a bare control (a switch, a field) takes the row's title.
  if (props.children == null && props['aria-label'] == null && props['aria-labelledby'] == null) {
    next['aria-labelledby'] = a11y['aria-labelledby']
  }

  if (a11y['aria-describedby'] && props['aria-describedby'] == null) {
    next['aria-describedby'] = a11y['aria-describedby']
  }

  return Object.keys(next).length > 0 ? cloneElement(control, next) : control
}

export interface SettingRowProps {
  /** The topic in one sentence. */
  title: ReactNode
  /** The longer explanation, in small secondary text under the title. */
  hint?: ReactNode
  /** The switch, menu, field or button — always at the trailing edge. A plain
   *  element is named by the title and described by the hint (unless it brought
   *  its own `aria-label`); a function receives those ids to place itself. */
  control?: ReactNode | ((a11y: SettingRowA11y) => ReactNode)
  /** Free content under the hint (a status line, a sub-form). */
  below?: ReactNode
  /** A technical reference (a config key) in small monospace, after the hint. */
  detail?: ReactNode
  /** Why the last change failed; announced, painted in the danger tone. */
  error?: ReactNode
  busy?: boolean
  disabled?: boolean
  /** The control takes the full width under the text instead of the trailing column. */
  wide?: boolean
  /** A wide row's compact switch: it keeps the trailing edge of the title line while the wide control (selects, a
   *  sub-form) spans the row under the text — the owner's "switches at the front" for rows that also configure. */
  aside?: ReactNode
  /** A select or text field: the trailing column is a fixed 15–22rem track so
   *  fields line up from row to row. Compact controls (switches, buttons) leave
   *  it off and size the column to the control, so the text runs to it. */
  field?: boolean
  /** Durable handle for tours (see lib/tour) — usually the field's schema key. */
  'data-tour'?: string
  id?: string
  className?: string
}

/**
 * THE Settings row (front I, 2026-10-20): every row of every Settings pane is
 * this component — title, hint under it, control at the trailing edge in one
 * column so controls align from row to row. Every state is declared here once:
 * hover and keyboard focus inside the row lift it on the same fill, disabled
 * and busy rows mute and lock their control, an error line replaces silence.
 * Container-queried, not viewport-queried: a narrow detail column stacks the
 * control under the text instead of squeezing the title.
 */
export function SettingRow({
  aside,
  below,
  busy = false,
  className,
  control,
  'data-tour': dataTour,
  detail,
  disabled = false,
  error,
  field = false,
  hint,
  id,
  title,
  wide = false
}: SettingRowProps) {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const hintId = hint ? `${baseId}-hint` : undefined

  const a11y = useMemo<SettingRowA11y>(
    () => (hintId ? { 'aria-describedby': hintId, 'aria-labelledby': titleId } : { 'aria-labelledby': titleId }),
    [hintId, titleId]
  )

  const controlNode = withRowA11y(control, a11y)

  return (
    <div
      aria-busy={busy || undefined}
      aria-disabled={disabled || undefined}
      className={cn(
        '@container -mx-2 rounded-(--ic-radius-md) px-2 transition-colors duration-(--ic-dur-fast) ease-(--ic-ease-std) motion-reduce:transition-none',
        'hover:bg-(--ic-fill-hover) has-[:focus-visible]:bg-(--ic-fill-hover)',
        disabled && 'hover:bg-transparent',
        className
      )}
      data-setting-row=""
      data-state={error ? 'error' : busy ? 'busy' : disabled ? 'disabled' : undefined}
      data-tour={dataTour}
      id={id}
    >
      <div
        className={cn(
          'grid gap-x-6 gap-y-2.5 py-3',
          // LEAD 2026-10-20 (I r8 critic): a compact control (switch, button) keeps its trailing
          // column from @md, so a rail doubled by large text cannot stack it under the label;
          // only the field variant waits for @2xl, where its 15–22rem track fits.
          !wide && (field ? '@2xl:items-center' : '@md:items-center'),
          !wide &&
            (field ? '@2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)]' : '@md:grid-cols-[minmax(0,1fr)_auto]'),
          wide && aside && 'grid-cols-[minmax(0,1fr)_auto] items-start'
        )}
      >
        <div className={cn('min-w-0', disabled && 'opacity-55')}>
          <div
            className="text-[length:var(--conversation-text-font-size)] leading-snug font-medium text-(--ic-text-1)"
            id={titleId}
          >
            {title}
          </div>
          {hint && (
            <div
              className="mt-0.5 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ic-text-2)"
              id={hintId}
            >
              {hint}
            </div>
          )}
          {detail && (
            <div className="mt-1 block font-mono text-[length:var(--conversation-caption-font-size)] text-(--ic-text-3)">
              {detail}
            </div>
          )}
          {error && (
            <div
              className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ic-danger)"
              role="alert"
            >
              {error}
            </div>
          )}
          {below}
        </div>
        {wide && aside && (
          <div
            className={cn('flex items-center justify-end', (busy || disabled) && 'pointer-events-none opacity-55')}
            data-setting-aside=""
          >
            <SettingRowA11yContext.Provider value={a11y}>{aside}</SettingRowA11yContext.Provider>
          </div>
        )}
        {controlNode && (
          <div
            className={cn(
              'flex min-w-0 items-center transition-opacity duration-(--ic-dur-fast) ease-(--ic-ease-std)',
              wide && aside && 'col-span-2',
              !wide &&
                (field ? '@2xl:justify-end @2xl:justify-self-stretch' : '@md:justify-end @md:justify-self-stretch'),
              (busy || disabled) && 'pointer-events-none',
              busy && 'opacity-60',
              disabled && 'opacity-55'
            )}
          >
            <SettingRowA11yContext.Provider value={a11y}>{controlNode}</SettingRowA11yContext.Provider>
          </div>
        )}
      </div>
    </div>
  )
}
