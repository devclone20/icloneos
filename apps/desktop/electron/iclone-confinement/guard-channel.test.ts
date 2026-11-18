/**
 * CF8: main's guard on the launcher's fd 3. A fake duplex stands for the socketpair (main's end): what the launcher
 * writes is pushed in, what main writes is collected as lines. The guard is a fake `check` with main's real
 * `checkBeforeStart` in front of it, on a fake clock. The last block drives a real Python child through a real fd 3.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Duplex } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HardlinkBlockView } from '../../src/iclone-shared/confinement'
import { appTeardown } from '../teardown-registry'

import {
  GUARD_FIRST_SCAN_CAP_MS,
  GUARD_LINE_MAX_BYTES,
  GUARD_MAX_OPEN,
  GUARD_STILL_CHECKING,
  GUARD_WRITE_BUFFER_MAX_BYTES,
  guardLine,
  serveGuardChannel
} from './guard-channel'
import { type HardlinkCheck, hardlinkRefusal, type HardlinkStartGuard } from './hardlinks'
import { createLauncher, GUARD_FD } from './launcher'
import { RUNTIME_PYTHON } from './runtime-live-harness'

class MainEnd extends Duplex {
  readonly lines: Record<string, unknown>[] = []
  private partial = ''

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.partial += chunk.toString('utf8')

    let newline = this.partial.indexOf('\n')

    while (newline >= 0) {
      this.lines.push(JSON.parse(this.partial.slice(0, newline)) as Record<string, unknown>)
      this.partial = this.partial.slice(newline + 1)
      newline = this.partial.indexOf('\n')
    }

    done()
  }

  ask(frame: unknown): void {
    this.push(Buffer.from(`${JSON.stringify(frame)}\n`))
  }

  of(id: string): Record<string, unknown>[] {
    return this.lines.filter(line => line.id === id)
  }
}

const ROOT = '/private/tmp/project'
const nonce = (): string => randomBytes(16).toString('hex')

const request = (overrides: Record<string, unknown> = {}) => ({
  id: nonce(),
  op: 'check',
  root: ROOT,
  cls: 'project',
  phase: 'before',
  ...overrides
})

const block = (kind: HardlinkBlockView['kind'] = 'hard-links'): HardlinkBlockView => ({
  root: ROOT,
  kind,
  paths: [`${ROOT}/linked.txt`],
  count: 1,
  groups: []
})

const passed: HardlinkCheck = { ok: true, cached: false, files: 3, dirs: 2, ms: 1, passed: 0 }

let clock: number
let wall: number
let end: MainEnd
let checks: { root: string; cls: unknown; exitedAtMs: unknown; settle: (result: HardlinkCheck) => void }[]
let scanDirs: number | null
let scanAt: number | null
let guarded: (root: string) => boolean

const guard: HardlinkStartGuard = {
  check: (root, cls, exitedAtMs) =>
    new Promise<HardlinkCheck>(resolve => checks.push({ root, cls, exitedAtMs, settle: resolve })),
  firstScanDirs: () => scanDirs,
  firstScanProgress: () => scanAt
}

const serve = (timings = {}) =>
  serveGuardChannel(end, {
    guard,
    guarded: root => guarded(root),
    now: () => clock,
    wallNow: () => wall,
    timings
  })

/** Advances the fake clock and the timers together, so `checkBeforeStart` reads the same time its timers ran at. */
async function advance(ms: number, step = 250): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    clock += Math.min(step, left)
    await vi.advanceTimersByTimeAsync(Math.min(step, left))
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_000
  wall = 1_800_000_000_000
  end = new MainEnd()
  checks = []
  scanDirs = null
  scanAt = null
  guarded = root => root === ROOT
})

afterEach(() => {
  vi.useRealTimers()
})

