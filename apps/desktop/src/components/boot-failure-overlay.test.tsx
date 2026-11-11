import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from './boot-failure-overlay'

// Remote-backend users hit a hard boot failure that isn't OAuth reauth (token
// auth, wrong URL, unreachable host). The recovery screen must let them fix the
// remote connection in place — the "Connection settings" action swaps the card
// to an in-line connect form — instead of stranding them (the old bug forced a
// hand-edit of connection.json).

function failBoot() {
  $desktopBoot.set({
    error: 'Could not connect to Hermes gateway',
    fakeMode: false,
    message: 'boot failed',
    phase: 'renderer.error',
    progress: 40,
    running: false,
    timestamp: Date.now(),
    visible: true
  })
}

function stubDesktop(config: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const original = window.hermesDesktop
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { getRecentLogs: async () => ({ lines: [] }), getConnectionConfig: async () => config, ...overrides }
  })

  return () => Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: original })
}

const remoteToken = {
  envOverride: false,
  mode: 'remote',
  profile: null,
  remoteAuthMode: 'token',
  remoteOauthConnected: false,
  remoteTokenPreview: null,
  remoteTokenSet: true,
  remoteUrl: 'http://100.116.104.53:9191',
  cloudOrg: ''
}

beforeEach(() => {
  $desktopOnboarding.set({
    configured: true,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  })
  failBoot()
})

afterEach(cleanup)

