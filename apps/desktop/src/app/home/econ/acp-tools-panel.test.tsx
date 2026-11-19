// v0.0.9 F1-B (owner decision 17 Nov, replaces ruling 26): the Virtuals ACP CLI ships inside the app. The ACP Market
// pane, its Work tab and the panel itself show ONE status line ("Virtuals ACP CLI 1.0.38 · included · verified") and
// only one control, Repair, while the included copy does not verify. Install, Cancel, Check for updates and Update now
// are gone (P0_ECONOMYOS_CONTROLS rows S1a–S1f, W0, M0).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { f1bAcpBundled } from '@/i18n/en/v009-f1b'
import { ptPt } from '@/i18n/pt-PT'
import type { Locale, Translations } from '@/i18n/types'
import type { AcpToolsView } from '@/iclone-shared/acp-tools'
import { $acpTools, resetAcpToolsForTests } from '@/store/acp-tools'

import { AcpToolsPanel, acpToolsStatus } from './acp-tools-panel'
import { WorkTab } from './market/work/work-tab'

const INSTALLED: AcpToolsView = {
  state: 'installed',
  cliVersion: '1.0.38',
  packages: 346,
  installedAt: '2026-11-17T00:00:00Z'
}

const CHANGED: AcpToolsView = {
  state: 'unverified',
  cliVersion: '1.0.38',
  reason: 'file-changed',
  subject: 'runtime/x.js'
}

/** Every control the v0.0.3–v0.0.8 installer had, by any of its labels: none may come back. */
const GONE = [/^Install/, /^Update/, /^Reinstall/, /^Cancel$/, /^Check for updates$/, /^Update now$/]

function bridge(view: AcpToolsView, install: () => Promise<unknown> = () => Promise.resolve({ ok: true, view })) {
  const door = {
    state: vi.fn(() => Promise.resolve(view)),
    check: vi.fn(() => Promise.resolve(view)),
    install: vi.fn(install),
    cancel: vi.fn(() => Promise.resolve(true)),
    openNotices: vi.fn(() => Promise.resolve(true)),
    onChanged: vi.fn(() => () => undefined)
  }

  const run = vi.fn()

  const work = {
    state: vi.fn(() => new Promise(() => undefined)),
    refresh: run,
    setLevel: run,
    online: run,
    offline: run,
    reboot: run,
    repair: run,
    approve: run,
    decline: run,
    onChanged: vi.fn(() => () => undefined)
  }

  Object.assign(window, {
    hermesDesktop: {
      ...(window.hermesDesktop ?? {}),
      icloneAcpTools: door,
      icloneAcp: { run, status: run, check: run },
      icloneAcpWork: work
    }
  })
  $acpTools.set(view)

  return { door, run }
}

// Ruling 69: English only. The reason words still come from the catalogue (main sends CODES, critic m4), so a forced
// pt-PT catalogue proves no reason is hardcoded; the status line and Repair are F1-B's English words by design.
const ENGLISH: { locale: Locale; t: Translations } = { locale: 'en', t: en }
const PORTUGUESE: { locale: Locale; t: Translations } = { locale: 'pt-PT', t: ptPt }

let shown = ENGLISH

vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, setLocale: vi.fn(), ...shown })
}))

afterEach(() => {
  cleanup()
  shown = ENGLISH
  resetAcpToolsForTests()
  Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneAcpTools: undefined } })
})

function noInstallerControls() {
  for (const button of screen.queryAllByRole('button')) {
    for (const gone of GONE) {
      expect(button.textContent ?? '', `a removed control is back: ${button.textContent}`).not.toMatch(gone)
    }
  }
}

