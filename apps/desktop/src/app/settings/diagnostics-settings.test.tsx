import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $sendDiagnostics } from '@/store/send-diagnostics'

import { DiagnosticsSettings } from './diagnostics-settings'
import type {
  DoctorCatalogue,
  DoctorFixResult,
  DoctorProgress,
  DoctorReport,
  IcloneDoctorBridge
} from './diagnostics-settings-model'
import { ageLabel, formatRunDuration, packRows } from './diagnostics-settings-model'
import { diagnosticsCheckCopy } from './machine/diagnostics-checks-copy'

// Front I-D r3 anatomy pin: no control of this pane lives outside THE row (section-heading actions aside).
const looseControls = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="switch"], [role="combobox"]')]
    .filter(control => !control.closest('[data-setting-row], h2, h3'))
    .map(control => control.getAttribute('aria-label') ?? control.textContent)

const PACKS = ['runtime', 'gateway', 'acp', 'wallet', 'permissions', 'storage', 'native', 'network']

const catalogue: DoctorCatalogue = {
  packs: PACKS.map(id => ({
    id,
    title: id === 'native' ? 'App install' : `Pack ${id}`,
    checks: [{ id: `${id}.a`, title: 'A' }],
    fixes:
      id === 'native'
        ? [{ id: 'native.install_release', title: 'Install the notarized release', risk: 'low', consent: null }]
        : id === 'permissions'
          ? [
              {
                id: 'permissions.reset_accessibility',
                title: 'Reset the Accessibility permission',
                risk: 'high',
                consent: 'automation'
              }
            ]
          : []
  })),
  errors: []
}

function report(failing: boolean): DoctorReport {
  return {
    schema: 1,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    durationMs: 4200,
    live: false,
    status: failing ? 'fail' : 'pass',
    counts: { pass: failing ? 6 : 8, warn: 0, fail: failing ? 2 : 0, skip: 0 },
    packs: PACKS.map(id => ({
      id,
      title: id === 'native' ? 'App install' : `Pack ${id}`,
      status: failing && (id === 'native' || id === 'permissions') ? 'fail' : 'pass',
      checks:
        failing && id === 'native'
          ? [
              {
                id: 'native.codesign',
                title: 'Signature and notarization',
                status: 'fail',
                detail: 'iclone os.app: Gatekeeper rejects it (local signing)',
                fixId: 'native.install_release',
                risk: 'low',
                consent: null,
                durationMs: 900
              }
            ]
          : failing && id === 'permissions'
            ? [
                {
                  id: 'permissions.accessibility',
                  title: 'Accessibility access',
                  status: 'fail',
                  detail: 'not granted',
                  fixId: 'permissions.reset_accessibility',
                  risk: 'high',
                  consent: 'automation',
                  durationMs: 1
                }
              ]
            : [{ id: `${id}.a`, title: 'A', status: 'pass', detail: 'ok', durationMs: 1 }]
    })),
    lines: ['icloneOS diagnostics', '✗ App install', '2 failed · 0 warnings']
  }
}

function bridge(initial: DoctorReport | null, next: DoctorReport, fixResult?: DoctorFixResult) {
  let progress: ((p: DoctorProgress) => void) | null = null
  let release: (() => void) | null = null

  const api: IcloneDoctorBridge = {
    list: vi.fn(async () => catalogue),
    report: vi.fn(async () => initial),
    run: vi.fn(
      () =>
        new Promise<DoctorReport>(resolve => {
          release = () => resolve(next)
        })
    ),
    fix: vi.fn(async () => fixResult ?? null),
    openLogs: vi.fn(async () => true),
    onProgress: cb => {
      progress = cb

      return () => (progress = null)
    }
  }

  window.hermesDesktop = { ...(window.hermesDesktop ?? {}), icloneDoctor: api } as typeof window.hermesDesktop

  return { api, emit: (p: DoctorProgress) => progress?.(p), finish: () => release?.() }
}

afterEach(() => {
  cleanup()
  $sendDiagnostics.set(null)
})

const state = () => window.document.querySelector('[data-diagnostics-state]')?.getAttribute('data-diagnostics-state')

