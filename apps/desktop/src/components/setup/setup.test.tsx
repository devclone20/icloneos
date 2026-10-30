// V3-ON (ruling 44) — the first-launch Set up step and Settings › Machine › Set up: which sections show (fresh install,
// upgrader, all decided, re-entry), each section and each TCC state, Skip per section and Skip all, Done never waits,
// nothing pre-selected toward more power, and the Settings pane's parity (same rows, quiet "Not set up").
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SetupSettings } from '@/app/settings/setup-settings'
import { FunctionMatrix } from '@/components/permissions/function-matrix'
import { enConsent } from '@/i18n/en'
import { enPermissions } from '@/i18n/en/enPermissions'
import { PERMISSION_FUNCTIONS } from '@/iclone-shared/permissions'
import { $permissions } from '@/store/permissions'

import { ConsentSheet } from '../consent'
import { accepted, bundledPolicy } from '../consent/fixtures'
import { resetConsentStore } from '../consent/store'

import { setupBankFor } from './copy'
import {
  fakeSetup,
  PACKAGE_LINES,
  PACKAGES,
  permissionState,
  runtimeStatus,
  SHIPPED_LEVELS,
  SYSTEM_ROWS
} from './fixtures'
import { $setupReentry, allDecided, probeSetupAvailability, sectionsToShow, SETUP_PROBE_BUDGET_MS } from './store'
import type { SetupSystemRow } from './types'

const computerUse = vi.hoisted(() => ({
  status: vi.fn(async (): Promise<unknown> => {
    throw new Error('no backend')
  }),
  grant: vi.fn(async () => ({ ok: true, name: 'grant' }))
}))

vi.mock('@/api/toolsets', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getComputerUseStatus: computerUse.status,
  grantComputerUsePermissions: computerUse.grant
}))

// RT-B's agentRuntime is not wired in production yet (r2 minor 2); the tests wire the fixture's fake through the one
// seam the lead will swap (`setupAgentRuntime()`).
vi.mock('./agent-runtime', async importOriginal => {
  const fixtures = await import('./fixtures')

  return {
    ...(await importOriginal<Record<string, unknown>>()),
    setupAgentRuntime: () => fixtures.wiredRuntime.current
  }
})

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notify: vi.fn(() => 'toast')
}))

const copy = setupBankFor('en')
const ACCEPT = enConsent.sheet.accept(bundledPolicy.title, bundledPolicy.version)
const CURRENT = { policyVersion: bundledPolicy.version }
const AT = '2026-10-20T00:00:00.000Z'

let root: HTMLElement
const step = () => root.querySelector('[data-consent-step]')?.getAttribute('data-consent-step') ?? null

const shownSections = () =>
  [...root.querySelectorAll('[data-setup-section]')].map(node => node.getAttribute('data-setup-section'))

beforeEach(() => {
  // System permissions exist on macOS only (jsdom reports no platform).
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  $setupReentry.set(false)
  $permissions.set({ status: 'loading', state: null, records: [] })
})

afterEach(() => {
  cleanup()
  resetConsentStore()
  vi.clearAllMocks()
})

async function openSetup() {
  root = render(<ConsentSheet />).container
  await waitFor(() => expect(step()).toBe('setup'))
  await waitFor(() => expect(root.querySelector('[data-setup-rows="system"]')).toBeTruthy())
}