describe('AcpToolsPanel — the included CLI: one status line, Repair only when it does not verify', () => {
  it('installed: "Virtuals ACP CLI 1.0.38 · included · verified", the included packages’ licences, nothing else', () => {
    const { door } = bridge(INSTALLED)

    render(<AcpToolsPanel view={INSTALLED} />)
    expect(screen.getByText('Virtuals ACP CLI 1.0.38 · included · verified')).toBeTruthy()
    expect(screen.queryByRole('button', { name: f1bAcpBundled.repair })).toBeNull()
    noInstallerControls()
    fireEvent.click(screen.getByRole('button', { name: f1bAcpBundled.licences }))
    expect(door.openNotices).toHaveBeenCalledWith('installed')
  })

  it('the status line takes its version from the view (the build’s pin), for every state', () => {
    expect(acpToolsStatus(INSTALLED)).toBe('Virtuals ACP CLI 1.0.38 · included · verified')
    expect(acpToolsStatus({ ...INSTALLED, cliVersion: '1.0.40' })).toBe('Virtuals ACP CLI 1.0.40 · included · verified')
    expect(acpToolsStatus(CHANGED)).toBe('Virtuals ACP CLI 1.0.38 · included · not verified')
    expect(acpToolsStatus({ state: 'absent', cliVersion: '1.0.38', stale: false })).toBe(
      'Virtuals ACP CLI 1.0.38 · not included in this build'
    )
    expect(acpToolsStatus({ state: 'checking', cliVersion: null })).toBe('Virtuals ACP CLI · checking…')
  })

  it('unverified: the reason, Repair carrying the gesture marker, called synchronously in the click', () => {
    const { door } = bridge(CHANGED)

    render(<AcpToolsPanel view={CHANGED} />)
    expect(screen.getByText('Virtuals ACP CLI 1.0.38 · included · not verified')).toBeTruthy()
    expect(screen.getByText(/Reason: an installed file was changed \(runtime\/x\.js\)/)).toBeTruthy()
    expect(screen.getByText(/puts back the copy that came with iclone os, from inside the app\. No download/)).toBeTruthy()
    noInstallerControls()

    const repair = screen.getByRole('button', { name: f1bAcpBundled.repair })

    // The preload's acp-tools lock only counts a real click on a control carrying this marker (V3-F, P0 row S1a).
    expect(repair.hasAttribute('data-acp-tools-confirm')).toBe(true)
    fireEvent.click(repair)
    expect(door.install).toHaveBeenCalledTimes(1)
  })

  it('a refused Repair says why (no gesture), and changes nothing', async () => {
    bridge(CHANGED, () => Promise.resolve({ ok: false, error: 'gesture' }))
    render(<AcpToolsPanel view={CHANGED} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: f1bAcpBundled.repair }))
    })
    expect(screen.getByText(f1bAcpBundled.errors.gesture)).toBeTruthy()
  })

  it('a failed Repair names the reason and the way out (reinstall the app)', () => {
    bridge(CHANGED)

    render(<AcpToolsPanel view={{ ...CHANGED, lastError: { reason: 'file-changed', subject: 'included copy: x.js' } }} />)
    expect(
      screen.getByText(
        'Repair did not finish: an installed file was changed (included copy: x.js). If it keeps failing, reinstall iclone os.'
      )
    ).toBeTruthy()
  })

  it('absent (a build without the CLI) and unavailable: no button at all — Repair cannot help, reinstalling can', () => {
    bridge(INSTALLED)

    const absent = render(<AcpToolsPanel view={{ state: 'absent', cliVersion: '1.0.38', stale: false }} />)

    expect(screen.getByText('Virtuals ACP CLI 1.0.38 · not included in this build')).toBeTruthy()
    expect(screen.getByText(f1bAcpBundled.reinstallHint)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    absent.unmount()

    render(<AcpToolsPanel view={{ state: 'unavailable', cliVersion: '1.0.38', reason: 'other-pin' }} />)
    expect(screen.getByText('Virtuals ACP CLI 1.0.38 · cannot run in this build')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('installing (main restoring the included copy): the line says so, no control', () => {
    const view: AcpToolsView = { state: 'installing', cliVersion: '1.0.38', phase: 'verify', done: 0, total: 9, bytes: 0 }

    bridge(view)
    render(<AcpToolsPanel view={view} />)
    expect(screen.getByText('Virtuals ACP CLI 1.0.38 · included · restoring from the included copy…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('critic m4: the reason words are the catalogue’s, never hardcoded (a forced pt-PT catalogue shows them)', () => {
    bridge(CHANGED)
    shown = PORTUGUESE
    render(<AcpToolsPanel view={{ state: 'unverified', cliVersion: '1.0.38', reason: 'manifest-signature' }} />)
    expect(screen.getByText(/Motivo: a lista dos ficheiros instalados não é a que esta aplicação assinou/)).toBeTruthy()
  })

  it('every reason code has words in all six locales', async () => {
    const { ACP_TOOLS_REASONS } = await import('@/iclone-shared/acp-tools')

    for (const locale of ['en', 'pt-PT', 'ja', 'zh', 'zh-hant', 'ar']) {
      const { acpTools } = (await import(`../../../i18n/${locale}/acpTools.ts`)) as {
        acpTools: { reasons: Record<string, string> }
      }

      expect(Object.keys(acpTools.reasons).sort()).toEqual([...ACP_TOOLS_REASONS].sort())

      for (const reason of ACP_TOOLS_REASONS) {
        expect(acpTools.reasons[reason]?.trim(), `${locale}.${reason}`).toBeTruthy()
      }
    }
  })
})

describe('W0 / M0: the ACP surfaces show the included CLI’s state instead of running it', () => {
  it('ACP Market: while the copy does not verify, the pane is the panel (Repair) and no CLI read is fired', async () => {
    const { run } = bridge(CHANGED)
    const { default: MarketApp } = await import('./market/market-app')

    render(<MarketApp expanded={false} identity={null as never} inftId="inft-1" refreshKey={0} slug="inft-1" />)
    expect(screen.getByText('Virtuals ACP CLI 1.0.38 · included · not verified')).toBeTruthy()
    expect(screen.getByRole('button', { name: f1bAcpBundled.repair }).hasAttribute('data-acp-tools-confirm')).toBe(true)
    noInstallerControls()
    expect(run).not.toHaveBeenCalled()
  })

  it('Work tab: the panel, not the tab, and never an Install', () => {
    bridge(CHANGED)
    render(<WorkTab slug="inft-1" />)
    expect(screen.getByText('Virtuals ACP CLI 1.0.38 · included · not verified')).toBeTruthy()
    expect(screen.queryByText('Put online')).toBeNull()
    noInstallerControls()
  })
})
