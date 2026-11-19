// v0.0.9 F5 — the home iNFT Collection contract (P0_DESIGN_SPECS.md "F5 · iNFT Collection no home"):
// every state, Retry that scans now, the 1/2-column grid, 2-D reorder, the detail plate, names never cut.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { f5Collection as copy } from '@/i18n/en/v009-f5'

import {
  collectionCount,
  CollectionsPanel,
  collectionsView,
  gridColumnsFor,
  type INftCardData,
  parseCardId,
  reorderTarget
} from './collections'

const privy = vi.hoisted(() => ({ openPrivyLogin: vi.fn(), retryInftScan: vi.fn() }))

// F2 exports `retryInftScan` from privy-session.ts; the panel's Retry must call it (and only it).
vi.mock('./privy-session', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openPrivyLogin: privy.openPrivyLogin,
  retryInftScan: privy.retryInftScan
}))

const css = readFileSync(path.join(__dirname, 'collections.css'), 'utf8')
const tokens = readFileSync(path.join(__dirname, 'ic-tokens.css'), 'utf8')

const ATLAS = '0x3d9f35e08c41a80155353862f883f2b70119809f'

function card(i: number, over: Partial<INftCardData> = {}): INftCardData {
  return {
    id: `base:${ATLAS}:${i}`,
    name: `i01 ZEUS #${i}`,
    collection: i % 2 ? 'CLONE FRAME · ATLAS' : 'ERC-8004 · AgentIdentity',
    chain: 'Base',
    configured: false,
    ...over
  }
}

const noop = () => undefined

function panel(props: Partial<Parameters<typeof CollectionsPanel>[0]> = {}) {
  return render(<CollectionsPanel cards={[]} onClose={noop} onSelect={noop} {...props} />)
}

/** The declarations of the first top-level rule whose selector list is exactly `selector` (at a line start, so
 *  `.inft-card-slot--dragging .inft-card {` is never taken for `.inft-card {`). */
