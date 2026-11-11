// @vitest-environment jsdom
/**
 * CF4 (B2-m1): a mode the sealed launch put back for want of its audit record is told to the owner once: in the
 * chat's mode menu and in Settings › Agent › Permissions, dismissible, and a dismissal holds in both and after reload.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PermissionPill } from '@/app/chat/composer/permission-pill'
import { TRANSLATIONS } from '@/i18n/catalog'
import { enPermissions } from '@/i18n/en/enPermissions'
import type { PermissionModeResetView } from '@/iclone-shared/permissions'
import { $confinement } from '@/store/confinement'
import { $dismissedModeResets, $pendingModeResets, resetModeResetSync } from '@/store/mode-reset'
import { $permissions } from '@/store/permissions'
import { $connection } from '@/store/session'

import { ModeResetNotice } from './mode-reset-notice'

const RESETS: PermissionModeResetView[] = [
  { id: 'r-standing', scope: 'standing', key: null, was: 'acceptEdits', now: 'manual' },
  { id: 'r-chat', scope: 'session', key: 'chat-1', was: 'automatic', now: null }
]

const stateWith = (modeReset: PermissionModeResetView[]) => ({
  sealed: true,
  project: null,
  enforcement: 'enforced',
  mode: { standing: 'manual', projects: {}, sessions: {}, updatedAt: '2026-11-10T00:00:00.000Z' },
  modeReset
})

let current = stateWith(RESETS)

beforeEach(() => {
  current = stateWith(RESETS)
  window.localStorage.clear()
  $dismissedModeResets.set(new Set())
  $pendingModeResets.set([])
  resetModeResetSync()
  $confinement.set({ status: 'loading', state: null, error: null })
  $connection.set(null)
  Object.assign(window, {
    hermesDesktop: {
      icloneConsent: {
        permissions: {
          state: vi.fn(async () => current),
          tail: vi.fn(async () => []),
          onChanged: vi.fn(() => () => undefined),
          setMode: vi.fn(async () => ({ ok: true }))
        }
      },
      keychainState: async () => ({ atLaunch: true, on: true })
    }
  })
  $permissions.set({ status: 'ready', state: current as never, records: [] })
})

afterEach(() => {
  cleanup()
  $permissions.set({ status: 'loading', state: null, records: [] })
})

const lines = () => [...document.querySelectorAll('[data-mode-reset-line]')].map(line => line.textContent)

describe('B2-m1: the mode-reset notice', () => {
  it("says, in Settings, what went back and asks the owner to choose again (the brief's English line)", () => {
    render(<ModeResetNotice />)

    expect(screen.getByRole('status').getAttribute('data-mode-reset')).toBe('')
    expect(lines()).toEqual([
      'Your default went back to Manual because its record was missing. Choose it again.',
      "A chat's own mode was removed because its record was missing. Choose it again."
    ])
  })

  it('shows in the chat mode menu, and a dismissal there holds in Settings and after a reload', async () => {
    await act(async () => {
      render(<PermissionPill />)
    })
    fireEvent.pointerDown(screen.getByTestId('permission-mode-trigger'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse'
    })
    await act(async () => undefined)

    const menu = screen.getByTestId('permission-mode-menu')

    expect(menu.querySelectorAll('[data-mode-reset-line]').length).toBe(2)
    await act(async () => {
      fireEvent.click(menu.querySelector('[data-mode-reset-dismiss]') as HTMLElement)
    })
    expect(document.querySelector('[data-mode-reset]')).toBeNull()
    cleanup()

    render(<ModeResetNotice />)
    expect(document.querySelector('[data-mode-reset]')).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('iclone.permissions.modeReset.dismissed') ?? '[]')).toEqual([
      'r-standing',
      'r-chat'
    ])

    // A NEW reset (a later launch, another audit record) is told again.
    act(() => {
      $permissions.set({
        status: 'ready',
        state: stateWith([
          { id: 'r-next', scope: 'project', key: '/p', was: 'automatic', now: 'acceptEdits' }
        ]) as never,
        records: []
      })
    })
    expect(lines()).toEqual([
      "A project's mode went back to Accept edits because its record was missing. Choose it again."
    ])
  })

  it('CF5 B3-n1: a reset outlives the launch that made it: the next launch (main lists none) shows it in the main window banner until dismissed', async () => {
    const pending = JSON.parse(window.localStorage.getItem('iclone.permissions.modeReset.pending') ?? '[]') as {
      id: string
    }[]

    expect(pending.map(reset => reset.id)).toEqual(['r-standing', 'r-chat'])
    cleanup()

    // The next launch: fresh modules read the window's storage; main's state lists no reset any more.
    vi.resetModules()

    const { ModeResetBanner } = await import('@/app/chat/mode-reset-banner')
    const permissions = await import('@/store/permissions')

    permissions.$permissions.set({ status: 'ready', state: stateWith([]) as never, records: [] })
    render(<ModeResetBanner />)
    expect(document.querySelector('[data-mode-reset-banner]')).not.toBeNull()
    expect(lines()).toEqual([
      'Your default went back to Manual because its record was missing. Choose it again.',
      "A chat's own mode was removed because its record was missing. Choose it again."
    ])

    await act(async () => {
      fireEvent.click(document.querySelector('[data-mode-reset-dismiss]') as HTMLElement)
    })
    expect(document.querySelector('[data-mode-reset-banner]')).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('iclone.permissions.modeReset.pending') ?? '[]')).toEqual([])
  })

  it('CF5 B3-n1: a pending default reset is dropped once the default in force is no longer the one it names (chosen again)', () => {
    resetModeResetSync()
    act(() => {
      $permissions.set({
        status: 'ready',
        state: { ...stateWith([]), mode: { ...stateWith([]).mode, standing: 'acceptEdits' } } as never,
        records: []
      })
    })
    render(<ModeResetNotice />)
    expect(lines()).toEqual(["A chat's own mode was removed because its record was missing. Choose it again."])
  })

  it('renders nothing when main reports no reset (or an older main sends no field)', () => {
    $permissions.set({ status: 'ready', state: { ...stateWith([]), modeReset: undefined } as never, records: [] })
    render(<ModeResetNotice />)
    expect(document.querySelector('[data-mode-reset]')).toBeNull()
  })

  it('every locale fills the notice, naming the mode it went back to', () => {
    for (const locale of Object.keys(TRANSLATIONS) as (keyof typeof TRANSLATIONS)[]) {
      const copy = TRANSLATIONS[locale].settings.permissions.modeReset

      expect(copy.standing('X-MODE')).toContain('X-MODE')
      expect(copy.project('X-MODE')).toContain('X-MODE')
      expect(copy.session(null).length).toBeGreaterThan(10)
      expect(copy.dismiss.length).toBeGreaterThan(0)
    }

    expect(enPermissions.modeReset.dismiss).toBe('Dismiss')
  })
})
