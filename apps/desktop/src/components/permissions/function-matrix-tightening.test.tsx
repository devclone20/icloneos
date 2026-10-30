// V3-F2 r5 — the lead contingency, the pane's half: with F2_LOOSENING_ENABLED off (this file mocks the one flag) the
// Functions matrix offers Follow mode, Ask always and Manual only — no cell for a loosening level exists to click.
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IclonePermissionsBridge } from '@/components/consent/types'
import { enPermissions } from '@/i18n/en/enPermissions'
import type * as Shared from '@/iclone-shared/permissions'
import { type FunctionLevels, PERMISSION_FUNCTIONS, type PermissionStateView } from '@/iclone-shared/permissions'
import { $permissions } from '@/store/permissions'

import { PermissionsPane } from './permissions-pane'

vi.mock('@/iclone-shared/permissions', async importOriginal => ({
  ...(await importOriginal<typeof Shared>()),
  F2_LOOSENING_ENABLED: false
}))

const STATE: PermissionStateView = {
  sealed: true,
  unconfirmed: [],
  mode: { standing: 'manual', projects: {}, sessions: {}, updatedAt: '2026-10-22T00:00:00.000Z' },
  grants: [],
  functions: Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, 'mode'])) as FunctionLevels,
  fnGrants: [],
  ceilings: {},
  chain: { ok: true, records: 0, gaps: 0 },
  integrity: [],
  project: null,
  enforcement: 'enforced'
}

afterEach(() => $permissions.set({ status: 'loading', state: null, records: [] }))

describe('V3-F2 r5 contingency — the pane with the loosening levels off', () => {
  it('every row offers the three tightening levels and no loosening one', async () => {
    const bridge: IclonePermissionsBridge = {
      setMode: vi.fn(async () => ({ ok: true as const, mode: 'manual' as const, scope: 'standing' as const })),
      revoke: vi.fn(async () => true),
      setFunctionLevel: vi.fn(async () => ({
        ok: true as const,
        fn: 'email' as const,
        level: 'mode' as const,
        raised: false
      })),
      hermesApproval: vi.fn(async () => 'deny' as const),
      state: vi.fn(async () => STATE),
      tail: vi.fn(async () => []),
      onChanged: vi.fn(() => () => undefined)
    }

    Object.assign(window, {
      hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneConsent: { permissions: bridge } }
    })
    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(enPermissions.functions.functions.payments.name)).toBeTruthy())

    const rows = [...window.document.querySelectorAll('[data-permission-function]')]

    expect(rows).toHaveLength(PERMISSION_FUNCTIONS.length)

    for (const row of rows) {
      const cells = [...row.querySelectorAll('[data-perm-fn-level]')].map(cell =>
        cell.getAttribute('data-perm-fn-level')
      )

      expect(cells).toEqual(['mode', 'askAlways', 'manual'])
    }

    expect(
      window.document.querySelector(
        '[data-perm-fn-level="ignore"], [data-perm-fn-level="automatic"], [data-perm-fn-level="askOnce"]'
      )
    ).toBeNull()
  })
})
