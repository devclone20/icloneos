import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $notifications, clearNotifications } from '@/store/notifications'
import { $gatewayState, setActiveSessionId, setSelectedStoredSessionId } from '@/store/session'

import { RECONNECT_HOLD_MS } from './reconnect-hold'
import { clearSingleFlightSessionResumeState } from './single-flight-resume'
import { clearSubmitInFlight } from './utils'

import { usePromptActions } from '.'

const NOT_CONNECTED = 'Hermes gateway is not connected'
const CLOSED = 'Hermes gateway connection closed'

type Request = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type Submit = (text: string) => Promise<unknown>

function Harness({
  active = 'rt-1',
  onReady,
  requestGateway,
  routed
}: {
  active?: null | string
  onReady: (submit: Submit) => void
  requestGateway: Request
  routed?: string
}) {
  const activeSessionIdRef = useRef<null | string>(active)
  const selectedStoredSessionIdRef = useRef<null | string>('stored-1')
  const busyRef = useRef(false)
  const runtimeRef = useRef(new Map(active ? [['stored-1', active]] : []))

  const actions = usePromptActions({
    activeSessionId: active,
    activeSessionIdRef,
    busyRef,
    createBackendSessionForSend: async () => null,
    getRoutedStoredSessionId: () => routed ?? null,
    getRuntimeIdForStoredSession: (id: string) => runtimeRef.current.get(id) ?? null,
    getRouteToken: () => (routed ? `/${routed}` : '/'),
    handleSkinCommand: () => '',
    openMemoryGraph: () => undefined,
    refreshSessions: async () => undefined,
    requestGateway: requestGateway as never,
    resumeStoredSession: () => undefined,
    runtimeIdByStoredSessionIdRef: runtimeRef,
    selectedStoredSessionIdRef,
    syncAttachmentsForSubmit: async (sessionId: string, attachments: unknown[]) => ({ attachments, sessionId }),
    updateSessionState: () => undefined
  } as never)

  useEffect(() => {
    onReady(actions.submitText as Submit)
  }, [actions.submitText, onReady])

  return null
}

async function mount(requestGateway: Request, extra: { active?: null | string; routed?: string } = {}) {
  let submit: null | Submit = null
  await act(async () => {
    render(<Harness {...extra} onReady={s => (submit = s)} requestGateway={requestGateway} />)
  })

  return submit as unknown as Submit
}

const submits = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter(c => c[0] === 'prompt.submit')

const shown = () =>
  $notifications
    .get()
    .map(n => n.message ?? '')
    .join(' | ')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  $gatewayState.set('idle')
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  clearSingleFlightSessionResumeState()
  clearSubmitInFlight()
  clearNotifications()
  $notifications.set([])
})

describe('a slash command entered while the backend restarts', () => {
  const titles = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter(c => c[0] === 'session.title')

  it('runs once the gateway is back, not against the restart', async () => {
    const request = vi.fn(async () => ({ title: 'renamed' }))
    const submit = await mount(request)
    $gatewayState.set('closed')
    const sent = submit('/title renamed')
    await act(async () => void (await Promise.resolve()))
    expect(titles(request)).toHaveLength(0)
    expect(shown()).toMatch(/reconnect/i)

    await act(async () => $gatewayState.set('open'))
    await expect(sent).resolves.toBe(true)
    expect(titles(request)).toHaveLength(1)
  })

  it('goes back to the composer with the reason when the backend never returns', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => ({}))
    const submit = await mount(request)
    $gatewayState.set('closed')
    const sent = submit('/title renamed')
    await act(async () => vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS + 1))
    await expect(sent).resolves.toBe(false)
    expect(titles(request)).toHaveLength(0)
    expect(shown()).toMatch(/did not come back/i)
  })
})

describe('a message sent while the backend restarts', () => {
  it('waits for the gateway and is delivered once, not before', async () => {
    const request = vi.fn(async (method: string) => {
      if ($gatewayState.get() !== 'open') {
        throw new Error(NOT_CONNECTED)
      }

      return method === 'session.resume' ? { session_id: 'rt-2' } : {}
    })

    const submit = await mount(request)
    $gatewayState.set('closed')
    const sent = submit('hello after restart')
    await act(async () => void (await Promise.resolve()))
    expect(submits(request)).toHaveLength(0)
    expect(shown()).toMatch(/reconnect/i)

    await act(async () => $gatewayState.set('open'))
    await expect(sent).resolves.toBe(true)
    expect(submits(request)).toHaveLength(1)
  })

  it('a send that loses the socket before it left is sent again once the gateway is back, exactly once', async () => {
    let wire = 0

    const request = vi.fn(async (method: string) => {
      if (method === 'prompt.submit' && ++wire === 1) {
        $gatewayState.set('closed')
        throw new Error(NOT_CONNECTED)
      }

      return {}
    })

    $gatewayState.set('open')
    const submit = await mount(request)
    const sent = submit('raced the close')
    await act(async () => void (await new Promise(r => setTimeout(r, 0))))
    await act(async () => $gatewayState.set('open'))
    await expect(sent).resolves.toBe(true)
    expect(submits(request)).toHaveLength(2)
    expect(wire).toBe(2)
  })

  it('a send cut off in flight is never retried: kept, with a reason that a transcript reload does not clear', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'prompt.submit') {
        throw new Error(CLOSED)
      }

      return {}
    })

    $gatewayState.set('open')
    const submit = await mount(request)
    await expect(submit('maybe delivered')).resolves.toBe(false)
    expect(submits(request)).toHaveLength(1)
    clearNotifications() // what resumeSession does on the reconnect
    expect(shown()).toMatch(/may have reached/i)
  })

  it('a resume refused while rebinding the runtime keeps the text with a visible reason', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.resume') {
        throw new Error(NOT_CONNECTED)
      }

      return {}
    })

    $gatewayState.set('open')
    const submit = await mount(request, { active: null, routed: 'stored-1' })
    await expect(submit('no runtime yet')).resolves.toBe(false)
    expect(submits(request)).toHaveLength(0)
    expect(shown()).toMatch(/not sent/i)
  })

  it('a gateway that never comes back keeps the text with a visible reason', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => ({}))
    const submit = await mount(request)
    $gatewayState.set('error')
    const sent = submit('never up')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    await expect(sent).resolves.toBe(false)
    expect(submits(request)).toHaveLength(0)
    expect(shown()).toMatch(/not sent/i)
  })
})
