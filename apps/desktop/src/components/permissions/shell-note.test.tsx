/**
 * V3-FX FX-6: the Permissions pane's note under the modes said terminal commands "are not confined yet", while V3-G's
 * Seatbelt confinement is ON by default. The note now says what is true: confined by default (what that means, and
 * where the owner can change it), or — only when the owner turned it off — that it is off. It reads the same shared
 * default main starts with (CONFINEMENT_ON_BY_DEFAULT), and main's live state when there is one.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { arPermissions } from '@/i18n/ar/permissions'
import { enPermissions } from '@/i18n/en/enPermissions'
import { jaPermissions } from '@/i18n/ja/permissions'
import { ptPtPermissions } from '@/i18n/pt-PT/permissions'
import { zhHantPermissions } from '@/i18n/zh-hant/permissions'
import { zhPermissions } from '@/i18n/zh/permissions'
import {
  CONFINEMENT_ON_BY_DEFAULT,
  CONFINEMENT_STATE_SCHEMA,
  type ConfinementStateView
} from '@/iclone-shared/confinement'
import type { PermissionStateView } from '@/iclone-shared/permissions'
import { $confinement } from '@/store/confinement'
import { $permissions } from '@/store/permissions'

import { CONFINEMENT_NOTE_POLL_MS, PermissionsPane } from './permissions-pane'

const STATE = {
  mode: { standing: 'manual', projects: {}, sessions: {}, updatedAt: '2026-10-21T00:00:00.000Z' },
  grants: [],
  functions: {},
  fnGrants: [],
  ceilings: {},
  chain: { ok: true, records: 0, gaps: 0 },
  project: null,
  enforcement: 'enforced'
} as unknown as PermissionStateView

function mount(confinement?: Partial<ConfinementStateView> | 'fails') {
  const icloneConfinement =
    confinement === undefined
      ? undefined
      : {
          state: vi.fn(async () => {
            if (confinement === 'fails') {
              throw new Error('main busy')
            }

            return { schema: CONFINEMENT_STATE_SCHEMA, ...confinement }
          }),
          onChanged: vi.fn(() => () => undefined)
        }

  Object.assign(window, {
    hermesDesktop: {
      ...(window.hermesDesktop ?? {}),
      icloneConfinement,
      icloneConsent: {
        permissions: {
          setMode: vi.fn(),
          revoke: vi.fn(),
          setFunctionLevel: vi.fn(),
          hermesApproval: vi.fn(),
          state: vi.fn(async () => STATE),
          tail: vi.fn(async () => []),
          onChanged: vi.fn(() => () => undefined)
        }
      }
    }
  })
  render(<PermissionsPane />)
}

const note = () => window.document.querySelector('[data-permission-shell-note]')?.textContent ?? null

afterEach(() => {
  cleanup()
  $permissions.set({ status: 'loading', state: null, records: [] })
  $confinement.set({ status: 'loading', state: null, error: null })
})

describe('FX-6: the shell note tells the truth about confinement', () => {
  it('confinement is ON by default, and with no live state the pane says so (flip the default → red)', async () => {
    expect(CONFINEMENT_ON_BY_DEFAULT).toBe(true)
    mount()
    await waitFor(() => expect(note()).not.toBeNull())
    expect(note()).toBe(enPermissions.shellNote.on)
    expect(note()).not.toMatch(/not confined/i)
  })

  it("M2: the pane reads main's LIVE state itself — This Mac chosen, Containers never opened ⇒ the off line", async () => {
    expect($confinement.get().state).toBeNull()
    // The poll's interval is faked and never advanced: no tick can fire, so the line can only come from the read on
    // mount (ruling 55: measured by what happened, not by a wall-clock bound — critic r5 n5).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    try {
      mount({ enabled: false, verdict: 'off' })
      await waitFor(() => expect(note()).toBe(enPermissions.shellNote.off))
      expect(window.hermesDesktop?.icloneConfinement?.state).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBeGreaterThan(0) // the poll is armed — and has not ticked
    } finally {
      vi.useRealTimers()
    }
  })

  it('M2: on and confining ⇒ the on line; on but not working (red) ⇒ never the on line', async () => {
    mount({ enabled: true, verdict: 'green' })
    await waitFor(() => expect(note()).toBe(enPermissions.shellNote.on))
    cleanup()
    $confinement.set({ status: 'loading', state: null, error: null })
    mount({ enabled: true, verdict: 'red' })
    await waitFor(() => expect(note()).toBe(enPermissions.shellNote.red))
  })

  it('M2: before main answers nothing is claimed; a failed read is not "confined"', async () => {
    mount('fails')
    await waitFor(() => expect(note()).toBe(enPermissions.shellNote.red))
  })

  it('r3: while open the pane re-reads main — This Mac chosen meanwhile shows the off line without a remount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    let live: Partial<ConfinementStateView> = { enabled: true, verdict: 'green' }

    try {
      mount({ enabled: true, verdict: 'green' })
      ;(window.hermesDesktop!.icloneConfinement!.state as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        schema: CONFINEMENT_STATE_SCHEMA,
        ...live
      }))
      await waitFor(() => expect(note()).toBe(enPermissions.shellNote.on))
      live = { enabled: false, verdict: 'off' }
      await act(async () => {
        vi.advanceTimersByTime(CONFINEMENT_NOTE_POLL_MS)
      })
      await waitFor(() => expect(note()).toBe(enPermissions.shellNote.off))
    } finally {
      vi.useRealTimers()
    }
  })

  it('r4: closing the pane stops the poll and the change subscription (no reads after unmount)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    try {
      mount({ enabled: true, verdict: 'green' })
      await waitFor(() => expect(note()).toBe(enPermissions.shellNote.on))

      const reads = window.hermesDesktop!.icloneConfinement!.state as ReturnType<typeof vi.fn>
      const before = reads.mock.calls.length

      cleanup()
      await act(async () => {
        vi.advanceTimersByTime(CONFINEMENT_NOTE_POLL_MS * 3)
      })
      expect(reads.mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('r3: a read that fails after a good one never keeps the stale "confined" line', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    try {
      mount({ enabled: true, verdict: 'green' })
      await waitFor(() => expect(note()).toBe(enPermissions.shellNote.on))
      ;(window.hermesDesktop!.icloneConfinement!.state as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        throw new Error('main busy')
      })
      await act(async () => {
        vi.advanceTimersByTime(CONFINEMENT_NOTE_POLL_MS)
      })
      await waitFor(() => expect(note()).toBe(enPermissions.shellNote.red))
    } finally {
      vi.useRealTimers()
    }
  })

  it('every locale has both lines, and the default line names where the owner can change it', () => {
    const banks = {
      ar: arPermissions,
      en: enPermissions,
      ja: jaPermissions,
      'pt-PT': ptPtPermissions,
      zh: zhPermissions,
      'zh-hant': zhHantPermissions
    }

    for (const [locale, bank] of Object.entries(banks)) {
      expect(bank.shellNote.red.length, locale).toBeGreaterThan(10)
      expect(bank.shellNote.pending.length, locale).toBeGreaterThan(5)
      expect(bank.shellNote.on, locale).toMatch(/Seatbelt/)
      expect(bank.shellNote.on, locale).not.toBe(bank.shellNote.off)
      expect(bank.shellNote.off.length, locale).toBeGreaterThan(10)
    }
  })
})
