/**
 * v0.0.7 item 4: the first command after prewarm. A start whose check is still behind the root's FIRST full scan (the
 * owner's project: 36.6 s) keeps waiting past the 30 s deadline while that scan reaches new folders (within 5 s), up
 * to 120 s; a stalled scan, a longer one, or no first scan at all is refused as before. Fake clock: the scan's
 * progress is a number the test moves, and only timers wait.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HardlinkFirstScanView } from '../../src/iclone-shared/confinement'

import {
  activeFirstScan,
  checkBeforeStart,
  createHardlinkGuard,
  HARDLINK_CHECK_DEADLINE_MS,
  HARDLINK_FIRST_SCAN_DEADLINE_MS,
  type HardlinkCheck,
  type HardlinkGuard,
  hardlinkUnansweredRefusal
} from './hardlinks'
import { walkInWorker } from './hardlinks-walker'

const OK: HardlinkCheck = { ok: true, cached: false, files: 1, dirs: 1, ms: 1, passed: 0 }
const dirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})

/** A check that answers when the test says, over a first scan whose last progress the test sets (null: none). */
function slowScan() {
  let answer: (result: HardlinkCheck) => void = () => undefined
  const state = { progress: null as number | null }

  return {
    state,
    answer: (result: HardlinkCheck) => answer(result),
    guard: {
      check: () => new Promise<HardlinkCheck>(resolve => (answer = resolve)),
      firstScanProgress: () => state.progress
    }
  }
}

type Outcome = Awaited<ReturnType<typeof checkBeforeStart>> | 'waiting'

/** Starts the wait on fake timers; `settled()` reads its outcome so far. */
function startWait(guard: Parameters<typeof checkBeforeStart>[0]) {
  let outcome: Outcome = 'waiting'

  void checkBeforeStart(guard, '/p', 'project', undefined, { now: () => Date.now() }).then(result => (outcome = result))

  return { settled: () => outcome }
}

/** Advances the fake clock in 1 s steps; the scan reaches a folder at every step while `progressing(t)` says so. */
async function advance(scan: ReturnType<typeof slowScan>, ms: number, progressing: (t: number) => boolean) {
  const start = Date.now()

  for (let t = 0; t < ms; t += 1_000) {
    if (progressing(Date.now() - start)) {
      scan.state.progress = Date.now()
    }

    await vi.advanceTimersByTimeAsync(1_000)
  }
}

describe('item 4: a start behind the FIRST full scan waits while it advances (up to 120 s), else refused at 30 s', () => {
  it('a first scan that keeps advancing past 30 s: the start waits and gets the answer at 40 s', async () => {
    vi.useFakeTimers({ now: 0 })

    const scan = slowScan()
    const wait = startWait(scan.guard)

    await advance(scan, 39_000, () => true)
    expect(wait.settled()).toBe('waiting')
    scan.answer(OK)
    await vi.advanceTimersByTimeAsync(0)
    expect(wait.settled()).toEqual(OK)
  })

  it('a first scan that stops advancing for 5 s is refused (stall), well before 120 s', async () => {
    vi.useFakeTimers({ now: 0 })

    const scan = slowScan()
    const wait = startWait(scan.guard)

    // Advances until 32 s, then reaches no new folder.
    await advance(scan, 45_000, t => t <= 32_000)

    const outcome = wait.settled()

    expect(outcome).toMatchObject({ ok: false, unanswered: 'timeout' })
    expect(outcome).toMatchObject({ detail: 'the first scan reached no new folder for 5 s' })
    expect(Date.now()).toBeLessThan(HARDLINK_FIRST_SCAN_DEADLINE_MS)

    if (typeof outcome === 'object' && 'unanswered' in outcome) {
      expect(hardlinkUnansweredRefusal('/p', outcome)).toBe(
        'confinement refused to start in /p: the hard-link check is still scanning the project (the first scan reached no new folder for 5 s); try again in a moment'
      )
    }
  })

  it('a first scan stalled at the deadline is refused at 30 s, as today', async () => {
    vi.useFakeTimers({ now: 0 })

    const scan = slowScan()
    const wait = startWait(scan.guard)

    await advance(scan, HARDLINK_CHECK_DEADLINE_MS - 1_000, t => t <= 20_000)
    expect(wait.settled()).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wait.settled()).toMatchObject({ ok: false, detail: 'the first scan reached no new folder for 5 s' })
  })

  it('a first scan still advancing at 120 s is refused at 120 s', async () => {
    vi.useFakeTimers({ now: 0 })

    const scan = slowScan()
    const wait = startWait(scan.guard)

    await advance(scan, HARDLINK_FIRST_SCAN_DEADLINE_MS - 1_000, () => true)
    expect(wait.settled()).toBe('waiting')
    await advance(scan, 2_000, () => true)
    expect(wait.settled()).toMatchObject({ ok: false, detail: 'the first scan did not finish within 120 s' })
  })

  it('no first scan running (a warm or a later scan): refused at 30 s exactly as before', async () => {
    vi.useFakeTimers({ now: 0 })

    const scan = slowScan()
    const wait = startWait(scan.guard)

    await vi.advanceTimersByTimeAsync(HARDLINK_CHECK_DEADLINE_MS - 1)
    expect(wait.settled()).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1)
    expect(wait.settled()).toMatchObject({ ok: false, unanswered: 'timeout', detail: 'no answer within 30 s' })
  })

  it('a guard without firstScanProgress keeps the plain deadline', async () => {
    vi.useFakeTimers({ now: 0 })

    const wait = startWait({ check: () => new Promise<HardlinkCheck>(() => undefined) })

    await vi.advanceTimersByTimeAsync(HARDLINK_CHECK_DEADLINE_MS)
    expect(wait.settled()).toMatchObject({ detail: 'no answer within 30 s' })
  })

  it('the real guard reports progress only during a root’s FIRST full scan, with its folder count (CF1 firstScan)', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fs1-')))
    const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fs1u-')))

    dirs.push(root, userData)

    for (let index = 0; index < 40; index += 1) {
      mkdirSync(path.join(root, `d${index}`, 'e'), { recursive: true })
      writeFileSync(path.join(root, `d${index}`, 'e', 'f'), 'x')
    }

    let ticks = 0
    let duringScan: number | null = null
    let viewAtStart: HardlinkFirstScanView | null = null
    const counts: number[] = []
    let guard: HardlinkGuard | null = null

    guard = createHardlinkGuard({
      ackFile: path.join(userData, 'acks.json'),
      fsEvents: null,
      clock: () => (ticks += 1),
      onFullScan: scanned => {
        duringScan = guard?.firstScanProgress(scanned) ?? null
        viewAtStart = activeFirstScan()
      },
      // The real worker, with its progress messages watched as they reach main.
      walkFull: (scanned, options) =>
        walkInWorker(scanned, {
          ...options,
          onProgress: dirs => {
            counts.push(dirs)
            options.onProgress?.(dirs)
            expect(guard?.firstScan()).toMatchObject({ root, dirs })
          }
        })
    })

    expect(guard.firstScanProgress(root)).toBeNull()
    expect(guard.firstScan()).toBeNull()
    await guard.prewarm(root)

    // Set when the scan began (0 folders), then moved by the worker's progress, which ends at all 81 folders.
    expect(duringScan).not.toBeNull()
    expect(viewAtStart).toMatchObject({ root, dirs: 0 })
    expect((viewAtStart as HardlinkFirstScanView | null)?.startedAt).toEqual(expect.any(Number))
    expect(counts.at(-1)).toBe(81)
    expect(ticks).toBeGreaterThanOrEqual(1 + counts.length)
    expect(guard.firstScanProgress(root)).toBeNull()
    expect(guard.firstScan()).toBeNull()
    expect(activeFirstScan()).toBeNull()

    const before = ticks

    expect(await guard.check(root, 'build')).toMatchObject({ ok: true, dirs: 81 })
    expect(ticks).toBe(before)
    guard.close()
  })
})

