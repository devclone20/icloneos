/**
 * V3-FX FX-2 r1b: with the Keychain setting off (the default since FX-2), the permission modes run Manual only, the
 * ACP tools are unavailable and payments are off. Each of these states names the fix in plain words: turn on Keychain,
 * and exactly where (Settings › Machine › Gateways › the toggle's own title), in all six locales. The path is checked
 * against the live Settings labels, so renaming the toggle or a nav entry without updating the fix turns this red.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AcpToolsPanel } from '@/app/home/econ/acp-tools-panel'
import { I18nProvider } from '@/i18n'
import { TRANSLATIONS } from '@/i18n/catalog'
import { enPermissions } from '@/i18n/en/enPermissions'
import type { PermissionStateView } from '@/iclone-shared/permissions'
import { $permissions } from '@/store/permissions'

import { PermissionsPane } from './permissions-pane'

const DEGRADED = {
  mode: { standing: 'manual', projects: {}, sessions: {}, updatedAt: '2026-10-22T00:00:00.000Z' },
  grants: [],
  functions: {},
  fnGrants: [],
  ceilings: {},
  chain: { ok: true, records: 0, gaps: 0 },
  project: null,
  enforcement: 'degraded'
} as unknown as PermissionStateView

function mountPane(keychainOn: boolean, atLaunch = keychainOn, restartAnswer: boolean | null = true) {
  Object.assign(window, {
    hermesDesktop: {
      ...(window.hermesDesktop ?? {}),
      keychainState: vi.fn(async () => ({ on: keychainOn, atLaunch })),
      keychainRestart: vi.fn(async () => restartAnswer),
      icloneConsent: {
        permissions: {
          setMode: vi.fn(),
          revoke: vi.fn(),
          setFunctionLevel: vi.fn(),
          hermesApproval: vi.fn(),
          state: vi.fn(async () => DEGRADED),
          tail: vi.fn(async () => []),
          onChanged: vi.fn(() => () => undefined)
        }
      }
    }
  })
  render(<PermissionsPane />)
}

const line = () => window.document.querySelector('[data-permission-enforcement]')?.textContent ?? null

afterEach(() => {
  cleanup()
  $permissions.set({ status: 'loading', state: null, records: [] })
})

describe('FX-2 r1b: the Keychain-off states name the fix', () => {
  it('Permissions: Manual only with the Keychain off says how to turn it on', async () => {
    mountPane(false)
    await waitFor(() => expect(line()).toBe(enPermissions.enforcement['keychain-off']))
    expect(line()).toMatch(/Turn on Keychain in Settings › Machine › Gateways/)
  })

  it('Permissions: degraded with the Keychain ON keeps the system-keychain line (a different cause)', async () => {
    mountPane(true)
    await waitFor(() => expect(line()).toBe(enPermissions.enforcement.degraded))
  })

  it('M1: Keychain turned on since launch: the line says the modes follow a restart (payments and ACP already live)', async () => {
    mountPane(true, false)
    await waitFor(() => expect(line()).toBe(enPermissions.enforcement['keychain-restart']))
    expect(line()).not.toMatch(/could not protect/)
  })

  it('r3: "Restart now" sits beside the restart line only, and asks main for the clean relaunch', async () => {
    mountPane(true, false)
    await waitFor(() => expect(line()).toBe(enPermissions.enforcement['keychain-restart']))

    const button = screen.getByRole('button', { name: enPermissions.restartNow })

    fireEvent.click(button)
    expect(window.hermesDesktop?.keychainRestart).toHaveBeenCalledTimes(1)
    cleanup()
    $permissions.set({ status: 'loading', state: null, records: [] })

    for (const [on, atLaunch] of [
      [false, false],
      [true, true]
    ] as const) {
      mountPane(on, atLaunch)
      await waitFor(() => expect(line()).not.toBeNull())
      expect(screen.queryByRole('button', { name: enPermissions.restartNow })).toBeNull()
      cleanup()
      $permissions.set({ status: 'loading', state: null, records: [] })
    }
  })

  it('r4: main refusing the relaunch (false or null) is said on screen, never silent', async () => {
    for (const answer of [false, null]) {
      mountPane(true, false, answer)
      await waitFor(() => expect(line()).toBe(enPermissions.enforcement['keychain-restart']))
      expect(screen.queryByText(enPermissions.restartRefused)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: enPermissions.restartNow }))
      await waitFor(() => expect(screen.getByText(enPermissions.restartRefused)).toBeTruthy())
      cleanup()
      $permissions.set({ status: 'loading', state: null, records: [] })
    }

    mountPane(true, false, true)
    await waitFor(() => expect(line()).toBe(enPermissions.enforcement['keychain-restart']))
    fireEvent.click(screen.getByRole('button', { name: enPermissions.restartNow }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.queryByText(enPermissions.restartRefused)).toBeNull()
  })

  it('ACP tools: unavailable because the Keychain is off says how to turn it on', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <AcpToolsPanel view={{ state: 'unavailable', cliVersion: '1.0.38', reason: 'keychain-off' }} />
      </I18nProvider>
    )
    expect(screen.getByText(/Turn on Keychain in Settings › Machine › Gateways/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('every locale: the three lines name Settings › Machine › Gateways › the toggle, in that locale’s own words', () => {
    for (const [locale, t] of Object.entries(TRANSLATIONS)) {
      const where = [t.settings.groups.machine, t.settings.nav.gateway, t.settings.gateway.keychainEncryptionTitle]

      const lines = [
        t.settings.permissions.enforcement['keychain-off'],
        t.acpTools.reasons['keychain-off'],
        t.payments.status.notReady.sealing_off
      ]

      for (const text of lines) {
        for (const part of where) {
          expect(text, `${locale}: ${text}`).toContain(part)
        }
      }
    }
  })
})