describe('which sections the Set up step shows', () => {
  it('pure rule: undecided ∩ available, every available one on re-entry', () => {
    const all = { packages: true, system: true, agent: true }

    expect(sectionsToShow({}, all, false)).toEqual(['packages', 'system', 'agent'])
    expect(sectionsToShow({ system: { state: 'skipped', at: AT } }, all, false)).toEqual(['packages', 'agent'])
    expect(sectionsToShow({ system: { state: 'done', at: AT } }, { ...all, packages: false }, true)).toEqual([
      'system',
      'agent'
    ])
    expect(allDecided({ packages: { state: 'done', at: AT }, system: { state: 'skipped', at: AT } }, all)).toBe(false)
    // A section that does not exist on this install is never undecided.
    expect(
      allDecided({ system: { state: 'done', at: AT }, agent: { state: 'done', at: AT } }, { ...all, packages: false })
    ).toBe(true)
  })

  it('fresh install: terms → Privacy switches → Set up (step 3 of 3) with the three sections, then the app', async () => {
    const fake = fakeSetup(null)

    root = render(<ConsentSheet />).container
    await waitFor(() => expect(step()).toBe('terms'))
    expect(screen.getByText(enConsent.sheet.step(1, 3))).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue })))
    await waitFor(() => expect(step()).toBe('permissions'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.skip })))
    await waitFor(() => expect(step()).toBe('setup'))
    expect(screen.getByText(enConsent.sheet.step(3, 3))).toBeTruthy()
    expect(shownSections()).toEqual(['packages', 'system', 'agent'])

    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.done })))
    expect(fake.setSetup).toHaveBeenCalledTimes(1)
    expect(fake.setSetup).toHaveBeenCalledWith({ sections: { packages: 'done', system: 'done', agent: 'done' } })
    await waitFor(() => expect(root.querySelector('[data-consent-step]')).toBeNull(), { timeout: 2000 })
  })

  it('upgrader from 0.0.2 (consent.json without setup): only the Set up step, never the terms again', async () => {
    fakeSetup(accepted(CURRENT))
    await openSetup()

    expect(root.querySelector('[data-consent-step="terms"]')).toBeNull()
    expect(screen.queryByText(enConsent.sheet.step(1, 1))).toBeNull()
    expect(shownSections()).toEqual(['packages', 'system', 'agent'])
  })

  it('upgrader with some sections decided sees only the ones never decided', async () => {
    fakeSetup(
      accepted({ ...CURRENT, setup: { agent: { state: 'done', at: AT }, packages: { state: 'skipped', at: AT } } })
    )
    await openSetup()

    expect(shownSections()).toEqual(['system'])
  })

  it('ON-4: every section decided → no sheet and no probe of macOS or the packages', async () => {
    const fake = fakeSetup(
      accepted({
        ...CURRENT,
        setup: {
          packages: { state: 'done', at: AT },
          system: { state: 'skipped', at: AT },
          agent: { state: 'done', at: AT }
        }
      })
    )

    root = render(<ConsentSheet />).container
    await waitFor(() => expect(fake.bridge.get).toHaveBeenCalled())
    await act(async () => undefined)
    expect(root.querySelector('[data-consent-step]')).toBeNull()
    expect(fake.setup.system).not.toHaveBeenCalled()
    expect(fake.runtime?.status).not.toHaveBeenCalled()
  })

  it('a section with nothing to show is not offered (packages API not wired yet: TODO V3-RT-B)', async () => {
    fakeSetup(accepted(CURRENT), { packages: null })
    await openSetup()

    expect(shownSections()).toEqual(['system', 'agent'])
  })

  it('no Set up bridge (web build, older main): the consent flow is exactly as before', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    Object.assign(window, { hermesDesktop: { ...window.hermesDesktop, icloneSetup: undefined } })
    root = render(<ConsentSheet />).container
    await waitFor(() => expect(fake.bridge.get).toHaveBeenCalled())
    await act(async () => undefined)
    expect(root.querySelector('[data-consent-step]')).toBeNull()
  })
})

