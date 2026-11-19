import fs from 'node:fs'
import path from 'node:path'

/**
 * v0.0.9 r4 (design r3 N4, N5): the Book reads as a library, not a form, and its states say something. Red on
 * 5470b2b185: the selects took a full row each, the error was one bare line, "Loaded 6 of ?" was debug text, the empty
 * state had no next step, and "We kept 0 on Home" showed for a zero count.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

describe('iNFT Book states (design r3 N5)', () => {
  it('the error names what failed and who, under the error glyph, with Retry', async () => {
    const store = await mount(true)

    fill(store, 0, 'partial')
    const alert = screen.getByRole('alert')

    expect(alert.textContent).toContain(copy.scanFailed)
    expect(alert.textContent).toContain(copy.scanFailedCause)
    expect(copy.scanFailedCause).toMatch(/indexer/)
    expect(copy.scanFailedCause).toMatch(/network/)
    expect(alert.querySelector('svg')).not.toBeNull()
    expect(screen.getAllByRole('button', { name: copy.retry })).toHaveLength(1)
  })

  it('partial says how many are shown, never "of ?"', async () => {
    const store = await mount(true)

    fill(store, 6, 'partial')
    expect(screen.getByText(copy.partial(6)).textContent).toBe("Showing 6 — the rest of the wallet didn't load.")
    expect(copy.partial(6)).not.toContain('?')
  })

  // v0.0.9 r4b (critic-r4 capture 09b): red on 4ba1f24493, where a filtered list of 1 still said "Showing 6".
  it('with a filter on, the partial line counts what is shown of what loaded', async () => {
    const store = await mount(true)

    fill(store, 6, 'partial')
    fireEvent.change(screen.getByPlaceholderText(copy.search), { target: { value: '#1' } })

    expect(screen.getByText(copy.partialFiltered(1, 6)).textContent).toBe(
      "Showing 1 of the 6 that loaded — the rest of the wallet didn't load."
    )
    expect(screen.queryByText(copy.partial(6))).toBeNull()

    fireEvent.change(screen.getByPlaceholderText(copy.search), { target: { value: '' } })
    expect(screen.getByText(copy.partial(6))).toBeTruthy()
  })

  // r4d (eng r4 F5): red on 52cae17554, where the Retry sat beside a danger note.
  it('partial: exactly one Retry, inside the warning alert', async () => {
    const store = await mount(true)

    fill(store, 6, 'partial')
    const alert = screen.getByRole('alert')

    expect(alert.dataset.tone).toBe('warning')
    expect(alert.textContent).toContain(copy.partial(6))
    // One Rescan inside the alert; the only other one is the page's own header Rescan (one verb, design r4 F5-3).
    expect(within(alert).getAllByRole('button', { name: copy.retry })).toHaveLength(1)
    expect(copy.retry).toBe(copy.rescan)
    // r5 (design R5-4): exactly one Rescan in the DOM — the header's steps aside while the alert owns it.
    expect(screen.getAllByRole('button', { name: copy.retry })).toHaveLength(1)
  })

  it('the empty wallet gives a next step', async () => {
    const store = await mount(true)

    fill(store, 0, 'done')
    expect(screen.getByText(copy.noneHint)).toBeTruthy()
  })

  it('"We kept 0 on Home" never shows; a real count still does', async () => {
    const store = await mount(true)

    act(() => store.seedOnce(FIXTURE_ADDRESS, []))
    fill(store, 3, 'done')
    expect(screen.queryByText(copy.kept(0))).toBeNull()
    expect(screen.queryByRole('button', { name: copy.dismiss })).toBeNull()

    cleanup()
    window.localStorage.clear()
    vi.resetModules()
    const again = await mount(true)

    act(() => again.seedOnce(FIXTURE_ADDRESS, [toInftCards({ ok: true, source: 'indexer', agents: [fixtureItem(0)] })[0].id]))
    fill(again, 3, 'done')
    expect(screen.getByText(copy.kept(1))).toBeTruthy()
  })
})

describe('iNFT Book filter bar (design r3 N4)', () => {
  it('the selects size to their content inside the bar instead of a full row each', () => {
    const css = fs.readFileSync(path.join(__dirname, 'inft-book.css'), 'utf8')
    const at = css.indexOf('.inft-book__bar .icui-select {')

    expect(at).toBeGreaterThanOrEqual(0)
    const rule = css.slice(at, css.indexOf('}', at))

    expect(rule).toMatch(/width:\s*auto/)
    expect(rule).toMatch(/flex:\s*0 1 200px/)
  })
})

// r5 (design R5-4): red on b290e6d7f3 — the header Rescan stayed beside the alert's, and the action sat off the line.
describe('the alert action sits on its line', () => {
  it('an IcAlert action is centred on the body line', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../../components/ic/ic-page.css'), 'utf8')

    expect(css).toMatch(/\.icpg__alert > \.icpg__btn \{\s*flex-shrink: 0;\s*align-self: center;/)
  })

  it('with a full scan the header Rescan is back', async () => {
    const store = await mount(true)

    fill(store, 3, 'done')
    expect(screen.getAllByRole('button', { name: copy.rescan })).toHaveLength(1)
  })
})

