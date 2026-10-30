import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  $desktopOnboarding,
  completeDesktopOnboarding,
  type DesktopOnboardingState,
  type OnboardingContext,
  peekPendingProviderOAuth,
  startManualProviderOAuth
} from '@/store/onboarding'
import { makeOAuthProvider } from '@/test/oauth-provider'

import { apiKeyPathFor, DesktopOnboardingOverlay, Picker } from '.'

const listOAuthProviders = vi.fn(async () => ({ providers: [makeOAuthProvider('anthropic', 'Anthropic API Key')] }))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGlobalModelOptions: async () => ({ providers: [] }),
  listOAuthProviders: () => listOAuthProviders()
}))

const IDLE: DesktopOnboardingState = {
  configured: true,
  flow: { status: 'idle' },
  mode: 'oauth',
  providers: null,
  reason: null,
  requested: false,
  firstRunSkipped: false,
  manual: false,
  localEndpoint: false
}

const ctx: OnboardingContext = { requestGateway: async () => undefined as never }

afterEach(() => {
  cleanup()
  $desktopOnboarding.set(IDLE)
})

describe('API-key-path providers', () => {
  it('maps the "Anthropic API Key" entry to a pasted ANTHROPIC_API_KEY', () => {
    expect(apiKeyPathFor('anthropic')?.option.envKey).toBe('ANTHROPIC_API_KEY')
    expect(apiKeyPathFor('claude-code')).toBeNull()
    expect(apiKeyPathFor('nous')).toBeNull()
  })

  it('opens the key form on the Anthropic key instead of starting the browser sign-in', () => {
    $desktopOnboarding.set({
      ...IDLE,
      configured: false,
      providers: [makeOAuthProvider('anthropic', 'Anthropic API Key')]
    })
    render(<Picker ctx={ctx} />)

    expect(screen.getByText(/Paste an sk-ant-… key/)).toBeTruthy()
    fireEvent.click(screen.getByText('Anthropic API Key'))

    expect($desktopOnboarding.get().mode).toBe('apikey')
    expect($desktopOnboarding.get().flow.status).toBe('idle')
    expect(screen.getByPlaceholderText('sk-ant-...')).toBeTruthy()
  })

  it('turns a deep link to the Anthropic entry into the key form, never a sign-in', async () => {
    render(<DesktopOnboardingOverlay enabled={false} profile="default" requestGateway={ctx.requestGateway} />)

    await act(async () => {
      startManualProviderOAuth('anthropic')
    })

    expect(peekPendingProviderOAuth()).toBeNull()
    expect($desktopOnboarding.get().mode).toBe('apikey')
    expect($desktopOnboarding.get().flow.status).toBe('idle')
  })

  it('drops a hand-off that outlived its manual session', async () => {
    $desktopOnboarding.set({ ...IDLE, providers: [] })
    render(<DesktopOnboardingOverlay enabled={false} profile="default" requestGateway={ctx.requestGateway} />)

    // An empty list keeps the hand-off alive (the overlay waits for a retry).
    listOAuthProviders.mockResolvedValueOnce({ providers: [] })
    await act(async () => {
      startManualProviderOAuth('openai-codex')
    })
    expect(peekPendingProviderOAuth()).toBe('openai-codex')
    act(() => completeDesktopOnboarding())

    expect(peekPendingProviderOAuth()).toBeNull()
  })
})
