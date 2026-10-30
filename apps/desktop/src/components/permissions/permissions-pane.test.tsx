import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IclonePermissionsBridge } from '@/components/consent/types'
import { enPermissions } from '@/i18n/en/enPermissions'
import type { PermissionStateView, SetModeResultView } from '@/iclone-shared/permissions'
import { $permissions } from '@/store/permissions'

import { PermissionsPane } from './permissions-pane'

const STATE: PermissionStateView = {
  sealed: true,
  unconfirmed: [],
  mode: { standing: 'manual', projects: {}, sessions: {}, updatedAt: '2026-10-21T00:00:00.000Z' },
  grants: [
    {
      id: 'g-1',
      cls: 'Wo',
      scope: 'standing',
      sessionId: null,
      project: null,
      createdAt: '2026-10-21T00:00:00.000Z',
      source: 'prompt'
    }
  ],
  functions: {
    email: 'mode',
    payments: 'mode',
    trading: 'mode',
    shopping: 'mode',
    acp: 'mode',
    messaging: 'mode',
    shell: 'mode',
    files: 'mode',
    publish: 'mode'
  },
  fnGrants: [],
  ceilings: {},
  chain: { ok: true, records: 3, gaps: 0 },
  integrity: [],
  project: null,
  enforcement: 'enforced'
}

function fakeBridge(results: SetModeResultView[], state: PermissionStateView = STATE) {
  const bridge: IclonePermissionsBridge = {
    setMode: vi.fn(
      async () => results.shift() ?? { ok: true as const, mode: 'manual' as const, scope: 'standing' as const }
    ),
    revoke: vi.fn(async () => true),
    setFunctionLevel: vi.fn(async () => ({ ok: false as const, error: 'invalid' as const, message: 'x' })),
    hermesApproval: vi.fn(async () => 'deny' as const),
    state: vi.fn(async () => state),
    tail: vi.fn(async () => []),
    onChanged: vi.fn(() => () => undefined)
  }

  Object.assign(window, {
    hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneConsent: { permissions: bridge } }
  })

  return bridge
}

afterEach(() => $permissions.set({ status: 'loading', state: null, records: [] }))

describe('Settings › Agent › Permissions', () => {
  it('shows the five modes; every mode control carries the gesture marker and asks main, never writes', async () => {
    const bridge = fakeBridge([])

    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(enPermissions.modes.automatic.name)).toBeTruthy())

    const controls = [...window.document.querySelectorAll('[data-perm-mode]')]

    expect(controls.map(node => node.getAttribute('data-perm-mode'))).toEqual([
      'ignore',
      'automatic',
      'plan',
      'acceptEdits'
    ])
    expect(controls.every(node => node.hasAttribute('data-perm-mode-confirm'))).toBe(true)
    // Ignore is never the standing default
    expect((controls[0] as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      fireEvent.click(controls[1])
    })
    expect(bridge.setMode).toHaveBeenCalledWith({ mode: 'automatic', scope: 'standing', key: null })
  })

  it('a refusal for want of a gesture is shown, and revoke is a marked control too', async () => {
    const bridge = fakeBridge([{ ok: false, error: 'gesture', message: 'x' }])

    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(enPermissions.modes.plan.name)).toBeTruthy())
    await act(async () => {
      fireEvent.click(window.document.querySelector('[data-perm-mode="plan"]')!)
    })
    expect(screen.getByRole('alert').textContent).toBe(enPermissions.refused.gesture)

    const revoke = screen.getByRole('button', { name: enPermissions.grants.revoke })

    expect(revoke.hasAttribute('data-perm-mode-confirm')).toBe(true)
    fireEvent.click(revoke)
    expect(bridge.revoke).toHaveBeenCalledWith('g-1')
  })

  it('says honestly, in one line, whether the gate is enforced (F-7) — never "enforced" without main having seen it', async () => {
    fakeBridge([], { ...STATE, enforcement: 'not-enforced' })
    render(<PermissionsPane />)
    await waitFor(() => expect(window.document.querySelector('[data-permission-enforcement]')).toBeTruthy())

    const line = window.document.querySelector('[data-permission-enforcement]') as HTMLElement

    expect(line.getAttribute('data-permission-enforcement')).toBe('not-enforced')
    expect(line.textContent).toBe(enPermissions.enforcement['not-enforced'])
    expect(line.getAttribute('role')).toBe('alert')
  })
})
