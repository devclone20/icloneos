// The Book's honest states (contract §2.7) and the select-all confirmation.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toInftCards } from '@/app/home/inft-scan'
import { en } from '@/i18n/en'

import { FIXTURE_ADDRESS, fixtureItem } from './book-fixture'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: en }) }))
vi.mock('@/app/home/privy-session', async () => {
  const { atom } = await import('nanostores')

  return {
    $inftRoster: atom([]),
    $privySession: atom({ status: 'out' }),
    openPrivyLogin: vi.fn(),
    rescan: vi.fn(() => Promise.resolve())
  }
})
vi.mock('./book-scan', () => ({ retryBookScan: vi.fn(), startBookScan: vi.fn(() => Promise.resolve()) }))

const copy = en.inftBook

async function mount(signedIn: boolean) {
  const privy = await import('@/app/home/privy-session')
  const store = await import('./book-store')
  const { InftBookView } = await import('./index')

  privy.$privySession.set(signedIn ? { status: 'in', address: FIXTURE_ADDRESS } : { status: 'out' })
  render(<InftBookView />)

  return store
}

function fill(store: Awaited<ReturnType<typeof mount>>, n: number, status: 'capped' | 'done' | 'partial' | 'scanning') {
  const cards = toInftCards({
    ok: true,
    source: 'indexer',
    agents: Array.from({ length: n }, (_, i) => fixtureItem(i))
  })

  act(() => {
    store.$bookItems.set(new Map(cards.map(card => [card.id, card])))
    store.$bookScan.set({ status, address: FIXTURE_ADDRESS, cursor: null, error: null })
  })
}

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
})

afterEach(cleanup)

describe('the iNFT Book view', () => {
  it('no wallet: says so and offers sign-in', async () => {
    await mount(false)

    expect(screen.getByText(copy.noWallet)).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.signIn })).toBeTruthy()
    expect(screen.getByText(copy.rule)).toBeTruthy()
  })

  it('wallet with none: says so', async () => {
    const store = await mount(true)

    fill(store, 0, 'done')
    expect(screen.getByText(copy.none)).toBeTruthy()
  })

  it('scanning: the count so far, never a bare spinner', async () => {
    const store = await mount(true)

    fill(store, 0, 'scanning')
    expect(screen.getByRole('status', { name: copy.scanning(0) })).toBeTruthy()
    fill(store, 150, 'scanning')
    expect(screen.getByText(copy.scanning(150))).toBeTruthy()
  })

  it('capped at the 5 000 ceiling: the Book says it shows only the first 5 000', async () => {
    const store = await mount(true)

    fill(store, 30, 'capped')

    expect(screen.getByText(copy.capped(5_000))).toBeTruthy()
    expect(screen.getByText(/Showing the first 5,000 iNFTs/)).toBeTruthy()
  })

  it('Rescan reads the Book and the Home roster in full (the one manual full scan)', async () => {
    const privy = await import('@/app/home/privy-session')
    const scan = await import('./book-scan')
    const store = await mount(true)

    fill(store, 3, 'done')
    vi.mocked(scan.startBookScan).mockClear()
    fireEvent.click(screen.getByRole('button', { name: copy.rescan }))

    expect(scan.startBookScan).toHaveBeenCalledTimes(1)
    expect(privy.rescan).toHaveBeenCalledTimes(1)
  })

  it('partial failure: kept pages + retry', async () => {
    const store = await mount(true)

    fill(store, 400, 'partial')
    expect(screen.getByText(copy.partial(400))).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.retry })).toBeTruthy()
  })

  it('header counts, and select-all on more than 24 asks first', async () => {
    const store = await mount(true)

    fill(store, 30, 'done')
    expect(screen.getByText(copy.count(30, 0))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.checkShown }))
    expect(screen.getByText(copy.confirmTitle(30))).toBeTruthy()
    expect(store.checkedSet(FIXTURE_ADDRESS).size).toBe(0)
  })

  it('K72: confirming checks exactly the cards that were asked about, not the ones that merged in since', async () => {
    const store = await mount(true)

    fill(store, 30, 'scanning')
    fireEvent.click(screen.getByRole('button', { name: copy.checkShown }))
    expect(screen.getByText(copy.confirmTitle(30))).toBeTruthy()

    // The next page lands while the dialog is open: 20 more cards are now shown.
    fill(store, 50, 'scanning')
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: copy.confirmAction })))

    expect(store.checkedSet(FIXTURE_ADDRESS).size).toBe(30)
  })

  it('select-all on 24 or fewer checks them at once; the count follows', async () => {
    const store = await mount(true)

    fill(store, 24, 'done')
    fireEvent.click(screen.getByRole('button', { name: copy.checkShown }))
    expect(store.checkedSet(FIXTURE_ADDRESS).size).toBe(24)
    expect(screen.getByText(copy.count(24, 24))).toBeTruthy()
  })
})