describe('verdicts are the guard check, passed through', () => {
  it('answers ok when the check passes', async () => {
    serve()
    const ask = request()

    end.ask(ask)
    await advance(10)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ root: ROOT, cls: 'project', exitedAtMs: undefined })
    checks[0].settle(passed)
    await advance(10)
    expect(end.of(ask.id)).toEqual([{ id: ask.id, ok: true }])
  })

  it('answers the refusal code and main sentence when the check refuses', async () => {
    serve()
    const ask = request({ cls: null })

    end.ask(ask)
    await advance(10)
    expect(checks[0].cls).toBeUndefined()
    checks[0].settle({ ok: false, cached: false, block: block(), ms: 1 })
    await advance(10)
    expect(end.of(ask.id)).toEqual([{ id: ask.id, ok: false, code: 'hard-links', detail: hardlinkRefusal(block()) }])
  })

  it('a check that fails outright is cannot-scan, never ok', async () => {
    const failing: HardlinkStartGuard = { check: () => Promise.reject(new Error('disk gone')) }

    serveGuardChannel(end, { guard: failing, guarded: () => true, now: () => clock })
    const ask = request()

    end.ask(ask)
    await advance(10)
    expect(end.of(ask.id)).toEqual([
      { id: ask.id, ok: false, code: 'cannot-scan', detail: 'the hard-link check failed (disk gone)' }
    ])
  })
})

describe('progress while the check is open', () => {
  it('sends a frame at most 2 s apart through a 150 s first scan, with its folder count, then one verdict', async () => {
    serve()
    const ask = request()

    end.ask(ask)
    await advance(10)
    const frameTimes: number[] = []
    let seen = 0

    for (let t = 0; t < 150_000; t += 250) {
      scanDirs = Math.floor(t / 10)
      scanAt = clock
      await advance(250)

      const frames = end.of(ask.id).filter(line => 'progress' in line)

      for (const frame of frames.slice(seen)) {
        frameTimes.push(clock)
        expect((frame.progress as { dirs: number }).dirs).toBe(scanDirs)
      }

      seen = frames.length
    }

    const gaps = frameTimes.slice(1).map((at, i) => at - frameTimes[i])

    expect(frameTimes[0] - 1_010).toBeLessThanOrEqual(2_000)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2_000)
    expect(end.of(ask.id).filter(line => 'ok' in line)).toEqual([])
    checks[0].settle(passed)
    await advance(3_000)
    expect(end.of(ask.id).filter(line => 'ok' in line)).toEqual([{ id: ask.id, ok: true }])
    expect(end.of(ask.id).at(-1)).toEqual({ id: ask.id, ok: true })
  })

  it('a first scan still running past the cap answers "still being checked", and the late answer sends nothing', async () => {
    serve()
    const ask = request()

    end.ask(ask)

    for (let t = 0; t <= GUARD_FIRST_SCAN_CAP_MS + 2_000; t += 500) {
      scanDirs = t
      scanAt = clock
      await advance(500)
    }

    expect(end.of(ask.id).filter(line => 'ok' in line)).toEqual([
      { id: ask.id, ok: false, code: 'cannot-scan', detail: GUARD_STILL_CHECKING, busy: true }
    ])

    const after = end.lines.length

    checks[0].settle(passed)
    await advance(5_000)
    expect(end.lines.length).toBe(after)
  })

  it('a stalled first scan is refused as main refuses its own start, with the same owner sentence', async () => {
    serve()
    const ask = request()

    scanDirs = 10
    scanAt = clock
    end.ask(ask)
    await advance(40_000)
    expect(end.of(ask.id).filter(line => 'ok' in line)).toEqual([
      { id: ask.id, ok: false, code: 'cannot-scan', detail: GUARD_STILL_CHECKING, busy: true }
    ])
  })
})

describe('ids', () => {
  it('two open checks get exactly one verdict each, in the order they settle', async () => {
    serve()
    const first = request()
    const second = request()

    end.ask(first)
    end.ask(second)
    await advance(10)
    checks[1].settle({ ok: false, cached: true, block: block('cannot-scan'), ms: 1 })
    checks[0].settle(passed)
    await advance(10)

    const verdicts = end.lines.filter(line => 'ok' in line)

    expect(verdicts.map(line => line.id)).toEqual([second.id, first.id])
    expect(end.of(second.id).filter(line => 'ok' in line)).toEqual([
      { id: second.id, ok: false, code: 'cannot-scan', detail: hardlinkRefusal(block('cannot-scan')) }
    ])
  })

  it('an id used twice closes the channel (open or already answered)', async () => {
    const channel = serve()
    const ask = request()

    end.ask(ask)
    await advance(10)
    checks[0].settle(passed)
    await advance(10)
    end.ask({ ...ask })
    await advance(10)
    expect(channel.closed()).toBe(true)
    expect(end.destroyed).toBe(true)
    expect(checks).toHaveLength(1)
  })

  it.each([
    ['an id that is not 32 hex', { id: 'ABC' }],
    ['an upper-case id', { id: 'A'.repeat(32) }],
    ['an unknown op', { op: 'walk' }],
    ['a relative root', { root: 'project' }],
    ['an unknown phase', { phase: 'during' }],
    ['a numeric class', { cls: 3 }],
    ['an extra key', { verdict: true }]
  ])('%s closes the channel and checks nothing', async (_name, overrides) => {
    const channel = serve()

    end.ask(request(overrides))
    await advance(10)
    expect(channel.closed()).toBe(true)
    expect(checks).toEqual([])
  })

  it('a missing key closes the channel', async () => {
    const channel = serve()
    const { phase: _dropped, ...rest } = request()

    end.ask(rest)
    await advance(10)
    expect(channel.closed()).toBe(true)
  })
})