describe('r2 minor 2 — Packages before RT-B is wired, and the 2 s startup budget', () => {
  it('not wired (production today): no Packages section, no probe once System and Agent are decided, no pill', async () => {
    const fake = fakeSetup(
      accepted({ ...CURRENT, setup: { system: { state: 'done', at: AT }, agent: { state: 'done', at: AT } } }),
      { packages: null }
    )

    root = render(<ConsentSheet />).container
    await waitFor(() => expect(fake.bridge.get).toHaveBeenCalled())
    await act(async () => undefined)
    expect(root.querySelector('[data-consent-step]')).toBeNull()
    expect(fake.setup.system).not.toHaveBeenCalled()

    cleanup()
    root = render(<SetupSettings navigate={vi.fn()} />).container
    await waitFor(() => expect(root.querySelector('[data-setup-settings-section="system"]')).toBeTruthy())
    expect(root.querySelector('[data-setup-settings-section="packages"]')).toBeNull()
    expect(root.querySelector('[data-setup-not-set-up]')).toBeNull()
  })

  it('not wired, never decided: the step shows System and Agent only', async () => {
    fakeSetup(accepted(CURRENT), { packages: null })
    await openSetup()

    expect(shownSections()).toEqual(['system', 'agent'])
  })

  it('a startup check that never answers opens the workspace after the budget (fail open, no endless mask)', async () => {
    vi.useFakeTimers()

    try {
      const never = new Promise<never>(() => undefined)
      const relevant = { packages: true, system: true, agent: true }
      const fake = fakeSetup(accepted(CURRENT))

      fake.setup.system = vi.fn(() => never)
      const probe = probeSetupAvailability(relevant)

      await vi.advanceTimersByTimeAsync(SETUP_PROBE_BUDGET_MS)
      await expect(probe).resolves.toEqual({ packages: false, system: false, agent: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a startup check that fails opens the workspace: no sheet, no mask', async () => {
    const fake = fakeSetup(accepted(CURRENT), { packages: null, permissions: false })

    fake.setup.system = vi.fn(async () => {
      throw new Error('ipc')
    })
    root = render(<ConsentSheet />).container
    await waitFor(() => expect(fake.setup.system).toHaveBeenCalled())
    await act(async () => undefined)
    expect(root.querySelector('[data-consent-step]')).toBeNull()
  })
})

describe('Skip, Skip all and Done', () => {
  it('a section’s Skip folds it to a quiet line (Undo restores); Done stores it skipped, the rest done', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    await openSetup()
    const system = root.querySelector('[data-setup-section="system"]') as HTMLElement

    fireEvent.click(within(system).getByRole('button', { name: copy.sheet.skip }))
    expect(within(system).getByText(copy.sheet.skipped)).toBeTruthy()
    expect(system.querySelector('[data-setup-item]')).toBeNull()
    fireEvent.click(within(system).getByRole('button', { name: copy.sheet.undo }))
    await waitFor(() => expect(system.querySelector('[data-setup-item]')).toBeTruthy())
    fireEvent.click(within(system).getByRole('button', { name: copy.sheet.skip }))

    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.done })))
    expect(fake.setSetup).toHaveBeenCalledWith({ sections: { packages: 'done', system: 'skipped', agent: 'done' } })
  })

  it('Skip all stores every shown section skipped, in one write, and opens the app', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    await openSetup()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.skipAll })))
    expect(fake.setSetup).toHaveBeenCalledTimes(1)
    expect(fake.setSetup).toHaveBeenCalledWith({
      sections: { packages: 'skipped', system: 'skipped', agent: 'skipped' }
    })
    await waitFor(() => expect(root.querySelector('[data-consent-step]')).toBeNull(), { timeout: 2000 })
  })

  it('never blocks the workspace: Done and Skip all are live while a package installs and nothing was granted', async () => {
    fakeSetup(accepted(CURRENT), {
      packages: runtimeStatus(
        [{ ...PACKAGE_LINES[0], name: 'x', state: 'downloading', percent: 40, totalBytes: null }],
        null
      )
    })
    await openSetup()

    expect(screen.getByText(copy.packages.installing(40))).toBeTruthy()
    expect((screen.getByRole('button', { name: copy.sheet.done }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: copy.sheet.skipAll }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('r2 M2: a failed save never traps — inline error, Continue to the app opens the workspace, nothing recorded', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    // An unwritable consent.json: main answers ok:false (and a second attempt fails too).
    fake.setSetup.mockResolvedValue({ ok: false, error: 'EACCES' } as never)
    await openSetup()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.done })))
    expect(screen.getByText(copy.sheet.saveFailed)).toBeTruthy()
    expect(step()).toBe('setup')

    // Try again re-sends the same choices once; still failing, the way out stays.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.tryAgain })))
    expect(fake.setSetup).toHaveBeenCalledTimes(2)
    expect(fake.setSetup.mock.calls[1]).toEqual(fake.setSetup.mock.calls[0])

    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.continueToApp })))
    await waitFor(() => expect(root.querySelector('[data-consent-step]')).toBeNull(), { timeout: 2000 })
    expect(fake.setSetup).toHaveBeenCalledTimes(2)
  })

  it('r2 M2: Skip all on a save that throws (IPC rejected) has the same way out; Try again that succeeds closes', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    fake.setSetup.mockRejectedValueOnce(new Error('ipc'))
    await openSetup()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.skipAll })))
    expect(screen.getByRole('button', { name: copy.sheet.continueToApp })).toBeTruthy()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.tryAgain })))
    await waitFor(() => expect(root.querySelector('[data-consent-step]')).toBeNull(), { timeout: 2000 })
    expect(fake.setSetup).toHaveBeenLastCalledWith({
      sections: { packages: 'skipped', system: 'skipped', agent: 'skipped' }
    })
  })
})

