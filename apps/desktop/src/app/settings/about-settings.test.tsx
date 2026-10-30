// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { settings } from '@/i18n/en/settings'
import { $agentCompatFlag, $agentUpdate, __resetAgentUpdate } from '@/store/agent-update'
import { $appUpdate } from '@/store/app-update'
import { $desktopVersion, $updateStatus } from '@/store/updates'
import type { IcloneAgentUpdateCheck, IcloneCompatFlag } from '@/types/iclone-updates'

import { AboutSettings } from './about-settings'
import { appUpdateWords } from './machine/app-update-copy'

vi.mock('@/store/updates', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshDesktopVersion: vi.fn(async () => null),
  refreshUpdatePolicy: vi.fn(async () => null)
}))

const CONTROLS = 'button, input, select, textarea, [role="switch"], [role="combobox"]'

afterEach(() => {
  cleanup()
  $desktopVersion.set(null)
  $appUpdate.set(null)
  $updateStatus.set(null)
  __resetAgentUpdate()
})

function showVersion(appVersion: string, runtimeVersion: null | string) {
  $desktopVersion.set({
    appVersion,
    electronVersion: '40.0.0',
    hermesRoot: '',
    nodeVersion: '22.0.0',
    platform: 'darwin',
    runtimeVersion
  })
}

describe('About (Machine, I-D r4)', () => {
  it('shows the three-number version the command palette shows, and the runtime line without the word Hermes', () => {
    showVersion('0.0.2', '0.17.0')
    const { container } = render(<AboutSettings />)

    expect(container.querySelector('[data-about-version]')?.textContent).toBe(settings.about.version('0.0.2'))
    expect(container.querySelector('[data-about-runtime]')?.textContent).toBe('Built-in agent v0.17.0')
    expect(container.querySelector('[data-about-runtime]')?.textContent).not.toMatch(/hermes/i)
  })

  it('hides the runtime line when the runtime version cannot be read', () => {
    showVersion('0.0.12', null)
    const { container } = render(<AboutSettings />)

    expect(container.querySelector('[data-about-version]')?.textContent).toBe(settings.about.version('0.0.12'))
    expect(container.querySelector('[data-about-runtime]')).toBeNull()
  })

  it('every control sits inside a SettingRow with a title', () => {
    showVersion('0.0.2', '0.17.0')
    const { container } = render(<AboutSettings />)
    const rows = [...container.querySelectorAll<HTMLElement>('[data-setting-row]')]

    const loose = [...container.querySelectorAll<HTMLElement>(CONTROLS)].filter(
      control => !control.closest('[data-setting-row]') && !control.closest('h2, h3, [data-nav-heading]')
    )

    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every(row => (row.querySelector('.font-medium')?.textContent ?? '').trim().length > 0)).toBe(true)
    expect(loose.map(control => control.textContent)).toEqual([])
  })

  it('the updater line is the pane catalogue sentence, never the store English or the updater error text', () => {
    showVersion('0.0.2', null)
    $appUpdate.set({
      checkedAt: null,
      current: '0.0.2',
      error: null,
      next: null,
      phase: 'inactive',
      progress: null,
      releaseUrl: null
    })
    const { container } = render(<AboutSettings />)

    expect(container.textContent).toContain(appUpdateWords('en').copy.inactive)
    expect(container.textContent).not.toContain('in Applications')
  })
})

describe('About status icon (V3-0)', () => {
  const PIN = '1ac3f97fbe0958aa2743c0c26202b20b3b4e760e'

  function pinned(verifiedWithRelease: boolean, red: boolean) {
    showVersion('0.0.2', '0.21.5')
    $updateStatus.set({ supported: true, pinned: true, pinSha: PIN, behind: 0, fetchedAt: 0 } as never)
    $agentUpdate.set({
      applyError: null,
      check: {
        installed: { sha: PIN, version: '0.21.5', date: null, branch: 'main', dirty: false, verifiedWithRelease }
      } as unknown as IcloneAgentUpdateCheck,
      fault: null,
      phase: 'checked'
    })
    $agentCompatFlag.set(red ? ({ red: true } as unknown as IcloneCompatFlag) : null)
  }

  const icon = (c: HTMLElement) => c.querySelector('[data-about-status-icon]')?.getAttribute('data-about-status-icon')

  it('flagged pin: the warning, never the green check beside "flagged"', () => {
    pinned(true, true)
    const { container } = render(<AboutSettings />)
    expect(container.querySelector('[data-about-agent-status]')?.textContent).toMatch(/flagged/)
    expect(icon(container)).toBe('flagged')
  })

  it('verified pin: the green check', () => {
    pinned(true, false)
    const { container } = render(<AboutSettings />)
    expect(icon(container)).toBe('verified')
  })

  it('newer than the pin: no verification icon at all', () => {
    pinned(false, false)
    const { container } = render(<AboutSettings />)
    expect(icon(container)).toBeUndefined()
  })
})
