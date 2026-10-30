import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $appUpdate, $appUpdateLog } from '@/store/app-update'
import { $desktopVersion, $updatePolicy } from '@/store/updates'
import type { AppUpdatePhase, AppUpdateState } from '@/types/iclone-app-update'

import { AppAtualisationSettings } from '../app-atualisation'

vi.mock('./developer', () => ({
  DeveloperUpdates: () => (
    <section aria-label="Developer">
      <h3>Developer</h3>
      <p>Track A rollback clones and pre-update backup receipts</p>
    </section>
  )
}))

// Front I-D r3 anatomy pin: no control of this pane lives outside THE row (section-heading actions aside).
const looseControls = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="switch"], [role="combobox"]')]
    .filter(control => !control.closest('[data-setting-row], h2, h3'))
    .map(control => control.getAttribute('aria-label') ?? control.textContent)

const BANNED = /unknown|atualisation|rollback|receipt|track [ab]|hermes update|backup/i

const PHASES: AppUpdatePhase[] = [
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'error',
  'inactive'
]

function stateFor(phase: AppUpdatePhase): AppUpdateState {
  return {
    checkedAt: Date.UTC(2026, 9, 18, 14, 2),
    current: '0.0.2',
    error:
      phase === 'error'
        ? { kind: 'verify', text: "The download couldn't be verified, so nothing was installed." }
        : null,
    next: ['available', 'downloading', 'downloaded', 'installing'].includes(phase) ? '0.0.3' : null,
    phase,
    progress: phase === 'downloading' ? { done: 61_000_000, percent: 38, total: 160_000_000 } : null,
    releaseUrl: null
  }
}

function policy(kind: 'curated' | 'developer') {
  return {
    align: null,
    override: null,
    packaged: kind === 'curated',
    pin: { date: '2026-10-17', sha: 'abcdef1234567', verified: 'bundled' },
    policy: kind,
    runtimeCheckOff: kind === 'curated'
  } as never
}

function renderPage() {
  return render(<AppAtualisationSettings navigate={() => undefined} onClose={() => undefined} />)
}

beforeEach(() => {
  $desktopVersion.set({ appVersion: '0.0.2', runtimeVersion: '0.20.6' } as never)
  $appUpdateLog.set([])
})

afterEach(() => {
  cleanup()
  $appUpdate.set(null)
  $updatePolicy.set(null)
})

describe('Settings → Updates copy', () => {
  it.each(PHASES)('phase %s: no developer or old-system words for users', phase => {
    $updatePolicy.set(policy('curated'))
    $appUpdate.set(stateFor(phase))
    const { container } = renderPage()

    expect(container.textContent ?? '').not.toMatch(BANNED)
    expect(container.querySelector('[data-app-update-phase]')?.getAttribute('data-app-update-phase')).toBe(phase)
    expect(screen.queryByText('Developer')).toBeNull()
    expect(looseControls(container)).toEqual([])
  })

  it('shows one primary action per phase; the bar runs while downloading and stays full when downloaded', () => {
    $updatePolicy.set(policy('curated'))
    $appUpdate.set(stateFor('downloading'))
    renderPage()

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('38')
    expect(screen.getByRole('status').textContent).toContain('38 % · 61 of 160 MB')
    cleanup()

    $appUpdate.set(stateFor('downloaded'))
    const { container } = renderPage()

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
    expect(container.querySelectorAll('[data-app-update-action="restart"]')).toHaveLength(1)
    cleanup()

    $appUpdate.set(stateFor('available'))
    renderPage()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('an error offers Try again and never a restart', () => {
    $updatePolicy.set(policy('curated'))
    $appUpdate.set(stateFor('error'))
    const { container } = renderPage()

    expect(container.querySelectorAll('[data-app-update-action="restart"]')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toContain('did not pass its signature check')
  })

  it('history starts empty and lists only our releases, newest first', () => {
    $updatePolicy.set(policy('curated'))
    $appUpdate.set(stateFor('up-to-date'))
    renderPage()
    expect(screen.getByText('No updates installed yet.')).toBeTruthy()
    cleanup()

    $appUpdateLog.set([
      { at: Date.UTC(2026, 9, 18, 14, 5), from: '0.0.2', result: 'installed', to: '0.0.3' },
      { at: Date.UTC(2026, 9, 19, 9, 0), from: '0.0.3', result: 'failed', to: '0.0.4' }
    ])
    renderPage()
    const rows = screen.getAllByRole('listitem').map(row => row.textContent ?? '')

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^v0\.0\.3 → v0\.0\.4 · .* · Did not install$/)
    expect(rows[1]).toMatch(/^v0\.0\.2 → v0\.0\.3 · .* · Installed$/)
  })

  it('developer material renders only under developer policy, under its own heading', () => {
    $updatePolicy.set(policy('developer'))
    $appUpdate.set(stateFor('up-to-date'))
    const { container } = renderPage()
    const developer = screen.getByRole('region', { name: 'Developer' })
    const userText = (container.textContent ?? '').replace(developer.textContent ?? '', '')

    expect(developer.textContent).toMatch(BANNED)
    expect(userText).not.toMatch(BANNED)
  })
})
