import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enAgentUpdate } from '@/i18n/en'
import { $agentCompatFlag, __resetAgentUpdate } from '@/store/agent-update'
import { $runtimeStatus } from '@/store/iclone-updates'
import { $updatePolicy } from '@/store/updates'
import type { IcloneAgentUpdateCheck, IcloneCompatFlag, IcloneRuntimeStatus } from '@/types/iclone-updates'

import { agentUpdateCopy, installedAgent, latestVersionLabel } from './agent-model'
import { AgentUpdateSection } from './agent-section'

const stores = vi.hoisted(() => ({ applyUpdates: vi.fn(), loadRuntimeStatus: vi.fn() }))

// These tests drive the upstream door (closed in 0.0.3, K-RT3: agent-section.door.test.tsx); it stays tested for when
// a release opens it again.
vi.mock('@/iclone-shared/update-status', async importOriginal => ({
  ...(await importOriginal<object>()),
  AGENT_UPDATE_DOOR_OPEN: true
}))

vi.mock('@/store/iclone-updates', () => ({
  $runtimeStatus: atom<IcloneRuntimeStatus | null>(null),
  loadRuntimeStatus: stores.loadRuntimeStatus
}))

vi.mock('@/store/updates', () => ({
  $desktopVersion: atom({ runtimeVersion: '0.21.5' }),
  $updateOverlayTarget: atom('client'),
  $updatePolicy: atom<null | { pin: { date: string; sha: string; verified: string }; policy: string }>(null),
  applyUpdates: stores.applyUpdates,
  isCuratedPolicy: (info: null | { policy: string }) => info?.policy !== 'developer',
  setUpdateOverlayOpen: vi.fn()
}))

const CHECK: IcloneAgentUpdateCheck = {
  checkedAt: new Date().toISOString(),
  compat: { findings: [], verdict: 'GREEN' },
  error: null,
  installed: {
    branch: 'main',
    date: '2026-10-06T10:00:00Z',
    dirty: false,
    sha: 'a'.repeat(40),
    version: '0.21.5',
    verifiedWithRelease: true
  },
  latest: {
    commitsNewer: 12,
    date: '2026-10-18T10:00:00Z',
    releaseTag: 'v0.21.0',
    sha: 'b'.repeat(40),
    version: '0.22.0'
  },
  updateAvailable: true,
  verified: { sha: 'a'.repeat(40), version: '0.21.5' }
}

function bridge(overrides: Record<string, unknown> = {}) {
  const api = {
    apply: vi.fn(async () => ({ compat: null, ok: true })),
    check: vi.fn(async () => CHECK),
    gesture: vi.fn(async () => ({ gesture: { expiresAt: 1, token: 'tok' }, ok: true })),
    lastCheck: vi.fn(async () => null),
    ...overrides
  }

  ;(window as unknown as { hermesDesktop: Record<string, unknown> }).hermesDesktop = { agentUpdate: api }

  return api
}

/**
 * The preload's second lock, as the page sees it: gesture() succeeds only after a click inside
 * `[data-agent-update-confirm]` (jsdom has no trusted events, so the predicate is what this proves).
 */
function preloadConfirmTracker() {
  let confirmed = false

  const observe = (event: Event) => {
    confirmed = event.target instanceof Element && event.target.closest('[data-agent-update-confirm]') !== null
  }

  window.addEventListener('click', observe, { capture: true })

  return {
    gesture: vi.fn(async () => {
      const ok = confirmed
      confirmed = false

      return ok ? { gesture: { expiresAt: 1, token: 'tok' }, ok: true } : { error: 'no-confirm', ok: false }
    }),
    stop: () => window.removeEventListener('click', observe, { capture: true })
  }
}

function setPolicy(policy: 'curated' | 'developer') {
  ;($updatePolicy as unknown as { set: (v: unknown) => void }).set({
    pin: { date: '2026-10-06', sha: 'a'.repeat(40), verified: '2026-10-06' },
    policy
  })
}