describe('System permissions: every TCC state', () => {
  const ALL: SetupSystemRow[] = [
    { id: 'microphone', status: 'granted', action: 'none' },
    { id: 'screen', status: 'notSetUp', action: 'request', restartToApply: true },
    { id: 'notifications', status: 'unknown', action: 'request' }
  ]

  const row = (id: string) => root.querySelector(`[data-setup-item="${id}"]`) as HTMLElement

  it('granted: "Allowed", no button; not yet: "Allow…"; notifications: a test notification', async () => {
    fakeSetup(accepted(CURRENT), { system: ALL })
    await openSetup()

    expect(within(row('microphone')).getByText(copy.system.status.granted)).toBeTruthy()
    expect(within(row('microphone')).queryByRole('button')).toBeNull()
    expect(within(row('screen')).getByText(copy.system.status.notSetUp)).toBeTruthy()
    expect(within(row('screen')).getByRole('button', { name: copy.system.action.request })).toBeTruthy()
    expect(within(row('screen')).getByText(copy.system.restart)).toBeTruthy()
    expect(within(row('notifications')).getByRole('button', { name: copy.system.testNotification })).toBeTruthy()
    expect(screen.getByText(copy.system.perApp)).toBeTruthy()
  })

  it('denied: "Open System Settings"; restricted: nothing to do; declined: says it is off in Privacy', async () => {
    fakeSetup(accepted(CURRENT), {
      system: [
        { id: 'microphone', status: 'denied', action: 'openSettings' },
        { id: 'screen', status: 'restricted', action: 'none' },
        { id: 'notifications', status: 'declined', action: 'none' }
      ]
    })
    await openSetup()

    expect(within(row('microphone')).getByRole('button', { name: copy.system.action.openSettings })).toBeTruthy()
    expect(within(row('screen')).getByText(copy.system.status.restricted)).toBeTruthy()
    expect(within(row('screen')).queryByRole('button')).toBeNull()
    expect(within(row('notifications')).getByText(copy.system.declined)).toBeTruthy()
    expect(within(row('notifications')).queryByRole('button')).toBeNull()
  })

  it('the button names the item only; main answers with the new rows (the request seam is main’s)', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    await openSetup()
    await act(async () =>
      fireEvent.click(within(row('microphone')).getByRole('button', { name: copy.system.action.request }))
    )
    expect(fake.setup.act).toHaveBeenCalledWith({ item: 'microphone' })
    await waitFor(() => expect(row('microphone').getAttribute('data-setup-status')).toBe('granted'))

    await act(async () =>
      fireEvent.click(within(row('notifications')).getByRole('button', { name: copy.system.testNotification }))
    )
    expect(fake.setup.act).toHaveBeenCalledWith({ item: 'notifications', ...copy.system.notification })
  })

  it('coming back from System Settings (window focus) re-reads the live status', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    await openSetup()
    const before = vi.mocked(fake.setup.system).mock.calls.length

    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(vi.mocked(fake.setup.system).mock.calls.length).toBeGreaterThan(before)
  })

  it('computer use (CuaDriver): unavailable without the agent, Allow… through the existing grant route', async () => {
    fakeSetup(accepted(CURRENT))
    await openSetup()
    await waitFor(() => expect(row('computerUse').getAttribute('data-setup-status')).toBe('unavailable'))

    cleanup()
    resetConsentStore()
    computerUse.status.mockResolvedValue({
      platform: 'darwin',
      platform_supported: true,
      installed: true,
      version: null,
      ready: false,
      can_grant: true,
      checks: []
    })
    fakeSetup(accepted(CURRENT))
    await openSetup()
    await waitFor(() => expect(row('computerUse').getAttribute('data-setup-status')).toBe('needs'))
    await act(async () => fireEvent.click(within(row('computerUse')).getByRole('button')))
    expect(computerUse.grant).toHaveBeenCalledTimes(1)
  })
})

