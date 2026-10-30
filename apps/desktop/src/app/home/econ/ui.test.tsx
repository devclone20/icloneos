import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CheckBox } from './email/email-controls'
import { Action } from './ui'

const noop = () => undefined

describe('a disabled button still says why (F-r3-C1a)', () => {
  it('keeps the button itself as the trigger: aria-disabled, focusable, named, click swallowed', async () => {
    const onClick = vi.fn()

    render(
      <Action disabled onClick={onClick} title="Finish the ACP setup first">
        New offering
      </Action>
    )

    const button = screen.getByRole('button', { name: 'New offering' }) as HTMLButtonElement

    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('data-slot')).toBe('tooltip-trigger')
    expect(button.parentElement?.tagName).not.toBe('SPAN')
    expect(button.tabIndex).toBe(0)

    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()

    fireEvent.pointerMove(button, { pointerType: 'mouse' })

    expect((await screen.findByRole('tooltip')).textContent).toContain('Finish the ACP setup first')
  })

  it('is the same DOM node before, during and after being disabled', () => {
    const { rerender } = render(
      <Action onClick={noop} title="Create an offering on ACP">
        New offering
      </Action>
    )

    const button = screen.getByRole('button', { name: 'New offering' })

    rerender(
      <Action disabled onClick={noop} title="Finish the ACP setup first">
        New offering
      </Action>
    )
    expect(screen.getByRole('button', { name: 'New offering' })).toBe(button)
    expect(button.getAttribute('aria-disabled')).toBe('true')

    rerender(
      <Action onClick={noop} title="Create an offering on ACP">
        New offering
      </Action>
    )
    expect(screen.getByRole('button', { name: 'New offering' })).toBe(button)
    expect(button.hasAttribute('aria-disabled')).toBe(false)
    expect(button.getAttribute('data-slot')).toBe('tooltip-trigger')
  })

  it('keeps a row checkbox out of the Tab order when it is disabled, with no wrapper', () => {
    render(<CheckBox checked={false} disabled label="Select message" onToggle={noop} tabbable={false} />)

    const box = screen.getByRole('checkbox', { name: 'Select message' })

    expect(box.getAttribute('tabindex')).toBe('-1')
    expect(box.getAttribute('aria-disabled')).toBe('true')
    expect(box.parentElement?.tagName).not.toBe('SPAN')
  })
})
