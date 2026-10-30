import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fakeConsentBridge } from '@/components/consent/fixtures'
import { PermissionsStep } from '@/components/consent/permissions-step'
import { CONSENT_PERMISSION_KEYS, type ConsentPermissions } from '@/components/consent/types'
import { enConsent } from '@/i18n/en'

afterEach(cleanup)

async function mount(values: ConsentPermissions, onChange = vi.fn()) {
  const policy = (await fakeConsentBridge(null).bridge.get()).bundled

  return render(
    <PermissionsStep
      busy={false}
      error={null}
      onAllowAll={vi.fn()}
      onChange={onChange}
      onSave={vi.fn()}
      onSkip={vi.fn()}
      policy={policy}
      values={values}
    />
  )
}

// U1-08-p2: the sheet offered a live "Local network" switch that nothing in the app read.
describe('PermissionsStep Local network (U1-08-p2)', () => {
  it('shows no Local network row and records no such key', async () => {
    await mount({})

    // The shipped policy's §9 table still lists it (electron/policy-version.generated.ts): the renderer drops the row.
    const policy = (await fakeConsentBridge(null).bridge.get()).bundled

    expect(policy.permissions.some(row => row.key === 'localNetwork')).toBe(true)
    expect(CONSENT_PERMISSION_KEYS).not.toContain('localNetwork')
    expect(screen.queryByRole('switch', { name: 'Local network' })).toBeNull()
    expect(window.document.querySelector('[data-consent-permission="localNetwork"]')).toBeNull()
    // 10 agent capabilities + Microphone + Notifications.
    expect(screen.getAllByRole('switch')).toHaveLength(12)
  })
})

// U1-p2-02: a greyed switch the person could never move, explained with signing-key / token / secret jargon.
describe('PermissionsStep Keychain (U1-p2-02)', () => {
  it('is a status row in plain words, never a switch', async () => {
    const onChange = vi.fn()

    await mount({ keychain: false }, onChange)
    const row = window.document.querySelector<HTMLElement>('[data-consent-permission="keychain"]')!

    expect(row.querySelector('[role="switch"]')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Keychain' })).toBeNull()
    expect(row.querySelector('[data-consent-keychain-state]')?.textContent).toBe(
      enConsent.settings.keychainState(false)
    )
    // UF2C-c1-01: 'Not encrypted' beside a sentence claiming Keychain storage of 'wallet keys' was a contradiction.
    expect(row.textContent).toContain(enConsent.sheet.keychainLine(false))
    expect(row.textContent).not.toMatch(/in the Mac Keychain|wallet keys/i)
    expect(row.textContent).not.toMatch(/signing key|sign-in token|connection secret|switch/i)

    fireEvent.click(row)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows Encrypted when the Mac already encrypts', async () => {
    await mount({ keychain: true })
    const row = window.document.querySelector<HTMLElement>('[data-consent-permission="keychain"]')!

    expect(row.querySelector('[data-consent-keychain-state="on"]')?.textContent).toBe(
      enConsent.settings.keychainState(true)
    )
    expect(row.textContent).toContain(enConsent.sheet.keychainLine(true))
    expect(row.textContent).toMatch(/Mac Keychain/)
  })
})
