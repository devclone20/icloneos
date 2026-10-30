import { describe, expect, it, vi } from 'vitest'

import { SIGN_IN_CAP_MS, startAcpSignIn } from './inft-acp-signin'

const INFT = 'base:0x4dfb000000000000000000000000000000000000:6'
const URL = 'https://app.virtuals.io/auth/abc'
const START = JSON.stringify({ url: URL, requestId: 'req-1' })

const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A clock and a sleep the test drives by hand: `tick()` ends the pending 4 s wait. */
function harness(stdouts: string[], clock = { t: 0 }) {
  const pending: Array<() => void> = []
  const run = vi.fn(async () => ok(stdouts.shift() ?? '{"status":"pending"}'))
  const open = vi.fn()
  const refresh = vi.fn(async () => null)
  const sleep = vi.fn(() => new Promise<void>(resolve => pending.push(resolve)))

  const tick = async () => {
    pending.shift()?.()
    await flush()
  }

  const handle = startAcpSignIn(INFT, { run, open, refresh, now: () => clock.t, sleep })

  return { handle, run, open, refresh, sleep, tick, clock }
}

describe('startAcpSignIn', () => {
  it('opens the link once, polls after each answer and settles done when authenticated', async () => {
    const h = harness([START, '{"status":"pending"}', '{"status":"authenticated"}'])
    const seen: string[] = []

    h.handle.subscribe(state => seen.push(state.phase))
    expect(h.handle.state.phase).toBe('starting')
    await flush()
    expect(h.handle.state).toEqual({ phase: 'waiting', url: URL })
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(h.open).toHaveBeenCalledWith(URL)
    expect(h.run).toHaveBeenCalledWith(INFT, ['configure', 'start', '--json'])

    await h.tick()
    expect(h.handle.state.phase).toBe('waiting')
    expect(h.run).toHaveBeenLastCalledWith(INFT, ['configure', 'complete', '--request-id', 'req-1', '--json'])

    await h.tick()
    await expect(h.handle.finished).resolves.toEqual({ phase: 'done', url: URL })
    expect(h.run).toHaveBeenCalledTimes(3)
    expect(h.refresh).toHaveBeenCalledWith(INFT)
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['waiting', 'done'])
  })

  it('fails with a clear reason when the CLI output carries no url or request id', async () => {
    const h = harness(['{"requestId":"req-1"}'])

    await expect(h.handle.finished).resolves.toEqual({
      phase: 'error',
      error: 'could not read the sign-in URL from the CLI output — try again'
    })
    expect(h.open).not.toHaveBeenCalled()
    expect(h.sleep).not.toHaveBeenCalled()
  })

  it('surfaces a failed configure start', async () => {
    const run = vi.fn(async () => ({ ok: false, code: 1, stdout: '', stderr: 'keychain locked' }))
    const handle = startAcpSignIn(INFT, { run, open: vi.fn(), refresh: vi.fn(async () => null) })

    await expect(handle.finished).resolves.toEqual({
      phase: 'error',
      error: 'acp configure start failed — keychain locked'
    })
  })

  it('cancel stops the polling at once', async () => {
    const h = harness([START])

    await flush()
    expect(h.handle.state.phase).toBe('waiting')
    await h.tick()
    expect(h.run).toHaveBeenCalledTimes(2)

    h.handle.cancel()
    await expect(h.handle.finished).resolves.toEqual({ phase: 'cancelled' })
    await h.tick()
    await h.tick()
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('gives up after five minutes without an answer', async () => {
    const clock = { t: 1_000 }
    const h = harness([START], clock)

    await flush()
    clock.t += SIGN_IN_CAP_MS - 1
    await h.tick()
    expect(h.handle.state.phase).toBe('waiting')
    clock.t += 1
    await h.tick()
    await expect(h.handle.finished).resolves.toEqual({
      phase: 'error',
      url: URL,
      error: 'sign-in timed out after 5 minutes — start again'
    })
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('opens the same link again on demand, and ignores a cancel once settled', async () => {
    const h = harness([START, '{"status":"authenticated"}'])

    h.handle.openLink()
    expect(h.open).not.toHaveBeenCalled()
    await flush()
    h.handle.openLink()
    expect(h.open).toHaveBeenCalledTimes(2)
    expect(h.open).toHaveBeenLastCalledWith(URL)
    await h.tick()
    await expect(h.handle.finished).resolves.toMatchObject({ phase: 'done' })
    h.handle.cancel()
    expect(h.handle.state.phase).toBe('done')
  })
})