function rule(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector} {`)

  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0)

  return source.slice(at, source.indexOf('}', at))
}

beforeEach(() => {
  privy.openPrivyLogin.mockReset()
  privy.retryInftScan.mockReset()
})

afterEach(() => {
  cleanup()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

describe('the panel picks one face per state', () => {
  it('names the view from cards, session and scan state', () => {
    expect(collectionsView({ cards: [card(1)], scanStatus: 'error', signedIn: true })).toBe('grid')
    expect(collectionsView({ cards: [], signedIn: false })).toBe('signed-out')
    // Q proofs F5: no wallet is the empty state even when cards are passed (the old sample roster drew a grid).
    expect(collectionsView({ cards: [card(1), card(2)], signedIn: false })).toBe('signed-out')
    expect(collectionsView({ cards: [card(1)] })).toBe('signed-out')
    expect(collectionsView({ cards: [], scanStatus: 'loading', signedIn: true })).toBe('loading')
    expect(collectionsView({ cards: [], scanStatus: 'error', signedIn: true })).toBe('error')
    expect(
      collectionsView({
        bookEmpty: { action: 'a', line: 'l', onOpen: noop, rule: 'r' },
        cards: [],
        scanStatus: 'ready',
        signedIn: true
      })
    ).toBe('book-empty')
    expect(collectionsView({ cards: [], scanStatus: 'ready', signedIn: true })).toBe('empty')
  })

  it('loading: four skeletons in the card shape, busy, never the "connect" line', () => {
    const { container } = panel({ scanStatus: 'loading', signedIn: true })
    const status = screen.getByRole('status', { name: copy.loading })

    expect(status.getAttribute('aria-busy')).toBe('true')
    expect(container.ownerDocument.querySelectorAll('.inft-skel')).toHaveLength(4)
    expect(container.ownerDocument.querySelectorAll('.inft-skel__art')).toHaveLength(4)
    expect(screen.queryByText(copy.signedOut)).toBeNull()
    // The skeleton wears the card's own shape: a 4:5 art box (r4d F5-1: the art box, not the card, is 4:5).
    expect(rule(css, '.inft-skel__art')).toMatch(/aspect-ratio:\s*4 \/ 5;/)
    expect(rule(css, '.inft-skel')).not.toMatch(/aspect-ratio/)
  })

  it('signed out: says how to see the iNFTs and Connect wallet opens the existing Privy login', () => {
    panel({ signedIn: false })

    expect(screen.getByText(copy.signedOut)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.connectWallet }))
    expect(privy.openPrivyLogin).toHaveBeenCalledTimes(1)
  })

  it('error: an IcAlert with the cause and a Retry that scans now (retryInftScan)', () => {
    panel({ scanError: 'The indexer did not answer.', scanStatus: 'error', signedIn: true })

    // r4d (design r4 F5-2): the alert says it in the owner's words; the raw scan text is behind Details only.
    expect(screen.getByRole('alert').textContent).toContain(copy.scanFailedCause)
    expect(screen.getByRole('alert').textContent).not.toContain('The indexer did not answer.')
    const details = screen.getByRole('button', { name: copy.details })
    const raw = document.getElementById(details.getAttribute('aria-controls')!)!

    expect(raw.hidden).toBe(true)
    fireEvent.click(details)
    expect(raw.hidden).toBe(false)
    expect(raw.textContent).toBe('The indexer did not answer.')
    expect(screen.queryByText(/retries on the next open/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: copy.retry }))
    expect(privy.retryInftScan).toHaveBeenCalledTimes(1)
  })

  // v0.0.9 r4b (critic-r4 capture 08): red on 4ba1f24493, where the Retry was a separate button under the alert.
  it('error: exactly one Retry, and it is inside the alert', () => {
    panel({ scanError: 'fixture: the scan failed', scanStatus: 'error', signedIn: true })

    const alert = screen.getByRole('alert')

    expect(screen.getAllByRole('button', { name: copy.retry })).toHaveLength(1)
    expect(alert.contains(screen.getByRole('button', { name: copy.retry }))).toBe(true)
  })

  it('error without a cause falls back to the stated line', () => {
    panel({ scanError: null, scanStatus: 'error', signedIn: true })

    expect(screen.getByRole('alert').textContent).toContain(copy.scanFailed)
  })

  it('partial: the cards that loaded stay, an inline alert names what is missing, Retry scans now', () => {
    const { container } = panel({
      cards: [card(1), card(2)],
      missingCollections: ['Solana', 'BNB Chain'],
      scanStatus: 'ready',
      signedIn: true
    })

    expect(container.ownerDocument.querySelectorAll('.inft-card')).toHaveLength(2)
    expect(screen.getByRole('alert').textContent).toContain('Solana, BNB Chain')
    // Q renderer 6: a partly successful scan is a warning (still announced), never the error tone.
    expect(screen.getByRole('alert').dataset.tone).toBe('warning')
    fireEvent.click(screen.getByRole('button', { name: copy.retry }))
    expect(privy.retryInftScan).toHaveBeenCalledTimes(1)
  })

  it('a failed refresh over a loaded roster is partial too, never a blank panel', () => {
    const { container } = panel({ cards: [card(1)], scanStatus: 'error', signedIn: true })

    expect(container.ownerDocument.querySelectorAll('.inft-card')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain(copy.partial([]))
    expect(screen.getByRole('alert').dataset.tone).toBe('warning')
  })

  it('a failed refresh with no names to give says the scan\'s own reason (Q renderer 6)', () => {
    panel({ cards: [card(1)], scanError: 'The indexer timed out.', scanStatus: 'error', signedIn: true })

    expect(screen.getByRole('alert').querySelector('.icpg__alert-text')?.textContent).toBe(
      'Some collections could not be read (The indexer timed out). The iNFTs below are the ones that loaded.'
    )
    expect(screen.getByRole('alert').dataset.tone).toBe('warning')
  })

  it('signed in with nothing: its own line, no grid', () => {
    const { container } = panel({ scanStatus: 'ready', signedIn: true })

    expect(screen.getByText(copy.emptyWallet)).toBeTruthy()
    expect(container.ownerDocument.querySelector('.inft-panel__body')).toBeNull()
  })
})

describe('the header', () => {
  it('title, "N iNFTs · M collections", Open iNFT Book and the close', () => {
    const onOpenBook = vi.fn()
    const cards = [card(1), card(2), card(3)]

    panel({ cards, onOpenBook, scanStatus: 'ready', signedIn: true })

    expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy()
    expect(screen.getByText(copy.count(3, collectionCount(cards)))).toBeTruthy()
    expect(screen.getByText('3 iNFTs · 2 collections')).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.close })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.openBook }))
    expect(onOpenBook).toHaveBeenCalledTimes(1)
  })

  it('Open iNFT Book is in the header in every state, not only when the panel is empty', () => {
    for (const props of [
      { scanStatus: 'loading' as const, signedIn: true },
      { signedIn: false },
      { scanStatus: 'error' as const, signedIn: true },
      { cards: [card(1)], scanStatus: 'ready' as const, signedIn: true }
    ]) {
      panel({ ...props, onOpenBook: noop })
      expect(screen.getByRole('button', { name: copy.openBook })).toBeTruthy()
      cleanup()
    }
  })

  it('counts one of each in the singular', () => {
    expect(copy.count(1, 1)).toBe('1 iNFT · 1 collection')
  })
})

describe('the grid', () => {
  it('2 columns from 460 px of useful width, 1 below', () => {
    expect(gridColumnsFor(459)).toBe(1)
    expect(gridColumnsFor(460)).toBe(2)
    expect(gridColumnsFor(344)).toBe(1)
    expect(gridColumnsFor(520)).toBe(2)
  })

  it.each([
    [520, '2'],
    [400, '1']
  ])('a grid %d px wide renders %s column(s)', (width, cols) => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('inft-panel__body') ? width : 0
      }
    })

    const { container } = panel({ cards: [card(1), card(2), card(3)], scanStatus: 'ready', signedIn: true })
    const grid = container.ownerDocument.querySelector<HTMLElement>('.inft-panel__body')

    expect(grid?.dataset.cols).toBe(cols)
    expect(grid?.style.getPropertyValue('--inft-cols')).toBe(cols)
  })

  it('the grid reads the measured column count; the panel is clamp(384px, 34vw, 560px)', () => {
    expect(rule(css, '.inft-panel__body')).toMatch(/grid-template-columns:\s*repeat\(var\(--inft-cols, 1\)/)
    expect(rule(css, '.inft-panel')).toMatch(/width:\s*min\(var\(--ic-inft-panel-w\)/)
    expect(tokens).toMatch(/--ic-inft-panel-w:\s*clamp\(384px, 34vw, 560px\);/)
    expect(tokens).toMatch(/--ic-inft-grid-gap:\s*14px;/)
  })

  it('reorders in 2-D: a pitch right is the next column, a pitch down is the next row', () => {
    // 2 columns, card box 200 x 250 + 14 gap.
    expect(reorderTarget(0, 214, 0, 2, 214, 264, 6)).toBe(1)
    expect(reorderTarget(0, 0, 264, 2, 214, 264, 6)).toBe(2)
    expect(reorderTarget(0, 214, 264, 2, 214, 264, 6)).toBe(3)
    expect(reorderTarget(3, -214, -264, 2, 214, 264, 6)).toBe(0)
    // Kept inside the grid: no column past the edge, no slot past the last card.
    expect(reorderTarget(1, 900, 0, 2, 214, 264, 6)).toBe(1)
    expect(reorderTarget(4, 0, 9_999, 2, 214, 264, 5)).toBe(4)
    // One column: only rows count.
    expect(reorderTarget(0, 500, 264, 1, 214, 264, 4)).toBe(1)
  })

  it('a drag over a 2-column grid hands the new order to onReorder', () => {
    const onReorder = vi.fn()
    const onSelect = vi.fn()

    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('inft-panel__body') ? 520 : 0
      }
    })

    panel({ cards: [card(1), card(2), card(3), card(4)], onReorder, onSelect, scanStatus: 'ready', signedIn: true })

    const first = screen.getByRole('button', { name: copy.cardLabel(card(1).name, card(1).collection) })
    // jsdom lays nothing out: the measured slot is 0 x 0, so one pitch is the 14 px gap.
    fireEvent.pointerDown(first, { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(first, { clientX: 14, clientY: 14, pointerId: 1 })
    fireEvent.pointerUp(first, { clientX: 14, clientY: 14, pointerId: 1 })
    fireEvent.click(first)

    expect(onReorder).toHaveBeenCalledWith([card(2).id, card(3).id, card(4).id, card(1).id])
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('the card', () => {
  it('4:5 portrait art; the tilt is 4° and off under reduced motion', () => {
    const base = rule(css, '.inft-card')

    // r4d (design r4 F5-1): the ART box is 4:5 and shows the art whole; the card grows by its caption.
    expect(rule(css, '.inft-card__art')).toMatch(/aspect-ratio:\s*4 \/ 5;/)
    expect(base).not.toMatch(/aspect-ratio/)
    expect(base).toMatch(/var\(--ic-inft-card-tilt\)/)
    expect(base).not.toMatch(/7deg/)
    expect(tokens).toMatch(/--ic-inft-card-tilt:\s*4deg;/)

    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))

    const still = reduced.slice(reduced.indexOf('.inft-card:not(:hover):not(:focus-within) {'))

    expect(reduced).toMatch(/\.inft-card,\s*\n\s*\.inft-card:not\(:hover\):not\(:focus-within\) \{/)
    expect(still.slice(0, still.indexOf('}'))).toMatch(/transform:\s*none !important;/)
  })

  it('a long name is never cut: it wraps, with no ellipsis and no nowrap', () => {
    const long = 'i01 ZEUS OF THE NORTHERN THUNDER — FIRST ARCHON OF THE ATLAS'
    const { container } = panel({ cards: [card(1, { name: long })], scanStatus: 'ready', signedIn: true })
    const name = rule(css, '.inft-card__name')

    expect(container.ownerDocument.querySelector('.inft-card__name')?.textContent).toBe(long)
    expect(name).not.toMatch(/text-overflow/)
    expect(name).not.toMatch(/white-space:\s*nowrap/)
    expect(name).not.toMatch(/line-clamp/)
    expect(name).toMatch(/overflow-wrap:\s*anywhere;/)
  })

  it('collection · chain under the name, one state in the corner', () => {
    const { container } = panel({
      cards: [card(1, { configured: true }), card(2)],
      scanStatus: 'ready',
      signedIn: true
    })

    const [gold, dim] = [...container.ownerDocument.querySelectorAll<HTMLElement>('.inft-card__state')]

    expect(container.ownerDocument.querySelector('.inft-card__meta')?.textContent).toBe('CLONE FRAME · ATLAS · Base')
    expect(gold.textContent).toBe(copy.economyOs)
    expect(gold.dataset.tone).toBe('gold')
    expect(dim.textContent).toBe(copy.setupNeeded)
  })

  it('Tab lands on the card and Enter (a click) opens it — the same switchInft path as before', () => {
    const onSelect = vi.fn()

    panel({ cards: [card(7)], onSelect, scanStatus: 'ready', signedIn: true })

    const open = screen.getByRole('button', { name: copy.cardLabel(card(7).name, card(7).collection) })

    open.focus()
    expect(open.ownerDocument.activeElement).toBe(open)
    fireEvent.click(open)
    expect(onSelect).toHaveBeenCalledWith(card(7).id)
  })

  it('the detail plate: token, chain, short contract, Open, and Set up only when setup is missing', () => {
    const onSelect = vi.fn()
    const onSetUp = vi.fn()

    const { container } = panel({
      cards: [card(7), card(8, { configured: true })],
      onSelect,
      onSetUp,
      scanStatus: 'ready',
      signedIn: true
    })

    const [plate, configuredPlate] = [...container.ownerDocument.querySelectorAll<HTMLElement>('.inft-card__plate')]

    expect(plate.textContent).toContain('#7')
    expect(plate.textContent).toContain('Base')
    expect(plate.textContent).toContain('0x3d9f…809f')
    fireEvent.click(within(plate).getByRole('button', { name: copy.openLabel(card(7).name) }))
    expect(onSelect).toHaveBeenCalledWith(card(7).id)
    fireEvent.click(within(plate).getByRole('button', { name: copy.setUp }))
    expect(onSetUp).toHaveBeenCalledWith(card(7).id)
    expect(within(configuredPlate).queryByRole('button', { name: copy.setUp })).toBeNull()
  })

  it('the plate rides inside the art, so it can never cover the name', () => {
    const { container } = panel({ cards: [card(1)], scanStatus: 'ready', signedIn: true })
    const plate = container.ownerDocument.querySelector('.inft-card__plate')

    expect(plate?.closest('.inft-card__art')).not.toBeNull()
    expect(plate?.contains(container.ownerDocument.querySelector('.inft-card__name'))).toBe(false)
    expect(css).toMatch(/\.inft-card:hover \.inft-card__plate,\s*\n\.inft-card:focus-within \.inft-card__plate \{/)
  })

  it('Copy on the contract says Copied, or Couldn\'t copy when the clipboard refuses', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    panel({ cards: [card(1)], scanStatus: 'ready', signedIn: true })

    const copyButton = screen.getByRole('button', { name: copy.copyContract(ATLAS) })

    await act(async () => void fireEvent.click(copyButton))
    expect(writeText).toHaveBeenCalledWith(ATLAS)
    expect(copyButton.textContent).toContain(copy.copied)

    await act(async () => void fireEvent.click(copyButton))
    expect(copyButton.textContent).toContain(copy.copyFailed)
  })

  it('parses the scan id into chain, contract and token', () => {
    expect(parseCardId(`base:${ATLAS}:42`)).toEqual({ chain: 'base', contract: ATLAS, tokenId: '42' })
    expect(parseCardId('soul-only')).toBeNull()
  })
})

// r4d (design r4 F5-1, F5-3). Red on 52cae17554: the card, not its art, was 4:5; the partial Retry sat after the alert.
describe('r4d: the card shows its art whole; the partial Rescan rides in its alert', () => {
  it('partial: exactly one Rescan, inside the warning alert', () => {
    panel({ cards: [card(1)], missingCollections: ['Solana'], scanStatus: 'ready', signedIn: true })

    const alert = screen.getByRole('alert')

    expect(copy.retry).toBe('Rescan')
    expect(screen.getAllByRole('button', { name: copy.retry })).toHaveLength(1)
    expect(alert.contains(screen.getByRole('button', { name: copy.retry }))).toBe(true)
  })

  it('the raw scan error never reaches the alert, with or without a cause', () => {
    panel({ scanError: 'HTTP 502 from indexer.example: upstream reset', scanStatus: 'error', signedIn: true })

    expect(screen.getByRole('alert').textContent).not.toMatch(/HTTP 502/)
    expect(screen.getByRole('alert').querySelector('.icpg__alert-title')?.textContent).toBe(copy.scanFailed)
  })
})

// r5 (design R5-7): red on b290e6d7f3 — the focus plate climbed over the art's face (10b).
describe('r5: the detail plate keeps to the bottom of the art', () => {
  it('its top never rises above 60 % of the art box', () => {
    const plate = rule(css, '.inft-card__plate')

    expect(plate).toMatch(/max-height: calc\(40% - 8px\);/)
    expect(plate).toMatch(/bottom: 8px;/)
    expect(plate).toMatch(/overflow-y: auto;/)
  })
})

