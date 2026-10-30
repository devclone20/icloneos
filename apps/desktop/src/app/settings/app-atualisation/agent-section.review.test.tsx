// V3-0: the Update button is honest about the gate. A cached non-GREEN (or missing) verdict, or a refusal the gate
// recorded for this target, makes "Review compatibility" the primary action; the review mints main's owner ack (the
// overlay chip's flow) before the gesture-guarded confirm; the gate's last refusal is read back from main after a
// restart and named on the pane with its time.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enAgentUpdate } from '@/i18n/en'
import { __resetAgentUpdate } from '@/store/agent-update'
import type { IcloneCompatRefusal, IcloneCompatStatus, IcloneCompatVerdict } from '@/types/iclone-compat'
import type { IcloneAgentUpdateCheck, IcloneRuntimeStatus } from '@/types/iclone-updates'

import { momentLabel } from './agent-model'
import { AgentUpdateSection } from './agent-section'

const compat = vi.hoisted(() => ({
  beginOwnerHold: vi.fn(),
  cancelOwnerHold: vi.fn(async () => undefined),
  refreshCompatStatus: vi.fn(async () => null),
  releaseOwnerHold: vi.fn()
}))

// These tests drive the upstream door (closed in 0.0.3, K-RT3: agent-section.door.test.tsx); it stays tested for when
// a release opens it again.
vi.mock('@/iclone-shared/update-status', async importOriginal => ({
  ...(await importOriginal<object>()),
  AGENT_UPDATE_DOOR_OPEN: true
}))

vi.mock('@/store/iclone-compat', () => ({
  $compatStatus: atom<IcloneCompatStatus | null>(null),
  $compatVerdict: atom<IcloneCompatVerdict | null>(null),
  ...compat
}))

vi.mock('@/store/iclone-updates', () => ({
  $runtimeStatus: atom<IcloneRuntimeStatus | null>(null),
  loadRuntimeStatus: vi.fn()
}))

vi.mock('@/store/updates', () => ({
  $desktopVersion: atom({ runtimeVersion: '0.21.5' }),
  $updateOverlayTarget: atom('client'),
  $updatePolicy: atom({
    pin: { date: '2026-10-06', sha: 'a'.repeat(40), verified: 'amber:2-roots' },
    policy: 'curated'
  }),
  applyUpdates: vi.fn(),
  isCuratedPolicy: (info: null | { policy: string }) => info?.policy !== 'developer',
  setUpdateOverlayOpen: vi.fn()
}))

const { $compatStatus, $compatVerdict } = await import('@/store/iclone-compat')

const TIP = 'b'.repeat(40)

const check = (verdict: 'AMBER' | 'GREEN' | 'RED' | null): IcloneAgentUpdateCheck => ({
  checkedAt: new Date().toISOString(),
  compat: verdict ? { findings: [], verdict } : null,
  error: null,
  installed: {
    branch: 'main',
    date: '2026-10-06T10:00:00Z',
    dirty: false,
    sha: 'a'.repeat(40),
    version: '0.21.5',
    verifiedWithRelease: true
  },
  latest: { commitsNewer: 12, date: '2026-10-18T10:00:00Z', releaseTag: null, sha: TIP, version: '0.22.0' },
  updateAvailable: true,
  verified: { sha: 'a'.repeat(40), version: '0.21.5' }
})

const pending = (level: 'AMBER' | 'GREEN' | 'RED', to = TIP.slice(0, 10)): IcloneCompatVerdict => ({
  schema: 1,
  id: `v-${level}`,
  kind: 'preview',
  level,
  computedAt: new Date().toISOString(),
  computedMs: 1,
  runtime: { from: 'a'.repeat(10), to, contractHash: 'x', isDescendant: true, specCoverage: [] },
  state: {},
  cards: [
    {
      root: 'server-requests',
      level: 'RED',
      items: 2,
      names: ['setup_beat', 'theme.apply'],
      rules: [],
      upstream: [],
      ticket: null,
      sites: 0
    },
    { root: 'events', level: 'AMBER', items: 1, names: ['stream.up'], rules: [], upstream: [], ticket: null, sites: 0 },
    {
      root: 'methods',
      level: 'GREEN',
      items: 1,
      names: ['never.named'],
      rules: [],
      upstream: [],
      ticket: null,
      sites: 0
    }
  ],
  perSpec: []
})

const refusal = (target: null | string, at = '2026-10-21T05:23:00Z'): IcloneCompatRefusal => ({
  at,
  level: 'RED',
  reason: 'owner-ack-required',
  target,
  verdictId: 'v-RED'
})

