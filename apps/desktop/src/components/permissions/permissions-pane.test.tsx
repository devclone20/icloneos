import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IclonePermissionsBridge } from '@/components/consent/types'
import { enPermissions } from '@/i18n/en/enPermissions'
import type { PermissionStateView, SetModeResultView } from '@/iclone-shared/permissions'
import { $permissions } from '@/store/permissions'
import { $currentCwd } from '@/store/session'

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
    removeFolder: vi.fn(async () => ({ ok: true })),
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

afterEach(() => {
  cleanup()
  $permissions.set({ status: 'loading', state: null, records: [] })
  $currentCwd.set('')
})

/** The picker row of one mode (the function matrix names "Manual" too). */
function modeRow(mode: 'automatic' | 'manual'): HTMLElement {
  const picker = window.document.querySelector<HTMLElement>('[data-permission-mode-picker]')!

  return within(picker).getByText(enPermissions.modes[mode].name).closest<HTMLElement>('[data-setting-row]')!
}

describe('Settings › Agent › Permissions', () => {
  it('B3: the Setting says it is the default for new sessions, and that an open chat with its own mode keeps it', async () => {
    fakeBridge([])
    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(enPermissions.modes.automatic.name)).toBeTruthy())

    expect(screen.getByRole('radio', { name: 'Default for new sessions' }).getAttribute('aria-checked')).toBe('true')
    expect(window.document.querySelector('[data-permission-scope-note]')?.textContent).toBe(
      'An open chat with its own mode keeps it; change that in its Message bar. A chat with no mode of its own or its project\'s follows this default.'
    )
    expect(window.document.body.textContent).not.toContain('Everywhere')
  })

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
    // F40: Ignore can be chosen for everything
    expect((controls[0] as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      fireEvent.click(controls[1])
    })
    expect(bridge.setMode).toHaveBeenCalledWith({ mode: 'automatic', scope: 'standing', key: null })
  })

  it('fx20: a folder you allowed has its own row with a marked Remove; with none listed there is no such row', async () => {
    const folder = '/Users/x/projects/sibling'
    const bridge = fakeBridge([], { ...STATE, mode: { ...STATE.mode, folders: [folder] } })

    render(<PermissionsPane />)

    const button = await screen.findByRole('button', { name: enPermissions.grants.removeFolder })

    expect(button.hasAttribute('data-perm-mode-confirm')).toBe(true)
    expect(screen.getByText(folder)).toBeTruthy()
    fireEvent.click(button)
    expect(bridge.removeFolder).toHaveBeenCalledWith(folder)
    cleanup()
    $permissions.set({ status: 'loading', state: null, records: [] })
    fakeBridge([], { ...STATE, grants: [], mode: { ...STATE.mode, folders: [folder] } })
    render(<PermissionsPane />)
    await screen.findByRole('button', { name: enPermissions.grants.removeFolder })
    expect(screen.queryByText(enPermissions.grants.empty)).toBeNull()
    cleanup()
    $permissions.set({ status: 'loading', state: null, records: [] })
    fakeBridge([])
    render(<PermissionsPane />)
    await screen.findAllByRole('button', { name: enPermissions.grants.revoke })
    expect(screen.queryByRole('button', { name: enPermissions.grants.removeFolder })).toBeNull()
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

  it('L5-13: any other refusal shows main\'s own reason, as the Message bar does, and the stock line only without one', async () => {
    fakeBridge([
      { ok: false, error: 'invalid', message: 'Main says why.' },
      { ok: false, error: 'invalid', message: '' }
    ])
    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(enPermissions.modes.plan.name)).toBeTruthy())
    await act(async () => {
      fireEvent.click(window.document.querySelector('[data-perm-mode="plan"]')!)
    })
    expect(screen.getByRole('alert').textContent).toBe('Main says why.')
    await act(async () => {
      fireEvent.click(window.document.querySelector('[data-perm-mode="plan"]')!)
    })
    expect(screen.getByRole('alert').textContent).toBe(enPermissions.refused.invalid)
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

  it('fx47: unsealed, the mode main reports is in force. Was F2: clamped to Manual, chosen but not in force', async () => {
    const bridge = fakeBridge([], {
      ...STATE,
      sealed: false,
      enforcement: 'degraded',
      mode: { ...STATE.mode, standing: 'automatic' }
    })

    render(<PermissionsPane />)
    await waitFor(() => expect(window.document.querySelector('[data-permission-mode-picker]')).toBeTruthy())

    expect(within(modeRow('automatic')).getByText(enPermissions.current)).toBeTruthy()
    expect(within(modeRow('automatic')).queryByText(enPermissions.chosenNotInForce)).toBeNull()
    expect(within(modeRow('manual')).queryByText(enPermissions.current)).toBeNull()
    // The reason stays, and only one row claims to be in force.
    expect(window.document.querySelector('[data-permission-enforcement]')?.textContent).toBe(
      enPermissions.enforcement.degraded
    )
    expect(screen.getAllByText(enPermissions.current)).toHaveLength(1)

    // The owner can still move the stored choice to the mode in force.
    await act(async () => {
      fireEvent.click(within(modeRow('manual')).getByRole('button', { name: enPermissions.choose }))
    })
    expect(bridge.setMode).toHaveBeenCalledWith({ mode: 'manual', scope: 'standing', key: null })
  })

  it('F2: sealed, the chosen mode is the one in use and nothing says otherwise', async () => {
    fakeBridge([], { ...STATE, mode: { ...STATE.mode, standing: 'automatic' } })

    render(<PermissionsPane />)
    await waitFor(() => expect(window.document.querySelector('[data-permission-mode-picker]')).toBeTruthy())

    expect(within(modeRow('automatic')).getByText(enPermissions.current)).toBeTruthy()
    expect(screen.queryByText(enPermissions.chosenNotInForce)).toBeNull()
    expect(within(modeRow('manual')).queryByText(enPermissions.current)).toBeNull()
  })

  it('names the window folder as main resolves it; an answered ask re-reads that folder, not its own', async () => {
    let announce: (seq: unknown) => void = () => undefined
    const bridge = fakeBridge([])

    bridge.onChanged = vi.fn((listener: (seq: unknown) => void) => {
      announce = listener

      return () => undefined
    })
    bridge.state = vi.fn(async (dir?: null | string) => ({ ...STATE, project: dir ?? null }))
    $currentCwd.set('/work/window-folder')

    render(<PermissionsPane />)
    await waitFor(() => expect(screen.getByText(enPermissions.scope.project('/work/window-folder'))).toBeTruthy())

    await act(async () => announce(1))
    expect(new Set(vi.mocked(bridge.state).mock.calls.map(call => call[0]))).toEqual(new Set(['/work/window-folder']))

    $currentCwd.set('/work/moved')
    await waitFor(() => expect(screen.getByText(enPermissions.scope.project('/work/moved'))).toBeTruthy())
  })
})

