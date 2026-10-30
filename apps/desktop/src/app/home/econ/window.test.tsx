import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setDockWindowSize } from '@/store/dock-window-size'

import { $acpConfigMap, type InftAcpStatus } from '../acp-setup'
import { $privySession } from '../privy-session'
import type * as Window from '../window'

import { $econStatus, READ_FAILED_TEXT, reportEconStatus, SAVED_MAIL_TEXT } from './live'
import { $liveEconEnabled } from './prefs'
import { EconWindow, resetConfiguredLatch, resolveConfigured } from './window'

const mounts = vi.hoisted(() => ({ count: 0, unmounts: 0 }))

// Only the chrome is stubbed. `../window` also exports inftGate, which this file's
// gating cases exercise for real, so the module's own exports are kept.
vi.mock('../window', async importOriginal => ({
  ...(await importOriginal<typeof Window>()),
  // The real chassis' two attributes, so a case can read how the window opened (window/expanded.ts).
  IcWindow: ({
    children,
    expanded,
    head,
    id,
    onToggleExpanded
  }: {
    children: React.ReactNode
    expanded: boolean
    head: React.ReactNode
    id: string
    onToggleExpanded: () => void
  }) => (
    <div data-expanded={expanded ? 'true' : undefined} data-ic-window={id}>
      <button onClick={onToggleExpanded} type="button">
        toggle size
      </button>
      <header>{head}</header>
      {children}
    </div>
  )
}))

vi.mock('./agent', () => ({
  loadAgentIdentity: vi.fn(async () => null),
  useAgentIdentity: () => null
}))

vi.mock('./registry', () => {
  function FakeApp({ slug }: { slug: string }) {
    useEffect(() => {
      mounts.count += 1

      return () => {
        mounts.unmounts += 1
      }
    }, [])

    return <p data-testid="app">app for {slug}</p>
  }

  const meta = { title: 'Email', Icon: () => null, App: FakeApp }

  return { ECON_APPS: { email: meta, wallet: meta, bank: meta, hyperliquid: meta, acp: meta } }
})

const SLUG = 'robinhood-0xabc-7'
const onOpenInfts = vi.fn()
const INFT = 'robinhood:0xabc:7'

function probe(configured: boolean, checkedAt: number, stale = false): InftAcpStatus {
  return { cli: true, authenticated: configured, cardReady: false, configured, checkedAt, slug: SLUG, stale }
}

function view(configured: boolean, extra: Partial<{ inftId?: string; slug?: string }> = {}) {
  return (
    <MemoryRouter>
      <EconWindow
        configured={configured}
        inftId={'inftId' in extra ? extra.inftId : INFT}
        inftName="iNFT #7"
        kind="email"
        onClose={() => undefined}
        onOpenInfts={onOpenInfts}
        slug={'slug' in extra ? extra.slug : SLUG}
      />
    </MemoryRouter>
  )
}

beforeEach(() => {
  resetConfiguredLatch()
  mounts.count = 0
  mounts.unmounts = 0
  $privySession.set({ status: 'in', address: '0x1' } as never)
  $acpConfigMap.set({})
  $liveEconEnabled.set(true)
  $econStatus.set({})
})

afterEach(() => {
  cleanup()
})

