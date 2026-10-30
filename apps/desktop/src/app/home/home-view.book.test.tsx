// The Home rule where Home uses it (critic MEDIUM-2): the real HomeView, signed
// in over a 1 000-iNFT roster with 3 checked, lists exactly those 3 cards; an
// unchecked iNFT on stage stays on stage (O3) without joining the list.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FIXTURE_ADDRESS, fixtureId, fixtureItem } from '@/app/settings/inft-book/book-fixture'
import { $bookChecked, checkShown } from '@/app/settings/inft-book/book-store'
import { en } from '@/i18n/en'
import { slugForInft } from '@/iclone-shared/inft-slug'

import { $acpConfigMap, type InftAcpStatus } from './acp-setup'
import { HomeView } from './home-view'
import { toInftCards } from './inft-scan'
import { $inftRoster, $inftRosterStatus, $privySession } from './privy-session'
import { $activeInft } from './stage-store'

vi.mock('./stage3d', () => ({
  Stage3D: ({ modelUrl }: { modelUrl: string }) => <div data-model={modelUrl} data-testid="stage3d" />
}))

const roster = toInftCards({
  ok: true,
  source: 'indexer',
  agents: Array.from({ length: 1_000 }, (_, i) => ({ ...fixtureItem(i), model: `https://m/${i}.glb` }))
})

function renderHome() {
  const view = render(
    <MemoryRouter>
      <HomeView mode="stage" onClose={() => undefined} />
    </MemoryRouter>
  )

  fireEvent.click(view.getByRole('button', { name: en.desktop.home.inftCollection }))

  return view
}

const listed = (container: HTMLElement) =>
  [...container.ownerDocument.querySelectorAll('.inft-card')].map(card => card.textContent ?? '')

beforeEach(() => {
  window.localStorage.clear()
  $bookChecked.set({})
  $privySession.set({ status: 'in', address: FIXTURE_ADDRESS })
  $inftRoster.set(roster)
  $inftRosterStatus.set('ready')
  $activeInft.set(null)
})

afterEach(() => {
  cleanup()
  $acpConfigMap.set({})
  $privySession.set({ status: 'out' })
  $inftRoster.set([])
  $activeInft.set(null)
})

describe('HomeView under the iNFT Book rule', () => {
  it('a 1 000-iNFT roster with 3 checked: Home lists exactly those 3', () => {
    checkShown(FIXTURE_ADDRESS, [{ id: fixtureId(4) }, { id: fixtureId(500) }, { id: fixtureId(999) }])

    const { container } = renderHome()
    const cards = listed(container)

    expect(cards).toHaveLength(3)
    expect(cards.join(' ')).toContain('#5')
    expect(cards.join(' ')).toContain('#501')
    expect(cards.join(' ')).toContain('#1000')
  })

  it('checking one more in the Book adds exactly that one to Home', () => {
    checkShown(FIXTURE_ADDRESS, [{ id: fixtureId(4) }])

    const { container } = renderHome()

    expect(listed(container)).toHaveLength(1)
    act(() => checkShown(FIXTURE_ADDRESS, [{ id: fixtureId(7) }]))
    expect(listed(container)).toHaveLength(2)
  })

  it('O3: an unchecked iNFT on stage stays on stage, and is not listed', () => {
    checkShown(FIXTURE_ADDRESS, [{ id: fixtureId(4) }])

    const onStage = roster[42]!

    $activeInft.set({ id: onStage.id, name: onStage.name, modelUrl: onStage.modelUrl! })

    const { container, getByTestId } = renderHome()

    expect(getByTestId('stage3d').dataset.model).toBe(onStage.modelUrl)
    expect(container.ownerDocument.querySelector('.ihome__inft-name')?.textContent).toBe(onStage.name.toLowerCase())
    expect(listed(container)).toHaveLength(1)
  })

  it('nothing checked: the stated empty Home, not the wallet', () => {
    checkShown(FIXTURE_ADDRESS, [])

    const { container, getByText } = renderHome()

    expect(listed(container)).toHaveLength(0)
    expect(getByText(en.inftBook.homeEmpty)).toBeTruthy()
  })

  it('N1: no seed yet (the sign-in scan fell short): Home shows the configured iNFTs of the roster, never 0', () => {
    const setUp = (slug: string): InftAcpStatus => ({
      slug,
      cli: true,
      authenticated: true,
      cardReady: false,
      configured: true,
      checkedAt: 1
    })

    $acpConfigMap.set(
      Object.fromEntries([3, 300, 700].map(i => slugForInft(fixtureId(i))).map(slug => [slug, setUp(slug)]))
    )

    const { container } = renderHome()
    const cards = listed(container).join(' ')

    expect(listed(container)).toHaveLength(3)
    expect(cards).toContain('#4')
    expect(cards).toContain('#301')
    expect(cards).toContain('#701')
  })

  it('opening the island refreshes cheaply — it never re-reads the whole wallet', () => {
    const scan = vi.fn(() => new Promise(() => undefined))

    const scanTick = vi.fn(() => new Promise(() => undefined))

    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { iclonePrivy: { scan, scanTick } }

    try {
      renderHome()
      expect(scanTick).toHaveBeenCalledTimes(1)
      expect(scan).not.toHaveBeenCalled()
    } finally {
      delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
    }
  })
})
