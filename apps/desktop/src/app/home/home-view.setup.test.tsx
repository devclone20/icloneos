// v0.0.9 W1b (F5 optional items, wired in home-view): (1) a card's "Set up in EconomyOS" opens THAT iNFT's setup —
// Settings › EconomyOS with ?inft=<id>, the deep link econ/handoff.ts uses — and closes the Collection; (2) the chains
// the last scan could not read ($inftScanMissing, filled from main's `incomplete`) are named in the partial alert.
// Red on the old code: home-view passed neither `onSetUp` (no button on the plate) nor `missingCollections`.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SETTINGS_ROUTE } from '@/app/routes'
import { FIXTURE_ADDRESS, fixtureId, fixtureItem } from '@/app/settings/inft-book/book-fixture'
import { $bookChecked, checkShown } from '@/app/settings/inft-book/book-store'
import { en } from '@/i18n/en'
import { f5Collection } from '@/i18n/en/v009-f5'

import { $acpConfigMap } from './acp-setup'
import { HomeView } from './home-view'
import { toInftCards } from './inft-scan'
import { $inftRoster, $inftRosterStatus, $inftScanMissing, $privySession } from './privy-session'
import { $activeInft } from './stage-store'

vi.mock('./stage3d', () => ({
  Stage3D: ({ modelUrl }: { modelUrl: string }) => <div data-model={modelUrl} data-testid="stage3d" />
}))

const roster = toInftCards({
  ok: true,
  source: 'indexer',
  agents: Array.from({ length: 6 }, (_, i) => ({ ...fixtureItem(i), model: `https://m/${i}.glb` }))
})

function Where() {
  const location = useLocation()

  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>
}

function renderHome() {
  const view = render(
    <MemoryRouter>
      <HomeView mode="stage" onClose={() => undefined} />
      <Where />
    </MemoryRouter>
  )

  fireEvent.click(view.getByRole('button', { name: en.desktop.home.inftCollection }))

  return view
}

beforeEach(() => {
  window.localStorage.clear()
  $bookChecked.set({})
  $acpConfigMap.set({})
  $privySession.set({ status: 'in', address: FIXTURE_ADDRESS })
  $inftRoster.set(roster)
  $inftRosterStatus.set('ready')
  $inftScanMissing.set([])
  $activeInft.set(null)
  checkShown(FIXTURE_ADDRESS, [{ id: fixtureId(2) }])
})

afterEach(() => {
  cleanup()
  $acpConfigMap.set({})
  $privySession.set({ status: 'out' })
  $inftRoster.set([])
  $inftScanMissing.set([])
  $activeInft.set(null)
})

describe('HomeView · Collection setup door and partial names (W1b)', () => {
  it('"Set up in EconomyOS" on an unconfigured card opens that iNFT’s setup and closes the Collection', () => {
    const view = renderHome()
    const id = fixtureId(2)

    fireEvent.click(view.getByRole('button', { name: f5Collection.setUp }), { detail: 1 })

    const route = `${SETTINGS_ROUTE}?tab=economyos&inft=${encodeURIComponent(id)}`

    expect(view.getByTestId('where').textContent).toBe(route)
    expect(view.container.ownerDocument.querySelector('.inft-card')).toBeNull()
    expect($activeInft.get()).toBeNull()
  })

  it('the chains the last scan could not read are named in the partial alert', () => {
    $inftScanMissing.set(['Robinhood'])

    const view = renderHome()

    expect(view.getByText(f5Collection.partial(['Robinhood']))).toBeTruthy()
  })

  it('a complete scan: no partial alert', () => {
    const view = renderHome()

    expect(view.queryByText(f5Collection.partial([]))).toBeNull()
    expect(view.queryByText(f5Collection.partial(['Robinhood']))).toBeNull()
  })
})

describe('HomeView · no wallet, no samples (Q proofs F5)', () => {
  it('signed out, the Collection shows the "Connect wallet" state and not one card', () => {
    $privySession.set({ status: 'out' })
    $inftRoster.set([])

    const view = renderHome()

    expect(view.getByText(f5Collection.signedOut)).toBeTruthy()
    expect(view.getByRole('button', { name: f5Collection.connectWallet })).toBeTruthy()
    expect(view.baseElement.querySelectorAll('.inft-card')).toHaveLength(0)
    expect(view.queryByText(/icloneOS i01 · #/)).toBeNull()
    expect(view.queryByText(f5Collection.setupNeeded)).toBeNull()
  })
})
