import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SettingRow } from './setting-row'

afterEach(() => cleanup())

describe('SettingRow aside (a wide row that also has a switch)', () => {
  it('keeps the switch in its own cell on the title line and spans the wide control under the text', () => {
    render(
      <SettingRow
        aside={<button role="switch" type="button" />}
        control={<select aria-label="Provider" />}
        title="Which model gives reference answer 1"
        wide
      />
    )

    const row = screen.getByText('Which model gives reference answer 1').closest('[data-setting-row]') as HTMLElement
    const aside = row.querySelector('[data-setting-aside]') as HTMLElement
    const titleColumn = screen.getByText('Which model gives reference answer 1').parentElement as HTMLElement

    expect(aside.querySelector('[role="switch"]')).toBeTruthy()
    expect(titleColumn.contains(aside)).toBe(false)
    expect(screen.getByLabelText('Provider').parentElement?.className).toContain('col-span-2')
  })

  it('renders no aside cell on a row that is not wide', () => {
    render(<SettingRow aside={<span>ignored</span>} control={<button type="button">Use</button>} title="A row" />)

    expect(screen.queryByText('ignored')).toBeNull()
  })
})

describe('SettingRow names its control (U1-p2b-03 / U2-p2b-06 / U4-p2b-07)', () => {
  it('points a plain control at the title and the hint, and leaves a wrapper div alone', () => {
    render(
      <>
        <SettingRow control={<button role="switch" type="button" />} hint="Say it twice." title="Read replies aloud" />
        <SettingRow
          control={
            <div data-wrapper="">
              <input />
            </div>
          }
          title="A wrapped field"
        />
      </>
    )

    const toggle = screen.getByRole('switch', { name: 'Read replies aloud' })
    const hintId = toggle.getAttribute('aria-describedby') as string

    expect(window.document.getElementById(hintId)?.textContent).toBe('Say it twice.')
    expect(window.document.querySelector('[data-wrapper]')?.hasAttribute('aria-labelledby')).toBe(false)
  })

  it('keeps a control that brought its own name, and hands the ids to a render function', () => {
    render(
      <>
        <SettingRow control={<button aria-label="Own name" type="button" />} hint="The hint" title="The title" />
        <SettingRow control={<button type="button">Set up</button>} hint="Opens the flow" title="Provider" />
        <SettingRow control={a11y => <input {...a11y} />} hint="Typed here" title="A field" />
      </>
    )

    const own = screen.getByRole('button', { name: 'Own name' })
    const typed = screen.getByRole('textbox', { name: 'A field' })

    expect(own.hasAttribute('aria-labelledby')).toBe(false)
    expect(screen.getByRole('button', { name: 'Set up' }).getAttribute('aria-describedby')).toBeTruthy()
    expect(window.document.getElementById(own.getAttribute('aria-describedby') as string)?.textContent).toBe('The hint')
    expect(window.document.getElementById(typed.getAttribute('aria-describedby') as string)?.textContent).toBe(
      'Typed here'
    )
  })
})
