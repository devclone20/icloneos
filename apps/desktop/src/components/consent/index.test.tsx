import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { enConsent } from '@/i18n/en'
import { ptPtConsent } from '@/i18n/pt-PT/consent'
import { notify } from '@/store/notifications'

import { accepted, bundledPolicy, fakeConsentBridge } from './fixtures'
import { resetConsentStore } from './store'

import { ConsentSheet } from './index'

// The accept sentence names the document by the title it bears (UF2C-c1-03).
const ACCEPT = enConsent.sheet.accept(bundledPolicy.title, bundledPolicy.version)

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notify: vi.fn(() => 'toast')
}))

let root: HTMLElement
const step = () => root.querySelector('[data-consent-step]')?.getAttribute('data-consent-step')

afterEach(() => {
  resetConsentStore()
})

async function openSheet() {
  root = render(<ConsentSheet />).container
  await waitFor(() => expect(step()).toBe('terms'))
}

describe('ConsentSheet', () => {
  it('fresh install: terms first, Continue inactive until the box is checked, then permissions', async () => {
    const fake = fakeConsentBridge(null)

    await openSheet()
    const proceed = screen.getByRole('button', { name: enConsent.sheet.continue })

    expect(proceed.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('Your agent lives on your device.')).toBeTruthy()
    // The AI-provider disclosure is part of the one required box; no optional box pretends to gate the send.
    expect(screen.getByText(enConsent.sheet.aiDisclosure)).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
    expect(proceed.hasAttribute('aria-disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(proceed)
    })
    await waitFor(() => expect(step()).toBe('permissions'))
    expect(fake.bridge.accept).toHaveBeenCalledWith({ aiProvider: true, version: bundledPolicy.version })
    // 10 agent capabilities + Microphone + Notifications; Keychain is a status row (U1-p2-02), Local network is gone
    // (U1-08-p2: nothing read it), and Camera, Location and Contacts are information, not switches.
    expect(screen.getAllByRole('switch')).toHaveLength(12)
    expect(screen.queryByRole('switch', { name: 'Keychain' })).toBeNull()
    expect(window.document.querySelector('[data-consent-permission="localNetwork"]')).toBeNull()
    expect(window.document.querySelectorAll('[data-consent-never-used]')).toHaveLength(3)
    expect(
      [...window.document.querySelectorAll('[data-consent-group]')].map(el => el.getAttribute('data-consent-group'))
    ).toEqual(['capabilities', 'device', 'never-used'])
    expect(screen.getAllByRole('switch').every(item => item.getAttribute('aria-checked') === 'false')).toBe(true)
  })

  it('terms opens on the dialog, never the accept box below the fold; Tab wraps inside; permissions on a switch', async () => {
    fakeConsentBridge(null)
    const calls: { options: FocusOptions | undefined; target: HTMLElement }[] = []
    const focus = HTMLElement.prototype.focus

    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      calls.push({ options, target: this })
      focus.call(this, options)
    })

    try {
      await openSheet()
      const dialog = screen.getByRole('dialog')
      const box = screen.getByRole('checkbox', { name: ACCEPT })

      // The box is the last thing in the step's scroll box: focused, it was invisible and Space accepted unseen.
      expect(window.document.activeElement).toBe(dialog)
      expect(calls[0]).toEqual({ options: { preventScroll: true }, target: dialog })
      expect(calls.some(call => call.target === box)).toBe(false)

      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
      // Continue is inactive, not disabled (U1-p2-01), so it is the last stop of the ring.
      expect(window.document.activeElement).toBe(screen.getByRole('button', { name: enConsent.sheet.continue }))
      act(() => dialog.focus())
      fireEvent.keyDown(dialog, { key: 'Tab' })
      expect(window.document.activeElement).toBe(within(dialog).getAllByRole('button')[0])

      fireEvent.click(box)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
      })
      await waitFor(() => expect(step()).toBe('permissions'))
      const first = screen.getAllByRole('switch')[0]

      expect(window.document.activeElement).toBe(first)
      expect(calls.at(-1)).toEqual({ options: { preventScroll: true }, target: first })
    } finally {
      spy.mockRestore()
    }
  })

  it('Escape does nothing on step 1 and Quit asks main to quit', async () => {
    const fake = fakeConsentBridge(null)

    await openSheet()
    fireEvent.keyDown(screen.getByRole('checkbox', { name: ACCEPT }), { key: 'Escape' })
    expect(step()).toBe('terms')
    fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.quit }))
    expect(fake.bridge.quit).toHaveBeenCalledTimes(1)
  })

  it('Continue sends the switches; nothing asks macOS on the sheet', async () => {
    const fake = fakeConsentBridge(null)

    await openSheet()
    fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    await waitFor(() => expect(step()).toBe('permissions'))
    fireEvent.click(screen.getByRole('switch', { name: 'Microphone' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    // Every row as shown: the untouched ones are recorded OFF, not left undecided.
    expect(fake.bridge.setPermissions).toHaveBeenCalledWith({
      permissions: {
        automation: false,
        clipboard: false,
        fileWriting: false,
        installSoftware: false,
        keychain: false,
        microphone: true,
        notifications: false,
        scheduledTasks: false,
        screen: false,
        sendMessages: false,
        spendTrade: false,
        terminal: false,
        webBrowsing: false
      }
    })
    expect(fake.requestMicrophoneAccess).not.toHaveBeenCalled()
  })

  it('Continue without touching anything records all thirteen shown values as false', async () => {
    const fake = fakeConsentBridge(null)

    await openSheet()
    fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    await waitFor(() => expect(step()).toBe('permissions'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    const sent = vi.mocked(fake.bridge.setPermissions).mock.calls[0]?.[0] as { permissions: Record<string, boolean> }

    expect(Object.keys(sent.permissions)).toHaveLength(13)
    expect(Object.values(sent.permissions).every(on => on === false)).toBe(true)
  })

  it('Allow all only turns the switches ON; nothing is recorded until Continue', async () => {
    const fake = fakeConsentBridge(null, true)

    await openSheet()
    fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    await waitFor(() => expect(step()).toBe('permissions'))
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(
      expect.arrayContaining([enConsent.sheet.skip, enConsent.sheet.allowAll, enConsent.sheet.continue])
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.allowAll }))
    })
    // The sheet stays open on the permissions step with every switch ON and nothing saved yet.
    expect(step()).toBe('permissions')
    expect(fake.bridge.setPermissions).not.toHaveBeenCalled()
    expect(screen.getAllByRole('switch').every(item => item.getAttribute('aria-checked') === 'true')).toBe(true)
    const allAllowed = screen.getByRole('button', { name: enConsent.sheet.allAllowed })

    expect(allAllowed.hasAttribute('disabled')).toBe(true)
    // Turning one switch back off re-enables Allow all.
    fireEvent.click(screen.getByRole('switch', { name: 'Microphone' }))
    expect(screen.getByRole('button', { name: enConsent.sheet.allowAll }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.allowAll }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    const sent = vi.mocked(fake.bridge.setPermissions).mock.calls[0]?.[0] as { permissions: Record<string, boolean> }

    expect(fake.bridge.setPermissions).toHaveBeenCalledTimes(1)
    expect(Object.keys(sent.permissions)).toHaveLength(13)
    expect(Object.values(sent.permissions).every(on => on === true)).toBe(true)
    expect(fake.requestMicrophoneAccess).not.toHaveBeenCalled()
  })

  it('Allow all tells the user when Keychain stays off; Continue records Keychain as its real state', async () => {
    for (const encrypted of [true, false]) {
      vi.mocked(notify).mockClear()
      resetConsentStore()
      const fake = fakeConsentBridge(null, encrypted)
      await openSheet()

      fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
      })
      await waitFor(() => expect(step()).toBe('permissions'))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.allowAll }))
      })
      expect(vi.mocked(notify).mock.calls.map(([input]) => input.message)).toEqual(
        encrypted ? [] : [enConsent.sheet.allowAllKeychain]
      )
      expect(fake.bridge.setPermissions).not.toHaveBeenCalled()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
      })
      expect(vi.mocked(fake.bridge.setPermissions).mock.calls[0]?.[0]).toMatchObject({
        permissions: { keychain: encrypted, terminal: true }
      })
      cleanup()
    }
  })

  it('Keychain is informational: it shows the real encryption state and is saved as that state', async () => {
    const fake = fakeConsentBridge(null, true)

    await openSheet()
    fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    await waitFor(() => expect(step()).toBe('permissions'))
    const keychain = window.document.querySelector<HTMLElement>('[data-consent-permission="keychain"]')!

    expect(keychain.querySelector('[role="switch"]')).toBeNull()
    expect(keychain.querySelector('[data-consent-keychain-state]')?.textContent).toBe(
      enConsent.settings.keychainState(true)
    )
    expect(keychain.textContent).toContain(enConsent.sheet.keychainLine(true))
    fireEvent.click(keychain)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    expect(vi.mocked(fake.bridge.setPermissions).mock.calls[0]?.[0]).toMatchObject({ permissions: { keychain: true } })
  })

  it('Skip for now writes permissions {}', async () => {
    const fake = fakeConsentBridge(null)

    await openSheet()
    fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    await waitFor(() => expect(step()).toBe('permissions'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.skip }))
    })
    expect(fake.bridge.setPermissions).toHaveBeenCalledWith({ skipped: true })
    expect(fake.record()?.permissions).toEqual({})
  })

  it('a policy bump shows step 1 only and keeps the saved switches', async () => {
    const saved = { clipboard: true, microphone: false }
    const fake = fakeConsentBridge(accepted({ policyVersion: '0.9', permissions: saved, permissionsDecidedAt: 'x' }))

    await openSheet()
    expect(screen.getByText(enConsent.sheet.updateTitle)).toBeTruthy()
    expect(screen.queryByText(enConsent.sheet.step(1, 2))).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: ACCEPT }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    await waitFor(() => expect(step()).toBe('terms'))
    expect(fake.bridge.setPermissions).not.toHaveBeenCalled()
    expect(fake.record()?.permissions).toEqual(saved)
  })

  // Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY, so a
  // starting pt-PT — a choice saved by an earlier version, a Portuguese system — opens the sheet in English. The
  // chrome still comes from the bank on BOTH steps (the step counter is there in English, nothing Portuguese leaks
  // through), and the binding-language line is gone with the translated sheet it existed for: the policy and the
  // sheet are now one language, so there is nothing to warn the reader about (`isTranslatedBank` is false).
  it('ruling 69: a saved pt-PT opens the sheet in English, step counter on both steps, no binding-language line', async () => {
    fakeConsentBridge(null)
    root = render(
      <I18nProvider configClient={null} initialLocale="pt-PT">
        <ConsentSheet />
      </I18nProvider>
    ).container
    await waitFor(() => expect(step()).toBe('terms'))
    const dialog = screen.getByRole('dialog')

    const portuguese = () =>
      [...dialog.querySelectorAll('span, p, button, h2')].filter(el =>
        /^Passo \d de \d$/.test(el.textContent?.trim() ?? '')
      )

    expect(within(dialog).getByText(enConsent.sheet.step(1, 2)).textContent).toContain('Step')
    expect(portuguese()).toHaveLength(0)
    expect(dialog.textContent).not.toContain(ptPtConsent.sheet.policyLanguage)
    expect(dialog.textContent).not.toContain(enConsent.sheet.policyLanguage)
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.sheet.continue }))
    })
    await waitFor(() => expect(step()).toBe('permissions'))
    expect(within(dialog).getByText(enConsent.sheet.step(2, 2))).toBeTruthy()
    expect(dialog.textContent).not.toContain(enConsent.sheet.policyLanguage)
    expect(portuguese()).toHaveLength(0)
  })

  it('an accepted current policy shows nothing', async () => {
    fakeConsentBridge(accepted())
    root = render(<ConsentSheet />).container
    await waitFor(() => expect(step()).toBeUndefined())
  })
})

describe('ConsentSheet over the boot screen', () => {
  it('masks the launch IPC round trip with the boot void (pure black), not the surface fill', async () => {
    const fake = fakeConsentBridge(null)

    fake.bridge.get = vi.fn(() => new Promise<never>(() => {}))
    root = render(<ConsentSheet />).container

    const mask = root.querySelector('[data-consent-step="loading"]')
    const classes = mask?.className.split(/\s+/) ?? []

    expect(mask).not.toBeNull()
    expect(classes).toContain('ic-sys-void')
    expect(classes).not.toContain('bg-(--ui-chat-surface-background)')
    cleanup()
  })

  it('fresh install: the Terms sheet itself stands on the boot void, so launch never steps black → night → black', async () => {
    fakeConsentBridge(null)
    await openSheet()

    const sheet = root.querySelector('[class*="z-(--z-consent)"]')
    const classes = sheet?.className.split(/\s+/) ?? []

    expect(classes).toContain('ic-sys-void')
    expect(classes).not.toContain('bg-(--ui-chat-surface-background)')
    cleanup()
  })
})