describe('Settings › Diagnostics', () => {
  it('idle: 8 groups from the catalogue, not run yet', async () => {
    bridge(null, report(false))
    const { container } = render(<DiagnosticsSettings />)
    await waitFor(() => expect(window.document.querySelectorAll('[data-pack]')).toHaveLength(8))
    expect(state()).toBe('idle')
    expect(screen.getByText('Not run yet')).toBeTruthy()
    expect(looseControls(container)).toEqual([])
  })

  it('running: Run all disables itself and shows one quiet progress line', async () => {
    const b = bridge(null, report(false))
    render(<DiagnosticsSettings />)
    await waitFor(() => expect(window.document.querySelectorAll('[data-pack]')).toHaveLength(8))
    fireEvent.click(window.document.querySelector('[data-run-all]')!)
    await waitFor(() => expect(state()).toBe('running'))
    expect((window.document.querySelector('[data-run-all]') as HTMLButtonElement).disabled).toBe(true)
    act(() => b.emit({ packId: 'gateway', done: 3, total: 31 }))
    expect(window.document.querySelector('[data-progress]')?.textContent).toBe(
      'The agent’s connection and sessions · checking 3 of 31'
    )
    await act(async () => b.finish())
    await waitFor(() => expect(state()).toBe('pass'))
    expect(window.document.querySelector('[data-progress]')?.textContent).toBe('Everything checks out · 2 min ago')
  })

  it('fail: one primary Fix per failed check, high risk shows the lock, consent refusal points to Privacy', async () => {
    const b = bridge(report(true), report(true), {
      ok: false,
      fixId: 'permissions.reset_accessibility',
      dryRun: false,
      plan: [],
      applied: false,
      backupDir: null,
      undo: '',
      refused: 'consent',
      needsConsent: 'automation'
    })

    const navigate = vi.fn()
    render(<DiagnosticsSettings navigate={navigate} />)
    await waitFor(() => expect(state()).toBe('fail'))
    fireEvent.click(window.document.querySelector('[data-pack="native"] button')!)
    fireEvent.click(window.document.querySelector('[data-pack="permissions"] button')!)
    expect(window.document.querySelectorAll('[data-fix]')).toHaveLength(2)
    // S28.2: the pane's own sentence and the fix label by id, never the runner's title, detail or consent key.
    const w = diagnosticsCheckCopy('en')
    expect(screen.getByText(w.checks['native.codesign'])).toBeTruthy()
    expect(screen.queryByText('iclone os.app: Gatekeeper rejects it (local signing)')).toBeNull()
    expect(screen.getByText(w.fixes['native.install_release'])).toBeTruthy()
    expect(screen.queryByText('Install the notarized release')).toBeNull()
    expect(screen.getByLabelText('Needs your approval')).toBeTruthy()
    fireEvent.click(window.document.querySelector('[data-fix="permissions.reset_accessibility"]')!)
    await waitFor(() => expect(screen.getByText(w.needsConsent)).toBeTruthy())
    fireEvent.click(screen.getByText('Open Privacy'))
    expect(navigate).toHaveBeenCalledWith('privacy')
    expect(b.api.fix).toHaveBeenCalledWith({ fixId: 'permissions.reset_accessibility', dryRun: false })
  })

  it('pass: Copy report copies the redacted lines and Save opens the report dialog', async () => {
    bridge(report(false), report(false))
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<DiagnosticsSettings />)
    await waitFor(() => expect(state()).toBe('pass'))
    fireEvent.click(screen.getByText('Copy report'))
    expect(writeText).toHaveBeenCalledWith(report(false).lines.join('\n'))
    fireEvent.click(screen.getByText('Save diagnostics'))
    expect($sendDiagnostics.get()).not.toBeNull()
  })

  it('pure helpers', () => {
    expect(formatRunDuration(4200)).toBe('4.2 s')
    expect(packRows(catalogue, null)).toHaveLength(8)
    expect(
      ageLabel(new Date(1_000_000).toISOString(), 1_000_000 + 7_200_000, {
        justNow: 'now',
        minAgo: n => `${n}m`,
        hoursAgo: n => `${n}h`,
        daysAgo: n => `${n}d`
      })
    ).toBe('2h')
  })
})

describe('packRows', () => {
  it('drops junk packs from a hand-edited report instead of throwing', () => {
    const junk = {
      packs: [null, { id: 'x', checks: 'junk' }, 7, { id: 'runtime', title: 'Runtime', status: 'pass', checks: [] }]
    }

    const rows = packRows(null, junk as unknown as Parameters<typeof packRows>[1])

    expect(rows.map(r => r.id)).toEqual(['runtime'])
    expect(() => packRows({ packs: [] } as unknown as Parameters<typeof packRows>[0], junk as never)).not.toThrow()
  })
})

describe('ageLabel', () => {
  const now = 10_000_000_000

  const copy = {
    justNow: 'now',
    minAgo: (n: number) => `${n}m`,
    hoursAgo: (n: number) => `${n}h`,
    daysAgo: (n: number) => `${n}d`
  }

  const at = (ageMs: number) => ageLabel(new Date(now - ageMs).toISOString(), now, copy)

  it('rounds to the nearest minute, hour or day', () => {
    expect(at(59_000)).toBe('now')
    expect(at(60_000)).toBe('1m')
    expect(at(89_000)).toBe('1m')
    expect(at(90_000)).toBe('2m')
    expect(at(3_570_000)).toBe('60m')
    expect(at(86_340_000)).toBe('24h')
    expect(at(90_000_000)).toBe('1d')
    expect(at(129_600_000)).toBe('2d')
  })

  it('reads a future or unparsable timestamp as just now', () => {
    expect(at(-120_000)).toBe('now')
    expect(ageLabel('not a date', now, copy)).toBe('now')
  })
})