describe('EconWindow configured latch', () => {
  it('keeps a mounted app across a transient configured=false (partial roster scan)', () => {
    const { rerender } = render(view(true))

    expect(screen.getByTestId('app')).toBeTruthy()

    // A partial ok:true scan drops the staged token from the roster: the
    // window is told configured=false three rescans in a row.
    for (let scan = 0; scan < 3; scan += 1) {
      rerender(view(false))
      rerender(view(true))
    }

    rerender(view(false))
    expect(screen.getByTestId('app')).toBeTruthy()
    expect(mounts.count).toBe(1)
    expect(mounts.unmounts).toBe(0)
  })

  it('survives the window itself closing and reopening (module-level, keyed by slug)', () => {
    render(view(true))
    cleanup()
    render(view(false))
    expect(screen.getByTestId('app')).toBeTruthy()
  })

  it('is released by a fresh probe newer than the latch that says configured=false (detach)', () => {
    vi.useFakeTimers()

    try {
      vi.setSystemTime(10_000)
      const { rerender } = render(view(true))

      // An old or stale probe does not release it…
      act(() => $acpConfigMap.set({ [SLUG]: probe(false, 5_000) }))
      rerender(view(false))
      expect(screen.getByTestId('app')).toBeTruthy()
      act(() => $acpConfigMap.set({ [SLUG]: probe(false, 20_000, true) }))
      rerender(view(false))
      expect(screen.getByTestId('app')).toBeTruthy()

      // …a fresh one does.
      act(() => $acpConfigMap.set({ [SLUG]: probe(false, 20_000) }))
      rerender(view(false))
      expect(screen.queryByTestId('app')).toBeNull()
      expect(screen.getByText('Setup needed')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gates on sign-out even when the config map still says configured', () => {
    const { rerender } = render(view(true))

    act(() => $privySession.set({ status: 'out' } as never))
    rerender(view(true))
    expect(screen.queryByTestId('app')).toBeNull()
    expect(screen.getByText('Signed out')).toBeTruthy()

    // Signing back in does not resurrect the latch: the window waits for a
    // real configured=true again.
    rerender(view(false))
    act(() => $privySession.set({ status: 'in', address: '0x1' } as never))
    expect(screen.getByText('Setup needed')).toBeTruthy()
  })

  it('still gates with no iNFT on stage and with the live engine off', () => {
    const { rerender } = render(view(true))

    rerender(view(true, { inftId: undefined, slug: undefined }))
    expect(screen.getByText('Summon an iNFT')).toBeTruthy()
    rerender(view(true))
    act(() => $liveEconEnabled.set(false))
    expect(screen.getByText('Live engine is off')).toBeTruthy()
  })

  it('never latches a slug that has not been configured', () => {
    expect(resolveConfigured(SLUG, false, undefined, true)).toBe(false)
    expect(resolveConfigured(undefined, true, undefined, true)).toBe(false)
  })
})

describe('EconWindow header', () => {
  it('a silent tick keeps the words and pulses the live dot; only the button says refreshing', () => {
    render(view(true))
    act(() => reportEconStatus('email', SLUG, { refreshing: false, updatedAt: Date.now() - 12_000 }))

    const text = () => window.document.querySelector('.iecon__status-text')?.textContent
    const dot = () => window.document.querySelector('.iecon__status-dot')?.className

    expect(text()).toMatch(/^updated /)
    const before = text()

    act(() => reportEconStatus('email', SLUG, { refreshing: true, silent: true }))
    expect(text()).toBe(before)
    expect(dot()).toContain('iecon__status-dot--live')
    expect(window.document.querySelector('.e-ibtn--spin')).toBeNull()

    act(() => reportEconStatus('email', SLUG, { refreshing: true, silent: false }))
    expect(text()).toBe('refreshing…')
    expect(dot()).not.toContain('--live')
  })

  it('says saved mail in the header while the rows come from disk', () => {
    render(view(true))
    act(() => reportEconStatus('email', SLUG, { snapshotAt: Date.now() - 3 * 3_600_000 }))
    expect(window.document.querySelector('.iecon__status-text')?.textContent).toBe(SAVED_MAIL_TEXT)
  })

  it('titles a cut error with its full words, and only an error', () => {
    const error = 'acp: command failed: connect ECONNREFUSED 127.0.0.1:443 — retrying in 30 seconds'
    const line = () => window.document.querySelector('.iecon__status-text')

    render(view(true))
    act(() => reportEconStatus('email', SLUG, { updatedAt: Date.now() - 12_000 }))
    expect(line()?.hasAttribute('title')).toBe(false)

    act(() => reportEconStatus('email', SLUG, { error }))
    expect(line()?.textContent).toBe(error)
    expect(line()?.getAttribute('title')).toBe(error)

    act(() => reportEconStatus('email', SLUG, { error: null, updatedAt: Date.now() }))
    expect(line()?.textContent).toMatch(/^updated /)
    expect(line()?.hasAttribute('title')).toBe(false)
  })

  it('shows a blank error as a failed read, styled and titled as an error', () => {
    const box = () => window.document.querySelector('.iecon__status')
    const line = () => window.document.querySelector('.iecon__status-text')

    render(view(true))
    act(() => reportEconStatus('email', SLUG, { updatedAt: Date.now() - 5_000 }))
    act(() => reportEconStatus('email', SLUG, { error: '' }))
    expect(line()?.textContent).toBe(READ_FAILED_TEXT)
    expect(line()?.getAttribute('title')).toBe(READ_FAILED_TEXT)
    expect(box()?.className).toContain('iecon__status--error')
    expect(box()?.getAttribute('data-status')).toBe('error')
  })
})

describe('the "Summon an iNFT" gate (U1-04-p2)', () => {
  it("carries an 'Open iNFTs' action that opens the island", () => {
    act(() => $privySession.set({ status: 'in', address: '0x1' } as never))
    render(view(false, { inftId: undefined, slug: undefined }))

    expect(screen.getByText('Summon an iNFT')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open iNFTs' }))
    expect(onOpenInfts).toHaveBeenCalledOnce()
  })
})

describe('how an econ window opens (Settings › Machine › Appearance)', () => {
  afterEach(() => setDockWindowSize('maximized'))

  const econ = (kind: 'bank' | 'email') => (
    <MemoryRouter>
      <EconWindow
        configured
        inftId={INFT}
        kind={kind}
        onClose={() => undefined}
        onOpenInfts={onOpenInfts}
        slug={SLUG}
      />
    </MemoryRouter>
  )

  const frame = () => window.document.querySelector<HTMLElement>('[data-ic-window]')!

  it('opens maximized by default; another kind in the same chassis opens as the choice says, not as the last one', () => {
    const { rerender } = render(econ('email'))

    expect(frame().dataset.expanded).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'toggle size' }))
    expect(frame().dataset.expanded).toBeUndefined()

    rerender(econ('bank'))
    expect(frame().dataset.icWindow).toBe('bank-card')
    expect(frame().dataset.expanded).toBe('true')
  })

  it('opens on its frame with the choice "normal size"', () => {
    setDockWindowSize('normal')
    render(econ('email'))

    expect(frame().dataset.expanded).toBeUndefined()
  })
})