describe('r2 — the Keychain opt-in row (V3-FX FX-2): the Settings setter, off by default', () => {
  function keychain(on: boolean) {
    const set = vi.fn(async (next: boolean) => ({ on: next }))

    Object.assign(window, {
      hermesDesktop: {
        ...window.hermesDesktop,
        getSecretStorageEncryption: vi.fn(async () => ({ on })),
        setSecretStorageEncryption: set
      }
    })

    return set
  }

  const row = () => root.querySelector('[data-setup-item="keychain"]') as HTMLElement

  it('off (the default): says what it enables and that macOS may prompt once; Done and Skip leave it off', async () => {
    fakeSetup(accepted(CURRENT))
    const set = keychain(false)

    await openSetup()
    await waitFor(() => expect(row()).toBeTruthy())
    expect(row().getAttribute('data-setup-status')).toBe('off')
    expect(within(row()).getByText(copy.system.keychain.purpose)).toBeTruthy()
    expect(within(row()).getByText(copy.system.keychain.note)).toBeTruthy()
    expect(within(row()).getByRole('switch').getAttribute('aria-checked')).toBe('false')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.skipAll })))
    expect(set).not.toHaveBeenCalled()
  })

  it('the user’s own switch turns it on through the same setter Settings uses', async () => {
    fakeSetup(accepted(CURRENT))
    const set = keychain(false)

    await openSetup()
    await waitFor(() => expect(row()).toBeTruthy())
    await act(async () => fireEvent.click(within(row()).getByRole('switch')))
    expect(set).toHaveBeenCalledWith(true)
    await waitFor(() => expect(row().getAttribute('data-setup-status')).toBe('on'))
  })

  it('on: reads On, and switching it off calls the setter with false', async () => {
    fakeSetup(accepted(CURRENT))
    const set = keychain(true)

    await openSetup()
    await waitFor(() => expect(row()?.getAttribute('data-setup-status')).toBe('on'))
    expect(within(row()).getByText(copy.system.keychain.on)).toBeTruthy()
    await act(async () => fireEvent.click(within(row()).getByRole('switch')))
    expect(set).toHaveBeenCalledWith(false)
    await waitFor(() => expect(row().getAttribute('data-setup-status')).toBe('off'))
  })
})

