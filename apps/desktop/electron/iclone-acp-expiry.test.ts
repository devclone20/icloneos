import { describe, expect, it } from 'vitest'

import { sessionExpired } from './iclone-acp'
import { ACP_SESSION_EXPIRED_RE, createExpiryGate } from './iclone-acp-expiry'

type Answer = 'expired' | 'ok' | 'other'

/** Fault injection: a scripted CLI on a fake clock; `sleep` advances the clock. */
function rig(script: Answer[], gapMs = 1_500) {
  let clock = 10_000
  const calls: number[] = []
  const slept: number[] = []

  const gate = createExpiryGate({
    gapMs,
    now: () => clock,
    sleep: async ms => {
      slept.push(ms)
      clock += ms
    }
  })

  const cli = async (): Promise<Answer> => {
    calls.push(clock)

    return script.shift() ?? 'ok'
  }

  const read = (slug = 'a') => gate.confirm(slug, cli, cli, answer => answer === 'expired')

  return {
    gate,
    calls,
    slept,
    read,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('createExpiryGate — F4: no false "sign-in required"', () => {
  it('a single expiry answer shows nothing: the retry (alone, at once) answers', async () => {
    const r = rig(['expired', 'ok'])

    await expect(r.read()).resolves.toBe('ok')
    expect(r.calls).toEqual([10_000, 10_000])
    expect(r.slept).toEqual([])
    expect(r.gate.suspectSince('a')).toBeUndefined()
  })

  it('expiry answers spanning ≥ 1.5 s with nothing in between are the verdict (a fast retry waits out the gap)', async () => {
    const r = rig(['expired', 'expired', 'expired'])

    await expect(r.read()).resolves.toBe('expired')
    expect(r.calls).toEqual([10_000, 10_000, 11_500])
    expect(r.slept).toEqual([1_500])
    expect(r.gate.suspectSince('a')).toBe(10_000)
  })

  it('a retry that itself takes ≥ 1.5 s confirms with no wait (the real CLI answers in ~5 s)', async () => {
    let clock = 0
    const slept: number[] = []
    const gate = createExpiryGate({ now: () => clock, sleep: async ms => void slept.push(ms) })

    const slow = async () => {
      clock += 5_000

      return 'expired'
    }

    await expect(
      gate.confirm(
        'a',
        async () => 'expired',
        slow,
        answer => answer === 'expired'
      )
    ).resolves.toBe('expired')
    expect(slept).toEqual([])
  })

  it('once confirmed, the next expiry answer is returned at once (no second wait)', async () => {
    const r = rig(['expired', 'expired', 'expired', 'expired'])

    await r.read()
    await expect(r.read()).resolves.toBe('expired')
    expect(r.slept).toEqual([1_500])
    expect(r.calls).toHaveLength(4)
  })

  it('a read that sights the expiry 400 ms after another waits only the rest of the gap', async () => {
    let clock = 0
    const waits: number[] = []

    const gate = createExpiryGate({
      now: () => clock,
      sleep: async ms => {
        waits.push(ms)
      }
    })

    const expired = async () => 'expired'

    const one = gate.confirm('a', expired, expired, answer => answer === 'expired')

    await new Promise(resolve => setTimeout(resolve, 0))
    clock = 400
    const two = gate.confirm('a', expired, expired, answer => answer === 'expired')

    await Promise.all([one, two])
    expect(waits).toEqual([1_500, 1_100])
    expect(gate.suspectSince('a')).toBe(0)
  })

  it('any other answer in between clears the suspicion', async () => {
    const r = rig(['expired', 'other', 'expired', 'ok'])

    await expect(r.read()).resolves.toBe('other')
    expect(r.gate.suspectSince('a')).toBeUndefined()
    await expect(r.read()).resolves.toBe('ok')
    expect(r.calls).toHaveLength(4)
    expect(r.slept).toEqual([])
  })

  it('a success clears a confirmed verdict, so the next blip is retried again', async () => {
    const r = rig(['expired', 'expired', 'expired', 'ok', 'expired', 'ok'])

    await r.read()
    await r.read()
    expect(r.gate.suspectSince('a')).toBeUndefined()
    await expect(r.read()).resolves.toBe('ok')
    expect(r.slept).toEqual([1_500])
  })

  it('each iNFT is judged on its own answers', async () => {
    const r = rig(['expired', 'expired', 'expired', 'ok'])

    await r.read('a')
    await expect(r.read('b')).resolves.toBe('ok')
    expect(r.gate.suspectSince('a')).toBe(10_000)
    expect(r.gate.suspectSince('b')).toBeUndefined()
  })

  it('an answer with no expiry signature passes untouched, with no retry', async () => {
    const r = rig(['other'])

    await expect(r.read()).resolves.toBe('other')
    expect(r.calls).toHaveLength(1)
    expect(r.slept).toEqual([])
  })

  it('reads the CLI expiry words and nothing else', () => {
    expect(ACP_SESSION_EXPIRED_RE.test('{"error":"Session expired.","code":"NOT_AUTHENTICATED"}')).toBe(true)
    expect(ACP_SESSION_EXPIRED_RE.test('Not authenticated. Run `acp configure` to authenticate.')).toBe(true)
    expect(ACP_SESSION_EXPIRED_RE.test('HTTP 503: upstream unavailable')).toBe(false)
    expect(ACP_SESSION_EXPIRED_RE.test('timed out after 60s')).toBe(false)
  })

  it('a successful read that mentions the words is never retried and never suspected', async () => {
    const thread = JSON.stringify({
      messages: [{ subject: 'Your session expired', body: 'Login required to continue.' }]
    })

    const ok = { ok: true, code: 0, stdout: thread, stderr: '' }
    const r = rig([])
    let retries = 0

    const result = await r.gate.confirm(
      'a',
      async () => ok,
      async () => {
        retries += 1

        return ok
      },
      sessionExpired
    )

    expect(result).toBe(ok)
    expect(retries).toBe(0)
    expect(r.slept).toEqual([])
    expect(r.gate.suspectSince('a')).toBeUndefined()
    expect(sessionExpired({ ...ok, ok: false, code: 1 })).toBe(true)
  })

  it('fail, another read succeeds, the retry fails = not consecutive: unconfirmed, never a verdict', async () => {
    let clock = 0
    const parked: { at: number; wake: () => void }[] = []

    const gate = createExpiryGate({
      now: () => clock,
      sleep: ms => new Promise<void>(wake => parked.push({ at: clock + ms, wake }))
    })

    const isExpired = (answer: string) => answer === 'expired'
    const soften = (answer: string) => `unconfirmed:${answer}`

    const a = gate.confirm(
      'a',
      async () => 'expired',
      async () => 'expired',
      isExpired,
      soften
    )

    await new Promise(resolve => setTimeout(resolve, 0))
    clock = 500
    await expect(
      gate.confirm(
        'a',
        async () => 'ok',
        async () => 'ok',
        isExpired,
        soften
      )
    ).resolves.toBe('ok')
    clock = 1_500
    parked.splice(0).forEach(p => p.wake())
    await expect(a).resolves.toBe('unconfirmed:expired')
    // The retry's failure opened a new run: the next lone failure is retried again, not a verdict.
    expect(gate.suspectSince('a')).toBe(1_500)
    await expect(
      gate.confirm(
        'a',
        async () => 'expired',
        async () => 'ok',
        isExpired
      )
    ).resolves.toBe('ok')
  })

  it('without `unconfirmed`, an unconfirmed expiry answer comes back as undefined', async () => {
    let clock = 0
    const gate = createExpiryGate({ now: () => clock, sleep: async ms => void (clock += ms) })
    const isExpired = (answer: string) => answer === 'expired'

    const a = gate.confirm(
      'a',
      async () => 'expired',
      async () => {
        await gate.confirm(
          'a',
          async () => 'ok',
          async () => 'ok',
          isExpired
        )

        return 'expired'
      },
      isExpired
    )

    await expect(a).resolves.toBeUndefined()
  })

  it('a run nobody sighted for a minute is over: one failure 10 min after a verdict is retried', async () => {
    const r = rig(['expired', 'expired', 'expired', 'expired', 'ok'])

    await expect(r.read()).resolves.toBe('expired')
    r.advance(600_000)
    await expect(r.read()).resolves.toBe('ok')
    expect(r.calls).toHaveLength(5)
    expect(r.slept).toEqual([1_500])
    expect(r.gate.suspectSince('a')).toBeUndefined()
  })

  it('an expiry answer inside the live run (< 1 min after the last sighting) whose retry fails too stays the verdict, with no second wait', async () => {
    const r = rig(['expired', 'expired', 'expired', 'expired', 'expired'])

    await r.read()
    r.advance(59_000)
    await expect(r.read()).resolves.toBe('expired')
    expect(r.calls).toHaveLength(5)
    expect(r.slept).toEqual([1_500])
  })

  it('verdict, then a successful write (the sign-in), then one failed read 20 s later: retried, never a verdict', async () => {
    const r = rig(['expired', 'expired', 'expired', 'expired', 'ok'])

    await expect(r.read()).resolves.toBe('expired')
    r.gate.settled('a')
    expect(r.gate.suspectSince('a')).toBeUndefined()
    r.advance(20_000)
    await expect(r.read()).resolves.toBe('ok')
    expect(r.calls).toHaveLength(5)
  })

  it('after a sign-in a failed read starts a new run: its failed retry waits out the gap again', async () => {
    const r = rig(['expired', 'expired', 'expired', 'expired', 'expired', 'ok'])

    await r.read()
    r.gate.settled('a')
    r.advance(20_000)
    await expect(r.read()).resolves.toBe('ok')
    expect(r.slept).toEqual([1_500, 1_500])
    expect(r.calls).toHaveLength(6)
  })

  it('a lone failed read 20 s or 55 s after a verdict the gate heard nothing about is still retried first', async () => {
    for (const quiet of [20_000, 55_000]) {
      const r = rig(['expired', 'expired', 'expired', 'expired', 'ok'])

      await r.read()
      r.advance(quiet)
      await expect(r.read()).resolves.toBe('ok')
      expect(r.calls).toHaveLength(5)
    }
  })

  it('settled() bumps the generation, so a retry that fails after a sign-in is unconfirmed', async () => {
    let clock = 0
    const gate = createExpiryGate({ now: () => clock, sleep: async ms => void (clock += ms) })
    let retried = 0

    const answer = await gate.confirm(
      'a',
      async () => 'expired',
      async () => {
        retried += 1
        gate.settled('a')

        return 'expired'
      },
      value => value === 'expired',
      value => `unconfirmed ${value}`
    )

    expect(answer).toBe('unconfirmed expired')
    expect(retried).toBe(1)
  })
})
