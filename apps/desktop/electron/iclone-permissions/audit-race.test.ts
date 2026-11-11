/**
 * Permfix (v0.0.7 lenses L2, L3) — the maintained chain health stays exact when someone else writes while this writer
 * is mid-append (L2 major), when the volume's timestamps are too coarse to see a same-size edit (L2 minor), when an
 * outsider keeps touching the files to hold the re-verification off (L2 medium), and when a change slips through the
 * one syscall gap left (periodic full re-verify). The writer lock and the anchor's temp name are per instance (L3-6).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isAtomicTempName } from '../lib/atomic-write'

import { createAuditLog } from './audit'

const KEY = Buffer.alloc(32, 9)
const KID = 'kid-race'

let root: string
let dir: string
const opened: { close: () => void }[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-race-'))
  dir = path.join(root, 'audit')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  opened.splice(0).forEach(log => log.close())
  fs.rmSync(root, { recursive: true, force: true })
})

const open = (extra: Record<string, unknown> = {}) => {
  const log = createAuditLog({ dir, key: KEY, kid: KID, durable: false, ...extra })

  opened.push(log)

  return log
}

type Log = ReturnType<typeof open>

function append(log: Log, count: number, pad = 0) {
  for (let i = 0; i < count; i += 1) {
    log.append({ src: 'main', kind: 'use', reason: `r${i} ${'x'.repeat(pad)}` })
  }
}

const dayFile = () => path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.jsonl')) as string)

/** Same-size edit of the first record's reason: the hash no longer matches, the size and inode do. */
function editFirstRecord() {
  const file = dayFile()
  const text = fs.readFileSync(file, 'utf8')
  const at = text.indexOf('"reason":"r0') + '"reason":"'.length

  fs.writeFileSync(file, `${text.slice(0, at)}Z${text.slice(at + 1)}`)
}

/** The health without `verifying` against the full verifier. */
function expectHealthIsVerifier(log: Log) {
  const { verifying, ...health } = log.health()

  expect(verifying).toBe(false)
  expect(health).toEqual(log.verify())
}

describe('L2 major: an outsider write inside this writer’s fdatasync window', () => {
  function armFsyncHook(outsider: () => void) {
    const real = fs.fdatasyncSync
    let armed = true

    vi.spyOn(fs, 'fdatasyncSync').mockImplementation(fd => {
      if (armed && fs.fstatSync(fd).ino === fs.statSync(dayFile()).ino) {
        armed = false
        outsider()
      }

      return real(fd)
    })
  }

  it('an appended line during the fsync is not adopted as ours: health reads RED exactly as the verifier', () => {
    const log = open({ durable: true })

    append(log, 5)
    expect(log.health().ok).toBe(true)
    armFsyncHook(() => fs.appendFileSync(dayFile(), `${JSON.stringify({ seq_main: 999, forged: true })}\n`))
    append(log, 1)

    expect(log.verify().ok).toBe(false)
    expectHealthIsVerifier(log)
    append(log, 1)
    expectHealthIsVerifier(log)
  })

  it('a same-size edit of an earlier record during the fsync reads RED', () => {
    const log = open({ durable: true })

    append(log, 5)
    armFsyncHook(editFirstRecord)
    append(log, 1)

    expect(log.verify().ok).toBe(false)
    expectHealthIsVerifier(log)
  })
})

describe('periodic full re-verification (the write→fstat gap)', () => {
  it('an outsider line appended between our open and our write is not adopted as ours (pins `wrote.size === opened.size + count`)', () => {
    const log = open()

    append(log, 5)
    expect(log.health().ok).toBe(true)

    const real = fs.writeSync
    let armed = true

    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: never, ...rest: never[]) => {
      if (armed && fs.fstatSync(fd).ino === fs.statSync(dayFile()).ino) {
        armed = false
        fs.appendFileSync(dayFile(), `${JSON.stringify({ seq_main: 999, forged: true })}\n`)
      }

      return (real as (...args: unknown[]) => number)(fd, data, ...rest)
    }) as typeof fs.writeSync)
    append(log, 1)

    expect(log.verify().ok).toBe(false)
    expectHealthIsVerifier(log)
    expect(log.health().ok).toBe(false)
  })

  it('a change no stamp can see is found by the periodic pass', async () => {
    const log = open({ reverifyEveryMs: 40 })

    append(log, 5)
    expect(log.health().ok).toBe(true)

    // Freeze what stat reports for the day file: the edit below is invisible to every stamp check.
    const file = dayFile()
    const realStat = fs.statSync
    const frozen = realStat(file)

    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, opts?: fs.StatSyncOptions) =>
      String(target) === file ? frozen : realStat(target, opts)) as typeof fs.statSync)
    editFirstRecord()
    expect(log.health().ok).toBe(true)

    await vi.waitFor(() => expect(log.health().ok).toBe(false), { timeout: 3_000, interval: 20 })
    expect(log.health().breaks).toEqual(log.verify().breaks)
  })
})

