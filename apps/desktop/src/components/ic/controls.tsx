import './ic-ui.css'

import type { ReactNode } from 'react'

import { Search } from '@/lib/icons'

/**
 * OUR controls — buttons, search and a segmented switch, drawn with `--ic-*`
 * tokens. `app/home/econ/ui.tsx` exports `Action`/`IconAction` too; those take
 * econ's toolbar props (`end`, `spinning`, tone set) and live inside its app
 * frame. Ours are page-frame controls with a submit mode the editor dialog
 * needs, so the names are prefixed rather than merged into one component with
 * two prop families.
 */

export function IcIconAction({
  children,
  label,
  onClick,
  tone
}: {
  children: ReactNode
  label: string
  onClick: () => void
  tone?: 'danger'
}) {
  // The icon's name is `aria-label` only: a native `title=` is banned on buttons in the
  // renderer (components/ui/__tests__/no-native-title.test.ts — the guard reaches this file
  // now that it lives in the one home). A styled hover hint is `IcTip`, if a page wants one.
  return (
    <button aria-label={label} className="icui-icon" data-tone={tone} onClick={onClick} type="button">
      {children}
    </button>
  )
}

export function IcAction({
  children,
  disabled,
  onClick,
  submit,
  tone
}: {
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
  /** Renders a form submit button (the dialog's primary action). */
  submit?: boolean
  tone?: 'accent' | 'danger'
}) {
  return (
    <button
      className="icui-btn"
      data-tone={tone}
      disabled={disabled}
      onClick={onClick}
      type={submit ? 'submit' : 'button'}
    >
      {children}
    </button>
  )
}

export function IcSearchInput({
  onChange,
  placeholder,
  value,
  width
}: {
  onChange: (next: string) => void
  placeholder: string
  value: string
  width?: string
}) {
  return (
    <span className="icui-field" style={width ? { width } : undefined}>
      <Search size={13} />
      <input
        aria-label={placeholder}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </span>
  )
}

export function IcSegmented<T extends string>({
  onChange,
  options,
  value
}: {
  onChange: (id: T) => void
  options: readonly { id: T; label: string }[]
  value: T
}) {
  return (
    <span className="icui-seg">
      {options.map(option => (
        <button aria-pressed={option.id === value} key={option.id} onClick={() => onChange(option.id)} type="button">
          {option.label}
        </button>
      ))}
    </span>
  )
}
