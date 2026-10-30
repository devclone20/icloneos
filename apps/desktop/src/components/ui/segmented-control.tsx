import { type KeyboardEvent, useRef } from 'react'

import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface SegmentedControlOption<T extends string> {
  id: T
  label: string
  icon?: IconComponent
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (id: T) => void
  className?: string
  /** Dims the whole track and blocks selection (e.g. gated behind a prerequisite). */
  disabled?: boolean
  /** Accessible name of the group (needed with `semantics="radio"`). */
  label?: string
  /**
   * `toggle` (default): buttons with `aria-pressed`. `radio`: a radiogroup —
   * `aria-checked`, one tab stop on the checked option, arrow keys move and select.
   */
  semantics?: 'radio' | 'toggle'
}

const NEXT_KEYS: Record<string, number> = { ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1 }

/**
 * Grouped one-row toggle used for small mutually-exclusive choices
 * (color mode, tool-call display, usage period, etc.). Flat by design —
 * no per-option borders, just a tinted track with a raised active pill.
 */
export function SegmentedControl<T extends string>({
  className,
  disabled = false,
  label,
  onChange,
  options,
  semantics = 'toggle',
  value
}: SegmentedControlProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const radio = semantics === 'radio'
  const checkedIndex = options.findIndex(option => option.id === value)
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!radio || disabled || options.length === 0) {
      return
    }

    const step = NEXT_KEYS[event.key]

    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : step === undefined
            ? null
            : (tabStop + step + options.length) % options.length

    if (next === null) {
      return
    }

    event.preventDefault()
    buttons.current[next]?.focus()
    onChange(options[next].id)
  }

  return (
    <div
      aria-disabled={radio && disabled ? true : undefined}
      aria-label={label}
      className={cn(
        'inline-grid w-fit auto-cols-fr grid-flow-col gap-0.5 rounded-[5px] bg-(--ui-bg-tertiary) p-0.5',
        disabled && 'opacity-50',
        className
      )}
      onKeyDown={radio ? onKeyDown : undefined}
      role={radio ? 'radiogroup' : undefined}
    >
      {options.map(({ id, label: optionLabel, icon: Icon }, index) => {
        const active = value === id

        return (
          <button
            aria-checked={radio ? active : undefined}
            aria-pressed={radio ? undefined : active}
            className={cn(
              'flex items-center justify-center gap-1 rounded-[3px] px-2.5 py-0.5 text-[0.6875rem] font-medium transition-colors disabled:cursor-default',
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            data-slot={radio ? 'segmented-radio' : undefined}
            disabled={disabled}
            key={id}
            onClick={() => onChange(id)}
            ref={node => {
              buttons.current[index] = node
            }}
            role={radio ? 'radio' : undefined}
            tabIndex={radio ? (index === tabStop ? 0 : -1) : undefined}
            type="button"
          >
            {Icon && <Icon className="size-3" />}
            {optionLabel}
          </button>
        )
      })}
    </div>
  )
}
