import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { expect, test } from 'vitest'

import { linkedStepFate, useLinkedSelection, useLinkedStep } from './use-linked-selection'

function Probe() {
  const [selected, select] = useLinkedSelection({ param: 'inft' })
  const navigate = useNavigate()

  return (
    <>
      <output data-testid="selected">{selected ?? 'none'}</output>
      <button onClick={() => select('base:0xabc:7')} type="button">
        pick 7
      </button>
      <button onClick={() => navigate('/settings?tab=economyos&inft=base%3A0xabc%3A6&step=signin')} type="button">
        link 6
      </button>
      <button onClick={() => navigate('/settings?tab=economyos')} type="button">
        no link
      </button>
    </>
  )
}

function mount(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
    </MemoryRouter>
  )
}

const selected = () => screen.getByTestId('selected').textContent
const click = (name: string) => act(() => void fireEvent.click(screen.getByRole('button', { name })))

test('a deep link selects its iNFT on mount', () => {
  mount('/settings?tab=economyos&inft=base%3A0xabc%3A6')
  expect(selected()).toBe('base:0xabc:6')
})

test('R16.F5 m3: with Settings already open, a deep link still selects its iNFT', () => {
  mount('/settings?tab=economyos')
  expect(selected()).toBe('none')
  click('link 6')
  expect(selected()).toBe('base:0xabc:6')
})

test('a pick stands until the next deep link, which wins even when it repeats the URL', () => {
  mount('/settings?tab=economyos&inft=base%3A0xabc%3A6&step=signin')
  click('pick 7')
  expect(selected()).toBe('base:0xabc:7')
  click('link 6')
  expect(selected()).toBe('base:0xabc:6')
})

test('a navigation that names no iNFT keeps the current selection', () => {
  mount('/settings?tab=economyos')
  click('link 6')
  click('no link')
  expect(selected()).toBe('base:0xabc:6')
  click('pick 7')
  click('no link')
  expect(selected()).toBe('base:0xabc:7')
})

function StepProbe({ options }: { options: null | readonly string[] }) {
  const [selectedId, select, linked] = useLinkedSelection({ param: 'inft' })
  const selected = (options ?? []).find(id => id === selectedId) ?? options?.[0] ?? null
  const show = useLinkedStep({ linked, options, param: 'step', selected })
  const { search } = useLocation()

  return (
    <>
      <output data-testid="show">{String(show)}</output>
      <output data-testid="search">{search}</output>
      <button onClick={() => select('base:0xabc:7')} type="button">
        pick 7
      </button>
    </>
  )
}

function mountStep(entry: string, options: null | readonly string[]) {
  const view = render(
    <MemoryRouter initialEntries={[entry]}>
      <StepProbe options={options} />
    </MemoryRouter>
  )

  return (next: null | readonly string[]) =>
    view.rerender(
      <MemoryRouter initialEntries={[entry]}>
        <StepProbe options={next} />
      </MemoryRouter>
    )
}

const shown = () => screen.getByTestId('show').textContent
const search = () => screen.getByTestId('search').textContent ?? ''
const ROSTER = ['base:0xabc:6', 'base:0xabc:7']

test('linkedStepFate: show only on the linked selection, drop only once the options are known', () => {
  expect(linkedStepFate({ linked: 'a', options: null, selected: 'a' })).toBe('show')
  expect(linkedStepFate({ linked: 'a', options: ['a', 'b'], selected: 'a' })).toBe('show')
  expect(linkedStepFate({ linked: 'x', options: null, selected: null })).toBe('wait')
  expect(linkedStepFate({ linked: 'x', options: ['a', 'b'], selected: 'a' })).toBe('drop')
  expect(linkedStepFate({ linked: null, options: ['a'], selected: 'a' })).toBe('drop')
  expect(linkedStepFate({ linked: null, options: null, selected: null })).toBe('wait')
  expect(linkedStepFate({ linked: 'a', options: ['a', 'b'], selected: 'b' })).toBe('wait')
})

test('FB-r6-T1: the step shows on the linked iNFT and stays in the URL for the highlight to consume', () => {
  mountStep('/settings?tab=economyos&inft=base%3A0xabc%3A7&step=signin', ROSTER)
  expect(shown()).toBe('true')
  expect(search()).toContain('step=signin')
})

test('FB-r6-T1: a link to an iNFT the roster lacks falls back silently and drops step=', () => {
  const settle = mountStep('/settings?tab=economyos&inft=base%3A0xabc%3A99&step=signin', null)
  expect(shown()).toBe('false')
  expect(search()).toContain('step=signin')
  settle(ROSTER)
  expect(shown()).toBe('false')
  expect(search()).not.toContain('step=')
  expect(search()).toContain('inft=base%3A0xabc%3A99')
})

test('FB-r6-T1: a step with no ?inft= is dropped once the roster is known', () => {
  mountStep('/settings?tab=economyos&step=signin', ROSTER)
  expect(shown()).toBe('false')
  expect(search()).not.toContain('step=')
})

test('FB-r6-T1: a pick away from a known link hides the step without dropping it', () => {
  mountStep('/settings?tab=economyos&inft=base%3A0xabc%3A6&step=signin', ROSTER)
  click('pick 7')
  expect(shown()).toBe('false')
  expect(search()).toContain('step=signin')
})