const AHEAD_OF_PIN = (): IcloneAgentUpdateCheck => ({
  ...CHECK,
  installed: { ...CHECK.installed, sha: 'c'.repeat(40), verifiedWithRelease: false },
  updateAvailable: false
})

describe('Settings › Updates › Agent', () => {
  beforeEach(() => {
    __resetAgentUpdate()
    $runtimeStatus.set(null)
    setPolicy('curated')
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'hermesDesktop')
    Reflect.deleteProperty(window.navigator, 'userAgent')
  })

  it('says it has not checked and asks nobody on mount', async () => {
    const api = bridge()

    render(<AgentUpdateSection />)
    await act(async () => undefined)

    expect(screen.getByText(enAgentUpdate.notChecked)).toBeTruthy()
    expect(screen.queryByText(/Nous Research|Hermes/)).toBeNull()
    expect(api.check).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
  })

  it('checks once per click, then offers the update behind a guarded confirm sheet', async () => {
    const api = bridge()

    render(<AgentUpdateSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.check }))
    })

    expect(api.check).toHaveBeenCalledTimes(1)
    expect(screen.getByText('12 commits newer')).toBeTruthy()
    expect(screen.getByText(/Latest release tag v0\.21\.0/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Update to v0.22.0+…' }))

    const sheet = screen.getByRole('alertdialog')
    expect(sheet.textContent).toContain(enAgentUpdate.confirmBackup)
    expect(sheet.textContent).toContain(enAgentUpdate.confirmReopen)

    const confirm = screen.getByRole('button', { name: enAgentUpdate.confirmUpdate })
    expect(confirm.hasAttribute('data-it-noclick')).toBe(true)
    expect(confirm.hasAttribute('data-agent-update-confirm')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.cancel }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('mints the gesture inside the confirm click and applies the checked sha', async () => {
    const tracker = preloadConfirmTracker()
    const api = bridge({ gesture: tracker.gesture })

    render(<AgentUpdateSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.check }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update to v0.22.0+…' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.confirmUpdate }))
    })
    tracker.stop()

    expect(api.gesture).toHaveBeenCalledTimes(1)
    expect(await api.gesture.mock.results[0].value).toMatchObject({ ok: true })
    expect(api.apply).toHaveBeenCalledWith({ gestureToken: 'tok', targetSha: 'b'.repeat(40) })
  })

  it('on Windows explains the terminal path and offers only Close', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0 Safari/537.36'
    })
    const api = bridge()

    render(<AgentUpdateSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.check }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update to v0.22.0+…' }))

    const sheet = screen.getByRole('alertdialog')
    const body = sheet.querySelector('h3')!.nextElementSibling!
    expect(body.textContent).toBe(enAgentUpdate.confirmWindows)
    expect(sheet.textContent).not.toContain(enAgentUpdate.confirmBackup)
    expect([...sheet.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Close'])
    expect(sheet.querySelector('[data-agent-update-confirm]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.gesture).not.toHaveBeenCalled()
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('shows the offline answer inline, not as a toast', async () => {
    bridge({ check: vi.fn(async () => ({ ...CHECK, error: 'offline', latest: null, updateAvailable: false })) })

    render(<AgentUpdateSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.check }))
    })

    expect(screen.getByRole('alert').textContent).toBe(agentUpdateCopy('en').offline)
  })

  it('offers the demoted rollback under curated POSIX when the agent is newer than the verified pin', async () => {
    bridge({ lastCheck: vi.fn(async () => AHEAD_OF_PIN()) })

    render(<AgentUpdateSection />)
    await act(async () => undefined)

    const restore = screen.getByRole('button', { name: 'Restore the verified version (v0.21.5)' })
    fireEvent.click(restore)
    expect(screen.getByRole('alertdialog').textContent).toContain('This is a rollback.')

    const confirm = screen.getByRole('button', { name: enAgentUpdate.restoreConfirm })
    expect(confirm.hasAttribute('data-it-noclick')).toBe(true)
    expect(confirm.hasAttribute('data-agent-update-confirm')).toBe(false)

    fireEvent.click(confirm)
    expect(stores.applyUpdates).toHaveBeenCalledTimes(1)
  })

  it('names a flagged verified pin in words, never with the engine key (U5-p2b-02)', async () => {
    bridge({ lastCheck: vi.fn(async () => CHECK) })
    $agentCompatFlag.set({ red: true } as unknown as IcloneCompatFlag)

    render(<AgentUpdateSection />)
    await act(async () => undefined)

    const pill = screen.getByText(new RegExp(`^${enAgentUpdate.verified} · `))
    expect(pill.textContent).toBe(
      `${enAgentUpdate.verified} · ${enAgentUpdate.compatibility(enAgentUpdate.compatibilityWords.RED)}`
    )
    expect(pill.textContent).not.toMatch(/\b(RED|AMBER|GREEN|UNKNOWN)\b/)
    expect(screen.getByRole('alert').textContent).toBe(enAgentUpdate.compatFlagged)
  })

  it('never offers Restore where the updater would pull the branch tip (developer policy)', async () => {
    setPolicy('developer')
    bridge({ lastCheck: vi.fn(async () => AHEAD_OF_PIN()) })

    render(<AgentUpdateSection />)
    await act(async () => undefined)

    expect(screen.getByText(/v0\.21\.5/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Restore the verified version/ })).toBeNull()
  })

  it('promises the release the tip carries with a plus, never the bare release name', async () => {
    bridge()

    render(<AgentUpdateSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.check }))
    })

    // The tip carries commits after v0.22.0, so a bare 'v0.22.0' would promise a release nobody is getting.
    expect(screen.getByRole('button', { name: enAgentUpdate.update('v0.22.0+') })).toBeTruthy()
    const row = screen.getByText(agentUpdateCopy('en').latest).closest('div')!
    expect(row.textContent).toContain('v0.22.0+')
    fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.update('v0.22.0+') }))
    expect(screen.getByRole('alertdialog').textContent).toContain(enAgentUpdate.confirmTitle('v0.22.0+'))
  })

  it('drops the plus when the tip IS that release, in the row, the button and both confirm sheets', async () => {
    const exact = (): IcloneAgentUpdateCheck => ({
      ...CHECK,
      latest: { ...CHECK.latest!, version: '0.22.2', versionBasis: 'exact' }
    })

    bridge({ check: vi.fn(async () => exact()) })

    render(<AgentUpdateSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.check }))
    })

    // The tip is v0.22.2's own commit, so a plus would invent commits beyond the release the user IS getting.
    const row = screen.getByText(agentUpdateCopy('en').latest).closest('div')!
    expect(row.textContent).toContain('v0.22.2')
    expect(row.textContent).not.toContain('v0.22.2+')
    fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.update('v0.22.2') }))
    expect(screen.getByRole('alertdialog').textContent).toContain(enAgentUpdate.confirmTitle('v0.22.2'))

    // The Windows sheet names the release through the same label.
    cleanup()
    __resetAgentUpdate()
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0 Safari/537.36'
    })
    bridge({ check: vi.fn(async () => exact()) })

    render(<AgentUpdateSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.check }))
    })
    fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.update('v0.22.2') }))

    const windowsSheet = screen.getByRole('alertdialog')
    expect(windowsSheet.textContent).toContain(enAgentUpdate.confirmTitle('v0.22.2'))
    expect(windowsSheet.textContent).toContain(enAgentUpdate.confirmWindows)
  })

  it('names no version at all when the check could not place one (never a bare or invented release)', () => {
    // An absent basis is a check stored before the field existed: it reads as 'newer', never as the bare release.
    expect(latestVersionLabel({ version: '0.22.2' })).toBe('v0.22.2+')
    expect(latestVersionLabel({ version: 'v0.22.2' })).toBe('v0.22.2+')
    expect(latestVersionLabel({ version: '0.22.2', versionBasis: 'newer' })).toBe('v0.22.2+')
    expect(latestVersionLabel({ version: '0.22.2', versionBasis: 'exact' })).toBe('v0.22.2')
    expect(latestVersionLabel({ version: 'v0.22.2', versionBasis: 'exact' })).toBe('v0.22.2')
    expect(latestVersionLabel({ version: null })).toBe(null)
    expect(latestVersionLabel({ version: null, versionBasis: 'exact' })).toBe(null)
    expect(latestVersionLabel(null)).toBe(null)
    expect(latestVersionLabel(undefined)).toBe(null)
  })

  it('names the update for what it is when Nous Research gave no version (never a sha)', async () => {
    bridge({
      check: vi.fn(async () => ({
        ...CHECK,
        installed: { ...CHECK.installed, version: null },
        latest: { ...CHECK.latest!, releaseTag: null, version: null }
      }))
    })

    render(<AgentUpdateSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.check }))
    })

    expect(screen.getByRole('button', { name: enAgentUpdate.updateLatest })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: enAgentUpdate.updateLatest }))
    expect(screen.getByRole('alertdialog').textContent).toContain(enAgentUpdate.confirmTitleLatest)
  })

  it("never pairs the backend's version with another install's sha", () => {
    const sha = '1ac3f97f'.padEnd(40, '0')
    const check = { ...CHECK, installed: { ...CHECK.installed, sha, version: null } }

    const receipt = (to: string) =>
      ({
        branch: 'main',
        dirty: false,
        head: { date: '2026-10-06T22:45:00Z', sha },
        lastUpdate: { from: { sha, version: '0.21.5' }, to: { sha: to, version: '0.21.5' } }
      }) as unknown as IcloneRuntimeStatus

    // The receipt that updated to this very sha names it, over the backend's 0.20.6 (check and no-check paths).
    expect(installedAgent(check, receipt(sha), '0.20.6', null)?.version).toBe('0.21.5')
    expect(installedAgent(null, receipt(sha.slice(0, 7)), '0.20.6', null)?.version).toBe('0.21.5')
    // Another sha, or no receipt: the sha and date alone, never a borrowed vX.
    expect(installedAgent(check, receipt('d'.repeat(40)), '0.20.6', null)?.version).toBeNull()
    expect(installedAgent(check, null, '0.20.6', null)?.version).toBeNull()
    // No sha known: the runtime's own version is all there is.
    const noSha = { ...CHECK, installed: { ...CHECK.installed, sha: null, version: null } }
    expect(installedAgent(noSha, null, '0.20.6', null)?.version).toBe('0.20.6')
    // The check's own reading always wins.
    expect(installedAgent(CHECK, null, '0.20.0', null)?.version).toBe('0.21.5')
  })

  it('renders the last update receipt card', async () => {
    bridge()
    $runtimeStatus.set({
      available: true,
      backupZip: null,
      branch: 'main',
      dirty: false,
      head: null,
      lastUpdate: {
        at: '2026-10-18T12:00:00Z',
        backupZip: '/tmp/home/backups/pre-update-20261018.zip',
        durationMs: 184_000,
        from: { sha: 'a'.repeat(40), version: '0.21.5' },
        outcome: 'success',
        to: { sha: 'b'.repeat(40), version: '0.22.0' }
      },
      readAt: '2026-10-18T12:00:00Z',
      receipt: null,
      rollbackClones: []
    } as unknown as IcloneRuntimeStatus)

    render(<AgentUpdateSection />)
    await act(async () => undefined)

    const card = screen.getByRole('figure', { name: enAgentUpdate.lastUpdate })
    expect(card.textContent).toContain('v0.21.5')
    expect(card.textContent).toContain('v0.22.0')
    expect(card.textContent).toContain('Backup pre-update-20261018.zip')
    expect(card.textContent).toContain('Updated')
    expect(card.textContent).toContain('3 min')
  })
})
