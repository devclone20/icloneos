// REL-6 (ruling 26): the ACP Market pane, its Work tab and the panel itself while the ACP tools are not installed.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { ptPt } from '@/i18n/pt-PT'
import type { Locale, Translations } from '@/i18n/types'
import type { AcpToolsView } from '@/iclone-shared/acp-tools'
import { $acpTools, resetAcpToolsForTests } from '@/store/acp-tools'

import { AcpToolsPanel } from './acp-tools-panel'
import { WorkTab } from './market/work/work-tab'

const ABSENT: AcpToolsView = { state: 'absent', cliVersion: '1.0.38', stale: false }

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

// Ruling 69 (owner, 2026-10-25, supersedes 61): the app ships in ENGLISH ONLY, so a locale can no longer be
// SELECTED — `I18nProvider initialLocale="pt-PT"` opens English. The two pt-PT rows below are not about a reader
// picking Portuguese: their point is that main sends CODES and every word on screen is the catalogue's, never
// English hardcoded in the panel. So the catalogue is forced (`vi.mock('@/i18n')`, the repo's idiom) instead of
// selected — an English leak is still a leak, and the subject (`dep-a@2.0.0`) is still data. G-31 brings the
// picker back; these rows keep their teeth meanwhile.
const ENGLISH: { locale: Locale; t: Translations } = { locale: 'en', t: en }
const PORTUGUESE: { locale: Locale; t: Translations } = { locale: 'pt-PT', t: ptPt }

let shown = ENGLISH

vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, setLocale: vi.fn(), ...shown })
}))

const inEnglish = (node: React.ReactNode) => render(node)

const inPortuguese = (node: React.ReactNode) => {
  shown = PORTUGUESE

  return render(node)
}

afterEach(() => {
  cleanup()
  shown = ENGLISH
  resetAcpToolsForTests()
  Object.assign(window, { hermesDesktop: { ...(window.hermesDesktop ?? {}), icloneAcpTools: undefined } })
})

describe('AcpToolsPanel — every state, honest words, the owner’s gesture', () => {
  it('absent: what they are, the gesture-locked Install, the licence sentence and its link', () => {
    const { door } = bridge(ABSENT)

    inEnglish(<AcpToolsPanel view={ABSENT} />)
    expect(screen.getByText('ACP tools not installed')).toBeTruthy()
    expect(screen.getByText(/not part of iclone os: it downloads from npm/)).toBeTruthy()

    const install = screen.getByRole('button', { name: 'Install (downloads from npm)' })

    expect(install.hasAttribute('data-acp-tools-confirm')).toBe(true)
    expect(screen.getByText(/installed from npm under their own licences/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Third-party notices' }))
    expect(door.openNotices).toHaveBeenCalledWith('app')

    // The bridge call happens synchronously inside the click (the preload's gesture lock reads that very click).
    fireEvent.click(install)
    expect(door.install).toHaveBeenCalledTimes(1)
  })

  it('a refused install says why (no gesture, no audit)', async () => {
    bridge(ABSENT, () => Promise.resolve({ ok: false, error: 'audit', message: 'x' }))
    inEnglish(<AcpToolsPanel view={ABSENT} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install (downloads from npm)' }))
    })
    expect(screen.getByText(/permission record is not available, so nothing was installed/)).toBeTruthy()
  })

  it('installing: progress and Cancel (doing less never needs the gesture lock)', () => {
    const view: AcpToolsView = {
      state: 'installing',
      cliVersion: '1.0.38',
      phase: 'download',
      done: 120,
      total: 346,
      bytes: 42 * 1024 * 1024
    }

    const { door } = bridge(view)

    inEnglish(<AcpToolsPanel view={view} />)
    expect(screen.getByText('Installing ACP tools…')).toBeTruthy()
    expect(screen.getByText('120 of 346 packages · 42.0 MB')).toBeTruthy()

    const cancel = screen.getByRole('button', { name: 'Cancel' })

    expect(cancel.hasAttribute('data-acp-tools-confirm')).toBe(false)
    fireEvent.click(cancel)
    expect(door.cancel).toHaveBeenCalled()
  })

  it('installed: the version, verified, and the installed packages’ own licences', () => {
    const view: AcpToolsView = {
      state: 'installed',
      cliVersion: '1.0.38',
      packages: 346,
      installedAt: '2026-10-22T05:00:00Z'
    }

    const { door } = bridge(view)

    inEnglish(<AcpToolsPanel view={view} />)
    expect(screen.getByText('Installed 1.0.38 · verified')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Licences of the installed packages' }))
    expect(door.openNotices).toHaveBeenCalledWith('installed')
  })

  it('unverified: the reason and Reinstall; stale: Update; unavailable: no button', () => {
    bridge(ABSENT)

    const { unmount } = inEnglish(
      <AcpToolsPanel
        view={{ state: 'unverified', cliVersion: '1.0.38', reason: 'file-changed', subject: 'runtime/x.js' }}
      />
    )

    expect(screen.getByText('Could not verify ACP tools')).toBeTruthy()
    expect(screen.getByText('Reason: an installed file was changed (runtime/x.js)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reinstall (downloads from npm)' })).toBeTruthy()
    unmount()

    const stale = inEnglish(<AcpToolsPanel view={{ ...ABSENT, stale: true }} />)

    expect(screen.getByRole('button', { name: 'Update (downloads from npm)' })).toBeTruthy()
    stale.unmount()

    inEnglish(<AcpToolsPanel view={{ state: 'unavailable', cliVersion: '1.0.38', reason: 'unsealable' }} />)
    expect(
      screen.getByText(
        'They cannot be installed here: this system cannot lock the install record in its keychain, so nothing can be verified'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('critic m4: main sends codes; every word on screen is the locale’s, the subject is data', () => {
    bridge(ABSENT)

    const failed: AcpToolsView = { ...ABSENT, lastError: { reason: 'download-stalled', subject: 'dep-a@2.0.0' } }
    const english = inEnglish(<AcpToolsPanel view={failed} />)

    expect(screen.getByText('The install failed: a download from npm stopped sending data (dep-a@2.0.0)')).toBeTruthy()
    english.unmount()

    inPortuguese(<AcpToolsPanel view={{ state: 'unverified', cliVersion: '1.0.38', reason: 'manifest-signature' }} />)
    expect(screen.getByText('Motivo: a lista dos ficheiros instalados não é a que esta aplicação assinou')).toBeTruthy()
    expect(screen.queryByText(/signature|manifest|does not verify/)).toBeNull()
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

  it('pt-PT: the same states in European Portuguese', () => {
    bridge(ABSENT)
    inPortuguese(<AcpToolsPanel view={ABSENT} />)
    expect(screen.getByText('Ferramentas ACP não instaladas')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Instalar (transfere do npm)' })).toBeTruthy()
  })
})

describe('the ACP surfaces show the tools’ state instead of running the CLI', () => {
  it('ACP Market: the pane is the panel and no CLI read is fired', async () => {
    const { run } = bridge(ABSENT)
    const { default: MarketApp } = await import('./market/market-app')

    inEnglish(<MarketApp expanded={false} identity={null as never} inftId="inft-1" refreshKey={0} slug="inft-1" />)
    expect(screen.getByText('ACP tools not installed')).toBeTruthy()
    expect(run).not.toHaveBeenCalled()
  })

  it('Work tab: the panel, not the tab', () => {
    bridge(ABSENT)
    inEnglish(<WorkTab slug="inft-1" />)
    expect(screen.getByText('ACP tools not installed')).toBeTruthy()
    expect(screen.queryByText('Put online')).toBeNull()
  })
})
