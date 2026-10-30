import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $compatVerdict } from '@/store/iclone-compat'
import type { IcloneCompatAckRequest, IcloneCompatBridge, IcloneCompatVerdict } from '@/types/iclone-compat'

import { CompatChip, compatGate, compatLevel, CompatUpdateButton } from './updates-overlay.compat-chip'

const RED: IcloneCompatVerdict = {
  schema: 1,
  id: 'v-red',
  kind: 'preview',
  level: 'RED',
  computedAt: '2026-10-07T00:00:00.000Z',
  computedMs: 3,
  runtime: { from: 'a'.repeat(40), to: 'b'.repeat(40), contractHash: 'h', isDescendant: true, specCoverage: [] },
  state: {},
  cards: [
    {
      root: 'session',
      level: 'RED',
      items: 2,
      names: ['session.b', 'session.a'],
      rules: [],
      upstream: [],
      ticket: null,
      sites: 1
    },
    { root: 'tools', level: 'INFO', items: 1, names: ['tools.new'], rules: [], upstream: [], ticket: null, sites: 0 }
  ],
  perSpec: []
}

function mockBridge() {
  const acks: IcloneCompatAckRequest[] = []

  const ack = vi.fn(async (request: IcloneCompatAckRequest) => {
    acks.push(request)

    if (request.phase === 'begin') {
      return { ok: true as const, phase: 'begin' as const, verdictId: request.verdictId, nonce: 'n1', holdMs: 3000 }
    }

    return request.phase === 'mint'
      ? { ok: true as const, phase: 'mint' as const, verdictId: request.verdictId, heldMs: 3000 }
      : { ok: true as const, phase: 'cancel' as const }
  })

  const compat = { ack, onVerdict: () => () => undefined } as unknown as IcloneCompatBridge

  Object.assign(window, { hermesDesktop: { icloneUpdates: { compat } } })

  return acks
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  $compatVerdict.set(null)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('P4a.ui.chip', () => {
  it('P4a.ui.chip renders each verdict level with its own label', () => {
    const labels = new Set<string>()

    for (const level of ['GREEN', 'AMBER', 'RED', 'UNKNOWN'] as const) {
      const { container, unmount } = render(<CompatChip level={level} />)
      const chip = container.querySelector('[data-iclone-compat-level]')

      expect(chip?.getAttribute('data-iclone-compat-level')).toBe(level)
      labels.add(chip?.textContent ?? '')
      unmount()
    }

    expect(labels.size).toBe(4)
  })

  it('P4a.ui.chip treats a missing or unrecognised verdict as UNKNOWN, never GREEN', () => {
    for (const level of [null, undefined, '', 'green', 'PASS']) {
      expect(compatLevel(level)).toBe('UNKNOWN')
    }

    expect(compatLevel('INFO')).toBe('GREEN')

    render(<CompatChip level={null} title="no verdict yet" />)
    expect(screen.getByTitle('no verdict yet').getAttribute('data-iclone-compat-level')).toBe('UNKNOWN')
  })

  it('P4a.ui.chip shapes the Update button: AMBER accepts, RED holds 3 s, UNKNOWN holds 1.5 s', () => {
    expect(compatGate('GREEN')).toEqual({ holdMs: 0, label: 'Update' })
    expect(compatGate('AMBER')).toEqual({ holdMs: 0, label: 'Update and accept' })
    expect(compatGate('RED').holdMs).toBe(3000)
    expect(compatGate(undefined).holdMs).toBe(1500)
  })

  it('P4a.ui.chip GREEN is a plain Update click', () => {
    const onInstall = vi.fn()
    $compatVerdict.set({ ...RED, id: 'v-green', level: 'GREEN', cards: [] })
    render(<CompatUpdateButton label="Update" onInstall={onInstall} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it('P4a.ui.chip RED: an early release cancels the hold in main; a full hold names the findings, then installs', async () => {
    vi.useFakeTimers()
    const acks = mockBridge()
    const onInstall = vi.fn()
    $compatVerdict.set(RED)
    render(<CompatUpdateButton label="Update" onInstall={onInstall} />)
    const button = screen.getByRole('button', { name: 'Hold to override' })

    await act(async () => fireEvent.pointerDown(button))
    await act(async () => fireEvent.pointerUp(button))
    await act(async () => vi.advanceTimersByTime(3000))
    expect(acks.map(a => a.phase)).toEqual(['begin', 'cancel'])
    expect(onInstall).not.toHaveBeenCalled()

    await act(async () => fireEvent.pointerDown(button))
    await act(async () => vi.advanceTimersByTime(3000))
    expect(acks.at(-1)).toEqual({ phase: 'mint', verdictId: 'v-red', nonce: 'n1', names: ['session.b', 'session.a'] })
    expect(onInstall).toHaveBeenCalledTimes(1)
  })
})