describe('BootFailureOverlay', () => {
  it('swaps to the in-place gateway settings view (no route nav) and back', async () => {
    render(<BootFailureOverlay />)

    fireEvent.click(screen.getByRole('button', { name: /gateway settings/i }))
    // Recovery actions give way to the embedded panel (behind a Back control).
    expect(await screen.findByRole('button', { name: /back/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull()
  })

  it('drops local-only Repair and Use-local-gateway on a local failure', () => {
    render(<BootFailureOverlay />)
    // No connection config stub → treated as a local failure.
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /repair/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /use local gateway/i })).toBeNull()
  })

  it('leads with Gateway settings and drops Repair for a remote (token) failure', async () => {
    const restore = stubDesktop(remoteToken)

    try {
      render(<BootFailureOverlay />)
      await waitFor(() => expect(screen.queryByRole('button', { name: /repair/i })).toBeNull())
      expect(screen.getByRole('button', { name: /gateway settings/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /use local gateway/i })).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('opens gateway settings with a partial persisted remote config', async () => {
    const restore = stubDesktop({ mode: 'remote', remoteAuthMode: undefined, remoteUrl: undefined })

    try {
      render(<BootFailureOverlay />)
      fireEvent.click(screen.getByRole('button', { name: /gateway settings/i }))

      expect(await screen.findByRole('button', { name: /back/i })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    } finally {
      restore()
    }
  })

  it('clears and signs in only the failed gateway once', async () => {
    const gatewayUrl = 'http://100.116.104.53:9191'
    const logout = vi.fn().mockResolvedValue({ ok: true, connected: false })
    const login = vi.fn().mockResolvedValue({ ok: true, connected: false })

    const restore = stubDesktop(
      {
        ...remoteToken,
        remoteAuthMode: 'oauth',
        remoteOauthConnected: false,
        remoteTokenSet: false,
        remoteUrl: gatewayUrl
      },
      {
        oauthLoginConnectionConfig: login,
        oauthLogoutConnectionConfig: logout,
        probeConnectionConfig: vi.fn().mockResolvedValue({ providers: [{ id: 'basic', type: 'password' }] })
      }
    )

    try {
      render(<BootFailureOverlay />)
      fireEvent.click(await screen.findByRole('button', { name: /sign out & sign in/i }))

      await waitFor(() => expect(login).toHaveBeenCalledWith(gatewayUrl))
      expect(logout).toHaveBeenCalledTimes(1)
      expect(logout).toHaveBeenCalledWith(gatewayUrl)
      expect(login).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('recovers a cloud connection through the portal cascade instead of native OAuth', async () => {
    const gatewayUrl = 'https://agent-1.agents.nousresearch.com'
    const logout = vi.fn().mockResolvedValue({ ok: true, connected: false })
    const nativeLogin = vi.fn().mockResolvedValue({ ok: true, connected: false })
    const cloudStatus = vi.fn().mockResolvedValue({ portalBaseUrl: 'https://portal.nousresearch.com', signedIn: false })

    const cloudLogin = vi.fn().mockResolvedValue({
      ok: true,
      portalBaseUrl: 'https://portal.nousresearch.com',
      signedIn: true
    })

    const cloudAgentSignIn = vi.fn().mockResolvedValue({ baseUrl: gatewayUrl, connected: false })

    const restore = stubDesktop(
      {
        ...remoteToken,
        mode: 'cloud',
        remoteAuthMode: 'oauth',
        remoteOauthConnected: false,
        remoteTokenSet: false,
        remoteUrl: gatewayUrl
      },
      {
        cloud: { status: cloudStatus, login: cloudLogin, agentSignIn: cloudAgentSignIn },
        oauthLoginConnectionConfig: nativeLogin,
        oauthLogoutConnectionConfig: logout,
        probeConnectionConfig: vi.fn().mockResolvedValue({ providers: [{ id: 'nous', type: 'oauth' }] })
      }
    )

    try {
      render(<BootFailureOverlay />)
      fireEvent.click(await screen.findByRole('button', { name: /sign in/i }))

      await waitFor(() => expect(cloudAgentSignIn).toHaveBeenCalledWith(gatewayUrl))
      expect(logout).toHaveBeenCalledWith(gatewayUrl)
      expect(cloudStatus).toHaveBeenCalledTimes(1)
      expect(cloudLogin).toHaveBeenCalledTimes(1)
      expect(nativeLogin).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('shows the Nous Cloud down recovery when the backend flags isCloudBackendDown', async () => {
    const restore = stubDesktop(remoteToken)
    $desktopBoot.set({
      error: 'Nous Cloud agent ares-3009.agents.nousresearch.com is down (HTTP 503: server-side fault).',
      fakeMode: false,
      isCloudBackendDown: true,
      message: 'boot failed',
      phase: 'renderer.error',
      progress: 40,
      running: false,
      statusCode: 503,
      timestamp: Date.now(),
      visible: true
    })

    try {
      render(<BootFailureOverlay />)
      // Cloud-specific title + actionable recovery instead of the generic
      // remote-failure copy.
      expect(await screen.findByText(/Your cloud agent is down/i)).toBeTruthy()
      // Portal and Discord are dedicated action buttons (localized labels
      // can't drift the URLs, which live in code).
      expect(screen.getByRole('button', { name: /check portal status/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /get help on discord/i })).toBeTruthy()
      // Cloud-down is a remote failure: local-only Repair is dropped; the
      // actionable paths are Gateway settings + Use local gateway.
      expect(screen.queryByRole('button', { name: /repair/i })).toBeNull()
      expect(screen.getByRole('button', { name: /gateway settings/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /use local gateway/i })).toBeTruthy()
      // The electron-built error message (portal / local mode / Discord) is
      // still surfaced in the error box.
      expect(screen.getByText(/ares-3009\.agents\.nousresearch\.com/i)).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('V3-S: a refused local spawn (permission gate not in place) gets the gate copy, Retry and Repair only', () => {
    $desktopBoot.set({
      error:
        '[iclone-gate] The icloneOS permission gate is not in place, so the agent was not started: Hermes did not load iclone-permissions',
      fakeMode: false,
      message: 'boot failed',
      phase: 'backend.error',
      progress: 84,
      running: false,
      timestamp: Date.now(),
      visible: true
    })
    render(<BootFailureOverlay />)

    expect(screen.getByText(/The permission gate is not in place/i)).toBeTruthy()
    expect(screen.getByText(/Repair install reinstalls the agent runtime, then the gate/i)).toBeTruthy()
    // m2: the one cause neither Retry nor Repair fixes is named, with its remedy.
    expect(screen.getByText(/remove iclone-permissions and iclone-confinement from plugins\.disabled/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /repair/i })).toBeTruthy()
    // Gateway settings cannot fix a local gate: not offered.
    expect(screen.queryByRole('button', { name: /gateway settings/i })).toBeNull()
    // main's reason stays visible in the error box.
    expect(screen.getByText(/did not load iclone-permissions/i)).toBeTruthy()
  })

  it('V3-S r4 m-g: a runtime the app does not manage (a git checkout) is named as the cause, with its way out', () => {
    $desktopBoot.set({
      error:
        "[iclone-gate] The icloneOS permission gate is not in place, so the agent was not started: iclone-permissions: the copy in /Users/u/.hermes/hermes-agent differs from the app's (1 changed (core.py)); runtime not managed by the app (it is a git checkout, which icloneOS never writes to), so icloneOS never writes to it [iclone-gate:unmanaged-runtime]",
      fakeMode: false,
      message: 'boot failed',
      phase: 'backend.error',
      progress: 84,
      running: false,
      timestamp: Date.now(),
      visible: true
    })
    render(<BootFailureOverlay />)

    expect(screen.getByText(/The permission gate is not in place/i)).toBeTruthy()
    expect(screen.getByText(/your own git checkout of Hermes/i)).toBeTruthy()
    expect(screen.getByText(/Repair install sets up icloneOS's own verified copy in the app's folder/i)).toBeTruthy()
    // The generic hint (Repair "reinstalls the agent runtime") is not the one shown for this cause.
    expect(screen.queryByText(/Repair install reinstalls the agent runtime, then the gate/i)).toBeNull()
    expect(screen.getByRole('button', { name: /repair/i })).toBeTruthy()
  })
})

// The exact shape a real Electron invoke hands the renderer (home-settings-ipc.live.test.ts proves it).
const WRAPPED =
  "Error invoking remote method 'hermes:connection': Error: Your .env is a link to a file outside the agent's home (/dot/env), and the agent's sandbox cannot read outside its home, so the agent was not started. Replace the link with a plain file, then try again: (umask 077)"

const REFUSAL = {
  code: 'home-settings-refused',
  findings: [
    {
      command: '(umask 077 && t=$(mktemp /h/.env.XXXXXX) && cp -L /h/.env "$t" && mv "$t" /h/.env)',
      file: '.env',
      kind: 'link-outside',
      message: 'whole sentence',
      path: '/h/.env',
      reason: "Your .env is a link to a file outside the agent's home (/dot/env), so the agent was not started.",
      target: '/dot/env'
    }
  ]
}

describe('BootFailureOverlay on a settings refusal over the real IPC shape', () => {
  const failWith = (error: string) => {
    failBoot()
    $desktopBoot.set({ ...$desktopBoot.get(), error })
  }

  it('offers the copy and Retry, never Repair, and copies only when the owner clicks', async () => {
    const replaceWithCopy = vi.fn(async () => ({ ok: true, refusal: null }))

    const restore = stubDesktop(
      { mode: 'local' },
      { homeSettings: { check: async () => REFUSAL, replaceWithCopy, warnings: async () => [] } }
    )

    failWith(WRAPPED)
    render(<BootFailureOverlay />)

    const button = await screen.findByRole('button', { name: 'Replace with a copy' })

    expect(screen.queryByRole('button', { name: /repair/i })).toBeNull()
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
    expect(screen.getByText(REFUSAL.findings[0].command)).toBeTruthy()
    expect(screen.getByText(/The agent can read that copy\./)).toBeTruthy()
    expect(replaceWithCopy).not.toHaveBeenCalled()

    fireEvent.click(button)
    await screen.findByRole('status')
    expect(replaceWithCopy).toHaveBeenCalledExactlyOnceWith({ doing: 'start', file: '.env', profile: null, target: '/dot/env' })
    expect(screen.queryByRole('button', { name: 'Replace with a copy' })).toBeNull()
    expect(screen.queryByText(/Fix it above/)).toBeNull()
    restore?.()
  })

  it('a link to a secret offers no copy, by button or by command: only that the owner moves it', async () => {
    const replaceWithCopy = vi.fn()
    const reason = 'Your .env is a link to /fake/.ssh/id_rsa, a file the agent must never read, so the agent was not started. Move this file yourself: put only the settings the agent should have in a plain file at /h/.env, then try again.'
    const guarded = { code: REFUSAL.code, findings: [{ command: '', file: '.env', kind: 'link-guarded', message: reason, path: '/h/.env', reason, target: '/fake/.ssh/id_rsa' }] }

    const restore = stubDesktop(
      { mode: 'local' },
      { homeSettings: { check: async () => guarded, replaceWithCopy, warnings: async () => [] } }
    )

    failWith(reason)
    render(<BootFailureOverlay />)

    expect((await screen.findByTestId('home-settings-refusal')).textContent).toContain('Move this file yourself')
    expect(screen.queryByRole('button', { name: 'Replace with a copy' })).toBeNull()
    expect(screen.queryByText(/Or run this in Terminal/)).toBeNull()
    expect(replaceWithCopy).not.toHaveBeenCalled()
    restore?.()
  })

  it('the button carries the mark the preload needs, and a failed call is not called unreadable', async () => {
    const restore = stubDesktop(
      { mode: 'local' },
      {
        homeSettings: {
          check: async () => REFUSAL,
          replaceWithCopy: async () => {
            throw new Error('the call failed')
          },
          warnings: async () => []
        }
      }
    )

    failWith(WRAPPED)
    render(<BootFailureOverlay />)

    const button = await screen.findByRole('button', { name: 'Replace with a copy' })

    expect(button.hasAttribute('data-confinement-confirm')).toBe(true)
    fireEvent.click(button)

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain('could not write the copy')
    expect(alert.textContent).not.toContain('cannot read')
    restore?.()
  })

  it('a target that cannot be read is said on the card, and the refusal stays', async () => {
    const restore = stubDesktop(
      { mode: 'local' },
      {
        homeSettings: {
          check: async () => REFUSAL,
          replaceWithCopy: async () => ({ ok: false, reason: 'unreadable', refusal: REFUSAL }),
          warnings: async () => []
        }
      }
    )

    failWith(WRAPPED)
    render(<BootFailureOverlay />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replace with a copy' }))
    expect((await screen.findByRole('alert')).textContent).toContain('This app cannot read /dot/env')
    expect(screen.getByRole('button', { name: 'Replace with a copy' })).toBeTruthy()
    restore?.()
  })

  it('the words alone do nothing: main says no refusal, so the ordinary card with Repair', async () => {
    const restore = stubDesktop(
      { mode: 'local' },
      { homeSettings: { check: async () => null, replaceWithCopy: vi.fn(), warnings: async () => [] } }
    )

    failWith(WRAPPED)
    render(<BootFailureOverlay />)
    expect(await screen.findByRole('button', { name: /repair/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Replace with a copy' })).toBeNull()
    restore?.()
  })
})