describe('malformed and oversize lines close the channel', () => {
  it.each([
    ['not JSON', Buffer.from('check please\n')],
    ['a JSON array', Buffer.from('[1,2]\n')],
    ['not UTF-8', Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')])]
  ])('%s', async (_name, bytes) => {
    const channel = serve()

    end.push(bytes)
    await advance(10)
    expect(channel.closed()).toBe(true)
    expect(checks).toEqual([])
  })

  it('a line over 64 KiB with no newline yet closes it before the newline comes', async () => {
    const channel = serve()

    end.push(Buffer.alloc(GUARD_LINE_MAX_BYTES + 1, 0x20))
    await advance(10)
    expect(channel.closed()).toBe(true)
  })

  it('a line over 64 KiB that arrives in pieces with its newline closes it', async () => {
    const channel = serve()
    const big = `${JSON.stringify(request({ root: `/${'a'.repeat(GUARD_LINE_MAX_BYTES)}` }))}\n`

    end.push(Buffer.from(big.slice(0, 40_000)))
    end.push(Buffer.from(big.slice(40_000)))
    await advance(10)
    expect(channel.closed()).toBe(true)
    expect(checks).toEqual([])
  })

  // L4.3: the bound counts the newline (as guardLine does); the padding moved from the root to the class because a root
  // is now bounded at 1024 bytes (L1.2). An over-long class is still a request: answered (unknown class), channel open.
  it('a line AT the bound, its newline included, is a request (answered, channel open)', async () => {
    const channel = serve()
    const base = JSON.stringify(request({ cls: '' }))
    const ask = request({ cls: 'a'.repeat(GUARD_LINE_MAX_BYTES - 1 - base.length) })

    expect(Buffer.byteLength(`${JSON.stringify(ask)}\n`)).toBe(GUARD_LINE_MAX_BYTES)
    end.ask(ask)
    await advance(10)
    expect(channel.closed()).toBe(false)
    expect(end.of(ask.id).filter(line => 'ok' in line)).toHaveLength(1)
  })

  it('L4.3: one byte past the bound (65 536 + its newline) closes the channel, whole or in pieces', async () => {
    const base = JSON.stringify(request({ cls: '' }))
    const over = `${JSON.stringify(request({ cls: 'a'.repeat(GUARD_LINE_MAX_BYTES - base.length) }))}\n`

    expect(Buffer.byteLength(over)).toBe(GUARD_LINE_MAX_BYTES + 1)

    const whole = serve()

    end.push(Buffer.from(over))
    await advance(10)
    expect(whole.closed()).toBe(true)

    end = new MainEnd()

    const pieces = serve()

    end.push(Buffer.from(over.slice(0, GUARD_LINE_MAX_BYTES)))
    await advance(10)
    expect(pieces.closed()).toBe(true)
  })

  it('two requests in one chunk, and one split across chunks, are each served', async () => {
    serve()
    const a = request()
    const b = request()
    const c = `${JSON.stringify(request())}\n`

    end.push(Buffer.from(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n${c.slice(0, 20)}`))
    end.push(Buffer.from(c.slice(20)))
    await advance(10)
    expect(checks).toHaveLength(3)
  })

  it('a verdict line stays within the bound however many paths the refusal names', () => {
    const many = { ...block(), paths: Array.from({ length: 2_000 }, (_, i) => `${ROOT}/${'x'.repeat(60)}-${i}`), count: 5_000 }
    const line = guardLine({ id: nonce(), ok: false, code: 'hard-links', detail: hardlinkRefusal(many) })

    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(GUARD_LINE_MAX_BYTES)
    expect(JSON.parse(line)).toMatchObject({ ok: false, code: 'hard-links' })
  })
})

describe('L1.2/L4.2: a request main could not admit in bounded work never reaches main\'s fs or leaves a timer', () => {
  it.each([
    ['a root over 1024 bytes', `/${'a/'.repeat(600)}x`],
    ['a 32 000-level root (64 KiB line)', `/a${'/a'.repeat(31_000)}`],
    ['a root that is not normal (..)', '/private/tmp/project/../project'],
    ['a root that is not normal (//)', '//private/tmp/project'],
    ['a root that is not normal (trailing .)', '/private/tmp/project/.']
  ])('%s closes the channel without asking admission', async (_name, root) => {
    let asked = 0

    guarded = () => ((asked += 1), true)

    const channel = serve()

    end.push(Buffer.from(`${JSON.stringify(request({ root }))}\n`))
    await advance(10)
    expect(channel.closed()).toBe(true)
    expect(asked).toBe(0)
    expect(checks).toEqual([])
  })

  it('admission that throws is answered cannot-scan; no progress frame ever follows; the channel stays open', async () => {
    guarded = () => {
      throw new RangeError('Maximum call stack size exceeded')
    }

    const channel = serve()
    const ask = request()

    end.ask(ask)
    await advance(5_000)
    expect(channel.closed()).toBe(false)
    expect(channel.open()).toBe(0)
    expect(end.of(ask.id)).toEqual([expect.objectContaining({ id: ask.id, ok: false, code: 'cannot-scan' })])
  })

  it('a guard whose check throws outright still answers that id (cannot-scan), and stops its progress', async () => {
    const throwing: HardlinkStartGuard = {
      check: () => {
        throw new Error('the guard is closed')
      }
    }

    const channel = serveGuardChannel(end, { guard: throwing, guarded: () => true, now: () => clock, wallNow: () => wall })
    const ask = request()

    end.ask(ask)
    await advance(3_000)
    expect(end.of(ask.id).filter(line => 'ok' in line)).toEqual([
      expect.objectContaining({ ok: false, code: 'cannot-scan', detail: expect.stringContaining('the guard is closed') })
    ])
    expect(channel.open()).toBe(0)
  })
})

describe('L4.5 + L1.4: a launcher that stops reading, and the close callback', () => {
  class StuckEnd extends Duplex {
    _read(): void {}

    _write(_chunk: Buffer, _encoding: BufferEncoding, _done: () => void): void {}
  }

  it('main closes the channel once its unsent answers pass GUARD_WRITE_BUFFER_MAX_BYTES', async () => {
    const stuck = new StuckEnd()
    const why: string[] = []

    const channel = serveGuardChannel(stuck, {
      guard,
      guarded: () => false,
      now: () => clock,
      onClosed: reason => why.push(reason)
    })

    const lines = Array.from({ length: 12_000 }, () => JSON.stringify(request())).join('\n')

    stuck.push(Buffer.from(`${lines}\n`))
    await advance(10)
    expect(channel.closed()).toBe(true)
    expect(stuck.writableLength).toBeLessThan(GUARD_WRITE_BUFFER_MAX_BYTES + 4_096)
    expect(why).toEqual(['the launcher stopped reading its answers'])
  })

  it('onClosed is called exactly once, with the reason, whoever closes', async () => {
    const why: string[] = []
    const channel = serveGuardChannel(end, { guard, guarded: () => true, now: () => clock, onClosed: r => why.push(r) })

    end.push(Buffer.from('check please\n'))
    await advance(10)
    channel.close('again')
    expect(why).toEqual(['a request line off the contract'])
  })
})

describe('only roots main guards are checked', () => {
  it('a root main does not guard is refused without a walk; the channel stays open', async () => {
    const channel = serve()
    const ask = request({ root: '/' })

    end.ask(ask)
    await advance(10)
    expect(checks).toEqual([])
    expect(end.of(ask.id)).toEqual([
      { id: ask.id, ok: false, code: 'cannot-scan', detail: '/ is not a folder main guards for a confined command, so it was not checked' }
    ])
    expect(channel.closed()).toBe(false)
  })

  it('an unknown class is refused without a walk', async () => {
    serve()
    const ask = request({ cls: 'root' })

    end.ask(ask)
    await advance(10)
    expect(checks).toEqual([])
    expect(end.of(ask.id)[0]).toMatchObject({ ok: false, code: 'cannot-scan' })
  })
})

describe('the after-run phase', () => {
  it('asks the guard with exitedAtMs = when the request arrived, and refuses only what appeared during the run', async () => {
    serve()
    const quiet = request({ phase: 'after' })
    const planted = request({ phase: 'after' })

    end.ask(quiet)
    await advance(10)
    wall += 5
    end.ask(planted)
    await advance(10)
    expect(checks.map(check => check.exitedAtMs)).toEqual([1_800_000_000_000, 1_800_000_000_005])
    checks[0].settle({ ok: false, cached: true, block: block(), ms: 1, appeared: null })
    checks[1].settle({ ok: false, cached: true, block: block(), ms: 1, appeared: block() })
    await advance(10)
    expect(end.of(quiet.id)).toEqual([{ id: quiet.id, ok: true }])
    expect(end.of(planted.id)).toEqual([
      { id: planted.id, ok: false, code: 'hard-links', detail: hardlinkRefusal(block()) }
    ])
  })
})

describe('"busy" marks only the still-being-checked verdict', () => {
  it('ok, a refusal, an appeared link, a failed check, an unguarded root and an unknown class carry no "busy" key', async () => {
    serve()
    const asks = [request(), request(), request({ phase: 'after' }), request({ root: '/' }), request({ cls: 'root' })]

    for (const ask of asks) {
      end.ask(ask)
    }

    await advance(10)
    checks[0].settle(passed)
    checks[1].settle({ ok: false, cached: false, block: block(), ms: 1 })
    checks[2].settle({ ok: false, cached: true, block: block(), ms: 1, appeared: block('cannot-scan') })
    await advance(10)

    const failing: HardlinkStartGuard = { check: () => Promise.reject(new Error('disk gone')) }
    const other = new MainEnd()
    const failed = request()

    serveGuardChannel(other, { guard: failing, guarded: () => true, now: () => clock })
    other.ask(failed)
    await advance(10)

    const verdicts = [...end.lines, ...other.lines].filter(line => 'ok' in line)

    expect(verdicts).toHaveLength(6)
    expect(verdicts.filter(line => line.ok === false)).toHaveLength(5)
    expect(verdicts.filter(line => 'busy' in line)).toEqual([])
  })

  it('an after-run check that runs out of time is busy (the launcher writes no row for it)', async () => {
    serve()
    const ask = request({ phase: 'after' })

    end.ask(ask)
    await advance(31_000)
    expect(end.of(ask.id)).toContainEqual({ id: ask.id, ok: false, code: 'cannot-scan', detail: GUARD_STILL_CHECKING, busy: true })
  })

  it('a request past the open-check bound is answered busy at once, without a walk', async () => {
    serve()
    const asks = Array.from({ length: GUARD_MAX_OPEN + 1 }, () => request())

    for (const ask of asks) {
      end.ask(ask)
    }

    await advance(10)
    expect(checks).toHaveLength(GUARD_MAX_OPEN)
    expect(end.of(asks[GUARD_MAX_OPEN].id)).toEqual([
      { id: asks[GUARD_MAX_OPEN].id, ok: false, code: 'cannot-scan', detail: GUARD_STILL_CHECKING, busy: true }
    ])
  })
})

describe('closing', () => {
  it('main closing stops every progress frame; a verdict that settles later is not sent', async () => {
    const channel = serve()
    const ask = request()

    end.ask(ask)
    await advance(10)
    channel.close('the launcher exited')
    expect(end.destroyed).toBe(true)
    expect(channel.open()).toBe(0)

    const sent = end.lines.length

    checks[0].settle(passed)
    await advance(5_000)
    expect(end.lines.length).toBe(sent)
  })

  it('quit (the app teardown) stops every progress ticker still armed; the channel and its answer are the launcher’s', async () => {
    const channel = serve()
    const ask = request()

    end.ask(ask)
    await advance(1_500)
    expect(end.of(ask.id).filter(line => 'progress' in line).length).toBeGreaterThan(0)
    expect(appTeardown.run()).toContain('guard channel progress tickers')

    const frames = end.of(ask.id).filter(line => 'progress' in line).length

    await advance(5_000)
    expect(end.of(ask.id).filter(line => 'progress' in line).length).toBe(frames)
    expect(channel.closed()).toBe(false)
    checks[0].settle(passed)
    await advance(10)
    expect(end.of(ask.id).at(-1)).toEqual({ id: ask.id, ok: true })
    expect(channel.open()).toBe(0)
  })

  it('the launcher ending its side closes main’s', async () => {
    const channel = serve()

    end.push(null)
    end.resume()
    await advance(10)
    expect(channel.closed()).toBe(true)
  })
})

const PYTHONS = [RUNTIME_PYTHON, path.resolve(import.meta.dirname, '../../../../../_v006-tools/venv314/bin/python')]
const python = PYTHONS.find(candidate => existsSync(candidate))

/**
 * A stand-in launcher (the real one is B2's): it asks main on fd 3, prints the verdict, and reports whether fd 3 is
 * open in itself, in a child it starts the way the launcher starts commands (subprocess, close_fds), and main checks
 * a sibling it spawns itself has no fd 3.
 */
const STAND_IN = String.raw`
import json, os, stat, subprocess, sys
fd = int(os.environ["ICLONE_GUARD_FD"])
mine = stat.S_ISSOCK(os.fstat(fd).st_mode)
child = subprocess.run([sys.executable, "-I", "-S", "-c", "import os\ntry:\n os.fstat(3); print('open')\nexcept OSError: print('closed')"], capture_output=True, text=True).stdout.strip()
os.write(fd, (json.dumps({"id": "ab" * 16, "op": "check", "root": sys.argv[1], "cls": "project", "phase": "before"}) + "\n").encode())
data = b""
while not data.endswith(b"\n"):
    part = os.read(fd, 65536)
    if not part:
        break
    data += part
print("RESULT " + json.dumps({"mine": mine, "child": child, "verdict": json.loads(data.splitlines()[-1])}), flush=True)
print("ICLONE-LAUNCHER-READY %d" % os.getpid(), flush=True)
os.read(fd, 1)
`

describe.skipIf(python === undefined || process.platform === 'win32')('a real child on a real fd 3', () => {
  it('asks main on fd 3 and gets the verdict; fd 3 reaches neither its child nor a sibling of main', async () => {
    vi.useRealTimers()
    const dir = mkdtempSync('/private/tmp/ie-guard-')
    const script = path.join(dir, 'stand-in.py')
    const logs: string[] = []
    let result: { mine: boolean; child: string; verdict: Record<string, unknown> } | null = null
    let channel: ReturnType<typeof serveGuardChannel> | null = null

    writeFileSync(script, STAND_IN)

    const launcher = createLauncher({
      python: python as string,
      script,
      socketPath: path.join(dir, 'run', 'l.sock'),
      journalDir: path.join(dir, 'run'),
      home: dir,
      hermesHome: dir,
      spec: '{}',
      roots: { reads: [], writes: [], grants: [] },
      log: line => logs.push(line),
      spawn: (command, args, options) => {
        const child = spawn(command, [...args.slice(0, -1), args.at(-1) as string, dir], options)

        child.stdout?.on('data', (chunk: Buffer) => {
          const line = String(chunk)
            .split('\n')
            .find(item => item.startsWith('RESULT '))

          if (line) {
            result = JSON.parse(line.slice('RESULT '.length)) as typeof result
          }
        })

        return child
      },
      guardChannel: stream => {
        channel = serveGuardChannel(stream, {
          guard: { check: async () => passed },
          guarded: root => root === dir
        })

        return channel
      }
    })

    try {
      await expect(launcher.start()).resolves.toBe('up')
      expect(result).toEqual({ mine: true, child: 'closed', verdict: { id: 'ab'.repeat(16), ok: true } })

      const sibling = await new Promise<string>(resolve => {
        const probe = spawn('/bin/sh', ['-c', `if [ -e /dev/fd/${GUARD_FD} ]; then echo open; else echo closed; fi`], {
          stdio: ['ignore', 'pipe', 'ignore']
        })

        let out = ''

        probe.stdout.on('data', chunk => (out += String(chunk)))
        probe.on('close', () => resolve(out.trim()))
      })

      expect(sibling).toBe('closed')
      await launcher.stop()
      expect((channel as ReturnType<typeof serveGuardChannel> | null)?.closed()).toBe(true)
    } finally {
      await launcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
