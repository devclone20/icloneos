import './ic-ui.css'

import type { ReactNode } from 'react'

/**
 * OUR form controls — the vocabulary the cron editor and the blueprint form are
 * written in. Native `input` / `textarea` / `select` under our own tokens: no
 * Radix popup to re-theme, so a select opens with the platform's own keyboard
 * handling and renders identically in a packaged build.
 *
 * Nothing in `app/home/econ/ui.tsx` overlaps here (econ has no forms).
 */

export function IcField({
  children,
  hint,
  htmlFor,
  label,
  optional,
  optionalLabel
}: {
  children: ReactNode
  hint?: string
  htmlFor: string
  label: string
  optional?: boolean
  optionalLabel?: string
}) {
  return (
    <div className="icui-label">
      {/* The id lets a non-labelable control (a role=group of checkboxes)
          take this label as its accessible name via aria-labelledby. */}
      <label className="icui-label__top" htmlFor={htmlFor} id={`${htmlFor}-label`}>
        {label}
        {optional && optionalLabel ? <span className="icui-label__optional">{optionalLabel}</span> : null}
      </label>
      {children}
      {hint ? <p className="icui-hint">{hint}</p> : null}
    </div>
  )
}

/** Hint text that is not attached to a field (a dialog-level remark). */
export function IcHint({ children }: { children: ReactNode }) {
  return <p className="icui-hint">{children}</p>
}

export function IcTextInput({
  autoFocus,
  id,
  mono,
  onChange,
  placeholder,
  type = 'text',
  value
}: {
  autoFocus?: boolean
  id: string
  mono?: boolean
  onChange: (next: string) => void
  placeholder?: string
  type?: 'text' | 'time'
  value: string
}) {
  return (
    <input
      autoFocus={autoFocus}
      className="icui-input"
      data-mono={mono ? 'true' : undefined}
      id={id}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      type={type}
      value={value}
    />
  )
}

export function IcTextarea({
  id,
  mono,
  onChange,
  placeholder,
  value
}: {
  id: string
  mono?: boolean
  onChange: (next: string) => void
  placeholder?: string
  value: string
}) {
  return (
    <textarea
      className="icui-textarea"
      data-mono={mono ? 'true' : undefined}
      id={id}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      value={value}
    />
  )
}

export interface IcOption {
  label: string
  value: string
}

export interface IcOptionGroup {
  label: string
  options: readonly IcOption[]
}

function isGroup(item: IcOption | IcOptionGroup): item is IcOptionGroup {
  return 'options' in item
}

export function IcSelect({
  id,
  onChange,
  options,
  value
}: {
  id: string
  onChange: (next: string) => void
  options: readonly (IcOption | IcOptionGroup)[]
  value: string
}) {
  return (
    <select className="icui-select" id={id} onChange={event => onChange(event.target.value)} value={value}>
      {options.map(item =>
        isGroup(item) ? (
          <optgroup key={item.label} label={item.label}>
            {item.options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        )
      )}
    </select>
  )
}

/** A bordered group of checkboxes (one `role=group` with its own label id). */
export function IcChecks({ children, id, labelledBy }: { children: ReactNode; id: string; labelledBy?: string }) {
  return (
    <div aria-labelledby={labelledBy} className="icui-checks" id={id} role="group">
      {children}
    </div>
  )
}

export function IcCheck({
  checked,
  id,
  label,
  onChange
}: {
  checked: boolean
  id: string
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <label className="icui-check" htmlFor={id}>
      <input checked={checked} id={id} onChange={event => onChange(event.target.checked)} type="checkbox" />
      <span>{label}</span>
    </label>
  )
}
