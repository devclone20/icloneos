import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { ptPt } from '@/i18n/pt-PT'
import type { Locale, Translations } from '@/i18n/types'
import { $acpWork, $acpWorkNotice } from '@/store/acp-work'

import { workViewFixture } from './fixture'
import { WorkTab } from './work-tab'

const SLUG = 'robinhood-1'

// Ruling 69 (owner, 2026-10-25, supersedes 61): the app ships in ENGLISH ONLY, so `I18nProvider initialLocale` can
// no longer select a language. The pt-PT row below is not about a reader picking Portuguese: its point is that the
// Work tab reads its words from the `acpWork` catalogue (useWorkCopy) and has none hardcoded. So the catalogue is
// forced — `vi.mock('@/i18n')`, the repo's idiom — instead of selected. G-31 brings the picker back.
const ENGLISH: { locale: Locale; t: Translations } = { locale: 'en', t: en }
const PORTUGUESE: { locale: Locale; t: Translations } = { locale: 'pt-PT', t: ptPt }

let shown = ENGLISH

vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, setLocale: vi.fn(), ...shown })
}))

function mount(view = workViewFixture(), words = ENGLISH) {
  const bridge = {
    state: vi.fn(() => Promise.resolve(view)),
    refresh: vi.fn(() => Promise.resolve(view)),
    setLevel: vi.fn(() => Promise.resolve({ ok: true as const })),
    online: vi.fn(() => Promise.resolve({ ok: true as const })),
    offline: vi.fn(() => Promise.resolve({ ok: true as const, open: [], escrowMicros: 0 })),
    reboot: vi.fn(() => Promise.resolve({ ok: true as const })),
    repair: vi.fn(() => Promise.resolve({ ok: true as const })),
    approve: vi.fn(() => Promise.resolve({ ok: true as const })),
    decline: vi.fn(() => Promise.resolve({ ok: true as const })),
    onChanged: vi.fn(() => () => undefined)
  }

  Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneAcpWork: bridge } })
  $acpWork.set({ [SLUG]: view })
  shown = words
  render(<WorkTab slug={SLUG} />)

  return bridge
}

afterEach(() => {
  $acpWork.set({})
  $acpWorkNotice.set({})
  shown = ENGLISH
})

describe('ACP Market › Work', () => {
  it('shows the state, the totals, the honest meaning of online and the earn-only promise', () => {
    mount()
    expect(screen.getByText('Online')).toBeTruthy()
    expect(screen.getByText(/not verified yet/)).toBeTruthy()
    expect(screen.getByText(/never spends, hires or tops up/)).toBeTruthy()
    expect(screen.getByText('Take offline')).toBeTruthy()
    expect(screen.queryByText('Put online')).toBeNull()
  })

  it('every owner decision control carries the gesture lock marker', () => {
    mount()

    for (const name of ['Approve', 'Decline', 'Observe', 'Approve each job', 'Act within policy']) {
      expect(screen.getByRole('button', { name }).hasAttribute('data-acp-work-confirm')).toBe(true)
    }

    expect(screen.getByRole('button', { name: 'Take offline' }).hasAttribute('data-acp-work-confirm')).toBe(false)
  })

  it('approve and decline call main in the click itself', () => {
    const bridge = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(bridge.approve).toHaveBeenCalledWith(SLUG, '3')
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(bridge.decline).toHaveBeenCalledWith(SLUG, '3')
  })

  it('a refused offer names its rule and offers no Approve', () => {
    mount()
    expect(screen.getByText(/the fee is below the floor/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1)
  })

  it('observe-only (spend/trade off) hides the decisions and says why', () => {
    mount(workViewFixture({ level: 'L2', effective: 'L0', downgrade: 'spend-trade-off' }))
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText(/Spend and trade is off/)).toBeTruthy()
  })

  it('a drain names the job that blocks it; an offline iNFT offers Put online', () => {
    mount(workViewFixture({ state: 'draining', blocking: ['2'] }))
    expect(screen.getByText('Waiting on job 2 before the listener stops.')).toBeTruthy()
  })

  it('traces each row and marks a gap as missing', () => {
    mount()
    expect(screen.getAllByText(/missing/).length).toBeGreaterThan(0)
    expect(screen.getByText('Payments')).toBeTruthy()
    expect(screen.getByText('The listener exited')).toBeTruthy()
  })

  it('offline shows Put online, and the honest stop report after Take offline', async () => {
    const bridge = mount(workViewFixture({ state: 'offline' }))

    fireEvent.click(screen.getByRole('button', { name: 'Put online' }))
    expect(bridge.online).toHaveBeenCalledWith(SLUG)
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))
    await act(async () => {
      $acpWorkNotice.set({
        [SLUG]: {
          kind: 'stop',
          report: { ok: true, open: [{ jobId: '2', status: 'funded' }], escrowMicros: 2_000_000 }
        }
      })
    })
    expect(screen.getByText('1 job is still open, $2.00 in escrow.')).toBeTruthy()
  })

  it('speaks Portuguese (Portugal) from the catalogue', () => {
    mount(workViewFixture(), PORTUGUESE)
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy()
  })
})

describe('ACP Market › Work in the web build', () => {
  it('says Work needs the desktop app instead of spinning forever', () => {
    Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneAcpWork: undefined } })
    render(<WorkTab slug={SLUG} />)
    expect(screen.getByText(/runs in the desktop app/)).toBeTruthy()
  })

  it('says why WORK holds the iNFT offline (sign-out, wallet switch, a sale, a resume waiting on its proof)', () => {
    mount(workViewFixture({ state: 'offline', hold: 'ownership-lost' }))
    expect(screen.getByText(/no longer in your wallet/)).toBeTruthy()
  })

  it('a broken ledger shows the Repair action, behind the gesture lock, and never a dead end', async () => {
    const bridge = mount(workViewFixture({ chain: { ok: false, records: 3, gaps: 0 } }))
    const repair = screen.getByRole('button', { name: 'Repair ledger' })

    expect(repair.hasAttribute('data-acp-work-confirm')).toBe(true)
    expect(screen.getByText(/sets the damaged file aside/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(repair)
    })
    expect(bridge.repair).toHaveBeenCalledWith(SLUG)
  })

  it('a ledger with recorded gaps says so, and offers no repair', () => {
    mount(workViewFixture({ chain: { ok: true, records: 12, gaps: 1 } }))
    expect(screen.getByText(/One write was interrupted or repaired/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Repair ledger' })).toBeNull()
  })
})
