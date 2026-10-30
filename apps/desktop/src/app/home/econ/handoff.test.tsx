import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { expect, test } from 'vitest'

import { SETTINGS_ROUTE } from '@/app/routes'

import { type SetupTarget, useOpenSetup } from './handoff'

function Probe({ target }: { target?: SetupTarget }) {
  const openSetup = useOpenSetup()
  // How the econ apps pass it down: an `onSetup: () => void` prop, then straight to onClick.
  const onSetup: () => void = openSetup
  const { pathname, search } = useLocation()

  return (
    <>
      <button onClick={() => openSetup(target)} type="button">
        with target
      </button>
      <button onClick={onSetup} type="button">
        as handler
      </button>
      <output data-testid="location">{pathname + search}</output>
    </>
  )
}

function landing(button: string, target?: SetupTarget): null | string {
  render(
    <MemoryRouter>
      <Probe target={target} />
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name: button }))

  return screen.getByTestId('location').textContent
}

test('with no target, Open Setup lands on the EconomyOS tab only', () => {
  expect(landing('with target')).toBe(`${SETTINGS_ROUTE}?tab=economyos`)
})

test("a target opens that iNFT's setup at its step", () => {
  expect(landing('with target', { inftId: 'base:0xabc:7', step: 'signin' })).toBe(
    `${SETTINGS_ROUTE}?tab=economyos&inft=base%3A0xabc%3A7&step=signin`
  )
})

test('a target with no step opens that iNFT only', () => {
  expect(landing('with target', { inftId: 'base:0xabc:6' })).toBe(
    `${SETTINGS_ROUTE}?tab=economyos&inft=base%3A0xabc%3A6`
  )
})

test('wired straight to onClick, the click event never becomes a target', () => {
  expect(landing('as handler')).toBe(`${SETTINGS_ROUTE}?tab=economyos`)
})
