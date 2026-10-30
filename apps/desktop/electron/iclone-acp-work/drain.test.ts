import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SupervisorState } from '../../src/iclone-shared/acp-work'

import { createDrain } from './drain'
import { fakeAcp, type FakeJob, offerJob } from './fake-cli'
import { createLedger, decisionsOf, type Ledger } from './ledger'
import { DEFAULT_POLICY } from './policy'
import { OWED_STATUSES } from './state'
import { createWatchdog } from './watchdog'

const SLUG = 'robinhood-1'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3i-drain-'))
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A seeded PRNG so a failing trial replays. */
function prng(seed: number) {
  let state = seed

  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648

    return state / 2_147_483_648
  }
}

function setup(jobs: FakeJob[], timeoutMs = 60_000) {
  const acp = fakeAcp(jobs)
  const ledger: Ledger = createLedger({ file: path.join(dir, SLUG, 'ledger.jsonl') })
  let clock = 0
  const timers: Array<() => void> = []
  const stops: Array<{ final: string; owedAtStop: number }> = []
  const supervisorState = { state: 'online' as SupervisorState, blocking: [] as string[] }

  const watchdog = createWatchdog({
    read: acp.read,
    actor: acp.actor,
    ledger: () => ledger,
    policy: () => ({ ...DEFAULT_POLICY, maxOpenJobs: 50 }),
    spendTradeOn: () => true,
    audit: () => undefined,
    onChange: () => undefined
  })

  const owed = () => acp.state.jobs.filter(job => OWED_STATUSES.has(job.status) || job.status === 'budget_set').length

  const drain = createDrain({
    supervisor: {
      draining: (_slug, blocking) => {
        supervisorState.state = 'draining'
        supervisorState.blocking = blocking
      },
      state: () => supervisorState.state,
      stopListener: (_slug, final) => {
        stops.push({ final, owedAtStop: owed() })
        supervisorState.state = final
      }
    },
    watchdog,
    ledger: () => ledger,
    onChange: () => undefined,
    timeoutMs,
    now: () => clock,
    setTimer: fn => timers.push(fn),
    clearTimer: () => undefined
  })

  /** Run the next drain re-check, as the timer would. */
  const tick = async (ms = 15_000) => {
    clock += ms

    const next = timers.shift()

    next?.()

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve()
    }
  }

  return { acp, ledger, watchdog, drain, stops, supervisorState, tick, owed, timers }
}

describe('safe offline — the drain', () => {
  it('with nothing owed: offers are refused, the listener stops, offline-safe', async () => {
    const h = setup([offerJob('1'), offerJob('2', { status: 'submitted' })])

    const { outcome, report } = await h.drain.start(SLUG)

    expect(outcome).toEqual({ state: 'offline-safe' })
    expect(h.stops).toEqual([{ final: 'offline-safe', owedAtStop: 0 }])
    expect(decisionsOf(h.ledger.read().records).get('1')).toBe('drain-refuse')
    expect(report.open.map(job => job.jobId)).toEqual(['1', '2'])
  })

  it('a funded job blocks the stop until it is delivered; the tab can name it', async () => {
    const h = setup([offerJob('1', { status: 'funded' })])

    expect((await h.drain.start(SLUG)).outcome).toEqual({ state: 'draining', blocking: ['1'] })
    expect(h.supervisorState.blocking).toEqual(['1'])
    await h.tick()
    expect(h.stops).toEqual([])
    h.acp.setStatus('1', 'submitted')
    await h.tick()
    expect(h.stops).toEqual([{ final: 'offline-safe', owedAtStop: 0 }])
  })

  it('a drain past its timeout stays draining, says it is overdue, and never stops the listener', async () => {
    const h = setup([offerJob('1', { status: 'funded' })], 30_000)

    await h.drain.start(SLUG)
    await h.tick(20_000)
    await h.tick(20_000)
    expect(h.drain.overdue(SLUG)).toBe(true)
    expect(h.supervisorState.state).toBe('draining')
    expect(h.stops).toEqual([])
  })

  it('without a trustworthy job list it keeps draining (fail closed)', async () => {
    const h = setup([])

    h.acp.state.failReads = true

    expect((await h.drain.start(SLUG)).outcome).toEqual({ state: 'draining', blocking: [] })
    expect(h.stops).toEqual([])
    h.acp.state.failReads = false
    await h.tick()
    expect(h.stops).toEqual([{ final: 'offline-safe', owedAtStop: 0 }])
  })

  it('the inbox is paused while draining and back after a cancel', async () => {
    const h = setup([offerJob('1', { status: 'funded' }), offerJob('2')])

    await h.drain.start(SLUG)
    expect(h.watchdog.paused(SLUG)).toBe(true)
    expect(await h.watchdog.approve(SLUG, '2', true)).toMatchObject({ ok: false })
    h.drain.cancel(SLUG)
    expect(h.watchdog.paused(SLUG)).toBe(false)
  })

  // I2: 10 concurrent jobs, a drain issued at a random point, 5 trials. 0 lost, 0 half done, the listener stopped
  // only after the last owed job settled.
  it.each([1, 2, 3, 4, 5])('drain under load, trial %i', async trial => {
    const random = prng(trial * 7919)
    const statuses = ['open', 'budget_set', 'funded', 'transaction', 'submitted']

    const jobs = Array.from({ length: 10 }, (_, i) =>
      offerJob(String(i + 1), { status: statuses[Math.floor(random() * statuses.length)] })
    )

    const h = setup(jobs, 10 * 60_000)

    const next: Record<string, string> = {
      budget_set: 'funded',
      funded: 'transaction',
      transaction: 'submitted',
      submitted: 'completed'
    }

    /** One unit of work by the agent and the clients: a random job moves one step. */
    const work = () => {
      const moving = h.acp.state.jobs.filter(job => next[job.status])
      const job = moving[Math.floor(random() * moving.length)]

      if (job) {
        h.acp.setStatus(job.jobId, next[job.status])
      }
    }

    const before = Math.floor(random() * 6)

    for (let i = 0; i < before; i += 1) {
      work()
    }

    await h.drain.start(SLUG)

    for (let step = 0; step < 200 && h.stops.length === 0; step += 1) {
      work()
      await h.tick()
    }

    const records = h.ledger.read().records
    const decisions = decisionsOf(records)

    expect(h.stops).toHaveLength(1)
    expect(h.stops[0]).toEqual({ final: 'offline-safe', owedAtStop: 0 })

    // Every job ended delivered (submitted or beyond) or explicitly refused; none is lost or half done.
    for (const job of h.acp.state.jobs) {
      const delivered = ['submitted', 'evaluation', 'completed'].includes(job.status)
      const refused = job.status === 'open' && decisions.get(job.jobId) === 'drain-refuse'

      expect({ jobId: job.jobId, ok: delivered || refused }).toEqual({ jobId: job.jobId, ok: true })
    }

    expect(h.acp.state.jobs).toHaveLength(10)
    expect(h.acp.valueMovingWrites()).toBe(0)
  })
})