describe('Packages after the first-launch install (owner override 11:0x)', () => {
  it('shows every package with its state; "Install again" only for failed or skipped', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    await openSetup()
    await waitFor(() => expect(root.querySelectorAll('[data-setup-package]')).toHaveLength(PACKAGES.length))
    expect(root.querySelector('[data-setup-retry="agent-browser"]')).toBeNull()
    expect(root.querySelector('[data-setup-retry="cua-driver"]')).toBeTruthy()
    expect(root.querySelector('[data-setup-retry="node"]')).toBeTruthy()
    // A line not needed on this Mac is not shown.
    expect(root.querySelector('[data-setup-package="ripgrep"]')).toBeNull()
    expect(screen.getByText(copy.packages.state.failed)).toBeTruthy()

    await act(async () => fireEvent.click(root.querySelector('[data-setup-retry="cua-driver"]') as HTMLElement))
    // RT-B's own "Install again" (the run resumes; what is installed is reused).
    expect(fake.runtime?.installAgain).toHaveBeenCalledTimes(1)
  })
})

describe('Agent permissions: the same matrix, nothing pre-selected toward more power', () => {
  it('every function shows main’s stored level (Follow mode = Ask) and no looser cell is marked', async () => {
    fakeSetup(accepted(CURRENT))
    await openSetup()
    await waitFor(() => expect(root.querySelector('[data-permission-functions]')).toBeTruthy())

    for (const fn of PERMISSION_FUNCTIONS) {
      const group = root.querySelector(`[data-permission-function="${fn}"]`) as HTMLElement
      const marked = [...group.querySelectorAll('[role="radio"][aria-checked="true"]')]

      expect(marked.map(cell => cell.getAttribute('data-perm-fn-level'))).toEqual(['mode'])
    }

    // Every cell carries the click lock: the level is the user's own click, never set by the step.
    expect(root.querySelectorAll('[data-perm-fn-level]:not([data-perm-mode-confirm])')).toHaveLength(0)
  })

  it('r2 minor 3: the sheet uses the fit layout (names wrap, columns at their header width); Settings keeps the base', async () => {
    fakeSetup(accepted(CURRENT))
    await openSetup()
    await waitFor(() => expect(root.querySelector('[data-permission-functions]')).toBeTruthy())

    const sheetGrid = root.querySelector('[data-permission-functions] .overflow-x-auto > div') as HTMLElement

    expect(sheetGrid.className).not.toMatch(/min-w-max/)
    expect(sheetGrid.className).toMatch(/repeat\(6,max-content\)/)

    cleanup()
    $permissions.set({ status: 'ready', state: permissionState(), records: [] })
    root = render(<FunctionMatrix ceilings={{}} levels={SHIPPED_LEVELS} sealed />).container
    expect((root.querySelector('[data-permission-functions] .overflow-x-auto > div') as HTMLElement).className).toMatch(
      /\bmin-w-max\b/
    )
  })

  it('explains every level and lists the never list as fixed (read-only)', async () => {
    fakeSetup(accepted(CURRENT))
    await openSetup()
    await waitFor(() => expect(root.querySelector('[data-setup-levels]')).toBeTruthy())

    expect(root.querySelectorAll('[data-setup-level]')).toHaveLength(6)
    expect(screen.getByText(enPermissions.floor.title)).toBeTruthy()
    expect(root.querySelector('[data-setup-floors]')?.querySelectorAll('li')).toHaveLength(
      enPermissions.floor.items.length
    )
    expect(root.querySelector('[data-setup-floors] button, [data-setup-floors] input')).toBeNull()
  })

  it('Done never writes a level: only the user’s own click on a matrix cell does', async () => {
    const fake = fakeSetup(accepted(CURRENT))

    await openSetup()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.done })))
    expect(fake.permissions.setFunctionLevel).not.toHaveBeenCalled()
  })
})

