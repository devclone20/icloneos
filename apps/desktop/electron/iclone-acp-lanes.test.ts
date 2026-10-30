import { describe, expect, it } from 'vitest'

import { isAcpRead } from './iclone-acp-argv'
import { type AcpCallClass, createAcpLanes } from './iclone-acp-lanes'

interface Gate {
  name: string
  open: () => void
}

/** A lane harness: every task waits for its gate, and the log says what started when. */
function harness(maxReads?: number, cap?: number) {
  const lanes = createAcpLanes({ maxReads, cap })
  const started: string[] = []
  const gates: Gate[] = []

  const call = (name: string, cls: AcpCallClass, slug = 'a') =>
    lanes.run(
      slug,
      cls,
      () =>
        new Promise<string>(resolve => {
          started.push(name)
          gates.push({ name, open: () => resolve(name) })
        })
    )

  const finish = async (name: string) => {
    gates.find(gate => gate.name === name)?.open()
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  return { lanes, started, call, finish, tick: () => new Promise(resolve => setTimeout(resolve, 0)) }
}

describe('createAcpLanes', () => {
  it('runs two reads of one iNFT side by side, and the third when one ends', async () => {
    const h = harness()

    void h.call('r1', 'read')
    void h.call('r2', 'read')
    void h.call('r3', 'read')
    await h.tick()
    expect(h.started).toEqual(['r1', 'r2'])

    await h.finish('r1')
    expect(h.started).toEqual(['r1', 'r2', 'r3'])
  })

  it('runs background probes in their own slot: one at a time, never in a read slot', async () => {
    const h = harness()

    void h.call('b1', 'background')
    void h.call('b2', 'background')
    void h.call('b3', 'background')
    await h.tick()
    expect(h.started).toEqual(['b1'])

    void h.call('owner', 'read')
    void h.call('later', 'read')
    void h.call('third', 'read')
    await h.tick()
    expect(h.started).toEqual(['b1', 'owner', 'later'])

    await h.finish('b1')
    expect(h.started).toEqual(['b1', 'owner', 'later', 'b2'])

    await h.finish('owner')
    expect(h.started).toEqual(['b1', 'owner', 'later', 'b2', 'third'])
  })

  it("F3: beside a running probe and a speculative read, the owner's open starts at once", async () => {
    const h = harness()

    void h.call('probe', 'background')
    void h.call('speculative', 'read')
    void h.call('open', 'read')
    await h.tick()
    expect(h.started).toEqual(['probe', 'speculative', 'open'])
  })

  it('runs an exclusive call alone: after the reads ahead of it, before the reads behind it', async () => {
    const h = harness()

    void h.call('r1', 'read')
    void h.call('w', 'exclusive')
    void h.call('r2', 'read')
    await h.tick()
    expect(h.started).toEqual(['r1'])

    await h.finish('r1')
    expect(h.started).toEqual(['r1', 'w'])

    await h.finish('w')
    expect(h.started).toEqual(['r1', 'w', 'r2'])
  })

  it('never runs two exclusive calls together, and keeps their order', async () => {
    const h = harness()

    void h.call('w1', 'exclusive')
    void h.call('w2', 'exclusive')
    await h.tick()
    expect(h.started).toEqual(['w1'])

    await h.finish('w1')
    expect(h.started).toEqual(['w1', 'w2'])
  })

  it('lanes of different iNFTs never wait on each other', async () => {
    const h = harness()

    void h.call('a-write', 'exclusive', 'a')
    void h.call('b-read', 'read', 'b')
    await h.tick()
    expect(h.started).toEqual(['a-write', 'b-read'])
  })

  it('with one read slot a probe and a read still run side by side, and an exclusive call waits for both', async () => {
    const h = harness(1)

    void h.call('b1', 'background')
    void h.call('r1', 'read')
    void h.call('w', 'exclusive')
    void h.call('r2', 'read')
    await h.tick()
    expect(h.started).toEqual(['b1', 'r1'])

    await h.finish('r1')
    expect(h.started).toEqual(['b1', 'r1'])

    await h.finish('b1')
    expect(h.started).toEqual(['b1', 'r1', 'w'])

    await h.finish('w')
    expect(h.started).toEqual(['b1', 'r1', 'w', 'r2'])
  })

  it('refuses past the cap, counts running + queued, and forgets an idle iNFT', async () => {
    const h = harness(2, 3)

    void h.call('w1', 'exclusive')
    void h.call('r1', 'read')
    void h.call('r2', 'read')
    await expect(h.call('r3', 'read')).rejects.toThrow('too many CLI calls queued for this iNFT')
    expect(h.lanes.size('a')).toBe(3)

    await h.finish('w1')
    await h.finish('r1')
    await h.finish('r2')
    expect(h.lanes.size('a')).toBe(0)
  })

  it('a failing task frees its slot and rejects only its own caller', async () => {
    const lanes = createAcpLanes()
    const failed = lanes.run('a', 'exclusive', () => Promise.reject(new Error('boom')))
    const next = lanes.run('a', 'read', () => Promise.resolve('ok'))

    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    expect(lanes.size('a')).toBe(0)
  })
})

describe('isAcpRead', () => {
  it('names the read-only commands, longest key first', () => {
    expect(isAcpRead(['email', 'thread', '--thread-id', 'x', '--json'])).toBe(true)
    expect(isAcpRead(['card', 'profile', '--json'])).toBe(true)
    expect(isAcpRead(['wallet', 'sol', 'balance'])).toBe(true)
  })

  it('treats writes, config-writing reads and unknown commands as exclusive', () => {
    expect(isAcpRead(['card', 'profile', 'reset'])).toBe(false)
    expect(isAcpRead(['card', 'limit', 'set', '--amount', '100'])).toBe(false)
    expect(isAcpRead(['agent', 'list'])).toBe(false)
    expect(isAcpRead(['email', 'reply'])).toBe(false)
    expect(isAcpRead(['toString'])).toBe(false)
    expect(isAcpRead([])).toBe(false)
  })
})
