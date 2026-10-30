import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { SegmentedControl } from './segmented-control'

const OPTIONS = [
  { id: 'small', label: 'Small' },
  { id: 'default', label: 'Default' },
  { id: 'large', label: 'Large' }
] as const

type Size = (typeof OPTIONS)[number]['id']

function Radio({ initial = 'default', onChange }: { initial?: Size; onChange?: (id: Size) => void }) {
  const [value, setValue] = useState<Size>(initial)

  return (
    <SegmentedControl
      label="Text size"
      onChange={id => {
        setValue(id)
        onChange?.(id)
      }}
      options={OPTIONS}
      semantics="radio"
      value={value}
    />
  )
}

describe('SegmentedControl', () => {
  it('keeps toggle buttons with aria-pressed by default', () => {
    const onChange = vi.fn()
    render(<SegmentedControl onChange={onChange} options={OPTIONS} value="large" />)

    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('button', { name: 'Large' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Small' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Small' }).hasAttribute('tabindex')).toBe(false)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Large' }), { key: 'ArrowLeft' })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Small' }))
    expect(onChange).toHaveBeenCalledWith('small')
  })

  it('is a named radiogroup with one checked radio and one tab stop', () => {
    render(<Radio />)

    const group = screen.getByRole('radiogroup', { name: 'Text size' })
    const radios = screen.getAllByRole('radio')

    expect(group).toBeTruthy()
    expect(radios.map(radio => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(radios.map(radio => radio.tabIndex)).toEqual([-1, 0, -1])
    expect(radios.some(radio => radio.hasAttribute('aria-pressed'))).toBe(false)
  })

  it('moves focus and selection with the arrow keys, wrapping, and Home/End', () => {
    const onChange = vi.fn()
    render(<Radio onChange={onChange} />)

    const radio = (name: string) => screen.getByRole('radio', { name })

    fireEvent.keyDown(radio('Default'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('large')
    expect(radio('Large').ownerDocument.activeElement).toBe(radio('Large'))
    expect(radio('Large').getAttribute('aria-checked')).toBe('true')

    fireEvent.keyDown(radio('Large'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('small')

    fireEvent.keyDown(radio('Small'), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('large')

    fireEvent.keyDown(radio('Large'), { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('small')

    fireEvent.keyDown(radio('Small'), { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('large')
    expect(radio('Large').tabIndex).toBe(0)

    fireEvent.keyDown(radio('Large'), { key: 'a' })
    expect(onChange).toHaveBeenCalledTimes(5)
  })

  it('ignores keys while disabled', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl disabled label="Size" onChange={onChange} options={OPTIONS} semantics="radio" value="small" />
    )

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Small' }), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radiogroup').getAttribute('aria-disabled')).toBe('true')
  })
})
