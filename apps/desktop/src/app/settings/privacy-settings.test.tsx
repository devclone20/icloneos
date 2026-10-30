import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { accepted, bundledPolicy, fakeConsentBridge } from '@/components/consent/fixtures'
import { resetConsentStore } from '@/components/consent/store'

import { privacyCopy } from './privacy-copy'
import { formatConsentDate, formatRequestTime, PrivacySettings } from './privacy-settings'

afterEach(() => resetConsentStore())

const en = privacyCopy('en')

describe('PrivacySettings', () => {
  it('every row is THE settings row: title, the hint below it, the switch at the trailing edge', async () => {
    fakeConsentBridge(accepted())
    const { container } = render(<PrivacySettings />)
    await waitFor(() => expect(container.querySelector('[data-privacy-permission]')).toBeTruthy())
    const rows = [...container.querySelectorAll('[data-setting-row]')]
    expect(rows.length).toBeGreaterThan(6)
    const sw = container.querySelector('[data-privacy-permission]') as HTMLElement
    const row = sw.closest('[data-setting-row]') as HTMLElement
    expect(row).toBeTruthy()
    expect(sw.getAttribute('role')).toBe('switch')
    // the text column comes first, the control column last
    expect(row.firstElementChild?.lastElementChild?.contains(sw)).toBe(true)
    expect(row.textContent).toContain(sw.getAttribute('aria-label') ?? '')
  })

  it('after Skip shows "Not configured" and the accepted policy', async () => {
    fakeConsentBridge(accepted({ skipped: true }))
    const { container } = render(<PrivacySettings />)
    await waitFor(() => expect(screen.getByText(en.settings.notConfigured)).toBeTruthy())
    expect(screen.getByText(en.settings.policyRow(bundledPolicy.version))).toBeTruthy()
    expect(screen.getByText(en.settings.accepted('17 October 2026'))).toBeTruthy()
    expect(container.querySelector('[data-privacy-permissions]')?.getAttribute('data-privacy-permissions')).toBe(
      'not-configured'
    )
  })

  it('after Skip, one switch records all twelve rows as shown (the rest OFF, not undecided)', async () => {
    const fake = fakeConsentBridge(accepted({ skipped: true }))

    render(<PrivacySettings />)
    await waitFor(() => expect(screen.getByRole('switch', { name: en.rows.notifications.title })).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: en.rows.notifications.title }))
    })
    const sent = vi.mocked(fake.bridge.setPermissions).mock.calls[0]?.[0] as { permissions: Record<string, boolean> }

    expect(Object.keys(sent.permissions).sort()).toEqual(
      [
        'automation',
        'clipboard',
        'fileWriting',
        'installSoftware',
        'keychain',
        'microphone',
        'notifications',
        'scheduledTasks',
        'screen',
        'sendMessages',
        'spendTrade',
        'terminal',
        'webBrowsing'
      ].sort()
    )
    expect(sent.permissions.notifications).toBe(true)
    expect(Object.entries(sent.permissions).filter(([, on]) => on)).toEqual([['notifications', true]])
  })

  it('a switch saves through main; Keychain links to the gateway toggle', async () => {
    const fake = fakeConsentBridge(
      accepted({ permissions: { microphone: true }, permissionsDecidedAt: '2026-10-17T10:00:00.000Z' }),
      true
    )

    const navigate = vi.fn()

    render(<PrivacySettings navigate={navigate} />)
    await waitFor(() => expect(screen.getByRole('switch', { name: en.rows.microphone.title })).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: en.rows.microphone.title }))
    })
    // Every row as shown: a row shown OFF is saved OFF; Keychain as its real encryption state.
    expect(fake.bridge.setPermissions).toHaveBeenCalledWith({
      permissions: {
        automation: false,
        clipboard: false,
        fileWriting: false,
        installSoftware: false,
        keychain: true,
        microphone: false,
        notifications: false,
        scheduledTasks: false,
        screen: false,
        sendMessages: false,
        spendTrade: false,
        terminal: false,
        webBrowsing: false
      }
    })
    expect(window.document.querySelectorAll('[data-privacy-permission]')).toHaveLength(12)
    expect(window.document.querySelectorAll('[data-privacy-group]')).toHaveLength(3)
    expect(screen.getByText(en.neverUsed.camera)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.settings.keychainOpen }))
    expect(navigate).toHaveBeenCalledWith('/settings?tab=gateway')
    expect(screen.queryByRole('switch', { name: en.rows.keychain.title })).toBeNull()
  })

  it('withdraw AI-provider consent records accepted:false after confirming', async () => {
    const fake = fakeConsentBridge(accepted({ aiProviderConsent: { accepted: true, at: 'x' } }))

    render(<PrivacySettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: en.settings.withdraw })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.settings.withdraw }))
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: en.settings.withdrawConfirm }))
    })
    await waitFor(() => expect(fake.bridge.setAiProvider).toHaveBeenCalledWith({ accepted: false }))
  })

  it('AI provider is a consent record, not a switch: state pill, Open Providers, Accept again after a withdrawal', async () => {
    const navigate = vi.fn()
    const fake = fakeConsentBridge(accepted({ aiProviderConsent: { accepted: false, at: 'y' } }))

    render(<PrivacySettings navigate={navigate} />)
    await waitFor(() => expect(screen.getByText(en.settings.aiWithdrawn('y'))).toBeTruthy())
    expect(screen.getByText(en.settings.aiWithdrawnHint)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: en.settings.aiRow })).toBeNull()
    expect(screen.queryByRole('button', { name: en.settings.withdraw })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.settings.openProviders }))
    expect(navigate).toHaveBeenCalledWith('/settings?tab=providers&pview=accounts')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.settings.aiAcceptAgain }))
    })
    await waitFor(() => expect(fake.bridge.setAiProvider).toHaveBeenCalledWith({ accepted: true }))
  })

  it('AI provider with no record says so instead of claiming a state', async () => {
    fakeConsentBridge(accepted({ aiProviderConsent: null }))

    render(<PrivacySettings />)
    await waitFor(() => expect(screen.getByText(en.settings.aiNotRecorded)).toBeTruthy())
    expect(screen.queryByRole('button', { name: en.settings.aiAcceptAgain })).toBeNull()
  })

  it('a request row shows the date and the time of day; the acceptance keeps the date alone', async () => {
    const at = new Date(2026, 9, 17, 14, 5).toISOString()
    const fake = fakeConsentBridge(accepted({ permissions: {}, permissionsDecidedAt: at }))

    vi.mocked(fake.bridge.requests!).mockResolvedValue([
      { answer: 'once', at, inft: 'inft-6', key: 'clipboard', reason: 'Paste the error into the bug report' }
    ])

    render(<PrivacySettings />)
    await waitFor(() => expect(window.document.querySelector('[data-privacy-request="clipboard"]')).toBeTruthy())
    expect(window.document.querySelector('[data-privacy-request="clipboard"]')!.textContent).toContain(
      en.settings.requestBy('inft-6', '17 October 2026, 14:05')
    )
    expect(screen.getByText(en.settings.accepted('17 October 2026'))).toBeTruthy()
    expect(formatConsentDate(at)).toBe('17 October 2026')
    expect(formatRequestTime('not a date')).toBe('not a date')
  })
})

describe('Settings › Privacy words', () => {
  const leaves = (value: unknown, path = ''): [string, string][] =>
    typeof value === 'string'
      ? [[path, value]]
      : typeof value === 'function'
        ? [[path, String((value as (...args: unknown[]) => unknown)('1', '2'))]]
        : value && typeof value === 'object'
          ? Object.entries(value).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key))
          : []

  it.each(['ja', 'zh', 'zh-hant', 'ar', 'pt-PT'] as const)(
    '%s has every sentence and none of them in English',
    locale => {
      const english = new Map(leaves(en))
      const local = new Map(leaves(privacyCopy(locale)))
      expect([...local.keys()].sort()).toEqual([...english.keys()].sort())
      const same = [...english].filter(([key, text]) => /[A-Za-z]{4,}/.test(text) && local.get(key) === text)
      expect(same.map(([key]) => key)).toEqual([])
    }
  )

  it('every switch title is one sentence with no OS name', () => {
    for (const row of Object.values(en.rows)) {
      expect(row.title).not.toMatch(/mac|apple|windows|\.$/i)
      expect(row.title.split(' ').length).toBeGreaterThan(3)
    }
  })
})