describe('L2 minor: a volume with coarse timestamps (HFS+ 1 s, FAT/exFAT 2 s)', () => {
  it('a same-size edit in the same tick as our append is caught', async () => {
    const tick = 2_000

    const coarse = <T extends fs.Stats>(stat: T): T => {
      const copy = Object.assign(Object.create(Object.getPrototypeOf(stat)) as T, stat)

      copy.ctimeMs = Math.floor(stat.ctimeMs / tick) * tick
      copy.mtimeMs = Math.floor(stat.mtimeMs / tick) * tick

      return copy
    }

    const realStat = fs.statSync
    const realFstat = fs.fstatSync

    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, opts?: fs.StatSyncOptions) => {
      const stat = realStat(target, opts)

      return stat && !opts?.bigint ? coarse(stat as fs.Stats) : stat
    }) as typeof fs.statSync)
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, opts?: fs.StatOptions) => {
      const stat = realFstat(fd, opts as never)

      return opts?.bigint ? stat : coarse(stat as fs.Stats)
    }) as typeof fs.fstatSync)

    // Start early in a tick so the append and the edit share it.
    while (Date.now() % tick > 300) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    const log = open()

    append(log, 5)
    expect(log.health().ok).toBe(true)
    editFirstRecord()

    expect(log.verify().ok).toBe(false)
    expectHealthIsVerifier(log)
  })
})

