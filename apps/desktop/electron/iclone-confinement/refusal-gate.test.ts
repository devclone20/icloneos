import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRefusalGate, type RefusalGateDeps } from './refusal-gate'

const TOKEN = `project+${'a'.repeat(12)}+sess-1+${'b'.repeat(32)}`

function harness(over: Partial<RefusalGateDeps> = {}) {
  let onName: ((name: string | null) => void) | null = null
  const files = new Set<string>(over.tokenNames?.('') ?? [])
  let enabled = true
  let live = true
  let closed = 0
  const starts: number[] = []
  let stops = 0

  const gate = createRefusalGate({
    membersDir: '/members',
    enabled: () => enabled,
    live: async () => live,
    start: backfill => {
      starts.push(backfill)

      return { stop: () => (stops += 1) }
    },
    checkEveryMs: 1_000,
    watch: (_dir, cb) => {
      onName = cb

      return { close: () => (closed += 1) }
    },
    tokenExists: (_dir, name) => files.has(name),
    tokenNames: () => [...files],
    ...over
  })

  return {
    gate,
    create(name: string) {
      files.add(name)
      onName?.(name)
    },
    remove(name: string) {
      files.delete(name)
      onName?.(name)
    },
    setEnabled: (value: boolean) => (enabled = value),
    setLive: (value: boolean) => (live = value),
    starts,
    stops: () => stops,
    closed: () => closed
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createRefusalGate (K97)', () => {
  it('at idle — no confined run — no stream is started at all', () => {
    const h = harness()

    expect(h.starts).toEqual([])
    expect(h.gate.running()).toBe(false)
    h.gate.stop()
  })

  it('a run token created starts the stream once, with the look-back', () => {
    const h = harness()

    h.create(TOKEN)
    h.create(TOKEN.replace('sess-1', 'sess-2'))

    expect(h.starts).toEqual([5])
    expect(h.gate.running()).toBe(true)
    h.gate.stop()
    expect(h.stops()).toBe(1)
    expect(h.closed()).toBe(1)
  })

  it('a removed token, a foreign name or the mark files never start it', () => {
    const h = harness()

    h.remove(TOKEN)
    h.create('.member')
    h.create('.decoy')
    h.create('notes.txt')

    expect(h.starts).toEqual([])
    h.gate.stop()
  })

  it('confinement off: a new token does not start the stream', () => {
    const h = harness()

    h.setEnabled(false)
    h.create(TOKEN)

    expect(h.starts).toEqual([])
    h.gate.stop()
  })

  it('stops when the last confined process is gone, and starts again on the next run', async () => {
    vi.useFakeTimers()

    const h = harness()

    h.create(TOKEN)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.gate.running()).toBe(true)

    h.setLive(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.gate.running()).toBe(false)
    expect(h.stops()).toBe(1)

    h.setLive(true)
    h.create(TOKEN.replace('sess-1', 'sess-3'))
    expect(h.starts).toEqual([5, 5])
    h.gate.stop()
  })

  it('stops at the next check when confinement is turned off', async () => {
    vi.useFakeTimers()

    const h = harness()

    h.create(TOKEN)
    h.setEnabled(false)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(h.gate.running()).toBe(false)
    h.gate.stop()
  })

  it('a token already present at start-up (Hermes outlived a reload) starts one check', async () => {
    vi.useFakeTimers()

    let checks = 0

    const h = harness({
      tokenNames: () => [TOKEN],
      live: async () => {
        checks += 1

        return false
      }
    })

    expect(h.starts).toEqual([5])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(checks).toBe(1)
    expect(h.gate.running()).toBe(false)
    h.gate.stop()
  })

  it('no ps fold while stopped: live() is only asked while the stream runs', async () => {
    vi.useFakeTimers()

    let checks = 0

    const h = harness({
      live: async () => {
        checks += 1

        return true
      }
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(checks).toBe(0)
    h.create(TOKEN)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(checks).toBe(3)
    h.gate.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(checks).toBe(3)
  })
})

describe('createRefusalGate — the real members folder (fs.watch)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a token file written by a run starts the stream', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'k97-members-'))

    dirs.push(dir)
    writeFileSync(path.join(dir, '.member'), '')

    const starts: number[] = []

    const gate = createRefusalGate({
      membersDir: dir,
      enabled: () => true,
      live: async () => true,
      start: backfill => {
        starts.push(backfill)

        return { stop: () => undefined }
      }
    })

    expect(starts).toEqual([])
    // fs.watch is armed asynchronously: a token written in the same tick as createRefusalGate can be created before
    // FSEvents is listening, and that event is then never delivered. Production never meets this race — a token
    // already there at start-up is handled by the start-up check above — so the settle below removes a race the test
    // never meant to measure. The assertion under it is unchanged.
    await new Promise(resolve => setTimeout(resolve, 250))
    writeFileSync(path.join(dir, TOKEN), '')

    // The wait is patience for one fs.watch event, not a latency the product promises. Its ceiling is well under
    // the budget below: a ceiling equal to the budget turns every failure into a timeout, which says nothing about
    // what broke. Measured on this machine, loaded and idle, the event arrives in under 300 ms.
    for (let waited = 0; starts.length === 0 && waited < 5_000; waited += 25) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    gate.stop()
    expect(starts).toEqual([5])
  }, 20_000)
})
