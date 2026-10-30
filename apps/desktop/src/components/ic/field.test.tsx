import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IcCheck, IcChecks, IcField, IcSelect, IcTextarea, IcTextInput } from './field'

afterEach(cleanup)

describe('IcField', () => {
  it('labels its control and carries an id a group can point at', () => {
    render(
      <IcField hint="one per line" htmlFor="x" label="Prompt" optional optionalLabel="Optional">
        <IcTextarea id="x" onChange={vi.fn()} value="" />
      </IcField>
    )

    expect(screen.getByLabelText(/^Prompt/)).toBeTruthy()
    expect(screen.getByText('Optional')).toBeTruthy()
    expect(screen.getByText('one per line')).toBeTruthy()
    expect(globalThis.document.getElementById('x-label')).toBeTruthy()
  })
})

describe('IcTextInput', () => {
  it('reports what was typed, not the event', () => {
    const onChange = vi.fn()

    render(<IcTextInput id="n" onChange={onChange} placeholder="Name" value="" />)
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Nightly' } })

    expect(onChange).toHaveBeenCalledWith('Nightly')
  })

  it('switches to a time control without a second component', () => {
    render(<IcTextInput id="t" onChange={vi.fn()} type="time" value="09:00" />)

    expect(globalThis.document.querySelector('input[type="time"]')).toBeTruthy()
  })
})

describe('IcSelect', () => {
  it('renders flat options and provider groups, and reports the value', () => {
    const onChange = vi.fn()

    render(
      <IcSelect
        id="m"
        onChange={onChange}
        options={[
          { label: 'Default', value: '__default__' },
          { label: 'Anthropic', options: [{ label: 'opus', value: 'anthropic:opus' }] }
        ]}
        value="__default__"
      />
    )

    expect(globalThis.document.querySelectorAll('optgroup')).toHaveLength(1)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'anthropic:opus' } })
    expect(onChange).toHaveBeenCalledWith('anthropic:opus')
  })
})

describe('IcChecks', () => {
  it('is a labelled group whose boxes report their new state', () => {
    const onChange = vi.fn()

    render(
      <>
        <span id="d-label">Deliver to</span>
        <IcChecks id="d" labelledBy="d-label">
          <IcCheck checked={false} id="d-0" label="This desktop" onChange={onChange} />
        </IcChecks>
      </>
    )

    expect(screen.getByRole('group', { name: 'Deliver to' })).toBeTruthy()
    fireEvent.click(screen.getByLabelText('This desktop'))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