function setStatus(lastRefusal: IcloneCompatRefusal | null) {
  $compatStatus.set({
    guard: null,
    holdMs: { AMBER: 0, GREEN: 0, RED: 3000, UNKNOWN: 1500 },
    lastRefusal,
    latest: null,
    pending: null,
    probe: null
  })
}

function bridge(last: IcloneAgentUpdateCheck, overrides: Record<string, unknown> = {}) {
  const api = {
    apply: vi.fn(async () => ({ compat: null, ok: true })),
    check: vi.fn(async () => last),
    gesture: vi.fn(async () => ({ gesture: { expiresAt: 1, token: 'tok' }, ok: true })),
    lastCheck: vi.fn(async () => last),
    ...overrides
  }

  ;(window as unknown as { hermesDesktop: Record<string, unknown> }).hermesDesktop = { agentUpdate: api }

  return api
}

async function mount() {
  render(<AgentUpdateSection />)
  await act(async () => undefined)
}

const primary = () =>
  globalThis.document.querySelector<HTMLButtonElement>(
    '[data-agent-update-action="review"], [data-agent-update-action="update"]'
  )

describe('Settings › Updates › Agent — compatibility review (V3-0)', () => {
  beforeEach(() => {
    __resetAgentUpdate()
    $compatVerdict.set(null)
    $compatStatus.set(null)

    for (const fn of Object.values(compat)) {
      fn.mockClear()
    }

    compat.beginOwnerHold.mockImplementation(async () => ({
      holdMs: 3000,
      nonce: 'n1',
      ok: true,
      phase: 'begin',
      verdictId: 'v-RED'
    }))
    compat.releaseOwnerHold.mockImplementation(async () => ({
      heldMs: 3000,
      ok: true,
      phase: 'mint',
      verdictId: 'v-RED'
    }))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('a cached RED target makes "Review compatibility" the primary action, never "Update to…"', async () => {
    bridge(check('RED'))
    await mount()

    expect(primary()?.dataset.agentUpdateAction).toBe('review')
    expect(primary()?.textContent).toBe(enAgentUpdate.reviewCompat)
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
  })

  it('a missing verdict (UNKNOWN) is reviewed too; AMBER as well, because the gate wants an ack for it', async () => {
    for (const verdict of [null, 'AMBER'] as const) {
      bridge(check(verdict))
      await mount()
      expect(primary()?.dataset.agentUpdateAction).toBe('review')
      cleanup()
      __resetAgentUpdate()
    }
  })

  it('a cached GREEN target keeps the plain Update (no regression)', async () => {
    bridge(check('GREEN'))
    await mount()

    expect(primary()?.dataset.agentUpdateAction).toBe('update')
    expect(primary()?.textContent).toBe('Update to v0.22.0+…')
  })

  it('RED: the hold mints main’s ack naming every non-GREEN finding, then the guarded confirm applies', async () => {
    const api = bridge(check('RED'))
    $compatVerdict.set(pending('RED'))
    await mount()
    vi.useFakeTimers()

    fireEvent.click(primary()!)
    const sheet = screen.getByRole('alertdialog')
    expect(sheet.querySelector('[data-agent-review]')?.getAttribute('data-agent-review')).toBe('RED')
    expect(sheet.textContent).toContain(enAgentUpdate.reviewBody.RED)
    expect(sheet.textContent).toContain('setup_beat · theme.apply · stream.up')
    expect(sheet.textContent).not.toContain('never.named')
    expect(sheet.querySelector('[data-agent-update-confirm]')).toBeNull()

    const hold = sheet.querySelector<HTMLButtonElement>('[data-agent-review-hold="RED"]')!
    expect(hold.textContent).toBe(enAgentUpdate.reviewAccept.RED)
    await act(async () => {
      fireEvent.pointerDown(hold)
    })
    expect(compat.beginOwnerHold).toHaveBeenCalledWith('v-RED')
    expect(hold.textContent).toBe(enAgentUpdate.reviewHolding)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    vi.useRealTimers()
    expect(compat.releaseOwnerHold).toHaveBeenCalledWith('v-RED', 'n1', ['setup_beat', 'theme.apply', 'stream.up'])

    // The ack is minted; the update sheet with the gesture-guarded confirm takes over.
    const confirm = screen.getByRole('button', { name: enAgentUpdate.confirmUpdate })
    expect(confirm.hasAttribute('data-agent-update-confirm')).toBe(true)
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(api.apply).toHaveBeenCalledWith({ gestureToken: 'tok', targetSha: TIP })
  })

  it('RED: releasing before main’s hold cancels it in main and mints nothing', async () => {
    bridge(check('RED'))
    $compatVerdict.set(pending('RED'))
    await mount()
    vi.useFakeTimers()

    fireEvent.click(primary()!)
    const hold = globalThis.document.querySelector<HTMLButtonElement>('[data-agent-review-hold="RED"]')!
    await act(async () => {
      fireEvent.pointerDown(hold)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
      fireEvent.pointerUp(hold)
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(compat.cancelOwnerHold).toHaveBeenCalled()
    expect(compat.releaseOwnerHold).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: enAgentUpdate.confirmUpdate })).toBeNull()
  })

  it('keyboard: Space starts the hold, focus leaving mid-hold cancels it in main; the hold reads its sentence', async () => {
    bridge(check('RED'))
    $compatVerdict.set(pending('RED'))
    await mount()
    vi.useFakeTimers()

    fireEvent.click(primary()!)
    const hold = globalThis.document.querySelector<HTMLButtonElement>('[data-agent-review-hold="RED"]')!
    const describedBy = hold.getAttribute('aria-describedby')!
    expect(globalThis.document.getElementById(describedBy)?.textContent).toBe(enAgentUpdate.reviewBody.RED)

    await act(async () => {
      fireEvent.keyDown(hold, { key: ' ' })
    })
    expect(compat.beginOwnerHold).toHaveBeenCalledWith('v-RED')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
      fireEvent.blur(hold)
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(compat.cancelOwnerHold).toHaveBeenCalled()
    expect(compat.releaseOwnerHold).not.toHaveBeenCalled()
  })

  it('a refused ack says so in words and never opens the confirm', async () => {
    bridge(check('RED'))
    $compatVerdict.set(pending('RED'))
    compat.releaseOwnerHold.mockImplementation(async () => ({ ok: false, reason: 'hold-too-short' }))
    await mount()
    vi.useFakeTimers()

    fireEvent.click(primary()!)
    await act(async () => {
      fireEvent.pointerDown(globalThis.document.querySelector('[data-agent-review-hold="RED"]')!)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(screen.getByText(enAgentUpdate.reviewRefused)).toBeTruthy()
    expect(screen.queryByRole('button', { name: enAgentUpdate.confirmUpdate })).toBeNull()
  })

  it('without a gate verdict for THIS rev the review asks for a fresh check instead of a hold', async () => {
    const api = bridge(check(null))
    $compatVerdict.set(pending('RED', 'c'.repeat(10)))
    await mount()

    fireEvent.click(primary()!)
    const sheet = screen.getByRole('alertdialog')
    expect(sheet.querySelector('[data-agent-review]')?.getAttribute('data-agent-review')).toBe('expired')
    expect(sheet.textContent).toContain(enAgentUpdate.reviewRecheck)
    expect(sheet.querySelector('[data-agent-review-hold]')).toBeNull()

    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: enAgentUpdate.check }))
    })
    expect(api.check).toHaveBeenCalledTimes(1)
  })

  it('the gate’s last refusal is named with its time after a restart, and only for the same target', async () => {
    bridge(check('GREEN'))
    setStatus(refusal(TIP.slice(0, 10)))
    await mount()

    const line = globalThis.document.querySelector('[data-agent-refusal]')
    expect(line?.textContent).toBe(enAgentUpdate.lastRefusal(momentLabel('2026-10-21T05:23:00Z', 'en')!))
    expect(line?.textContent).toContain('2026')
    // A refusal the gate recorded for this target flips even a cached GREEN to the review.
    expect(primary()?.dataset.agentUpdateAction).toBe('review')

    cleanup()
    __resetAgentUpdate()
    bridge(check('GREEN'))
    setStatus(refusal('d'.repeat(10)))
    await mount()
    expect(globalThis.document.querySelector('[data-agent-refusal]')).toBeNull()
    expect(primary()?.dataset.agentUpdateAction).toBe('update')
  })

  it('a refusal with no known target (or a short one) speaks for no target', async () => {
    for (const target of [null, 'bbb']) {
      bridge(check('GREEN'))
      setStatus(refusal(target))
      await mount()
      expect(globalThis.document.querySelector('[data-agent-refusal]')).toBeNull()
      expect(primary()?.dataset.agentUpdateAction).toBe('update')
      cleanup()
      __resetAgentUpdate()
    }
  })

  it('a compat-hold refusal from main re-reads the persisted record from main', async () => {
    const api = bridge(check('GREEN'), {
      apply: vi.fn(async () => ({ compat: null, error: 'compat-hold', message: 'held', ok: false }))
    })

    await mount()

    fireEvent.click(primary()!)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.confirmUpdate }))
    })

    expect(api.apply).toHaveBeenCalledTimes(1)
    expect(compat.refreshCompatStatus).toHaveBeenCalledTimes(1)
    expect(globalThis.document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      enAgentUpdate.applyErrors['compat-hold']
    )
  })
})