describe('Settings › Machine › Set up (ON-3 parity) and re-entry', () => {
  it('the same rows; a skipped or never-decided section reads a quiet "Not set up"', async () => {
    fakeSetup(
      accepted({ ...CURRENT, setup: { system: { state: 'skipped', at: AT }, agent: { state: 'done', at: AT } } })
    )
    root = render(<SetupSettings navigate={vi.fn()} />).container

    await waitFor(() => expect(root.querySelectorAll('[data-setup-item]').length).toBeGreaterThanOrEqual(3))
    expect(root.querySelectorAll('[data-setup-package]')).toHaveLength(PACKAGES.length)

    const section = (id: string) => root.querySelector(`[data-setup-settings-section="${id}"]`) as HTMLElement

    const pill = (id: string) => root.querySelector(`[data-setup-not-set-up="${id}"]`)

    await waitFor(() => expect(pill('system')?.textContent).toBe(copy.settings.notSetUp))
    expect(pill('packages')).toBeTruthy()
    expect(pill('agent')).toBeNull()
  })

  it('"Set up again" re-opens the Set up step with every section, after the sheet was done', async () => {
    const all = {
      packages: { state: 'done' as const, at: AT },
      system: { state: 'skipped' as const, at: AT },
      agent: { state: 'done' as const, at: AT }
    }

    const fake = fakeSetup(accepted({ ...CURRENT, setup: all }))

    root = render(
      <>
        <ConsentSheet />
        <SetupSettings navigate={vi.fn()} />
      </>
    ).container
    await waitFor(() => expect(fake.bridge.get).toHaveBeenCalled())
    expect(root.querySelector('[data-consent-step]')).toBeNull()

    await waitFor(() =>
      expect((root.querySelector('[data-setup-again]') as HTMLButtonElement | null)?.disabled).toBe(false)
    )
    await act(async () => fireEvent.click(root.querySelector('[data-setup-again]') as HTMLElement))
    await waitFor(() => expect(step()).toBe('setup'))
    expect(shownSections()).toEqual(['packages', 'system', 'agent'])

    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.done })))
    expect(fake.setSetup).toHaveBeenCalledWith({ sections: { packages: 'done', system: 'done', agent: 'done' } })
    expect($setupReentry.get()).toBe(false)
  })

  it('a re-entry stands on the app surface from the moment it opens to the end of its exit fade, never the boot void', async () => {
    const all = {
      packages: { state: 'done' as const, at: AT },
      system: { state: 'skipped' as const, at: AT },
      agent: { state: 'done' as const, at: AT }
    }

    const fake = fakeSetup(accepted({ ...CURRENT, setup: all }))

    root = render(
      <>
        <ConsentSheet />
        <SetupSettings navigate={vi.fn()} />
      </>
    ).container
    await waitFor(() => expect(fake.bridge.get).toHaveBeenCalled())
    await waitFor(() =>
      expect((root.querySelector('[data-setup-again]') as HTMLButtonElement | null)?.disabled).toBe(false)
    )

    const sheetClasses = () => root.querySelector('[class*="z-(--z-consent)"]')?.className.split(/\s+/) ?? []

    await act(async () => fireEvent.click(root.querySelector('[data-setup-again]') as HTMLElement))
    await waitFor(() => expect(step()).toBe('setup'))
    expect(sheetClasses()).toContain('bg-(--ui-chat-surface-background)')
    expect(sheetClasses()).not.toContain('ic-sys-void')

    // Done clears the re-entry flag at once; the sheet is still on screen for its exit fade and keeps the surface.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: copy.sheet.done })))
    expect($setupReentry.get()).toBe(false)
    expect(root.querySelector('[class*="z-(--z-consent)"]')).toBeTruthy()
    expect(sheetClasses()).toContain('bg-(--ui-chat-surface-background)')
    expect(sheetClasses()).not.toContain('ic-sys-void')
  })

  it('the Agent door opens Settings › Agent › Permissions (the same matrix)', async () => {
    fakeSetup(accepted(CURRENT))
    const navigate = vi.fn()

    root = render(<SetupSettings navigate={navigate} />).container
    fireEvent.click(root.querySelector('[data-setup-open-permissions]') as HTMLElement)
    expect(navigate).toHaveBeenCalledWith('/settings?tab=permissions')
  })
})

it('fixtures stay honest: the system fixture has one row per item main lists', () => {
  expect(SYSTEM_ROWS.map(row => row.id)).toEqual(['microphone', 'screen', 'notifications'])
})