describe('L2 medium: an outsider touching the files cannot hold the warning off', () => {
  /*
   * Deterministic: the back-off and the clock are fake, and the outsider touches the day file from inside each pass's read,
   * so a pass ends stale exactly when the test says so. The wall-clock version flaked because a pass sometimes landed
   * between two touches: it settled the broken walk (correctly not verifying), and once that walk had stood STABLE_MS the
   * next read began a fresh run of restarts, which reads `verifying` until it runs out. That is the contract: every run of
   * restarts is bounded, and a new run needs the warning to have stood first.
   */
  const STABLE_MS = 2_000
  const MAX_STALE_PASSES = 3

  const turn = () => new Promise<void>(resolve => setImmediate(resolve))

  async function setUp() {
    // Built and verified on real timers: a re-verification the appends start must be free to run its back-off.
    const log = open()

    append(log, 1_300, 900)
    expect((await log.whenVerified()).ok).toBe(true)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    // The verified walk has stood longer than STABLE_MS: the first drop below starts a pass at once.
    await vi.advanceTimersByTimeAsync(STABLE_MS + 1)
    editFirstRecord()

    const file = dayFile()
    const realRead = fs.promises.readFile

    const outsider = {
      armed: true,
      reads: [] as number[],
      touches: 0,
      touch() {
        outsider.touches += 1
        fs.utimesSync(file, outsider.touches, outsider.touches)
      }
    }

    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      const bytes = await realRead(...args)

      outsider.reads.push(Date.now())

      if (outsider.armed) {
        outsider.touch()
      }

      return bytes
    }) as typeof realRead)

    // onVerified fires inside the pass; one loop turn later its promise chain has finished and no pass is running.
    const settled = () =>
      new Promise<void>(resolve => {
        const off = log.onVerified(() => {
          off()
          setImmediate(resolve)
        })
      })

    return { log, outsider, settled }
  }

  /** Wait (by real I/O turns, no clock) until the pass that started after `before` reads ended stale: a back-off is pending. */
  async function untilStale(outsider: { reads: number[] }, before: number) {
    while (outsider.reads.length === before || vi.getTimerCount() === 0) {
      await turn()
    }
  }

  async function nextStalePass(outsider: { reads: number[] }) {
    const before = outsider.reads.length

    await vi.advanceTimersToNextTimerAsync()
    await untilStale(outsider, before)
  }

  /** Runs the back-off restarts until the health stops reading `verifying`; ok is false throughout. Returns the passes. */
  async function restartsUntilChanging(log: Log, outsider: { reads: number[] }, passes: number) {
    while (log.health().verifying) {
      expect(passes).toBeLessThan(MAX_STALE_PASSES)
      await nextStalePass(outsider)
      passes += 1
      expect(log.health().ok).toBe(false)
    }

    expect(log.health().breaks.map(found => found.problem)).toContain('changing')

    return passes
  }

  it('a re-verification that keeps restarting ends as broken (not verifying) and stops re-reading the log', async () => {
    const { log, outsider } = await setUp()

    expect(log.health()).toMatchObject({ ok: false, verifying: true })
    await untilStale(outsider, 0)
    await restartsUntilChanging(log, outsider, 1)

    // The outsider keeps touching through ten seconds: the warning stays up, and the re-reads back off (not a busy loop).
    const since = Date.now()
    const readsBefore = outsider.reads.length

    while (Date.now() - since < 10_000) {
      await nextStalePass(outsider)
      expect(log.health()).toMatchObject({ ok: false, verifying: false })
    }

    const reads = outsider.reads.slice(readsBefore)
    const gaps = reads.slice(1).map((at, i) => at - reads[i])

    expect(reads.length).toBeLessThanOrEqual(4)
    gaps.forEach((gap, i) => expect(gap).toBeGreaterThanOrEqual(i === 0 ? 0 : gaps[i - 1]))
  }, 90_000)

  it('a pass that lands between touches shows the break; a new run of touches after it stood gets a bounded run of restarts', async () => {
    const { log, outsider, settled } = await setUp()
    const verified = settled()

    outsider.armed = false
    expect(log.health()).toMatchObject({ ok: false, verifying: true })
    await verified
    expect(log.health()).toMatchObject({ ok: false, verifying: false })
    expect(log.health().breaks.map(found => found.problem)).toEqual(['hash'])

    await vi.advanceTimersByTimeAsync(STABLE_MS + 1)
    outsider.armed = true
    outsider.touch()

    const before = outsider.reads.length

    expect(log.health()).toMatchObject({ ok: false, verifying: true })
    await untilStale(outsider, before)
    await restartsUntilChanging(log, outsider, 1)
    expect(log.health().breaks.map(found => found.problem)).toEqual(['hash', 'changing'])
  }, 90_000)

  it('a touch right after a pass settles continues the run of restarts instead of starting a new one', async () => {
    const { log, outsider, settled } = await setUp()
    const verified = settled()

    outsider.armed = false
    expect(log.health().verifying).toBe(true)
    await verified
    expect(log.health()).toMatchObject({ ok: false, verifying: false })

    // Well inside STABLE_MS: the walk was dropped too soon to count as stable, so the next pass waits out a back-off.
    outsider.armed = true
    outsider.touch()
    expect(log.health()).toMatchObject({ ok: false, verifying: true })
    expect(vi.getTimerCount()).toBe(1)
    expect(await restartsUntilChanging(log, outsider, 0)).toBeLessThanOrEqual(MAX_STALE_PASSES - 1)
  }, 90_000)
})

describe('L3-6: one writer per log, also inside one process', () => {
  it('a second log on the same directory in the same process never removes the lock the first still holds', () => {
    const first = open()
    const second = createAuditLog({ dir, key: KEY, kid: KID, durable: false })

    second.close()
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, '.lock'), 'utf8').trim()).toBe(String(process.pid))
    append(first, 1)
    expect(first.health().ok).toBe(true)

    first.close()
    opened.splice(0)
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false)
  })

  it('the anchor is written through a random, exclusive temp name the leftover sweep recognises', () => {
    const realOpen = fs.openSync
    const temps: string[] = []

    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (String(target).includes('audit-head.json') && String(target).endsWith('.tmp')) {
        temps.push(String(target))
        expect(flags).toBe('wx')
      }

      return realOpen(target, flags as fs.OpenMode, mode)
    }) as typeof fs.openSync)

    const log = open()

    append(log, 2)
    expect(temps.length).toBeGreaterThanOrEqual(2)
    expect(new Set(temps).size).toBe(temps.length)
    temps.forEach(temp => expect(isAtomicTempName(path.basename(temp))).toBe(true))
  })
})
