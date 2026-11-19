/**
 * v0.0.9 F2 (P0_HERMES_FAILURES cause D, gate G4): the iNFT on the home connects by itself — at app reopen it waits
 * for the agent instead of racing it, a passing failure is retried quietly, a socket replaced mid-request ("connection
 * closed") is waited out, and when the gateway comes back after a drop the persona is re-sent (or a failed switch
 * re-run). The owner never has to close and reopen the agent.
 *
 * Red on the old code: (1) the restore ran the 20 s resolve bound against a backend still starting and ended
 * `failed`; (2) a restore before the gateway client existed failed at once ("still starting"); (3) "Hermes gateway
 * connection closed" was not a reconnect, so the switch failed; (4) nothing happened when the gateway reopened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId, $sessions } from '@/store/session'

import type { INftCardData } from './collections'

const ensurePersona = vi.fn<(...args: unknown[]) => Promise<string>>()

vi.mock('./inft-profile', () => ({
  ensurePersona: (...args: unknown[]) => ensurePersona(...args),
  holdSweep: () => () => undefined,
  sourceFromCard: (id: string, name: string, bootstrap: unknown) => {
    const [, contract, tokenId] = id.split(':')

    return { contract, tokenId, name, bootstrap }
  }
}))

vi.mock('@/app/open-session', () => ({ openSession: vi.fn() }))
vi.mock('./stage-store', () => ({ clearInftChoice: vi.fn(), dismissInft: vi.fn(), summonInft: vi.fn() }))

const {
  $inftSwitch,
  AGENT_STOPPED_REASON,
  inftSwitchLabel,
  READY_BUDGET_SPENT_REASON,
  RESTORE_READY_BUDGET_MS,
  resetInftSwitchForTests,
  switchInft
} = await import('./inft-switch')

const { applyBackendRestartProgress, resetBackendRestartForTests } = await import('@/store/backend-restart')

function card(token: string): INftCardData {
  return {
    id: `46630:0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631:${token}`,
    name: `iNFT #${token}`,
    bootstrap: { soul: 'x' },
    modelUrl: `model-${token}.glb`
  } as unknown as INftCardData
}

type Req = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>

function fakeGateway(request: Req) {
  $gateway.set({ request } as never)
}

const phases: string[] = []
let offPhases: () => void = () => undefined

beforeEach(async () => {
  // Open first and let a reopen callback from the previous case run out, then forget everything.
  $gatewayState.set('open')
  await new Promise(resolve => setTimeout(resolve, 0))
  resetInftSwitchForTests()
  resetBackendRestartForTests()
  ensurePersona.mockReset()
  ensurePersona.mockResolvedValue('soul')
  $gateway.set(null as never)
  $gatewayState.set('open')
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  window.localStorage.clear()
  phases.length = 0
  offPhases = $inftSwitch.listen(state => phases.push(state.phase))
})

afterEach(() => {
  offPhases()
  vi.useRealTimers()
  vi.restoreAllMocks()
  $gateway.set(null as never)
  $sessions.set([])
})

describe('the restore at app reopen waits for the agent', () => {
  it('the agent is ready only at 25 s (past the 20 s resolve bound): the restore ends done, never failed', async () => {
    vi.useFakeTimers()
    const calls = vi.fn(() => Promise.resolve({}))

    $gatewayState.set('connecting')
    fakeGateway(calls)

    const pending = switchInft(card('6'), { origin: 'restore' })

    await vi.advanceTimersByTimeAsync(25_000)
    expect($inftSwitch.get()).toMatchObject({ phase: 'waiting', reason: 'starting' })
    expect(ensurePersona).not.toHaveBeenCalled()

    $gatewayState.set('open')

    const result = await pending

    expect(result.personaApplied).toBe(true)
    expect(calls).toHaveBeenCalledWith('config.set', { key: 'personality', value: 'inft-4dfb27-6' }, expect.anything())
    expect(phases).not.toContain('failed')
  })

  it('a restore before the gateway client exists waits for it (no "still starting" failure)', async () => {
    const calls = vi.fn(() => Promise.resolve({}))
    const pending = switchInft(card('6'), { origin: 'restore' })

    await Promise.resolve()
    expect($inftSwitch.get().phase).toBe('waiting')

    fakeGateway(calls)

    expect((await pending).personaApplied).toBe(true)
    expect(phases).not.toContain('failed')
  })

  it('a click with no gateway still answers at once (the click bound is unchanged)', async () => {
    const result = await switchInft(card('6'), { origin: 'pill' })

    expect(result.error).toMatch(/still starting/)
  })

  it('the wait is bounded by the restore budget, not the click budget', async () => {
    vi.useFakeTimers()
    $gatewayState.set('connecting')
    fakeGateway(() => Promise.resolve({}))

    void switchInft(card('6'), { origin: 'restore' })
    await vi.advanceTimersByTimeAsync(RESTORE_READY_BUDGET_MS - 1_000)

    expect($inftSwitch.get().phase).toBe('waiting')
    expect(phases).not.toContain('failed')
  })

  it('a passing failure during the restore is retried quietly: "connecting…", no failed state, no error log line', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const calls = vi.fn(() => Promise.resolve({}))

    fakeGateway(calls)
    ensurePersona.mockRejectedValueOnce(new Error('HTTP 503: Hermes is still starting'))

    const pending = switchInft(card('6'), { origin: 'restore' })

    await vi.advanceTimersByTimeAsync(0)
    expect($inftSwitch.get()).toMatchObject({ phase: 'waiting', reason: 'retrying' })

    await vi.advanceTimersByTimeAsync(2_000)

    expect((await pending).personaApplied).toBe(true)
    expect(phases).not.toContain('failed')
    expect(errors.mock.calls.some(([line]) => String(line).startsWith('[inft-switch]'))).toBe(false)
  })
})

describe('the restore never waits for an agent nothing will bring back (Q correctness 5)', () => {
  it('main stops restarting it mid-wait: the restore ends at once, failed, with no retry rounds', async () => {
    vi.useFakeTimers()
    $gatewayState.set('connecting')
    fakeGateway(() => Promise.resolve({}))

    const pending = switchInft(card('6'), { origin: 'restore' })

    await vi.advanceTimersByTimeAsync(10_000)
    expect($inftSwitch.get().phase).toBe('waiting')

    applyBackendRestartProgress({ restart: { phase: 'stopped', attempt: 5, maxAttempts: 5, stoppedBecause: 'limit' } })

    const result = await pending

    expect(result).toMatchObject({ personaApplied: false, error: AGENT_STOPPED_REASON })
    expect($inftSwitch.get()).toMatchObject({ phase: 'failed', reason: AGENT_STOPPED_REASON })
    expect(ensurePersona).not.toHaveBeenCalled()
  })

  it('already stopped when the restore starts: no five-minute wait at all', async () => {
    applyBackendRestartProgress({ restart: { phase: 'stopped', attempt: 0, maxAttempts: 5, stoppedBecause: 'deterministic' } })
    $gatewayState.set('connecting')

    const result = await switchInft(card('6'), { origin: 'restore' })

    expect(result.error).toBe(AGENT_STOPPED_REASON)
  })

  it('the ready budget spent once is said once: not three more five-minute waits', async () => {
    vi.useFakeTimers()
    $gatewayState.set('connecting')
    fakeGateway(() => Promise.resolve({}))

    let settled = false

    const pending = switchInft(card('6'), { origin: 'restore' }).then(result => {
      settled = true

      return result
    })

    await vi.advanceTimersByTimeAsync(RESTORE_READY_BUDGET_MS + 1)

    expect(settled).toBe(true)
    expect((await pending).error).toBe(READY_BUDGET_SPENT_REASON)
    expect($inftSwitch.get().phase).toBe('failed')
  })

  it('a waiting pill never says "starting" while main has stopped', () => {
    const waiting = { phase: 'waiting', slug: 's', name: 'iNFT #6', startedAt: 0, reason: 'starting' } as const

    applyBackendRestartProgress({ restart: { phase: 'stopped', attempt: 5, maxAttempts: 5, stoppedBecause: 'limit' } })
    expect(inftSwitchLabel(waiting)).toBe('iNFT #6: Hermes is not running')
  })
})

describe('a socket replaced mid-request', () => {
  it('"Hermes gateway connection closed" waits for the gateway and finishes when it is back', async () => {
    let first = true
    const values: unknown[] = []

    fakeGateway((_method, params) => {
      values.push(params.value)

      if (first) {
        first = false

        return Promise.reject(new Error('Hermes gateway connection closed'))
      }

      return Promise.resolve({})
    })

    const pending = switchInft(card('6'), { origin: 'pill' })

    await vi.waitFor(() => expect($inftSwitch.get().phase).toBe('waiting'))
    $gatewayState.set('connecting')
    $gatewayState.set('open')

    expect((await pending).personaApplied).toBe(true)
    expect(values).toEqual(['inft-4dfb27-6', 'inft-4dfb27-6'])
  })
})

describe('the gateway comes back after a drop', () => {
  it('an applied persona is re-sent to the agent that came back (a restarted backend)', async () => {
    vi.useFakeTimers()
    const calls = vi.fn(() => Promise.resolve({}))

    fakeGateway(calls)
    expect((await switchInft(card('6'), { origin: 'pill' })).personaApplied).toBe(true)
    expect(calls).toHaveBeenCalledTimes(1)
    // Later in the session (a persona applied a moment ago was applied on the connection that just opened).
    await vi.advanceTimersByTimeAsync(5_000)

    $gatewayState.set('connecting')
    $gatewayState.set('open')
    await vi.advanceTimersByTimeAsync(1)

    expect(calls).toHaveBeenCalledTimes(2)
    expect(calls).toHaveBeenLastCalledWith('config.set', { key: 'personality', value: 'inft-4dfb27-6' }, expect.anything())
  })

  it('a switch that failed is re-run by itself when the gateway is back (no close-and-reopen)', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let fail = true

    const calls = vi.fn(() => {
      if (fail) {
        fail = false

        return Promise.reject(new Error('HTTP 500 boom'))
      }

      return Promise.resolve({})
    })

    fakeGateway(calls)
    expect((await switchInft(card('6'), { origin: 'pill' })).personaApplied).toBe(false)
    expect($inftSwitch.get().phase).toBe('failed')

    $gatewayState.set('connecting')
    $gatewayState.set('open')
    await vi.advanceTimersByTimeAsync(1)

    await vi.waitFor(() => expect($inftSwitch.get().phase).toBe('done'))
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('nothing is sent when no persona was applied (plain Hermes)', async () => {
    vi.useFakeTimers()
    const calls = vi.fn(() => Promise.resolve({}))

    fakeGateway(calls)
    await switchInft(null, { origin: 'pill' })
    calls.mockClear()

    $gatewayState.set('connecting')
    $gatewayState.set('open')
    await vi.advanceTimersByTimeAsync(1)

    expect(calls).not.toHaveBeenCalled()
  })
})

describe('the calm status while the agent restarts', () => {
  it('a waiting switch names main’s restart attempt; else why it waits', () => {
    const waiting = { phase: 'waiting', slug: 's', name: 'iNFT #6', startedAt: 0, reason: 'starting' } as const

    expect(inftSwitchLabel(waiting)).toMatch(/waiting for the agent to start/)

    applyBackendRestartProgress({ restart: { phase: 'waiting', attempt: 2, maxAttempts: 5 } })
    expect(inftSwitchLabel(waiting)).toBe('iNFT #6: the agent is restarting (attempt 2 of 5) — connecting when it is back')

    applyBackendRestartProgress({ restart: { phase: 'idle', attempt: 0, maxAttempts: 5 } })
    expect(inftSwitchLabel({ ...waiting, reason: undefined })).toMatch(/reconnecting/)
  })
})
