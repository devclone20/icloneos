// v0.0.9 W1b — Settings › Voice › Local speech recognition: the ONE control that may install the voice extra carries
// `data-voice-extra-confirm` (the preload's `voiceExtra` lock), the bridge call happens inside the click (before any
// await, so the preload takes the owner's confirm), and every outcome says what happened. Red on the old code: the row
// (and the bridge) did not exist.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { w1bVoiceExtra } from '@/i18n/en/v009-w1b'

import type { VoiceExtraBridge } from '../../../electron/voice-extra-types'

import { VoiceExtraRow } from './voice-extra-row'

function withBridge(bridge: VoiceExtraBridge | undefined) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = bridge ? { icloneVoiceExtra: bridge } : {}
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('VoiceExtraRow', () => {
  it('no bridge (a browser, an older preload): no row', () => {
    withBridge(undefined)

    const { container } = render(<VoiceExtraRow />)

    expect(container.textContent).toBe('')
  })

  it('absent: Install is the marked control; the bridge is called inside the click; then installed', async () => {
    let calledDuringClick = false
    const status = vi
      .fn<VoiceExtraBridge['status']>()
      .mockResolvedValueOnce({ state: 'absent' })
      .mockResolvedValue({ state: 'installed', restartNeeded: true })
    const install = vi.fn<VoiceExtraBridge['install']>(() => {
      calledDuringClick = true

      return Promise.resolve({ ok: true, status: { state: 'installed', restartNeeded: true } })
    })

    withBridge({ install, status })
    render(<VoiceExtraRow />)

    const button = await screen.findByRole('button', { name: w1bVoiceExtra.install })

    expect(button.hasAttribute('data-voice-extra-confirm')).toBe(true)
    expect(screen.getByText(w1bVoiceExtra.state.absent)).toBeTruthy()

    fireEvent.click(button, { detail: 1 })
    expect(calledDuringClick).toBe(true)
    expect(install).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(screen.getByText(w1bVoiceExtra.state.installedRestart)).toBeTruthy())
    expect(screen.queryByRole('button', { name: w1bVoiceExtra.install })).toBeNull()
  })

  it('a refused click (no real gesture) says so and offers Try again', async () => {
    const status = vi.fn<VoiceExtraBridge['status']>().mockResolvedValue({ state: 'absent' })
    const install = vi.fn<VoiceExtraBridge['install']>().mockResolvedValue({ ok: false, refused: 'gesture' })

    withBridge({ install, status })
    render(<VoiceExtraRow />)

    // Find the button first: a findBy inside act() waits on updates act() holds back until it returns.
    const button = await screen.findByRole('button', { name: w1bVoiceExtra.install })

    await act(async () => {
      fireEvent.click(button, { detail: 1 })
    })

    await waitFor(() => expect(screen.getByText(w1bVoiceExtra.refused.gesture)).toBeTruthy())
    const retry = screen.getByRole('button', { name: w1bVoiceExtra.retry })

    expect(retry.hasAttribute('data-voice-extra-confirm')).toBe(true)
  })

  it('unsupported / unmanaged: words only, no Install', async () => {
    withBridge({ install: vi.fn(), status: vi.fn().mockResolvedValue({ state: 'unsupported' }) })
    render(<VoiceExtraRow />)

    expect(await screen.findByText(w1bVoiceExtra.state.unsupported)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
