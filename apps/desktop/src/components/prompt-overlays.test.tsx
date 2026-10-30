import type { JsonRpcGatewayClient } from '@hermes/shared'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $serverRequests, replayOpenRequests, resetServerRequestsForTest } from '@/lib/server-requests'
import { notifyError } from '@/store/notifications'
import { $secretRequest, $sudoRequest, clearAllPrompts, setSecretRequest, setSudoRequest } from '@/store/prompts'
import { $activeSessionId } from '@/store/session'

import { PromptOverlays } from './prompt-overlays'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))

// Drives the real seam: open requests are replayed through a fake gateway and
// every answer must leave as that gateway's `respond(id, {result})` frame.
function fakeGateway() {
  const respond = vi.fn((_id: number | string, _outcome: unknown) => true)

  const unsubscribe = () => () => {}

  const gateway = {
    on: unsubscribe,
    onOpen: unsubscribe,
    onServerRequest: unsubscribe,
    request: vi.fn(async () => ({})),
    respond
  } as unknown as JsonRpcGatewayClient

  return { gateway, respond }
}

function renderPrompts(sessionId: string | null = 's1') {
  render(
    <I18nProvider configClient={null}>
      <PromptOverlays sessionId={sessionId} />
    </I18nProvider>
  )
}

let fake: ReturnType<typeof fakeGateway>

beforeEach(() => {
  resetServerRequestsForTest()
  fake = fakeGateway()
  $activeSessionId.set('s1')
})

afterEach(() => {
  cleanup()
  clearAllPrompts()
  resetServerRequestsForTest()
  $activeSessionId.set(null)
  vi.clearAllMocks()
})

describe('PromptOverlays', () => {
  it('dismisses a stale sudo dialog when the seam no longer has the password request', async () => {
    setSudoRequest({ requestId: 'sudo-1', sessionId: 's1' })

    renderPrompts()

    expect(screen.getByText('Administrator password')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect($sudoRequest.get()).toBeNull())
    expect(fake.respond).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('dismisses a stale secret dialog when the seam no longer has the value request', async () => {
    setSecretRequest({ envVar: 'TEST_SECRET', prompt: 'Paste a secret', requestId: 'secret-1', sessionId: 's1' })

    renderPrompts()

    expect(screen.getByText('TEST_SECRET')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect($secretRequest.get()).toBeNull())
    expect(fake.respond).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('refuses a live sudo request with an empty value frame on Cancel', async () => {
    replayOpenRequests(fake.gateway, [{ id: 'sudo-1', method: 'sudo', params: { session_id: 's1' } }])

    renderPrompts()

    expect(screen.getByText('Administrator password')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect($sudoRequest.get()).toBeNull())
    expect(fake.respond).toHaveBeenCalledTimes(1)
    expect(fake.respond).toHaveBeenCalledWith('sudo-1', { result: { value: '' } })
    expect($serverRequests.get()).toEqual([])
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('refuses a live secret request with an empty value frame on Cancel', async () => {
    replayOpenRequests(fake.gateway, [
      {
        id: 'secret-1',
        method: 'secret',
        params: { env_var: 'TEST_SECRET', prompt: 'Paste a secret', session_id: 's1' }
      }
    ])

    renderPrompts()

    expect(screen.getByText('TEST_SECRET')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect($secretRequest.get()).toBeNull())
    expect(fake.respond).toHaveBeenCalledWith('secret-1', { result: { value: '' } })
    expect($serverRequests.get()).toEqual([])
  })

  it('keeps a live sudo dialog and reports the failure when the frame cannot be sent', async () => {
    replayOpenRequests(fake.gateway, [{ id: 'sudo-1', method: 'sudo', params: { session_id: 's1' } }])
    fake.respond.mockReturnValueOnce(false)

    renderPrompts()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(notifyError).toHaveBeenCalledTimes(1))
    expect($sudoRequest.get()).toMatchObject({ requestId: 'sudo-1' })
    expect($serverRequests.get().map(entry => entry.id)).toEqual(['sudo-1'])
  })
})
