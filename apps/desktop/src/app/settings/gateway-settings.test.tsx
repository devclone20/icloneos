import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getConnectionConfig = vi.fn()
const saveConnectionConfig = vi.fn()

// This test owns the machine-level GatewaySettings contract. The managed SSH
// update section mounted below the registry has its own focused coverage
// (store/managed-updates.test.ts); keep its store subscriptions out of this
// single-purpose test.
vi.mock('./managed-updates-section', () => ({ ManagedUpdatesSection: () => null }))

// Front I-D r3 anatomy pin: no control of this pane lives outside THE row (section-heading actions aside).
const looseControls = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="switch"], [role="combobox"]')]
    .filter(control => !control.closest('[data-setting-row], h2, h3'))
    .map(control => control.getAttribute('aria-label') ?? control.textContent)

const localConnection = {
  cloudOrg: '',
  envOverride: false,
  mode: 'local',
  remoteAuthMode: 'token',
  remoteOauthConnected: false,
  remoteTokenPreview: null,
  remoteTokenSet: false,
  remoteUrl: ''
}

beforeEach(() => {
  getConnectionConfig.mockResolvedValue(localConnection)
  saveConnectionConfig.mockResolvedValue(localConnection)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { getConnectionConfig, saveConnectionConfig }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GatewaySettings', () => {
  it('loads the machine-level connection config (no profile scoping)', async () => {
    const { GatewaySettings } = await import('./gateway-settings')

    const { container } = render(<GatewaySettings />)
    expect(await screen.findByText('On this computer')).toBeTruthy()
    expect(looseControls(container)).toEqual([])
    expect(screen.getByText('Your agent runs privately here and works offline. This is the default.')).toBeTruthy()

    // The page manages the machine's gateway connections; it must load the
    // global config, never a per-profile override.
    await waitFor(() => expect(getConnectionConfig).toHaveBeenCalledWith(null))
    expect(getConnectionConfig).not.toHaveBeenCalledWith(expect.any(String))

    // The legacy per-profile scope switcher must not render.
    expect(screen.queryByText('Applies to')).toBeNull()
    expect(screen.queryByText('All profiles')).toBeNull()
    expect(screen.queryByText('Use default gateway')).toBeNull()
  })

  it('lays the mode cards over the full row width, never inside a collapsed container (I-D r5)', async () => {
    const { GatewaySettings } = await import('./gateway-settings')

    render(<GatewaySettings />)
    const card = (await screen.findByText('On this computer')).closest('button') as HTMLElement
    const container = card.closest('.\\@container') as HTMLElement

    expect(container.className).toContain('w-full')
    expect(card.closest('[data-setting-row]')).toBeTruthy()
  })
})

describe('GatewaySettings sign-out', () => {
  const remote = {
    ...localConnection,
    mode: 'remote',
    remoteAuthMode: 'oauth',
    remoteOauthConnected: true,
    remoteUrl: 'https://gw.example.com/hermes?token=s3cret'
  }

  it('signs out in one click (no confirm) and audits the host only', async () => {
    window.localStorage.clear()
    const oauthLogoutConnectionConfig = vi.fn(async () => undefined)
    getConnectionConfig.mockResolvedValue(remote)
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { getConnectionConfig, oauthLogoutConnectionConfig, saveConnectionConfig }
    })
    const { $confirmRequest } = await import('@/store/confirm')
    const { readCredentialAudit } = await import('@/lib/credential-audit')
    const { GatewaySettings } = await import('./gateway-settings')

    render(<GatewaySettings />)
    const signOut = await screen.findByRole('button', { name: 'Sign out' })

    await act(async () => {
      fireEvent.click(signOut)
    })

    await waitFor(() => expect(oauthLogoutConnectionConfig).toHaveBeenCalledWith(remote.remoteUrl))
    expect($confirmRequest.get()).toBeNull()
    await waitFor(() =>
      expect(readCredentialAudit()[0]).toMatchObject({
        id: 'gw.example.com',
        kind: 'gateway_session',
        result: 'signed_out',
        surface: 'gateway'
      })
    )
    expect(JSON.stringify(readCredentialAudit())).not.toContain('s3cret')
  })
})
