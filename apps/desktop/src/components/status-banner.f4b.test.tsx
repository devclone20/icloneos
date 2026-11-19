/**
 * v0.0.9 F4b — type 2 for the banners F4 left hand-drawn (P0_NOTIFICATIONS B1, B2, B4, T5): billing wall, provider
 * refusal, engine fallback and remote display now render through IcStatusBanner (one band, by priority, words wrap,
 * a ✕ only where the owner may put the reminder away). Each case fails on the old code: one truncated line above the
 * composer, a status-row in the composer card, or a sticky toast in the toast stack.
 */
import type { BillingBlock } from '@hermes/shared'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderBlockBanner } from '@/app/chat/provider-block-banner'
import { I18nProvider } from '@/i18n'
import { f4bBanner } from '@/i18n/en/v009-f4b'
import { $providerBlock, noteTurnFailure } from '@/lib/provider-block'
import { $billingBlock, setBillingBlock } from '@/store/billing-block'
import { $notifications, clearNotifications } from '@/store/notifications'

import { BillingBanner } from './billing-banner'
import { RemoteDisplayBanner } from './remote-display-banner'
import { IcStatusBanner } from './status-banner'

const band = () => document.querySelector<HTMLElement>('[data-slot="ic-banner"]')

beforeEach(() => {
  $providerBlock.set(null)
  $billingBlock.set(null)
  clearNotifications()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  vi.restoreAllMocks()
})

describe('F4b · IcStatusBanner gains a ✕ for dismissible reminders and keeps data hooks on the announced element', () => {
  it('no onDismiss → no ✕ (a state that must stay only collapses)', () => {
    render(<IcStatusBanner title="The agent is not running" />)

    expect(screen.queryByRole('button', { name: f4bBanner.dismiss })).toBeNull()
  })

  it('onDismiss → a labelled ✕ that calls it; data-* lands on the role=status element', () => {
    const onDismiss = vi.fn()

    render(<IcStatusBanner data={{ 'data-kind-hook': 'x' }} onDismiss={onDismiss} title="Out of credits" />)

    expect(screen.getByRole('status').getAttribute('data-kind-hook')).toBe('x')
    fireEvent.click(screen.getByRole('button', { name: f4bBanner.dismiss }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('a block title (one line per reset) is not nested in a <p>', () => {
    render(
      <IcStatusBanner
        title={
          <div>
            <p>one</p>
            <p>two</p>
          </div>
        }
      />
    )

    expect(band()?.querySelector('p p, p div')).toBeNull()
  })
})

describe('F4b · the migrated banners', () => {
  it('provider refusal: the band, the whole sentence (no truncate), its data hook, a ✕ that clears the block', () => {
    noteTurnFailure({ layer: 'auth', code: 'auth', retryable: false, provider: 'anthropic', model: 'm' })

    render(
      <MemoryRouter>
        <ProviderBlockBanner />
      </MemoryRouter>
    )

    expect(band()).not.toBeNull()
    expect(screen.getByRole('status').getAttribute('data-provider-block')).toBe('auth')
    expect(document.querySelector('[data-provider-block] .truncate')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: f4bBanner.dismiss }))
    expect($providerBlock.get()).toBeNull()
  })

  it('billing wall: the band with what (title) and why (the whole message), its CTA, and a ✕ that clears it', () => {
    const block: BillingBlock = {
      billing_url: null,
      is_nous: false,
      message: 'Your credit balance is too low.\nAdd credits to continue.',
      model: 'm',
      provider: 'openrouter',
      provider_label: 'OpenRouter'
    }

    setBillingBlock('s1', block)

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <BillingBanner sessionId="s1" />
      </I18nProvider>
    )

    expect(band()).not.toBeNull()
    expect(screen.getByRole('status').textContent).toContain(
      'Your credit balance is too low. Add credits to continue.'
    )

    const dismiss = screen.getAllByRole('button').find(b => b.closest('.icn-close'))

    expect(dismiss).toBeTruthy()
    fireEvent.click(dismiss!)
    expect($billingBlock.get()).toBeNull()
  })

  it('remote display: a band, not a sticky toast in the stack', async () => {
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
      getRemoteDisplayReason: () => Promise.resolve('RDP session')
    }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RemoteDisplayBanner />
      </I18nProvider>
    )

    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('RDP session')
    expect($notifications.get()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: f4bBanner.dismiss }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