describe('CF8 D3/L4.1 + L4.4: a re-walk counts as a first scan; a scan ending between polls is answered', () => {
  it('L4.1: after the root is released (30 min idle, I7), the walk the next check waits for reports progress', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fs2-')))
    const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fs2u-')))
    const [root, other] = [path.join(base, 'a'), path.join(base, 'b')]
    let at = 1_800_000_000_000

    dirs.push(base, userData)

    for (const dir of [root, other]) {
      for (let index = 0; index < 30; index += 1) {
        mkdirSync(path.join(dir, `d${index}`), { recursive: true })
        writeFileSync(path.join(dir, `d${index}`, 'f'), 'x')
      }
    }

    const during: [string, number | null][] = []
    const released: string[] = []
    let guard: HardlinkGuard | null = null

    guard = createHardlinkGuard({
      ackFile: path.join(userData, 'acks.json'),
      fsEvents: null,
      now: () => new Date(at),
      idleReleaseMs: 60_000,
      onRootReleased: dir => released.push(dir),
      onFullScan: scanned => during.push([scanned, guard?.firstScanProgress(scanned) ?? null])
    })

    expect(await guard.check(root, 'build')).toMatchObject({ ok: true })
    at += 61_000
    expect(await guard.check(other, 'build')).toMatchObject({ ok: true })
    expect(released).toEqual([root])
    expect(await guard.check(root, 'build')).toMatchObject({ ok: true })
    expect(during.map(([dir]) => dir)).toEqual([root, other, root])
    expect(during[2][1]).not.toBeNull()
    expect(guard.firstScanProgress(root)).toBeNull()
    guard.close()
  })

  it('L4.4: the scan ends at 1.0 s, its check resolves at 1.25 s (deadline 300 ms): answered, not refused', async () => {
    vi.useFakeTimers()

    const scan = slowScan()
    let outcome: Outcome = 'waiting'
    const start = Date.now()

    void checkBeforeStart(scan.guard, '/p', 'project', 300, {
      pollMs: 100,
      stallMs: 500,
      firstScanDeadlineMs: 10_000,
      now: () => Date.now()
    }).then(result => (outcome = result))

    for (let t = 0; t < 1_250; t += 50) {
      scan.state.progress = Date.now() - start < 1_000 ? Date.now() : null

      if (Date.now() - start >= 1_250) {
        break
      }

      await vi.advanceTimersByTimeAsync(50)
    }

    scan.answer(OK)
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toEqual(OK)
  })
})

