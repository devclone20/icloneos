/** n1 (V3-K critic r1): without storage the fallback line is announced once per run, not after every answer. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $selectedStoredSessionId } from '@/store/session'

import { EngineFallbackBanner } from './engine-fallback-banner'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('engine fallback banner with no storage (n1)', () => {
  it('a second fallback for the same reason in the same conversation is not announced again', async () => {
    vi.useFakeTimers()
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })

    let at = Date.now()

    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
      icloneClaudeCode: {
        fallbackState: () => Promise.resolve({ lastFallback: { at, reason: 'binary_missing', text: 'x' } })
      }
    }
    $selectedStoredSessionId.set('chat-n1')
    render(<EngineFallbackBanner />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.queryByRole('status')).not.toBeNull()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('status')).toBeNull()

    // The next answer falls back for the same reason: a new fallback, same conversation and reason.
    at += 60_000
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
