import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'

import { $providerBlock, noteTurnFailure, noteTurnSuccess } from '@/lib/provider-block'

import { PROVIDER_SETTINGS_LINK, ProviderBlockBanner } from './provider-block-banner'

function Where() {
  const { pathname, search } = useLocation()

  return <div data-testid="where">{pathname + search}</div>
}

beforeEach(() => $providerBlock.set(null))

describe('ProviderBlockBanner', () => {
  it('shows a 401 block with the settings CTA, never key material, and clears on success', async () => {
    noteTurnFailure({ layer: 'auth', code: 'auth', retryable: false, provider: 'anthropic', model: 'claude-opus-5-5' })

    const { container, rerender } = render(
      <MemoryRouter>
        <ProviderBlockBanner />
      </MemoryRouter>
    )

    expect(screen.getByRole('status').textContent).toMatch(/The configured Anthropic key is not a valid Anthropic key/)
    expect(screen.getByText('Open Settings → Providers')).toBeTruthy()
    expect(container.textContent ?? '').not.toMatch(/sk-|key=|bearer/i)

    noteTurnSuccess('anthropic', 'claude-opus-5-5')
    rerender(
      <MemoryRouter>
        <ProviderBlockBanner />
      </MemoryRouter>
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('raises the block for a generic provider-layer HTTP 401 and links to Settings → Providers', () => {
    noteTurnFailure(
      { layer: 'provider', code: 'non_retryable_client_error', retryable: false, provider: 'anthropic', model: 'm' },
      'HTTP 401: invalid x-api-key'
    )

    render(
      <MemoryRouter initialEntries={['/']}>
        <ProviderBlockBanner />
        <Routes>
          <Route element={<Where />} path="*" />
        </Routes>
      </MemoryRouter>
    )

    expect(screen.getByRole('status').getAttribute('data-provider-block')).toBe('auth')
    expect(screen.getByRole('status').textContent).not.toMatch(/x-api-key|sk-|bearer/i)
    fireEvent.click(screen.getByText('Open Settings → Providers'))
    expect(screen.getByTestId('where').textContent).toBe(PROVIDER_SETTINGS_LINK)
    expect(PROVIDER_SETTINGS_LINK).toMatch(/[?&]tab=providers\b/)
  })
})