describe('Settings › Agent › Permissions › audit chain pill', () => {
  /** The badge that carries `text`, and whether it wears the warning or the muted tone. */
  async function chainPill(chain: PermissionStateView['chain'], text: string): Promise<'muted' | 'warn' | 'other'> {
    fakeBridge([], { ...STATE, chain })
    render(<PermissionsPane />)

    const pill = (await screen.findByText(text)).closest<HTMLElement>('[data-slot="badge"]')!

    if (pill.classList.contains('text-amber-600')) {
      return 'warn'
    }

    return pill.classList.contains('text-muted-foreground') ? 'muted' : 'other'
  }

  it('V-2: while the log is re-verified the pill is neutral and never says the chain is broken', async () => {
    const tone = await chainPill({ ok: false, records: 0, gaps: 0, verifying: true }, enPermissions.audit.chainVerifying)

    expect(tone).toBe('muted')
    expect(window.document.body.textContent).not.toContain(enPermissions.audit.chainBroken)
    expect(window.document.body.textContent).not.toContain(enPermissions.audit.chainOk(0))
  })

  it('a broken chain that is not being verified warns, as before', async () => {
    const tone = await chainPill({ ok: false, records: 3, gaps: 0, verifying: false }, enPermissions.audit.chainBroken)

    expect(tone).toBe('warn')
    expect(window.document.body.textContent).not.toContain(enPermissions.audit.chainVerifying)
  })

  it('a broken chain with no verifying field warns, as before', async () => {
    expect(await chainPill({ ok: false, records: 3, gaps: 0 }, enPermissions.audit.chainBroken)).toBe('warn')
  })

  it('L5-12: the pill says "Checking records…" inside a polite status region, and the count is grouped', async () => {
    expect(enPermissions.audit.chainVerifying).toBe('Checking records…')
    await chainPill({ ok: false, records: 0, gaps: 0, verifying: true }, enPermissions.audit.chainVerifying)

    const region = window.document.querySelector<HTMLElement>('[data-permission-chain-status]')!

    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toBe('Checking records…')
    expect(enPermissions.audit.chainOk(200000)).toBe(`${(200000).toLocaleString()} records · intact`)
  })

  it('an intact chain shows its record count in the muted tone, as before', async () => {
    const tone = await chainPill({ ok: true, records: 3, gaps: 0 }, enPermissions.audit.chainOk(3))

    expect(tone).toBe('muted')
    expect(window.document.body.textContent).not.toContain(enPermissions.audit.chainVerifying)
    expect(window.document.body.textContent).not.toContain(enPermissions.audit.chainBroken)
  })
})
