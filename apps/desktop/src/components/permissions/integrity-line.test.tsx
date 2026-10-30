/**
 * Review panel 2, A-1: a permission state file main refused or could not verify is said where the user can see it —
 * one alert line per distinct sentence at the top of Settings › Agent › Permissions, naming what happened and what is
 * in force instead. The two grant files share one sentence; nothing is drawn when every file verifies.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { enPermissions } from '@/i18n/en/enPermissions'
import type { PermissionIntegrityFinding, PermissionStateView } from '@/iclone-shared/permissions'
import { $permissions } from '@/store/permissions'

import { integrityLines, PermissionsPane } from './permissions-pane'

const state = (integrity: PermissionIntegrityFinding[]): PermissionStateView =>
  ({
    sealed: true,
    unconfirmed: [],
    mode: { standing: 'manual', projects: {}, sessions: {}, updatedAt: '2026-10-28T00:00:00.000Z' },
    grants: [],
    functions: {},
    fnGrants: [],
    ceilings: {},
    chain: { ok: true, records: 1, gaps: integrity.length },
    integrity,
    project: null,
    enforcement: 'no-agent'
  }) as unknown as PermissionStateView

function mountPane(integrity: PermissionIntegrityFinding[]) {
  Object.assign(window, {
    hermesDesktop: {
      ...(window.hermesDesktop ?? {}),
      keychainState: vi.fn(async () => ({ on: true, atLaunch: true })),
      icloneConsent: {
        permissions: {
          setMode: vi.fn(),
          revoke: vi.fn(),
          setFunctionLevel: vi.fn(),
          hermesApproval: vi.fn(),
          state: vi.fn(async () => state(integrity)),
          tail: vi.fn(async () => []),
          onChanged: vi.fn(() => () => undefined)
        }
      }
    }
  })
  render(
    <I18nProvider>
      <PermissionsPane />
    </I18nProvider>
  )
}

const lines = () => [...window.document.querySelectorAll('[data-permission-integrity]')]

afterEach(() => {
  cleanup()
  $permissions.set({ status: 'loading', state: null, records: [] })
})

describe('A-1: the pane says which state file is not in force, and what is', () => {
  it('a tampered functions file and both grant files: two alert lines, the grant files share one', async () => {
    mountPane([
      { file: 'functions', problem: 'tampered' },
      { file: 'grants', problem: 'tampered' },
      { file: 'fnGrants', problem: 'tampered' }
    ])

    await waitFor(() => expect(lines()).toHaveLength(2))
    expect(lines().map(line => line.textContent)).toEqual([
      enPermissions.integrity.functions.tampered,
      enPermissions.integrity.grants.tampered
    ])
    expect(lines().every(line => line.getAttribute('role') === 'alert')).toBe(true)
    expect(lines()[0]?.getAttribute('data-permission-integrity')).toBe('functions:tampered')
    expect(screen.getByText(/every function is Manual until you choose it again/)).toBeTruthy()
  })

  it('an unverified mode (upgrade, or chosen with the Keychain off) says to choose a mode again', async () => {
    mountPane([{ file: 'mode', problem: 'unverified' }])

    await waitFor(() => expect(lines()).toHaveLength(1))
    expect(lines()[0]?.textContent).toBe(enPermissions.integrity.mode.unverified)
    expect(lines()[0]?.textContent).toMatch(/Manual everywhere until you choose a mode again/)
  })

  it('nothing to report: no line is drawn', async () => {
    mountPane([])

    await waitFor(() => expect(window.document.querySelector('[data-permissions-pane]')).toBeTruthy())
    expect(lines()).toHaveLength(0)
  })

  it('integrityLines keeps main’s order, one line per sentence, and tolerates an older main without the field', () => {
    const copy = enPermissions.integrity

    expect(integrityLines(undefined, copy)).toEqual([])
    expect(
      integrityLines(
        [
          { file: 'grants', problem: 'missing' },
          { file: 'functions', problem: 'missing' },
          { file: 'fnGrants', problem: 'missing' }
        ],
        copy
      )
    ).toEqual([
      { key: 'grants:missing', text: copy.grants.missing },
      { key: 'functions:missing', text: copy.functions.missing }
    ])
  })
})
